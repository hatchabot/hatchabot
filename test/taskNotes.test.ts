import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { cronStoreReadShell, readCronStore, type Cron } from '../src/orchestrator/crons.js';
import { TASK_NOTES_PER_HOUR, dueTaskNotes, taskNoteText } from '../src/orchestrator/taskNotes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * HB-0537: an agent in no chat app writes a scheduled task's result into its
 * console conversation, and nothing reached the owner's phone. A task they
 * tick "Tell me on Telegram when it runs" for now gets a note from their
 * Hatchabot agent's bot each time it has run: the task, the agent and a link.
 * Never the result.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };
/** A made-up Telegram id, built at run time so no id-shaped literal sits in the file. */
const TG_ID = ['55', '50', '0', '01'].join('');
const BOT = ['fake', 'bot', 'token'].join('-');

const job = (over: Partial<Cron> = {}): Cron => ({ id: 'j1', name: 'Market report', enabled: true, ...over });

describe('which runs are told (dueTaskNotes)', () => {
  it('tells a finished run newer than the setting and the last one told, once', () => {
    const since = 1_000;
    // Ran before it was turned on: not what was asked about.
    expect(dueTaskNotes([{ jobId: 'j1', sinceMs: since }], [job({ lastRunAtMs: 900, lastStatus: 'ok' })]))
      .toEqual({ due: [], seen: [], gone: [] });
    // Ran since: told, and marked seen.
    expect(dueTaskNotes([{ jobId: 'j1', sinceMs: since }], [job({ lastRunAtMs: 2_000, lastStatus: 'ok' })])).toEqual({
      due: [{ jobId: 'j1', name: 'Market report', status: 'ok', runAtMs: 2_000 }], seen: [{ jobId: 'j1', runMs: 2_000 }], gone: [],
    });
    // The same run again: nothing.
    expect(dueTaskNotes([{ jobId: 'j1', sinceMs: since, seenRunMs: 2_000 }], [job({ lastRunAtMs: 2_000, lastStatus: 'ok' })]).due).toEqual([]);
    // A failed run is told as failed; a skipped one is seen but not told.
    expect(dueTaskNotes([{ jobId: 'j1', sinceMs: since, seenRunMs: 2_000 }], [job({ lastRunAtMs: 3_000, lastStatus: 'error' })]).due[0]!.status).toBe('error');
    expect(dueTaskNotes([{ jobId: 'j1', sinceMs: since }], [job({ lastRunAtMs: 3_000, lastStatus: 'skipped' })]))
      .toEqual({ due: [], seen: [{ jobId: 'j1', runMs: 3_000 }], gone: [] });
    // Never run: nothing. No name: still told, as a scheduled task.
    expect(dueTaskNotes([{ jobId: 'j1', sinceMs: since }], [job()]).due).toEqual([]);
    expect(dueTaskNotes([{ jobId: 'j1', sinceMs: since }], [job({ name: '  ', lastRunAtMs: 2_000, lastStatus: 'ok' })]).due[0]!.name).toBe('A scheduled task');
  });

  it('forgets a task that is gone, or is OpenClaw\'s own, but never on an empty list', () => {
    const s = [{ jobId: 'j1', sinceMs: 0 }, { jobId: 'sys', sinceMs: 0 }];
    expect(dueTaskNotes(s, [job({ id: 'other' }), job({ id: 'sys', system: true, lastRunAtMs: 5, lastStatus: 'ok' })]).gone).toEqual(['j1', 'sys']);
    expect(dueTaskNotes(s, []).gone).toEqual([]);
  });
});

