/**
 * The deep audit of v2.166.2 (2026-10-24), its moves group: host moves,
 * setup and rebuild recovery, archive and the Telegram pool, rebuild hooks,
 * refused rebuilds and the automatic rebuild sweep (audit #081–#095). Each
 * test asserts the corrected behaviour; the data is made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntimeSpec, rebuildAgent, recordApplied, runRebuildHook } from '../src/orchestrator/provision.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { beginOperation, newBootForTests, setStepHookForTests, SimulatedCrash } from '../src/orchestrator/operations.js';
import { resumeOperations, type ResumeContext } from '../src/orchestrator/operationsResume.js';
import { reconcileAgents } from '../src/orchestrator/reconcile.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { archiveAgent, ArchiveError } from '../src/orchestrator/archive.js';
import { TelegramPoolProvisioner } from '../src/channels/telegramPool.js';
import { migrateAgent, moveState, preflight, receiveMove } from '../src/orchestrator/migrate.js';
import { moveAgentToHost, recoverMoveHost, resumeMoveHost } from '../src/orchestrator/moveHost.js';
import { clearBusy } from '../src/orchestrator/busy.js';
import { scriptEnv } from './helpers/scriptEnv.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

const dirs: string[] = [];
const worlds: World[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  setStepHookForTests(undefined);
  for (const w of worlds.splice(0)) await w.f.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const world = async () => { const w = await makeWorld(); worlds.push(w); return w; };
const resumeCtx = (w: World): ResumeContext => ({
  store: w.store, secrets: w.secrets, channel: w.channel, sleep: async () => {}, providerForHost: () => w.provider,
});
/** The agent as a restart found it: still PROVISIONING, whatever its container did. */
const cutOffInSetup = (w: World, id: string) => (w.store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } })
  .db.prepare("UPDATE agents SET state = 'PROVISIONING' WHERE id = ?").run(id);
const tempDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

describe('the rebuild hook says when it failed (audit #088)', () => {
  /** The generated shell, run for real against a made-up hook in a sandbox. */
  const runWith = async (body: string) => {
    const root = tempDir('hook-');
    const hook = join(root, 'on-rebuild.sh');
    writeFileSync(hook, `#!/bin/bash\n${body}\n`);
    chmodSync(hook, 0o700);
    const provider = new MockProvider();
    provider.execShell = async (_ref, script) => {
      const r = spawnSync('/bin/bash', ['-c', script.replaceAll('/home/node/.openclaw/on-rebuild.sh', hook)], { env: scriptEnv(root, '/usr/bin:/bin'), encoding: 'utf8' });
      return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
    };
    const events: Array<[string, Record<string, unknown>]> = [];
    await runRebuildHook({ provider } as never, 'agent-a', 'mock://agent-a', (e, d) => events.push([e, d]));
    return events;
  };

  it('a hook that exits 7 with output is logged as failed, with its code', async () => {
    const events = await runWith('echo "made-up package install failed"\nexit 7');
    expect(events.map(([e]) => e)).toEqual(['rebuild_hook.failed']);
    expect(events[0]![1]).toMatchObject({ code: 7, output: expect.stringContaining('made-up package install failed') });
  });

  it('a silent failure is logged too, and a silent success is not', async () => {
    expect((await runWith('exit 3')).map(([e, d]) => [e, d.code])).toEqual([['rebuild_hook.failed', 3]]);
    expect(await runWith('exit 0')).toEqual([]);
    expect((await runWith('echo installed')).map(([e]) => e)).toEqual(['rebuild_hook.ran']);
  });
});

