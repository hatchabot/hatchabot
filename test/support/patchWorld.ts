/**
 * The harness of the tests that pin PATCH /v1/agents/:id (HB-0825): what it
 * refuses and in which order, and the order of what a change does. The real
 * routes over an in-memory store and a MockProvider, as test/support/world.ts
 * makes them, with three more things a test of this route needs:
 *  - a Slack connector of its own, so a rename reaches a bot of each kind;
 *  - a Telegram channel whose pool can rename a pool bot;
 *  - a log (`log`) of every write the route makes, in the order it makes
 *    them: the store's setters, its transaction (outermost only: `tx{` and
 *    `}tx`), the timeline (`event:<name>`), what the machine is asked
 *    (`docker:<cap>[+<swap>]`, `exec:<first two words>`, `shell`, `volume`,
 *    `info`, `imageInfo`), a rebuild owed (`owe`, `owe-cleared`), a hold
 *    kept for a restart (`hold:<kind>`, `unhold:<kind>`), an operation
 *    begun (`operation:<kind>`), a secret read (`secret:<ref>`), a bot renamed
 *    (`rename:<kind>`, `pool-rename`, `telegram:setMyName`), and the answer
 *    (`reply`, from an onSend hook).
 * `pick` takes the entries a test is about, so a test pins the order of its
 * own steps and is not thrown by what runs beside them (a rebuild kicked).
 *
 * The data is made up.
 */
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { MockProvider } from '../../src/providers/mockProvider.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { ChannelConnector } from '../../src/channels/connector.js';
import { as, MemSecrets, OWNER, viaGlobalFetch, type World } from './world.js';
import { urlHost } from '../helpers/urlHost.js';

process.env.HATCHABOT_READY_POLL_MS ??= '1';
process.env.HATCHABOT_READY_TIMEOUT_MS ??= '2000';

export const MEMBER = 'user-member';
export const DEFAULT = 'claude-opus-4-8';
export const OTHER = 'claude-haiku-4-5';

export interface PatchWorld extends World {
  log: string[];
  /** PATCH /v1/agents/:id as `who` (the machine's owner by default). */
  patch(id: string, body: unknown, who?: string): Promise<{ statusCode: number; json(): any; body: string }>;
}

/** A promise a test opens by hand, and one that says the step was reached. */
export function gate() {
  let open!: () => void, reach!: () => void;
  const held = new Promise<void>((r) => { open = r; });
  const reached = new Promise<void>((r) => { reach = r; });
  return { held, open, reached, reach };
}

/** Let what is running in the background take its next steps. */
export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** The entries of `log` that are one of `markers` (a marker ending in `*` matches by its start), in order. */
export function pick(log: string[], ...markers: string[]): string[] {
  const hit = (e: string) => markers.some((m) => (m.endsWith('*') ? e.startsWith(m.slice(0, -1)) : e === m));
  return log.filter(hit);
}

const STORE_WRITES = [
  'setAgentAIProfile', 'setAgentMemoryCap', 'setAgentSwapAllowance', 'setAgentAttentionAck',
  'setHibernatePolicy', 'setAgentFilesMaxMb', 'setAgentIcon', 'setAgentParameters', 'setAgentGroupAccess',
  'setAgentRichMessages', 'setAgentEmbedMode', 'setAgentBrowser', 'setAgentCronTriggers', 'setAgentPersona',
  'setAgentParamFile', 'setAgentGroup', 'setAgentMigratedTo', 'setAgentImage', 'setAgentSharedPaths',
  'setAgentName', 'setAgentClassIf', 'setChannelSettings',
] as const;

/** A Slack connector that renames a bot and says so in the log. */
function slackConnector(log: string[]): ChannelConnector {
  return {
    kind: 'slack', label: 'Slack',
    fields: [{ key: 'token', label: 'Token', pattern: /^ok-/, help: 'starts with ok-' }],
    secretValue: (c) => String(c.token),
    credsFromSecret: (secret) => ({ token: secret }),
    async rename(_secret, name) { log.push('rename:slack'); return { ok: true, name }; },
    async verify() { throw new Error('not in these tests'); },
  } as ChannelConnector;
}

