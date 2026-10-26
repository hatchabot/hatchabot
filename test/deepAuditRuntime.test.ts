import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import vm from 'node:vm';
import nodePath from 'node:path';
import nodeCrypto from 'node:crypto';
import { aiSourceHealth } from '../src/orchestrator/health.js';
import { sampleAgentUsage, summarizeSourceUsage } from '../src/orchestrator/sourceUsage.js';
import { Store } from '../src/store/store.js';
import { hibernateSweep, resetHibernateState, type HibernateDeps } from '../src/orchestrator/hibernate.js';
import { exportAgent, importAgent } from '../src/orchestrator/transfer.js';
import { archiveAgent } from '../src/orchestrator/archive.js';
import { createAgentRecord, runProvisionSteps } from '../src/orchestrator/provision.js';
import { accessOverview, verifyAgentAccess } from '../src/orchestrator/accessOverview.js';
import { PAIRING_DB } from '../src/orchestrator/claim.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { TelegramPoolProvisioner } from '../src/channels/telegramPool.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';
import { totalOf } from './helpers/usageFake.js';

/**
 * The deep audit of v2.166.2 (2026-10-24), runtime group: AI-source health and
 * history, cap-hit counters, the sleep lock, file-move retirement, runtime
 * pins after an import, first-provision storage and the access overview.
 * Each case asserts the corrected behaviour of one finding.
 */

const worlds: World[] = [];
const world = async () => { const w = await makeWorld(); worlds.push(w); return w; };
afterEach(async () => { vi.restoreAllMocks(); for (const w of worlds.splice(0)) await w.f.close(); });
const addSource = (w: World, id: string, name: string) => w.store.insertAIProfile({
  id, ownerId: w.owner, name, vendor: 'anthropic', kind: 'api_key', model: `model-${id}`, secretRef: `fixture/${id}`, createdAt: '2026-10-24T00:00:00.000Z',
});

describe('AI-source health reads the source the container runs (audit #052)', () => {
  it('a switch saved but not rebuilt: the running source and its refusal, not the saved one', async () => {
    const w = await world();
    const id = await seedRunningAgent(w, { name: 'Homework Helper' });
    addSource(w, 'p2', 'Next source');
    w.store.setAgentApplied(id, 'p1', 'model-p1');
    w.store.setAgentAIProfile(id, 'p2'); // saved, not rebuilt: the container still calls p1
    w.store.addLimitHit(id, 'p1', '2026-10-24T11:59:00.000Z', 'model-p1');
    const h = aiSourceHealth(w.store, w.store.getAgent(id)!);
    expect(h.name).toBe(w.store.getAIProfile('p1')!.name);
    expect(h).toMatchObject({ refusal: 'refused', refusingSince: '2026-10-24T11:59:00.000Z' });
    // Rebuilt onto p2: p2's (clean) record from then on.
    w.store.setAgentApplied(id, 'p2', 'model-p2');
    const after = aiSourceHealth(w.store, w.store.getAgent(id)!);
    expect(after.name).toBe('Next source');
    expect(after.refusal).toBeUndefined();
  });
});

