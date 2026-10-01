import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { claudePlanAllowed, registerRoutes } from '../src/api/routes.js';
import { installErrorHandler } from '../src/api/errorHandler.js';

/**
 * A hosted Hatchabot (HATCHABOT_MANAGED_BY set) takes Claude by API key only
 * (2026-09-30): a Claude plan source would have the provider storing and
 * relaying a customer's Claude.ai credentials, which Anthropic's terms bar.
 * HATCHABOT_MANAGED_ALLOW_CLAUDE_PLAN=1 turns it back on. Home installs: no change.
 */

const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };
const HOSTED = /On a hosted Hatchabot, connect Claude with an API key from console\.anthropic\.com\./;
// Made-up credentials, assembled here so nothing token-shaped sits in this file.
const SETUP_TOKEN = ['sk', 'ant', 'oat01', 'made', 'up', 'for', 'tests'].join('-');
const API_KEY = ['sk', 'ant', 'api03', 'made', 'up', 'for', 'tests'].join('-');

class MemSecrets {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error('missing'); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}

async function box() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  const secrets = new MemSecrets();
  const f = Fastify();
  installErrorHandler(f);
  await registerRoutes(f, {
    store, secrets, providers: new Map([['mock', new MockProvider()]]),
    channel: { kind: 'telegram', pool: { owns: () => false } },
  } as never);
  const add = (payload: Record<string, unknown>) => f.inject({ method: 'POST', url: '/v1/ai-profiles', headers: H, payload: { name: 'Claude', vendor: 'anthropic', model: 'claude-opus-4-8', ...payload } });
  return { f, store, secrets, add };
}

afterEach(() => {
  for (const k of ['HATCHABOT_MANAGED_BY', 'HATCHABOT_MANAGED_ALLOW_CLAUDE_PLAN', 'HATCHABOT_ALLOW_MACHINE_LOGIN']) delete process.env[k];
});

describe('Claude plan sources on a hosted Hatchabot', () => {
  it('a setup token, this machine\'s login, and a setup token pasted as an API key are all refused, with how to do it instead', async () => {
    process.env.HATCHABOT_MANAGED_BY = 'Example Cloud';
    process.env.HATCHABOT_ALLOW_MACHINE_LOGIN = '1'; // even where machine login would otherwise be allowed
    const b = await box();
    for (const payload of [{ kind: 'subscription', oauthToken: SETUP_TOKEN }, { kind: 'subscription' }, { kind: 'api_key', apiKey: SETUP_TOKEN }]) {
      const r = await b.add(payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error).toMatch(HOSTED);
    }
    expect(b.store.listAIProfiles(OWNER)).toEqual([]);
    expect(b.secrets.map.size).toBe(0);                 // nothing stored on the way to the refusal
    // An API key is the way, and works.
    const ok = await b.add({ kind: 'api_key', apiKey: API_KEY });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ kind: 'api_key', vendor: 'anthropic' });
    // The app is told not to offer it.
    expect((await b.f.inject({ method: 'GET', url: '/v1/config' })).json()).toMatchObject({ managed: { by: 'Example Cloud' }, claudePlan: false });
  });

  it('is allowed on a home install, as before', async () => {
    const b = await box();
    const r = await b.add({ kind: 'subscription', oauthToken: SETUP_TOKEN });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ kind: 'subscription' });
    expect((await b.f.inject({ method: 'GET', url: '/v1/config' })).json().claudePlan).toBe(true);
    // The old advice for a setup token pasted as a key is unchanged here.
    expect((await b.add({ kind: 'api_key', apiKey: SETUP_TOKEN })).json().error).toMatch(/Claude subscription/);
  });

  it('is allowed on a hosted install that turned it back on', async () => {
    process.env.HATCHABOT_MANAGED_BY = 'Example Cloud';
    process.env.HATCHABOT_MANAGED_ALLOW_CLAUDE_PLAN = '1';
    const b = await box();
    expect((await b.add({ kind: 'subscription', oauthToken: SETUP_TOKEN })).statusCode).toBe(201);
    expect((await b.f.inject({ method: 'GET', url: '/v1/config' })).json().claudePlan).toBe(true);
  });

  it('only an exact 1 turns it back on; a blank managed name is not managed', () => {
    expect(claudePlanAllowed({})).toBe(true);
    expect(claudePlanAllowed({ HATCHABOT_MANAGED_BY: '  ' })).toBe(true);
    expect(claudePlanAllowed({ HATCHABOT_MANAGED_BY: 'Example Cloud' })).toBe(false);
    expect(claudePlanAllowed({ HATCHABOT_MANAGED_BY: 'Example Cloud', HATCHABOT_MANAGED_ALLOW_CLAUDE_PLAN: 'yes' })).toBe(false);
    expect(claudePlanAllowed({ HATCHABOT_MANAGED_BY: 'Example Cloud', HATCHABOT_MANAGED_ALLOW_CLAUDE_PLAN: '1' })).toBe(true);
  });
});
