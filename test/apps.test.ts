import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { ExecResult } from '../src/providers/provider.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import {
  AppError, fieldsToAsk, hostGit, installRelease, mergeConfig, parseManifest, parseSource, repoFor, resolveRelease, type AgentFacts,
} from '../src/orchestrator/apps.js';

/**
 * Apps in agents (docs/apps-in-agents.md): a repo with hatchabot.json installed
 * into an agent as a release. A throwaway git repo (hooks off) and a fake agent
 * that records every command; nothing reaches a real agent. Made-up data only.
 */
const MANIFEST = {
  app: 'demoapp',
  name: 'Demo App',
  model: 'claude-haiku-4-5',
  test: ['python3', '-m', 'unittest'],
  env: { DEMO_HOME: '{data_dir}' },
  tasks: [{ name: 'tick', every: '1m', command: ['python3', '-m', 'demo', 'tick'] }],
  config: { fields: [
    { key: 'mailbox', label: 'its address', type: 'email', required: true },
    { key: 'mode', default: 'shadow' },
    { key: 'openclaw_agent', from: 'agent.openclawId' },
    { key: 'timezone', from: 'host.timezone' },
  ] },
};
const FACTS: AgentFacts = { slug: 'demo-agent', name: 'Demo', timezone: 'America/Toronto', telegramAccount: 'demobot', ownerTelegram: '100' };

const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

function repo(manifest: unknown = MANIFEST): string {
  const dir = mkdtempSync(join(tmpdir(), 'hb-app-'));
  tmp.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-C', dir, ...a]);
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'demo'));
  writeFileSync(join(dir, 'demo', '__init__.py'), '');
  if (manifest) writeFileSync(join(dir, 'hatchabot.json'), JSON.stringify(manifest));
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return dir;
}

/** A fake agent: answers `cat config`, `readlink current`, `cron list`; records the rest. */
class FakeAgent extends MockProvider {
  calls: Array<{ kind: string; what: string; input?: string }> = [];
  config = '';
  current = '';
  jobs: Array<{ id: string; name: string }> = [{ id: 'old1', name: 'demoapp-tick' }, { id: 'keep', name: 'daily-brief' }];
  testCode = 0;
  override async exec(_ref: string, argv: string[]): Promise<ExecResult> {
    this.calls.push({ kind: 'exec', what: JSON.stringify(argv) });
    if (argv[0] === 'cron' && argv[1] === 'list') return { code: 0, stdout: JSON.stringify({ jobs: this.jobs }), stderr: '' };
    return { code: 0, stdout: '{}', stderr: '' };
  }
  override async execShell(_ref: string, script: string): Promise<ExecResult> {
    this.calls.push({ kind: 'sh', what: script });
    if (script.startsWith('cat ')) return { code: 0, stdout: this.config, stderr: '' };
    if (script.startsWith('readlink ')) return { code: 0, stdout: this.current, stderr: '' };
    if (script.includes('unittest')) return { code: this.testCode, stdout: this.testCode ? 'FAILED (failures=1)' : 'OK', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }
  override async writeToVolume(_ref: string, argv: string[], input: Buffer): Promise<ExecResult> {
    const isConfig = argv.join(' ').includes('config.json');
    if (isConfig) this.config = input.toString(); // the agent keeps it, as a real volume does
    this.calls.push({ kind: 'write', what: argv.join(' '), input: isConfig ? input.toString() : `${input.length} bytes` });
    return { code: 0, stdout: '', stderr: '' };
  }
}

describe('the manifest', () => {
  it('is checked, and says what it will ask for', () => {
    const m = parseManifest(JSON.stringify(MANIFEST));
    expect(fieldsToAsk(m).map((f) => f.key)).toEqual(['mailbox', 'mode']);
    expect(() => parseManifest('{"app":"Bad App","name":"x"}')).toThrow(/app: 2-40 characters/);
    expect(() => parseManifest(JSON.stringify({ ...MANIFEST, tasks: [{ name: 'x', command: ['a'] }] }))).toThrow(/exactly one of "every" or "cron"/);
    expect(() => parseManifest('not json')).toThrow(AppError);
  });

  it('a source is a folder or a git address, nothing else', () => {
    expect(parseSource('~/myapp', '/home/tester')).toEqual({ kind: 'dir', path: '/home/tester/myapp' });
    expect(parseSource('https://github.com/example-org/demo.git')).toEqual({ kind: 'git', url: 'https://github.com/example-org/demo.git' });
    expect(() => parseSource('demo; rm -rf ~')).toThrow(AppError);
    expect(() => parseSource('https://example.org/x.git; touch y')).toThrow(AppError);
  });
});

describe('reading a repo on the host', () => {
  it('resolves a ref to its commit, its manifest and its files', async () => {
    const dir = repo();
    const r = await resolveRelease(hostGit, await repoFor(hostGit, { kind: 'dir', path: dir }, '/nonexistent'), 'HEAD');
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.manifest.app).toBe('demoapp');
    expect(r.tar.length).toBeGreaterThan(512);
  });

  it('says so when there is no manifest or no such ref', async () => {
    const dir = repo(null);
    await expect(resolveRelease(hostGit, dir, 'HEAD')).rejects.toThrow(/has no hatchabot.json/);
    await expect(resolveRelease(hostGit, repo(), 'no-such-branch')).rejects.toThrow(/No commit "no-such-branch"/);
    await expect(resolveRelease(hostGit, repo(), '--upload-pack=x')).rejects.toThrow(/Not a ref/);
  });
});

