import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { AgentState } from '../src/domain/types.js';
import { markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { beginOperation } from '../src/orchestrator/lifecycle/operations.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

const worlds: World[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  while (worlds.length) await worlds.pop()!.f.close();
});
const db = (w: World) => (w.store as unknown as { db: Database.Database }).db;
const state = (w: World, next: AgentState) => db(w).prepare('UPDATE agents SET state = ? WHERE id = ?').run(next, 'a1');
const read = (w: World, owner = w.owner, id = 'a1') => w.f.inject({ method: 'GET', url: `/v1/agents/${id}/skills/status`, headers: as(owner) });
async function ready() {
  const w = await makeWorld(); worlds.push(w);
  await seedRunningAgent(w, { members: [{ userId: 'member', role: 'user' }, { userId: 'member-owner', role: 'owner' }] });
  w.provider.execResponses.set('gateway call skills.status', { code: 0, stderr: '', stdout: JSON.stringify({
    agentId: w.store.getAgent('a1')!.slug,
    workspaceDir: '/private/workspace',
    skills: [{ name: 'hatchabot-writing', skillKey: 'hatchabot-writing', description: 'private customized text',
      filePath: '/private/skill', apiKey: 'private-value', disabled: false, blockedByAllowlist: false,
      blockedByAgentFilter: false, eligible: true, modelVisible: true, platformIncompatible: false,
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] } }],
  }) });
  w.provider.execLog.length = 0;
  return w;
}
async function hold(w: World) {
  let release!: () => void, reached!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const entering = new Promise<void>((resolve) => { reached = resolve; });
  releases.push(release);
  const exec = w.provider.exec.bind(w.provider);
  w.provider.exec = async (ref, args, opts) => {
    const result = await exec(ref, args, opts);
    if (args.slice(0, 3).join(' ') === 'gateway call skills.status') { reached(); await wait; }
    return result;
  };
  const response = Promise.resolve(read(w));
  await entering;
  return { response, release };
}

