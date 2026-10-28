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
import { resolvePendingValues, stashPendingSecrets } from '../src/orchestrator/appPending.js';
import {
  AppError, fieldsToAsk, hostGit, installRelease, manifestAt, mergeConfig, parseManifest, parseSource, removeTasks, repoFor, resolveRelease, switchTo, type AgentFacts,
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
  /** A disabled job is listed only with `--all`, as OpenClaw does; a job of the agent's own may have no name. */
  jobs: Array<{ id: string; name: string; argv?: string[]; disabled?: boolean }> = [{ id: 'old1', name: 'demoapp-tick' }, { id: 'keep', name: 'daily-brief' }];
  testCode = 0;
  /** What the app's tests print (default: unittest's last line). */
  testOutput?: string;
  /** The config file the app's tests found in their {data_dir}. */
  testSaw: string[] = [];
  failAdd: (name: string) => boolean = () => false;
  /** A `cron add` (by name) whose call rejects outright (the daemon gone), rather than answering an error. */
  throwAdd: (name: string) => boolean = () => false;
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
    if (argv[0] === 'cron' && argv[1] === 'list') return { code: 0, stdout: JSON.stringify({ jobs: this.jobs.filter((j) => argv.includes('--all') || !j.disabled).map(({ id, name, disabled }) => ({ id, name, enabled: !disabled })) }), stderr: '' };
    if (argv[0] === 'cron' && argv[1] === 'add') {
      const name = argv[argv.indexOf('--name') + 1]!;
      if (this.throwAdd(name)) throw new Error('provider unavailable');
      if (this.failAdd(name)) return { code: 1, stdout: '', stderr: 'gateway refused the job' };
      const id = `j${this.#next++}`;
      this.jobs.push({ id, name, argv, ...(argv.includes('--disabled') ? { disabled: true } : {}) });
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
      return { code: this.testCode, stdout: this.testOutput ?? (this.testCode ? 'FAILED (failures=1)' : 'OK'), stderr: '' };
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

  it("a secret setting's value printed by failing tests is masked in the error and the kept output (HB-0052)", async () => {
    const withKey = { ...MANIFEST, config: { fields: [...MANIFEST.config.fields, { key: 'feed_code', type: 'text', required: true, secret: true }] } };
    const r = await resolveRelease(hostGit, repo(withKey), 'HEAD');
    const agent = new FakeAgent();
    agent.testCode = 1;
    agent.testOutput = 'calling with demo-key-not-real-0042\n{"feed_code": "demo-key-not-real-0042"}\nFAILED (failures=1)';
    const e = (await installRelease({ provider: agent, runtimeRef: 'x', facts: FACTS }, r, { mailbox: 'demo@example.org', feed_code: 'demo-key-not-real-0042' })
      .catch((x: unknown) => x)) as Error & { test?: { output: string } };
    expect(e.message).toMatch(/tests failed/);
    expect(e.message).not.toContain('demo-key-not-real');
    expect(e.message).toContain('calling with ••••••');
    expect(e.test!.output).not.toContain('demo-key-not-real');
    // A value kept from the live config (an update that gives none) is masked too.
    agent.testCode = 0; agent.testOutput = 'OK';
    await installRelease({ provider: agent, runtimeRef: 'x', facts: FACTS }, r, { mailbox: 'demo@example.org', feed_code: 'demo-key-not-real-0042' });
    agent.testCode = 1; agent.testOutput = 'still demo-key-not-real-0042';
    const again = (await installRelease({ provider: agent, runtimeRef: 'x', facts: FACTS }, r, {}).catch((x: unknown) => x)) as Error;
    expect(again.message).toContain('still ••••••');
  });

  it('a required value missing stops it before anything runs', async () => {
    const agent = new FakeAgent();
    await expect(installRelease({ provider: agent, runtimeRef: 'x', facts: FACTS }, await rel())).rejects.toThrow(/Needs a value for: mailbox/);
    expect(agent.calls.some((c) => c.what.includes('unittest'))).toBe(false);
  });

  it('says which fields it needs, so the page can ask for them (final audit, 2026-10-22)', async () => {
    const e = await installRelease({ provider: new FakeAgent(), runtimeRef: 'x', facts: FACTS }, await rel()).catch((x: unknown) => x);
    expect((e as { needs?: unknown }).needs).toEqual([expect.objectContaining({ key: 'mailbox' })]);
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

  it('a failed update puts a task the owner had turned off back turned off, and says so when it cannot (audit #016)', async () => {
    const changed = { ...MANIFEST, tasks: [{ name: 'tick', every: '5m', command: ['python3', '-m', 'demo', 'tick'] }] };
    const { agent, d, v2 } = await installed(changed);
    const oldTick = agent.jobs.find((j) => j.name === 'demoapp-tick')!;
    oldTick.disabled = true;
    agent.lostRm = (id) => id === oldTick.id; // taken off, its reply lost: the put-back re-adds it
    await expect(installRelease(d, v2, {})).rejects.toThrow(/Its tasks are as they were\./);
    expect(agent.jobs.filter((j) => j.name === 'demoapp-tick').map((j) => ({ every: j.argv?.[j.argv.indexOf('--every') + 1], disabled: j.disabled === true })))
      .toEqual([{ every: '1m', disabled: true }]);
    // An agent that re-adds it switched on all the same is never "as they were".
    const again = await installed(changed);
    const tick = again.agent.jobs.find((j) => j.name === 'demoapp-tick')!;
    tick.disabled = true;
    again.agent.lostRm = (id) => id === tick.id;
    const exec = again.agent.exec.bind(again.agent);
    again.agent.exec = (ref: string, argv: string[]) => exec(ref, argv.filter((a) => a !== '--disabled'));
    const err = await installRelease(again.d, v2, {}).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/switched on, though you had turned it off: demoapp-tick/);
    expect((err as Error).message).not.toMatch(/as they were/);
  });
});

describe('the app routes', () => {
  const OWNER = 'owner-1';
  async function app(appGit?: typeof hostGit, secrets: { put(r: string, v: string): Promise<void>; get(r: string): Promise<string>; delete(r: string): Promise<void> } = { put: async () => {}, get: async () => 'x', delete: async () => {} }) {
    const store = new Store(new Database(':memory:'));
    const provider = new FakeAgent();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p', ownerId: OWNER, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', secretRef: 'ai/p', createdAt: 'now' } as never);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Demo', slug: 'demo-agent', state: 'RUNNING', runtimeRef: 'mock://a1', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    const f = Fastify();
    const routes = await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } }, appGit } as never);
    return { f, store, provider, routes };
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

  it('values that are not an object of settings are refused on install, pending and update (HB-0064)', async () => {
    const { f, store, provider } = await app();
    const dir = repo();
    for (const values of ['mailbox=demo@example.org', ['demo@example.org'], 42]) {
      for (const url of ['/v1/agents/a1/app', '/v1/agents/a1/app/pending', '/v1/agents/a1/app/update']) {
        const r = await f.inject({ method: 'POST', url, headers: as, payload: { source: dir, values } });
        expect(r.statusCode, `${url} ${JSON.stringify(values)}`).toBe(400);
        expect(r.json().error).toMatch(/values must be an object/);
      }
    }
    expect(store.getAgentApp('a1')).toBeUndefined();
    expect(store.getAppPending('a1')).toBeUndefined();
    expect(provider.calls).toEqual([]);
  });

  it('an update whose source now names another app is refused; the old app, its record and its tasks stay (audit #012)', async () => {
    const { f, store, provider } = await app();
    provider.jobs = [];
    const dir = repo();
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload: { source: dir, values: { mailbox: 'demo@example.org' } } })).statusCode).toBe(200);
    const before = store.getAgentApp('a1')!;
    commit(dir, { ...MANIFEST, app: 'otherapp', name: 'Other App' });
    const upd = await f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: as, payload: {} });
    expect(upd.statusCode).toBe(409);
    expect(upd.json()).toMatchObject({ unchanged: true });
    expect(upd.json().error).toMatch(/another app \(otherapp, not demoapp\).*install it again/);
    expect(store.getAgentApp('a1')).toEqual(before);
    expect(provider.jobs.map((j) => j.name)).toEqual(['demoapp-tick']);
    // Installed from the same source instead, it replaces demoapp: one app's tasks, one record.
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload: { source: dir, values: { mailbox: 'demo@example.org' } } })).statusCode).toBe(200);
    expect(store.getAgentApp('a1')).toMatchObject({ app: 'otherapp', manifest: { app: 'otherapp' } });
    expect(provider.jobs.map((j) => j.name)).toEqual(['otherapp-tick']);
    // Stopping it takes its tasks off; nothing of demoapp is left running.
    expect((await f.inject({ method: 'DELETE', url: '/v1/agents/a1/app', headers: as })).statusCode).toBe(200);
    expect(provider.jobs).toEqual([]);
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

  it('a waiting app keeps its secret values in the secret store, and they go when it goes in or the agent goes (2026-10-10)', async () => {
    const kept = new Map<string, string>();
    const secrets = {
      put: async (r: string, v: string) => { kept.set(r, v); },
      get: async (r: string) => { const v = kept.get(r); if (v === undefined) throw new Error('missing'); return v; },
      delete: async (r: string) => { kept.delete(r); },
    };
    const { f, store, provider } = await app(undefined, secrets);
    const PASSWORD = 'made-up-app-password';
    const withSecret = { ...MANIFEST, config: { fields: [...MANIFEST.config.fields, { key: 'app_password', type: 'text', required: true, secret: true }] } };
    const dir = repo(withSecret);
    store.setAgentState('a1', 'STOPPED');
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/app/pending', headers: as, payload: { source: dir, values: { mailbox: 'demo@example.org', app_password: PASSWORD } } });
    expect(res.statusCode).toBe(200);
    // The database row names where it is, never what it is.
    const row = (store as unknown as { db: Database.Database }).db.prepare(`SELECT vals FROM agent_app_pending WHERE agent_id = 'a1'`).get() as { vals: string };
    expect(row.vals).not.toContain(PASSWORD);
    expect(row.vals).toContain('demo@example.org');
    expect([...kept.values()].some((v) => v.includes(PASSWORD))).toBe(true);
    // A failed install keeps it waiting, and its secret with it.
    provider.testCode = 1;
    store.setAgentState('a1', 'RUNNING');
    await f.inject({ method: 'POST', url: '/v1/agents/a1/app/pending', headers: as, payload: {} });
    for (let i = 0; i < 50 && !store.getAppPending('a1')?.error; i++) await new Promise((r) => setTimeout(r, 20));
    expect(store.getAppPending('a1')?.error).toMatch(/tests failed/);
    expect(kept.size).toBe(1);
    // It goes in: the app's config has the value; the row and the secret are gone.
    provider.testCode = 0;
    await f.inject({ method: 'POST', url: '/v1/agents/a1/app/pending', headers: as, payload: {} });
    for (let i = 0; i < 50 && !store.getAgentApp('a1'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(provider.live('mock://a1').config!)).toMatchObject({ app_password: PASSWORD });
    for (let i = 0; i < 50 && store.getAppPending('a1'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(store.getAppPending('a1')).toBeUndefined();
    expect(kept.size).toBe(0);
    // A second agent whose install never went in is deleted: nothing is left of it.
    store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Demo Two', slug: 'demo-two', state: 'STOPPED', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    await f.inject({ method: 'POST', url: '/v1/agents/a2/app/pending', headers: as, payload: { source: dir, values: { mailbox: 'other@example.org', app_password: PASSWORD } } });
    expect(kept.size).toBe(1);
    const del = await f.inject({ method: 'DELETE', url: '/v1/agents/a2', headers: as });
    expect(del.statusCode).toBe(200);
    expect(store.getAppPending('a2')).toBeUndefined();
    expect(kept.size).toBe(0);
  });

  it('a waiting app from before v2.160.0 has its plain-text secret moved to the secret store at boot', async () => {
    const kept = new Map<string, string>();
    const secrets = {
      put: async (r: string, v: string) => { kept.set(r, v); },
      get: async (r: string) => { const v = kept.get(r); if (v === undefined) throw new Error('missing'); return v; },
      delete: async (r: string) => { kept.delete(r); },
    };
    const { store, routes } = await app(undefined, secrets);
    const PASSWORD = 'made-up-old-app-password';
    const withSecret = { ...MANIFEST, config: { fields: [...MANIFEST.config.fields, { key: 'app_password', type: 'text', required: true, secret: true }] } };
    const dir = repo(withSecret);
    store.setAgentState('a1', 'STOPPED');
    // As the old release wrote it: every value in the row, a failure on it.
    store.setAppPending('a1', { source: dir, ref: 'HEAD', values: { mailbox: 'demo@example.org', app_password: PASSWORD, __allowShared: true } });
    store.setAppPendingError('a1', 'tests failed');
    const since = store.getAppPending('a1')!.createdAt;
    // One whose repo isn't on this machine (no mirror of the address): its manifest can't be known.
    store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Demo Two', slug: 'demo-two', state: 'STOPPED', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.setAppPending('a2', { source: 'https://example.org/demo-app.git', ref: 'HEAD', values: { mailbox: 'other@example.org', app_password: PASSWORD } });
    const rowOf = (id: string) => ((store as unknown as { db: Database.Database }).db.prepare(`SELECT vals FROM agent_app_pending WHERE agent_id = ?`).get(id) as { vals: string }).vals;
    const a2Before = rowOf('a2');

    await routes.stashOldPendingSecrets();
    expect(rowOf('a1')).not.toContain(PASSWORD);
    expect(JSON.parse(rowOf('a1'))).toEqual({ mailbox: 'demo@example.org', app_password: { $secretRef: 'app-pending/a1/app_password' }, __allowShared: true });
    expect(kept.get('app-pending/a1/app_password')).toBe(JSON.stringify(PASSWORD));
    expect(store.getAppPending('a1')).toMatchObject({ error: 'tests failed', createdAt: since });
    // The install reads it back as it went in.
    expect(await resolvePendingValues(secrets, 'a1', store.getAppPending('a1')!.values)).toMatchObject({ app_password: PASSWORD, mailbox: 'demo@example.org' });
    // Left alone, and tried again next boot.
    expect(rowOf('a2')).toBe(a2Before);
    expect(store.storeMigrationDone('2026-10-11-app-pending-secrets')).toBe(false);
    // Once every row is settled, it is recorded and runs no more; a repeat changes nothing.
    store.deleteAppPending('a2');
    await routes.stashOldPendingSecrets();
    expect(store.storeMigrationDone('2026-10-11-app-pending-secrets')).toBe(true);
    expect(kept.size).toBe(1);
  });

  it('a waiting value made to look like a secret reference reads nothing (2026-10-10)', async () => {
    const kept = new Map([['ai/p', 'made-up-key'], ['app-pending/a1/mailbox', '"demo@example.org"']]);
    const secrets = { put: async () => {}, get: async (r: string) => kept.get(r)!, delete: async () => {} };
    const got = await resolvePendingValues(secrets, 'a1', { mode: { $secretRef: 'ai/p' }, mailbox: { $secretRef: 'app-pending/a1/mailbox' } });
    expect(got).toEqual({ mailbox: 'demo@example.org' });
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

  it('the same check on the config it would run with: a default mailbox, an update to another mailbox (2026-10-10)', async () => {
    const { f, store } = await app();
    store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Demo Two', slug: 'demo-two', state: 'RUNNING', runtimeRef: 'mock://a2', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.insertAgent({ id: 'a3', ownerId: OWNER, name: 'Demo Three', slug: 'demo-three', state: 'STOPPED', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.insertConnection({ id: 'c1', ownerId: OWNER, kind: 'google', email: 'demo@example.org', services: ['gmail'], secretRef: 's/c1' });
    for (const id of ['a1', 'a2', 'a3']) store.attachConnection(id, 'c1', false);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload: { source: repo(), values: { mailbox: 'demo@example.org' } } })).statusCode).toBe(200);
    // A manifest whose mailbox defaults to the shared one: nothing given, still the same account.
    const byDefault = repo({ ...MANIFEST, config: { fields: [{ key: 'mailbox', type: 'email', default: 'demo@example.org' }, { key: 'mode', default: 'shadow' }] } });
    const install = await f.inject({ method: 'POST', url: '/v1/agents/a2/app', headers: as, payload: { source: byDefault } });
    expect(install.statusCode).toBe(409);
    expect(install.json()).toMatchObject({ conflict: ['Demo'] });
    expect(store.getAgentApp('a2')).toBeUndefined();
    const pend = await f.inject({ method: 'POST', url: '/v1/agents/a3/app/pending', headers: as, payload: { source: byDefault } });
    expect(pend.statusCode).toBe(409);
    expect(store.getAppPending('a3')).toBeUndefined();
    // On another mailbox it goes in; an update that moves it onto the shared one is refused, unless confirmed.
    const dir = repo();
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a2/app', headers: as, payload: { source: dir, values: { mailbox: 'other@example.org' } } })).statusCode).toBe(200);
    const moved = await f.inject({ method: 'POST', url: '/v1/agents/a2/app/update', headers: as, payload: { values: { mailbox: 'demo@example.org' } } });
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({ conflict: ['Demo'] });
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a2/app/update', headers: as, payload: { values: { mailbox: 'demo@example.org' }, allowShared: true } })).statusCode).toBe(200);
    // Confirmed once, it stays allowed: a later update with nothing new about the mailbox is not refused.
    commit(dir);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a2/app/update', headers: as, payload: {} })).statusCode).toBe(200);
  });

  it('two installs of one app on one account at the same time: one goes in, the other is refused (2026-10-10)', async () => {
    const { f, store, provider } = await app();
    store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Demo Two', slug: 'demo-two', state: 'RUNNING', runtimeRef: 'mock://a2', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.insertConnection({ id: 'c1', ownerId: OWNER, kind: 'google', email: 'demo@example.org', services: ['gmail'], secretRef: 's/c1' });
    store.attachConnection('a1', 'c1', false);
    store.attachConnection('a2', 'c1', false);
    // The first one's tests are held: the second runs meanwhile, as far as it may.
    let letGo!: () => void, firstIn!: () => void, secondIn!: () => void;
    const gate = new Promise<void>((r) => { letGo = r; });
    const inFirst = new Promise<void>((r) => { firstIn = r; });
    const inSecond = new Promise<void>((r) => { secondIn = r; });
    const shell = provider.execShell.bind(provider);
    provider.execShell = async (ref: string, script: string) => {
      if (script.includes('unittest')) { if (ref === 'mock://a1') { firstIn(); await gate; } else secondIn(); }
      return shell(ref, script);
    };
    const payload = { source: repo(), values: { mailbox: 'demo@example.org' } };
    const first = f.inject({ method: 'POST', url: '/v1/agents/a1/app', headers: as, payload });
    await inFirst;
    const second = f.inject({ method: 'POST', url: '/v1/agents/a2/app', headers: as, payload });
    await Promise.race([inSecond, new Promise((r) => setTimeout(r, 1500))]);
    letGo();
    const both = await Promise.all([first, second]);
    expect(both.map((r) => r.statusCode)).toEqual([200, 409]);
    expect([store.getAgentApp('a1'), store.getAgentApp('a2')].filter(Boolean)).toHaveLength(1);
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

  it('a roll back held after its tasks went on, then "Stay on" the newer: a task the newer renamed comes off too (regression audit, 2026-10-22)', async () => {
    const w = await world();
    expect((await w.install()).statusCode).toBe(200);
    commit(w.dir, { ...MANIFEST, tasks: [{ name: 'tock', every: '5m', command: ['python3', '-m', 'demo', 'tock'] }] });
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: hdr, payload: {} })).statusCode).toBe(200);
    const newer = w.agrees()!;
    crashAt('tasks');
    await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/rollback', headers: hdr });
    reboot();
    await w.routes.resumeOperations();
    const op = opOf(w.store);
    expect(op).toMatchObject({ kind: 'app-rollback', status: 'held' });
    expect(w.provider.jobs.map((j) => j.name)).toContain('demoapp-tick');
    const rec = await w.f.inject({ method: 'POST', url: `/v1/operations/${op.id}/recover`, headers: hdr, payload: { action: 'go-back' } });
    expect(rec.json().operation.status).toBe('rolled_back');
    expect(w.agrees()!.sha).toBe(newer.sha); // only demoapp-tock: the older release's demoapp-tick is gone
  });

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

  // #120 (workflow audit, 2026-10-10): new values on the commit already running.
  // The record and the link say that commit throughout, so they alone said "done".
  it('new values on the running commit, cut off at the switch: undone, not "done" over a config still staged (#120)', async () => {
    const w = await world();
    try {
      expect((await w.install()).statusCode).toBe(200);
      const first = w.agrees()!;
      const config = readFileSync(w.provider.configFile('mock://a1'), 'utf8');
      // The process dies as the switch is about to run: the step is recorded, the new config still staged.
      const shell = w.provider.execShell.bind(w.provider);
      w.provider.execShell = async (ref: string, script: string) => {
        if (script.includes('mv -T current.new current') && script.includes('mv -f')) throw new SimulatedCrash();
        return shell(ref, script);
      };
      const res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: hdr, payload: { values: { mailbox: 'other@example.org' } } });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      w.provider.execShell = shell;
      reboot();
      await w.routes.resumeOperations();
      const op = opOf(w.store);
      expect(op).toMatchObject({ kind: 'app-update', status: 'rolled_back' });
      expect(op.outcome).toMatch(/nothing changed/);
      expect(readFileSync(w.provider.configFile('mock://a1'), 'utf8')).toBe(config);
      expect(w.provider.live('mock://a1').staging).toBe(false);
      expect(w.agrees()!.sha).toBe(first.sha);
    } finally { setStepHookForTests(undefined); await w.f.close(); }
  });

  it('new values on the running commit, cut off once the config was moved in: held, and "Use the new release" finishes it (#120)', async () => {
    const w = await world();
    try {
      expect((await w.install()).statusCode).toBe(200);
      const first = w.agrees()!;
      crashAt('switched');
      await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: hdr, payload: { values: { mailbox: 'other@example.org' } } });
      reboot();
      await w.routes.resumeOperations();
      const op = opOf(w.store);
      expect(op).toMatchObject({ kind: 'app-update', status: 'held' });
      const rec = await w.f.inject({ method: 'POST', url: `/v1/operations/${op.id}/recover`, headers: hdr, payload: { action: 'use-new' } });
      expect(rec.json().operation.status).toBe('succeeded');
      const now = w.agrees()!;
      expect(now.sha).toBe(first.sha);
      expect(now.previousSha).toBeUndefined(); // the same commit is not "the one before"
      expect(JSON.parse(readFileSync(w.provider.configFile('mock://a1'), 'utf8')).mailbox).toBe('other@example.org');
      expect(w.provider.live('mock://a1').staging).toBe(false);
    } finally { setStepHookForTests(undefined); await w.f.close(); }
  });

  it('a sync cut off part way leaves a task twice: not called done (#120)', async () => {
    const w = await world();
    try {
      expect((await w.install()).statusCode).toBe(200);
      commit(w.dir, SECOND);
      crashAt('#succeeded');
      await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: hdr, payload: {} });
      w.provider.jobs.push({ id: 'dup', name: 'demoapp-tick' });
      reboot();
      await w.routes.resumeOperations();
      expect(opOf(w.store).status).toBe('held');
    } finally { setStepHookForTests(undefined); await w.f.close(); }
  });

  // #106, #97 (workflow audit, 2026-10-10): the put-back after a failed switch fails too.
  it('an update whose put-back fails keeps its staging folder, is held for a choice, and never says "unchanged" (#106 #97)', async () => {
    const w = await world();
    try {
      expect((await w.install()).statusCode).toBe(200);
      const first = w.agrees()!;
      const config = readFileSync(w.provider.configFile('mock://a1'), 'utf8');
      commit(w.dir, SECOND);
      w.provider.failAdd = (n) => n === 'demoapp-tick'; // its task cannot be scheduled…
      w.provider.breakScript = (s) => (s.startsWith('rc=0;') ? s.replace('ln -sfn', 'false && ln -sfn') : s); // …and `current` will not go back
      const res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: hdr, payload: { values: { mailbox: 'other@example.org' } } });
      w.provider.failAdd = () => false;
      w.provider.breakScript = (s) => s;
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ held: true, unchanged: false });
      expect(res.json().error).toMatch(/back failed too.*waits for your choice/s);
      const op = opOf(w.store);
      expect(op).toMatchObject({ kind: 'app-update', status: 'held' });
      expect(op.recovery!.actions.map((a) => a.action)).toEqual(['use-new', 'go-back']);
      // What a recovery needs is still there: the new config, staged again.
      const to = String(op.params.toSha).slice(0, 12);
      expect(JSON.parse(readFileSync(join(w.provider.root('mock://a1'), `demoapp/staging/${to}/config.json`), 'utf8')).mailbox).toBe('other@example.org');
      // Held: nothing else changes the app meanwhile.
      expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: hdr, payload: {} })).statusCode).toBe(409);
      const back = await w.f.inject({ method: 'POST', url: `/v1/operations/${op.id}/recover`, headers: hdr, payload: { action: 'go-back' } });
      expect(back.json().operation.status).toBe('rolled_back');
      expect(w.agrees()!.sha).toBe(first.sha);
      expect(readFileSync(w.provider.configFile('mock://a1'), 'utf8')).toBe(config);
      expect(w.provider.live('mock://a1').staging).toBe(false);
    } finally { await w.f.close(); }
  });

  it('…and "Use the new release" after it gets the new config (#106)', async () => {
    const w = await world();
    try {
      expect((await w.install()).statusCode).toBe(200);
      commit(w.dir, SECOND);
      w.provider.failAdd = (n) => n === 'demoapp-tick';
      w.provider.breakScript = (s) => (s.startsWith('rc=0;') ? s.replace('ln -sfn', 'false && ln -sfn') : s);
      await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: hdr, payload: { values: { mailbox: 'other@example.org' } } });
      w.provider.failAdd = () => false;
      w.provider.breakScript = (s) => s;
      const op = opOf(w.store);
      const fwd = await w.f.inject({ method: 'POST', url: `/v1/operations/${op.id}/recover`, headers: hdr, payload: { action: 'use-new' } });
      expect(fwd.json().operation.status).toBe('succeeded');
      expect(w.agrees()!.sha).toBe(op.params.toSha);
      expect(JSON.parse(readFileSync(w.provider.configFile('mock://a1'), 'utf8')).mailbox).toBe('other@example.org');
      expect(w.provider.every('demoapp-tick')).toEqual(['5m']);
    } finally { await w.f.close(); }
  });

  it('a failure before the switch, or one put back whole, says the running version is unchanged (#97)', async () => {
    const w = await world();
    try {
      expect((await w.install()).statusCode).toBe(200);
      commit(w.dir, SECOND);
      w.provider.testCode = 1;
      const tests = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: hdr, payload: {} });
      expect(tests.json()).toMatchObject({ unchanged: true });
      w.provider.testCode = 0;
      w.provider.failAdd = (n) => n === 'demoapp-tick';
      const tasks = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: hdr, payload: {} });
      expect(tasks.json()).toMatchObject({ unchanged: true });
      expect(tasks.json().held).toBeUndefined();
    } finally { await w.f.close(); }
  });

});

