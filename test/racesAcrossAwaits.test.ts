import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { SourceGoneError, Store } from '../src/store/store.js';
import { makeWorld, seedRunningAgent, as } from './support/world.js';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTemplate } from '../src/orchestrator/template.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { clearBusy, isBusy, markBusy } from '../src/orchestrator/busy.js';
import { machineTz, monthKey } from '../src/orchestrator/budgets.js';
import { agentMemoryLimits } from '../src/orchestrator/swap.js';
import { GOOGLE_CLIENT_REF, materializeConnections } from '../src/orchestrator/googleConnections.js';
import { beginOperation, filesReplacingCount, noteFilesReplacing } from '../src/orchestrator/operations.js';

/**
 * A check made before an await reserves nothing: each of these held one
 * request at its await, ran the competing one, then let the first go on
 * (the 2026-11-07 deep audit; HB-0603 C). Every name and value is made up.
 */

const OWNER = 'user-household';
const H = { 'x-hatchabot-owner': OWNER };

class MemSecrets {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('no secret'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

/** A promise held open until `release`, and one that says when it was reached. */
function gate() {
  let release!: () => void; let signal!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const reached = new Promise<void>((r) => { signal = r; });
  return { held, reached, release, signal };
}

const opened: Array<() => Promise<void>> = [];
afterEach(async () => {
  clearBusy('a1');
  while (opened.length) await opened.pop()!();
});

async function world(extra: Record<string, unknown> = {}) {
  const store = new Store(new Database(':memory:'));
  const secrets = (extra.secrets as MemSecrets | undefined) ?? new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Cloud', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'garden-notes', workspace: { files: {}, configPatch: { agentId: 'garden-notes', authMode: 'api-key' } as never }, env: {} });
  await provider.start(runtimeRef);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Garden Notes', slug: 'garden-notes', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
  store.setAgentApplied('a1', 'p1', 'claude-sonnet-5');
  const providers = new Map<string, MockProvider>([['mock', provider], ...((extra.providers as Array<[string, MockProvider]> | undefined) ?? [])]);
  const f = Fastify();
  const routes = await registerRoutes(f, {
    store, secrets, providers,
    channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0, list: () => [] }, release: async () => {} },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'secrets' && k !== 'providers')),
  } as never);
  opened.push(async () => { await f.close(); });
  const inject = (method: string, url: string, payload?: unknown) => f.inject({ method: method as never, url, headers: H, ...(payload === undefined ? {} : { payload: payload as never }) });
  return { store, secrets, provider, f, inject, routes };
}

describe('removing a runner (HB-0512)', () => {
  it('sweeps its finished one-shots while it still answers', async () => {
    const runner = new MockProvider();
    const sweeps: unknown[] = [];
    (runner as unknown as { sweepOneShots: (o: unknown) => Promise<number> }).sweepOneShots = async (o) => { sweeps.push(o); return 1; };
    const w = await world({ providers: [['runner-mock', runner]] });
    w.store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'docker', provider: 'runner-mock', name: 'shed', settings: {}, createdAt: 'now' } as never);
    const r = await w.inject('DELETE', '/v1/hosts/h2');
    expect(r.statusCode, r.body).toBe(200);
    expect(w.store.getHost('h2')).toBeUndefined();
    // Exited ones only (a 'created' one may be a call's in flight), and a failed docker call said (orThrow).
    expect(sweeps).toEqual([{ created: false, orThrow: true }]);
  });

  it('says what it could not remove there', async () => {
    const runner = new MockProvider();
    (runner as unknown as { sweepOneShots: () => Promise<number> }).sweepOneShots = async () => { throw new Error('docker said no'); };
    const w = await world({ providers: [['runner-mock', runner]] });
    w.store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'docker', provider: 'runner-mock', name: 'shed', settings: {}, createdAt: 'now' } as never);
    const r = await w.inject('DELETE', '/v1/hosts/h2');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().warning).toMatch(/could not be removed .*hatchabot\.oneshot/);
  });
});

