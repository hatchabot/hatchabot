import { randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import type { Host } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import { pingRunner } from '../../providers/resolveProvider.js';
import { tcpTlsProblem } from '../../providers/runnerEndpoint.js';
import type { Store } from '../../store/store.js';
import { isBusy, whileBusy } from '../lifecycle/busy.js';
import { ensureRunnerKey, ensureSshConfigBlock, parseSshEndpoint } from './runnerSetup.js';

/** What a runner's probe said when it was added (pingRunner). */
export type RunnerPing = Awaited<ReturnType<typeof pingRunner>>;

/** Why a host cannot be removed now: agents on it, a move to or from it not over, or an image copy to it under way. */
export type HostInUse = { error: string; operation?: string };

/**
 * This install's machines (HB-0808):
 * this machine and the runners added to it (Settings → Hosts). Listed, added,
 * drained and removed.
 *
 * Its state, sorted (HB-0809): none of its own. A removal under way holds
 * the registry's `removingHosts` (moves, imports and new agents refuse such a
 * host too), reached through `beginRemoval` and `endRemoval`; the providers
 * and the runners' memory search services it forgets are the registry's
 * caches.
 *
 * Nothing here knows about HTTP: a route checks who is asking (only the
 * machine's owner adds, drains or removes one), asks this, and words the
 * answer.
 */
export interface Hosts {
  /**
   * The machines the caller is listed, each with how many agents run on it.
   * The machine's owner (`admin`) counts every agent and sees each row's
   * settings; anyone else counts their own, and gets the settings of their
   * own rows only (HB-0059).
   */
  list(ownerId: string, admin: boolean): Promise<Array<Record<string, unknown>>>;
  /** Why this address cannot be added for this account: not one that can be reached safely, or already added. */
  addProblem(ownerId: string, dockerHost: string): { invalid: string } | { already: Host } | undefined;
  /**
   * Add a runner (its key and ssh block first, best-effort), probed once; saved whether it answered or not.
   * `already`: the same address, however written, was added while this one was probed (HB-1119).
   */
  add(o: { ownerId: string; name: string; dockerHost: string }): Promise<{ host: Host; ping: RunnerPing; twins: Host[] } | { already: Host }>;
  /** Stop every running agent on the host; a busy one is skipped and named, one that left it or stopped meanwhile is neither. */
  drain(host: Host): Promise<{ stopped: number; skipped: string[] }>;
  /** Why the host cannot be removed now, or undefined. */
  inUse(hostId: string): HostInUse | undefined;
  /**
   * Remove a runner's row, and what Hatchabot ran there when it can be told
   * apart from this machine and answers. `going`: a removal of it is under
   * way. The caller has refused this machine itself.
   */
  remove(host: Host): Promise<{ refused: HostInUse } | { going: true } | { ok: true; warning?: string }>;
}

/** What the machines need from the process they run in. Functions only, so a test hands them fakes. */
export interface HostsDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** A stop by hand: a budget's pause no longer holds the agent (budgets.ts). */
  disownPauseOnStop: (agentId: string) => void;
  /** Hold the host for its removal: false when one is under way. Nothing new is placed on a held host. */
  beginRemoval: (hostId: string) => boolean;
  endRemoval: (hostId: string) => void;
  /** The runner's memory search service, and forgetting it and the host's providers once the row is gone. */
  embedderOf: (hostId: string) => { remove(onMachine: boolean): Promise<{ leftThere?: string }> };
  forgetEmbedder: (hostId: string) => void;
  forgetProviders: (hostId: string) => void;
  /** The image agents run on (HATCHABOT_IMAGE, or hatchabot-runtime:latest): the one a runner's probe looks for. */
  defaultBase: string;
}

/**
 * A Docker address as one spelling, whatever its case or trailing slash: what
 * sameEndpoint compares, and the key Add holds one address at a time by (HB-1119).
 */
export const endpointKey = (v: unknown): string => String(v ?? '').trim().replace(/\/+$/, '').toLowerCase();

/** One Docker address written two ways (case, a trailing slash) is the same. */
export const sameEndpoint = (a: unknown, b: unknown) => !!endpointKey(a) && endpointKey(a) === endpointKey(b);