describe('the note (taskNoteText)', () => {
  const now = Date.UTC(2026, 10, 7, 8, 1);
  it('says which task, from which agent, whether it worked, and links to the agent — never the result', () => {
    expect(taskNoteText({ agent: 'Kitchen', task: 'Market report', status: 'ok', runAtMs: now - 60_000, now, link: 'https://box.example.org/#console=kitchen' })).toEqual({
      headline: '"Market report" from Kitchen has run.', tail: 'Read it in Hatchabot: https://box.example.org/#console=kitchen',
    });
    expect(taskNoteText({ agent: 'Kitchen', task: 'Market report', status: 'error', runAtMs: now, now })).toEqual({
      headline: '"Market report" from Kitchen ran, but failed.', tail: 'See what went wrong in the Hatchabot app.',
    });
  });
  it('a run seen late says how long ago it ran; long names are cut', () => {
    expect(taskNoteText({ agent: 'K', task: 'T', status: 'ok', runAtMs: now - 40 * 60_000, now }).headline).toBe('"T" from K has run (it ran 40 minutes ago).');
    expect(taskNoteText({ agent: 'K', task: 'T', status: 'ok', runAtMs: now - 5 * 3_600_000, now }).headline).toMatch(/it ran 5 hours ago/);
    expect(taskNoteText({ agent: 'K', task: 'T', status: 'ok', runAtMs: now - 3 * 86_400_000, now }).headline).toMatch(/it ran 3 days ago/);
    const long = taskNoteText({ agent: 'A'.repeat(100), task: 'x\n'.repeat(100), status: 'ok', runAtMs: now, now }).headline;
    expect(long.length).toBeLessThan(170);
    expect(long).not.toContain('\n');
  });
});

describe('the task store read carries each task\'s run state (cronStoreReadShell)', () => {
  /** The shell as it runs in the container, pointed at a database here and at this Node. */
  const runShell = (db: string) => {
    const sh = cronStoreReadShell('kitchen')
      .replaceAll('/home/node/.openclaw/state/openclaw.sqlite', db)
      .replace("&& node -e '", `&& '${process.execPath}' -e '`);
    return execFileSync('sh', ['-c', sh], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  };
  it('reads state_json beside job_json (OpenClaw 2026.9), and still reads a table without it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-cronstore-'));
    try {
      const path = join(dir, 'openclaw.sqlite');
      const db = new Database(path);
      db.exec(`CREATE TABLE cron_jobs (job_id TEXT, declaration_key TEXT, agent_id TEXT, job_json TEXT, updated_at INTEGER, state_json TEXT NOT NULL DEFAULT '{}')`);
      db.prepare('INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, ?)').run('j1', null, 'kitchen',
        JSON.stringify({ name: 'Market report', enabled: true, payload: { kind: 'agentTurn', message: 'Write it.' } }), 1000,
        JSON.stringify({ lastRunAtMs: 5000, lastRunStatus: 'ok', lastDurationMs: 1200 }));
      db.prepare('INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, ?)').run('other', null, 'someone-else', '{}', 1, '{}');
      db.close();
      const out = JSON.parse(runShell(path)) as { jobs: Array<Record<string, any>> };
      expect(out.jobs.map((j) => j.id)).toEqual(['j1']);
      expect(out.jobs[0]).toMatchObject({ id: 'j1', name: 'Market report', updatedAtMs: 1000, state: { lastRunAtMs: 5000, lastRunStatus: 'ok' } });

      const old = join(dir, 'old.sqlite');
      const db2 = new Database(old);
      db2.exec('CREATE TABLE cron_jobs (job_id TEXT, declaration_key TEXT, agent_id TEXT, job_json TEXT, updated_at INTEGER)');
      db2.prepare('INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?)').run('j1', null, null, JSON.stringify({ name: 'Old' }), 7);
      db2.close();
      const out2 = JSON.parse(runShell(old)) as { jobs: Array<Record<string, any>> };
      expect(out2.jobs).toEqual([{ name: 'Old', id: 'j1', updatedAtMs: 7 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readCronStore gives the run state as listCrons would', async () => {
    const p = new MockProvider();
    const { runtimeRef } = await p.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: {} }, env: {} } as any);
    p.execResponses.set('sh', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [{ id: 'j1', name: 'Market report', enabled: true, updatedAtMs: 4, state: { lastRunAtMs: 5000, lastRunStatus: 'error', consecutiveErrors: 2 } }] }) });
    const read = await readCronStore(p, runtimeRef, 'kitchen');
    expect(read!.jobs[0]).toMatchObject({ id: 'j1', lastRunAtMs: 5000, lastStatus: 'error', consecutiveErrors: 2 });
    expect(read!.stamp.get('j1')).toBe(4);
  });
});

