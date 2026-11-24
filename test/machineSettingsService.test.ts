import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Agent } from '../src/domain/types.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { ProviderError } from '../src/providers/provider.js';
import { SecretNotFoundError, type SecretStore } from '../src/secrets/secretStore.js';
import { Store } from '../src/store/store.js';
import { MEDIA_KEY_REF, SEARCH_KEY_REF } from '../src/orchestrator/lifecycle/provision.js';
import { OWN_BRAVE, SEARCH_CHECKS } from '../src/orchestrator/settings/searchUsage.js';
import { AGENT_SEARCH_TEST_ARGV } from '../src/orchestrator/settings/webSearch.js';
import { createMachineSettings, type MachineSettings, type MachineSettingsDeps } from '../src/orchestrator/settings/machineSettings.js';

/**
 * The machine settings service (HB-0808 step 15 part A), driven as the
 * routes drive it but with no HTTP server: a real store on an in-memory
 * database, a mock machine, secrets in memory, and Brave and DuckDuckGo
 * played by a stubbed fetch. Made-up data only; every key is built at run
 * time and looks like no real provider's.
 */
const OWNER = 'user-owner';
const madeUpKey = (what: string) => ['made', 'up', what, 'value'].join('-');

/** Secrets in memory that say "not found" as the real store does. */
class Secrets implements SecretStore {
  map = new Map<string, string>();
  reads: string[] = [];
  failDelete = false;
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) {
    this.reads.push(ref);
    const v = this.map.get(ref);
    if (v === undefined) throw new SecretNotFoundError(ref);
    return v;
  }
  async delete(ref: string) { if (this.failDelete) throw new Error('refused'); this.map.delete(ref); }
}

interface World {
  store: Store;
  secrets: Secrets;
  provider: MockProvider;
  svc: MachineSettings;
  warned: Array<{ detail: Record<string, unknown>; msg: string }>;
  traced: string[];
  notes: string[];
  docsSynced: string[];
  filesCaps: Array<{ agentId: string; only?: string }>;
  limitsTurns: string[];
  restarts: number;
  /** What Brave answers: a status and its quota headers. */
  brave: { status: number; remaining?: number; limit?: number };
  braveAsked: number;
  agent(id: string, o?: Partial<Agent>): Promise<Agent>;
}

function world(over: Partial<MachineSettingsDeps> = {}): World {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const secrets = new Secrets();
  const provider = new MockProvider();
  const w = {
    store, secrets, provider, warned: [], traced: [], notes: [], docsSynced: [], filesCaps: [], limitsTurns: [], restarts: 0,
    brave: { status: 200, remaining: 900, limit: 1000 }, braveAsked: 0,
  } as unknown as World;
  const searchFetch = (async (url: string) => {
    if (String(url).includes('brave')) {
      w.braveAsked++;
      const h: Record<string, string> = {};
      if (w.brave.remaining !== undefined) h['x-ratelimit-remaining'] = String(w.brave.remaining);
      if (w.brave.limit !== undefined) h['x-ratelimit-limit'] = String(w.brave.limit);
      return new Response('{}', { status: w.brave.status, headers: h });
    }
    return new Response('<a class="result__a">a result</a>', { status: 200 });
  }) as unknown as typeof fetch;
  w.svc = createMachineSettings({
    store, secrets,
    providerFor: () => provider,
    isBusy: () => false,
    trace: () => (event) => { w.traced.push(event); },
    notify: (headline) => { w.notes.push(headline); },
    info: () => {},
    warn: (detail, msg) => { w.warned.push({ detail, msg }); },
    searchFetch,
    tickEveryMs: 0,
    recheckOn: () => true,
    inLimitsTurn: async (agentId, fn) => { w.limitsTurns.push(agentId); return fn(); },
    syncDocsHeld: async (a) => { w.docsSynced.push(a.id); },
    applyFilesCap: async (a, only) => { w.filesCaps.push({ agentId: a.id, ...(only ? { only } : {}) }); return { applied: 1, gone: false }; },
    embedder: () => ({ enabled: true, external: undefined, restart: async () => { w.restarts++; } }),
    ...over,
  });
  w.agent = async (id, o = {}) => {
    const { runtimeRef } = await provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: {} }, env: {} } as never);
    store.insertAgent({
      id, ownerId: OWNER, name: `Agent ${id}`, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      runtimeRef, persona: '', sharedMemory: false, webOnly: true, createdAt: 'now', updatedAt: 'now', ...o,
    } as never);
    return store.getAgent(id)!;
  };
  return w;
}

