import { randomUUID } from 'node:crypto';
import type { CompositeTelegramProvisioner } from '../../channels/composite.js';
import type { Agent, Host } from '../../domain/types.js';
import { moveCrossesDown } from '../../openclaw/configWriter.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { allowedPeerAddress, pinnedPeerFetch, type PeerFetch } from '../../util/peerAddress.js';
import { markBusy } from '../lifecycle/busy.js';
import { derivedByTag, ensureImageOn } from '../machines/imageRecipe.js';
import { migrateAgent, moveState, preflight, type MigrateOptions, type MigrateResult, type MoveState, type Peer, type PreflightAnswer } from './migrate.js';
import { moveAgentToHost } from './moveHost.js';
import { TransferError } from './transfer.js';
import type { ProvisionDeps } from '../lifecycle/provision.js';

/** What another server asks before it sends an agent here (POST /v1/agents/preflight's body). */
export type PreflightAsk = Parameters<typeof preflight>[2];

/**
 * Moving an agent (HB-0808 step 12),
 * docs/moving-agents.md: to another machine of this install (move-host: the
 * same record, bot and members, only the Docker daemon changes), and to
 * another Hatchabot (rehost: the agent is shipped and the copy here
 * tombstoned), with the other servers this account knows (`peers`), the
 * questions they ask before a move here (`answerPreflight`) and after one
 * (`moveState`).
 *
 * Its state: none. A move is a long operation on disk (operations.ts),
 * finished, undone or held at the start (`resumeOperations`), and holds the
 * busy flag while it runs (moveHost.ts, migrate.ts).
 *
 * Nothing here knows about HTTP: a route checks who is asking and what they
 * asked, asks this in the order the checks have always run, and words the
 * answer. The checks a move makes before it stops anything, and once more
 * under its lock (`preflightRefusal`), are here so that both use one rule.
 */
export interface Moves {
  /** The folders of this machine the agent reads, which a runner cannot mount: the refusal, or undefined. */
  foldersStayHere(agent: Agent, host: Host): { error: string; code: 'folders_stay_here' } | undefined;
  /**
   * The agent's pinned image onto the other machine: there already, or built
   * there from its recipe. Holds the busy flag while it builds (the caller has
   * just checked it is free, with no wait between).
   */
  ensurePinnedImage(agent: Agent, image: string, host: Host): ReturnType<typeof ensureImageOn>;
  /** Its OpenClaw on the other machine could not read its data (across the 2026.8 line, downwards): the two versions, or undefined. */
  crossesDown(agent: Agent, host: Host, dropPin: boolean): Promise<{ running?: string; there?: string } | undefined>;
  /**
   * The checks of what the move was judged on, made again after the waits
   * (here, and once more under the move's lock after the daemon probes):
   * still the caller's (`current`, the owner's view of it now), not deleted,
   * on the same machine, runtime, source and image, not the manager, not
   * moved away, and no folder of this machine to a runner.
   */
  preflightRefusal(agent: Agent, host: Host, current: () => Agent | undefined): () => string | undefined;
  /** Run the move to another machine of this install (moveAgentToHost). */
  moveToHost(agent: Agent, host: Host, o: { dropPin: boolean; requestedBy: string; preflightRefusal: () => string | undefined; onOperation: (id: string) => void }): Promise<Agent>;
  /** Run the move to another Hatchabot (migrateAgent). */
  rehost(agent: Agent, peer: Peer, o: MigrateOptions): Promise<MigrateResult>;
  /** Another server's question before it sends an agent here. Changes nothing. */
  answerPreflight(ownerId: string, ask: PreflightAsk): Promise<PreflightAnswer>;
  /** What became of a move another Hatchabot sent here (move_receipts), for that account only. */
  moveState(moveId: string, ownerId: string): MoveState;
  /** The other Hatchabot servers this account can move agents to. */
  peers: {
    /** Without their tokens. */
    list(ownerId: string): Array<{ id: string; name: string; url: string }>;
    /** Why this address and token are not another Hatchabot server that takes them, or undefined. */
    refusal(url: string, token: string): Promise<string | undefined>;
    /** Keep one: its token in the secret store. */
    add(ownerId: string, p: { name: string; url: string; token: string }): Promise<{ id: string; name: string; url: string }>;
    /** Forget one and its token: false when the account has none by that id. A token that cannot be removed keeps it (TransferError). */
    remove(ownerId: string, id: string): Promise<boolean>;
  };
}