describe('installing into an agent', () => {
  const rel = async () => resolveRelease(hostGit, repo(), 'HEAD');

  it('unpacks, writes the config, tests, switches, and syncs only its own tasks', async () => {
    const r = await rel();
    const agent = new FakeAgent();
    const done = await installRelease({ provider: agent, runtimeRef: 'x', facts: FACTS }, r, { mailbox: 'demo@example.org' });
    const short = r.sha.slice(0, 12);
    expect(agent.calls.find((c) => c.kind === 'write' && c.what.includes(`releases/${short}`))).toBeTruthy();
    const cfg = JSON.parse(agent.calls.find((c) => c.kind === 'write' && c.what.includes('config.json'))!.input!);
    expect(cfg).toEqual({ mailbox: 'demo@example.org', mode: 'shadow', openclaw_agent: 'demo-agent', timezone: 'America/Toronto' });
    const order = agent.calls.map((c) => (c.what.includes('unittest') ? 'test' : c.what.includes('mv -T current.new current') ? 'switch' : null)).filter(Boolean);
    expect(order).toEqual(['test', 'switch']);
    const rm = agent.calls.filter((c) => c.what.startsWith('["cron","rm"'));
    expect(rm.map((c) => JSON.parse(c.what)[2])).toEqual(['old1']); // another task of the agent is left alone
    const add = JSON.parse(agent.calls.find((c) => c.what.startsWith('["cron","add"'))!.what) as string[];
    expect(add).toEqual(expect.arrayContaining(['--name', 'demoapp-tick', '--agent', 'demo-agent', '--every', '1m',
      '--command-cwd', '/home/node/.openclaw/apps/demoapp/current', '--command-env', 'DEMO_HOME=/home/node/.openclaw/apps/demoapp/data', '--no-deliver']));
    expect(JSON.parse(add[add.indexOf('--command-argv') + 1]!)).toEqual(['python3', '-m', 'demo', 'tick']);
    expect(done.tasks).toEqual(['demoapp-tick']);
  });

  it('a failing test leaves the running version alone', async () => {
    const agent = new FakeAgent();
    agent.testCode = 1;
    await expect(installRelease({ provider: agent, runtimeRef: 'x', facts: FACTS }, await rel(), { mailbox: 'demo@example.org' }))
      .rejects.toThrow(/tests failed, so .* was not switched on/);
    expect(agent.calls.some((c) => c.what.includes('mv -T current.new current'))).toBe(false);
    expect(agent.calls.some((c) => c.what.startsWith('["cron"'))).toBe(false);
  });

  it('a required value missing stops it before anything runs', async () => {
    const agent = new FakeAgent();
    await expect(installRelease({ provider: agent, runtimeRef: 'x', facts: FACTS }, await rel())).rejects.toThrow(/Needs a value for: mailbox/);
    expect(agent.calls.some((c) => c.what.includes('unittest'))).toBe(false);
  });

  it('an update keeps the values already in the config', () => {
    const m = parseManifest(JSON.stringify(MANIFEST));
    const { config, missing } = mergeConfig(m, FACTS, { mailbox: 'kept@example.org', mode: 'live', extra: 1 }, {});
    expect(missing).toEqual([]);
    expect(config).toEqual({ mailbox: 'kept@example.org', mode: 'live', extra: 1, openclaw_agent: 'demo-agent', timezone: 'America/Toronto' });
  });
});

