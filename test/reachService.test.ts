import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePublicUrl, type RepointResult, type TailnetInfo } from '../src/ops/tailnet.js';
import { createReach, type ReachDeps } from '../src/orchestrator/reach/reach.js';
import { createAppAddress } from '../src/orchestrator/reach/appAddress.js';
import { publicConfigView } from '../src/orchestrator/reach/appConfig.js';

/**
 * The reach service with no HTTP server (HB-0808 step 15 part B): the
 * app's two addresses and the tailnet probe's timers, Tailscale serve and
 * use-for-links, and /v1/config as the public address may see it.
 */
const TAILNET = 'https://box.example-tailnet.ts.net';

function reach(over: Partial<ReachDeps> = {}, tailnet: { info?: TailnetInfo; serve?: { ok: boolean; error?: string }; write?: { ok: boolean; replaced?: boolean; error?: string }; repoint?: RepointResult } = {}) {
  const traced: Array<[string, Record<string, unknown>]> = [];
  const warned: string[] = [];
  const written: Array<[string, string]> = [];
  let info: TailnetInfo = tailnet.info ?? { installed: false };
  const served: number[] = [];
  const asked: Array<[number, number | undefined]> = [];
  const repointed: Array<[number, number]> = [];
  const deps: ReachDeps = {
    publicUrl: () => undefined,
    port: () => 8080,
    proxyPort: () => 8094,
    proxyListener: () => ({ listening: true, port: 8094 }),
    envPath: () => '/nowhere/.env',
    publicStatus: () => undefined,
    refreshOn: false,
    trace: () => (event, detail) => { traced.push([event, detail]); },
    warn: (_d, msg) => { warned.push(msg); },
    authMode: () => 'accounts',
    countLocalAccounts: () => 1,
    localAccountsOn: () => true,
    loopbackIsRemote: () => false,
    rebuildsAtOnce: () => 2,
    tailnet: {
      info: async (port, mainPort) => { asked.push([port, mainPort]); return info; },
      repointServe: async (mainPort, listener) => {
        repointed.push([mainPort, listener.port]);
        const out = tailnet.repoint ?? { moved: ['box.example-tailnet.ts.net:443'], left: [] };
        if (out.moved.length && !out.left.length) info = { ...info, oldPort: undefined };
        return out;
      },
      enableServe: async (port) => {
        served.push(port);
        const out = tailnet.serve ?? { ok: true };
        if (out.ok) info = { ...info, serving: true, url: TAILNET };
        return out;
      },
      writePublicUrl: async (envPath, url) => { written.push([envPath, url]); return tailnet.write ?? { ok: true, replaced: false }; },
    },
    ...over,
  };
  return { r: createReach(deps), traced, warned, written, served, asked, repointed, setInfo: (i: TailnetInfo) => { info = i; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('the app\'s addresses', () => {
  it('shows HATCHABOT_PUBLIC_URL when it is a real address, else what the tailnet probe saw, else the loopback one', async () => {
    const set = reach({ publicUrl: () => 'https://hatchabot.example.org/' }).r;
    set.address.saw(TAILNET);
    expect(set.address.appUrl()).toBe('https://hatchabot.example.org');

    const loop = reach({ publicUrl: () => 'http://localhost:8080' }).r;
    expect(loop.address.appUrl()).toBe('http://localhost:8080');
    loop.address.saw(TAILNET);
    expect(loop.address.appUrl()).toBe(TAILNET);

    const none = reach().r;
    expect(none.address.appUrl()).toBeUndefined();
  });

  it('makes links for the public address only while public access is on and serving', () => {
    let st: { on: boolean; serving: boolean; url?: string } | undefined = { on: true, serving: false, url: 'https://box.example-tailnet.ts.net:8443' };
    const { r } = reach({ publicUrl: () => 'https://hatchabot.example.org', publicStatus: () => st });
    expect(r.address.linkUrl()).toBe('https://hatchabot.example.org');
    st = { ...st, serving: true };
    expect(r.address.linkUrl()).toBe('https://box.example-tailnet.ts.net:8443');
    st = undefined;
    expect(r.address.linkUrl()).toBe('https://hatchabot.example.org');
  });

  it('starts its two timers only where it is on, unref\'d, and stop() ends both', () => {
    const once = vi.spyOn(globalThis, 'setTimeout');
    const every = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const probe = async () => ({ installed: false });
      const off = createAppAddress({ publicUrl: () => undefined, port: () => 8080, publicStatus: () => undefined, refreshOn: false, tailnetInfo: probe });
      expect(once).not.toHaveBeenCalled();
      expect(every).not.toHaveBeenCalled();
      off.stop();
      expect(cleared).not.toHaveBeenCalled();
      const on = createAppAddress({ publicUrl: () => undefined, port: () => 8080, publicStatus: () => undefined, refreshOn: true, tailnetInfo: probe });
      expect(once.mock.calls.map((c) => c[1])).toEqual([4_000]);
      expect(every.mock.calls.map((c) => c[1])).toEqual([10 * 60_000]);
      const timers = [once.mock.results[0]!.value, every.mock.results[0]!.value] as NodeJS.Timeout[];
      for (const t of timers) expect(t.hasRef()).toBe(false);
      on.stop();
      expect(cleared.mock.calls.map((c) => c[0])).toEqual(timers);
    } finally {
      once.mockRestore(); every.mockRestore(); cleared.mockRestore();
    }
  });

  it('probes the tailnet 4 s after the start and every 10 minutes, and no more once stopped', async () => {
    vi.useFakeTimers();
    let probes = 0;
    const on = createAppAddress({ publicUrl: () => undefined, port: () => 8080, publicStatus: () => undefined, refreshOn: true, tailnetInfo: async () => { probes++; return { installed: true, url: TAILNET }; } });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(probes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes).toBe(1);
    expect(on.appUrl()).toBe(TAILNET);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(probes).toBe(2);
    on.stop();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(probes).toBe(2);
  });

  it('a probe never rejects, and a real setting is never probed for', async () => {
    vi.useFakeTimers();
    let probes = 0;
    const a = createAppAddress({ publicUrl: () => undefined, port: () => 8080, publicStatus: () => undefined, refreshOn: true, tailnetInfo: async () => { probes++; throw new Error('no tailscale'); } });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(probes).toBe(1);
    expect(a.appUrl()).toBeUndefined();
    a.stop();
    const b = createAppAddress({ publicUrl: () => 'https://hatchabot.example.org', port: () => 8080, publicStatus: () => undefined, refreshOn: true, tailnetInfo: async () => { probes++; return { installed: true, url: TAILNET }; } });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(probes).toBe(1);
    b.stop();
  });
});

describe('Tailscale serve', () => {
  it('refuses when Tailscale is not installed, or not connected, in its words', async () => {
    const missing = reach();
    expect(await missing.r.tailscale.serve()).toEqual({ ok: false, refusal: { error: 'Tailscale is not installed on this machine.' } });
    const down = reach({}, { info: { installed: true } });
    expect(await down.r.tailscale.serve()).toEqual({ ok: false, refusal: { error: 'Tailscale is installed but not connected — run `tailscale up` first.' } });
    expect(missing.served).toEqual([]);
    expect(down.served).toEqual([]);
  });

  it('says it is on already, turns it on (the address then shown), and passes on a refusal with the command', async () => {
    const already = reach({}, { info: { installed: true, dns: 'box.example-tailnet.ts.net', serving: true, url: TAILNET } });
    expect(await already.r.tailscale.serve()).toEqual({ ok: true, answer: expect.objectContaining({ alreadyOn: true }) });
    expect(already.served).toEqual([]);

    const fresh = reach({}, { info: { installed: true, dns: 'box.example-tailnet.ts.net' } });
    expect(fresh.r.address.appUrl()).toBeUndefined();
    const on = await fresh.r.tailscale.serve();
    expect(on).toEqual({ ok: true, answer: expect.objectContaining({ turnedOn: true, serving: true, url: TAILNET }) });
    // At the listener for it, not the app's own port (HB-1239); asked where it lands, the app's own port named as the old one.
    expect(fresh.served).toEqual([8094]);
    expect(fresh.asked.every(([p, main]) => p === 8094 && main === 8080)).toBe(true);
    expect(fresh.r.address.appUrl()).toBe(TAILNET);
    expect(fresh.traced).toEqual([['tailscale.serve_enabled', { dns: 'box.example-tailnet.ts.net', serving: true }]]);

    const refused = reach({}, { info: { installed: true, dns: 'box.example-tailnet.ts.net' }, serve: { ok: false, error: 'Serve is not enabled on your tailnet.' } });
    expect(await refused.r.tailscale.serve()).toEqual({ ok: false, refusal: { error: 'Serve is not enabled on your tailnet.', command: 'tailscale serve --bg http://127.0.0.1:8094' } });
    expect(refused.warned).toEqual(['tailscale.serve_failed']);
  });

  it('on, but still at the app\'s own port (HB-1239): moved there, path and all, and a move Tailscale refused is said with the command', async () => {
    const old = { installed: true, dns: 'box.example-tailnet.ts.net', serving: true, oldPort: true, url: TAILNET };
    const moving = reach({}, { info: old });
    const moved = await moving.r.tailscale.serve();
    expect(moved).toEqual({ ok: true, answer: expect.objectContaining({ turnedOn: true, serving: true, moved: ['box.example-tailnet.ts.net:443'] }) });
    expect((moved as { answer: Record<string, unknown> }).answer.oldPort).toBeUndefined();
    expect(moving.repointed).toEqual([[8080, 8094]]);
    expect(moving.served).toEqual([]);

    const left = reach({}, { info: old, repoint: { moved: [], left: [{ where: 'box.example-tailnet.ts.net:443', command: 'tailscale serve --bg --https=443 http://127.0.0.1:8094' }], error: 'Access denied: serve config denied' } });
    expect(await left.r.tailscale.serve()).toEqual({ ok: false, refusal: { error: 'Access denied: serve config denied', command: 'tailscale serve --bg --https=443 http://127.0.0.1:8094' } });
    expect(left.warned).toEqual(['tailscale.serve_repoint_failed']);

    const why = 'a `tailscale serve` running in a terminal made it: stop that one (Ctrl+C), then run tailscale serve --bg --https=10000 http://127.0.0.1:8094';
    const held = reach({}, { info: old, repoint: { moved: [], left: [{ where: 'box.example-tailnet.ts.net:10000', why }] } });
    expect(await held.r.tailscale.serve()).toEqual({ ok: false, refusal: { error: `box.example-tailnet.ts.net:10000: ${why}`, command: 'tailscale serve --bg http://127.0.0.1:8094' } });
  });

  it('says "moved" only when something moved and serve no longer lands on the app\'s own port', async () => {
    const old = { installed: true, dns: 'box.example-tailnet.ts.net', serving: true, oldPort: true, url: TAILNET };
    // Serve's configuration could not be read: that, and logged.
    const unread = reach({}, { info: old, repoint: { moved: [], left: [], error: 'Tailscale\'s serve configuration could not be read.' } });
    expect(await unread.r.tailscale.serve()).toEqual({ ok: false, refusal: { error: 'Tailscale\'s serve configuration could not be read.' } });
    expect(unread.warned).toEqual(['tailscale.serve_repoint_failed']);
    // Nothing it moves (the entry on the app's port is Funnel's, say), and serve still lands there.
    const funnel = reach({}, { info: old, repoint: { moved: [], left: [] } });
    expect(await funnel.r.tailscale.serve()).toEqual({ ok: false, refusal: { error: 'Tailscale still sends something to port 8080 from an entry Hatchabot does not move (a Funnel entry, say): run tailscale serve status to see it.' } });
    expect(funnel.warned).toEqual(['tailscale.serve_repoint_failed']);
    expect(funnel.traced.some(([e]) => e === 'tailscale.serve_enabled')).toBe(false);
  });

  it('never moves serve, or turns it on, onto a listener that did not open: it says why, and changes nothing (the owner\'s call, 2026-11-24)', async () => {
    const why = 'The listener for tailscale serve could not open 127.0.0.1:8094: listen EADDRINUSE: address already in use 127.0.0.1:8094';
    const closed = { proxyListener: () => ({ listening: false, port: 8094, error: why }) };
    const said = `Tailscale serve was left as it is: Hatchabot's listener for it, 127.0.0.1:8094, is not open. ${why}.`;
    const old = reach(closed, { info: { installed: true, dns: 'box.example-tailnet.ts.net', serving: true, oldPort: true, url: TAILNET } });
    expect(await old.r.tailscale.serve()).toEqual({ ok: false, refusal: { error: said, noListener: true } });
    expect(old.repointed).toEqual([]);
    const fresh = reach(closed, { info: { installed: true, dns: 'box.example-tailnet.ts.net' } });
    expect(await fresh.r.tailscale.serve()).toEqual({ ok: false, refusal: { error: said, noListener: true } });
    expect(fresh.served).toEqual([]);
    expect([...old.warned, ...fresh.warned]).toEqual(['tailscale.serve_no_listener', 'tailscale.serve_no_listener']);
    // None tried at all (a process that never opened one): not open either.
    const none = reach({ proxyListener: () => undefined }, { info: { installed: true, dns: 'box.example-tailnet.ts.net' } });
    expect(await none.r.tailscale.serve()).toEqual({ ok: false, refusal: { error: 'Tailscale serve was left as it is: Hatchabot\'s listener for it, 127.0.0.1:8094, is not open.', noListener: true } });
    // The setup guide is told, to say so instead of offering the command.
    expect(await old.r.tailscale.status()).toMatchObject({ proxyListening: false, proxyError: why });
  });

  it('status tells the address what it found, and answers the port and the address shown', async () => {
    const { r } = reach({}, { info: { installed: true, dns: 'box.example-tailnet.ts.net', serving: true, url: TAILNET } });
    expect(await r.tailscale.status()).toMatchObject({ installed: true, port: 8080, proxyPort: 8094, serveCommand: 'tailscale serve --bg http://127.0.0.1:8094', publicUrl: TAILNET, proxyListening: true });
    expect(r.address.appUrl()).toBe(TAILNET);
    expect((await r.tailscale.status()).mac).toBeUndefined();
  });

  it('status says when this is a Mac, where moving serve does not yet give each device its own sign-in limit (HB-1239 review)', async () => {
    const info: TailnetInfo = { installed: true, dns: 'box.example-tailnet.ts.net', serving: true, oldPort: true, url: TAILNET };
    expect(await reach({ platform: 'darwin' }, { info }).r.tailscale.status()).toMatchObject({ oldPort: true, mac: true });
    expect((await reach({ platform: 'linux' }, { info }).r.tailscale.status()).mac).toBeUndefined();
  });
});

describe('use for links', () => {
  it('refuses with no HTTPS address yet, and writes none', async () => {
    const w = reach({}, { info: { installed: true, dns: 'box.example-tailnet.ts.net' } });
    expect(await w.r.tailscale.useForLinks()).toEqual({ ok: false, refusal: { error: 'There is no working HTTPS address to write yet — turn on HTTPS first.' } });
    expect(w.written).toEqual([]);
  });

  it('writes the tailnet address to the .env and puts it in force at once, over the address the server started with (the .env took it: see the real writer below)', async () => {
    const envPath = join(mkdtempSync(join(tmpdir(), 'hb-reach-')), '.env');
    const w = reach({ envPath: () => envPath, publicUrl: () => 'https://hatchabot.example.org' }, { info: { installed: true, url: TAILNET }, write: { ok: true, replaced: true } });
    expect(await w.r.tailscale.useForLinks()).toEqual({ ok: true, answer: { written: envPath, url: TAILNET, restartNeeded: false } });
    expect(w.written).toEqual([[envPath, TAILNET]]);
    expect(w.traced).toEqual([['app.public_url_written', { url: TAILNET, envPath, replaced: true }]]);
    // In force now, as it will be after a restart: the setting the server
    // started with no longer wins, on the screen or in a link (HB-1008).
    expect(w.r.address.appUrl()).toBe(TAILNET);
    expect(w.r.address.linkUrl()).toBe(TAILNET);
    // The probe's own sightings do not move a written address.
    w.r.address.saw('https://other.example-tailnet.ts.net');
    expect(w.r.address.appUrl()).toBe(TAILNET);
  });

  it('with the real .env writer: in force at once when the .env takes it; refused, and nothing changes, over an address chosen there (HB-1008)', async () => {
    const started = 'https://hatchabot.example.org';
    const withEnv = (body: string) => {
      const envPath = join(mkdtempSync(join(tmpdir(), 'hb-reach-')), '.env');
      writeFileSync(envPath, body, { mode: 0o600 });
      const r = reach({ envPath: () => envPath, publicUrl: () => started, tailnet: { info: async () => ({ installed: true, url: TAILNET }), enableServe: async () => ({ ok: true }), writePublicUrl } }).r;
      return { r, envPath };
    };
    // The .env still names the address the server started with: the writer will not replace it.
    let w = withEnv(`PORT=8080\nHATCHABOT_PUBLIC_URL=${started}\n`);
    expect(await w.r.tailscale.useForLinks()).toEqual({ ok: false, refusal: { error: `.env already sets HATCHABOT_PUBLIC_URL=${started} — change it there if you meant to.` } });
    expect([w.r.address.appUrl(), w.r.address.linkUrl()]).toEqual([started, started]);
    expect(readFileSync(w.envPath, 'utf8')).toContain(`HATCHABOT_PUBLIC_URL=${started}`);
    // Changed in the .env since the start (to a loopback address, or taken out): written, and in force at once.
    for (const body of ['PORT=8080\nHATCHABOT_PUBLIC_URL=http://localhost:8080\n', 'PORT=8080\n']) {
      w = withEnv(body);
      expect(await w.r.tailscale.useForLinks()).toMatchObject({ ok: true, answer: { url: TAILNET, restartNeeded: false } });
      expect(readFileSync(w.envPath, 'utf8')).toContain(`HATCHABOT_PUBLIC_URL=${TAILNET}`);
      expect([w.r.address.appUrl(), w.r.address.linkUrl()]).toEqual([TAILNET, TAILNET]);
    }
  });

  it('the origin check and the cookie\'s https fallback count the written address at once, beside the one the server started with, until stop (HB-1314)', async () => {
    const { foreignRequest } = await import('../src/api/requestOrigin.js');
    const { requestIsHttps } = await import('../src/api/signIn/sessionCookie.js');
    const was = process.env.HATCHABOT_PUBLIC_URL;
    process.env.HATCHABOT_PUBLIC_URL = 'http://localhost:8080'; // as an install starts: written over by Use for links
    try {
      /** A request through a proxy that keeps the Host and says nothing of https; an older browser's post naming its origin. */
      const atTailnet = { headers: { host: 'box.example-tailnet.ts.net' }, socket: {} };
      const post = (origin: string) => ({ headers: { host: 'localhost:8080', origin }, socket: {} });
      const w = reach({}, { info: { installed: true, url: TAILNET }, write: { ok: true, replaced: true } });
      // Before: today's answers, kept.
      expect(requestIsHttps(atTailnet)).toBe(false);
      expect(foreignRequest(post(TAILNET))).toBe('origin: box.example-tailnet.ts.net');
      expect(foreignRequest(post('http://localhost:8080'))).toBeUndefined();
      expect(await w.r.tailscale.useForLinks()).toMatchObject({ ok: true });
      // After: in force now, as it will be after a restart.
      expect(requestIsHttps(atTailnet)).toBe(true);
      expect(foreignRequest(post(TAILNET))).toBeUndefined();
      // The rest as before: the address it started with, another host, another site, a caller's own env.
      expect(foreignRequest(post('http://localhost:8080'))).toBeUndefined();
      expect(requestIsHttps({ headers: { host: 'other.example-tailnet.ts.net' }, socket: {} })).toBe(false);
      expect(foreignRequest(post('https://elsewhere.example.org'))).toBe('origin: elsewhere.example.org');
      expect(requestIsHttps(atTailnet, {})).toBe(false);
      expect(foreignRequest(post(TAILNET), {})).toBe('origin: box.example-tailnet.ts.net');
      // Stopped (the service ending): this process's word on it ends with it.
      w.r.stop();
      expect(requestIsHttps(atTailnet)).toBe(false);
      expect(foreignRequest(post(TAILNET))).toBe('origin: box.example-tailnet.ts.net');
    } finally {
      if (was === undefined) delete process.env.HATCHABOT_PUBLIC_URL; else process.env.HATCHABOT_PUBLIC_URL = was;
    }
  });

  it('says a restart is needed only where sign-in links still check the address the server started with (HB-1314 review)', async () => {
    const { signinLinkAudience } = await import('../src/api/signIn/signinLink.js');
    /** Use for links on a process started with this env, with sign-in links judged as the routes judge them. */
    const answer = async (env: NodeJS.ProcessEnv) =>
      (await reach({ signinLinkAudience: () => signinLinkAudience(env) }, { info: { installed: true, url: TAILNET }, write: { ok: true, replaced: true } }).r.tailscale.useForLinks());
    const KEY = { HATCHABOT_SIGNIN_KEY_FILE: '/nowhere/key.pem' };
    // Sign-in links on, checked against another address until a restart.
    expect(await answer({ ...KEY, HATCHABOT_PUBLIC_URL: 'https://hatchabot.example.org/' })).toMatchObject({ ok: true, answer: { url: TAILNET, restartNeeded: true } });
    // …or against none at all (they answer 503 until a restart): no address, an empty one, one that is no URL.
    for (const started of [{}, { HATCHABOT_PUBLIC_URL: '' }, { HATCHABOT_PUBLIC_URL: 'not an address' }]) {
      expect(await answer({ ...KEY, ...started }), JSON.stringify(started)).toMatchObject({ ok: true, answer: { restartNeeded: true } });
    }
    // Already this address, or no sign-in links here: nothing waits.
    expect(await answer({ ...KEY, HATCHABOT_PUBLIC_URL: `${TAILNET}/` })).toMatchObject({ ok: true, answer: { restartNeeded: false } });
    expect(await answer({ HATCHABOT_PUBLIC_URL: 'https://hatchabot.example.org/' })).toMatchObject({ ok: true, answer: { restartNeeded: false } });
    expect(await answer({})).toMatchObject({ ok: true, answer: { restartNeeded: false } });
  });

  it('a write that fails is refused in its words, and the address is not used', async () => {
    const w = reach({}, { info: { installed: true, url: TAILNET }, write: { ok: false, error: 'The .env could not be written.' } });
    expect(await w.r.tailscale.useForLinks()).toEqual({ ok: false, refusal: { error: 'The .env could not be written.' } });
    expect(w.r.address.appUrl()).toBeUndefined();
  });

  it('the QR encodes the tailnet address, else HATCHABOT_PUBLIC_URL as set', async () => {
    expect(await reach({}, { info: { installed: true, url: TAILNET } }).r.tailscale.qrAddress()).toBe(TAILNET);
    expect(await reach({ publicUrl: () => 'http://localhost:8080' }).r.tailscale.qrAddress()).toBe('http://localhost:8080');
    expect(await reach().r.tailscale.qrAddress()).toBeUndefined();
  });
});

describe('/v1/config', () => {
  it('at the public address leaves out the private address, the notice, the limits and the setup-code rule; keeps the rest', () => {
    process.env.HATCHABOT_NOTICE = 'Maintenance on Sunday';
    try {
      const { r } = reach({ publicUrl: () => 'https://hatchabot.example.org', publicStatus: () => ({ on: true, serving: true, url: 'https://box.example-tailnet.ts.net:8443' }) });
      const inside = r.config.view(false);
      expect(inside).toMatchObject({
        authMode: 'accounts', publicAddress: false, notice: 'Maintenance on Sunday', needsSetup: false, localAccounts: true,
        setupCodeRequired: false, maxAgentsPerAccount: 0, rebuildConcurrency: 2, appUrl: 'https://hatchabot.example.org',
        linkUrl: 'https://box.example-tailnet.ts.net:8443', handover: 2,
      });
      const outside = r.config.view(true);
      for (const k of ['appUrl', 'notice', 'maxAgentsPerAccount', 'rebuildConcurrency', 'setupCodeRequired']) expect(outside).not.toHaveProperty(k);
      expect(outside).toMatchObject({ authMode: 'accounts', publicAddress: true, localAccounts: true, linkUrl: 'https://box.example-tailnet.ts.net:8443', handover: 2 });
      expect(Object.keys(inside).filter((k) => !(k in outside)).sort()).toEqual(['appUrl', 'maxAgentsPerAccount', 'notice', 'rebuildConcurrency', 'setupCodeRequired']);
    } finally { delete process.env.HATCHABOT_NOTICE; }
  });

  it('the masking alone: the same object privately, five keys fewer publicly', () => {
    const full = { appUrl: 'a', notice: 'n', maxAgentsPerAccount: 1, rebuildConcurrency: 2, setupCodeRequired: true, authMode: 'accounts' };
    expect(publicConfigView(false, full)).toBe(full);
    expect(publicConfigView(true, full)).toEqual({ authMode: 'accounts' });
  });

  it('needs setup in accounts mode with no account; identity mode names its project', () => {
    expect(reach({ countLocalAccounts: () => 0 }).r.config.view(false)).toMatchObject({ needsSetup: true, identity: undefined });
    expect(reach({ authMode: () => undefined }).r.config.view(false)).toMatchObject({ authMode: 'password', needsSetup: false });
    expect(reach({ authMode: () => 'identity' }).r.config.view(true)).toHaveProperty('identity');
  });
});