// ---- the Apps in agents audit of 2026-10-27: waiting installs, replacement and roll back ----
describe('apps: what the 2026-10-27 audit found (waiting installs, replacing, rolling back)', () => {
  const OWNER = 'owner-1';
  const hdr = { 'x-hatchabot-owner': OWNER };
  afterEach(() => { setStepHookForTests(undefined); clearBusy('a1'); });
  /** A fetch that waits at a gate once armed (`only`: just the fetch whose arguments name it). */
  const gated = () => {
    let armed: string | undefined;
    let entered!: () => void;
    let letGo!: () => void;
    const inFetch = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { letGo = r; });
    const run: typeof hostGit = async (args, cwd) => {
      if (armed !== undefined && (!armed || args.includes(armed))) { armed = undefined; entered(); await gate; }
      return hostGit(args, cwd);
    };
    return { run, arm: (only = '') => { armed = only; }, inFetch, letGo };
  };
  async function world(appGit?: typeof hostGit, state = 'RUNNING') {
    const store = new Store(new Database(':memory:'));
    const provider = new FakeAgent();
    provider.jobs = [];
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p', ownerId: OWNER, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', secretRef: 'ai/p', createdAt: 'now' } as never);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Demo', slug: 'demo-agent', state, runtimeRef: 'mock://a1', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    const f = Fastify();
    const routes = await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0, list: () => [] } }, appGit } as never);
    const dir = repo();
    const post = (suffix: string, source?: string) =>
      f.inject({ method: 'POST', url: `/v1/agents/a1/app${suffix}`, headers: hdr, payload: { ...(source ? { source } : {}), values: { mailbox: 'demo@example.org' } } });
    return { store, provider, f, routes, dir, post };
  }
  const until = async (ok: () => boolean) => {
    for (let n = 0; n < 300; n++) { if (ok()) return; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('did not settle');
  };
  const names = (p: FakeAgent) => p.jobs.map((j) => j.name).sort();

  it('a request to install saved while an earlier one runs goes in after it, and is not deleted by it (HB-0256)', async () => {
    const w = await world();
    const other = repo({ ...MANIFEST, app: 'otherapp' });
    let entered!: () => void, letGo!: () => void;
    const inTests = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { letGo = r; });
    const shell = w.provider.execShell.bind(w.provider);
    let first = true;
    w.provider.execShell = async (ref: string, script: string) => {
      if (script.includes('unittest') && first) { first = false; entered(); await gate; }
      return shell(ref, script);
    };
    expect((await w.post('/pending', w.dir)).statusCode).toBe(200);
    await inTests;
    expect((await w.post('/pending', other)).statusCode).toBe(200);
    letGo();
    await until(() => w.store.getAgentApp('a1')?.app === 'otherapp' && !w.store.getAppPending('a1'));
    expect(names(w.provider)).toEqual(['otherapp-tick']);
    expect(w.store.listOperations(['a1']).map((o) => o.status)).toEqual(['succeeded', 'succeeded']);
    await w.f.close();
  });

  it("an earlier request that fails leaves its error off the newer one, which still goes in (HB-0256)", async () => {
    const w = await world();
    const other = repo({ ...MANIFEST, app: 'otherapp' });
    let entered!: () => void, letGo!: () => void;
    const inTests = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { letGo = r; });
    const shell = w.provider.execShell.bind(w.provider);
    let first = true;
    w.provider.execShell = async (ref: string, script: string) => {
      if (script.includes('unittest') && first) { first = false; entered(); await gate; return { code: 1, stdout: 'FAILED (failures=1)', stderr: '' }; }
      return shell(ref, script);
    };
    expect((await w.post('/pending', w.dir)).statusCode).toBe(200);
    await inTests;
    expect((await w.post('/pending', other)).statusCode).toBe(200);
    letGo();
    await until(() => w.store.getAgentApp('a1')?.app === 'otherapp' && !w.store.getAppPending('a1'));
    expect(names(w.provider)).toEqual(['otherapp-tick']);
    await w.f.close();
  });

  it('a direct install retires the waiting request, and Stop app is not undone at the next start (HB-0252)', async () => {
    const w = await world();
    w.store.setAgentState('a1', 'STOPPED');
    expect((await w.post('/pending', w.dir)).statusCode).toBe(200);
    w.store.setAgentState('a1', 'RUNNING');
    expect((await w.post('', w.dir)).statusCode).toBe(200);
    expect(w.store.getAppPending('a1')).toBeUndefined();
    // One left by an earlier version goes with Stop app.
    w.store.setAppPending('a1', { source: w.dir, ref: 'HEAD', values: { mailbox: 'demo@example.org' } });
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/agents/a1/app', headers: hdr })).statusCode).toBe(200);
    expect(w.store.getAppPending('a1')).toBeUndefined();
    await w.routes.resumeOperations();
    expect(w.store.getAgentApp('a1')).toBeUndefined();
    expect(w.provider.jobs).toEqual([]);
    await w.f.close();
  });

  it('setup that finishes while the request reads its source: the App goes in without a restart (HB-0255)', async () => {
    const g = gated();
    const w = await world(g.run, 'PROVISIONING');
    g.arm();
    const req = w.post('/pending', w.dir);
    await g.inFetch;
    w.store.setAgentState('a1', 'RUNNING');
    g.letGo();
    expect((await req).statusCode).toBe(200);
    await until(() => w.store.getAgentApp('a1')?.app === 'demoapp' && !w.store.getAppPending('a1'));
    expect(names(w.provider)).toEqual(['demoapp-tick']);
    await w.f.close();
  });

  it('an older install slow to read its source is refused once a newer one went in (HB-0264)', async () => {
    const g = gated();
    const w = await world(g.run);
    const older = repo({ ...MANIFEST, app: 'olderapp' });
    const newer = repo({ ...MANIFEST, app: 'newerapp' });
    g.arm(older);
    const old = w.post('', older);
    await g.inFetch;
    expect((await w.post('', newer)).statusCode).toBe(200);
    g.letGo();
    const res = await old;
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ unchanged: true });
    expect(res.json().error).toMatch(/app changed meanwhile/);
    expect(w.store.getAgentApp('a1')!.app).toBe('newerapp');
    expect(names(w.provider)).toEqual(['newerapp-tick']);
    await w.f.close();
  });

  it('a replacement that fails puts back a task the owner had turned off turned off (HB-0253)', async () => {
    const w = await world();
    expect((await w.post('', w.dir)).statusCode).toBe(200);
    w.provider.jobs.find((j) => j.name === 'demoapp-tick')!.disabled = true;
    w.provider.testCode = 1;
    const res = await w.post('', repo({ ...MANIFEST, app: 'replacementapp' }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ unchanged: true });
    expect(w.provider.jobs.filter((j) => j.name === 'demoapp-tick').map((j) => j.disabled === true)).toEqual([true]);
    expect(w.store.listOperations(['a1'])[0]!.params).toMatchObject({ fromApp: 'demoapp', fromAppOff: ['demoapp-tick'] });
    await w.f.close();
  });

  it('…and after a restart that cut the replacement off, from what the operation recorded (HB-0253)', async () => {
    const w = await world();
    expect((await w.post('', w.dir)).statusCode).toBe(200);
    w.provider.jobs.find((j) => j.name === 'demoapp-tick')!.disabled = true;
    setStepHookForTests((_op, k) => { if (k === 'unpacked') throw new SimulatedCrash(); });
    await w.post('', repo({ ...MANIFEST, app: 'replacementapp' })).catch(() => undefined);
    expect(w.provider.jobs.filter((j) => j.name === 'demoapp-tick')).toEqual([]);
    setStepHookForTests(undefined); clearBusy('a1'); newBootForTests();
    await w.routes.resumeOperations();
    const op = w.store.listOperations(['a1']).find((o) => o.params.app === 'replacementapp')!;
    expect(op.status).toBe('rolled_back');
    expect(w.provider.jobs.filter((j) => j.name === 'demoapp-tick').map((j) => j.disabled === true)).toEqual([true]);
    await w.f.close();
  });

  /** Installed, then updated to a second release whose task runs every 5 minutes. */
  const twoReleases = async () => {
    const w = await world();
    expect((await w.post('', w.dir)).statusCode).toBe(200);
    const first = w.store.getAgentApp('a1')!;
    commit(w.dir, { ...MANIFEST, tasks: [{ name: 'tick', every: '5m', command: ['python3', '-m', 'demo', 'tick'] }] });
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/update', headers: hdr, payload: {} })).statusCode).toBe(200);
    const newer = w.store.getAgentApp('a1')!;
    const rollback = () => w.f.inject({ method: 'POST', url: '/v1/agents/a1/app/rollback', headers: hdr });
    const op = () => w.store.listOperations(['a1']).find((o) => o.kind === 'app-rollback')!;
    return { ...w, first, newer, rollback, op };
  };

  it('a roll back whose switch landed but whose reply was lost goes on from what the link says (HB-0254)', async () => {
    const w = await twoReleases();
    const shell = w.provider.execShell.bind(w.provider);
    let lost = false;
    w.provider.execShell = async (ref: string, script: string) => {
      const r = await shell(ref, script);
      if (!lost && script.includes(`test -d releases/${w.first.sha.slice(0, 12)}`)) { lost = true; return { code: 1, stdout: '', stderr: 'reply lost', timedOut: true }; }
      return r;
    };
    expect((await w.rollback()).statusCode).toBe(200);
    expect(w.provider.live('mock://a1').current).toBe(`releases/${w.first.sha.slice(0, 12)}`);
    expect(w.provider.every('demoapp-tick')).toEqual(['1m']);
    expect(w.store.getAgentApp('a1')!.sha).toBe(w.first.sha);
    expect(w.op().status).toBe('succeeded');
    await w.f.close();
  });

  it('a roll back whose switch did not land changes nothing and says so (HB-0254)', async () => {
    const w = await twoReleases();
    w.provider.breakScript = (s) => (s.includes(`test -d releases/${w.first.sha.slice(0, 12)}`) ? 'exit 1' : s);
    const res = await w.rollback();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ unchanged: true });
    expect(w.provider.live('mock://a1').current).toBe(`releases/${w.newer.sha.slice(0, 12)}`);
    expect(w.provider.every('demoapp-tick')).toEqual(['5m']);
    expect(w.op().status).toBe('failed');
    await w.f.close();
  });

  it('a roll back that can neither set its tasks nor point back is held for a choice, and either choice makes it agree (HB-0254)', async () => {
    for (const action of ['go-back', 'use-new'] as const) {
      const w = await twoReleases();
      w.provider.failAdd = () => true;
      w.provider.breakScript = (s) => (s.includes(`ln -sfn 'releases/${w.newer.sha.slice(0, 12)}'`) ? 'exit 1' : s);
      const res = await w.rollback();
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ held: true, unchanged: false });
      expect(w.provider.live('mock://a1').current).toBe(`releases/${w.first.sha.slice(0, 12)}`);
      expect(w.op()).toMatchObject({ status: 'held' });
      expect(w.op().recovery!.actions.map((a) => a.action)).toEqual(['use-new', 'go-back']);
      w.provider.failAdd = () => false;
      w.provider.breakScript = (s) => s;
      const rec = await w.f.inject({ method: 'POST', url: `/v1/operations/${w.op().id}/recover`, headers: hdr, payload: { action } });
      expect(rec.statusCode).toBe(200);
      const want = action === 'go-back' ? w.newer : w.first;
      expect(w.store.getAgentApp('a1')!.sha).toBe(want.sha);
      expect(w.provider.live('mock://a1').current).toBe(`releases/${want.sha.slice(0, 12)}`);
      expect(w.provider.every('demoapp-tick')).toEqual([action === 'go-back' ? '5m' : '1m']);
      await w.f.close();
    }
  });
});

