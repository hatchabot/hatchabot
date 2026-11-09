import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { installErrorHandler } from '../src/api/errorHandler.js';
import { ChannelSetupRequired } from '../src/channels/channel.js';
import { reconcileAgents } from '../src/orchestrator/reconcile.js';
import { TelegramManualProvisioner } from '../src/channels/telegramManual.js';
import { clearBusy, isBusy, markBusy } from '../src/orchestrator/busy.js';
import { beginOperation, newBootForTests } from '../src/orchestrator/operations.js';
import { resumeOperations } from '../src/orchestrator/operationsResume.js';
import { HANDOVER_SAYS } from '../src/cli.js';

/**
 * Fifth review of fix/r3-cli: the channel-token route answered 202 while the
 * agent still said "waiting for a bot token", and a slow setup read as a
 * turned-down token. Eighth review: clearing the step in the route left an
 * agent with no step and no setup when a setup was still running (the kick
 * was dropped) or the server restarted before setup ran (the token was only
 * in memory); reconcile then failed it. Now the token is held on disk, the
 * step is marked answered (and shown as setting up), and setup clears it
 * when it takes the token.
 */
const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };
const TOKEN = '123456:made-up-token-for-the-test';

afterEach(() => { vi.restoreAllMocks(); });

function memorySecrets() {
  const m = new Map<string, string>([['ai/p1', 'made-up-ai-value']]);
  return {
    map: m,
    put: async (ref: string, v: string) => { m.set(ref, v); },
    get: async (ref: string) => { const v = m.get(ref); if (v === undefined) throw new Error(`no secret ${ref}`); return v; },
    delete: async (ref: string) => { m.delete(ref); },
  };
}

function parkedStore(id = 'park') {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  store.insertAgent({ id, ownerId: OWNER, name: 'Lunch Picker', slug: 'lunch-picker', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: false, createdAt: 'now', updatedAt: 'now' } as never);
  store.setAgentPendingAction(id, { type: 'bot_token', instructions: 'paste it' } as never);
  return store;
}

/** A channel over a real manual provisioner; `provision` as the test likes. */
function channelOver(manual: TelegramManualProvisioner, provision: (req: { agentId: string }) => Promise<unknown>) {
  return {
    kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 },
    submitToken: (id: string, token: string, checked?: string) => manual.submitToken(id, token, checked),
    discardPending: (id: string) => manual.discardPending(id),
    waitingFor: (id: string) => manual.waitingFor(id),
    loadHeld: (ids: string[]) => manual.loadHeld(ids),
    heldBot: (id: string, token: string) => manual.heldBot(id, token),
    release: async () => {},
    provision,
  };
}

async function box() {
  const store = parkedStore();
  // Setup's bot step takes as long as the test likes.
  let finish!: (outcome: 'refuse') => void;
  const slow = new Promise<'refuse'>((r) => { finish = r; });
  const f = Fastify();
  installErrorHandler(f);
  const providers = new Map([['mock', new MockProvider()]]);
  await registerRoutes(f, {
    store, secrets: memorySecrets(), providers,
    channel: {
      kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 },
      submitToken: async () => ({ username: 'made_up_bot' }), discardPending: () => {}, release: async () => {},
      provision: async () => { await slow; throw new ChannelSetupRequired('paste another', 'made-up-resume'); },
    },
  } as never);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { username: 'made_up_bot' } })));
  return { store, f, providers, finish };
}