const owner = { ownsMachine: () => true, ownerId: () => OWNER };
const member = { ownsMachine: () => false, ownerId: () => 'user-member' };

describe('the fleet keys', () => {
  it('saves a key, says only whether it is set, shows it to the machine owner alone, and removes it', async () => {
    const w = world();
    expect(await w.svc.keys.isSet('media')).toBe(false);
    const gemini = madeUpKey('gemini');
    await w.svc.keys.save('media', gemini);
    expect(w.secrets.map.get(MEDIA_KEY_REF)).toBe(gemini);
    // A read is a yes or no: never the key.
    const set = await w.svc.keys.isSet('media');
    expect(set).toBe(true);
    expect(JSON.stringify(set)).not.toContain(gemini);
    // Anyone else is refused before the key is read, and nothing is logged.
    w.secrets.reads.length = 0;
    expect(await w.svc.keys.reveal('media', member)).toEqual({ ok: false, why: 'machine-owner' });
    expect(w.secrets.reads).toEqual([]);
    expect(w.warned).toEqual([]);
    // The owner sees it, and the reveal is logged with who asked, never the key.
    expect(await w.svc.keys.reveal('media', owner)).toEqual({ ok: true, key: gemini });
    expect(w.warned).toEqual([{ detail: { ownerId: OWNER }, msg: 'media.key_revealed' }]);
    expect(JSON.stringify(w.warned)).not.toContain(gemini);
    await w.svc.keys.remove('media');
    expect(await w.svc.keys.isSet('media')).toBe(false);
    expect(await w.svc.keys.reveal('media', owner)).toEqual({ ok: false, why: 'none' });
  });

  it('keeps the two keys apart, and a removal the store refuses is said, not thrown, and the key stays (HB-0918)', async () => {
    const w = world();
    const brave = madeUpKey('brave');
    await w.svc.keys.save('search', brave);
    expect(w.secrets.map.get(SEARCH_KEY_REF)).toBe(brave);
    expect(await w.svc.keys.isSet('media')).toBe(false);
    expect(await w.svc.keys.reveal('search', owner)).toEqual({ ok: true, key: brave });
    expect(w.warned.at(-1)?.msg).toBe('search.key_revealed');
    w.secrets.failDelete = true;
    await expect(w.svc.keys.remove('search')).resolves.toEqual({ ok: false, error: 'refused' });
    expect(w.warned.at(-1)).toEqual({ detail: { which: 'search', error: 'refused' }, msg: 'search.key_not_removed' });
    expect(await w.svc.keys.isSet('search')).toBe(true);
  });

  it('a key that cannot be read is "not set", and not shown', async () => {
    const w = world();
    w.secrets.get = async () => { throw new Error('the store is locked'); };
    expect(await w.svc.keys.isSet('search')).toBe(false);
    expect(await w.svc.keys.reveal('search', owner)).toEqual({ ok: false, why: 'none' });
  });
});