// ---- the workflow audit of 2026-10-10 (issues #73–#121) ----
describe('apps: what the 2026-10-10 workflow audit found', () => {
  const d = (agent: FakeAgent) => ({ provider: agent, runtimeRef: 'x', facts: FACTS });

  it('a manifest names each task and each config key once (#75 #104)', () => {
    const tick = MANIFEST.tasks[0]!;
    expect(() => parseManifest(JSON.stringify({ ...MANIFEST, tasks: [tick, { ...tick, every: '5m' }] }))).toThrow(/tasks: two tasks are named "tick"/);
    const fields = [...MANIFEST.config.fields, { key: 'mailbox', from: 'owner.email' }];
    expect(() => parseManifest(JSON.stringify({ ...MANIFEST, config: { fields } }))).toThrow(/config\.fields: two fields have the key "mailbox"/);
    expect(parseManifest(JSON.stringify(MANIFEST)).tasks).toHaveLength(1);
  });

  const TYPED = parseManifest(JSON.stringify({ ...MANIFEST, config: { fields: [
    ...MANIFEST.config.fields,
    { key: 'filter', label: 'only mail from', type: 'text' },
    { key: 'labels', type: 'list' },
    { key: 'max_per_day', type: 'number' },
    { key: 'wait_minutes', type: 'number', required: true, default: 15 },
    { key: 'dry_run', type: 'bool' },
    { key: 'owner_telegram', from: 'owner.telegram', required: true },
  ] } }));

  it('an optional value given as empty clears it; left out, it is kept (#76)', () => {
    const had = { mailbox: 'kept@example.org', filter: 'from:school', labels: ['a'], max_per_day: 5, wait_minutes: 30 };
    const { config } = mergeConfig(TYPED, FACTS, had, { filter: '', labels: '', max_per_day: ' ', wait_minutes: '' });
    expect(config).toMatchObject({ mailbox: 'kept@example.org', filter: '', labels: [], max_per_day: null });
    expect(config.wait_minutes).toBe(30); // a required one is not cleared: it keeps what it has
    expect(mergeConfig(TYPED, FACTS, had, {}).config).toMatchObject({ filter: 'from:school', labels: ['a'], max_per_day: 5 });
  });

  it('a value not of its field\'s type is refused, never written as null (#77)', () => {
    expect(() => mergeConfig(TYPED, FACTS, {}, { mailbox: 'demo@example.org', max_per_day: 'abc' })).toThrow(/max_per_day must be a number \(got "abc"\)/);
    expect(() => mergeConfig(TYPED, FACTS, {}, { mailbox: 'demo@example.org', dry_run: 'maybe' })).toThrow(/dry_run must be true or false/);
    expect(() => mergeConfig(TYPED, FACTS, {}, { mailbox: 'not an address' })).toThrow(/mailbox must be an email address/);
    expect(() => mergeConfig(TYPED, FACTS, {}, { mailbox: 'demo@example.org', max_per_day: { $gt: 1 } })).toThrow(/max_per_day must be a number/);
    const ok = mergeConfig(TYPED, FACTS, {}, { mailbox: 'demo@example.org', max_per_day: ' 12 ', dry_run: 'off', labels: 'a, b' }).config;
    expect(ok).toMatchObject({ max_per_day: 12, dry_run: false, labels: ['a', 'b'] });
    expect(JSON.parse(JSON.stringify(ok)).max_per_day).toBe(12);
  });

  it('a required field Hatchabot fills, with nothing to fill it with, stops the install (#78)', async () => {
    const noTelegram = { ...FACTS, ownerTelegram: undefined };
    expect(mergeConfig(TYPED, noTelegram, {}, { mailbox: 'demo@example.org' }).unfilled).toEqual(['owner_telegram (its owner has not linked a Telegram account (Settings → You))']);
    expect(mergeConfig(TYPED, FACTS, {}, { mailbox: 'demo@example.org' }).unfilled).toEqual([]);
    const agent = new FakeAgent();
    const rel = await resolveRelease(hostGit, repo({ ...MANIFEST, config: { fields: [...MANIFEST.config.fields, { key: 'owner_telegram', from: 'owner.telegram', required: true }] } }), 'HEAD');
    await expect(installRelease({ ...d(agent), facts: noTelegram }, rel, { mailbox: 'demo@example.org' })).rejects.toThrow(/nothing to fill owner_telegram/);
    expect(agent.calls.some((c) => c.what.includes('unittest'))).toBe(false);
    expect(agent.live().config).toBeNull();
  });

  it('a disabled task of the app is seen: Update replaces it and Stop app takes it off (#73)', async () => {
    const { agent, v2 } = await v1AndV2();
    agent.jobs.find((j) => j.name === 'demoapp-tick')!.disabled = true;
    await installRelease(d(agent), v2, {});
    expect(agent.every('demoapp-tick')).toEqual(['5m']); // not the old one beside it
    // …and still turned off, as the owner left it (HB-0229).
    expect(agent.jobs.filter((j) => j.name === 'demoapp-tick').map((j) => j.disabled === true)).toEqual([true]);
    agent.jobs.find((j) => j.name === 'demoapp-tick')!.disabled = true;
    expect(await removeTasks(d(agent), 'demoapp', v2.manifest)).toBe(1);
    expect(agent.jobs.filter((j) => j.name.startsWith('demoapp-'))).toEqual([]);
  });

  it('a job of the agent\'s own with no name does not block the app (#74)', async () => {
    const agent = new FakeAgent();
    agent.jobs = [{ id: 'own1' } as never, { id: 'keep', name: 'daily-brief' }];
    const done = await installRelease(d(agent), await resolveRelease(hostGit, repo(), 'HEAD'), { mailbox: 'demo@example.org' });
    expect(done.tasks).toEqual(['demoapp-tick']);
    expect(agent.jobs.map((j) => j.id)).toEqual(expect.arrayContaining(['own1', 'keep']));
    // One of the app's own without an id is still refused: it could not be taken off.
    agent.jobs.push({ name: 'demoapp-tick' } as never);
    await expect(removeTasks(d(agent), 'demoapp', parseManifest(JSON.stringify(MANIFEST)))).rejects.toThrow(/incomplete or malformed/);
  });

  it('a task of the owner\'s whose name starts like the app\'s is not the app\'s: install, update and Stop app leave it (audit, 2026-10-20)', async () => {
    const { agent, v2 } = await v1AndV2();
    // The owner's own task, and another app's, both named "demoapp-…".
    agent.jobs.push({ id: 'own', name: 'demoapp-digest' }, { id: 'other', name: 'demoapp-extra-tick' });
    await installRelease(d(agent), v2, {});
    expect(agent.every('demoapp-tick')).toEqual(['5m']);
    expect(await removeTasks(d(agent), 'demoapp', v2.manifest)).toBe(1);
    expect(agent.jobs.map((j) => j.id).sort()).toEqual(['other', 'own']);
  });

  it('a change of values on the same commit keeps the live release folder (#92)', async () => {
    const dir = repo();
    const agent = new FakeAgent();
    agent.jobs = [];
    const v1 = await resolveRelease(hostGit, dir, 'HEAD');
    await installRelease(d(agent), v1, { mailbox: 'first@example.org' });
    const live = join(agent.root('x'), `demoapp/releases/${v1.sha.slice(0, 12)}`);
    writeFileSync(join(live, 'built-by-its-tests.txt'), 'kept');
    // While its tests run, the code it is running from is still there.
    let duringTests = false;
    const shell = agent.execShell.bind(agent);
    agent.execShell = async (ref: string, script: string) => {
      if (script.includes('unittest')) duringTests = existsSync(join(live, 'built-by-its-tests.txt'));
      return shell(ref, script);
    };
    await installRelease(d(agent), v1, { mailbox: 'second@example.org' });
    expect(duringTests).toBe(true);
    expect(readFileSync(join(live, 'built-by-its-tests.txt'), 'utf8')).toBe('kept');
    expect(agent.live().current).toBe(`releases/${v1.sha.slice(0, 12)}`);
    expect(JSON.parse(agent.live().config!).mailbox).toBe('second@example.org');
    expect(agent.calls.filter((c) => c.kind === 'write' && c.what.includes('tar -x'))).toHaveLength(1);
  });

  /** v1 installed with the owner's own settings, and a v2 commit (with one task on another schedule) ready. */
  async function v1AndV2() {
    const dir = repo();
    const agent = new FakeAgent();
    agent.jobs = [];
    const v1 = await resolveRelease(hostGit, dir, 'HEAD');
    await installRelease(d(agent), v1, { mailbox: 'first@example.org', mode: 'live' });
    commit(dir, { ...MANIFEST, tasks: [{ name: 'tick', every: '5m', command: ['python3', '-m', 'demo', 'tick'] }] });
    return { agent, v1, v2: await resolveRelease(hostGit, dir, 'HEAD'), before: agent.live() };
  }

  it('the live link that cannot be read is not "no release": nothing is changed, and `current` is never removed (#103)', async () => {
    const { agent, v2, before } = await v1AndV2();
    agent.breakScript = (s) => (s.includes('readlink') ? 'echo "Input/output error" >&2; exit 1' : s);
    agent.failAdd = () => true; // a later failure would "put back" what it read
    await expect(installRelease(d(agent), v2, {})).rejects.toThrow(/Could not tell which release of demoapp is live \(Input\/output error\)/);
    agent.breakScript = (s) => s;
    expect(agent.live()).toEqual(before);
  });

  it('a config that cannot be read stops it: the defaults are never written over the owner\'s settings (#105)', async () => {
    const { agent, v2, before } = await v1AndV2();
    agent.breakScript = (s) => (s.includes('cat ') && s.includes('data/config.json') && !s.includes('cat >') ? 'echo "Permission denied" >&2; exit 1' : s);
    // The mailbox given again, as the dialog would: the rest (its mode) would have gone back to the default.
    await expect(installRelease(d(agent), v2, { mailbox: 'first@example.org' })).rejects.toThrow(/Could not read .*config\.json in the agent \(Permission denied\)/);
    agent.breakScript = (s) => s;
    expect(agent.live()).toEqual(before);
    expect(JSON.parse(before.config!)).toMatchObject({ mailbox: 'first@example.org', mode: 'live' });
  });
});

