import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';
import { regexpEscape } from '../src/domain/regexpEscape.js';
import { baseBuildRepo, baseBuildTag, posixCksum } from '../src/orchestrator/machines/runtimeImages.js';
import { imageRepository } from '../src/domain/imageRepository.js';

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

/** `user` and `inputs`: what the image built runs as, and its build-inputs label, as docker's inspect says them (node, and this OpenClaw's, unless a test says). */
function world(opts: { runs?: string; manifest?: boolean; user?: string; inputs?: string } = {}) {
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
  image) case "$4" in *Config.User*) echo ${JSON.stringify(`${opts.user ?? 'node'}|${opts.inputs ?? `v1;openclaw=${openclaw};engine=baked`}`)} ;; *) exit 1 ;; esac ;;
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

  it('uses a built image only when it runs as node and says what it was built from, as a derived build is checked (HB-1326)', () => {
    // The Dockerfile is Hatchabot's own and sets both; one edited so it did
    // not made an image every agent on it fails with (root), or one no other
    // machine could tell from the standard image of its OpenClaw.
    for (const [o, said] of [
      [{ user: 'root' }, "would run as 'root', not node"],
      [{ user: '' }, "would run as 'root', not node"],
      [{ user: '0:0' }, "would run as '0:0', not node"],
      [{ inputs: '' }, 'carries no build-inputs label'],
      [{ inputs: '<no value>' }, 'carries no build-inputs label'],
    ] as const) {
      const w = world(o);
      const r = w.run({ BUILD_LOCAL: '1', NO_LATEST: '1', OPENCLAW_VERSION: '2026.9.8' });
      expect(r.status, JSON.stringify(o) + r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toContain(`hatchabot-runtime:2026.9.8 ${said}`);
      expect(r.stderr).toContain('Removing it.');
      expect(w.calls()).toContain('docker rmi hatchabot-runtime:2026.9.8');
      expect(r.stdout).not.toContain('Built hatchabot-runtime');
    }
    // Not made the default either.
    const w = world({ user: 'root' });
    expect(w.run({ BUILD_LOCAL: '1', OPENCLAW_VERSION: '2026.9.8' }).status).toBe(1);
    expect(w.calls()).not.toContain('docker tag hatchabot-runtime:2026.9.8 hatchabot-runtime:latest');
    // As this Dockerfile builds it: used.
    const ok = world();
    const r = ok.run({ BUILD_LOCAL: '1', NO_LATEST: '1', OPENCLAW_VERSION: '2026.9.8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Built hatchabot-runtime:2026.9.8 (candidate');
    expect(ok.calls()).not.toContain('docker rmi');
  });

  it('uses a pulled published image only when it runs as node and says what it was built from, as a build here is checked (HB-1511)', () => {
    const pulled = 'ghcr.io/hatchabot/runtime@sha256:fixture';
    for (const [o, said] of [
      [{ user: 'root' }, "would run as 'root', not node"],
      [{ user: '' }, "would run as 'root', not node"],
      [{ inputs: '' }, 'carries no build-inputs label'],
      [{ inputs: '<no value>' }, 'carries no build-inputs label'],
    ] as const) {
      for (const NO_LATEST of ['1', '']) {
        const w = world({ manifest: true, ...o });
        const r = w.run({ NO_LATEST });
        expect(r.status, JSON.stringify(o) + r.stdout + r.stderr).toBe(1);
        expect(w.calls()).toContain(`docker pull ${pulled}`);
        expect(r.stderr).toContain(`✗ The published image ${pulled} ${said}`);
        expect(r.stderr).toContain('Build it from source instead: BUILD_LOCAL=1 ./scripts/build-runtime-image.sh');
        // It takes no tag of this script's, :latest least of all, and nothing is built in its place.
        expect(w.calls()).not.toMatch(/^docker tag /m);
        expect(w.calls()).not.toMatch(/^docker build /m);
        expect(r.stdout).not.toContain('Pulled hatchabot-runtime');
      }
    }
    // As the release's own image is (this Dockerfile sets both): used.
    const w = world({ manifest: true });
    const r = w.run({ NO_LATEST: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.calls()).toContain(`docker tag ${pulled} hatchabot-runtime:${w.openclaw}`);
    expect(r.stdout).toContain(`Pulled hatchabot-runtime:${w.openclaw} (candidate`);
  });

  it('a default build under a HATCHABOT_IMAGE that pins another tag says the fleet stays on it, and how to move it, not "promoted" (HB-1355)', () => {
    const digest = `sha256:${'ab'.repeat(32)}`;
    for (const manifest of [false, true]) {
      const built = manifest ? 'Pulled' : 'Built';
      for (const pin of ['hatchabot-runtime:2026.9.4', `hatchabot-runtime@${digest}`]) {
        const w = world({ manifest });
        const r = w.run({ HATCHABOT_IMAGE: pin, ...(manifest ? {} : { BUILD_LOCAL: '1' }) });
        expect(r.status, pin + r.stdout + r.stderr).toBe(0);
        expect(w.calls()).toContain(`docker tag hatchabot-runtime:${w.openclaw} hatchabot-runtime:latest`);
        expect(r.stdout).toContain(`${built} hatchabot-runtime:${w.openclaw} (moved hatchabot-runtime:latest; the fleet default stays ${pin})\n`
          + `  To make it the fleet default, set HATCHABOT_IMAGE in .env to hatchabot-runtime:${w.openclaw} and restart Hatchabot.\n`);
        expect(r.stdout).not.toContain('promoted');
      }
      // Another repository named for the build: the fleet's default stays, whatever HATCHABOT_IMAGE says.
      const other = world({ manifest });
      const o = other.run({ HATCHABOT_IMAGE_REPO: 'example-runtime', ...(manifest ? {} : { BUILD_LOCAL: '1' }) });
      expect(o.stdout, o.stderr).toContain(`${built} example-runtime:${other.openclaw} (moved example-runtime:latest; the fleet default stays hatchabot-runtime:latest)`);
      // And not how to make it the default: built outside the fleet's repository, it is tagged in to be used (review of HB-1386).
      expect(o.stdout).not.toContain('To make it the fleet default');
      // The fleet's own repository named: said, as before.
      const own = world({ manifest });
      const n = own.run({ HATCHABOT_IMAGE: 'example-runtime:2026.9.4', HATCHABOT_IMAGE_REPO: 'example-runtime', ...(manifest ? {} : { BUILD_LOCAL: '1' }) });
      expect(n.stdout, n.stderr).toContain(`  To make it the fleet default, set HATCHABOT_IMAGE in .env to example-runtime:${own.openclaw} and restart Hatchabot.\n`);
      // The default is :latest (named so, or with no tag, or not at all): promoted, as before.
      for (const image of [undefined, 'hatchabot-runtime:latest', 'hatchabot-runtime', 'registry.example:5000/team/runtime']) {
        const w = world({ manifest });
        const r = w.run({ ...(image ? { HATCHABOT_IMAGE: image } : {}), ...(manifest ? {} : { BUILD_LOCAL: '1' }) });
        expect(r.status, String(image) + r.stdout + r.stderr).toBe(0);
        expect(r.stdout, String(image)).toContain(`${built} ${imageRepository(image ?? 'hatchabot-runtime')}:${w.openclaw} (promoted to :latest)\n`);
        expect(r.stdout).not.toContain('To make it the fleet default');
      }
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
    expect(node26).toMatch(new RegExp(`^${regexpEscape(w.openclaw)}-custom-\\d+$`));
    expect(node24).toMatch(/-custom-\d+$/);
    expect(node26).not.toBe(node24);
    expect(tag({ NODE_IMAGE: 'node:26-slim' })).toBe(node26);
    expect(tag({ BAKED_PLUGINS: 'fixture=fixture-plugin', EXTRA_PACKAGES: 'tcpdump' })).toMatch(new RegExp(`^${regexpEscape(w.openclaw)}-plus-tcpdump-custom-\\d+$`));
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
    expect(a).toMatch(new RegExp(`^${regexpEscape(w.openclaw)}-plus-libicu-dev-libssl-dev-libsqlite3-dev-bui-\\d+$`));
    expect(b).toMatch(/-plus-libicu-dev-libssl-dev-libsqlite3-dev-bui-\d+$/);
    expect(a).not.toBe(b);
    expect(tag(prefix + 'curl')).toBe(a);
    expect(tag('tcpdump')).toBe(`${w.openclaw}-plus-tcpdump`);
    expect(tag('jq curl')).toBe(`${w.openclaw}-plus-jq-curl`);
  });

  it('each package list gets a tag of its own: a name with a - in it no longer meets the same names apart; names without one keep their tag (HB-1346)', () => {
    const w = world();
    const tag = (packages: string, env: Record<string, string> = {}) => /would build hatchabot-runtime:(\S+)/.exec(w.run({ EXTRA_PACKAGES: packages, ...env, DRYRUN: '1' }).stdout)?.[1];
    // As today: names without a - of their own.
    expect(tag('python3 pip')).toBe(`${w.openclaw}-plus-python3-pip`);
    expect(tag('jq curl')).toBe(`${w.openclaw}-plus-jq-curl`);
    expect(tag('tcpdump')).toBe(`${w.openclaw}-plus-tcpdump`);
    // One whose name holds a -: the names, then the list's checksum, as a long list has.
    const one = tag('python3-pip');
    expect(one).toMatch(new RegExp(`^${regexpEscape(w.openclaw)}-plus-python3-pip-\\d+$`));
    expect(one).toBe(`${w.openclaw}-plus-python3-pip-${posixCksum('python3-pip')}`);
    const lists = ['python3 pip', 'python3-pip', 'a b-c', 'a-b c', 'a b c', 'a-b-c', 'curl-lite', 'curl lite'];
    expect(new Set(lists.map((l) => tag(l))).size).toBe(lists.length);
    // The same list, the same tag, and -lite stays apart from the packages' names.
    expect(tag('python3-pip')).toBe(one);
    expect(tag('python3-pip', { OPENCLAW_VERSION: '2026.7.1', EMBED_ENGINE: 'none' })).toBe(`2026.7.1-lite-plus-python3-pip-${posixCksum('python3-pip')}`);
    // A long list's tag is as it was: one checksum, not two.
    const long = 'libicu-dev libssl-dev libsqlite3-dev build-essential curl';
    expect(tag(long)).toBe(`${w.openclaw}-plus-${long.split(' ').join('-').slice(0, 40)}-${posixCksum(long)}`);
    // The app names each as the script does.
    for (const l of [...lists, long]) expect(baseBuildTag({ EXTRA_PACKAGES: l }, w.openclaw), l).toBe(tag(l));
  });

  it('a package name with a + gives a tag docker takes, of its own: the + written p, and the checksum (review of HB-1346)', () => {
    const w = world();
    const tag = (packages: string) => /would build hatchabot-runtime:(\S+)/.exec(w.run({ EXTRA_PACKAGES: packages, DRYRUN: '1' }).stdout)?.[1];
    // Docker's tag grammar, which the app's image name check (IMAGE_REF_RE) holds a tag to.
    const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
    const lists = ['g++', 'libstdc++6', 'g++ x', 'gpp', 'libstdcpp6', 'gpp x', 'c++ c', 'c c++'];
    const tags = lists.map((l) => tag(l));
    for (const [i, t] of tags.entries()) {
      expect(t, lists[i]).toMatch(TAG);
      expect(baseBuildTag({ EXTRA_PACKAGES: lists[i] }, w.openclaw), lists[i]).toBe(t);
    }
    expect(new Set(tags).size).toBe(lists.length);
    expect(tag('g++')).toBe(`${w.openclaw}-plus-gpp-${posixCksum('g++')}`);
    // Names of a-z, 0-9 and . alone keep the tag they had.
    expect(tag('gpp')).toBe(`${w.openclaw}-plus-gpp`);
    expect(tag('libstdcpp6')).toBe(`${w.openclaw}-plus-libstdcpp6`);
  });

  it('a build with packages and no engine of its own gets another tag than the same packages with one (HB-1120)', () => {
    const w = world();
    const tag = (env: Record<string, string>) => /would build hatchabot-runtime:(\S+)/.exec(w.run({ OPENCLAW_VERSION: '2026.7.1', ...env, DRYRUN: '1' }).stdout)?.[1];
    expect(tag({ EXTRA_PACKAGES: 'curl' })).toBe('2026.7.1-plus-curl');
    expect(tag({ EXTRA_PACKAGES: 'curl', EMBED_ENGINE: 'none' })).toBe('2026.7.1-lite-plus-curl');
    expect(tag({ EMBED_ENGINE: 'none' })).toBe('2026.7.1-lite');
    // A long list keeps its checksum; a package whose name ends in -lite meets neither.
    const long = 'libicu-dev libssl-dev libsqlite3-dev build-essential curl';
    expect(tag({ EXTRA_PACKAGES: long, EMBED_ENGINE: 'none' })).toBe(`2026.7.1-lite-${tag({ EXTRA_PACKAGES: long })!.slice('2026.7.1-'.length)}`);
    expect(new Set([tag({ EXTRA_PACKAGES: 'curl-lite' }), tag({ EXTRA_PACKAGES: 'curl', EMBED_ENGINE: 'none' }), tag({ EXTRA_PACKAGES: 'curl' })]).size).toBe(3);
    // A tag given is the tag; an OpenClaw with no engine to bake keeps its packages' tag.
    expect(tag({ EXTRA_PACKAGES: 'curl', EMBED_ENGINE: 'none', IMAGE_TAG: 'trial-1' })).toBe('trial-1');
    expect(tag({ OPENCLAW_VERSION: w.openclaw, EXTRA_PACKAGES: 'curl' })).toBe(`${w.openclaw}-plus-curl`);
  });

  it('builds into the repository of a default pinned by digest, as the app reads it (review of HB-1182)', () => {
    const w = world();
    const digest = `sha256:${'cd'.repeat(32)}`;
    for (const [image, repo] of [
      [`hatchabot-runtime@${digest}`, 'hatchabot-runtime'],
      [`example-runtime:2026.9.8@${digest}`, 'example-runtime'],
      [`registry.example:5000/team/runtime@${digest}`, 'registry.example:5000/team/runtime'],
      ['registry.example:5000/team/runtime', 'registry.example:5000/team/runtime'],
      ['example-runtime:latest', 'example-runtime'],
    ] as const) {
      const r = w.run({ HATCHABOT_IMAGE: image, DRYRUN: '1' });
      expect(r.status, image + r.stderr).toBe(0);
      expect(r.stdout, image).toContain(`would build ${repo}:${w.openclaw} `);
      expect(baseBuildRepo(image, {}), image).toBe(repo);
    }
  });

  it("an install without HATCHABOT_IMAGE_REPO builds into the repository it always did when the app names the fleet's for the script (HB-1352)", () => {
    const w = world();
    const digest = `sha256:${'ef'.repeat(32)}`;
    for (const image of [undefined, 'hatchabot-runtime:latest', 'hatchabot-runtime:2026.9.4', `hatchabot-runtime@${digest}`, 'example-runtime:2026.9.8', `registry.example:5000/team/runtime:2026.9.8@${digest}`, 'registry.example:5000/team/runtime']) {
      const base: Record<string, string> = image ? { HATCHABOT_IMAGE: image } : {};
      const today = w.run({ ...base, DRYRUN: '1' });
      expect(today.status, String(image) + today.stderr).toBe(0);
      // The repository the app reads the fleet's images in (RUNTIME_REPO), from the default as the routes take it.
      const named = w.run({ ...base, HATCHABOT_IMAGE_REPO: imageRepository(image ?? 'hatchabot-runtime:latest'), DRYRUN: '1' });
      expect(named.stdout, String(image)).toBe(today.stdout);
      expect(today.stdout, String(image)).toMatch(new RegExp(`would build ${regexpEscape(imageRepository(image ?? 'hatchabot-runtime:latest'))}:`));
    }
  });

  it('the app names the tag a build writes exactly as the script does, so it can guard what pins it (HB-1074)', () => {
    const w = world();
    const long = 'libicu-dev libssl-dev libsqlite3-dev build-essential curl';
    for (const env of [
      {}, { EXTRA_PACKAGES: 'jq curl' }, { EXTRA_PACKAGES: long }, { EXTRA_PACKAGES: 'g++ x' },
      { OPENCLAW_VERSION: '2026.7.1-2' }, { OPENCLAW_VERSION: '2026.7.1-2', EMBED_ENGINE: 'none' }, { OPENCLAW_VERSION: '2026.7.1-2', EMBED_ENGINE: 'none', EXTRA_PACKAGES: 'jq' },
      { OPENCLAW_VERSION: '2026.7.1-2', EMBED_ENGINE: 'none', EXTRA_PACKAGES: long }, { OPENCLAW_VERSION: '2026.7.1-2', EMBED_ENGINE: 'none', IMAGE_TAG: '2026.7.1-2', EXTRA_PACKAGES: 'jq' },
      { OPENCLAW_VERSION: '2026.9.6', EMBED_ENGINE: 'none' }, { NODE_IMAGE: 'node:26-slim' }, { NODE_IMAGE: 'node:26-slim', EXTRA_PACKAGES: 'tcpdump' },
      { NODE_IMAGE: 'node:26-slim', OPENCLAW_VERSION: '2026.10.1' }, { IMAGE_TAG: 'trial-1', EXTRA_PACKAGES: 'jq' }, { BAKED_PLUGINS: 'fixture=fixture-plugin', PLUGIN_INSTALL: 'npm' },
    ] as Array<Record<string, string>>) {
      const r = w.run({ ...env, DRYRUN: '1' });
      expect(r.status, JSON.stringify(env) + r.stderr).toBe(0);
      const script = /would build hatchabot-runtime:(\S+)/.exec(r.stdout)?.[1];
      expect(baseBuildTag(env, w.openclaw), JSON.stringify(env)).toBe(script);
    }
  });

  it('says which settings it was given by hand, in its dry run and in the image it builds, named or not (HB-0986)', () => {
    const w = world();
    const dry = (env: Record<string, string>) => w.run({ ...env, DRYRUN: '1' }).stdout;
    expect(dry({ NODE_IMAGE: 'node:26-slim' })).toMatch(/, set by hand: node\n$/);
    // A tag given hides nothing of how it was built.
    expect(dry({ NODE_IMAGE: 'node:26-slim', IMAGE_TAG: `${w.openclaw}` })).toMatch(new RegExp(`would build hatchabot-runtime:${regexpEscape(w.openclaw)} .*, set by hand: node\\n$`));
    expect(dry({ BAKED_PLUGINS: 'fixture=fixture-plugin', PLUGIN_INSTALL: 'npm', CHANNEL_PLUGIN_VERSION: '2026.9.9' })).toMatch(/, set by hand: channel-plugins,plugins,plugin-install\n$/);
    expect(dry({ EXTRA_PACKAGES: 'jq' })).not.toContain('set by hand');
    // The build passes them to the image's build-inputs label.
    const r = w.run({ NODE_IMAGE: 'node:26-slim', BUILD_LOCAL: '1', NO_LATEST: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.calls()).toContain('--build-arg SET_BY_HAND=node ');
    const plain = world();
    expect(plain.run({ BUILD_LOCAL: '1', NO_LATEST: '1' }).status).toBe(0);
    expect(plain.calls()).toContain('--build-arg SET_BY_HAND= ');
  });

  it('refuses an extra package ending in "-", which apt reads as "remove", before anything is built (HB-0972)', () => {
    const w = world();
    for (const packages of ['curl-', 'jq git-']) {
      const r = w.run({ EXTRA_PACKAGES: packages, DRYRUN: '1' });
      expect(r.status, packages + r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toContain('EXTRA_PACKAGES must be space-separated apt package names');
    }
    expect(w.calls()).toBe('');
    const ok = w.run({ EXTRA_PACKAGES: 'g++ build-essential x', DRYRUN: '1' });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    // A name with a - or a + of its own: its tag ends in the list's checksum,
    // and a + is written p: docker takes no + in a tag (HB-1346 and its review).
    expect(ok.stdout).toContain(`would build hatchabot-runtime:${w.openclaw}-plus-gpp-build-essential-x-${posixCksum('g++ build-essential x')} `);
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
