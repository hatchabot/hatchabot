import type { Agent } from '../../domain/types.js';
import { CURATED_SKILLS, selectedCuratedSkills } from '../../openclaw/skills.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { AgentBusyError, isBusy, whileBusy } from '../lifecycle/busy.js';
import { TurnRefused } from '../files/coreFileTurns.js';
import { operationRefusal } from '../lifecycle/operations.js';
import { mutateSkillFile, readSkillFile, SkillFileError, type SkillFileView } from './skillFiles.js';
import { readSkillsStatus, type SkillsStatus } from './skillsStatus.js';
import { describeSkillTrial, runSkillTrial, type SkillTrialResult } from './skillTrials.js';
import { practicePausedLine, recordPracticeUsage } from '../usage/practiceUsage.js';

/** Why not, with the status the route answers and its words (and a 429's `retry-after`). */
export type SkillRefusal = { ok: false; status: number; error: string; retryAfter?: string };
type Answer<T> = { ok: true; body: T } | SkillRefusal;

/**
 * Who is asking, as the route reads them at each step: the agent as they
 * own it now (`owned`), and their browser session held across the waits
 * (`watch`, the context's `watchConsoleHttp`), started where the route
 * started it.
 */
export interface SkillCaller {
  owned: (agentId: string) => Agent | undefined;
  watch: () => { valid: () => boolean };
}

export type CuratedSkill = (typeof CURATED_SKILLS)[number];

/** The skills library as the page shows it. */
export type SkillsView = ReturnType<Skills['view']>;

/**
 * Curated skills per agent (HB-0808 step 13): the library's saved choices, an
 * instruction file previewed, updated, replaced or rolled back, a practice
 * run, and the running agent's inventory read on demand. Built once in
 * `registerRoutes` and on the route context as `ctx.skills`; its routes are
 * in src/api/data/skillRoutes.ts, which checks who asks, the skill's id and the
 * body, then hands over. Nothing here knows HTTP: a refusal is a result with
 * its status and words.
 *
 * Its state: `skillTrialNext` (the practice cooldown: two minutes between
 * practice tasks on one agent, a cache) and `skillStatusReads` (the status
 * reads under way, coalesced for the same context, a lock). `stop()` ends
 * the cooldowns. A file change and a practice take the agent's core-files
 * turn (handed in: the agent files service's, so they wait with every other
 * change to its files) and then the busy flag. Each read again, after
 * waiting, the agent, its owner, the caller's session and its context.
 */
export interface Skills {
  /** May its choices or files be changed now (not the manager, not gone, not busy, archived or held)? */
  editable(a: Agent): boolean;
  /** The library: the catalog, what is selected and what the last build applied. */
  view(a: Agent): {
    skills: Array<Omit<CuratedSkill, 'content'> & { trial: ReturnType<typeof describeSkillTrial>; selected: boolean; applied: boolean | null }>;
    selected: string[]; applied: string[] | null; pending: boolean; managed: boolean; canEdit: boolean; message: string;
  };
  /** Save the choices (a next-start rebuild owed); the view after. */
  save(agent: Agent, chosen: string[]): Answer<SkillsView>;
  /** One instruction file as installed beside the catalog's, with what may be done to it. */
  readFile(agent: Agent, skill: CuratedSkill, caller: SkillCaller): Promise<Answer<SkillFileView | Record<string, unknown>>>;
  /** Update, replace or roll back one instruction file. */
  changeFile(agent: Agent, skillId: string, change: { action: 'update' | 'replace' | 'rollback'; expectedRevision: string }, caller: SkillCaller):
    Promise<Answer<SkillFileView & { agentUpdatedAt: string }>>;
  /** A practice task with the installed instructions, two minutes apart per agent. */
  practice(agent: Agent, skillId: string, expectedRevision: string, caller: SkillCaller): Promise<Answer<SkillTrialResult>>;
  /** The running agent's skills as it reports them, read on demand. */
  status(agent: Agent, caller: SkillCaller): Promise<Answer<SkillsStatus | { status: 'busy' | 'not_running' | 'unavailable'; skills: [] } | (SkillsStatus & { checkedAt?: string })>>;
  /** At shutdown: the cooldowns end. */
  stop(): void;
}

export interface SkillsDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Deleted or being deleted. */
  agentGone: (id: string) => boolean;
  /** Is an archive of this agent under way? */
  isArchiving: (agentId: string) => boolean;
  /** Keep a change for the agent's next start (the lifecycle queue's). */
  oweRebuild: (agentId: string, log?: (event: string, detail: Record<string, unknown>) => void) => string;
  /** The agent's core-files turn (the agent files service's): one waits two minutes at most, then is refused (AgentBusyError). */
  withCoreFilesTurn: <T>(agentId: string, fn: () => Promise<T>) => Promise<T>;
}

