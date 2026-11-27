import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { createAgentSecrets, type AgentSecrets } from '../src/orchestrator/agentSecrets/agentSecrets.js';
import { MACHINE_OWNER_ONLY, TOKEN_CHECK_THROTTLED } from '../src/api/routeContext.js';
import type { Agent } from '../src/domain/types.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * The agent secrets service (HB-0808 step 15, part C), driven as
 * src/api/agents/agentSecretRoutes.ts drives it, with no HTTP server: a real store
 * on an in-memory database, a secret store in memory, a Telegram channel
 * that records what it is handed, and Telegram's getMe stubbed. Every token
 * and value here is made at run time and made up.
 */
const OWNER = 'user-owner';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  onPut?: () => void;
  async put(ref: string, v: string) { this.map.set(ref, v); this.onPut?.(); }
  async get(ref: string) {
    const v = this.map.get(ref);
    if (v === undefined) throw new Error(`no secret ${ref}`);
    return v;
  }
  async delete(ref: string) { this.map.delete(ref); }
}

/** A token of the shape Telegram's are, never a real one. */
const fakeToken = (n: number) => [String(4000 + n), 'Z'.repeat(20) + String.fromCharCode(97 + n).repeat(15)].join(':');
/** A value of an env variable, made at run time. */
const fakeValue = (n: number) => ['value', 'for', 'test', String(n)].join('-');

interface World {
  store: Store; s: AgentSecrets; secrets: MemSecrets;
  /** What the channel and the queue were handed, in order. */
  asked: string[];
  /** The usernames the pool owns. */
  pool: Set<string>;
  /** The bots held for setup, by agent. */
  held: Map<string, { token: string; username: string }>;
  caller: { owns: boolean; throttled: boolean; failures: number };
  agent(id: string, o?: { waiting?: boolean }): Agent;
  /** Telegram's getMe answers with this username (or refuses when undefined). */
  telegram(username: string | undefined): void;
}

function world(opts: { telegramFetch?: typeof fetch } = {}): World {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const secrets = new MemSecrets();
  const w = { store, secrets, asked: [], pool: new Set(), held: new Map(), caller: { owns: true, throttled: false, failures: 0 } } as unknown as World;
  w.s = createAgentSecrets({
    store, secrets, trace: (id) => (event, detail) => { w.asked.push(`${event} ${id}`); if (id) store.recordEvent(id, event, detail); },
    agentGone: (id) => { const st = store.getAgent(id)?.state; return !st || st === 'DELETED' || st === 'DELETING'; },
    channel: {
      heldBot: async (agentId, token) => (w.held.get(agentId)?.token === token ? w.held.get(agentId)!.username : undefined),
      discardPending: async (agentId) => { w.asked.push(`discard ${agentId}`); w.held.delete(agentId); },
      submitToken: async (agentId, token, checked) => { w.asked.push(`submit ${agentId} @${checked}`); w.held.set(agentId, { token, username: checked! }); return { username: checked! }; },
      pool: { owns: (u: string) => w.pool.has(u) } as never,
    },
    provisionWhenFree: (id) => { w.asked.push(`provision ${id}`); },
    ...(opts.telegramFetch ? { telegramFetch: opts.telegramFetch } : {}),
  });
  w.agent = (id, o = {}) => {
    store.insertAgent({
      id, ownerId: OWNER, name: `Agent ${id}`, slug: id, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    } as unknown as Agent);
    if (o.waiting) store.setAgentPendingAction(id, { type: 'bot_token', instructions: 'Paste a token.' });
    return store.getAgent(id)!;
  };
  w.telegram = (username) => {
    vi.stubGlobal('fetch', async () => (username
      ? new Response(JSON.stringify({ ok: true, result: { username } }), { headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })));
  };
  return w;
}

const callerOf = (w: World) => ({
  ownsLocalHost: () => w.caller.owns,
  throttled: () => w.caller.throttled,
  noteFailure: () => { w.caller.failures++; },
});