describe('a bot token taken: setup owns the step', () => {
  it('a slow setup shows no "waiting for a bot token", and the sweep leaves it alone', async () => {
    const b = await box();
    const r = await b.f.inject({ method: 'POST', url: '/v1/agents/park/channel-token', headers: H, payload: { token: TOKEN } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ username: 'made_up_bot', stepAnswered: true });
    // On the record the step stays, answered, until setup takes the token…
    expect(b.store.getAgent('park')!.pendingAction).toMatchObject({ type: 'bot_token', received: true });
    // …and the app and the CLI see an agent setting up, not one asking.
    const seen = (await b.f.inject({ method: 'GET', url: '/v1/agents/park', headers: H })).json();
    expect(seen.state).toBe('PROVISIONING');
    expect(seen.pendingAction).toBeUndefined();
    // However long setup takes, the health sweep does not call it interrupted.
    await reconcileAgents(b.store, b.providers, () => {});
    expect(b.store.getAgent('park')!.state).toBe('PROVISIONING');
    // A second token while setup runs is not taken.
    expect((await b.f.inject({ method: 'POST', url: '/v1/agents/park/channel-token', headers: H, payload: { token: TOKEN } })).statusCode).toBe(409);
    // Turned down: asked again, plainly.
    b.finish('refuse');
    await vi.waitFor(() => expect(b.store.getAgent('park')!.pendingAction).toEqual({ type: 'bot_token', instructions: 'paste another' }));
    expect(b.store.getAgent('park')!.state).toBe('PROVISIONING');
  });

  it('a token pasted while an earlier setup still runs is taken by the setup after it', async () => {
    const store = parkedStore('nudged');
    const secrets = memorySecrets();
    const manual = new TelegramManualProvisioner(secrets as never);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let calls = 0;
    const f = Fastify();
    installErrorHandler(f);
    const providers = new Map([['mock', new MockProvider()]]);
    await registerRoutes(f, {
      store, secrets, providers,
      channel: channelOver(manual, async (req) => {
        calls++;
        // The first setup looked before the paste, and found no token.
        if (calls === 1) { await gate; throw new ChannelSetupRequired('paste it', 'made-up-resume'); }
        return manual.provision(req as never);
      }),
    } as never);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { username: 'made_up_bot' } })));
    // A nudge starts a setup; it is still running when the token comes.
    expect((await f.inject({ method: 'POST', url: '/v1/agents/nudged/provision', headers: H })).statusCode).toBe(202);
    await vi.waitFor(() => expect(calls).toBe(1));
    expect((await f.inject({ method: 'POST', url: '/v1/agents/nudged/channel-token', headers: H, payload: { token: TOKEN } })).statusCode).toBe(202);
    open();
    await vi.waitFor(() => expect(store.getChannelForAgent('nudged')?.accountId).toBe('made_up_bot'));
    expect(calls).toBe(2);
    expect(store.getAgent('nudged')!.pendingAction).toBeUndefined();
    expect(store.getAgent('nudged')!.stateReason ?? '').not.toMatch(/interrupted/);
  });

  it('a restart between the paste and setup: setup runs after it with the token, never "Setup was interrupted"', async () => {
    const store = parkedStore('restarted');
    const secrets = memorySecrets();
    const providers = new Map([['mock', new MockProvider()]]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { username: 'made_up_bot' } })));
    // The first process: the token is pasted, and the process ends before setup takes it.
    const before = Fastify();
    installErrorHandler(before);
    await registerRoutes(before, { store, secrets, providers, channel: channelOver(new TelegramManualProvisioner(secrets as never), () => new Promise(() => {})) } as never);
    expect((await before.inject({ method: 'POST', url: '/v1/agents/restarted/channel-token', headers: H, payload: { token: TOKEN } })).statusCode).toBe(202);
    await vi.waitFor(() => expect(isBusy('restarted')).toBe(true));
    // The restart: a new process, with nothing in memory.
    newBootForTests();
    clearBusy('restarted');
    const manual = new TelegramManualProvisioner(secrets as never);
    const after = Fastify();
    installErrorHandler(after);
    const handle = await registerRoutes(after, { store, secrets, providers, channel: channelOver(manual, (req) => manual.provision(req as never)) } as never);
    await reconcileAgents(store, providers, () => {});
    expect(store.getAgent('restarted')!.state).toBe('PROVISIONING');
    await handle.resumeOperations();
    await vi.waitFor(() => expect(store.getChannelForAgent('restarted')?.accountId).toBe('made_up_bot'));
    expect(store.getAgent('restarted')!.stateReason ?? '').not.toMatch(/interrupted/);
    expect(store.getAgent('restarted')!.pendingAction).toBeUndefined();
    // The held copy goes once setup has the token.
    await vi.waitFor(() => expect(secrets.map.has(TelegramManualProvisioner.pendingRef('restarted'))).toBe(false));
  });
});

