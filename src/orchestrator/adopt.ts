import { execFile } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Store } from '../store/store.js';
import { sharePathProblem } from './provision.js';
import type { ProvisionDeps } from './provision.js';

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
];

export interface WorkspacePreview {
  path: string;
  files: string[];
  markdownFiles: string[];
  bytes: number;
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

  const entries = readdirSync(path, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && !EXCLUDE.includes(e.name))
    .map((e) => e.name);
  const markdownFiles = files.filter((f) => f.toLowerCase().endsWith('.md'));
  if (markdownFiles.length === 0) {
    throw new AdoptError(
      `${path} has no .md files — that does not look like an OpenClaw workspace. ` +
        `Expected SOUL.md, AGENTS.md, MEMORY.md or similar.`,
    );
  }
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += statSync(resolve(path, f)).size;
    } catch {
      /* raced with a write; the estimate is advisory */
    }
  }
  return { path, files, markdownFiles, bytes };
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
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new AdoptError('That agent has no runtime yet.');

  const preview = inspectWorkspace(sourceDir);
  const tar = await packWorkspace(sourceDir);

  // Stop first: OpenClaw reads these at turn time, and copying underneath a
  // live agent risks a half-written workspace being read mid-conversation.
  const wasRunning = agent.state === 'RUNNING';
  if (wasRunning) {
    await provider.stop(agent.runtimeRef);
    store.setAgentState(agentId, 'STOPPED');
  }
  await provider.importWorkspace(agent.runtimeRef, agent.slug, tar);
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
