import type { Agent, AIProfile } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { sixAtATime } from '../../util/queues.js';
import { isBusy } from '../lifecycle/busy.js';
import type { Detach } from '../lifecycle/classChanges.js';
import type { Kept } from '../lifecycle/memoryLimits.js';
import { machineLoginOnly, modelOverrideProblem, type ModelRuntime } from '../lifecycle/modelRuntime.js';
import type { SourceHolds } from '../lifecycle/sourceHolds.js';
import { snapshotModels } from '../usage/modelLedger.js';
import { foldDatedIds, openclawAtLeast } from './modelOptions.js';
import { runtimeModels } from './runtimeModels.js';
import { localModelListed } from './warmModels.js';

/**
 * The AI sources service (HB-0808): an
 * AI source (an "AI profile" in code) is a Claude plan via a setup token, an
 * API key, or a local model server. This holds the rules its routes follow
 * when agents move onto a source, when a source's default model changes for
 * the agents on it, and what a source can switch between:
 *
 *  - `switchAgentToSource`: one agent moved onto a source, under a hold on it
 *    (the bulk switches: migrate-agents, adopt-agents);
 *  - `applyDefaultModel`: a new default, with the caller's ticked agents
 *    following it and the rest held on what they run;
 *  - `availableModels`: the models a source's agents could switch between.
 *
 * It keeps no state of its own. The holds on a source are the agent settings
 * service's (`sourceHolds`, which a class change takes too), and a recovery
 * chained after a switch's rebuild is the Recover context feature's, handed
 * in as `recoverAfterRebuild`. So it has no timers, and nothing to stop.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the routes on the shared context (`ctx.sources`). Nothing here knows
 * about HTTP: a route reads its request, asks this, and words the answer.
 * A model change goes in the ledger through a function the route hands in.
 */