export function createSkills(deps: SkillsDeps): Skills {
  const { store, providerFor, trace, agentGone, isArchiving, oweRebuild, withCoreFilesTurn } = deps;
  const refused = (status: number, error: string): SkillRefusal => ({ ok: false, status, error });

  // Curated instructions only: saving never installs binaries, grants tools,
  // or touches a workspace file. The normal build applies the saved choice.
  const skillsEditable = (a: Agent) => !a.ops && !agentGone(a.id) &&
    ['RUNNING', 'STOPPED', 'FAILED'].includes(a.state) &&
    !isBusy(a.id) && !isArchiving(a.id) && !operationRefusal(store, a.id);
  const skillsView = (a: Agent) => {
    const selected = selectedCuratedSkills(a.curatedSkills);
    const applied = a.appliedCuratedSkills === undefined ? null : selectedCuratedSkills(a.appliedCuratedSkills);
    const pending = a.curatedSkills !== undefined && (applied === null || JSON.stringify(selected) !== JSON.stringify(applied));
    return {
      skills: CURATED_SKILLS.map(({ content: _content, ...skill }) => ({
        ...skill, trial: describeSkillTrial(skill.id), selected: selected.includes(skill.id), applied: applied === null ? null : applied.includes(skill.id),
      })),
      selected, applied, pending, managed: a.curatedSkills !== undefined, canEdit: skillsEditable(a),
      message: a.curatedSkills === undefined
        ? 'Google Workspace is the original default. Save your choices to manage this agent’s curated skills; its current runtime selection has not been checked.'
        : pending
          ? 'Saved. Rebuild the agent to apply these choices, or they will apply when it next starts. Then start a new conversation.'
          : 'These choices were applied at the last build. Start a new conversation to use them. Check availability to inspect the running configuration; external tasks have not been tested.',
    };
  };

  const save: Skills['save'] = (agent, chosen) => {
    if (!skillsEditable(agent)) return refused(409, 'Finish the current operation or restore the archived agent before changing its skills.');
    const selected = selectedCuratedSkills(chosen);
    // No await between ownership/lifecycle checks and the transaction. A
    // repeated save is a no-op; an empty array is an intentional disable-all.
    if (agent.curatedSkills === undefined || JSON.stringify(selectedCuratedSkills(agent.curatedSkills)) !== JSON.stringify(selected)) {
      store.transact(() => {
        store.setAgentCuratedSkills(agent.id, selected);
        if (agent.runtimeRef) oweRebuild(agent.id, () => {});
      });
      trace(agent.id)('skills.selected', { selected });
    }
    return { ok: true, body: skillsView(store.getAgent(agent.id)!) };
  };

  const skillFileContext = (a: Agent) => JSON.stringify([
    a.ownerId, a.ops, a.runtimeRef, a.slug, a.hostId, a.state, a.updatedAt, a.image,
    a.aiProfileId, a.appliedProfileAt, a.curatedSkills, a.appliedCuratedSkills,
    store.getHost(a.hostId), store.getAIProfile(a.aiProfileId),
  ]);
  const skillFileBusy = (a: Agent) => isBusy(a.id) || isArchiving(a.id) || operationRefusal(store, a.id) ||
    a.state === 'PROVISIONING' || a.state === 'REBUILDING';
  const skillFileFailure = (error: unknown): SkillRefusal => {
    if (error instanceof TurnRefused) return refused(error.status, error.message);
    if (error instanceof AgentBusyError) return refused(409, error.userMessage);
    if (error instanceof SkillFileError) {
      const status = error.code === 'invalid' ? 400 : error.code === 'too_large' ? 413
        : ['conflict', 'customized', 'no_history', 'unsafe'].includes(error.code) ? 409 : 502;
      return refused(status, error.userMessage);
    }
    return refused(502, 'Could not inspect or change this skill. Reopen its preview before trying again.');
  };

  const readFile: Skills['readFile'] = async (agent, skill, caller) => {
    if (skillFileBusy(agent)) return refused(409, 'Wait for the current operation, then reopen the preview.');
    if (!agent.runtimeRef) return { ok: true, body: {
      id: skill.id, catalog: { version: skill.version, content: skill.content }, revision: null,
      installed: { content: null, hash: null, version: null }, state: 'unavailable',
      canUpdate: false, canReplace: false, canRollback: false, history: [],
    } };
    const session = caller.watch(), before = skillFileContext(agent);
    try {
      const provider = providerFor(agent.hostId);
      const result = await readSkillFile(provider, { runtimeRef: agent.runtimeRef, slug: agent.slug,
        onVolume: agent.state !== 'RUNNING', image: agent.image }, skill.id);
      const fresh = caller.owned(agent.id);
      if (!session.valid() || !fresh || agentGone(agent.id)) throw new TurnRefused(404, 'Not found');
      if (skillFileBusy(fresh) || skillFileContext(fresh) !== before || providerFor(fresh.hostId) !== provider)
        throw new TurnRefused(409, 'The agent changed while reading. Reopen the preview.');
      const editable = skillsEditable(fresh);
      return { ok: true, body: { ...result, canUpdate: editable && result.canUpdate, canReplace: editable && result.canReplace, canRollback: editable && result.canRollback } };
    } catch (error) { return skillFileFailure(error); }
  };

  const changeFile: Skills['changeFile'] = async (agent, skillId, change, caller) => {
    if (!agent.runtimeRef || !skillsEditable(agent)) return refused(409, 'Finish the current operation or restore the agent before changing its skill files.');
    const session = caller.watch(), before = skillFileContext(agent);
    try {
      const provider = providerFor(agent.hostId);
      const result = await withCoreFilesTurn(agent.id, () => whileBusy(agent.id, 'skill-change', async () => {
        const fresh = caller.owned(agent.id);
        if (!session.valid() || !fresh || agentGone(agent.id)) throw new TurnRefused(404, 'Not found');
        if (!fresh.runtimeRef || fresh.ops || skillFileContext(fresh) !== before || providerFor(fresh.hostId) !== provider || isArchiving(fresh.id) || operationRefusal(store, fresh.id))
          throw new TurnRefused(409, 'The agent changed meanwhile. Reopen the preview.');
        const changed = await mutateSkillFile(provider, { runtimeRef: fresh.runtimeRef, slug: fresh.slug,
          onVolume: fresh.state !== 'RUNNING', image: fresh.image }, skillId, change);
        const after = caller.owned(fresh.id);
        if (!session.valid() || !after || agentGone(fresh.id)) throw new TurnRefused(404, 'Not found');
        if (after.ops || skillFileContext(after) !== before || providerFor(after.hostId) !== provider || isArchiving(after.id) || operationRefusal(store, after.id))
          throw new TurnRefused(409, 'The agent changed during the operation. Reopen the preview to inspect its current instructions.');
        store.touchAgentSkills(fresh.id);
        trace(fresh.id)('skills.file_changed', { skill: skillId, action: change.action });
        return changed;
      }));
      if (!session.valid() || !caller.owned(agent.id) || agentGone(agent.id)) throw new TurnRefused(404, 'Not found');
      return { ok: true, body: { ...result, agentUpdatedAt: store.getAgent(agent.id)!.updatedAt } };
    } catch (error) { return skillFileFailure(error); }
  };

  /** The practice cooldown: when each agent may practise again. */
  const skillTrialNext = new Map<string, number>();
  const practice: Skills['practice'] = async (agent, skillId, expectedRevision, caller) => {
    if (agent.state !== 'RUNNING' || !agent.runtimeRef || !skillsEditable(agent)) return refused(409, 'Practice needs a running, idle agent. It does not start the agent for you.');
    // Practice spends what the agent's own calls do (HB-0933): not while its budget holds it.
    const paused = practicePausedLine(store, agent.id);
    if (paused) return refused(409, paused);
    const now = Date.now();
    for (const [id, next] of skillTrialNext) if (next <= now) skillTrialNext.delete(id);
    if (skillTrialNext.has(agent.id)) return { ...refused(429, 'Wait two minutes between practice tasks on this agent.'), retryAfter: String(Math.max(1, Math.ceil((skillTrialNext.get(agent.id)! - now) / 1000))) };
    const session = caller.watch(), before = skillFileContext(agent);
    try {
      const provider = providerFor(agent.hostId);
      const freshForTrial = () => {
        const fresh = caller.owned(agent.id);
        if (!session.valid() || !fresh || agentGone(agent.id)) throw new TurnRefused(404, 'Not found');
        if (!fresh.runtimeRef || fresh.ops || fresh.state !== 'RUNNING' || skillFileContext(fresh) !== before || providerFor(fresh.hostId) !== provider || isArchiving(fresh.id) || operationRefusal(store, fresh.id))
          throw new TurnRefused(409, 'The agent changed during practice. Reopen its skill preview.');
        return fresh;
      };
      return { ok: true, body: await withCoreFilesTurn(agent.id, () => whileBusy(agent.id, 'skill-trial', async () => {
        const fresh = freshForTrial();
        if ((skillTrialNext.get(agent.id) ?? 0) > Date.now()) throw new TurnRefused(429, 'Wait two minutes between practice tasks on this agent.');
        const file = await readSkillFile(provider, { runtimeRef: fresh.runtimeRef!, slug: fresh.slug }, skillId);
        freshForTrial();
        if (file.revision !== expectedRevision) throw new TurnRefused(409, 'The instructions changed. Refresh the preview before practice.');
        if (file.installed.content === null) throw new TurnRefused(409, 'Install the instructions before practice.');
        // Paused by its budget while this waited for its turn.
        const pausedNow = practicePausedLine(store, agent.id);
        if (pausedNow) throw new TurnRefused(409, pausedNow);
        skillTrialNext.set(agent.id, Date.now() + 120_000);
        const { spent, spentFrom, ...result } = await runSkillTrial(provider, { runtimeRef: fresh.runtimeRef!, slug: fresh.slug }, { id: skillId, content: file.installed.content });
        // What it spent is written before anything can refuse the answer (HB-0933):
        // its transcript went with its folder, so nothing else will ever count it.
        const tokens = recordPracticeUsage(store, fresh, skillId, result.status, spent, Date.now());
        freshForTrial();
        trace(agent.id)('skills.practiced', { skill: skillId, status: result.status, tokens, ...(spentFrom ? { spentFrom } : {}) });
        return result;
      })) };
    } catch (error) { return skillFileFailure(error); }
  };

  // Explicit, read-only inspection; ordinary library reads never start a
  // gateway process. Coalesce concurrent clicks only for the same context.
  const skillStatusReads = new Map<string, { context: string; provider: RuntimeProvider; result: Promise<SkillsStatus> }>();
  const status: Skills['status'] = async (agent, caller) => {
    const unknown = (status: 'busy' | 'not_running' | 'unavailable') => ({ ok: true as const, body: { status, skills: [] as [] } });
    const waiting = (a: Agent) => isBusy(a.id) || isArchiving(a.id) || operationRefusal(store, a.id) ||
      a.state === 'PROVISIONING' || a.state === 'REBUILDING';
    if (waiting(agent)) return unknown('busy');
    if (agent.state !== 'RUNNING' || !agent.runtimeRef) return unknown('not_running');
    const session = caller.watch();
    const context = (a: Agent) => JSON.stringify([
      a.ownerId, a.runtimeRef, a.slug, a.hostId, a.state, a.updatedAt, a.gatewayToken,
      a.aiProfileId, a.appliedModel, a.appliedProfileAt, a.curatedSkills, a.appliedCuratedSkills,
      a.browser, a.image, a.rebuildOnStart, store.getHost(a.hostId), store.getAIProfile(a.aiProfileId),
      store.listAgentEnv(a.id), store.listAgentConnections(a.id), store.connectionRemovalsSince(a.id),
      store.listOperations([a.id], 1)[0],
    ]);
    const before = context(agent);
    let provider: RuntimeProvider;
    try { provider = providerFor(agent.hostId); }
    catch { return unknown('unavailable'); }
    let pending = skillStatusReads.get(agent.id);
    if (!pending || pending.context !== before || pending.provider !== provider) {
      pending = { context: before, provider, result: readSkillsStatus(provider, agent.runtimeRef, agent.slug) };
      skillStatusReads.set(agent.id, pending);
    }
    let result: SkillsStatus;
    try { result = await pending.result; }
    finally { if (skillStatusReads.get(agent.id) === pending) skillStatusReads.delete(agent.id); }
    const current = caller.owned(agent.id);
    if (!session.valid() || !current || agentGone(agent.id)) return refused(404, 'Not found');
    if (current.ops) return unknown('unavailable');
    if (waiting(current)) return unknown('busy');
    if (current.state !== 'RUNNING' || !current.runtimeRef) return unknown('not_running');
    if (context(current) !== before) return unknown('unavailable');
    try { if (providerFor(current.hostId) !== provider) return unknown('unavailable'); }
    catch { return unknown('unavailable'); }
    return { ok: true, body: { ...result, ...(result.status === 'checked' ? { checkedAt: new Date().toISOString() } : {}) } };
  };

  return {
    editable: skillsEditable, view: skillsView, save, readFile, changeFile, practice, status,
    stop: () => { skillTrialNext.clear(); },
  };
}
