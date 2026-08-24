/**
 * End-to-end coverage of the copy/move user actions — Clone, Share/Import,
 * Download/Restore, the unified Import router, and Rehost — driven through the
 * real HTTP routes the web UI and CLI call. Runtime is MockProvider and the
 * channel is a stub; no Docker or Telegram. Peers are faked by stubbing fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { makeWorld, seedRunningAgent, as, OWNER } from './support/world.js';

function decode(raw: Buffer): any {
  return JSON.parse(gunzipSync(raw).toString('utf8'));
}
const octet = (owner?: string) => ({ ...as(owner), 'content-type': 'application/octet-stream' });

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------- Clone ------

describe('Clone — POST /v1/agents/:id/clone', () => {
  it('makes an independent copy: caller-owned, memory seeded, source untouched', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { members: [{ userId: 'member-x', displayName: 'Gran', channelUserId: '222' }] });

    const res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/clone', headers: as(), payload: { name: 'Kitchen Copy' } });
    expect(res.statusCode).toBe(201);
    const clone = res.json();
    expect(clone.name).toBe('Kitchen Copy');
    expect(clone.id).not.toBe('a1');
    expect(clone.slug).not.toBe('kitchen');

    // Clone includes memory → it's staged as a seed for first provision.
    const seed = w.store.getAgentSeed(clone.id);
    expect(Object.keys(seed)).toContain('MEMORY.md');

    // Sole owner is the caller; the source's extra member did NOT come along.
    const members = w.store.listMemberships(clone.id);
    expect(members.filter((m) => m.status === 'active')).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: OWNER, role: 'owner' });

    // Source is untouched — still running, still has both members.
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
    expect(w.store.listMemberships('a1').filter((m) => m.status === 'active')).toHaveLength(2);
  });

  it('refuses to clone an agent the caller does not own (404)', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    const res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/clone', headers: as('someone-else'), payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

// -------------------------------------------------- Share (template) ---------

describe('Share — GET /v1/agents/:id/export', () => {
  it('produces a template stripped of identity (no token, no members)', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { members: [{ userId: 'member-x', displayName: 'Gran', channelUserId: '222' }] });

    const res = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/export', headers: as() });
    expect(res.statusCode).toBe(200);
    const tpl = decode(res.rawPayload);
    expect(tpl.format).toBe('agentclaw-template');
    // identity must never leak into a shareable file
    expect(JSON.stringify(tpl)).not.toContain('bot-token-123');
    expect(JSON.stringify(tpl)).not.toContain('222'); // member telegram id
    // memory is included by default
    expect(Object.keys(tpl.files)).toContain('MEMORY.md');
  });

  it('omits memory when asked (?excludeMemory)', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    const res = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/export?excludeMemory=1', headers: as() });
    expect(Object.keys(decode(res.rawPayload).files)).not.toContain('MEMORY.md');
  });
});

// --------------------------------------------- Import a template -------------

describe('Import a template — POST /v1/agents/import', () => {
  it('stands up a FRESH agent owned solely by the importer', async () => {
    const src = await makeWorld();
    await seedRunningAgent(src, { members: [{ userId: 'member-x', channelUserId: '222' }] });
    const tpl = (await src.f.inject({ method: 'GET', url: '/v1/agents/a1/export', headers: as() })).rawPayload;

    // A different installation / owner imports it.
    const dst = await makeWorld('owner-b');
    const res = await dst.f.inject({ method: 'POST', url: '/v1/agents/import', headers: octet('owner-b'), payload: tpl });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe('template');

    const agent = dst.store.listAllActiveAgents()[0]!;
    const members = dst.store.listMemberships(agent.id).filter((m) => m.status === 'active');
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: 'owner-b', role: 'owner' });
    // no bot token carried — it provisions its own
    expect(dst.store.getChannelForAgent(agent.id)).toBeUndefined();
  });
});

// ------------------------------------------- Download + Restore --------------

describe('Download — GET /v1/agents/:id/backup', () => {
  it('is a full copy and leaves the source STOPPED (one poller per bot)', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    const res = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/backup', headers: as() });
    expect(res.statusCode).toBe(200);
    expect(decode(res.rawPayload).format).toBe('agentclaw-export');
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
  });
});

describe('Restore — POST /v1/agents/restore', () => {
  async function backupFrom() {
    const src = await makeWorld();
    await seedRunningAgent(src, { members: [{ userId: 'member-x', displayName: 'Gran', channelUserId: '222' }] });
    return (await src.f.inject({ method: 'GET', url: '/v1/agents/a1/backup', headers: as() })).rawPayload;
  }

  it('restores the SAME agent: token + members carried, owner reassigned, prior owner id dropped', async () => {
    const file = await backupFrom();
    const dst = await makeWorld('owner-b');
    const res = await dst.f.inject({ method: 'POST', url: '/v1/agents/restore', headers: octet('owner-b'), payload: file });
    expect(res.statusCode).toBe(201);
    expect(res.json().state).toBe('RUNNING');

    const agent = dst.store.listAllActiveAgents()[0]!;
    // bot token travelled, stored under the new install's ref
    const chan = dst.store.getChannelForAgent(agent.id)!;
    expect(chan.accountId).toBe('kitchenbot');
    expect(await dst.secrets.get(chan.secretRef)).toBe('bot-token-123');
    // owner seat is the importer; the non-owner member rides along
    const members = dst.store.listMemberships(agent.id);
    expect(members.find((m) => m.role === 'owner')!.userId).toBe('owner-b');
    expect(members.find((m) => m.displayName === 'Gran')!.channelUserId).toBe('222');
    // the previous owner's telegram id must NOT seed the new owner seat
    expect(members.find((m) => m.role === 'owner')!.channelUserId).toBeUndefined();
  });

  it('refuses when an agent with that slug already lives here', async () => {
    const file = await backupFrom();
    const dst = await makeWorld('owner-b');
    await seedRunningAgent(dst, { owner: 'owner-b', slug: 'kitchen', accountId: 'otherbot' });
    const res = await dst.f.inject({ method: 'POST', url: '/v1/agents/restore', headers: octet('owner-b'), payload: file });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/already lives/i);
  });

  it('refuses when the bot is already wired to another agent here', async () => {
    const file = await backupFrom();
    const dst = await makeWorld('owner-b');
    // a different agent already owns @kitchenbot
    await seedRunningAgent(dst, { owner: 'owner-b', slug: 'other', accountId: 'kitchenbot' });
    const res = await dst.f.inject({ method: 'POST', url: '/v1/agents/restore', headers: octet('owner-b'), payload: file });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/wired/i);
  });

  it('rejects a non-archive file (400)', async () => {
    const dst = await makeWorld('owner-b');
    const res = await dst.f.inject({ method: 'POST', url: '/v1/agents/restore', headers: octet('owner-b'), payload: Buffer.from('not an archive') });
    expect(res.statusCode).toBe(400);
  });
});

// -------------------------------- Unified Import auto-detect routing ----------

describe('Import router — POST /v1/agents/import auto-detects the file kind', () => {
  it('routes a full backup to a restore (kind: agent)', async () => {
    const src = await makeWorld();
    await seedRunningAgent(src);
    const file = (await src.f.inject({ method: 'GET', url: '/v1/agents/a1/backup', headers: as() })).rawPayload;
    const dst = await makeWorld('owner-b');
    const res = await dst.f.inject({ method: 'POST', url: '/v1/agents/import', headers: octet('owner-b'), payload: file });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe('agent');
    expect(res.json().state).toBe('RUNNING');
  });

  it('rejects garbage with a 400, not a 500', async () => {
    const dst = await makeWorld('owner-b');
    const res = await dst.f.inject({ method: 'POST', url: '/v1/agents/import', headers: octet('owner-b'), payload: Buffer.from('garbage') });
    expect(res.statusCode).toBe(400);
  });
});

// --------------------------------------------------------- Rehost ------------

describe('Rehost — POST /v1/agents/:id/rehost', () => {
  function registerPeer(w: Awaited<ReturnType<typeof makeWorld>>) {
    w.store.insertPeer({ id: 'peer1', ownerId: w.owner, name: 'Desktop', url: 'http://desktop:8080', secretRef: 'peer/tok', createdAt: 'now' });
    return w.secrets.put('peer/tok', 'agentclaw_peertoken');
  }
  function peerResponds(handlers: { preflight?: any; import?: any; importStatus?: number; landed?: any }) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith('/v1/agents/preflight')) return new Response(JSON.stringify(handlers.preflight ?? { ok: true, reasons: [] }), { status: 200 });
      if (u.endsWith('/v1/agents/restore')) return new Response(JSON.stringify(handlers.import ?? { id: 'r1', name: 'Kitchen', slug: 'kitchen', state: 'RUNNING' }), { status: handlers.importStatus ?? 201 });
      if (u.endsWith('/v1/agents')) return new Response(JSON.stringify(handlers.landed ?? [{ slug: 'kitchen', state: 'RUNNING' }]), { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
  }

  it('moves the agent and leaves the source STOPPED, not deleted', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    await registerPeer(w);
    peerResponds({});
    const res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/rehost', headers: as(), payload: { peerId: 'peer1' } });
    expect(res.statusCode).toBe(200);
    // source retained but stopped — deleting it is a deliberate manual step
    const src = w.store.getAgent('a1')!;
    expect(src.state).toBe('STOPPED');
  });

  it('refuses up front when the peer preflight says no, leaving the source RUNNING', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    await registerPeer(w);
    peerResponds({ preflight: { ok: false, reasons: ['Bot @kitchenbot is already wired to an agent here.'] } });
    const res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/rehost', headers: as(), payload: { peerId: 'peer1' } });
    expect(res.statusCode).toBe(400);
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
  });
});

// ------------------------------------- Permission gates (owner-only) ---------

describe('Permission gates', () => {
  it('backups, openclaw discovery, scan-paths and bots are refused to a non-host-owner (403)', async () => {
    const w = await makeWorld(); // local host owned by OWNER
    const notOwner = as('intruder');
    for (const [method, url, payload] of [
      ['GET', '/v1/backups'],
      ['POST', '/v1/backups/run'],
      ['GET', '/v1/bots'],
      ['GET', '/v1/openclaw/agents'],
      ['POST', '/v1/openclaw/quiesce', { accountIds: ['x'] }],
    ] as const) {
      const res = await w.f.inject({ method: method as any, url, headers: notOwner, payload: payload as any });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("a Download of another owner's agent is 404 (not found for the caller)", async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    const res = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/backup', headers: as('intruder') });
    expect(res.statusCode).toBe(404);
  });
});
