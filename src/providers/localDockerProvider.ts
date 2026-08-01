import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import type {
  ExecResult,
  RuntimeInfo,
  RuntimeProvider,
  RuntimeSpec,
  RuntimeStatus,
} from './provider.js';
import { ProviderError } from './provider.js';
import { buildConfigCommands, WORKSPACE_DIR_TEMPLATE } from '../openclaw/configWriter.js';

const execFileP = promisify(execFile);

export interface LocalDockerOptions {
  /** Image built by scripts/build-runtime-image.sh. */
  image?: string;
  /** Container name prefix. */
  prefix?: string;
  docker?: string;
}

/**
 * §5.2 made concrete on a single always-on box: one container per agent, one
 * named volume per agent. The volume holds the entire OpenClaw state dir
 * (config + workspace + memory + sessions), so the container is cattle — kill
 * and recreate it and the agent comes back intact. Re-hosting later is "move
 * the volume, keep the ref format".
 *
 * provision() goes all the way to `docker create`, baking env and mounts into
 * the container, so start/stop survive control-plane restarts with no state
 * held in this process. Changing env/mounts = re-provision (cattle).
 *
 * Shells out to the docker CLI rather than a client library: fewer deps, and
 * every operation here is coarse enough that process spawn cost is noise.
 */
export class LocalDockerProvider implements RuntimeProvider {
  readonly key = 'local-docker';
  readonly image: string;
  readonly prefix: string;
  readonly docker: string;

  constructor(opts: LocalDockerOptions = {}) {
    this.image = opts.image ?? 'agentclaw-runtime:latest';
    this.prefix = opts.prefix ?? 'agentclaw';
    this.docker = opts.docker ?? 'docker';
  }

