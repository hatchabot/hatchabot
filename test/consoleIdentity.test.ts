import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CONSOLE_USER_HEADER, GUEST_ROLE, OWNER_ROLE, consoleGatewayAuth, consoleGatewayRoles, consoleIdentity,
  guestConsoleSessionKey, isConsoleIdentity, supportsConsoleIdentity, NO_PROXY_YET,
} from '../src/openclaw/consoleIdentity.js';
import { batchConfigCommands, buildConfigCommands } from '../src/openclaw/configWriter.js';

/** A gateway secret made at run time: tests never carry a real-looking token. */
const secret = () => randomBytes(16).toString('hex');

describe('the names Hatchabot vouches for at a gateway', () => {
  it('are stable per person and agent, different per role, per person and per agent secret', () => {
    const s = secret();
    const a = consoleIdentity(s, 'guest', 'user-anna');
    expect(consoleIdentity(s, 'guest', 'user-anna')).toBe(a);
    expect(consoleIdentity(s, 'owner', 'user-anna')).not.toBe(a);
    expect(consoleIdentity(s, 'guest', 'user-bob')).not.toBe(a);
    expect(consoleIdentity(secret(), 'guest', 'user-anna')).not.toBe(a);
  });

  it('say nothing about the person: an HMAC under the reserved .invalid domain', () => {
    const s = secret();
    const id = consoleIdentity(s, 'guest', 'user-anna@example.com');
    expect(id).toMatch(/^guest-[0-9a-f]{24}@hatchabot\.invalid$/);
    expect(id).not.toContain('anna');
    expect(isConsoleIdentity(id)).toBe(true);
    expect(isConsoleIdentity(id, 'guest')).toBe(true);
    expect(isConsoleIdentity(id, 'owner')).toBe(false);
    expect(isConsoleIdentity(['guest-a1', 'hb.invalid'].join('@'))).toBe(false);
  });

  it("a guest's own conversation key is agent-scoped and unguessable without the secret", () => {
    const s = secret();
    const k = guestConsoleSessionKey(s, 'recipe-box', 'user-anna');
    expect(k).toMatch(/^agent:recipe-box:guest:[0-9a-f]{16}$/);
    expect(guestConsoleSessionKey(s, 'recipe-box', 'user-bob')).not.toBe(k);
    expect(guestConsoleSessionKey(secret(), 'recipe-box', 'user-anna')).not.toBe(k);
  });

  it('only OpenClaw 2026.9 and later get it (named roles and identity profiles)', () => {
    expect(supportsConsoleIdentity('2026.9.6')).toBe(true);
    expect(supportsConsoleIdentity('2026.10.1')).toBe(true);
    expect(supportsConsoleIdentity('2027.1.0')).toBe(true);
    expect(supportsConsoleIdentity('2026.7.1-2')).toBe(false);
    expect(supportsConsoleIdentity('2026.8.3')).toBe(false);
    expect(supportsConsoleIdentity(undefined)).toBe(false);
  });
});

describe('the gateway settings of a console with identities', () => {
  const s = secret();
  const owner = consoleIdentity(s, 'owner', 'user-owner');
  const guests = ['user-anna', 'user-bob'].map((u) => consoleIdentity(s, 'guest', u));

  it('trusted-proxy auth with the secret as the loopback password — and no token', () => {
    const auth = consoleGatewayAuth({ password: s, trustedProxies: ['172.18.0.1'], allowUsers: guests, ownerIdentity: owner, slug: 'a' }) as any;
    expect(auth.mode).toBe('trusted-proxy');
    expect(auth.password).toBe(s);
    expect('token' in auth).toBe(false);
    expect(auth.trustedProxy.userHeader).toBe(CONSOLE_USER_HEADER);
  });

  it('admits exactly the owner and the guests — never an empty list (which would admit anyone)', () => {
    const auth = consoleGatewayAuth({ password: s, trustedProxies: [], allowUsers: guests, ownerIdentity: owner, slug: 'a' }) as any;
    expect(auth.trustedProxy.allowUsers).toEqual([owner, ...guests]);
    const alone = consoleGatewayAuth({ password: s, trustedProxies: [], allowUsers: [], ownerIdentity: owner, slug: 'a' }) as any;
    expect(alone.trustedProxy.allowUsers).toEqual([owner]);
  });

  it('only the owner is granted operator.admin; auto-approved browsers get read and write at most', () => {
    const auth = consoleGatewayAuth({ password: s, trustedProxies: [], allowUsers: guests, ownerIdentity: owner, slug: 'a' }) as any;
    expect(auth.identityScopes).toEqual({ [owner]: ['operator.admin'] });
    expect(auth.trustedProxy.deviceAutoApprove.enabled).toBe(true);
    expect(auth.trustedProxy.deviceAutoApprove.scopes).toEqual(['operator.read', 'operator.write']);
  });

  it('roles: everyone is a guest by default (own sessions only, no admin, this agent only)', () => {
    const roles = consoleGatewayRoles('recipe-box') as any;
    expect(roles.default).toBe(GUEST_ROLE);
    expect(roles.definitions[GUEST_ROLE]).toEqual({ sessions: { others: 'none' }, agents: ['recipe-box'], scopes: ['operator.read', 'operator.write'] });
    expect(roles.definitions[OWNER_ROLE].scopes).toEqual(['operator.admin']);
    expect(roles.definitions[OWNER_ROLE].sessions.others).toBe('write');
  });
});

