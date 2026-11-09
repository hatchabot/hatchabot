import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';
import { isBusy } from '../src/orchestrator/busy.js';
import type { MockProvider } from '../src/providers/mockProvider.js';

/**
 * HB-0230 (follow-up to audit #096): the AGENTS.md docs sync reads the file,
 * works out its managed sections and writes the whole file back. Every route
 * that runs it off the request holds the agent busy while it does, so a save
 * of AGENTS.md made meanwhile is refused ("another operation") instead of
 * being written over without a snapshot. The one exception, a memory cap
 * (the budget sync), writes only if the file is still what it read.
 */

const SYNC_READ = /^cat "[^"]*\/AGENTS\.md" 2>\/dev\/null \|\| true$/;
/** The budget sync's read: the file's bytes, as base64 (syncMemoryBudget). */
const BUDGET_READ = /^cat "[^"]*\/AGENTS\.md" 2>\/dev\/null \| base64$/;

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
  it('a new memory cap: not held, and a save made meanwhile is kept, with the new budget', async () => {
    // Its sync is the budget sync (tellMemoryBudget): held busy, it refused
    // a Rebuild and made a model change wait. It replaces AGENTS.md only if
    // it is still what it read; refused, it reads it again.
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    let text = '# Playbook\n\n## Memory budget\n- Your container has **8 GB** of memory in total.\n';
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => { enter = r; });
    const gate = new Promise<void>((r) => { release = r; });
    let refused = 0;
    const staged = new Map<string, string>();
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, opts) => {
      // What it reads first is the file before the save; it answers after.
      if (BUDGET_READ.test(script)) { const read = text; enter(); await gate; return { code: 0, stdout: Buffer.from(read).toString('base64'), stderr: '' }; }
      // Staged, checked and renamed in one shell (a guarded write).
      const stage = /echo "([A-Za-z0-9+/=]+)" \| base64 -d > "([^"]*AGENTS\.md\.tmp-[0-9a-f]+)"/.exec(script);
      if (stage) staged.set(stage[2]!, Buffer.from(stage[1]!, 'base64').toString());
      const swap = /= "([0-9a-f]{64})" \] \|\| .*; mv -f "([^"]*)" "[^"]*AGENTS\.md"$/.exec(script);
      if (stage && !swap) return { code: 0, stdout: '', stderr: '' };
      if (swap) {
        if (swap[1] !== createHash('sha256').update(text, 'utf8').digest('hex')) { refused++; return { code: 3, stdout: '', stderr: 'it changed meanwhile' }; }
        text = staged.get(swap[2]!)!;
        return { code: 0, stdout: '', stderr: '' };
      }
      const b64 = /echo "([A-Za-z0-9+/=]+)" \| base64 -d > "[^"]*AGENTS\.md"\.tmp && mv/.exec(script)?.[1];
      if (b64) { text = Buffer.from(b64, 'base64').toString(); return { code: 0, stdout: '', stderr: '' }; }
      return shell(ref, script, opts);
    };
    const res = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { memoryCap: '4g' } });
    expect(res.statusCode, res.body).toBe(200);
    await entered;
    expect(isBusy(id)).toBe(false);
    const save = await w.f.inject({ method: 'PUT', url: `/v1/agents/${id}/files/AGENTS.md`, headers: as(), payload: { content: '# Playbook\nThe owner\'s edit.\n' } });
    expect(save.statusCode, save.body).toBe(200);
    release();
    for (let i = 0; i < 200 && !text.includes('**4 GB**'); i++) await new Promise((r) => setTimeout(r, 5));
    expect(refused).toBe(1); // its first write: the file was no longer what it read
    expect(text.startsWith('# Playbook\nThe owner\'s edit.\n')).toBe(true);
    expect(text).toMatch(/## Memory budget[\s\S]*\*\*4 GB\*\*/);
    await settle(id);
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
      expect(w.provider.execLog.some((c) => c[0] === 'sh' && (SYNC_READ.test(String(c[1])) || BUDGET_READ.test(String(c[1]))))).toBe(false);
    } finally { clearBusy(id); }
  });
});