describe('a setup cut off after its runtime came up is finished, not just marked running (audit #082)', () => {
  it('its git source is cloned and its parked schedules go in, then it is RUNNING and the operation succeeded', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    cutOffInSetup(w, id);
    w.store.insertDataSource({ id: 'notes-repo', agentId: id, kind: 'git', access: 'ro', mountName: 'family-notes', repoUrl: 'https://example.com/household/family-notes.git', createdAt: 'now' });
    w.store.setPendingSchedules(id, [{ name: 'Weekly menu', message: 'Plan next week\'s dinners', cron: '0 9 * * 1', tz: 'UTC' }]);
    const op = beginOperation(w.store, 'provision', id, {});
    newBootForTests();
    await resumeOperations(resumeCtx(w));
    expect(w.store.getOperation(op.id)).toMatchObject({ status: 'succeeded' });
    expect(w.store.getAgent(id)?.state).toBe('RUNNING');
    expect(w.provider.execLog.some((a) => a[0] === 'sh' && String(a[1] ?? '').includes('clone'))).toBe(true);
    expect(w.store.listDataSources(id)[0]?.syncedAt).toBeTruthy();
    expect(w.store.getPendingSchedules(id)).toHaveLength(0);
  });
});

describe('a setup or rebuild cut off with a dead container is FAILED, not busy for good (audit #083)', () => {
  it('setup: the recovery fails the agent with a Retry, and reconcile has nothing left to judge', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    cutOffInSetup(w, id);
    w.provider.status = async () => ({ phase: 'error', message: 'container state: dead' });
    const op = beginOperation(w.store, 'provision', id, {});
    newBootForTests();
    await resumeOperations(resumeCtx(w));
    expect(w.store.getAgent(id)).toMatchObject({ state: 'FAILED', stateReason: expect.stringMatching(/Setup was interrupted .*dead.* tap Retry/) });
    expect(w.store.getOperation(op.id)?.status).toBe('failed');
  });

  it('rebuild: reconcile fails a REBUILDING agent whose container reports an error', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    w.store.setAgentState(id, 'REBUILDING');
    w.provider.status = async () => ({ phase: 'error', message: 'container state: dead' });
    await reconcileAgents(w.store, w.providers, () => {});
    expect(w.store.getAgent(id)).toMatchObject({ state: 'FAILED', stateReason: expect.stringMatching(/rebuild was interrupted .* tap Retry/) });
  });
});

describe('a paused container is not a stopped one (audit #084)', () => {
  /** A docker stand-in on its own path: `stop` refuses a paused container, as Docker does. */
  const pausedDocker = () => {
    const root = tempDir('paused-');
    const home = join(root, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', '/usr/bin:/bin');
    const docker = join(root, 'docker');
    writeFileSync(docker, `#!/bin/bash
case "$1" in
  stop) echo 'cannot stop container: container is paused, unpause it first' >&2; exit 1;;
  inspect) printf 'paused||\\n';;
esac
exit 0
`, { mode: 0o755 });
    return new LocalDockerProvider({ docker, image: 'test-image:latest' });
  };

  it('the provider reports it as an error, not stopped', async () => {
    expect(await pausedDocker().status('docker://hatchabot-kitchen-0000aa11')).toEqual({ phase: 'error', message: 'container state: paused' });
  });

  it('archive refuses to give its bot back while it is paused', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    w.store.setAgentRuntimeRef(id, 'docker://hatchabot-kitchen-0000aa11');
    const released: string[] = [];
    w.channel.release = async (accountId: string) => { released.push(accountId); };
    const err = await archiveAgent({ store: w.store, secrets: w.secrets, provider: pausedDocker(), channel: w.channel, log: () => {} }, id).catch((e) => e);
    expect(err).toBeInstanceOf(ArchiveError);
    expect(released).toEqual([]);
    expect(w.store.getAgent(id)?.state).toBe('RUNNING');
    expect(w.store.getChannelForAgent(id)?.accountId).toBe('kitchenbot');
  });
});

