import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { createAgentHome, type AgentHome } from './agentHome.js';
import { createCoreFiles, type CoreFiles } from './coreFiles.js';
import { createCoreFileTurns, type CoreFileTurns } from './coreFileTurns.js';

/**
 * An agent's files (HB-0808 step 13):
 * its core-files turn, which every change that writes its files shares
 * (`turns`), its core files read and saved from the app (`core`), and its
 * home browsed, downloaded and uploaded to (`home`). Built once in
 * `registerRoutes`, before the services that take the turn are, and on the
 * route context as `ctx.files`; its routes are in src/api/fileRoutes.ts.
 *
 * It owns the turn's queue (`agentsMdTurns`) and the deadlines of the
 * changes waiting for it (`turnWaits`); `stop()` refuses those waiting, as
 * their deadline would. It has no timer of its own beyond those deadlines.
 */
export interface Files {
  turns: CoreFileTurns;
  core: CoreFiles;
  home: AgentHome;
  /** The largest file (or folder as .tar.gz) that moves through the Files tab, either way (HATCHABOT_FILE_MAX_MB). */
  fileMaxBytes: number;
  stop(): void;
}

/** What the files need from the process they run in. Functions only, so a test hands them fakes. */
export interface FilesDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Deleted or being deleted. */
  agentGone: (id: string) => boolean;
  /** Is an archive of this agent under way? (Read when an upload's turn comes.) */
  isArchiving: (agentId: string) => boolean;
  /** The largest file (or folder as .tar.gz) that moves through the Files tab, either way (HATCHABOT_FILE_MAX_MB). */
  fileMaxBytes: number;
}

export function createFiles(deps: FilesDeps): Files {
  const { store, providerFor, trace, agentGone, isArchiving, fileMaxBytes } = deps;
  const turns = createCoreFileTurns({ store, agentGone });
  const core = createCoreFiles({ store, providerFor, trace, turns });
  const home = createAgentHome({ store, providerFor, trace, isArchiving, turns, fileMaxBytes });
  return { turns, core, home, fileMaxBytes, stop: () => turns.stop() };
}