/** The Telegram channel: a pool that knows its bots, and a pool bot's rename. */
function telegramChannel(log: string[]) {
  const entries: Array<{ username: string; token: string; leasedTo?: string; ownerId?: string | null }> = [];
  const pending = new Set<string>();
  const pool = {
    entries,
    availableCount: () => 0,
    owns: (u: string) => entries.some((e) => e.username === u),
    list: () => entries.map((e) => ({ username: e.username, secretRef: `telegram/bot/${e.username}`, leasedTo: e.leasedTo, ownerId: e.ownerId ?? undefined })),
    addToPool: async () => {},
    removeFromPool: async () => {},
    /** A rename Telegram refused, queued (a test sets it). */
    pendingName: (u: string) => (pending.has(u) ? 'queued' : undefined),
    pending,
  };
  return {
    kind: 'telegram', pool, release: async () => {}, discardPending: () => {},
    syncDisplayName: async (_u: string, _name: string) => { log.push('pool-rename'); },
  } as any;
}

/**
 * No test talks to Telegram: the wake poll and getMe get an empty, well-formed
 * answer, and the owner's own bot's rename (handed this fetch, HB-1437) is
 * in the log, as the global one's is.
 */
const oauthFetchFor = (log: string[]) => (async (u: string | URL | Request) => {
  if (urlHost(u) === 'api.telegram.org' && String(u instanceof Request ? u.url : u).includes('/setMyName')) {
    log.push('telegram:setMyName');
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify(urlHost(u) === 'api.telegram.org' ? { ok: true, result: [] } : { error: 'stubbed' }), { status: urlHost(u) === 'api.telegram.org' ? 200 : 404, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

/** The routes of a fresh installation, its local host and source `p1` the owner's, with the log on. */
export async function patchWorld(): Promise<PatchWorld> {
  const db = new Database(':memory:');
  const store = new Store(db);
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: DEFAULT, models: [OTHER], secretRef: 'ai/p1', createdAt: 'now' });
  await secrets.put('ai/p1', 'sk-test');
  const log: string[] = [];
  const f = Fastify();
  const channel = telegramChannel(log);
  const providers = new Map<string, MockProvider>([['mock', provider]]);
  const routes = await registerRoutes(f, { store, secrets, providers, channel, oauthFetch: oauthFetchFor(log), peerFetch: viaGlobalFetch, connectors: { slack: slackConnector(log) } } as never);
  f.addHook('onSend', async (_req, _reply, payload) => { log.push('reply'); return payload; });
  const w: PatchWorld = {
    store, secrets, provider, providers, f, owner: OWNER, channel, routes, db, log,
    patch: (id, body, who) => w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(who), payload: body as never }) as never,
  };
  watch(w);
  return w;
}