describe('archiving a pasted bot keeps a lease another agent took meanwhile (audit #089)', () => {
  it('the new lease stays, the bot is not spare, and its token cannot be removed', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    const telegram = async () => new Response(JSON.stringify({ ok: true, result: true }), { headers: { 'content-type': 'application/json' } });
    const pool = new TelegramPoolProvisioner((w.store as unknown as { db: never }).db, w.secrets, { fetchImpl: telegram as never, renameBackoffMs: [] });
    const add = pool.addToPool.bind(pool);
    // A create leases the bot the moment archive has parked it, before archive releases it.
    pool.addToPool = async (...a: Parameters<typeof pool.addToPool>) => {
      await add(...a);
      await pool.provision({ agentId: 'garden', agentName: 'Garden', slug: 'garden', ownerId: w.owner });
    };
    const channel = { pool, release: (accountId: string, opts?: never) => pool.release(accountId, opts) };
    await archiveAgent({ store: w.store, secrets: w.secrets, provider: w.provider, channel: channel as never, log: () => {} }, id);
    expect(w.store.getAgent(id)?.state).toBe('ARCHIVED');
    expect(pool.list().find((b) => b.username === 'kitchenbot')?.leasedTo).toBe('garden');
    expect(pool.availableCount(w.owner)).toBe(0);
    await expect(pool.removeFromPool('kitchenbot')).rejects.toThrow(/leased to an agent/);
    expect(await w.secrets.get('telegram/bot/kitchenbot')).toBe('bot-token-123');
  });

  it("a release named for the agent that holds the lease still ends it", async () => {
    const w = await world();
    const pool = new TelegramPoolProvisioner((w.store as unknown as { db: never }).db, w.secrets, { fetchImpl: (async () => new Response('{"ok":true}')) as never, renameBackoffMs: [] });
    await pool.addToPool('gardenbot', 'made-up-token', w.owner);
    await pool.provision({ agentId: 'garden', agentName: 'Garden', slug: 'garden', ownerId: w.owner });
    await pool.release('gardenbot', { reason: 'archived', agentId: 'garden' });
    expect(pool.availableCount(w.owner)).toBe(1);
  });
});

describe('an archive a restart cut off parks its Discord bot too (audit #093)', () => {
  it('the finish after the restart parks it for the agent and takes the row off', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    await w.secrets.put('chan/discord-kitchen', 'made-up-discord-credential');
    w.store.insertChannel({ id: 'c-discord', agentId: id, kind: 'discord', accountId: 'kitchen-discord-app', secretRef: 'chan/discord-kitchen', deepLink: 'https://discord.com', createdAt: 'now' });
    setStepHookForTests((_op, step) => { if (step === 'archived') throw new SimulatedCrash(); });
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/archive`, headers: as() })).statusCode).toBe(502);
    setStepHookForTests(undefined);
    newBootForTests();
    await w.routes!.resumeOperations();
    expect(w.store.listOperations([id])[0]).toMatchObject({ kind: 'archive', status: 'succeeded' });
    expect(w.store.getAgent(id)?.state).toBe('ARCHIVED');
    expect(w.store.getChannelForAgent(id, 'discord')).toBeUndefined();
    expect(w.store.discordBotArchivedFor(id, 'discord')?.applicationId).toBe('kitchen-discord-app');
  });

  it('a plain archive still parks it', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    await w.secrets.put('chan/discord-kitchen', 'made-up-discord-credential');
    w.store.insertChannel({ id: 'c-discord', agentId: id, kind: 'discord', accountId: 'kitchen-discord-app', secretRef: 'chan/discord-kitchen', deepLink: 'https://discord.com', createdAt: 'now' });
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/archive`, headers: as() })).statusCode).toBe(200);
    expect(w.store.getChannelForAgent(id, 'discord')).toBeUndefined();
    expect(w.store.discordBotArchivedFor(id, 'discord')?.applicationId).toBe('kitchen-discord-app');
  });
});

