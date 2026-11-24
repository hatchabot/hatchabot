import type { AIProfile, Agent, AgentClass } from '../../domain/types.js';
import { effectiveSwapAllowance } from '../../domain/swap.js';
import type { Store } from '../../store/store.js';
import { inQueue, semaphore, sixAtATime } from '../../util/queues.js';
import { isBusy } from './busy.js';
import { snapshotModels } from '../usage/modelLedger.js';
import { operationRefusal } from './operations.js';
import { effectiveModel } from './provision.js';
import type { Kept, MemoryLimits } from './memoryLimits.js';
import { machineLoginOnly, modelOverrideProblem, type ModelRuntime } from './modelRuntime.js';

/**
 * Class changes (HB-0807): an edit of a class, its deletion, an agent joining
 * or leaving one, and the tag coming off an agent that drifted from its
 * class. One of the three parts of the agent settings service
 * (agentSettings.ts), which builds it. Only records are written in a class's
 * queue; containers are changed after it, through the other two parts
 * (modelRuntime.ts, memoryLimits.ts).
 *
 * State, each sorted for HB-0809 (docs/architecture.md, "In-memory
 * state, sorted"):
 *  - `classQueues`, one change to a class at a time: an in-process lock.
 *  - `classEditsUnderWay`, the edits of each class from their first check to
 *    the end of their turn, and who waits for them: an in-process lock. What
 *    waits is a detach to decide once the edit is done; that is kept in the
 *    store too (`agent_holds`, 'class-detach'), and one a restart cut off is
 *    decided as the next process builds this service (HB-0820).
 *  - `detachWaits`, how many such decisions each agent still waits for, per
 *    class: an in-process lock (its stored mark goes with the last).
 *  - `classWrote`, what each agent ran once a class was last written to it:
 *    a cache, read only by a join that retries within one request.
 * Not in memory: a class's model waiting for the image that can run it is
 * in the store (`agent_holds`, 'model-waits-image'), written with the model.
 * An edit's records (the class's row and every member's) are one
 * transaction: a process killed in the middle leaves none of them.
 */

/** What detachClassIfDrifted did: the tag came off (`detached`), will be decided once its class's edit is done ('pending'), or stays. `limits`: those put on now. */
export type Detach = { detached: boolean | 'pending'; limits?: Promise<Kept> };
/**
 * What a class change's turn in its queue hands back: a refusal to send
 * (`status`, `body`), or the work left once the queue is let go (`later`:
 * its members' containers, and the answer). Sent and run outside the
 * queue (classStep), so nothing in the queue holds a reply.
 */
export type ClassStep = { status: number; body: unknown } | { later: () => Promise<unknown> };
/**
 * What an agent runs, for a class change to tell whether the agent changed
 * it itself since (changedSince): its source, its image, and its model
 * with the generation of its writes (Store.modelGeneration).
 */
type Since = { gen: number; model?: string; aiProfileId: string; image?: string };
/**
 * A class as one agent will take it: what is written to it (its source,
 * model, image) when its class changes or it joins one.
 */
export type ClassTarget = { id: string; model?: string; aiProfileId?: string; image?: string };
/** Which class settings a check was made for, to tell whether it still fits when written. */
export const classKey = (c: ClassTarget, unpin: boolean): string => JSON.stringify([c.id, c.model ?? null, c.aiProfileId ?? null, c.image ?? null, unpin]);
/**
 * A class checked against one agent, before anything is written and before
 * its class's queue is taken (checkClassFor): every check that asks its
 * machine (an image pin, the runtime a model needs) is made here, so a
 * container slow to answer, or a runner asleep, holds up no other change
 * of the class. `since`: what it ran when it was read for the check (a
 * change of its own made after stands: changedSince); `pin`: its own
 * model then, where the check and the write read it; `for`: the class
 * settings checked (classKey).
 */
export type ClassCheck = { since: Since; for: string; error: string } | {
  since: Since; for: string; switching: boolean; target: AIProfile; imageChange: boolean; unpin: boolean;
  dropPin: boolean; modelWaitsForRebuild: boolean; pin?: string | null;
};
/** A class's machine-login Max source for an agent on a runner: refused at its check and again at its write. */
const CLASS_RUNNER = "the class's machine-login Max source can't reach an agent on a runner — use a setup-token source";
/**
 * A class written to one agent, checked by checkClassFor (`check`, for
 * these settings): its record only, in one transaction, and nothing that
 * asks its machine. `agent`: as read in the class's queue. `from`: the
 * class it is in as the caller read it; `cls.id` for a member of an edit.
 * A change of its own made since its check stands: nothing is written
 * (`changed`); its own model set meanwhile where the check read it, also
 * nothing (`moved`: checked again, it may be written). `ledger`: its model
 * change goes in the ledger as the class's, read around this write alone
 * (it is handed the models as they were before the write).
 * `finish`, when its model is to go on its runtime now, does that
 * container work; the caller runs it once the class's queue is let go.
 */