/** The log's hooks on this world's store, secrets, providers and the Telegram API. */
function watch(w: PatchWorld): void {
  const { log } = w;
  const s = w.store as any;
  for (const name of STORE_WRITES) {
    const orig = s[name].bind(s);
    s[name] = (...a: unknown[]) => { log.push(name); return orig(...a); };
  }
  const setModel = s.setAgentModel.bind(s);
  s.setAgentModel = (id: string, model: string | null, opts?: unknown) => { log.push(`setAgentModel:${model}`); return setModel(id, model, opts); };
  const setOwed = s.setRebuildOnStart.bind(s);
  s.setRebuildOnStart = (id: string, at: string | null) => { log.push(at ? 'owe' : 'owe-cleared'); return setOwed(id, at); };
  const hold = s.setAgentHold.bind(s), unhold = s.clearAgentHold.bind(s);
  s.setAgentHold = (id: string, kind: string, v: string) => { log.push(`hold:${kind}`); return hold(id, kind, v); };
  s.clearAgentHold = (id: string, kind: string, onlyIf?: string) => { log.push(`unhold:${kind}`); return unhold(id, kind, onlyIf); };
  const op = s.insertOperation.bind(s);
  s.insertOperation = (o: { kind: string }) => { log.push(`operation:${o.kind}`); return op(o); };
  const event = s.recordEvent.bind(s);
  s.recordEvent = (id: string, name: string, ...rest: unknown[]) => { log.push(`event:${name}`); return event(id, name, ...rest); };
  let depth = 0;
  const transact = s.transact.bind(s);
  s.transact = (fn: () => unknown) => {
    const outer = depth === 0;
    if (outer) log.push('tx{');
    depth++;
    try { return transact(fn); } finally { depth--; if (outer) log.push('}tx'); }
  };
  const get = w.secrets.get.bind(w.secrets);
  w.secrets.get = (ref: string) => { log.push(`secret:${ref}`); return get(ref); };
  for (const p of w.providers.values()) watchProvider(log, p);
  vi.stubGlobal('fetch', async (u: string | URL | Request) => {
    if (String(u).includes('/setMyName')) { log.push('telegram:setMyName'); return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

/** What a machine is asked, in the log. A second machine added by a test is watched with this. */
export function watchProvider(log: string[], p: MockProvider): void {
  const update = p.updateMemory.bind(p);
  p.updateMemory = async (ref: string, cap: string, swap: string | undefined) => { log.push(`docker:${cap}${swap ? `+${swap}` : ''}`); return update(ref, cap, swap); };
  const exec = p.exec.bind(p);
  p.exec = (ref: string, argv: string[], opts?: { timeoutMs?: number }) => { log.push(`exec:${argv.slice(0, 2).join(' ')}`); return exec(ref, argv, opts); };
  const shell = p.execShell.bind(p);
  p.execShell = (ref: string, script: string, opts?: never) => { log.push('shell'); return shell(ref, script, opts); };
  const vol = p.execShellOnVolume.bind(p);
  p.execShellOnVolume = (ref: string, script: string, opts?: never) => { log.push('volume'); return vol(ref, script, opts); };
  const info = p.info.bind(p);
  p.info = (ref: string) => { log.push('info'); return info(ref); };
  const imageInfo = p.currentImageInfo.bind(p);
  p.currentImageInfo = (image?: string) => { log.push('imageInfo'); return imageInfo(image); };
}

/** A running agent with a Telegram bot (not a pool one) and its owner's seat, as seedRunningAgent makes it. */
export async function runningAgent(w: PatchWorld, opts: { id?: string; name?: string; owner?: string; accountId?: string } = {}): Promise<string> {
  const id = opts.id ?? 'a1';
  const name = opts.name ?? 'Kitchen';
  const owner = opts.owner ?? OWNER;
  const slug = name.toLowerCase();
  w.store.insertAgent({
    id, ownerId: owner, name, slug, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'helps cook', sharedMemory: true,
    createdAt: 'now', updatedAt: 'now',
  });
  const { runtimeRef } = await w.provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } }, env: {} });
  w.store.setAgentRuntimeRef(id, runtimeRef);
  await w.provider.start(runtimeRef);
  w.store.setAgentState(id, 'RUNNING');
  const accountId = opts.accountId ?? `${slug}bot`;
  await w.secrets.put(`chan/${id}`, 'made-up-bot-credential');
  w.store.insertChannel({ id: `c-${id}`, agentId: id, kind: 'telegram', accountId, secretRef: `chan/${id}`, deepLink: `https://t.me/${accountId}`, createdAt: 'now' });
  w.store.insertMembership({ id: `m-${id}-owner`, agentId: id, userId: owner, role: 'owner', status: 'active', channelUserId: '111' });
  return id;
}

/** The same agent stopped (its container kept). */
export async function stop(w: PatchWorld, id: string): Promise<void> {
  await w.provider.stop(w.store.getAgent(id)!.runtimeRef!);
  w.store.setAgentState(id, 'STOPPED');
}

/** An agent with no container (stopped before its first setup), as a test inserts it. */
export function bareAgent(w: PatchWorld, opts: { id: string; name?: string; owner?: string; ops?: boolean; hostId?: string; profile?: string }): string {
  const name = opts.name ?? 'Pantry';
  w.store.insertAgent({
    id: opts.id, ownerId: opts.owner ?? OWNER, name, slug: `${name.toLowerCase()}-${opts.id}`, state: 'STOPPED', aiProfileId: opts.profile ?? 'p1',
    hostId: opts.hostId ?? 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now', ...(opts.ops ? { ops: true } : {}),
  } as never);
  w.store.insertMembership({ id: `m-${opts.id}-owner`, agentId: opts.id, userId: opts.owner ?? OWNER, role: 'owner', status: 'active' });
  return opts.id;
}

/** A second machine, a runner, with its own MockProvider (watched). */
export function addRunner(w: PatchWorld): MockProvider {
  const p = new MockProvider();
  w.store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'cloud', provider: 'mock2', name: 'Test Runner', settings: {}, createdAt: 'now' });
  w.providers.set('mock2', p);
  watchProvider(w.log, p);
  return p;
}

/** Hold the machine's next memory update (docker update) until the gate opens; `fail` makes it throw instead once open. */
export function holdDockerUpdate(p: MockProvider, g = gate(), opts: { nth?: number } = {}): ReturnType<typeof gate> {
  const update = p.updateMemory.bind(p);
  let n = 0;
  p.updateMemory = async (...a: Parameters<MockProvider['updateMemory']>) => {
    if (++n === (opts.nth ?? 1)) { g.reach(); await g.held; }
    return update(...a);
  };
  return g;
}
