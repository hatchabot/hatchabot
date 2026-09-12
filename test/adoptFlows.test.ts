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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    await seedRunningAgent(w, { id: 'a1', name: 'Tech Advisor', slug: 'tech-adv', accountId: 'TechAdvBot', botToken: '111:zzz' });

    const res = await w.f.inject({ method: 'GET', url: '/v1/openclaw/agents', headers: as() });
    expect(res.statusCode).toBe(200);
    const by = Object.fromEntries(res.json().agents.map((a: any) => [a.id, a]));
    expect(by['tech'].bot).toMatchObject({ accountId: 'techbot', enabledInSource: true });
    expect(by['tech'].alreadyAdoptedAs).toBe('Tech Advisor'); // matched by bot id 111
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
    await seedRunningAgent(w, { id: 'a1', slug: 'tech-adv' });

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