describe('apps: what the 2026-10-23 review found', () => {
  const d = (agent: FakeAgent) => ({ provider: agent, runtimeRef: 'x', facts: FACTS });
  const withFields = (fields: unknown[]) => parseManifest(JSON.stringify({ ...MANIFEST, config: { fields } }));

  it('a required list given as [] is asked for, as "" is for text (R03)', () => {
    const m = withFields([{ key: 'recipients', type: 'list', required: true, label: 'who gets it' }]);
    const r = mergeConfig(m, FACTS, {}, { recipients: [] });
    expect(r.missing).toEqual(['recipients (who gets it)']);
    expect(r.missingKeys).toEqual(['recipients']);
    expect(Object.hasOwn(r.config, 'recipients')).toBe(false);
    expect(mergeConfig(m, FACTS, {}, { recipients: ['a@example.org'] })).toMatchObject({ config: { recipients: ['a@example.org'] }, missing: [] });
  });

  it("a kept value is held to its field's type now: one the new type refuses is asked for again, an optional one cleared, a secret kept (R04)", () => {
    const m = withFields([{ key: 'count', type: 'number', required: true }, { key: 'limit', type: 'number' }, { key: 'token', type: 'text', secret: true }]);
    const r = mergeConfig(m, FACTS, { count: 'not-a-number', limit: 'abc', token: 'ref:app-token/1' }, {});
    expect(r.missing).toEqual(['count']);
    expect(r.missingKeys).toEqual(['count']);
    expect(r.config).toEqual({ limit: null, token: 'ref:app-token/1' });
    // A kept value the type takes is written as that type ("12" under a number field is 12).
    expect(mergeConfig(m, FACTS, { count: ' 12 ', limit: 3, token: 't' }, {})).toMatchObject({ config: { count: 12, limit: 3 }, missing: [] });
  });

  it('a field keyed "__proto__" is refused when the manifest is read (R13)', () => {
    expect(() => withFields([{ key: '__proto__', type: 'text', required: true }])).toThrow(/config\.fields\.0\.key: a field cannot be keyed "__proto__"/);
  });

  it('a scheduling call that rejects outright (the daemon gone) is a failed call: the jobs already made come off again (R05)', async () => {
    const agent = new FakeAgent();
    agent.jobs = [{ id: 'keep', name: 'daily-brief' }];
    agent.throwAdd = (name) => name === 'demoapp-two';
    const rel = await resolveRelease(hostGit, repo({ ...MANIFEST, tasks: [{ name: 'tick', every: '5m', command: ['true'] }, { name: 'two', every: '1h', command: ['true'] }] }), 'HEAD');
    await expect(installRelease(d(agent), rel, { mailbox: 'demo@example.org' }))
      .rejects.toThrow(/Could not schedule demoapp-two: provider unavailable.*Its tasks are as they were/s);
    expect(agent.live()).toEqual({ current: null, config: null, tasks: [], staging: false });
    expect(agent.jobs).toEqual([{ id: 'keep', name: 'daily-brief' }]);
  });
});

