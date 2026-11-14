import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearBusy } from '../src/orchestrator/busy.js';
import { rebuildAgent } from '../src/orchestrator/provision.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

describe('event-trigger permissions reach the runtime (HB-0690)', () => {
  afterEach(() => { vi.unstubAllEnvs(); clearBusy('a1'); });
  const ready = async () => {
    vi.stubEnv('HATCHABOT_REBUILD_POLICY', 'manual');
    vi.stubEnv('HATCHABOT_READY_POLL_MS', '1');
    vi.stubEnv('HATCHABOT_READY_TIMEOUT_MS', '2000');
    const w = await makeWorld();
    await seedRunningAgent(w);
    w.store.setAgentCronTriggers('a1', true);
    return w;
  };
  const set = (w: World, on: boolean) => w.f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as(), payload: { cronTriggers: on } });

  it('a stopped agent stays stopped and Start rebuilds it with the saved permission', async () => {
    const w = await ready();
    const ref = w.store.getAgent('a1')!.runtimeRef!;
    await w.provider.stop(ref);
    w.store.setAgentState('a1', 'STOPPED');
    try {
      const changed = await set(w, false);
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json().cronTriggersPending).toMatch(/disabled when the agent next starts/);
      expect(w.store.getAgent('a1')).toMatchObject({ state: 'STOPPED', cronTriggers: false });
      expect(w.store.getAgent('a1')!.rebuildOnStart).toBeTruthy();
      expect(w.provider.execLog.filter((a) => a[2] === 'cron.triggers.enabled')).toHaveLength(0);
      const started = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/start', headers: as(), payload: {} });
      expect(started.statusCode, started.body).toBe(202);
      expect(started.json().rebuilding).toBe(true);
      await vi.waitFor(() => expect(w.store.getAgent('a1')!.rebuildOnStart).toBeUndefined(), { timeout: 5000 });
      expect(w.provider.lastSpec?.workspace.configPatch.cronTriggers).toBe(false);
    } finally { await w.f.close(); }
  });

  it.each(['refused', 'throwing'])('a %s live apply reports pending and leaves a durable retry obligation', async (failure) => {
    const w = await ready();
    const exec = w.provider.exec.bind(w.provider);
    w.provider.exec = async (ref, argv, opts) => {
      if (argv[2] === 'cron.triggers.enabled') {
        if (failure === 'throwing') throw new Error('fixture disconnect');
        return { code: 1, stdout: '', stderr: 'fixture refusal' };
      }
      return exec(ref, argv, opts);
    };
    try {
      const changed = await set(w, false);
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json().cronTriggersPending).toMatch(/may still use the old permission/);
      expect(w.store.getAgent('a1')).toMatchObject({ state: 'RUNNING', cronTriggers: false });
      expect(w.store.getAgent('a1')!.rebuildOnStart).toBeTruthy();
      const event = w.store.listEvents(['a1'], 50).find((e) => e.event === 'cron.triggers');
      expect(event?.detail).toMatchObject({ enabled: false, live: false });
    } finally { await w.f.close(); }
  });

  it('concurrent opposite toggles finish with the latest saved permission in the runtime', async () => {
    const w = await ready();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { entered = r; });
    const exec = w.provider.exec.bind(w.provider);
    const applied: string[] = [];
    w.provider.exec = async (ref, argv, opts) => {
      if (argv[2] === 'cron.triggers.enabled') {
        if (argv[3] === 'true') { entered(); await held; }
        applied.push(argv[3]!);
      }
      return exec(ref, argv, opts);
    };
    try {
      const first = Promise.resolve(set(w, true));
      await reached;
      // The permission is saved before its write finishes, with the retry
      // obligation already on disk if the service stops right here.
      expect(w.store.getAgent('a1')!.rebuildOnStart).toBeTruthy();
      const second = Promise.resolve(set(w, false));
      await vi.waitFor(() => expect(w.store.getAgent('a1')!.cronTriggers).toBe(false));
      expect(applied).toEqual([]);
      release();
      const answers = await Promise.all([first, second]);
      expect(answers.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(applied).toEqual(['true', 'false']);
      expect(answers[1]!.json().cronTriggersPending).toBeUndefined();
      expect(w.store.getAgent('a1')!.cronTriggers).toBe(false);
    } finally { release(); await w.f.close(); }
  });

  it('a successful live write clears its own obligation and preserves another change\'s', async () => {
    const w = await ready();
    try {
      expect((await set(w, false)).json().cronTriggersPending).toBeUndefined();
      expect(w.store.getAgent('a1')!.rebuildOnStart).toBeUndefined();
      const other = '2026-11-01T00:00:00.000Z';
      w.store.setRebuildOnStart('a1', other);
      expect((await set(w, true)).json().cronTriggersPending).toBeUndefined();
      expect(w.store.getAgent('a1')!.rebuildOnStart).toBe(other);
    } finally { await w.f.close(); }
  });

  it('refuses before storing if a rebuild rendered the old permission while another field was checked', async () => {
    const w = await ready();
    let releaseCap!: () => void, enteredCap!: () => void, releaseBuild!: () => void, enteredBuild!: () => void;
    const heldCap = new Promise<void>((r) => { releaseCap = r; });
    const capReached = new Promise<void>((r) => { enteredCap = r; });
    const heldBuild = new Promise<void>((r) => { releaseBuild = r; });
    const buildReached = new Promise<void>((r) => { enteredBuild = r; });
    const update = w.provider.updateMemory.bind(w.provider);
    let first = true;
    w.provider.updateMemory = async (...args) => {
      if (first) { first = false; enteredCap(); await heldCap; }
      return update(...args);
    };
    const provision = w.provider.provision.bind(w.provider);
    let rendered: boolean | undefined;
    w.provider.provision = async (spec) => {
      rendered = spec.workspace.configPatch.cronTriggers;
      enteredBuild(); await heldBuild;
      return provision(spec);
    };
    let rebuilding: Promise<unknown> | undefined;
    try {
      const changing = Promise.resolve(w.f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as(), payload: { cronTriggers: false, memoryCap: '4g' } }));
      await capReached;
      rebuilding = rebuildAgent({ store: w.store, secrets: w.secrets, provider: w.provider, channel: w.channel, sleep: async () => {} }, 'a1');
      await buildReached;
      releaseCap();
      const res = await changing;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatch(/event-trigger permission/);
      expect(w.store.getAgent('a1')!.cronTriggers).toBe(true);
      expect(w.store.getAgent('a1')!.memoryCap).toBeUndefined();
      releaseBuild();
      await rebuilding;
      expect(rendered).toBe(true);
      expect(w.store.getAgent('a1')!.cronTriggers).toBe(true);
    } finally { releaseCap(); releaseBuild(); await rebuilding; await w.f.close(); }
  });
});