describe('the seed writes it (configWriter)', () => {
  const s = secret();
  const base = { agentId: 'recipe-box', model: 'm', authMode: 'api-key' as const, openclawVersion: '2026.9.6', gatewayToken: s };
  const spec = { trustedProxies: ['172.18.0.1'], ownerIdentity: consoleIdentity(s, 'owner', 'o'), guestIdentities: [consoleIdentity(s, 'guest', 'g')] };

  it('three sets in the one batched CLI start, the auth marked sensitive, no token set', () => {
    const cmds = batchConfigCommands(buildConfigCommands({ ...base, console: spec }));
    const batch = cmds.find((c) => c.argv[2] === '--batch-json' && c.argv[3]!.includes('gateway.auth'))!;
    expect(batch).toBeTruthy();
    expect(batch.sensitive).toBe(true);
    const ops = JSON.parse(batch.argv[3]!) as Array<{ path: string; value: any }>;
    const at = (p: string) => ops.find((o) => o.path === p)?.value;
    expect(at('gateway.trustedProxies')).toEqual(['172.18.0.1']);
    expect(at('gateway.roles').default).toBe(GUEST_ROLE);
    expect(at('gateway.auth').mode).toBe('trusted-proxy');
    expect(at('gateway.auth').trustedProxy.allowUsers).toEqual([spec.ownerIdentity, ...spec.guestIdentities]);
    expect(ops.some((o) => o.path === 'gateway.auth.token' || o.path === 'gateway.auth.mode')).toBe(false);
    // The whole gateway.auth object is replaced (the token goes with it).
    expect(batch.argv).toContain('--replace');
    // Nothing un-batched for it: no extra CLI start on a rebuild.
    expect(cmds.filter((c) => c.argv.join(' ').includes('gateway.roles') && c.argv[2] !== '--batch-json')).toEqual([]);
  });

  it('with no proxy address known yet, a placeholder no peer can have (the CLI refuses an empty list)', () => {
    const cmds = batchConfigCommands(buildConfigCommands({ ...base, console: { ...spec, trustedProxies: [] } }));
    const ops = JSON.parse(cmds.find((c) => c.argv[2] === '--batch-json' && c.argv[3]!.includes('gateway.auth'))!.argv[3]!) as Array<{ path: string; value: any }>;
    expect(ops.find((o) => o.path === 'gateway.trustedProxies')?.value).toEqual([NO_PROXY_YET]);
  });

  it('a token console (no console spec) clears any roles and trusted proxy first, only when present, outside the batch', () => {
    const raw = buildConfigCommands(base);
    const clear = raw.find((c) => c.argv.join(' ') === 'config patch --stdin')!;
    expect(clear).toBeTruthy();
    expect(JSON.parse(clear.stdin!)).toEqual({ gateway: { roles: null, trustedProxies: null } });
    expect(clear.skipIf).toBe('!(c.gateway && (c.gateway.roles || c.gateway.trustedProxies))');
    expect(clear.optional).toBe(true);
    // Before the run of sets, so the batch stays one CLI start.
    const cmds = batchConfigCommands(raw);
    const i = cmds.indexOf(clear);
    const batches = cmds.map((c, n) => (c.argv[2] === '--batch-json' ? n : -1)).filter((n) => n >= 0);
    expect(batches.length).toBe(1);
    expect(i).toBeLessThan(batches[0]!);
    // And the token is still how it authenticates.
    const ops = JSON.parse(cmds[batches[0]!]!.argv[3]!) as Array<{ path: string; value: any }>;
    expect(ops.find((o) => o.path === 'gateway.auth.mode')?.value).toBe('token');
    expect(ops.find((o) => o.path === 'gateway.auth.token')?.value).toBe(s);
  });

  it('an agent with no console at all (no token) is untouched by either', () => {
    const { gatewayToken: _drop, ...noToken } = base;
    const raw = buildConfigCommands(noToken);
    expect(raw.some((c) => c.argv.join(' ') === 'config patch --stdin')).toBe(false);
    expect(raw.some((c) => c.argv.includes('gateway.roles'))).toBe(false);
  });
});

