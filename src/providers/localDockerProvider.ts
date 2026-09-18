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
import { batchConfigCommands, buildConfigCommands, WORKSPACE_DIR_TEMPLATE } from '../openclaw/configWriter.js';

const execFileP = promisify(execFile);

export interface LocalDockerOptions {
  /** Image built by scripts/build-runtime-image.sh. */
  image?: string;
  /** Container name prefix. */
  prefix?: string;
  docker?: string;
  /**
   * A remote Docker endpoint (a `DOCKER_HOST` value — `ssh://user@vm` is the
   * simplest secure transport, or `tcp://ip:2376` with TLS set up out of band).
   * When set, every docker command targets that daemon via `-H`, the workspace
   * seed is streamed in over stdin instead of bind-mounted (the seed dir is on
   * THIS box, not the remote), and host-path bind mounts are skipped (they name
   * the control plane's filesystem, which the remote daemon can't see). This is
   * what turns the local provider into a fleet runner.
   */
  host?: string;
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
/** Docker object prefix for new agents; `agentclaw` is what installs from before the rename used. */
export const DEFAULT_PREFIX = 'hatchabot';
export const LEGACY_PREFIXES = ['agentclaw'] as const;
/** Docker image reference: repo[:tag] — no leading dash, so it can't parse as a flag. */
const IMAGE_REF_RE = /^[a-z0-9][a-z0-9._\/-]*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?$/;
/** Bound for volume import/export and seeding (large tarballs, slow runners). */
const IO_TIMEOUT_MS = Number(process.env.HATCHABOT_DOCKER_IO_TIMEOUT_MS ?? 15 * 60_000);

export class LocalDockerProvider implements RuntimeProvider {
  readonly key: string;
  readonly image: string;
  readonly prefix: string;
  readonly docker: string;
  /** True when pointed at a remote daemon (opts.host set). */
  readonly remote: boolean;
  /** Connection args prepended to every docker invocation (`-H <host>` or none). */
  readonly #conn: string[];

  constructor(opts: LocalDockerOptions = {}) {
    this.image = opts.image ?? 'hatchabot-runtime:latest';
    this.prefix = opts.prefix ?? DEFAULT_PREFIX;
    this.docker = opts.docker ?? 'docker';
    this.remote = !!opts.host;
    this.#conn = opts.host ? ['-H', opts.host] : [];
    this.key = this.remote ? 'remote-docker' : 'local-docker';
  }

  /** Full argv for a docker call: connection args first, then the command. */
  #argv(args: string[]): string[] {
    return [...this.#conn, ...args];
  }