describe('apps: what the 2026-10-22 review found', () => {
  const d = (agent: FakeAgent) => ({ provider: agent, runtimeRef: 'x', facts: FACTS });
  const withFields = (fields: unknown[]) => parseManifest(JSON.stringify({ ...MANIFEST, config: { fields } }));

  it('a required field keyed like an Object method is asked for, not read from Object (A27)', () => {
    const m = withFields([{ key: 'constructor', required: true }]);
    expect(mergeConfig(m, FACTS, {}, {}).missing).toEqual(['constructor']);
    expect(mergeConfig(m, FACTS, { constructor: 'kept' }, {})).toMatchObject({ config: { constructor: 'kept' }, missing: [] });
  });

  it('a field made required asks again for a value left blank while it was optional (A28)', () => {
    const m = withFields([{ key: 'mailbox', label: 'its address', type: 'email', required: true }, { key: 'tags', type: 'list', required: true, default: ['a'] }]);
    const { config, missing } = mergeConfig(m, FACTS, { mailbox: ' ', tags: [] }, {});
    expect(missing).toEqual(['mailbox (its address)']);
    expect(config.tags).toEqual(['a']);
    // A blank default is no value: a required field with one is asked for too.
    expect(mergeConfig(withFields([{ key: 'mailbox', type: 'email', required: true, default: '' }]), FACTS, { mailbox: '' }, {}).missing).toEqual(['mailbox']);
    expect(mergeConfig(withFields([{ key: 'mailbox', type: 'email', required: true, default: '' }]), FACTS, {}, {}).missing).toEqual(['mailbox']);
    // An optional one keeps its blank, as before.
    expect(mergeConfig(withFields([{ key: 'mailbox', type: 'email' }]), FACTS, { mailbox: '' }, {}).config.mailbox).toBe('');
  });

  it("a default is held to its field's type (A52)", () => {
    expect(() => mergeConfig(withFields([{ key: 'per_day', type: 'number', default: 'lots' }]), FACTS, {}, {}))
      .toThrow(/the app's default for per_day is not a number \("lots"; its hatchabot\.json needs fixing\)/);
    expect(mergeConfig(withFields([{ key: 'per_day', type: 'number', default: '5' }, { key: 'dry', type: 'bool', default: 'yes' }, { key: 'note', type: 'number', default: '' }]), FACTS, {}, {}).config)
      .toMatchObject({ per_day: 5, dry: true, note: '' });
    // A value given is what counts: the bad default is never read.
    expect(mergeConfig(withFields([{ key: 'per_day', type: 'number', default: 'lots' }]), FACTS, {}, { per_day: '3' }).config.per_day).toBe(3);
  });

  it("the same commit's failed tests leave its live folder as it was (A44)", async () => {
    const dir = repo();
    const agent = new FakeAgent();
    agent.jobs = [];
    const v1 = await resolveRelease(hostGit, dir, 'HEAD');
    await installRelease(d(agent), v1, { mailbox: 'first@example.org' });
    const live = join(agent.root('x'), `demoapp/releases/${v1.sha.slice(0, 12)}`);
    writeFileSync(join(live, 'built.txt'), 'before');
    const shell = agent.execShell.bind(agent);
    let sawBuilt = '';
    agent.execShell = async (ref: string, script: string) => {
      if (!script.includes('unittest')) return shell(ref, script);
      // The test writes where it runs, then fails.
      const at = /^cd '([^']*)'/.exec(script)![1]!.split(APPS).join(agent.root(ref));
      sawBuilt = readFileSync(join(at, 'built.txt'), 'utf8');
      writeFileSync(join(at, 'built.txt'), 'changed by a failing test');
      return { code: 1, stdout: 'FAILED (failures=1)', stderr: '' };
    };
    const e = await installRelease(d(agent), v1, { mailbox: 'second@example.org' }).then(() => new Error('installed'), (x: unknown) => x) as Error & { unchanged?: boolean };
    expect(e.message).toMatch(/Its tests failed/);
    expect(e.unchanged).toBe(true);
    expect(sawBuilt).toBe('before');                                   // what it built before came along
    expect(readFileSync(join(live, 'built.txt'), 'utf8')).toBe('before');
    expect(JSON.parse(agent.live().config!).mailbox).toBe('first@example.org');
    expect(agent.live().staging).toBe(false);                          // the copy went with the staging folder
  });

  it("a mirror follows the repo's default branch when it is renamed (A47)", async () => {
    const src = repo();
    const cache = mkdtempSync(join(tmpdir(), 'hb-appcache-'));
    tmp.push(cache);
    const first = await manifestAt(hostGit, await repoFor(hostGit, { kind: 'git', url: src }, cache), 'HEAD');
    gitIn(src, 'branch', '-m', 'main', 'trunk');
    commit(src);
    const mirror = await repoFor(hostGit, { kind: 'git', url: src }, cache);
    const now = await manifestAt(hostGit, mirror, 'HEAD');
    expect(now.sha).not.toBe(first.sha);
    expect(now.sha).toBe(gitIn(src, 'rev-parse', 'HEAD').toString().trim());
  });

  it('waiting secret values are stored all or none (B29)', async () => {
    const kept = new Map<string, string>();
    let puts = 0;
    const secrets = {
      put: async (r: string, v: string) => { if (++puts === 2) throw new Error('disk full'); kept.set(r, v); },
      get: async (r: string) => kept.get(r)!, delete: async (r: string) => { kept.delete(r); },
    };
    const m = withFields([{ key: 'app_password', secret: true }, { key: 'api_key', secret: true }]);
    await expect(stashPendingSecrets(secrets, 'a1', m, { app_password: 'made-up-one', api_key: 'made-up-two' })).rejects.toThrow(/disk full/);
    expect([...kept.keys()]).toEqual([]);
  });

  it("replacing a waiting install that fails part way keeps the waiting one's secrets (final audit, 2026-10-22)", async () => {
    const { SecretNotFoundError } = await import('../src/secrets/secretStore.js');
    const kept = new Map<string, string>([['app-pending/a1/app_password', JSON.stringify('the-old-one')]]);
    let puts = 0;
    const secrets = {
      put: async (r: string, v: string) => { if (++puts === 2) throw new Error('disk full'); kept.set(r, v); },
      get: async (r: string) => { if (!kept.has(r)) throw new SecretNotFoundError(r); return kept.get(r)!; },
      delete: async (r: string) => { kept.delete(r); },
    };
    const m = withFields([{ key: 'app_password', secret: true }, { key: 'api_key', secret: true }]);
    await expect(stashPendingSecrets(secrets, 'a1', m, { app_password: 'made-up-new', api_key: 'made-up-two' })).rejects.toThrow(/disk full/);
    expect([...kept]).toEqual([['app-pending/a1/app_password', JSON.stringify('the-old-one')]]);
  });
});
