import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { MemSecrets } from './support/world.js';

/**
 * The bodies of the Hatchabot agent's and Report a problem's routes, parsed
 * by their schemas where the old code first read them (HB-0814, HB-0808 step
 * 14): a field of the wrong type, or a body that is not an object, is a 400
 * that changes nothing; null is as good as left out. Made-up names only.
 */
const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };
const JSON_H = { ...H, 'content-type': 'application/json' };

async function world() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'openai', kind: 'api_key', model: 'gpt-5', secretRef: 'ai/p1', createdAt: 'now' });
  await secrets.put('ai/p1', ['made', 'up'].join('-'));
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: { pool: { availableCount: () => 0 } } as never, allowUnjailedOps: true });
  return { store, f };
}

describe('the operator\'s profile', () => {
  it('content of the wrong type, or a body that is not an object, is a 400 and keeps the profile', async () => {
    const { store, f } = await world();
    expect((await f.inject({ method: 'PUT', url: '/v1/operator-profile', headers: H, payload: { content: 'Bakes bread.' } })).statusCode).toBe(202);
    for (const payload of [JSON.stringify({ content: 5 }), JSON.stringify('Bakes bread.'), JSON.stringify([1])]) {
      const r = await f.inject({ method: 'PUT', url: '/v1/operator-profile', headers: JSON_H, payload });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toEqual(expect.any(String));
    }
    expect(store.getOperatorProfile(OWNER)).toBe('Bakes bread.');
    // Null is as good as left out: an empty profile, as before.
    expect((await f.inject({ method: 'PUT', url: '/v1/operator-profile', headers: H, payload: { content: null } })).json()).toMatchObject({ content: '' });
  });
});

describe('making the Hatchabot agent', () => {
  it('a source id of the wrong type is a 400 that makes nothing; null takes the default', async () => {
    const { store, f } = await world();
    const bad = await f.inject({ method: 'POST', url: '/v1/ops-agent', headers: H, payload: { aiProfileId: 7 } });
    expect(bad.statusCode).toBe(400);
    expect(store.getOpsAgent(OWNER)).toBeUndefined();
    const ok = await f.inject({ method: 'POST', url: '/v1/ops-agent', headers: H, payload: { aiProfileId: null } });
    expect(ok.statusCode).toBe(202);
    expect(store.getOpsAgent(OWNER)?.aiProfileId).toBe('p1');
  });
});

describe('a problem report\'s draft', () => {
  it('a field of the wrong type is a 400 that keeps nothing; the old words for a missing title stay', async () => {
    const { store, f } = await world();
    const bad = await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: H, payload: { title: 'It stopped', whatHappened: 'It stopped answering.', steps: 3 } });
    expect(bad.statusCode).toBe(400);
    expect(store.listProblemReports(OWNER)).toEqual([]);
    const none = await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: H, payload: { whatHappened: 'It stopped answering.' } });
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toBe('A title and what happened, in a sentence or two.');
  });

  it('an edit of the wrong type is a 400 that changes nothing, even for a draft that is not there', async () => {
    const { store, f } = await world();
    const made = (await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: H, payload: { title: 'It stopped', whatHappened: 'It stopped answering.', by: null } })).json();
    expect(made.by).toBe('person');
    const bad = await f.inject({ method: 'PATCH', url: `/v1/problem-reports/${made.id}`, headers: H, payload: { title: ['x'] } });
    expect(bad.statusCode).toBe(400);
    expect(store.getProblemReport(OWNER, made.id)!.title).toBe(made.title);
    expect((await f.inject({ method: 'PATCH', url: '/v1/problem-reports/no-such', headers: H, payload: { body: 5 } })).statusCode).toBe(400);
    expect((await f.inject({ method: 'PATCH', url: '/v1/problem-reports/no-such', headers: H, payload: { body: 'x' } })).statusCode).toBe(404);
  });
});
