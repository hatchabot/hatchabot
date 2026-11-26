import { defaultMemoryCap, effectiveMemoryCap, formatMemoryCap, memberMemoryMax, parseMemoryCap } from '../../domain/memoryCap.js';
import { agentMemoryLimits, formatSwapAllowance, parseSwapAllowance } from '../../domain/swap.js';
import type { Agent } from '../../domain/types.js';
import { ProviderError, type RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { keyedLock, sixAtATimeWhenReady } from '../../util/queues.js';
import { containerUp, type UpWait } from './afterRestart.js';
import { busyDone, isBusy } from './busy.js';
import { syncMemoryBudget } from './provision.js';

/**
 * Memory limits (HB-0807): how an agent's memory cap and swap allowance reach
 * its container, and how a running agent hears its new budget. One of the
 * three parts of the agent settings service (agentSettings.ts), which builds
 * it.
 *
 * State, each sorted for HB-0809:
 *  - `limitApplies`, each agent's turn for its container's limits: an
 *    in-process lock. The limits themselves are in the store, and the limits
 *    check puts back on a container what a restart left half done.
 *  - `budgetSyncs`, the agents being told a new budget: an in-process lock
 *    with one wanted run behind it. A run still waiting when the process
 *    ends (the agent busy or being rebuilt), or never asked for because it
 *    ended between a cap's write and the ask, is made up for by the next
 *    process: it tells every running agent its budget once (`tellRunning`),
 *    as a start or a wake tells the one agent, and a section that already
 *    says the cap is left as it is.
 *  - `budgetWaits`, the timers of the waits for a busy agent: an in-process
 *    lock, which `stop()` ends.
 */

/** Limits its container kept: the sentence (memoryPending) and its reason alone (why), for clients to word. */
export type Kept = { memoryPending?: string; why?: string };
/** What applyCurrentLimits did: kept (Kept), went on (`applied`), or refused by a machine that answers (`refused`). */
export type LimitsOut = Kept & { applied?: { memory: string; swap?: string }; refused?: string };
/**
 * An answer's limits its container kept: the sentence (memoryPending) and,
 * beside it, its parts (limitsKept: whose, and the reason alone), which the
 * app and the manager word themselves rather than parse the sentence.
 */
export const keptSaid = (name: string, k: Kept | undefined): { memoryPending?: string; limitsKept?: { name: string; why: string } } =>
  k?.memoryPending ? { memoryPending: k.memoryPending, limitsKept: { name, why: k.why ?? 'not applied' } } : {};
/**
 * Why this memory cap may not be set by this caller, or undefined. The same
 * words setMemoryCap answers with; a class's cap obeys the same per-agent
 * maximum as an agent's own (memoryCap.ts). `machineOwner`: asked only for a
 * cap above that maximum, which the account that set the machine up may set.
 */
export const memoryCapProblem = (cap: string, machineOwner: () => boolean): { status: number; error: string } | undefined => {
  const bytes = parseMemoryCap(cap);
  if (!bytes) return { status: 400, error: `A memory cap looks like "4g" or "1536m", at least 512m.` };
  const max = parseMemoryCap(memberMemoryMax())!;
  if (bytes > max && !machineOwner()) {
    return { status: 403, error: `Up to ${memberMemoryMax()} per agent here; the machine's owner can go higher (HATCHABOT_AGENT_MEMORY_MAX).` };
  }
  return undefined;
};
/**
 * Why this swap allowance may not be set (swap.ts), or undefined: a size or
 * "off", and never more than the memory cap it sits on top of. Members are
 * bound by the same per-agent maximum as for the cap.
 */
export const swapAllowanceProblem = (input: string, cap: string, machineOwner: () => boolean): { status: number; error: string } | undefined => {
  const bytes = parseSwapAllowance(input);
  if (bytes === undefined) return { status: 400, error: 'A swap allowance looks like "2g" or "512m" (at least 256m), or "off".' };
  const capBytes = parseMemoryCap(cap) ?? parseMemoryCap(defaultMemoryCap())!;
  if (bytes > capBytes) return { status: 400, error: `At most the memory cap it sits on top of (${formatMemoryCap(capBytes)}). Raise the cap first, or give it less swap.` };
  if (bytes > parseMemoryCap(memberMemoryMax())! && !machineOwner()) return { status: 403, error: `Up to ${memberMemoryMax()} per agent here; the machine's owner can go higher (HATCHABOT_AGENT_MEMORY_MAX).` };
  return undefined;
};
/** A change of an agent's own limits, put on its container as if stored (applyCurrentLimits). */
export type LimitsChange = { memoryCap?: string | null; swapAllowance?: string | null };

/** What the memory limits need from the process they run in. */
export interface MemoryLimitsDeps {
  store: Store;
  /** The runtime provider of a host. Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log and to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The setup or rebuild in flight for an agent (the setup and rebuild queue), or undefined. */
  inFlight: (agentId: string) => Promise<void> | undefined;
  /** One write of an agent's AGENTS.md at a time: the turn a save of it takes. */
  withAgentsMdTurn: <T>(agentId: string, fn: () => Promise<T>) => Promise<T>;
  /** After a restart: how long a container the record says is running is waited for (afterRestart.ts). */
  upWait: UpWait;
}

export interface MemoryLimits {
  /** An agent's turn for its container memory limits (applyCurrentLimits): one at a time per agent. */
  inLimitsTurn<T>(agentId: string, fn: () => Promise<T>): Promise<T>;
  /**
   * The limits that apply to an agent put on its container, as stored or
   * with `how.change`. Its caller holds the agent's limits turn. Never rejects.
   */
  applyCurrentLimits(agentId: string, how?: { change?: LimitsChange; forClass?: boolean }): Promise<LimitsOut>;
  /** applyCurrentLimits for a class path, in the agent's turn, and its budget told when they went on. */
  limitsTold(agentId: string, opts?: { when?: string; tellIf?: (now: Agent) => boolean }): Promise<LimitsOut>;
  /** For limitsTold's `tellIf`: the cap it runs on now is not `before`. */
  capMovedFrom(before: string): (now: Agent) => boolean;
  /** A class taken off: its limits, now or after a rebuild under way. Never rejects. */
  limitsAfterDetach(agentId: string): Promise<Kept>;
  /** A running agent whose memory cap moved hears its new budget (AGENTS.md). Never rejects. */
  tellMemoryBudget(agentId: string): Promise<void>;
  /**
   * After a restart: every running agent on a machine that answers is told
   * its budget, six at a time, so one an earlier process had still to tell
   * is told. Each once `ready` says its agent is (its own operations the
   * start settles are settled, HB-0839). Never rejects.
   */
  tellRunning(ready?: (agentId: string) => Promise<void>): Promise<void>;
  /** Set (or clear) an agent's own memory cap on its container now; `record` stores it. */
  setMemoryCap(agent: Agent, cap: string | null, machineOwner: () => boolean): Promise<{ error?: string; status?: number; applied?: string; own?: string | null; live?: boolean; record?: (log?: (event: string, detail: Record<string, unknown>) => void) => void } & Kept>;
  /** Set (or clear) an agent's own swap allowance on its container now; `record` stores it. */
  setSwapAllowance(agent: Agent, input: string | null, withCap?: { memoryCap?: string | null }): Promise<{ error?: string; status?: number; live?: boolean; record?: () => void; after?: () => Promise<void> } & Kept>;
  /** End the waits under way (an agent that stays busy) and start no more: at shutdown. */
  stop(): void;
}

export function createMemoryLimits(deps: MemoryLimitsDeps): MemoryLimits {
  const { store, providerFor, trace, inFlight, withAgentsMdTurn } = deps;
  /**
   * The limits that apply now put on its container, and its budget told
   * when they went on (each agent on its own: one stuck, busy or being
   * rebuilt, holds up none of the others), unless `tellIf`, asked of it as
   * it is then, says no (capMovedFrom: only if the cap it runs on changed).
   * Limits its container kept are traced with the container's own reason,
   * `when` saying what moved them. Every class path puts limits on through
   * it: a detach, an edit's members, a class deleted, a join or a leave.
   */
  const limitsTold = (agentId: string, opts: { when?: string; tellIf?: (now: Agent) => boolean } = {}): Promise<LimitsOut> => inLimitsTurn(agentId, () => applyCurrentLimits(agentId, { forClass: true })).then((r) => {
    const now = store.getAgent(agentId);
    if (r.applied) { if (now && (opts.tellIf?.(now) ?? true)) void tellMemoryBudget(agentId).catch(() => undefined); }
    else if (r.memoryPending) trace(agentId)('memory.limits_kept', { why: r.why ?? 'not applied', when: opts.when ?? 'its class was taken off' });
    return r;
  });
  /** For limitsTold's `tellIf`: the cap it runs on now is not `before`. */
  const capMovedFrom = (before: string) => (now: Agent): boolean =>
    effectiveMemoryCap(now, now.classId ? store.getAgentClass(now.classId) : undefined) !== before;
  /** A class taken off: its limits, now or after a rebuild under way (detachClassIfDrifted). Never rejects. */
  const limitsAfterDetach = (agentId: string): Promise<Kept> => {
    const rebuilding = inFlight(agentId);
    if (!rebuilding) return limitsTold(agentId);
    void rebuilding.catch(() => undefined).then(() => limitsTold(agentId)).catch(() => undefined);
    return Promise.resolve({});
  };
  /**
   * How a change of an agent's limits reaches its container: the limits that
   * apply to it put on its container, as stored (its own, its class's, the
   * fleet's) or with `how.change`, not at some later rebuild. A container
   * that could not take them keeps its old ones until it is rebuilt: said
   * in memoryPending (#138), and `why` is the container's reason alone.
   * Never rejects.
   * Its caller holds the agent's limits turn (inLimitsTurn), so it reads
   * the agent as it is when that comes: a class edit's apply that read it
   * as a member, still at work when the agent left the class, no longer
   * lands after the one its leaving asked for and puts the class's limits
   * back on; and no other change of its limits lands between PATCH's docker
   * call and its record. The limits sweep, fleet defaults and Start take
   * that same turn and read the desired limits once it comes (HB-0653).
   * Its callers:
   * - every class path (limitsTold: an edit's members, a class deleted, a
   *   join, a leave, a detach), with `forClass`: an agent with a cap and a
   *   swap allowance of its own is left alone, as its limits never depended
   *   on its class, so there is nothing to put on, nor a machine away to
   *   warn of;
   * - PATCH's own cap or swap allowance (setMemoryCap, setSwapAllowance),
   *   with `change`, put on as if stored; PATCH stores it in its one
   *   transaction, in the same turn. Not taken on a machine that answers
   *   (docker refused it: a cap below what it uses, a value docker rejects;
   *   or any other error there), it is not stored (`refused`, a 502): kept,
   *   a later rebuild would put it on and could kill the agent for memory.
   *   A machine gone (providerFor throws) or not answering (reachable()
   *   false: a runner asleep), or no container running to change, keeps it:
   *   stored, and said in memoryPending where its container kept the old
   *   limits;
   * - PATCH stopping after one of its docker calls moved the limits (a
   *   later one refused, or the change refused at its write, HB-0570):
   *   neither, which puts the container back on what the store says.
   */
  const limitApplies = keyedLock();
  /** An agent's turn for its container memory limits (applyCurrentLimits): limitsTold takes it for a class path, PATCH for its own cap or swap. */
  const inLimitsTurn = <T>(agentId: string, fn: () => Promise<T>): Promise<T> => limitApplies.run(agentId, fn);
  const applyCurrentLimits = async (agentId: string, how: { change?: LimitsChange; forClass?: boolean } = {}): Promise<LimitsOut> => {
    const { change } = how;
    const now = store.getAgent(agentId);
    if (!now) return {};
    if (how.forClass && now.memoryCap && now.swapAllowance) return {};
    if (!now.runtimeRef || (now.state !== 'RUNNING' && now.state !== 'STOPPED')) return {};
    // The cap and the swap allowance (swap.ts) together: either may be the class's.
    const as: Agent = !change ? now : {
      ...now,
      ...('memoryCap' in change ? { memoryCap: change.memoryCap ?? undefined } : {}),
      ...('swapAllowance' in change ? { swapAllowance: change.swapAllowance ?? undefined } : {}),
    };
    const lim = agentMemoryLimits(store, as);
    // Its machine gone from the list (providerFor throws) is a reason like any other.
    let prov: RuntimeProvider;
    try { prov = providerFor(now.hostId); } catch {
      return { why: 'its machine is not known here', memoryPending: 'Its container kept its old memory limits (its machine is not known here); a rebuild applies them.' };
    }
    if (!prov.updateMemory) return {};
    try { await prov.updateMemory(now.runtimeRef, lim.memory, lim.swap); return { applied: lim }; }
    catch (err) {
      const said = err instanceof ProviderError ? err.userMessage : undefined;
      // Its machine answers, and the change did not go on: whatever the error,
      // a change of its own is refused and not stored. Kept only for a
      // machine that does not answer (asleep, offline).
      if (change && (prov.reachable ? await prov.reachable().catch(() => false) : true)) {
        return { refused: said, why: said };
      }
      return { why: said ?? 'memory cap not applied', memoryPending: `Its container kept its old memory limits (${said ?? 'not applied'}); a rebuild applies them.` };
    }
  };
  /**
   * A running agent whose memory cap moved hears its new budget (AGENTS.md):
   * its own cap set, or a class assigned, edited, deleted or dropped, which
   * changed the container's cap and left the agent sizing jobs to the old
   * one (HB-0599). The budget is about its container, so it is told even
   * with a source switch waiting for its rebuild.
   * Only that section (syncMemoryBudget): off the request, outside the busy
   * flag and the agent's model queue, so it never refuses a Rebuild nor
   * holds up a model change, and so it leaves the agent's peers, tools and
   * other sections to the syncs that hold the agent. A save made while it
   * works is not written over (audit #096, HB-0230): it replaces AGENTS.md
   * only if it is still what it read, checked and renamed in the turn a
   * save takes (withAgentsMdTurn); changed meanwhile, it reads it again, a
   * few times at most.
   * Per agent, one at work and at most one more wanted: asks made meanwhile
   * are that one, which reads all they stored.
   * Busy (a backup, a move, a restore), it waits for that to end (busyDone),
   * then looks again: up to BUDGET_BUSY_MAX_MS, past which it gives up,
   * traced (memory.budget_not_told), and lets the next change start afresh
   * rather than hold its place for good; one asked while it waited is not
   * dropped, and waits its own while. Being rebuilt, it waits for the
   * rebuild, which may have written AGENTS.md before the cap moved.
   * Stopped or moved away, it is left to its next start. Never rejects.
   */
  const budgetSyncs = new Map<string, { again: boolean; done: Promise<void> }>();
  const BUDGET_BUSY_MAX_MS = 30 * 60_000;
  /** The waits for a busy agent under way, and whether stop() was called: it ends them, and no run starts after it. */
  const budgetWaits = new Set<{ timer: NodeJS.Timeout; stop: AbortController }>();
  let stopped = false;
  const stopWaits = (): void => {
    stopped = true;
    for (const w of budgetWaits) { clearTimeout(w.timer); w.stop.abort(); }
    budgetWaits.clear();
  };
  const tellMemoryBudget = (agentId: string): Promise<void> => {
    if (stopped) return Promise.resolve();
    const at = budgetSyncs.get(agentId);
    if (at) { at.again = true; return at.done; }
    const entry = { again: true, done: Promise.resolve() };
    budgetSyncs.set(agentId, entry);
    entry.done = (async () => {
      let raced = 0;
      // Checked and let go with nothing awaited between, so no ask falls between the two.
      // Anything that throws (its machine gone: providerFor) ends this one,
      // traced, and lets the next ask start afresh.
      try {
        while (entry.again && !stopped) {
          entry.again = false;
          const a = store.getAgent(agentId);
          if (!a?.runtimeRef || a.state !== 'RUNNING' || a.migratedTo) continue;
          const rebuilding = inFlight(agentId);
          if (rebuilding) { await rebuilding.catch(() => undefined); entry.again = true; continue; }
          if (isBusy(agentId)) {
            // Its wait ends with the agent free or the time limit, and a wait
            // that timed out is taken off the agent's waiters (busyDone's signal).
            const stop = new AbortController();
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; stop.abort(); }, BUDGET_BUSY_MAX_MS);
            timer.unref?.();
            const wait = { timer, stop };
            budgetWaits.add(wait);
            await busyDone(agentId, stop.signal);
            clearTimeout(timer);
            budgetWaits.delete(wait);
            if (stopped) break;
            if (!timedOut) { entry.again = true; continue; }
            trace(agentId)('memory.budget_not_told', { why: `it stayed busy (a backup, a move) for ${BUDGET_BUSY_MAX_MS / 60_000} minutes; the next change of its cap tells it` });
            // Asked again while it waited: that ask is not dropped, it waits its own while.
            continue;
          }
          const provider = providerFor(a.hostId);
          const out = await syncMemoryBudget({ store, provider }, a.id, a.runtimeRef, trace(a.id), (commit) => withAgentsMdTurn(agentId, commit))
            .catch(() => 'failed' as const);
          if (out === 'changed') {
            if (++raced < 3) entry.again = true;
            else trace(agentId)('memory.budget_not_told', { why: 'AGENTS.md kept changing while it was written' });
          }
        }
      } catch (err) {
        trace(agentId)('memory.budget_not_told', { why: String((err as Error)?.message ?? err).slice(0, 200) });
      } finally {
        budgetSyncs.delete(agentId);
      }
    })();
    return entry.done;
  };
  /**
   * What a restart cost (HB-0809): an ask still waiting for a busy or
   * rebuilding agent went with the process (budgetSyncs), and so did one
   * not yet made (the process ended after a cap was stored, before its
   * container work reached the ask). Nothing records which agents those
   * were, and nothing needs to: telling is asking the file, and a section
   * that says the cap its container has is left as it is. So every running
   * agent is told once, as each is at its start or wake. An agent on a
   * machine that does not answer now (a runner asleep) is left to its next
   * start, wake, rebuild or change of cap, as a tell made while its machine
   * is away always was. One whose container is not up yet (the whole machine
   * restarted) is waited for a little first (afterRestart.ts).
   */
  const tellRunning = async (ready: (agentId: string) => Promise<void> = async () => undefined): Promise<void> => {
    const answers = new Map<string, Promise<boolean>>();
    const machineAnswers = (hostId: string): Promise<boolean> => {
      let known = answers.get(hostId);
      if (!known) {
        known = (async () => { const p = providerFor(hostId); return p.reachable ? p.reachable() : true; })().catch(() => false);
        answers.set(hostId, known);
      }
      return known;
    };
    try {
      const running = store.listAllActiveAgents().filter((a) => a.state === 'RUNNING' && !!a.runtimeRef && !a.migratedTo);
      await sixAtATimeWhenReady(running, (a) => ready(a.id), async (a) => {
        if (stopped || !(await machineAnswers(a.hostId))) return;
        if (!(await containerUp(providerFor(a.hostId), a.runtimeRef!, deps.upWait).catch(() => false))) return;
        await tellMemoryBudget(a.id).catch(() => undefined);
      });
    } catch { /* the list could not be read: the next start tells them */ }
  };
  /**
   * Set (or clear) an agent's own memory cap and apply it to its container
   * right away. A member may go up to the machine's per-agent maximum
   * (HATCHABOT_AGENT_MEMORY_MAX, default 8g); the machine owner beyond it.
   * The cap hits the container has so far become the baseline, so the
   * "hit its cap" note stops showing hits from before the raise.
   */
  const setMemoryCap: MemoryLimits['setMemoryCap'] = async (agent, cap, machineOwner) => {
    let own: string | null = null;
    if (cap !== null) {
      const bytes = parseMemoryCap(cap);
      if (!bytes) return { error: `A memory cap looks like "4g" or "1536m", at least 512m.` };
      own = formatMemoryCap(bytes);
      const max = parseMemoryCap(memberMemoryMax())!;
      if (bytes > max && !machineOwner()) {
        return { status: 403, error: `Up to ${memberMemoryMax()} per agent here; the machine's owner can go higher (HATCHABOT_AGENT_MEMORY_MAX).` };
      }
    }
    // The cap hits its container has so far become the baseline, read before
    // the new cap goes on. Then the limits it makes go on its container
    // (applyCurrentLimits, in the limits turn PATCH holds): refused by docker
    // on a machine that answers, nothing is stored (502); a machine gone or
    // asleep keeps it, said in memoryPending.
    const now = store.getAgent(agent.id) ?? agent;
    const effective = effectiveMemoryCap({ memoryCap: own ?? undefined }, now.classId ? store.getAgentClass(now.classId) : undefined);
    let baseline: number | undefined, baselineStartedAt: string | undefined;
    if (now.runtimeRef && (now.state === 'RUNNING' || now.state === 'STOPPED')) {
      try { const info = await providerFor(now.hostId).info(now.runtimeRef); baseline = info.memCapHits; baselineStartedAt = info.startedAt; } catch { /* no reading: no baseline */ }
    }
    // Its record is the caller's, written with the rest of its change
    // (PATCH's one transaction); its trace goes to `log`, which PATCH writes
    // once the change is committed. The agent hears its new budget
    // (AGENTS.md) once the whole change is stored: PATCH tells it at its end (HB-0230).
    const record = (log = trace(agent.id)) => {
      store.setAgentMemoryCap(agent.id, own, baseline, baselineStartedAt);
      log('memory.cap_set', { cap: own ?? 'default', effective, live: !!now.runtimeRef });
    };
    const out = await applyCurrentLimits(agent.id, { change: { memoryCap: own } });
    if ('refused' in out) return { status: 502, error: out.refused ?? "Couldn't change the container's memory cap." };
    return { applied: effective, own, record, live: !!out.applied, ...(out.memoryPending ? { memoryPending: out.memoryPending, why: out.why } : {}) };
  };
  /**
   * Set (or clear) an agent's own swap allowance and apply it to its container
   * right away, with its cap. As setMemoryCap: on its container now
   * (applyCurrentLimits, in the limits turn PATCH holds), its record for the
   * caller to store (`withCap`: a cap set in the same change, not yet
   * stored), and its trace (`after`) once the change is.
   */
  const setSwapAllowance: MemoryLimits['setSwapAllowance'] = async (agent, input, withCap = {}) => {
    const own = input === null ? null : formatSwapAllowance(parseSwapAllowance(input)!);
    // Refused by docker on a machine that answers, nothing is stored (502).
    const out = await applyCurrentLimits(agent.id, { change: { ...withCap, swapAllowance: own } });
    if ('refused' in out) return { status: 502, error: out.refused ?? "Couldn't change the container's swap allowance." };
    const after = async () => {
      const now = store.getAgent(agent.id) ?? agent;
      const lim = out.applied ?? agentMemoryLimits(store, now);
      let host: Awaited<ReturnType<NonNullable<RuntimeProvider['compressedSwap']>>> | undefined;
      if (lim.swap) { try { host = await providerFor(now.hostId).compressedSwap?.(); } catch { /* no reading */ } }
      trace(agent.id)('memory.swap_set', { swap: own ?? 'default', effective: lim.swap ?? 'off', live: !!out.applied, ...(lim.swap && host && !host.compressed ? { withheld: host.kind } : {}) });
    };
    return { record: () => store.setAgentSwapAllowance(agent.id, own), after, live: !!out.applied, ...(out.memoryPending ? { memoryPending: out.memoryPending, why: out.why } : {}) };
  };

  return { inLimitsTurn, applyCurrentLimits, limitsTold, capMovedFrom, limitsAfterDetach, tellMemoryBudget, tellRunning, setMemoryCap, setSwapAllowance, stop: stopWaits };
}
