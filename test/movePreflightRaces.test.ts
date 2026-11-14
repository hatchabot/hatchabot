import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../src/providers/mockProvider.js';
import { as, makeWorld, seedRunningAgent } from './support/world.js';

describe('a host move keeps the configuration its preflight checked', () => {
  for (const boundary of ['image', 'daemon'] as const) {
  it.each(['shared folder', 'folder source', 'image pin', 'AI source'] as const)(`refuses a changed %s while the target ${boundary} is checked (HB-0709)`, async (changed) => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    const target = new MockProvider();
    w.providers.set('mock-target', target);
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock-target', name: 'Runner', settings: {}, createdAt: 'now' });
    const stop = vi.spyOn(w.provider, 'stop');
    const provision = vi.spyOn(target, 'provision');
    const image = target.currentImageInfo.bind(target);
    const daemon = target.daemonId.bind(target);
    w.store.insertAIProfile({ id: 'p2', ownerId: w.owner, name: 'Second key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p2', createdAt: 'now' });
    let changedOnce = false;
    const change = () => {
      if (!changedOnce) {
        changedOnce = true;
        if (changed === 'shared folder') w.store.setAgentSharedPaths(id, ['/srv/notes']);
        if (changed === 'folder source') w.store.insertDataSource({ id: 'folder-notes', agentId: id, kind: 'folder', access: 'ro', mountName: 'notes', hostPath: '/srv/notes', createdAt: 'now' });
        if (changed === 'image pin') w.store.setAgentImage(id, 'fixture-runtime:custom');
        if (changed === 'AI source') w.store.setAgentAIProfile(id, 'p2');
      }
    };
    if (boundary === 'image') target.currentImageInfo = async (...args) => { change(); return image(...args); };
    else target.daemonId = async () => { change(); return daemon(); };
    try {
      const response = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2' } });
      expect(changedOnce).toBe(true);
      if (changed === 'folder source') expect(w.store.listDataSources(id)).toHaveLength(1);
      expect(response.statusCode, response.body).toBe(boundary === 'image' ? 409 : 400);
      expect(w.store.getAgent(id)?.hostId).toBe('h1');
      expect((await w.provider.status(ref)).phase).toBe('running');
      expect(stop).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
    } finally { await w.f.close(); }
  });
  }

  it.each([
    { setting: 'image', finish: false }, { setting: 'folder', finish: false }, { setting: 'folder', finish: true },
  ])('refuses a delayed $setting PATCH after a move starts (finished: $finish), before storing any of its fields', async ({ setting, finish }) => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const folder = mkdtempSync(join(tmpdir(), 'move-patch-'));
    const target = new MockProvider();
    w.providers.set('mock-target', target);
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock-target', name: 'Runner', settings: {}, createdAt: 'now' });
    let capReached!: () => void, releaseCap!: () => void, moveReached!: () => void, releaseMove!: () => void;
    const capWaiting = new Promise<void>((r) => { capReached = r; });
    const capGate = new Promise<void>((r) => { releaseCap = r; });
    const moveWaiting = new Promise<void>((r) => { moveReached = r; });
    const moveGate = new Promise<void>((r) => { releaseMove = r; });
    const update = w.provider.updateMemory.bind(w.provider);
    let first = true;
    w.provider.updateMemory = async (...args) => {
      await update(...args);
      if (first) { first = false; capReached(); await capGate; }
    };
    const stop = w.provider.stop.bind(w.provider);
    w.provider.stop = async (ref) => { moveReached(); await moveGate; return stop(ref); };
    let moving: Promise<unknown> | undefined;
    const changing = Promise.resolve(w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(),
      payload: { memoryCap: '4g', ...(setting === 'image' ? { image: 'fixture-runtime:custom' } : { sharedPaths: [folder] }) } }));
    try {
      await capWaiting;
      moving = Promise.resolve(w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2' } }));
      await moveWaiting;
      if (finish) { releaseMove(); await moving; }
      releaseCap();
      const response = await changing;
      expect(response.statusCode, response.body).toBe(finish ? 400 : 409);
      expect(response.json().error).toMatch(finish ? /another machine now/ : /move to another machine is not over/);
      expect(w.store.getAgent(id)).toMatchObject({ hostId: finish ? 'h2' : 'h1' });
      expect(w.store.getAgent(id)?.image).toBeUndefined();
      expect(w.store.getAgent(id)?.sharedPaths).toBeUndefined();
      expect(w.store.getAgent(id)?.memoryCap).toBeUndefined();
    } finally {
      releaseCap(); releaseMove();
      await changing; await moving; await w.f.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('refuses a folder data source while a move is already stopping the local runtime', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const folder = mkdtempSync(join(tmpdir(), 'move-folder-'));
    const target = new MockProvider();
    w.providers.set('mock-target', target);
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock-target', name: 'Runner', settings: {}, createdAt: 'now' });
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const stop = w.provider.stop.bind(w.provider);
    w.provider.stop = async (ref) => { entered(); await gate; return stop(ref); };
    const moving = Promise.resolve(w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2' } }));
    try {
      await waiting;
      const add = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/data-sources`, headers: as(), payload: { kind: 'folder', access: 'ro', path: folder } });
      expect(add.statusCode, add.body).toBe(409);
      expect(w.store.listDataSources(id)).toEqual([]);
      release();
      const moved = await moving;
      expect(moved.statusCode, moved.body).toBe(200);
      expect(w.store.getAgent(id)?.hostId).toBe('h2');
    } finally { release(); await moving; await w.f.close(); rmSync(folder, { recursive: true, force: true }); }
  });

  it.each(['PATCH', 'DELETE'] as const)('refuses folder %s after a move rendered its mounts', async (method) => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    w.store.insertDataSource({ id: 'notes', agentId: id, kind: 'folder', access: 'ro', mountName: 'notes', hostPath: '/srv/notes', createdAt: 'now' });
    const target = new MockProvider();
    w.providers.set('mock-target', target);
    // Another local daemon sees the same host folders; unlike a runner,
    // moving here is permitted with the existing folder attached.
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'local', provider: 'mock-target', name: 'Other local daemon', settings: {}, createdAt: 'now' });
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const provision = target.provision.bind(target);
    let first = true;
    target.provision = async (spec) => { if (first) { first = false; entered(); await gate; } return provision(spec); };
    const moving = Promise.resolve(w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2' } }));
    try {
      await waiting;
      const change = await w.f.inject({ method, url: `/v1/agents/${id}/data-sources/notes`, headers: as(), ...(method === 'PATCH' ? { payload: { access: 'rw' } } : {}) });
      expect(change.statusCode, change.body).toBe(409);
      expect(w.store.getDataSource(id, 'notes')).toMatchObject({ hostPath: '/srv/notes', access: 'ro' });
      release();
      const moved = await moving;
      expect(moved.statusCode, moved.body).toBe(200);
    } finally { release(); await moving; await w.f.close(); }
  });
});