export type ClassWrite = { rebuild: boolean; error?: string; changed?: boolean; moved?: boolean; finish?: () => Promise<{ rebuild: boolean; modelPending?: string }> };
/** A class change whose checks never fitted the class and its members as they were then, three tries running: nothing written. */
export const classChangedThrice: ClassStep = { status: 409, body: { error: 'The class or its members kept changing while this applied. Nothing was changed; try again.' } };
/**
 * A class edit as asked (PUT /v1/agent-classes/:id), read against the class
 * as it is now: its new settings. `row`: the class as read, which tells
 * whether it changed between the edit's checks and its turn in the queue;
 * `b`: the limits the request named.
 */
export type ClassEdit = { cls: AgentClass; row: string; name: string; model?: string; aiProfileId?: string; image?: string; memoryCap?: string; swapAllowance?: string; b: { memoryCap?: string | null; swapAllowance?: string | null } };
/** The model of each agent before a write, as the model-change ledger reads it (modelLedger.ts snapshotModels). */
export type ModelsBefore = Map<string, string | undefined>;

/** What class changes need from the process they run in. */
export interface ClassChangesDeps {
  store: Store;
  /** A line to the log and to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The setup or rebuild in flight for an agent (the setup and rebuild queue), or undefined. */
  inFlight: (agentId: string) => Promise<void> | undefined;
  /** Deleted or being deleted: nothing more is stored for it. */
  agentGone: (id: string) => boolean;
  models: Pick<ModelRuntime, 'applyModelToRuntime' | 'imagePinCheck' | 'finalModelCheck'>;
  limits: Pick<MemoryLimits, 'limitsTold' | 'limitsAfterDetach'>;
}

export interface ClassChanges {
  /**
   * The class tag off an agent whose source, model or image is no longer
   * what its class sets, and the limits that apply without the class put on
   * its container. Called in one transaction with the write that drifted it.
   */
  detachClassIfDrifted(agentId: string): Detach;
  /** `fn` in the queues of these classes (taken in one order): one change to a class at a time. */
  inClassQueue<T>(classIds: Array<string | null | undefined>, fn: () => Promise<T>): Promise<T>;
  /** An edit of this class is under way, from its first check: a detach waits for classEditEnded. */
  classEditBegun(classId: string): void;
  classEditEnded(classId: string): void;
  /** A class checked against one agent, before anything is written and before its class's queue is taken. */
  checkClassFor(agent: Agent, cls: ClassTarget, unpinAsked?: boolean): Promise<ClassCheck>;
  /** A class written to one agent, checked by checkClassFor: its record only, in one transaction. */
  applyClassToAgent(agent: Agent, cls: ClassTarget, check: ClassCheck, opts: { from: string | null; ledger?: (before: ModelsBefore) => void }): ClassWrite;
  /** Each member of an edited class checked against its new settings, outside the class's queue. */
  checkEditMembers(e: ClassEdit): Promise<Map<string, ClassCheck>>;
  /** An edit's records, in its class's queue: the class row, then each member with its check. */
  writeClassEdit(e: ClassEdit, checks: Map<string, ClassCheck>, last: boolean, ledger: (before: ModelsBefore) => void): ClassStep | { again: true };
  /** It runs what a class last wrote to it: a change found since a check was its class's, not its owner's. */
  asItsClassWroteIt(agentId: string): boolean;
  /** The class's model this agent waits to run until the image that can run it is on (publicAgent's rebuildWaits). */
  modelWaitingForImage(agentId: string): string | undefined;
  /** An agent deleted, or one whose making failed: what was kept for it here goes. */
  forgetAgent(agentId: string): void;
  /**
   * After a restart: the limits of each agent taken out of its class as this
   * service was built (a detach an earlier process had left to be decided),
   * put on its container once `ready` says the agent is (its own operations
   * the start settles are settled, HB-0839). Each agent's on its own: by
   * agent, when its limits are on (what waits for them, its model and its
   * budget). One at a time among those that are ready, as before (each is a
   * docker update of a container). Each never rejects.
   */
  limitsAfterRestart(ready?: (agentId: string) => Promise<void>): Map<string, Promise<void>>;
}