/**
 * `installs`: the image copies (imageInstalls.ts). A copy under way to a runner
 * keeps it from being removed: the row went while docker went on pulling and
 * loading gigabytes there for hours, past anything that could follow or stop
 * it (HB-1025).
 */
export function createHosts(deps: HostsDeps, installs?: { underWay(hostId: string): boolean }): Hosts {
  const { store, providerFor, trace, disownPauseOnStop } = deps;

  /**
   * Other host rows on the same Docker daemon as this one: the same address, or
   * the same daemon ID when both answer in time. A machine that does not answer
   * cannot be told apart, and is not counted.
   */
  const rowsOnSameDaemon = async (host: Host, opts: { withLocal?: boolean } = {}): Promise<Host[]> => {
    const asked = <T>(p: Promise<T>): Promise<T | undefined> => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<undefined>((done) => { timer = setTimeout(() => done(undefined), 15_000); });
      return Promise.race([p.catch(() => undefined), late]).finally(() => clearTimeout(timer));
    };
    const others = store.listHosts(host.ownerId).filter((h) => h.id !== host.id && (opts.withLocal || h.kind !== 'local'));
    const mine = await asked((async () => providerFor(host.id).daemonId())());
    const same = await Promise.all(others.map(async (h) => {
      if (sameEndpoint(h.settings?.dockerHost, host.settings?.dockerHost)) return h;
      if (!mine) return undefined;
      return (await asked((async () => providerFor(h.id).daemonId())())) === mine ? h : undefined;
    }));
    return same.filter((h): h is Host => !!h);
  };

  const list: Hosts['list'] = async (ownerId, admin) => {
    // Annotate each host with how many agents run on it — the load signal for
    // placement and the "can I delete this?" check in the UI. The host owner
    // (admin) sees the true fleet-wide count; a plain user sees only THEIR own
    // agents' count, never a window onto others' fleet size.
    const active = store.listAllActiveAgents().filter((a) => admin || a.ownerId === ownerId);
    const hosts = store.listHosts(ownerId);
    // Whether each other machine answers a quick connect now (the provider's
    // cached probe, the same one every call to it goes through): the home
    // screen's machine line and its alert (2026-10-05).
    const reach = new Map(await Promise.all(hosts.filter((h) => h.kind !== 'local').map(async (h) =>
      [h.id, await (async () => (await providerFor(h.id).reachable?.()) ?? true)().catch(() => undefined)] as const)));
    // A machine's settings (a runner's Docker address) are its owner's: a
    // member is listed only this machine and their own, and gets no settings
    // of a machine that is not theirs (HB-0059).
    return hosts.map(({ settings, ...h }) => ({
      ...h,
      ...(admin || h.ownerId === ownerId ? { settings } : {}),
      ...(reach.has(h.id) && reach.get(h.id) !== undefined ? { reachable: reach.get(h.id) } : {}),
      agentCount: active.filter((a) => a.hostId === h.id).length,
      // The local host's stored NAME is a label ("This machine (its hostname)");
      // this is the machine itself. Agent cards want the bare hostname, and
      // reading it live also keeps it right after a box is renamed — the
      // stored label is written once at first boot and never revisited.
      ...(h.kind === 'local' ? { hostname: osHostname() } : {}),
    }));
  };

  const addProblem: Hosts['addProblem'] = (ownerId, dockerHost) => {
    const tlsProblem = tcpTlsProblem(dockerHost);
    if (tlsProblem) return { invalid: tlsProblem };
    // What the key's ssh block can be written for: saved anyway, an address in IPv6
    // form got none, and could never sign in (HB-0436).
    if (dockerHost.startsWith('ssh://') && !parseSshEndpoint(dockerHost)) {
      return { invalid: 'Use ssh://user@host, with a hostname or an IPv4 address: an IPv6 address, or anything else in that spot, cannot be set up to sign in.' };
    }
    // The same address again, usually after "it didn't answer yet": a second row for
    // one machine, and removing either took what the other's agents use (HB-0435).
    const already = store.listHosts(ownerId).find((h) => sameEndpoint(h.settings?.dockerHost, dockerHost));
    return already ? { already } : undefined;
  };

  const add: Hosts['add'] = async ({ ownerId, name, dockerHost }) => {
    // For ssh:// endpoints, pin our dedicated key + accept-new in ~/.ssh/config
    // BEFORE the first probe — this is what makes the headless service (no
    // ssh-agent) authenticate deterministically. Best-effort: a config we
    // can't write just means the ping reports whatever ssh can do without it.
    try {
      await ensureRunnerKey();
      await ensureSshConfigBlock(dockerHost);
    } catch {
      /* surfaced by the ping below if it actually matters */
    }
    // The image its agents would run, as Install image copies it: the probe
    // looked for hatchabot-runtime:latest whatever HATCHABOT_IMAGE said (HB-1108).
    const ping = await pingRunner(dockerHost, { image: deps.defaultBase });
    // Asked again now the probe is over, in the tick of the insert: the same
    // address written another way could have been added meanwhile (HB-1119).
    { const already = store.listHosts(ownerId).find((h) => sameEndpoint(h.settings?.dockerHost, dockerHost)); if (already) return { already }; }
    const host = {
      id: randomUUID(),
      ownerId,
      kind: 'cloud' as const,
      provider: 'remote-docker',
      name,
      settings: { dockerHost },
      createdAt: new Date().toISOString(),
    };
    store.insertHost(host);
    // Another address for a machine already here (a hostname and a tailnet address).
    // Said rather than refused: cloned machines can share a daemon's ID.
    const twins = ping.ok ? await rowsOnSameDaemon(host, { withLocal: true }) : [];
    return { host, ping, twins };
  };

  const drain: Hosts['drain'] = async (host) => {
    const running = store
      .listAllActiveAgents()
      .filter((a) => a.hostId === host.id && a.state === 'RUNNING' && a.runtimeRef);
    let stopped = 0;
    const skipped: string[] = [];
    for (const listed of running) {
      if (isBusy(listed.id)) { skipped.push(listed.name); continue; }
      try {
        // Hold the busy flag for the stop so an export/migrate can't start
        // between the check and the stop and get its container killed mid-tar.
        const done = await whileBusy(listed.id, 'drain', async () => {
          // As it is now, not as listed: while an earlier agent's stop waited,
          // this one could have moved to another host (its old copy left
          // there), stopped or been rebuilt. Stopped by the old listing, its
          // new home's row was marked STOPPED while it ran there (HB-0904).
          const a = store.getAgent(listed.id);
          if (!a || a.hostId !== host.id || a.state !== 'RUNNING' || !a.runtimeRef) return false;
          await providerFor(host.id).stop(a.runtimeRef);
          disownPauseOnStop(a.id);
          store.setAgentState(a.id, 'STOPPED');
          return true;
        });
        if (done) stopped++;
      } catch (err) {
        skipped.push(listed.name);
        trace(listed.id)('host.drain_stop_failed', { error: String(err).slice(0, 200) });
      }
    }
    return { stopped, skipped };
  };

  // Asked before anything is touched, after the machine is probed, and again
  // in the same tick as the delete, since an agent created, imported or moved there
  // while the machine was probed below was left on a host that was gone
  // (HB-0275).
  const inUse = (hostId: string): HostInUse | undefined => {
    const still = store.listAllActiveAgents().filter((a) => a.hostId === hostId);
    if (still.length) {
      return { error: `${still.length} agent${still.length === 1 ? '' : 's'} still run on this host — move or delete them first.` };
    }
    // A move to or from it that is not over still needs it: Put back starts
    // the agent's intact copy there. Removed, the agent was pointed back at a
    // machine Hatchabot no longer knew, and could not be started (audit #085).
    const moving = store.operationsWithStatus(['queued', 'running', 'interrupted', 'held'])
      .filter((o) => o.kind === 'move-host' && (o.params.from === hostId || o.params.to === hostId));
    if (moving.length) {
      const names = [...new Set(moving.map((o) => (o.agentId && store.getAgent(o.agentId)?.name) || 'an agent'))];
      return {
        error: `A move to or from this host is not over (${names.join(', ')}) — settle it on the agent's page (Alerts) first.`,
        operation: moving[0]!.id,
      };
    }
    if (installs?.underWay(hostId)) {
      return { error: 'The runtime image is being installed on this host — wait for Install image to finish (its row shows how far it has come), then remove it.' };
    }
    return undefined;
  };

  const remove: Hosts['remove'] = async (host) => {
    { const busy = inUse(host.id); if (busy) return { refused: busy }; }
    // Reserved until the row is gone: nothing new is placed on it meanwhile.
    if (!deps.beginRemoval(host.id)) return { going: true };
    try {
      // What it ran for this Hatchabot goes with it (2026-10-09): its memory
      // search service and agents' browsers on the machine when it answers,
      // and the service's key and state here either way. Not answering, they
      // stay there, and the owner is told what to remove by hand.
      const p = providerFor(host.id);
      const answers = p.reachable ? await p.reachable().catch(() => false) : true;
      // A runner row that is this machine's own Docker under another name (the
      // move's cardinal hazard, moveHost.ts) holds THIS machine's service and
      // browsers: nothing there is touched unless the daemons are known to differ.
      const local = store.localHostId();
      const sameDaemon = answers && local
        ? await Promise.all([p.daemonId(), providerFor(local).daemonId()]).then(([a, b]) => a === b, () => undefined)
        : false;
      // And another row on that same daemon: its browsers and memory search are named
      // per daemon, not per row, so its agents would lose both (HB-0435).
      const twins = answers && sameDaemon === false ? await rowsOnSameDaemon(host) : [];
      const shared = twins.length > 0;
      const reachable = answers && sameDaemon === false && !shared;
      // And before anything there is touched: an agent that arrived while the
      // machine was asked keeps its browser and memory search key (HB-0275).
      { const busy = inUse(host.id); if (busy) return { refused: busy }; }
      const left: string[] = [];
      if (reachable && p.listBrowsers && p.stopBrowser) {
        for (const b of await p.listBrowsers().catch(() => [])) {
          await p.stopBrowser(b.agentContainer).catch(() => { left.push(b.name); });
        }
      }
      // Finished one-shots too: one Docker stopped mid-restore keeps the
      // agent's archive (/tmp/s.tgz), and the 10-minute sweep never visits a
      // runner Hatchabot no longer knows (HB-0512). Exited ones only.
      if (reachable && p.sweepOneShots) {
        await p.sweepOneShots({ created: false, orThrow: true }).catch(() => { left.push('stopped helper containers labelled hatchabot.oneshot'); });
      }
      const svc = deps.embedderOf(host.id);
      const emb = await svc.remove(reachable).catch((err) => ({ leftThere: String((err as Error)?.message ?? err).slice(0, 200) }));
      { const busy = inUse(host.id); if (busy) return { refused: busy }; }
      deps.forgetEmbedder(host.id);
      deps.forgetProviders(host.id);
      store.deleteHost(host.id);
      const prefix = process.env.HATCHABOT_PREFIX || 'hatchabot';
      // Nothing there was removed, rightly if the two rows are one machine. Told
      // apart only by a daemon's ID, though, and cloned machines share one (POST
      // /v1/hosts): a clone keeps what ran on it, so that is said. The same address
      // is one machine for sure.
      const twin = sameDaemon === true ? (local ? store.getHost(local) : undefined)
        : twins.some((h) => sameEndpoint(h.settings?.dockerHost, host.settings?.dockerHost)) ? undefined : twins[0];
      const warning = twin
        ? `${host.name} reports the same Docker as "${twin.name}", so nothing Hatchabot ran there was removed. If it is really another machine (a cloned one can report the same Docker), remove the containers and volumes named ${prefix}-embed… (and any …-browser) with docker on it.`
        : sameDaemon === true || shared ? undefined
        : !reachable
        ? `${host.name} ${answers ? 'could not be told apart from this machine\'s Docker' : 'did not answer'}, so what Hatchabot ran there is still on it: remove the containers and volumes named ${prefix}-embed… (and any …-browser) with docker on that machine.`
        : emb.leftThere || left.length
          ? `Some of what Hatchabot ran on ${host.name} could not be removed (${[emb.leftThere, ...left].filter(Boolean).join('; ')}): remove it with docker on that machine.`
          : undefined;
      trace()('host.removed', { host: host.id, reachable, ...(warning ? { leftThere: warning } : {}) });
      return { ok: true, ...(warning ? { warning } : {}) };
    } finally { deps.endRemoval(host.id); }
  };

  return { list, addProblem, add, drain, inUse, remove };
}