/** What the moves need from the process they run in. Functions only, so a test hands them fakes. */
export interface MovesDeps {
  store: Store;
  secrets: SecretStore;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Telegram's provisioner (the bot travels with a move). */
  channel: CompositeTelegramProvisioner;
  /** The memory search service as a build needs it (routes.ts's, read when a move runs). */
  embedder: () => ProvisionDeps['embedder'];
  /** Is a setup or rebuild in flight for the agent? (The setup and rebuild queue: no move begins under one.) */
  isInFlight: (agentId: string) => boolean;
  /** How another server is called: pinnedPeerFetch unless a test stubs it. */
  peerFetch?: PeerFetch;
  /** Deleted or being deleted. */
  agentGone: (id: string) => boolean;
}

export function createMoves(deps: MovesDeps): Moves {
  const { store, secrets, providerFor, trace, agentGone } = deps;
  return {
    foldersStayHere: (agent, host) => {
      // Folders are bind mounts of this machine's disk; a runner cannot mount
      // them, and the agent arrived told it had data it could not see (audit,
      // 2026-10-23). Say so, before anything is stopped.
      if (host.kind !== 'local') {
        const folders = [...(agent.sharedPaths ?? []), ...store.listDataSources(agent.id).filter((d) => d.kind === 'folder').map((d) => d.hostPath ?? d.mountName)];
        if (folders.length) {
          return {
            error: `"${agent.name}" reads ${folders.length} folder${folders.length === 1 ? '' : 's'} of this machine (${folders.slice(0, 2).join(', ')}${folders.length > 2 ? ', …' : ''}), which ${host.name} cannot see. Remove ${folders.length === 1 ? 'it' : 'them'} from its Data tab first, or move the data into a git repo.`,
            code: 'folders_stay_here',
          };
        }
      }
      return undefined;
    },

    ensurePinnedImage: async (agent, image, host) => {
      const release = markBusy(agent.id, 'move-image');
      try {
        // Derived images are built, and their records kept, on this machine.
        return await ensureImageOn(providerFor(host.id), providerFor(agent.hostId), image,
          derivedByTag((n) => store.getDerivedImage(n)), host.name, host.kind === 'local');
      } finally {
        release();
      }
    },

    crossesDown: async (agent, host, dropPin) => {
      if (!agent.runtimeRef) return undefined;
      const running = await providerFor(agent.hostId).info(agent.runtimeRef).catch(() => ({} as { openclawVersion?: string }));
      const there = await Promise.resolve().then(() => providerFor(host.id).currentImageInfo(dropPin ? undefined : (agent.image ?? undefined))).catch(() => ({} as { openclawVersion?: string }));
      return moveCrossesDown(running.openclawVersion, there.openclawVersion) ? { running: running.openclawVersion, there: there.openclawVersion } : undefined;
    },

    preflightRefusal: (agent, host, current) => (): string | undefined => {
      const fresh = current();
      if (!fresh || agentGone(agent.id)) return 'It was deleted or its ownership changed while the move was checked.';
      if (fresh.hostId !== agent.hostId || fresh.runtimeRef !== agent.runtimeRef || fresh.aiProfileId !== agent.aiProfileId
        || fresh.image !== agent.image || fresh.ops || fresh.migratedTo) {
        return 'Its machine, AI source or image changed while the move was checked. Look again, then move it.';
      }
      if (host.kind !== 'local' && ((fresh.sharedPaths?.length ?? 0) > 0 || store.listDataSources(agent.id).some((d) => d.kind === 'folder'))) {
        return 'It now reads a folder of this machine, which the other machine cannot see. Remove the folder before moving it.';
      }
      return undefined;
    },

    moveToHost: (agent, host, o) => moveAgentToHost(
      { store, secrets, channel: deps.channel, log: trace(agent.id), embedder: deps.embedder(),
        source: providerFor(agent.hostId), sourceHostId: agent.hostId, target: providerFor(host.id),
        requestedBy: o.requestedBy, onOperation: o.onOperation, dropPin: o.dropPin,
        rebuildWaiting: () => deps.isInFlight(agent.id), preflightRefusal: o.preflightRefusal },
      agent.id,
      host.id,
    ),

    rehost: (agent, peer, o) => migrateAgent(
      { store, secrets, provider: providerFor(agent.hostId), channel: deps.channel,
        log: trace(agent.id), peerFetch: deps.peerFetch },
      agent.id,
      peer,
      o,
    ),

    answerPreflight: async (ownerId, ask) => {
      // Our own image version, best-effort — unknown must not block a move.
      const localHost = store.listHosts(ownerId).find((h) => h.kind === 'local');
      const localVersion = localHost
        ? await providerFor(localHost.id)
            .currentImageInfo()
            .then((i) => i.openclawVersion)
            .catch(() => undefined)
        : undefined;
      return preflight(store, ownerId, ask, { openclawVersion: localVersion });
    },

    moveState: (moveId, ownerId) => moveState(store, moveId, ownerId),

    peers: {
      list: (ownerId) => store.listPeers(ownerId).map(({ secretRef: _s, ...safe }) => safe),
      refusal: async (url, token) => {
        // Another Hatchabot server is another machine: not this one's loopback,
        // nor a link-local/metadata address — that turned the probe into a
        // port scan from the server's own vantage point (26th audit).
        if (!allowedPeerAddress(url)) {
          return 'Give the other server\'s own address (its Tailscale or LAN name), not a local one.';
        }

        // Prove the token works before storing it, so a typo fails here rather
        // than halfway through a migration.
        try {
          // The name's resolved address is checked as the socket dials it, and
          // a redirect is refused (pinnedPeerFetch): the text check above can't
          // see a name that resolves to 127.0.0.1.
          const probe = await (deps.peerFetch ?? pinnedPeerFetch)(`${url.replace(/\/$/, '')}/v1/agents`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000),
          });
          if (probe.status === 401) {
            return 'That server rejected the token.';
          }
          if (!probe.ok) {
            return 'That address did not answer like a Hatchabot server.';
          }
        } catch {
          return `Couldn't reach a Hatchabot server at ${url}.`;
        }
        return undefined;
      },
      add: async (ownerId, { name, url, token }) => {
        const id = randomUUID();
        const secretRef = `peer/${id}/token`;
        await secrets.put(secretRef, token);
        store.insertPeer({
          id,
          ownerId,
          name,
          url,
          secretRef,
          createdAt: new Date().toISOString(),
        });
        return { id, name, url };
      },
      remove: async (ownerId, id) => {
        const peer = store.getPeer(ownerId, id);
        if (!peer) return false;
        // Its token goes first, and a delete that fails keeps the server: the
        // failure was swallowed and the row deleted, so the token outlived
        // what the owner was told was gone, with nothing left to try again
        // from (HB-1024).
        try {
          await secrets.delete(peer.secretRef);
        } catch (err) {
          throw new TransferError(`Couldn't remove ${peer.name}'s token here (${String((err as Error).message ?? err).slice(0, 200)}). It is still listed: forget it again.`);
        }
        store.deletePeer(ownerId, peer.id);
        return true;
      },
    },
  };
}
