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
import { makeWorld, seedRunningAgent, as } from './support/world.js';

const tmp = mkdtempSync(join(tmpdir(), 'acl-adopt-'));
const cfgPath = join(tmp, 'openclaw.json');
const dbPath = join(tmp, 'state.sqlite');
const wsTech = join(tmp, 'workspace-tech'); // inspect allows /tmp
const wsFresh = join(tmp, 'workspace-fresh');
// External data folder must live OUTSIDE /tmp (the scan excludes /tmp).
const repoTmp = mkdtempSync(join(process.cwd(), 'acl-adopt-data-'));
const dataDir = join(repoTmp, 'condo-docs');
// A checkout that is itself under a system tree (a self-hosted runner's
// /var/lib/...): the route's scan keeps every other system prefix.
vi.mock('../src/orchestrator/dataPaths.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/orchestrator/dataPaths.js')>();
  const here = process.cwd();
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
