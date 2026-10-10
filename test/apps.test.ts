import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { ExecResult } from '../src/providers/provider.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { clearBusy } from '../src/orchestrator/busy.js';
import { newBootForTests, setStepHookForTests, SimulatedCrash } from '../src/orchestrator/operations.js';
import {
  AppError, fieldsToAsk, hostGit, installRelease, mergeConfig, parseManifest, parseSource, repoFor, resolveRelease, switchTo, type AgentFacts,
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
  connections: [{ kind: 'google', purpose: 'its mailbox', field: 'mailbox' }],
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

const gitIn = (dir: string, ...a: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-C', dir, ...a]);

function repo(manifest: unknown = MANIFEST): string {
  const dir = mkdtempSync(join(tmpdir(), 'hb-app-'));
  tmp.push(dir);
  const git = (...a: string[]) => gitIn(dir, ...a);
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'demo'));
  writeFileSync(join(dir, 'demo', '__init__.py'), '');
  if (manifest) writeFileSync(join(dir, 'hatchabot.json'), JSON.stringify(manifest));
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return dir;
}

/** A new commit, with another manifest when given. */
let commits = 0;
function commit(dir: string, manifest?: unknown) {
  if (manifest) writeFileSync(join(dir, 'hatchabot.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'demo', `v${++commits}.py`), 'X = 1\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', `change ${commits}`);
}

/**
 * A fake agent. Its volume is a temp folder: the shell steps really run there
 * (the agent's apps folder rewritten to it, a bare PATH, a temp HOME), so the
 * config bytes and the `current` link are real. Its scheduled tasks are a list
 * in memory; the app's tests are answered with `testCode`. Every call is
 * recorded as sent.
 */
const APPS = '/home/node/.openclaw/apps';
class FakeAgent extends MockProvider {
  calls: Array<{ kind: string; what: string; input?: string }> = [];
  jobs: Array<{ id: string; name: string; argv?: string[] }> = [{ id: 'old1', name: 'demoapp-tick' }, { id: 'keep', name: 'daily-brief' }];
  testCode = 0;
  /** The config file the app's tests found in their {data_dir}. */
  testSaw: string[] = [];
  failAdd: (name: string) => boolean = () => false;
  failRm: (id: string) => boolean = () => false;
  /** A `cron add` (by name) or `cron rm` (by id) that takes effect, then its reply is lost. */
  lostAdd: (name: string) => boolean = () => false;
  lostRm: (id: string) => boolean = () => false;
  /** `cron list` calls so far; those after the `failListAfter`th cannot be read. */
  lists = 0;
  failListAfter = Infinity;
  /** Change a shell step before it runs (to break it part way). */
  breakScript: (script: string) => string = (s) => s;
  #roots = new Map<string, string>();
  #next = 1;
  root(ref: string): string {
    let r = this.#roots.get(ref);
    if (!r) { r = mkdtempSync(join(tmpdir(), 'hb-agentvol-')); tmp.push(r); this.#roots.set(ref, r); }
    return r;
  }
  #run(ref: string, script: string, input?: Buffer): ExecResult {
    const s = this.breakScript(script).split(APPS).join(this.root(ref));
    if (s.includes('/home/node')) throw new Error(`a step reaches outside the fake volume: ${s}`);
    const r = spawnSync('sh', ['-c', s], { input, cwd: this.root(ref), env: { PATH: '/usr/bin:/bin', HOME: this.root(ref), LC_ALL: 'C' } });
    return { code: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
  }
  override async exec(_ref: string, argv: string[]): Promise<ExecResult> {
    this.calls.push({ kind: 'exec', what: JSON.stringify(argv) });
    const lost = { code: 1, stdout: '', stderr: 'fixture response lost', timedOut: true };
    if (argv[0] === 'cron' && argv[1] === 'list' && ++this.lists > this.failListAfter) return { code: 1, stdout: '', stderr: 'gateway closed' };
    if (argv[0] === 'cron' && argv[1] === 'list') return { code: 0, stdout: JSON.stringify({ jobs: this.jobs.map(({ id, name }) => ({ id, name })) }), stderr: '' };
    if (argv[0] === 'cron' && argv[1] === 'add') {
      const name = argv[argv.indexOf('--name') + 1]!;
      if (this.failAdd(name)) return { code: 1, stdout: '', stderr: 'gateway refused the job' };
      const id = `j${this.#next++}`;
      this.jobs.push({ id, name, argv });
      if (this.lostAdd(name)) return lost;
      return { code: 0, stdout: JSON.stringify({ id }), stderr: '' };
    }
    if (argv[0] === 'cron' && argv[1] === 'rm') {
      if (this.failRm(argv[2]!)) return { code: 1, stdout: '', stderr: 'gateway timed out' };
      this.jobs = this.jobs.filter((j) => j.id !== argv[2]);
      if (this.lostRm(argv[2]!)) return lost;
    }
    return { code: 0, stdout: '{}', stderr: '' };
  }
  override async execShell(ref: string, script: string): Promise<ExecResult> {
    this.calls.push({ kind: 'sh', what: script });
    if (script.includes('unittest')) {
      const home = /DEMO_HOME='([^']*)'/.exec(script)?.[1];
      const f = home ? join(home.split(APPS).join(this.root(ref)), 'config.json') : '';
      this.testSaw.push(f && existsSync(f) ? readFileSync(f, 'utf8') : '');
      return { code: this.testCode, stdout: this.testCode ? 'FAILED (failures=1)' : 'OK', stderr: '' };
    }
    return this.#run(ref, script);
  }
  override async writeToVolume(ref: string, argv: string[], input: Buffer): Promise<ExecResult> {
    const isConfig = argv.join(' ').includes('config.json');
    this.calls.push({ kind: 'write', what: argv.join(' '), input: isConfig ? input.toString() : `${input.length} bytes` });
    return this.#run(ref, argv[2]!, input);
  }
  /** The live config file of demoapp, on the fake volume. */
  configFile(ref = 'x') { return join(this.root(ref), 'demoapp/data/config.json'); }
  /** What is live: the release `current` points at, the config bytes, the app's task ids, whether staging is gone. */
  live(ref = 'x') {
    let current: string | null = null;
    try { current = readlinkSync(join(this.root(ref), 'demoapp/current')); } catch { /* not installed */ }
    return {
      current, config: existsSync(this.configFile(ref)) ? readFileSync(this.configFile(ref), 'utf8') : null,
      tasks: this.jobs.filter((j) => j.name.startsWith('demoapp-')).map((j) => j.id).sort(),
      staging: existsSync(join(this.root(ref), 'demoapp/staging')),
    };
  }
  /** The schedule a task of demoapp was added with ('?' when it predates the test). */
  every(name: string) {
    return this.jobs.filter((j) => j.name === name).map((j) => (j.argv ? j.argv[j.argv.indexOf('--every') + 1] : '?'));
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

/**
 * A failed update changes nothing live (issues #4 and #5): the release, its
 * config (to the byte) and its tasks stay as they were, whichever step fails.
 */
describe('a failed update leaves the running app as it was', () => {
  const TWO_TASKS = { ...MANIFEST, tasks: [
    { name: 'tick', every: '1m', command: ['python3', '-m', 'demo', 'tick'] },
    { name: 'digest', every: '1h', command: ['python3', '-m', 'demo', 'digest'] },
  ] };
  /** The owner's own edit to the live config, in bytes no install would write. */
  const OWN_BYTES = '{"mailbox":"first@example.org","mode":"live","note":"kept as typed"}';

  /** v1 installed, its config edited by hand, and a v2 commit (with `next` as its manifest) ready. */
  async function installed(next: unknown = MANIFEST, first: unknown = MANIFEST) {
    const dir = repo(first);
    const agent = new FakeAgent();
    agent.jobs = [{ id: 'keep', name: 'daily-brief' }];
    const d = { provider: agent, runtimeRef: 'x', facts: FACTS };
    const v1 = await resolveRelease(hostGit, dir, 'HEAD');
    await installRelease(d, v1, { mailbox: 'first@example.org' });
    writeFileSync(agent.configFile(), OWN_BYTES);
    commit(dir, next);
    const v2 = await resolveRelease(hostGit, dir, 'HEAD');
    return { agent, d, v1, v2, before: agent.live() };
  }

  it('failing tests: the live config keeps its bytes, and the tests saw the new values', async () => {
    const { agent, d, v1, v2, before } = await installed();
    expect(before.current).toBe(`releases/${v1.sha.slice(0, 12)}`);
    agent.testCode = 1;
    await expect(installRelease(d, v2, { mailbox: 'second@example.org' })).rejects.toThrow(/tests failed/);
    expect(agent.live()).toEqual({ ...before, config: OWN_BYTES, staging: false });
    expect(JSON.parse(agent.testSaw.at(-1)!)).toMatchObject({ mailbox: 'second@example.org', mode: 'live', note: 'kept as typed' });
  });

  it('a switch that fails part way puts the config back to the byte', async () => {
    const { agent, d, v2, before } = await installed();
    // The config is moved in, then the link cannot be made.
    agent.breakScript = (s) => (s.includes('mv -f') ? s.replace('ln -sfn releases/', 'false && ln -sfn releases/') : s);
    await expect(installRelease(d, v2, { mailbox: 'second@example.org' })).rejects.toThrow(/Could not switch to .* is running as before, with its configuration/);
    expect(agent.live()).toEqual({ ...before, config: OWN_BYTES, staging: false });
  });

  it('a first install that cannot schedule its task leaves no config, no current, no task', async () => {
    const agent = new FakeAgent();
    agent.jobs = [{ id: 'keep', name: 'daily-brief' }];
    agent.failAdd = () => true;
    await expect(installRelease({ provider: agent, runtimeRef: 'x', facts: FACTS }, await resolveRelease(hostGit, repo(), 'HEAD'), { mailbox: 'demo@example.org' }))
      .rejects.toThrow(/Could not schedule demoapp-tick.*Its tasks are as they were. Nothing was left switched on/s);
    expect(agent.live()).toEqual({ current: null, config: null, tasks: [], staging: false });
    expect(agent.jobs).toEqual([{ id: 'keep', name: 'daily-brief' }]);
  });

  it('a successful update applies the new values and keeps the rest', async () => {
    const { agent, d, v2 } = await installed();
    const done = await installRelease(d, v2, { mailbox: 'second@example.org' });
    const now = agent.live();
    expect(now.current).toBe(`releases/${v2.sha.slice(0, 12)}`);
    expect(JSON.parse(now.config!)).toEqual({ mailbox: 'second@example.org', mode: 'live', note: 'kept as typed', openclaw_agent: 'demo-agent', timezone: 'America/Toronto' });
    expect(now.staging).toBe(false);
    expect(done.tasks).toEqual(['demoapp-tick']);
    expect(agent.jobs.map((j) => j.name).sort()).toEqual(['daily-brief', 'demoapp-tick']);
  });

  it('the first new task cannot be scheduled: the old release, config and tasks stay', async () => {
    const { agent, d, v2, before } = await installed({ ...MANIFEST, tasks: [{ name: 'tick', every: '5m', command: ['python3', '-m', 'demo', 'tick'] }] });
    agent.failAdd = () => true;
    await expect(installRelease(d, v2, { mailbox: 'second@example.org' }))
      .rejects.toThrow(/Could not schedule demoapp-tick: gateway refused the job\. Its tasks are as they were\. [0-9a-f]{12} is running as before/);
    expect(agent.live()).toEqual({ ...before, config: OWN_BYTES, staging: false });
    expect(agent.every('demoapp-tick')).toEqual(['1m']);
  });

  it('a later task cannot be scheduled: the new ones already added come off again', async () => {
    const { agent, d, v2, before } = await installed(TWO_TASKS);
    agent.failAdd = (name) => name === 'demoapp-digest';
    await expect(installRelease(d, v2, {})).rejects.toThrow(/Could not schedule demoapp-digest.*Its tasks are as they were/s);
    expect(agent.live()).toEqual({ ...before, config: OWN_BYTES, staging: false });
    expect(agent.jobs.map((j) => j.name).sort()).toEqual(['daily-brief', 'demoapp-tick']);
  });

  it('an old task cannot be taken off: the new set comes off and the old one is whole again, as it was defined', async () => {
    const changed = { ...TWO_TASKS, tasks: TWO_TASKS.tasks.map((t) => ({ ...t, every: t.name === 'tick' ? '5m' : '2h' })) };
    const { agent, d, v2, before } = await installed(changed, TWO_TASKS);
    const oldDigest = agent.jobs.find((j) => j.name === 'demoapp-digest')!.id;
    agent.failRm = (id) => id === oldDigest; // the old tick comes off, then the old digest will not
    await expect(installRelease(d, v2, {})).rejects.toThrow(/Could not take off the old task demoapp-digest: gateway timed out\. Its tasks are as they were\..*running as before/s);
    const now = agent.live();
    expect(now.current).toBe(before.current);
    expect(now.config).toBe(OWN_BYTES);
    expect(agent.every('demoapp-tick')).toEqual(['1m']); // re-added from the old release's manifest
    expect(agent.every('demoapp-digest')).toEqual(['1h']);
    expect(now.tasks).toContain(oldDigest);
  });

  it('says what it could not put back', async () => {
    const changed = { ...TWO_TASKS, tasks: TWO_TASKS.tasks.map((t) => ({ ...t, every: '5m' })) };
    const { agent, d, v2 } = await installed(changed, TWO_TASKS);
    const oldDigest = agent.jobs.find((j) => j.name === 'demoapp-digest')!.id;
    let rmFailed = false;
    agent.failRm = (id) => (id === oldDigest ? (rmFailed = true) : false);
    agent.failAdd = (name) => rmFailed && name === 'demoapp-tick'; // the re-add of the old tick fails
    await expect(installRelease(d, v2, {})).rejects.toThrow(/Its scheduled tasks could not be confirmed: not re-added: demoapp-tick\. Check them/);
  });

  // #17 (2026-10-09): a removal or an add can take effect and still answer an
  // error (its reply lost, a timeout); the rollback goes by what the agent has.
  it('an old task taken off whose reply is lost: it is put back, and only then called as it was', async () => {
    const { agent, d, v2, before } = await installed({ ...MANIFEST, tasks: [{ name: 'tick', every: '5m', command: ['python3', '-m', 'demo', 'tick'] }] });
    const oldTick = agent.jobs.find((j) => j.name === 'demoapp-tick')!.id;
    agent.lostRm = (id) => id === oldTick;
    await expect(installRelease(d, v2, { mailbox: 'second@example.org' }))
      .rejects.toThrow(/Could not take off the old task demoapp-tick: fixture response lost\. Its tasks are as they were\. [0-9a-f]{12} is running as before/);
    const now = agent.live();
    expect(now.current).toBe(before.current);
    expect(now.config).toBe(OWN_BYTES);
    expect(agent.every('demoapp-tick')).toEqual(['1m']); // the old one, as v1 defined it; the new one is gone
    expect(agent.jobs.map((j) => j.name).sort()).toEqual(['daily-brief', 'demoapp-tick']);
  });

  it('the put-back re-add loses its reply too: the list shows it back, so it is as it was', async () => {
    const { agent, d, v2 } = await installed({ ...MANIFEST, tasks: [{ name: 'tick', every: '5m', command: ['python3', '-m', 'demo', 'tick'] }] });
    const oldTick = agent.jobs.find((j) => j.name === 'demoapp-tick')!.id;
    let rmLost = false;
    agent.lostRm = (id) => (id === oldTick ? (rmLost = true) : false);
    agent.lostAdd = (name) => rmLost && name === 'demoapp-tick';
    await expect(installRelease(d, v2, {})).rejects.toThrow(/Its tasks are as they were/);
    expect(agent.every('demoapp-tick')).toEqual(['1m']);
  });

  it('a new task added whose reply is lost: the rollback finds it and takes it off', async () => {
    const { agent, d, v2, before } = await installed(TWO_TASKS);
    agent.lostAdd = (name) => name === 'demoapp-digest';
    await expect(installRelease(d, v2, {})).rejects.toThrow(/Could not schedule demoapp-digest: fixture response lost\. Its tasks are as they were/);
    expect(agent.live()).toEqual({ ...before, config: OWN_BYTES, staging: false });
    expect(agent.jobs.map((j) => j.name).sort()).toEqual(['daily-brief', 'demoapp-tick']);
  });

  it('when the tasks cannot be listed again it says they could not be confirmed, never that they are as they were', async () => {
    const { agent, d, v2 } = await installed({ ...MANIFEST, tasks: [{ name: 'tick', every: '5m', command: ['python3', '-m', 'demo', 'tick'] }] });
    const oldTick = agent.jobs.find((j) => j.name === 'demoapp-tick')!.id;
    agent.lostRm = (id) => id === oldTick;
    agent.failListAfter = agent.lists + 1; // the sync's own list, then nothing
    const err = await installRelease(d, v2, {}).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Its scheduled tasks could not be confirmed: the list could not be read.*openclaw cron list/s);
    expect((err as Error).message).not.toMatch(/as they were/);
  });

  it('a lost reply on rollback: the release it had keeps its tasks', async () => {
    const changed = { ...MANIFEST, tasks: [{ name: 'tick', every: '5m', command: ['python3', '-m', 'demo', 'tick'] }] };
    const { agent, d, v1, v2 } = await installed(changed);
    await installRelease(d, v2, {});
    const newTick = agent.jobs.find((j) => j.name === 'demoapp-tick')!.id;
    agent.lostRm = (id) => id === newTick;
    await expect(switchTo(d, v1.manifest, v1.sha, v2.manifest)).rejects.toThrow(/Its tasks are as they were\. Still on [0-9a-f]{12}/);
    expect(agent.live().current).toBe(`releases/${v2.sha.slice(0, 12)}`);
    expect(agent.every('demoapp-tick')).toEqual(['5m']);
  });
});

describe('the app routes', () => {
  const OWNER = 'owner-1';
  async function app(appGit?: typeof hostGit) {
    const store = new Store(new Database(':memory:'));
    const provider = new FakeAgent();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p', ownerId: OWNER, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', secretRef: 'ai/p', createdAt: 'now' } as never);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Demo', slug: 'demo-agent', state: 'RUNNING', runtimeRef: 'mock://a1', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    const f = Fastify();
    await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } }, appGit } as never);
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

  /** The record and the agent agree: `current` is the recorded commit, the tasks are the recorded manifest's. */
  const agrees = (store: Store, provider: FakeAgent) => {
    const rec = store.getAgentApp('a1')!;
    const m = rec.manifest as { tasks: Array<{ name: string }> };
    expect(provider.live('mock://a1').current).toBe(`releases/${rec.sha.slice(0, 12)}`);
    expect(provider.jobs.filter((j) => j.name.startsWith('demoapp-')).map((j) => j.name).sort())
      .toEqual(m.tasks.map((t) => `demoapp-${t.name}`).sort());
    return rec;
  };

  it('an update whose task cannot be scheduled: a 400, and the record, release, config and tasks stay together', async () => {
    const { f, store, provider } = await app();
    provider.jobs = [];
    const dir = repo();
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload: { source: dir, values: { mailbox: 'demo@example.org' } } })).statusCode).toBe(200);
    const first = agrees(store, provider);
    const config = readFileSync(provider.configFile('mock://a1'), 'utf8');
    commit(dir, { ...MANIFEST, tasks: [{ name: 'tick', every: '5m', command: ['python3', '-m', 'demo', 'tick'] }, { name: 'nightly', cron: '0 3 * * *', command: ['python3', '-m', 'demo', 'nightly'] }] });
    provider.failAdd = (name) => name === 'demoapp-nightly';
    const upd = await f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: as, payload: { values: { mailbox: 'other@example.org' } } });
    expect(upd.statusCode).toBe(400);
    expect(upd.json().error).toMatch(/Could not schedule demoapp-nightly.*Its tasks are as they were.*running as before/s);
    expect(agrees(store, provider)).toEqual(first);
    expect(readFileSync(provider.configFile('mock://a1'), 'utf8')).toBe(config);
    expect(provider.every('demoapp-tick')).toEqual(['1m']);
    // Fixed, it goes through and all three agree on the new release.
    provider.failAdd = () => false;
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: as, payload: { values: { mailbox: 'other@example.org' } } })).statusCode).toBe(200);
    const now = agrees(store, provider);
    expect(now.sha).not.toBe(first.sha);
    expect(now.previousSha).toBe(first.sha);
    expect(JSON.parse(readFileSync(provider.configFile('mock://a1'), 'utf8')).mailbox).toBe('other@example.org');
    // A rollback whose tasks cannot be scheduled stays on the new release.
    provider.failAdd = (name) => name === 'demoapp-tick';
    const back = await f.inject({ method: 'POST', url: '/v1/agents/a1/app/rollback', headers: as });
    expect(back.statusCode).toBe(400);
    expect(back.json().error).toMatch(/Could not schedule demoapp-tick.*Still on/s);
    expect(agrees(store, provider)).toEqual(now);
  });

  it('another app in its place that fails: the first app keeps its record and gets its tasks back', async () => {
    const { f, store, provider } = await app();
    provider.jobs = [];
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload: { source: repo(), values: { mailbox: 'demo@example.org' } } })).statusCode).toBe(200);
    const first = agrees(store, provider);
    provider.testCode = 1;
    const other = await f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload: { source: repo({ ...MANIFEST, app: 'otherapp' }), values: { mailbox: 'demo@example.org' } } });
    expect(other.statusCode).toBe(400);
    expect(agrees(store, provider)).toEqual(first);
    expect(provider.jobs.some((j) => j.name.startsWith('otherapp-'))).toBe(false);
  });

  it('a failing test is a 400 with the output, and nothing is recorded', async () => {
    const { f, store, provider } = await app();
    provider.testCode = 1;
    const r = await f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload: { source: repo(), values: { mailbox: 'demo@example.org' } } });
    expect(r.statusCode).toBe(400);
    expect(r.json().test.output).toMatch(/FAILED/);
    expect(store.getAgentApp('a1')).toBeUndefined();
  });

  it('a new agent from a repo: checked at once, installed when it runs, a failure kept for its page', async () => {
    const { f, store, provider } = await app();
    const dir = repo();
    store.setAgentState('a1', 'STOPPED'); // not up yet
    const bad = await f.inject({ method: 'POST', url: '/v1/agents/a1/app/pending', headers: as, payload: { source: dir } });
    expect(bad.statusCode).toBe(400); // the required mailbox is missing: said before the agent is even up
    const ok = await f.inject({ method: 'POST', url: '/v1/agents/a1/app/pending', headers: as, payload: { source: dir, values: { mailbox: 'demo@example.org' } } });
    expect(ok.json()).toMatchObject({ pending: true, app: 'demoapp' });
    let got = (await f.inject({ method: 'GET', url: '/v1/agents/a1/app', headers: as })).json();
    expect(got).toMatchObject({ app: null, pending: { source: dir, error: null }, canChange: true });
    // It comes up: asking again while running installs it straight away.
    store.setAgentState('a1', 'RUNNING');
    await f.inject({ method: 'POST', url: '/v1/agents/a1/app/pending', headers: as, payload: { source: dir, values: { mailbox: 'demo@example.org' } } });
    for (let i = 0; i < 50 && !store.getAgentApp('a1'); i++) await new Promise((r) => setTimeout(r, 20));
    got = (await f.inject({ method: 'GET', url: '/v1/agents/a1/app', headers: as })).json();
    expect(got.app).toMatchObject({ app: 'demoapp' });
    expect(got.pending).toBeNull();
    // A failing install stays on the record.
    provider.testCode = 1;
    store.deleteAgentApp('a1');
    await f.inject({ method: 'POST', url: '/v1/agents/a1/app/pending', headers: as, payload: { source: dir, values: { mailbox: 'demo@example.org' } } });
    for (let i = 0; i < 50 && !store.getAppPending('a1')?.error; i++) await new Promise((r) => setTimeout(r, 20));
    expect(store.getAppPending('a1')?.error).toMatch(/tests failed/);
  });

  it('two copies of one app on one account: refused unless confirmed, and the connection list says who runs what', async () => {
    const { f, store } = await app();
    const dir = repo();
    store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Demo Two', slug: 'demo-two', state: 'RUNNING', runtimeRef: 'mock://a2', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.insertConnection({ id: 'c1', ownerId: OWNER, kind: 'google', email: 'demo@example.org', services: ['gmail'], secretRef: 's/c1' });
    store.attachConnection('a1', 'c1', false);
    store.attachConnection('a2', 'c1', false);
    const values = { mailbox: 'demo@example.org' };
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload: { source: dir, values } })).statusCode).toBe(200);
    const conns = (await f.inject({ method: 'GET', url: '/v1/connections', headers: as })).json().connections;
    expect(conns[0].attachedTo.find((x: { id: string }) => x.id === 'a1')).toMatchObject({ app: 'demoapp', state: 'RUNNING' });
    const twice = await f.inject({ method: 'POST', url: '/v1/agents/a2/app', headers: as, payload: { source: dir, values } });
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ conflict: ['Demo'] });
    expect(twice.json().error).toMatch(/already runs Demo App on the same account/);
    const pend = await f.inject({ method: 'POST', url: '/v1/agents/a2/app/pending', headers: as, payload: { source: dir, values } });
    expect(pend.statusCode).toBe(409);
    expect(store.getAppPending('a2')).toBeUndefined();
    // Another account, or a confirmation, is fine.
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a2/app', headers: as, payload: { source: dir, values: { mailbox: 'other@example.org' } } })).statusCode).toBe(200);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a2/app', headers: as, payload: { source: dir, values, allowShared: true } })).statusCode).toBe(200);
  });

  /** A fetch that waits at a gate once armed: the minutes a real one can take. */
  const gatedFetch = () => {
    let armed = false;
    let entered!: () => void;
    let letGo!: () => void;
    const inFetch = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { letGo = r; });
    const run: typeof hostGit = async (args, cwd) => { if (armed) { armed = false; entered(); await gate; } return hostGit(args, cwd); };
    return { run, arm: () => { armed = true; }, inFetch, letGo };
  };

  it('an update judges the agent and its app again once it holds the lock (2026-10-09)', async () => {
    const g = gatedFetch();
    const { f, store, provider } = await app(g.run);
    const dir = repo();
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload: { source: dir, values: { mailbox: 'demo@example.org' } } })).statusCode).toBe(200);
    const first = store.getAgentApp('a1')!;
    commit(dir);

    // Stopped while the release was fetched: nothing is installed into it.
    g.arm();
    const pending = f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: as, payload: {} });
    await g.inFetch;
    store.setAgentState('a1', 'STOPPED');
    const sent = provider.calls.length;
    g.letGo();
    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/changed while the release was fetched/);
    expect(provider.calls.length).toBe(sent);
    expect(store.getAgentApp('a1')!.sha).toBe(first.sha);
  });

  it('an update refuses when another install finished while it fetched (2026-10-09)', async () => {
    const g = gatedFetch();
    const { f, store } = await app(g.run);
    const dir = repo();
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload: { source: dir, values: { mailbox: 'demo@example.org' } } })).statusCode).toBe(200);
    commit(dir);
    g.arm();
    const pending = f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: as, payload: {} });
    await g.inFetch;
    const other = { ...store.getAgentApp('a1')!, installedAt: new Date(Date.now() + 1000).toISOString() };
    store.setAgentApp(other);
    g.letGo();
    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/app changed meanwhile/);
    expect(store.getAgentApp('a1')!.installedAt).toBe(other.installedAt);
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

