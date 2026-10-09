import { describe, expect, it, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { isDefiniteRefusal, migrateAgent, MigrateError, preflight } from '../src/orchestrator/migrate.js';
import { isBusy } from '../src/orchestrator/busy.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) {
    const v = this.map.get(ref);
    if (v === undefined) throw new Error(`no secret ${ref}`);
    return v;
  }
  async delete(ref: string) { this.map.delete(ref); }
}

const channelStub = { kind: 'telegram' } as unknown as ChannelProvisioner;
const PEER = { id: 'peer1', name: 'Desktop', url: 'http://desktop:8080', secretRef: 'peer/tok' };

async function world() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({
    id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box',
    settings: {}, createdAt: 'now',
  });
  store.insertAIProfile({
    id: 'p1', ownerId: 'o', name: 'Claude', vendor: 'anthropic', kind: 'api_key',
    model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now',
  });
  store.insertAgent({
    id: 'a1', ownerId: 'o', name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING',
    aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true,
    createdAt: 'now', updatedAt: 'now',
  });
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'o', role: 'owner', status: 'active' });
  await secrets.put('ai/p1', 'sk');
  await secrets.put('chan/a1', 'bot-token');
  await secrets.put('peer/tok', 'hatchabot_peertoken');
  store.insertChannel({
    id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'kitchenbot',
    secretRef: 'chan/a1', deepLink: 'https://t.me/kitchenbot', createdAt: 'now',
  });
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'kitchen',
    workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } },
    env: {},
  });
  store.setAgentRuntimeRef('a1', runtimeRef);
  await provider.start(runtimeRef);
  store.setAgentState('a1', 'RUNNING');
  provider.stateStore.set(runtimeRef, Buffer.from('memory'));
  return { store, secrets, provider, deps: { store, secrets, provider, channel: channelStub, sleep: async () => {} } };
}