describe('a source keeps its own successes after its agent leaves it (audit #053)', () => {
  const NOW = Date.parse('2026-10-24T12:00:00.000Z');
  const p1Of = (w: World) => summarizeSourceUsage(w.store, w.owner, NOW).find((p) => p.id === 'p1')!;

  it('saving the agent onto another source does not bring back the refusal its later success answered', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    addSource(w, 'p2', 'Next source');
    w.store.addLimitHit(id, 'p1', '2026-10-24T11:50:00.000Z', 'model-p1');
    w.store.setUsageCursor(id, '2026-10-24T11:55:00.000Z', '2026-10-24T11:55:00.000Z', undefined, 'p1');
    expect(p1Of(w).status).toBe('ok');
    w.store.setAgentAIProfile(id, 'p2');
    expect(p1Of(w)).toMatchObject({ status: 'ok', lastOkAt: '2026-10-24T11:55:00.000Z' });
    // Rebuilt onto p2 too: still p1's success.
    w.store.setAgentApplied(id, 'p2', 'model-p2', '2026-10-24T11:56:00.000Z');
    expect(p1Of(w).status).toBe('ok');
  });

  it('a newer success on the new source does not erase the old source\'s own', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    addSource(w, 'p2', 'Next source');
    w.store.addLimitHit(id, 'p1', '2026-10-24T11:50:00.000Z', 'model-p1');
    // p1 answered again in the 11:55 slot (the transcripts' count), then the agent moved to p2 and answered there.
    w.store.setModelCallOk(id, 'p1', new Map([['2026-10-24T11:55', 2]]), '2026-10-24T11:00', false);
    w.store.setAgentAIProfile(id, 'p2');
    w.store.setAgentApplied(id, 'p2', 'model-p2', '2026-10-24T11:57:00.000Z');
    w.store.setUsageCursor(id, '2026-10-24T11:58:00.000Z', '2026-10-24T11:58:00.000Z', undefined, 'p2');
    expect(p1Of(w).status).toBe('ok');
    // A success from before the refusal answers nothing.
    w.store.addLimitHit(id, 'p1', '2026-10-24T11:56:30.000Z', 'model-p1');
    expect(p1Of(w).status).toBe('limited');
  });

  it('a legacy success with no source recorded counts only for the agent\'s own source', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    addSource(w, 'p2', 'Next source');
    w.store.setAgentAIProfile(id, 'p2');
    w.store.setAgentApplied(id, 'p2', 'model-p2');
    w.store.setUsageCursor(id, '2026-10-24T11:55:00.000Z', '2026-10-24T11:55:00.000Z'); // no source kept with it
    expect(w.store.lastOkOn(id, 'p2')).toBe('2026-10-24T11:55:00.000Z');
    expect(w.store.lastOkOn(id, 'p1', true)).toBeUndefined();
    expect(p1Of(w).lastOkAt).toBeUndefined();
  });
});

describe('every source change in the rewritten hour keeps its own calls (audit #056)', () => {
  it('p1 -> p2 -> p3 inside one hour: 3, 2 and 1 calls, nothing counted twice', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    addSource(w, 'p2', 'Next source');
    addSource(w, 'p3', 'Third source');
    w.provider.modelCallLines = '';
    const deps = { store: w.store, providerFor: () => w.provider };
    const callSlots: Record<string, number> = { '2026-10-24T11:25:00.000Z': 3 };
    const sample = async (when: string) => {
      w.provider.usage.set('*', { ...totalOf(1000), callSlots: { ...callSlots } });
      await sampleAgentUsage(deps, w.store.getAgent(id)!, Date.parse(when));
    };
    const counts = () => ['p1', 'p2', 'p3'].map((p) => w.store.modelCallSlotsFor(p, '2026-10-24T11').reduce((n, r) => n + r.ok, 0));
    w.store.setAgentApplied(id, 'p1', 'model-p1', '2026-10-24T11:00:00.000Z');
    await sample('2026-10-24T11:30:00.000Z');
    w.store.setAgentAIProfile(id, 'p2'); w.store.setAgentApplied(id, 'p2', 'model-p2', '2026-10-24T11:35:00.000Z');
    callSlots['2026-10-24T11:40:00.000Z'] = 2;
    await sample('2026-10-24T11:42:00.000Z');
    expect(counts()).toEqual([3, 2, 0]);
    w.store.setAgentAIProfile(id, 'p3'); w.store.setAgentApplied(id, 'p3', 'model-p3', '2026-10-24T11:45:00.000Z');
    callSlots['2026-10-24T11:50:00.000Z'] = 1;
    await sample('2026-10-24T11:52:00.000Z');
    expect(counts()).toEqual([3, 2, 1]);
    // Read again a little later: the same counts, and back on p1 nothing moves either.
    w.store.setAgentAIProfile(id, 'p1'); w.store.setAgentApplied(id, 'p1', 'model-p1', '2026-10-24T11:55:00.000Z');
    await sample('2026-10-24T11:58:00.000Z');
    expect(counts()).toEqual([3, 2, 1]);
    expect(w.store.appliedSourceChanges(id).map((c) => `${c.from}>${c.to}`)).toEqual(['p1>p2', 'p2>p3', 'p3>p1']);
  });

  it('the one change an older database kept becomes the first of the history', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    addSource(w, 'p2', 'Next source');
    const db = (w.store as unknown as { db: Database.Database }).db;
    db.prepare(`UPDATE agents SET applied_profile_id = 'p2', applied_profile_prev = 'p1', applied_profile_at = '2026-10-24T11:35:00.000Z' WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM store_migrations WHERE name = '2026-10-25-applied-source-changes'`).run();
    const again = new Store(db);
    expect(again.appliedSourceChanges(id)).toEqual([{ at: '2026-10-24T11:35:00.000Z', from: 'p1', to: 'p2' }]);
    // Older than the usage the history keeps: pruned with it.
    again.pruneSourceUsage('2026-10-25T00:00:00.000Z');
    expect(again.appliedSourceChanges(id)).toEqual([]);
  });
});

