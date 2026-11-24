import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { registerMgmtChat } from '../src/api/mgmtChat.js';
import { getOpsHandlers, setOpsHandlers } from '../src/ops/opsServer.js';
import { grantVoiceNetwork, voiceNetworkHosts, voiceNetworkReady } from '../src/orchestrator/voice/voiceNetwork.js';

const databases: Database.Database[] = [];
afterEach(() => {
  setOpsHandlers({ mcp: async () => undefined, allowedHosts: () => undefined });
  for (const db of databases.splice(0)) db.close();
});

function world() {
  const db = new Database(':memory:'); databases.push(db);
  const store = new Store(db);
  store.insertHost({ id: 'h1', ownerId: 'owner-a', kind: 'local', provider: 'mock', name: 'Fixture host', settings: {}, createdAt: 'now' });
  store.insertHost({ id: 'h2', ownerId: 'owner-a', kind: 'cloud', provider: 'other', name: 'Other host', settings: {}, createdAt: 'now' });
  for (const id of ['p1', 'p2']) store.insertAIProfile({ id, ownerId: 'owner-a', vendor: 'anthropic', name: 'Fixture source', kind: 'api_key', model: 'fixture-model', secretRef: `fixture/${id}`, createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: 'owner-a', slug: 'hatchabot', name: 'Hatchabot', state: 'RUNNING', runtimeRef: 'mock://manager', hostId: 'h1', aiProfileId: 'p1', ops: true, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  const agent = () => store.getAgent('a1')!;
  return { db, store, agent };
}

describe('explicit manager voice network access', () => {
  it('ordinary agents need no grant, while a second provider on a manager does', () => {
    const { store, agent } = world();
    expect(voiceNetworkReady(store, { ...agent(), ops: false }, 'Google')).toBe(true);
    expect(voiceNetworkReady(store, agent(), 'Google')).toBe(false);
    expect(voiceNetworkHosts(store, agent())).toEqual([]);
    expect(store.getVoiceNetworkGrant('a1')).toBeUndefined();
    grantVoiceNetwork(store, { ...agent(), ops: false }, 'Google');
    expect(store.getVoiceNetworkGrant('a1')).toBeUndefined();
  });

  it('recognizes Google text-provider access without creating a grant', () => {
    const { db, store, agent } = world();
    db.prepare('UPDATE ai_profiles SET vendor = ? WHERE id = ?').run('google', 'p1');
    expect(voiceNetworkReady(store, agent(), 'Google')).toBe(true);
    expect(store.getVoiceNetworkGrant('a1')).toBeUndefined();
  });

  it('requires explicit OpenAI voice access even when its text API is already allowed', () => {
    const { db, store, agent } = world();
    db.prepare('UPDATE ai_profiles SET vendor = ? WHERE id = ?').run('openai', 'p1');
    expect(voiceNetworkReady(store, agent(), 'OpenAI')).toBe(false);
    grantVoiceNetwork(store, agent(), 'OpenAI');
    expect(voiceNetworkHosts(store, agent())).toEqual(['api.openai.com', 'chatgpt.com']);
    expect(voiceNetworkReady(store, agent(), 'OpenAI')).toBe(true);
  });

  it('adds only a fixed host and replaces, rather than accumulates, approved providers', () => {
    const { store, agent } = world();
    grantVoiceNetwork(store, agent(), 'Google');
    expect(voiceNetworkHosts(store, agent())).toEqual(['generativelanguage.googleapis.com']);
    expect(voiceNetworkReady(store, agent(), 'Google')).toBe(true);
    expect(voiceNetworkReady(store, agent(), 'OpenAI')).toBe(false);
    grantVoiceNetwork(store, agent(), 'OpenAI');
    expect(voiceNetworkHosts(store, agent())).toEqual(['api.openai.com', 'chatgpt.com']);
    expect(voiceNetworkReady(store, agent(), 'Google')).toBe(false);
    expect(store.ownerPrefs('owner-a')).toEqual({ ownBotsOnly: false });
    const raw = store.getVoiceNetworkGrant('a1')!;
    expect(raw).not.toContain('fixture/p1');
    expect(raw).not.toContain('mock://manager');
    expect(raw).not.toContain('api.openai.com');
  });

  it.each([undefined, '', 'google', 'https://api.openai.com', 'api.openai.com', 'OpenAI.evil', 'Configured voice provider'])('refuses unknown provider label %s', (label) => {
    const { store, agent } = world();
    grantVoiceNetwork(store, agent(), label);
    expect(voiceNetworkReady(store, agent(), label)).toBe(false);
    expect(voiceNetworkHosts(store, agent())).toEqual([]);
    expect(store.getVoiceNetworkGrant('a1')).toBeUndefined();
  });

  it('ignores malformed, oversized and extra-field grants', () => {
    const { store, agent } = world();
    grantVoiceNetwork(store, agent(), 'Google');
    const valid = JSON.parse(store.getVoiceNetworkGrant('a1')!);
    for (const raw of ['bad JSON', 'null', '[]', '{}', ' '.repeat(513),
      JSON.stringify({ ...valid, provider: 'arbitrary.example.test' }),
      JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, host: 'arbitrary.example.test' }),
      JSON.stringify({ ...valid, context: 'stale' })]) {
      store.setVoiceNetworkGrant('a1', raw);
      expect(voiceNetworkHosts(store, agent()), raw).toEqual([]);
      expect(voiceNetworkReady(store, agent(), 'Google'), raw).toBe(false);
    }
  });

  it.each([
    ['owner', "UPDATE agents SET owner_id = 'owner-b' WHERE id = 'a1'"],
    ['slug', "UPDATE agents SET slug = 'renamed' WHERE id = 'a1'"],
    ['runtime', "UPDATE agents SET runtime_ref = 'mock://replacement' WHERE id = 'a1'"],
    ['host', "UPDATE agents SET host_id = 'h2' WHERE id = 'a1'"],
    ['host provider', "UPDATE hosts SET provider = 'replacement' WHERE id = 'h1'"],
    ['host settings', "UPDATE hosts SET settings = '{\"socket\":\"/tmp/fixture.sock\"}' WHERE id = 'h1'"],
    ['host ownership', "UPDATE hosts SET owner_id = 'owner-b' WHERE id = 'h1'"],
    ['source', "UPDATE agents SET ai_profile_id = 'p2' WHERE id = 'a1'"],
    ['source settings', "UPDATE ai_profiles SET model = 'other-model' WHERE id = 'p1'"],
    ['source owner', "UPDATE ai_profiles SET owner_id = 'owner-b' WHERE id = 'p1'"],
    ['applied source time', "UPDATE agents SET applied_profile_at = 'later' WHERE id = 'a1'"],
    ['applied source', "UPDATE agents SET applied_profile_id = 'p2' WHERE id = 'a1'"],
    ['stopped', "UPDATE agents SET state = 'STOPPED' WHERE id = 'a1'"],
    ['non-manager', "UPDATE agents SET ops = 0 WHERE id = 'a1'"],
    ['missing host', "DELETE FROM hosts WHERE id = 'h1'"],
    ['missing source', "DELETE FROM ai_profiles WHERE id = 'p1'"],
  ])('does not carry a grant across a changed %s', (_kind, sql) => {
    const { db, store, agent } = world();
    const original = agent();
    grantVoiceNetwork(store, original, 'Google');
    db.exec(sql);
    expect(voiceNetworkHosts(store, original)).toEqual([]);
    expect(voiceNetworkHosts(store, agent())).toEqual([]);
  });

  it('keeps the grant when its source is chosen as the default for new agents or for the helper calls (HB-1105)', () => {
    const { db, store, agent } = world();
    db.prepare('UPDATE ai_profiles SET vendor = ? WHERE id = ?').run('openai', 'p1');
    grantVoiceNetwork(store, agent(), 'OpenAI');
    expect(voiceNetworkReady(store, agent(), 'OpenAI')).toBe(true);
    store.setAIProfileDefault('p1');
    expect(voiceNetworkHosts(store, agent())).toEqual(['api.openai.com', 'chatgpt.com']);
    expect(voiceNetworkReady(store, agent(), 'OpenAI')).toBe(true);
    store.setAIProfileDefault('p2');
    store.setAIProfileDefault(null);
    db.exec("UPDATE ai_profiles SET mgmt_llm = 1 WHERE id = 'p1'");
    expect(voiceNetworkHosts(store, agent())).toEqual(['api.openai.com', 'chatgpt.com']);
    // What the source is still binds it.
    db.exec("UPDATE ai_profiles SET secret_ref = 'fixture/other' WHERE id = 'p1'");
    expect(voiceNetworkHosts(store, agent())).toEqual([]);
  });

  it('a grant made before HB-1105 still holds while nothing changed, and is bound anew (HB-1105)', () => {
    const { store, agent } = world();
    const a = agent();
    const legacy = createHash('sha256').update(JSON.stringify([
      [a.id, a.ownerId, a.slug, a.runtimeRef, a.hostId, a.aiProfileId, a.appliedProfileId, a.appliedProfileAt],
      store.getHost('h1'), store.getAIProfile('p1'), undefined,
    ])).digest('hex');
    store.setVoiceNetworkGrant('a1', JSON.stringify({ version: 1, provider: 'google', context: legacy }));
    expect(voiceNetworkHosts(store, agent())).toEqual(['generativelanguage.googleapis.com']);
    expect(JSON.parse(store.getVoiceNetworkGrant('a1')!).context).not.toBe(legacy);
    store.setAIProfileDefault('p1');
    expect(voiceNetworkHosts(store, agent())).toEqual(['generativelanguage.googleapis.com']);
  });

  it('cannot grant from a stale caller snapshot or an old owner preference moved to the new owner', () => {
    const { db, store, agent } = world();
    const original = agent();
    grantVoiceNetwork(store, original, 'Google');
    db.exec("UPDATE agents SET owner_id = 'owner-b' WHERE id = 'a1'; UPDATE owner_prefs SET owner_id = 'owner-b' WHERE owner_id = 'owner-a'");
    const moved = store.getVoiceNetworkGrant('a1');
    expect(moved).toBeDefined();
    expect(voiceNetworkHosts(store, agent())).toEqual([]);
    grantVoiceNetwork(store, original, 'OpenAI');
    expect(store.getVoiceNetworkGrant('a1')).toBe(moved);
    expect(voiceNetworkHosts(store, agent())).toEqual([]);
  });

  it('clears private grants with deleted-agent residue and permits explicit removal', () => {
    const { db, store, agent } = world();
    grantVoiceNetwork(store, agent(), 'Google');
    store.setVoiceNetworkGrant('a1', null);
    expect(voiceNetworkHosts(store, agent())).toEqual([]);
    grantVoiceNetwork(store, agent(), 'Google');
    store.setAgentState('a1', 'DELETING');
    store.setAgentState('a1', 'DELETED');
    store.scrubAgentResidue('a1');
    expect(store.getVoiceNetworkGrant('a1')).toBeUndefined();
    expect(voiceNetworkHosts(store, agent())).toEqual([]);
    expect(db.prepare("SELECT count(*) n FROM owner_prefs WHERE key = 'voice-network:a1'").get()).toEqual({ n: 0 });
  });

  it('the actual manager proxy preserves text and messaging hosts and admits only the scoped voice grant', async () => {
    const { db, store, agent } = world();
    const app = Fastify();
    try {
      registerMgmtChat(app, { store, secrets: { get: async () => { throw new Error('unused'); }, put: async () => {}, delete: async () => {} } });
      store.setOpsToken('a1', 'owner-a', 'fixture-door');
      for (const kind of ['telegram', 'discord'] as const) store.insertChannel({ id: kind, agentId: 'a1', kind, accountId: 'fixture', secretRef: `fixture/${kind}`, deepLink: '', createdAt: 'now' });
      const door = getOpsHandlers()!, existing = ['api.anthropic.com', 'api.telegram.org', 'discord.com', 'gateway.discord.gg', 'cdn.discordapp.com', 'media.discordapp.net'];
      expect(door.allowedHosts('fixture-door')).toEqual(existing);
      grantVoiceNetwork(store, agent(), 'Google');
      expect(door.allowedHosts('fixture-door')).toEqual([...existing, 'generativelanguage.googleapis.com']);
      grantVoiceNetwork(store, agent(), 'OpenAI');
      expect(door.allowedHosts('fixture-door')).toEqual([...existing, 'api.openai.com', 'chatgpt.com']);
      expect(door.allowedHosts('unknown-door')).toBeUndefined();
      db.exec("UPDATE hosts SET settings = '{\"changed\":true}' WHERE id = 'h1'");
      expect(door.allowedHosts('fixture-door')).toEqual(existing);
    } finally { await app.close(); }
  });
});