/** Telegram's getMe, made up: the bot's name follows the token. */
function fakeGetMe() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
    await new Promise((r) => setTimeout(r, 5));
    const name = String(u).includes('made-up-other') ? 'made_up_other_bot' : 'made_up_bot';
    return new Response(JSON.stringify({ ok: true, result: { username: name } }));
  });
}
const OTHER = '654321:made-up-other-token-for-the-test';

/** An app over a real manual provisioner; the first setup's bot step waits for `open`. */
async function gatedBox(id: string, opts: { hold?: boolean } = {}) {
  const store = parkedStore(id);
  const secrets = memorySecrets();
  const manual = new TelegramManualProvisioner(secrets as never);
  if (opts.hold) await manual.submitToken(id, TOKEN, 'made_up_bot'); // a token held from before
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let calls = 0;
  const f = Fastify();
  installErrorHandler(f);
  const providers = new Map([['mock', new MockProvider()]]);
  await registerRoutes(f, {
    store, secrets, providers,
    channel: channelOver(manual, async (req) => {
      calls++;
      // The first setup looked before the answer, and found no token.
      if (calls === 1) { await gate; throw new ChannelSetupRequired('paste it', 'made-up-resume'); }
      return manual.provision(req as never);
    }),
  } as never);
  fakeGetMe();
  return { store, secrets, manual, f, open, calls: () => calls };
}