describe('Tell me on Telegram when it runs (HB-0537)', () => {
  const storeRead = (jobs: Array<Record<string, unknown>>) => ({ code: 0, stderr: '', stdout: JSON.stringify({ jobs }) });
  /** A task bound to the agent's console conversation, as an agent in no chat app has them: nothing to re-point. */
  const stored = (state: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) => ({
    id: 'j1', name: 'Market report', enabled: true, sessionTarget: 'current', sessionKey: 'agent:kitchen:main',
    delivery: { mode: 'announce' }, payload: { kind: 'agentTurn', message: 'Write the market report.' }, updatedAtMs: 1000,
    ...(state ? { state } : {}), ...over,
  });

  async function world(opts: { bot?: boolean } = {}) {
    const store = new Store(new Database(':memory:'));
    const secrets = new MemSecrets();
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: {} }, env: {} } as any);
    provider.infoOverride.set(runtimeRef, { openclawVersion: '2026.9.8' });
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as any);
    // The owner's Hatchabot agent, with its own Telegram bot and the owner linked on it.
    store.insertAgent({ id: 'ops1', ownerId: OWNER, name: 'Hatchabot', slug: 'hatchabot', state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, ops: true, createdAt: 'now', updatedAt: 'now' } as any);
    if (opts.bot !== false) {
      store.insertChannel({ id: 'c1', agentId: 'ops1', kind: 'telegram', accountId: 'HouseBot', secretRef: 's1', deepLink: 'https://t.me/HouseBot', createdAt: 'now' } as never);
      await secrets.put('s1', BOT);
      store.insertMembership({ id: 'm1', agentId: 'ops1', userId: OWNER, role: 'owner', displayName: 'Me', channelUserId: TG_ID, status: 'active' } as never);
    }
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    const pushFetch = (async (url: unknown, init?: { body?: unknown }) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets, providers: new Map([['mock', provider]]), pushFetch, publicUrl: 'https://box.example.org',
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
    } as any);
    const quick = () => (f as unknown as { quickCronRetarget: () => Promise<void> }).quickCronRetarget();
    return { store, provider, f, sent, quick };
  }

  it('turned on for a task, each new run is told once on the owner\'s Telegram, with a link and not the result', async () => {
    const { store, provider, f, sent, quick } = await world();
    provider.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [stored(undefined)] }) });
    const before = await f.inject({ method: 'GET', url: '/v1/agents/a1/crons', headers: as });
    expect(before.json()).toMatchObject({ notes: [], noteReach: true });

    const on = await f.inject({ method: 'PATCH', url: '/v1/agents/a1/crons/j1', headers: as, payload: { notify: true } });
    expect(on.json()).toEqual({ ok: true, notify: true });
    // Hatchabot's own setting: the task itself is not touched, no CLI starts.
    expect(provider.execLog.filter((a) => a[0] === 'cron' && a[1] !== 'list')).toEqual([]);
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/crons', headers: as })).json().notes).toEqual(['j1']);

    // A run from before it was turned on: not told.
    provider.execResponses.set('sh', storeRead([stored({ lastRunAtMs: Date.now() - 3_600_000, lastRunStatus: 'ok' })]));
    await quick();
    expect(sent).toEqual([]);

    // A run since: one note.
    const t1 = Date.now() + 1_000;
    provider.execResponses.set('sh', storeRead([stored({ lastRunAtMs: t1, lastRunStatus: 'ok' })]));
    await quick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://api.telegram.org/bot${BOT}/sendMessage`);
    expect(sent[0]!.body).toMatchObject({ chat_id: TG_ID, disable_web_page_preview: true });
    expect(sent[0]!.body.text).toBe('"Market report" from Kitchen has run.\n\nRead it in Hatchabot: https://box.example.org/#console=kitchen');
    expect(String(sent[0]!.body.text)).not.toContain('Write the market report');
    expect(store.listEvents(['a1']).some((e) => e.event === 'cron.noted')).toBe(true);

    // The same run on the next pass: nothing more.
    await quick();
    expect(sent).toHaveLength(1);
    // A failed run: told as failed. A skipped one: not told.
    provider.execResponses.set('sh', storeRead([stored({ lastRunAtMs: t1 + 1_000, lastRunStatus: 'error' })]));
    await quick();
    expect(sent[1]!.body.text).toMatch(/^"Market report" from Kitchen ran, but failed\.\n\nSee what went wrong in Hatchabot: /);
    provider.execResponses.set('sh', storeRead([stored({ lastRunAtMs: t1 + 2_000, lastRunStatus: 'skipped' })]));
    await quick();
    expect(sent).toHaveLength(2);
    // No CLI was started for any of it.
    expect(provider.execLog.filter((a) => a[0] === 'cron' && a[1] !== 'list')).toEqual([]);

    // Turned off: no more.
    await f.inject({ method: 'PATCH', url: '/v1/agents/a1/crons/j1', headers: as, payload: { notify: false } });
    provider.execResponses.set('sh', storeRead([stored({ lastRunAtMs: t1 + 3_000, lastRunStatus: 'ok' })]));
    await quick();
    expect(sent).toHaveLength(2);
    expect(store.cronNotes('a1')).toEqual([]);
  });

  it('a new task can be asked for with it on; deleting a task, or the agent removing it, forgets the setting', async () => {
    const { store, provider, f } = await world();
    provider.execResponses.set('cron add', { code: 0, stdout: '{"id":"menu-1"}', stderr: '' });
    const made = await f.inject({ method: 'POST', url: '/v1/agents/a1/crons', headers: as, payload: { name: 'Market report', cron: '0 8 * * 1-5', message: 'Write it.', notify: true } });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ created: true, id: 'menu-1', notify: true });
    expect(store.cronNotes('a1').map((n) => n.jobId)).toEqual(['menu-1']);

    provider.execResponses.set('cron rm', { code: 0, stdout: '', stderr: '' });
    expect((await f.inject({ method: 'DELETE', url: '/v1/agents/a1/crons/menu-1', headers: as })).statusCode).toBe(200);
    expect(store.cronNotes('a1')).toEqual([]);

    // Removed by the agent itself: the next pass forgets it — but an empty list forgets nothing.
    store.setCronNote('a1', 'j1', true, Date.now());
    provider.execResponses.set('sh', storeRead([]));
    const { quick } = { quick: () => (f as unknown as { quickCronRetarget: () => Promise<void> }).quickCronRetarget() };
    await quick();
    expect(store.cronNotes('a1').map((n) => n.jobId)).toEqual(['j1']);
    provider.execResponses.set('sh', storeRead([stored(undefined, { id: 'j2' })]));
    await quick();
    expect(store.cronNotes('a1')).toEqual([]);
    // A deleted agent leaves no setting behind.
    store.setCronNote('a1', 'j2', true, Date.now());
    store.scrubAgentResidue('a1');
    expect(store.cronNotes('a1')).toEqual([]);
  });

  it('with no bot to reach the owner, the list says so and nothing is sent', async () => {
    const { store, provider, f, sent, quick } = await world({ bot: false });
    provider.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [stored(undefined)] }) });
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/crons', headers: as })).json().noteReach).toBe(false);
    store.setCronNote('a1', 'j1', true, Date.now() - 10_000);
    provider.execResponses.set('sh', storeRead([stored({ lastRunAtMs: Date.now(), lastRunStatus: 'ok' })]));
    await quick();
    expect(sent).toEqual([]);
    const ev = store.listEvents(['a1']).find((e) => e.event === 'cron.noted');
    expect(ev?.detail).toMatchObject({ told: false });
  });

  it('only the agent\'s owner can turn it on, with a true or false', async () => {
    const { f } = await world();
    const other = await f.inject({ method: 'PATCH', url: '/v1/agents/a1/crons/j1', headers: { 'x-hatchabot-owner': 'user-someone-else' }, payload: { notify: true } });
    expect(other.statusCode).toBe(404);
    expect((await f.inject({ method: 'PATCH', url: '/v1/agents/a1/crons/j1', headers: as, payload: { notify: 'yes' } })).statusCode).toBe(400);
  });

  it('has an hourly budget of its own', () => {
    expect(TASK_NOTES_PER_HOUR).toBeGreaterThan(0);
  });
});