describe('an agent\'s environment values', () => {
  it('keeps the value in the secret store and only its name in the store', async () => {
    const w = world();
    const a = w.agent('a');
    expect(await w.s.env.add(a, 'WEATHER_KEY', fakeValue(1))).toEqual({ ok: true, body: undefined });
    const [row] = w.store.listAgentEnv('a');
    expect(row).toMatchObject({ name: 'WEATHER_KEY', secretRef: expect.stringMatching(/^agent-env\//) });
    expect(w.secrets.map.get(row!.secretRef)).toBe(fakeValue(1));
    expect(JSON.stringify(w.store.listAgentEnv('a'))).not.toContain(fakeValue(1));
  });

  it('refuses a bad name, a reserved one, one already set and one past the limit, in their words', async () => {
    const w = world();
    const a = w.agent('a');
    expect(await w.s.env.add(a, '9LIVES', fakeValue(1))).toEqual({ ok: false, status: 400, error: 'Not a valid variable name — use letters, digits and underscores, not starting with a digit.' });
    expect(await w.s.env.add(a, 'PATH', fakeValue(1))).toMatchObject({ ok: false, status: 400 });
    await w.s.env.add(a, 'WEATHER_KEY', fakeValue(1));
    expect(await w.s.env.add(a, 'WEATHER_KEY', fakeValue(2))).toEqual({ ok: false, status: 409, error: '"WEATHER_KEY" is already set — remove it first to change its value.' });
    for (let i = 0; i < 40; i++) {
      const r = await w.s.env.add(a, `EXTRA_${i}`, fakeValue(i));
      if (!r.ok) { expect(r).toMatchObject({ status: 409, error: expect.stringMatching(/^An agent can have at most \d+ variables/) }); break; }
    }
    expect(w.secrets.map.size).toBe(w.store.listAgentEnv('a').length);
  });

  it('takes its secret back when the agent is deleted while it is written', async () => {
    const w = world();
    const a = w.agent('a');
    w.secrets.onPut = () => w.store.setAgentState('a', 'DELETING');
    expect(await w.s.env.add(a, 'WEATHER_KEY', fakeValue(1))).toEqual({ ok: false, status: 409, error: 'It was deleted.' });
    expect(w.secrets.map.size).toBe(0);
    expect(w.store.listAgentEnv('a')).toEqual([]);
  });

  it('checks again after the secret store\'s wait: two at once do not both get the last place', async () => {
    const w = world();
    const a = w.agent('a');
    // The second addition of the same name lands while the first waits on the store.
    let second: Promise<unknown> | undefined;
    w.secrets.onPut = () => { w.secrets.onPut = undefined; second = w.s.env.add(a, 'WEATHER_KEY', fakeValue(2)); };
    const first = w.s.env.add(a, 'WEATHER_KEY', fakeValue(1));
    const answers = [await first, await second];
    expect(answers.filter((r) => (r as { ok: boolean }).ok)).toHaveLength(1);
    expect(w.store.listAgentEnv('a')).toHaveLength(1);
    expect(w.secrets.map.size).toBe(1);
  });

  it('removes one with its secret, and says when there is none', async () => {
    const w = world();
    const a = w.agent('a');
    await w.s.env.add(a, 'WEATHER_KEY', fakeValue(1));
    const [row] = w.store.listAgentEnv('a');
    expect(await w.s.env.remove(a, 'nope')).toEqual({ ok: false, status: 404, error: 'No such variable.' });
    expect(await w.s.env.remove(a, row!.id)).toEqual({ ok: true, body: undefined });
    expect(w.store.listAgentEnv('a')).toEqual([]);
    expect(w.secrets.map.size).toBe(0);
  });
});

describe('the bot token a parked setup waits for', () => {
  it('uses the words routeContext.ts has', () => {
    // The service says them itself (it imports nothing from src/api/); a test keeps them the same.
    expect(MACHINE_OWNER_ONLY).toMatch(/^Only the account that set up this machine/);
    expect(TOKEN_CHECK_THROTTLED).toBe('Too many token checks — wait a few minutes and try again.');
  });

  it('takes a pasted token: checked with Telegram, claimed, held for setup, and setup goes on', async () => {
    const w = world();
    const a = w.agent('a', { waiting: true });
    w.telegram('kitchen_helper_bot');
    const token = fakeToken(1);
    expect(await w.s.botToken.answer(a, { token: `  ${token} ` }, callerOf(w))).toEqual({ ok: true, body: { username: 'kitchen_helper_bot', stepAnswered: true } });
    expect(w.asked).toEqual(['submit a @kitchen_helper_bot', 'provision a']);
    expect(w.store.getAgent('a')!.pendingAction).toMatchObject({ type: 'bot_token', received: true });
    expect(w.held.get('a')!.token).toBe(token);
    // The same post again (a proxy's retry): answered as the first was, nothing run twice.
    expect(await w.s.botToken.answer(a, { token }, callerOf(w))).toEqual({ ok: true, body: { username: 'kitchen_helper_bot', stepAnswered: true } });
    expect(w.asked).toHaveLength(2);
    // Another token now: the step is answered already.
    expect(await w.s.botToken.answer(a, { token: fakeToken(2) }, callerOf(w))).toEqual({ ok: false, status: 409, error: 'A bot token came in already, and setup is taking it.' });
  });

  it('checks the token with the Telegram it is handed, not the global fetch (HB-1447)', async () => {
    const getMes: string[] = [];
    const w = world({ telegramFetch: (async (u: string | URL | Request) => { getMes.push(String(u)); return new Response(JSON.stringify({ ok: true, result: { username: 'kitchen_helper_bot' } }), { headers: { 'content-type': 'application/json' } }); }) as typeof fetch });
    const global = vi.fn();
    vi.stubGlobal('fetch', global);
    const a = w.agent('a', { waiting: true });
    expect(await w.s.botToken.answer(a, { token: fakeToken(1) }, callerOf(w))).toEqual({ ok: true, body: { username: 'kitchen_helper_bot', stepAnswered: true } });
    expect(getMes).toEqual([expect.stringMatching(/^https:\/\/api\.telegram\.org\/bot.+\/getMe$/)]);
    expect(global).not.toHaveBeenCalled();
  });

  it('counts a wrong token against the caller, and refuses a throttled caller before asking Telegram', async () => {
    const w = world();
    const a = w.agent('a', { waiting: true });
    w.telegram(undefined);
    const r = await w.s.botToken.answer(a, { token: fakeToken(1) }, callerOf(w));
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(w.caller.failures).toBe(1);
    w.caller.throttled = true;
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    expect(await w.s.botToken.answer(a, { token: fakeToken(1) }, callerOf(w))).toEqual({ ok: false, status: 429, error: TOKEN_CHECK_THROTTLED });
    expect(fetched).not.toHaveBeenCalled();
    expect(w.store.getAgent('a')!.pendingAction?.received).toBeUndefined();
  });

  it('refuses a spare pool bot and a bot another agent has, leaving the step open', async () => {
    const w = world();
    const a = w.agent('a', { waiting: true });
    w.agent('b');
    w.pool.add('spare_bot');
    w.telegram('spare_bot');
    expect(await w.s.botToken.answer(a, { token: fakeToken(1) }, callerOf(w))).toEqual({ ok: false, status: 400, error: '@spare_bot is a spare bot in the pool. Use "a ready bot from the pool" instead, or remove it from the pool first.' });
    w.store.insertChannel({ id: 'c1', agentId: 'b', kind: 'telegram', accountId: 'taken_bot', secretRef: 'tg/b', deepLink: 'https://t.me/taken_bot', createdAt: 'now' });
    w.telegram('taken_bot');
    expect(await w.s.botToken.answer(a, { token: fakeToken(2) }, callerOf(w))).toEqual({ ok: false, status: 400, error: 'That bot is already connected to "Agent b". Each agent needs its own bot — create another with @BotFather.' });
    expect(w.store.getAgent('a')!.pendingAction?.received).toBeUndefined();
    expect(w.asked).toEqual([]);
  });

  it('goes on web only when asked, and answers that again only where it was so answered', async () => {
    const w = world();
    const a = w.agent('a', { waiting: true });
    expect(await w.s.botToken.answer(a, { webOnly: true }, callerOf(w))).toEqual({ ok: true, body: { webOnly: true } });
    expect(w.store.getAgent('a')!.webOnly).toBe(true);
    expect(w.asked).toEqual(['discard a', 'telegram.skipped a', 'provision a']);
    // Not open any more; its timeline says the owner skipped Telegram, so the same post is answered the same.
    expect(await w.s.botToken.answer(a, { webOnly: true }, callerOf(w))).toEqual({ ok: true, body: { webOnly: true } });
    expect(w.asked).toHaveLength(3);
    // A token now is not wanted: the step was answered.
    expect(await w.s.botToken.answer(a, { token: fakeToken(1) }, callerOf(w))).toMatchObject({ ok: false, status: 409 });
  });

  it('reuses a hand-built workspace\'s bot only for the machine\'s owner', async () => {
    const w = world();
    const a = w.agent('a', { waiting: true });
    w.caller.owns = false;
    expect(await w.s.botToken.answer(a, { fromWorkspace: '/nowhere/at/all' }, callerOf(w))).toEqual({ ok: false, status: 403, error: MACHINE_OWNER_ONLY });
    w.caller.owns = true;
    expect(await w.s.botToken.answer(a, { fromWorkspace: '/nowhere/at/all' }, callerOf(w))).toEqual({ ok: false, status: 400, error: 'No existing Telegram bot is bound to /nowhere/at/all.' });
  });

  it('a workspace\'s bot that is also a spare in the pool is refused, as a pasted one is (HB-1091)', async () => {
    const w = world();
    const a = w.agent('a', { waiting: true });
    // A hand-built instance with the bot switched off there, in a config of its own.
    const dir = mkdtempSync(join(tmpdir(), 'hb-workspace-'));
    try {
      const config = join(dir, 'openclaw.json');
      writeFileSync(config, JSON.stringify({
        agents: { list: [{ id: 'helper', workspace: join(dir, 'workspace') }] },
        bindings: [{ agentId: 'helper', match: { channel: 'telegram', accountId: 'spare_bot' } }],
        channels: { telegram: { accounts: { spare_bot: { botToken: fakeToken(3), enabled: false } } } },
      }));
      vi.stubEnv('OPENCLAW_CONFIG', config);
      w.telegram('spare_bot');
      w.pool.add('spare_bot');
      expect(await w.s.botToken.answer(a, { fromWorkspace: join(dir, 'workspace') }, callerOf(w))).toEqual({
        ok: false, status: 400, error: '@spare_bot is a spare bot in the pool. Use "a ready bot from the pool" instead, or remove it from the pool first.',
      });
      expect(w.asked).toEqual([]);
      expect(w.store.getAgent('a')!.pendingAction?.received).toBeUndefined();
      // Not in the pool: the workspace's bot is taken, as before.
      w.pool.delete('spare_bot');
      expect(await w.s.botToken.answer(a, { fromWorkspace: join(dir, 'workspace') }, callerOf(w))).toEqual({ ok: true, body: { username: 'spare_bot', stepAnswered: true } });
      expect(w.asked).toEqual(['submit a @spare_bot', 'provision a']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a workspace\'s bot whose account is still on, with Telegram off for the whole instance, is refused in words that say so (HB-1031)', async () => {
    const w = world();
    const a = w.agent('a', { waiting: true });
    const dir = mkdtempSync(join(tmpdir(), 'hb-workspace-'));
    try {
      const config = join(dir, 'openclaw.json');
      const write = (account: Record<string, unknown>) => writeFileSync(config, JSON.stringify({
        agents: { list: [{ id: 'helper', workspace: join(dir, 'workspace') }] },
        bindings: [{ agentId: 'helper', match: { channel: 'telegram', accountId: 'porch_bot' } }],
        channels: { telegram: { enabled: false, accounts: { porch_bot: { botToken: fakeToken(4), ...account } } } },
      }));
      write({});
      vi.stubEnv('OPENCLAW_CONFIG', config);
      w.telegram('porch_bot');
      expect(await w.s.botToken.answer(a, { fromWorkspace: join(dir, 'workspace') }, callerOf(w))).toEqual({
        ok: false, status: 409,
        error: 'Telegram is switched off in your hand-built instance\'s config, but its account "porch_bot" for "helper" is still on: '
          + 'switched back on there, Telegram would poll this bot in both copies. '
          + 'Switch that account off too (in its openclaw.json, under channels.telegram.accounts, set "enabled": false on the account "porch_bot"), then try again.',
      });
      expect(w.asked).toEqual([]);
      // Its account off as well: taken over, as before.
      write({ enabled: false });
      expect(await w.s.botToken.answer(a, { fromWorkspace: join(dir, 'workspace') }, callerOf(w))).toEqual({ ok: true, body: { username: 'porch_bot', stepAnswered: true } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a takeover refusal names the account by its key in the config, not as an @handle, and its place for any key (HB-1300)', async () => {
    const w = world();
    const a = w.agent('a', { waiting: true });
    const dir = mkdtempSync(join(tmpdir(), 'hb-workspace-'));
    try {
      const config = join(dir, 'openclaw.json');
      // A key with a dot: "channels.telegram.accounts.made.up" read as a deeper path.
      const write = (telegram: Record<string, unknown>) => writeFileSync(config, JSON.stringify({
        agents: { list: [{ id: 'helper', workspace: join(dir, 'workspace') }] },
        bindings: [{ agentId: 'helper', match: { channel: 'telegram', accountId: 'made.up' } }],
        channels: { telegram: { ...telegram, accounts: { 'made.up': { botToken: fakeToken(5) } } } },
      }));
      vi.stubEnv('OPENCLAW_CONFIG', config);
      write({});
      expect(await w.s.botToken.answer(a, { fromWorkspace: join(dir, 'workspace') }, callerOf(w))).toEqual({
        ok: false, status: 409,
        error: 'Its bot (Telegram account "made.up") is still enabled for "helper" in your hand-built instance. '
          + 'Turn it off there first, or both copies will fight over every message.',
      });
      write({ enabled: false });
      const off = await w.s.botToken.answer(a, { fromWorkspace: join(dir, 'workspace') }, callerOf(w)) as { error: string };
      expect(off.error).toContain('under channels.telegram.accounts, set "enabled": false on the account "made.up"');
      expect(off.error).not.toMatch(/@made\.up|accounts\.made\.up/);
      expect(w.asked).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('says what is wrong with an agent not waiting, one being deleted, and a post with nothing in it', async () => {
    const w = world();
    const idle = w.agent('i');
    expect(await w.s.botToken.answer(idle, { token: fakeToken(1) }, callerOf(w))).toEqual({ ok: false, status: 409, error: 'This agent is not waiting for a bot token.' });
    const a = w.agent('a', { waiting: true });
    expect(await w.s.botToken.answer(a, {}, callerOf(w))).toEqual({ ok: false, status: 400, error: 'token required' });
    w.store.setAgentState('a', 'DELETING');
    expect(await w.s.botToken.answer(w.store.getAgent('a')!, { token: fakeToken(1) }, callerOf(w))).toEqual({ ok: false, status: 409, error: 'It is being deleted.' });
  });
});