describe('the held-token flow (ninth review)', () => {
  it('the same token posted again is answered 202 again, held or taken; another token gets 409', async () => {
    const store = parkedStore('again');
    const secrets = memorySecrets();
    const manual = new TelegramManualProvisioner(secrets as never);
    const f = Fastify();
    installErrorHandler(f);
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: channelOver(manual, () => new Promise(() => {})) } as never);
    fakeGetMe();
    const post = (token: string) => f.inject({ method: 'POST', url: '/v1/agents/again/channel-token', headers: H, payload: { token } });
    expect((await post(TOKEN)).statusCode).toBe(202);
    // The proxy lost the first answer; the same post again (held, not yet taken).
    const again = await post(TOKEN);
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ username: 'made_up_bot', stepAnswered: true });
    expect((await post(OTHER)).statusCode).toBe(409);
    // Taken by setup: the agent's bot is that token's.
    await manual.discardPending('again');
    store.insertChannel({ id: 'ch-again', agentId: 'again', kind: 'telegram', accountId: 'made_up_bot', secretRef: 'telegram/bot/made_up_bot', deepLink: 'https://t.me/made_up_bot', createdAt: 'now' } as never);
    await secrets.put('telegram/bot/made_up_bot', TOKEN);
    store.setAgentPendingAction('again', null);
    expect((await post(TOKEN)).json()).toEqual({ username: 'made_up_bot', stepAnswered: true });
    expect((await post(OTHER)).statusCode).toBe(409);
  });

  it('two posts at once: one token is held, and only its caller hears it attached', async () => {
    const store = parkedStore('twice');
    const secrets = memorySecrets();
    const manual = new TelegramManualProvisioner(secrets as never);
    const f = Fastify();
    installErrorHandler(f);
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: channelOver(manual, () => new Promise(() => {})) } as never);
    fakeGetMe();
    const [a, b] = await Promise.all([TOKEN, OTHER].map((token) => f.inject({ method: 'POST', url: '/v1/agents/twice/channel-token', headers: H, payload: { token } })));
    expect([a!.statusCode, b!.statusCode].sort()).toEqual([202, 409]);
    const won = a!.statusCode === 202 ? { token: TOKEN, r: a! } : { token: OTHER, r: b! };
    const lost = won.token === TOKEN ? OTHER : TOKEN;
    expect(await manual.heldBot('twice', won.token)).toBe(won.r.json().username);
    expect(await manual.heldBot('twice', lost)).toBeUndefined();
  });

  it('"go on without a bot" during a running setup ends web-only, and a held token goes', async () => {
    const b = await gatedBox('webonly', { hold: true });
    expect((await b.f.inject({ method: 'POST', url: '/v1/agents/webonly/provision', headers: H })).statusCode).toBe(202);
    await vi.waitFor(() => expect(b.calls()).toBe(1));
    expect((await b.f.inject({ method: 'POST', url: '/v1/agents/webonly/channel-token', headers: H, payload: { webOnly: true } })).statusCode).toBe(202);
    b.open();
    await vi.waitFor(() => expect(b.store.getAgent('webonly')!.pendingAction).toBeUndefined());
    expect(b.store.getAgent('webonly')!.webOnly).toBe(true);
    expect(b.store.getChannelForAgent('webonly')).toBeUndefined();
    expect(b.calls()).toBe(1);
    await vi.waitFor(() => expect(b.secrets.map.has(TelegramManualProvisioner.pendingRef('webonly'))).toBe(false));
  });

  // A delete is refused while setup holds the agent; this is the moment after
  // it lets go, with the queued setup not yet started.
  it('a delete while setup for a held token is queued removes the agent, starts no new setup, and drops the token', async () => {
    const store = parkedStore('gone');
    const secrets = memorySecrets();
    const manual = new TelegramManualProvisioner(secrets as never);
    let calls = 0;
    const f = Fastify();
    installErrorHandler(f);
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: channelOver(manual, (req) => { calls++; return manual.provision(req as never); }) } as never);
    fakeGetMe();
    markBusy('gone');
    try {
      expect((await f.inject({ method: 'POST', url: '/v1/agents/gone/channel-token', headers: H, payload: { token: TOKEN } })).statusCode).toBe(202);
      expect(secrets.map.has(TelegramManualProvisioner.pendingRef('gone'))).toBe(true);
    } finally { clearBusy('gone'); }
    const r = await f.inject({ method: 'DELETE', url: '/v1/agents/gone', headers: H });
    expect(r.statusCode, r.body).toBeLessThan(300);
    expect(store.getAgent('gone')?.state ?? 'DELETED').toBe('DELETED');
    await new Promise((r) => setTimeout(r, 2_500)); // past the queued setup's next look
    expect(calls).toBe(0);
    expect(store.getChannelForAgent('gone')).toBeUndefined();
    expect(secrets.map.has(TelegramManualProvisioner.pendingRef('gone'))).toBe(false);
    expect(await manual.waitingFor('gone')).toBe(false);
  });

  it('an agent busy with another change: setup waits for it, then takes the token, rather than failing', async () => {
    const store = parkedStore('held');
    const secrets = memorySecrets();
    const manual = new TelegramManualProvisioner(secrets as never);
    const f = Fastify();
    installErrorHandler(f);
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: channelOver(manual, (req) => manual.provision(req as never)) } as never);
    fakeGetMe();
    markBusy('held'); // another holder: an import, a move, a change
    try {
      expect((await f.inject({ method: 'POST', url: '/v1/agents/held/channel-token', headers: H, payload: { token: TOKEN } })).statusCode).toBe(202);
      await new Promise((r) => setTimeout(r, 300));
      expect(store.getAgent('held')!.state).toBe('PROVISIONING');
      expect(store.getAgent('held')!.pendingAction).toMatchObject({ received: true });
    } finally { clearBusy('held'); }
    await vi.waitFor(() => expect(store.getChannelForAgent('held')?.accountId).toBe('made_up_bot'), { timeout: 6_000 });
    expect(store.getAgent('held')!.stateReason ?? '').not.toMatch(/could not start/);
  });
});

