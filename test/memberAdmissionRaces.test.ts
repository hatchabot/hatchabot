import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerRoutes } from '../src/api/routes.js';
import type { IdentityVerifier } from '../src/api/identity.js';
import { clearBusy, isBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { checkInvite, createInvite } from '../src/orchestrator/members/invite.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

const worlds: World[] = [];
afterEach(async () => {
  clearBusy('a1');
  for (const w of worlds.splice(0)) await w.f.close();
});

async function fixture(identity = false) {
  const w = await makeWorld();
  worlds.push(w);
  if (identity) {
    await w.f.close();
    w.f = Fastify();
    const verifier = { verify: async () => ({ sub: 'guest', email: 'guest@example.com', emailVerified: true, expMs: Date.now() + 60_000 }) } as unknown as IdentityVerifier;
    await registerRoutes(w.f, { store: w.store, secrets: w.secrets, providers: w.providers, channel: w.channel, authMode: 'identity', verifier });
  }
  await seedRunningAgent(w);
  await seedRunningAgent(w, { id: 'a2', slug: 'second', accountId: 'secondbot', members: [{ userId: 'user-guest', displayName: 'Guest', channelUserId: '555' }] });
  w.provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [{ id: '555', code: 'CODE1' }] }), stderr: '' });
  return w;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('membership admission holds the lifecycle turn (HB-0719)', () => {
  it.each(['pairing/approve', 'members/known'])('%s refuses an existing operation before contacting the runtime', async (path) => {
    const w = await fixture();
    markBusy('a1');
    const before = w.provider.execLog.length;
    const response = await w.f.inject({ method: 'POST', url: `/v1/agents/a1/${path}`, headers: as(), payload: path.startsWith('pairing') ? { code: 'CODE1' } : { userId: 'user-guest' } });
    expect(response.statusCode, response.body).toBe(409);
    expect(w.provider.execLog).toHaveLength(before);
    expect(w.store.getMembership('a1', 'user-guest')).toBeUndefined();
    expect(isBusy('a1')).toBe(true);
  });

  it('known-person admission excludes revocation until the grant and membership agree', async () => {
    const w = await fixture();
    const entered = deferred(), release = deferred();
    const exec = w.provider.execShellOnVolume.bind(w.provider);
    w.provider.execShellOnVolume = async (ref, script, options) => {
      if (ref === w.store.getAgent('a1')!.runtimeRef && script.includes('const add = (arr)')) { entered.resolve(); await release.promise; }
      return exec(ref, script, options);
    };
    const pending = w.f.inject({ method: 'POST', url: '/v1/agents/a1/members/known', headers: as(), payload: { userId: 'user-guest' } }).then((r) => r);
    await entered.promise;
    let removal;
    try { removal = await w.f.inject({ method: 'DELETE', url: '/v1/agents/a1/members/user-guest', headers: as() }); }
    finally { release.resolve(); }
    expect((await pending).statusCode).toBe(200);
    expect(removal.statusCode, removal.body).toBe(409);
    expect(isBusy('a1')).toBe(false);
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/agents/a1/members/user-guest', headers: as() })).statusCode).toBe(200);
    expect(w.store.getMembership('a1', 'user-guest')?.status).toBe('revoked');
  });

  it('manual pairing excludes a stop while the runtime approval is pending', async () => {
    const w = await fixture();
    const entered = deferred(), release = deferred();
    const exec = w.provider.exec.bind(w.provider);
    w.provider.exec = async (ref, args, options) => {
      if (args[0] === 'pairing' && args[1] === 'approve') { entered.resolve(); await release.promise; }
      return exec(ref, args, options);
    };
    const pending = w.f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/approve', headers: as(), payload: { code: 'CODE1' } }).then((r) => r);
    await entered.promise;
    let stopped;
    try { stopped = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/stop', headers: as() }); }
    finally { release.resolve(); }
    expect((await pending).statusCode).toBe(200);
    expect(stopped.statusCode, stopped.body).toBe(409);
    expect(w.store.getAgent('a1')?.state).toBe('RUNNING');
    expect(isBusy('a1')).toBe(false);
  });

  it('keeps an invitation unused when its agent is busy', async () => {
    const w = await fixture(true);
    const { code } = createInvite(w.store, 'a1', w.owner);
    markBusy('a1');
    const response = await w.f.inject({ method: 'POST', url: '/v1/join', payload: { code, name: 'Guest', idToken: 'synthetic-identity' } });
    expect(response.statusCode, response.body).toBe(409);
    expect(checkInvite(w.store, code)).toMatchObject({ valid: true });
    expect(w.store.getMembership('a1', 'user-guest')).toBeUndefined();
  });

  it('a known invitee cannot be revoked while their runtime grant is pending', async () => {
    const w = await fixture(true);
    const { code } = createInvite(w.store, 'a1', w.owner);
    const entered = deferred(), release = deferred();
    const exec = w.provider.execShellOnVolume.bind(w.provider);
    w.provider.execShellOnVolume = async (ref, script, options) => {
      if (ref === w.store.getAgent('a1')!.runtimeRef && script.includes('const add = (arr)')) { entered.resolve(); await release.promise; }
      return exec(ref, script, options);
    };
    const pending = w.f.inject({ method: 'POST', url: '/v1/join', payload: { code, name: 'Guest', idToken: 'synthetic-identity' } }).then((r) => r);
    await entered.promise;
    let removal;
    try { removal = await w.f.inject({ method: 'DELETE', url: '/v1/agents/a1/members/user-guest', headers: as() }); }
    finally { release.resolve(); }
    expect((await pending).statusCode).toBe(201);
    expect(removal.statusCode, removal.body).toBe(409);
    expect(w.store.getMembership('a1', 'user-guest')).toMatchObject({ status: 'active', channelUserId: '555' });
    expect(isBusy('a1')).toBe(false);
  });

  it('cleans the original runtime grant if the known-person destination changes before commit', async () => {
    const w = await fixture();
    const ref = w.store.getAgent('a1')!.runtimeRef!;
    const exec = w.provider.execShellOnVolume.bind(w.provider);
    w.provider.execShellOnVolume = async (runtime, script, options) => {
      const result = await exec(runtime, script, options);
      if (script.includes('const add = (arr)')) w.store.setAgentRuntimeRef('a1', 'mock://replacement');
      return result;
    };
    const response = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/members/known', headers: as(), payload: { userId: 'user-guest' } });
    expect(response.statusCode, response.body).toBe(400);
    expect(w.store.getMembership('a1', 'user-guest')).toBeUndefined();
    expect(w.provider.execLog.some((a) => a[0] === 'sh-volume' && a[1]!.includes('delete from channel_pairing_allow_entries'))).toBe(true);
    expect(w.provider.stateStore.has(ref)).toBe(true);
    expect(isBusy('a1')).toBe(false);
  });

  it('cleans a late known-invitee grant if the seat was revoked outside the route lock', async () => {
    const w = await fixture(true);
    const { code } = createInvite(w.store, 'a1', w.owner);
    const exec = w.provider.execShellOnVolume.bind(w.provider);
    w.provider.execShellOnVolume = async (runtime, script, options) => {
      const result = await exec(runtime, script, options);
      if (script.includes('const add = (arr)')) w.store.revokeMembership('a1', 'user-guest');
      return result;
    };
    const response = await w.f.inject({ method: 'POST', url: '/v1/join', payload: { code, name: 'Guest', idToken: 'synthetic-identity' } });
    expect(response.statusCode, response.body).toBe(400);
    expect(w.store.getMembership('a1', 'user-guest')).toMatchObject({ status: 'revoked', channelUserId: undefined });
    expect(w.provider.execLog.some((a) => a[0] === 'sh-volume' && a[1]!.includes('delete from channel_pairing_allow_entries'))).toBe(true);
    expect(w.store.pairingWindowOpen('a1')).toBe(false);
    expect(isBusy('a1')).toBe(false);
  });

  it('does not approve a request after its runtime changes during channel discovery', async () => {
    const w = await fixture();
    w.store.insertChannel({ id: 'slack', agentId: 'a1', kind: 'slack', accountId: 'hatchabot', secretRef: 'slack', deepLink: '', createdAt: 'now' });
    const exec = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (runtime, script, options) => {
      const result = await exec(runtime, script, options);
      w.store.setAgentRuntimeRef('a1', 'mock://replacement');
      return result;
    };
    const response = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/approve', headers: as(), payload: { code: 'CODE1' } });
    expect(response.statusCode, response.body).toBe(409);
    expect(w.provider.execLog.some((a) => a[0] === 'pairing' && a[1] === 'approve')).toBe(false);
    expect(isBusy('a1')).toBe(false);
  });

  it('removes partial grants on every attempted channel when adding a known person fails', async () => {
    const w = await fixture();
    w.store.bindMemberIdentity('a2', 'user-guest', 'slack', 'U0GUEST');
    w.store.insertChannel({ id: 'slack', agentId: 'a1', kind: 'slack', accountId: 'hatchabot', secretRef: 'slack', deepLink: '', createdAt: 'now' });
    const exec = w.provider.execShellOnVolume.bind(w.provider);
    w.provider.execShellOnVolume = async (runtime, script, options) => {
      const result = await exec(runtime, script, options);
      if (script.includes('const add = (arr)') && script.includes('"channel":"slack"')) return { code: 1, stdout: '', stderr: 'write failed' };
      return result;
    };
    const response = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/members/known', headers: as(), payload: { userId: 'user-guest' } });
    expect(response.statusCode, response.body).toBe(400);
    expect(w.store.getMembership('a1', 'user-guest')).toBeUndefined();
    const cleanup = w.provider.execLog.filter((a) => a[0] === 'sh-volume' && a[1]!.includes('delete from channel_pairing_allow_entries'));
    expect(cleanup).toHaveLength(2);
    expect(cleanup.map((a) => a[1]).join('\n')).toContain('U0GUEST');
    expect(cleanup.map((a) => a[1]).join('\n')).toContain('555');
    expect(isBusy('a1')).toBe(false);
  });
});