// ---- durable operations (appOperations.ts): an install, update or roll back cut off by a restart ----
describe('an app change cut off by a restart (kill at every step)', () => {
  const OWNER = 'owner-1';
  const hdr = { 'x-hatchabot-owner': OWNER };
  afterEach(() => setStepHookForTests(undefined));
  const crashAt = (key: string) => setStepHookForTests((_op, k) => { if (k === key) throw new SimulatedCrash(); });
  const reboot = () => { setStepHookForTests(undefined); clearBusy('a1'); newBootForTests(); };
  async function world() {
    const store = new Store(new Database(':memory:'));
    const provider = new FakeAgent();
    provider.jobs = [];
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p', ownerId: OWNER, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', secretRef: 'ai/p', createdAt: 'now' } as never);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Demo', slug: 'demo-agent', state: 'RUNNING', runtimeRef: 'mock://a1', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    const f = Fastify();
    const routes = await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0, list: () => [] } } } as never);
    const dir = repo();
    const install = (payload: Record<string, unknown> = { source: dir, values: { mailbox: 'demo@example.org' } }) =>
      f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: hdr, payload });
    /** The record, the `current` link and the tasks say the same release. */
    const agrees = () => {
      const rec = store.getAgentApp('a1');
      const live = provider.live('mock://a1');
      expect(live.current).toBe(rec ? `releases/${rec.sha.slice(0, 12)}` : null);
      const m = rec?.manifest as { tasks: Array<{ name: string }> } | undefined;
      expect(provider.jobs.filter((j) => j.name.startsWith('demoapp-')).map((j) => j.name).sort())
        .toEqual((m?.tasks ?? []).map((t) => `demoapp-${t.name}`).sort());
      return rec;
    };
    return { store, provider, f, routes, dir, install, agrees };
  }
  const opOf = (store: Store) => store.listOperations(['a1'])[0]!;
  const SECOND = { ...MANIFEST, tasks: [{ name: 'tick', every: '5m', command: ['python3', '-m', 'demo', 'tick'] }] };

  for (const key of ['unpacked', 'configured', 'tested', 'switching', 'switched', 'tasks', '#succeeded']) {
    const before = ['unpacked', 'configured', 'tested', 'switching'].includes(key);
    it(`an update, at "${key}": ${before ? 'nothing live changed — undone' : key === '#succeeded' ? 'done' : 'held, then either choice leaves the record and the agent agreeing'}`, async () => {
      const w = await world();
      expect((await w.install()).statusCode).toBe(200);
      const first = w.agrees()!;
      const config = readFileSync(w.provider.configFile('mock://a1'), 'utf8');
      commit(w.dir, SECOND);
      crashAt(key);
      const res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: hdr, payload: { values: { mailbox: 'other@example.org' } } });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      reboot();
      await w.routes.resumeOperations();
      const op = opOf(w.store);
      expect(op.kind).toBe('app-update');
      if (before) {
        expect(op.status).toBe('rolled_back');
        expect(w.agrees()!.sha).toBe(first.sha);
        expect(readFileSync(w.provider.configFile('mock://a1'), 'utf8')).toBe(config);
        expect(w.provider.live('mock://a1').staging).toBe(false);
        return;
      }
      if (key === '#succeeded') {
        expect(op.status).toBe('succeeded');
        expect(w.agrees()!.sha).not.toBe(first.sha);
        expect(w.provider.live('mock://a1').staging).toBe(false);
        return;
      }
      expect(op.status).toBe('held');
      expect(op.recovery!.actions.map((a) => a.action)).toEqual(['use-new', 'go-back']);
      // Held: the app routes (and Start, Rebuild…) refuse with its line.
      const again = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: hdr, payload: {} });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toMatch(/interrupted by a restart/);
      // Either choice, through the API.
      const which = key === 'switched' ? 'go-back' : 'use-new';
      const rec = await w.f.inject({ method: 'POST', url: `/v1/operations/${op.id}/recover`, headers: hdr, payload: { action: which } });
      expect(rec.statusCode).toBe(200);
      const now = w.agrees()!;
      expect(w.provider.live('mock://a1').staging).toBe(false);
      if (which === 'go-back') {
        expect(rec.json().operation.status).toBe('rolled_back');
        expect(now.sha).toBe(first.sha);
        expect(readFileSync(w.provider.configFile('mock://a1'), 'utf8')).toBe(config);
      } else {
        expect(rec.json().operation.status).toBe('succeeded');
        expect(now.sha).not.toBe(first.sha);
        expect(now.previousSha).toBe(first.sha);
        expect(JSON.parse(readFileSync(w.provider.configFile('mock://a1'), 'utf8')).mailbox).toBe('other@example.org');
        expect(w.provider.every('demoapp-tick')).toEqual(['5m']);
      }
    });
  }

  for (const key of ['switching', 'tasks', '#succeeded']) {
    it(`a roll back, at "${key}"`, async () => {
      const w = await world();
      expect((await w.install()).statusCode).toBe(200);
      commit(w.dir, SECOND);
      expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: hdr, payload: {} })).statusCode).toBe(200);
      const newer = w.agrees()!;
      crashAt(key);
      await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/rollback', headers: hdr });
      reboot();
      await w.routes.resumeOperations();
      const op = opOf(w.store);
      expect(op.kind).toBe('app-rollback');
      if (key === 'switching') { expect(op.status).toBe('rolled_back'); expect(w.agrees()!.sha).toBe(newer.sha); return; }
      if (key === '#succeeded') { expect(op.status).toBe('succeeded'); expect(w.agrees()!.sha).toBe(newer.previousSha); return; }
      expect(op.status).toBe('held');
      const rec = await w.f.inject({ method: 'POST', url: `/v1/operations/${op.id}/recover`, headers: hdr, payload: { action: 'go-back' } });
      expect(rec.json().operation.status).toBe('rolled_back');
      expect(w.agrees()!.sha).toBe(newer.sha);
    });
  }

  it('a first install held after the switch: "Go back" leaves no app at all; the record never claimed one', async () => {
    const w = await world();
    crashAt('tasks');
    expect((await w.install()).statusCode).toBeGreaterThanOrEqual(500);
    reboot();
    await w.routes.resumeOperations();
    const op = opOf(w.store);
    expect(op).toMatchObject({ kind: 'app-install', status: 'held' });
    expect(w.store.getAgentApp('a1')).toBeUndefined();
    const rec = await w.f.inject({ method: 'POST', url: `/v1/operations/${op.id}/recover`, headers: hdr, payload: { action: 'go-back' } });
    expect(rec.statusCode).toBe(200);
    expect(w.agrees()).toBeUndefined();
  });

  // Issue #22 (2026-10-09): replacing an app takes the old app's tasks off
  // first. Cut off before the switch, the restart puts them back on; when that
  // failed it was swallowed and the operation said "nothing changed".
  it('replacing an app, cut off at "unpacked", and the old tasks cannot go back on: held with a retry, not "nothing changed"', async () => {
    const w = await world();
    expect((await w.install()).statusCode).toBe(200);
    const first = w.agrees()!;
    expect(w.provider.jobs.map((j) => j.name)).toEqual(['demoapp-tick']);
    crashAt('unpacked');
    const other = await w.install({ source: repo({ ...MANIFEST, app: 'otherapp' }), values: { mailbox: 'demo@example.org' }, allowShared: true });
    expect(other.statusCode).toBeGreaterThanOrEqual(500);
    expect(w.provider.jobs.filter((j) => j.name.startsWith('demoapp-'))).toEqual([]); // taken off before the unpack
    reboot();
    w.provider.failAdd = (n) => n === 'demoapp-tick';
    await w.routes.resumeOperations();
    const op = opOf(w.store);
    expect(op).toMatchObject({ kind: 'app-install', status: 'held' });
    expect(op.outcome).not.toMatch(/nothing changed/);
    expect(op.outcome).toMatch(/demoapp-tick/);
    expect(op.recovery!.actions).toEqual([{ action: 'put-tasks-back', label: 'Put its scheduled tasks back' }]);
    expect(w.store.getAgentApp('a1')!.sha).toBe(first.sha);
    // The guard holds: no other app change while its tasks are missing.
    const again = await w.install();
    expect(again.statusCode).toBe(409);
    // Still failing: refused, still held, says what is missing.
    const still = await w.f.inject({ method: 'POST', url: `/v1/operations/${op.id}/recover`, headers: hdr, payload: { action: 'put-tasks-back' } });
    expect(still.statusCode).toBeGreaterThanOrEqual(400);
    expect(still.json().error).toMatch(/demoapp-tick/);
    expect(opOf(w.store).status).toBe('held');
    // Cron works again: the retry puts them back, confirmed, and only then rolled back.
    w.provider.failAdd = () => false;
    const ok = await w.f.inject({ method: 'POST', url: `/v1/operations/${op.id}/recover`, headers: hdr, payload: { action: 'put-tasks-back' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().operation.status).toBe('rolled_back');
    expect(w.agrees()!.sha).toBe(first.sha);
    expect(w.provider.live('mock://a1').staging).toBe(false);
    expect((await w.install()).statusCode).toBe(200);
  });

  it('an app waiting for its new agent goes in after a restart (there was no boot sweep)', async () => {
    const w = await world();
    w.store.setAppPending('a1', { source: w.dir, ref: 'HEAD', values: { mailbox: 'demo@example.org' } });
    await w.routes.resumeOperations();
    expect(w.store.getAppPending('a1')).toBeUndefined();
    expect(w.agrees()!.app).toBe('demoapp');
    expect(opOf(w.store)).toMatchObject({ kind: 'app-install', status: 'succeeded' });
  }); it('failed go-back preserves candidate config for a subsequent use-new', async () => {
  const w = await world();
  try {
   expect((await w.install()).statusCode).toBe(200);
   commit(w.dir, SECOND);
   crashAt('switched');
   await w.f.inject({method:'POST',url:'/v1/agents/a1/app/update',headers:hdr,payload:{values:{mailbox:'candidate@example.org'}}});
   reboot(); await w.routes.resumeOperations();
   const op = opOf(w.store);
   expect(op.status).toBe('held');
   expect(JSON.parse(readFileSync(w.provider.configFile('mock://a1'),'utf8')).mailbox).toBe('candidate@example.org');
   w.provider.failAdd = () => true;
   const back = await w.f.inject({method:'POST',url:`/v1/operations/${op.id}/recover`,headers:hdr,payload:{action:'go-back'}});
   expect(back.statusCode).toBeGreaterThanOrEqual(400);
   expect(w.store.getOperation(op.id)!.status).toBe('held');
   w.provider.failAdd = () => false;
   const forward = await w.f.inject({method:'POST',url:`/v1/operations/${op.id}/recover`,headers:hdr,payload:{action:'use-new'}});
   expect(forward.statusCode).toBe(200);
   expect(w.store.getOperation(op.id)!.status).toBe('succeeded');
   expect(w.agrees()!.sha).toBe(op.params.toSha);
   expect(w.provider.every('demoapp-tick')).toEqual(['5m']);
   expect(JSON.parse(readFileSync(w.provider.configFile('mock://a1'),'utf8')).mailbox).toBe('candidate@example.org');
  } finally {setStepHookForTests(undefined); await w.f.close();}
 }); it.each(['unreadable-list','failed-removal'])('app removal retains its record when tasks cannot be removed: %s', async failure => {
  const w=await world();
  try {
   expect((await w.install()).statusCode).toBe(200);
   expect(w.provider.jobs.some(j=>j.name==='demoapp-tick')).toBe(true);
   if(failure==='unreadable-list') w.provider.failListAfter=0;
   else w.provider.failRm=()=>true;
   const removed=await w.f.inject({method:'DELETE',url:'/v1/agents/a1/app',headers:hdr});
   expect(removed.statusCode).toBeGreaterThanOrEqual(400);
   expect(w.store.getAgentApp('a1')).toBeDefined();
   expect(w.provider.jobs.some(j=>j.name==='demoapp-tick')).toBe(true);
   w.provider.failListAfter=Infinity; w.provider.failRm=()=>false;
   const retry=await w.f.inject({method:'DELETE',url:'/v1/agents/a1/app',headers:hdr});
   expect(retry.statusCode).toBe(200);
  } finally {await w.f.close();}
 });
 it('replacing an app refuses when old tasks remain',async()=>{
  const w=await world();
  try {
   expect((await w.install()).statusCode).toBe(200);
   w.provider.failRm=()=>true;
   const replaced=await w.install({source:repo({...MANIFEST,app:'otherapp'}),values:{mailbox:'demo@example.org'},allowShared:true});
   expect(replaced.statusCode).toBeGreaterThanOrEqual(400);
   expect(w.store.getAgentApp('a1')!.app).toBe('demoapp');
   expect(w.provider.jobs.map(j=>j.name).sort()).toEqual(['demoapp-tick']);
  } finally {await w.f.close();}
 });
  it('app removal reconciles a lost response after the task was actually removed', async () => {
    const w = await world();
    try {
      expect((await w.install()).statusCode).toBe(200);
      w.provider.lostRm = () => true;
      const r = await w.f.inject({ method: 'DELETE', url: '/v1/agents/a1/app', headers: hdr });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ removed: true, tasks: 1 });
      expect(w.store.getAgentApp('a1')).toBeUndefined();
      expect(w.provider.jobs).toEqual([]);
    } finally { await w.f.close(); }
  });

});
