import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

const worlds: World[] = [];
afterEach(async () => { while (worlds.length) await worlds.pop()!.f.close(); });

describe('browser metadata after a delayed runner read', () => {
  async function ready() {
    const w = await makeWorld(); worlds.push(w);
    await seedRunningAgent(w);
    w.store.setAgentBrowser('a1', true);
    w.store.setAgentBrowserLogins('a1', '0a1b2c3d4e5f');
    w.store.noteAgentBrowserSite('a1', '0a1b2c3d4e5f', 'private.example.test');
    w.provider.browsers.set('a1', true);
    w.provider.browserLoginsOf.set('a1', '0a1b2c3d4e5f');
    return w;
  }

  it.each(['list', 'profile'])('does not disclose old sites after ownership changes during %s', async (stage) => {
    const w = await ready();
    const transfer = () => (w.store as unknown as { db: Database.Database }).db.prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run('user-other', 'a1');
    if (stage === 'list') {
      const original = w.provider.listBrowsers.bind(w.provider);
      w.provider.listBrowsers = async () => { const rows = await original(); transfer(); return rows; };
    } else {
      w.provider.browserProfileBytes = async () => { transfer(); return 1024; };
    }
    const r = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/browser', headers: as() });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('private.example.test');
  });

  it.each(['runtime', 'logins', 'browser', 'state', 'host'])('refuses obsolete browser metadata after %s changes', async (kind) => {
    const w = await ready(), original = w.provider.listBrowsers.bind(w.provider);
    w.provider.listBrowsers = async () => {
      const rows = await original();
      if (kind === 'runtime') w.store.setAgentRuntimeRef('a1', 'mock://replacement');
      if (kind === 'logins') w.store.setAgentBrowserLogins('a1', null);
      if (kind === 'browser') w.store.setAgentBrowser('a1', false);
      if (kind === 'state') w.store.setAgentState('a1', 'STOPPED');
      if (kind === 'host') (w.store as unknown as { db: Database.Database }).db.prepare('UPDATE hosts SET settings = ? WHERE id = ?').run('{"dockerHost":"tcp://runner.example.test:2376"}', 'h1');
      return rows;
    };
    const r = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/browser', headers: as() });
    expect(r.statusCode).toBe(409);
    expect(r.body).not.toContain('private.example.test');
  });

  it('returns current site history when only another site was added', async () => {
    const w = await ready(), original = w.provider.listBrowsers.bind(w.provider);
    w.provider.listBrowsers = async () => { const rows = await original(); w.store.noteAgentBrowserSite('a1', '0a1b2c3d4e5f', 'second.example.test'); return rows; };
    const r = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/browser', headers: as() });
    expect(r.statusCode).toBe(200);
    expect(r.json().sites).toEqual(expect.arrayContaining([expect.objectContaining({ site: 'second.example.test' })]));
  });
});
