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
