import { execFile } from 'node:child_process';
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Store } from '../store/store.js';
import { sharePathProblem } from './provision.js';
import type { ProvisionDeps } from './provision.js';
import { whileBusy } from './busy.js';

const execFileP = promisify(execFile);

/**
 * Adopt an OpenClaw agent that already exists on this machine — one you built
 * by hand, outside AgentClaw — bringing its whole workspace with it.
 *
 * Deliberately copies the ENTIRE directory rather than the three files
 * AgentClaw seeds. A hand-built agent's knowledge is rarely confined to
 * SOUL/AGENTS/MEMORY: real ones accumulate IDENTITY.md, USER.md, TOOLS.md,
 * HEARTBEAT.md and their own domain files, and taking only three would quietly
 * discard most of what makes the agent useful.
 *
 * The source is only ever READ. The original keeps working until you retire
 * it — which matters, because the two would otherwise both want the same bot.
 */

export class AdoptError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'AdoptError';
  }
}

/** Files that must never be carried into a managed agent. */
const EXCLUDE = [
  'openclaw-agent.sqlite',
  'openclaw-agent.sqlite-wal',
  'openclaw-agent.sqlite-shm',
  'auth-profiles.json',
  'auth-state.json',
  '.git',
  // Build artifacts: compiled for THIS machine, with absolute host paths baked
  // in, and regenerable from the manifests we do copy. Carrying them across is
  // worse than skipping them — you get binaries that don't run in the
  // container. A real workspace here held a 1.2 GB venv/ next to 800 KB of
  // actual notes.
  'node_modules',
  'venv',
  '.venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.DS_Store',
];

/** Above this, adopting is almost certainly a mistake — and the tar would
 *  outgrow the 1 GB buffer and fail with something unreadable. */
const MAX_BYTES = 750 * 1024 * 1024;
const MAX_FILES = 20_000;

export interface WorkspacePreview {
  path: string;
  files: string[];
  markdownFiles: string[];
  bytes: number;
  /** Artifact directories found and deliberately not copied, so the count
   *  never looks like something silently vanished. */
  skipped: string[];
}

/**
 * Look at a candidate workspace without touching it, so the owner can see
 * what would be adopted before committing.
 */
export function inspectWorkspace(dir: string): WorkspacePreview {
  const path = resolve(dir);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new AdoptError(`No such folder on this machine: ${path}`);
  }
  // The same refusals as a shared folder: never adopt a credential directory.
  const problem = sharePathProblem(path);
  if (problem) throw new AdoptError(problem);

  // Walk the whole tree, because packWorkspace copies the whole tree. Counting
  // only the top level made the preview lie: a real workspace keeps its daily
  // notes in memory/ and its work in projects/, so "8 files" announced a copy
  // that actually moved 17.
  const files: string[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  let truncated = false;
  const walk = (dir: string, prefix: string, depth: number): void => {
    // A deep tree must still be COUNTED, or the preview lies and the size/file
    // guards don't fire — packWorkspace tars the whole thing regardless of
    // depth. Treat hitting the depth ceiling as "too deep to vet", same as
    // over-many files, rather than silently ignoring what lies below.
    if (depth > 40) {
      truncated = true;
      return;
    }
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDE.includes(e.name)) {
        if (e.isDirectory()) skipped.push(prefix ? `${prefix}/${e.name}` : e.name);
        continue;
      }
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      // Dirent reflects lstat, so symlinks are neither isFile nor isDirectory
      // and are skipped — which also means no symlink loops to worry about.
      if (e.isDirectory()) {
        walk(resolve(dir, e.name), rel, depth + 1);
      } else if (e.isFile()) {
        files.push(rel);
        try {
          bytes += statSync(resolve(dir, e.name)).size;
        } catch {
          /* raced with a write; the estimate is advisory */
        }
      }
    }
  };
  walk(path, '', 0);
  if (truncated || bytes > MAX_BYTES) {
    throw new AdoptError(
      `${path} holds ${truncated ? `over ${MAX_FILES} files` : `${(bytes / 1e6).toFixed(0)} MB`} ` +
        `after skipping build artifacts. That is too big to copy into an agent — ` +
        `move the bulk data somewhere else and share that folder with the agent ` +
        `instead (agentclaw folders), so it reads the data in place rather than ` +
        `owning a copy of it.`,
    );
  }

  const markdownFiles = files.filter((f) => f.toLowerCase().endsWith('.md'));
  if (markdownFiles.length === 0) {
    throw new AdoptError(
      `${path} has no .md files — that does not look like an OpenClaw workspace. ` +
        `Expected SOUL.md, AGENTS.md, MEMORY.md or similar.`,
    );
  }
  return { path, files, markdownFiles, bytes, skipped };
}

