import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';
import type { LimitsCheckSummary } from '../src/orchestrator/swap.js';

const GiB = 1024 ** 3;
const gate = () => {
  let signal!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => { signal = r; });
  const held = new Promise<void>((r) => { release = r; });
  return { signal, release, reached, held };
};
const opened: World[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const w of opened.splice(0)) await w.f.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function setup() {
  vi.stubEnv('HATCHABOT_AGENT_MEMORY', '3g');
  vi.stubEnv('HATCHABOT_AGENT_SWAP', 'off');
  const w = await makeWorld(); opened.push(w);
  const id = await seedRunningAgent(w), ref = w.store.getAgent(id)!.runtimeRef!;
  w.provider.swapState = { kind: 'zswap', compressed: true, swapDevices: [] };
  const check = (w.f as unknown as { limitsCheck: () => Promise<LimitsCheckSummary> }).limitsCheck;
  return { w, id, ref, check };
}
const patch = (w: World, id: string, payload: object) =>
  w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload });

describe('every memory-limit writer shares the commit turn (HB-0653)', () => {
  it.each(['sweep', 'machine cap', 'machine swap', 'start'] as const)('%s cannot land between a PATCH runtime update and its record', async (competing) => {
    const { w, id, ref, check } = await setup();
    if (competing === 'start') {
      await w.provider.stop(ref); w.store.setAgentState(id, 'STOPPED');
    }
    const g = gate(), update = w.provider.updateMemory.bind(w.provider);
    let changes = 0;
    w.provider.updateMemory = async (...args) => {
      await update(...args);
      if (++changes === 2) { g.signal(); await g.held; }
    };
    const saving = Promise.resolve(patch(w, id, { memoryCap: '4g', swapAllowance: '1g' }));
    await g.reached;
    expect(w.store.getAgent(id)?.memoryCap).toBeUndefined();
    let other: Promise<unknown>;
    if (competing === 'sweep') other = check();
    else if (competing === 'start') other = Promise.resolve(w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() }));
    else {
      const dir = mkdtempSync(join(tmpdir(), 'hb-limits-')); dirs.push(dir);
      const envFile = join(dir, '.env'); writeFileSync(envFile, 'HATCHABOT_SECRET_KEY=example\n');
      vi.stubEnv('HATCHABOT_ENV_FILE', envFile);
      other = Promise.resolve(w.f.inject({ method: 'PUT', url: '/v1/machine-defaults', headers: as(), payload: {
        key: competing === 'machine cap' ? 'agentMemory' : 'agentSwap', value: competing === 'machine cap' ? '5g' : '2g',
      } }));
    }
    // Give the independent request its await boundaries. It must be queued
    // until the held PATCH stores the settings; the old code completes here.
    await new Promise((r) => setTimeout(r, 30));
    const during = w.provider.memoryUpdates.slice(2);
    g.release();
    expect((await saving).statusCode).toBe(200);
    const otherResult = await other;
    if (competing === 'sweep') expect(otherResult).toMatchObject({ reasserted: 0, failed: 0 });
    expect(during).toEqual([]);
    expect(w.store.getAgent(id)).toMatchObject({ memoryCap: '4g', swapAllowance: '1g' });
    expect(w.provider.dockerLimits.get(ref)).toEqual({ memory: 4 * GiB, memorySwap: 5 * GiB });
  });

  it('a runtime replaced while the sweep reads is left to its new lifecycle', async () => {
    const { w, id, ref, check } = await setup(), g = gate();
    w.provider.dockerLimits.set(ref, { memory: GiB, memorySwap: GiB });
    const live = w.provider.memoryLimitsLive.bind(w.provider);
    let first = true;
    w.provider.memoryLimitsLive = async (refs) => {
      const result = await live(refs);
      if (first) { first = false; g.signal(); await g.held; }
      return result;
    };
    const checking = check(); await g.reached;
    w.store.setAgentRuntimeRef(id, 'mock://replacement');
    g.release(); await checking;
    expect(w.provider.memoryUpdates).toEqual([]);
  });
});