export interface AiSources {
  /**
   * Move ONE agent onto `target`: write the source (dropping a model pin the
   * new source lacks, detaching a drifted class), and optionally rebuild with a
   * checkpoint first and/or a transcript recovery chained after the rebuild.
   * Shared by the owner-scoped adopt-agents and the host-owner migrate.
   * Under a hold on the source it goes to, from its first look until it is
   * written, when it is not on it already: its delete is refused meanwhile
   * (HB-0570). What it did is counted in `tally`; a class it leaves takes its
   * memory limits with it, collected in `limits` (limitsSaid).
   */
  switchAgentToSource(listed: Agent, target: AIProfile, opts: SwitchOpts, tally: SwitchTally, limits: Array<Promise<KeptLine | undefined>>): Promise<void>;
  /**
   * Change the default model with EXPLICIT control over which of the caller's
   * existing agents adopt it: the ticked ones (`apply`) follow it, every other
   * agent of theirs on this source is pinned to what it runs today. Refused,
   * with nothing written, when the list would then hold more than a source
   * does (SOURCE_MODELS_MAX), the models kept for held agents among them.
   */
  applyDefaultModel(profile: AIProfile, ownerId: string, change: DefaultModelChange, ledger: Ledger): Promise<DefaultModelApplied>;
  /** What models this source could switch between (the caller's agents on it are asked, for Anthropic). */
  availableModels(profile: AIProfile, ownerId: string): Promise<AvailableModels>;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface AiSourcesDeps {
  store: Store;
  /** A stored secret by its reference (an OpenAI or Google key, to list its models). */
  secretOf: (ref: string) => Promise<string>;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** Deleted or being deleted: nothing more is stored for it. */
  agentGone: (id: string) => boolean;
  /** The agent settings service's model checks and writes (lifecycle/modelRuntime.ts). */
  models: Pick<ModelRuntime, 'sourceSwitchRuntime' | 'subscriptionRuntimeProblem' | 'applyModelToRuntime' | 'askToApply' | 'pushModelList'>;
  /** Take the class off an agent that no longer runs what it sets (lifecycle/classChanges.ts). */
  detachClassIfDrifted: (agentId: string) => Detach;
  /** A hold on the source a switch goes to (lifecycle/sourceHolds.ts). */
  withSourceHold: SourceHolds['withSourceHold'];
  /**
   * Queue a rebuild in the background; false when none was queued (the setup
   * and rebuild queue). `recoverOn`: the recovery chained after it, kept with
   * the rebuild's record, so a restart before it runs does not lose it (HB-0832).
   */
  kickRebuild: (agentId: string, opts: { checkpoint: boolean; recoverOn?: string }) => boolean;
  /** Keep a change for the agent's next start or wake, which is then a rebuild. */
  oweRebuild: (agentId: string) => unknown;
  /**
   * Recover the agent's conversation once the rebuild just queued for it is
   * done, on its new source (Recover context's turn, reserved now). Best-effort.
   */
  recoverAfterRebuild: (agentId: string) => void;
}

/** What a bulk switch asks of each agent. */
export type SwitchOpts = { rebuild?: boolean; checkpoint?: boolean; recoverAfter?: boolean };
/** What a bulk switch did, counted as it goes; the answer the routes send. */
export type SwitchTally = { switched: number; rebuilding: number; atNextStart: number; notRecovered: number; classDetached: number; classDetachPending?: number; skipped: Array<{ name: string; reason: string }> };
/** Each agent whose model moved since `before` goes in the ledger, as `source` ('default-model', 'source-default'). */
export type Ledger = (source: string, before: Map<string, string | undefined>) => void;
/** POST /v1/ai-profiles/:id/apply-default-model, as read. */
export type DefaultModelChange = { model: string; models?: string[]; apply?: string[] };
export type DefaultModelApplied = {
  profile: Omit<AIProfile, 'secretRef'>;
  applied: number; held: number; live: number; staged: number; classDetached: number;
  classDetachPending?: number; volumeGone?: number; notSwitched?: Array<{ id: string; name: string; reason: string; why: NotSwitchedWhy }>;
  /** Other accounts' agents kept on their model, and of them `othersUnchecked`: on the source only since the last round of checks began, never checked (HB-1342). */
  othersHeld?: number; othersUnchecked?: number;
  memoryPending?: string[]; limitsKept?: Array<{ name: string; why: string }>;
} | {
  /** The list, with the models kept for agents that stay on theirs, would hold more than a source does: nothing was written (HB-0907). */
  refused: 'menu-full'; error: string;
} | {
  /** The source was deleted while the runtime checks waited: nothing was written. */
  refused: 'gone'; error: string;
};
/** Why one of the caller's agents was not switched: its runtime is too old for the new default, its model was changed while this applied, or it joined the source too late to be checked (HB-1342). */
export type NotSwitchedWhy = 'runtime' | 'changed' | 'late';

/** How many times a new default's apply looks for agents that joined its source while its runtime checks waited, and checks them (HB-1342). */
const JOIN_ROUNDS = 3;

/** The most models a source's list holds, its default among them: what create and edit take (src/api/usage/aiSourceRoutes.ts) and the editor sends. */
export const SOURCE_MODELS_MAX = 16;

/** How many of the caller's agents, and how many of other accounts', stay on a model a new default's list keeps. */
export type ModelHolders = ReadonlyMap<string, {
  mine: number;
  /** Of `mine`, those the caller could tick to follow the new default: not one ticked already and too old for it, nor one whose own choice made meanwhile stands. */
  tickable: number;
  others: number;
}>;

/**
 * Why a new default's list is too long, and what the caller can do to make
 * it fit (HB-0907): take off what they chose that no agent stays on, tick
 * more of their agents to follow the new default, or choose a model already
 * on the list as the default. A model another account's agent stays on is
 * that account's to free, never offered as the caller's to change.
 */
export function menuFullError(newDefault: string, chosen: readonly string[], holders: ModelHolders): string {
  const picked = new Set(chosen.filter((m) => m !== newDefault));
  const kept = [...holders.keys()].filter((m) => m !== newDefault && !picked.has(m));
  const theirs = kept.filter((m) => (holders.get(m)?.others ?? 0) > 0);
  const yours = kept.filter((m) => !theirs.includes(m));
  const agentsOn = (models: string[], whose: 'mine' | 'others') => models.reduce((n, m) => n + (holders.get(m)?.[whose] ?? 0), 0);
  const total = 1 + picked.size + kept.length;
  const over = total - SOURCE_MODELS_MAX;
  const and = (parts: string[]) => parts.length > 2 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join(' and ');

  const parts = ['the new default'];
  if (picked.size) parts.push(`${picked.size} you chose`);
  if (yours.length) {
    const one = agentsOn(yours, 'mine') === 1;
    parts.push(theirs.length
      ? `${yours.length} kept for ${one ? 'your agent that stays on its' : 'your agents that stay on theirs'}`
      : `${yours.length} kept for ${one ? 'an agent that stays on its' : 'agents that stay on theirs'}`);
  }
  if (theirs.length) parts.push(`${theirs.length} kept for ${agentsOn(theirs, 'others') === 1 ? "another account's agent" : "other accounts' agents"}`);

  // What the caller can free, cheapest first: a model they chose that no
  // agent stays on comes off the list; one only their own agents stay on,
  // agents that could follow the new default, goes once those are ticked
  // (and comes off the list too, when they chose it). A model another
  // account's agent stays on, or one of theirs too old to follow, stays.
  const byTicking = (m: string) => { const h = holders.get(m); return !!h && h.others === 0 && h.mine > 0 && h.tickable === h.mine; };
  let need = over;
  const take = (n: number) => { const t = Math.min(need, n); need -= t; return t; };
  const removed = take([...picked].filter((m) => !holders.has(m)).length);
  const ticked = take(kept.filter(byTicking).length);
  const tickedChosen = take([...picked].filter(byTicking).length);
  // A default already on the list takes no place of its own.
  const onList = need === 1;
  if (need > 1) {
    return theirs.length
      ? `This source's list would hold ${total} models: ${and(parts)}. A source holds ${SOURCE_MODELS_MAX}, and ${theirs.length} of these stay on it for other accounts' agents until those accounts move them to other models: ask them to, then save again.`
      : `This source's list would hold ${total} models: ${and(parts)}. A source holds ${SOURCE_MODELS_MAX}, and what is left stays on it for your agents too old to follow the new default: give them a newer runtime image first, then save again.`;
  }
  const steps: string[] = [];
  if (removed + tickedChosen) steps.push(`remove ${removed + tickedChosen} from Also switchable`);
  if (ticked + tickedChosen) steps.push(theirs.length ? 'tick more of your agents to follow the new default' : 'tick more agents to follow the new default');
  if (onList) steps.push('choose as the new default a model already on the list');
  return `This source's list would hold ${total} models: ${and(parts)}. A source holds ${SOURCE_MODELS_MAX}: ${and(steps)}, then save again.`;
}
export type AvailableModels = { models: string[]; error?: string; stale?: string[]; source?: 'runtime' | 'curated'; openclawVersion?: string };

/** One agent of a batch whose container kept its old limits, or nothing; never rejects. */
export type KeptLine = { name: string; why: string; line: string };
export const keptLine = (name: string, limits: Promise<Kept>): Promise<KeptLine | undefined> =>
  limits.then((r) => (r.memoryPending ? { name, why: r.why ?? 'not applied', line: `${name}: ${r.memoryPending}` } : undefined), () => undefined);
/**
 * The kept limits of a batch, in its order, once all have answered: the
 * sentences (memoryPending, "Name: …") and their parts (limitsKept).
 */
export const limitsSaid = async (limits: Array<Promise<KeptLine | undefined>>): Promise<{ memoryPending?: string[]; limitsKept?: Array<{ name: string; why: string }> }> => {
  const kept = (await Promise.all(limits)).filter((k): k is KeptLine => !!k);
  return kept.length ? { memoryPending: kept.map((k) => k.line), limitsKept: kept.map(({ name, why }) => ({ name, why })) } : {};
};

/**
 * Is this agent on the source: what it WILL use, or what its container still
 * runs NOW (a switch waiting for its rebuild leaves the old source's token in
 * the container, 30th audit). The count the list shows and the rule delete
 * applies.
 */
export const usesSource = (a: Agent, profileId: string): boolean =>
  a.aiProfileId === profileId || (a.appliedProfileId === profileId && a.state !== 'ARCHIVED' && !!a.runtimeRef);

/** The Claude models a new Anthropic source is stocked with, and the offline
 *  fallback for available-models. Newest-first; keep in step with pricing.ts. */
export const CURATED_ANTHROPIC_MODELS = [
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-fable-5',
] as const;

/** A local model server must live on this box or a private network. */
export function isPrivateModelUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname;
  return (
    h === 'localhost' ||
    h === '::1' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    // Not 169.254.* or *.internal: no model server lives there, and on a
    // cloud machine that is the metadata service (26th audit).
    h.endsWith('.local')
  );
}

