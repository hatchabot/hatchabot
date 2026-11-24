import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import type { ExecResult, RuntimeProvider } from '../src/providers/provider.js';
import { clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { createHatchabotAgent, OPS_NO_LOCAL, type HatchabotAgent } from '../src/orchestrator/ops/hatchabotAgent.js';
import type { Agent } from '../src/domain/types.js';
import { IMAGE_TAG_RE } from '../src/api/routeContext.js';

/**
 * The Hatchabot agent service (HB-0808), driven as the routes and the door
 * drive it but with no HTTP server: a turn in the manager's own
 * conversation, "what agents should I add?", the manager made (and each
 * refusal in its order), who may use its door, the operator's profile pushed
 * into the running agents, and the lockdown check's timer. A real store on
 * an in-memory database; a runtime that records what it is asked. Every
 * name and address is made up.
 */
const OWNER = 'user-owner';

interface World {
  store: Store;
  svc: HatchabotAgent;
  execs: string[][];
  forgot: string[];
  traced: Array<{ event: string; detail: Record<string, unknown> }>;
  synced: string[];
  kicked: string[];
  warned: string[];
  tagged: string[];
  doorFails?: Error & { userMessage?: string };
  answer: () => ExecResult | Promise<ExecResult>;
  doormen: string[] | undefined;
  agent(id: string, opts?: { state?: Agent['state']; ops?: boolean }): Agent;
}

/** `base`: the fleet's default; `tags`: this machine's images (the default and a version of the same image, unless given); `tagOk`: the pin rule (IMAGE_TAG_RE's, unless given). */
function world(opts: { jail?: boolean; driftEveryMs?: number; base?: string; tags?: Array<{ tag: string; imageId: string }>; tagOk?: (tag: string) => boolean } = {}): World {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  const w = { store, execs: [], forgot: [], traced: [], synced: [], kicked: [], warned: [], tagged: [], doormen: undefined,
    answer: () => ({ code: 0, stdout: 'ok', stderr: '' }) } as unknown as World;
  const provider = {
    exec: async (_ref: string, argv: string[]) => { w.execs.push(argv); return w.answer(); },
    ...(opts.jail === false ? {} : { ensureOpsJail: async () => {} }),
    doormanAddresses: async () => { if (!w.doormen) throw new Error('no doormen here'); return w.doormen; },
    listImageTags: async () => opts.tags ?? [
      { tag: 'hatchabot-runtime:latest', imageId: 'sha256:abc123def4567890' },
      { tag: 'hatchabot-runtime:2026.9.8', imageId: 'sha256:abc123def4567890' },
    ],
    tagImage: async (_from: string, to: string) => { w.tagged.push(to); },
  } as unknown as RuntimeProvider;
  w.svc = createHatchabotAgent({
    store,
    providerFor: () => provider,
    trace: (agentId) => (event, detail) => { w.traced.push({ event, detail: { ...(agentId ? { agentId } : {}), ...detail } }); },
    forgetSessions: (id) => { w.forgot.push(id); },
    openDoor: async () => { if (w.doorFails) throw w.doorFails; return { host: '127.0.0.1', port: 1 }; },
    unjailedOk: () => false,
    defaultBase: opts.base ?? 'hatchabot-runtime:latest',
    imageTagOk: opts.tagOk ?? ((tag) => IMAGE_TAG_RE.test(tag)),
    kickProvision: (id) => { w.kicked.push(id); },
    syncDocsHeld: async (a) => { w.synced.push(a.id); },
    log: { info: () => {}, warn: (_d, msg) => { w.warned.push(msg); } },
    driftEveryMs: opts.driftEveryMs ?? 0,
  });
  w.agent = (id, o = {}) => {
    store.insertAgent({
      id, ownerId: OWNER, name: `Agent ${id}`, slug: id, state: o.state ?? 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `rt-${id}`,
    } as never);
    if (o.ops) store.setAgentOps(id, true);
    return store.getAgent(id)!;
  };
  return w;
}
const source = (w: World, id: string, vendor: string, extra: Record<string, unknown> = {}) =>
  w.store.insertAIProfile({ id, ownerId: OWNER, name: id, vendor, kind: 'api_key', model: 'm', secretRef: `ai/${id}`, createdAt: 'now', ...extra } as never);

afterEach(() => { vi.useRealTimers(); clearBusy('ops1'); clearBusy('a1'); });

describe('a turn in the manager\'s own conversation', () => {
  it('runs one turn and forgets the cached sessions on both sides of it', async () => {
    const w = world();
    const ops = w.agent('ops1', { ops: true });
    expect(await w.svc.runTurn(ops, 'hello')).toEqual({ ok: true, error: 'ok' });
    expect(w.execs).toEqual([['agent', '--agent', 'ops1', '-m', 'hello']]);
    expect(w.forgot).toEqual(['ops1', 'ops1']);
  });

  it('refuses a turn while the manager is busy, without running anything', async () => {
    const w = world();
    const ops = w.agent('ops1', { ops: true });
    markBusy('ops1');
    expect(await w.svc.runTurn(ops, 'hello')).toEqual({ ok: false, error: 'busy' });
    expect(w.execs).toEqual([]);
  });

  it('finds an owner\'s manager, and the notes go into its conversation', async () => {
    const w = world();
    expect(w.svc.opsAgentOf(OWNER)).toBeUndefined();
    w.agent('ops1', { ops: true });
    expect(w.svc.opsAgentOf(OWNER)?.id).toBe('ops1');
    await w.svc.notifier.notify(OWNER, 'The build finished.');
    expect(w.execs).toHaveLength(1);
    expect(w.execs[0]!.at(-1)).toMatch(/Hatchabot note .*The build finished\./);
  });
});

describe('"what agents should I add?"', () => {
  it('says there is no manager, or that it is not running', async () => {
    const w = world();
    expect(await w.svc.suggest(OWNER)).toEqual({ kind: 'none' });
    w.agent('ops1', { ops: true, state: 'STOPPED' });
    expect(await w.svc.suggest(OWNER)).toEqual({ kind: 'not-running', state: 'STOPPED' });
    expect(w.execs).toEqual([]);
  });

  it('asks it, and puts the asking on its timeline', async () => {
    const w = world();
    w.agent('ops1', { ops: true });
    expect(await w.svc.suggest(OWNER)).toEqual({ kind: 'asked', agentId: 'ops1', slug: 'ops1' });
    expect(w.traced).toEqual([{ event: 'ops.suggest_asked', detail: { agentId: 'ops1', ok: true } }]);
  });

  it('hands back why a turn failed: busy, or the turn\'s own words', async () => {
    const w = world();
    w.agent('ops1', { ops: true });
    markBusy('ops1');
    expect(await w.svc.suggest(OWNER)).toEqual({ kind: 'failed', why: 'busy' });
    clearBusy('ops1');
    w.answer = () => ({ code: 1, stdout: '', stderr: 'rate limit reached' });
    expect(await w.svc.suggest(OWNER)).toEqual({ kind: 'failed', why: 'rate limit reached' });
    w.answer = () => { throw new Error('the runner went away'); };
    expect(await w.svc.suggest(OWNER)).toEqual({ kind: 'failed', why: 'the runner went away' });
    expect(w.traced.at(-1)).toEqual({ event: 'ops.suggest_asked', detail: { agentId: 'ops1', ok: false, error: 'the runner went away' } });
  });
});

describe('making the manager', () => {
  it('refuses a local model, and no source at all, in their own words', async () => {
    const w = world();
    expect(await w.svc.create(OWNER, undefined)).toEqual({ refusal: 'invalid', error: 'Add an AI source first (Settings → AI): Claude, OpenAI or Gemini.' });
    source(w, 'local1', 'local');
    expect(await w.svc.create(OWNER, undefined)).toEqual({ refusal: 'invalid', error: OPS_NO_LOCAL });
    expect(await w.svc.create(OWNER, 'local1')).toEqual({ refusal: 'invalid', error: OPS_NO_LOCAL });
    expect(await w.svc.create(OWNER, 'no-such')).toEqual({ refusal: 'invalid', error: OPS_NO_LOCAL });
    expect(w.store.listAllActiveAgents()).toEqual([]);
  });

  it('refuses a machine whose runtime has no network jail, and one whose door will not open, leaving nothing behind', async () => {
    const bare = world({ jail: false });
    source(bare, 'p1', 'anthropic');
    expect(await bare.svc.create(OWNER, undefined)).toEqual({ refusal: 'invalid', error: 'This machine’s runtime cannot isolate the agent’s network, so it is not offered here.' });
    const w = world();
    source(w, 'p1', 'anthropic');
    w.doorFails = Object.assign(new Error('EADDRINUSE'), { userMessage: 'The door\'s port is taken.' });
    expect(await w.svc.create(OWNER, undefined)).toEqual({ refusal: 'conflict', error: 'The door\'s port is taken.' });
    expect(w.traced).toEqual([{ event: 'ops.door_unavailable', detail: { ownerId: OWNER, error: 'EADDRINUSE' } }]);
    w.doorFails = new Error('no reason for a person');
    expect(await w.svc.create(OWNER, undefined)).toEqual({ refusal: 'conflict', error: 'Hatchabot could not open the management agent’s door on this machine.' });
    expect(w.store.listAllActiveAgents()).toEqual([]);
  });

  it('makes it web-only, owner-only, seeded, with its morning task, pinned to today\'s image, and starts its setup', async () => {
    const w = world();
    source(w, 'p0', 'local');
    source(w, 'p1', 'anthropic');
    const made = await w.svc.create(OWNER, undefined);
    if ('refusal' in made) throw new Error(made.error);
    const a = w.store.getAgent(made.agent.id)!;
    expect(a).toMatchObject({ ops: true, webOnly: true, aiProfileId: 'p1', hostId: 'h1', image: 'hatchabot-runtime:2026.9.8' });
    expect(w.store.getPendingSchedules(a.id)).toEqual([expect.objectContaining({ name: 'Morning fleet check', cron: '0 8 * * *' })]);
    expect(w.kicked).toEqual([a.id]);
    expect(w.traced.at(-1)).toEqual({ event: 'ops.created', detail: { agentId: a.id, aiProfileId: 'p1' } });
    expect(w.tagged).toEqual([]);
  });

  it('names today\'s image, when it has no other name, in the fleet\'s own repository, a registry\'s port and all (review of HB-1182)', async () => {
    const made = async (base: string, tagOk?: (tag: string) => boolean) => {
      const w = world({ base, tags: [{ tag: base, imageId: 'sha256:abc123def4567890' }], ...(tagOk ? { tagOk } : {}) });
      source(w, 'p1', 'anthropic');
      const r = await w.svc.create(OWNER, undefined);
      if ('refusal' in r) throw new Error(r.error);
      return { image: w.store.getAgent(r.agent.id)!.image ?? undefined, tagged: w.tagged };
    };
    expect(await made('example-runtime:latest')).toEqual({ image: 'example-runtime:ops-abc123def456', tagged: ['example-runtime:ops-abc123def456'] });
    // A registry with a port: its repository, never "registry.example:ops-…", which nothing lists,
    // and pinned by the pin rule itself (IMAGE_TAG_RE), which took no port and left it unpinned (HB-1357).
    expect(await made('registry.example:5000/team/runtime:latest')).toEqual({ image: 'registry.example:5000/team/runtime:ops-abc123def456', tagged: ['registry.example:5000/team/runtime:ops-abc123def456'] });
    // A tag the rule refuses: left unpinned, as a failed pin is, and nothing tagged elsewhere.
    expect(await made('registry.example:5000/team/runtime:latest', () => false)).toEqual({ image: undefined, tagged: [] });
  });

  it('takes another name when one is in use, and refuses when all three are', async () => {
    const w = world();
    source(w, 'p1', 'anthropic');
    for (const slug of ['hatchabot', 'hatchabot-agent', 'hatchabot-manager']) {
      w.store.insertAgent({ id: `x-${slug}`, ownerId: OWNER, name: slug, slug, state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as never);
    }
    expect(await w.svc.create(OWNER, undefined)).toEqual({ refusal: 'conflict', error: 'Rename your agent called "Hatchabot" first.' });
  });
});

describe('who may use the door', () => {
  it('lets in a doorman\'s address, turns away any other, and looks again on a miss', async () => {
    const w = world();
    w.agent('ops1', { ops: true });
    w.doormen = ['172.30.0.5'];
    expect(await w.svc.peerOk('')).toBe(false);
    expect(await w.svc.peerOk('172.30.0.5')).toBe(true);
    expect(await w.svc.peerOk('172.30.0.9')).toBe(false);
  });

  it('a lookup that fails is logged and counts as no doormen', async () => {
    const w = world();
    w.agent('ops1', { ops: true });
    expect(await w.svc.peerOk('172.30.0.5')).toBe(false);
    expect(w.warned).toEqual(['ops.doorman_lookup_failed']);
  });

  it('with no manager to ask, a runtime that cannot say keeps the old behaviour', async () => {
    const w = world();
    expect(await w.svc.peerOk('172.30.0.5')).toBe(true);
  });
});

describe('the operator\'s profile', () => {
  it('is saved, and pushed to the running agents that are free, one owner\'s pushes in order', async () => {
    const w = world();
    w.agent('a1');
    w.agent('a2');
    w.agent('a3', { state: 'STOPPED' });
    markBusy('a1');
    expect(w.svc.setOperatorProfile(OWNER, 'Runs a small bakery.')).toEqual({ pushing: 1 });
    clearBusy('a1');
    expect(w.store.getOperatorProfile(OWNER)).toBe('Runs a small bakery.');
    expect(w.svc.setOperatorProfile(OWNER, 'Runs two bakeries.')).toEqual({ pushing: 2 });
    // The first push (a2 alone) is done before the second (both) begins.
    await vi.waitFor(() => expect(w.synced).toHaveLength(3));
    expect(w.synced[0]).toBe('a2');
    expect(w.synced.slice(1).sort()).toEqual(['a1', 'a2']);
  });
});

describe('the lockdown check\'s timer', () => {
  it('runs every interval it is given, never at 0, and stop() ends it', () => {
    vi.useFakeTimers();
    const off = world();
    expect(vi.getTimerCount()).toBe(0);
    off.svc.stop();
    const on = world({ driftEveryMs: 60_000 });
    expect(vi.getTimerCount()).toBe(1);
    on.svc.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
