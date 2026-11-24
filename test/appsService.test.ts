import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { createAppsAndSources, type AppsAndSources } from '../src/orchestrator/apps/appsAndSources.js';
import { AppError, type Git } from '../src/orchestrator/apps/apps.js';
import { isBusy } from '../src/orchestrator/lifecycle/busy.js';
import { MAX_DATA_SOURCES } from '../src/orchestrator/apps/dataSourceLimits.js';
import { PUBLIC_REPO_READ_ONLY } from '../src/orchestrator/apps/gitSource.js';
import { beginOperation } from '../src/orchestrator/lifecycle/operations.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { Agent } from '../src/domain/types.js';

/**
 * The apps and data sources service (HB-0808): an agent's app and its git
 * repos and folders, driven as the routes drive them but with no HTTP
 * server. A real store on an in-memory database; a git that answers from a
 * made-up manifest (nothing is cloned or fetched); a secret store in memory
 * that can be held; a runtime provider that refuses every command, so
 * nothing here goes into an agent. Made-up data only.
 */
const OWNER = 'user-owner';
const MANIFEST = {
  app: 'demoapp',
  name: 'Demo App',
  tasks: [{ name: 'tick', every: '1m', command: ['python3', '-m', 'demo', 'tick'] }],
  connections: [{ kind: 'google', purpose: 'its mailbox', field: 'mailbox' }],
  config: { fields: [{ key: 'mailbox', label: 'its address', type: 'email', required: true }, { key: 'mode', default: 'shadow' }] },
  chat: 'cd {app_dir} for {agent}',
};
const SHA = 'a'.repeat(40);
/** A data source's place in the secret store, made at run time (no ref-shaped literal in the source). */
const dsRef = (id: string) => ['data-source', id].join('/');

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Resolves when `open()` is called: a step held until the test lets it go. */
function gate() {
  let open!: () => void;
  const shut = new Promise<void>((r) => { open = r; });
  return { shut, open: () => open() };
}

