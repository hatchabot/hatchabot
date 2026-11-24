import type { CompositeTelegramProvisioner } from '../../channels/composite.js';
import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { applyWorkspace, botPollState, findExistingBot, inspectWorkspace } from './adopt.js';
import { isBusy, whileBusy } from '../lifecycle/busy.js';
import { listCrons } from '../schedules/crons.js';
import { discoverOpenclawAgents, quiesceOpenclawBots } from './openclawImport.js';
import { autoSnapshot } from '../files/snapshots.js';
import {
  migrateCrons,
  openclawAgentEntryForWorkspace,
  readOpenclawCronStore,
  rewriteWorkspaceFiles,
  selfPathReplacements,
} from './cronImport.js';
import { scanWorkspacePaths } from './dataPaths.js';

/** What an adopt says about the source's scheduled tasks. */
export type AdoptCrons = { total: number; carried: number; failed: number; deferred?: number; error?: string; notReady?: boolean };
/** How long a deferred adopt waits for its agent's gateway to answer, from the first pass that
 *  found the agent running, before its tasks count as failed. */
const ADOPT_WAIT_MS = 24 * 3600_000;
/** A deferred adopt whose gateway did not answer is looked at again this often, not every pass. */
const ADOPT_RETRY_MS = 3600_000;

/**
 * Bringing in what was made outside Hatchabot (HB-0808 step 12): the
 * OpenClaw agents already installed for the user this server runs as,
 * quieting their bots before Hatchabot takes them, the folders a
 * workspace names, and a workspace copied into an agent that exists here,
 * with its own paths and scheduled tasks pointed at the copy.
 *
 * Its state: which deferred adopts have been found running and for how long
 * (`adoptRan`), when each was last looked at (`adoptLastTry`), and which were
 * said to be waiting (`adoptWaitSaid`). All caches: the adopts themselves are
 * the store's (`adopt_pending`), and the schedules' quick pass gives them
 * their turn (`finishDeferredAdopts`).
 *
 * Nothing here knows about HTTP: a route checks who is asking (the machine's
 * owner only: these read and write this machine's folders), asks this, and
 * words the answer.
 */
export interface Adopts {
  /** Every OpenClaw agent installed for the user this server runs as. */
  openclawAgents(): ReturnType<typeof discoverOpenclawAgents>;
  /** Disable the named bots in OpenClaw and restart its gateway once (quiesceOpenclawBots). Its refusals are thrown. */
  quiesce(accountIds: string[]): ReturnType<typeof quiesceOpenclawBots>;
  /** External host folders an adopted workspace references. */
  scanPaths(path: string): ReturnType<typeof scanWorkspacePaths>;
  /** What would be adopted from this folder, and the bot it already owns (never its token). AdoptError when it cannot be. */
  inspect(path: string): Promise<Record<string, unknown>>;
  /** The snapshot an adopt into a running agent takes first (it overwrites memory files). Never fails. */
  snapshotBefore(agent: Agent): Promise<void>;
  /** Copy the workspace into the agent, then point its own paths and tasks at the copy (now, or once it runs). */
  adoptInto(agent: Agent, path: string): Promise<{ files: number; bytes: number; crons: AdoptCrons }>;
  /**
   * Point an adopted workspace's own absolute paths at the container copy, in
   * its files and its tasks. Undefined when another operation held the agent.
   */
  repointAdopted(agent: Agent, path: string, deferred?: boolean, wait?: boolean): Promise<AdoptCrons | undefined>;
  /** Adopts that could not re-point yet (stopped, or busy then): each runs once its agent is running. */
  finishDeferredAdopts(): Promise<void>;
}

/** What the adopts need from the process they run in. Functions only, so a test hands them fakes. */
export interface AdoptsDeps {
  store: Store;
  secrets: SecretStore;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Telegram's provisioner (an adopted workspace's bot). */
  channel: CompositeTelegramProvisioner;
  /** A note in the owner's Hatchabot agent conversation (the ops notifier). */
  notify: (ownerId: string, body: string) => void;
}