describe('deleting an AI source while an agent is switched to it (HB-0570)', () => {
  it('a switch during the key\'s deletion finds no such source', async () => {
    const g = gate();
    const secrets = new MemSecrets();
    secrets.delete = async (ref: string) => { if (ref === 'ai/p2') { g.signal(); await g.held; } secrets.map.delete(ref); };
    const w = await world({ secrets });
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Spare key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' });
    const deleting = Promise.resolve(w.inject('DELETE', '/v1/ai-profiles/p2'));
    await g.reached;
    const switched = await w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p2' });
    expect(switched.statusCode).toBeGreaterThanOrEqual(400);
    g.release();
    expect((await deleting).statusCode).toBe(200);
    expect(w.store.getAIProfile('p2')).toBeUndefined();
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p1');
  });

  it('a switch whose runtime check was under way when the source went is refused', async () => {
    const g = gate();
    const w = await world();
    // A subscription source whose default model has a minimum OpenClaw: the switch asks the runtime image.
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Family plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.provider.currentImageInfo = async () => { g.signal(); await g.held; return { openclawVersion: '2026.9.8' } as never; };
    const switching = Promise.resolve(w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p2' }));
    await g.reached;
    expect((await w.inject('DELETE', '/v1/ai-profiles/p2')).statusCode).toBe(200);
    g.release();
    const r = await switching;
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe(new SourceGoneError().userMessage);
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p1');
  });

  it('a delete while a switch is under way is refused, and the switch completes', async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Spare key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' });
    // The memory cap's docker update is the wait, after the source was looked at.
    w.provider.updateMemory = async () => { g.signal(); await g.held; };
    const switching = Promise.resolve(w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p2', memoryCap: '2g' }));
    await g.reached;
    const del = await w.inject('DELETE', '/v1/ai-profiles/p2');
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toMatch(/switching to it/);
    g.release();
    const r = await switching;
    expect(r.statusCode, r.body).toBe(200);
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p2');
    expect(w.store.getAIProfile('p2')).toBeTruthy();
    // Let go once it is done: now it is in use, which is the usual refusal.
    expect((await w.inject('DELETE', '/v1/ai-profiles/p2')).statusCode).toBe(400);
  });

  it('a hold is let go when the switch is refused after it was taken', async () => {
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Spare key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.provider.updateMemory = async () => { throw new Error('made-up docker refusal'); };
    const r = await w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p2', memoryCap: '2g' });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p1');
    expect((await w.inject('DELETE', '/v1/ai-profiles/p2')).statusCode).toBe(200);
  });

  it('a delete while agents are moved to it in bulk is refused', async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Family plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.provider.currentImageInfo = async () => { g.signal(); await g.held; return { openclawVersion: '2026.9.8' } as never; };
    const moving = Promise.resolve(w.inject('POST', '/v1/ai-profiles/p2/adopt-agents', { apply: ['a1'] }));
    await g.reached;
    expect((await w.inject('DELETE', '/v1/ai-profiles/p2')).statusCode).toBe(409);
    g.release();
    const r = await moving;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().switched).toBe(1);
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p2');
  });

  it('a delete while a class brings its source is refused', async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Family plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.store.upsertAgentClass({ id: 'cls1', ownerId: OWNER, name: 'Tutors', aiProfileId: 'p2', model: 'claude-opus-5-5' });
    w.provider.currentImageInfo = async () => { g.signal(); await g.held; return { openclawVersion: '2026.9.8' } as never; };
    const joining = Promise.resolve(w.inject('POST', '/v1/agents/a1/class', { classId: 'cls1' }));
    await g.reached;
    expect((await w.inject('DELETE', '/v1/ai-profiles/p2')).statusCode).toBe(409);
    g.release();
    const r = await joining;
    expect(r.statusCode, r.body).toBe(200);
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p2');
  });

  it('should the store still refuse a class\'s source, nothing more of the class is written', async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Family plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.store.upsertAgentClass({ id: 'cls1', ownerId: OWNER, name: 'Tutors', aiProfileId: 'p2', model: 'claude-opus-5-5' });
    w.provider.currentImageInfo = async () => { g.signal(); await g.held; return { openclawVersion: '2026.9.8' } as never; };
    const joining = Promise.resolve(w.inject('POST', '/v1/agents/a1/class', { classId: 'cls1' }));
    await g.reached;
    w.store.deleteAIProfile('p2'); // past the hold: only the store's own check is left
    g.release();
    const r = await joining;
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/deleted meanwhile/);
    const a = w.store.getAgent('a1')!;
    expect(a.aiProfileId).toBe('p1');
    expect(a.model).toBeUndefined();
    expect(a.classId).toBeFalsy();
  });

  it('should the store still refuse it in a bulk move, that agent is skipped and said', async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Family plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.provider.currentImageInfo = async () => { g.signal(); await g.held; return { openclawVersion: '2026.9.8' } as never; };
    const moving = Promise.resolve(w.inject('POST', '/v1/ai-profiles/p2/adopt-agents', { apply: ['a1'] }));
    await g.reached;
    w.store.deleteAIProfile('p2');
    g.release();
    const r = await moving;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().switched).toBe(0);
    expect(r.json().skipped[0]?.reason).toMatch(/deleted meanwhile/);
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p1');
  });

  it('a class applied to an agent already on its source holds nothing: the delete says the source is in use', async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Family plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.store.setAgentAIProfile('a1', 'p2');
    w.store.setAgentApplied('a1', 'p2', 'claude-opus-5-5');
    w.store.upsertAgentClass({ id: 'cls1', ownerId: OWNER, name: 'Tutors', aiProfileId: 'p2', model: 'claude-opus-5-5' });
    // Not a switch: its model check asks the running container.
    w.provider.info = (async () => { g.signal(); await g.held; return { openclawVersion: '2026.9.8' }; }) as never;
    const joining = Promise.resolve(w.inject('POST', '/v1/agents/a1/class', { classId: 'cls1' }));
    await g.reached;
    const del = await w.inject('DELETE', '/v1/ai-profiles/p2');
    expect(del.statusCode).toBe(400);
    expect(del.json().error).toMatch(/^Still in use by Garden Notes/);
    g.release();
    expect((await joining).statusCode).toBeLessThan(300);
  });

  it('a delete while one agent switches to a source another already uses says it is in use', async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Spare key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Piano Practice', slug: 'piano-practice', state: 'STOPPED', aiProfileId: 'p2', hostId: 'h1', runtimeRef: 'mock:piano-practice', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    w.provider.updateMemory = async () => { g.signal(); await g.held; };
    const switching = Promise.resolve(w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p2', memoryCap: '2g' }));
    await g.reached;
    const del = await w.inject('DELETE', '/v1/ai-profiles/p2');
    expect(del.statusCode).toBe(400);
    expect(del.json().error).toMatch(/^Still in use by Piano Practice/);
    g.release();
    expect((await switching).statusCode).toBe(200);
  });

  for (const why of ['the source gone', 'the agent gone', 'the agent busy by then'] as const) {
    it(`a switch refused at the end (${why}) keeps none of the change, renames no bot, and puts the container's limits back`, async () => {
      const g = gate();
      const w = await world();
      w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Spare key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' });
      const limits: Array<[string, string | undefined]> = [];
      w.provider.updateMemory = async (_ref: string, cap: string, swap?: string) => { limits.push([cap, swap]); if (limits.length === 1) { g.signal(); await g.held; } };
      const before = w.provider.execLog.length;
      const saving = Promise.resolve(w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p2', memoryCap: '2g', name: 'Garden Journal', persona: 'Keeps the bed plans', group: 'Home', icon: '🌱' }));
      await g.reached;
      // Past the hold and the busy check: only the transaction's own checks are left.
      if (why === 'the source gone') w.store.deleteAIProfile('p2');
      else if (why === 'the agent gone') w.store.setAgentState('a1', 'DELETING');
      else markBusy('a1');
      g.release();
      const r = await saving;
      expect(r.statusCode).toBe(why === 'the agent gone' ? 404 : 409);
      if (why === 'the agent busy by then') expect(r.json().error).toMatch(/^The agent is busy/);
      const a = w.store.getAgent('a1')!;
      expect([a.name, a.persona, a.group, a.icon, a.memoryCap, a.aiProfileId]).toEqual(['Garden Notes', '', undefined, undefined, undefined, 'p1']);
      expect(w.provider.execLog.slice(before).some((x) => x.includes('set-identity'))).toBe(false);
      // Its container is back on what the store says (one being deleted is left alone).
      if (why !== 'the agent gone') {
        const stored = agentMemoryLimits(w.store, a);
        expect(limits).toEqual([['2g', limits[0]![1]], [stored.memory, stored.swap]]);
      }
    });
  }

  it('a swap refused after the cap took puts the container back on its stored limits', async () => {
    const w = await world();
    const limits: Array<[string, string | undefined]> = [];
    w.provider.updateMemory = async (_ref: string, cap: string, swap?: string) => {
      limits.push([cap, swap]);
      if (limits.length === 2) throw new Error('made-up docker refusal');
    };
    const r = await w.inject('PATCH', '/v1/agents/a1', { memoryCap: '2g', swapAllowance: '1g' });
    expect(r.statusCode).toBe(502);
    const a = w.store.getAgent('a1')!;
    expect([a.memoryCap, a.swapAllowance]).toEqual([undefined, undefined]);
    const stored = agentMemoryLimits(w.store, a);
    expect(limits).toHaveLength(3);
    expect(limits[2]).toEqual([stored.memory, stored.swap]);
  });

  it('an agent deleted during the cap\'s docker call gets no swap call: it was deleted', async () => {
    const g = gate();
    const w = await world();
    const limits: Array<[string, string | undefined]> = [];
    w.provider.updateMemory = async (_ref: string, cap: string, swap?: string) => { limits.push([cap, swap]); if (limits.length === 1) { g.signal(); await g.held; } };
    const saving = Promise.resolve(w.inject('PATCH', '/v1/agents/a1', { memoryCap: '2g', swapAllowance: '1g' }));
    await g.reached;
    w.store.setAgentState('a1', 'DELETING');
    g.release();
    const r = await saving;
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('It was deleted.');
    expect(limits).toHaveLength(1);
  });

  it("an agent deleted during the cap's docker call has none of the change written, a switch or not", async () => {
    const g = gate();
    const w = await world();
    w.provider.updateMemory = async () => { g.signal(); await g.held; };
    const saving = Promise.resolve(w.inject('PATCH', '/v1/agents/a1', { memoryCap: '2g', image: 'ghcr.io/example/runtime:made-up' }));
    await g.reached;
    w.store.setAgentState('a1', 'DELETING');
    g.release();
    const r = await saving;
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('It was deleted.');
    const a = w.store.getAgent('a1')!;
    expect([a.memoryCap, a.image]).toEqual([undefined, undefined]);
  });

  it('a source switch with an image says the class was let go when either step let it go', async () => {
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Spare key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.store.upsertAgentClass({ id: 'cls1', ownerId: OWNER, name: 'Tutors', aiProfileId: 'p1' });
    w.store.setAgentClassIf('a1', null, 'cls1');
    const r = await w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p2', image: 'ghcr.io/example/runtime:made-up' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().classDetached).toBe(true);
    expect(w.store.getAgent('a1')?.classId).toBeFalsy();
  });

  it('a switch whose hold is older than ten minutes no longer keeps its source from being deleted', async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Spare key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.provider.updateMemory = async () => { g.signal(); await g.held; };
    const switching = Promise.resolve(w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p2', memoryCap: '2g' }));
    await g.reached;
    expect((await w.inject('DELETE', '/v1/ai-profiles/p2')).statusCode).toBe(409);
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    try {
      expect((await w.inject('DELETE', '/v1/ai-profiles/p2')).statusCode).toBe(200);
    } finally { later.mockRestore(); }
    g.release();
    expect((await switching).statusCode).toBe(409);
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p1');
  });

  it('the store does not point an agent at a source that is not there, and says which is gone', async () => {
    const w = await world();
    expect(w.store.setAgentAIProfile('a1', 'no-such-source')).toBe('no-source');
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p1');
    expect(w.store.setAgentAIProfile('no-such-agent', 'p1')).toBe('no-agent');
    w.store.setAgentState('a1', 'DELETING');
    expect(w.store.setAgentAIProfile('a1', 'p1')).toBe('no-agent');
  });

  it('an agent deleted while its switch waited is said to be deleted, not its source', async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Spare key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.provider.updateMemory = async () => { g.signal(); await g.held; };
    const switching = Promise.resolve(w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p2', memoryCap: '2g' }));
    await g.reached;
    w.store.setAgentState('a1', 'DELETING');
    g.release();
    const r = await switching;
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('It was deleted.');
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p1');
  });

  it('a class edit judges each member as it is when its turn comes', async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Family plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/p2', createdAt: 'now' });
    const { runtimeRef } = await w.provider.provision({ agentId: 'a2', slug: 'piano-practice', workspace: { files: {}, configPatch: { agentId: 'piano-practice', authMode: 'api-key' } as never }, env: {} });
    await w.provider.start(runtimeRef);
    w.store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Piano Practice', slug: 'piano-practice', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    w.store.upsertAgentClass({ id: 'cls1', ownerId: OWNER, name: 'Tutors' });
    w.store.setAgentClassIf('a1', null, 'cls1');
    w.store.setAgentClassIf('a2', null, 'cls1');
    // Only a switch asks the image it lands on: the first member's is held.
    let first = true;
    w.provider.currentImageInfo = async () => { if (first) { first = false; g.signal(); await g.held; } return { openclawVersion: '2026.9.8' } as never; };
    const editing = Promise.resolve(w.inject('PUT', '/v1/agent-classes/cls1', { aiProfileId: 'p2', model: 'claude-opus-5-5' }));
    await g.reached;
    w.store.setAgentAIProfile('a2', 'p2'); // moved there by hand meanwhile
    g.release();
    const r = await editing;
    expect(r.statusCode, r.body).toBe(200);
    // Only the first was switched by the class, and owes a rebuild for it.
    expect(r.json().needRebuild).toBe(1);
  });

  it('in a bulk move or a class, an agent deleted meanwhile is skipped as deleted', async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Family plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.provider.currentImageInfo = async () => { g.signal(); await g.held; return { openclawVersion: '2026.9.8' } as never; };
    const moving = Promise.resolve(w.inject('POST', '/v1/ai-profiles/p2/adopt-agents', { apply: ['a1'] }));
    await g.reached;
    w.store.setAgentState('a1', 'DELETING');
    g.release();
    const r = await moving;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().skipped[0]?.reason).toBe('it was deleted');

    const g2 = gate();
    const w2 = await world();
    w2.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Family plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/p2', createdAt: 'now' });
    w2.store.upsertAgentClass({ id: 'cls1', ownerId: OWNER, name: 'Tutors', aiProfileId: 'p2', model: 'claude-opus-5-5' });
    w2.provider.currentImageInfo = async () => { g2.signal(); await g2.held; return { openclawVersion: '2026.9.8' } as never; };
    const joining = Promise.resolve(w2.inject('POST', '/v1/agents/a1/class', { classId: 'cls1' }));
    await g2.reached;
    w2.store.setAgentState('a1', 'DELETING');
    g2.release();
    const c = await joining;
    expect(c.json().error).toBe('it was deleted');
    expect(w2.store.getAgent('a1')?.model).toBeUndefined();
  });

  it('a class is judged again where it is written: busy by then, it is not switched; deleted, nothing is written', async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Family plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.store.upsertAgentClass({ id: 'cls1', ownerId: OWNER, name: 'Tutors', aiProfileId: 'p2', model: 'claude-opus-5-5' });
    w.provider.currentImageInfo = async () => { g.signal(); await g.held; return { openclawVersion: '2026.9.8' } as never; };
    const joining = Promise.resolve(w.inject('POST', '/v1/agents/a1/class', { classId: 'cls1' }));
    await g.reached;
    markBusy('a1'); // a rebuild began during its runtime check
    g.release();
    const c = await joining;
    expect(c.json().error).toBe('busy (a rebuild, a move or a backup) — apply the class again when that is done');
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p1');
    clearBusy('a1');

    const g2 = gate();
    const w2 = await world();
    w2.store.upsertAgentClass({ id: 'cls2', ownerId: OWNER, name: 'Pinned', image: 'ghcr.io/example/runtime:made-up' });
    // Not a switch: its image check asks the running container.
    const info = w2.provider.info.bind(w2.provider);
    w2.provider.info = (async (ref: string) => { g2.signal(); await g2.held; return info(ref); }) as never;
    const pinning = Promise.resolve(w2.inject('POST', '/v1/agents/a1/class', { classId: 'cls2' }));
    await g2.reached;
    w2.store.setAgentState('a1', 'DELETING');
    g2.release();
    const p = await pinning;
    expect(p.json().error).toBe('it was deleted');
    expect(w2.store.getAgent('a1')?.image).toBeUndefined();
  });

  it("a switch to this machine's login is refused when the agent moved to a runner during its runtime check", async () => {
    const machineLogin = (w: Awaited<ReturnType<typeof world>>) => {
      w.store.insertAIProfile({ id: 'p3', ownerId: OWNER, name: 'This machine', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', createdAt: 'now' } as never);
      w.store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'docker', provider: 'mock', name: 'shed', settings: {}, createdAt: 'now' } as never);
    };
    const g = gate();
    const w = await world();
    machineLogin(w);
    w.provider.currentImageInfo = async () => { g.signal(); await g.held; return { openclawVersion: '2026.9.8' } as never; };
    const switching = Promise.resolve(w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p3' }));
    await g.reached;
    w.store.setAgentHost('a1', 'h2'); // its move ended meanwhile
    g.release();
    const r = await switching;
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("This Claude Max profile uses this machine's login, which can't reach a runner. Run `claude setup-token` and add it as a setup-token AI source, or use an API-key profile.");
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p1');

    // A class that brings that source: the member is skipped for it.
    const g2 = gate();
    const w2 = await world();
    machineLogin(w2);
    w2.store.upsertAgentClass({ id: 'cls3', ownerId: OWNER, name: 'Home desk', aiProfileId: 'p3', model: 'claude-opus-5-5' });
    w2.provider.currentImageInfo = async () => { g2.signal(); await g2.held; return { openclawVersion: '2026.9.8' } as never; };
    const joining = Promise.resolve(w2.inject('POST', '/v1/agents/a1/class', { classId: 'cls3' }));
    await g2.reached;
    w2.store.setAgentHost('a1', 'h2');
    g2.release();
    const c = await joining;
    expect(c.json().error).toBe("the class's machine-login Max source can't reach an agent on a runner — use a setup-token source");
    expect(w2.store.getAgent('a1')?.aiProfileId).toBe('p1');
  });

  it("in a bulk move, an agent moved to a runner meanwhile is not put on this machine's login", async () => {
    const g = gate();
    const w = await world();
    // A machine-login source: no key of its own, this machine's ~/.claude.
    w.store.insertAIProfile({ id: 'p3', ownerId: OWNER, name: 'This machine', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', createdAt: 'now' } as never);
    w.store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Piano Practice', slug: 'piano-practice', state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock:piano-practice', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    w.store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'docker', provider: 'mock', name: 'shed', settings: {}, createdAt: 'now' } as never);
    let first = true;
    w.provider.currentImageInfo = async () => { if (first) { first = false; g.signal(); await g.held; } return { openclawVersion: '2026.9.8' } as never; };
    const moving = Promise.resolve(w.inject('POST', '/v1/ai-profiles/p3/adopt-agents', { apply: ['a1', 'a2'] }));
    await g.reached;
    // Both moved to the runner while the first one's runtime was asked about.
    w.store.setAgentHost('a1', 'h2');
    w.store.setAgentHost('a2', 'h2');
    g.release();
    const r = await moving;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().switched).toBe(0);
    expect(r.json().skipped.map((x: { reason: string }) => x.reason)).toEqual([
      "machine-login Max can't run on a runner — use a setup-token source",
      "machine-login Max can't run on a runner — use a setup-token source",
    ]);
    expect([w.store.getAgent('a1')?.aiProfileId, w.store.getAgent('a2')?.aiProfileId]).toEqual(['p1', 'p1']);
  });

  it("once a switch is stored its source is held no longer: the in-use check answers from then on", async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Spare key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' });
    // Its task switch is set live after the commit: that is the wait.
    const exec = w.provider.exec.bind(w.provider);
    w.provider.exec = (async (ref: string, argv: string[], opts?: never) => {
      if (argv[0] === 'config' && argv[2] === 'cron.triggers.enabled') { g.signal(); await g.held; }
      return exec(ref, argv, opts);
    }) as never;
    const switching = Promise.resolve(w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p2', cronTriggers: true }));
    await g.reached;
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p2');
    const del = await w.inject('DELETE', '/v1/ai-profiles/p2');
    expect(del.statusCode).toBe(400);
    expect(del.json().error).toMatch(/^Still in use by Garden Notes/);
    // Moved off it again meanwhile: nothing holds it, and it can go.
    expect((await w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p1' })).statusCode).toBe(200);
    expect((await w.inject('DELETE', '/v1/ai-profiles/p2')).statusCode).toBe(200);
    g.release();
    await switching;
  });

  it('a caller that hangs up does not let the hold go while the switch goes on', async () => {
    const g = gate();
    const w = await world();
    const raws: Array<{ emit(e: string): boolean }> = [];
    w.f.addHook('onRequest', async (_req, reply) => { raws.push(reply.raw); });
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Spare key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.provider.updateMemory = async () => { g.signal(); await g.held; };
    const switching = Promise.resolve(w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p2', memoryCap: '2g' })).catch(() => undefined);
    await g.reached;
    raws[0]!.emit('close'); // the socket went; the handler goes on
    expect((await w.inject('DELETE', '/v1/ai-profiles/p2')).statusCode).toBe(409);
    g.release();
    await switching;
    await vi.waitFor(() => expect(w.store.getAgent('a1')?.aiProfileId).toBe('p2'));
    expect(w.store.getAIProfile('p2')).toBeTruthy();
  });

  it('should the store still refuse the source, the switch stops there: its pin stays, and it answers 409', async () => {
    const g = gate();
    const w = await world();
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Spare key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' });
    w.store.setAgentModel('a1', 'claude-opus-5-5');
    w.provider.updateMemory = async () => { g.signal(); await g.held; };
    const switching = Promise.resolve(w.inject('PATCH', '/v1/agents/a1', { aiProfileId: 'p2', memoryCap: '2g' }));
    await g.reached;
    w.store.deleteAIProfile('p2'); // past the hold: only the store's own check is left
    g.release();
    const r = await switching;
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe(new SourceGoneError().userMessage);
    expect(w.store.getAgent('a1')?.aiProfileId).toBe('p1');
    expect(w.store.getAgent('a1')?.model).toBe('claude-opus-5-5');
  });
});

describe('a PATCH rolled back (HB-0570)', () => {
  it('logs nothing it did not store', async () => {
    const w = await world();
    // The app's log is one object for every app built without a logger.
    const logged = vi.spyOn(w.f.log, 'info');
    opened.push(async () => { logged.mockRestore(); });
    vi.spyOn(w.store, 'setAgentName').mockImplementation(() => { throw new Error('disk full'); });
    const r = await w.inject('PATCH', '/v1/agents/a1', { memoryCap: '2g', embedMode: 'baked', name: 'Herb Notes' });
    expect(r.statusCode).toBe(500);
    const said = logged.mock.calls.map((c) => c[1]);
    expect(said).not.toContain('embed.mode');
    expect(said).not.toContain('memory.cap_set');
    expect(w.store.listEvents(['a1']).map((e) => e.event)).not.toContain('memory.cap_set');
    expect(w.store.getAgent('a1')?.name).toBe('Garden Notes');
  });

  it('a change stored logs its traces once it is', async () => {
    const w = await world();
    const logged = vi.spyOn(w.f.log, 'info');
    opened.push(async () => { logged.mockRestore(); });
    const r = await w.inject('PATCH', '/v1/agents/a1', { memoryCap: '2g', embedMode: 'baked' });
    expect(r.statusCode, r.body).toBe(200);
    const said = logged.mock.calls.map((c) => c[1]);
    expect(said).toContain('embed.mode');
    expect(said).toContain('memory.cap_set');
    expect(w.store.listEvents(['a1']).map((e) => e.event)).toEqual(expect.arrayContaining(['embed.mode', 'memory.cap_set']));
  });
});

describe('an import, and the source it goes on deleted meanwhile (HB-0570)', () => {
  async function restoreWorlds() {
    const src = await makeWorld();
    opened.push(async () => { await src.f.close(); });
    await seedRunningAgent(src);
    const file = (await src.f.inject({ method: 'GET', url: '/v1/agents/a1/backup', headers: as() })).rawPayload;
    const dst = await makeWorld('owner-b');
    opened.push(async () => { await dst.f.close(); });
    const g = gate();
    dst.provider.currentImageInfo = async () => { g.signal(); await g.held; return { openclawVersion: '2026.9.8' } as never; };
    const restore = (query = '') => Promise.resolve(dst.f.inject({ method: 'POST', url: '/v1/agents/restore' + query, headers: { ...as('owner-b'), 'content-type': 'application/octet-stream' }, payload: file }));
    return { dst, g, restore };
  }

  for (const query of ['?aiProfileId=p2', '?aiProfileId=p2&async=1']) {
    it(`a source named for it is not held while it runs: its delete goes through, and the import is refused with 409 (${query})`, async () => {
      const { dst, g, restore } = await restoreWorlds();
      dst.store.insertAIProfile({ id: 'p2', ownerId: 'owner-b', name: 'Spare key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' });
      await dst.secrets.put('ai/p2', 'made-up-key');
      const importing = restore(query);
      await g.reached;
      expect((await dst.f.inject({ method: 'DELETE', url: '/v1/ai-profiles/p2', headers: as('owner-b') })).statusCode).toBe(200);
      g.release();
      // Refused where the agent is written, before its operation begins: an
      // async import answers it itself, rather than a 202 to poll.
      const r = await importing;
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatch(/deleted meanwhile/);
      expect(dst.store.listAllActiveAgents()).toEqual([]);
    });
  }

  it('a source named for it that is already gone fails at once', async () => {
    const { dst, restore } = await restoreWorlds();
    dst.provider.currentImageInfo = async () => { throw new Error('should not get this far'); };
    const r = await restore('?aiProfileId=gone-source');
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/Unknown AI profile/);
  });

  it('one it picked itself, deleted while it waited, is refused with 409 and no agent', async () => {
    const { dst, g, restore } = await restoreWorlds();
    const importing = restore();
    await g.reached;
    expect((await dst.f.inject({ method: 'DELETE', url: '/v1/ai-profiles/p1', headers: as('owner-b') })).statusCode).toBe(200);
    g.release();
    const r = await importing;
    expect(r.statusCode).toBe(409);
    expect(dst.store.listAllActiveAgents()).toEqual([]);
  });

  it('a template import whose source is gone says so, not that the name is taken', async () => {
    const w = await world();
    const data = gzipSync(JSON.stringify({ format: 'hatchabot-template', version: 1, exportedAt: 'now', agent: { name: 'Bird Log', persona: '', sharedMemory: true }, files: { 'SOUL.md': 'Notes birds.' }, ai: { vendor: 'anthropic' }, parameters: [] }));
    // Listed when the template picked it, gone when the agent is written.
    vi.spyOn(w.store, 'getAIProfile').mockReturnValue(undefined);
    let thrown: unknown;
    try { importTemplate({ store: w.store, provider: w.provider }, data, { ownerId: OWNER }); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(SourceGoneError);
    expect((thrown as SourceGoneError).statusCode).toBe(409);
    expect((thrown as SourceGoneError).userMessage).toMatch(/deleted meanwhile/);
    expect(w.store.listAgents(OWNER).map((a) => a.name)).toEqual(['Garden Notes']);
  });

  it('the store refuses a new agent on a source that is not there', async () => {
    const w = await world();
    expect(() => w.store.insertAgentOnSource({ id: 'a9', ownerId: OWNER, name: 'Piano Practice', slug: 'piano-practice', state: 'PROVISIONING', aiProfileId: 'gone', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never)).toThrow(SourceGoneError);
    expect(w.store.getAgent('a9')).toBeUndefined();
  });
});

/** Answers the core-file reads and writes the snapshot and save routes make, from `files`. */
function fileShell(files: Record<string, string>, holdOn?: { name: string; g: ReturnType<typeof gate> }) {
  let held = false;
  return async (_ref: string, script: string) => {
    const name = /\/(SOUL|AGENTS|MEMORY|USER|IDENTITY|TOOLS)\.md/.exec(script)?.[1];
    if (!name) return { code: 0, stdout: '', stderr: '' };
    const file = `${name}.md`;
    if (script.startsWith('head ')) {
      if (holdOn && !held && file === holdOn.name) { held = true; holdOn.g.signal(); await holdOn.g.held; }
      return { code: 0, stdout: files[file] ?? '', stderr: '' };
    }
    const b64 = /echo "([A-Za-z0-9+/=]+)"/.exec(script)?.[1];
    if (b64) files[file] = Buffer.from(b64, 'base64').toString();
    return { code: 0, stdout: '', stderr: '' };
  };
}

describe('a core-file save and a persona change at once (HB-0567)', () => {
  it('the save keeps the persona set meanwhile in the setup layer', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParamState('a1', { style: 'calm' }, { soul: 'Soul {{style}}', agents: 'Rules', persona: 'Old persona' });
    w.provider.execShell = fileShell({ 'SOUL.md': 'Soul calm', 'AGENTS.md': 'Rules' }, { name: 'SOUL.md', g }) as never;
    const saving = Promise.resolve(w.inject('PUT', '/v1/agents/a1/files/SOUL.md', { content: 'New soul' }));
    await g.reached;
    expect((await w.inject('PATCH', '/v1/agents/a1', { persona: 'New persona' })).statusCode).toBe(200);
    g.release();
    expect((await saving).statusCode).toBe(200);
    const a = w.store.getAgent('a1')!;
    expect(a.persona).toBe('New persona');
    expect(a.paramFiles?.persona).toBe('New persona');
    expect(a.paramFiles?.soul).toBe('New soul');
  });

  it('Apply values renders the description from the layer as it is once its writes are done', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'calm' }, { soul: 'Soul {{style}}', agents: 'Rules', persona: 'Helps in a {{style}} way' });
    w.store.setAgentPersona('a1', 'Helps in a calm way');
    w.provider.execShell = fileShell({ 'SOUL.md': 'Soul calm', 'AGENTS.md': 'Rules' }, { name: 'SOUL.md', g }) as never;
    const applying = Promise.resolve(w.inject('PUT', '/v1/agents/a1/params', { values: { style: 'brisk' } }));
    await g.reached;
    expect((await w.inject('PATCH', '/v1/agents/a1', { persona: 'Answers in a {{style}} tone' })).statusCode).toBe(200);
    g.release();
    expect((await applying).statusCode).toBe(200);
    const a = w.store.getAgent('a1')!;
    expect(a.paramFiles?.persona).toBe('Answers in a {{style}} tone');
    expect(a.persona).toBe('Answers in a brisk tone');
    expect(a.paramValues).toEqual({ style: 'brisk' });
  });

  it('Apply values says so when the description changed meanwhile cannot take the values', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'calm' }, { soul: 'Soul {{style}}', agents: 'Rules', persona: 'Helps in a {{style}} way' });
    w.store.setAgentPersona('a1', 'Helps in a calm way');
    w.provider.execShell = fileShell({ 'SOUL.md': 'Soul calm', 'AGENTS.md': 'Rules' }, { name: 'SOUL.md', g }) as never;
    const applying = Promise.resolve(w.inject('PUT', '/v1/agents/a1/params', { values: { style: 'y'.repeat(2000) } }));
    await g.reached;
    // A template the long value makes over the limit; the one read at the start was fine.
    const longer = `${'Tends the beds. '.repeat(230)}{{style}} {{style}} {{style}}`;
    expect((await w.inject('PATCH', '/v1/agents/a1', { persona: longer })).statusCode).toBe(200);
    g.release();
    const r = await applying;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().applied).toBe(true);
    expect(r.json().warning).toMatch(/description .* not filled in/);
    expect(w.store.getAgent('a1')?.persona).toBe(longer);
  });

  it('a definition pushed to a child keeps the description it was given meanwhile', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: false, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'calm' }, { soul: 'Soul {{style}}', agents: 'Rules' });
    const { runtimeRef } = await w.provider.provision({ agentId: 'a2', slug: 'piano-practice', workspace: { files: {}, configPatch: { agentId: 'piano-practice', authMode: 'api-key' } as never }, env: {} });
    await w.provider.start(runtimeRef);
    w.store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Piano Practice', slug: 'piano-practice', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: 'Old child persona', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    w.store.setAgentParent('a2', 'a1');
    w.store.setAgentParamState('a2', { style: 'brisk' }, { soul: 'Old soul {{style}}', agents: 'Old rules', persona: 'Old child persona' });
    w.provider.execShell = fileShell({ 'SOUL.md': 'Old soul brisk', 'AGENTS.md': 'Old rules' }, { name: 'SOUL.md', g }) as never;
    const pushing = Promise.resolve(w.inject('POST', '/v1/agents/a1/push-definition'));
    await g.reached;
    expect((await w.inject('PATCH', '/v1/agents/a2', { persona: 'New child persona' })).statusCode).toBe(200);
    g.release();
    const r = await pushing;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().results?.[0]?.ok ?? r.json().pushed?.[0]?.ok).toBe(true);
    const child = w.store.getAgent('a2')!;
    expect(child.paramFiles).toEqual({ soul: 'Soul {{style}}', agents: 'Rules', persona: 'New child persona' });
  });

  it('the store writes one file of the layer, and leaves the rest as it is', async () => {
    const w = await world();
    w.store.setAgentParamFile('a1', 'persona', 'Begun');
    expect(w.store.getAgent('a1')?.paramFiles).toEqual({ persona: 'Begun' });
    w.store.setAgentParamState('a1', { style: 'calm' }, { soul: 'Soul {{style}}', agents: 'Rules', persona: 'Old' });
    w.store.setAgentParamFile('a1', 'soul', 'New soul with "quotes" and {{style}}');
    expect(w.store.getAgent('a1')?.paramFiles).toEqual({ soul: 'New soul with "quotes" and {{style}}', agents: 'Rules', persona: 'Old' });
    w.store.setAgentParamFile('a1', 'agents', undefined);
    expect(w.store.getAgent('a1')?.paramFiles).toEqual({ soul: 'New soul with "quotes" and {{style}}', persona: 'Old' });
    expect(w.store.getAgent('a1')?.paramValues).toEqual({ style: 'calm' });
  });
});