describe('which builds get it (buildRuntimeSpec)', () => {
  const setup = async (version: string, opts: { ops?: boolean } = {}) => {
    const { default: Database } = await import('better-sqlite3');
    const { Store } = await import('../src/store/store.js');
    const { MockProvider } = await import('../src/providers/mockProvider.js');
    const { provisionAgent, buildRuntimeSpec } = await import('../src/orchestrator/provision.js');
    const db = new Database(':memory:');
    const store = new Store(db);
    const map = new Map<string, string>();
    const secrets = { put: async (r: string, v: string) => { map.set(r, v); }, get: async (r: string) => map.get(r) ?? '', delete: async (r: string) => { map.delete(r); } };
    const provider = new MockProvider();
    provider.imageOpenclawVersion = version;
    (provider as any).agentProxySource = async () => '172.18.0.1';
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    await secrets.put('ai/p1', 'sk-test');
    await secrets.put('chan/stub', 'bot');
    const channel = { kind: 'telegram', async provision() { return { accountId: 'stubbot', secretRef: 'chan/stub', deepLink: 'x' }; }, async release() {} } as any;
    const deps = { store, secrets, provider, channel, sleep: async () => {} } as any;
    const { agent } = await provisionAgent(deps, { ownerId: 'o', name: 'Kitchen', aiProfileId: 'p1', hostId: 'h1' });
    if (opts.ops) db.prepare('UPDATE agents SET ops = 1 WHERE id = ?').run(agent.id);
    store.insertMembership({ id: 'm1', agentId: agent.id, userId: 'user-anna', role: 'user' as any, status: 'active', joinedAt: 'now', webChat: true });
    store.insertMembership({ id: 'm2', agentId: agent.id, userId: 'user-bob', role: 'user' as any, status: 'active', joinedAt: 'now', webChat: false });
    store.insertMembership({ id: 'm3', agentId: agent.id, userId: 'user-gone', role: 'user' as any, status: 'revoked', joinedAt: 'now', webChat: true });
    return { spec: () => buildRuntimeSpec(deps, agent.id), agent };
  };

  it('an OpenClaw 2026.9 agent: the owner and each web-chat guest (not other members, not the removed)', async () => {
    const { spec, agent } = await setup('2026.9.6');
    const s = await spec();
    const token = s.workspace.configPatch.gatewayToken!;
    expect(s.workspace.configPatch.console).toEqual({
      trustedProxies: ['172.18.0.1'],
      ownerIdentity: consoleIdentity(token, 'owner', agent.ownerId),
      guestIdentities: [consoleIdentity(token, 'guest', 'user-anna')],
    });
  });

  it('not on an older OpenClaw, not with the switch off', async () => {
    expect((await (await setup('2026.7.1-2')).spec()).workspace.configPatch.console).toBeUndefined();
    const prev = process.env.HATCHABOT_CONSOLE_IDENTITY;
    process.env.HATCHABOT_CONSOLE_IDENTITY = 'off';
    try { expect((await (await setup('2026.9.6')).spec()).workspace.configPatch.console).toBeUndefined(); }
    finally { if (prev === undefined) delete process.env.HATCHABOT_CONSOLE_IDENTITY; else process.env.HATCHABOT_CONSOLE_IDENTITY = prev; }
  });
});