describe('cap hits after a clear count again once a new container starts (audit #054)', () => {
  it('a counter below the cleared baseline is a new one: it counts whole, and keeps counting past the old total', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    const name = 'hatchabot-fixture-a1';
    w.store.setAgentRuntimeRef(id, `docker://${name}`);
    const row = (hits: number) => [{ name, cpuPct: 1, memBytes: 100, memLimitBytes: 1000, pids: 1, memCapHits: hits, memPeakBytes: 100 }];
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const shown = async () => {
      clock += 4000; // past the three-second stats cache
      const res = await w.f.inject({ method: 'GET', url: '/v1/resources', headers: as() });
      expect(res.statusCode).toBe(200);
      return res.json().hosts[0].containers.find((c: { agentId?: string }) => c.agentId === id).memCapHits as number;
    };
    w.provider.statsRows = row(1200);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/resources/clear`, headers: as(), payload: {} })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.memoryCapBaseline).toBe(1200);
    // The same container hits its cap again: counted from the clear.
    w.provider.statsRows = row(1230);
    expect(await shown()).toBe(30);
    // Rebuilt: the new container's counter starts again from zero.
    w.provider.statsRows = row(50);
    expect(await shown()).toBe(50);
    expect(w.store.getAgent(id)!.memoryCapBaseline).toBeUndefined();
    w.provider.statsRows = row(1300);
    expect(await shown()).toBe(1300);
    // The agent list reads the same way.
    w.provider.infoOverride.set(`docker://${name}`, { memCapHits: 1300 });
    const list = await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as() });
    expect(list.json().find((a: { id: string }) => a.id === id).memoryCapHits).toBe(1300);
  });

  it('a new container that has not reached the baseline shows its own hits in the agent list too', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    w.store.clearMemoryPeaks(id, 900);
    w.provider.infoOverride.set(ref, { memCapHits: 40 });
    const list = await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as() });
    expect(list.json().find((a: { id: string }) => a.id === id).memoryCapHits).toBe(40);
  });
});

