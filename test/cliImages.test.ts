/**
 * `hatchabot image` and `upgrade-image`: the names they give an image
 * (HB-1182), and how long `image` follows a build (HB-1229). The real CLI
 * runs in a child process against a fake server: a temp HOME, PATH holding
 * only node, an environment built from scratch — nothing reaches the real
 * machine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/** `stall`: the fake takes the request and never answers it. */
type Handler = (req: IncomingMessage, body: string) => { status?: number; json?: unknown; stall?: true } | undefined;
let handler: Handler = () => undefined;
const seen: Array<{ method: string; url: string; body: string }> = [];
let server: Server;
let base = '';
const home = mkdtempSync(join(tmpdir(), 'hb-cli-images-'));

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body });
      const out = common(req) ?? handler(req, body);
      if (out?.stall) return;
      res.writeHead(out?.status ?? (out ? 200 : 404), { 'content-type': 'application/json' });
      res.end(JSON.stringify(out?.json ?? { error: `no fake for ${req.method} ${req.url}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); rmSync(home, { recursive: true, force: true }); });

const AGENT = { id: 'agent-0001-test', name: 'Test Agent', slug: 'test-agent', hostId: 'h1', state: 'RUNNING', runtimeRef: 'fixture-runtime-1' };
function common(req: IncomingMessage): ReturnType<Handler> {
  if (req.url === '/v1/config') return { json: { authMode: 'accounts' } };
  if (req.method === 'GET' && (req.url === '/v1/agents' || req.url === '/v1/agents?all=1')) return { json: [AGENT] };
  return undefined;
}

/** The real CLI, sandboxed, killed after `ms`. */
function cliWithin(ms: number, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: join(__dirname, '..'),
      env: { HOME: home, PATH: dirname(process.execPath), HATCHABOT_URL: base, HATCHABOT_TOKEN: 'made-up-cli-credential', NO_COLOR: '1' },
      timeout: ms,
    }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout), err: String(stderr) }));
  });
}

describe('a bare image name is the fleet\'s own (HB-1182)', () => {
  /** A fleet on another runtime repository: its default, a derived image named there, and one from before it moved. */
  const fleet = (answer: unknown): Handler => (req) => {
    if (req.method === 'GET' && req.url === '/v1/images') return { json: answer };
    if (req.method === 'PATCH' && req.url === `/v1/agents/${AGENT.id}`) return { json: { ok: true } };
    if (req.method === 'POST' && req.url === `/v1/agents/${AGENT.id}/rebuild`) return { status: 202, json: { rebuilding: true } };
    if (req.method === 'POST' && req.url === '/v1/runtime/images/promote') return { json: { promoted: 'x', now: 'y', followers: [] } };
    return undefined;
  };
  const sent = (method: string, url: string) => seen.filter((s) => s.method === method && s.url === url).map((s) => JSON.parse(s.body));

  it('pin, try and promote name a version and a derived image in the fleet\'s repository, and a derived image by its record', async () => {
    handler = fleet({
      base: 'example-runtime:latest',
      images: [
        { name: 'media', tag: 'example-runtime:derived-media', status: 'READY' },
        { name: 'older', tag: 'hatchabot-runtime:derived-older', status: 'READY' },
      ],
    });
    seen.length = 0;
    for (const [args, want] of [
      [['image', 'pin', 'Test Agent', '2026.9.8'], 'example-runtime:2026.9.8'],
      [['image', 'pin', 'Test Agent', 'media'], 'example-runtime:derived-media'],
      [['image', 'pin', 'Test Agent', 'older'], 'hatchabot-runtime:derived-older'],
      [['image', 'pin', 'Test Agent', 'not-made-yet'], 'example-runtime:derived-not-made-yet'],
      [['image', 'try', 'Test Agent', '2026.7.1-2-plus-jq'], 'example-runtime:2026.7.1-2-plus-jq'],
      // A name with its repository is taken as it is.
      [['image', 'pin', 'Test Agent', 'hatchabot-runtime:2026.9.8'], 'hatchabot-runtime:2026.9.8'],
    ] as const) {
      const r = await cliWithin(30_000, ...args);
      expect(r.code, r.err).toBe(0);
      expect(sent('PATCH', `/v1/agents/${AGENT.id}`).pop(), args.join(' ')).toEqual({ image: want });
      expect(r.out, args.join(' ')).toContain(want);
    }
    const p = await cliWithin(30_000, 'image', 'promote', '2026.9.8');
    expect(p.code, p.err).toBe(0);
    expect(sent('POST', '/v1/runtime/images/promote')).toEqual([{ tag: 'example-runtime:2026.9.8' }]);
  }, 120_000);

  it('a finished build names the image as the server has it', async () => {
    const images = fleet({ base: 'example-runtime:latest', images: [{ name: 'media', tag: 'example-runtime:derived-media', status: 'READY' }] });
    handler = (req, body) => {
      if (req.method === 'POST' && req.url === '/v1/images/media/rebuild') return { status: 202, json: { building: true } };
      if (req.method === 'GET' && req.url === '/v1/images/media/log') return { json: { status: 'READY', log: 'step 1/3\n' } };
      return images(req, body);
    };
    const r = await cliWithin(30_000, 'image', 'rebuild', 'media');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('✓ Built example-runtime:derived-media. Pin an agent:  hatchabot image pin <agent> media');
  }, 60_000);

  it('a default pinned by digest names its repository, without the digest (review of HB-1182)', async () => {
    const digest = `sha256:${'ef'.repeat(32)}`;
    for (const [base, want] of [[`hatchabot-runtime@${digest}`, 'hatchabot-runtime'], [`example-runtime:2026.9.8@${digest}`, 'example-runtime']] as const) {
      handler = fleet({ base, images: [] });
      seen.length = 0;
      for (const ref of ['2026.9.8', 'media']) {
        const r = await cliWithin(30_000, 'image', 'pin', 'Test Agent', ref);
        expect(r.code, r.err).toBe(0);
        expect(sent('PATCH', `/v1/agents/${AGENT.id}`).pop(), base).toEqual({ image: ref === 'media' ? `${want}:derived-media` : `${want}:2026.9.8` });
      }
    }
  }, 120_000);

  it('a derived image with no --base on a fleet pinned by digest says which tag it was built on (HB-1353)', async () => {
    const lines = join(home, 'tools.Dockerfile');
    writeFileSync(lines, 'RUN true\n');
    const said = "The fleet's image is pinned by digest: built on hatchabot-runtime:2026.9.8, its tag on this machine.";
    handler = (req) => {
      if (req.method === 'POST' && req.url === '/v1/images') return { status: 202, json: { building: true, tag: 'hatchabot-runtime:derived-tools', base: 'hatchabot-runtime:2026.9.8', said } };
      if (req.method === 'GET' && req.url === '/v1/images/tools/log') return { json: { status: 'READY', log: 'step 1/3\n' } };
      if (req.method === 'GET' && req.url === '/v1/images') return { json: { base: `hatchabot-runtime@sha256:${'ef'.repeat(32)}`, images: [{ name: 'tools', tag: 'hatchabot-runtime:derived-tools', status: 'READY' }] } };
      return undefined;
    };
    const r = await cliWithin(30_000, 'image', 'derive', 'tools', '--from', lines);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`${said}\nBuilding hatchabot-runtime:derived-tools…`);
  }, 60_000);

  it('a server that names no default is read as the default repository', async () => {
    handler = fleet({ images: [] });
    seen.length = 0;
    const r = await cliWithin(30_000, 'image', 'pin', 'Test Agent', '2026.9.8');
    expect(r.code, r.err).toBe(0);
    expect(sent('PATCH', `/v1/agents/${AGENT.id}`)).toEqual([{ image: 'hatchabot-runtime:2026.9.8' }]);
  }, 60_000);
});

describe('following an image build ends with --timeout (HB-1229)', () => {
  // 0.05 min is 3 s: each command must be done well inside the 30 s it is given.
  const started: Handler = (req) => {
    if (req.method === 'GET' && req.url === '/v1/images') return { json: { base: 'hatchabot-runtime:latest', images: [{ name: 'media', tag: 'hatchabot-runtime:derived-media', status: 'BUILDING' }] } };
    if (req.method === 'POST' && req.url === '/v1/images/media/rebuild') return { status: 202, json: { building: true } };
    return undefined;
  };
  it('a look the server never answers is cut off, and it says the build goes on', async () => {
    handler = (req, body) => (req.url === '/v1/images/media/log' ? { stall: true } : started(req, body));
    const r = await cliWithin(30_000, 'image', 'rebuild', 'media', '--timeout', '0.05');
    expect(r.code).toBe(1);
    expect(r.err).toContain('still building after 0.05 min — it goes on. Its output so far: hatchabot image log media · done or not: hatchabot image list');
  }, 60_000);
  it('a build that never ends is followed until the time is up', async () => {
    let looks = 0;
    handler = (req, body) => (req.url === '/v1/images/media/log' ? { json: { status: 'BUILDING', log: `step ${++looks}\n` } } : started(req, body));
    const r = await cliWithin(30_000, 'image', 'rebuild', 'media', '--timeout', '0.05');
    expect(r.code).toBe(1);
    expect(r.out).toContain('step 1\n');
    expect(r.err).toContain('still building after 0.05 min — it goes on. Its output so far: hatchabot image log media · done or not: hatchabot image list');
  }, 60_000);
  it('a request starting a build, or the look for its tag, that the server never answers is cut off too (review of HB-1229)', async () => {
    const lines = join(home, 'media.Dockerfile');
    writeFileSync(lines, 'RUN true\n');
    const unanswered = 'no answer from the server in 0.05 min — the build may have started. See: hatchabot image list · its output so far: hatchabot image log media';
    for (const [args, stalls, says] of [
      [['image', 'derive', 'media', '--from', lines], 'POST /v1/images', unanswered],
      [['image', 'rebuild', 'media'], 'POST /v1/images/media/rebuild', unanswered],
      [['image', 'rebuild', 'media'], 'GET /v1/images', 'still building after 0.05 min — it goes on.'],
    ] as const) {
      handler = (req, body) => (`${req.method} ${req.url}` === stalls ? { stall: true } : started(req, body));
      const r = await cliWithin(30_000, ...args, '--timeout', '0.05');
      expect(r.code, `${stalls}: ${r.err}`).toBe(1);
      expect(r.err, stalls).toContain(says);
    }
  }, 120_000);
  it('the usage lines name --timeout', async () => {
    for (const sub of ['derive', 'rebuild']) {
      const r = await cliWithin(30_000, 'image', sub);
      expect(r.err).toMatch(new RegExp(`usage: hatchabot image ${sub} <name> .*\\[--timeout <min>\\]`));
    }
  }, 60_000);
});

describe('upgrade-image builds into the fleet\'s repository and names what it builds (review of HB-1182)', () => {
  // A copy of the CLI whose checkout's build script is a shim that says what
  // it was given: the CLI runs the script of its own checkout, and the real
  // one must never run here.
  function install(dotenv: string) {
    const app = mkdtempSync(join(tmpdir(), 'hb-cli-upgrade-image-'));
    cpSync(join(__dirname, '..', 'src'), join(app, 'src'), { recursive: true });
    for (const f of ['package.json', 'tsconfig.json']) cpSync(join(__dirname, '..', f), join(app, f));
    symlinkSync(join(__dirname, '..', 'node_modules'), join(app, 'node_modules'));
    mkdirSync(join(app, 'docker')); cpSync(join(__dirname, '..', 'docker', 'Dockerfile.runtime'), join(app, 'docker', 'Dockerfile.runtime'));
    mkdirSync(join(app, 'scripts'));
    const seenBy = join(app, 'script.env');
    writeFileSync(join(app, 'scripts', 'build-runtime-image.sh'), `#!/usr/bin/env bash
printf 'HATCHABOT_IMAGE=%s\\nNO_LATEST=%s\\nEMBED_ENGINE=%s\\nOPENCLAW_VERSION=%s\\n' "\${HATCHABOT_IMAGE-}" "\${NO_LATEST-}" "\${EMBED_ENGINE-}" "\${OPENCLAW_VERSION-}" > ${JSON.stringify(seenBy)}
`, { mode: 0o755 });
    writeFileSync(join(app, '.env'), dotenv);
    // The machine's commands, shims that say what they were asked (HB-1450: the CLI tags :latest itself):
    // the real docker must never be reached. A docker that fails a tag: the file `docker.fails` is there.
    const bin = join(app, 'bin'), calls = join(app, 'calls.log');
    mkdirSync(bin);
    for (const c of ['docker', 'podman', 'systemctl', 'launchctl', 'ssh', 'openclaw']) {
      writeFileSync(join(bin, c), `#!/usr/bin/env bash
echo "${c} $* on \${DOCKER_HOST:-default}" >> ${JSON.stringify(calls)}
[ "${c}" = docker ] && [ -e ${JSON.stringify(join(app, 'docker.fails'))} ] && { echo "made-up: no such image" >&2; exit 1; }
exit 0
`, { mode: 0o755 });
    }
    return {
      app, seen: () => readFileSync(seenBy, 'utf8'), built: () => existsSync(seenBy),
      calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []),
      done: () => rmSync(app, { recursive: true, force: true }),
    };
  }
  const runWith = (shell: Record<string, string>, url: string, app: string, ...args: string[]) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', join(app, 'src', 'cli.ts'), ...args], {
      cwd: app,
      // The shell names another image: the .env's is the fleet's.
      env: scriptEnv(home, `${join(app, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, { HATCHABOT_URL: url, HATCHABOT_TOKEN: 'made-up-cli-credential', NO_COLOR: '1', HATCHABOT_IMAGE: 'shell-runtime:latest', ...shell }),
      timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout), err: String(stderr) }));
  });
  /** The route's answer to `url`: `refused`, and, asked once built (built=1), that it was (HB-1450 review). */
  const answered = (url: string, refused: string | null = null) => ({ refused, ...(new URL(url, 'http://example.invalid').searchParams.get('built') === '1' ? { built: true } : {}) });
  /** The route's check, answering nothing refused (or `refused`), each ask written down with whether the build had run. */
  const checks = (w: { built: () => boolean }, refused: (url: string, built: boolean) => string | null = () => null) => {
    const asked: Array<{ url: string; built: boolean }> = [];
    const h: Handler = (req) => {
      if (req.method !== 'GET' || !req.url?.startsWith('/v1/runtime/build/check?')) return undefined;
      asked.push({ url: req.url, built: w.built() });
      return { json: answered(req.url, refused(req.url, w.built())) };
    };
    return { h, asked };
  };
  const runAt = (url: string, app: string, ...args: string[]) => runWith({}, url, app, ...args);
  const run = (app: string, ...args: string[]) => runAt(base, app, ...args);

  it('a candidate without its engine, before 2026.8: the .env\'s repository and the -lite tag', async () => {
    handler = (req) => (req.url?.startsWith('/v1/runtime/build/check?') ? { json: answered(req.url) } : undefined);
    const w = install('HATCHABOT_IMAGE=example-runtime:latest\n');
    try {
      const r = await run(w.app, 'upgrade-image', '--version', '2026.7.1', '--candidate', '--no-engine');
      expect(r.code, r.err).toBe(0);
      expect(w.seen()).toBe('HATCHABOT_IMAGE=example-runtime:latest\nNO_LATEST=1\nEMBED_ENGINE=none\nOPENCLAW_VERSION=2026.7.1\n');
      expect(r.out).toContain('Building example-runtime:2026.7.1-lite for OpenClaw 2026.7.1 (candidate — :latest untouched)…');
      expect(r.out).toContain('Candidate built as example-runtime:2026.7.1-lite (:latest untouched).');
      expect(r.out).toContain('  docker tag example-runtime:2026.7.1-lite example-runtime:latest');
      expect(r.out).not.toContain('hatchabot-runtime');
    } finally { w.done(); }
  }, 90_000);

  it("a build the route's own check refuses is refused, in its words, and the script never runs (HB-1428)", async () => {
    const asked: string[] = [];
    const pinned = 'example-runtime:2026.9.8 is pinned by Kitchen, class Builders; rebuilding it would change what they run. Unpin them first, or build another version.';
    handler = (req) => {
      if (req.method !== 'GET' || !req.url?.startsWith('/v1/runtime/build/check?')) return undefined;
      asked.push(req.url);
      return { json: answered(req.url, req.url.includes('2026.9.8') ? pinned : null) };
    };
    const w = install('HATCHABOT_IMAGE=example-runtime:latest\n');
    try {
      const r = await run(w.app, 'upgrade-image', '--version', '2026.9.8', '--candidate');
      expect(r.code).toBe(1);
      expect(r.err).toContain(pinned);
      expect(() => w.seen()).toThrow(); // the build script was never run
      expect(asked).toEqual(['/v1/runtime/build/check?tag=example-runtime%3A2026.9.8&version=2026.9.8&candidate=1']);
      // Another version's tag is refused by nothing: it builds. Not a candidate: asked as one that moves :latest.
      const other = await run(w.app, 'upgrade-image', '--version', '2026.9.6');
      expect(other.code, other.err).toBe(0);
      expect(w.seen()).toContain('OPENCLAW_VERSION=2026.9.6\n');
      expect(other.out).not.toContain('Could not ask');
      expect(asked.slice(-2)).toEqual(['/v1/runtime/build/check?tag=example-runtime%3A2026.9.6&version=2026.9.6', '/v1/runtime/build/check?tag=example-runtime%3A2026.9.6&version=2026.9.6&built=1']);
    } finally { w.done(); }
  }, 90_000);

  it('signed out, or not the machine\'s owner, it is refused and says to log in; the script never runs (HB-1428 review)', async () => {
    const w = install('HATCHABOT_IMAGE=example-runtime:latest\n');
    try {
      handler = (req) => (req.url?.startsWith('/v1/runtime/build/check') ? { status: 401, json: { error: 'auth required' } } : undefined);
      const out = await run(w.app, 'upgrade-image', '--version', '2026.9.8', '--candidate');
      expect(out.code).toBe(1);
      expect(out.err).toContain("Hatchabot did not take this CLI's sign-in, so it could not say whether example-runtime:2026.9.8 may be built. Log in again (hatchabot login), then build.");
      handler = (req) => (req.url?.startsWith('/v1/runtime/build/check') ? { status: 403, json: { error: "Only this machine's owner can do that." } } : undefined);
      const member = await run(w.app, 'upgrade-image', '--version', '2026.9.8', '--candidate');
      expect(member.code).toBe(1);
      expect(member.err).toContain("Only this machine's owner can do that. Building a runtime image is the machine owner's: log in as them (hatchabot login), then build.");
      expect(() => w.seen()).toThrow();
    } finally { handler = () => undefined; w.done(); }
  }, 90_000);

  it('a service that cannot be asked (not running) is said before the build and again after it, and the build goes ahead (HB-1428)', async () => {
    // Nothing can listen there: port 0 is no port a server can have, and the CLI's plain fetch connects
    // to it as written and is refused. A port opened and closed again was anyone's for the seconds the
    // CLI takes to start: another test's listen(0) could be handed it and answer (HB-1495).
    const closed = 'http://127.0.0.1:0';
    const w = install('HATCHABOT_IMAGE=example-runtime:latest\n');
    try {
      const r = await runAt(closed, w.app, 'upgrade-image', '--version', '2026.9.8', '--candidate');
      expect(r.code, r.err).toBe(0);
      const warning = /^⚠ Could not ask Hatchabot whether example-runtime:2026\.9\.8 may be built \(.+\): if agents are pinned to it, or would run it as the new default, this build changes what they run\.$/;
      const lines = r.out.trimEnd().split('\n');
      expect(lines.filter((l) => warning.test(l))).toHaveLength(2);
      expect(lines.at(-1)).toMatch(warning);
      expect(w.seen()).toContain('OPENCLAW_VERSION=2026.9.8\n');
      // A default build, not asked before or after: it moves :latest, said twice still (HB-1450).
      const d = await runAt(closed, w.app, 'upgrade-image', '--version', '2026.9.8');
      expect(d.code, d.err).toBe(0);
      expect(d.out.trimEnd().split('\n').filter((l) => warning.test(l))).toHaveLength(2);
      expect(d.out.trimEnd().split('\n').at(-1)).toMatch(warning);
      expect(w.calls()).toEqual(['docker tag example-runtime:2026.9.8 example-runtime:latest on default']);
    } finally { w.done(); }
  }, 120_000);

  it('a service older than this CLI (a 404), or one whose check fails (a 5xx), refuses the build, and the script never runs (HB-1450)', async () => {
    const w = install('HATCHABOT_IMAGE=example-runtime:latest\n');
    try {
      handler = (req) => (req.url?.startsWith('/v1/runtime/build/check') ? { status: 404, json: { error: 'Route GET:/v1/runtime/build/check not found' } } : undefined);
      for (const args of [['--candidate'], []]) {
        const old = await run(w.app, 'upgrade-image', '--version', '2026.9.8', ...args);
        expect(old.code, args.join(' ')).toBe(1);
        expect(old.err).toContain("error: Hatchabot's service is older than this CLI: restart it onto this release (./scripts/restart.sh in its install folder), then build.");
        expect(old.out).not.toContain('Could not ask');
      }
      for (const status of [500, 503]) {
        handler = (req) => (req.url?.startsWith('/v1/runtime/build/check') ? { status, json: { error: 'made-up failure' } } : undefined);
        const r = await run(w.app, 'upgrade-image', '--version', '2026.9.8');
        expect(r.code, String(status)).toBe(1);
        expect(r.err).toContain('error: Hatchabot could not say whether example-runtime:2026.9.8 may be built (made-up failure). Try again once it answers.');
      }
      // A question it refuses (a tag it does not take) is said in its own words (HB-1450 review).
      handler = (req) => (req.url?.startsWith('/v1/runtime/build/check') ? { status: 400, json: { error: 'That image tag is not valid.' } } : undefined);
      const bad = await run(w.app, 'upgrade-image', '--version', '2026.9.8');
      expect(bad.code).toBe(1);
      expect(bad.err).toContain('error: That image tag is not valid.');
      expect(bad.err).not.toContain('Try again once it answers');
      expect(w.built()).toBe(false);
      expect(w.calls()).toEqual([]);
    } finally { handler = () => undefined; w.done(); }
  }, 120_000);

  it('a default build is built as a candidate and asked again once built; only then does it move :latest, on the service\'s Docker, and say so; refused then, it stays a candidate and says why (HB-1450)', async () => {
    const DOTENV = 'HATCHABOT_IMAGE=example-runtime:latest\nDOCKER_HOST=tcp://192.0.2.20:2376\n';
    const ASKED = '/v1/runtime/build/check?tag=example-runtime%3A2026.9.8&version=2026.9.8';
    const STAYS = 'It stays a candidate: example-runtime:2026.9.8, with example-runtime:latest untouched.';
    const ok = install(DOTENV);
    try {
      const c = checks(ok);
      handler = c.h;
      const r = await run(ok.app, 'upgrade-image', '--version', '2026.9.8');
      expect(r.code, r.err).toBe(0);
      expect(ok.seen()).toContain('NO_LATEST=1\n');
      // Once built it asks what the app's build asks as it ends (built=1), not the pins again (HB-1450 review).
      expect(c.asked).toEqual([{ url: ASKED, built: false }, { url: `${ASKED}&built=1`, built: true }]);
      expect(ok.calls()).toEqual(['docker tag example-runtime:2026.9.8 example-runtime:latest on tcp://192.0.2.20:2376']);
      expect(r.out).toContain('Then Hatchabot made it the fleet default: example-runtime:latest names example-runtime:2026.9.8 now.');
    } finally { handler = () => undefined; ok.done(); }
    // A candidate is asked once, and moves nothing.
    const cand = install(DOTENV);
    try {
      const c = checks(cand);
      handler = c.h;
      const r = await run(cand.app, 'upgrade-image', '--version', '2026.9.8', '--candidate');
      expect(r.code, r.err).toBe(0);
      expect(c.asked).toEqual([{ url: `${ASKED}&candidate=1`, built: false }]);
      expect(cand.calls()).toEqual([]);
    } finally { handler = () => undefined; cand.done(); }
    // Refused as it ends (an engine-free image with the shared service off, the service says): the candidate kept, :latest not moved.
    const stuck = 'it has no memory search engine of its own and the shared service is off, so no agent could be built on it. It is kept as example-runtime:2026.9.8: turn the service on (Settings → Hosts), then promote it.';
    const late = install(DOTENV);
    try {
      handler = checks(late, (url, built) => (built && url.endsWith('&built=1') ? stuck : null)).h;
      const r = await run(late.app, 'upgrade-image', '--version', '2026.9.8');
      expect(r.code).toBe(1);
      expect(late.built()).toBe(true);
      expect(r.err).toContain(`error: Then Hatchabot did not make it the fleet default: ${stuck}\n${STAYS}`);
      expect(late.calls()).toEqual([]);
      expect(r.out).not.toContain('Done —');
    } finally { handler = () => undefined; late.done(); }
    // A check that fails once it is built (the service restarted onto an older release meanwhile): the same.
    const older = install(DOTENV);
    try {
      handler = (req) => (req.url?.startsWith('/v1/runtime/build/check') ? (older.built() ? { status: 404, json: { error: 'not found' } } : { json: { refused: null } }) : undefined);
      const r = await run(older.app, 'upgrade-image', '--version', '2026.9.8');
      expect(r.code).toBe(1);
      expect(r.err).toContain(`error: Hatchabot's service is older than this CLI: restart it onto this release (./scripts/restart.sh in its install folder), then build.\nThen Hatchabot did not make it the fleet default.\n${STAYS}`);
      expect(older.calls()).toEqual([]);
    } finally { handler = () => undefined; older.done(); }
    // A service from before built=1 (2.191, 2.192) answers its check before a build, with no word that it was built:
    // taken as older than the CLI, the candidate kept (HB-1450 review).
    const unmarked = install(DOTENV);
    try {
      handler = (req) => (req.url?.startsWith('/v1/runtime/build/check') ? { json: { refused: null } } : undefined);
      const r = await run(unmarked.app, 'upgrade-image', '--version', '2026.9.8');
      expect(r.code).toBe(1);
      expect(unmarked.built()).toBe(true);
      expect(r.err).toContain(`error: Hatchabot's service is older than this CLI: restart it onto this release (./scripts/restart.sh in its install folder), then build.\nThen Hatchabot did not make it the fleet default.\n${STAYS}`);
      expect(unmarked.calls()).toEqual([]);
    } finally { handler = () => undefined; unmarked.done(); }
    // Docker will not tag it: said, the candidate kept.
    const untagged = install(DOTENV);
    try {
      handler = checks(untagged).h;
      writeFileSync(join(untagged.app, 'docker.fails'), '');
      const r = await run(untagged.app, 'upgrade-image', '--version', '2026.9.8');
      expect(r.code).toBe(1);
      expect(r.err).toContain(`error: Then Hatchabot did not make it the fleet default: docker could not tag it as example-runtime:latest (made-up: no such image).\n${STAYS}`);
    } finally { handler = () => undefined; untagged.done(); }
  }, 240_000);

  it('the build goes to the service\'s Docker: this shell\'s context, TLS, host and config folder are dropped, and the .env\'s used (HB-1354)', async () => {
    handler = (req) => (req.url?.startsWith('/v1/runtime/build/check?') ? { json: answered(req.url) } : undefined);
    const shell = { DOCKER_CONTEXT: 'made-up-remote', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/made-up/shell-certs', DOCKER_HOST: 'tcp://192.0.2.9:2376', DOCKER_CONFIG: '/made-up/docker-config' };
    for (const [dotenv, want] of [
      ['HATCHABOT_IMAGE=example-runtime:latest\n', 'host=default context=none tls=none certs=none config=none'],
      ['HATCHABOT_IMAGE=example-runtime:latest\nDOCKER_HOST=tcp://192.0.2.20:2376\nDOCKER_TLS_VERIFY=1\nDOCKER_CONFIG=/made-up/service-config\n', 'host=tcp://192.0.2.20:2376 context=none tls=1 certs=none config=/made-up/service-config'],
    ] as const) {
      const w = install(dotenv);
      const said = join(w.app, 'docker.env');
      writeFileSync(join(w.app, 'scripts', 'build-runtime-image.sh'), `#!/usr/bin/env bash
echo "host=\${DOCKER_HOST:-default} context=\${DOCKER_CONTEXT:-none} tls=\${DOCKER_TLS_VERIFY:-none} certs=\${DOCKER_CERT_PATH:-none} config=\${DOCKER_CONFIG:-none}" > ${JSON.stringify(said)}
`, { mode: 0o755 });
      try {
        const r = await runWith(shell, base, w.app, 'upgrade-image', '--version', '2026.9.8', '--candidate');
        expect(r.code, r.err).toBe(0);
        expect(readFileSync(said, 'utf8').trim(), dotenv).toBe(want);
      } finally { w.done(); }
    }
  }, 90_000);

  it('a build this shell\'s HATCHABOT_IMAGE_REPO sends outside the fleet\'s repository says so, before and after, and how to tag it in (HB-1386)', async () => {
    handler = (req) => (req.url?.startsWith('/v1/runtime/build/check?') ? { json: answered(req.url) } : undefined);
    const w = install('HATCHABOT_IMAGE=example-runtime:latest\n');
    try {
      const said = '⚠ made-up-elsewhere:2026.9.8 is built in made-up-elsewhere (HATCHABOT_IMAGE_REPO, set in this shell), not in the fleet\'s repository example-runtime: the app and its image list do not look there. To use it, build again without HATCHABOT_IMAGE_REPO, or tag it in:  docker tag made-up-elsewhere:2026.9.8 example-runtime:2026.9.8';
      const r = await runWith({ HATCHABOT_IMAGE_REPO: 'made-up-elsewhere' }, base, w.app, 'upgrade-image', '--version', '2026.9.8', '--candidate');
      expect(r.code, r.err).toBe(0);
      expect(r.out.split('\n').filter((l) => l === said)).toHaveLength(2);
      expect(r.out.trimEnd().split('\n').at(-1)).toBe(said);
      // The warning's ways alone: no other line says how to use it (review of HB-1386).
      expect(r.out).not.toContain('set HATCHABOT_IMAGE in .env');
      const done = await runWith({ HATCHABOT_IMAGE_REPO: 'made-up-elsewhere' }, base, w.app, 'upgrade-image', '--version', '2026.9.8');
      expect(done.code, done.err).toBe(0);
      expect(done.out).toContain('Done — made-up-elsewhere:2026.9.8 is built, and made-up-elsewhere:latest moved with it. The fleet default stays example-runtime:latest.');
      expect(done.out).not.toContain('set HATCHABOT_IMAGE in .env');
      expect(done.out).not.toContain('hatchabot rebuild');
      expect(done.out.trimEnd().split('\n').at(-1)).toBe(said);
      // Naming the fleet's own repository: nothing said.
      const same = await runWith({ HATCHABOT_IMAGE_REPO: 'example-runtime' }, base, w.app, 'upgrade-image', '--version', '2026.9.8', '--candidate');
      expect(same.code, same.err).toBe(0);
      expect(same.out).not.toContain('HATCHABOT_IMAGE_REPO');
    } finally { handler = () => undefined; w.done(); }
  }, 90_000);

  it('a default build, the .env naming no image: the shell\'s, as upgrade.sh leaves it, and where its :latest moves', async () => {
    const w = install('PORT=8080\n');
    handler = (req) => (req.url?.startsWith('/v1/runtime/build/check?') ? { json: answered(req.url) } : undefined);
    try {
      const r = await run(w.app, 'upgrade-image', '--version', '2026.9.8');
      expect(r.code, r.err).toBe(0);
      expect(w.seen()).toContain('HATCHABOT_IMAGE=shell-runtime:latest\nNO_LATEST=1\n'); // .env names none: the shell's stays, as upgrade.sh leaves it
      expect(r.out).toContain('Building shell-runtime:2026.9.8 for OpenClaw 2026.9.8 (promotes to shell-runtime:latest)…');
      // Built as a candidate, then made the default here (HB-1450).
      expect(w.calls()).toEqual(['docker tag shell-runtime:2026.9.8 shell-runtime:latest on default']);
      expect(r.out).toContain('Then Hatchabot made it the fleet default: shell-runtime:latest names shell-runtime:2026.9.8 now.\n\nDone — shell-runtime:latest is now OpenClaw 2026.9.8.');
      expect(r.out).not.toContain('To make'); // :latest is the default: it has moved
    } finally { handler = () => undefined; w.done(); }
  }, 90_000);

  it('a default build with the .env pinning a version tag says it moves :latest, and that only agents pinned to it follow (HB-1256)', async () => {
    handler = (req) => (req.url?.startsWith('/v1/runtime/build/check?') ? { json: answered(req.url) } : undefined);
    const w = install('HATCHABOT_IMAGE=example-runtime:2026.9.4\n');
    try {
      const r = await run(w.app, 'upgrade-image', '--version', '2026.9.8');
      expect(r.code, r.err).toBe(0);
      expect(w.seen()).toContain('HATCHABOT_IMAGE=example-runtime:2026.9.4\nNO_LATEST=1\n');
      expect(r.out).toContain('Building example-runtime:2026.9.8 for OpenClaw 2026.9.8 (moves example-runtime:latest; the fleet default stays example-runtime:2026.9.4)…');
      expect(w.calls()).toEqual(['docker tag example-runtime:2026.9.8 example-runtime:latest on default']);
      expect(r.out).toContain('Then Hatchabot moved example-runtime:latest to it: example-runtime:latest names example-runtime:2026.9.8 now. The fleet default stays example-runtime:2026.9.4, as HATCHABOT_IMAGE pins it.');
      expect(r.out).toContain('Done — example-runtime:latest is now OpenClaw 2026.9.8. The fleet default stays example-runtime:2026.9.4:\nonly agents pinned to example-runtime:latest show "update available". Rebuild one to adopt it, memory kept:  hatchabot rebuild "<agent>"');
      // How the fleet moves onto it, said once: here, the script building a candidate (HB-1355, HB-1450).
      expect(r.out.split('To make it the fleet default, set HATCHABOT_IMAGE in .env to example-runtime:2026.9.8 and restart Hatchabot.')).toHaveLength(2);
      expect(r.out).not.toContain('promotes to');
      expect(r.out).not.toContain('Each agent shows');
    } finally { handler = () => undefined; w.done(); }
  }, 90_000);

  // Review (L3): under the pin, "then promote: docker tag X example-runtime:latest" moved :latest, never the default.
  it('a candidate build with the .env pinning a version tag says the setting makes it the default, not a retag of :latest (HB-1256)', async () => {
    handler = (req) => (req.url?.startsWith('/v1/runtime/build/check?') ? { json: answered(req.url) } : undefined);
    const w = install('HATCHABOT_IMAGE=example-runtime:2026.9.4\n');
    try {
      const r = await run(w.app, 'upgrade-image', '--candidate', '--version', '2026.9.8');
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain('Candidate built as example-runtime:2026.9.8 (:latest untouched). Smoke-test it:\n  HATCHABOT_IMAGE=example-runtime:2026.9.8 npm run e2e:docker');
      expect(r.out).toContain('The fleet default stays example-runtime:2026.9.4 (HATCHABOT_IMAGE): to make example-runtime:2026.9.8 the default, set HATCHABOT_IMAGE in .env to it and restart Hatchabot.');
      expect(r.out).not.toContain('docker tag');
      expect(r.out).not.toContain('then promote');
    } finally { handler = () => undefined; w.done(); }
  }, 90_000);
});
