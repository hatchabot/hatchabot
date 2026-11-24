import { createAgentSnapshots, type AgentSnapshots, type AgentSnapshotsDeps } from './agentSnapshots.js';
import { createBackupSets, type BackupSets, type BackupSetsDeps } from './backupSets.js';
import { createRestoreDrills, type RestoreDrills, type RestoreDrillsDeps } from './restoreDrills.js';

/**
 * The backups service (HB-0808): what
 * there is to put an agent back from, and putting it back. Three parts:
 *
 *  - `sets` (backupSets.ts): the nightly backup sets as Settings → Backups
 *    shows them, Back up now, and one agent's whole volume restored from a
 *    set;
 *  - `drills` (restoreDrills.ts): recovery readiness, and the restore drills
 *    that prove a set restores, from the app or on the opt-in schedule;
 *  - `snapshots` (agentSnapshots.ts): an agent's core-file history, one
 *    taken by hand, restored or deleted.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route file on the shared context (`ctx.backups`). Nothing here
 * knows about HTTP: a route checks who is asking, asks this, and words the
 * answer. `stop()` ends the drill schedule's timer, the only one.
 *
 * Reading and acting on the sets (src/orchestrator/backups/backupFiles.ts), the drill
 * script (drills.ts), the readiness maths (recoveryReadiness.ts) and taking
 * and restoring a snapshot (snapshots.ts) are their own modules, used beyond
 * this feature (doctor, moving machines, setup, the boot resume); this is
 * what the API built on them.
 */
export interface Backups {
  sets: BackupSets;
  drills: RestoreDrills;
  snapshots: AgentSnapshots;
  /** End the timer (the drill schedule): at shutdown. */
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type BackupsDeps = BackupSetsDeps & RestoreDrillsDeps & AgentSnapshotsDeps;

export function createBackups(deps: BackupsDeps): Backups {
  const sets = createBackupSets(deps);
  const drills = createRestoreDrills(deps);
  const snapshots = createAgentSnapshots(deps);
  return {
    sets, drills, snapshots,
    stop: () => { drills.stop(); },
  };
}