/** Tar the workspace, excluding session databases and credentials. */
export async function packWorkspace(dir: string): Promise<Buffer> {
  const path = resolve(dir);
  const args = ['cz', '-C', path];
  for (const e of EXCLUDE) args.push(`--exclude=${e}`);
  args.push('.');
  const { stdout } = await execFileP('tar', args, {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 1024,
  });
  return stdout as Buffer;
}

export interface AdoptDeps extends ProvisionDeps {
  store: Store;
}

/**
 * Copy a prepared workspace into an already-provisioned agent, then restart it
 * so the runtime picks the files up.
 */
export async function applyWorkspace(
  deps: AdoptDeps,
  agentId: string,
  sourceDir: string,
): Promise<{ files: number; bytes: number }> {
  // Busy while the workspace is being replaced: a Rebuild passing its own
  // guards mid-copy would docker rm the container underneath the restore.
  return whileBusy(agentId, () => applyWorkspaceInner(deps, agentId, sourceDir));
}

async function applyWorkspaceInner(
  deps: AdoptDeps,
  agentId: string,
  sourceDir: string,
): Promise<{ files: number; bytes: number }> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new AdoptError('That agent has no runtime yet.');
  // Mid-provision, mid-rebuild or FAILED, the runtime is not a stable target
  // for a tar extract — and DELETING would resurrect files into a purge.
  if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
    throw new AdoptError(`Can't adopt into this agent while it is ${agent.state}.`);
  }

  const preview = inspectWorkspace(sourceDir);
  const tar = await packWorkspace(sourceDir);

  // Stop first: OpenClaw reads these at turn time, and copying underneath a
  // live agent risks a half-written workspace being read mid-conversation.
  const wasRunning = agent.state === 'RUNNING';
  if (wasRunning) {
    await provider.stop(agent.runtimeRef);
    store.setAgentState(agentId, 'STOPPED');
  }
  try {
    await provider.importWorkspace(agent.runtimeRef, agent.slug, tar);
  } catch (err) {
    // The extract is not atomic — the workspace may now hold an arbitrary
    // prefix of the archive. The agent must not come back up believing that
    // half-truth; leave it stopped and say what happened.
    log('adopt.import_failed', { agentId, from: preview.path, error: String(err) });
    throw new AdoptError(
      `Copying the workspace in failed partway — the agent is left stopped because its files ` +
        `may be half-replaced. Adopt again (a clean copy fixes a torn one), or restore a snapshot.`,
    );
  }
  if (wasRunning) {
    await provider.start(agent.runtimeRef);
    store.setAgentState(agentId, 'RUNNING');
  }

  log('agent.adopted_workspace', {
    agentId,
    from: preview.path,
    files: preview.files.length,
    bytes: preview.bytes,
  });
  return { files: preview.files.length, bytes: preview.bytes };
}

/**
 * The bot a hand-built agent already owns.
 *
 * Telegram caps one account at ~20 bots, and a workspace being adopted almost
 * always has a bot already — with the family's real chat history in it. Minting
 * a fresh one therefore spends a scarce slot to give everybody a stranger to
 * talk to. Reusing the existing one costs nothing and keeps the conversation.
 */
