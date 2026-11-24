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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
    return { app, seen: () => readFileSync(seenBy, 'utf8'), done: () => rmSync(app, { recursive: true, force: true }) };
  }
  const runAt = (url: string, app: string, ...args: string[]) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', join(app, 'src', 'cli.ts'), ...args], {
      cwd: app,
      // The shell names another image: the .env's is the fleet's.
      env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HATCHABOT_URL: url, HATCHABOT_TOKEN: 'made-up-cli-credential', NO_COLOR: '1', HATCHABOT_IMAGE: 'shell-runtime:latest' },
      timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout), err: String(stderr) }));
  });
  const run = (app: string, ...args: string[]) => runAt(base, app, ...args);

  it('a candidate without its engine, before 2026.8: the .env\'s repository and the -lite tag', async () => {
    handler = () => undefined;
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
      return { json: { refused: req.url.includes('2026.9.8') ? pinned : null } };
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
      expect(asked.at(-1)).toBe('/v1/runtime/build/check?tag=example-runtime%3A2026.9.6&version=2026.9.6');
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
    // Nothing listens there: a closed port on this machine.
    const closed = await new Promise<string>((resolve) => { const s2 = createServer(); s2.listen(0, '127.0.0.1', () => { const port = (s2.address() as { port: number }).port; s2.close(() => resolve(`http://127.0.0.1:${port}`)); }); });
    const w = install('HATCHABOT_IMAGE=example-runtime:latest\n');
    try {
      const r = await runAt(closed, w.app, 'upgrade-image', '--version', '2026.9.8', '--candidate');
      expect(r.code, r.err).toBe(0);
      const warning = /^⚠ Could not ask Hatchabot whether example-runtime:2026\.9\.8 may be built \(.+\): if agents are pinned to it, or would run it as the new default, this build changes what they run\.$/;
      const lines = r.out.trimEnd().split('\n');
      expect(lines.filter((l) => warning.test(l))).toHaveLength(2);
      expect(lines.at(-1)).toMatch(warning);
      expect(w.seen()).toContain('OPENCLAW_VERSION=2026.9.8\n');
    } finally { w.done(); }
  }, 90_000);

  it('a default build, the .env naming no image: the shell\'s, as upgrade.sh leaves it, and where its :latest moves', async () => {
    const w = install('PORT=8080\n');
    try {
      const r = await run(w.app, 'upgrade-image', '--version', '2026.9.8');
      expect(r.code, r.err).toBe(0);
      expect(w.seen()).toContain('HATCHABOT_IMAGE=shell-runtime:latest\n'); // .env names none: the shell's stays, as upgrade.sh leaves it
      expect(r.out).toContain('Building shell-runtime:2026.9.8 for OpenClaw 2026.9.8 (promotes to shell-runtime:latest)…');
      expect(r.out).toContain('Done — shell-runtime:latest is now OpenClaw 2026.9.8.');
    } finally { w.done(); }
  }, 90_000);
});
