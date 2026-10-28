import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { ExecResult } from '../src/providers/provider.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { clearBusy } from '../src/orchestrator/busy.js';
import { AppError, appChat, hostGit, installRelease, mergeConfig, parseManifest, resolveRelease, type AgentFacts } from '../src/orchestrator/apps.js';

/**
 * Apps in agents: what the settings, the shared-account guard and a new
 * agent's chat are judged by (the app audit of 2026-10-27, HB-0259 to
 * HB-0263). A throwaway git repo (hooks off) and a fake agent whose volume is
 * a temp folder; nothing reaches a real agent. Made-up data only.
 */
const MANIFEST = {
  app: 'demoapp',
  name: 'Demo App',
  env: { DEMO_HOME: '{data_dir}' },
  tasks: [{ name: 'tick', every: '1m', command: ['python3', '-m', 'demo', 'tick'] }],
  connections: [{ kind: 'google', purpose: 'its mailbox', field: 'mailbox' }],
  config: { fields: [{ key: 'mailbox', label: 'its address', type: 'email', required: true }, { key: 'mode', default: 'shadow' }] },
};
const FACTS: AgentFacts = { slug: 'demo-agent', name: 'Demo', timezone: 'America/Toronto' };
const OWNER = 'owner-1';
const as = { 'x-hatchabot-owner': OWNER };

const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { clearBusy('a1'); clearBusy('a2'); });

