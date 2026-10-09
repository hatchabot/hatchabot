/**
 * Recovery readiness (docs/recovery-readiness-design.md): per agent, the
 * newest backup a restore could use, the sets that left it out and why, the
 * last drill that checked it, one status — read from sandboxed backup sets
 * on disk (their backup-status.json records and drill records), and the
 * route's scoping, the drill route, its schedule and its operation.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBackups } from '../src/orchestrator/backups.js';
import { drillDue, drillEvery, listDrills, resetDrillStateForTests } from '../src/orchestrator/drills.js';
import { computeReadiness, usableFor, type ReadinessAgentIn } from '../src/orchestrator/recoveryReadiness.js';
import { newBootForTests, beginOperation } from '../src/orchestrator/operations.js';
import { as, makeWorld, seedRunningAgent } from './support/world.js';

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Local midnight `days` ago as a set date. */
const day = (days: number, now = Date.now()) => {
  const d = new Date(now - days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A backup base with dated sets: each its archives and its record, as backup-volumes.sh writes them. */
function base() {
  const b = tmp('hb-ready-');
  const set = (date: string, vols: string[], record?: Record<string, unknown>) => {
    mkdirSync(join(b, date), { recursive: true });
    writeFileSync(join(b, date, 'hatchabot.sqlite'), 'db');
    for (const v of vols) writeFileSync(join(b, date, `${v}.tgz`), 'archive');
    if (record) writeFileSync(join(b, date, 'backup-status.json'), JSON.stringify({ startedAt: `${date}T03:30:00`, finishedAt: `${date}T03:40:00`, failedVolumes: [], missing: [], orphans: [], skipped: [], ...record }));
  };
  const drill = (stamp: string, set: string, volumes: Array<Record<string, unknown>>, result = 'passed') => {
    mkdirSync(join(b, 'drills'), { recursive: true });
    writeFileSync(join(b, 'drills', `${stamp}.json`), JSON.stringify({
      version: 1, set, setState: 'complete', startedAt: `${set}T05:10:00Z`, finishedAt: `${set}T05:20:00Z`, durationSec: 600,
      trigger: 'scheduled', result, reason: '', database: 'ok', key: 'ok', volumes,
    }));
  };
  return { b, set, drill };
}

const agent = (id: string, over: Partial<ReadinessAgentIn> = {}): ReadinessAgentIn => ({
  id, name: `Test Agent ${id}`, runtimeRef: `docker://hatchabot-${id}`, createdAt: '2026-01-01T00:00:00Z', hostId: 'local', state: 'RUNNING', ...over,
});
const hosts = (id: string) => (id === 'runner' ? { name: 'Laptop runner', local: false, reachable: false } : { name: 'This machine', local: true });

describe('readiness from the sets on disk', () => {
  it('ready, never drilled, drill failed; an incomplete set counts only for an agent captured whole', () => {
    const w = base();
    w.set(day(3), ['hatchabot-a1-vol', 'hatchabot-a2-vol', 'hatchabot-a3-vol'], { state: 'complete', captured: ['hatchabot-a1-vol', 'hatchabot-a2-vol', 'hatchabot-a3-vol'] });
    // Last night: a3 failed, so the set is incomplete — a1 is in it whole, a2's
    // archive is on disk but the record does not say it was captured.
    w.set(day(1), ['hatchabot-a1-vol', 'hatchabot-a2-vol'], { state: 'incomplete', failedVolumes: ['hatchabot-a3-vol'], captured: ['hatchabot-a1-vol'] });
    w.drill('2026-01-05T05-10-00Z', day(3), [
      { volume: 'hatchabot-a1-vol', readable: true, layout: true, restored: true, note: '', result: 'passed' },
      { volume: 'hatchabot-a3-vol', readable: true, layout: true, restored: false, note: 'extract', result: 'failed' },
    ], 'failed');
    const r = computeReadiness({ sets: listBackups(w.b), drills: listDrills(w.b), agents: [agent('a1'), agent('a2'), agent('a3')], host: hosts, now: Date.now() });
    const by = Object.fromEntries(r.agents.map((a) => [a.agentId, a]));
    expect(by.a1).toMatchObject({ status: 'ready', latestUsable: { date: day(1), complete: false } });
    expect(by.a1!.line).toBe(`Recoverable from ${day(1)} · last drill ${day(3)} passed`);
    expect(by.a1!.drill).toMatchObject({ passed: true, restored: true, checks: ['archive read whole', 'OpenClaw files found', 'restored into a throwaway volume with no network'] });
    // a2: last night's archive is not usable (not captured), so its newest is 3 days old.
    expect(by.a2).toMatchObject({ status: 'stale', latestUsable: { date: day(3), ageDays: 3 }, leftOut: { count: 1, of: 2, failed: 1 } });
    expect(by.a2!.line).toMatch(new RegExp(`Its newest backup is from ${day(3)} \\(3 days ago\\) — left out of 1 of the last 2 backups: its archive failed`));
    // a3 failed last night, and its drill failed: stale wins (older than 2 days).
    expect(by.a3).toMatchObject({ status: 'stale', drill: { passed: false, checks: expect.arrayContaining(['it did not restore into a fresh volume']) } });
    expect(by.a3!.restorable.map((s) => s.date)).toEqual([day(3)]);
    expect(by.a3!.restorable[0]).toMatchObject({ drill: 'failed' });
    expect(r).toMatchObject({ newestSet: day(1), newestFresh: true });
  });

  it('a record from before "captured": an archive there and not failed is whole', () => {
    const w = base();
    w.set(day(0), ['hatchabot-a1-vol'], { state: 'incomplete', failedVolumes: ['hatchabot-a2-vol'] });
    const [set] = listBackups(w.b);
    expect(set!.captured).toBeUndefined();
    expect(usableFor(set!, 'hatchabot-a1-vol')).toBe(true);
    expect(usableFor(set!, 'hatchabot-a2-vol')).toBe(false);
  });

  it('a runner asleep night after night: stale, why, and its runner not answering; the alert while the machine is fresh', () => {
    const w = base();
    w.set(day(4), ['hatchabot-a1-vol', 'hatchabot-r1-vol'], { state: 'complete' });
    for (const d of [3, 2, 1, 0]) w.set(day(d), ['hatchabot-a1-vol'], { state: 'complete', skipped: ['hatchabot-r1-vol'] });
    const r = computeReadiness({ sets: listBackups(w.b), drills: [], agents: [agent('a1'), agent('r1', { hostId: 'runner' })], host: hosts, now: Date.now() });
    const r1 = r.agents.find((a) => a.agentId === 'r1')!;
    expect(r1).toMatchObject({ status: 'stale', runner: { name: 'Laptop runner', reachable: false }, leftOut: { count: 4, of: 5, asleep: 4 } });
    expect(r1.line).toBe(`Its newest backup is from ${day(4)} (4 days ago) — left out of 4 of the last 5 backups: its machine (Laptop runner) was asleep or offline. Laptop runner is not answering now.`);
    expect(r1.alert).toEqual({ key: `recovery:${day(4)}`, why: expect.stringMatching(/^Its newest backup is from .*\(its settings → Advanced → Recovery\)$/) });
    // a1 is fine and never drilled: no alert.
    expect(r.agents.find((a) => a.agentId === 'a1')).toMatchObject({ status: 'never drilled', line: `Recoverable from ${day(0)} · never drilled` });
    expect(r.agents.find((a) => a.agentId === 'a1')!.alert).toBeUndefined();
  });

  it('the fold: when the whole machine is late, no agent carries its own alert', () => {
    const w = base();
    w.set(day(5), ['hatchabot-a1-vol'], { state: 'complete' });
    const r = computeReadiness({ sets: listBackups(w.b), drills: [], agents: [agent('a1'), agent('a2')], host: hosts, now: Date.now() });
    expect(r.newestFresh).toBe(false);
    expect(r.agents.map((a) => [a.status, !!a.alert])).toEqual([['stale', false], ['not covered', false]]);
  });

  it('a missing volume, an agent no set holds, one made after the last backup, one with no runtime, an archived one', () => {
    const w = base();
    w.set(day(1), ['hatchabot-a1-vol'], { state: 'incomplete', missing: ['hatchabot-a2-vol'], failedVolumes: ['hatchabot-a2-vol'], captured: ['hatchabot-a1-vol'] });
    w.set(day(0), ['hatchabot-a1-vol'], { state: 'incomplete', missing: ['hatchabot-a2-vol'], failedVolumes: ['hatchabot-a2-vol'], captured: ['hatchabot-a1-vol'] });
    const r = computeReadiness({
      sets: listBackups(w.b), drills: [], host: hosts, now: Date.now(),
      agents: [agent('a1'), agent('a2'), agent('a3', { createdAt: new Date().toISOString() }), agent('a4', { runtimeRef: undefined }), agent('a5', { state: 'ARCHIVED' })],
    });
    const by = Object.fromEntries(r.agents.map((a) => [a.agentId, a]));
    expect(by.a2).toMatchObject({ status: 'not covered', leftOut: { count: 2, of: 2, missing: 2 } });
    expect(by.a2!.line).toBe('No backup holds it — left out of the last 2 backups: its volume was not there.');
    expect(by.a2!.alert).toMatchObject({ key: 'recovery:none' });
    expect(by.a3).toMatchObject({ status: 'new', line: 'Not backed up yet — it was made after the last backup.' });
    expect(by.a3!.alert).toBeUndefined();
    expect(by.a4).toBeUndefined();
    expect(by.a5).toMatchObject({ status: 'not covered' });
    expect(by.a5!.alert).toBeUndefined(); // archived: no alert
  });

  it('a set still being written never counts; drill records are read defensively', () => {
    const w = base();
    w.set(day(0), ['hatchabot-a1-vol'], { state: 'running', startedAt: new Date().toISOString() });
    mkdirSync(join(w.b, 'drills'));
    writeFileSync(join(w.b, 'drills', '2026-01-01T05-00-00Z.json'), 'not json');
    writeFileSync(join(w.b, 'drills', 'notes.txt'), 'ignored');
    expect(listDrills(w.b)).toEqual([]);
    const r = computeReadiness({ sets: listBackups(w.b), drills: [], agents: [agent('a1')], host: hosts, now: Date.now() });
    expect(r.agents[0]).toMatchObject({ status: 'not covered' });
    expect(r.newestSet).toBeUndefined();
  });
});

describe('the drill schedule', () => {
  const at = (h: number) => { const d = new Date(); d.setHours(h, 15, 0, 0); return d; };
  const today = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  it('off by default; anything unknown is off', () => {
    expect(drillEvery({})).toBe('off');
    expect(drillEvery({ HATCHABOT_DRILL_EVERY: 'hourly' })).toBe('off');
    expect(drillEvery({ HATCHABOT_DRILL_EVERY: 'Weekly' })).toBe('weekly');
  });
  it('in the quiet hours, after today\'s backup, one at a time, once a period (a failed one again the next morning)', () => {
    const now = at(5);
    const base = { every: 'weekly' as const, now, newestSet: { date: today(now) }, backupRunning: false, drillRunning: false };
    expect(drillDue(base)).toEqual({ due: true, why: 'due' });
    expect(drillDue({ ...base, every: 'off' }).due).toBe(false);
    expect(drillDue({ ...base, now: at(3), newestSet: { date: today(at(3)) } }).why).toBe('outside the quiet hours');
    expect(drillDue({ ...base, newestSet: { date: '2020-01-01' } }).why).toBe("today's backup has not run");
    expect(drillDue({ ...base, newestSet: { date: today(now), running: true } }).why).toBe('a backup is running');
    expect(drillDue({ ...base, backupRunning: true }).due).toBe(false);
    expect(drillDue({ ...base, drillRunning: true }).why).toBe('a drill is running');
    const twoDays = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    expect(drillDue({ ...base, lastDrillAt: twoDays, lastDrillPassed: true }).why).toBe('drilled recently');
    expect(drillDue({ ...base, lastDrillAt: twoDays, lastDrillPassed: false }).due).toBe(true);
    expect(drillDue({ ...base, every: 'daily', lastDrillAt: twoDays, lastDrillPassed: true }).due).toBe(true);
    // Last week's drill started a little later in the morning: due all the same.
    const lastWeek = new Date(now.getTime() - 7 * 86_400_000 + 30 * 60_000).toISOString();
    expect(drillDue({ ...base, lastDrillAt: lastWeek, lastDrillPassed: true }).due).toBe(true);
  });
});

describe('GET /v1/backups/readiness and the drill routes', () => {
  const bdir = mkdtempSync(join(tmpdir(), 'hb-ready-route-'));
  dirs.push(bdir);
  const saved = { dir: process.env.HATCHABOT_BACKUP_DIR, env: process.env.HATCHABOT_ENV_FILE, every: process.env.HATCHABOT_DRILL_EVERY, script: process.env.HATCHABOT_DRILL_SCRIPT };
  beforeAll(() => { process.env.HATCHABOT_BACKUP_DIR = bdir; });
  afterAll(() => {
    for (const [k, v] of [['HATCHABOT_BACKUP_DIR', saved.dir], ['HATCHABOT_ENV_FILE', saved.env], ['HATCHABOT_DRILL_EVERY', saved.every], ['HATCHABOT_DRILL_SCRIPT', saved.script]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  afterEach(() => { resetDrillStateForTests(); vi.restoreAllMocks(); });

  async function world() {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', name: 'Test Agent', slug: 'test-agent' });
    await seedRunningAgent(w, { id: 'a2', name: 'Other Agent', slug: 'other-agent', owner: 'someone-else', accountId: 'otherbot' });
    mkdirSync(join(bdir, day(0)), { recursive: true });
    writeFileSync(join(bdir, day(0), 'a1-vol.tgz'), 'archive');
    writeFileSync(join(bdir, day(0), 'a2-vol.tgz'), 'archive');
    writeFileSync(join(bdir, day(0), 'backup-status.json'), JSON.stringify({ state: 'complete', startedAt: new Date().toISOString(), captured: ['a1-vol', 'a2-vol'] }));
    return w;
  }

  it('the machine owner sees every agent and the last drill; another owner only their own, and cannot restore', async () => {
    const w = await world();
    const mine = (await w.f.inject({ method: 'GET', url: '/v1/backups/readiness', headers: as() })).json();
    expect(mine.agents.map((a: { agentId: string }) => a.agentId).sort()).toEqual(['a1', 'a2']);
    expect(mine).toMatchObject({ canRestore: true, drill: { every: 'off', run: { status: 'idle' } } });
    expect(mine.agents[0].restorable).toBeUndefined(); // the list leaves the choices out
    const theirs = (await w.f.inject({ method: 'GET', url: '/v1/backups/readiness', headers: as('someone-else') })).json();
    expect(theirs.agents.map((a: { agentId: string }) => a.agentId)).toEqual(['a2']);
    expect(theirs.canRestore).toBe(false);
    expect(theirs.drill.run).toBeUndefined();
    expect(theirs.drill.last).toBeUndefined();
    // One agent, with the sets a restore can use: only one the caller may see.
    const one = (await w.f.inject({ method: 'GET', url: '/v1/backups/readiness?agentId=a1', headers: as() })).json();
    expect(one.agents).toHaveLength(1);
    expect(one.agents[0].restorable).toEqual([{ date: day(0), sizeBytes: 7, complete: true }]);
    const notTheirs = (await w.f.inject({ method: 'GET', url: '/v1/backups/readiness?agentId=a1', headers: as('someone-else') })).json();
    expect(notTheirs.agents).toEqual([]);
  });

  it('Run a drill now: machine owner only; recorded as an operation of this machine, with the record\'s verdict', async () => {
    const w = await world();
    expect((await w.f.inject({ method: 'POST', url: '/v1/backups/drill', headers: as('someone-else') })).statusCode).toBe(403);
    const scripts = tmp('hb-drill-script-');
    const script = join(scripts, 'drill.sh');
    // A stand-in for the drill: writes the record the real one would (no docker anywhere).
    writeFileSync(script, `#!/bin/sh
mkdir -p "$HATCHABOT_BACKUP_DIR/drills"
printf '{"version":1,"set":"${day(0)}","setState":"complete","startedAt":"%s","finishedAt":"%s","durationSec":3,"trigger":"%s","result":"passed","reason":"","database":"ok","key":"ok","volumes":[{"volume":"a1-vol","readable":true,"layout":true,"restored":true,"note":"","result":"passed"}]}' "$(date -u +%FT%TZ)" "$(date -u +%FT%TZ)" "$HATCHABOT_DRILL_TRIGGER" > "$HATCHABOT_BACKUP_DIR/drills/$(date -u +%Y-%m-%dT%H-%M-%SZ).json"
echo "made-up drill passed"
`);
    chmodSync(script, 0o700);
    process.env.HATCHABOT_DRILL_SCRIPT = script;
    const res = await w.f.inject({ method: 'POST', url: '/v1/backups/drill', headers: as() });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.status).toBe('running');
    const op = w.store.listMachineOperations(['h1']).find((o) => o.kind === 'restore-drill')!;
    expect(op).toBeTruthy();
    await vi.waitFor(() => expect(w.store.getOperation(op.id)!.status).toBe('succeeded'));
    expect(w.store.getOperation(op.id)!.outcome).toBe(`Passed: 1 agent checked from the ${day(0)} backup, 1 restored into a throwaway volume.`);
    expect(listDrills(bdir)[0]).toMatchObject({ trigger: 'app', passed: true });
    const after = (await w.f.inject({ method: 'GET', url: '/v1/backups/readiness', headers: as() })).json();
    expect(after.drill.last).toMatchObject({ passed: true, checked: 1, restored: 1, set: day(0) });
    expect(JSON.stringify(after.drill.last)).not.toContain('a1-vol'); // counts, not volume names
    expect(after.agents.find((a: { agentId: string }) => a.agentId === 'a1')).toMatchObject({ status: 'ready', drill: { passed: true } });
    expect(after.agents.find((a: { agentId: string }) => a.agentId === 'a2')).toMatchObject({ status: 'never drilled' });
    rmSync(join(bdir, 'drills'), { recursive: true, force: true });
  });

  it('the schedule: off by default, set from the page into .env, and the sweep starts one when due', async () => {
    const w = await world();
    const envDir = tmp('hb-drill-env-');
    process.env.HATCHABOT_ENV_FILE = join(envDir, '.env');
    writeFileSync(process.env.HATCHABOT_ENV_FILE, 'PORT=8080\n');
    delete process.env.HATCHABOT_DRILL_EVERY;
    expect((await w.f.inject({ method: 'PUT', url: '/v1/backups/drill-schedule', headers: as('someone-else'), payload: { every: 'weekly' } })).statusCode).toBe(403);
    expect((await w.f.inject({ method: 'PUT', url: '/v1/backups/drill-schedule', headers: as(), payload: { every: 'hourly' } })).statusCode).toBe(400);
    const sweep = (w.f as unknown as { drillSweep: (now?: Date) => boolean }).drillSweep;
    const five = new Date(); five.setHours(5, 30, 0, 0);
    expect(sweep(five)).toBe(false); // off
    const res = await w.f.inject({ method: 'PUT', url: '/v1/backups/drill-schedule', headers: as(), payload: { every: 'weekly' } });
    expect(res.json()).toEqual({ every: 'weekly' });
    expect(readFileSync(process.env.HATCHABOT_ENV_FILE, 'utf8')).toMatch(/^HATCHABOT_DRILL_EVERY=weekly$/m);
    const scripts = tmp('hb-drill-script-');
    writeFileSync(join(scripts, 'drill.sh'), '#!/bin/sh\necho "made-up drill"\n', { mode: 0o700 });
    process.env.HATCHABOT_DRILL_SCRIPT = join(scripts, 'drill.sh');
    const noon = new Date(five); noon.setHours(12);
    expect(sweep(noon)).toBe(false); // not in the quiet hours
    if (day(0) === `${five.getFullYear()}-${String(five.getMonth() + 1).padStart(2, '0')}-${String(five.getDate()).padStart(2, '0')}`) {
      expect(sweep(five)).toBe(true);
      const op = w.store.listMachineOperations(['h1']).find((o) => o.kind === 'restore-drill')!;
      expect(op.params).toMatchObject({ trigger: 'scheduled' });
      await vi.waitFor(() => expect(w.store.getOperation(op.id)!.status).not.toBe('running'));
    }
    delete process.env.HATCHABOT_DRILL_EVERY;
  });

  it('a drill cut off by a restart is recorded as failed, with what to do', async () => {
    const w = await world();
    const op = beginOperation(w.store, 'restore-drill', null, { trigger: 'scheduled' }, { hostId: 'h1' });
    newBootForTests();
    await w.routes!.resumeOperations();
    expect(w.store.getOperation(op.id)).toMatchObject({ status: 'failed' });
    expect(w.store.getOperation(op.id)!.outcome).toMatch(/interrupted by a restart.*run a drill again/);
  });
});