describe('sleep and a new scheduled task are judged under the same lock (audit #055)', () => {
  afterEach(() => resetHibernateState());

  it('by hand: a task added while the tasks are read is refused, not put to sleep with the agent', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    const original = w.provider.exec.bind(w.provider);
    let began!: () => void, finish!: () => void;
    const reading = new Promise<void>((r) => { began = r; });
    const hold = new Promise<void>((r) => { finish = r; });
    const jobs: Array<{ id: string; enabled: boolean }> = [];
    let first = true;
    w.provider.exec = async (runtime, argv, opts) => {
      if (argv[0] === 'cron' && argv[1] === 'list' && first) {
        first = false;
        const seen = [...jobs]; began(); await hold;
        return { code: 0, stdout: JSON.stringify({ jobs: seen }), stderr: '' };
      }
      if (argv[0] === 'cron' && argv[1] === 'list') return { code: 0, stdout: JSON.stringify({ jobs }), stderr: '' };
      if (argv[0] === 'cron' && argv[1] === 'add') { jobs.push({ id: 'fixture-task', enabled: true }); return { code: 0, stdout: '{"id":"fixture-task"}', stderr: '' }; }
      return original(runtime, argv, opts);
    };
    const sleeping = w.f.inject({ method: 'POST', url: `/v1/agents/${id}/hibernate`, headers: as() });
    await reading;
    const task = { name: 'Fixture reminder', message: 'Read the fixtures', everyMinutes: 15, announce: false };
    const refused = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/crons`, headers: as(), payload: task });
    expect(refused.statusCode).toBe(409);
    finish();
    expect((await sleeping).statusCode).toBe(200);
    expect(jobs).toEqual([]);
    expect(w.store.getAgent(id)!.state).toBe('STOPPED');
    // Awake again with a task: by hand is refused, saying why.
    w.store.setHibernated(id, null);
    w.store.setAgentState(id, 'RUNNING');
    await w.provider.start(w.store.getAgent(id)!.runtimeRef!);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/crons`, headers: as(), payload: task })).statusCode).toBe(201);
    const again = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/hibernate`, headers: as() });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/scheduled tasks of its own/);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
  });

  it('the idle sweep reads the tasks again under the lock: one added after its first read keeps the agent up', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    let reads = 0;
    const quiet = new Date(Date.now() - 10 * 3_600_000).toISOString();
    const deps: HibernateDeps = {
      store: w.store, secrets: w.secrets, providerFor: () => w.provider,
      lastActiveFor: async () => quiet,
      // The first read (the sweep's) finds none; a task is added before the stop.
      ownCrons: async () => (++reads === 1 ? [] : [{ enabled: true }]),
      isBusy: () => false, log: () => () => {},
    };
    expect(await hibernateSweep(deps, Date.now(), 3_600_000)).toEqual([]);
    expect(reads).toBe(2);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
    expect(w.store.getAgent(id)!.hibernatedAt).toBeFalsy();
  });
});

describe('a downloaded copy keeps its bot when the stopped original is deleted or archived (audit #099)', () => {
  const deps = (w: World) => ({ store: w.store, secrets: w.secrets, provider: w.provider, channel: w.channel, sleep: async () => {} });
  /** The real pool behind the world's channel; every call to Telegram is recorded, none is made. */
  function realPool(w: World) {
    const calls: string[] = [];
    const pool = new TelegramPoolProvisioner((w.store as unknown as { db: Database.Database }).db, w.secrets, {
      fetchImpl: (async (url: string) => { calls.push(String(url).split('/').at(-1)!); return new Response('{"ok":true,"result":true}', { headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch,
      renameBackoffMs: [],
    });
    w.channel.pool = pool;
    w.channel.release = (name: string, opts: unknown) => pool.release(name, opts as never);
    w.channel.provision = (req: unknown) => pool.provision(req as never);
    return { pool, calls };
  }
  async function movedByFile(kind: 'pool' | 'pasted') {
    const source = await world(), target = await world();
    const id = await seedRunningAgent(source, { accountId: 'kitchenfixturebot' });
    const { pool, calls } = realPool(source);
    if (kind === 'pool') {
      await pool.addToPool('kitchenpoolbot', 'fixture-pool-bot-value', source.owner);
      const chan = await pool.provision({ agentId: id, agentName: 'Kitchen', slug: 'kitchen', ownerId: source.owner });
      source.store.deleteChannelForAgent(id);
      source.store.insertChannel({ id: 'pooled', agentId: id, kind: 'telegram', accountId: chan.accountId, secretRef: chan.secretRef, deepLink: chan.deepLink, createdAt: 'now' });
    }
    const copy = await exportAgent(deps(source), id);
    const remote = await importAgent(deps(target), copy.data, { ownerId: target.owner });
    expect(remote.state).toBe('RUNNING');
    expect(source.store.getAgent(id)).toMatchObject({ state: 'STOPPED', exportedAt: expect.any(String) });
    calls.length = 0;
    return { source, id, pool, calls, bot: kind === 'pool' ? 'kitchenpoolbot' : 'kitchenfixturebot' };
  }
  const nextLease = (w: World, pool: TelegramPoolProvisioner) => pool.provision({ agentId: 'next', agentName: 'Next', slug: 'next', ownerId: w.owner });

  it('delete: a pool bot leaves the pool quietly instead of going to the next agent', async () => {
    const { source, id, pool, calls, bot } = await movedByFile('pool');
    const del = await source.f.inject({ method: 'DELETE', url: `/v1/agents/${id}`, headers: as() });
    expect(del.statusCode, del.body).toBe(200);
    expect(pool.availableCount(source.owner)).toBe(0);
    expect(pool.list().some((e) => e.username === bot)).toBe(false);
    await expect(nextLease(source, pool)).rejects.toThrow(/exhausted/);
    // No goodbye through a bot the copy is answering on.
    expect(calls).not.toContain('sendMessage');
  });

  it('delete with ?recycleBot=1: the owner asked, so it is parked for the next agent as before', async () => {
    const { source, id, pool, bot } = await movedByFile('pool');
    expect((await source.f.inject({ method: 'DELETE', url: `/v1/agents/${id}?recycleBot=1`, headers: as() })).statusCode).toBe(200);
    expect(pool.availableCount(source.owner)).toBe(1);
    expect((await nextLease(source, pool)).accountId).toBe(bot);
  });

  it('archive: neither a pasted bot nor a pool bot is parked or freed', async () => {
    for (const kind of ['pasted', 'pool'] as const) {
      const { source, id, pool, calls, bot } = await movedByFile(kind);
      await archiveAgent({ ...deps(source), log: () => {} }, id);
      expect(source.store.getAgent(id)!.state).toBe('ARCHIVED');
      expect(pool.availableCount(source.owner), kind).toBe(0);
      expect(pool.list().some((e) => e.username === bot), kind).toBe(false);
      await expect(nextLease(source, pool)).rejects.toThrow(/exhausted/);
      expect(calls, kind).not.toContain('sendMessage');
    }
  });
});

describe('an import clears conversations pinned to a runtime this machine does not configure (audit #100)', () => {
  it('a copy made on a machine-login source, imported onto an API key, answers at once', async () => {
    const source = await world(), target = await world();
    const deps = (w: World) => ({ store: w.store, secrets: w.secrets, provider: w.provider, channel: w.channel, sleep: async () => {} });
    const id = await seedRunningAgent(source);
    const ref = source.store.getAgent(id)!.runtimeRef!;
    source.store.insertAIProfile({ id: 'machine-login', ownerId: source.owner, name: 'Made-up machine login', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', createdAt: 'now' });
    source.store.setAgentAIProfile(id, 'machine-login');
    // The made-up state carries one conversation, pinned to the Claude CLI runtime.
    source.provider.stateStore.set(ref, Buffer.from(JSON.stringify({ runtime: 'claude-cli' })));
    let pin: string | null = null;
    const importState = target.provider.importState.bind(target.provider);
    target.provider.importState = async (r, data) => { pin = (JSON.parse(data.toString()) as { runtime: string }).runtime; await importState(r, data); };
    const exec = target.provider.exec.bind(target.provider);
    target.provider.exec = async (r, args, opts) => {
      const command = args.slice(0, 3).join(' ');
      if (command === 'gateway call sessions.list') return { code: 0, stdout: JSON.stringify({ sessions: [{ key: 'agent:kitchen:main', agentRuntime: pin, runtimeSelectionLocked: false }] }), stderr: '' };
      if (command === 'config get agents.defaults.models') return { code: 0, stdout: '{}', stderr: '' };
      if (command === 'gateway call sessions.patch') { pin = null; return { code: 0, stdout: '{"ok":true}', stderr: '' }; }
      // OpenClaw's answer for a stale CLI pin on a token source (docs/troubleshooting.md); nothing real is asked.
      if (args[0] === 'agent') return pin === 'claude-cli' ? { code: 1, stdout: '', stderr: 'Not logged in · Please run /login' } : { code: 0, stdout: 'made-up answer', stderr: '' };
      return exec(r, args, opts);
    };
    const copy = await exportAgent(deps(source), id);
    const remote = await importAgent(deps(target), copy.data, { ownerId: target.owner });
    expect(remote.state).toBe('RUNNING');
    expect(target.provider.lastSpec?.workspace.configPatch.authMode).toBe('api-key');
    expect(pin).toBeNull();
    expect((await target.provider.exec(remote.runtimeRef!, ['agent', '--agent', remote.slug, '-m', 'made-up question'])).code).toBe(0);
  });
});

describe('a first setup that fails after its volume was made leaves nothing behind (audit #101)', () => {
  const provisionDeps = (w: World) => ({ store: w.store, secrets: w.secrets, provider: w.provider, channel: w.channel, sleep: async () => {} });
  /** The provider makes its storage, then its seed fails: an ordinary rejected call, not a crash. */
  const failAfterStorage = (w: World) => {
    const provision = w.provider.provision.bind(w.provider);
    w.provider.provision = async (spec) => { await provision(spec); throw new Error('made-up seed failure after the volume'); };
  };

  it('the rollback purges the volume it made; Delete then has nothing left to find', async () => {
    const w = await world();
    const agent = createAgentRecord(w.store, { ownerId: w.owner, name: 'Made-up failed setup', aiProfileId: 'p1', hostId: 'h1' });
    w.store.setAgentWebOnly(agent.id, true);
    failAfterStorage(w);
    const made = w.provider.runtimeRefFor({ agentId: agent.id, slug: agent.slug });
    const result = await runProvisionSteps(provisionDeps(w), agent.id);
    expect(result.agent.state).toBe('FAILED');
    expect(w.provider.runtimes.get(made)?.purged).toBe(true);
    const del = await w.f.inject({ method: 'DELETE', url: `/v1/agents/${agent.id}`, headers: as() });
    expect(del.statusCode, del.body).toBe(200);
    expect(w.store.getAgent(agent.id)?.state).toBe('DELETED');
  });

  it('when the purge fails too, the agent keeps the ref, so Delete removes the volume', async () => {
    const w = await world();
    const agent = createAgentRecord(w.store, { ownerId: w.owner, name: 'Made-up stuck setup', aiProfileId: 'p1', hostId: 'h1' });
    w.store.setAgentWebOnly(agent.id, true);
    failAfterStorage(w);
    const made = w.provider.runtimeRefFor({ agentId: agent.id, slug: agent.slug });
    const destroy = w.provider.destroy.bind(w.provider);
    let refuse = true;
    w.provider.destroy = async (ref, opts) => { if (refuse) throw new Error('made-up docker hiccup'); return destroy(ref, opts); };
    expect((await runProvisionSteps(provisionDeps(w), agent.id)).agent.state).toBe('FAILED');
    expect(w.store.getAgent(agent.id)!.runtimeRef).toBe(made);
    expect(w.provider.runtimes.get(made)?.purged).toBe(false);
    refuse = false;
    expect((await w.f.inject({ method: 'DELETE', url: `/v1/agents/${agent.id}`, headers: as() })).statusCode).toBe(200);
    expect(w.provider.runtimes.get(made)?.purged).toBe(true);
  });

  it('a retry over an existing volume never purges it on a failure', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    w.store.setAgentState(id, 'FAILED', 'made-up earlier failure');
    failAfterStorage(w);
    expect((await runProvisionSteps(provisionDeps(w), id)).agent.state).toBe('FAILED');
    expect(w.provider.runtimes.get(ref)?.purged).toBe(false);
  });
});

describe('Verify now: disabled accounts in the pairing store, and an unreadable expected bot token (audits #102, #103)', () => {
  const STATE = '/home/node/.openclaw';
  const EXPECTED = 'fixture-expected-bot-value';
  /** The real probe, run in a VM over a made-up container: files by path, and a real SQLite pairing table. */
  function probe(script: string, cfg: object, pairing: Database.Database, files: Record<string, string>) {
    const m = /^HB_ACCESS_PROBE=([A-Za-z0-9+/=]+) node -e '([^']*)'$/.exec(script)!;
    const contents: Record<string, string> = { ...files, [`${STATE}/openclaw.json`]: JSON.stringify(cfg), [PAIRING_DB]: '' };
    const absent = () => Object.assign(new Error('made-up missing path'), { code: 'ENOENT' });
    const fs = {
      readFileSync(p: string) { if (p in contents) return contents[p]; throw absent(); },
      readdirSync(p: string) { if (p === `${STATE}/credentials`) return Object.keys(files).map((x) => nodePath.basename(x)); throw absent(); },
      statSync(p: string) { if (p in contents) return { isFile: () => true }; throw absent(); },
    };
    const modules: Record<string, unknown> = { fs, path: nodePath, crypto: nodeCrypto, 'node:sqlite': { DatabaseSync: class { prepare(sql: string) { return pairing.prepare(sql); } close() {} } } };
    let out = '';
    vm.runInNewContext(m[2]!, {
      require: (n: string) => { if (!(n in modules)) throw new Error(`module ${n} not in the made-up container`); return modules[n]; },
      process: { env: { HB_ACCESS_PROBE: m[1] }, stdout: { write: (x: string) => { out += x; } } }, Buffer,
    });
    return out;
  }
  async function accessWorld() {
    const db = new Database(':memory:');
    const store = new Store(db);
    const provider = new MockProvider();
    const owner = 'owner-fixture';
    store.insertHost({ id: 'host-fixture', ownerId: owner, kind: 'local', provider: 'mock', name: 'Fixture machine', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'profile-fixture', ownerId: owner, name: 'Fixture source', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'fixture-profile-ref', createdAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'agent-fixture', slug: 'garden-notes', workspace: { files: {}, configPatch: { agentId: 'garden-notes', authMode: 'api-key' } }, env: {} } as never);
    await provider.start(runtimeRef);
    store.insertAgent({ id: 'agent-fixture', ownerId: owner, name: 'Garden Notes', slug: 'garden-notes', state: 'RUNNING', aiProfileId: 'profile-fixture', hostId: 'host-fixture', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.insertChannel({ id: 'channel-fixture', agentId: 'agent-fixture', kind: 'discord', accountId: 'fixture-discord-account', secretRef: 'fixture-bot-ref', deepLink: 'https://example.invalid/bot', createdAt: 'now' });
    const secrets = { get: async (_ref: string): Promise<string> => EXPECTED, put: async () => {}, delete: async () => {} };
    const pairing = new Database(':memory:');
    pairing.exec('CREATE TABLE channel_pairing_allow_entries(channel_key TEXT, account_id TEXT, entry TEXT, sort_order INTEGER, updated_at INTEGER)');
    const cfg = { channels: { discord: { accounts: { hatchabot: { enabled: true, botToken: EXPECTED }, Retired: { enabled: false, botToken: 'fixture-retired-bot-value' } } } } };
    const files: Record<string, string> = {};
    provider.execShell = async (_ref, script) => {
      if (script.includes('gog auth list')) return { code: 0, stdout: '{"accounts":[]}', stderr: '' };
      if (script.startsWith('HB_ACCESS_PROBE=')) return { code: 0, stdout: probe(script, cfg, pairing, files), stderr: '' };
      throw new Error('a command the made-up container does not know');
    };
    const deps = { store, provider, secrets };
    const rows = () => accessOverview(store, store.getAgent('agent-fixture')!).groups.flatMap((g) => g.rows);
    const close = () => { pairing.close(); db.close(); };
    return { store, pairing, cfg, deps, rows, secrets, close };
  }

  it('#102: an approval kept only under a turned-off account admits nobody; one under the live account still does', async () => {
    const w = await accessWorld();
    try {
      w.store.insertMembership({ id: 'member-fixture', agentId: 'agent-fixture', userId: 'visitor-fixture', role: 'user', status: 'active' });
      expect(w.store.bindMemberIdentity('agent-fixture', 'visitor-fixture', 'discord', 'fixture-chat-user')).toBe(true);
      w.store.revokeMembership('agent-fixture', 'visitor-fixture');
      // The turned-off account, named in another case than its config key.
      w.pairing.prepare('INSERT INTO channel_pairing_allow_entries VALUES (?, ?, ?, 0, 1)').run('discord', 'retired', 'fixture-chat-user');
      await verifyAgentAccess(w.deps, 'agent-fixture');
      expect(w.store.listAccessChecks('agent-fixture').find((c) => c.kind === 'person')).toMatchObject({ present: false });
      expect(w.rows().find((r) => r.subject === 'visitor-fixture')).toBeUndefined();
      expect(accessOverview(w.store, w.store.getAgent('agent-fixture')!).summary.mismatches).toBe(0);
      // Still allowed by the account that runs: that is real access, and said so.
      w.pairing.prepare('INSERT INTO channel_pairing_allow_entries VALUES (?, ?, ?, 0, 1)').run('discord', 'hatchabot', 'fixture-chat-user');
      await verifyAgentAccess(w.deps, 'agent-fixture');
      expect(w.rows().find((r) => r.subject === 'visitor-fixture')).toMatchObject({ mismatch: 'extra' });
    } finally { w.close(); }
  });

  it('#103: an expected token that cannot be read keeps the difference found before, and says what it skipped', async () => {
    const w = await accessWorld();
    try {
      w.cfg.channels.discord.accounts.hatchabot.botToken = 'fixture-different-bot-value';
      await verifyAgentAccess(w.deps, 'agent-fixture');
      const before = w.rows().find((r) => r.kind === 'discord' && r.subject === 'hatchabot')!;
      expect(before).toMatchObject({ mismatch: 'differs', verified: { detail: 'differs' } });
      w.secrets.get = async () => { throw new Error('made-up temporary vault read failure'); };
      const checked = await verifyAgentAccess(w.deps, 'agent-fixture');
      expect(checked).toMatchObject({ status: 'checked' });
      expect((checked as { skipped?: string[] }).skipped?.join(' ')).toMatch(/discord bot hatchabot .*could not be read/);
      const after = w.rows().find((r) => r.kind === 'discord' && r.subject === 'hatchabot')!;
      expect(after).toMatchObject({ mismatch: 'differs', verified: { detail: 'differs', at: before.verified.at } });
      expect(accessOverview(w.store, w.store.getAgent('agent-fixture')!).summary.mismatches).toBe(1);
      // Readable again and the right bot running: the alert clears as before.
      w.secrets.get = async () => EXPECTED;
      w.cfg.channels.discord.accounts.hatchabot.botToken = EXPECTED;
      await verifyAgentAccess(w.deps, 'agent-fixture');
      expect(w.rows().find((r) => r.kind === 'discord' && r.subject === 'hatchabot')!.mismatch).toBeUndefined();
    } finally { w.close(); }
  });
});