describe('the held-token flow (tenth review)', () => {
  // A delete waits for a setup that is ending (its record settled, its hold
  // let go); another change takes the agent as that setup ends, so the delete
  // is refused. The token posted meanwhile was skipped while the delete ran.
  it('a token posted while a delete waits, and the delete is then refused: setup still takes it', async () => {
    const b = await gatedBox('kept');
    expect((await b.f.inject({ method: 'POST', url: '/v1/agents/kept/provision', headers: H })).statusCode).toBe(202);
    await vi.waitFor(() => expect(b.calls()).toBe(1));
    const op = b.store.listOperations(['kept'], 1)[0]!;
    b.store.updateOperation(op.id, { status: 'succeeded', finishedAt: new Date().toISOString() });
    clearBusy('kept');
    const real = b.store.updateOperation.bind(b.store);
    vi.spyOn(b.store, 'updateOperation').mockImplementation((id, patch) => {
      const r = real(id, patch);
      if (id === op.id) markBusy('kept'); // another change takes the agent as that setup ends
      return r;
    });
    try {
      const del = b.f.inject({ method: 'DELETE', url: '/v1/agents/kept', headers: H });
      await new Promise((r) => setTimeout(r, 30));
      expect((await b.f.inject({ method: 'POST', url: '/v1/agents/kept/channel-token', headers: H, payload: { token: TOKEN } })).statusCode).toBe(202);
      b.open();
      expect((await del).statusCode).toBe(409);
    } finally { clearBusy('kept'); }
    await vi.waitFor(() => expect(b.store.getChannelForAgent('kept')?.accountId).toBe('made_up_bot'), { timeout: 6_000 });
    expect(b.store.getAgent('kept')!.state).not.toBe('DELETED');
  });

  it('a step asked again after its token was lost shows in Alerts again, though it was cleared before', async () => {
    const store = parkedStore('cleared');
    const secrets = memorySecrets();
    const manual = new TelegramManualProvisioner(secrets as never);
    const f = Fastify();
    installErrorHandler(f);
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: channelOver(manual, (req) => manual.provision(req as never)) } as never);
    fakeGetMe();
    // What the app's Alerts read: a step shown, and not cleared.
    const needsYou = async () => {
      const a = (await f.inject({ method: 'GET', url: '/v1/agents/cleared', headers: H })).json();
      return !!a.pendingAction && !String(a.attentionAck ?? '').split('\n').includes('pending');
    };
    expect(await needsYou()).toBe(true);
    store.setAgentAttentionAck('cleared', 'pending'); // the owner's Clear
    expect(await needsYou()).toBe(false);
    markBusy('cleared'); // setup waits, so the token can be lost first
    try {
      expect((await f.inject({ method: 'POST', url: '/v1/agents/cleared/channel-token', headers: H, payload: { token: TOKEN } })).statusCode).toBe(202);
      manual.discardPending('cleared'); // the token is lost
      await vi.waitFor(() => expect(secrets.map.has(TelegramManualProvisioner.pendingRef('cleared'))).toBe(false));
    } finally { clearBusy('cleared'); }
    await vi.waitFor(() => expect(store.getAgent('cleared')!.pendingAction).toMatchObject({ type: 'bot_token' }), { timeout: 6_000 });
    await vi.waitFor(() => expect(store.getAgent('cleared')!.pendingAction?.received).toBeUndefined(), { timeout: 6_000 });
    expect(await needsYou()).toBe(true);
  });
});

