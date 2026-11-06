import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { registerRoutes } from '../src/api/routes.js';
import { buildConfigCommands } from '../src/openclaw/configWriter.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import {
  applySearchScript, createSearchWatch, DDG_TURNED_AWAY, duckDuckGoTurnedAway, ownSearchKeys, probeBrave, probeDuckDuckGo, readAgentSearchTest, readWebSearch, searchProviderFor,
} from '../src/orchestrator/webSearch.js';

const T0 = Date.parse('2026-11-03T12:00:00Z');
const HOUR = 3_600_000;
const DDG_OK = '<a class="result__a" href="https://x.example">x</a>';

/** Brave answers from the queue, its last answer for ever; DuckDuckGo answers `ddg`. */
function net(brave: Array<{ status: number; headers?: Record<string, string> } | 'down'>, ddg: { status?: number; body?: string } | 'down' = { body: DDG_OK }) {
  const seen = { brave: 0, ddg: 0 };
  const fetchImpl = (async (url: string) => {
    if (String(url).includes('brave.com')) {
      const a = brave[Math.min(seen.brave++, brave.length - 1)]!;
      if (a === 'down') throw new TypeError('fetch failed');
      return new Response('{}', { status: a.status, ...(a.headers ? { headers: a.headers } : {}) });
    }
    seen.ddg++;
    if (ddg === 'down') throw new TypeError('fetch failed');
    return new Response(ddg.body ?? '', { status: ddg.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function world(opts: { key?: string; agents?: Array<Record<string, unknown>>; own?: string[]; exec?: (ref: string, script: string) => { code: number; stdout: string; stderr: string } } = {}) {
  const prefs = new Map<string, string>();
  const store = {
    getOwnerPref: (_o: string, k: string) => prefs.get(k),
    setOwnerPref: (_o: string, k: string, v: string | null) => { if (v === null) prefs.delete(k); else prefs.set(k, v); },
    listAllActiveAgents: () => opts.agents ?? [],
    listAgentEnv: (id: string) => (opts.own?.includes(id) ? [{ name: 'BRAVE_API_KEY' }] : []),
  };
  const scripts: Array<{ ref: string; script: string }> = [];
  const provider = {
    execShell: async (ref: string, script: string) => {
      scripts.push({ ref, script });
      return opts.exec?.(ref, script) ?? { code: 0, stdout: 'changed\n', stderr: '' };
    },
  };
  const notes: string[] = [];
  return { store, scripts, notes, provider, prefs, base: {
    store: store as never,
    braveKey: async () => opts.key,
    providerFor: () => provider as never,
    notify: (h: string) => { notes.push(h); },
    sleep: async () => {},
  } };
}
const settledCheck = async (watch: ReturnType<typeof createSearchWatch>) => { await watch.check(); await watch.idle(); return watch.state(); };
const running = (id: string, more: Record<string, unknown> = {}) => ({ id, name: id, hostId: 'h1', runtimeRef: `docker://${id}`, state: 'RUNNING', ...more });
const QUOTA = (remaining: number, limit = 2000, reset = 86_400) => ({ 'x-ratelimit-remaining': `1, ${remaining}`, 'x-ratelimit-limit': `1, ${limit}`, 'x-ratelimit-reset': `1, ${reset}` });

describe('asking Brave', () => {
  it('reads the monthly window of its quota headers', async () => {
    const { fetchImpl } = net([{ status: 200, headers: QUOTA(1500) }]);
    const p = await probeBrave('made-up', { fetchImpl, now: () => T0 });
    expect(p).toMatchObject({ status: 'ok', remaining: 1500, limit: 2000, resetsAt: new Date(T0 + 86_400_000).toISOString() });
  });

  it('works when Brave sends no quota headers', async () => {
    const { fetchImpl } = net([{ status: 200 }]);
    expect(await probeBrave('made-up', { fetchImpl })).toEqual({ status: 'ok', detail: 'Brave works.' });
  });

  it('a 429 that clears on the second try was the per-second limit, not an empty quota', async () => {
    const { fetchImpl, seen } = net([{ status: 429 }, { status: 200, headers: QUOTA(900) }]);
    expect((await probeBrave('made-up', { fetchImpl, sleep: async () => {} })).status).toBe('ok');
    expect(seen.brave).toBe(2);
  });

  it('a 429 that stays, or a 402, is an empty quota', async () => {
    expect((await probeBrave('made-up', { fetchImpl: net([{ status: 429 }]).fetchImpl, sleep: async () => {} })).status).toBe('exhausted');
    expect((await probeBrave('made-up', { fetchImpl: net([{ status: 429, headers: QUOTA(0) }]).fetchImpl, sleep: async () => {} })).status).toBe('exhausted');
    expect((await probeBrave('made-up', { fetchImpl: net([{ status: 402 }]).fetchImpl })).status).toBe('exhausted');
  });

  it('tells a refused key, Brave\'s own trouble and no network apart', async () => {
    for (const status of [401, 403, 422]) expect((await probeBrave('made-up', { fetchImpl: net([{ status }]).fetchImpl })).status).toBe('rejected');
    expect((await probeBrave('made-up', { fetchImpl: net([{ status: 503 }]).fetchImpl })).status).toBe('busy');
    expect((await probeBrave('made-up', { fetchImpl: net(['down']).fetchImpl })).status).toBe('unreachable');
  });

  it('a monthly limit of 0 is no cap: it works, with no count to show (HB-0454)', async () => {
    const p = await probeBrave('made-up', { fetchImpl: net([{ status: 200, headers: QUOTA(0, 0) }]).fetchImpl, now: () => T0 });
    expect(p).toEqual({ status: 'ok', detail: 'Brave works, on a plan with no monthly cap.' });
  });
  it('a count with no limit beside it says nothing about a cap (HB-0454)', async () => {
    const p = await probeBrave('made-up', { fetchImpl: net([{ status: 200, headers: { 'x-ratelimit-remaining': '1, 0' } }]).fetchImpl });
    expect(p.status).toBe('ok');
  });
  it('a refusal on such a plan is still a refusal', async () => {
    const p = await probeBrave('made-up', { fetchImpl: net([{ status: 429, headers: QUOTA(0, 0) }]).fetchImpl, sleep: async () => {} });
    expect(p.status).toBe('exhausted');
  });

  it('at the last few queries it is low, and the key is never in what it says', async () => {
    const p = await probeBrave('made-up-secret', { fetchImpl: net([{ status: 200, headers: QUOTA(10) }]).fetchImpl });
    expect(p.status).toBe('low');
    expect(JSON.stringify(p)).not.toContain('made-up-secret');
  });
});

/** An invented challenge page, shaped like the one seen (HB-0455): no result links in it. */
const DDG_CHALLENGE = '<html><body><form id="challenge-form"><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>'
  + '<p class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</p></form></body></html>';

describe('asking DuckDuckGo', () => {
  it('a page with no results is being turned away, even at 200', async () => {
    const ask = (ddg: Parameters<typeof net>[1]) => probeDuckDuckGo({ fetchImpl: net([], ddg).fetchImpl });
    expect((await ask({ body: DDG_OK })).status).toBe('ok');
    expect((await ask({ body: 'Unfortunately, bots use DuckDuckGo too.' })).status).toBe('turned-away');
    expect((await ask({ status: 202 })).status).toBe('turned-away');
    expect((await ask('down')).status).toBe('unreachable');
  });

  it('a challenge page (202, or its words) says plainly that this machine has no free search and needs a Brave key (HB-0455)', async () => {
    const ask = (ddg: Parameters<typeof net>[1]) => probeDuckDuckGo({ fetchImpl: net([], ddg).fetchImpl });
    for (const answer of [{ status: 202, body: DDG_CHALLENGE }, { status: 200, body: DDG_CHALLENGE }, { status: 403, body: DDG_CHALLENGE }, { status: 202, body: '' }]) {
      const p = await ask(answer);
      expect(p.status, JSON.stringify(answer)).toBe('turned-away');
      expect(p.detail).toMatch(/no free search/);
      expect(p.detail).toMatch(/only with a working Brave key/);
      expect(p.detail).not.toMatch(/answered with no results/);
    }
    // Not a challenge: an empty page, or an error, is not called one.
    for (const answer of [{ status: 200, body: '<html><body>nothing here</body></html>' }, { status: 503, body: 'down for a moment' }]) {
      const p = await ask(answer);
      expect(p.status, JSON.stringify(answer)).toBe('blocked');
      expect(p.detail).not.toMatch(/turns this machine away/);
    }
    // Results in it, whatever the status: it works.
    expect((await ask({ status: 200, body: DDG_OK + '<p>captcha</p>' })).status).toBe('ok');
    expect(duckDuckGoTurnedAway(202, DDG_OK)).toBe(false);
  });

  it('it keeps its own user agent: it does not dress up as a browser to get past a challenge (HB-0455)', async () => {
    const agents: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      agents.push(String((init?.headers as Record<string, string>)['user-agent']));
      return new Response(DDG_CHALLENGE, { status: 202 });
    }) as unknown as typeof fetch;
    await probeDuckDuckGo({ fetchImpl });
    expect(agents).toEqual(['Mozilla/5.0 (Hatchabot)']);
  });

  it('a fleet with no Brave key, turned away by DuckDuckGo: the state and the message say a Brave key is needed', async () => {
    const w = world({});
    const bodies: string[] = [];
    const watch = createSearchWatch({ ...w.base, notify: (h: string, b: string) => { w.notes.push(h); bodies.push(b); }, fetchImpl: net([], { status: 202, body: DDG_CHALLENGE }).fetchImpl });
    const s = await watch.check();
    expect(s).toMatchObject({ active: 'duckduckgo', duckduckgo: { status: 'turned-away', detail: DDG_TURNED_AWAY } });
    expect(w.notes).toEqual(['Web search may not be working']);
    expect(bodies[0]).toContain('no free search');
    expect(bodies[0]).toContain('A Brave key is needed: add one under Settings → AI → Fleet search key');
  });

  /** A watch whose messages are kept whole. */
  const watchOf = (w: ReturnType<typeof world>, fetchImpl: typeof fetch) => {
    const said: Array<[string, string]> = [];
    const watch = createSearchWatch({ ...w.base, notify: (h: string, b: string) => { said.push([h, b]); }, fetchImpl });
    return { watch, said };
  };
  const challenge = { status: 202, body: DDG_CHALLENGE } as const;

  it('turned away with a Brave key set: the message says what its check found, and "add one" only when none is set (review of HB-0455)', async () => {
    // Out of quota, in auto: moved to DuckDuckGo, and told the key has run out.
    const out = watchOf(world({ key: 'made-up' }), net([{ status: 429, headers: QUOTA(0) }], challenge).fetchImpl);
    await out.watch.check();
    expect(out.said.map(([h]) => h)).toEqual(['Web search moved to DuckDuckGo', 'Web search may not be working']);
    expect(out.said[1]![1]).toContain('run out of quota');
    expect(out.said[1]![1]).toContain('Replace it under Settings → AI → Fleet search key');
    expect(out.said[1]![1]).not.toMatch(/add one|key is needed/);
    // Refused: told so.
    const bad = watchOf(world({ key: 'made-up' }), net([{ status: 401 }], challenge).fetchImpl);
    await bad.watch.check();
    expect(bad.said.at(-1)![1]).toContain('Brave refused the key (401)');
    expect(bad.said.at(-1)![1]).not.toMatch(/add one|key is needed/);
    // A key that works, with "DuckDuckGo only" chosen: told to choose Brave.
    const chose = watchOf(world({ key: 'made-up' }), net([{ status: 200, headers: QUOTA(1500) }], challenge).fetchImpl);
    await chose.watch.setMode('duckduckgo');
    expect(chose.said.map(([h]) => h)).toEqual(['Web search may not be working']);
    expect(chose.said[0]![1]).toContain('The Brave key works');
    expect(chose.said[0]![1]).toContain('instead of "DuckDuckGo only"');
    expect(chose.said[0]![1]).not.toMatch(/add one|key is needed/);
  });

  it('an install already stuck on DuckDuckGo with an older "blocked" is told once when it turns out to be turned away (review of HB-0455)', async () => {
    const w = world({});
    w.prefs.set('webSearch', JSON.stringify({ mode: 'auto', active: 'duckduckgo', why: 'No Brave key is set.',
      duckduckgo: { status: 'blocked', detail: 'DuckDuckGo answered with no results: it may be turning this address away for now.' } }));
    const { watch, said } = watchOf(w, net([], challenge).fetchImpl);
    await watch.check();
    expect(said.map(([h]) => h)).toEqual(['Web search may not be working']);
    expect(said[0]![1]).toContain('turns this machine away');
    await watch.check();
    expect(said).toHaveLength(1);
  });

  it('a fleet on Brave is told once when DuckDuckGo starts turning this machine away: nothing to fall back on', async () => {
    const w = world({ key: 'made-up' });
    const { watch, said } = watchOf(w, net([{ status: 200, headers: QUOTA(1500) }], challenge).fetchImpl);
    expect((await watch.check()).active).toBe('brave');
    await watch.check();
    expect(said.map(([h]) => h)).toEqual(['Web search has nothing to fall back on']);
    expect(said[0]![1]).toContain('The Brave key works.');
  });

  /** DuckDuckGo answers check by check from `ddg`; Brave from `brave()` (none: no key). */
  const flapping = (ddg: Array<'away' | 'ok' | 'down' | 'empty'>, brave?: () => { status: number; headers?: Record<string, string> }) => {
    let i = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('brave.com')) { const b = brave!(); return new Response('{}', { status: b.status, headers: b.headers ?? {} }); }
      const d = ddg[Math.min(i, ddg.length - 1)];
      if (d === 'down') throw new TypeError('fetch failed');
      return d === 'away' ? new Response(DDG_CHALLENGE, { status: 202 }) : new Response(d === 'ok' ? DDG_OK : '<html></html>', { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, next: () => { i++; } };
  };
  const runChecks = async (w: ReturnType<typeof world>, f: ReturnType<typeof flapping>, n: number) => {
    const { watch, said } = watchOf(w, f.fetchImpl);
    const active: string[] = [];
    for (let k = 0; k < n; k++) { active.push((await watch.check()).active); f.next(); }
    return { said: said.map(([h]) => h), active };
  };

  it('a DuckDuckGo that comes and goes is announced once, not at every turn (final review of HB-0455)', async () => {
    // No key, turned away and timing out by turns: one message.
    expect((await runChecks(world({}), flapping(['away', 'down', 'away', 'down', 'away']), 5)).said).toEqual(['Web search may not be working']);
    // No key, turned away and working by turns: still one.
    expect((await runChecks(world({}), flapping(['away', 'ok', 'away', 'ok', 'away']), 5)).said).toEqual(['Web search may not be working']);
    // Brave works, DuckDuckGo away and working by turns: one "nothing to fall back on".
    expect((await runChecks(world({ key: 'made-up' }), flapping(['away', 'ok', 'away', 'ok', 'away'], () => ({ status: 200, headers: QUOTA(1500) })), 5)).said)
      .toEqual(['Web search has nothing to fall back on']);
    // Brave nearly out, DuckDuckGo away and timing out by turns: one message, and the fleet never leaves Brave.
    const low = await runChecks(world({ key: 'made-up' }), flapping(['away', 'down', 'away', 'down'], () => ({ status: 200, headers: QUOTA(5) })), 4);
    expect(low.said).toEqual(['Web search has nothing to fall back on']);
    expect(low.active).toEqual(['brave', 'brave', 'brave', 'brave']);
    // Working again for two checks running: the next time it turns away is news again.
    expect((await runChecks(world({}), flapping(['away', 'ok', 'ok', 'away']), 4)).said).toEqual(['Web search may not be working', 'Web search may not be working']);
  });

  it('the fleet moving onto a DuckDuckGo already said to turn this machine away is still told it has no search', async () => {
    let brave = { status: 200, headers: QUOTA(1500) } as { status: number; headers?: Record<string, string> };
    const r = await (async () => {
      const w = world({ key: 'made-up' });
      const f = flapping(['away'], () => brave);
      const { watch, said } = watchOf(w, f.fetchImpl);
      await watch.check();
      brave = { status: 429, headers: QUOTA(0) };
      await watch.check();
      return said.map(([h]) => h);
    })();
    expect(r).toEqual(['Web search has nothing to fall back on', 'Web search moved to DuckDuckGo', 'Web search may not be working']);
  });

  it('Brave nearly out and DuckDuckGo not answering with results (a timeout, an empty page): the fleet stays on Brave (final review of HB-0455)', async () => {
    for (const ddg of ['down', 'empty'] as const) {
      const r = await runChecks(world({ key: 'made-up' }), flapping([ddg], () => ({ status: 200, headers: QUOTA(5) })), 2);
      expect(r.active, ddg).toEqual(['brave', 'brave']);
      expect(r.said, ddg).not.toContain('Web search moved to DuckDuckGo');
    }
  });

  it('Brave nearly out and DuckDuckGo turning this machine away: the fleet stays on Brave, and moves only once it runs out (review of HB-0455)', async () => {
    const w = world({ key: 'made-up' });
    let brave: { status: number; headers?: Record<string, string> } = { status: 200, headers: QUOTA(5) };
    const fetchImpl = (async (url: string) => String(url).includes('brave.com')
      ? new Response('{}', { status: brave.status, headers: brave.headers ?? {} })
      : new Response(DDG_CHALLENGE, { status: 202 })) as unknown as typeof fetch;
    const { watch, said } = watchOf(w, fetchImpl);
    const low = await watch.check();
    expect(low).toMatchObject({ active: 'brave', brave: { status: 'low' } });
    expect(low.why).toContain('agents stay on Brave until it runs out');
    expect(said.map(([h]) => h)).not.toContain('Web search moved to DuckDuckGo');
    // Out: now it moves.
    brave = { status: 429, headers: QUOTA(0) };
    expect((await watch.check()).active).toBe('duckduckgo');
    // Low again (quota partly back): back to Brave, and not announced as its quota returning.
    brave = { status: 200, headers: QUOTA(5) };
    expect((await watch.check()).active).toBe('brave');
    expect(said.map(([h]) => h)).not.toContain('Web search is back on Brave');
    // With DuckDuckGo working, low still moves the fleet, as before.
    const w2 = world({ key: 'made-up' });
    expect((await watchOf(w2, net([{ status: 200, headers: QUOTA(5) }]).fetchImpl).watch.check()).active).toBe('duckduckgo');
  });
});

describe('which provider an agent is told', () => {
  const brave = { active: 'brave' } as const, ddg = { active: 'duckduckgo' } as const;
  it('no key: DuckDuckGo by name, since auto-detection skips it (HB-0392)', () => {
    expect(searchProviderFor({ hasFleetKey: false, hasOwnKey: false, state: brave })).toBe('duckduckgo');
  });
  it('a fleet key: none named while Brave has quota, DuckDuckGo once it has not', () => {
    expect(searchProviderFor({ hasFleetKey: true, hasOwnKey: false, state: brave })).toBeUndefined();
    expect(searchProviderFor({ hasFleetKey: true, hasOwnKey: false, state: ddg })).toBe('duckduckgo');
  });
  it('its own key is its own quota, whatever the fleet is on', () => {
    expect(searchProviderFor({ hasFleetKey: false, hasOwnKey: true, state: ddg })).toBeUndefined();
  });
});

describe('the config an agent is built with', () => {
  const cmds = (patch: Record<string, unknown>) => buildConfigCommands({ agentId: 'kitchen', ...patch } as never);
  const about = (c: { argv: string[]; rawShell?: string }) => `${c.argv.join(' ')} ${c.rawShell ?? ''}`.includes('tools.web.search.provider');
  it('names DuckDuckGo, leaving a provider set by hand', () => {
    const c = cmds({ searchProvider: 'duckduckgo' }).find(about)!;
    expect(c.rawShell).toContain('duckduckgo');
    expect(c.skipIf).toContain('c.tools.web.search.provider');
  });
  it('else clears only its own DuckDuckGo', () => {
    const c = cmds({}).find(about)!;
    expect(c.argv).toEqual(['config', 'unset', 'tools.web.search.provider']);
    expect(c.skipIf).toContain('!== "duckduckgo"');
  });
  it('the manager has no search setting: it searches through Hatchabot', () => {
    expect(cmds({ ops: { mcpUrl: 'http://x', token: 'made-up' } }).find(about)).toBeUndefined();
  });
});

describe('the script that moves a running agent', () => {
  const sha = (k: string) => createHash('sha256').update(k).digest('hex');
  /** Runs it for real, as `bash -s`: its config in a temp folder and a shim for `openclaw`, nothing of the machine's. */
  function run(script: string, opts: { env?: Record<string, string>; provider?: string; failCli?: boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'hb-search-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    const calls = join(home, 'calls');
    writeFileSync(join(bin, 'openclaw'), `#!/bin/bash\necho "$*" >> ${JSON.stringify(calls)}\n${opts.failCli ? 'exit 1' : 'exit 0'}\n`, { mode: 0o755 });
    writeFileSync(join(home, 'openclaw.json'), JSON.stringify({ tools: { web: { search: { enabled: true, ...(opts.provider ? { provider: opts.provider } : {}) } } } }));
    try {
      const r = spawnSync('/bin/bash', ['-s'], {
        input: script.replaceAll('/home/node/.openclaw/openclaw.json', join(home, 'openclaw.json')),
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...opts.env }, encoding: 'utf8',
      });
      return { code: r.status, out: r.stdout.trim(), err: r.stderr, cli: existsSync(calls) ? readFileSync(calls, 'utf8').trim() : '' };
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  const SET = 'config set tools.web.search.provider duckduckgo', UNSET = 'config unset tools.web.search.provider';
  const held = { BRAVE_API_KEY: 'made-up-held' };

  it.each([
    ['fleet out of quota: to DuckDuckGo', { fleetKey: sha('made-up-held'), fleetOn: false }, { env: held }, 'changed', SET],
    ['already there: no CLI start', { fleetKey: sha('made-up-held'), fleetOn: false }, { env: held, provider: 'duckduckgo' }, 'same', ''],
    ['quota back, holding that key: to Brave', { fleetKey: sha('made-up-held'), fleetOn: true }, { env: held, provider: 'duckduckgo' }, 'changed', UNSET],
    ['already on Brave: no CLI start', { fleetKey: sha('made-up-held'), fleetOn: true }, { env: held }, 'same', ''],
    ['a replaced key: it holds the old one, so it does not go back to it', { fleetKey: sha('made-up-new'), fleetOn: true }, { env: held, provider: 'duckduckgo' }, 'same needs-rebuild', ''],
    ['a replaced key while on the old one: to DuckDuckGo, and counted', { fleetKey: sha('made-up-new'), fleetOn: true }, { env: held }, 'changed needs-rebuild', SET],
    ['a fleet key it has not got yet', { fleetKey: sha('made-up-new'), fleetOn: true }, {}, 'changed needs-rebuild', SET],
    ['no key anywhere', { fleetOn: false }, {}, 'changed', SET],
    ['set by hand: left alone', { fleetKey: sha('made-up-held'), fleetOn: false }, { env: held, provider: 'gemini' }, 'custom', ''],
    ['its own key: off DuckDuckGo, whatever the fleet is on', { own: ['BRAVE_API_KEY'], fleetKey: sha('made-up-fleet'), fleetOn: false }, { env: { BRAVE_API_KEY: 'made-up-own' }, provider: 'duckduckgo' }, 'changed', UNSET],
    ['its own Brave key not built yet, the fleet\'s empty one still there: not the empty one', { own: ['BRAVE_API_KEY'], fleetKey: sha('made-up-fleet'), fleetOn: false }, { env: { BRAVE_API_KEY: 'made-up-fleet' } }, 'changed needs-rebuild', SET],
    ['its own other key not built yet, fleet healthy: stays on the fleet\'s', { own: ['PERPLEXITY_API_KEY'], fleetKey: sha('made-up-fleet'), fleetOn: true }, { env: { BRAVE_API_KEY: 'made-up-fleet' } }, 'same', ''],
    ['its own other key not built yet, fleet out: DuckDuckGo, and counted', { own: ['PERPLEXITY_API_KEY'], fleetKey: sha('made-up-fleet'), fleetOn: false }, { env: { BRAVE_API_KEY: 'made-up-fleet' } }, 'changed needs-rebuild', SET],
    ['its own other key built: left to auto-detect', { own: ['PERPLEXITY_API_KEY'], fleetKey: sha('made-up-fleet'), fleetOn: false }, { env: { PERPLEXITY_API_KEY: 'made-up', BRAVE_API_KEY: 'made-up-fleet' }, provider: 'duckduckgo' }, 'changed', UNSET],
  ] as Array<[string, Parameters<typeof applySearchScript>[0], Parameters<typeof run>[1], string, string]>)('%s', (_n, a, o, out, cli) => {
    const r = run(applySearchScript(a), o);
    expect(r, r.err).toMatchObject({ code: 0, out, cli });
  });

  it('a CLI that fails is a failure, not "changed"', () => {
    const r = run(applySearchScript({ fleetOn: false }), { failCli: true });
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  });

  it('only known names and hex go in', () => {
    const s = applySearchScript({ own: ['EVIL$(reboot)', 'BRAVE_API_KEY'], fleetKey: 'abc"; reboot #', fleetOn: true });
    expect(s).not.toContain('reboot');
  });
});

describe('watching the quota', () => {
  it('a replaced key: the agents still hold the old one, so they stay on DuckDuckGo until a rebuild, and it is not called a quota returning', async () => {
    const hash = (k: string) => createHash('sha256').update(k).digest('hex');
    let key = 'made-up-old';
    const w = world({ agents: [running('a')], exec: (_r, script) => {
      // What this agent's container does: it holds the old key.
      const stale = script.includes('if [ "$have" =') && !script.includes(`"$have" = "${hash('made-up-old')}"`);
      return { code: 0, stdout: stale ? 'same needs-rebuild' : 'changed', stderr: '' };
    } });
    const n = net([{ status: 429 }, { status: 429 }, { status: 200, headers: QUOTA(2000) }]);
    const watch = createSearchWatch({ ...w.base, braveKey: async () => key, fetchImpl: n.fetchImpl, now: () => T0 });
    await settledCheck(watch);
    key = 'made-up-new';
    const s = await settledCheck(watch);
    expect(s.active).toBe('brave');
    expect(s.applied).toMatchObject({ rebuild: 1, changed: 0 });
    const last = w.scripts.at(-1)!.script;
    expect(last).toContain(hash('made-up-new'));
    expect(last).not.toContain(hash('made-up-old'));
    expect(w.notes).toEqual(['Web search moved to DuckDuckGo']);
    expect(JSON.stringify(s)).not.toContain('made-up');
  });

  it('a 429 with quota left is its per-second limit: nothing moves, even asked twice', async () => {
    const w = world({ key: 'made-up', agents: [running('a')] });
    const s = await settledCheck(createSearchWatch({ ...w.base, fetchImpl: net([{ status: 429, headers: QUOTA(1500) }]).fetchImpl, now: () => T0 }));
    expect(s).toMatchObject({ active: 'brave', brave: { status: 'busy' } });
    expect(Date.parse(s.nextCheckAt!)).toBe(T0 + HOUR);
    expect(w.notes).toEqual([]);
  });

  it('an empty quota is asked again on the usual round, however far off its reset: being wrong must not park the fleet', async () => {
    const w = world({ key: 'made-up' });
    const s = await createSearchWatch({ ...w.base, fetchImpl: net([{ status: 429, headers: QUOTA(0, 2000, 2_000_000) }]).fetchImpl, now: () => T0 }).check();
    expect(Date.parse(s.nextCheckAt!)).toBe(T0 + 6 * HOUR);
  });

  it('a key that could not be read is not "no key": nothing moves', async () => {
    const w = world({ agents: [running('a')] });
    const watch = createSearchWatch({ ...w.base, braveKey: async () => { throw new Error('bad decrypt'); }, fetchImpl: net([{ status: 200 }]).fetchImpl });
    await expect(watch.check()).rejects.toThrow('bad decrypt');
    expect(watch.state().active).toBe('brave');
    expect(w.scripts).toEqual([]);
  });

  it('a mode set while the probes run is kept, and is checked again rather than answered with the old run', async () => {
    const w = world({ key: 'made-up' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inner = net([{ status: 200, headers: QUOTA(1500) }]);
    const fetchImpl = (async (...a: Parameters<typeof fetch>) => { await gate; return inner.fetchImpl(...a); }) as typeof fetch;
    const watch = createSearchWatch({ ...w.base, fetchImpl });
    const first = watch.check();
    const set = watch.setMode('duckduckgo');
    release();
    await first;
    expect(await set).toMatchObject({ mode: 'duckduckgo', active: 'duckduckgo' });
    expect(watch.state().mode).toBe('duckduckgo');
    expect(inner.seen.brave).toBe(2);
  });

  it('a key saved while a check runs gets a check of its own', async () => {
    let key = 'made-up-old';
    const asked: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      await gate;
      if (String(url).includes('brave.com')) { asked.push((init?.headers as Record<string, string>)['x-subscription-token']!); return new Response('{}', { status: 200, headers: QUOTA(1500) }); }
      return new Response(DDG_OK);
    }) as unknown as typeof fetch;
    const w = world();
    const watch = createSearchWatch({ ...w.base, braveKey: async () => key, fetchImpl });
    const first = watch.check();
    await new Promise((r) => setImmediate(r));
    key = 'made-up-new';
    const second = watch.recheck();
    release();
    await first;
    await second;
    expect(asked).toEqual(['made-up-old', 'made-up-new']);
  });

  it('a check does not wait for the fleet to move, and one can run while it does', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = world({ key: 'made-up', agents: [running('slow')] });
    w.provider.execShell = (async (ref: string, script: string) => { w.scripts.push({ ref, script }); await gate; return { code: 0, stdout: 'changed', stderr: '' }; }) as never;
    const watch = createSearchWatch({ ...w.base, fetchImpl: net([{ status: 429 }, { status: 429 }, { status: 200 }]).fetchImpl });
    expect((await watch.check()).active).toBe('duckduckgo');
    expect(watch.moving()).toBe(true);
    expect((await watch.check()).active).toBe('brave');
    release();
    await watch.idle();
    expect(watch.moving()).toBe(false);
  });

  it('the pass in progress when the fleet moves is followed by one that puts every agent right', async () => {
    // The fleet flips while the first agent is being set: without the second pass the first stayed on the old answer.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = world({ key: 'made-up', agents: [running('x'), running('y')] });
    let first = true;
    w.provider.execShell = (async (ref: string, script: string) => {
      w.scripts.push({ ref, script });
      if (first) { first = false; await gate; }
      return { code: 0, stdout: 'changed', stderr: '' };
    }) as never;
    const watch = createSearchWatch({ ...w.base, fetchImpl: net([{ status: 200, headers: QUOTA(1500) }, { status: 429 }, { status: 429 }]).fetchImpl });
    await watch.check();
    await watch.check();
    release();
    await watch.idle();
    const lastFor = (ref: string) => w.scripts.filter((x) => x.ref === ref).at(-1)!.script;
    expect(lastFor('docker://x')).not.toContain('want=""');
    expect(lastFor('docker://y')).not.toContain('want=""');
  });

  it('a first key, or a mode set back to auto, is not announced as a quota returning', async () => {
    let key: string | undefined;
    const w = world();
    const watch = createSearchWatch({ ...w.base, braveKey: async () => key, fetchImpl: net([{ status: 200, headers: QUOTA(1500) }]).fetchImpl });
    await watch.check();
    key = 'made-up';
    expect((await watch.check()).active).toBe('brave');
    await watch.setMode('duckduckgo');
    await watch.setMode('auto');
    expect(w.notes).toEqual([]);
  });

  it('Brave runs out: the fleet moves, the owner is told once, and it asks again at the reset', async () => {
    const w = world({ key: 'made-up', agents: [running('a'), running('b')] });
    const { fetchImpl } = net([{ status: 429, headers: QUOTA(0, 2000, 3600) }]);
    let t = T0;
    const watch = createSearchWatch({ ...w.base, fetchImpl, now: () => t });
    const s = await settledCheck(watch);
    expect(s).toMatchObject({ active: 'duckduckgo', why: 'The Brave key has run out of quota.', since: new Date(T0).toISOString() });
    expect(w.notes).toEqual(['Web search moved to DuckDuckGo']);
    expect(w.scripts.map((x) => x.ref)).toEqual(['docker://a', 'docker://b']);
    expect(w.scripts[0]!.script).not.toContain('want=""');
    expect(s.applied).toMatchObject({ changed: 2, failed: [] });
    expect(Date.parse(s.nextCheckAt!)).toBe(T0 + HOUR + 60_000);
    // Nothing more until then, and not told twice.
    t = T0 + 10 * 60_000;
    await watch.tick();
    await watch.idle();
    expect(w.scripts).toHaveLength(2);
    expect(w.notes).toHaveLength(1);
  });

  it('it returns: back to Brave, told, and the agents are put right', async () => {
    const w = world({ key: 'made-up', agents: [running('a')] });
    const seq = net([{ status: 429, headers: QUOTA(0) }, { status: 429, headers: QUOTA(0) }, { status: 200, headers: QUOTA(2000) }]);
    const watch = createSearchWatch({ ...w.base, fetchImpl: seq.fetchImpl, now: () => T0 });
    await settledCheck(watch);
    const s = await settledCheck(watch);
    expect(s).toMatchObject({ active: 'brave', why: 'Brave has quota.' });
    expect(w.notes).toEqual(['Web search moved to DuckDuckGo', 'Web search is back on Brave']);
    expect(w.scripts.at(-1)!.script).toContain('want=""');
  });

  it('a fleet parked on DuckDuckGo by a metered plan goes back at the next check (HB-0454)', async () => {
    const w = world({ key: 'made-up', agents: [running('a')] });
    const parked = createSearchWatch({ ...w.base, fetchImpl: net([{ status: 429, headers: QUOTA(0) }, { status: 429, headers: QUOTA(0) }]).fetchImpl, now: () => T0 });
    expect((await settledCheck(parked)).active).toBe('duckduckgo');
    const watch = createSearchWatch({ ...w.base, fetchImpl: net([{ status: 200, headers: QUOTA(0, 0) }]).fetchImpl, now: () => T0 });
    const s = await settledCheck(watch);
    expect(s.active).toBe('brave');
    expect(s.brave).toEqual({ status: 'ok', detail: 'Brave works, on a plan with no monthly cap.' });
    expect(w.scripts.at(-1)!.script).toContain('want=""');
  });

  it('there and back and there again: an agent is put right every time, not just the first', async () => {
    const w = world({ key: 'made-up', agents: [running('a')] });
    const n = net([{ status: 200, headers: QUOTA(1500) }, { status: 429 }, { status: 429 }, { status: 200, headers: QUOTA(1500) }, { status: 429 }, { status: 429 }]);
    const watch = createSearchWatch({ ...w.base, fetchImpl: n.fetchImpl, now: () => T0 });
    const wants: boolean[] = [];
    for (const active of ['brave', 'duckduckgo', 'brave', 'duckduckgo']) {
      expect((await settledCheck(watch)).active).toBe(active);
      wants.push(w.scripts.at(-1)!.script.includes('want=""'));
    }
    expect(w.scripts).toHaveLength(4);
    expect(wants).toEqual([true, false, true, false]);
  });

  it('moves before the very end, keeping a few queries for the checks that see it return', async () => {
    const w = world({ key: 'made-up' });
    const s = await createSearchWatch({ ...w.base, fetchImpl: net([{ status: 200, headers: QUOTA(5) }]).fetchImpl }).check();
    expect(s.active).toBe('duckduckgo');
  });

  it('a refused key moves the fleet too', async () => {
    const w = world({ key: 'made-up' });
    expect((await createSearchWatch({ ...w.base, fetchImpl: net([{ status: 422 }]).fetchImpl }).check()).active).toBe('duckduckgo');
  });

  it('no network, or Brave\'s own trouble, says nothing about the key: nothing moves, and it asks again within the hour', async () => {
    for (const a of ['down', { status: 503 }] as const) {
      const w = world({ key: 'made-up', agents: [running('a')] });
      const s = await settledCheck(createSearchWatch({ ...w.base, fetchImpl: net([a]).fetchImpl, now: () => T0 }));
      expect(s.active).toBe('brave');
      expect(w.notes).toEqual([]);
      expect(Date.parse(s.nextCheckAt!)).toBe(T0 + HOUR);
    }
  });

  it('asks every 6 hours on a full quota, hourly under 10%: four queries a day, not 24', async () => {
    const at = async (remaining: number) => {
      const w = world({ key: 'made-up' });
      const s = await createSearchWatch({ ...w.base, fetchImpl: net([{ status: 200, headers: QUOTA(remaining) }]).fetchImpl, now: () => T0 }).check();
      return Date.parse(s.nextCheckAt!) - T0;
    };
    expect(await at(1500)).toBe(6 * HOUR);
    expect(await at(100)).toBe(HOUR);
  });

  it('a restart does not spend a query: the next check is in the record', async () => {
    const w = world({ key: 'made-up' });
    const a = net([{ status: 200, headers: QUOTA(1500) }]);
    await createSearchWatch({ ...w.base, fetchImpl: a.fetchImpl, now: () => T0 }).check();
    const again = createSearchWatch({ ...w.base, fetchImpl: a.fetchImpl, now: () => T0 + HOUR });
    await again.tick();
    expect(a.seen.brave).toBe(1);
  });

  it('with no key it spends nothing, and agents are told DuckDuckGo', async () => {
    const w = world({ agents: [running('a')] });
    const n = net([{ status: 200 }]);
    const s = await settledCheck(createSearchWatch({ ...w.base, fetchImpl: n.fetchImpl }));
    expect(s.active).toBe('duckduckgo');
    expect(w.scripts).toHaveLength(1);
    expect(n.seen.brave).toBe(0);
    expect(w.notes).toEqual([]);
  });

  it('DuckDuckGo chosen: stays there whatever Brave says, and is not announced as running out', async () => {
    const w = world({ key: 'made-up', agents: [running('a')] });
    const watch = createSearchWatch({ ...w.base, fetchImpl: net([{ status: 200, headers: QUOTA(1500) }]).fetchImpl });
    const s = await watch.setMode('duckduckgo');
    expect(s).toMatchObject({ mode: 'duckduckgo', active: 'duckduckgo', why: 'You chose DuckDuckGo.' });
    expect(w.notes).toEqual([]);
    expect((await watch.setMode('auto')).active).toBe('brave');
  });

  it('nowhere left to go is said, once', async () => {
    const w = world({ key: 'made-up' });
    const watch = createSearchWatch({ ...w.base, fetchImpl: net([{ status: 429 }], { body: 'a challenge' }).fetchImpl });
    await watch.check();
    await watch.check();
    expect(w.notes).toEqual(['Web search moved to DuckDuckGo', 'Web search may not be working']);
  });

  it('two checks at once are one check', async () => {
    const w = world({ key: 'made-up' });
    const n = net([{ status: 200, headers: QUOTA(1500) }]);
    const watch = createSearchWatch({ ...w.base, fetchImpl: n.fetchImpl });
    await Promise.all([watch.check(), watch.check()]);
    expect(n.seen.brave).toBe(1);
  });

  it('a failure nudges a check, but not within minutes of the last', async () => {
    const w = world({ key: 'made-up' });
    const n = net([{ status: 200, headers: QUOTA(1500) }]);
    let t = T0;
    const watch = createSearchWatch({ ...w.base, fetchImpl: n.fetchImpl, now: () => t });
    await watch.check();
    t = T0 + 60_000;
    watch.nudge();
    await new Promise((r) => setImmediate(r));
    expect(n.seen.brave).toBe(1);
    t = T0 + 20 * 60_000;
    watch.nudge();
    await expect.poll(() => n.seen.brave).toBe(2);
  });
});

describe('going through the agents', () => {
  const out = async (agents: Array<Record<string, unknown>>, opts: Partial<Parameters<typeof world>[0]> = {}) => {
    const w = world({ key: 'made-up', agents, ...opts });
    return { w, s: await settledCheck(createSearchWatch({ ...w.base, fetchImpl: net([{ status: 429 }]).fetchImpl, isBusy: (id) => id === 'busy' })) };
  };

  it('skips the manager, one not running, one moved away and one mid-operation', async () => {
    const { w } = await out([running('m', { ops: true }), running('off', { state: 'STOPPED' }), running('gone', { migratedTo: 'x' }), running('busy'), running('ok')]);
    expect(w.scripts.map((x) => x.ref)).toEqual(['docker://ok']);
  });

  it('an agent with its own key keeps it while the fleet is on DuckDuckGo', async () => {
    const { w } = await out([running('own'), running('fleet')], { own: ['own'] });
    expect(w.scripts.find((x) => x.ref === 'docker://own')!.script).toContain('[ -n "$BRAVE_API_KEY" ]');
    expect(w.scripts.find((x) => x.ref === 'docker://fleet')!.script).not.toContain('want=""');
  });

  it('own means a key for any search provider, and not any credential', () => {
    expect(ownSearchKeys([{ name: 'PERPLEXITY_API_KEY' }, { name: 'MARKETDATA_API_KEY' }])).toEqual(['PERPLEXITY_API_KEY']);
  });

  it('the count waiting for a rebuild stays true of the fleet: not lost to one failure, not kept after their rebuilds', async () => {
    const agents = [running('a'), running('b'), running('c')];
    let rebuilt = false;
    let bFails = true;
    const w = world({ key: 'made-up', agents, exec: (ref) => {
      if (ref === 'docker://b' && bFails) return { code: 1, stdout: '', stderr: 'asleep' };
      return { code: 0, stdout: rebuilt ? 'same' : 'same needs-rebuild', stderr: '' };
    } });
    const watch = createSearchWatch({ ...w.base, fetchImpl: net([{ status: 200, headers: QUOTA(1500) }]).fetchImpl, now: () => T0 });
    expect((await settledCheck(watch)).applied).toMatchObject({ rebuild: 2, failed: ['b'] });
    await watch.tick();
    expect(watch.state().applied).toMatchObject({ rebuild: 2, failed: ['b'] });
    bFails = false;
    await watch.tick();
    expect(watch.state().applied).toMatchObject({ rebuild: 3, failed: [] });
    rebuilt = true;
    await watch.tick();
    expect(watch.state().applied?.rebuild).toBeUndefined();
    const looks = w.scripts.length;
    await watch.tick();
    expect(w.scripts).toHaveLength(looks);
  });

  it('what a pass named goes when nothing is left to look at', async () => {
    const agents = [running('a')];
    let refuse = true;
    const w = world({ key: 'made-up', agents, exec: () => (refuse ? { code: 1, stdout: '', stderr: 'asleep' } : { code: 0, stdout: 'same', stderr: '' }) });
    const watch = createSearchWatch({ ...w.base, fetchImpl: net([{ status: 200, headers: QUOTA(1500) }]).fetchImpl, now: () => T0 });
    expect((await settledCheck(watch)).applied?.failed).toEqual(['a']);
    refuse = false;
    agents[0]!.state = 'STOPPED';
    await watch.tick();
    expect(watch.state().applied?.failed).toEqual([]);
  });

  it('one that cannot be reached is named and tried again; the others still move', async () => {
    let refuse = true;
    const w = world({ key: 'made-up', agents: [running('asleep'), running('ok')], exec: (ref) => (ref === 'docker://asleep' && refuse ? { code: 1, stdout: '', stderr: 'machine asleep' } : { code: 0, stdout: 'changed', stderr: '' }) });
    const watch = createSearchWatch({ ...w.base, fetchImpl: net([{ status: 429, headers: QUOTA(0, 2000, 864_000) }]).fetchImpl, now: () => T0 });
    const s = await settledCheck(watch);
    expect(s.applied).toMatchObject({ changed: 1, failed: ['asleep'] });
    refuse = false;
    await watch.tick();
    expect(w.scripts.filter((x) => x.ref === 'docker://asleep')).toHaveLength(2);
    expect(w.scripts.filter((x) => x.ref === 'docker://ok')).toHaveLength(1);
    expect(readWebSearch(w.store as never).applied).toMatchObject({ changed: 1, failed: [] });
  });

  it('a stopped agent is looked at again once it runs', async () => {
    const agents = [running('a')];
    const w = world({ key: 'made-up', agents, exec: () => ({ code: 0, stdout: 'same', stderr: '' }) });
    const watch = createSearchWatch({ ...w.base, fetchImpl: net([{ status: 200, headers: QUOTA(1500) }]).fetchImpl, now: () => T0 });
    await settledCheck(watch);
    agents[0]!.state = 'STOPPED';
    await watch.tick();
    agents[0]!.state = 'RUNNING';
    await watch.tick();
    expect(w.scripts).toHaveLength(2);
  });
});

describe('reading an agent\'s test', () => {
  const okOut = (provider: string, count: number) => JSON.stringify({ ok: true, provider, outputs: [{ result: { count, tookMs: 650 } }] });
  it('names who answered, and no results is not called working', () => {
    expect(readAgentSearchTest(okOut('duckduckgo', 1), '')).toEqual({ ok: true, provider: 'duckduckgo', results: 1, tookMs: 650, detail: 'Search works: DuckDuckGo answered.' });
    expect(readAgentSearchTest(okOut('brave', 0), '')).toMatchObject({ ok: true, results: 0, detail: 'Brave answered, but with no results for the test search.' });
  });
  it('says when Gemini took over, by naming it', () => {
    expect(readAgentSearchTest(`[plugins] noise\n${okOut('gemini', 1)}`, '')).toMatchObject({ ok: true, provider: 'gemini' });
  });
  it.each([
    ['Brave Search API error (429): usage limit exceeded', 'quota', 'brave'],
    ['Brave Search API error (402)', 'quota', 'brave'],
    ['Brave Search API error (422): invalid subscription token', 'key', 'brave'],
    ['web_search is disabled or no provider is available.', 'no-provider', undefined],
    ['getaddrinfo EAI_AGAIN html.duckduckgo.com', 'network', 'duckduckgo'],
    ['something else', 'unknown', undefined],
  ])('%s', (message, why, provider) => {
    const viaJson = readAgentSearchTest(JSON.stringify({ ok: false, error: { message } }), '');
    expect(viaJson).toMatchObject({ ok: false, why });
    expect((viaJson as { provider?: string }).provider).toBe(provider);
    expect(readAgentSearchTest('', `[openclaw] Reason: ${message}`)).toMatchObject({ ok: false, why });
  });
  it('never hands the page what the tool printed', () => {
    const r = readAgentSearchTest('', 'something else with made-up-secret in it');
    expect(JSON.stringify(r)).not.toContain('made-up-secret');
  });
});

describe('the routes', () => {
  async function app(fetchImpl: typeof fetch) {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'owner', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    const map = new Map<string, string>([['media/brave-api-key', 'made-up']]);
    const secrets = { async put(r: string, v: string) { map.set(r, v); }, async get(r: string) { const v = map.get(r); if (v === undefined) throw new Error('none'); return v; }, async delete(r: string) { map.delete(r); } };
    const f = Fastify();
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } }, searchFetch: fetchImpl } as never);
    return f;
  }
  const as = (who: string) => ({ 'x-hatchabot-owner': who });

  it('are the machine owner\'s', async () => {
    const f = await app(net([{ status: 200 }]).fetchImpl);
    for (const [method, url] of [['GET', '/v1/web-search'], ['POST', '/v1/web-search/check'], ['PUT', '/v1/web-search']] as const) {
      expect((await f.inject({ method, url, headers: as('member'), payload: method === 'PUT' ? { mode: 'auto' } : undefined })).statusCode, url).toBe(403);
    }
  });

  it('a test shows the answer, and the mode is checked', async () => {
    const f = await app(net([{ status: 429 }]).fetchImpl);
    const r = await f.inject({ method: 'POST', url: '/v1/web-search/check', headers: as('owner') });
    expect(r.json()).toMatchObject({ active: 'duckduckgo', keySet: true, brave: { status: 'exhausted' }, duckduckgo: { status: 'ok' } });
    expect(JSON.stringify(r.json())).not.toContain('made-up');
    expect((await f.inject({ method: 'PUT', url: '/v1/web-search', headers: as('owner'), payload: { mode: 'gemini' } })).statusCode).toBe(400);
    expect((await f.inject({ method: 'PUT', url: '/v1/web-search', headers: as('owner'), payload: { mode: 'duckduckgo' } })).json()).toMatchObject({ mode: 'duckduckgo', active: 'duckduckgo' });
  });
});
