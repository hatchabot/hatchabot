import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { AgentState } from '../src/domain/types.js';
import { clearBusy, isBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { beginOperation } from '../src/orchestrator/lifecycle/operations.js';
import { voiceNetworkReady } from '../src/orchestrator/voice/voiceNetwork.js';
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
const setup = (w: World, owner = w.owner, body: unknown = {}) => w.f.inject({ method: 'POST', url: '/v1/agents/a1/voice', headers: { ...as(owner), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const patches = (w: World) => w.provider.execLog.filter((args) => args.slice(0, 3).join(' ') === 'gateway call config.patch');

async function ready(bound = true) {
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
  const config = { agents: { entries: { kitchen: {} } }, talk: bound ? { agentId: 'kitchen' } : {} };
  const snapshot = () => ({ code: 0, stderr: '', stdout: JSON.stringify({ valid: true, hash: 'fixture-config-revision', config }) });
  w.provider.execResponses.set('gateway call config.get', snapshot());
  w.provider.execResponses.set('gateway call config.patch', { code: 0, stderr: '', stdout: '{"ok":true}' });
  const exec = w.provider.exec.bind(w.provider);
  w.provider.exec = async (ref, args, options) => {
    const result = await exec(ref, args, options);
    if (args.slice(0, 3).join(' ') === 'gateway call config.patch' && result.code === 0) {
      config.talk = { agentId: 'kitchen' };
      w.provider.execResponses.set('gateway call config.get', snapshot());
    }
    return result;
  };
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

async function heldRequest(w: World, method: 'GET' | 'POST', command = 'config.get', cookie?: string) {
  let release!: () => void, signal!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  releasePending.push(release);
  const exec = w.provider.exec.bind(w.provider);
  let first = true;
  w.provider.exec = async (ref, args, options) => {
    const result = await exec(ref, args, options);
    if (first && args.slice(0, 3).join(' ') === `gateway call ${command}`) {
      first = false; signal(); await held;
    }
    return result;
  };
  const response = Promise.resolve(w.f.inject({ method, url: '/v1/agents/a1/voice',
    headers: { ...as(w.owner), ...(cookie ? { cookie } : {}) }, ...(method === 'POST' ? { payload: {} } : {}) }));
  await reached;
  return { response, release };
}

describe('GET /v1/agents/:id/voice', () => {
  it('reports that Talk needs this agent binding without querying another agent’s catalog', async () => {
    const w = await ready(false);
    const response = await read(w);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: 'unconfigured', reason: 'agent' });
    expect(w.provider.execLog.map((a) => a[2])).toEqual(['config.get']);
  });

  it('returns only safe configuration readiness, without caching or changing the agent', async () => {
    const w = await ready();
    const before = w.store.getAgent('a1');
    const response = await read(w);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ status: 'configured', provider: 'Google' });
    expect(w.provider.execLog).toEqual([
      ['gateway', 'call', 'config.get', '--params', '{}', '--json'],
      ['gateway', 'call', 'talk.catalog', '--params', '{}', '--json'],
      ['gateway', 'call', 'config.get', '--params', '{}', '--json'],
    ]);
    expect(w.store.getAgent('a1')).toEqual(before);
    expect(voiceNetworkReady(w.store, w.store.getAgent('a1')!, 'Google')).toBe(true);
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

describe('POST /v1/agents/:id/voice', () => {
  it.each([false, true])('binds Talk using the existing provider (manager=%s) without changing the source or starting a call', async (manager) => {
    const w = await ready(false);
    if (manager) db(w).prepare('UPDATE agents SET ops = 1 WHERE id = ?').run('a1');
    const before = w.store.getAgent('a1');
    const response = await setup(w);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ status: 'configured', provider: 'Google' });
    expect(patches(w)).toHaveLength(1);
    const args = patches(w)[0]!;
    const params = JSON.parse(args[args.indexOf('--params') + 1]!);
    expect(JSON.parse(params.raw)).toEqual({ talk: { agentId: 'kitchen' } });
    expect(params.baseHash).toBe('fixture-config-revision');
    expect(w.provider.execLog.every((a) => ['config.get', 'config.patch', 'talk.catalog'].includes(a[2]!))).toBe(true);
    expect(w.store.getAgent('a1')).toEqual(before);
    expect(isBusy('a1')).toBe(false);
    expect(response.body).not.toContain('private');
  });

  it('reuses an existing binding without a redundant configuration write', async () => {
    const w = await ready();
    const response = await setup(w);
    expect(response.statusCode, response.body).toBe(200);
    expect(patches(w)).toEqual([]);
    expect(isBusy('a1')).toBe(false);
  });

  it.each(['unconfigured', 'unsupported', 'unavailable'] as const)('reports the final %s catalog honestly after binding', async (kind) => {
    const w = await ready(false);
    w.provider.execResponses.set('gateway call talk.catalog', kind === 'unconfigured'
      ? { code: 0, stdout: '{"realtime":{"ready":false}}', stderr: '' }
      : { code: 1, stdout: '', stderr: kind === 'unsupported' ? 'unknown method: talk.catalog' : 'private catalog detail' });
    const response = await setup(w);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: kind });
    expect(patches(w)).toHaveLength(1);
    expect(response.body).not.toContain('private');
    expect(isBusy('a1')).toBe(false);
  });

  it.each(['user-member', 'user-member-owner', 'user-foreign'])('refuses %s before runtime access', async (owner) => {
    const w = await ready(false);
    const response = await setup(w, owner);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Not found' });
    expect(w.provider.execLog).toEqual([]);
  });

  it.each([null, [], 'setup', { provider: 'google' }, { agentId: 'other-agent' }, { apiKey: 'made-up-credential' }])('rejects nonempty or non-object input %j', async (body) => {
    const w = await ready(false);
    const response = await setup(w, w.owner, body);
    expect(response.statusCode).toBe(400);
    expect(w.provider.execLog).toEqual([]);
    expect(response.body).not.toContain('made-up-credential');
  });

  it('requires an explicit empty object', async () => {
    const w = await ready(false);
    const response = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/voice', headers: as(w.owner) });
    expect(response.statusCode).toBe(400);
    expect(w.provider.execLog).toEqual([]);
  });

  it.each(['STOPPED', 'FAILED', 'ARCHIVED', 'PROVISIONING', 'REBUILDING', 'lock', 'operation', 'no runtime'] as const)('refuses %s before any runtime write', async (kind) => {
    const w = await ready(false);
    if (kind === 'lock') markBusy('a1');
    else if (kind === 'operation') beginOperation(w.store, 'move-host', 'a1', {}, { queued: true });
    else if (kind === 'no runtime') db(w).prepare('UPDATE agents SET runtime_ref = NULL WHERE id = ?').run('a1');
    else state(w, kind);
    const response = await setup(w);
    expect(response.statusCode, response.body).toBe(409);
    expect(w.provider.execLog).toEqual([]);
  });

  it.each(['DELETED', 'DELETING'] as const)('refuses a %s agent', async (kind) => {
    const w = await ready(false); state(w, kind);
    expect((await setup(w)).statusCode).toBe(404);
    expect(w.provider.execLog).toEqual([]);
  });

  it('holds the lifecycle lock through configuration and refuses a second setup', async () => {
    const w = await ready(false), pending = await heldRequest(w, 'POST');
    expect(isBusy('a1')).toBe(true);
    expect((await setup(w)).statusCode).toBe(409);
    expect(patches(w)).toEqual([]);
    pending.release();
    expect((await pending.response).statusCode).toBe(200);
    expect(isBusy('a1')).toBe(false);
  });

  it.each(['unsupported', 'invalid', 'conflict', 'failed', 'throws', 'provider gone'] as const)('reports %s safely and releases its lifecycle lock', async (kind) => {
    const w = await ready(false);
    if (kind === 'provider gone') w.providers.delete('mock');
    else if (kind === 'throws') w.provider.exec = async () => { throw new Error('private runtime credential'); };
    else if (kind === 'invalid') w.provider.execResponses.set('gateway call config.get', { code: 0, stderr: '', stdout: '{"valid":false,"hash":"fixture-revision","config":{}}' });
    else if (kind === 'conflict') w.provider.execResponses.set('gateway call config.patch', { code: 1, stdout: '', stderr: 'config changed since last load; reload config.get and retry' });
    else w.provider.execResponses.set('gateway call config.get', { code: 1, stdout: '', stderr: kind === 'unsupported' ? 'unknown method: config.get' : 'private runtime credential' });
    const response = await setup(w);
    expect(response.statusCode, response.body).toBe(['unsupported', 'invalid', 'conflict'].includes(kind) ? 409 : 502);
    expect(typeof response.json().error).toBe('string');
    expect(response.body).not.toContain('private');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(isBusy('a1')).toBe(false);
  });

  it.each(['owner', 'logout', 'runtime', 'slug', 'host', 'host settings', 'host removed', 'profile', 'profile settings', 'profile removed', 'applied source', 'applied settings', 'provider', 'provider removed', 'STOPPED', 'operation'] as const)
    ('rechecks %s after the configuration read and before writing', async (kind) => {
      const w = await ready(false); let signedIn = true;
      if (kind === 'logout') w.f.principalFromCookieHeader = () => signedIn ? { ownerId: w.owner } as never : undefined;
      w.store.insertHost({ ...w.store.getHost('h1')!, id: 'h2', name: 'Other fixture host' });
      w.store.insertAIProfile({ ...w.store.getAIProfile('p1')!, id: 'p2', name: 'Other fixture source' });
      w.store.setAgentApplied('a1', 'p2', 'fixture-model');
      const pending = await heldRequest(w, 'POST');
      switch (kind) {
        case 'owner': db(w).prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run('other-owner', 'a1'); break;
        case 'logout': signedIn = false; break;
        case 'runtime': w.store.setAgentRuntimeRef('a1', 'mock://replacement'); break;
        case 'slug': db(w).prepare('UPDATE agents SET slug = ? WHERE id = ?').run('new-fixture-slug', 'a1'); break;
        case 'host': w.store.setAgentHost('a1', 'h2'); break;
        case 'host settings': db(w).prepare('UPDATE hosts SET settings = ? WHERE id = ?').run('{"changed":true}', 'h1'); break;
        case 'host removed': w.store.deleteHost('h1'); break;
        case 'profile': w.store.setAgentAIProfile('a1', 'p2'); break;
        case 'profile settings': w.store.setAIProfileModel('p1', 'fixture-replacement'); break;
        case 'profile removed': w.store.deleteAIProfile('p1'); break;
        case 'applied source': w.store.setAgentApplied('a1', 'p1', 'fixture-model', '2026-11-16T12:00:00Z'); break;
        case 'applied settings': w.store.setAIProfileModel('p2', 'fixture-replacement'); break;
        case 'provider': w.providers.set('mock', new MockProvider()); break;
        case 'provider removed': w.providers.delete('mock'); break;
        case 'STOPPED': state(w, kind); break;
        case 'operation': beginOperation(w.store, 'move-host', 'a1', {}, { queued: true }); break;
      }
      pending.release();
      const response = await pending.response;
      expect(response.statusCode, response.body).toBe(['owner', 'logout'].includes(kind) ? 404 : 409);
      expect(patches(w)).toEqual([]);
      expect(isBusy('a1')).toBe(false);
    });

  it.each(['owner', 'logout', 'provider', 'runtime', 'STOPPED'] as const)('discards a setup response after %s changes during the write', async (kind) => {
    const w = await ready(false); let signedIn = true;
    if (kind === 'logout') w.f.principalFromCookieHeader = () => signedIn ? { ownerId: w.owner } as never : undefined;
    const pending = await heldRequest(w, 'POST', 'config.patch');
    if (kind === 'owner') db(w).prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run('other-owner', 'a1');
    else if (kind === 'logout') signedIn = false;
    else if (kind === 'provider') w.providers.set('mock', new MockProvider());
    else if (kind === 'runtime') w.store.setAgentRuntimeRef('a1', 'mock://replacement');
    else state(w, kind);
    pending.release();
    const response = await pending.response;
    expect(response.statusCode, response.body).toBe(['owner', 'logout'].includes(kind) ? 404 : 409);
    expect(w.provider.execLog.map((a) => a[2])).toEqual(['config.get', 'config.patch']);
    expect(isBusy('a1')).toBe(false);
  });
});

describe('voice session guards', () => {
  it.each(['GET', 'POST'] as const)('discards a pending %s when its browser session stops verifying', async (method) => {
    const w = await ready(method === 'GET'); let signedIn = true;
    w.f.principalFromCookieHeader = () => signedIn ? { ownerId: w.owner } as never : undefined;
    const pending = await heldRequest(w, method);
    signedIn = false; pending.release();
    expect((await pending.response).statusCode).toBe(404);
    expect(patches(w)).toEqual([]);
  });

  it.each(['GET', 'POST'] as const)('retires a pending %s on explicit logout even when the cookie still verifies', async (method) => {
    const w = await ready(method === 'GET');
    w.f.principalFromCookieHeader = () => ({ ownerId: w.owner } as never);
    w.f.post('/v1/logout', async () => ({ ok: true }));
    const cookie = 'hatchabot_session=synthetic-voice-session';
    const pending = await heldRequest(w, method, 'config.get', cookie);
    await w.f.inject({ method: 'POST', url: '/v1/logout', headers: { ...as(w.owner), cookie } });
    pending.release();
    expect((await pending.response).statusCode).toBe(404);
    expect(patches(w)).toEqual([]);
  });
});

describe('manager voice network permission', () => {
  it('a read reports the missing network permission without granting it; explicit setup permits that voice provider', async () => {
    const w = await ready();
    db(w).prepare('UPDATE agents SET ops = 1 WHERE id = ?').run('a1');
    const agent = w.store.getAgent('a1')!;
    expect(voiceNetworkReady(w.store, agent, 'Google')).toBe(false);
    const before = await read(w);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toEqual({ status: 'unconfigured', reason: 'network' });
    expect(voiceNetworkReady(w.store, agent, 'Google')).toBe(false);
    const configured = await setup(w);
    expect(configured.statusCode, configured.body).toBe(200);
    expect(configured.json()).toEqual({ status: 'configured', provider: 'Google' });
    expect(voiceNetworkReady(w.store, w.store.getAgent('a1')!, 'Google')).toBe(true);
    expect((await read(w)).json()).toEqual({ status: 'configured', provider: 'Google' });
  });

  it('does not claim an unknown voice provider can leave the manager network restriction', async () => {
    const w = await ready();
    db(w).prepare('UPDATE agents SET ops = 1 WHERE id = ?').run('a1');
    w.provider.execResponses.set('gateway call talk.catalog', {
      code: 0, stderr: '', stdout: '{"realtime":{"ready":true,"activeProvider":"fixture-unknown"}}',
    });
    expect((await setup(w)).json()).toEqual({ status: 'unconfigured', reason: 'network' });
    expect(voiceNetworkReady(w.store, w.store.getAgent('a1')!, 'Configured voice provider')).toBe(false);
  });

  it.each(['owner', 'logout', 'runtime', 'provider', 'STOPPED'] as const)('does not grant network access after %s changes during the final catalog read', async (kind) => {
    const w = await ready(false); let signedIn = true;
    db(w).prepare('UPDATE agents SET ops = 1 WHERE id = ?').run('a1');
    const agent = w.store.getAgent('a1')!;
    if (kind === 'logout') w.f.principalFromCookieHeader = () => signedIn ? { ownerId: w.owner } as never : undefined;
    const pending = await heldRequest(w, 'POST', 'talk.catalog');
    if (kind === 'owner') db(w).prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run('other-owner', 'a1');
    else if (kind === 'logout') signedIn = false;
    else if (kind === 'runtime') w.store.setAgentRuntimeRef('a1', 'mock://replacement');
    else if (kind === 'provider') w.providers.set('mock', new MockProvider());
    else state(w, kind);
    pending.release();
    const response = await pending.response;
    expect(response.statusCode, response.body).toBe(['owner', 'logout'].includes(kind) ? 404 : 409);
    expect(voiceNetworkReady(w.store, agent, 'Google')).toBe(false);
    expect(voiceNetworkReady(w.store, w.store.getAgent('a1')!, 'Google')).toBe(false);
    expect(isBusy('a1')).toBe(false);
  });
});
