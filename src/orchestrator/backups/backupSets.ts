import type { ChannelProvisioner } from '../../channels/channel.js';
import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import {
  agentArchiveName,
  agentsMissingFromSet,
  backupRunState,
  backupsDir,
  keepDays,
  listBackups,
  restoreAgentFromBackup,
  startBackup,
  type BackupRunState,
  type BackupSet,
  type RestoreResult,
} from './backupFiles.js';
import { whileBusy } from '../lifecycle/busy.js';
import { beginOperation, type OpHandle } from '../lifecycle/operations.js';
import { reapplyCurrentSettings, type ProvisionDeps } from '../lifecycle/provision.js';

/**
 * Backup sets (HB-0808): the nightly
 * sets as Settings → Backups shows them, Back up now, and ONE agent's whole
 * volume restored from a set. Reading, pruning and restoring the sets
 * themselves is src/orchestrator/backups/backupFiles.ts; this is what the API built on it.
 *
 * Its state: none of its own. Whether a run is under way is backups.ts's
 * (`backupRunState`, and the lock file in the set); a restore holds the busy
 * flag (busy.ts) and is recorded as an operation (restore-backup).
 *
 * Nothing here knows about HTTP: a route checks who is asking (these sets
 * hold the whole fleet's data, so the machine's owner only), asks this, and
 * words the answer.
 */
export interface BackupSets {
  /**
   * The sets, each backed-up volume matched to a live agent, and who the
   * newest set leaves out. `latest`: only the newest set's date and flags,
   * no volume list (what the home screen polls).
   */
  list(opts: { latest: boolean }): BackupList;
  /** Back up now: the run's state, recorded as a machine's operation (Activity) unless one was already running. */
  runNow(requestedBy: string): BackupRunState;
  /**
   * ONE agent's volume replaced from the set of `date`, under the busy flag.
   * The function returned runs it (the route runs it now or in the
   * background); its refusals (RestoreError, AgentBusyError) are thrown.
   */
  restore(o: { agent: Agent; date: string; otherKey: boolean; requestedBy: string }): (onOperation?: (id: string) => void) => Promise<RestoreResult>;
}

/** GET /v1/backups's answer, with or without `?latest=1`. */
export type BackupList =
  | { backups: BackupSet[]; missing: ReturnType<typeof agentsMissingFromSet> }
  | { dir: string; keepDays: number; run: BackupRunState; backups: BackupSet[]; missing: ReturnType<typeof agentsMissingFromSet> };

/** What the backup sets need from the process they run in. Functions only, so a test hands them fakes. */
export interface BackupSetsDeps {
  store: Store;
  secrets: SecretStore;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Telegram's provisioner: a restore's second provision puts this installation's bot back. */
  channel: ChannelProvisioner;
  /** The memory search service a restore's second provision uses (read when it runs). */
  embedder: () => ProvisionDeps['embedder'];
  /** What a Start runs once up, for an agent a restore brought up (the routes' startHooksFor). */
  afterStart: (agentId: string) => void;
}

export function createBackupSets(deps: BackupSetsDeps): BackupSets {
  const { store, secrets, providerFor, trace } = deps;
  const snapshotDeps = (agent: Agent) => ({
    store,
    provider: providerFor(agent.hostId),
    log: trace(agent.id),
  });

  const list = ({ latest }: { latest: boolean }): BackupList => {
    // The host an agent missing from a set is on, named when it is not this machine.
    const remoteHost = (hostId: string) => {
      const h = store.getHost(hostId);
      return h && h.kind !== 'local' ? h.name : undefined;
    };
    if (latest) {
      // With who that set does not cover, as the full answer has it: the
      // home screen's machine line reads both (fourteenth review: it fetched
      // every set for them).
      const [newest] = listBackups(backupsDir(), { limit: 1 });
      const missing = newest && !newest.running ? agentsMissingFromSet(newest, store.listAllActiveAgents(), remoteHost) : [];
      return { backups: newest ? [{ ...newest, volumes: [] }] : [], missing };
    }
    // Match each backed-up volume to a live agent so the panel can offer a
    // per-agent Restore (and show its real name). Backups are machine-level (the
    // nightly script captures EVERY volume, across all owners) and this route is
    // already gated to the machine owner — so match against every active agent,
    // not just the caller's. Scoping to the caller made a family host's other
    // owners' agents all show up as "deleted".
    const all = store.listAllActiveAgents();
    const byArchive = new Map(all.filter((a) => a.runtimeRef).map((a) => [agentArchiveName(a.runtimeRef!), a]));
    // With the sets made by another install or under an earlier key, labelled
    // (BackupSet.foreign): hidden, an install's own vanished after a key change.
    const backups = listBackups(backupsDir(), { others: true }).map((set) => ({
      ...set,
      volumes: set.volumes.map((v) => {
        const a = byArchive.get(v.file);
        return a ? { ...v, agentId: a.id, name: a.name } : v;
      }),
    }));
    // Who the newest set does NOT cover: an agent on a runner is never in it
    // (the script archives this machine's volumes only), and nothing said so
    // (review, 2026-09-29). The host is named when it is not this machine.
    const newest = backups.find((b) => !b.foreign);
    const missing = newest && !newest.running ? agentsMissingFromSet(newest, all, remoteHost) : [];
    return { dir: backupsDir(), keepDays: keepDays(), run: backupRunState(), backups, missing };
  };

  const runNow = (requestedBy: string): BackupRunState => {
    // Recorded for the Activity list (a machine's operation, operations.ts);
    // backup-status.json stays what says whether the set is whole.
    const already = backupRunState().status === 'running';
    let op: OpHandle | undefined;
    const run = startBackup(Date.now(), (st) => {
      if (st.status === 'ok') op?.done('Backed up.');
      else op?.fail(st.summary?.split('\n').pop() || 'The backup failed.');
    });
    const local = store.localHostId();
    if (!already && local) {
      op = beginOperation(store, 'backup-run', null, {}, { hostId: local, requestedBy });
      if (run.status === 'error') op.fail(run.summary || 'The backup could not start.');
    }
    return run;
  };

  const restore: BackupSets['restore'] = ({ agent, date, otherKey, requestedBy }) =>
    (onOperation?: (id: string) => void) => whileBusy(agent.id, 'restore-backup', () =>
      restoreAgentFromBackup({
        ...snapshotDeps(agent),
        // The same second provision Import and Move use: this installation's
        // bot, members and model over the restored openclaw.json.
        reapply: () => reapplyCurrentSettings(
          { store, secrets, provider: providerFor(agent.hostId), channel: deps.channel, log: trace(agent.id), embedder: deps.embedder() },
          agent.id,
        ),
        // Started again after it: what a Start runs once up — detached Google
        // accounts come off, web chat and pins follow (B022).
        afterStart: deps.afterStart,
        requestedBy,
        onOperation,
        // The owner's yes to a set made by another install or under an earlier key.
        otherKey,
      }, agent.id, date));

  return { list, runNow, restore };
}
