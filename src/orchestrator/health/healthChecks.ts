import { writeFile as writeFileAsync } from 'node:fs/promises';
import { agentMemoryLimits, COMPRESSED_SWAP_FIX, limitsDrift, wantedLimits, type LimitsCheckSummary } from '../../domain/swap.js';
import type { Agent } from '../../domain/types.js';
import type { LiveMemoryLimits, RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { isBusy } from '../lifecycle/busy.js';
import { eventLabel } from './eventLabels.js';
import { BACKGROUND_KINDS, KIND_LABEL, operationSummary, publicOperation, spanWords, STATUS_EVENT } from '../lifecycle/operations.js';
import { baselineOf, computePosture, diffRisks, measureAgentDisks, riskKeys } from './posture.js';
import { agentHealth, aiSourceHealth, doctorLint } from './health.js';

/** One row of the Activity feed, or of an agent's timeline. */
export type FeedRow = Record<string, unknown> & { at: string };

/**
 * The health, logs and events service (HB-0808): is an agent really
 * working, what Hatchabot did to it and when, and is every container
 * held to the memory and swap it should have.
 *
 *  - `check`: the live probe of an agent's own gateway, with when its AI
 *    source last answered (health.ts), and `openclaw doctor --lint` on ask;
 *  - `posture`: the security and disk posture, against the owner's last
 *    snapshot (posture.ts; read-only, the daily sweep records the baseline);
 *  - `timeline` and `feed`: an agent's Setup log, and Activity across the
 *    agents a caller can see (an operation one row that opens to its steps);
 *  - `limitsCheck`: every agent's memory cap and swap allowance as docker
 *    and the kernel hold them, applied again where they drifted, at the
 *    start, every ten minutes and for one agent after it starts or wakes;
 *  - `diskSweep`: each agent's storage, once a day (src/index.ts).
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route file on the shared context (`ctx.health`). The registry calls
 * it too: a start or wake checks that agent's limits. Nothing here knows
 * about HTTP: who is asking and the reply's words are the route file's
 * (src/api/healthRoutes.ts). `stop()` ends the limits check's two timers.
 */
export interface HealthChecks {
  /** The live health of a RUNNING agent, and its config lint when `doctor`. */
  check(agent: Agent, doctor: boolean): Promise<Record<string, unknown>>;
  /** The posture for an owner: the report, what changed since their last snapshot, and whether there was one. */
  posture(input: { ownerId: string; isHostOwner: boolean; authMode: 'password' | 'accounts' | 'identity' }): {
    report: ReturnType<typeof computePosture>; changes: { added: string[]; removed: string[] }; comparedToPrior: boolean;
  };
  /** An agent's own event trail, newest first, in plain words (the Setup log). */
  timeline(agent: Agent, limit: number): { agent: string; state: string; events: Array<{ at: string; event: string; label: string; note: unknown }> };
  /** Recent activity across every agent `callerId` can see, or one of them (`agentId`). */
  feed(callerId: string, limit: number, agentId?: string): FeedRow[];
  /** The limits check: all agents, or only these. */
  limitsCheck(opts?: { agentIds?: string[] }): Promise<LimitsCheckSummary>;
  /** The last check of all agents, for the doctor's line (and tests). */
  lastLimitsCheck(): LimitsCheckSummary | undefined;
  /** Each agent's storage, measured. */
  diskSweep(): Promise<{ measured: number; failed: number }>;
  /** End the limits check's timers: at shutdown. */
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface HealthChecksDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The agent's limits turn (the agent settings service's), so a check never crosses a PATCH or a class change. */
  inLimitsTurn: <T>(agentId: string, fn: () => Promise<T>) => Promise<T>;
  /** A setup or rebuild in flight for the agent (the registry's queue): its storage is not measured then. */
  inFlight: (agentId: string) => boolean;
  /** Where the last check of all agents is written for the doctor (limits-check.json beside the database); none, not written (tests). */
  limitsCheckFile: string | undefined;
  warn: (detail: unknown, msg: string) => void;
  /** The limits check's first run after the start and its interval; none, never (tests). */
  limitsTimers?: { bootMs: number; everyMs: number };
}

