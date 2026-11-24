import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBusy } from '../src/orchestrator/lifecycle/busy.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

const worlds: World[] = [];
afterEach(async () => { while (worlds.length) await worlds.pop()!.f.close(); });

describe('saved skills reach the next runtime through normal lifecycle routes', () => {
  it.each(['rebuild', 'start'] as const)('applies and records the selection on %s', async (action) => {
    const w = await makeWorld();
    worlds.push(w);
    await seedRunningAgent(w);
    if (action === 'start') {
      await w.provider.stop(w.store.getAgent('a1')!.runtimeRef!);
      w.store.setAgentState('a1', 'STOPPED');
    }
    const selection = ['hatchabot-writing'];
    const save = await w.f.inject({ method: 'PUT', url: '/v1/agents/a1/skills', headers: as(), payload: { selected: selection } });
    expect(save.statusCode, save.body).toBe(200);
    expect(save.json()).toMatchObject({ selected: selection, applied: null, pending: true });
    expect(w.store.getAgent('a1')!.state).toBe(action === 'start' ? 'STOPPED' : 'RUNNING');
    const applied = await w.f.inject({ method: 'POST', url: `/v1/agents/a1/${action}`, headers: as() });
    expect(applied.statusCode, applied.body).toBe(202);
    await vi.waitFor(() => {
      expect(isBusy('a1')).toBe(false);
      expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
      expect(w.store.getAgent('a1')!.appliedCuratedSkills).toEqual(selection);
    }, { timeout: 3000, interval: 10 });
    expect(w.store.getAgent('a1')!.rebuildOnStart).toBeUndefined();
    expect(w.provider.lastSpec!.workspace.configPatch.curatedSkills).toEqual(selection);
    expect(Object.keys(w.provider.lastSpec!.workspace.files).filter((p) => p.startsWith('skills/')))
      .toEqual(['skills/hatchabot-writing/SKILL.md']);
    const read = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/skills', headers: as() });
    expect(read.json()).toMatchObject({ selected: selection, applied: selection, pending: false });
  });
});