const gitIn = (dir: string, ...a: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-C', dir, ...a],
  { env: { HOME: dir, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
const isolatedGit: typeof hostGit = async (args) => {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { env: { HOME: tmpdir(), PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: String(r.stderr ?? '') };
};

function repo(manifest: unknown = MANIFEST): string {
  const dir = mkdtempSync(join(tmpdir(), 'hb-app-'));
  tmp.push(dir);
  gitIn(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'demo'));
  writeFileSync(join(dir, 'demo', '__init__.py'), '');
  writeFileSync(join(dir, 'hatchabot.json'), JSON.stringify(manifest));
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

/** A fake agent: shell steps run in a temp folder per agent (the apps folder rewritten to it); tasks are a list in memory. */
const APPS = '/home/node/.openclaw/apps';
class FakeAgent extends MockProvider {
  jobs: Array<{ id: string; name: string }> = [];
  #roots = new Map<string, string>();
  #next = 1;
  root(ref: string): string {
    let r = this.#roots.get(ref);
    if (!r) { r = mkdtempSync(join(tmpdir(), 'hb-agentvol-')); tmp.push(r); this.#roots.set(ref, r); }
    return r;
  }
  #run(ref: string, script: string, input?: Buffer): ExecResult {
    const s = script.split(APPS).join(this.root(ref));
    if (s.includes('/home/node')) throw new Error(`a step reaches outside the fake volume: ${s}`);
    const r = spawnSync('sh', ['-c', s], { input, cwd: this.root(ref), env: { PATH: '/usr/bin:/bin', HOME: this.root(ref), LC_ALL: 'C' } });
    return { code: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
  }
  override async exec(_ref: string, argv: string[]): Promise<ExecResult> {
    if (argv[0] === 'cron' && argv[1] === 'list') return { code: 0, stdout: JSON.stringify({ jobs: this.jobs.map(({ id, name }) => ({ id, name, enabled: true })) }), stderr: '' };
    if (argv[0] === 'cron' && argv[1] === 'add') {
      const id = `j${this.#next++}`;
      this.jobs.push({ id, name: argv[argv.indexOf('--name') + 1]! });
      return { code: 0, stdout: JSON.stringify({ id }), stderr: '' };
    }
    if (argv[0] === 'cron' && argv[1] === 'rm') this.jobs = this.jobs.filter((j) => j.id !== argv[2]);
    return { code: 0, stdout: '{}', stderr: '' };
  }
  override async execShell(ref: string, script: string): Promise<ExecResult> { return this.#run(ref, script); }
  override async writeToVolume(ref: string, argv: string[], input: Buffer): Promise<ExecResult> { return this.#run(ref, argv[2]!, input); }
  config(ref: string) {
    const f = join(this.root(ref), 'demoapp/data/config.json');
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  }
}

async function world() {
  const db = new Database(':memory:');
  const store = new Store(db);
  const provider = new FakeAgent();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p', ownerId: OWNER, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', secretRef: 'ai/p', createdAt: 'now' } as never);
  const agent = (id: string, name: string, state = 'RUNNING') => store.insertAgent({ id, ownerId: OWNER, name, slug: id, state, runtimeRef: `mock://${id}`, aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
  agent('a1', 'Demo');
  const f = Fastify();
  const secrets = { put: async () => {}, get: async () => 'x', delete: async () => {} };
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } }, appGit: isolatedGit } as never);
  const install = (id: string, source: string, values: Record<string, unknown>) => f.inject({ method: 'POST', url: `/v1/agents/${id}/app`, headers: as, payload: { source, values } });
  return { db, store, provider, f, agent, install };
}

describe("an app setting's value", () => {
  const withFields = (fields: unknown[]) => parseManifest(JSON.stringify({ ...MANIFEST, connections: [], config: { fields } }));

  it('a secret one that is not valid is never said back, nor kept with the operation and its event (HB-0260)', async () => {
    const w = await world();
    const value = 'made-up-private-address-with-typo';
    const source = repo({ app: 'demoapp', name: 'Demo App', tasks: [], config: { fields: [{ key: 'private_address', type: 'email', secret: true, required: true }] } });
    try {
      const r = await w.install('a1', source, { private_address: value });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('Not a valid value: private_address must be an email address.');
      const op = w.db.prepare("SELECT outcome FROM operations WHERE agent_id = 'a1' AND kind = 'app-install'").get() as { outcome: string };
      expect(op.outcome).toContain('private_address must be an email address');
      expect(op.outcome).not.toContain(value);
      const events = w.db.prepare("SELECT detail FROM agent_events WHERE agent_id = 'a1'").all() as Array<{ detail: string }>;
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect(e.detail ?? '').not.toContain(value);
    } finally { await w.f.close(); w.db.close(); }
  });

  it("a secret one's default is not said back either; a plain one's still is (HB-0260)", () => {
    expect(() => mergeConfig(withFields([{ key: 'api_key', type: 'number', secret: true, default: 'made-up-default-key' }]), FACTS, {}, {}))
      .toThrow(/^Not a valid value: the app's default for api_key is not a number \(its hatchabot\.json needs fixing\)\.$/);
    expect(() => mergeConfig(withFields([{ key: 'per_day', type: 'number', default: 'lots' }]), FACTS, {}, {})).toThrow(/\("lots"; its hatchabot\.json/);
    expect(() => mergeConfig(withFields([{ key: 'per_day', type: 'number' }]), FACTS, {}, { per_day: 'many' })).toThrow(/per_day must be a number \(got "many"\)/);
  });

  it('a secret value given never reaches an install error, whatever made it (HB-0260)', async () => {
    const agent = new FakeAgent();
    const rel = await resolveRelease(isolatedGit, repo({ ...MANIFEST, connections: [], config: { fields: [{ key: 'app_password', secret: true }] } }), 'HEAD');
    const e = await installRelease({ provider: agent, runtimeRef: 'x', facts: FACTS, checkConfig: (c) => { throw new AppError(`refused ${String(c.app_password)}`); } },
      rel, { app_password: 'made-up-app-password' }).then(() => new Error('installed'), (x: unknown) => x as Error);
    expect(e.message).toMatch(/^refused ••••••/);
    expect(e.message).not.toContain('made-up-app-password');
  });

  it('a kept value of a required list that coerces to nothing is asked for again (HB-0263)', () => {
    const m = withFields([{ key: 'recipients', type: 'list', required: true }]);
    const r = mergeConfig(m, FACTS, { recipients: ', ,' }, {});
    expect(r.missingKeys).toEqual(['recipients']);
    expect(Object.hasOwn(r.config, 'recipients')).toBe(false);
    expect(mergeConfig(m, FACTS, { recipients: 'a@example.org, b@example.org' }, {}).config.recipients).toEqual(['a@example.org', 'b@example.org']);
    // An optional one keeps its empty list.
    expect(mergeConfig(withFields([{ key: 'recipients', type: 'list' }]), FACTS, { recipients: ', ,' }, {})).toMatchObject({ config: { recipients: [] }, missing: [] });
  });
});

describe('two copies of one app on one account (HB-0261)', () => {
  it("an account the other agent has attached but its app does not use is free", async () => {
    const w = await world();
    w.agent('a2', 'Demo Two');
    for (const [id, email] of [['c1', 'demo@example.org'], ['c2', 'other@example.org']] as const) w.store.insertConnection({ id, ownerId: OWNER, kind: 'google', email, services: ['gmail'], secretRef: `s/${id}` });
    w.store.attachConnection('a1', 'c1', false); w.store.attachConnection('a1', 'c2', false); w.store.attachConnection('a2', 'c2', false);
    const dir = repo();
    try {
      expect((await w.install('a1', dir, { mailbox: 'demo@example.org' })).statusCode).toBe(200);
      expect(w.provider.config('mock://a1').mailbox).toBe('demo@example.org');
      const r = await w.install('a2', dir, { mailbox: 'other@example.org' });
      expect(r.statusCode, r.body).toBe(200);
      expect(w.provider.config('mock://a2').mailbox).toBe('other@example.org');
    } finally { await w.f.close(); w.db.close(); }
  });

  it("the account the other copy is configured with is refused; one whose config cannot be read still counts", async () => {
    const w = await world();
    w.agent('a2', 'Demo Two');
    w.store.insertConnection({ id: 'c2', ownerId: OWNER, kind: 'google', email: 'other@example.org', services: ['gmail'], secretRef: 's/c2' });
    w.store.attachConnection('a1', 'c2', false); w.store.attachConnection('a2', 'c2', false);
    const dir = repo();
    try {
      expect((await w.install('a1', dir, { mailbox: 'other@example.org' })).statusCode).toBe(200);
      const same = await w.install('a2', dir, { mailbox: 'other@example.org' });
      expect(same.statusCode).toBe(409);
      expect(same.json()).toMatchObject({ conflict: ['Demo'] });
      // Its config gone (or its agent stopped): not known, so not free.
      rmSync(join(w.provider.root('mock://a1'), 'demoapp/data/config.json'));
      const unknown = await w.install('a2', dir, { mailbox: 'other@example.org' });
      expect(unknown.statusCode).toBe(409);
      expect(w.store.getAgentApp('a2')).toBeUndefined();
    } finally { await w.f.close(); w.db.close(); }
  });
});

describe("a new agent's chat from its app (HB-0259)", () => {
  const CHAT = 'Run cd {app_dir} && {env} python3 -m demo status for {name} as {agent}; data in {data_dir}.';

  it('fills the placeholders as its tasks are', () => {
    const m = parseManifest(JSON.stringify({ ...MANIFEST, chat: CHAT }));
    expect(appChat(m, 'garden-helper')).toBe("Run cd /home/node/.openclaw/apps/demoapp/current && DEMO_HOME='/home/node/.openclaw/apps/demoapp/data' python3 -m demo status for Demo App as garden-helper; data in /home/node/.openclaw/apps/demoapp/data.");
    expect(appChat(parseManifest(JSON.stringify(MANIFEST)), 'garden-helper')).toBeUndefined();
  });

  it("inspect with the new agent's name answers the chat filled in for it", async () => {
    const w = await world();
    const dir = repo({ ...MANIFEST, chat: CHAT });
    try {
      const plain = (await w.f.inject({ method: 'POST', url: '/v1/apps/inspect', headers: as, payload: { source: dir } })).json();
      expect(plain.chat).toBeUndefined();
      expect(plain.manifest.chat).toBe(CHAT);
      const named = (await w.f.inject({ method: 'POST', url: '/v1/apps/inspect', headers: as, payload: { source: dir, name: 'Garden Helper' } })).json();
      expect(named.chat).toContain('cd /home/node/.openclaw/apps/demoapp/current && ');
      expect(named.chat).toContain(' as garden-helper;');
      expect(named.chat).not.toMatch(/\{(app_dir|data_dir|agent|name|env)\}/);
    } finally { await w.f.close(); w.db.close(); }
  });
});

describe('hatchabot app create (HB-0259, HB-0262)', () => {
  /** The real CLI against a stubbed server: each request is written to a log. */
  function cli(manifest: unknown, args: string[]) {
    const home = mkdtempSync(join(tmpdir(), 'hb-app-cli-'));
    tmp.push(home);
    const m = parseManifest(JSON.stringify(manifest));
    const log = join(home, 'calls.jsonl');
    const preload = join(home, 'fetch.mjs');
    writeFileSync(preload, `import { appendFileSync } from 'node:fs';
const m = ${JSON.stringify(m)};
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname, method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : undefined;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body }) + '\\n');
  const ok = (x) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
  if (path === '/v1/config') return ok({ authMode: 'accounts' });
  if (path === '/v1/apps/inspect') return ok({ sha: 'c0ffee0123456789c0ffee0123456789c0ffee01', manifest: m, ask: m.config.fields, connections: [],
    ...(body.name ? { chat: 'filled in for ' + body.name } : {}) });
  if (path === '/v1/ai-profiles') return ok([{ id: 'p', name: 'Plan', defaultSource: true }]);
  if (path === '/v1/hosts') return ok([{ id: 'h1', kind: 'local' }]);
  if (path === '/v1/agents' && method === 'POST') return ok({ id: 'new1' });
  if (path === '/v1/agents/new1' && method === 'GET') return ok({ id: 'new1', state: 'RUNNING' });
  if (path === '/v1/agents/new1/app') return ok({ app: { name: m.name, app: m.app, sha: 'c0ffee0123456789', source: '/tmp/demo', ref: 'HEAD', tasks: [] } });
  throw new Error('Unexpected fixture call ' + method + ' ' + path);
};`);
    const r = spawnSync(process.execPath, ['--import', preload, '--import', 'tsx', 'src/cli.ts', 'app', 'create', 'Garden Helper', '/tmp/fixture-app', '--no-telegram', ...args], {
      cwd: join(import.meta.dirname, '..'), timeout: 30_000, encoding: 'utf8',
      env: { HOME: home, PATH: dirname(process.execPath), HATCHABOT_URL: 'http://fixture.invalid', HATCHABOT_TOKEN: 'made-up-credential', NO_COLOR: '1' },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    return { ...r, calls };
  }
  const APP = { app: 'garden-log', name: 'Garden Log', chat: 'Run {app_dir}', config: { fields: [{ key: 'mode', required: true, default: 'shadow' }, { key: 'mailbox', type: 'email' }] } };

  it('a required setting with a valid default needs nothing typed; the chat sent is the one filled in', () => {
    const r = cli(APP, []);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.calls.find((c) => c.path === '/v1/apps/inspect').body.name).toBe('Garden Helper');
    expect(r.calls.find((c) => c.path === '/v1/agents' && c.method === 'POST').body.persona).toBe('filled in for Garden Helper');
    expect(r.calls.find((c) => c.path === '/v1/agents/new1/app').body.values).toEqual({});
  });

  it('a required setting with no default, or a value not of its type, stops it before an agent is made', () => {
    const none = cli({ ...APP, config: { fields: [{ key: 'mode', required: true }] } }, []);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('Garden Log needs: mode=');
    expect(none.calls.some((c) => c.path === '/v1/agents')).toBe(false);
    const bad = cli(APP, ['mailbox=not-an-address']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('mailbox must be an email address');
    expect(bad.calls.some((c) => c.path === '/v1/agents')).toBe(false);
  });
});
