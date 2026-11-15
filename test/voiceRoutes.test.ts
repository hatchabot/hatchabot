import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { AgentState } from '../src/domain/types.js';
import { clearBusy, markBusy } from '../src/orchestrator/busy.js';
import { beginOperation } from '../src/orchestrator/operations.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

const opened: World[] = [];
const releasePending: Array<() => void> = [];
afterEach(async () => {
  while (releasePending.length) releasePending.pop()!();
  clearBusy('a1');
  while (opened.length) await opened.pop()!.f.close();
});

const db = (w: World) => (w.store as unknown as { db: Database.Database }).db;
// Seed lifecycle snapshots directly: these checks must also tolerate states
// loaded after a restart, without performing real lifecycle work in the test.
const state = (w: World, next: AgentState) => db(w).prepare('UPDATE agents SET state = ? WHERE id = ?').run(next, 'a1');
const read = (w: World, owner = w.owner, id = 'a1') => w.f.inject({ method: 'GET', url: `/v1/agents/${id}/voice`, headers: as(owner) });

async function ready() {
  const w = await makeWorld();
  opened.push(w);
  await seedRunningAgent(w, { members: [
    { userId: 'user-member', role: 'user' },
    { userId: 'user-member-owner', role: 'owner' },
  ] });
  w.provider.execResponses.set('gateway call talk.catalog', {
    code: 0, stderr: '', stdout: JSON.stringify({
      realtime: {
        ready: true, activeProvider: 'google',
        providers: [{ id: 'google', label: 'private provider label', apiKey: 'private provider credential', models: ['private model'] }],
      },
      config: { secretRef: 'private/ref' },
    }),
  });
  w.provider.execLog.length = 0;
  return w;
}

async function pendingRead(w: World) {
  let release!: () => void;
  let signal!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  releasePending.push(release);
  const exec = w.provider.exec.bind(w.provider);
  w.provider.exec = async (ref, argv, opts) => {
    const answer = await exec(ref, argv, opts);
    if (argv.slice(0, 3).join(' ') === 'gateway call talk.catalog') {
      signal();
      await held;
    }
    return answer;
  };
  const response = Promise.resolve(read(w));
  await reached;
  return { response, release };
}

describe('GET /v1/agents/:id/voice', () => {
  it('returns only safe configuration readiness, without caching or changing the agent', async () => {
    const w = await ready();
    const before = w.store.getAgent('a1');
    const response = await read(w);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ status: 'configured', provider: 'Google' });
    expect(w.provider.execLog).toEqual([['gateway', 'call', 'talk.catalog', '--params', '{}', '--json']]);
    expect(w.store.getAgent('a1')).toEqual(before);
  });

  it.each(['user-member', 'user-member-owner', 'user-foreign'])('refuses %s before contacting the runtime', async (owner) => {
    const w = await ready();
    const response = await read(w, owner);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Not found' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(w.provider.execLog).toEqual([]);
  });

  it.each(['missing', 'DELETING', 'DELETED'] as const)('does not inspect an agent that is %s', async (kind) => {
    const w = await ready();
    if (kind !== 'missing') state(w, kind);
    const response = await read(w, w.owner, kind === 'missing' ? 'missing' : 'a1');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Not found' });
    expect(w.provider.execLog).toEqual([]);
  });

  it.each(['PROVISIONING', 'REBUILDING', 'lock', 'operation'] as const)('reports %s as busy without contacting the runtime', async (kind) => {
    const w = await ready();
    if (kind === 'lock') markBusy('a1');
    else if (kind === 'operation') beginOperation(w.store, 'move-host', 'a1', {}, { queued: true }).hold('private recovery detail', { actions: [] });
    else state(w, kind);
    const response = await read(w);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: 'busy' });
    expect(w.provider.execLog).toEqual([]);
  });

  it.each(['STOPPED', 'ARCHIVED', 'FAILED', 'no runtime'] as const)('reports %s without starting or querying it', async (kind) => {
    const w = await ready();
    if (kind === 'no runtime') db(w).prepare('UPDATE agents SET runtime_ref = NULL WHERE id = ?').run('a1');
    else state(w, kind);
    const before = w.store.getAgent('a1');
    const response = await read(w);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: 'not_running' });
    expect(w.provider.execLog).toEqual([]);
    expect(w.store.getAgent('a1')).toEqual(before);
  });

  it.each(['unconfigured', 'unsupported', 'failed', 'throws', 'provider gone'] as const)('reports %s without exposing private details', async (kind) => {
    const w = await ready();
    if (kind === 'provider gone') w.providers.delete('mock');
    else if (kind === 'throws') w.provider.exec = async () => { throw new Error('private provider credential'); };
    else w.provider.execResponses.set('gateway call talk.catalog', kind === 'unconfigured'
      ? { code: 0, stdout: '{"realtime":{"ready":false}}', stderr: '' }
      : { code: 1, stdout: '', stderr: kind === 'unsupported' ? 'unknown method: talk.catalog' : 'private provider credential' });
    const response = await read(w);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: kind === 'unconfigured' || kind === 'unsupported' ? kind : 'unavailable' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each(['owner', 'DELETING', 'DELETED'] as const)('discards the catalog when %s changes while it waits', async (kind) => {
    const w = await ready();
    const pending = await pendingRead(w);
    if (kind === 'owner') db(w).prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run('user-new-owner', 'a1');
    else state(w, kind);
    pending.release();
    const response = await pending.response;
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toEqual({ error: 'Not found' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each(['STOPPED', 'REBUILDING', 'lock', 'operation'] as const)('reports the current %s lifecycle after a slow catalog call', async (kind) => {
    const w = await ready();
    const pending = await pendingRead(w);
    if (kind === 'lock') markBusy('a1');
    else if (kind === 'operation') beginOperation(w.store, 'move-host', 'a1', {}, { queued: true });
    else state(w, kind);
    pending.release();
    const response = await pending.response;
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: kind === 'STOPPED' ? 'not_running' : 'busy' });
  });

  it.each(['runtime', 'host', 'host settings', 'host removed', 'profile', 'profile settings', 'profile removed', 'provider', 'provider removed', 'applied source'] as const)('discards a result from the old %s context', async (kind) => {
    const w = await ready();
    w.store.insertHost({ ...w.store.getHost('h1')!, id: 'h2', name: 'Other box' });
    w.store.insertAIProfile({ ...w.store.getAIProfile('p1')!, id: 'p2', name: 'Other source' });
    w.store.setAgentApplied('a1', 'p1', 'claude-opus-4-8');
    const pending = await pendingRead(w);
    switch (kind) {
      case 'runtime': w.store.setAgentRuntimeRef('a1', 'mock://replacement'); break;
      case 'host': w.store.setAgentHost('a1', 'h2'); break;
      case 'host settings': db(w).prepare('UPDATE hosts SET settings = ? WHERE id = ?').run(JSON.stringify({ note: 'private runner setting' }), 'h1'); break;
      case 'host removed': w.store.deleteHost('h1'); break;
      case 'profile': w.store.setAgentAIProfile('a1', 'p2'); break;
      case 'profile settings': w.store.setAIProfileModel('p1', 'claude-sonnet-5'); break;
      case 'profile removed': w.store.deleteAIProfile('p1'); break;
      case 'provider': w.providers.set('mock', new MockProvider()); break;
      case 'provider removed': w.providers.delete('mock'); break;
      case 'applied source': w.store.setAgentApplied('a1', 'p2', 'claude-opus-4-8', '2026-11-15T12:00:00Z'); break;
    }
    pending.release();
    const response = await pending.response;
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