  /**
   * Container names carry the agent slug so `docker ps` reads like an agent
   * list: hatchabot-kitchen-helper-9221b8b8. The runtimeRef embeds the full
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
    if (name.startsWith(`${this.prefix}-`) || LEGACY_PREFIXES.some((p) => name.startsWith(`${p}-`))) {
      return { container: name, volume: `${name}-vol` };
    }
    // legacy: docker://<uuid-fragment> — these predate the rename, so under the
    // default prefix they live under the old one.
    const short = name.slice(0, 12);
    const p = this.prefix === DEFAULT_PREFIX ? LEGACY_PREFIXES[0] : this.prefix;
    return { container: `${p}-${short}`, volume: `${p}-vol-${short}` };
  }

  /**
   * Pre-rename daemons (this host or a runner loaded by `docker save|load`)
   * hold the image as agentclaw-runtime:<tag>; make the new name exist there
   * by tagging — a pointer, no rebuild. Only for the default repo name.
   */
  async #ensureImage(image: string): Promise<void> {
    if (!image.startsWith('hatchabot-runtime:')) return;
    if ((await this.#docker(['image', 'inspect', '--format', '{{.Id}}', image])).code === 0) return;
    const legacy = image.replace(/^hatchabot-runtime:/, 'agentclaw-runtime:');
    if ((await this.#docker(['image', 'inspect', '--format', '{{.Id}}', legacy])).code !== 0) return; // genuinely missing; docker will say so
    await this.#docker(['tag', legacy, image]);
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

    // Reshape an older volume BEFORE anything writes to it: the seed below
    // mounts it as $HOME and writes .openclaw paths, which would collide with
    // the pre-migration content still sitting at the volume root.
    await this.#migrateToHomeLayout(volume);
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
      // PID 1 is a node process (openclaw gateway) and node does not reap
      // orphaned grandchildren — Claude Code spawns bash/git/etc., and any
      // orphan that outlives its parent would sit as a zombie for the whole
      // life of a long-lived agent. tini (docker's --init) reaps them.
      '--init',
      // An agent runs AI-authored code reachable by anyone in its rooms — deny
      // it privilege escalation via setuid binaries. Cheap, safe hardening for
      // the shared multi-account box (family-member hardening 2026-09-08).
      '--security-opt', 'no-new-privileges',
      // One misbehaving agent must not fill the disk or the box. Overridable
      // for hosts that want to run bigger agents.
      '--log-opt', 'max-size=10m',
      '--log-opt', 'max-file=3',
      // Agents live on their own network with inter-container traffic off. On
      // docker's default bridge every agent could open a connection to every
      // other agent's gateway, bypassing the owner-only proxy (audit
      // 2026-09-18). Host services (Hatchabot at 172.17.0.1:8080, Ollama) stay
      // reachable. HATCHABOT_AGENT_NETWORK=bridge restores the old behaviour.
      ...(spec.isolated ? ['--network', await this.#isolatedNetwork()] : await this.#agentNetworkArgs()),
      '--memory', process.env.HATCHABOT_AGENT_MEMORY ?? '2g',
      '--pids-limit', process.env.HATCHABOT_AGENT_PIDS ?? '512',
      // `hostname` inside the container answers "<agent>.<host>" — the moving
      // agent's compass (see provision.ts, which derives it per host).
      ...(spec.hostname ? ['--hostname', spec.hostname] : []),
      '-v',
      // The volume is the agent's HOME, not just ~/.openclaw. /usr is the image
      // (base functionality, replaced by a rebuild); $HOME is the agent's and
      // persists. That one boundary is why a credential written to
      // ~/.config/<tool> — the natural place, and where a chat-configured Jira
      // token landed — now survives a rebuild without per-tool plumbing.
      // Absolute paths are unchanged: the volume contains .openclaw/, so
      // /home/node/.openclaw/... still resolves exactly as before.
      `${volume}:/home/node`,
    ];
    // Host-path bind mounts (shared folders, ~/.claude) name the CONTROL
    // PLANE's filesystem; a remote daemon can't see them, so they're skipped
    // there. Cloud agents use API keys (no ~/.claude) and git/volume data, not
    // local folders — provision.ts already refuses Max on a non-local host.
    if (!this.remote) {
      for (const m of spec.hostMounts ?? []) {
        args.push('-v', `${m.source}:${m.target}${m.readonly ? ':ro' : ''}`);
      }
    }
    // An isolated network publishes nothing (docker ignores -p there anyway):
    // the control plane reaches the container by its address instead.
    for (const p of spec.isolated ? [] : spec.ports ?? []) {
      // Loopback only: the agent's Control UI is a debug door for whoever is
      // on this box (or tunnelling to it), never for the whole LAN/tailnet.
      args.push('-p', `127.0.0.1:${p.host}:${p.container}`);
    }
    for (const [k, v] of Object.entries(spec.env)) {
      args.push('-e', `${k}=${v}`);
    }
    const image = spec.image ?? this.image;
    if (!IMAGE_REF_RE.test(image)) throw new ProviderError(`bad image ref ${image}`, 'That image name is not valid.');
    await this.#ensureImage(image);
    args.push(image, 'openclaw', 'gateway');
    await this.#must(args, 'The agent runtime could not be created.');

    return { runtimeRef };
  }

  /**
   * One-time move of a pre-home-as-volume layout into its new shape.
   *
   * The volume used to be mounted at ~/.openclaw, so its root held `agents/`,
   * `openclaw.json`, `credentials/`… Now the volume IS $HOME, so that content
   * has to sit under `.openclaw/`. Absolute paths inside the container are
   * identical afterwards — only the volume's internal shape changes.
   *
   * Idempotent and self-healing: the marker is written LAST, so a run that dies
   * midway simply moves whatever is left the next time. Runs before the
   * container is created, so it covers provision, rebuild, restore and move.
   */
  async #migrateToHomeLayout(volume: string): Promise<void> {
    // One line, and an explicit `if` rather than `[ … ] && exit 0`: under
    // `set -e` that idiom's exit status is a well-known footgun, and a
    // multi-line script also breaks the argv-logging in tests.
    const script =
      'set -e; ' +
      // Already migrated, or a brand-new empty volume → nothing to do.
      'if [ -f /vol/.openclaw/.agentclaw-home-v2 ]; then exit 0; fi; ' +
      'mkdir -p /vol/.openclaw; ' +
      // This one-shot runs as ROOT, so anything it creates is root-owned — and
      // the agent runs as uid 1000. Without this the gateway can't even open
      // openclaw.json.lock (EACCES) and never comes online. The MOVED content
      // already carries the right ownership; it's the new dir and the volume
      // root (now $HOME) that need it.
      'chown 1000:1000 /vol /vol/.openclaw; ' +
      // Move every root entry except .openclaw itself into it.
      'find /vol -mindepth 1 -maxdepth 1 ! -name .openclaw -exec mv -t /vol/.openclaw {} + ; ' +
      // Marker LAST: a run that dies midway simply finishes next time.
      'touch /vol/.openclaw/.agentclaw-home-v2';
    const res = await this.#docker([
      'run', '--rm', '-v', `${volume}:/vol`, 'alpine', 'sh', '-c', script,
    ]);
    if (res.code !== 0) {
      throw new ProviderError(
        `home-layout migration failed (${res.code}): ${res.stderr.slice(-300)}`,
        "Couldn't prepare the agent's storage.",
      );
    }
  }

  async #seed(volume: string, spec: RuntimeSpec): Promise<void> {
    // Stage the seed: config commands as a shell script, workspace files as a
    // directory, both mounted read-only into a one-shot container. The bot
    // token rides inside seed.sh in a tmpdir (0700) for the duration of one
    // container run, then the whole directory is deleted.
    const seedDir = await mkdtemp(join(tmpdir(), 'hatchabot-seed-'));
    try {
      const workspaceDir = WORKSPACE_DIR_TEMPLATE.replace(
        '{slug}',
        spec.workspace.configPatch.agentId,
      );
      // Where the one-shot reads its seed payload. Locally it's bind-mounted at
      // /seed (mount point pre-exists). Remotely it's streamed in as a tar and
      // must be extracted somewhere the NON-ROOT runtime user can create — /seed
      // is at the root fs (root-owned), so use a world-writable tmp path.
      const seedBase = this.remote ? '/tmp/hatchabot-seed' : '/seed';
      // The seed must be idempotent: rebuilds re-run it against a volume that
      // already holds a live workspace. Config sets are naturally re-runnable
      // (and SHOULD re-run — they re-apply current tokens/allowlists), but
      // `agents add` and the workspace file copies must not touch an existing
      // agent — overwriting MEMORY.md on rebuild would lobotomize it.
      const script: string[] = ['#!/usr/bin/env bash', 'set -euo pipefail'];
      // $HOME is the volume, so anything the agent installs or configures for
      // itself persists. Make the conventional targets exist and be usable:
      //  - ~/.local/bin on PATH, so a tool it installs is runnable by name
      //  - npm's prefix in $HOME, so `npm i -g` works without root and persists
      // Written to .profile/.bashrc-adjacent state ONLY if absent, so an agent
      // that edits its own environment keeps the edit.
      script.push(
        'mkdir -p "$HOME/.local/bin" "$HOME/.config" "$HOME/.npm-global"',
        'grep -qs agentclaw-path "$HOME/.profile" 2>/dev/null || cat >> "$HOME/.profile" <<\'EOF\'',
        '# agentclaw-path: $HOME is a persistent volume — things you install here survive rebuilds.',
        'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"',
        'export NPM_CONFIG_PREFIX="$HOME/.npm-global"',
        'EOF',
      );
      for (const cmd of batchConfigCommands(buildConfigCommands(spec.workspace.configPatch))) {
        const invoke = `openclaw ${cmd.argv.map(shq).join(' ')}`;
        const base = cmd.rawShell ?? (cmd.stdin ? `printf %s ${shq(cmd.stdin)} | ${invoke}` : invoke);
        const line = cmd.optional ? `${base} || true` : base;
        script.push(
          cmd.argv[0] === 'agents' && cmd.argv[1] === 'add'
            ? `if [ ! -d ${shq(workspaceDir)} ]; then ${line}; fi`
            : line,
        );
      }
      script.push(`mkdir -p ${shq(workspaceDir)}`);
      for (const name of Object.keys(spec.workspace.files)) {
        const dest = `${workspaceDir}/${name}`;
        // Nested seeds (skills/gog/SKILL.md) need their directory first; the
        // guard below only checks the FILE, so this stays overwrite-safe.
        if (name.includes('/')) {
          script.push(`mkdir -p ${shq(dest.slice(0, dest.lastIndexOf('/')))}`);
        }
        script.push(`[ -f ${shq(dest)} ] || cp ${shq(`${seedBase}/workspace/${name}`)} ${shq(dest)}`);
      }

      await writeFile(join(seedDir, 'seed.sh'), script.join('\n') + '\n', { mode: 0o700 });
      for (const [name, contents] of Object.entries(spec.workspace.files)) {
        const path = join(seedDir, 'workspace', name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents);
      }

      let res: ExecResult;
      if (this.remote) {
        // The seed dir is on THIS box; a remote daemon can't bind-mount it, so
        // stream it in as a tar over stdin and extract inside the one-shot.
        const tar = await execFileP('tar', ['cz', '-C', seedDir, '.'], {
          encoding: 'buffer',
          maxBuffer: 256 * 1024 * 1024,
        });
        res = await this.#runStdin(
          ['run', '--rm', '-i', '-v', `${volume}:/home/node`, spec.image ?? this.image,
            'bash', '-c', `mkdir -p ${seedBase} && tar xz -C ${seedBase} && bash ${seedBase}/seed.sh`],
          tar.stdout as Buffer,
        );
      } else {
        res = await this.#docker([
          'run', '--rm', '-v', `${volume}:/home/node`, '-v', `${seedDir}:/seed:ro`,
          spec.image ?? this.image, 'bash', '/seed/seed.sh',
        ]);
      }
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
    // #docker turns every non-zero exit (including an unreachable daemon) into
    // a RESULT, so ignoring it made destroy() unable to fail — and callers that
    // branch on failure (moveHost's orphan check, delete's "runtime may have
    // survived" guard) became dead code: a move whose cleanup failed restarted
    // the source while the target still ran, putting two pollers on one bot.
    // Already-gone is still success — delete must stay idempotent.
    const gone = /no such (container|volume)|not found/i;
    const check = (r: { code: number; stderr: string }, what: string) => {
      if (r.code === 0 || gone.test(r.stderr)) return;
      throw new ProviderError(
        `docker ${what} failed (${r.code}): ${r.stderr.slice(-300)}`,
        "Couldn't remove the agent's runtime.",
      );
    };
    check(await this.#docker(['rm', '-f', container]), 'rm');
    if (opts?.purge) check(await this.#docker(['volume', 'rm', '-f', volume]), 'volume rm');
  }

  async status(runtimeRef: string): Promise<RuntimeStatus> {
    const { container } = this.#names(runtimeRef);
    const res = await this.#docker(['inspect', '-f', '{{.State.Status}}', container]);
    if (res.code !== 0) {
      // A daemon that is down is NOT a container that is gone. Conflating them
      // let a boot-order race mark every healthy agent FAILED — and the owner's
      // Retry then risked their memory. Report unknown and let callers wait.
      // A timed-out inspect is the same situation arriving a different way: a
      // stalled daemon (IO load, backup running) says nothing about the
      // container, and its stderr is empty so the regex below can't catch it.
      if (res.timedOut) return { phase: 'unknown' };
      // Any "can't reach/use the daemon" error means the container's fate is
      // unknown, NOT that it is gone. Besides the daemon being down, this
      // covers a permission error (user briefly out of the docker group after
      // a reboot) and TLS/context/connect misconfig — all of which otherwise
      // fell through to `absent` and made reconcile FAIL the whole fleet.
      if (
        /cannot connect to the docker daemon|is the docker daemon running|permission denied|denied while trying to connect|error during connect|cannot connect|no such host|context .* not found/i.test(
          res.stderr,
        )
      ) {
        return { phase: 'unknown' };
      }
      // Default stays `absent`: a genuine "No such container" (the common
      // stderr on inspect of a removed container) must still be caught so a
      // vanished runtime gets flagged for Retry.
      return { phase: 'absent' };
    }
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

  async exec(runtimeRef: string, openclawArgv: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    const { container } = this.#names(runtimeRef);
    return this.#docker(['exec', container, 'openclaw', ...openclawArgv], opts?.timeoutMs);
  }

  async execShell(runtimeRef: string, script: string): Promise<ExecResult> {
    const { container } = this.#names(runtimeRef);
    return this.#docker(['exec', container, 'bash', '-c', script]);
  }

  async execShellOnVolume(runtimeRef: string, script: string, opts?: { readOnly?: boolean }): Promise<ExecResult> {
    const { volume } = this.#names(runtimeRef);
    // The runtime image (has bash + node, runs as uid 1000 like the files on
    // the volume), mounted at the path the agent itself sees. Read-only callers
    // (archive inspection) get a :ro mount so the guarantee is enforced by
    // Docker, not just by which commands the script happens to run.
    const mount = opts?.readOnly ? `${volume}:/home/node:ro` : `${volume}:/home/node`;
    return this.#docker([
      'run', '--rm', '-v', mount, this.image,
      'bash', '-c', script,
    ]);
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

  #daemonId?: string;
  async daemonId(): Promise<string> {
    // The daemon's own ID is stable for the life of the daemon — cache it.
    if (this.#daemonId) return this.#daemonId;
    const res = await this.#docker(['info', '--format', '{{.ID}}']);
    const id = res.stdout.trim();
    if (res.code !== 0 || !id) {
      throw new ProviderError(
        `docker info failed on ${this.remote ? this.#conn.join(' ') : 'the local daemon'}: ${res.stderr.slice(-200)}`,
        "Couldn't reach that host's Docker daemon.",
      );
    }
    return (this.#daemonId = id);
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

  async listImageTags(): Promise<{ tag: string; imageId: string; createdAt?: string; size?: string; openclawVersion?: string }[]> {
    const repo = this.image.replace(/:[^:]*$/, '');
    const res = await this.#docker(['images', '--format', '{{.Repository}}:{{.Tag}}|{{.ID}}|{{.CreatedAt}}|{{.Size}}', repo]);
    if (res.code !== 0) return [];
    const tags: { tag: string; imageId: string; createdAt?: string; size?: string; openclawVersion?: string }[] = res.stdout.split('\n').filter(Boolean).map((l) => {
      const [tag, imageId, createdAt, size] = l.split('|');
      return { tag: tag!, imageId: imageId!, createdAt: createdAt?.slice(0, 19), size };
    }).filter((t) => !t.tag.endsWith(':<none>'));
    // What's inside: the OpenClaw version label, one inspect for all distinct ids.
    const ids = [...new Set(tags.map((t) => t.imageId))];
    if (ids.length) {
      const ins = await this.#docker(['image', 'inspect', '--format', '{{.Id}}|{{ index .Config.Labels "org.agentclaw.openclaw-version" }}', ...ids]);
      const ver = new Map<string, string>();
      for (const l of ins.stdout.split('\n')) { const [id, v] = l.split('|'); if (id && v) ver.set(id.replace(/^sha256:/, '').slice(0, 12), v); }
      for (const t of tags) t.openclawVersion = ver.get(t.imageId);
    }
    return tags;
  }

  async tagImage(from: string, to: string): Promise<void> {
    for (const ref of [from, to]) if (!IMAGE_REF_RE.test(ref)) throw new ProviderError(`bad image ref ${ref}`, 'That image name is not valid.');
    await this.#must(['tag', from, to], `Couldn't tag ${from} as ${to}.`);
  }

  async imageHistory(ref: string): Promise<{ step: string; size: string }[]> {
    if (!IMAGE_REF_RE.test(ref)) throw new ProviderError(`bad image ref ${ref}`, 'That image name is not valid.');
    const res = await this.#docker(['history', '--no-trunc', '--format', '{{.Size}}\t{{.CreatedBy}}', ref]);
    if (res.code !== 0) return [];
    return res.stdout.split('\n').filter(Boolean).map((l) => {
      const i = l.indexOf('\t');
      const size = l.slice(0, i); let step = l.slice(i + 1);
      // Strip the shell/buildkit noise so a step reads like the Dockerfile line it came from.
      step = step.replace(/^\/bin\/sh -c #\(nop\)\s*/, '').replace(/^\/bin\/sh -c /, 'RUN ').replace(/^RUN \|\d+ (?:[A-Z_]+=\S+ )*/, 'RUN ').replace(/\s*# buildkit$/, '').trim();
      return { step, size };
    }).filter((h) => h.step && !/^(LABEL|ARG|ENV|WORKDIR|SHELL|STOPSIGNAL|EXPOSE|VOLUME|MAINTAINER)\b/i.test(h.step) || /openclaw|apt|pip|npm|COPY|ADD/i.test(h.step));
  }

  async removeImageTag(ref: string): Promise<void> {
    if (!IMAGE_REF_RE.test(ref)) throw new ProviderError(`bad image ref ${ref}`, 'That image name is not valid.');
    const res = await this.#docker(['rmi', ref]);
    if (res.code !== 0) {
      const inUse = /conflict|being used|is using/i.test(res.stderr);
      throw new ProviderError(`rmi failed: ${res.stderr.slice(0, 300)}`, inUse ? 'A container (possibly stopped or archived) still runs on that image — it cannot be removed until they are rebuilt or deleted.' : "Couldn't remove that image tag.");
    }
  }

  async modelCallLog(runtimeRef: string, sinceIso: string): Promise<string> {
    // Stream and filter: an agent that polls an inbox logs thousands of lines a
    // day, so never buffer the whole log — keep only the model-call results.
    const { container } = this.#names(runtimeRef);
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.docker, this.#argv(['logs', '--since', sinceIso, '--timestamps', container]));
      const keep: string[] = [];
      let buf = '';
      const eat = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (line.includes('[model-fetch] response') && keep.length < 200_000) keep.push(line);
        }
        if (buf.length > 1_000_000) buf = ''; // a pathological line: drop it
      };
      child.stdout.on('data', eat);
      child.stderr.on('data', eat);
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      timer.unref();
      // A failure must REJECT. Resolving with "" made a dead docker daemon
      // indistinguishable from an idle agent: the sampler logged nothing and
      // advanced its cursor, so every call made during the outage was lost
      // for good (audit 2026-09-16).
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (keep.length === 0 && (signal || (code ?? 0) !== 0)) {
          reject(new Error(`docker logs exited ${signal ?? code} for ${container}`));
          return;
        }
        resolve(keep.join('\n'));
      });
    });
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
        this.#argv(['run', '--rm', '-v', `${volume}:/vol:ro`, 'alpine', 'tar', 'cz', '-C', '/vol', '.']),
        { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, timeout: IO_TIMEOUT_MS, killSignal: 'SIGKILL' },
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
      // An archive is untrusted input, so it must not dictate ownership or
      // carry setuid bits — but the runtime runs as uid 1000 and has to be
      // able to read what we extract. --no-same-owner alone left everything
      // root-owned and every import failed with EACCES on openclaw.json.
      // So: refuse the archive's ownership, then set the correct one, and
      // strip setuid/setgid while KEEPING modes (credentials rely on 0600).
      // Clear the volume FIRST so this is a true replace, not an overlay — a
      // restore/rollback must not leave behind files created since the snapshot
      // (and on import it discards the provisioned seed skeleton). But VALIDATE
      // the archive (gzip -t on a staged copy) BEFORE deleting: a truncated or
      // corrupt snapshot must not empty the agent's volume and then fail,
      // leaving no state and nothing to roll back to.
      const child = spawn(this.docker, this.#argv([
        'run', '--rm', '-i', '-v', `${volume}:/vol`, 'alpine',
        'sh', '-c',
        // Archives made before the home-as-volume change hold ~/.openclaw's
        // CONTENTS at their root; newer ones hold the whole home (with
        // .openclaw/ inside it). Detect which, and extract to the matching
        // place, so old backups and .hatchabot files still restore.
        'cat > /tmp/s.tgz && gzip -t /tmp/s.tgz && ' +
          'if tar tzf /tmp/s.tgz | grep -qE "^\\./\\.openclaw/"; then DEST=/vol; else DEST=/vol/.openclaw; fi && ' +
          'find /vol -mindepth 1 -delete && mkdir -p "$DEST" && ' +
          'tar xz --no-same-owner -C "$DEST" -f /tmp/s.tgz && ' +
          'chown -R 1000:1000 /vol && chmod -R a-s /vol',
      ]));
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
      // Same EPIPE race as #runStdin: if the child exits before draining stdin
      // (a corrupt archive fails `gzip -t` early, docker refuses to start), the
      // write emits an unhandled stream error and takes the PROCESS down. The
      // real failure is already reported by the close handler above.
      child.stdin.on('error', () => {});
      child.stdin.end(data);
    });
  }

  async importWorkspace(runtimeRef: string, slug: string, data: Buffer): Promise<void> {
    const { volume } = this.#names(runtimeRef);
    const dir = `/vol/.openclaw/agents/${slug}/agent`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.docker, this.#argv([
        'run', '--rm', '-i', '-v', `${volume}:/vol`, 'alpine',
        'sh', '-c',
        // Same untrusted-input rules as importState: refuse the archive's
        // ownership, then set the one the runtime actually needs.
        `mkdir -p ${dir} && tar xz --no-same-owner -C ${dir} && ` +
          `chown -R 1000:1000 /vol/.openclaw && chmod -R a-s /vol/.openclaw`,
      ]));
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(
              new ProviderError(
                `workspace import failed (${code}): ${stderr.slice(-500)}`,
                "Couldn't copy the agent's files into its new home.",
              ),
            ),
      );
      // Same EPIPE race as #runStdin: if the child exits before draining stdin
      // (a corrupt archive fails `gzip -t` early, docker refuses to start), the
      // write emits an unhandled stream error and takes the PROCESS down. The
      // real failure is already reported by the close handler above.
      child.stdin.on('error', () => {});
      child.stdin.end(data);
    });
  }

  #isolatedReady = false;
  /** The management agents' jail: `--internal` (no route off this host, no
   *  DNS) and no traffic between the containers on it either. */
  async #isolatedNetwork(): Promise<string> {
    // Per installation: two installs on one box must not share a jail (or
    // fight over the ops server's address).
    const name = `${this.prefix}-ops`;
    if (!this.#isolatedReady) {
      if ((await this.#docker(['network', 'inspect', name])).code !== 0) {
        const made = await this.#docker([
          'network', 'create', '--driver', 'bridge', '--internal',
          '-o', 'com.docker.network.bridge.enable_icc=false',
          '--label', 'hatchabot.role=ops', name,
        ]);
        if (made.code !== 0 && (await this.#docker(['network', 'inspect', name])).code !== 0) {
          throw new ProviderError(`docker network create failed: ${made.stderr.slice(-500)}`, 'Could not create the management agent’s network.');
        }
      }
      this.#isolatedReady = true;
    }
    return name;
  }

  async isolatedGateway(): Promise<string> {
    const name = await this.#isolatedNetwork();
    const res = await this.#must(['network', 'inspect', name, '--format', '{{(index .IPAM.Config 0).Gateway}}'], 'Could not read the management agent’s network.');
    const ip = res.stdout.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new ProviderError(`bad gateway ${ip}`, 'Could not read the management agent’s network.');
    return ip;
  }

  async containerIp(runtimeRef: string): Promise<string | undefined> {
    const { container } = this.#names(runtimeRef);
    const res = await this.#docker(['inspect', container, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}']);
    const ip = res.code === 0 ? res.stdout.trim().split(/\s+/)[0] : undefined;
    return ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : undefined;
  }

  #networkReady = false;
  /** `--network <name>`, creating the isolated agent network on first use. */
  async #agentNetworkArgs(): Promise<string[]> {
    const name = (process.env.HATCHABOT_AGENT_NETWORK ?? 'hatchabot-agents').trim();
    if (!name || name === 'bridge' || name === 'default') return [];
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      throw new ProviderError(`bad network name ${name}`, 'HATCHABOT_AGENT_NETWORK is not a valid docker network name.');
    }
    if (!this.#networkReady) {
      if ((await this.#docker(['network', 'inspect', name])).code !== 0) {
        const made = await this.#docker([
          'network', 'create', '--driver', 'bridge',
          '-o', 'com.docker.network.bridge.enable_icc=false',
          '--label', 'hatchabot.role=agents', name,
        ]);
        // Another provision may have created it a moment ago: fine if it now exists.
        if (made.code !== 0 && (await this.#docker(['network', 'inspect', name])).code !== 0) {
          throw new ProviderError(`docker network create failed: ${made.stderr.slice(-500)}`, 'Could not create the agents network.');
        }
      }
      this.#networkReady = true;
    }
    return ['--network', name];
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

  /** Run a docker command, piping `data` to its stdin (for tar-over-stdin on a
   *  remote daemon, where bind mounts of this box's paths aren't possible). */
  async #runStdin(args: string[], data: Buffer): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(this.docker, this.#argv(args));
      // A stalled daemon/runner must fail the call, not pin the agent busy forever.
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new ProviderError('docker stdin op timed out', 'Docker did not respond in time.')); }, IO_TIMEOUT_MS);
      timer.unref();
      child.on('close', () => clearTimeout(timer));
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      // If the child exits without draining stdin, the write races to EPIPE —
      // swallow it (the close handler above is the real result).
      child.stdin.on('error', () => {});
      child.stdin.end(data);
    });
  }

  async #docker(args: string[], timeoutMs?: number): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileP(this.docker, this.#argv(args), {
        maxBuffer: 8 * 1024 * 1024,
        // A hung daemon must fail this call, not freeze the control plane.
        timeout: timeoutMs ?? Number(process.env.HATCHABOT_DOCKER_TIMEOUT_MS ?? 60_000),
        killSignal: 'SIGKILL',
      });
      return { code: 0, stdout, stderr };
    } catch (err: any) {
      // execFile's timeout kill surfaces as killed+signal with empty streams —
      // indistinguishable from "exited 1, said nothing" unless flagged here.
      if (err?.killed && err?.signal) {
        return {
          code: 1,
          timedOut: true,
          stdout: String(err.stdout ?? ''),
          stderr: `docker ${args[0]} timed out`,
        };
      }
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
