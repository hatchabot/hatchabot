import { afterEach, describe, expect, it } from 'vitest';
import { clearBusy, markBusy } from '../src/orchestrator/busy.js';
import { as, makeWorld, seedRunningAgent } from './support/world.js';

/**
 * A rebuild or a move reads the agent's AI source as it goes. A switch while
 * one held the agent was written anyway, and the operation could finish on
 * a mix of the two sources (HB-0063).
 */
let held = '';
afterEach(() => { if (held) clearBusy(held); held = ''; });

describe('switching the AI source while the agent is busy (HB-0063)', () => {
  it('is refused with 409 and changes nothing; once free, it goes through', async () => {
    const w = await makeWorld();
    w.store.insertAIProfile({ id: 'p2', ownerId: w.owner, name: 'Second key', vendor: 'anthropic', kind: 'api_key', model: 'claude-haiku-4-5', secretRef: 'ai/p2', createdAt: 'now' });
    const id = await seedRunningAgent(w);
    markBusy(id); held = id;
    const busy = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { aiProfileId: 'p2' } });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatch(/busy/);
    expect(w.store.getAgent(id)!.aiProfileId).toBe('p1');
    // A rename is not a source switch: still allowed while busy.
    expect((await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { name: 'Pantry' } })).statusCode).toBe(200);
    clearBusy(id); held = '';
    expect((await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { aiProfileId: 'p2' } })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.aiProfileId).toBe('p2');
  });

  it('moving every agent onto a source skips a busy one and says why', async () => {
    const w = await makeWorld();
    w.store.insertAIProfile({ id: 'p2', ownerId: w.owner, name: 'Second key', vendor: 'anthropic', kind: 'api_key', model: 'claude-haiku-4-5', secretRef: 'ai/p2', createdAt: 'now' });
    const id = await seedRunningAgent(w);
    markBusy(id); held = id;
    const r = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/p2/adopt-agents', headers: as(), payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ switched: 0, skipped: [{ reason: expect.stringMatching(/busy/) }] });
    expect(w.store.getAgent(id)!.aiProfileId).toBe('p1');
  });
});