  /**
   * Container names carry the agent slug so `docker ps` reads like an agent
   * list: agentclaw-kitchen-helper-9221b8b8. The runtimeRef embeds the full
   * container name, so nothing needs to be re-derived later.
   */
  #namesFor(spec: { agentId: string; slug: string }) {
    const slug = spec.slug.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 24);
    const container = `${this.prefix}-${slug}-${spec.agentId.slice(0, 8)}`;
    return { container, volume: `${container}-vol`, runtimeRef: `docker://${container}` };
  }

  /**
   * Resolve a stored ref to docker object names. Legacy refs (pre-slug, a bare
   * uuid fragment) map to the old naming scheme so existing agents keep
   * working without a migration.
   */
  #names(runtimeRef: string) {
    const name = runtimeRef.replace(/^docker:\/\//, '');
    if (name.startsWith(`${this.prefix}-`)) {
      return { container: name, volume: `${name}-vol` };
    }
    const short = name.slice(0, 12); // legacy: docker://<uuid-fragment>
    return { container: `${this.prefix}-${short}`, volume: `${this.prefix}-vol-${short}` };
  }

  async provision(spec: RuntimeSpec): Promise<{ runtimeRef: string }> {
    // Rebuild/retry path: reuse the existing names wholesale (container AND
    // volume) so the agent's memory survives and the stored ref stays valid —
    // including for legacy agents named under the old scheme.
    const { volume, container, runtimeRef } = spec.previousRef
      ? { ...this.#names(spec.previousRef), runtimeRef: spec.previousRef }
      : this.#namesFor(spec);

    // `docker volume create` is idempotent by name — a retry reuses the volume.
    await this.#must(['volume', 'create', volume], 'Could not create the agent volume.');

    await this.#seed(volume, spec);

    // Replace any existing container so a re-provision picks up new env/mounts.
    // Safe because all durable state lives on the volume.
    await this.#docker(['rm', '-f', container]);

    const args = [
      'create',
      '--name',
      container,
      '--restart',
      'unless-stopped',
      '-v',
      `${volume}:/home/node/.openclaw`,
    ];
    for (const m of spec.hostMounts ?? []) {
      args.push('-v', `${m.source}:${m.target}${m.readonly ? ':ro' : ''}`);
    }
    for (const [k, v] of Object.entries(spec.env)) {
      args.push('-e', `${k}=${v}`);
    }
    args.push(this.image, 'openclaw', 'gateway');
    await this.#must(args, 'The agent runtime could not be created.');

    return { runtimeRef };
  }

  async #seed(volume: string, spec: RuntimeSpec): Promise<void> {
    // Stage the seed: config commands as a shell script, workspace files as a
    // directory, both mounted read-only into a one-shot container. The bot
    // token rides inside seed.sh in a tmpdir (0700) for the duration of one
    // container run, then the whole directory is deleted.
    const seedDir = await mkdtemp(join(tmpdir(), 'agentclaw-seed-'));
    try {
      const workspaceDir = WORKSPACE_DIR_TEMPLATE.replace(
        '{slug}',
        spec.workspace.configPatch.agentId,
      );
      // The seed must be idempotent: rebuilds re-run it against a volume that
      // already holds a live workspace. Config sets are naturally re-runnable
      // (and SHOULD re-run — they re-apply current tokens/allowlists), but
      // `agents add` and the workspace file copies must not touch an existing
      // agent — overwriting MEMORY.md on rebuild would lobotomize it.
      const script: string[] = ['#!/usr/bin/env bash', 'set -euo pipefail'];
      for (const cmd of buildConfigCommands(spec.workspace.configPatch)) {
        const invoke = `openclaw ${cmd.argv.map(shq).join(' ')}`;
        const line = cmd.stdin ? `printf %s ${shq(cmd.stdin)} | ${invoke}` : invoke;
        script.push(
          cmd.argv[0] === 'agents' && cmd.argv[1] === 'add'
            ? `if [ ! -d ${shq(workspaceDir)} ]; then ${line}; fi`
            : line,
        );
      }
      script.push(`mkdir -p ${shq(workspaceDir)}`);
      for (const name of Object.keys(spec.workspace.files)) {
        const dest = `${workspaceDir}/${name}`;
        script.push(`[ -f ${shq(dest)} ] || cp ${shq(`/seed/workspace/${name}`)} ${shq(dest)}`);
      }

      await writeFile(join(seedDir, 'seed.sh'), script.join('\n') + '\n', { mode: 0o700 });
      for (const [name, contents] of Object.entries(spec.workspace.files)) {
        const path = join(seedDir, 'workspace', name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents);
      }

      const res = await this.#docker([
        'run',
        '--rm',
        '-v',
        `${volume}:/home/node/.openclaw`,
        '-v',
        `${seedDir}:/seed:ro`,
        this.image,
        'bash',
        '/seed/seed.sh',
      ]);
      if (res.code !== 0) {
        throw new ProviderError(
          `seed failed: ${res.stderr.slice(-2000) || res.stdout.slice(-2000)}`,
          'Setting up the agent workspace failed.',
        );
      }
    } finally {
      await rm(seedDir, { recursive: true, force: true });
    }
  }

  async start(runtimeRef: string): Promise<void> {
    const { container } = this.#names(runtimeRef);
    await this.#must(['start', container], 'The agent could not start. Try again?');
  }

  async stop(runtimeRef: string): Promise<void> {
    const { container } = this.#names(runtimeRef);
    await this.#must(['stop', '-t', '10', container], 'The agent could not be stopped.');
  }

  async destroy(runtimeRef: string, opts?: { purge?: boolean }): Promise<void> {
    const { container, volume } = this.#names(runtimeRef);
    await this.#docker(['rm', '-f', container]);
    if (opts?.purge) await this.#docker(['volume', 'rm', '-f', volume]);
  }

  async status(runtimeRef: string): Promise<RuntimeStatus> {
    const { container } = this.#names(runtimeRef);
    const res = await this.#docker(['inspect', '-f', '{{.State.Status}}', container]);
    if (res.code !== 0) return { phase: 'absent' };
    const state = res.stdout.trim();
    if (state === 'exited' || state === 'created' || state === 'paused') {
      return { phase: 'stopped' };
    }
    if (state === 'running') {
      // OpenClaw's own health command is the readiness signal — it queries the
      // gateway over its local socket and exits non-zero until it's serving.
      const health = await this.exec(runtimeRef, ['health']);
      return { phase: 'running', healthy: health.code === 0 };
    }
    if (state === 'restarting') return { phase: 'starting' };
    return { phase: 'error', message: `container state: ${state}` };
  }

  async exec(runtimeRef: string, openclawArgv: string[]): Promise<ExecResult> {
    const { container } = this.#names(runtimeRef);
    return this.#docker(['exec', container, 'openclaw', ...openclawArgv]);
  }

  async execShell(runtimeRef: string, script: string): Promise<ExecResult> {
    const { container } = this.#names(runtimeRef);
    return this.#docker(['exec', container, 'bash', '-c', script]);
  }

  async info(runtimeRef: string): Promise<RuntimeInfo> {
    const { container } = this.#names(runtimeRef);
    const res = await this.#docker([
      'inspect',
      '-f',
      `{{.Image}}|{{ index .Config.Labels "org.agentclaw.openclaw-version" }}`,
      container,
    ]);
    if (res.code !== 0) return {};
    const [imageId, openclawVersion] = res.stdout.trim().split('|');
    return { imageId, openclawVersion: openclawVersion || undefined };
  }

  async currentImageInfo(): Promise<RuntimeInfo> {
    const res = await this.#docker([
      'image',
      'inspect',
      '-f',
      `{{.Id}}|{{ index .Config.Labels "org.agentclaw.openclaw-version" }}`,
      this.image,
    ]);
    if (res.code !== 0) return {};
    const [imageId, openclawVersion] = res.stdout.trim().split('|');
    return { imageId, openclawVersion: openclawVersion || undefined };
  }

  async logs(runtimeRef: string, lines: number): Promise<string> {
    const { container } = this.#names(runtimeRef);
    const res = await this.#docker(['logs', '--tail', String(lines), container]);
    // docker logs writes container stdout to stdout and stderr to stderr —
    // interleave both, the reader wants the story not the streams.
    return (res.stdout + res.stderr).trim();
  }

  async exportState(runtimeRef: string): Promise<Buffer> {
    const { volume } = this.#names(runtimeRef);
    try {
      const { stdout } = await execFileP(
        this.docker,
        ['run', '--rm', '-v', `${volume}:/vol:ro`, 'alpine', 'tar', 'cz', '-C', '/vol', '.'],
        { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
      );
      return stdout as Buffer;
    } catch (err) {
      throw new ProviderError(
        `volume export failed: ${String(err).slice(0, 500)}`,
        "Couldn't snapshot the agent's state.",
        { cause: err },
      );
    }
  }

  async importState(runtimeRef: string, data: Buffer): Promise<void> {
    const { volume } = this.#names(runtimeRef);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.docker, [
        'run', '--rm', '-i', '-v', `${volume}:/vol`, 'alpine', 'tar', 'xz', '-C', '/vol',
      ]);
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new ProviderError(
              `volume import failed (${code}): ${stderr.slice(-500)}`,
              "Couldn't restore the agent's state.",
            ),
          );
      });
      child.stdin.end(data);
    });
  }

  async #must(args: string[], userMessage: string): Promise<ExecResult> {
    const res = await this.#docker(args);
    if (res.code !== 0) {
      throw new ProviderError(
        `docker ${args[0]} failed: ${res.stderr.slice(-2000)}`,
        userMessage,
      );
    }
    return res;
  }

  async #docker(args: string[]): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileP(this.docker, args, {
        maxBuffer: 8 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (err: any) {
      if (typeof err?.code === 'number' || err?.stdout !== undefined) {
        return {
          code: typeof err.code === 'number' ? err.code : 1,
          stdout: String(err.stdout ?? ''),
          stderr: String(err.stderr ?? err.message ?? ''),
        };
      }
      throw new ProviderError(
        `docker unavailable: ${String(err)}`,
        'Docker is not available on this host.',
      );
    }
  }
}

/** Minimal single-quote shell escaping for the generated seed script. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
