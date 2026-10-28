import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';
import { isBusy } from '../src/orchestrator/busy.js';
import type { MockProvider } from '../src/providers/mockProvider.js';

/**
 * HB-0230 (follow-up to audit #096): the AGENTS.md docs sync reads the file,
 * works out its managed sections and writes the whole file back. Every route
 * that runs it off the request holds the agent busy while it does, so a save
 * of AGENTS.md made meanwhile is refused ("another operation") instead of
 * being written over without a snapshot.
 */

const SYNC_READ = /^cat "[^"]*\/AGENTS\.md" 2>\/dev\/null \|\| true$/;

/** Pause the first docs-sync read of AGENTS.md until released. */
function pauseSync(provider: MockProvider) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => { enter = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const orig = provider.execShell.bind(provider);
  let paused = false;
  provider.execShell = async (ref, script, opts) => {
    if (!paused && SYNC_READ.test(script)) { paused = true; enter(); await gate; }
    return orig(ref, script, opts);
  };
  return { entered, release };
}

const settle = async (id: string) => { for (let i = 0; i < 100 && isBusy(id); i++) await new Promise((r) => setTimeout(r, 5)); };

/** While the sync is paused the agent is busy, and a save of AGENTS.md is refused; after, it is free. */
async function expectHeld(w: World, id: string, p: { entered: Promise<void>; release: () => void }) {
  await p.entered;
  expect(isBusy(id)).toBe(true);
  const save = await w.f.inject({ method: 'PUT', url: `/v1/agents/${id}/files/AGENTS.md`, headers: as(), payload: { content: '# Playbook\nThe owner\'s edit.\n' } });
  expect(save.statusCode).toBe(409);
  expect(save.json().error).toMatch(/Another operation/);
  p.release();
  await settle(id);
  expect(isBusy(id)).toBe(false);
}

const KEYS = ['HATCHABOT_ENV_FILE', 'HATCHABOT_AGENT_MEMORY'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('docs syncs run with the agent held (HB-0230)', () => {
  it('a new memory cap', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const p = pauseSync(w.provider);
    const res = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { memoryCap: '4g' } });
    expect(res.statusCode, res.body).toBe(200);
    await expectHeld(w, id, p);
  });

  it('a new memory cap together with an old client\'s sharedMemory: true is not refused by its own sync', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const res = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { memoryCap: '4g', sharedMemory: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect(w.store.getAgent(id)!.sharedMemory).toBe(true);
    await settle(id);
  });

  it("the machine's memory setting", async () => {
    const w = await makeWorld();
    const f = join(mkdtempSync(join(tmpdir(), 'hb-docsync-')), '.env');
    writeFileSync(f, 'HATCHABOT_SECRET_KEY=x\n');
    process.env.HATCHABOT_ENV_FILE = f;
    const id = await seedRunningAgent(w);
    const p = pauseSync(w.provider);
    const res = await w.f.inject({ method: 'PUT', url: '/v1/machine-defaults', headers: as(), payload: { key: 'agentMemory', value: '4g' } });
    expect(res.statusCode, res.body).toBe(200);
    await expectHeld(w, id, p);
  });

  it('the operator profile fan-out', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const p = pauseSync(w.provider);
    const res = await w.f.inject({ method: 'PUT', url: '/v1/operator-profile', headers: as(), payload: { content: 'The Example household.' } });
    expect(res.statusCode).toBe(202);
    await expectHeld(w, id, p);
  });

  it('removing a repo', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    w.store.insertDataSource({ id: 'ds1', agentId: id, kind: 'git', access: 'ro', mountName: 'notes', repoUrl: 'https://example.org/example-owner/notes.git', createdAt: 'now' });
    const p = pauseSync(w.provider);
    const res = await w.f.inject({ method: 'DELETE', url: `/v1/agents/${id}/data-sources/ds1`, headers: as() });
    expect(res.statusCode, res.body).toBe(200);
    await expectHeld(w, id, p);
  });

  it('an agent already busy is skipped, not queued', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const { markBusy, clearBusy } = await import('../src/orchestrator/busy.js');
    markBusy(id);
    try {
      const res = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { memoryCap: '4g' } });
      expect(res.statusCode, res.body).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect(w.provider.execLog.some((c) => c[0] === 'sh' && SYNC_READ.test(String(c[1])))).toBe(false);
    } finally { clearBusy(id); }
  });
});
