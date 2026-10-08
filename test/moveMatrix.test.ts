import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWorld, seedRunningAgent, as } from './support/world.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import type { EmbedderService } from '../src/embedder/embedder.js';

/**
 * Moves between machines whose OpenClaw versions and images differ: the
 * cases a laptop runner left on an old image meets (2026-10-07). Before
 * 2.147 none of these had a test: every move test ran one version on both
 * sides, and the version check across 2026.8 was inverted unseen. The same
 * cases run for real in scripts/runner-scenarios.mjs.
 *
 * h1 is this machine, h2 a runner. "old" = 2026.7 (an image with its own
 * memory search engine), "new" = 2026.9.8 (no engine: the machine's service).
 */

const OLD = '2026.7.1-2';
const NEW = '2026.9.8';

async function world() {
  const w = await makeWorld();
  const runner = new MockProvider();
  w.providers.set('mock2', runner);
  w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Laptop runner', settings: {}, createdAt: 'now' });
  const machine = (p: MockProvider, v: string) => { p.imageOpenclawVersion = v; p.imageEmbedEngine = v === OLD ? 'baked' : 'none'; };
  const embedderFor = (w.f as unknown as { embedderFor: (h: string | undefined) => EmbedderService }).embedderFor;
  // Each machine's memory search service as up (its start is covered in embedRunner.test.ts).
  const serviceUp = (hostId: string, door: string) => {
    const svc = embedderFor(hostId);
    Object.defineProperty(svc, 'enabled', { value: true, configurable: true });
    svc.status = async () => ({ embedder: 'running', door: 'running', doorAddress: door, enabled: true, modelPresent: true });
    svc.syncKeys = () => {};
    return svc;
  };
  const serviceStoppedByOwner = (hostId: string) => {
    const svc = embedderFor(hostId);
    Object.defineProperty(svc, 'enabled', { value: false, configurable: true });
    Object.defineProperty(svc, 'stoppedByOwner', { value: true, configurable: true });
  };
  /** An agent running `v` on `hostId`. */
  const agentOn = async (hostId: 'h1' | 'h2', v: string) => {
    const id = await seedRunningAgent(w);
    const p = hostId === 'h1' ? w.provider : runner;
    if (hostId === 'h2') {
      w.store.setAgentHost(id, 'h2');
      const { runtimeRef } = await runner.provision({ agentId: id, slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {} });
      w.store.setAgentRuntimeRef(id, runtimeRef);
      await runner.start(runtimeRef);
      runner.stateStore.set(runtimeRef, Buffer.from('the-agents-memory'));
    }
    p.infoOverride.set(w.store.getAgent(id)!.runtimeRef!, { openclawVersion: v });
    if (v === OLD) w.store.setAgentEmbedApplied(id, 'baked');
    return id;
  };
  const move = (id: string, hostId: string) => w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as(), payload: { hostId } });
  return { w, runner, machine, serviceUp, serviceStoppedByOwner, agentOn, move };
}

describe('moving between machines on different OpenClaw versions and images', () => {
  let prevDb: string | undefined;
  beforeEach(() => { prevDb = process.env.HATCHABOT_DB; process.env.HATCHABOT_DB = join(mkdtempSync(join(tmpdir(), 'hb-move-matrix-')), 'hatchabot.sqlite'); });
  afterEach(() => { if (prevDb === undefined) delete process.env.HATCHABOT_DB; else process.env.HATCHABOT_DB = prevDb; });

  it('a current agent onto a runner still on 2026.7: refused before anything is touched (2026.7 cannot read its data)', async () => {
    const m = await world();
    m.machine(m.w.provider, NEW); m.machine(m.runner, OLD);
    const id = await m.agentOn('h1', NEW);
    const r = await m.move(id, 'h2');
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/cannot read its data.*Install image/);
    const a = m.w.store.getAgent(id)!;
    expect([a.hostId, a.state]).toEqual(['h1', 'RUNNING']);
    expect(m.runner.lastSpec).toBeUndefined();
  });

  it('an old agent from the runner to this machine on 2026.9.8: moved, onto this machine\'s memory search (inverted check refused this before 2.147)', async () => {
    const m = await world();
    m.machine(m.w.provider, NEW); m.machine(m.runner, OLD);
    m.serviceUp('h1', '172.17.0.1:8093');
    const id = await m.agentOn('h2', OLD);
    const r = await m.move(id, 'h1');
    expect(r.statusCode).toBe(200);
    const a = m.w.store.getAgent(id)!;
    expect([a.hostId, a.state, a.appliedEmbedMode]).toEqual(['h1', 'RUNNING', 'shared']);
    expect(m.w.provider.lastSpec!.workspace.configPatch.embed?.baseUrl).toBe('http://172.17.0.1:8093/v1');
    expect(m.w.provider.lastSpec!.workspace.configPatch.openclawVersion).toBe(NEW);
    expect(m.w.store.embedTokenHost(id)).toBe('h1');
    // The memory came with it.
    expect(m.w.provider.stateStore.get(a.runtimeRef!)?.toString()).toBe('the-agents-memory');
  });

  it('a current agent to a runner on 2026.9.8: built on the RUNNER\'s service (its own door), key for the runner', async () => {
    const m = await world();
    m.machine(m.w.provider, NEW); m.machine(m.runner, NEW);
    m.serviceUp('h1', '172.17.0.1:8093');
    m.serviceUp('h2', '127.0.0.1:8093'); // Docker Desktop: loopback
    const id = await m.agentOn('h1', NEW);
    m.w.store.setEmbedToken(id, 'old-hash', 'h1');
    m.w.store.setAgentEmbedIndex(id, '2026-10-07T00:00:00Z', null);
    const r = await m.move(id, 'h2');
    expect(r.statusCode).toBe(200);
    expect(m.w.store.getAgent(id)!.hostId).toBe('h2');
    expect(m.runner.lastSpec!.workspace.configPatch.embed?.baseUrl).toBe('http://host.docker.internal:8093/v1');
    expect(m.w.store.embedTokenHost(id)).toBe('h2');
  });

  it('a current agent to a runner whose service its owner stopped: refused by the build, rolled back, still running here', async () => {
    const m = await world();
    m.machine(m.w.provider, NEW); m.machine(m.runner, NEW);
    m.serviceUp('h1', '172.17.0.1:8093');
    m.serviceStoppedByOwner('h2');
    const id = await m.agentOn('h1', NEW);
    const r = await m.move(id, 'h2');
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.json())).toMatch(/memory search/i);
    const a = m.w.store.getAgent(id)!;
    expect([a.hostId, a.state]).toEqual(['h1', 'RUNNING']);
  });

  it('versions unknown on either side: the move goes ahead (the build is the judge)', async () => {
    const m = await world();
    m.machine(m.runner, OLD);
    m.serviceUp('h1', '172.17.0.1:8093');
    const id = await m.agentOn('h1', 'mock');
    const r = await m.move(id, 'h2');
    expect(r.statusCode).toBe(200);
  });
});