describe('a move to another Hatchabot (audit #090, #091)', () => {
  const peer = { id: 'peer-cabin', name: 'Cabin server', url: 'http://cabin.invalid', secretRef: 'peer/cabin' };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it("its preflight sends the version the agent runs, not this machine's newer default image", async () => {
    const source = await world(), destination = await world();
    const id = await seedRunningAgent(source);
    await source.secrets.put(peer.secretRef, 'made-up-peer-credential');
    source.provider.currentImageInfo = async () => ({ openclawVersion: '2026.10.1' });
    source.provider.info = async () => ({ openclawVersion: '2026.9.6' });
    const sent: Array<{ openclawVersion?: string }> = [];
    const peerFetch = async (url: string, init: { body?: string }) => {
      if (url.endsWith('/preflight')) {
        sent.push(JSON.parse(String(init.body)));
        return json(preflight(destination.store, destination.owner, JSON.parse(String(init.body)), { openclawVersion: '2026.9.6' }));
      }
      return json({ error: 'made-up refusal after the preflight' }, 400);
    };
    const err = await migrateAgent({ store: source.store, secrets: source.secrets, provider: source.provider, channel: source.channel, peerFetch: peerFetch as never, sleep: async () => {} }, id, peer).catch((e) => e);
    expect(sent[0]?.openclawVersion).toBe('2026.9.6');
    expect(String(err?.message)).not.toMatch(/older than the agent/);
  });

  it('a slug another agent holds there is not taken for this move while its own receipt says it is under way', async () => {
    const source = await world(), destination = await world();
    const id = await seedRunningAgent(source);
    await source.secrets.put(peer.secretRef, 'made-up-peer-credential');
    let receipt: ReturnType<typeof receiveMove> | undefined;
    const peerFetch = async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      if (url.endsWith('/preflight')) return json(preflight(destination.store, destination.owner, JSON.parse(String(init.body))));
      if (url.includes('/restore')) {
        // Meanwhile somebody made another agent with this slug there; the
        // import is still on its way when the proxy gives up on it.
        await seedRunningAgent(destination, { id: 'other-kitchen', slug: 'kitchen', accountId: 'otherkitchenbot', botToken: 'made-up-other-bot' });
        receipt = receiveMove(destination.store, init.headers?.['x-hatchabot-move'], destination.owner);
        return json({ error: 'made-up proxy timeout' }, 502);
      }
      if (url.includes('/moves/')) return json({ state: moveState(destination.store, url.split('/').at(-1)!, destination.owner) });
      if (url.endsWith('/agents')) return json(destination.store.listAllActiveAgents());
      throw new Error(`unexpected route ${url}`);
    };
    const err = await migrateAgent({ store: source.store, secrets: source.secrets, provider: source.provider, channel: source.channel, peerFetch: peerFetch as never, sleep: async () => {} }, id, peer).catch((e) => e);
    expect(String(err?.message)).toMatch(/couldn't confirm whether the agent arrived/);
    expect(source.store.getAgent(id)?.migratedTo).toBeUndefined();
    expect(source.store.listOperations([id])[0]?.status).toBe('held');
    expect(receipt).toBeDefined();
  });
});