describe('web search', () => {
  it('a search key saved puts the fleet on Brave and reaches the running agents as its hash only', async () => {
    const w = world();
    await w.agent('a1');
    const brave = madeUpKey('brave');
    await w.svc.keys.save('search', brave);
    // The recheck runs in the background: wait for it and for the pass over the agents.
    await vi.waitFor(() => expect(w.svc.search.watch.state().checkedAt).toBeDefined());
    await w.svc.search.watch.idle();
    const view = await w.svc.search.view();
    expect(view.active).toBe('brave');
    expect(view.keySet).toBe(true);
    expect(view.moving).toBe(false);
    expect(JSON.stringify(view)).not.toContain(brave);
    const hash = createHash('sha256').update(brave).digest('hex');
    expect(w.provider.secretShells.some((s) => s.includes(hash))).toBe(true);
    expect(w.provider.secretShells.some((s) => s.includes(brave))).toBe(false);
    // Removed: back on DuckDuckGo, with the reason.
    await w.svc.keys.remove('search');
    await vi.waitFor(async () => expect((await w.svc.search.view()).active).toBe('duckduckgo'));
    expect((await w.svc.search.view()).why).toBe('No Brave key is set.');
  });

  it('a key change is not checked at once where that is off (the tests\' real Brave)', async () => {
    const w = world({ recheckOn: () => false });
    await w.svc.keys.save('search', madeUpKey('brave'));
    await new Promise((r) => setTimeout(r, 20));
    expect(w.braveAsked).toBe(0);
  });

  it('a check chooses the provider: Brave with quota, DuckDuckGo once Brave is out or when chosen', async () => {
    const w = world({ recheckOn: () => false });
    await w.secrets.put(SEARCH_KEY_REF, madeUpKey('brave'));
    expect((await w.svc.search.check()).active).toBe('brave');
    // Spent one query, counted with Hatchabot's checks.
    const hours = w.store.searchHours('0000', '9999');
    expect(hours.some((h) => h.agentId === SEARCH_CHECKS && h.provider === 'brave')).toBe(true);
    w.brave = { status: 402 };
    const out = await w.svc.search.check();
    expect(out.active).toBe('duckduckgo');
    expect(out.why).toBe('The Brave key has run out of quota.');
    expect(w.notes).toContain('Web search moved to DuckDuckGo');
    w.brave = { status: 200, remaining: 900, limit: 1000 };
    expect((await w.svc.search.check()).active).toBe('brave');
    const chose = await w.svc.search.set({ mode: 'duckduckgo' });
    expect(chose).toMatchObject({ mode: 'duckduckgo', active: 'duckduckgo', why: 'You chose DuckDuckGo.' });
  });

  it('a price alone is saved and answered with the usage', async () => {
    const w = world({ recheckOn: () => false });
    const out = await w.svc.search.set({ price: { per1000: 3, monthlyCredit: 1 } });
    expect(out).toMatchObject({ price: { per1000: 3, monthlyCredit: 1 }, keySet: false });
    expect(await w.svc.search.usage()).toMatchObject({ price: { per1000: 3, monthlyCredit: 1 } });
    expect(w.braveAsked).toBe(0);
  });
});

describe('an agent\'s search test', () => {
  it('runs a real search in the agent and counts it under the provider that answered', async () => {
    const w = world({ recheckOn: () => false });
    const a = await w.agent('a1');
    w.provider.execResponses.set(AGENT_SEARCH_TEST_ARGV.join(' '), { code: 0, stdout: JSON.stringify({ ok: true, provider: 'duckduckgo', outputs: [{ result: { count: 1 } }] }), stderr: '' });
    const out = await w.svc.search.agentTest(a as Agent & { runtimeRef: string });
    expect(out).toEqual({ ok: true, provider: 'duckduckgo', results: 1, detail: 'Search works: DuckDuckGo answered.' });
    expect(w.provider.execOpts.at(-1)).toEqual({ timeoutMs: 120_000 });
    expect(w.store.searchHours('0000', '9999').some((h) => h.agentId === SEARCH_CHECKS && h.provider === 'duckduckgo')).toBe(true);
    expect(w.traced).toEqual([]);
  });

  it('a Brave answer on the agent\'s own key is counted as its own, not the fleet key\'s, as its other searches are (HB-0999)', async () => {
    const w = world({ recheckOn: () => false });
    const fleetKey = madeUpKey('fleet-brave');
    await w.secrets.put(SEARCH_KEY_REF, fleetKey);
    const braveAnswered = { code: 0, stdout: JSON.stringify({ ok: true, provider: 'brave', outputs: [{ result: { count: 1 } }] }), stderr: '' };
    w.provider.execResponses.set(AGENT_SEARCH_TEST_ARGV.join(' '), braveAnswered);
    const checks = () => w.store.searchHours('0000', '9999', SEARCH_CHECKS).map((h) => `${h.provider}:${h.n}`);
    // Built with its own key: its own bill.
    const own = await w.agent('own');
    w.store.recordAppliedSearchKey('own', 'own');
    expect(await w.svc.search.agentTest(own as Agent & { runtimeRef: string })).toMatchObject({ ok: true, provider: 'brave' });
    expect(checks()).toEqual([`${OWN_BRAVE}:1`]);
    // Built with the fleet's: the fleet's.
    const fleet = await w.agent('fleet');
    w.store.recordAppliedSearchKey('fleet', 'fleet');
    await w.svc.search.agentTest(fleet as Agent & { runtimeRef: string });
    expect(checks().sort()).toEqual([`${OWN_BRAVE}:1`, 'brave:1']);
    // No build has said: its saved key decides, its own when it is not the fleet's.
    const saved = await w.agent('saved');
    await w.secrets.put('env/saved/brave', madeUpKey('own-brave'));
    w.store.insertAgentEnv({ id: 'env-saved', agentId: 'saved', name: 'BRAVE_API_KEY', secretRef: 'env/saved/brave', createdAt: 'now' } as never);
    await w.svc.search.agentTest(saved as Agent & { runtimeRef: string });
    expect(checks().sort()).toEqual([`${OWN_BRAVE}:2`, 'brave:1']);
    // The month's report charges the fleet key for the one search it made.
    const report = await w.svc.search.usage();
    expect(report.byAgent.find((r) => r.id === SEARCH_CHECKS)).toMatchObject({ brave: 1, other: 2 });
  });

  it('a refusal for quota is on the agent\'s trail and has the fleet checked again', async () => {
    const w = world({ recheckOn: () => false });
    await w.secrets.put(SEARCH_KEY_REF, madeUpKey('brave'));
    const a = await w.agent('a1');
    w.provider.execResponses.set(AGENT_SEARCH_TEST_ARGV.join(' '), { code: 1, stdout: '', stderr: 'brave: 429 quota exhausted' });
    const out = await w.svc.search.agentTest(a as Agent & { runtimeRef: string });
    expect(out).toMatchObject({ ok: false, why: 'quota', provider: 'brave' });
    expect(w.traced).toEqual(['search.test_failed']);
    await vi.waitFor(() => expect(w.braveAsked).toBeGreaterThan(0));
    expect(w.store.searchHours('0000', '9999').filter((h) => h.provider !== 'brave')).toEqual([]);
  });
});