describe('the held-token flow (eleventh review)', () => {
  it('a token that could not be held puts the step back as it was: a Clear the owner gave it stands', async () => {
    const store = parkedStore('unheld');
    const secrets = memorySecrets();
    // The disk refuses the held copy.
    const put = secrets.put;
    secrets.put = async (ref: string, v: string) => {
      if (ref === TelegramManualProvisioner.pendingRef('unheld')) throw new Error('made-up disk full');
      return put(ref, v);
    };
    const manual = new TelegramManualProvisioner(secrets as never);
    const f = Fastify();
    installErrorHandler(f);
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: channelOver(manual, () => new Promise(() => {})) } as never);
    fakeGetMe();
    store.setAgentAttentionAck('unheld', 'pending'); // the owner's Clear
    const r = await f.inject({ method: 'POST', url: '/v1/agents/unheld/channel-token', headers: H, payload: { token: TOKEN } });
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect(store.getAgent('unheld')!.pendingAction).toEqual({ type: 'bot_token', instructions: 'paste it' });
    const seen = (await f.inject({ method: 'GET', url: '/v1/agents/unheld', headers: H })).json();
    expect(String(seen.attentionAck ?? '').split('\n')).toContain('pending');
  });

  it('a setup cut off by a restart after its step was answered is told by what the step holds', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
    const secrets = memorySecrets();
    const ops: Record<string, string> = {};
    for (const [id, webOnly] of [['r-kept', false], ['r-lost', false], ['r-web', true]] as const) {
      store.insertAgent({ id, ownerId: OWNER, name: 'Lunch Picker', slug: id, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly, createdAt: 'now', updatedAt: 'now' } as never);
      store.setAgentPendingAction(id, { type: 'bot_token', instructions: 'paste it', received: true });
      ops[id] = beginOperation(store, 'provision', id, {}).id;
    }
    // Held on disk before the restart for one; the other's paste was cut off before it was kept.
    await new TelegramManualProvisioner(secrets as never).submitToken('r-kept', TOKEN, 'made_up_bot');
    newBootForTests();
    const manual = new TelegramManualProvisioner(secrets as never);
    manual.loadHeld(['r-kept', 'r-lost', 'r-web']); // as registerRoutes does at boot
    const provider = new MockProvider();
    await resumeOperations({ store, secrets, channel: channelOver(manual, () => new Promise(() => {})), providerForHost: () => provider } as never);
    const outcome = (id: string) => store.getOperation(ops[id]!)!.outcome ?? '';
    expect(outcome('r-kept')).toMatch(/token was kept, and setup starts again with it/);
    expect(outcome('r-lost')).toMatch(/asks for the token again/);
    expect(outcome('r-lost')).not.toMatch(/kept, and/);
    expect(outcome('r-web')).toMatch(/without a Telegram bot; setup goes on without one/);
    expect(outcome('r-web')).not.toMatch(/token was kept/);
  });
});