/** Stub the peer's HTTP surface. */
function peerResponds(handlers: { preflight?: any; import?: any; importStatus?: number }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    const u = String(url);
    if (u.endsWith('/v1/agents/preflight')) {
      return new Response(JSON.stringify(handlers.preflight ?? { ok: true, reasons: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (u.endsWith('/v1/agents/restore')) {
      return new Response(JSON.stringify(handlers.import ?? { id: 'remote1', name: 'Kitchen', state: 'RUNNING' }), {
        status: handlers.importStatus ?? 201, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('preflight', () => {
  it('accepts when nothing collides', async () => {
    const w = await world();
    const a = preflight(w.store, 'o', { slug: 'newname', accountId: 'otherbot', vendor: 'anthropic' });
    expect(a.ok).toBe(true);
    expect(a.aiModel).toBe('claude-opus-4-8');
  });

  it('refuses a slug or bot that already lives here, and says which', async () => {
    const w = await world();
    const a = preflight(w.store, 'o', { slug: 'kitchen', accountId: 'kitchenbot' });
    expect(a.ok).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/already lives here/);
    expect(a.reasons.join(' ')).toMatch(/already wired/);
  });

  it('refuses a bot that is a spare in this machine\'s pool (any case): two agents would share it', async () => {
    const w = await world();
    const { TelegramPoolProvisioner } = await import('../src/channels/telegramPool.js');
    const pool = new TelegramPoolProvisioner((w.store as any).db, new MemSecrets(), { fetchImpl: (async () => new Response('{"ok":true}')) as any });
    await pool.addToPool('sparebot', 'tok-s');
    const a = preflight(w.store, 'o', { slug: 'fresh', accountId: 'SpareBot', vendor: 'anthropic' });
    expect(a.ok).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/spare bot in this machine's pool/);
  });

  it('refuses a local-model agent when the destination has no local source', async () => {
    const w = await world(); // only an anthropic profile exists here
    const a = preflight(w.store, 'o', { slug: 'fresh', accountId: 'freshbot', vendor: 'local' });
    expect(a.ok).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/no local model server/i);
    expect(a.warnings).toContain('vendor-mismatch');
    // and it names what it WOULD have fallen back to, so the owner can judge
    expect(a.reasons.join(' ')).toMatch(/Claude/);
  });

  it('accepts when the vendor matches', async () => {
    const w = await world();
    const a = preflight(w.store, 'o', { slug: 'fresh', accountId: 'freshbot', vendor: 'anthropic' });
    expect(a.ok).toBe(true);
  });

  it('refuses when the destination has no AI source', () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({
      id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box',
      settings: {}, createdAt: 'now',
    });
    const a = preflight(store, 'o', { slug: 's', accountId: 'b' });
    expect(a.ok).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/No AI source/);
  });
});

describe('migrateAgent', () => {
  it('never exports when the destination refuses on a vendor mismatch', async () => {
    const w = await world();
    peerResponds({
      preflight: { ok: false, reasons: ['No matching AI source: it runs on a local model…'], warnings: ['vendor-mismatch'] },
    });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/No matching AI source/);
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING'); // untouched
  });

  it('moves the agent and leaves the source STOPPED, never deleted', async () => {
    const w = await world();
    peerResponds({});
    const res = await migrateAgent(w.deps as any, 'a1', PEER);
    expect(res).toMatchObject({ movedTo: 'Desktop', remoteAgentId: 'remote1' });
    // one poller per bot: the source must not be running
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
    // and it still exists — deleting it is the owner's decision
    expect(w.store.getAgent('a1')).toBeTruthy();
  });

  it('refuses before touching anything when preflight says no', async () => {
    const w = await world();
    peerResponds({ preflight: { ok: false, reasons: ['Bot @kitchenbot is already wired to an agent here.'] } });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toBeInstanceOf(MigrateError);
    // untouched: still running, never exported
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it('restarts the source when the destination rejects the import', async () => {
    const w = await world();
    peerResponds({ importStatus: 400, import: { error: 'disk full' } });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/disk full/);
    // export stopped it; the rollback must have put it back
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it('restarts the source when the destination accepts but does not come up', async () => {
    const w = await world();
    peerResponds({ import: { id: 'r1', name: 'Kitchen', state: 'FAILED' } });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/FAILED there/);
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it('restarts the source when the destination confirms nothing landed', async () => {
    const w = await world();
    // The import call dies, but the destination is reachable and its agent
    // list has no "kitchen" — the import really did roll back over there.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith('/preflight')) {
        return new Response(JSON.stringify({ ok: true, reasons: [] }), { status: 200 });
      }
      if (u.endsWith('/v1/agents') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error('ECONNRESET');
    });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/unchanged/);
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it('never restarts the source when it cannot confirm the agent did not land', async () => {
    const w = await world();
    // Peer completely unreachable after preflight: the import may have
    // committed over there. Restarting the source on that guess is the
    // two-pollers failure — the source must stay stopped.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).endsWith('/preflight')) {
        return new Response(JSON.stringify({ ok: true, reasons: [] }), { status: 200 });
      }
      throw new Error('ECONNRESET');
    });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/couldn't confirm/);
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
    expect(w.store.getAgent('a1')!.migratedTo).toBeUndefined();
  });

  it('tombstones without restarting when the agent landed despite the dropped connection', async () => {
    const w = await world();
    // The response was lost but the destination committed: its list shows
    // kitchen RUNNING. Both sides polling is the one unacceptable outcome.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith('/preflight')) {
        return new Response(JSON.stringify({ ok: true, reasons: [] }), { status: 200 });
      }
      if (u.endsWith('/v1/agents') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify([{ slug: 'kitchen', state: 'RUNNING' }]), { status: 200 });
      }
      throw new Error('ECONNRESET');
    });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/DID arrive/);
    const src = w.store.getAgent('a1')!;
    expect(src.state).toBe('STOPPED');
    expect(src.migratedTo).toContain('Desktop');
  });

  it('holds the busy flag for the whole move, so nothing else judges the stopped source', async () => {
    const w = await world();
    let busyDuringImport: boolean | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.endsWith('/preflight')) {
        return new Response(JSON.stringify({ ok: true, reasons: [] }), { status: 200 });
      }
      if (u.endsWith('/v1/agents/restore')) {
        busyDuringImport = isBusy('a1');
        return new Response(JSON.stringify({ id: 'remote1', name: 'Kitchen', state: 'RUNNING' }), {
          status: 201, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    await migrateAgent(w.deps as any, 'a1', PEER);
    expect(busyDuringImport).toBe(true);
    expect(isBusy('a1')).toBe(false);
  });

  it('tombstones the source so it cannot be restarted into a second poller', async () => {
    const w = await world();
    peerResponds({});
    await migrateAgent(w.deps as any, 'a1', PEER);
    const moved = w.store.getAgent('a1')!;
    expect(moved.state).toBe('STOPPED');
    expect(moved.migratedTo).toContain('Desktop');
  });

  it('leaves no tombstone when the move fails', async () => {
    const w = await world();
    peerResponds({ importStatus: 400, import: { error: 'nope' } });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow();
    expect(w.store.getAgent('a1')!.migratedTo).toBeUndefined();
  });

  it('refuses to move an agent that is mid-flight', async () => {
    const w = await world();
    w.store.setAgentState('a1', 'REBUILDING');
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/while it is REBUILDING/);
  });
});