describe('rebuilds (audit #092, #094, #095)', () => {
  it('a rebuild refused at render time keeps the agent running and its operation failed, not "Rebuilt"', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    w.store.insertAIProfile({ id: 'p2', ownerId: w.owner, name: 'No key yet', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-4-6', secretRef: 'ai/not-stored', createdAt: 'now' });
    w.store.setAgentAIProfile(id, 'p2');
    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: as() });
    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => expect(['failed', 'succeeded']).toContain(w.store.listOperations([id])[0]?.status));
    expect(w.store.listOperations([id])[0]).toMatchObject({ kind: 'rebuild', status: 'failed', outcome: expect.stringMatching(/^Not rebuilt: .*It keeps running as it was\.$/) });
    expect(w.store.getAgent(id)?.state).toBe('RUNNING');
  });

  it('a source edited during a slow build: the model the container was seeded with is recorded, and the edit stays pending', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    const deps = { store: w.store, secrets: w.secrets, channel: w.channel, provider: w.provider, sleep: async () => {} };
    await w.provider.provision(await buildRuntimeSpec(deps, id));
    recordApplied(w.store, id);
    const provision = w.provider.provision.bind(w.provider);
    let entered!: () => void, go!: () => void;
    const inProvision = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { go = r; });
    w.provider.provision = async (spec) => { entered(); await gate; return provision(spec); };
    const rebuilding = rebuildAgent(deps, id);
    await inProvision;
    const edit = await w.f.inject({ method: 'PATCH', url: '/v1/ai-profiles/p1', headers: as(), payload: { model: 'claude-sonnet-4-6' } });
    expect(edit.statusCode).toBe(200);
    go();
    await rebuilding;
    expect(w.provider.runtimes.get(ref)!.spec.workspace.configPatch.model).toBe('claude-opus-4-8');
    expect(w.store.getAgent(id)?.appliedModel).toBe('claude-opus-4-8');
    expect(w.store.getAIProfile('p1')?.model).toBe('claude-sonnet-4-6'); // wanted, not yet applied
  });

  it('the automatic sweep leaves an agent its owner stopped while it read the activity', async () => {
    vi.stubEnv('HATCHABOT_REBUILD_POLICY', 'required-only');
    const w = await world();
    const id = await seedRunningAgent(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    w.provider.infoOverride.set(ref, { onAgentNetwork: false }); // a required rebuild is due
    let entered!: () => void, go!: () => void, first = true;
    const reading = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { go = r; });
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (r, script, opts) => {
      if (first) { first = false; entered(); await gate; return { code: 0, stdout: '{}', stderr: '' }; }
      return shell(r, script, opts);
    };
    const sweeping = (w.f as unknown as { rebuildSweep(): Promise<string[]> }).rebuildSweep();
    await reading;
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/stop`, headers: as() })).statusCode).toBe(200);
    go();
    expect(await sweeping).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(w.store.listOperations([id]).filter((o) => o.kind === 'rebuild')).toEqual([]);
    expect(w.store.getAgent(id)?.state).toBe('STOPPED');
    expect((await w.provider.status(ref)).phase).toBe('stopped');
  });
});

describe('moving between machines on this Hatchabot (audit #081, #085, #086, #087)', () => {
  const runner = (w: World, n: string) => {
    w.store.insertHost({ id: `h${n}`, ownerId: w.owner, name: `Runner ${n}`, kind: 'cloud', provider: `mock${n}`, settings: {}, createdAt: 'now' });
    const p = new MockProvider();
    w.providers.set(`mock${n}`, p);
    return p;
  };
  const hasHookRun = (p: MockProvider) => p.execLog.some((c) => c[0] === 'sh' && String(c[1] ?? '').includes('on-rebuild.sh'));

  it('a move undone puts back the record of what the source runs: its AI source and model', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    const base = { store: w.store, secrets: w.secrets, channel: w.channel, provider: w.provider, sleep: async () => {} };
    await w.provider.provision(await buildRuntimeSpec(base, id));
    recordApplied(w.store, id);
    w.store.insertHost({ id: 'h2', ownerId: w.owner, name: 'Runner 2', kind: 'cloud', provider: 'mock2', settings: {}, createdAt: 'now' });
    w.store.insertAIProfile({ id: 'p2', ownerId: w.owner, name: 'Second source', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-4-6', secretRef: 'ai/p2', createdAt: 'now' });
    await w.secrets.put('ai/p2', 'made-up-second-credential');
    w.store.setAgentAIProfile(id, 'p2');
    const target = new MockProvider({ failOn: 'start' });
    await expect(moveAgentToHost({ ...base, source: w.provider, target }, id, 'h2')).rejects.toThrow(/rolled back/);
    expect(w.store.getAgent(id)).toMatchObject({ hostId: 'h1', state: 'RUNNING', aiProfileId: 'p2', appliedProfileId: 'p1', appliedModel: 'claude-opus-4-8' });
  });

  it('the machine a held move came from cannot be removed while Put back still needs it', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    runner(w, '2');
    const target = runner(w, '3');
    w.store.setAgentHost(id, 'h2');
    const base = { store: w.store, secrets: w.secrets, channel: w.channel, sleep: async () => {} };
    setStepHookForTests((_op, step) => { if (step === 'host-flipped') throw new SimulatedCrash(); });
    await expect(moveAgentToHost({ ...base, source: w.provider, target }, id, 'h3')).rejects.toBeInstanceOf(SimulatedCrash);
    setStepHookForTests(undefined);
    const op = w.store.listOperations([id])[0]!;
    const resume = { ...base, providerForHost: (h: string) => (w.store.getHost(h) ? (h === 'h3' ? target : w.provider) : undefined), answers: async () => false };
    await resumeMoveHost(resume, op.id);
    expect(w.store.getOperation(op.id)?.status).toBe('held');
    const removal = await w.f.inject({ method: 'DELETE', url: '/v1/hosts/h2', headers: as() });
    expect(removal.statusCode).toBe(409);
    expect(removal.json().error).toMatch(/move to or from this host is not over/);
    expect(w.store.getHost('h2')).toBeDefined();
    await recoverMoveHost(resume, op.id, 'put-back');
    expect(w.store.getOperation(op.id)?.status).toBe('rolled_back');
    expect(w.store.getAgent(id)).toMatchObject({ hostId: 'h2', state: 'RUNNING' });
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/hosts/h3', headers: as() })).statusCode).toBe(200);
  });

  it('a drop-pin move a restart undid keeps its image pin', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    w.store.setAgentImage(id, 'hatchabot-runtime:2026.7.1-2-plus-jq');
    const target = runner(w, '2');
    let reached!: () => void;
    const provisioning = new Promise<void>((r) => { reached = r; });
    // The process dies during the remote provision: this call never returns.
    target.provision = async () => { reached(); return new Promise<never>(() => {}); };
    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as(), payload: { hostId: 'h2', dropPin: true } });
    expect(res.statusCode).toBe(202);
    await provisioning;
    expect(w.store.getAgent(id)?.image).toBeUndefined(); // dropped for the move…
    clearBusy(id);
    newBootForTests();
    await w.routes!.resumeOperations();
    expect(w.store.listOperations([id])[0]?.status).toBe('rolled_back');
    expect(w.store.getAgent(id)).toMatchObject({ hostId: 'h1', state: 'RUNNING', image: 'hatchabot-runtime:2026.7.1-2-plus-jq' }); // …and back with it undone
  });

  it('a drop-pin move that fails in one go keeps its pin, and one that lands drops it', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    w.store.setAgentImage(id, 'hatchabot-runtime:2026.7.1-2-plus-jq');
    w.store.insertHost({ id: 'h2', ownerId: w.owner, name: 'Runner 2', kind: 'cloud', provider: 'mock2', settings: {}, createdAt: 'now' });
    w.providers.set('mock2', new MockProvider({ failOn: 'start' }));
    const failed = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2', dropPin: true } });
    expect(failed.statusCode).toBe(400);
    expect(w.store.getAgent(id)).toMatchObject({ hostId: 'h1', image: 'hatchabot-runtime:2026.7.1-2-plus-jq' });
    w.providers.set('mock2', new MockProvider());
    const moved = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2', dropPin: true } });
    expect(moved.statusCode).toBe(200);
    expect(w.store.getAgent(id)?.hostId).toBe('h2');
    expect(w.store.getAgent(id)?.image ?? null).toBeNull();
  });

  it('an agent moved while stopped stays stopped, and runs its rebuild hook when it is next started', async () => {
    vi.stubEnv('HATCHABOT_REBUILD_POLICY', 'manual');
    const w = await world();
    const id = await seedRunningAgent(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    await w.provider.stop(ref);
    w.store.setAgentState(id, 'STOPPED');
    const target = runner(w, '2');
    const moved = await moveAgentToHost({ store: w.store, secrets: w.secrets, channel: w.channel, source: w.provider, target, sleep: async () => {} }, id, 'h2');
    expect(moved.state).toBe('STOPPED');
    expect(hasHookRun(target)).toBe(false);
    expect(w.store.getAgent(id)?.rebuildHookDue).toBeTruthy();
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() })).statusCode).toBe(200);
    await vi.waitFor(() => expect(hasHookRun(target)).toBe(true));
    await vi.waitFor(() => expect(w.store.getAgent(id)?.rebuildHookDue).toBeUndefined());
  });

  it('a running agent moved runs its hook on the way, and owes nothing', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    const target = runner(w, '2');
    await moveAgentToHost({ store: w.store, secrets: w.secrets, channel: w.channel, source: w.provider, target, sleep: async () => {} }, id, 'h2');
    expect(hasHookRun(target)).toBe(true);
    expect(w.store.getAgent(id)?.rebuildHookDue).toBeUndefined();
  });
});