describe('a manual snapshot during a setup-values change (HB-0566)', () => {
  it('a change of setup values waits for the snapshot under way: the snapshot is one moment', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'old' }, { soul: 'Soul {{style}}', agents: 'Rules {{style}}' });
    w.provider.execShell = fileShell({ 'SOUL.md': 'Soul old', 'AGENTS.md': 'Rules old', 'MEMORY.md': 'Memory' }, { name: 'SOUL.md', g }) as never;
    const snapping = Promise.resolve(w.inject('POST', '/v1/agents/a1/snapshots', { label: 'Before the move' }));
    await g.reached;
    const looked = vi.spyOn(w.store, 'getAgent');
    const changing = Promise.resolve(w.inject('PUT', '/v1/agents/a1/params', { values: { style: 'new' } }));
    // Under way, waiting its turn behind the snapshot, and not yet busy:
    // waiting on a snapshot does not hold the agent up for anything else.
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a1'));
    expect(isBusy('a1')).toBe(false);
    g.release();
    const snap = await snapping;
    expect(snap.statusCode).toBe(201);
    const files = w.store.getSnapshot('a1', snap.json().id)!.files;
    expect(files['SOUL.md']).toBe('Soul old');
    expect(files['AGENTS.md']).toBe('Rules old');
    expect((await changing).statusCode).toBe(200);
  });

  it('a snapshot during a change of setup values waits for it, and holds both new files', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'old' }, { soul: 'Soul {{style}}', agents: 'Rules {{style}}' });
    const base = fileShell({ 'SOUL.md': 'Soul old', 'AGENTS.md': 'Rules old', 'MEMORY.md': 'Memory' });
    let held = false;
    // Held once SOUL.md has the new values and AGENTS.md not yet.
    w.provider.execShell = (async (ref: string, script: string) => {
      const r = await base(ref, script);
      if (!held && /SOUL\.md/.test(script) && /echo "/.test(script)) { held = true; g.signal(); await g.held; }
      return r;
    }) as never;
    const changing = Promise.resolve(w.inject('PUT', '/v1/agents/a1/params', { values: { style: 'new' } }));
    await g.reached;
    // The change is held mid-write; the snapshot's first look at the agent is its arrival.
    const looked = vi.spyOn(w.store, 'getAgent');
    const snapping = Promise.resolve(w.inject('POST', '/v1/agents/a1/snapshots', { label: 'Mid-change' }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a1'));
    g.release();
    expect((await changing).statusCode).toBe(200);
    const snap = await snapping;
    expect(snap.statusCode, snap.body).toBe(201);
    const taken = w.store.getSnapshot('a1', snap.json().id)!;
    expect(taken.files['SOUL.md']).toBe('Soul new');
    expect(taken.files['AGENTS.md']).toBe('Rules new');
    // And the values and layer they were made from, not the old ones.
    expect(taken.params).toEqual({ values: { style: 'new' }, soul: 'Soul {{style}}', agents: 'Rules {{style}}' });
  });

  it('a snapshot that waited while its agent was archived says so, and takes nothing', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'old' }, { soul: 'Soul {{style}}', agents: 'Rules {{style}}' });
    const base = fileShell({ 'SOUL.md': 'Soul old', 'AGENTS.md': 'Rules old', 'MEMORY.md': 'Memory' });
    let held = false;
    w.provider.execShell = (async (ref: string, script: string) => {
      const r = await base(ref, script);
      if (!held && /SOUL\.md/.test(script) && /echo "/.test(script)) { held = true; g.signal(); await g.held; }
      return r;
    }) as never;
    const changing = Promise.resolve(w.inject('PUT', '/v1/agents/a1/params', { values: { style: 'new' } }));
    await g.reached;
    const looked = vi.spyOn(w.store, 'getAgent');
    const snapping = Promise.resolve(w.inject('POST', '/v1/agents/a1/snapshots', { label: 'Before the trip' }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a1'));
    w.store.setAgentState('a1', 'STOPPED');
    w.store.setAgentState('a1', 'ARCHIVED');
    g.release();
    await changing;
    const snap = await snapping;
    expect(snap.statusCode).toBe(409);
    expect(snap.json().error).toBe('It was archived. Unarchive it to snapshot its files.');
    expect(w.store.listSnapshots('a1').some((x) => x.label === 'Before the trip')).toBe(false);
  });

  it('a SOUL.md saved ahead of a waiting Apply values is what it renders, not the layer read before', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'old' }, { soul: 'Soul {{style}}', agents: 'Rules {{style}}' });
    const files: Record<string, string> = { 'SOUL.md': 'Soul old', 'AGENTS.md': 'Rules old', 'MEMORY.md': 'Memory' };
    w.provider.execShell = fileShell(files, { name: 'SOUL.md', g }) as never;
    const snapping = Promise.resolve(w.inject('POST', '/v1/agents/a1/snapshots', { label: 'Before the trip' }));
    await g.reached;
    const looked = vi.spyOn(w.store, 'getAgent');
    // The save waits its turn behind the snapshot, then Apply values behind the save.
    const saving = Promise.resolve(w.inject('PUT', '/v1/agents/a1/files/SOUL.md', { content: 'Saved soul, {{style}}' }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a1'));
    looked.mockClear();
    const applying = Promise.resolve(w.inject('PUT', '/v1/agents/a1/params', { values: { style: 'new' } }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a1'));
    g.release();
    expect((await snapping).statusCode).toBe(201);
    const saved = await saving;
    expect(saved.statusCode, saved.body).toBe(200);
    const r = await applying;
    expect(r.statusCode, r.body).toBe(200);
    expect(files['SOUL.md']).toBe('Saved soul, new');
    expect(files['AGENTS.md']).toBe('Rules new');
    expect(w.store.getAgent('a1')?.paramFiles?.soul).toBe('Saved soul, {{style}}');
  });

  it("on a master's first edit, a second Apply values that waited renders from the layer the first stored", async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    // A master: no layer stored yet, its live files hold the placeholders.
    const files: Record<string, string> = { 'SOUL.md': 'Soul {{style}}', 'AGENTS.md': 'Rules {{style}}', 'MEMORY.md': 'Memory' };
    w.provider.execShell = fileShell(files, { name: 'SOUL.md', g }) as never;
    const snapping = Promise.resolve(w.inject('POST', '/v1/agents/a1/snapshots', { label: 'Before the edit' }));
    await g.reached;
    const looked = vi.spyOn(w.store, 'getAgent');
    const first = Promise.resolve(w.inject('PUT', '/v1/agents/a1/params', { values: { style: 'brisk' } }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a1'));
    looked.mockClear();
    const second = Promise.resolve(w.inject('PUT', '/v1/agents/a1/params', { values: { style: 'gentle' } }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a1'));
    g.release();
    expect((await snapping).statusCode).toBe(201);
    expect((await first).statusCode).toBe(200);
    const r = await second;
    expect(r.statusCode, r.body).toBe(200);
    expect(files['SOUL.md']).toBe('Soul gentle');
    expect(w.store.getAgent('a1')?.paramFiles).toMatchObject({ soul: 'Soul {{style}}', agents: 'Rules {{style}}' });
  });

  it('Apply values that waited while its agent was archived is refused, and writes nothing', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'old' }, { soul: 'Soul {{style}}', agents: 'Rules {{style}}' });
    const files: Record<string, string> = { 'SOUL.md': 'Soul old', 'AGENTS.md': 'Rules old', 'MEMORY.md': 'Memory' };
    w.provider.execShell = fileShell(files, { name: 'SOUL.md', g }) as never;
    const snapping = Promise.resolve(w.inject('POST', '/v1/agents/a1/snapshots', { label: 'Before the trip' }));
    await g.reached;
    const looked = vi.spyOn(w.store, 'getAgent');
    const applying = Promise.resolve(w.inject('PUT', '/v1/agents/a1/params', { values: { style: 'new' } }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a1'));
    w.store.setAgentState('a1', 'STOPPED');
    w.store.setAgentState('a1', 'ARCHIVED');
    g.release();
    await snapping;
    const r = await applying;
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('Start the agent to change its setup values.');
    expect(files['SOUL.md']).toBe('Soul old');
    expect(w.store.getAgent('a1')?.paramValues).toEqual({ style: 'old' });
  });

  it("a child's own Apply values that finished while a push waited keeps its value", async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: false, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'calm' }, { soul: 'Soul {{style}}', agents: 'Rules {{style}}' });
    const { runtimeRef } = await w.provider.provision({ agentId: 'a2', slug: 'piano-practice', workspace: { files: {}, configPatch: { agentId: 'piano-practice', authMode: 'api-key' } as never }, env: {} });
    await w.provider.start(runtimeRef);
    w.store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Piano Practice', slug: 'piano-practice', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    w.store.setAgentParent('a2', 'a1');
    w.store.setAgentParameters('a2', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    w.store.setAgentParamState('a2', { style: 'brisk' }, { soul: 'Old soul {{style}}', agents: 'Old rules {{style}}' });
    // The child's files: the master has its layer stored, so nothing of its own is read.
    const files: Record<string, string> = { 'SOUL.md': 'Old soul brisk', 'AGENTS.md': 'Old rules brisk', 'MEMORY.md': 'Memory' };
    w.provider.execShell = fileShell(files, { name: 'SOUL.md', g }) as never;
    const snapping = Promise.resolve(w.inject('POST', '/v1/agents/a2/snapshots', { label: 'Before the recital' }));
    await g.reached;
    const looked = vi.spyOn(w.store, 'getAgent');
    const own = Promise.resolve(w.inject('PUT', '/v1/agents/a2/params', { values: { style: 'gentle' } }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a2'));
    const listed = vi.spyOn(w.store, 'listChildren');
    const pushing = Promise.resolve(w.inject('POST', '/v1/agents/a1/push-definition'));
    await vi.waitFor(() => expect(listed).toHaveBeenCalled());
    g.release();
    expect((await snapping).statusCode).toBe(201);
    expect((await own).statusCode).toBe(200);
    const r = await pushing;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().results[0].ok, r.body).toBe(true);
    expect(w.store.getAgent('a2')?.paramValues).toEqual({ style: 'gentle' });
    expect(files['SOUL.md']).toBe('Soul gentle');
  });

  it('a restore that waited while its agent moved is refused, and writes nothing', async () => {
    const g = gate();
    const w = await world();
    const files: Record<string, string> = { 'SOUL.md': 'Soul then', 'AGENTS.md': 'Rules then', 'MEMORY.md': 'Memory' };
    w.provider.execShell = fileShell(files) as never;
    const taken = await w.inject('POST', '/v1/agents/a1/snapshots', { label: 'Last week' });
    expect(taken.statusCode).toBe(201);
    files['SOUL.md'] = 'Soul now';
    w.provider.execShell = fileShell(files, { name: 'SOUL.md', g }) as never;
    const snapping = Promise.resolve(w.inject('POST', '/v1/agents/a1/snapshots', { label: 'Before the move' }));
    await g.reached;
    const looked = vi.spyOn(w.store, 'getAgent');
    const restoring = Promise.resolve(w.inject('POST', `/v1/agents/a1/snapshots/${taken.json().id}/restore?wait=1`));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a1'));
    // Moved to another machine meanwhile.
    w.store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'shed', settings: {}, createdAt: 'now' });
    w.store.setAgentHost('a1', 'h2');
    w.store.setAgentRuntimeRef('a1', 'mock:garden-notes-moved');
    g.release();
    expect((await snapping).statusCode).toBe(201);
    const r = await restoring;
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('It moved while this waited; restore again.');
    expect(files['SOUL.md']).toBe('Soul now');
  });

  it('Apply values that waited behind a push takes the field it added, with the value the push gave it', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [
      { key: 'style', label: 'Style', type: 'text', required: false, target: 'soul' },
      { key: 'mood', label: 'Mood', type: 'text', required: false, default: 'cheerful', target: 'soul' },
    ] as never);
    w.store.setAgentParamState('a1', { style: 'calm', mood: 'cheerful' }, { soul: 'Soul {{style}} {{mood}}', agents: 'Rules' });
    const { runtimeRef } = await w.provider.provision({ agentId: 'a2', slug: 'piano-practice', workspace: { files: {}, configPatch: { agentId: 'piano-practice', authMode: 'api-key' } as never }, env: {} });
    await w.provider.start(runtimeRef);
    w.store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Piano Practice', slug: 'piano-practice', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    w.store.setAgentParent('a2', 'a1');
    // The child knows one field; it kept a mood it was given before.
    w.store.setAgentParameters('a2', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    w.store.setAgentParamState('a2', { style: 'brisk', mood: 'sleepy' }, { soul: 'Old soul {{style}}', agents: 'Rules' });
    const files: Record<string, string> = { 'SOUL.md': 'Old soul brisk', 'AGENTS.md': 'Rules', 'MEMORY.md': 'Memory' };
    w.provider.execShell = fileShell(files, { name: 'SOUL.md', g }) as never;
    const snapping = Promise.resolve(w.inject('POST', '/v1/agents/a2/snapshots', { label: 'Before the recital' }));
    await g.reached;
    const listed = vi.spyOn(w.store, 'listChildren');
    const pushing = Promise.resolve(w.inject('POST', '/v1/agents/a1/push-definition'));
    await vi.waitFor(() => expect(listed).toHaveBeenCalled());
    const looked = vi.spyOn(w.store, 'getAgent');
    const applying = Promise.resolve(w.inject('PUT', '/v1/agents/a2/params', { values: { style: 'gentle' } }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a2'));
    g.release();
    expect((await snapping).statusCode).toBe(201);
    expect((await pushing).json().results[0].ok).toBe(true);
    const r = await applying;
    expect(r.statusCode, r.body).toBe(200);
    expect(w.store.getAgent('a2')?.paramValues).toEqual({ style: 'gentle', mood: 'sleepy' });
    expect(files['SOUL.md']).toBe('Soul gentle sleepy');
  });

  it('a reset that waited behind a push puts back only the fields it showed, and keeps the one the push added', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [
      { key: 'style', label: 'Style', type: 'text', required: false, default: 'calm', target: 'soul' },
      { key: 'mood', label: 'Mood', type: 'text', required: false, default: 'cheerful', target: 'soul' },
    ] as never);
    w.store.setAgentParamState('a1', { style: 'calm', mood: 'cheerful' }, { soul: 'Soul {{style}} {{mood}}', agents: 'Rules' });
    const { runtimeRef } = await w.provider.provision({ agentId: 'a2', slug: 'piano-practice', workspace: { files: {}, configPatch: { agentId: 'piano-practice', authMode: 'api-key' } as never }, env: {} });
    await w.provider.start(runtimeRef);
    w.store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Piano Practice', slug: 'piano-practice', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    w.store.setAgentParent('a2', 'a1');
    // The child knows one field; it kept a mood it was given before.
    w.store.setAgentParameters('a2', [{ key: 'style', label: 'Style', type: 'text', required: false, default: 'calm', target: 'soul' }] as never);
    w.store.setAgentParamState('a2', { style: 'brisk', mood: 'sleepy' }, { soul: 'Old soul {{style}}', agents: 'Rules' });
    const files: Record<string, string> = { 'SOUL.md': 'Old soul brisk', 'AGENTS.md': 'Rules', 'MEMORY.md': 'Memory' };
    w.provider.execShell = fileShell(files, { name: 'SOUL.md', g }) as never;
    const snapping = Promise.resolve(w.inject('POST', '/v1/agents/a2/snapshots', { label: 'Before the recital' }));
    await g.reached;
    const listed = vi.spyOn(w.store, 'listChildren');
    const pushing = Promise.resolve(w.inject('POST', '/v1/agents/a1/push-definition'));
    await vi.waitFor(() => expect(listed).toHaveBeenCalled());
    const looked = vi.spyOn(w.store, 'getAgent');
    const resetting = Promise.resolve(w.inject('PUT', '/v1/agents/a2/params', { reset: true }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a2'));
    g.release();
    expect((await snapping).statusCode).toBe(201);
    expect((await pushing).json().results[0].ok).toBe(true);
    const r = await resetting;
    expect(r.statusCode, r.body).toBe(200);
    // Style, which it showed, back to its default; mood, which it never showed, as it was.
    expect(w.store.getAgent('a2')?.paramValues).toEqual({ style: 'calm', mood: 'sleepy' });
    expect(files['SOUL.md']).toBe('Soul calm sleepy');
  });

  it('a snapshot while the agent is busy otherwise (a backup) is taken', async () => {
    const w = await world();
    w.provider.execShell = fileShell({ 'SOUL.md': 'Soul', 'AGENTS.md': 'Rules', 'MEMORY.md': 'Memory' }) as never;
    markBusy('a1'); // a backup holds it: it reads the files, it does not replace them
    const snap = await w.inject('POST', '/v1/agents/a1/snapshots', { label: 'During the backup' });
    expect(snap.statusCode, snap.body).toBe(201);
  });

  it('a snapshot asked for during a rebuild is refused, and takes nothing', async () => {
    const g = gate();
    const w = await world();
    // An agent of its own: a rebuild that fails here is remembered by its id for later tests.
    const { runtimeRef } = await w.provider.provision({ agentId: 'a7', slug: 'bird-count', workspace: { files: {}, configPatch: { agentId: 'bird-count', authMode: 'api-key' } as never }, env: {} });
    await w.provider.start(runtimeRef);
    w.store.insertAgent({ id: 'a7', ownerId: OWNER, name: 'Bird Count', slug: 'bird-count', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    // Held in the rebuild's own snapshot, which it takes first, under its busy flag.
    w.provider.execShell = fileShell({ 'SOUL.md': 'Soul', 'AGENTS.md': 'Rules', 'MEMORY.md': 'Memory' }, { name: 'SOUL.md', g }) as never;
    const rebuilding = await w.inject('POST', '/v1/agents/a7/rebuild', {});
    expect(rebuilding.statusCode, rebuilding.body).toBe(202);
    await g.reached;
    const snap = await w.inject('POST', '/v1/agents/a7/snapshots', { label: 'Mid-rebuild' });
    expect(snap.statusCode).toBe(409);
    expect(snap.json().error).toBe('It is busy (a rebuild); take the snapshot when that ends.');
    expect(w.store.listSnapshots('a7').some((x) => x.label === 'Mid-rebuild')).toBe(false);
    g.release();
    await vi.waitFor(() => expect(isBusy('a7')).toBe(false));
  });

  it('a Rebuild pressed while a snapshot reads goes ahead, and the snapshot is dropped, not stored', async () => {
    const g = gate();
    const w = await world();
    // An agent of its own: a rebuild that fails here is remembered by its id for later tests.
    const { runtimeRef } = await w.provider.provision({ agentId: 'a8', slug: 'tide-log', workspace: { files: {}, configPatch: { agentId: 'tide-log', authMode: 'api-key' } as never }, env: {} });
    await w.provider.start(runtimeRef);
    w.store.insertAgent({ id: 'a8', ownerId: OWNER, name: 'Tide Log', slug: 'tide-log', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    w.provider.execShell = fileShell({ 'SOUL.md': 'Soul', 'AGENTS.md': 'Rules', 'MEMORY.md': 'Memory' }, { name: 'SOUL.md', g }) as never;
    const taking = Promise.resolve(w.inject('POST', '/v1/agents/a8/snapshots', { label: 'By hand' }));
    await g.reached;
    const rebuilding = await w.inject('POST', '/v1/agents/a8/rebuild', {});
    expect(rebuilding.statusCode, rebuilding.body).toBe(202);
    // It runs, while the snapshot by hand still reads.
    await vi.waitFor(() => expect(w.store.listOperations(['a8'], 5).find((o) => o.kind === 'rebuild')?.status).not.toBe('queued'));
    g.release();
    const snap = await taking;
    expect(snap.statusCode, snap.body).toBe(409);
    expect(snap.json().error).toBe('A rebuild or restore started while the snapshot read its files; take it again.');
    expect(w.store.listSnapshots('a8').some((x) => x.label === 'By hand')).toBe(false);
    await vi.waitFor(() => expect(isBusy('a8')).toBe(false));
  });

  it("a deleted agent's count of changes to its files goes with it", async () => {
    const w = await world();
    noteFilesReplacing('a1');
    expect(filesReplacingCount('a1')).toBeGreaterThan(0);
    expect((await w.inject('DELETE', '/v1/agents/a1')).statusCode).toBeLessThan(300);
    expect(filesReplacingCount('a1')).toBe(0);
  });

  it('a change that replaces the files counts when it starts running, not when it is queued', async () => {
    const w = await world();
    const before = filesReplacingCount('a1');
    const op = beginOperation(w.store, 'rebuild', 'a1', {}, { queued: true });
    expect(filesReplacingCount('a1')).toBe(before);
    op.start();
    expect(filesReplacingCount('a1')).toBe(before + 1);
    op.done('Rebuilt.');
  });

  it('a change that replaces the files, started again after a restart, counts again', async () => {
    const w = await world();
    const op = beginOperation(w.store, 'restore-snapshot', 'a1', { snapshotId: 'made-up-snapshot' });
    w.store.updateOperation(op.id, { bootId: 'an-earlier-boot' }); // cut off by a restart
    const before = filesReplacingCount('a1');
    await w.routes.resumeOperations();
    expect(filesReplacingCount('a1')).toBeGreaterThan(before);
  });

  it('a merge asked for while a snapshot reads waits for it, and the snapshot keeps AGENTS.md and its layer together', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'old' }, { soul: 'Soul {{style}}', agents: 'Rules {{style}}' });
    w.store.insertProposal({ id: 'lesson-2', masterAgentId: 'a1', childAgentId: 'child-1', childName: 'Piano Practice', text: 'Keep the watering schedule.' });
    const files: Record<string, string> = { 'SOUL.md': 'Soul old', 'AGENTS.md': 'Rules old', 'MEMORY.md': 'Memory' };
    // Held at MEMORY.md: SOUL.md and AGENTS.md are read already.
    w.provider.execShell = fileShell(files, { name: 'MEMORY.md', g }) as never;
    const taking = Promise.resolve(w.inject('POST', '/v1/agents/a1/snapshots', { label: 'By hand' }));
    await g.reached;
    const looked = vi.spyOn(w.store, 'getAgent');
    const merging = Promise.resolve(w.inject('POST', '/v1/agents/a1/proposals/lesson-2/resolve', { action: 'merge' }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a1'));
    await new Promise((done) => setTimeout(done, 30));
    // Nothing written while the snapshot reads.
    expect(files['AGENTS.md']).toBe('Rules old');
    g.release();
    const snap = await taking;
    expect(snap.statusCode, snap.body).toBe(201);
    const taken = w.store.getSnapshot('a1', snap.json().id)!;
    expect(taken.files['AGENTS.md']).toBe('Rules old');
    expect(taken.params?.agents).toBe('Rules {{style}}');
    const merged = await merging;
    expect(merged.statusCode, merged.body).toBe(200);
    expect(files['AGENTS.md']).toContain('Keep the watering schedule.');
    expect(w.store.getAgent('a1')?.paramFiles?.agents).toContain('Keep the watering schedule.');
  });

  it('a snapshot with nothing alongside is stored', async () => {
    const w = await world();
    w.provider.execShell = fileShell({ 'SOUL.md': 'Soul', 'AGENTS.md': 'Rules', 'MEMORY.md': 'Memory' }) as never;
    const snap = await w.inject('POST', '/v1/agents/a1/snapshots', { label: 'A quiet moment' });
    expect(snap.statusCode, snap.body).toBe(201);
    expect(w.store.getSnapshot('a1', snap.json().id)!.files).toMatchObject({ 'SOUL.md': 'Soul', 'AGENTS.md': 'Rules', 'MEMORY.md': 'Memory' });
  });

  it('a file saved while a snapshot reads waits for it, then goes through; the snapshot is kept', async () => {
    const g = gate();
    const w = await world();
    const files: Record<string, string> = { 'SOUL.md': 'Soul', 'AGENTS.md': 'Rules', 'MEMORY.md': 'Memory' };
    w.provider.execShell = fileShell(files, { name: 'SOUL.md', g }) as never;
    const taking = Promise.resolve(w.inject('POST', '/v1/agents/a1/snapshots', { label: 'By hand' }));
    await g.reached;
    const looked = vi.spyOn(w.store, 'getAgent');
    const saving = Promise.resolve(w.inject('PUT', '/v1/agents/a1/files/AGENTS.md', { content: 'New rules' }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a1'));
    g.release();
    const snap = await taking;
    expect(snap.statusCode, snap.body).toBe(201);
    expect(w.store.getSnapshot('a1', snap.json().id)!.files['AGENTS.md']).toBe('Rules');
    const saved = await saving;
    expect(saved.statusCode, saved.body).toBe(200);
    expect(files['AGENTS.md']).toBe('New rules');
  });

  it('a SOUL.md save that lands after a snapshot read SOUL.md waits for it, and the snapshot keeps file and layer together', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'old' }, { soul: 'Soul {{style}}', agents: 'Rules {{style}}' });
    const files: Record<string, string> = { 'SOUL.md': 'Soul old', 'AGENTS.md': 'Rules old', 'MEMORY.md': 'Memory' };
    // Held at AGENTS.md: SOUL.md is read already.
    w.provider.execShell = fileShell(files, { name: 'AGENTS.md', g }) as never;
    const taking = Promise.resolve(w.inject('POST', '/v1/agents/a1/snapshots', { label: 'By hand' }));
    await g.reached;
    const looked = vi.spyOn(w.store, 'getAgent');
    const saving = Promise.resolve(w.inject('PUT', '/v1/agents/a1/files/SOUL.md', { content: 'Saved soul, {{style}}' }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a1'));
    await new Promise((done) => setTimeout(done, 30));
    // Nothing written while the snapshot reads.
    expect(files['SOUL.md']).toBe('Soul old');
    expect(w.store.getAgent('a1')?.paramFiles?.soul).toBe('Soul {{style}}');
    g.release();
    const snap = await taking;
    expect(snap.statusCode, snap.body).toBe(201);
    const taken = w.store.getSnapshot('a1', snap.json().id)!;
    expect(taken.files['SOUL.md']).toBe('Soul old');
    expect(taken.params?.soul).toBe('Soul {{style}}');
    const saved = await saving;
    expect(saved.statusCode, saved.body).toBe(200);
    expect(files['SOUL.md']).toBe('Saved soul, {{style}}');
    expect(w.store.getAgent('a1')?.paramFiles?.soul).toBe('Saved soul, {{style}}');
  });
});

describe('a change to the core files that hangs (HB-0566)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const LATE = 'Another change to its files is still running; try again when it ends.';

  it('one waiting behind it gives up after two minutes, and never runs', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: true, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'old' }, { soul: 'Soul {{style}}', agents: 'Rules {{style}}' });
    const files: Record<string, string> = { 'SOUL.md': 'Soul old', 'AGENTS.md': 'Rules old', 'MEMORY.md': 'Memory' };
    w.provider.execShell = fileShell(files, { name: 'SOUL.md', g }) as never;
    const snapping = Promise.resolve(w.inject('POST', '/v1/agents/a1/snapshots', { label: 'Before the trip' }));
    await g.reached;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const looked = vi.spyOn(w.store, 'getAgent');
    const applying = Promise.resolve(w.inject('PUT', '/v1/agents/a1/params', { values: { style: 'new' } }));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('a1'));
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const r = await applying;
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe(LATE);
    vi.useRealTimers();
    g.release();
    expect((await snapping).statusCode).toBe(201);
    // It never ran, then or once the snapshot ended.
    await new Promise((done) => setTimeout(done, 20));
    expect(files['SOUL.md']).toBe('Soul old');
    expect(w.store.getAgent('a1')?.paramValues).toEqual({ style: 'old' });
    // And the files are free again.
    expect((await w.inject('PUT', '/v1/agents/a1/params', { values: { style: 'new' } })).statusCode).toBe(200);
    expect(files['SOUL.md']).toBe('Soul new');
  });

  it('a push gives up on a child whose files are held that long, and goes on to the next', async () => {
    const g = gate();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: false, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'calm' }, { soul: 'Soul {{style}}', agents: 'Rules' });
    for (const [id, slug, name] of [['a2', 'piano-practice', 'Piano Practice'], ['a3', 'bike-repairs', 'Bike Repairs']] as const) {
      const { runtimeRef } = await w.provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } as never }, env: {} });
      await w.provider.start(runtimeRef);
      w.store.insertAgent({ id, ownerId: OWNER, name, slug, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
      w.store.setAgentParent(id, 'a1');
      w.store.setAgentParamState(id, { style: 'brisk' }, { soul: 'Old soul {{style}}', agents: 'Old rules' });
    }
    const files: Record<string, string> = { 'SOUL.md': 'Old soul brisk', 'AGENTS.md': 'Old rules', 'MEMORY.md': 'Memory' };
    w.provider.execShell = fileShell(files, { name: 'SOUL.md', g }) as never;
    const snapping = Promise.resolve(w.inject('POST', '/v1/agents/a2/snapshots', { label: 'Before the recital' }));
    await g.reached;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let answered = false;
    const pushing = Promise.resolve(w.inject('POST', '/v1/agents/a1/push-definition')).finally(() => { answered = true; });
    for (let i = 0; i < 40 && !answered; i++) await vi.advanceTimersByTimeAsync(30_000);
    const r = await pushing;
    vi.useRealTimers();
    expect(r.statusCode, r.body).toBe(200);
    const byId = new Map((r.json().results as Array<{ id: string; ok: boolean; error?: string }>).map((x) => [x.id, x]));
    expect(byId.get('a2')).toMatchObject({ ok: false, error: LATE });
    expect(byId.get('a3')?.ok).toBe(true);
    g.release();
    expect((await snapping).statusCode).toBe(201);
    await new Promise((done) => setTimeout(done, 20));
    expect(w.store.getAgent('a2')?.paramFiles?.soul).toBe('Old soul {{style}}');
    expect(w.store.getAgent('a3')?.paramFiles?.soul).toBe('Soul {{style}}');
  });

  it('a push to two children whose files are both held answers within one wait, not one each', async () => {
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: false, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'calm' }, { soul: 'Soul {{style}}', agents: 'Rules' });
    const refs = new Set<string>();
    for (const [id, slug, name] of [['a2', 'piano-practice', 'Piano Practice'], ['a3', 'bike-repairs', 'Bike Repairs']] as const) {
      const { runtimeRef } = await w.provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } as never }, env: {} });
      await w.provider.start(runtimeRef);
      w.store.insertAgent({ id, ownerId: OWNER, name, slug, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
      w.store.setAgentParent(id, 'a1');
      w.store.setAgentParamState(id, { style: 'brisk' }, { soul: 'Old soul {{style}}', agents: 'Old rules' });
      refs.add(runtimeRef);
    }
    // Each child's snapshot by hand hangs at its first read, holding its files.
    const g = gate();
    const reading = new Set<string>();
    const base = fileShell({ 'SOUL.md': 'Old soul brisk', 'AGENTS.md': 'Old rules', 'MEMORY.md': 'Memory' });
    w.provider.execShell = (async (ref: string, script: string) => {
      if (refs.has(ref) && !reading.has(ref) && script.startsWith('head ') && script.includes('/SOUL.md')) {
        reading.add(ref);
        if (reading.size === refs.size) g.signal();
        await g.held;
      }
      return base(ref, script);
    }) as never;
    const snapping = ['a2', 'a3'].map((id) => Promise.resolve(w.inject('POST', `/v1/agents/${id}/snapshots`, { label: 'Before the recital' })));
    await g.reached;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let answered = false;
    const pushing = Promise.resolve(w.inject('POST', '/v1/agents/a1/push-definition')).finally(() => { answered = true; });
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 5_000);
    expect(answered).toBe(true);
    const r = await pushing;
    vi.useRealTimers();
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().results).toEqual([
      { id: 'a2', name: 'Piano Practice', ok: false, error: LATE },
      { id: 'a3', name: 'Bike Repairs', ok: false, error: LATE },
    ]);
    g.release();
    for (const snap of snapping) expect((await snap).statusCode).toBe(201);
  });

  it('a push to ten children works on four at a time, and answers within one wait plus the work', async () => {
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: false, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'calm' }, { soul: 'Soul {{style}}', agents: 'Rules' });
    const refs = new Map<string, string>();
    for (let n = 0; n < 10; n++) {
      const id = `k${n}`, slug = `practice-${n}`;
      const { runtimeRef } = await w.provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } as never }, env: {} });
      await w.provider.start(runtimeRef);
      w.store.insertAgent({ id, ownerId: OWNER, name: `Practice ${n}`, slug, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
      w.store.setAgentParent(id, 'a1');
      w.store.setAgentParamState(id, { style: 'brisk' }, { soul: 'Old soul {{style}}', agents: 'Old rules' });
      refs.set(id, runtimeRef);
    }
    const base = fileShell({ 'SOUL.md': 'Old soul brisk', 'AGENTS.md': 'Old rules', 'MEMORY.md': 'Memory' });
    // The last two children's files are held by snapshots by hand that hang:
    // each holds a slot while it waits, once the others are done.
    const g = gate();
    const held = new Set([refs.get('k8')!, refs.get('k9')!]);
    const reading = new Set<string>();
    w.provider.execShell = (async (ref: string, script: string) => {
      if (held.has(ref) && !reading.has(ref) && script.startsWith('head ') && script.includes('/SOUL.md')) {
        reading.add(ref);
        if (reading.size === held.size) g.signal();
        await g.held;
      }
      return base(ref, script);
    }) as never;
    const snapping = ['k8', 'k9'].map((id) => Promise.resolve(w.inject('POST', `/v1/agents/${id}/snapshots`, { label: 'Before the recital' })));
    await g.reached;
    // Each docker call takes a moment; the docs sync after a push (cat) is off the reply.
    let running = 0;
    let most = 0;
    w.provider.execShell = (async (ref: string, script: string) => {
      if (script.startsWith('cat ')) return base(ref, script);
      running++;
      most = Math.max(most, running);
      try {
        await new Promise((done) => setTimeout(done, 50));
        return await base(ref, script);
      } finally { running--; }
    }) as never;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let answered = false;
    const pushing = Promise.resolve(w.inject('POST', '/v1/agents/a1/push-definition')).finally(() => { answered = true; });
    let seconds = 0;
    while (!answered && seconds < 300) { await vi.advanceTimersByTimeAsync(1_000); seconds++; }
    const r = await pushing;
    vi.useRealTimers();
    expect(seconds).toBeLessThanOrEqual(125);
    expect(r.statusCode, r.body).toBe(200);
    const results = r.json().results as Array<{ id: string; ok: boolean; error?: string }>;
    expect(results.filter((x) => !x.ok)).toEqual([
      { id: 'k8', name: 'Practice 8', ok: false, error: LATE },
      { id: 'k9', name: 'Practice 9', ok: false, error: LATE },
    ]);
    expect(r.json().pushed).toBe(8);
    expect(most).toBe(4);
    g.release();
    for (const snap of snapping) expect((await snap).statusCode).toBe(201);
  });

  it('a child waiting for one of the four slots does not hold its files: a snapshot of it is taken meanwhile', async () => {
    vi.useRealTimers();
    const w = await world();
    w.store.setAgentParameters('a1', [{ key: 'style', label: 'Style', type: 'text', required: false, target: 'soul' }] as never);
    w.store.setAgentParamState('a1', { style: 'calm' }, { soul: 'Soul {{style}}', agents: 'Rules' });
    const refs = new Map<string, string>();
    for (let n = 0; n < 5; n++) {
      const id = `q${n}`, slug = `practice-${n}`;
      const { runtimeRef } = await w.provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } as never }, env: {} });
      await w.provider.start(runtimeRef);
      w.store.insertAgent({ id, ownerId: OWNER, name: `Practice ${n}`, slug, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
      w.store.setAgentParent(id, 'a1');
      w.store.setAgentParamState(id, { style: 'brisk' }, { soul: 'Old soul {{style}}', agents: 'Old rules' });
      refs.set(runtimeRef, id);
    }
    const base = fileShell({ 'SOUL.md': 'Old soul brisk', 'AGENTS.md': 'Old rules', 'MEMORY.md': 'Memory' });
    // The first four children to get a slot hang at their first docker call.
    const g = gate();
    const working = new Set<string>();
    w.provider.execShell = (async (ref: string, script: string) => {
      if (refs.has(ref) && working.size < 4 && !working.has(ref)) {
        working.add(ref);
        if (working.size === 4) g.signal();
        await g.held;
      }
      return base(ref, script);
    }) as never;
    const pushing = Promise.resolve(w.inject('POST', '/v1/agents/a1/push-definition'));
    await g.reached;
    const waiting = [...refs].find(([ref]) => !working.has(ref))![1];
    const snapping = Promise.resolve(w.inject('POST', `/v1/agents/${waiting}/snapshots`, { label: 'While it waits' }));
    const quick = await Promise.race([snapping.then((x) => x.statusCode), new Promise((done) => setTimeout(() => done('still waiting'), 500))]);
    g.release();
    expect(quick).toBe(201);
    const r = await pushing;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().pushed).toBe(5);
  });
});