describe('the defaults for this machine', () => {
  let dir: string;
  const kept: Record<string, string | undefined> = {};
  const names = ['HATCHABOT_ENV_FILE', 'HATCHABOT_AGENT_MEMORY', 'HATCHABOT_EMBEDDER_MEMORY', 'HATCHABOT_FILES_MB_TELEGRAM'];
  beforeEach(() => {
    for (const n of names) kept[n] = process.env[n];
    dir = mkdtempSync(join(tmpdir(), 'hb-defaults-'));
    process.env.HATCHABOT_ENV_FILE = join(dir, '.env');
    writeFileSync(process.env.HATCHABOT_ENV_FILE, '# made up\n');
  });
  afterEach(() => {
    for (const n of names) { if (kept[n] === undefined) delete process.env[n]; else process.env[n] = kept[n]; }
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a setting it does not know, and a value it does not take, before writing anything', async () => {
    const w = world();
    expect(await w.svc.defaults.set('nope', '1')).toEqual({ ok: false, why: 'invalid', error: 'Unknown setting.' });
    const bad = await w.svc.defaults.set('agentMemory', 'lots');
    expect(bad).toMatchObject({ ok: false, why: 'invalid' });
    expect(readFileSync(process.env.HATCHABOT_ENV_FILE!, 'utf8')).toBe('# made up\n');
  });

  it('a memory default is written to .env and applied, in each agent\'s limits turn, to agents with no cap of their own', async () => {
    const w = world();
    const plain = await w.agent('a1');
    await w.agent('a2');
    w.store.setAgentMemoryCap('a2', '4g');
    await w.agent('a3', { state: 'STOPPED' });
    const out = await w.svc.defaults.set('agentMemory', '2g');
    expect(out).toMatchObject({ ok: true, answer: { applied: 2, default: { key: 'agentMemory', value: '2g', set: true } } });
    expect(readFileSync(process.env.HATCHABOT_ENV_FILE!, 'utf8')).toContain('HATCHABOT_AGENT_MEMORY=2g');
    expect(process.env.HATCHABOT_AGENT_MEMORY).toBe('2g');
    expect(w.limitsTurns.sort()).toEqual(['a1', 'a2', 'a3']);
    // The one with its own cap is left; only the running one's AGENTS.md is told.
    expect(w.provider.memoryUpdates.map((u) => u.runtimeRef).sort()).toEqual([plain.runtimeRef, w.store.getAgent('a3')!.runtimeRef].sort());
    await vi.waitFor(() => expect(w.docsSynced).toEqual(['a1']));
    expect(w.traced).toContain('machine.default_set');
  });

  it('the engine\'s memory restarts the memory search service; a file ceiling reaches each agent on that app', async () => {
    const w = world();
    expect(await w.svc.defaults.set('engineMemory', '2g')).toMatchObject({ ok: true, answer: { applied: 1 } });
    expect(w.restarts).toBe(1);
    await w.agent('a1');
    const files = await w.svc.defaults.set('filesTelegram', '20');
    expect(files).toMatchObject({ ok: true, answer: { applied: 1 } });
    expect(w.filesCaps).toEqual([{ agentId: 'a1', only: 'telegram' }]);
  });

  it('a restart of the memory search service that fails is not applied, and says so in plain words (HB-0937)', async () => {
    // As the provider fails each half: the stop (the door's removal refused,
    // the engine left as it was) and the start after a stop that went through.
    const stopFailed = new ProviderError('docker rm hatchabot-embed-door: Error response from daemon: made-up refusal', "Couldn't stop the memory search service. Try again in a moment.");
    const startFailed = new ProviderError('embedder failed: made-up docker output', 'Could not start the embedding service.');
    for (const [err, reason] of [
      [stopFailed, "Couldn't stop the memory search service. Try again in a moment."],
      [startFailed, 'Could not start the embedding service.'],
      [new Error('This host cannot run the embedding service.'), 'This host cannot run the embedding service.'],
    ] as const) {
      const w = world({ embedder: () => ({ enabled: true, external: undefined, restart: async () => { throw err; } }) });
      const out = await w.svc.defaults.set('engineMemory', '3g');
      expect(out).toMatchObject({ ok: true, answer: { applied: 0, default: { key: 'engineMemory', value: '3g', set: true } } });
      const said = out.ok ? out.answer.notApplied ?? '' : '';
      expect(said).toBe(`The memory search service did not restart: ${reason} It may keep its old memory, or be off, until it next starts: Hatchabot tries again within about 5 minutes, and at its own next start. To do it now, press Restart under Settings → Hosts → Memory search service (Start, if it shows Start).`);
      // What the provider said to the log is not for the page.
      expect(said).not.toContain('docker');
      // Saved all the same.
      expect(readFileSync(process.env.HATCHABOT_ENV_FILE!, 'utf8')).toContain('HATCHABOT_EMBEDDER_MEMORY=3g');
    }
    // A restart that works says nothing more.
    const ok = await world().svc.defaults.set('engineMemory', '2g');
    expect(ok.ok && ok.answer).not.toHaveProperty('notApplied');
  });

  it('an external memory search service is not restarted', async () => {
    const w = world({ embedder: () => ({ enabled: true, external: 'http://engine.example.test/v1', restart: async () => { throw new Error('not ours'); } }) });
    expect(await w.svc.defaults.set('engineMemory', '2g')).toMatchObject({ ok: true, answer: { applied: 0 } });
  });

  it('says what the machine\'s swap is beside "Compressed swap per agent"', async () => {
    const w = world();
    const { defaults } = await w.svc.defaults.view();
    const swap = defaults.find((d) => d.key === 'agentSwap') as { note?: string };
    expect(swap.note).toMatch(/^This machine has no swap: .* To turn it on: /);
    expect(defaults.find((d) => d.key === 'agentMemory')).not.toHaveProperty('note');
  });
});

describe('the search watch\'s tick', () => {
  it('starts with the service when asked for, unref\'d, and ends with stop()', () => {
    const started = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    try {
      const off = world();
      expect(started).not.toHaveBeenCalled();
      off.svc.stop();
      expect(cleared).not.toHaveBeenCalled();
      const on = world({ tickEveryMs: 600_000 });
      expect(started).toHaveBeenCalledTimes(1);
      expect(started.mock.calls[0]![1]).toBe(600_000);
      const timer = started.mock.results[0]!.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      on.svc.stop();
      expect(cleared).toHaveBeenCalledWith(timer);
    } finally {
      started.mockRestore();
      cleared.mockRestore();
    }
  });
});
