/**
 * End-to-end coverage of the Backups panel routes: listing (machine-scoped, so
 * every owner's agent resolves), per-agent restore by the host owner, and prune
 * with its path-traversal guard. The backup sets are faked on disk under a temp
 * HATCHABOT_BACKUP_DIR; the tarball name matches MockProvider's volume archive.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWorld, seedRunningAgent, as, OWNER, type World } from './support/world.js';
import { agentArchiveName } from '../src/orchestrator/backups.js';

const base = mkdtempSync(join(tmpdir(), 'acl-bkflow-'));
const prevEnv = process.env.HATCHABOT_BACKUP_DIR;
beforeAll(() => { process.env.HATCHABOT_BACKUP_DIR = base; });
afterAll(() => {
  if (prevEnv === undefined) delete process.env.HATCHABOT_BACKUP_DIR;
  else process.env.HATCHABOT_BACKUP_DIR = prevEnv;
  rmSync(base, { recursive: true, force: true });
});
afterEach(() => {
  // clear dated sets between tests
  for (const d of ['2026-08-20', '2026-08-21']) rmSync(join(base, d), { recursive: true, force: true });
});

/** Write a backup set for the given agents (by runtimeRef → archive name). */
function writeSet(date: string, w: World, agentIds: string[], opts: { db?: boolean; key?: boolean } = {}) {
  const dir = join(base, date);
  mkdirSync(dir, { recursive: true });
  if (opts.db !== false) writeFileSync(join(dir, 'hatchabot.sqlite'), 'db');
  if (opts.key !== false) writeFileSync(join(dir, 'secret-key.env'), 'k');
  for (const id of agentIds) {
    const ref = w.store.getAgent(id)!.runtimeRef!;
    writeFileSync(join(dir, agentArchiveName(ref)), `backup-of-${id}`);
  }
}

describe('Backups list — GET /v1/backups', () => {
  it('matches every active agent to its volume, across owners (machine-scoped)', async () => {
    const w = await makeWorld(); // host owned by OWNER
    await seedRunningAgent(w, { id: 'a1', slug: 'mine', accountId: 'minebot' });
    // a second agent owned by a DIFFERENT user, on the same host
    await seedRunningAgent(w, { id: 'a2', slug: 'theirs', owner: 'owner-b', accountId: 'theirsbot' });
    writeSet('2026-08-20', w, ['a1', 'a2']);

    const res = await w.f.inject({ method: 'GET', url: '/v1/backups', headers: as() });
    expect(res.statusCode).toBe(200);
    const set = res.json().backups.find((b: any) => b.date === '2026-08-20');
    const byId: Record<string, any> = Object.fromEntries(set.volumes.map((v: any) => [v.agentId, v]));
    // BOTH agents resolved — the cross-owner fix. Neither shows as "deleted".
    expect(byId['a1'].name).toBe('Kitchen'); // default seed name
    expect(byId['a2']).toBeDefined();
    expect(set.volumes.every((v: any) => v.agentId)).toBe(true);
  });

  it('flags a set missing the decryption key', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1' });
    writeSet('2026-08-21', w, ['a1'], { key: false });
    const res = await w.f.inject({ method: 'GET', url: '/v1/backups', headers: as() });
    const set = res.json().backups.find((b: any) => b.date === '2026-08-21');
    expect(set.hasDb).toBe(true);
    expect(set.hasKey).toBe(false);
  });
});

describe('Backups restore — POST /v1/backups/restore', () => {
  it('lets the host owner restore ANY agent on the box, overwriting its volume', async () => {
    const w = await makeWorld(); // OWNER owns the host
    await seedRunningAgent(w, { id: 'a2', slug: 'theirs', owner: 'owner-b', memory: 'current' });
    writeSet('2026-08-20', w, ['a2']);
    const ref = w.store.getAgent('a2')!.runtimeRef!;
    expect(w.provider.stateStore.get(ref)!.toString()).toBe('current');

    // OWNER (host owner), NOT owner-b, restores the other user's agent.
    const res = await w.f.inject({ method: 'POST', url: '/v1/backups/restore', headers: as(), payload: { agentId: 'a2', date: '2026-08-20' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ date: '2026-08-20', running: true });
    expect(w.provider.stateStore.get(ref)!.toString()).toBe('backup-of-a2');
    expect(w.store.getAgent('a2')!.state).toBe('RUNNING');
  });

  it('404s when the set has no tarball for that agent', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1' });
    writeSet('2026-08-20', w, []); // empty set
    const res = await w.f.inject({ method: 'POST', url: '/v1/backups/restore', headers: as(), payload: { agentId: 'a1', date: '2026-08-20' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/doesn't contain/i);
  });

  it('is refused to a non-host-owner (403)', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1' });
    writeSet('2026-08-20', w, ['a1']);
    const res = await w.f.inject({ method: 'POST', url: '/v1/backups/restore', headers: as('intruder'), payload: { agentId: 'a1', date: '2026-08-20' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('Backups prune — DELETE /v1/backups/:date', () => {
  it('deletes a dated set', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1' });
    writeSet('2026-08-20', w, ['a1']);
    expect(existsSync(join(base, '2026-08-20'))).toBe(true);
    const res = await w.f.inject({ method: 'DELETE', url: '/v1/backups/2026-08-20', headers: as() });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(base, '2026-08-20'))).toBe(false);
  });

  it('404s an unknown date and 400s a non-date name (no traversal)', async () => {
    const w = await makeWorld();
    const missing = await w.f.inject({ method: 'DELETE', url: '/v1/backups/2026-01-01', headers: as() });
    expect(missing.statusCode).toBe(404);
    const bad = await w.f.inject({ method: 'DELETE', url: '/v1/backups/not-a-date', headers: as() });
    expect(bad.statusCode).toBe(400);
  });
});