describe('a waiting app install prepared while the agent is deleted (HB-0569)', () => {
  it('saves nothing for the deleted agent', async () => {
    const g = gate();
    const appGit = async (args: string[]) => {
      if (args.includes('--git-dir')) { g.signal(); await g.held; }
      const stdout = args.includes('show') ? JSON.stringify({ app: 'garden-log', name: 'Garden log', tasks: [] }) : args.includes('--verify') ? 'made-up-commit' : '';
      return { code: 0, stdout: Buffer.from(stdout), stderr: '' };
    };
    const w = await world({ appGit });
    const preparing = Promise.resolve(w.inject('POST', '/v1/agents/a1/app/pending', { source: '/tmp' }));
    await g.reached;
    expect((await w.inject('DELETE', '/v1/agents/a1')).statusCode).toBeLessThan(300);
    g.release();
    const r = await preparing;
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/deleted or archived meanwhile/);
    expect(w.store.getAgent('a1')?.state).toBe('DELETED');
    expect(w.store.getAppPending('a1')).toBeFalsy();
  });

  it('archived while its secrets were stored: the install already waiting keeps its own', async () => {
    const manifest = { app: 'garden-log', name: 'Garden log', tasks: [], config: { fields: [{ key: 'app_password', secret: true }] } };
    const appGit = async (args: string[]) => {
      const stdout = args.includes('show') ? JSON.stringify(manifest) : args.includes('--verify') ? 'made-up-commit' : '';
      return { code: 0, stdout: Buffer.from(stdout), stderr: '' };
    };
    const g = gate();
    const secrets = new MemSecrets();
    const w = await world({ appGit, secrets });
    w.store.setAgentState('a1', 'STOPPED');
    // An install already waiting, its secret at the ref this one shares.
    expect((await w.inject('POST', '/v1/agents/a1/app/pending', { source: '/tmp', values: { app_password: 'made-up-first' } })).statusCode).toBe(200);
    const ref = 'app-pending/a1/app_password';
    expect(secrets.map.get(ref)).toBe(JSON.stringify('made-up-first'));
    const put = secrets.put.bind(secrets);
    secrets.put = async (r: string, v: string) => { await put(r, v); if (v === JSON.stringify('made-up-second')) { g.signal(); await g.held; } };
    const replacing = Promise.resolve(w.inject('POST', '/v1/agents/a1/app/pending', { source: '/tmp', values: { app_password: 'made-up-second' } }));
    await g.reached;
    w.store.setAgentState('a1', 'ARCHIVED');
    g.release();
    expect((await replacing).statusCode).toBe(409);
    expect(w.store.getAppPending('a1')).toBeTruthy();
    expect(secrets.map.get(ref)).toBe(JSON.stringify('made-up-first'));
  });
});