describe('the held-token flow (twelfth review)', () => {
  /** A web-only agent that runs, to attach a bot to; puts to the secret store are recorded. */
  async function attachBox(owns: (u: string) => boolean, provision?: (req: { agentId: string }) => Promise<unknown>) {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
    store.insertAgent({ id: 'att', ownerId: OWNER, name: 'Recipe Box', slug: 'recipe-box', state: 'RUNNING', runtimeRef: 'mock://att', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    const secrets = memorySecrets();
    const puts: string[] = [];
    const put = secrets.put;
    secrets.put = async (ref: string, v: string) => { puts.push(ref); return put(ref, v); };
    const manual = new TelegramManualProvisioner(secrets as never);
    const f = Fastify();
    installErrorHandler(f);
    const channel = { ...channelOver(manual, provision ?? (() => new Promise(() => {}))), pool: { owns, availableCount: () => 0 } };
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel } as never);
    fakeGetMe();
    return { store, f, puts, secrets, manual };
  }

  // Sixteenth review.
  it('a token the store would not keep is not left held in memory by the attach route', async () => {
    const b = await attachBox(() => false, (req) => b.manual.provision(req as never));
    const put = b.secrets.put;
    b.secrets.put = async (ref: string, v: string) => { if (ref === TelegramManualProvisioner.pendingRef('att')) throw new Error('made-up disk full'); return put(ref, v); };
    const r = await b.f.inject({ method: 'POST', url: '/v1/agents/att/telegram', headers: H, payload: { token: TOKEN } });
    expect(r.statusCode).toBe(500);
    expect(await b.manual.waitingFor('att')).toBe(false);
    // The next attach from the pool does not take it unasked.
    await expect(b.manual.provision({ agentId: 'att', agentName: 'Recipe Box', slug: 'recipe-box' } as never)).rejects.toBeInstanceOf(ChannelSetupRequired);
  });

  // Fifteenth review.
  it('a token the attach route held is let go when setting up the bot fails', async () => {
    const b = await attachBox(() => false, async () => { throw new Error('made-up disk full'); });
    const r = await b.f.inject({ method: 'POST', url: '/v1/agents/att/telegram', headers: H, payload: { token: TOKEN } });
    expect(r.statusCode).toBe(500);
    expect(b.puts).toContain(TelegramManualProvisioner.pendingRef('att')); // it was held
    expect(b.secrets.map.has(TelegramManualProvisioner.pendingRef('att'))).toBe(false);
    expect(await b.manual.waitingFor('att')).toBe(false);
  });

  it('a token the attach route turns down is never held on disk', async () => {
    // Another agent's bot.
    const b = await attachBox(() => false);
    b.store.insertAgent({ id: 'other', ownerId: OWNER, name: 'Lunch Picker', slug: 'lunch-picker', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: false, createdAt: 'now', updatedAt: 'now' } as never);
    b.store.insertChannel({ id: 'ch-other', agentId: 'other', kind: 'telegram', accountId: 'made_up_bot', secretRef: 'telegram/bot/made_up_bot', deepLink: 'https://t.me/made_up_bot', createdAt: 'now' } as never);
    const used = await b.f.inject({ method: 'POST', url: '/v1/agents/att/telegram', headers: H, payload: { token: TOKEN } });
    expect(used.statusCode).toBe(400);
    expect(used.json().error).toMatch(/already connected to "Lunch Picker"/);
    expect(b.puts).not.toContain(TelegramManualProvisioner.pendingRef('att'));
    // A spare in the pool: a token problem too, so 400.
    const s = await attachBox((u) => u === 'made_up_bot');
    const spare = await s.f.inject({ method: 'POST', url: '/v1/agents/att/telegram', headers: H, payload: { token: TOKEN } });
    expect(spare.statusCode).toBe(400);
    expect(spare.json().error).toMatch(/spare bot in the pool/);
    expect(s.puts).not.toContain(TelegramManualProvisioner.pendingRef('att'));
  });

  it('a pool spare\'s token pasted for a waiting agent is a token problem: 400, so adopt asks for another', async () => {
    const store = parkedStore('spare');
    const f = Fastify();
    installErrorHandler(f);
    const manual = new TelegramManualProvisioner(memorySecrets() as never);
    await registerRoutes(f, { store, secrets: memorySecrets(), providers: new Map([['mock', new MockProvider()]]), channel: { ...channelOver(manual, () => new Promise(() => {})), pool: { owns: (u: string) => u === 'made_up_bot', availableCount: () => 1 } } } as never);
    fakeGetMe();
    const r = await f.inject({ method: 'POST', url: '/v1/agents/spare/channel-token', headers: H, payload: { token: TOKEN } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/spare bot in the pool/);
    expect(store.getAgent('spare')!.pendingAction).toEqual({ type: 'bot_token', instructions: 'paste it' });
  });

  it('a token posted for an agent being deleted is told so, not "came in already"', async () => {
    const store = parkedStore('leaving');
    store.setAgentState('leaving', 'DELETING');
    const f = Fastify();
    installErrorHandler(f);
    const manual = new TelegramManualProvisioner(memorySecrets() as never);
    await registerRoutes(f, { store, secrets: memorySecrets(), providers: new Map([['mock', new MockProvider()]]), channel: channelOver(manual, () => new Promise(() => {})) } as never);
    fakeGetMe();
    const r = await f.inject({ method: 'POST', url: '/v1/agents/leaving/channel-token', headers: H, payload: { token: TOKEN } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('It is being deleted.');
  });
});

describe('one Telegram check per pasted token', () => {
  it('the route\'s getMe serves the channel too', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
    store.insertAgent({ id: 'park', ownerId: OWNER, name: 'Lunch Picker', slug: 'lunch-picker', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: false, createdAt: 'now', updatedAt: 'now' } as never);
    store.setAgentPendingAction('park', { type: 'bot_token', instructions: 'paste it' } as never);
    const manual = new TelegramManualProvisioner({ put: async () => {}, get: async () => 'x', delete: async () => {} } as never);
    const f = Fastify();
    installErrorHandler(f);
    await registerRoutes(f, {
      store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', new MockProvider()]]),
      channel: {
        kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 }, discardPending: () => {}, release: async () => {},
        submitToken: (id: string, token: string, checked?: string) => manual.submitToken(id, token, checked),
        provision: () => new Promise(() => {}),
      },
    } as never);
    const getMe = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { username: 'made_up_bot' } })));
    const r = await f.inject({ method: 'POST', url: '/v1/agents/park/channel-token', headers: H, payload: { token: TOKEN } });
    expect(r.statusCode).toBe(202);
    expect(getMe.mock.calls.filter(([u]) => /\/getMe$/.test(String(u)))).toHaveLength(1);
    expect(await manual.waitingFor('park')).toBe(true);
  });
});

