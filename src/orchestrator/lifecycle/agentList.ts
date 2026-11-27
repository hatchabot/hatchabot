import type { CompositeTelegramProvisioner } from '../../channels/composite.js';
import { formatMemoryCap } from '../../domain/memoryCap.js';
import type { Agent } from '../../domain/types.js';
import type { RuntimeInfo, RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { accessAlertOf, accessOverview, agentsWithAccessFindings } from '../google/accessOverview.js';
import { MACHINE, budgetLine, budgetView, endedPauseLine, endedPauseOwed, endedSwitchLine, endedSwitchOwed, machineTz, monthKey, monthName, monthSpend, nextMonth, stepLine, stepView, type EndedPause, type EndedSwitch, type StepView } from '../usage/budgets.js';
import type { MonthlyBudgets } from '../usage/monthlyBudgets.js';
import { diskWarnBytes } from '../health/posture.js';
import { memoryCapFor } from './provision.js';
import type { AutoRebuilds } from './autoRebuilds.js';
import { localModelListed } from '../sources/warmModels.js';
import { ownersModel } from '../transfer/transfer.js';

/**
 * The agent list (HB-0808 step 11, part 2): every tile's agent, with what the
 * home screen and Alerts show of it (its versions and the rebuild it needs,
 * its memory and swap, its storage, a loop, a budget, a spike, what it can
 * reach that it should not, its bots, its unread mark and its progress). Part
 * of the agent lifecycle service (agentLifecycle.ts). Who may see the
 * machine owner's view of every account (`?all=1`) is the route's
 * (src/api/agents/lifecycleRoutes.ts); each tile is `publicAgent`'s shape.
 *
 * A machine that doesn't answer is skipped for a minute (`slowHostUntil`, a
 * cache: a restart only tries it once more, sooner).
 */
export interface AgentList {
  /** The tiles: the viewer's agents (theirs and those shared with them), or with `all`, every account's. */
  view(viewer: string, opts: { all: boolean; machineOwner: () => boolean }): Promise<Record<string, unknown>[]>;
  /** Did this machine miss a question in the last minute (asleep or offline)? */
  hostKnownAway(hostId: string): boolean;
}

export interface AgentListDeps {
  store: Store;
  providerFor: (hostId: string) => RuntimeProvider;
  /** The Telegram pool's view of a bot (pooled, a name pending, when last renamed). */
  channel: Pick<CompositeTelegramProvisioner, 'pool'>;
  /** The only shape an agent leaves the process in (routes.ts). */
  publicAgent: (agent: Agent, extra?: Record<string, unknown>) => Record<string, unknown>;
  rebuildNeedOf: AutoRebuilds['rebuildNeedOf'];
  isQueued: (agentId: string) => boolean;
  progressOf: (a: Agent) => { at: string; step: string } | undefined;
  /** A restart of its process Hatchabot saw (routes.ts, `restartsSeen`). */
  noteSelfRestart: (a: Agent, running: RuntimeInfo) => void;
  /** Its swap as the app shows it (routes.ts). */
  swapViewOf: (a: Agent, running?: RuntimeInfo) => Promise<Record<string, unknown>>;
  /** The tags that are a machine's fleet default image (routes.ts, `aliasCache`). */
  defaultAliasesFor: (hostId: string) => Promise<Set<string>>;
  /** Its newest conversation, and the viewer's unread mark (routes.ts, the sessions cache). */
  lastActiveFor: (a: Agent) => Promise<string | undefined>;
  unreadFor: (a: Agent, ownerId: string) => Promise<boolean>;
  /** Its bot's live Telegram name (the channels service). */
  botDisplayNameFor: (agentId: string, secretRef: string) => Promise<string | undefined>;
  /** The local models loaded now at a base address (routes.ts). */
  warmLocalModels: (baseUrl: string) => Promise<string[]>;
  /** Its memory peak and cap hits since they were cleared (the machines service). */
  peakSinceClear: (a: Agent, kernelPeak: number | undefined, current: number | undefined) => number | undefined;
  capHitsSince: (a: Agent, raw: number | undefined, startedAt?: string) => number | undefined;
  /** The machine's budget (the usage service). */
  machineBudgetView: MonthlyBudgets['machineBudgetView'];
}

export function createAgentList(deps: AgentListDeps): AgentList {
  const { store, providerFor, publicAgent, rebuildNeedOf, isQueued, progressOf, noteSelfRestart, swapViewOf, defaultAliasesFor,
    lastActiveFor, unreadFor, botDisplayNameFor, warmLocalModels, peakSinceClear, capHitsSince, machineBudgetView } = deps;
  // A machine that doesn't answer (a laptop runner asleep or offline) must
  // not hold the whole list: each of its lookups gets a few seconds, and a
  // machine that missed one is skipped for a minute so polls don't pile up
  // slow connections to it (2026-10-04: the home screen sat on "Loading…"
  // for 60 s per request while the laptop was off).
  const slowHostUntil = new Map<string, number>();
  const LIST_LOOKUP_MS = 3_000;
  const forHost = <T,>(hostId: string, work: () => Promise<T>, fallback: T): Promise<T> => {
    if ((slowHostUntil.get(hostId) ?? 0) > Date.now()) return Promise.resolve(fallback);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<T>((resolve) => {
      timer = setTimeout(() => { slowHostUntil.set(hostId, Date.now() + 60_000); resolve(fallback); }, LIST_LOOKUP_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    const done = work().then((v) => { slowHostUntil.delete(hostId); return v; }, () => fallback);
    return Promise.race([done, late]).finally(() => clearTimeout(timer));
  };
  const view: AgentList['view'] = async (viewer, { all, machineOwner }) => {
    const agents = all ? store.listAllActiveAgents() : store.listVisibleAgents(viewer);
    // Machines that do not answer a quick connect (asleep or offline): their
    // agents' lookups are skipped for a minute and their tiles say so at once,
    // rather than each lookup finding out by timing out (2026-10-05).
    await Promise.all([...new Set(agents.filter((a) => a.state === 'RUNNING' || a.state === 'STOPPED').map((a) => a.hostId))].map(async (hostId) => {
      const up = await (async () => (await providerFor(hostId).reachable?.()) ?? true)().catch(() => true);
      if (!up) slowHostUntil.set(hostId, Date.now() + 60_000);
    }));
    // Fleet-wide lookups once per request (publicAgent's per-agent versions are
    // for single-agent responses; on a 45-agent list they were 3 queries each).
    const peersPendingSet = store.agentsWithPeersPending(viewer);
    const classes = new Map(store.listAgentClasses(viewer).map((c) => [c.id, c]));
    const classNames = new Map([...classes].map(([id, c]) => [id, c.name]));
    // The daily storage measurement (posture.ts measureAgentDisks): an agent
    // over HATCHABOT_AGENT_DISK_WARN_GB goes to Alerts (2026-09-30).
    const disks = store.agentDiskBytes();
    const diskWarn = diskWarnBytes();
    // Loops Hatchabot's watcher found (tokenWatch.ts): a "Alerts" line each, for the owner.
    const stuckBy = new Map<string, Array<{ id: string; kind: string; text: string; fix?: string; since?: string }>>();
    for (const i of store.listTokenIncidents({ ownerId: viewer, open: true })) {
      // A consult loop is the pair's: on both tiles.
      const on = i.kind === 'consult-ping-pong' ? i.key.split('+') : [i.agentId];
      for (const id of on) stuckBy.set(id, [...(stuckBy.get(id) ?? []), { id: i.id, kind: i.kind, text: i.text, ...(i.fix ? { fix: i.fix } : {}), ...(i.firstAt ? { since: i.firstAt } : {}) }]);
    }
    // Budgets (budgets.ts): this month's figures for each agent with one, and
    // the machine's on the manager's tile for the machine owner — Alerts.
    const budgetNow = Date.now(), budgetTz = machineTz(), budgetMonth = monthKey(budgetNow, budgetTz);
    const budgetRows = new Map(store.listBudgets().map((b) => [b.scope, b]));
    const budgetSpend = budgetRows.size ? monthSpend(store, budgetMonth) : new Map<string, number>();
    const budgetOf = (a: Agent) => { const b = budgetRows.get(a.id); return b ? budgetView(store, b, budgetSpend.get(a.id) ?? 0, budgetNow, budgetTz, a.id) : undefined; };
    const machineBudget = budgetRows.has(MACHINE) && machineOwner() ? machineBudgetView(budgetNow).budget : undefined;
    // "Tell me every $X": the month so far against the step, and its Alerts line once a multiple is passed.
    const stepRows = new Map(store.listSpendAlerts().map((x) => [x.scope, x]));
    const stepSpend = stepRows.size ? (budgetSpend.size ? budgetSpend : monthSpend(store, budgetMonth)) : new Map<string, number>();
    const stepOf = (scope: string): (StepView & { line?: string }) | undefined => {
      const al = stepRows.get(scope); if (!al) return undefined;
      const v = stepView(al, scope === MACHINE ? [...stepSpend.values()].reduce((x, y) => x + y, 0) : stepSpend.get(scope) ?? 0, budgetNow, budgetTz);
      return { ...v, ...(v.passed ? { line: stepLine(v) } : {}) };
    };
    const machineStep = stepRows.has(MACHINE) && machineOwner() ? stepOf(MACHINE) : undefined;
    // Paused by the machine's budget: the agent's own tile says so.
    // One from a month that is over, still owed its start, says so (HB-1011).
    // Only a pause: a move to a cheaper model leaves it running, and its tile
    // said it was paused by this Hatchabot's budget (HB-1315).
    const machinePaused = new Map<string, { pausedAt: string; alreadyStopped?: boolean; ended?: EndedPause }>(
      store.listBudgetPauses({ open: true, month: budgetMonth }).filter((p) => p.scope === MACHINE && p.kind === 'pause').map((p) => [p.agentId, p]));
    // Moved to a cheaper model by the machine's budget: said on its tile too,
    // with the model and the 1st it ends on; that pause's line was all
    // there was, and a move is not a pause (HB-1315), so it showed nowhere (HB-1422).
    const machineCheaper = new Map<string, { to: string; classModel: boolean; ended?: EndedSwitch }>(store.listBudgetPauses({ open: true, month: budgetMonth })
      .filter((p) => p.scope === MACHINE && p.kind === 'cheaper' && !!p.toModel).map((p) => [p.agentId, { to: p.toModel!, classModel: p.fromModel === p.toModel }]));
    const machineUntil = `${monthName(nextMonth(budgetMonth))} 1`;
    // `own`: its owner's own model, which the copy carries; none when it
    // follows its source's default, which there is the other machine's
    // source's (HB-1299 review).
    const budgetSwitchOf = (a: Agent): { budgetSwitch?: { to: string; own?: string; scope: 'agent' | 'machine' } } => {
      const cheap = a.model ? store.openCheaperPause(a.id) : undefined;
      if (!cheap?.toModel || cheap.toModel !== a.model) return {};
      const own = ownersModel(store, a);
      if (own === cheap.toModel) return {};
      return { budgetSwitch: { to: cheap.toModel, ...(own ? { own } : {}), scope: cheap.scope === MACHINE ? 'machine' : 'agent' } };
    };
    // One of its own budget's, the budget removed since (this month's too):
    // still owed its start, said on its tile as well (HB-1316).
    const ownEnded = new Map<string, { pausedAt: string; ended: EndedPause }>();
    // This Hatchabot's budget no longer pauses at this month's spend (raised,
    // removed, or set to warn or a cheaper model): this month's machine
    // pauses still owed their start are ended too (HB-1496).
    const machineRow = budgetRows.get(MACHINE);
    const machinePausesNow = !!machineRow && machineRow.atLimit === 'pause' && [...budgetSpend.values()].reduce((x, y) => x + y, 0) >= machineRow.usd;
    for (const p of store.listBudgetPauses({ open: true })) {
      if (p.month > budgetMonth) continue;
      if (p.scope === p.agentId && !budgetRows.has(p.agentId) && !ownEnded.has(p.agentId)) {
        const owed = endedPauseOwed(store, p.agentId, budgetMonth, p.agentId);
        if (owed) ownEnded.set(p.agentId, { pausedAt: owed.at, ended: owed.ended });
      }
      if (p.scope !== MACHINE) continue;
      // An earlier month's switch to a cheaper model whose own model is not back yet (HB-1496).
      if (p.kind === 'cheaper') {
        if (p.month < budgetMonth && !machineCheaper.has(p.agentId)) {
          const owed = endedSwitchOwed(store, p.agentId, budgetMonth, MACHINE);
          if (owed) machineCheaper.set(p.agentId, { to: owed.to, classModel: false, ended: owed.ended });
        }
        continue;
      }
      if (p.month === budgetMonth ? machinePausesNow || !!machinePaused.get(p.agentId)?.ended : machinePaused.has(p.agentId)) continue;
      const owed = endedPauseOwed(store, p.agentId, budgetMonth, MACHINE, { machineSpend: machineOwner() });
      if (owed) machinePaused.set(p.agentId, { pausedAt: owed.at, ended: owed.ended });
    }
    // Today's spike (usageAlerts.ts), owner only: an Alerts line linking to its
    // Recommended item. A loop on the agent speaks for it (one cause, one line).
    const spikeBy = new Map<string, { at: string; tokens: number; usual: number }>();
    for (const x of store.usageAlertsSince(new Date(budgetNow - 86_400_000).toISOString(), { ownerId: viewer })) {
      if (!spikeBy.has(x.agentId) && !stuckBy.has(x.agentId)) spikeBy.set(x.agentId, { at: x.at, tokens: x.tokens, usual: x.usual });
    }
    // What it can reach that it should not (access overview): two fleet-wide reads, the overview only for those with findings.
    const accessFindings = agentsWithAccessFindings(store, budgetNow);
    return Promise.all(
      agents.map(async (a) => {
        let openclawVersion: string | undefined;
        let latestOpenclawVersion: string | undefined;
        let updateAvailable = false;
        let rebuild: Awaited<ReturnType<typeof rebuildNeedOf>> | undefined;
        if (a.runtimeRef && (a.state === 'RUNNING' || a.state === 'STOPPED')) {
          try {
            rebuild = await forHost(a.hostId, () => rebuildNeedOf(a), undefined as Awaited<ReturnType<typeof rebuildNeedOf>> | undefined);
            if (!rebuild) throw new Error('machine did not answer');
            noteSelfRestart(a, rebuild!.running);
            openclawVersion = rebuild!.running.openclawVersion;
            latestOpenclawVersion = rebuild!.current.openclawVersion;
            // Image ids, never tags (:latest is reassigned in place); a pinned
            // agent is exempt — see rebuildNeedOf. Any image rebuild counts,
            // same-version too, so the app words it from the two versions.
            updateAvailable = rebuild!.imageBehind;
          } catch {
            /* provider hiccup — omit version info rather than fail the list */
          }
        }
        const chan = store.getChannelForAgent(a.id);
        const role = store.accessRole(a.id, viewer);
        // Its machine missed a question in the last minute (asleep or offline):
        // the tile says so instead of looking ready (2026-10-04).
        const unreachable = a.state === 'RUNNING' && (slowHostUntil.get(a.hostId) ?? 0) > Date.now();
        const noBotSince = role === 'owner' && a.webOnly && !chan && a.state !== 'ARCHIVED' ? store.telegramSkippedForNoBot(a.id) : undefined;
        return publicAgent(a, {
          // The machine owner's --all view of someone else's agent: metadata, not where their files live.
          foreign: a.ownerId !== viewer && !role,
          ...(unreachable ? { hostUnreachable: true, hostName: store.getHost(a.hostId)?.name } : {}),
          selfRestarts: rebuild?.running.restartCount || undefined,
          // Its memory: the cap it has (its own / class / default), what the
          // container actually runs with, and how it has fared against it.
          memoryCap: a.memoryCap,
          memoryCapEffective: rebuild?.running.memoryLimitBytes ? formatMemoryCap(rebuild.running.memoryLimitBytes) : memoryCapFor(store, a),
          memoryPeakBytes: peakSinceClear(a, rebuild?.running.memPeakBytes, undefined),
          memoryCapHits: capHitsSince(a, rebuild?.running.memCapHits, rebuild?.running.startedAt),
          memoryKills: rebuild?.running.memOomKills,
          // Its swap (swap.ts): the allowance it should have, what the container
          // runs with, how much sits in swap now, and why none is given here.
          ...(await forHost(a.hostId, () => swapViewOf(a, rebuild?.running), {} as Awaited<ReturnType<typeof swapViewOf>>)),
          ...(role === 'owner' && (disks.get(a.id)?.bytes ?? 0) > diskWarn
            ? { diskOver: { bytes: disks.get(a.id)!.bytes, warnBytes: diskWarn, measuredAt: disks.get(a.id)!.measuredAt } }
            : {}),
          peersPending: peersPendingSet.has(a.id),
          className: a.classId ? classNames.get(a.classId) : undefined,
          // Pinned to an image its class doesn't prescribe → a trial (🧪 in the legend).
          // A pin to the tag that IS the fleet default's image (the candidate just
          // promoted) is no trial: nothing to discard, nothing to flag (Chris, 2026-09-24).
          imageTrial: !a.ops && !!a.image && !(await forHost(a.hostId, () => defaultAliasesFor(a.hostId), new Set<string>([a.image]))).has(a.image) && (!a.classId || (classes.get(a.classId) ?? store.getAgentClass(a.classId))?.image !== a.image),
          /** What the viewer may do — drives which controls the app renders. */
          role,
          /** A member the owner lets chat from this app (the 💬 Chat panel, 2026-09-29). */
          ...(role && role !== 'owner' && store.webChatAllowed(a.id, viewer) ? { webChat: true } : {}),
          // The owner's applied setup ANSWERS are theirs — a member (or the
          // ?all=1 metadata view) gets the declarations, never the values.
          ...(role === 'owner' ? {} : { paramValues: undefined }),
          deepLink: chan?.deepLink,
          botUsername: chan?.accountId,
          /** It came back (or was made) with no Telegram bot free, so it runs
           *  web-only until one is attached (owner only): Alerts. */
          ...(noBotSince ? { telegramSkipped: { at: noBotSince } } : {}),
          /** Its chat lost its context (after a rebuild, or an idle reset) and
           *  the owner has not dealt with it yet — the app offers Recover. */
          contextReset: store.getContextReset(a.id),
          /** A loop the watcher found and the fix (owner only): Alerts. */
          ...(role === 'owner' && stuckBy.get(a.id) ? { stuck: stuckBy.get(a.id) } : {}),
          /** Its monthly budget, this month's spend against it, and a pause (owner only): Alerts from 80%. */
          ...(role === 'owner' && budgetOf(a) ? { budget: { ...budgetOf(a)!, ...(budgetOf(a)!.level || budgetOf(a)!.paused?.ended || budgetOf(a)!.downgraded?.ended ? { line: budgetLine(budgetOf(a)!, 'it') } : {}) } } : {}),
          ...(role === 'owner' && machinePaused.has(a.id) ? { budgetPaused: { scope: 'machine', at: machinePaused.get(a.id)!.pausedAt, ...(machinePaused.get(a.id)!.alreadyStopped ? { staysStopped: true } : {}),
            ...(machinePaused.get(a.id)!.ended ? { ended: machinePaused.get(a.id)!.ended, line: endedPauseLine(machinePaused.get(a.id)!.ended!, 'this Hatchabot') } : {}) } }
            : role === 'owner' && ownEnded.has(a.id) ? { budgetPaused: { scope: 'agent', at: ownEnded.get(a.id)!.pausedAt, ended: ownEnded.get(a.id)!.ended, line: endedPauseLine(ownEnded.get(a.id)!.ended, 'it') } } : {}),
          /**
           * On a cheaper model a budget switched it to (its own or the machine's): a
           * download or a move carries `own`, its owner's model (ownersModel), so the
           * other machine runs that until a budget there says otherwise; the
           * confirmations say so (owner only, HB-1299).
           */
          ...(role === 'owner' ? budgetSwitchOf(a) : {}),
          /**
           * On a cheaper model the machine's budget moved it to, until the 1st (owner only): Alerts. Gone once its model
           * is changed by hand. `classModel`: that model is its class's own, which stays: no "until" (HB-1477 review).
           */
          // `ended`: an earlier month's, its own model not back yet: no "until", and its line (HB-1496).
          ...(role === 'owner' && machineCheaper.has(a.id) && machineCheaper.get(a.id)!.to === a.model ? { budgetCheaper: { scope: 'machine', to: machineCheaper.get(a.id)!.to,
            ...(machineCheaper.get(a.id)!.ended ? { ended: machineCheaper.get(a.id)!.ended, line: endedSwitchLine(machineCheaper.get(a.id)!.ended!) } : machineCheaper.get(a.id)!.classModel ? { classModel: true } : { until: machineUntil }) } } : {}),
          ...(role === 'owner' && stepOf(a.id) ? { spendStep: stepOf(a.id) } : {}),
          /** It used far more than its usual day in the last 24 hours (owner only): an Alerts line. */
          ...(role === 'owner' && spikeBy.has(a.id) ? { spike: spikeBy.get(a.id) } : {}),
          /** It can still reach something it should not (access overview), owner only: Alerts. */
          ...(role === 'owner' && accessFindings.has(a.id) ? (() => { const al = accessAlertOf(accessOverview(store, a, budgetNow)); return al ? { accessAlert: al } : {}; })() : {}),
          ...(a.ops && machineStep ? { machineStep } : {}),
          ...(a.ops && machineBudget ? { machineBudget: { ...machineBudget, ...(machineBudget.level ? { line: budgetLine(machineBudget, 'this Hatchabot') } : {}) } } : {}),
          /** Slack and Discord, for the icon marks and the Messaging row. */
          otherChannels: store.listChannelsForAgent(a.id).filter((c) => c.kind !== 'telegram').map((c) => ({
            kind: c.kind,
            displayName: typeof c.settings?.displayName === 'string' ? c.settings.displayName : undefined,
            deepLink: c.deepLink,
          })),
          /** Live Telegram display name (cached 10 min) — the Sync-name
           *  button greys out when it already matches the agent. */
          botDisplayName: chan && a.state === 'RUNNING' ? await botDisplayNameFor(a.id, chan.secretRef) : undefined,
          /** Pool-leased bots auto-recycle on delete; pasted ones are offered
           *  a trip INTO the pool — the app needs to know which is which. */
          botPooled: chan ? deps.channel.pool.owns(chan.accountId) : undefined,
          /** Set while Telegram is refusing a rename (its quota is hours long),
           *  so the card can explain a chat header that doesn't match. */
          botNamePending: chan ? deps.channel.pool.pendingName?.(chan.accountId) : undefined,
          /** When a rename last LANDED — so a wait that ran for hours ends with
           *  a confirmation rather than a warning silently vanishing. */
          botNamedAt: chan ? deps.channel.pool.lastRenamed?.(chan.accountId)?.at : undefined,
          // Default model from the agent's AI profile. Applied config can lag
          // one rebuild behind, and /model can switch a single chat session —
          // this is "what it runs by default", which is what the card answers.
          lastActiveAt: await lastActiveFor(a),
          /** Queued behind other rebuilds: the app says so rather than spinning silently. */
          queuedForRebuild: isQueued(a.id) || undefined,
          unread: role ? await unreadFor(a, viewer) : undefined,
          modelWarm: await (async () => {
            const p = store.getAIProfile(a.aiProfileId);
            if (p?.vendor !== 'local' || !p.baseUrl) return undefined;
            // `/api/ps` names it with its tag: `llama3:latest` for `llama3` (HB-1339's rule).
            return localModelListed(await warmLocalModels(p.baseUrl), a.appliedModel ?? p.model);
          })(),
          openclawVersion,
          latestOpenclawVersion,
          updateAvailable,
          /** { level: required | recommended, reasons } — absent when it's current. */
          rebuild: rebuild?.need,
          /** When its container was last built (docker's creation time). */
          rebuiltAt: rebuild?.running.containerCreatedAt,
          /** While it runs: when its OpenClaw process last started (its uptime, in the tooltip). */
          startedAt: a.state === 'RUNNING' ? rebuild?.running.startedAt : undefined,
          /** Times its process quit on its own and Docker started it again since the last rebuild,
           *  and how the last one ended (135 = a memory fault, 137 = killed for memory). */
          restarts: rebuild?.running.restartCount || undefined,
          // Docker's own exit code reads 0 again once it is running, so the code
          // comes from the restart Hatchabot saw happen — if it belongs to this container.
          lastExitCode: rebuild?.running.restartCount ? (() => {
            const seen = store.lastSelfRestart(a.id);
            const built = rebuild!.running.containerCreatedAt;
            return seen && (!built || seen.at >= built) ? seen.exitCode : undefined;
          })() : undefined,
          /** True when it runs the fleet default — unpinned, or pinned to a tag that IS the default's image. */
          imageIsDefault: !a.image || (await forHost(a.hostId, () => defaultAliasesFor(a.hostId), new Set<string>([a.image]))).has(a.image),
          /** While it is being set up or rebuilt: the step it is on, and since when. */
          progress: progressOf(a),
        });
      }),
    );
  };
  return { view, hostKnownAway: (hostId) => (slowHostUntil.get(hostId) ?? 0) > Date.now() };
}