describe('peers changed while an agent was down (HB-0465)', () => {
  /** Another agent of the household's, with a container of its own; ids no other test rebuilds (a refusal at render holds rebuilds back a while, HB-0419). */
  async function addAgent(w: Awaited<ReturnType<typeof world>>, id: string, slug: string, state: 'RUNNING' | 'STOPPED') {
    const { runtimeRef } = await w.provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } as never }, env: {} });
    if (state === 'RUNNING') await w.provider.start(runtimeRef);
    w.store.insertAgent({ id, ownerId: OWNER, name: slug.replace(/-/g, ' '), slug, state, aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
  }

  it('connected in bulk while stopped: nothing is marked, and Start rebuilds it', async () => {
    const w = await world();
    await addAgent(w, 'b1', 'piano-practice', 'STOPPED');
    await addAgent(w, 'b2', 'tide-tables', 'RUNNING');
    const r = await w.inject('POST', '/v1/agent-peers/mesh', { agentIds: ['b1', 'b2'], connect: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().changed).toBe(2);
    expect(r.json().note).toBeUndefined();
    expect(w.store.getAgent('b1')?.rebuildOnStart).toBeFalsy();
    const started = await w.inject('POST', '/v1/agents/b1/start');
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json().rebuilding).toBe(true);
  });

  it('one that falls asleep while the bulk Connect works is named as asleep', async () => {
    const g = gate();
    const w = await world();
    await addAgent(w, 'b11', 'rain-gauge', 'RUNNING');
    await addAgent(w, 'b12', 'frost-dates', 'RUNNING');
    const put = w.secrets.put.bind(w.secrets);
    let first = true;
    w.secrets.put = async (ref: string, value: string) => {
      if (first && ref.startsWith('agent-call-token/')) { first = false; g.signal(); await g.held; }
      return put(ref, value);
    };
    const connecting = Promise.resolve(w.inject('POST', '/v1/agent-peers/mesh', { agentIds: ['b11', 'b12'], connect: true }));
    await g.reached;
    w.store.setAgentState('b11', 'STOPPED');
    w.store.setHibernated('b11', new Date().toISOString());
    g.release();
    const r = await connecting;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().note).toMatch(/^rain gauge is asleep\./);
    expect(r.json().needRebuild.find((a: { id: string }) => a.id === 'b11')?.state).toBe('STOPPED');
  });

  it('one deleted while the bulk Connect works is not named as needing a rebuild, nor as asleep', async () => {
    const g = gate();
    const w = await world();
    await addAgent(w, 'b21', 'rain-gauge', 'RUNNING');
    await addAgent(w, 'b22', 'frost-dates', 'RUNNING');
    await addAgent(w, 'b23', 'seed-swap', 'STOPPED');
    w.store.setHibernated('b23', new Date().toISOString());
    const put = w.secrets.put.bind(w.secrets);
    let first = true;
    w.secrets.put = async (ref: string, value: string) => {
      if (first && ref.startsWith('agent-call-token/')) { first = false; g.signal(); await g.held; }
      return put(ref, value);
    };
    const connecting = Promise.resolve(w.inject('POST', '/v1/agent-peers/mesh', { agentIds: ['b21', 'b22', 'b23'], connect: true }));
    await g.reached;
    w.store.setAgentState('b23', 'DELETING'); // its delete under way
    g.release();
    const r = await connecting;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().needRebuild.map((a: { id: string }) => a.id)).not.toContain('b23');
    expect(r.json().note).toBeUndefined();
  });

  it('connected in bulk while asleep: the answer says it takes the change at its next Start or Rebuild', async () => {
    const w = await world();
    await addAgent(w, 'b9', 'star-chart', 'STOPPED');
    await addAgent(w, 'b10', 'cloud-diary', 'RUNNING');
    w.store.setHibernated('b9', new Date().toISOString());
    const r = await w.inject('POST', '/v1/agent-peers/mesh', { agentIds: ['b9', 'b10'], connect: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().needRebuild.map((a: { id: string }) => a.id).sort()).toEqual(['b10', 'b9']);
    expect(r.json().note).toBe('star chart is asleep. A sleeping agent wakes for a message as it was; it takes this change at its next Start or Rebuild, and its card says its peers changed.');
  });

  it('a budget\'s resume starts it as it is: only the owner\'s Start rebuilds it for peers', async () => {
    const w = await world();
    await addAgent(w, 'b7', 'herb-garden', 'STOPPED');
    await addAgent(w, 'b8', 'compost-log', 'RUNNING');
    w.store.setAgentPeers('b7', ['b8'], []);
    w.store.addBudgetPause('b7', monthKey(Date.now(), machineTz()), 'b7', new Date().toISOString());
    const r = await w.inject('PUT', '/v1/agents/b7/budget', { usd: null });
    expect(r.statusCode, r.body).toBe(200);
    await vi.waitFor(() => expect(w.store.getAgent('b7')?.state).toBe('RUNNING'));
    expect(w.store.listOperations(['b7'], 5).some((o) => o.kind === 'rebuild')).toBe(false);
    expect(w.store.getBudgetPause('b7', monthKey(Date.now(), machineTz()))).toMatchObject({ resumedBy: 'budget-raised' });
  });

  it('given peers and then put back as it had them: Start starts it as it is', async () => {
    const w = await world();
    await addAgent(w, 'b3', 'bird-log', 'STOPPED');
    await addAgent(w, 'b4', 'seed-swap', 'RUNNING');
    expect((await w.inject('PUT', '/v1/agents/b3/peers', { peerIds: ['b4'] })).statusCode).toBe(200);
    expect((await w.inject('PUT', '/v1/agents/b3/peers', { peerIds: [] })).statusCode).toBe(200);
    const started = await w.inject('POST', '/v1/agents/b3/start');
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().rebuilding).toBeFalsy();
  });

  it('a stopped agent whose peer was deleted comes up rebuilt at Start', async () => {
    const w = await world();
    w.store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Piano Practice', slug: 'piano-practice', state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock:piano-practice', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    w.store.setAgentPeers('a1', ['a2'], []);
    w.store.recordAppliedPeers('a1');
    w.store.setAgentState('a1', 'STOPPED');
    // Deleting the peer takes its grant away, and marks nothing on this one.
    expect((await w.inject('DELETE', '/v1/agents/a2')).statusCode).toBeLessThan(300);
    expect(w.store.listAgentPeers('a1')).toEqual([]);
    expect(w.store.getAgent('a1')?.rebuildOnStart).toBeFalsy();
    const r = await w.inject('POST', '/v1/agents/a1/start');
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().rebuilding).toBe(true);
  });

  it('a sleeping one whose peer was deleted wakes its old container: the peers wait for Start or a rebuild', async () => {
    const w = await world();
    await addAgent(w, 'b5', 'tide-log', 'STOPPED');
    await addAgent(w, 'b6', 'moon-phases', 'STOPPED');
    w.store.setAgentPeers('b5', ['b6'], []);
    w.store.recordAppliedPeers('b5');
    w.store.setHibernated('b5', new Date().toISOString());
    expect((await w.inject('DELETE', '/v1/agents/b6')).statusCode).toBeLessThan(300);
    const r = await w.inject('POST', '/v1/agents/b5/wake');
    expect(r.statusCode, r.body).toBe(200);
    expect(w.store.listOperations(['b5'], 5).some((o) => o.kind === 'rebuild')).toBe(false);
    expect(w.store.getAgent('b5')?.state).toBe('RUNNING');
  });

  it('one whose peers are as installed starts as it is', async () => {
    const w = await world();
    w.store.setAgentState('a1', 'STOPPED');
    const r = await w.inject('POST', '/v1/agents/a1/start');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().rebuilding).toBeFalsy();
  });
});

