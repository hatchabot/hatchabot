import { describe, expect, it } from 'vitest';
import { isBusy } from '../src/orchestrator/lifecycle/busy.js';
import { as, makeWorld, OWNER, seedRunningAgent } from './support/world.js';

/**
 * The moves, import and export routes (HB-0808 step 12) read their JSON
 * bodies with a schema (HB-0814), where the old code first read the body: a
 * body of the wrong shape is a 400 worded by `zodMessage`, nothing is
 * started, and every other answer keeps its words. Made-up data only; the
 * one address is built at run time.
 */
const post = (w: Awaited<ReturnType<typeof makeWorld>>, url: string, payload: unknown) =>
  w.f.inject({ method: 'POST', url, headers: { ...as(), 'content-type': 'application/json' }, payload: JSON.stringify(payload) });

describe('bodies of the wrong shape (HB-0814)', () => {
  it('move-host: a dropPin that is not a boolean is a 400, read after the busy check; a missing host keeps its words', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    w.store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'cloud', provider: 'mock', name: 'Runner', settings: {}, createdAt: 'now' });
    const bad = await post(w, '/v1/agents/a1/move-host', { hostId: 'h2', dropPin: 'yes' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/dropPin/);
    expect(w.store.getAgent('a1')).toMatchObject({ hostId: 'h1', state: 'RUNNING' });
    const none = await post(w, '/v1/agents/a1/move-host', {});
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toBe('Unknown host');
    const notThere = await post(w, '/v1/agents/a-none/move-host', { dropPin: 'yes' });
    expect(notThere.statusCode).toBe(404);
  });

  it('rehost: a peerId that is not text is a 400; an unknown one keeps its words', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    const bad = await post(w, '/v1/agents/a1/rehost', { peerId: 5 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/peerId/);
    const unknown = await post(w, '/v1/agents/a1/rehost', { peerId: 'peer-none' });
    expect(unknown.json()).toEqual({ error: 'Unknown server' });
    const pin = await post(w, '/v1/agents/a1/rehost', { peerId: 'peer-none', allowDroppedPin: 'yes' });
    expect(pin.statusCode).toBe(400);
    expect(pin.json().error).toMatch(/allowDroppedPin/);
  });

  it('send: an address that is not text is a 400 (it was a server error)', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    const bad = await post(w, '/v1/agents/a1/send', { toEmail: 5 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/toEmail/);
    const empty = await post(w, '/v1/agents/a1/send', {});
    expect(empty.json()).toEqual({ error: 'A valid recipient email is required.' });
  });

  it('clone and derive: a name that is not text is a 400, and the source is free after', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    const clone = await post(w, '/v1/agents/a1/clone', { name: 5 });
    expect(clone.statusCode).toBe(400);
    expect(clone.json().error).toMatch(/name/);
    expect(isBusy('a1')).toBe(false);
    expect(w.store.listAgents(OWNER).map((a) => a.id)).toEqual(['a1']);
    const derive = await post(w, '/v1/agents/a1/derive', { name: 5 });
    expect(derive.statusCode).toBe(400);
    expect(derive.json().error).toMatch(/name/);
    const unnamed = await post(w, '/v1/agents/a1/derive', {});
    expect(unnamed.json()).toEqual({ error: 'Name the child agent.' });
    const values = await post(w, '/v1/agents/a1/derive', { name: 'Unit 4B', values: { key: 5 } });
    expect(values.json()).toEqual({ error: 'Malformed setup values.' });
  });

  it('accept: a name that is not text is a 400 and the share stays waiting; dismiss turns it away', async () => {
    const w = await makeWorld();
    const address = ['owner', 'example.test'].join('@');
    w.store.insertShare({ id: 'sh1', fromOwner: 'user-sender', toEmail: address, toOwner: OWNER, agentName: 'Example', blob: Buffer.from('made-up'), createdAt: 'now' });
    const bad = await post(w, '/v1/inbox/sh1/accept', { name: 5 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/name/);
    expect(w.store.getShareFor('sh1', OWNER, undefined)).toBeDefined();
    const values = await post(w, '/v1/inbox/sh1/accept', { values: 'x' });
    expect(values.json()).toEqual({ error: 'Malformed setup values.' });
    expect((await post(w, '/v1/inbox/sh-none/dismiss', {})).statusCode).toBe(404);
    const gone = await post(w, '/v1/inbox/sh1/dismiss', {});
    expect(gone.json()).toEqual({ dismissed: true });
    expect(w.store.getShareFor('sh1', OWNER, undefined)).toBeUndefined();
  });

  it('the adopt routes: a path that is not text keeps its words, as does a quiesce without its ids', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    for (const url of ['/v1/workspaces/scan-paths', '/v1/workspaces/inspect', '/v1/agents/a1/adopt-workspace']) {
      const res = await post(w, url, { path: 5 });
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toEqual({ error: 'path required' });
    }
    const quiet = await post(w, '/v1/openclaw/quiesce', { accountIds: [5] });
    expect(quiet.json()).toEqual({ error: 'accountIds (string[]) required.' });
    expect((await post(w, '/v1/openclaw/quiesce', { accountIds: [] })).json()).toEqual({ quiet: [], stillBusy: [], unconfirmed: [] });
  });
});