describe('owner-only runtime skill checks', () => {
  it('checks explicitly without changing the selection or disclosing runtime text', async () => {
    const w = await ready(), before = w.store.getAgent('a1');
    const r = await read(w);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json().status).toBe('checked');
    expect(Number.isFinite(Date.parse(r.json().checkedAt))).toBe(true);
    expect(r.json().skills.find((s: { id: string }) => s.id === 'hatchabot-writing'))
      .toEqual({ id: 'hatchabot-writing', status: 'available', dependencies: [] });
    expect(r.body).not.toContain('private');
    expect(r.body).not.toContain('tested');
    expect(w.store.getAgent('a1')).toEqual(before);
    expect(w.provider.execLog).toEqual([['gateway', 'call', 'skills.status', '--params',
      JSON.stringify({ agentId: before!.slug }), '--json']]);
  });

  it.each(['member', 'member-owner', 'foreign'])('refuses %s before any runtime read', async (owner) => {
    const w = await ready();
    expect((await read(w, owner)).statusCode).toBe(404);
    expect(w.provider.execLog).toEqual([]);
  });

  it.each(['missing', 'DELETING', 'DELETED', 'manager'] as const)('does not inspect %s', async (kind) => {
    const w = await ready();
    if (kind === 'manager') db(w).prepare('UPDATE agents SET ops = 1 WHERE id = ?').run('a1');
    else if (kind !== 'missing') state(w, kind);
    const r = await read(w, w.owner, kind === 'missing' ? 'missing' : 'a1');
    expect(r.statusCode).toBe(kind === 'manager' ? 400 : 404);
    expect(w.provider.execLog).toEqual([]);
  });

  it.each(['STOPPED', 'ARCHIVED', 'FAILED', 'no runtime', 'PROVISIONING', 'REBUILDING', 'lock', 'operation'] as const)
    ('reports %s without waking or inspecting it', async (kind) => {
      const w = await ready();
      if (kind === 'no runtime') db(w).prepare('UPDATE agents SET runtime_ref = NULL WHERE id = ?').run('a1');
      else if (kind === 'lock') markBusy('a1');
      else if (kind === 'operation') beginOperation(w.store, 'move-host', 'a1', {}, { queued: true });
      else state(w, kind);
      const before = w.store.getAgent('a1');
      expect((await read(w)).json()).toEqual({ status: ['PROVISIONING', 'REBUILDING', 'lock', 'operation'].includes(kind) ? 'busy' : 'not_running', skills: [] });
      expect(w.provider.execLog).toEqual([]);
      expect(w.store.getAgent('a1')).toEqual(before);
    });

  it.each(['owner', 'DELETING', 'DELETED', 'logout'] as const)('discards a delayed result after %s', async (kind) => {
    const w = await ready();
    let signedIn = true;
    if (kind === 'logout') w.f.principalFromCookieHeader = () => signedIn ? { ownerId: w.owner } as never : undefined;
    const pending = await hold(w);
    if (kind === 'owner') db(w).prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run('new-owner', 'a1');
    else if (kind === 'logout') signedIn = false;
    else state(w, kind);
    pending.release();
    expect((await pending.response).statusCode).toBe(404);
  });

  it.each(['STOPPED', 'REBUILDING', 'lock', 'operation'] as const)('uses the current %s lifecycle after waiting', async (kind) => {
    const w = await ready();
    const pending = await hold(w);
    if (kind === 'lock') markBusy('a1');
    else if (kind === 'operation') beginOperation(w.store, 'move-host', 'a1', {}, { queued: true });
    else state(w, kind);
    pending.release();
    expect((await pending.response).json()).toEqual({ status: kind === 'STOPPED' ? 'not_running' : 'busy', skills: [] });
  });

  it.each(['runtime', 'host', 'host settings', 'profile', 'profile settings', 'provider', 'provider removed',
    'selection', 'applied selection', 'browser', 'environment', 'connection', 'rebuild completed'] as const)
    ('discards a reading when the %s changes', async (kind) => {
      const w = await ready();
      w.store.insertHost({ ...w.store.getHost('h1')!, id: 'h2' });
      w.store.insertAIProfile({ ...w.store.getAIProfile('p1')!, id: 'p2' });
      const pending = await hold(w);
      switch (kind) {
        case 'runtime': w.store.setAgentRuntimeRef('a1', 'mock://replacement'); break;
        case 'host': w.store.setAgentHost('a1', 'h2'); break;
        case 'host settings': db(w).prepare('UPDATE hosts SET settings = ? WHERE id = ?').run('{"changed":true}', 'h1'); break;
        case 'profile': w.store.setAgentAIProfile('a1', 'p2'); break;
        case 'profile settings': w.store.setAIProfileModel('p1', 'another-model'); break;
        case 'provider': w.providers.set('mock', new MockProvider()); break;
        case 'provider removed': w.providers.delete('mock'); break;
        case 'selection': w.store.setAgentCuratedSkills('a1', []); break;
        case 'applied selection': w.store.setAgentCuratedSkillsApplied('a1', []); break;
        case 'browser': w.store.setAgentBrowser('a1', true); break;
        case 'environment': w.store.insertAgentEnv({ id: 'env', agentId: 'a1', name: 'EXAMPLE', secretRef: 'made-up/ref', createdAt: 'now' }); break;
        case 'connection':
          w.store.insertConnection({ id: 'connection', ownerId: w.owner, kind: 'google', email: 'pat@example.com', services: ['gmail'], secretRef: 'made-up/ref' });
          w.store.attachConnection('a1', 'connection', true); break;
        case 'rebuild completed': db(w).prepare('UPDATE agents SET updated_at = ? WHERE id = ?').run('2026-11-15T12:00:00Z', 'a1'); break;
      }
      pending.release();
      expect((await pending.response).json()).toEqual({ status: 'unavailable', skills: [] });
    });

  it('coalesces concurrent checks, then reads afresh after they finish', async () => {
    const w = await ready();
    const first = await hold(w);
    const second = Promise.resolve(read(w));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(w.provider.execLog).toHaveLength(1);
    first.release();
    const results = await Promise.all([first.response, second]);
    expect(results.map((r) => r.json().status)).toEqual(['checked', 'checked']);
    await read(w);
    expect(w.provider.execLog).toHaveLength(2);
  });
});