/**
 * Reachability + model check for a local model server. The control plane can
 * reach the docker bridge (it owns it), so this validates the same address
 * the agent will use.
 */
export async function checkLocalServer(
  baseUrl: string,
  model: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Loopback is the trap: the control plane runs on the host and CAN reach
  // it, so a naive reachability probe passes — but the agent runs in a
  // container where localhost is the container itself. Reject it outright.
  const host = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return '';
    }
  })();
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) {
    return {
      ok: false,
      error:
        `${baseUrl} points at this machine's loopback, which an agent container ` +
        `cannot reach — inside a container "localhost" is the container itself. ` +
        `Use the docker bridge instead: http://172.17.0.1:11434/v1`,
    };
  }

  const root = baseUrl.replace(/\/v1\/?$/, '');
  let tags: { models?: Array<{ name?: string }> };
  try {
    const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `The model server answered ${res.status} at ${root}.` };
    tags = (await res.json()) as typeof tags;
  } catch {
    return {
      ok: false,
      error:
        `Couldn't reach a model server at ${baseUrl}. Note this address must work ` +
        `from inside a container — the host's own localhost does not. Try ` +
        `http://172.17.0.1:11434/v1, and make sure the server listens on more ` +
        `than loopback (Ollama: OLLAMA_HOST=0.0.0.0:11434).`,
    };
  }
  const names = (tags.models ?? []).map((m) => m.name).filter(Boolean) as string[];
  // A list with nothing in it is the server saying it has no model: any
  // model was taken, and the source saved could answer nothing (HB-1130).
  // An answer with no list at all says nothing either way, and is taken.
  if (Array.isArray(tags.models) && !names.length) {
    return {
      ok: false,
      error: `That server has no models yet, so it cannot run "${model}". Pull one there first (Ollama: ollama pull ${model}), then add the source.`,
    };
  }
  // A name with no tag is the one Ollama serves as its `:latest` (HB-1339).
  if (names.length && !localModelListed(names, model)) {
    return {
      ok: false,
      error: `That server has no model "${model}". It offers: ${names.slice(0, 8).join(', ')}.`,
    };
  }
  return { ok: true };
}

