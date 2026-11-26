/**
 * End-to-end coverage of the OpenClaw import routes: discovery (matching an
 * already-imported agent by bot-token id), adopt-workspace carrying the source
 * agent's crons, and the external-data-folder scan. OpenClaw's config + state DB
 * are faked under temp paths via OPENCLAW_CONFIG / OPENCLAW_STATE_DB.
 *
 * The `quiesce` route is intentionally NOT exercised here — it runs
 * `systemctl restart openclaw-gateway` for real; its logic is covered in
 * openclawImport.test.ts with an injected restart.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWorld, seedRunningAgent, as, type World } from './support/world.js';
import { WORKSPACE_DIR_TEMPLATE } from '../src/openclaw/configWriter.js';
import { CORE_FILES_WAIT_MS } from '../src/orchestrator/files/coreFileTurns.js';
import { parseTemplate } from '../src/orchestrator/transfer/template.js';
import { moveAgentToHost } from '../src/orchestrator/transfer/moveHost.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { markBusy } from '../src/orchestrator/lifecycle/busy.js';

const tmp = mkdtempSync(join(tmpdir(), 'acl-adopt-'));
const cfgPath = join(tmp, 'openclaw.json');
const dbPath = join(tmp, 'state.sqlite');
const wsTech = join(tmp, 'workspace-tech'); // inspect allows /tmp
const wsFresh = join(tmp, 'workspace-fresh');
// The external data folder, in a root of its own in the temp folder, not
// under the checkout: the scan leaves out a path with a hidden folder on the
// way, and a checkout in an agent's worktree (.claude/worktrees) has one
// (HB-0817).
const repoTmp = mkdtempSync(join(tmpdir(), 'acl-adopt-data-'));
const dataDir = join(repoTmp, 'condo-docs');
// The temp folder is a system tree the scan excludes too: the route's scan
// keeps every system prefix but the one the fixtures are under.
vi.mock('../src/orchestrator/transfer/dataPaths.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/orchestrator/transfer/dataPaths.js')>();
  const here = `${(await import('node:os')).tmpdir()}/acl-adopt-data-`;
  const prefixes = real.SYSTEM_PREFIXES.filter((s) => !here.startsWith(`${s}/`));
  return { ...real, scanWorkspacePaths: (ws: string) => real.scanWorkspacePaths(ws, prefixes) };
});

const prevCfg = process.env.OPENCLAW_CONFIG;
const prevDb = process.env.OPENCLAW_STATE_DB;

beforeAll(() => {
  process.env.OPENCLAW_CONFIG = cfgPath;
  process.env.OPENCLAW_STATE_DB = dbPath;

  for (const ws of [wsTech, wsFresh]) {
    mkdirSync(join(ws, 'memory'), { recursive: true });
    writeFileSync(join(ws, 'SOUL.md'), 'You are helpful.');
    writeFileSync(join(ws, 'AGENTS.md'), '# agents');
    writeFileSync(join(ws, 'MEMORY.md'), '# memory');
  }
  // wsTech's SOUL references an external data folder → a scan candidate.
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(wsTech, 'SOUL.md'), `You read board documents from ${dataDir}.`);

  writeFileSync(
    cfgPath,
    JSON.stringify({
      agents: { list: [{ id: 'tech', workspace: wsTech }, { id: 'fresh', workspace: wsFresh }] },
      bindings: [
        { agentId: 'tech', match: { channel: 'telegram', accountId: 'techbot' } },
        { agentId: 'fresh', match: { channel: 'telegram', accountId: 'freshbot' } },
      ],
      channels: {
        telegram: {
          accounts: {
            techbot: { botToken: '111:aaa', enabled: true, allowFrom: ['999'] },
            freshbot: { botToken: '222:bbb', enabled: true },
          },
        },
      },
    }),
  );

  const db = new Database(dbPath);
  db.exec(`CREATE TABLE cron_jobs (agent_id TEXT, name TEXT, description TEXT, schedule_kind TEXT,
    schedule_expr TEXT, schedule_tz TEXT, every_ms INTEGER, at TEXT, payload_kind TEXT,
    payload_message TEXT, sort_order INTEGER, created_at_ms INTEGER)`);
  db.prepare(`INSERT INTO cron_jobs (agent_id,name,schedule_kind,schedule_expr,payload_kind,payload_message,sort_order,created_at_ms)
              VALUES ('tech','Daily brief','cron','0 8 * * *','agentTurn','Write the brief',0,1)`).run();
  db.close();
});

afterAll(() => {
  if (prevCfg === undefined) delete process.env.OPENCLAW_CONFIG; else process.env.OPENCLAW_CONFIG = prevCfg;
  if (prevDb === undefined) delete process.env.OPENCLAW_STATE_DB; else process.env.OPENCLAW_STATE_DB = prevDb;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(repoTmp, { recursive: true, force: true });
});

describe('Discovery — GET /v1/openclaw/agents', () => {
  it('lists agents with their bot, and matches an already-imported one by bot-id', async () => {
    const w = await makeWorld();
    // A Hatchabot agent already on techbot's bot (same id 111, different token).
    await seedRunningAgent(w, { id: 'a1', name: 'Garden Advisor', slug: 'garden-adv', accountId: 'GardenAdvisorBot', botToken: '111:zzz' });

    const res = await w.f.inject({ method: 'GET', url: '/v1/openclaw/agents', headers: as() });
    expect(res.statusCode).toBe(200);
    const by = Object.fromEntries(res.json().agents.map((a: any) => [a.id, a]));
    expect(by['tech'].bot).toMatchObject({ accountId: 'techbot', enabledInSource: true });
    expect(by['tech'].alreadyAdoptedAs).toBe('Garden Advisor'); // matched by bot id 111
    expect(by['fresh'].alreadyAdoptedAs).toBeUndefined(); // not imported
  });

  it('is refused to a non-host-owner (403)', async () => {
    const w = await makeWorld();
    const res = await w.f.inject({ method: 'GET', url: '/v1/openclaw/agents', headers: as('intruder') });
    expect(res.statusCode).toBe(403);
  });
});

describe('Adopt workspace — POST /v1/agents/:id/adopt-workspace', () => {
  it('copies the workspace and carries the source agent\'s crons (disabled)', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', slug: 'garden-adv' });

    const res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/adopt-workspace', headers: as(), payload: { path: wsTech } });
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toBeGreaterThan(0);
    expect(res.json().crons).toEqual({ total: 1, carried: 1, failed: 0 });

    // the cron was actually recreated in the container, disabled
    const add = w.provider.execLog.find((a) => a[0] === 'cron' && a[1] === 'add');
    expect(add).toBeDefined();
    expect(add).toContain('--disabled');
  });
});

describe('Adopt into a stopped agent (review 2026-10-22, A39)', () => {
  it('keeps the deferred tasks, and carries them once the agent is running', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', slug: 'garden-adv' });
    await w.provider.stop(w.store.getAgent('a1')!.runtimeRef!);
    w.store.setAgentState('a1', 'STOPPED');

    const res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/adopt-workspace', headers: as(), payload: { path: wsTech } });
    expect(res.statusCode).toBe(200);
    expect(res.json().crons).toMatchObject({ total: 1, carried: 0, deferred: 1 });
    expect(w.store.listAdoptPending()).toMatchObject([{ agentId: 'a1', path: wsTech }]);
    const quick = (w.f as unknown as { quickCronRetarget: () => Promise<void> }).quickCronRetarget;
    await quick();   // still stopped: it waits
    expect(w.provider.execLog.find((a) => a[0] === 'cron' && a[1] === 'add')).toBeUndefined();
    expect(w.store.listAdoptPending()).toHaveLength(1);

    await w.provider.start(w.store.getAgent('a1')!.runtimeRef!);
    w.store.setAgentState('a1', 'RUNNING');
    await quick();
    const add = w.provider.execLog.find((a) => a[0] === 'cron' && a[1] === 'add');
    expect(add).toContain('--disabled');
    expect(w.store.listAdoptPending()).toEqual([]);
    expect(w.store.listEvents(['a1']).map((e) => e.event)).toContain('adopt.deferred_done');
  });

  // Final audit, 2026-10-22.
  it('the pass skips an adopt a newer one replaced while it was busy with another agent', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', slug: 'garden-adv' });
    // The pass read its list before the newer adopt dropped this row.
    const real = w.store.listAdoptPending.bind(w.store);
    let first = true;
    w.store.listAdoptPending = () => (first ? ((first = false), [{ agentId: 'a1', path: wsTech, at: new Date().toISOString() }]) : real());
    const quick = (w.f as unknown as { quickCronRetarget: () => Promise<void> }).quickCronRetarget;
    await quick();
    expect(w.provider.execLog.find((a) => a[0] === 'cron' && a[1] === 'add')).toBeUndefined();
    expect(w.store.listEvents(['a1']).map((e) => e.event)).not.toContain('adopt.deferred_done');
  });

  const cronLists = (w: { provider: { execLog: string[][] } }) => w.provider.execLog.filter((a) => a[0] === 'cron' && a[1] === 'list').length;
  const stoppedThenAdopted = async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', slug: 'garden-adv' });
    await w.provider.stop(w.store.getAgent('a1')!.runtimeRef!);
    w.store.setAgentState('a1', 'STOPPED');
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/adopt-workspace', headers: as(), payload: { path: wsTech } })).statusCode).toBe(200);
    return w;
  };
  const started = async (w: Awaited<ReturnType<typeof makeWorld>>) => {
    await w.provider.start(w.store.getAgent('a1')!.runtimeRef!);
    w.store.setAgentState('a1', 'RUNNING');
  };
  const passOf = (w: Awaited<ReturnType<typeof makeWorld>>) => async () => {
    const pass = (w.f as unknown as { quickCronRetarget: () => Promise<void> }).quickCronRetarget();
    await vi.advanceTimersByTimeAsync(60_000);
    await pass;
  };

  it("a gateway that does not answer yet keeps the deferred adopt: one look outside the busy guard, again within the hour", async () => {
    const w = await stoppedThenAdopted();
    await started(w);
    w.provider.execResponses.set('cron list', { code: 1, stdout: '', stderr: 'gateway not ready' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-22T10:00:00.000Z'));
      const pass = passOf(w);
      const before = cronLists(w);
      await pass();
      expect(cronLists(w) - before).toBe(1);   // not a readiness poll of minutes, holding the agent busy
      expect(w.store.listAdoptPending()).toHaveLength(1);
      expect(w.store.listEvents(['a1']).map((e) => e.event)).toContain('adopt.deferred_waiting');
      await pass();                            // five minutes on: not looked at again yet
      expect(cronLists(w) - before).toBe(1);
      w.provider.execResponses.delete('cron list');
      vi.setSystemTime(Date.parse('2026-10-22T11:01:00.000Z'));
      await pass();
    } finally { vi.useRealTimers(); }
    expect(w.provider.execLog.find((a) => a[0] === 'cron' && a[1] === 'add')).toContain('--disabled');
    expect(w.store.listAdoptPending()).toEqual([]);
  });

  it('the day it waits starts when the agent is first found running, not at the adopt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-20T09:00:00.000Z'));
      const w = await stoppedThenAdopted();
      vi.setSystemTime(Date.parse('2026-10-22T09:00:00.000Z'));   // started two days later
      await started(w);
      w.provider.execResponses.set('cron list', { code: 1, stdout: '', stderr: 'gateway not ready' });
      const pass = passOf(w);
      await pass();
      expect(w.store.listAdoptPending()).toHaveLength(1);         // waits, its day just began
      expect(w.store.listEvents(['a1']).map((e) => e.event)).not.toContain('adopt.deferred_failed');
      vi.setSystemTime(Date.parse('2026-10-23T09:30:00.000Z'));   // a day of not answering
      await pass();
      expect(w.store.listAdoptPending()).toEqual([]);
      expect(w.store.listEvents(['a1']).map((e) => e.event)).toContain('adopt.deferred_failed');
    } finally { vi.useRealTimers(); }
  });

  it('stopped again, its day starts afresh at the next start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-20T09:00:00.000Z'));
      const w = await stoppedThenAdopted();
      await started(w);
      w.provider.execResponses.set('cron list', { code: 1, stdout: '', stderr: 'gateway not ready' });
      const pass = passOf(w);
      await pass();                                                // found running once, still booting
      await w.provider.stop(w.store.getAgent('a1')!.runtimeRef!);
      w.store.setAgentState('a1', 'STOPPED');
      await pass();                                                // found stopped
      vi.setSystemTime(Date.parse('2026-10-22T09:00:00.000Z'));   // started two days later, booting
      await started(w);
      await pass();
      expect(w.store.listAdoptPending()).toHaveLength(1);
      expect(w.store.listEvents(['a1']).map((e) => e.event)).not.toContain('adopt.deferred_failed');
    } finally { vi.useRealTimers(); }
  });

  it('its day counts only while the agent runs: sleeping and waking, it still gives up after a day of running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-20T00:00:00.000Z'));
      const w = await stoppedThenAdopted();
      await started(w);
      w.provider.execResponses.set('cron list', { code: 1, stdout: '', stderr: 'gateway not ready' });
      const pass = passOf(w);
      await pass();                                                // running: 0 h
      vi.setSystemTime(Date.parse('2026-10-20T20:00:00.000Z'));
      await pass();                                                // 20 h
      await w.provider.stop(w.store.getAgent('a1')!.runtimeRef!);
      w.store.setAgentState('a1', 'STOPPED');
      vi.setSystemTime(Date.parse('2026-10-21T08:00:00.000Z'));
      await pass();                                                // asleep: the clock stops
      vi.setSystemTime(Date.parse('2026-10-22T08:00:00.000Z'));
      await started(w);
      await pass();                                                // awake again: still 20 h
      expect(w.store.listAdoptPending()).toHaveLength(1);
      vi.setSystemTime(Date.parse('2026-10-22T13:00:00.000Z'));
      await pass();                                                // 25 h of running
      expect(w.store.listAdoptPending()).toEqual([]);
      expect(w.store.listEvents(['a1']).map((e) => e.event)).toContain('adopt.deferred_failed');
    } finally { vi.useRealTimers(); }
  });

  it('an adopt into a running agent whose gateway does not answer keeps no record: its answer says the tasks did not come', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', slug: 'garden-adv' });
    w.provider.execResponses.set('cron list', { code: 1, stdout: '', stderr: 'gateway not ready' });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let res;
    try {
      const req = w.f.inject({ method: 'POST', url: '/v1/agents/a1/adopt-workspace', headers: as(), payload: { path: wsTech } });
      await vi.advanceTimersByTimeAsync(60_000);
      res = await req;
    } finally { vi.useRealTimers(); }
    expect(res.statusCode).toBe(200);
    expect(res.json().crons.failed).toBeGreaterThan(0);
    expect(w.store.listAdoptPending()).toEqual([]);
  });

  it('an adopt into a running agent whose re-point another operation refused answers its tasks as put off (HB-1466)', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', slug: 'garden-adv' });
    // Another operation takes the agent between the copy and its re-point.
    let release: (() => void) | undefined;
    const set = w.store.setAdoptPending.bind(w.store);
    w.store.setAdoptPending = (...args) => { set(...args); release ??= markBusy('a1'); };
    let res;
    try {
      res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/adopt-workspace', headers: as(), payload: { path: wsTech } });
    } finally { release?.(); w.store.setAdoptPending = set; }
    expect(res.statusCode).toBe(200);
    // It answered { total: 0, carried: 0, failed: 0 }: no tasks at all.
    expect(res.json().crons).toEqual({ total: 1, carried: 0, failed: 0, deferred: 1 });
    expect(w.store.listAdoptPending()).toMatchObject([{ agentId: 'a1', path: wsTech }]);
    expect(w.store.listEvents(['a1']).map((e) => e.event)).toContain('adopt.repoint_busy');
  });

  it('a newer adopt with nothing to re-point drops an older one still waiting', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', slug: 'garden-adv' });
    await w.provider.stop(w.store.getAgent('a1')!.runtimeRef!);
    w.store.setAgentState('a1', 'STOPPED');
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/adopt-workspace', headers: as(), payload: { path: wsTech } })).statusCode).toBe(200);
    expect(w.store.listAdoptPending()).toHaveLength(1);
    // A folder no OpenClaw agent names: nothing of its own to re-point.
    const loose = join(tmp, 'workspace-loose');
    mkdirSync(join(loose, 'memory'), { recursive: true });
    writeFileSync(join(loose, 'SOUL.md'), 'You are helpful.');
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/adopt-workspace', headers: as(), payload: { path: loose } })).statusCode).toBe(200);
    expect(w.store.listAdoptPending()).toEqual([]);   // the first one's tasks and paths must not land on this workspace
  });
});

describe('Data-folder scan — POST /v1/workspaces/scan-paths', () => {
  it('surfaces the external folder the workspace references', async () => {
    const w = await makeWorld();
    const res = await w.f.inject({ method: 'POST', url: '/v1/workspaces/scan-paths', headers: as(), payload: { path: wsTech } });
    expect(res.statusCode).toBe(200);
    expect(res.json().candidates).toContain(dataDir);
  });

  it('is refused to a non-host-owner (403)', async () => {
    const w = await makeWorld();
    const res = await w.f.inject({ method: 'POST', url: '/v1/workspaces/scan-paths', headers: as('intruder'), payload: { path: wsTech } });
    expect(res.statusCode).toBe(403);
  });
});

/**
 * The re-point and the snapshot an adopt takes first, in the agent's files
 * turn (HB-0629): the re-point rewrote SOUL.md, AGENTS.md and MEMORY.md one
 * at a time while a snapshot by hand or a template export read them, and the
 * snapshot an adopt takes first read them while another change wrote them.
 */