class HeldSecrets implements SecretStore {
  map = new Map<string, string>();
  /** A put waits for this, when set. */
  putGate?: Promise<void>;
  /** A get waits for this, when set. */
  getGate?: Promise<void>;
  async put(r: string, v: string) { await this.putGate; this.map.set(r, v); }
  async get(r: string) { await this.getGate; const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

interface World {
  store: Store;
  secrets: HeldSecrets;
  svc: AppsAndSources;
  /** The repo the fake git serves (a real folder, so a folder source exists). */
  repo: string;
  manifest: Record<string, unknown>;
  sha: string;
  /** Each git call, and a hook that may hold or fail it. */
  gitCalls: string[][];
  beforeGit?: (args: string[]) => Promise<void> | void;
  gitFails: boolean;
  gone: Set<string>;
  traced: string[];
  warned: string[];
  synced: string[];
  owns: boolean;
}

function world(): World {
  const db = new Database(':memory:');
  const store = new Store(db);
  const secrets = new HeldSecrets();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'remote', provider: 'mock', name: 'Laptop runner', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const w = {
    store, secrets, repo: tmp('hb-appsvc-repo-'), manifest: { ...MANIFEST }, sha: SHA,
    gitCalls: [], gitFails: false, gone: new Set(), traced: [], warned: [], synced: [], owns: true,
  } as unknown as World;
  const ok = (out: string) => ({ code: 0, stdout: Buffer.from(out), stderr: '' });
  const git: Git = async (args) => {
    w.gitCalls.push(args);
    await w.beforeGit?.(args);
    if (w.gitFails) return { code: 1, stdout: Buffer.from(''), stderr: 'fatal: made-up failure' };
    if (args.includes('rev-parse') && args.at(-1) === '--git-dir') return ok('.git\n');
    if (args.includes('--verify')) return ok(`${w.sha}\n`);
    if (args[2] === 'show') return ok(JSON.stringify(w.manifest));
    if (args.includes('archive')) return ok('tar');
    return { code: 1, stdout: Buffer.from(''), stderr: `unexpected git ${args.join(' ')}` };
  };
  const provider = { execShell: async () => { throw new Error('no agent here'); } };
  w.svc = createAppsAndSources({
    store, secrets,
    providerFor: (hostId) => { if (hostId !== 'h1' && hostId !== 'h2') throw new Error(`no host ${hostId}`); return provider as never; },
    trace: () => (event) => { w.traced.push(event); },
    agentGone: (id) => w.gone.has(id),
    appGit: git,
    appCacheDir: join(tmp('hb-appsvc-cache-'), 'app-sources'),
    warn: (_detail, event) => { w.warned.push(event); },
    channel: {} as never,
    withAgentsMdTurn: (_id, fn) => fn(),
    syncDocsHeld: async (a) => { w.synced.push(a.id); },
  });
  return w;
}

function agent(w: World, id: string, o: { name?: string; state?: Agent['state']; hostId?: string } = {}): Agent {
  const state = o.state ?? 'RUNNING';
  w.store.insertAgent({
    id, ownerId: OWNER, name: o.name ?? `Agent ${id}`, slug: id, state, aiProfileId: 'p1', hostId: o.hostId ?? 'h1',
    persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now', ...(state === 'RUNNING' ? { runtimeRef: `mock://${id}` } : {}),
  } as never);
  return w.store.getAgent(id)!;
}

describe('the apps', () => {
  it('inspect reads the manifest where it is, and fills the chat in for a new agent by its name', async () => {
    const w = world();
    const plain = await w.svc.installed.inspect(w.repo, 'HEAD', undefined);
    expect(plain).toMatchObject({ sha: SHA, ask: [expect.objectContaining({ key: 'mailbox' }), expect.objectContaining({ key: 'mode' })] });
    expect(plain.chat).toBeUndefined();
    const named = await w.svc.installed.inspect(w.repo, 'HEAD', 'Kitchen Helper');
    expect(named.chat).toContain('kitchen-helper');
    await expect(w.svc.installed.inspect('not a source', 'HEAD', undefined)).rejects.toBeInstanceOf(AppError);
  });

  it('a second copy of the app on the same account is refused before anything starts', async () => {
    const w = world();
    const a = agent(w, 'a1', { name: 'Kitchen' });
    agent(w, 'a2', { name: 'Garden', state: 'STOPPED' });
    w.store.insertConnection({ id: 'c1', ownerId: OWNER, kind: 'google', email: 'demo@example.org', services: [], secretRef: 'conn/c1' });
    w.store.attachConnection('a2', 'c1', false);
    w.store.setAgentApp({ agentId: 'a2', app: 'demoapp', source: w.repo, ref: 'HEAD', sha: SHA, manifest: MANIFEST, installedAt: 'now' });
    const err = await w.svc.installed.installFromSource(a, w.repo, 'HEAD', { mailbox: 'Demo@Example.org' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as { conflict?: string[] }).conflict).toEqual(['Garden']);
    expect((err as Error).message).toMatch(/Garden already runs Demo App on the same account/);
    // Nothing began: no operation, no busy flag, no record.
    expect(w.store.activeOperationFor('a1')).toBeUndefined();
    expect(isBusy('a1')).toBe(false);
    expect(w.store.getAgentApp('a1')).toBeUndefined();
  });

  it('a waiting install: its missing settings are named, it is saved for a stopped agent, and not for one deleted meanwhile', async () => {
    const w = world();
    const a = agent(w, 'a1', { state: 'STOPPED' });
    expect(await w.svc.installed.savePending(a, { source: w.repo, ref: 'HEAD', values: {}, allowShared: false })).toEqual({ missing: ['mailbox'] });
    expect(w.store.getAppPending('a1')).toBeUndefined();
    const saved = await w.svc.installed.savePending(a, { source: w.repo, ref: 'HEAD', values: { mailbox: 'demo@example.org' }, allowShared: true });
    expect(saved).toEqual({ saved: true, app: 'demoapp', name: 'Demo App' });
    expect(w.store.getAppPending('a1')).toMatchObject({ source: w.repo, ref: 'HEAD', values: { mailbox: 'demo@example.org', __allowShared: true } });
    expect(w.traced).toContain('app.pending');
    const b = agent(w, 'b1', { state: 'STOPPED' });
    w.gone.add('b1');
    expect(await w.svc.installed.savePending(b, { source: w.repo, ref: 'HEAD', values: { mailbox: 'demo@example.org' }, allowShared: false })).toEqual({ saved: false });
    expect(w.store.getAppPending('b1')).toBeUndefined();
  });

  it('a waiting install runs once per agent at a time, and a request saved while it runs goes in after it', async () => {
    const w = world();
    agent(w, 'a1');
    w.store.setAppPending('a1', { source: w.repo, ref: 'HEAD', values: { mailbox: 'first@example.org' } });
    const g = gate();
    let held = false;
    w.beforeGit = async () => { if (!held) { held = true; await g.shut; } };
    w.gitFails = true;
    const first = w.svc.installed.runPendingApp('a1');
    await new Promise((r) => setTimeout(r, 20));
    // A newer request, and the call setup makes for it: the run already under way looks again for it.
    w.store.setAppPending('a1', { source: w.repo, ref: 'HEAD', values: { mailbox: 'second@example.org' } });
    await w.svc.installed.runPendingApp('a1');
    expect(w.traced.filter((e) => e === 'app.install_failed')).toEqual([]);
    g.open();
    await first;
    // Each request ran once and failed; the newest keeps its failure for Try again.
    expect(w.traced.filter((e) => e === 'app.install_failed')).toHaveLength(2);
    expect(w.store.getAppPending('a1')).toMatchObject({ values: { mailbox: 'second@example.org' }, error: expect.stringMatching(/not a git repository/) });
  });

  it('a waiting install never rejects, even when the store fails, and can run again after', async () => {
    const w = world();
    agent(w, 'a1');
    (w.store as unknown as Record<string, unknown>).getAppPending = () => { throw new Error('SQLITE_FULL: made-up'); };
    await expect(w.svc.installed.runPendingApp('a1')).resolves.toBeUndefined();
    await expect(w.svc.installed.runPendingApp('a1')).resolves.toBeUndefined();
    expect(w.warned).toEqual(['app.pending_run_failed', 'app.pending_run_failed']);
  });

  it('an update with nothing new says so; a source that now holds another app is not installed as an update', async () => {
    const w = world();
    const a = agent(w, 'a1');
    w.store.setAgentApp({ agentId: 'a1', app: 'demoapp', source: w.repo, ref: 'HEAD', sha: SHA, manifest: MANIFEST, installedAt: 'now' });
    const had = w.store.getAgentApp('a1')!;
    expect(await w.svc.installed.update(a, had, { ref: undefined, values: undefined, allowShared: false, requestedBy: OWNER })).toEqual({ unchanged: true });
    w.sha = 'b'.repeat(40);
    w.manifest = { ...MANIFEST, app: 'otherapp' };
    expect(await w.svc.installed.update(a, had, { ref: null, values: null, allowShared: false, requestedBy: OWNER })).toEqual({ otherApp: 'otherapp', sha: 'b'.repeat(40) });
    expect(w.store.activeOperationFor('a1')).toBeUndefined();
    expect(w.store.getAgentApp('a1')!.sha).toBe(SHA);
  });

  it('a waiting install\'s manifest is read where it is on this machine, never fetched', async () => {
    const w = world();
    expect(await w.svc.installed.manifestHere(w.repo, 'HEAD')).toMatchObject({ app: 'demoapp' });
    const before = w.gitCalls.length;
    expect(await w.svc.installed.manifestHere('https://git.example.org/demo/app.git', 'HEAD')).toBeUndefined();
    expect(w.gitCalls.length).toBe(before);
  });

  it('the view is what the page shows, or null', () => {
    const w = world();
    const a = agent(w, 'a1');
    expect(w.svc.installed.appView(a)).toBeNull();
    w.store.setAgentApp({ agentId: 'a1', app: 'demoapp', source: w.repo, ref: 'HEAD', sha: SHA, manifest: MANIFEST, installedAt: 'now', testOk: true });
    expect(w.svc.installed.appView(a)).toEqual({ app: 'demoapp', name: 'Demo App', source: w.repo, ref: 'HEAD', sha: SHA, previousSha: null, installedAt: 'now', testOk: true, tasks: ['demoapp-tick'] });
  });
});

describe('the data sources', () => {
  const folder = (name: string) => { const d = join(tmp('hb-appsvc-data-'), name); mkdirSync(d); return d; };

  it('a folder: its path first, then the machine\'s owner, then this machine', async () => {
    const w = world();
    const a = agent(w, 'a1');
    const owner = () => w.owns;
    w.owns = false;
    expect(await w.svc.dataSources.add(a, { kind: 'folder', access: 'ro', path: '  ' }, owner)).toEqual({ refused: 'invalid', error: 'A folder path is required.' });
    expect(await w.svc.dataSources.add(a, { kind: 'folder', access: 'ro', path: folder('recipes') }, owner)).toEqual({ refused: 'machine-owner' });
    w.owns = true;
    const r = agent(w, 'r1', { name: 'Runner One', hostId: 'h2' });
    expect(await w.svc.dataSources.add(r, { kind: 'folder', access: 'ro', path: folder('recipes') }, owner))
      .toEqual({ refused: 'invalid', error: expect.stringMatching(/"Runner One" runs on another machine/) });
    const f = folder('recipes');
    expect(await w.svc.dataSources.add(a, { kind: 'folder', access: 'rw', path: f }, owner)).toBeUndefined();
    expect(w.store.listDataSources('a1')).toEqual([expect.objectContaining({ kind: 'folder', access: 'rw', mountName: 'recipes', hostPath: f })]);
    expect(await w.svc.dataSources.add(a, { kind: 'folder', access: 'ro', path: folder('recipes') }, owner))
      .toEqual({ refused: 'conflict', error: 'Another source already lives at /data/recipes. Rename or remove it first.' });
    const file = join(tmp('hb-appsvc-file-'), 'notes.txt');
    writeFileSync(file, 'x');
    expect(await w.svc.dataSources.add(a, { kind: 'folder', access: 'ro', path: file }, owner))
      .toEqual({ refused: 'invalid', error: `${file} is a file, not a folder. Give the folder it is in.` });
  });

  it('no more than the limit, counted before anything else', async () => {
    const w = world();
    const a = agent(w, 'a1');
    for (let i = 0; i < MAX_DATA_SOURCES; i++) {
      w.store.insertDataSource({ id: `d${i}`, agentId: 'a1', kind: 'git', access: 'ro', mountName: `repo${i}`, repoUrl: `https://git.example.org/o/repo${i}`, createdAt: 'now' });
    }
    expect(await w.svc.dataSources.add(a, { kind: 'folder', access: 'ro' }, () => false))
      .toEqual({ refused: 'conflict', error: `"${a.name}" already has ${MAX_DATA_SOURCES} data sources, the most one agent can hold. Remove one first.` });
  });

  it('a repo\'s name is held from the clash check to its row, across the key\'s save', async () => {
    const w = world();
    const a = agent(w, 'a1', { state: 'STOPPED' });
    const g = gate();
    w.secrets.putGate = g.shut;
    const first = w.svc.dataSources.add(a, { kind: 'git', access: 'ro', repoUrl: 'git@git.example.org:o/notes.git' }, () => false);
    await new Promise((r) => setTimeout(r, 20));
    expect(await w.svc.dataSources.add(a, { kind: 'git', access: 'ro', repoUrl: 'https://git.example.org/o/notes' }, () => false))
      .toEqual({ refused: 'conflict', error: 'Another source is already named "notes". Remove it first.' });
    g.open();
    expect(await first).toBeUndefined();
    const [row] = w.store.listDataSources('a1');
    expect(row).toMatchObject({ kind: 'git', mountName: 'notes', secretRef: dsRef(row!.id) });
    expect(w.secrets.map.has(row!.secretRef!)).toBe(true);
    // The hold went with the row: once the row is gone, the name is free again.
    w.store.deleteDataSource('a1', row!.id);
    w.secrets.putGate = undefined;
    expect(await w.svc.dataSources.add(a, { kind: 'git', access: 'ro', repoUrl: 'git@git.example.org:o/notes.git' }, () => false)).toBeUndefined();
  });

  it('an agent deleted while its key was saved keeps nothing', async () => {
    const w = world();
    const a = agent(w, 'a1', { state: 'STOPPED' });
    const g = gate();
    w.secrets.putGate = g.shut;
    const add = w.svc.dataSources.add(a, { kind: 'git', access: 'ro', repoUrl: 'git@git.example.org:o/notes.git' }, () => false);
    await new Promise((r) => setTimeout(r, 20));
    w.gone.add('a1');
    g.open();
    expect(await add).toEqual({ refused: 'gone' });
    expect(w.store.listDataSources('a1')).toEqual([]);
    expect([...w.secrets.map.keys()]).toEqual([]);
  });

  it('a public repo is read-only and has no key', async () => {
    const w = world();
    const a = agent(w, 'a1', { state: 'STOPPED' });
    expect(await w.svc.dataSources.add(a, { kind: 'git', access: 'rw', repoUrl: 'https://git.example.org/o/notes', public: true }, () => false))
      .toEqual({ refused: 'invalid', error: PUBLIC_REPO_READ_ONLY });
    expect(await w.svc.dataSources.add(a, { kind: 'git', access: 'ro', repoUrl: 'https://git.example.org/o/notes', public: true }, () => false)).toBeUndefined();
    expect(w.store.listDataSources('a1')).toEqual([expect.objectContaining({ kind: 'git', access: 'ro', mountName: 'notes' })]);
    expect(w.store.listDataSources('a1')[0]!.secretRef).toBeUndefined();
    expect([...w.secrets.map.keys()]).toEqual([]);
  });

  it('the Test button: one check of a repo at a time; a folder is looked at here', async () => {
    const w = world();
    const a = agent(w, 'a1');
    w.store.insertDataSource({ id: 'd1', agentId: 'a1', kind: 'git', access: 'ro', mountName: 'notes', repoUrl: 'git@git.example.org:o/notes.git', secretRef: dsRef('d1'), createdAt: 'now' });
    const src = w.store.getDataSource('a1', 'd1')!;
    const g = gate();
    w.secrets.getGate = g.shut;
    const first = w.svc.dataSources.check(a, src);
    await new Promise((r) => setTimeout(r, 20));
    expect(await w.svc.dataSources.check(a, src)).toEqual({ refused: 'conflict', error: 'This repo is being checked already.' });
    g.open();
    // No key stored (the made-up store has none): answered without reaching a git host.
    expect(await first).toMatchObject({ ok: false, message: 'This repo has no deploy key stored. Remove it and add it again.' });
    expect(w.traced).toContain('data_source.checked');
    // The check let go: another runs.
    w.secrets.getGate = undefined;
    expect(await w.svc.dataSources.check(a, src)).toMatchObject({ ok: false });
    w.store.insertDataSource({ id: 'd2', agentId: 'a1', kind: 'folder', access: 'ro', mountName: 'gone', hostPath: join(tmp('hb-appsvc-gone-'), 'nothing'), createdAt: 'now' });
    expect(await w.svc.dataSources.check(a, w.store.getDataSource('a1', 'd2')!)).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('removing: a folder waits for a move; a repo\'s scrub is recorded before its row goes', async () => {
    const w = world();
    const a = agent(w, 'a1');
    w.store.insertDataSource({ id: 'd1', agentId: 'a1', kind: 'folder', access: 'ro', mountName: 'recipes', hostPath: folder('recipes'), createdAt: 'now' });
    w.store.insertDataSource({ id: 'd2', agentId: 'a1', kind: 'git', access: 'ro', mountName: 'notes', repoUrl: 'git@git.example.org:o/notes.git', secretRef: dsRef('d2'), createdAt: 'now' });
    await w.secrets.put(dsRef('d2'), ['made', 'up'].join('-'));
    const op = beginOperation(w.store, 'move-host', 'a1', { toHostId: 'h2' });
    expect(await w.svc.dataSources.remove(a, w.store.getDataSource('a1', 'd1')!))
      .toEqual({ refused: 'conflict', error: 'Its move to another machine is not over. Remove folders once that finishes.' });
    expect(w.store.getDataSource('a1', 'd1')).toBeDefined();
    op.done('moved');
    const removed = await w.svc.dataSources.remove(a, w.store.getDataSource('a1', 'd2')!);
    expect(removed).toEqual({
      removedRepo: { repo: 'git@git.example.org:o/notes.git', scrubbed: expect.any(Boolean) },
      removedKey: { repo: 'git@git.example.org:o/notes.git', scrubbed: expect.any(Boolean) },
    });
    expect(w.store.getDataSource('a1', 'd2')).toBeUndefined();
    // Its key's private half is out of the secret store; its AGENTS.md is told now.
    expect(w.secrets.map.has(dsRef('d2'))).toBe(false);
    expect(w.synced).toEqual(['a1']);
    // A folder is only its row.
    expect(await w.svc.dataSources.remove(a, w.store.getDataSource('a1', 'd1')!)).toEqual({});
    expect(w.synced).toEqual(['a1']);
  });
});