describe('fifteenth review', () => {
  it('the boot read of held tokens asks for them all at once', async () => {
    const secrets = memorySecrets();
    const ids = ['b1', 'b2', 'b3', 'b4', 'b5'];
    for (const id of ids) await secrets.put(TelegramManualProvisioner.pendingRef(id), JSON.stringify({ username: `made_up_${id}_bot`, token: TOKEN }));
    let inFlight = 0, most = 0;
    const get = secrets.get;
    secrets.get = async (ref: string) => {
      most = Math.max(most, ++inFlight);
      try { await new Promise((r) => setTimeout(r, 5)); return await get(ref); } finally { inFlight--; }
    };
    const manual = new TelegramManualProvisioner(secrets as never);
    manual.loadHeld(ids);
    for (const id of ids) expect(await manual.waitingFor(id)).toBe(true);
    expect(most).toBe(ids.length);
  });

  // Sixteenth review.
  it('a token let go while the boot read runs is not brought back by it', async () => {
    const secrets = memorySecrets();
    await secrets.put(TelegramManualProvisioner.pendingRef('d1'), JSON.stringify({ username: 'made_up_bot', token: TOKEN }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const get = secrets.get;
    secrets.get = async (ref: string) => { const v = await get(ref); await gate; return v; };
    const manual = new TelegramManualProvisioner(secrets as never);
    manual.loadHeld(['d1']);
    await new Promise((r) => setTimeout(r, 5)); // the read has the old value
    await manual.discardPending('d1');
    release();
    expect(await manual.waitingFor('d1')).toBe(false);
    expect(secrets.map.has(TelegramManualProvisioner.pendingRef('d1'))).toBe(false);
  });

  it('/v1/config says the server marks a hand-over\'s step answered (handover: 2), as the CLI asks', async () => {
    const f = Fastify();
    installErrorHandler(f);
    await registerRoutes(f, { store: parkedStore(), secrets: memorySecrets(), providers: new Map([['mock', new MockProvider()]]), channel: channelOver(new TelegramManualProvisioner(memorySecrets() as never), () => new Promise(() => {})) } as never);
    const r = await f.inject({ method: 'GET', url: '/v1/config', headers: H });
    expect(r.json().handover).toBe(HANDOVER_SAYS);
  });
});
