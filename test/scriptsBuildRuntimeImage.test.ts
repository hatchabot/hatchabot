import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

// Every test here runs real shell scripts in a sandbox; vitest's 5 s is not
// enough under load on the self-hosted runner (2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

/**
 * scripts/build-runtime-image.sh in a sandbox (audit, 2026-10-29): an install
 * whose path has a space in it, a temp HOME, and shims for docker (logs what
 * it was asked; `openclaw --version` prints what the test says), npm and git.
 * Nothing here reaches Docker or the network.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const shim = (bin: string, name: string, body: string) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });

function world(opts: { runs?: string; manifest?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hb-build-image-')); dirs.push(root);
  const home = join(root, 'home'), bin = join(root, 'bin'), app = join(root, 'my apps', 'hatchabot');
  for (const d of [home, bin, join(app, 'scripts'), join(app, 'docker')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(app, 'scripts', 'build-runtime-image.sh'), readFileSync('scripts/build-runtime-image.sh'), { mode: 0o755 });
  writeFileSync(join(app, 'scripts', 'runtime-pins.mjs'), readFileSync('scripts/runtime-pins.mjs'));
  writeFileSync(join(app, 'docker', 'Dockerfile.runtime'), readFileSync('docker/Dockerfile.runtime'));
  writeFileSync(join(app, 'package.json'), '{\n  "version": "2.170.1"\n}\n');
  // This release's manifest names its image by digest, for the release's own OpenClaw.
  const openclaw = /ARG OPENCLAW_VERSION=(\S+)/.exec(readFileSync('docker/Dockerfile.runtime', 'utf8'))![1]!;
  shim(join(app, 'scripts'), 'release-manifest.sh', opts.manifest ? `echo "ghcr.io/hatchabot/runtime@sha256:fixture ${openclaw}"` : 'exit 10');
  symlinkSync(process.execPath, join(bin, 'node'));
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  shim(bin, 'docker', `echo "docker $*" >> ${JSON.stringify(log)}
case "$1" in
  inspect) echo ${JSON.stringify(openclaw)} ;;
  run) echo ${JSON.stringify(opts.runs ?? `OpenClaw ${openclaw}`)} ;;
  image) exit 1 ;;
  manifest) exit 1 ;;
esac
exit 0`);
  shim(bin, 'npm', 'exit 1');
  shim(bin, 'git', 'exit 128');
  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', [join(app, 'scripts', 'build-runtime-image.sh')], { encoding: 'utf8', timeout: 60_000, env: scriptEnv(home, `${bin}:/usr/bin:/bin`, env) });
  return { openclaw, app, run, calls: () => readFileSync(log, 'utf8') };
}

describe('scripts/build-runtime-image.sh (audit, 2026-10-29)', () => {
  it('accepts a built image only when its OpenClaw version is the one asked for, exactly (HB-0339)', () => {
    for (const runs of ['OpenClaw 2026.9.80', 'OpenClaw 2026.9.8-2', 'OpenClaw 12026.9.8']) {
      const w = world({ runs });
      const r = w.run({ BUILD_LOCAL: '1', NO_LATEST: '1', OPENCLAW_VERSION: '2026.9.8' });
      expect(r.status, runs + r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toContain(`runs '${runs}', not OpenClaw 2026.9.8. Removing it.`);
      expect(w.calls()).toContain('docker rmi hatchabot-runtime:2026.9.8');
    }
    for (const runs of ['OpenClaw 2026.9.8', 'OpenClaw 2026.9.8 (a1b2c3d)', 'openclaw v2026.9.8']) {
      const w = world({ runs });
      const r = w.run({ BUILD_LOCAL: '1', NO_LATEST: '1', OPENCLAW_VERSION: '2026.9.8' });
      expect(r.status, runs + r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('Built hatchabot-runtime:2026.9.8 (candidate');
    }
  });

  it('builds what it is asked to, instead of pulling the published image, when a build setting is given (HB-0340)', () => {
    for (const [name, value] of [['NODE_IMAGE', 'node:26-slim'], ['CHANNEL_PLUGIN_VERSION', '2026.9.9'], ['BAKED_PLUGINS', 'fixture=fixture-plugin'], ['PLUGIN_INSTALL', 'npm'], ['LLAMA_CPP_PROVIDER_VERSION', '2026.9.9']] as const) {
      const w = world({ manifest: true });
      const r = w.run({ [name]: value, NO_LATEST: '1', ...(name === 'LLAMA_CPP_PROVIDER_VERSION' ? { EMBED_ENGINE: 'none' } : {}) });
      expect(r.status, name + r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain(`${name} is set, and the published image is built without it — building locally.`);
      expect(w.calls(), name).not.toContain('docker pull');
      expect(w.calls(), name).toMatch(/^docker build /m);
      if (name !== 'LLAMA_CPP_PROVIDER_VERSION') expect(w.calls(), name).toContain(`--build-arg ${name}=${value}`);
    }
    // Asked for nothing else: the release's image, by its digest.
    const w = world({ manifest: true });
    const r = w.run({ NO_LATEST: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.calls()).toContain('docker pull ghcr.io/hatchabot/runtime@sha256:fixture');
    expect(w.calls()).not.toMatch(/^docker build /m);
    expect(r.stdout).not.toContain('building locally');
  });

  it('a build setting for the OpenClaw the release publishes gets its own tag, never the plain version tag (HB-0340)', () => {
    const w = world({ manifest: true });
    const tag = (env: Record<string, string>) => /would build hatchabot-runtime:(\S+)/.exec(w.run({ ...env, DRYRUN: '1' }).stdout)?.[1];
    const node26 = tag({ NODE_IMAGE: 'node:26-slim' }), node24 = tag({ NODE_IMAGE: 'node:24-slim' });
    expect(node26).toMatch(new RegExp(`^${w.openclaw.replace(/\./g, '\\.')}-custom-\\d+$`));
    expect(node24).toMatch(/-custom-\d+$/);
    expect(node26).not.toBe(node24);
    expect(tag({ NODE_IMAGE: 'node:26-slim' })).toBe(node26);
    expect(tag({ BAKED_PLUGINS: 'fixture=fixture-plugin', EXTRA_PACKAGES: 'tcpdump' })).toMatch(new RegExp(`^${w.openclaw.replace(/\./g, '\\.')}-plus-tcpdump-custom-\\d+$`));
    // Another OpenClaw is made to build with them: its own version tag. A tag given is the tag.
    expect(tag({ NODE_IMAGE: 'node:26-slim', OPENCLAW_VERSION: '2026.10.1' })).toBe('2026.10.1');
    expect(tag({ NODE_IMAGE: 'node:26-slim', IMAGE_TAG: `${w.openclaw}-node26` })).toBe(`${w.openclaw}-node26`);
    expect(tag({})).toBe(w.openclaw);
    // The build itself: the plain version tag is never written.
    const r = w.run({ NODE_IMAGE: 'node:26-slim' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.calls()).toContain(`-t hatchabot-runtime:${node26} `);
    expect(w.calls()).not.toContain(`-t hatchabot-runtime:${w.openclaw} `);
    expect(w.calls()).not.toContain(`docker tag hatchabot-runtime:${w.openclaw} `);
  });

  it('gives two package lists alike for forty characters tags of their own; a short list keeps its plain tag (HB-0341)', () => {
    const w = world();
    const tag = (packages: string) => /would build hatchabot-runtime:(\S+)/.exec(w.run({ EXTRA_PACKAGES: packages, DRYRUN: '1' }).stdout)?.[1];
    const prefix = 'libicu-dev libssl-dev libsqlite3-dev build-essential ';
    const a = tag(prefix + 'curl'), b = tag(prefix + 'wget');
    expect(a).toMatch(new RegExp(`^${w.openclaw.replace(/\./g, '\\.')}-plus-libicu-dev-libssl-dev-libsqlite3-dev-bui-\\d+$`));
    expect(b).toMatch(/-plus-libicu-dev-libssl-dev-libsqlite3-dev-bui-\d+$/);
    expect(a).not.toBe(b);
    expect(tag(prefix + 'curl')).toBe(a);
    expect(tag('tcpdump')).toBe(`${w.openclaw}-plus-tcpdump`);
    expect(tag('jq curl')).toBe(`${w.openclaw}-plus-jq-curl`);
  });

  it('works from an install whose path has a space: the pins tool answers there too (HB-0342)', () => {
    const w = world();
    const r = w.run({ BUILD_LOCAL: '1', NO_LATEST: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.calls()).toContain('--build-arg EMBED_ENGINE=none');
    const pins = spawnSync(process.execPath, [join(w.app, 'scripts', 'runtime-pins.mjs'), 'embed-engine', '2026.7.1'], { encoding: 'utf8' });
    expect(pins.status).toBe(0);
    expect(pins.stdout.trim()).toBe('baked');
  });
});