/**
 * The import comes back as an HTTP error (`restore`), and the destination's
 * agent list answers as `list` says: an array, or 'unreachable' (the list
 * call throws), or a status number (the list call fails with it). Counts the
 * list calls so a test can tell whether the destination was asked.
 */
function importFailsWith(
  restore: { status: number; statusText?: string; body: string; contentType?: string },
  list: Array<Array<{ slug: string; state: string }>> | 'unreachable' | number,
) {
  const calls = { list: 0 };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
    const u = String(url);
    if (u.endsWith('/v1/agents/preflight')) {
      return new Response(JSON.stringify({ ok: true, reasons: [] }), { status: 200 });
    }
    if (u.includes('/v1/agents/restore')) {
      return new Response(restore.body, {
        status: restore.status,
        statusText: restore.statusText ?? '',
        headers: { 'content-type': restore.contentType ?? 'text/html' },
      });
    }
    if (u.endsWith('/v1/agents') && (init?.method ?? 'GET') === 'GET') {
      calls.list++;
      if (list === 'unreachable') throw new Error('ECONNREFUSED');
      if (typeof list === 'number') return new Response('<html>proxy error</html>', { status: list });
      // Successive answers; the last one repeats.
      const answer = list[Math.min(calls.list - 1, list.length - 1)];
      return new Response(JSON.stringify(answer), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  return calls;
}

const GATEWAY_TIMEOUT = { status: 504, statusText: 'Gateway Timeout', body: '<html>504 Gateway Timeout</html>' };
const BAD_GATEWAY = { status: 502, statusText: 'Bad Gateway', body: '<html>502 Bad Gateway</html>' };

describe('issue #1: an HTTP error from the import is not proof it rolled back', () => {
  it.each([
    ['504', GATEWAY_TIMEOUT],
    ['502', BAD_GATEWAY],
  ])('%s with the agent RUNNING on the destination: source stays stopped and is marked moved', async (code, restore) => {
    const w = await world();
    const calls = importFailsWith(restore, [[{ slug: 'kitchen', state: 'RUNNING' }]]);
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(
      new RegExp(`Desktop answered ${code} [A-Za-z ]+, but the agent DID arrive and is running there`),
    );
    expect(calls.list).toBeGreaterThan(0);
    const src = w.store.getAgent('a1')!;
    expect(src.state).toBe('STOPPED');
    expect(src.migratedTo).toContain('Desktop');
  });

  it.each([
    ['504', GATEWAY_TIMEOUT],
    ['502', BAD_GATEWAY],
  ])('%s with the agent still PROVISIONING there: source stays stopped, no tombstone, owner told to check', async (code, restore) => {
    const w = await world();
    const calls = importFailsWith(restore, [[{ slug: 'kitchen', state: 'PROVISIONING' }]]);
    const err = await migrateAgent(w.deps as any, 'a1', PEER).catch((e) => e);
    expect(err).toBeInstanceOf(MigrateError);
    expect(err.message).toMatch(new RegExp(`failed \\(it answered ${code} [A-Za-z ]+\\) and we couldn't confirm`));
    expect(err.message).toMatch(/left stopped to be safe — check Desktop/);
    // It waited for the import over there to settle before giving up.
    expect(calls.list).toBe(12);
    const src = w.store.getAgent('a1')!;
    expect(src.state).toBe('STOPPED');
    expect(src.migratedTo).toBeUndefined();
  });

  it('504, then the PROVISIONING import finishes RUNNING: source stays stopped and is marked moved', async () => {
    const w = await world();
    importFailsWith(GATEWAY_TIMEOUT, [
      [{ slug: 'kitchen', state: 'PROVISIONING' }],
      [{ slug: 'kitchen', state: 'RUNNING' }],
    ]);
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/DID arrive/);
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
    expect(w.store.getAgent('a1')!.migratedTo).toContain('Desktop');
  });

  it.each([
    ['504', GATEWAY_TIMEOUT],
    ['502', BAD_GATEWAY],
  ])('%s with the agent absent from the destination: source restarted, agent unchanged', async (code, restore) => {
    const w = await world();
    const calls = importFailsWith(restore, [[{ slug: 'other', state: 'RUNNING' }]]);
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(
      new RegExp(`The transfer to Desktop failed \\(it answered ${code} [A-Za-z ]+\\)\\. Your agent is unchanged\\.`),
    );
    expect(calls.list).toBe(1);
    const src = w.store.getAgent('a1')!;
    expect(src.state).toBe('RUNNING');
    expect(src.migratedTo).toBeUndefined();
  });

  it.each([
    ['504, list unreachable', GATEWAY_TIMEOUT, 'unreachable' as const],
    ['502, list unreachable', BAD_GATEWAY, 'unreachable' as const],
    ['504, list also 504', GATEWAY_TIMEOUT, 504],
    ['502, list also 502', BAD_GATEWAY, 502],
  ])('%s: source never restarted, owner told it could not be confirmed', async (_name, restore, list) => {
    const w = await world();
    const calls = importFailsWith(restore, list);
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/couldn't confirm whether the agent arrived/);
    expect(calls.list).toBe(12);
    const src = w.store.getAgent('a1')!;
    expect(src.state).toBe('STOPPED');
    expect(src.migratedTo).toBeUndefined();
  });

  it('a 503 or a 500 from Hatchabot itself is checked too', async () => {
    for (const restore of [
      { status: 503, statusText: 'Service Unavailable', body: 'upstream unavailable' },
      { status: 500, body: JSON.stringify({ error: 'Something went wrong on the server — its log has the details.' }), contentType: 'application/json' },
    ]) {
      const w = await world();
      const calls = importFailsWith(restore, [[{ slug: 'kitchen', state: 'RUNNING' }]]);
      await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/DID arrive/);
      expect(calls.list).toBe(1);
      expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
      vi.restoreAllMocks();
    }
  });

  it('a 4xx without a Hatchabot error body (a proxy\'s 408) is checked, not taken as a refusal', async () => {
    const w = await world();
    const calls = importFailsWith(
      { status: 408, statusText: 'Request Timeout', body: '<html>408</html>' },
      [[{ slug: 'kitchen', state: 'RUNNING' }]],
    );
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/answered 408 Request Timeout, but the agent DID arrive/);
    expect(calls.list).toBe(1);
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
  });

  // Issue #15: a proxy's timeout with a JSON `error` body was read as
  // Hatchabot refusing, so the source restarted next to a running copy.
  it.each([
    ['408', 408, 'Request Timeout'],
    ['499', 499, ''],
  ])('a JSON %s timeout with the agent RUNNING on the destination: checked, source stays stopped and marked moved', async (code, status, statusText) => {
    const w = await world();
    const calls = importFailsWith(
      { status, statusText, body: JSON.stringify({ error: 'proxy timed out' }), contentType: 'application/json' },
      [[{ slug: 'kitchen', state: 'RUNNING' }]],
    );
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(
      new RegExp(`Desktop answered ${code}[A-Za-z ]*, but the agent DID arrive and is running there`),
    );
    expect(calls.list).toBe(1);
    const src = w.store.getAgent('a1')!;
    expect(src.state).toBe('STOPPED');
    expect(src.migratedTo).toContain('Desktop');
  });

  it('a JSON 499 timeout with the agent absent from the destination: checked, then the source restarts', async () => {
    const w = await world();
    const calls = importFailsWith(
      { status: 499, body: JSON.stringify({ error: 'proxy timed out' }), contentType: 'application/json' },
      [[{ slug: 'other', state: 'RUNNING' }]],
    );
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/The transfer to Desktop failed \(it answered 499\)\. Your agent is unchanged\./);
    expect(calls.list).toBe(1);
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it.each([
    [409, JSON.stringify({ error: 'needs a build', code: 'image_decision', problem: 'only the owner may build' }), /doesn't have the image/],
    [429, JSON.stringify({ error: 'agent cap reached' }), /couldn't import it: agent cap reached\. Your agent is unchanged\./],
  ])('a genuine %s refusal from Hatchabot still restarts the source without asking', async (status, body, msg) => {
    const w = await world();
    w.store.setAgentImage('a1', 'hatchabot-derived:test');
    const calls = importFailsWith({ status, body, contentType: 'application/json' }, [[{ slug: 'kitchen', state: 'RUNNING' }]]);
    const err = await migrateAgent(w.deps as any, 'a1', PEER).catch((e) => e);
    expect(err).toBeInstanceOf(MigrateError);
    expect(err.message).toMatch(msg);
    expect(calls.list).toBe(0);
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it('a success status with no agent in the body is checked, not taken as an answer', async () => {
    const w = await world();
    const calls = importFailsWith(
      { status: 200, body: '<html>maintenance page</html>' },
      [[{ slug: 'kitchen', state: 'RUNNING' }]],
    );
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/DID arrive/);
    expect(calls.list).toBe(1);
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
    expect(w.store.getAgent('a1')!.migratedTo).toContain('Desktop');
  });

  it('a definite 4xx refusal from Hatchabot still restarts the source without asking the destination', async () => {
    const w = await world();
    const calls = importFailsWith(
      { status: 400, body: JSON.stringify({ error: 'disk full' }), contentType: 'application/json' },
      [[{ slug: 'kitchen', state: 'RUNNING' }]],
    );
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/Desktop couldn't import it: disk full\. Your agent is unchanged\./);
    expect(calls.list).toBe(0);
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it('isDefiniteRefusal: only a refusal status with Hatchabot\'s JSON error body', () => {
    expect(isDefiniteRefusal(400, { error: 'disk full' })).toBe(true);
    expect(isDefiniteRefusal(409, { error: 'needs a build', code: 'image_decision' })).toBe(true);
    expect(isDefiniteRefusal(429, { error: 'cap reached' })).toBe(true);
    expect(isDefiniteRefusal(504, undefined)).toBe(false);
    expect(isDefiniteRefusal(502, {})).toBe(false);
    expect(isDefiniteRefusal(500, { error: 'Something went wrong on the server' })).toBe(false);
    expect(isDefiniteRefusal(408, undefined)).toBe(false);
    expect(isDefiniteRefusal(400, { message: 'not ours' })).toBe(false);
    // Issue #15: timeouts are never a refusal, JSON body or not.
    for (const s of [408, 421, 425, 499]) expect(isDefiniteRefusal(s, { error: 'proxy timed out' })).toBe(false);
    for (const s of [401, 403, 404, 413, 415, 422]) expect(isDefiniteRefusal(s, { error: 'no' })).toBe(true);
  });
});

describe('one agent per bot, any case (night review, 2026-09-27)', () => {
  it('a second agent cannot take @KitchenBot as @kitchenbot', async () => {
    const { ChannelTakenError } = await import('../src/store/store.js');
    const w = await world();
    const existing = w.store.listChannelsForAgent('a1')[0]!;
    w.store.insertAgent({ id: 'a9', ownerId: 'o', name: 'Other', slug: 'other', state: 'STOPPED', aiProfileId: w.store.getAgent('a1')!.aiProfileId, hostId: w.store.getAgent('a1')!.hostId, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    expect(() => w.store.insertChannel({ id: 'c9', agentId: 'a9', kind: 'telegram', accountId: existing.accountId.toUpperCase(), secretRef: 'x', deepLink: 'https://t.me/x', createdAt: 'now' } as any)).toThrow(ChannelTakenError);
  });
});

describe('review, 2026-09-29: a failed move of a sleeping agent', () => {
  it('puts the agent back to sleep, mark and all, when the destination refuses', async () => {
    const w = await world();
    const ref = w.store.getAgent('a1')!.runtimeRef!;
    await w.provider.stop(ref);
    w.store.setAgentState('a1', 'STOPPED');
    const at = new Date().toISOString();
    w.store.setHibernated('a1', at, 42);
    peerResponds({ importStatus: 400, import: { error: 'disk full' } });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/disk full/);
    const a = w.store.getAgent('a1')!;
    expect(a.state).toBe('STOPPED');
    expect(a.hibernatedAt).toBe(at); // the wake poll will still answer its messages
    expect(a.hibernateMark).toBe(42);
  });

  it('a successful move leaves it plain stopped (asleep, it would wake beside its copy)', async () => {
    const w = await world();
    const ref = w.store.getAgent('a1')!.runtimeRef!;
    await w.provider.stop(ref);
    w.store.setAgentState('a1', 'STOPPED');
    w.store.setHibernated('a1', new Date().toISOString(), 42);
    peerResponds({});
    await migrateAgent(w.deps as any, 'a1', PEER);
    expect(w.store.getAgent('a1')!.hibernatedAt ?? null).toBeNull();
  });
});