export function createClassChanges(deps: ClassChangesDeps): ClassChanges {
  const { store, trace, inFlight, agentGone } = deps;
  const { applyModelToRuntime, imagePinCheck, finalModelCheck } = deps.models;
  const { limitsTold, limitsAfterDetach } = deps.limits;
  /**
   * A class's model written to an agent whose runtime is too old for it,
   * with the image that brings one new enough (applyClassToAgent's
   * modelWaitsForRebuild): that model is kept for the agent in the store
   * (`agent_holds`, 'model-waits-image'), in the transaction that writes
   * it, so the list says it waits for its rebuild after a restart too
   * (HB-0809). The next class written to it replaces or removes it, and so
   * does the rebuild that makes its new container (provision.ts, recordApplied).
   */
  const modelWaitingForImage = (agentId: string): string | undefined => store.agentHold(agentId, 'model-waits-image');
  /**
   * Edits of each class under way, from their first check to the end of
   * their turn in its queue (PUT /v1/agent-classes/:id), and who waits for
   * them to be done (classEditsDone): a detach decided after them.
   */
  const classEditsUnderWay = new Map<string, { n: number; idle: Array<() => void> }>();
  /**
   * The detach decisions each agent still waits for, per class it may leave
   * (detachClassIfDrifted's 'pending'; keyed by agent and class). Its mark
   * in the store ('class-detach', which names that class) goes with the
   * last of them.
   */
  const detachWaits = new Map<string, number>();
  const detachKey = (agentId: string, classId: string): string => `${agentId}\n${classId}`;
  const classEditBegun = (classId: string): void => {
    const e = classEditsUnderWay.get(classId) ?? { n: 0, idle: [] };
    e.n++;
    classEditsUnderWay.set(classId, e);
  };
  const classEditEnded = (classId: string): void => {
    const e = classEditsUnderWay.get(classId);
    if (!e || --e.n > 0) return;
    classEditsUnderWay.delete(classId);
    for (const go of e.idle) go();
  };
  const classEditsDone = (classId: string): Promise<void> => {
    const e = classEditsUnderWay.get(classId);
    return e ? new Promise<void>((go) => { e.idle.push(go); }) : Promise.resolve();
  };
  /**
   * Q4 of the 2026-09-11 review: a class is a "set" action plus a tag, and a
   * later class edit re-applies to every tagged agent. So when an agent's
   * source or model is changed by hand (card or bulk) to something the class
   * doesn't pin, drop the tag — otherwise the next class edit would silently
   * yank the agent back. `detached`: it did.
   * When the class it leaves set a memory cap or a swap allowance, the
   * limits that apply now go on its container (its own or the
   * fleet's: applyCurrentLimits reads it without its class, whatever the
   * class row says by then), as removing the class by hand does (HB-0561),
   * and a running agent whose limits went on hears its new budget
   * (limitsTold, HB-0599). Here, so every path that detaches does both: the
   * model route, PATCH, the bulk switch and the default-model sweep; the
   * callers only say what happened.
   * Called in one transaction with the model, source or image write that
   * drifted it; the tag comes off only while it is still the class read
   * (setAgentClassIf). The limits start once that has committed and the
   * caller's own steps after it have run: a rebuild under way then (one the
   * caller kicked, or any other), they go on after it, off the request, as
   * it may have read the class's. `limits`: those put on now, to say a
   * refusal (memoryPending, traced). Never rejects.
   * An edit of its class under way (checking its members or writing
   * them, classEditsUnderWay), which may make it look drifted only because
   * it has not reached it yet: decided once the edits under way are done,
   * on the agent as they left it, in the class's queue and off the request
   * (`detached: 'pending'`; a failure traced); its limits then go on
   * outside the queue. Another agent joining or leaving the class does not
   * make it wait. Nothing that runs in a class's queue calls this (the
   * edit, its deletion and a join use driftedFrom), so it never waits on
   * itself.
   * A decision left for later is kept in the store as well ('class-detach',
   * the class it may leave), written here, so in the caller's transaction
   * with the write that drifted it. The process ending before it is decided
   * ends the edit too, whose own write would have taken the agent out: the
   * next process decides it as it builds this service (the loop at the foot
   * of createClassChanges), on the agent and the class as they were left. Without that the agent
   * stayed in its class, and the class's next edit wrote the class's model
   * over its owner's choice (HB-0820).
   */
  // A class with no limits of its own left nothing on its container: not touched (a runner asleep holds up no answer).
  const setsLimits = (cl: AgentClass | undefined): boolean => !!(cl?.memoryCap || cl?.swapAllowance);
  /**
   * A detach left for after its class's edit, decided: the tag comes off
   * when it is still in that class and still not what the class asks for.
   * One transaction with its stored mark, which goes when `last` (no other
   * decision waits for this agent). True: the class set limits, and those
   * that apply without it are to go on its container (limitsAfterDetach).
   */
  const decideDetach = (agentId: string, classId: string, after: string, last: boolean): boolean => store.transact(() => {
    if (last) store.clearAgentHold(agentId, 'class-detach', classId);
    const now = store.getAgent(agentId), cl = store.getAgentClass(classId);
    if (now?.classId !== classId || (cl && !driftedFrom(now, cl)) || !store.setAgentClassIf(agentId, classId, null)) return false;
    trace(agentId)('class.detached', { after });
    return setsLimits(cl);
  });
  const detachClassIfDrifted = (agentId: string): Detach => {
    const a = store.getAgent(agentId);
    if (!a?.classId) return { detached: false };
    const classId = a.classId;
    const c = store.getAgentClass(classId);
    if (c && !driftedFrom(a, c)) return { detached: false };
    if (c && classEditsUnderWay.has(classId)) {
      store.setAgentHold(agentId, 'class-detach', classId);
      const waits = detachKey(agentId, classId);
      detachWaits.set(waits, (detachWaits.get(waits) ?? 0) + 1);
      void classEditsDone(classId).then(() => inClassQueue([classId], async () => {
        const left = (detachWaits.get(waits) ?? 1) - 1;
        if (left > 0) detachWaits.set(waits, left); else detachWaits.delete(waits);
        // Still in that class, and still not what it asks for, once its change is written.
        return decideDetach(agentId, classId, 'once the class change under way was done', left <= 0);
      })).then((limits) => (limits ? limitsAfterDetach(agentId) : undefined))
        .catch((err) => trace(agentId)('class.detach_failed', { why: String((err as Error)?.message ?? err).slice(0, 200) }));
      return { detached: 'pending' };
    }
    if (!store.setAgentClassIf(agentId, classId, null)) return { detached: false };
    return { detached: true, ...(setsLimits(c) ? { limits: Promise.resolve().then(() => limitsAfterDetach(agentId)) } : {}) };
  };
  /**
   * Whether it runs something its class does not (a source, a model, an
   * image the class sets). On its budget's cheaper model, with the class's
   * model the one that comes back when that ends (its open switch's
   * fromModel), it runs what its class sets as far as the class goes.
   */
  const driftedFrom = (a: Agent, c: { model?: string; aiProfileId?: string; image?: string }): boolean => {
    const p = store.getAIProfile(a.aiProfileId);
    const onBudget = (m: string) => { const cheap = store.openCheaperPause(a.id); return !!cheap && cheap.toModel === a.model && cheap.fromModel === m; };
    return !!((c.aiProfileId && c.aiProfileId !== a.aiProfileId) || (c.model && p && effectiveModel(a, p) !== c.model && !onBudget(c.model)) || (c.image && a.image !== c.image));
  };
  /**
   * One change to a class at a time: an edit, its deletion, an agent joining
   * or leaving it. Each reads the class as the one before left it and
   * writes all of it (the class's row, its members' records). Two edits
   * close together applying at once left members on the earlier one's
   * model, and one joining meanwhile missed the edit (HB-0560). Only the
   * records are written in the queue: the containers (a model, memory
   * limits) are changed after it, in each agent's own turn
   * (applyModelToRuntime, applyCurrentLimits), which reads the agent as
   * it is then, so a slow or sleeping container holds up no other change
   * of the class and the last change stored is the one that lands
   * (classStep). Several classes (an agent moving from one to another) are
   * queued for in one order, so two moves the other way round never wait on
   * each other.
   */
  const classQueues = new Map<string, Promise<unknown>>();
  const inClassQueue = <T>(classIds: Array<string | null | undefined>, fn: () => Promise<T>): Promise<T> => {
    const ids = [...new Set(classIds.filter((c): c is string => !!c))].sort();
    return ids.reduceRight<() => Promise<T>>((inner, id) => () => inQueue(classQueues, id, inner), fn)();
  };
  const runsModel = (a: Agent): string | undefined => { const p = store.getAIProfile(a.aiProfileId); return p ? effectiveModel(a, p) : a.model; };
  const sinceOf = (a: Agent): Since => ({ gen: store.modelGeneration(a.id), model: runsModel(a), aiProfileId: a.aiProfileId, image: a.image });
  /**
   * Its source or image changed, or a model was written for it that changed
   * what it runs. A write that keeps what it runs (the same model chosen
   * again) is no change of its own; nor is a new source default it follows,
   * written to no agent, nor a write Hatchabot made on its own (the
   * budget's switch down and restore, the default-model sweep's hold),
   * which leaves the model generation as it was.
   */
  const changedSince = (agentId: string, since: Since): boolean => {
    const now = store.getAgent(agentId);
    if (!now || now.aiProfileId !== since.aiProfileId || (now.image ?? null) !== (since.image ?? null)) return true;
    return store.modelGeneration(agentId) !== since.gen && runsModel(now) !== since.model;
  };
  /**
   * Why a class may not be written to this agent now, or nothing: a source
   * switch not under a rebuild or a move, which reads the source as it goes
   * (HB-0063), and a source or image change not under an operation on disk
   * (held, interrupted), as PATCH and the bulk switch refuse: it resumes on
   * the settings it began with (HB-0573). Asked by checkClassFor before its
   * runtime checks, and by applyClassToAgent just before the write.
   */
  const classWriteRefusal = (agentId: string, switching: boolean, imageChange: boolean): string | undefined => {
    if (switching || imageChange) { const onDisk = operationRefusal(store, agentId); if (onDisk) return onDisk; }
    if (switching && isBusy(agentId)) return 'busy (a rebuild, a move or a backup) — apply the class again when that is done';
    return undefined;
  };
  const checkClassFor = async (agent: Agent, cls: ClassTarget, unpinAsked = false): Promise<ClassCheck> => {
    const since = sinceOf(agent), key = classKey(cls, unpinAsked);
    // Validate the WHOLE class against the agent's TARGET source before writing
    // anything — a failed model check must not leave the agent half-switched.
    const switching = !!cls.aiProfileId && cls.aiProfileId !== agent.aiProfileId;
    const target = store.getAIProfile(switching ? cls.aiProfileId! : agent.aiProfileId);
    if (!target) return { since, for: key, error: switching ? 'class source unavailable' : 'agent has no AI source' };
    if (switching && agent.ops && target.vendor === 'local') return { since, for: key, error: "the Hatchabot agent can't use a local model" };
    // Not under a rebuild, a move or an operation on disk (classWriteRefusal);
    // asked again just before the write, after the runtime checks below.
    const refused = classWriteRefusal(agent.id, switching, false);
    if (refused) return { since, for: key, error: refused };
    if (switching) {
      if (target.ownerId !== agent.ownerId && !target.shared) return { since, for: key, error: 'class source unavailable' };
      // Same layered guard as create/switch: a machine-login Max source is never
      // usable by another account's agent, shared flag or not.
      if (target.kind === 'subscription' && !target.secretRef && target.ownerId !== agent.ownerId) {
        return { since, for: key, error: "a machine-login Max source can't run another account's agent" };
      }
      // A runner cannot use this machine's login, as PATCH and the source switch refuse.
      if (machineLoginOnly(target) && store.getHost(agent.hostId)?.kind !== 'local') return { since, for: key, error: CLASS_RUNNER };
    }
    if (cls.model) {
      const prob = modelOverrideProblem(target, cls.model);
      if (prob) return { since, for: key, error: prob }; // e.g. local source, or model not on this source
    }
    // The class image pins the agent (applied on its next rebuild); no class
    // image leaves whatever pin the agent has, unless the class edit cleared
    // the image that pinned it (unpin: back to the fleet default). Checked
    // like any pin before anything is written: a class image the agent's data
    // cannot go back to is refused for it, as PATCH image refuses it (#147),
    // and a refusal leaves its pin where it was (#149).
    const unpin = unpinAsked && !!agent.image;
    const imageChange = unpin || (!!cls.image && cls.image !== (agent.image ?? undefined));
    if (imageChange) {
      const pin = await imagePinCheck(agent, unpin ? null : cls.image!);
      if (pin.problem) return { since, for: key, error: pin.problem };
    }
    // The class's model on a subscription, against the OpenClaw it will run
    // on: the image a source or image change rebuilds it on, and the
    // container it is applied to now. The model route refused it; a class
    // gave it (audit #069). Too old now but not after the class's new image:
    // it waits for that rebuild rather than break the agent until then.
    // Without a model of its own, the class still decides what the agent runs
    // when it changes its source or image: the agent's pin (dropped on a source
    // that cannot use it), else the source's default, checked the same way
    // (finalModelCheck; a class with only a source skipped it, HB-0556).
    let modelWaitsForRebuild = false;
    let dropPin = false;
    const rebuildOn = unpin ? null : (cls.image ?? agent.image ?? null);
    if (cls.model) {
      if (switching || imageChange) {
        const tooOld = (await finalModelCheck(agent, target, { pin: cls.model, rebuildOn })).problem;
        if (tooOld) return { since, for: key, error: tooOld };
      }
      if (!switching) {
        const tooOld = (await finalModelCheck(agent, target, { pin: cls.model })).problem;
        if (tooOld && !imageChange) return { since, for: key, error: tooOld };
        modelWaitsForRebuild = !!tooOld;
      }
    } else if (switching || imageChange) {
      const runtime = await finalModelCheck(agent, target, { switching, rebuildOn });
      if (runtime.problem) return { since, for: key, error: runtime.problem };
      dropPin = !!runtime.dropPin;
    }
    return {
      since, for: key, switching, target, imageChange, unpin, dropPin, modelWaitsForRebuild,
      // Its own model, which the checks above and the write read (a class without one).
      ...(!cls.model && (switching || imageChange) ? { pin: agent.model ?? null } : {}),
    };
  };
  /**
   * What each agent ran once a class was last written to it
   * (applyClassToAgent): a join that finds the agent changed since its
   * check tells a change of its class (an edit of the class it leaves,
   * written just before in that class's queue) from one of its owner's.
   * An agent's entry goes when it is deleted.
   */
  const classWrote = new Map<string, Since>();
  const applyClassToAgent: ClassChanges['applyClassToAgent'] = (agent, cls, check, opts) => {
    if ('error' in check) return { rebuild: false, error: check.error };
    const { switching, imageChange, unpin, dropPin, modelWaitsForRebuild } = check;
    // The source as it is now, for the checks that read only the store.
    const target = store.getAIProfile(check.target.id) ?? check.target;
    if (cls.model) {
      const prob = modelOverrideProblem(target, cls.model);
      if (prob) return { rebuild: false, error: prob };
    }
    const refused = classWriteRefusal(agent.id, switching, imageChange);
    if (refused) return { rebuild: false, error: refused };
    // Its class, then everything else, in one transaction: written only
    // while it is still in the class the caller read (setAgentClassIf), and
    // its own model, source and image are as its check read them
    // (`since`). A change of its own made meanwhile, outside the class's
    // queue, stands: nothing is written (`changed`), and whether it leaves
    // the class is decided once this change is done (detachClassIfDrifted).
    const before = snapshotModels(store, [agent.id]);
    // Judged again here, as PATCH does: deleted, or moved to a runner for a
    // switch to this machine's login, during the checks, nothing is written;
    // its source deleted past its hold (withSourceHold), nothing either.
    const wrote = store.transact(() => {
      if (agentGone(agent.id)) return 'no-agent' as const;
      if (changedSince(agent.id, check.since)) return 'changed' as const;
      const pin = store.getAgent(agent.id)?.model ?? null;
      if (check.pin !== undefined && pin !== check.pin) return 'moved' as const;
      if (switching) {
        if (machineLoginOnly(target) && store.getHost(store.getAgent(agent.id)!.hostId)?.kind !== 'local') return 'runner' as const;
        // What the store would refuse at the write (setAgentAIProfile), asked before anything is written.
        const src = store.getAIProfile(cls.aiProfileId!);
        if (!src) return 'no-source' as const;
        // Another account's source its owner stopped sharing during the
        // checks above: the agent was put on a source its build then refused (HB-0970).
        const ownerId = store.getAgent(agent.id)!.ownerId;
        if (src.ownerId !== ownerId && (!src.shared || (src.kind === 'subscription' && !src.secretRef))) return 'unshared' as const;
      }
      if (!store.setAgentClassIf(agent.id, opts.from, cls.id)) return 'changed' as const;
      if (switching) {
        store.setAgentAIProfile(agent.id, cls.aiProfileId!);
        if (pin && !cls.model && (dropPin || modelOverrideProblem(target, pin))) store.setAgentModel(agent.id, null);
      }
      // On the cheaper model its budget switched it to (its source kept):
      // the class's model is the one that comes back when that ends.
      // `apply`: its runtime is told once the class's queue is let go
      // (`finish`, below), and the ask for that is stored with the model: a
      // restart between the two leaves it for the next process to tell
      // (modelRuntime.ts applyOwed), not for some later rebuild (HB-0809).
      if (cls.model && !(!switching && pin && pin !== cls.model && store.setCheaperPauseFrom(agent.id, pin, cls.model))) store.setAgentModel(agent.id, cls.model, { apply: !switching && !modelWaitsForRebuild });
      if (imageChange) store.setAgentImage(agent.id, unpin ? null : cls.image!);
      // Its model waits for the image that can run it: kept with the write, or let go with it.
      if (cls.model && modelWaitsForRebuild) store.setAgentHold(agent.id, 'model-waits-image', cls.model); else store.clearAgentHold(agent.id, 'model-waits-image');
      return 'wrote' as const;
    });
    if (wrote === 'changed') return { rebuild: false, changed: true };
    if (wrote === 'moved') return { rebuild: false, moved: true };
    if (wrote !== 'wrote') return { rebuild: false, error: wrote === 'runner' ? CLASS_RUNNER : wrote === 'no-agent' ? 'it was deleted' : wrote === 'unshared' ? 'class source unavailable' : "the class's source was deleted meanwhile" };
    classWrote.set(agent.id, sinceOf(store.getAgent(agent.id) ?? agent));
    opts.ledger?.(before);
    // A source change is applied by a rebuild (auth/env are provision-time);
    // a model-only change applies now (live, or staged on the stopped volume).
    // A runtime that refused it still answers on its old model: said, not
    // counted as applied (audit #068). A source switch already waiting for a
    // rebuild takes the model with it.
    const rebuild = switching || imageChange;
    if (!switching && cls.model && !modelWaitsForRebuild) return { rebuild, finish: () => classModelOn(agent, target, cls.model!, rebuild) };
    return { rebuild };
  };
  /**
   * A class's model put on a member's runtime, once its record is written
   * (applyClassToAgent's `finish`): after its class's queue is let go, in
   * the agent's own turn (applyModelToRuntime), which reads what it runs
   * when it comes, so a later edit's model is the one that lands.
   */
  const classModelOn = async (agent: Agent, target: AIProfile, model: string, rebuild: boolean): Promise<{ rebuild: boolean; modelPending?: string }> => {
    const how = await applyModelToRuntime(agent.id).catch(() => 'failed' as const);
    if (how === 'rebuild') return { rebuild: true };
    if (how === 'gone') return { rebuild, modelPending: `its stored files are not on its machine: its volume is gone, so ${model} could not be written to it (a Rebuild would make a fresh, empty volume)` };
    if (how === 'failed' && !rebuild) {
      return { rebuild, modelPending: `its runtime did not take ${model}, so it still answers on its old model — try again, or Rebuild it to apply` };
    }
    // A rebuild under way: it puts the model on from the record, or, past
    // that step already, the apply chained after it does. Applied there.
    // Neither took it (the rebuild failed, the runtime refused): traced on
    // the agent, which then shows the model still to come (pendingModel)
    // in the list and in its class's row.
    if (how === 'none' && !rebuild && !!inFlight(agent.id)) {
      const id = agent.id;
      const on = () => { const a = store.getAgent(id), p = a && store.getAIProfile(a.aiProfileId); return !a || !p || a.appliedModel === effectiveModel(a, p); };
      void inFlight(id)!.then(async () => {
        if (on()) return;
        const after = await applyModelToRuntime(id).catch(() => 'failed' as const);
        if (after !== 'live' && after !== 'staged' && !on()) trace(id)('model.apply_failed', { model, why: `the rebuild it waited for did not put it on, nor did a try after it (${after})` });
      }).catch(() => undefined);
      return { rebuild };
    }
    // Busy (a snapshot, a backup, a move): stored only. Not applied, so not
    // counted as applied, while its runtime runs another model (HB-0564).
    // With nothing applied on record, it runs what it ran before: its pin,
    // or its source's default (which may be the class's model already).
    const now = how === 'none' && !rebuild ? store.getAgent(agent.id) : undefined;
    if (now?.runtimeRef && !now.migratedTo && (now.state === 'RUNNING' || now.state === 'STOPPED')
      && (now.appliedModel ? now.appliedModel !== model : effectiveModel(agent, target) !== model)) {
      return { rebuild, modelPending: `it was busy with another operation, so ${model} is recorded but it still answers on its old model — apply the class again once that is done, or Rebuild it to apply` };
    }
    return { rebuild };
  };
  const unpinFor = (e: ClassEdit, a: Agent): boolean => !e.image && !!e.cls.image && a.image === e.cls.image;
  const editTarget = (e: ClassEdit): ClassTarget => ({ id: e.cls.id, model: e.model, aiProfileId: e.aiProfileId, image: e.image });
  /** Each member of an edited class checked against its new settings, outside the class's queue. */
  const checkEditMembers = async (e: ClassEdit): Promise<Map<string, ClassCheck>> => {
    const members = store.listAgentsInClass(e.cls.id).filter((a) => a.state !== 'ARCHIVED');
    const checked = await sixAtATime(members, async (a) => [a.id, await checkClassFor(a, editTarget(e), unpinFor(e, a))] as const);
    return new Map(checked);
  };
  /**
   * An edit's records, in its class's queue: the class row, then each member
   * with its check. A member with none that fits these settings (one that
   * joined since, the class changed since) asks for the checks again
   * (`again`); on the last try, nothing is written (classChangedThrice).
   * A member the budget switched to a cheaper model keeps it, and gets
   * the class's model back when that ends (applyClassToAgent).
   * The class's row and every member's record are one transaction
   * (HB-0809): each was its own, so a process killed between two left the
   * class saying one thing and some of its members running another, with
   * nothing to say an edit had been cut off. Now it is all of them or
   * none. What follows the records (each member's container: its model, its
   * limits) is asked for in the store or put right at the next start
   * (modelRuntime.ts applyOwed; the limits check; memoryLimits.ts tellRunning).
   */
  const writeClassEdit: ClassChanges['writeClassEdit'] = (e, checks, last, ledger) => {
    const { cls } = e;
    const target = editTarget(e);
    const members = store.listAgentsInClass(cls.id).filter((a) => a.state !== 'ARCHIVED');
    const fits = (a: Agent) => checks.get(a.id)?.for === classKey(target, unpinFor(e, a));
    if (members.some((a) => !fits(a))) return last ? classChangedThrice : { again: true };
    return store.transact(() => writeEditRecords(e, checks, members, ledger));
  };
  const writeEditRecords = (e: ClassEdit, checks: Map<string, ClassCheck>, members: Agent[], ledger: (before: ModelsBefore) => void): ClassStep => {
    const { cls, name, model, aiProfileId, image, memoryCap, swapAllowance, b } = e;
    const target = editTarget(e);
    // The class row and its members are written with nothing awaited
    // between, so no other change of the class reads the new row before its
    // members have it.
    store.upsertAgentClass({ id: cls.id, ownerId: cls.ownerId, name, model, aiProfileId, image, memoryCap, swapAllowance });
    // Propagate the (possibly changed) model/source/image to every agent in the class.
    // modelPending: members whose runtime refused the class's model — the
    // record has it, the agent still answers on its old one (audit #068).
    type Done = { applied: number; needRebuild: number; skipped: string[]; modelPending: string[] };
    const nothing = (): Done => ({ applied: 0, needRebuild: 0, skipped: [], modelPending: [] });
    // Each member's container work once the queue is let go, six at a time,
    // each in its agent's own turn; said in member order.
    const later: Array<() => Promise<Done>> = [];
    for (const m of members) {
      const a = store.getAgent(m.id);
      if (!a || a.classId !== cls.id) continue; // it left the class meanwhile
      // The class image cleared: members it had pinned go back to the fleet
      // default (needs a rebuild), and the rest of the edit (model, source)
      // still applies — it was skipped (night review). Unpinned only once
      // the whole change passed: a refused model kept the pin gone (#149).
      const r = applyClassToAgent(a, target, checks.get(a.id)!, { from: cls.id, ledger });
      // Its own model, source or image changed since its check: that
      // change stands, and nothing of the class is written to it. Still
      // what the class now asks for, it stays, and the class's limits reach
      // it as they do the rest. Otherwise it leaves the class here, said,
      // rather than stay in it on the class's old settings; the limits that
      // apply without it go on when the class set any.
      // (One taken out of the class meanwhile is not read as a member here:
      // nothing is awaited between this read and its write.)
      // Its own model set while it was checked (`moved`, for a class without a
      // model whose source or image moves): the same.
      if ((r.changed || r.moved) && driftedFrom(store.getAgent(a.id) ?? a, { model, aiProfileId, image })) {
        const left = store.setAgentClassIf(a.id, cls.id, null);
        if (left) trace(a.id)('class.detached', { after: 'as its class was edited, after its own change' });
        const limitsToo = left && !!(cls.memoryCap || cls.swapAllowance || memoryCap || swapAllowance);
        later.push(async () => {
          const kept = limitsToo ? await limitsAfterDetach(a.id) : {};
          const note = kept.memoryPending ? `; its container kept its old memory limits (${kept.why ?? 'not applied'})` : '';
          const what = r.moved ? 'its own model was set while this was checked, and it keeps it' : 'its own model, source or image was changed while this applied, and keeps that change';
          return { ...nothing(), skipped: [`${a.name}: ${what}${left ? '; it left the class' : ''}${note}`] };
        });
        continue;
      }
      // A class cap reaches members without a cap of their own, live.
      // Its swap allowance too (swap.ts), which a class cap can also shrink.
      // Named in the request, they are applied even when the class already
      // says so: a retry after a container refused them saw no change, did
      // nothing and answered with no skips (#220). The limits that apply
      // to it as it is then (applyCurrentLimits): its class's as saved,
      // unless it left the class while the model was applied.
      const capMoved = memoryCap !== cls.memoryCap && !a.memoryCap;
      const swapMoved = swapAllowance !== cls.swapAllowance && !a.swapAllowance;
      const asked = (b.memoryCap !== undefined || b.swapAllowance !== undefined) && (!a.memoryCap || !a.swapAllowance);
      const limits = capMoved || swapMoved || asked || (memoryCap !== cls.memoryCap && !!effectiveSwapAllowance(a, { memoryCap, swapAllowance }));
      later.push(async () => {
        const done = nothing();
        if (r.changed) done.applied++;
        else if (r.error) done.skipped.push(`${a.name}: ${r.error}`);
        else if (r.moved) done.skipped.push(`${a.name}: its own model was set while this was checked — apply the class again`);
        else {
          const on = r.finish ? await r.finish() : { rebuild: r.rebuild, modelPending: undefined };
          if (on.modelPending) done.modelPending.push(`${a.name}: ${on.modelPending}`);
          else { done.applied++; if (on.rebuild) done.needRebuild++; }
        }
        if (!limits) return done;
        // Its new budget, told (HB-0599): unless the cap is its own.
        const out = await limitsTold(a.id, { when: "its class's limits changed", tellIf: () => !a.memoryCap && (capMoved || b.memoryCap !== undefined) });
        if (out.why) done.skipped.push(`${a.name}: ${out.why}`);
        else if (out.applied) {
          if (capMoved) trace(a.id)('memory.cap_set', { cap: 'class', effective: out.applied.memory, live: true });
          if (swapMoved) trace(a.id)('memory.swap_set', { swap: 'class', effective: out.applied.swap ?? 'off', live: true });
        }
        return done;
      });
    }
    return {
      later: async () => {
        const all = await sixAtATime(later, (step) => step());
        return {
          class: store.getAgentClass(cls.id),
          applied: all.reduce((n, d) => n + d.applied, 0),
          needRebuild: all.reduce((n, d) => n + d.needRebuild, 0),
          skipped: all.flatMap((d) => d.skipped),
          modelPending: all.flatMap((d) => d.modelPending),
        };
      },
    };
  };

  /**
   * Detaches an earlier process left to be decided (HB-0820): it ended with
   * an edit of the class under way, and the decision and the edit ended
   * with it. Decided here, as the service is built and before anything is
   * asked of it, so no edit of the class in this process finds the agent
   * still in it and writes the class's settings over its owner's own. On
   * the agent and the class as they were left: an edit that never wrote
   * leaves the class as it was, and one that wrote did so whole
   * (writeClassEdit). The limits of those that left a class which set any
   * go on their containers once the machines are asked (limitsAfterRestart).
   */
  const limitsOwed: string[] = [];
  for (const left of store.agentHolds('class-detach')) {
    try {
      if (decideDetach(left.agentId, left.value, 'when Hatchabot started again: a restart had cut its class change off', true)) limitsOwed.push(left.agentId);
    } catch (err) {
      trace(left.agentId)('class.detach_failed', { why: String((err as Error)?.message ?? err).slice(0, 200) });
    }
  }
  const limitsAfterRestart = (ready: (agentId: string) => Promise<void> = async () => undefined): Map<string, Promise<void>> => {
    // Was all at once since HB-0839, which made them wait each on its own (HB-0839 review).
    const one = semaphore(1);
    return new Map(limitsOwed.splice(0).map((agentId) => [agentId, ready(agentId).catch(() => undefined)
      .then(async () => { await one.acquire(); try { await limitsAfterDetach(agentId); } finally { one.release(); } })
      .then(() => undefined, () => undefined)] as const));
  };

  return {
    detachClassIfDrifted, inClassQueue, classEditBegun, classEditEnded,
    checkClassFor, applyClassToAgent, checkEditMembers, writeClassEdit,
    asItsClassWroteIt: (agentId) => { const byClass = classWrote.get(agentId); return !!byClass && !changedSince(agentId, byClass); },
    modelWaitingForImage,
    forgetAgent: (agentId) => {
      classWrote.delete(agentId);
      for (const waits of [...detachWaits.keys()]) if (waits.startsWith(`${agentId}\n`)) detachWaits.delete(waits);
      store.clearAgentHold(agentId, 'model-waits-image'); store.clearAgentHold(agentId, 'class-detach');
    },
    limitsAfterRestart,
  };
}