describe('an adopt\'s writes and reads in the files turn (HB-0629)', () => {
  /** A promise held open until `release`, and one that says when it was reached. */
  function gate() {
    let release!: () => void; let signal!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { signal = r; });
    return { held, reached, release, signal };
  }
  const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  const quick = (w: World) => (w.f as unknown as { quickCronRetarget: () => Promise<void> }).quickCronRetarget();
  const ok = { code: 0, stdout: '', stderr: '' };

  /**
   * The agent's core files as its container holds them (made up): read one
   * at a time (`head -c`, as a snapshot or an export reads them), written
   * whole (writeFileInAgent's `base64 -d`), and rewritten by the re-point's
   * node pass (`WSDIR=`), which goes through them one at a time with the
   * patterns it is sent. `holdRewrite`: the next pass stops after its first
   * file until let go. `holdRead`: the next read of that file waits.
   */
  function agentFiles(w: World, files: Record<string, string>) {
    let rewriteHold: ReturnType<typeof gate> | undefined;
    let readHold: { name: string; g: ReturnType<typeof gate> } | undefined;
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, opts) => {
      if (script.includes('WSDIR=')) {
        const pairs = JSON.parse(/PAIRS='([^']*)'/.exec(script)![1]!) as Array<[string, string]>;
        let hold = rewriteHold;
        rewriteHold = undefined;
        for (const name of ['SOUL.md', 'AGENTS.md', 'MEMORY.md']) {
          if (files[name] === undefined) continue;
          files[name] = pairs.reduce((t, [p, to]) => t.replace(new RegExp(p, 'gu'), () => to), files[name]!);
          if (hold) { hold.signal(); await hold.held; hold = undefined; }
        }
        return ok;
      }
      const read = /^head -c \d+ "[^"]*\/([A-Z]+\.md)"/.exec(script);
      if (read) {
        const name = read[1]!;
        if (readHold?.name === name) { const { g } = readHold; readHold = undefined; g.signal(); await g.held; }
        return files[name] === undefined ? ok : { code: 0, stdout: files[name]!, stderr: '' };
      }
      const wrote = /echo "([A-Za-z0-9+/=]+)" \| base64 -d > "[^"]*\/([A-Z]+\.md)/.exec(script);
      if (wrote) { files[wrote[2]!] = Buffer.from(wrote[1]!, 'base64').toString('utf8'); return ok; }
      return shell(ref, script, opts);
    };
    return {
      files,
      holdRewrite: () => (rewriteHold = gate()),
      holdRead: (name: string) => { const g = gate(); readHold = { name, g }; return g; },
    };
  }

  const to = WORKSPACE_DIR_TEMPLATE.replace('{slug}', 'garden-adv');
  /** The copied workspace's files, still naming the folder they came from. */
  const copied = () => ({ 'SOUL.md': `You read your notes in ${wsTech}/memory.`, 'AGENTS.md': `Keep ${wsTech}/notes.md tidy.`, 'MEMORY.md': 'Made-up memory.' });
  /** Which moment SOUL.md and AGENTS.md are from: before the re-point, after it, or a mixture never there. */
  const moment = (f: Record<string, string>) => {
    const each = ['SOUL.md', 'AGENTS.md'].map((n) => (f[n]!.includes(wsTech) ? 'before' : f[n]!.includes(to) ? 'after' : '?'));
    return each[0] === each[1] ? each[0] : `mixed (${each.join(', ')})`;
  };
  /** Adopted into a stopped agent, then started: the next quick pass re-points it. */
  const adoptedWhileStopped = async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', slug: 'garden-adv' });
    await w.provider.stop(w.store.getAgent('a1')!.runtimeRef!);
    w.store.setAgentState('a1', 'STOPPED');
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/adopt-workspace', headers: as(), payload: { path: wsTech } })).statusCode).toBe(200);
    await w.provider.start(w.store.getAgent('a1')!.runtimeRef!);
    w.store.setAgentState('a1', 'RUNNING');
    return w;
  };
  const snapshot = (w: World, label: string) => Promise.resolve(w.f.inject({ method: 'POST', url: '/v1/agents/a1/snapshots', headers: as(), payload: { label } }));

  it('a snapshot by hand while the re-point rewrites the files waits for it, and holds them as they are after it', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', slug: 'garden-adv' });
    const agent = agentFiles(w, copied());
    const rewrite = agent.holdRewrite();
    const adopting = Promise.resolve(w.f.inject({ method: 'POST', url: '/v1/agents/a1/adopt-workspace', headers: as(), payload: { path: wsTech } }));
    await rewrite.reached;   // SOUL.md re-pointed, AGENTS.md not yet
    const snapping = snapshot(w, 'Mid re-point');
    await ticks();
    rewrite.release();
    const snap = await snapping;
    expect(snap.statusCode, snap.body).toBe(201);
    expect(moment(w.store.getSnapshot('a1', snap.json().id)!.files)).toBe('after');
    expect((await adopting).statusCode).toBe(200);
    expect(moment(agent.files)).toBe('after');
  });

  it('a re-point that comes while a snapshot by hand reads the files waits for it: the snapshot holds them as they were', async () => {
    const w = await adoptedWhileStopped();
    const agent = agentFiles(w, copied());
    const read = agent.holdRead('AGENTS.md');
    const snapping = snapshot(w, 'Before the re-point');
    await read.reached;      // SOUL.md read, AGENTS.md not yet
    const pass = quick(w);
    await ticks();
    read.release();
    const snap = await snapping;
    expect(snap.statusCode, snap.body).toBe(201);
    expect(moment(w.store.getSnapshot('a1', snap.json().id)!.files)).toBe('before');
    await pass;
    expect(moment(agent.files)).toBe('after');
    expect(w.store.listAdoptPending()).toEqual([]);
  });

  it('a re-point that comes while a template is exported waits for it: the template holds the files as they were', async () => {
    const w = await adoptedWhileStopped();
    const agent = agentFiles(w, copied());
    const read = agent.holdRead('AGENTS.md');
    const exporting = Promise.resolve(w.f.inject({ method: 'GET', url: '/v1/agents/a1/export', headers: as() }));
    await read.reached;
    const pass = quick(w);
    await ticks();
    read.release();
    const res = await exporting;
    expect(res.statusCode, res.body).toBe(200);
    expect(moment(parseTemplate(res.rawPayload).files)).toBe('before');
    await pass;
    expect(moment(agent.files)).toBe('after');
  });

  it('the snapshot an adopt takes first is taken in the files turn: a change of setup values made meanwhile waits for it', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', slug: 'garden-adv' });
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'old' }, { soul: 'Soul {{style}}', agents: 'Rules {{style}}' });
    const agent = agentFiles(w, { 'SOUL.md': 'Soul old', 'AGENTS.md': 'Rules old', 'MEMORY.md': 'Made-up memory.' });
    const read = agent.holdRead('AGENTS.md');
    const adopting = Promise.resolve(w.f.inject({ method: 'POST', url: '/v1/agents/a1/adopt-workspace', headers: as(), payload: { path: wsTech } }));
    await read.reached;      // its snapshot has read SOUL.md
    const changing = Promise.resolve(w.f.inject({ method: 'PUT', url: '/v1/agents/a1/params', headers: as(), payload: { values: { style: 'new' } } }));
    await ticks();
    read.release();
    const [adopted, changed] = await Promise.all([adopting, changing]);
    const first = w.store.listSnapshots('a1').find((s) => s.reason === 'pre-adopt')!;
    const files = w.store.getSnapshot('a1', first.id)!.files;
    expect([files['SOUL.md'], files['AGENTS.md']]).toEqual(['Soul old', 'Rules old']);
    // Then the adopt goes ahead, and the change, which waited for the turn,
    // is refused as busy. Before, the change went ahead beside the snapshot
    // and the adopt was the one refused.
    expect(adopted.statusCode, adopted.body).toBe(200);
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: 'Another operation is already running on this agent.' });
  });

  it('an adopt whose first snapshot does not get the files turn in time is refused, with nothing changed', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', slug: 'garden-adv' });
    const was = { 'SOUL.md': 'Soul as it is', 'AGENTS.md': 'Rules as they are', 'MEMORY.md': 'Made-up memory.' };
    const agent = agentFiles(w, { ...was });
    const read = agent.holdRead('AGENTS.md');
    const snapping = snapshot(w, 'Slow read');   // holds the files turn while it reads
    await read.reached;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let res;
    try {
      const adopting = Promise.resolve(w.f.inject({ method: 'POST', url: '/v1/agents/a1/adopt-workspace', headers: as(), payload: { path: wsTech } }));
      await ticks();         // at the turn, waiting
      let answered = false;
      void adopting.then(() => { answered = true; });
      await vi.advanceTimersByTimeAsync(CORE_FILES_WAIT_MS);
      await ticks();
      // Answered at its time limit (an adopt that went on would copy, start
      // the agent and wait for its re-point's turn before it answered).
      expect(answered).toBe(true);
      res = await adopting;
    } finally { vi.useRealTimers(); }
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Another change to its files is still running; try again when it ends.' });
    // Not copied in, not begun, and no snapshot of its own.
    expect(w.provider.workspaceStore.size).toBe(0);
    expect(w.store.listOperations(['a1']).filter((o) => o.kind === 'adopt-workspace')).toEqual([]);
    expect(w.store.listSnapshots('a1').filter((s) => s.reason === 'pre-adopt')).toEqual([]);
    read.release();
    expect((await snapping).statusCode).toBe(201);
    expect(agent.files).toEqual(was);
    expect(w.store.listAdoptPending()).toEqual([]);
  });

  it('an agent moved to another machine while its adopt waited for the snapshot\'s turn is not adopted into: refused, as a move is', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', slug: 'garden-adv' });
    w.store.insertHost({ id: 'h2', ownerId: w.owner, name: 'Runner 2', kind: 'cloud', provider: 'mock2', settings: {}, createdAt: 'now' });
    const target = new MockProvider();
    w.providers.set('mock2', target);
    const agent = agentFiles(w, copied());
    const read = agent.holdRead('AGENTS.md');
    const snapping = snapshot(w, 'Slow read');   // holds the files turn while it reads
    await read.reached;
    const adopting = Promise.resolve(w.f.inject({ method: 'POST', url: '/v1/agents/a1/adopt-workspace', headers: as(), payload: { path: wsTech } }));
    await ticks();
    await moveAgentToHost({ store: w.store, secrets: w.secrets, channel: w.channel, source: w.provider, target, sleep: async () => {} }, 'a1', 'h2');
    expect(w.store.getAgent('a1')!.hostId).toBe('h2');
    read.release();
    // The snapshot by hand saw the move replace its files, and says so.
    expect((await snapping).statusCode).toBe(409);
    const res = await adopting;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: 'It moved to another machine while its snapshot was taken. Look again, then adopt the workspace.' });
    expect(target.workspaceStore.size).toBe(0);
    expect(w.provider.workspaceStore.size).toBe(0);
    expect(w.store.listOperations(['a1']).filter((o) => o.kind === 'adopt-workspace')).toEqual([]);
  });

  it('a re-point whose files turn does not come in time is left for a later pass, its adopt kept', async () => {
    const w = await adoptedWhileStopped();
    const agent = agentFiles(w, copied());
    const read = agent.holdRead('AGENTS.md');
    const snapping = snapshot(w, 'Slow read');   // holds the files turn while it reads
    await read.reached;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-11-20T09:00:00.000Z'));
      const pass = quick(w);
      await vi.advanceTimersByTimeAsync(CORE_FILES_WAIT_MS);
      await pass;
      expect(w.store.listAdoptPending()).toHaveLength(1);
      expect(w.store.listEvents(['a1']).map((e) => e.event)).toContain('adopt.repoint_busy');
      expect(w.provider.execLog.find((a) => a[0] === 'cron' && a[1] === 'add')).toBeUndefined();
      expect(moment(agent.files)).toBe('before');
      read.release();
      expect((await snapping).statusCode).toBe(201);
      vi.setSystemTime(Date.parse('2026-11-20T10:01:00.000Z'));   // a later pass
      const again = quick(w);
      await vi.advanceTimersByTimeAsync(60_000);
      await again;
    } finally { vi.useRealTimers(); }
    expect(w.store.listAdoptPending()).toEqual([]);
    expect(moment(agent.files)).toBe('after');
    expect(w.provider.execLog.find((a) => a[0] === 'cron' && a[1] === 'add')).toContain('--disabled');
  });
});