export function createHealthChecks(deps: HealthChecksDeps): HealthChecks {
  const { store, providerFor, trace, inLimitsTurn } = deps;

  // Live health probe of the agent's own gateway (event loop, Telegram
  // connection, plugin errors). Distinct from the tracked state: an agent can be
  // RUNNING here yet have a gateway that stopped answering. The gateway
  // answering is not the agent answering: it runs no model turn, so when its
  // AI source last answered (or has refused since) rides along (2026-09-30).
  const check = async (agent: Agent, doctor: boolean) => {
    const provider = providerFor(agent.hostId);
    const health = { ...(await agentHealth(provider, agent.runtimeRef!)), aiSource: aiSourceHealth(store, agent) };
    // ?doctor=1 additionally runs `openclaw doctor --lint` — ~4s of read-only
    // config checks that catch silent degradations (disabled search provider,
    // missing memory-search key). The fleet sweep asks for it; the cheap
    // gateway probe stays the default.
    if (doctor && health.reachable) {
      return { ...health, doctor: await doctorLint(provider, agent.runtimeRef!) };
    }
    return health;
  };

  // ---- security posture (config-risk check, runnable on demand) ------------
  const posture = (input: { ownerId: string; isHostOwner: boolean; authMode: 'password' | 'accounts' | 'identity' }) => {
    const { ownerId } = input;
    const report = computePosture(store, {
      ownerId,
      isHostOwner: input.isHostOwner,
      authMode: input.authMode,
    });
    // Diff today's active risks against this owner's most recent prior snapshot,
    // then record today's — so the UI (and the daily job) can flag what changed.
    const today = new Date().toISOString().slice(0, 10);
    const keys = riskKeys(report);
    // One of an older key format is no baseline (HB-1103): nothing to compare yet.
    const prior = baselineOf(store.latestPostureSnapshotBefore(ownerId, today));
    const previous = prior && prior !== 'older' ? prior.keys : undefined;
    const changes = previous ? diffRisks(keys, previous) : { added: [], removed: [] };
    // Read-only: the daily sweep records the baseline. A GET writing it meant
    // opening this page after a risky change silently reset what the next
    // sweep would have flagged as newly appeared.
    return { report, changes, comparedToPrior: previous !== undefined };
  };

  /** The agent's own event trail — what Hatchabot did to it and when, in plain words (the Setup log). */
  const timeline = (agent: Agent, limit: number) => {
    const events = store.listEvents([agent.id], limit).map((e) => ({
      at: e.at, event: e.event, label: eventLabel(e.event, e.detail),
      // A little of the detail for the curious; never the whole blob.
      // A guest's visit names its device and address (console.guest_opened).
      note: e.detail?.reason ?? e.detail?.error ?? e.detail?.why ?? e.detail?.mountName ?? (e.detail?.device ? [e.detail.device, e.detail.from && e.detail.from !== 'unknown' ? `from ${e.detail.from}` : '', e.detail.tailnetUser ? `(${e.detail.tailnetUser})` : ''].filter(Boolean).join(' ') : undefined),
    }));
    return { agent: agent.name, state: agent.state, events };
  };

  /** Recent activity across every agent the caller can see. */
  const feed = (callerId: string, limit: number, agentId?: string): FeedRow[] => {
    const visible = store.listVisibleAgents(callerId);
    const names = new Map(visible.map((a) => [a.id, a.name]));
    // Optional filter to one agent — but only one the caller can see, so this
    // can't be used to probe another owner's timeline.
    let ids = [...names.keys()];
    if (agentId) {
      if (!names.has(agentId)) return [];
      ids = [agentId];
    }
    // Another owner's agent shared with you: what happened, not its details
    // (an event can carry an address or an error text; use-case audit, 2026-09-27).
    const mine = new Set(visible.filter((a) => a.ownerId === callerId).map((a) => a.id));
    const shape = (e: ReturnType<typeof store.listEvents>[number]) => ({
      ...e,
      ...(mine.has(e.agentId) ? {} : { detail: undefined }),
      agentName: names.get(e.agentId),
    });
    // One agent's timeline: every line, an operation's steps among them.
    if (agentId) return store.listEvents(ids, limit).map(shape);
    // The feed (Activity): an operation is ONE row that opens to its steps
    // (phase 3), not a row per step. Its own lines (op.*) are left out, and
    // so is what the agent logged while it ran (runtime.started,
    // agent.moved…: the operation's doing, kept in the Setup log). The agent
    // is busy on disk for that time, so nothing else of its own happens then.
    const agentOps = store.listOperations(ids, limit, { exceptKinds: BACKGROUND_KINDS });
    const nowMs = Date.now();
    // Its window: until it ended; while it runs, until now; held or cut off
    // by a restart, a little past its last step (a held one is asked about
    // again every 10 minutes, which must not hide that agent's lines for days).
    const windows = agentOps.map((op) => ({
      agentId: op.agentId,
      from: Date.parse(op.requestedAt),
      to: op.finishedAt ? Date.parse(op.finishedAt) + 2000
        : op.status === 'running' || op.status === 'queued' ? nowMs + 2000
        : Date.parse(op.stepAt ?? op.requestedAt) + 120_000,
    }));
    const during = (e: { agentId: string; at: string }) => {
      const t = Date.parse(e.at);
      return windows.some((w) => w.agentId === e.agentId && t >= w.from && t <= w.to);
    };
    const rows: Array<Record<string, unknown> & { at: string }> = store
      .listEvents(ids, Math.min(limit * 3, 600), { withoutOps: true })
      .filter((e) => !during(e))
      .slice(0, limit)
      .map(shape);
    for (const op of agentOps) {
      const pub = publicOperation(op, { recovery: false })!;
      const own = mine.has(op.agentId!);
      const ended = op.finishedAt ?? null;
      const ms = Math.max(0, Date.parse(ended ?? (op.status === 'running' || op.status === 'queued' ? new Date(nowMs).toISOString() : op.updatedAt)) - Date.parse(op.requestedAt));
      // Another owner's agent shared with you: what happened, not where to or why.
      const summary = own ? String(pub.summary) : operationSummary(op.kind, String(pub.status), {});
      const steps = own
        ? store.eventsForOperation(op.agentId!, op.id).filter((e) => e.event !== 'op.started').map((e) => ({ at: e.at, event: e.event, label: eventLabel(e.event, e.detail) }))
        : [];
      rows.push({
        agentId: op.agentId, at: ended ?? op.updatedAt, event: STATUS_EVENT[String(pub.status)] ?? 'op.done',
        detail: own ? { op: op.id, kind: op.kind, outcome: op.outcome ?? undefined } : undefined,
        agentName: names.get(op.agentId!),
        label: `${summary} · ${spanWords(ms)}`,
        op: {
          id: op.id, kind: op.kind, kindLabel: pub.kindLabel, status: pub.status, summary, durationMs: ms,
          startedAt: op.requestedAt, finishedAt: ended, ...(own ? { outcome: op.outcome ?? undefined, steps } : {}),
        },
      });
    }
    // A machine's own operations (a runner's image copy, Back up now) have no
    // agent and so no agent_events row: read from the operations table, one
    // row each, for that machine's owner only (design, "On the page").
    const hosts = store.listHosts(callerId).filter((h) => h.ownerId === callerId);
    const hostName = new Map(hosts.map((h) => [h.id, h.kind === 'local' ? 'This machine' : h.name]));
    const machine = store.listMachineOperations([...hostName.keys()], limit).map((op) => {
      const pub = publicOperation(op, { recovery: false })!;
      const event = STATUS_EVENT[String(pub.status)] ?? 'op.done';
      const detail = { op: op.id, kind: op.kind, label: KIND_LABEL[op.kind] ?? op.kind, outcome: op.outcome ?? undefined, hostId: op.hostId };
      const ms = Math.max(0, Date.parse(op.finishedAt ?? new Date(nowMs).toISOString()) - Date.parse(op.requestedAt));
      return {
        agentId: null, at: op.finishedAt ?? op.requestedAt, event, detail,
        agentName: hostName.get(op.hostId ?? '') ?? 'A machine',
        label: `${KIND_LABEL[op.kind] ?? op.kind}: ${eventLabel(event, detail)}`,
        // No agent, so no timeline of steps: how it ended is the whole story.
        op: { id: op.id, kind: op.kind, kindLabel: pub.kindLabel, status: pub.status, summary: pub.summary, durationMs: ms,
          startedAt: op.requestedAt, finishedAt: op.finishedAt ?? null, outcome: op.outcome ?? undefined, steps: [] },
      };
    });
    return [...rows, ...machine].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  };

  /**
   * The limits check: every agent's memory cap and swap allowance as docker
   * AND the kernel hold them, against what the agent should have, applied
   * again with `docker update` where they differ. Three ways they drift:
   *  - a host gains or loses compressed swap (scripts/enable-compressed-swap.sh,
   *    --undo, a runner rebooted without it): the allowance follows it;
   *  - a setting changed in .env while the app was down;
   *  - **a systemd reload.** With docker's systemd cgroup driver a zero swap
   *    limit is not in systemd's record of the container's scope
   *    (MemorySwapMax=infinity), so any `systemctl daemon-reload` (a snap
   *    refresh does one) puts memory.swap.max back to "max" while docker still
   *    says no swap: on the Spark 16 of 44 running agents had ~2.7 GiB in the
   *    plain disk swap file that way (2026-10-02). The service user cannot set
   *    the scope's property itself (system scopes need root), so this check is
   *    the fix: it reads the cgroup, not docker's record.
   * At start, every ten minutes, and for one agent right after it starts or
   * wakes. Each restoration is on the agent's trail (runtime.swap_reasserted,
   * before and after) once per distinct drift, never every sweep; the last
   * check's counts go to limits-check.json beside the database for the doctor.
   */
  const swapSeen = new Map<string, string>();
  const driftSeen = new Map<string, string>();
  let lastLimitsCheck: LimitsCheckSummary | undefined;
  const limitsCheckFile = deps.limitsCheckFile;
  const limitsCheck = async (opts: { agentIds?: string[] } = {}): Promise<LimitsCheckSummary> => {
    const sum: LimitsCheckSummary = { at: new Date().toISOString(), checked: 0, cgroupDrifted: 0, reasserted: 0, failed: 0, notCovered: 0, unread: 0, away: 0, noContainer: 0 };
    // An agent the check could not read is counted, not skipped: a runner
    // that did not answer gave "0 checked, none drifted", and the doctor
    // said the limits were fine with nothing read (HB-1106).
    const unread = (n: number) => { sum.unread = (sum.unread ?? 0) + n; };
    // Its machine says it is not answering (asleep or offline): a state, not a fault.
    const down = async (prov: RuntimeProvider) => !!prov.reachable && !(await prov.reachable().catch(() => false));
    const agents = store.listAllActiveAgents().filter((a) => a.runtimeRef && (a.state === 'RUNNING' || a.state === 'STOPPED')
      && !isBusy(a.id) && !a.migratedTo && !!store.getHost(a.hostId) && (!opts.agentIds || opts.agentIds.includes(a.id)));
    const byHost = new Map<string, Agent[]>();
    for (const a of agents) byHost.set(a.hostId, [...(byHost.get(a.hostId) ?? []), a]);
    for (const [hostId, list] of byHost) {
      const prov = providerFor(hostId);
      if (!prov.updateMemory || !prov.memoryLimitsLive) { unread(list.length); continue; }
      if (await down(prov)) { sum.away! += list.length; continue; }
      // The host's compressed swap, only where some agent here has an allowance.
      let compressed = false;
      const withSwap = list.filter((a) => !!agentMemoryLimits(store, a).swap);
      let swapChecked = withSwap.length > 0;
      if (withSwap.length) {
        const sw = await prov.compressedSwap?.({ fresh: !opts.agentIds }).catch(() => undefined);
        compressed = !!sw?.compressed;
        const state = sw ? sw.kind : 'unknown';
        if (swapSeen.has(hostId) && swapSeen.get(hostId) !== state) for (const a of withSwap) trace(a.id)('memory.swap_host', { compressed, kind: state });
        if (swapSeen.get(hostId) !== state && !compressed) {
          deps.warn({ host: hostId, agents: withSwap.length, state, why: sw?.why, fix: COMPRESSED_SWAP_FIX }, 'swap.withheld: agents have a swap allowance, but this host does not compress swap; they run without swap');
        }
        swapSeen.set(hostId, state);
      }
      let live: Map<string, LiveMemoryLimits>;
      // Only a container its docker said is not there counts as "none yet";
      // one it gave no answer for is not read (HB-1106).
      const missing = new Set<string>();
      try { live = await prov.memoryLimitsLive(list.map((a) => a.runtimeRef!), { missing }); } catch {
        if (await down(prov)) sum.away! += list.length; else unread(list.length);
        continue; // next sweep
      }
      for (const a of list) {
        await inLimitsTurn(a.id, async () => {
          let l = live.get(a.runtimeRef!);
          if (!l) {
            // No reading for it. Not counted when it changed meanwhile (stopped, moved, rebuilt).
            // A stopped one whose docker says it has no container (pruned) has nothing to check until it starts.
            const n = store.getAgent(a.id);
            if (n && n.runtimeRef === a.runtimeRef && !isBusy(a.id)) { if (n.state === 'STOPPED' && missing.has(a.runtimeRef!)) sum.noContainer!++; else unread(1); }
            return;
          }
          // The batched reading is only a hint. A PATCH may have applied its
          // limits but not stored them yet, or a lifecycle change moved the
          // agent while that reading was in flight. Judge it in its turn.
          let now = store.getAgent(a.id);
          const sameRuntime = (n: Agent | undefined): n is Agent & { runtimeRef: string } =>
            !!n?.runtimeRef && n.runtimeRef === a.runtimeRef && n.hostId === hostId
            && (n.state === 'RUNNING' || n.state === 'STOPPED') && !n.migratedTo && !isBusy(n.id);
          if (!sameRuntime(now)) return;
          // An allowance may have been saved while this sweep queued behind
          // PATCH; the original batch then had no reason to inspect swap.
          if (!swapChecked && agentMemoryLimits(store, now).swap) {
            compressed = !!(await prov.compressedSwap?.({ fresh: !opts.agentIds }).catch(() => undefined))?.compressed;
            swapChecked = true;
            now = store.getAgent(a.id);
            if (!sameRuntime(now)) return;
          }
          sum.checked++;
          if (l.running && !l.cgroup) sum.notCovered++;
          let lim = agentMemoryLimits(store, now);
          let d = limitsDrift(wantedLimits(lim, compressed), l);
          if (!d.reassert) { driftSeen.delete(a.id); return; }
          l = (await prov.memoryLimitsLive!([now.runtimeRef]).catch(() => undefined))?.get(now.runtimeRef);
          now = store.getAgent(a.id);
          if (!l || !sameRuntime(now)) return;
          lim = agentMemoryLimits(store, now);
          d = limitsDrift(wantedLimits(lim, compressed), l);
          if (!d.reassert) { driftSeen.delete(a.id); return; }
          // The kernel's own limit moved while docker's record did not: a systemd reload.
          const cgroupOnly = d.reasons.every((r) => r.startsWith('cgroup'));
          if (cgroupOnly) sum.cgroupDrifted++;
          let after: ReturnType<typeof limitsDrift> | undefined;
          try {
            await prov.updateMemory!(now.runtimeRef, lim.memory, lim.swap);
            const re = (await prov.memoryLimitsLive!([now.runtimeRef]).catch(() => undefined))?.get(now.runtimeRef);
            after = re ? limitsDrift(wantedLimits(lim, compressed), re) : undefined;
          } catch { /* counted as failed below */ }
          const ok = !!after && !after.reassert;
          sum.reasserted++;
          if (!ok) sum.failed++;
          const sig = `${d.reasons.join(',')}|${JSON.stringify(d.have)}|${ok}`;
          if (driftSeen.get(a.id) !== sig) {
            driftSeen.set(a.id, sig);
            trace(a.id)(ok ? 'runtime.swap_reasserted' : 'runtime.swap_reassert_failed', {
              reasons: d.reasons, before: d.have, after: after?.have, want: wantedLimits(lim, compressed), ...(cgroupOnly ? { cause: 'cgroup changed under docker (a systemd reload)' } : {}),
            });
          }
        });
      }
    }
    if (!opts.agentIds) {
      lastLimitsCheck = sum;
      if (sum.reasserted) deps.warn(sum, 'limits check: agents\' memory or swap limits had drifted and were applied again');
      if (limitsCheckFile) await writeFileAsync(limitsCheckFile, JSON.stringify(sum, null, 2) + '\n').catch(() => {});
    }
    return sum;
  };

  /** Each agent's storage, once a day, before the posture sweep reads it (src/index.ts). */
  const diskSweep = () => measureAgentDisks({ store, providerFor, isBusy: (id) => isBusy(id) || deps.inFlight(id), log: (e, d) => deps.warn(d, e) });

  // The check's first run after the start, and every ten minutes after (HATCHABOT_SWAP_BOOT_MS, HATCHABOT_SWAP_PROBE_MS).
  const firstCheck = deps.limitsTimers
    ? setTimeout(() => { void limitsCheck().catch((err) => deps.warn({ err: String(err) }, 'limits check failed')); }, deps.limitsTimers.bootMs).unref()
    : undefined;
  const everyCheck = deps.limitsTimers
    ? setInterval(() => { void limitsCheck().catch((err) => deps.warn({ err: String(err) }, 'limits check failed')); }, deps.limitsTimers.everyMs).unref()
    : undefined;

  return {
    check,
    posture,
    timeline,
    feed,
    limitsCheck,
    lastLimitsCheck: () => lastLimitsCheck,
    diskSweep,
    stop: () => { if (firstCheck) clearTimeout(firstCheck); if (everyCheck) clearInterval(everyCheck); },
  };
}