describe('a task edit that is refused (HB-0559)', () => {
  it('leaves the phone note as it was', async () => {
    const w = await world();
    const bad = await w.inject('PATCH', '/v1/agents/a1/crons/job-water', { notify: true, name: '' });
    expect(bad.statusCode).toBe(400);
    const gone = await w.inject('PATCH', '/v1/agents/a1/crons/job-water', { notify: true, name: 'Water the beds' });
    expect(gone.statusCode).toBe(404); // the mock agent has no tasks
    expect(w.store.cronNotes('a1')).toEqual([]);
    // Alone, it is kept as before.
    const on = await w.inject('PATCH', '/v1/agents/a1/crons/job-water', { notify: true });
    expect(on.statusCode).toBe(200);
    expect(w.store.cronNotes('a1')[0]?.jobId).toBe('job-water');
  });

  it('goes with an edit that took, though turning the task on then failed', async () => {
    const w = await world();
    w.provider.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [{ id: 'job-water', name: 'Water', enabled: false, payload: { kind: 'agentTurn', message: 'Water the beds' } }] }) });
    w.provider.execResponses.set('cron edit', { code: 0, stdout: '', stderr: '' });
    w.provider.execResponses.set('cron enable', { code: 1, stdout: '', stderr: 'made-up refusal' });
    const r = await w.inject('PATCH', '/v1/agents/a1/crons/job-water', { notify: true, name: 'Water the beds', enabled: true });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/was changed, but/);
    expect(w.store.cronNotes('a1')[0]?.jobId).toBe('job-water');
  });

  it('goes with an edit that took, though turning the task on then threw', async () => {
    const w = await world();
    w.provider.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [{ id: 'job-water', name: 'Water', enabled: false, payload: { kind: 'agentTurn', message: 'Water the beds' } }] }) });
    const exec = w.provider.exec.bind(w.provider);
    w.provider.exec = (async (ref: string, argv: string[], opts?: never) => {
      if (argv[0] === 'cron' && argv[1] === 'enable') throw new Error('made-up lost connection');
      return exec(ref, argv, opts);
    }) as never;
    const r = await w.inject('PATCH', '/v1/agents/a1/crons/job-water', { notify: true, name: 'Water the beds', enabled: true });
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect(w.store.cronNotes('a1')[0]?.jobId).toBe('job-water');
  });
});