describe('the app routes', () => {
  const OWNER = 'owner-1';
  async function app() {
    const store = new Store(new Database(':memory:'));
    const provider = new FakeAgent();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p', ownerId: OWNER, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', secretRef: 'ai/p', createdAt: 'now' } as never);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Demo', slug: 'demo-agent', state: 'RUNNING', runtimeRef: 'mock://a1', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    const f = Fastify();
    await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } } } as never);
    return { f, store, provider };
  }
  const as = { 'x-hatchabot-owner': OWNER };

  it('inspect, install, update with nothing new, roll back, remove', async () => {
    const { f, store, provider } = await app();
    const dir = repo();
    const ins = await f.inject({ method: 'POST', url: '/v1/apps/inspect', headers: as, payload: { source: dir } });
    expect(ins.json().ask.map((x: { key: string }) => x.key)).toEqual(['mailbox', 'mode']);
    const put = await f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload: { source: dir, values: { mailbox: 'demo@example.org' } } });
    expect(put.statusCode).toBe(200);
    expect(put.json().app).toMatchObject({ app: 'demoapp', source: dir, ref: 'HEAD', tasks: ['demoapp-tick'], testOk: true });
    const same = await f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: as, payload: {} });
    expect(same.json().unchanged).toBe(true);
    // A second commit, then an update, then back.
    writeFileSync(join(dir, 'demo', 'more.py'), 'X = 1\n');
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-C', dir, 'commit', '-qam', 'second', '--allow-empty']);
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-C', dir, 'add', '-A']);
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-C', dir, 'commit', '-qm', 'third']);
    const first = store.getAgentApp('a1')!.sha;
    const upd = await f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: as, payload: {} });
    expect(upd.statusCode).toBe(200);
    expect(store.getAgentApp('a1')!.previousSha).toBe(first);
    const back = await f.inject({ method: 'POST', url: '/v1/agents/a1/app/rollback', headers: as });
    expect(back.statusCode).toBe(200);
    expect(store.getAgentApp('a1')!.sha).toBe(first);
    const gone = await f.inject({ method: 'DELETE', url: '/v1/agents/a1/app', headers: as });
    expect(gone.json()).toMatchObject({ removed: true });
    expect(store.getAgentApp('a1')).toBeUndefined();
    expect(provider.calls.some((c) => c.what.startsWith('["cron","rm"'))).toBe(true);
  });

  it('a failing test is a 400 with the output, and nothing is recorded', async () => {
    const { f, store, provider } = await app();
    provider.testCode = 1;
    const r = await f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload: { source: repo(), values: { mailbox: 'demo@example.org' } } });
    expect(r.statusCode).toBe(400);
    expect(r.json().test.output).toMatch(/FAILED/);
    expect(store.getAgentApp('a1')).toBeUndefined();
  });

  it('only the machine owner, and only a running agent', async () => {
    const { f, store } = await app();
    const other = await f.inject({ method: 'POST', url: '/v1/apps/inspect', headers: { 'x-hatchabot-owner': 'someone-else' }, payload: { source: repo() } });
    expect(other.statusCode).toBe(403);
    store.setAgentState('a1', 'STOPPED');
    const stopped = await f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload: { source: repo(), values: { mailbox: 'x@example.org' } } });
    expect(stopped.statusCode).toBe(409);
  });
});