export function createAiSources(deps: AiSourcesDeps): AiSources {
  const { store, providerFor, agentGone, detachClassIfDrifted, withSourceHold, kickRebuild, oweRebuild, recoverAfterRebuild } = deps;
  const { sourceSwitchRuntime, subscriptionRuntimeProblem, applyModelToRuntime, askToApply, pushModelList } = deps.models;

  /**
   * The switch itself, under the hold switchAgentToSource takes.
   * A class it leaves takes its memory limits with it, in that agent's own
   * turn: started here and not waited for, so a batch on a runner asleep
   * does not wait for each in turn. `limits` collects them, each the line
   * to say when its container kept the old ones; the caller waits for them
   * all at once (limitsSaid).
   */
  const switchAgentToSourceHeld = async (
    listed: Agent,
    target: AIProfile,
    opts: SwitchOpts,
    tally: SwitchTally,
    limits: Array<Promise<KeptLine | undefined>>,
  ): Promise<void> => {
    // The agent as it is when its step comes, and again after the runtime
    // check's wait, not as the batch listed it: one moved to a runner
    // meanwhile was switched onto this machine's login.
    const begun = store.getAgent(listed.id);
    if (!begun || agentGone(listed.id)) {
      tally.skipped.push({ name: listed.name, reason: 'it was deleted' });
      return;
    }
    if (begun.aiProfileId === target.id) return; // already here — nothing to do
    // Before the checks below, which must see the agent as it is when it is written.
    const runtime = await sourceSwitchRuntime(begun, target);
    const a = store.getAgent(listed.id);
    if (!a || agentGone(listed.id)) {
      tally.skipped.push({ name: listed.name, reason: 'it was deleted' });
      return;
    }
    if (a.aiProfileId === target.id) return;
    if (runtime.problem) {
      tally.skipped.push({ name: a.name, reason: runtime.problem });
      return;
    }
    // A machine-login Max source (no secretRef) can't reach a runner-hosted
    // agent, exactly as create/move/PATCH enforce. Refuse per agent rather
    // than fail the whole batch.
    if (machineLoginOnly(target) && store.getHost(a.hostId)?.kind !== 'local') {
      tally.skipped.push({ name: a.name, reason: "machine-login Max can't run on a runner — use a setup-token source" });
      return;
    }
    // The rules create and PATCH keep, per agent (night review, 2026-09-28):
    // the manager cannot reach a local model; a machine-login Max source is
    // its owner's ~/.claude and never runs another account's agent.
    if (a.ops && target.vendor === 'local') {
      tally.skipped.push({ name: a.name, reason: "the Hatchabot agent can't use a local model" });
      return;
    }
    if (target.kind === 'subscription' && !target.secretRef && target.ownerId !== a.ownerId) {
      tally.skipped.push({ name: a.name, reason: "a machine-login Max source can't run another account's agent" });
      return;
    }
    // Deleted while its runtime was asked about: not switched to (HB-0570).
    // Not under a rebuild or a move: it reads the source as it goes (HB-0063).
    if (isBusy(a.id) || store.activeOperationFor(a.id)) {
      tally.skipped.push({ name: a.name, reason: 'busy (a rebuild, a move or a backup) — switch it when that is done' });
      return;
    }
    // The class comes off in one transaction with the source and model
    // written (setAgentClassIf), and takes its memory limits with it
    // (detachClassIfDrifted): after a rebuild kicked below, as nothing is
    // awaited before it is kicked (a backup or a move could start in that
    // gap); without one, now, and a container that kept the old ones is
    // named (memoryPending). One whose class is still applying a change
    // leaves it once that is done, and this does not wait for it.
    const fresh = store.getAgent(a.id) ?? a;
    // The source's write first: the store refuses it for an agent or a
    // source deleted meanwhile, and then nothing is written (HB-0570).
    const dropped = store.transact(() => {
      const set = store.setAgentAIProfile(a.id, target.id);
      if (set !== 'ok') return set;
      // Drop a model pin the new source doesn't offer, so the agent falls back
      // to the new default instead of provisioning healthy and failing on use.
      // The pin as it is now, read here: one its owner set while the checks
      // above ran (or while earlier agents of the batch switched) stands when
      // the new source offers it; the runtime's refusal (dropPin) was of the
      // pin those checks read.
      const pin = store.getAgent(a.id)?.model;
      if (pin && (modelOverrideProblem(target, pin) || (runtime.dropPin && pin === begun.model))) store.setAgentModel(a.id, null);
      return detachClassIfDrifted(a.id);
    });
    if (typeof dropped === 'string') {
      tally.skipped.push({ name: a.name, reason: dropped === 'no-agent' ? 'it was deleted' : 'that AI source was deleted meanwhile' });
      return;
    }
    tally.switched++;
    if (dropped.detached === true) tally.classDetached++;
    else if (dropped.detached === 'pending') tally.classDetachPending = (tally.classDetachPending ?? 0) + 1;
    // Stopped or asleep, it stays so and takes the new source when it next
    // starts: a rebuild would start it, on a source it may not have been meant
    // to spend on, and in Migrate all it may be another account's (HB-0411).
    // Its next start is a plain rebuild, so a recovery asked for here does not
    // run: the answer counts them, and Recover context is there once it is up.
    // So with any agent no rebuild started for here (archived, still being set
    // up, a rebuild refused): a recovery only runs chained to one, below.
    let recoveryChained = false;
    if (opts.rebuild && fresh.runtimeRef && fresh.state === 'STOPPED') {
      oweRebuild(a.id);
      tally.atNextStart++;
    } else if (opts.rebuild && fresh.runtimeRef && fresh.state === 'RUNNING') {
      // Checkpoint only a RUNNING agent — a stopped one has no live turn to
      // summarise. Each runs as the first step of its own background rebuild.
      const checkpoint = opts.checkpoint === true;
      const kicked = kickRebuild(a.id, { checkpoint, ...(opts.recoverAfter ? { recoverOn: target.id } : {}) });
      if (kicked) {
        tally.rebuilding++;
        if (opts.recoverAfter) {
          // Chain onto the rebuild's own task so recovery runs on the NEW
          // source, after the container is healthy. Best-effort.
          recoverAfterRebuild(a.id);
          recoveryChained = true;
        }
      }
    }
    if (opts.recoverAfter && !recoveryChained) tally.notRecovered++;
    if (dropped.limits) limits.push(keptLine(a.name, dropped.limits));
  };
  const switchAgentToSource: AiSources['switchAgentToSource'] = (a, target, opts, tally, limits) =>
    withSourceHold(a.aiProfileId !== target.id ? target.id : undefined, () => switchAgentToSourceHeld(a, target, opts, tally, limits));

  // Change the default model with EXPLICIT control over which of the caller's
  // existing agents adopt it (the "select agents, hold the rest" apply). The
  // plain PATCH lets followers drift to the new default on their next
  // rebuild; this instead:
  //   • sets the new default,
  //   • clears the override on every SELECTED agent so it follows the new
  //     default (and optionally rebuilds it now), and
  //   • PINS every other agent of yours on this source to the model it runs
  //     today, so it never silently switches — the pinned models are kept on
  //     the menu so the pins stay valid.
  // Only your own agents are touched; a shared source's other users keep theirs.
  const applyDefaultModel: AiSources['applyDefaultModel'] = async (profile, ownerId, change, ledger) => {
    const newDefault = change.model;
    const applyIds = new Set(change.apply ?? []);

    const mine = store.listAgents(ownerId).filter((a) => a.aiProfileId === profile.id);
    // Each one's model as asked for when this began: a model chosen for it
    // during the runtime checks below is newer than this apply, and used to
    // be cleared or written over by what was read here (HB-0889).
    const gens = new Map(mine.map((a) => [a.id, store.modelGeneration(a.id)]));
    const ledgerBefore = snapshotModels(store, mine.map((a) => a.id));
    // On a shared source, other accounts' followers move with the default too.
    const others = store.listAllActiveAgents().filter((a) => a.aiProfileId === profile.id && a.ownerId !== ownerId);
    const gone = (a: Agent) => a.state === 'DELETING' || a.state === 'DELETED';
    const othersBefore = snapshotModels(store, others.map((a) => a.id));

    // The runtime checks come first, and are the only waits: nothing is
    // written until every one has answered, so a list that would be too long
    // is refused with nothing changed (HB-0907).
    // A selected agent whose OpenClaw is too old for the new default on a
    // subscription is held like the rest instead: switched, every message
    // would fail with an opaque HTTP 400 (subscriptionRuntimeProblem; the
    // rule a class model and the model route keep, audit #069). Said per
    // agent in `notSwitched` (HB-0232). An agent with no container is judged
    // on the image it would be built on.
    const notSwitched: Array<{ id: string; name: string; reason: string; why: NotSwitchedWhy }> = [];
    const cannotFollow = new Set<string>(); // ticked, and too old for the new default: ticking it frees nothing
    for (const a of mine) {
      if (!applyIds.has(a.id)) continue;
      const tooOld = await subscriptionRuntimeProblem(a, profile, newDefault, a.runtimeRef ? undefined : (a.image ?? null));
      if (tooOld) { applyIds.delete(a.id); cannotFollow.add(a.id); notSwitched.push({ id: a.id, name: a.name, reason: tooOld, why: 'runtime' }); }
    }
    // Another account's agent that follows the default moves with it, so it
    // gets the same runtime check a ticked one of ours does: one whose
    // OpenClaw is too old for the new default on a subscription is pinned to
    // what it runs today instead (HB-0245). Counted, never named: they are
    // not the caller's agents. Each is checked whatever its pin: its owner
    // may clear the pin while these checks wait, and it then follows the
    // new default, which only a check lets it do.
    const othersFine = new Set<string>(), othersChecked = new Set<string>();
    for (const a of others) {
      if (gone(a)) continue;
      othersChecked.add(a.id);
      if (!(await subscriptionRuntimeProblem(a, profile, newDefault, a.runtimeRef ? undefined : (a.image ?? null)))) othersFine.add(a.id);
    }
    // An agent that joined the source while those checks waited (moved onto
    // it, its own or another account's) is checked too before it may follow
    // the new default: a few rounds at most, as each round's checks are a
    // wait in which another may join. Before, one of the caller's followed
    // the new default unchecked, and another account's was held unchecked,
    // a pin its owner did not choose (HB-1342). Its model as it joined goes
    // in the ledger's snapshot, so a move to the new default is recorded.
    const seen = new Set([...mine, ...others].map((a) => a.id));
    const joinedMine: Agent[] = [];
    const joinedFine = new Set<string>();
    const joinedTooOld = new Map<string, string>();
    for (let round = 0; round < JOIN_ROUNDS; round++) {
      const joined = store.listAllActiveAgents().filter((a) => a.aiProfileId === profile.id && !gone(a) && !seen.has(a.id));
      if (!joined.length) break;
      for (const a of joined) {
        seen.add(a.id);
        (a.ownerId === ownerId ? ledgerBefore : othersBefore).set(a.id, snapshotModels(store, [a.id]).get(a.id));
        if (a.ownerId === ownerId) joinedMine.push(a);
      }
      for (const a of joined) {
        const tooOld = await subscriptionRuntimeProblem(a, profile, newDefault, a.runtimeRef ? undefined : (a.image ?? null));
        if (a.ownerId !== ownerId) { othersChecked.add(a.id); if (!tooOld) othersFine.add(a.id); }
        else if (tooOld) joinedTooOld.set(a.id, tooOld);
        else joinedFine.add(a.id);
      }
    }
    // One of the caller's that joined during the last round's checks, too
    // late to be checked: held below, and named. Read with the writes, as
    // nothing waits from here on.
    for (const a of store.listAllActiveAgents()) {
      if (a.ownerId !== ownerId || a.aiProfileId !== profile.id || gone(a) || seen.has(a.id)) continue;
      seen.add(a.id);
      ledgerBefore.set(a.id, snapshotModels(store, [a.id]).get(a.id));
      joinedMine.push(a);
    }

    // From here to the writes nothing waits, so each agent is judged as it
    // is now, after those checks, and what is counted for the list is what
    // is pinned. So is the source: its default and its list as an edit made
    // while the checks waited left them, which were written over from the
    // record this was given (HB-1340).
    const current = store.getAIProfile(profile.id);
    // Deleted while the checks waited (no agent on it any more): nothing is written.
    if (!current) return { refused: 'gone', error: 'This AI source was deleted while its new default was being applied: nothing was changed.' };
    const oldDefault = current.model;
    // On a shared source, another account's pins are held the same way: its
    // stored pin was kept, but left off the menu effectiveModel ignored it
    // and moved that agent onto our new default (A098). Only a pin that was
    // valid before this call — one already stale stays stale.
    const oldMenu = [oldDefault, ...(current.models ?? [])];
    // Held = "runs today": its override, or for a follower the
    // model it was last built with on this source (the page shows that one),
    // and the OLD default only when nothing was applied yet. A default saved
    // but not yet applied to it is not what it runs: pinned to that, the
    // "held" agent changed model at its next rebuild (audit #098).
    // Selected = clear the override so it follows the new default.
    const pins: Array<[string, string | null]> = [];
    // Each held model, and how many of the caller's agents and of other accounts' stay on it.
    const holders = new Map<string, { mine: number; tickable: number; others: number }>();
    const hold = (model: string, whose: 'mine' | 'others', canTick = false) => {
      const h = holders.get(model) ?? { mine: 0, tickable: 0, others: 0 };
      h[whose]++;
      if (whose === 'mine' && canTick) h.tickable++;
      holders.set(model, h);
    };
    let held = 0;
    let applied = 0; // agents actually changed — NOT the ids the caller sent
    for (const read of mine) {
      // Moved to another source, or being deleted, meanwhile: it is not this source's to pin or switch.
      const a = store.getAgent(read.id);
      if (!a || a.aiProfileId !== profile.id || gone(a)) { applyIds.delete(read.id); continue; }
      // A model of its own chosen meanwhile stands. Set back to follow the
      // default meanwhile, it asks what this gives it: switched, and live.
      if (applyIds.has(a.id) && a.model && store.modelGeneration(a.id) !== gens.get(a.id)) {
        applyIds.delete(a.id);
        notSwitched.push({ id: a.id, name: a.name, reason: 'its model was changed while this applied, and that choice stands', why: 'changed' });
        hold(a.model, 'mine');
        continue;
      }
      if (applyIds.has(a.id)) {
        applied++;
        if (a.model) pins.push([a.id, null]);
      } else {
        const runsNow = a.appliedProfileId === profile.id && a.appliedModel ? a.appliedModel : undefined;
        const runs = a.model ?? runsNow ?? oldDefault;
        pins.push([a.id, runs]); // pin (no-op if already this override): a hold, not a change of its own
        hold(runs, 'mine', !cannotFollow.has(a.id));
        held++;
      }
    }
    // One of the caller's that joined while the checks waited (HB-1342): its
    // own pin on the list stands; following the default, it follows the new
    // one once its check let it. Too old, or joined too late to be checked,
    // it is held on what it runs, and named with why.
    for (const read of joinedMine) {
      const a = store.getAgent(read.id);
      if (!a || a.aiProfileId !== profile.id || gone(a)) continue;
      if (a.model && oldMenu.includes(a.model)) { hold(a.model, 'mine'); continue; }
      if (joinedFine.has(a.id)) continue;
      const runsNow = a.appliedProfileId === profile.id && a.appliedModel ? a.appliedModel : oldDefault;
      pins.push([a.id, runsNow]);
      hold(runsNow, 'mine', !joinedTooOld.has(a.id));
      held++;
      const tooOld = joinedTooOld.get(a.id);
      notSwitched.push({ id: a.id, name: a.name, reason: tooOld ?? 'it joined this source while the new default was applied, too late to be checked, so it stays on what it runs', why: tooOld ? 'runtime' : 'late' });
    }
    // Another account's agent, as it is now too: one whose own pin (chosen
    // meanwhile, perhaps) is on the list keeps it; one following the default
    // follows the new one only when its check found it can run it. Too old,
    // or never checked (on the source only since the last round of checks
    // began), it is held on what it runs: holding changes nothing it runs,
    // where following unchecked could put it on a model its runtime refuses
    // (HB-0245).
    let othersHeld = 0, othersUnchecked = 0;
    for (const a of store.listAllActiveAgents()) {
      if (a.aiProfileId !== profile.id || a.ownerId === ownerId || gone(a)) continue;
      if (a.model && oldMenu.includes(a.model)) { hold(a.model, 'others'); continue; }
      if (!othersFine.has(a.id)) {
        const runsNow = a.appliedProfileId === profile.id && a.appliedModel ? a.appliedModel : oldDefault;
        pins.push([a.id, runsNow]);
        hold(runsNow, 'others');
        othersHeld++;
        if (!othersChecked.has(a.id)) othersUnchecked++;
      }
    }

    // Menu must contain the new default, the owner's extras, AND every held
    // model — otherwise effectiveModel treats a held pin as stale and the
    // agent drifts to the new default, defeating the hold. A source holds 16,
    // the held among them: a longer list, stored, is one the editor cannot
    // send back (HB-0907), so it is refused here, before anything is written.
    // The list asked for was read when Save was pressed (the app always
    // sends one): a model added to the source or taken off it while the
    // checks waited stays added or taken off, merged three ways against the
    // record this was given (HB-1340 review). Asked for none: the list as it
    // is now.
    const was = profile.models ?? [], now = current.models ?? [];
    const takenOff = new Set(was.filter((m) => !now.includes(m)));
    const extras = [...new Set([...(change.models ?? now), ...now.filter((m) => !was.includes(m))])].filter((m) => !takenOff.has(m));
    const menu = [...new Set([newDefault, ...extras, ...holders.keys()])];
    if (menu.length > SOURCE_MODELS_MAX) return { refused: 'menu-full', error: menuFullError(newDefault, extras, holders) };
    // The ticked agents whose class pinned another model come off it in
    // one transaction with the new default (setAgentClassIf).
    const drops = store.transact(() => {
      for (const [id, model] of pins) {
        if (model === null) store.setAgentModel(id, null);
        else store.setAgentModel(id, model, { hatchabot: true });
      }
      store.setAIProfileModel(profile.id, newDefault);
      store.setAIProfileModels(profile.id, menu);
      // `menu` is built from OUR held models only, so scope the sweep to us —
      // another owner's pin isn't ours to clear.
      store.clearStaleAgentModels(profile.id, menu, ownerId);
      // Each ticked agent's runtime is asked for the new default here, with it:
      // one that follows the default has no model write of its own, and the
      // loop below reaches each in turn, so a restart before its turn left it
      // waiting for its rebuild (HB-0832). The next start serves what is left.
      // The caller's own only: `apply` may name another account's agent.
      for (const a of mine) if (applyIds.has(a.id)) askToApply(a.id);
      return new Map(mine.filter((a) => applyIds.has(a.id)).map((a) => [a.id, detachClassIfDrifted(a.id)]));
    });
    // The switched agents' changes go in the ledger; the held ones did not move.
    ledger('default-model', ledgerBefore);
    ledger('source-default', othersBefore);

    // Apply the new default LIVE to the switched agents that are RUNNING —
    // OpenClaw reads the model per turn, so `models set` takes effect on the
    // next message with no rebuild or downtime. Stopped/archived switched
    // agents already had their override cleared, so they follow the new
    // default when they next start (nothing to rebuild).
    // applyModelToRuntime re-reads agent + profile from the store, so it sees
    // the NEW default (the local `profile` object above is stale after
    // setAIProfileModel — using it applied the OLD model to every agent).
    let live = 0, staged = 0, volumeGone = 0, classDetached = 0, classDetachPending = 0;
    // A class dropped takes its memory limits with it, and the agent is told
    // its new budget; a container that kept the old ones is named. Each in
    // its own turn, waited for together at the end (limitsSaid).
    const limits: Array<Promise<KeptLine | undefined>> = [];
    for (const a of mine) {
      const dropped = drops.get(a.id);
      if (!dropped) continue;
      // A member of a class still applying a change leaves it once that is done.
      if (dropped.detached === true) classDetached++; else if (dropped.detached === 'pending') classDetachPending++;
      if (dropped.limits) limits.push(keptLine(a.name, dropped.limits));
      const how = await applyModelToRuntime(a.id);
      if (how === 'live') live++; else if (how === 'staged') staged++; else if (how === 'gone') volumeGone++;
    }
    // The list changed too (the new default, the held models): every agent
    // on the source gets it, after the switched ones took their model (HB-0668).
    void pushModelList(profile.id).catch(() => undefined);
    const kept = await limitsSaid(limits);

    // Deleted since the writes (every agent moved off it meanwhile): as it was written.
    const { secretRef: _s, ...safe } = store.getAIProfile(profile.id) ?? { ...current, model: newDefault, models: menu };
    // `applied` counts agents this call actually touched. It previously
    // echoed applyIds.size, which over-reported when the caller passed ids
    // that aren't theirs (a shared profile's other users) — they're filtered
    // out of `mine`, so nothing happened to them.
    return { profile: safe, applied, held, live, staged, classDetached, ...(classDetachPending ? { classDetachPending } : {}), ...(volumeGone ? { volumeGone } : {}), ...(notSwitched.length ? { notSwitched } : {}), ...(othersHeld ? { othersHeld } : {}), ...(othersUnchecked ? { othersUnchecked } : {}), ...kept };
  };

  // What models this profile could switch between — so the app can offer a
  // pick-list instead of making the owner hand-type IDs (a typo like
  // "claude-opus-4.8" provisions green and only fails on first use). Live for
  // a local server (it knows what it has pulled); a curated current list for
  // the cloud vendors. The route checks it is the caller's own or shared.
  const availableModels: AiSources['availableModels'] = async (profile, ownerId) => {
    if (profile.vendor === 'local') {
      if (!profile.baseUrl) return { models: [] };
      const root = profile.baseUrl.replace(/\/v1\/?$/, '');
      try {
        const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return { models: [], error: `The model server answered ${res.status}.` };
        const data = (await res.json()) as { models?: Array<{ name?: string }> };
        return { models: (data.models ?? []).map((m) => m.name ?? '').filter(Boolean) };
      } catch {
        return { models: [], error: "Couldn't reach the model server to list its models." };
      }
    }
    if (profile.vendor === 'openai') {
      // Live list: a key sees exactly the models its account may call. Chat
      // models only — the catalogue also carries embeddings, audio and image
      // ids an agent can't hold a conversation with.
      const key = profile.secretRef ? await deps.secretOf(profile.secretRef).catch(() => undefined) : undefined;
      if (!key) return { models: [] };
      try {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) return { models: [] };
        const data = (await res.json()) as { data?: Array<{ id?: string }> };
        const models = (data.data ?? [])
          .map((m) => m.id ?? '')
          .filter((id) => id && /^(gpt|o\d)/.test(id))
          .filter((id) => !/(embed|audio|whisper|tts|image|dall-e|moderation|realtime|transcribe)/.test(id))
          .sort();
        return { models };
      } catch {
        return { models: [] };
      }
    }
    if (profile.vendor === 'google') {
      // Live list, since key holders get exactly what their key can call.
      const key = profile.secretRef ? await deps.secretOf(profile.secretRef).catch(() => undefined) : undefined;
      if (!key) return { models: [] };
      // Every page: Google answers a page at a time with a token for the
      // next, and the first page alone was offered as the whole list, every
      // model past it left out with no word (HB-1129). Up to ten pages of a
      // thousand, all in one six seconds. A list read only in part is not
      // offered: Sync takes what Google does not list off the menu.
      const partial = { models: [], error: "Google's list of this key's models could be read only in part, so nothing is offered from it: try again in a moment." };
      const signal = AbortSignal.timeout(6000);
      const models = new Set<string>();
      let pageToken: string | undefined;
      let page = 0;
      try {
        for (; page < 10; page++) {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
            { signal },
          );
          if (!res.ok) return page ? partial : { models: [] };
          const data = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>; nextPageToken?: unknown };
          for (const m of data.models ?? []) {
            const id = (m.name ?? '').replace(/^models\//, '');
            if (id && (m.supportedGenerationMethods ?? []).includes('generateContent')) models.add(id);
          }
          pageToken = typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
          if (!pageToken) return { models: [...models] };
        }
        return partial; // still another page after ten
      } catch {
        return page ? partial : { models: [] };
      }
    }
    // Anthropic. Prefer asking a LIVE agent on this profile what its runtime
    // actually serves: a static list once offered claude-opus-5, which the
    // claude-cli (Max) runtime has no catalog entry for — it became a fleet
    // default and every conversation broke on compaction. See runtimeModels.
    // The agent on the NEWEST OpenClaw is asked: the first one found could run
    // an older image (a runner's, a pinned one), whose smaller catalog pruned
    // the menu for every agent on the source (HB-0082). The answer says which
    // runtime it came from.
    // Every candidate's version is read before the newest two are asked for
    // their catalogue: taking the first twelve first left a newer runtime past
    // them unasked (HB-0565). One listing of each machine's containers, not
    // an inspect per agent, the machines at once; where a provider has no
    // listing or it failed, those agents are inspected, six at a time in all,
    // and no more than twelve of them, as the menu asked before (a listing
    // that fails on a big fleet does not become an inspect per agent).
    const running = store
      .listAgents(ownerId)
      .filter((a) => a.aiProfileId === profile.id && a.state === 'RUNNING' && a.runtimeRef);
    const byHost = new Map<string, Agent[]>();
    for (const a of running) { const onHost = byHost.get(a.hostId); if (onHost) onHost.push(a); else byHost.set(a.hostId, [a]); }
    // A machine not known here (gone from the list: providerFor throws) has its agents left out, not the menu failed.
    const known = [...byHost].flatMap(([hostId, onHost]) => { try { return [{ prov: providerFor(hostId), onHost }]; } catch { return []; } });
    const listings = await Promise.all(known.map(async ({ prov, onHost }) => {
      const listed = prov.openclawVersions ? await prov.openclawVersions(onHost.map((a) => a.runtimeRef!)).catch(() => undefined) : undefined;
      return { prov, onHost, listed };
    }));
    const versions: Array<{ a: Agent; v?: string }> = listings.flatMap(({ onHost, listed }) => (listed ? onHost.map((a) => ({ a, v: listed.get(a.runtimeRef!) })) : []));
    const unlisted = listings.flatMap(({ prov, onHost, listed }) => (listed ? [] : onHost.map((a) => ({ prov, a })))).slice(0, 12);
    versions.push(...await sixAtATime(unlisted, async ({ prov, a }) => ({ a, v: (await prov.info(a.runtimeRef!).catch(() => undefined))?.openclawVersion })));
    const newer = (x?: string, y?: string) => (x && y ? (openclawAtLeast(x, y) ? (openclawAtLeast(y, x) ? 0 : -1) : 1) : x ? -1 : y ? 1 : 0);
    versions.sort((x, y) => newer(x.v, y.v));
    const provOf = new Map(listings.flatMap(({ prov, onHost }) => onHost.map((a) => [a.id, prov] as const)));
    for (const { a: live, v } of versions.slice(0, 2)) {
      const found = await runtimeModels(provOf.get(live.id)!, live.runtimeRef!, 'anthropic');
      const usable = found.filter((m) => m.catalogued).map((m) => m.id);
      // Only trust a non-empty answer; an old CLI without --all returns nothing.
      if (usable.length) {
        // Anything this profile still lists that the runtime does NOT serve is
        // junk (claude-opus-5 was exactly this). Report it separately instead of
        // blending it into the offered list, so the app can strip it from the
        // menu rather than keep presenting a model that breaks on compaction.
        const listed = [profile.model, ...(profile.models ?? [])].filter(Boolean) as string[];
        const stale = [...new Set(listed.filter((m) => !usable.includes(m)))];
        // Offered once per model: a dated id where the undated one is served
        // too only spent a place in the list (HB-0669). Stale is still read
        // against everything served, so a dated id a source lists is not junk.
        return { models: foldDatedIds(usable), stale, source: 'runtime' as const, ...(v ? { openclawVersion: v } : {}) };
      }
    }
    // Fallback: a curated current list (no live agent to ask yet, e.g. the
    // profile's first agent hasn't been created). Offline-safe.
    return { models: [...CURATED_ANTHROPIC_MODELS], source: 'curated' as const };
  };

  return { switchAgentToSource, applyDefaultModel, availableModels };
}