describe('Discord attached while the agent is deleted (HB-0568)', () => {
  it('stores no channel and no token for the deleted agent', async () => {
    const g = gate();
    const connector = {
      kind: 'discord', label: 'Discord', fields: [], secretValue: () => 'made-up-value', credsFromSecret: () => ({}),
      verify: async () => { g.signal(); await g.held; return { accountId: 'garden-helper', displayName: 'Garden helper', deepLink: 'https://example.invalid/bot', settings: {}, warnings: [] }; },
    };
    const w = await world({ connectors: { discord: connector } });
    w.provider.currentImageInfo = async () => ({ channels: ['discord'] }) as never;
    const attaching = Promise.resolve(w.inject('POST', '/v1/agents/a1/channels/discord', {}));
    await g.reached;
    expect((await w.inject('DELETE', '/v1/agents/a1')).statusCode).toBeLessThan(300);
    g.release();
    const r = await attaching;
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('It was deleted.');
    expect(w.store.getChannelForAgent('a1', 'discord')).toBeUndefined();
    expect(w.secrets.map.has('channel/a1/discord')).toBe(false);
  });
});

describe('a Telegram re-check across a bot swap (HB-0598)', () => {
  it('does not write the old bot over the new one', async () => {
    const g = gate();
    const oauthFetch = async () => { g.signal(); await g.held; return { json: async () => ({ ok: true, result: { username: 'old_garden_bot', first_name: 'Old garden', can_join_groups: false, can_read_all_group_messages: false } }) }; };
    const w = await world({ oauthFetch });
    await w.secrets.put('made-up/old', 'made-up-old-value');
    const row = { id: 'ch-old', agentId: 'a1', kind: 'telegram' as const, accountId: 'old_garden_bot', secretRef: 'made-up/old', deepLink: '', createdAt: 'now', settings: { botName: 'Old garden' } };
    w.store.insertChannel(row);
    const checking = Promise.resolve(w.inject('POST', '/v1/agents/a1/channels/telegram/recheck'));
    await g.reached;
    w.store.replaceChannelRow('a1', 'telegram', { ...row, id: 'ch-new', accountId: 'new_garden_bot', secretRef: 'made-up/new', settings: { botName: 'New garden', warnings: [] } });
    g.release();
    const r = await checking;
    expect(r.statusCode).toBe(409);
    const now = w.store.getChannelForAgent('a1', 'telegram')!;
    expect(now.accountId).toBe('new_garden_bot');
    expect((now.settings as { botName?: string }).botName).toBe('New garden');
  });
});