export interface ExistingBot {
  /** The old instance's agent id, for telling the owner what to stop. */
  sourceAgentId: string;
  accountId: string;
  botToken: string;
  /** Telegram user ids already cleared to talk to it. Carrying these over is
   *  what stops the owner having to pair with their own adopted agent. */
  allowFrom: string[];
  /** Still switched on in the hand-built instance — meaning that instance will
   *  poll this bot the moment it is running. */
  enabledInSource: boolean;
}

interface OpenClawConfig {
  agents?: { list?: Array<{ id?: string; workspace?: string; agentDir?: string }> };
  bindings?: Array<{ agentId?: string; match?: { channel?: string; accountId?: string } }>;
  channels?: {
    telegram?: {
      accounts?: Record<string, { botToken?: string; allowFrom?: string[]; enabled?: boolean }>;
    };
  };
}

/**
 * Resolve workspace → agent → binding → bot token in the hand-built instance's
 * config. Returns undefined rather than throwing: no existing bot is a normal
 * case (the owner just makes one), not an error.
 */
export function findExistingBot(
  workspaceDir: string,
  configPath = resolve(homedir(), '.openclaw/openclaw.json'),
): ExistingBot | undefined {
  let cfg: OpenClawConfig;
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8')) as OpenClawConfig;
  } catch {
    return undefined;
  }
  const want = resolve(workspaceDir);
  const agent = (cfg.agents?.list ?? []).find(
    (a) =>
      (a.workspace && resolve(a.workspace) === want) ||
      (a.agentDir && resolve(a.agentDir) === want),
  );
  if (!agent?.id) return undefined;

  const accountId = (cfg.bindings ?? []).find(
    (b) => b.agentId === agent.id && (b.match?.channel ?? 'telegram') === 'telegram',
  )?.match?.accountId;
  if (!accountId) return undefined;

  const account = cfg.channels?.telegram?.accounts?.[accountId];
  if (!account?.botToken) return undefined;
  const allowFrom = (account.allowFrom ?? []).filter((id) => /^\d{1,32}$/.test(id));
  return {
    sourceAgentId: agent.id,
    accountId,
    botToken: account.botToken,
    allowFrom,
    enabledInSource: account.enabled !== false,
  };
}

/**
 * Ask Telegram itself whether anyone else is polling this bot.
 *
 * Three-state on purpose: "couldn't reach Telegram" is not "nobody is polling",
 * and neither is "nobody answered in the split second we asked".
 *
 * This is the only authoritative answer: getUpdates replies 409 when another
 * process holds the poll, whatever manages that process. It matters most for
 * reuse, where the old instance is usually still running — and two pollers on
 * one token is not a clean failure, it is messages vanishing at random into
 * whichever copy won the race.
 *
 * offset=-1 peeks at the newest update without acknowledging it, so a live
 * conversation loses nothing.
 */
export type PollState = 'busy' | 'quiet' | 'unknown';

/**
 * NOTE ON WHAT THIS CAN PROVE: 'quiet' is not 'safe'. Telegram answers 409 only
 * when a getUpdates call is in flight at that instant, so a poller resting
 * between long-polls is indistinguishable from no poller at all — verified
 * against a bot the running instance owned, which answered ok:true. Use this to
 * CONFIRM a conflict, never to clear one; `enabledInSource` is the deterministic
 * signal.
 */
export async function botPollState(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PollState> {
  try {
    const res = await fetchImpl(
      `https://api.telegram.org/bot${botToken}/getUpdates?offset=-1&limit=1&timeout=0`,
    );
    if (res.status === 409) return 'busy';
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error_code?: number };
    if (body.error_code === 409) return 'busy';
    return body.ok ? 'quiet' : 'unknown';
  } catch {
    return 'unknown';
  }
}