export function createAdopts(deps: AdoptsDeps): Adopts {
  const { store, secrets, providerFor, trace } = deps;
  /** Deferred adopts already said to be waiting for their gateway (said once). */
  const adoptWaitSaid = new Set<string>();

  /**
   * Point an adopted workspace's OWN absolute paths (its old workspace and
   * agentDir) at the container copy, in both its files and its crons, so
   * references resolve. Best-effort: it never fails the adopt itself. Held
   * under the busy guard (the long cron migration must not race a rebuild or
   * a delete), and only for a RUNNING agent: against a stopped one the cron
   * gateway never answers. Undefined when another operation held the agent;
   * the pending record stays for the next try. `deferred`: run from the
   * pending list, so only while that adopt is still the agent's pending one
   * (a newer adopt made since replaced or dropped it), with a short readiness
   * poll. `wait`: a gateway not answering yet keeps the record for a later
   * pass (finishDeferredAdopts decides, within its day). Otherwise, as for an
   * adopt into a running agent (its answer says the tasks were not carried),
   * the record goes (final audit, 2026-10-22).
   */
  const repointAdopted = async (agent: Agent, path: string, deferred = false, wait = false): Promise<AdoptCrons | undefined> => {
    let crons: AdoptCrons = { total: 0, carried: 0, failed: 0 };
    const selfEntry = openclawAgentEntryForWorkspace(path);
    const pendingRow = () => store.listAdoptPending().find((r) => r.agentId === agent.id && r.path === path);
    let stale = false;
    const ran = await whileBusy(agent.id, async () => {
      if (deferred && !pendingRow()) { stale = true; return true; }
      // Where it runs, read under the flag: the caller's copy was read before
      // a wait (the quick pass's look at its gateway), and an agent moved to
      // another machine meanwhile had its files and tasks written through the
      // old one (HB-0978). Not running now: the record waits for the next pass.
      const now = store.getAgent(agent.id);
      if (!now?.runtimeRef || now.state !== 'RUNNING') { stale = true; return true; }
      const provider = providerFor(now.hostId);
      if (selfEntry) {
        try {
          await rewriteWorkspaceFiles(
            { provider, log: trace(agent.id) },
            now.runtimeRef,
            now.slug,
            selfPathReplacements(selfEntry, now.slug),
          );
        } catch (err) {
          trace(agent.id)('adopt.path_rewrite_skipped', { error: String(err).slice(0, 200) });
        }
      }
      try {
        crons = await migrateCrons(
          { store, provider, log: trace(agent.id) },
          agent.id,
          path,
          deferred ? { readyTries: 2 } : {},
        );
      } catch (err) {
        trace(agent.id)('cron.migrate_skipped', { error: String(err).slice(0, 200) });
      }
      // The source's task store could not be read at all (locked by its
      // OpenClaw, out of reach, damaged): read as no tasks, the pending adopt
      // was cleared and its tasks forgotten with nothing said (HB-0979). Kept
      // for a later pass within its day, as a gateway that did not answer is.
      const unread = !!crons.error && crons.total === 0;
      if ((crons.notReady || unread) && wait && pendingRow()) {
        // Its gateway did not answer yet (just started, or its runner is out
        // of reach): the next pass tries again. Said once.
        if (!adoptWaitSaid.has(`${agent.id}\n${path}`)) {
          adoptWaitSaid.add(`${agent.id}\n${path}`);
          trace(agent.id)('adopt.deferred_waiting', { total: crons.total, ...(unread ? { error: crons.error } : {}) });
        }
        return true;
      }
      adoptWaitSaid.delete(`${agent.id}\n${path}`);
      store.clearAdoptPending(agent.id, path);
      // Deferred tasks that did not come after all: the answer had said "deferred".
      if (deferred && (crons.failed > 0 || crons.error)) {
        trace(agent.id)('adopt.deferred_failed', { total: crons.total, failed: crons.failed, ...(crons.notReady ? { notReady: true } : {}), ...(crons.error ? { error: crons.error } : {}) });
        const failed = crons.failed > 0
          ? `${crons.failed} of the ${crons.total} scheduled task${crons.total === 1 ? '' : 's'} adopted into ${agent.name} could not be brought over${crons.notReady ? ' (its gateway did not answer for a day)' : ''}.`
          : '';
        const unreadable = crons.error
          ? `${failed ? ' ' : ''}The scheduled tasks of the OpenClaw agent adopted into ${agent.name} could not ${unread ? 'be read' : 'all be read'} (${crons.error}), so ${unread ? 'none of them' : 'not all of them'} came over.`
          : '';
        deps.notify(agent.ownerId, `${failed}${unreadable} Add them again in its Tasks page.`);
      }
      return true;
    }).catch((err) => {
      // A concurrent op holds the flag: repointing waits for the next pass, not fatal.
      trace(agent.id)('adopt.repoint_busy', { error: String(err).slice(0, 120) });
      return false;
    });
    return ran && !stale ? crons : undefined;
  };
  /** Per deferred adopt (agent + path): how long its agent has been found running (ms, and when
   *  last seen running), and its last look. In memory: a restart costs one early look and starts
   *  its day again. */
  const adoptRan = new Map<string, { ms: number; seen?: number }>();
  const adoptLastTry = new Map<string, number>();
  /** Adopts that could not re-point yet (stopped, or busy then): each runs once its agent is running. */
  const finishDeferredAdopts = async () => {
    const now = Date.now();
    const live = new Set<string>();
    for (const { agentId, path } of store.listAdoptPending()) {
      const key = `${agentId}\n${path}`;
      live.add(key);
      const a = store.getAgent(agentId);
      if (!a || a.state === 'DELETED' || a.state === 'ARCHIVED') { store.clearAdoptPending(agentId, path); continue; }
      // Its day counts only while the agent runs: stopped, the clock stops
      // (counted on, a start after a day gave up at once while the gateway
      // booted; started afresh, sleeping and waking meant it never gave up).
      // Review of the final-audit fixes, 2026-10-22.
      const ran = adoptRan.get(key) ?? { ms: 0 };
      if (a.state !== 'RUNNING' || !a.runtimeRef) { adoptRan.set(key, { ms: ran.ms }); adoptLastTry.delete(key); continue; }
      adoptRan.set(key, { ms: ran.ms + (ran.seen === undefined ? 0 : now - ran.seen), seen: now });
      if (isBusy(a.id)) continue;
      // Its day starts when it is first found running, not at the adopt
      // (one started two days later got a single try), and a gateway that did
      // not answer is looked at again hourly, not every pass: each look held
      // the agent busy for minutes (final audit, 2026-10-22).
      const last = adoptLastTry.get(key);
      if (last !== undefined && now - last < ADOPT_RETRY_MS) continue;
      adoptLastTry.set(key, now);
      const wait = adoptRan.get(key)!.ms < ADOPT_WAIT_MS;
      if (wait) {
        // One look at its gateway, outside the busy guard: not up yet, the agent stays free.
        const up = await listCrons(providerFor(a.hostId), a.runtimeRef, a.slug).then(() => true, () => false);
        if (!up) {
          if (!adoptWaitSaid.has(key)) { adoptWaitSaid.add(key); trace(a.id)('adopt.deferred_waiting', {}); }
          continue;
        }
      }
      const crons = await repointAdopted(a, path, true, wait);
      if (crons && !store.listAdoptPending().some((r) => r.agentId === agentId && r.path === path)) {
        trace(a.id)('adopt.deferred_done', { total: crons.total, carried: crons.carried, failed: crons.failed, ...(crons.error ? { error: crons.error } : {}) });
      }
    }
    for (const k of [...adoptRan.keys()]) if (!live.has(k)) { adoptRan.delete(k); adoptLastTry.delete(k); }
  };

  return {
    openclawAgents: () => discoverOpenclawAgents({ store, secrets }),
    quiesce: (ids) => quiesceOpenclawBots(ids),
    scanPaths: (path) => scanWorkspacePaths(path),

    inspect: async (path) => {
      const preview = inspectWorkspace(path);
      // Surface the bot this workspace already owns. The token never leaves
      // the server — the caller only needs to know one exists, and whether
      // taking it over is safe right now.
      const bot = findExistingBot(path);
      return {
        ...preview,
        existingBot: bot
          ? {
              accountId: bot.accountId,
              sourceAgentId: bot.sourceAgentId,
              allowFrom: bot.allowFrom,
              enabledInSource: bot.enabledInSource,
              channelOffInSource: bot.channelOffInSource,
              polling: await botPollState(bot.botToken),
            }
          : undefined,
      };
    },

    snapshotBefore: (agent) => autoSnapshot({ store, provider: providerFor(agent.hostId), log: trace(agent.id) }, agent.id, 'pre-adopt'),

    adoptInto: async (agent, path) => {
      const res = await applyWorkspace(
        { store, secrets, provider: providerFor(agent.hostId), channel: deps.channel,
          log: trace(agent.id) },
        agent.id,
        path,
      );
      // Repoint the agent's OWN absolute paths (its old workspace/agentDir) at
      // the container copy, in both its files and its crons, so references
      // resolve. Best-effort — neither ever fails the adopt itself. Held under
      // the busy guard (the long cron migration must not race a rebuild/delete)
      // and only attempted when the agent is actually RUNNING — against a
      // STOPPED container the cron gateway never answers, so it would hang the
      // readiness probe and then mislabel every cron "failed".
      const freshAgent = store.getAgent(agent.id)!;
      let crons: AdoptCrons = { total: 0, carried: 0, failed: 0 };
      const selfEntry = openclawAgentEntryForWorkspace(path);
      // Remembered until it has run: into a stopped agent, or one busy
      // just now, it runs once the agent is running (finishDeferredAdopts).
      // The answer said "deferred" while nothing kept the work (review
      // 2026-10-22, A39).
      if (selfEntry) store.setAdoptPending(agent.id, path, new Date().toISOString());
      else store.dropAdoptPending(agent.id);
      if (freshAgent.runtimeRef && freshAgent.state === 'RUNNING') {
        crons = (await repointAdopted(freshAgent, path)) ?? crons;
      } else if (selfEntry) {
        // Agent isn't running (adopted into a STOPPED agent): defer the crons
        // rather than attempt them against a down gateway. Report honestly.
        const read = readOpenclawCronStore(selfEntry.id);
        const pending = read.crons.length;
        if (pending > 0) crons = { total: pending, carried: 0, failed: 0, deferred: pending };
        if (read.error) crons = { ...crons, error: read.error };
      }
      return { ...res, crons };
    },

    repointAdopted,
    finishDeferredAdopts,
  };
}