describe('a new Google client secret for a busy agent (HB-0463)', () => {
  async function googleWorld() {
    const secrets = new MemSecrets();
    await secrets.put(GOOGLE_CLIENT_REF, JSON.stringify({ clientId: 'made-up-client', clientSecret: 'made-up-old-secret' }));
    await secrets.put('google/made-up', 'made-up-refresh');
    const w = await world({ secrets });
    w.store.insertConnection({ id: 'conn', ownerId: OWNER, kind: 'google', email: 'mailbox@example.org', services: ['gmail'], secretRef: 'google/made-up', clientId: 'made-up-client' });
    w.store.attachConnection('a1', 'conn', false);
    const pending = () => {
      const c = w.store.listConnections(OWNER)[0]!;
      const at = w.store.listConnectionAttachments('conn')[0]!;
      return !!c.clientSecretAt && (!at.materializedAt || at.materializedAt < c.clientSecretAt);
    };
    return { ...w, pending };
  }

  it('saving the same secret again delivers what is still owed', async () => {
    const w = await googleWorld();
    markBusy('a1');
    const first = await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    expect(first.json()).toMatchObject({ pushing: 0, waiting: 1 });
    clearBusy('a1');
    expect(w.pending()).toBe(true);
    const again = await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    expect(again.json()).toMatchObject({ pushing: 1, waiting: 0 });
    await vi.waitFor(() => expect(w.pending()).toBe(false));
  });

  it('the periodic pass reaches it once it is free', async () => {
    const w = await googleWorld();
    markBusy('a1');
    await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    clearBusy('a1');
    const sweep = w.routes.clientSecretSweep;
    expect(await sweep()).toEqual({ pushing: 1, waiting: 0 });
    await vi.waitFor(() => expect(w.pending()).toBe(false));
    // Nothing owed: nothing to push.
    expect(await sweep()).toEqual({ pushing: 0, waiting: 0 });
  });

  it('who is owed is one query: never imported, or imported before the secret, of this client only', async () => {
    const w = await googleWorld();
    w.store.insertConnection({ id: 'conn-other', ownerId: OWNER, kind: 'google', email: 'other@example.org', services: ['gmail'], secretRef: 'google/made-up', clientId: 'another-client' });
    w.store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Piano Practice', slug: 'piano-practice', state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock:piano-practice', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    w.store.attachConnection('a2', 'conn-other', false);
    const owed = (client: string) => w.store.connectionsOwedClientSecret('google', client).map(({ agentId, connectionId }) => ({ agentId, connectionId }));
    expect(owed('made-up-client')).toEqual([]); // no secret saved since
    w.store.markClientSecretChanged('google', 'made-up-client', '2026-11-08T10:00:00.000Z');
    w.store.markClientSecretChanged('google', 'another-client', '2026-11-08T10:00:00.000Z');
    expect(owed('made-up-client')).toEqual([{ agentId: 'a1', connectionId: 'conn' }]);
    w.store.markConnectionMaterialized('a1', 'conn', '2026-11-08T09:00:00.000Z');
    expect(owed('made-up-client')).toEqual([{ agentId: 'a1', connectionId: 'conn' }]);
    w.store.markConnectionMaterialized('a1', 'conn', '2026-11-08T11:00:00.000Z');
    expect(owed('made-up-client')).toEqual([]);
    expect(owed('another-client')).toEqual([{ agentId: 'a2', connectionId: 'conn-other' }]);
  });

  it('the Connections page reads the same: an account made with another client is not owed, it needs connecting again', async () => {
    const w = await googleWorld();
    w.store.insertConnection({ id: 'conn-old', ownerId: OWNER, kind: 'google', email: 'other@example.org', services: ['gmail'], secretRef: 'google/made-up', clientId: 'another-client' });
    w.store.attachConnection('a1', 'conn-old', false);
    // Its secret was saved when that client was the one set.
    w.store.markClientSecretChanged('google', 'another-client', '2026-11-08T10:00:00.000Z');
    // And a new one for the client set now.
    w.store.markClientSecretChanged('google', 'made-up-client', new Date().toISOString());
    const page = (await w.inject('GET', '/v1/connections')).json().connections as Array<{ id: string; needsReconnect: boolean; attachedTo: Array<{ secretPending: boolean }> }>;
    const byId = new Map(page.map((c) => [c.id, c]));
    expect(byId.get('conn')!.attachedTo[0]!.secretPending).toBe(true);
    expect(byId.get('conn-old')!.needsReconnect).toBe(true);
    expect(byId.get('conn-old')!.attachedTo[0]!.secretPending).toBe(false);
    const sweep = w.routes.clientSecretSweep;
    expect(await sweep()).toEqual({ pushing: 1, waiting: 0 });
    const after = (await w.inject('GET', '/v1/connections')).json().connections as typeof page;
    expect(after.find((c) => c.id === 'conn')!.attachedTo[0]!.secretPending).toBe(false);
  });

  it('the pass imports only the owed account, not every one the agent holds', async () => {
    const w = await googleWorld();
    w.store.insertConnection({ id: 'conn-second', ownerId: OWNER, kind: 'google', email: 'other@example.org', services: ['gmail'], secretRef: 'google/made-up', clientId: 'made-up-client' });
    w.store.attachConnection('a1', 'conn-second', false);
    markBusy('a1');
    await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    clearBusy('a1');
    // The second one took it meanwhile (a rebuild, an attach).
    w.store.markConnectionMaterialized('a1', 'conn-second', new Date(Date.now() + 1000).toISOString());
    w.provider.secretShells.length = 0;
    const sweep = w.routes.clientSecretSweep;
    expect(await sweep()).toEqual({ pushing: 1, waiting: 0 });
    const imports = w.provider.secretShells.filter((x) => x.includes('gog auth import'));
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain('mailbox@example.org');
  });

  it('one pass at a time: a pass while the last still runs starts nothing', async () => {
    const w = await googleWorld();
    markBusy('a1');
    await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    clearBusy('a1');
    const g = gate();
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = (async (ref: string, script: string, opts?: never) => {
      if (script.includes('gog auth import')) { g.signal(); await g.held; }
      return shell(ref, script, opts);
    }) as never;
    const sweep = w.routes.clientSecretSweep;
    const first = sweep();
    await g.reached;
    expect(await sweep()).toBeUndefined();
    g.release();
    expect(await first).toEqual({ pushing: 1, waiting: 0 });
    expect(w.pending()).toBe(false);
  });

  it('each agent is judged when its turn comes: one that became busy meanwhile is left for later', async () => {
    const w = await googleWorld();
    const { runtimeRef } = await w.provider.provision({ agentId: 'a2', slug: 'piano-practice', workspace: { files: {}, configPatch: { agentId: 'piano-practice', authMode: 'api-key' } as never }, env: {} });
    await w.provider.start(runtimeRef);
    w.store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Piano Practice', slug: 'piano-practice', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    w.store.attachConnection('a2', 'conn', false);
    markBusy('a1'); markBusy('a2');
    await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    clearBusy('a1'); clearBusy('a2');
    const g = gate();
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = (async (ref: string, script: string, opts?: never) => {
      if (script.includes('gog auth import') && ref !== runtimeRef) { g.signal(); await g.held; }
      return shell(ref, script, opts);
    }) as never;
    const sweep = w.routes.clientSecretSweep;
    const passing = sweep();
    await g.reached;
    markBusy('a2'); // a rebuild began on it while the first was imported
    g.release();
    try {
      await passing;
      const imports = w.provider.secretShells.filter((x) => x.includes('gog auth import'));
      expect(imports).toHaveLength(1);
      expect(w.store.connectionsOwedClientSecret('google', 'made-up-client').map(({ agentId, connectionId }) => ({ agentId, connectionId }))).toEqual([{ agentId: 'a2', connectionId: 'conn' }]);
    } finally { clearBusy('a2'); }
  });

  it('an account whose connection was deleted during its import is taken off the agent again', async () => {
    const w = await googleWorld();
    markBusy('a1');
    await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    clearBusy('a1');
    const g = gate();
    const scripts: string[] = [];
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = (async (ref: string, script: string, opts?: never) => {
      scripts.push(script);
      if (script.includes('gog auth import')) { g.signal(); await g.held; }
      return shell(ref, script, opts);
    }) as never;
    const pass = w.routes.clientSecretSweep();
    await g.reached;
    w.store.deleteConnection('conn');
    g.release();
    await pass;
    expect(scripts.some((x) => x.includes('gog auth remove') && x.includes('mailbox@example.org'))).toBe(true);
  });

  it("who is owed comes with what its agent is judged by, and the Connections page asks for its caller's accounts only", async () => {
    const w = await googleWorld();
    // Another household's account on the same client, owed too.
    w.store.insertConnection({ id: 'conn-next-door', ownerId: 'user-next-door', kind: 'google', email: 'test@example.org', services: ['gmail'], secretRef: 'google/made-up', clientId: 'made-up-client' });
    w.store.insertAgent({ id: 'a3', ownerId: 'user-next-door', name: 'Bike Repairs', slug: 'bike-repairs', state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock:bike-repairs', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    w.store.attachConnection('a3', 'conn-next-door', false);
    w.store.markClientSecretChanged('google', 'made-up-client', new Date().toISOString());
    const runtimeRef = w.store.getAgent('a1')!.runtimeRef;
    w.store.setAgentMigratedTo('a3', 'another Hatchabot');
    expect(w.store.connectionsOwedClientSecret('google', 'made-up-client')).toEqual([
      { agentId: 'a1', connectionId: 'conn', state: 'RUNNING', runtimeRef, migratedTo: undefined },
      { agentId: 'a3', connectionId: 'conn-next-door', state: 'STOPPED', runtimeRef: 'mock:bike-repairs', migratedTo: 'another Hatchabot' },
    ]);
    expect(w.store.connectionsOwedClientSecret('google', 'made-up-client', { ownerId: OWNER }).map((o) => o.agentId)).toEqual(['a1']);
    const asked = vi.spyOn(w.store, 'connectionsOwedClientSecret');
    const page = await w.inject('GET', '/v1/connections');
    expect(page.statusCode).toBe(200);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith('google', 'made-up-client', { ownerId: OWNER });
    expect(page.json().connections[0].attachedTo[0].secretPending).toBe(true);
  });

  it('a pass asks the store who is owed once', async () => {
    const w = await googleWorld();
    markBusy('a1');
    await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    clearBusy('a1');
    const asked = vi.spyOn(w.store, 'connectionsOwedClientSecret');
    expect(await w.routes.clientSecretSweep()).toEqual({ pushing: 1, waiting: 0 });
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('an agent whose import keeps failing is asked less often, not every pass', async () => {
    const w = await googleWorld();
    w.provider.execResponses.set('sh', { code: 1, stdout: '', stderr: 'made-up import failure' });
    markBusy('a1');
    await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    clearBusy('a1');
    const sweep = w.routes.clientSecretSweep;
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });
    try {
      expect(await sweep()).toEqual({ pushing: 1, waiting: 0 });
      expect(await sweep()).toEqual({ pushing: 0, waiting: 1 }); // the next pass, 10 minutes on, not this one
      vi.setSystemTime(t0 + 11 * 60_000);
      expect(await sweep()).toEqual({ pushing: 1, waiting: 0 });
      vi.setSystemTime(t0 + 22 * 60_000); // failed twice: 20 minutes after the second
      expect(await sweep()).toEqual({ pushing: 0, waiting: 1 });
      vi.setSystemTime(t0 + 32 * 60_000);
      expect(await sweep()).toEqual({ pushing: 1, waiting: 0 });
    } finally { vi.useRealTimers(); }
    // Saving the client again asks at once, whatever the back-off.
    const again = await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    expect(again.json()).toMatchObject({ pushing: 1, waiting: 0 });
  });

  it("the pass's first import of an account writes it into AGENTS.md, as an attach does", async () => {
    const w = await googleWorld();
    markBusy('a1');
    await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    clearBusy('a1');
    const docs: string[] = [];
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = (async (ref: string, script: string, opts?: never) => {
      if (script.includes('AGENTS.md') && !script.includes('gog auth import')) docs.push(script);
      return shell(ref, script, opts);
    }) as never;
    const sweep = w.routes.clientSecretSweep;
    expect(await sweep()).toEqual({ pushing: 1, waiting: 0 });
    await vi.waitFor(() => expect(docs.length).toBeGreaterThan(0));
  });

  it('an agent owed two accounts gets both in one turn, and AGENTS.md is written once for them', async () => {
    const run = async (accounts: 1 | 2) => {
      const w = await googleWorld();
      if (accounts === 2) {
        w.store.insertConnection({ id: 'conn-second', ownerId: OWNER, kind: 'google', email: 'other@example.org', services: ['gmail'], secretRef: 'google/made-up', clientId: 'made-up-client' });
        w.store.attachConnection('a1', 'conn-second', false);
      }
      markBusy('a1');
      await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
      clearBusy('a1');
      const docs: string[] = [];
      const imports: string[] = [];
      const shell = w.provider.execShell.bind(w.provider);
      w.provider.execShell = (async (ref: string, script: string, opts?: never) => {
        if (script.includes('gog auth import')) imports.push(...(script.match(/gog auth import/g) ?? []));
        else if (script.includes('AGENTS.md')) docs.push(script);
        return shell(ref, script, opts);
      }) as never;
      expect(await w.routes.clientSecretSweep()).toEqual({ pushing: 1, waiting: 0 });
      expect(w.store.connectionsOwedClientSecret('google', 'made-up-client')).toEqual([]);
      return { docs: docs.length, imports: imports.length };
    };
    const one = await run(1);
    const two = await run(2);
    expect(one.docs).toBeGreaterThan(0);
    expect(two.imports).toBe(2);
    expect(two.docs).toBe(one.docs);
  });

  it('two owed accounts go in one exec, and each keeps its own result', async () => {
    const w = await googleWorld();
    w.store.insertConnection({ id: 'conn-second', ownerId: OWNER, kind: 'google', email: 'other@example.org', services: ['gmail'], secretRef: 'google/made-up', clientId: 'made-up-client' });
    w.store.attachConnection('a1', 'conn-second', false);
    markBusy('a1');
    await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    clearBusy('a1');
    const imports: string[] = [];
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = (async (ref: string, script: string, opts?: never) => {
      if (!script.includes('gog auth import')) return shell(ref, script, opts);
      imports.push(script);
      // The first took; the second was refused, in its own words.
      return { code: 0, stdout: 'IMPORTED 0 0\nIMPORTED 1 1\n', stderr: '[1] made-up refusal\n' };
    }) as never;
    const sweep = w.routes.clientSecretSweep;
    expect(await sweep()).toEqual({ pushing: 1, waiting: 0 });
    expect(imports).toHaveLength(1);
    expect(imports[0]!.match(/gog auth import/g)).toHaveLength(2);
    // Its lines carry a number and an exit code, never an address or a token.
    expect(imports[0]!.match(/echo "IMPORTED [^"]*"/g)).toEqual(['echo "IMPORTED 0 $rc"', 'echo "IMPORTED 1 $rc"']);
    expect(w.store.connectionsOwedClientSecret('google', 'made-up-client').map((o) => o.connectionId)).toEqual(['conn-second']);
    expect(w.store.listEvents(['a1']).filter((e) => e.event === 'connection.sync_failed').map((e) => e.detail?.error)).toEqual(['made-up refusal']);
    // Its own back-off: the next pass leaves it for later.
    expect(await sweep()).toEqual({ pushing: 0, waiting: 1 });
    expect(imports).toHaveLength(1);
  });

  it('when the script stops after the first account fails, the second is not given the first one\'s error', async () => {
    const w = await googleWorld();
    w.store.insertConnection({ id: 'conn-second', ownerId: OWNER, kind: 'google', email: 'other@example.org', services: ['gmail'], secretRef: 'google/made-up', clientId: 'made-up-client' });
    w.store.attachConnection('a1', 'conn-second', false);
    markBusy('a1');
    await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    clearBusy('a1');
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = (async (ref: string, script: string, opts?: never) => {
      if (!script.includes('gog auth import')) return shell(ref, script, opts);
      // The first was refused; then the shell stopped, before the second's line.
      return { code: 1, stdout: 'IMPORTED 0 1\n', stderr: '[0] made-up refusal for the first\nmade-up stop\n' };
    }) as never;
    expect(await w.routes.clientSecretSweep()).toEqual({ pushing: 1, waiting: 0 });
    const errors = new Map(w.store.listEvents(['a1']).filter((e) => e.event === 'connection.materialize_failed').map((e) => [e.detail?.email, e.detail?.error]));
    expect(errors.size).toBe(2);
    expect(errors.get('other@example.org')).toBe('made-up stop');
    expect([...errors.values()]).toContain('made-up refusal for the first');
  });

  it('an import refused on stdout gives that account the words it printed', async () => {
    const w = await googleWorld();
    w.store.insertConnection({ id: 'conn-second', ownerId: OWNER, kind: 'google', email: 'other@example.org', services: ['gmail'], secretRef: 'google/made-up', clientId: 'made-up-client' });
    w.store.attachConnection('a1', 'conn-second', false);
    markBusy('a1');
    await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    clearBusy('a1');
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = (async (ref: string, script: string, opts?: never) => {
      if (!script.includes('gog auth import')) return shell(ref, script, opts);
      // The first took; the second said why it refused on stdout, nothing on stderr.
      return { code: 0, stdout: '[0] made-up note\nIMPORTED 0 0\n[1] made-up refusal on stdout\nIMPORTED 1 3\n', stderr: '[1] \n' };
    }) as never;
    expect(await w.routes.clientSecretSweep()).toEqual({ pushing: 1, waiting: 0 });
    const errors = new Map(w.store.listEvents(['a1']).filter((e) => e.event === 'connection.materialize_failed').map((e) => [e.detail?.email, e.detail?.error]));
    expect([...errors]).toEqual([['other@example.org', 'made-up refusal on stdout']]);
  });

  it('an import whose output ends without a newline still reads as done', async () => {
    const w = await googleWorld();
    // The script's import lines, run for real in a sandbox: a made-up gog
    // that prints its note with no newline at the end, and nothing else.
    const sandbox = mkdtempSync(join(tmpdir(), 'hb-gog-'));
    try {
      const bin = join(sandbox, 'bin');
      mkdirSync(join(sandbox, '.local', 'bin'), { recursive: true });
      mkdirSync(bin);
      for (const tool of ['sed', 'base64']) {
        const at = ['/usr/bin', '/bin'].map((d) => join(d, tool)).find((f) => existsSync(f))!;
        symlinkSync(at, join(bin, tool));
      }
      const gog = join(sandbox, '.local', 'bin', 'gog');
      writeFileSync(gog, "#!/bin/sh\nwhile read -r _; do :; done\nprintf 'made-up note'\n");
      chmodSync(gog, 0o755);
      const scripts: string[] = [];
      const shell = w.provider.execShell.bind(w.provider);
      w.provider.execShell = (async (ref: string, script: string, opts?: never) => {
        if (!script.includes('gog auth import')) return shell(ref, script, opts);
        scripts.push(script);
        const lines = script.slice(script.indexOf('exec 3>&1'));
        const run = spawnSync('/bin/bash', ['-e', '-c', lines], { env: { HOME: sandbox, PATH: bin }, encoding: 'utf8', timeout: 20_000 });
        return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
      }) as never;
      const deps = { store: w.store, secrets: w.secrets, provider: w.provider };
      const agent = { id: 'a1', slug: 'garden-notes', runtimeRef: w.store.getAgent('a1')!.runtimeRef! };
      const results = await materializeConnections(deps, agent, ['conn']);
      expect(scripts).toHaveLength(1);
      expect(results, JSON.stringify(results)).toEqual([expect.objectContaining({ ok: true })]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('the import of several accounts has a minute for each, ten minutes at most', async () => {
    const w = await googleWorld();
    const timeouts: Array<number | undefined> = [];
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = (async (ref: string, script: string, opts?: { timeoutMs?: number; secret?: boolean }) => {
      if (script.includes('gog auth import')) timeouts.push(opts?.timeoutMs);
      return shell(ref, script, opts);
    }) as never;
    const deps = { store: w.store, secrets: w.secrets, provider: w.provider };
    const agent = { id: 'a1', slug: 'garden-notes', runtimeRef: w.store.getAgent('a1')!.runtimeRef! };
    const ids = ['conn'];
    const more = (n: number) => {
      for (let i = ids.length; ids.length < n; i++) {
        w.store.insertConnection({ id: `conn-${i}`, ownerId: OWNER, kind: 'google', email: `box${i}@example.org`, services: ['gmail'], secretRef: 'google/made-up', clientId: 'made-up-client' });
        w.store.attachConnection('a1', `conn-${i}`, false);
        ids.push(`conn-${i}`);
      }
      return [...ids];
    };
    expect((await materializeConnections(deps, agent, more(1))).every((r) => r.ok)).toBe(true);
    expect((await materializeConnections(deps, agent, more(3))).every((r) => r.ok)).toBe(true);
    expect((await materializeConnections(deps, agent, more(12))).every((r) => r.ok)).toBe(true);
    expect(timeouts).toEqual([60_000, 180_000, 600_000]);
  });

  it('a failed import is asked again at the next pass ten minutes on, then twenty after that', async () => {
    const t0 = new Date('2026-11-08T10:00:00.000Z').getTime();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(t0);
      const w = await googleWorld();
      markBusy('a1');
      await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
      clearBusy('a1');
      let tries = 0;
      const shell = w.provider.execShell.bind(w.provider);
      w.provider.execShell = (async (ref: string, script: string, opts?: never) => {
        if (!script.includes('gog auth import')) return shell(ref, script, opts);
        tries++;
        vi.setSystemTime(Date.now() + 5_000); // an import takes a few seconds
        return { code: 1, stdout: '', stderr: 'made-up failure' };
      }) as never;
      const passAt = async (minutes: number) => { vi.setSystemTime(t0 + minutes * 60_000); await w.routes.clientSecretSweep(); return tries; };
      expect(await passAt(0)).toBe(1);
      expect(await passAt(10)).toBe(2);
      expect(await passAt(20)).toBe(2);
      expect(await passAt(30)).toBe(3);
    } finally { vi.useRealTimers(); }
  });

  it('a later import of one it already held leaves AGENTS.md alone', async () => {
    const w = await googleWorld();
    w.store.markConnectionMaterialized('a1', 'conn', '2026-11-01T00:00:00.000Z');
    markBusy('a1');
    await w.inject('PUT', '/v1/google-oauth/client', { clientId: 'made-up-client', clientSecret: 'made-up-new-secret' });
    clearBusy('a1');
    const docs: string[] = [];
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = (async (ref: string, script: string, opts?: never) => {
      if (script.includes('AGENTS.md') && !script.includes('gog auth import')) docs.push(script);
      return shell(ref, script, opts);
    }) as never;
    const sweep = w.routes.clientSecretSweep;
    expect(await sweep()).toEqual({ pushing: 1, waiting: 0 });
    expect(docs).toEqual([]);
  });
});

describe('a proposal merge whose write landed but whose answer was lost (HB-0571)', () => {
  it('the retry does not add the learning a second time', async () => {
    const w = await world();
    w.store.insertProposal({ id: 'lesson-1', masterAgentId: 'a1', childAgentId: 'child-1', childName: 'Piano Practice', text: 'Keep the watering schedule.' });
    let playbook = 'Existing playbook'; let lost = false;
    w.provider.execShell = (async (_ref: string, script: string) => {
      if (script.startsWith('head ')) return { code: 0, stdout: script.includes('/AGENTS.md') ? playbook : 'Other core file', stderr: '' };
      const b64 = /echo "([A-Za-z0-9+/=]+)"/.exec(script)?.[1];
      if (b64 && script.includes('/AGENTS.md')) {
        playbook = Buffer.from(b64, 'base64').toString();
        if (!lost) { lost = true; throw new Error('the answer was lost after the write'); }
      }
      return { code: 0, stdout: '', stderr: '' };
    }) as never;
    const first = await w.inject('POST', '/v1/agents/a1/proposals/lesson-1/resolve', { action: 'merge' });
    expect(first.statusCode).toBe(500);
    expect(w.store.listProposals('a1')).toHaveLength(1);
    const retry = await w.inject('POST', '/v1/agents/a1/proposals/lesson-1/resolve', { action: 'merge' });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().merged).toBe(true);
    expect(playbook.match(/Keep the watering schedule/g)).toHaveLength(1);
    expect(playbook).toContain('(proposal lesson-1) -->');
    expect(w.store.listProposals('a1')).toHaveLength(0);
  });
});
