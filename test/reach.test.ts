import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, Jar, publicApp, type PublicApp } from './helpers/publicApp.js';
import { SHIM_DNS, tailscaleShim, type Shim } from './helpers/tailscaleShim.js';
import { activeValues } from '../src/config/envFile.js';
import { enableServe, funnelOff, funnelOn, funnelPreflight, parseFunnelStatus, targetsPort } from '../src/ops/tailnet.js';

/**
 * "Reach it from anywhere": the switch, end to end, against a stand-in for
 * the tailscale command (test/helpers/tailscaleShim.ts). Nothing here can
 * reach this machine's real Tailscale: HATCHABOT_TAILSCALE_BIN is the only
 * binary the module runs when it is set, and without it every changing
 * command refuses under a test runner.
 */
let h: PublicApp | undefined;
let shim: Shim;
let dir: string;
let envFile: string;

beforeEach(() => {
  shim = tailscaleShim();
  dir = mkdtempSync(join(tmpdir(), 'hb-reach-'));
  envFile = join(dir, '.env');
  writeFileSync(envFile, 'HATCHABOT_AUTH=accounts\nHATCHABOT_SECRET_KEY=x\n');
});
afterEach(async () => {
  await h?.close(); h = undefined;
  shim.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const start = async (env: Record<string, string> = {}, probes = {}) => {
  h = await publicApp({
    off: true, fullRoutes: true, probes,
    env: { HATCHABOT_TAILSCALE_BIN: shim.bin, HATCHABOT_ENV_FILE: envFile, HATCHABOT_PUBLIC_ACCESS_URL: '', HATCHABOT_PUBLIC_URL: `https://${SHIM_DNS}`, ...env },
  });
  const owner = await h.addAccount('owner', { owner: true });
  const login = await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'owner', password: owner.password } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const call = (method: string, url: string, payload?: unknown, c = cookie) => h!.app.inject({ method: method as 'GET', url, headers: { cookie: c }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { h, owner, call };
};
const envNow = () => activeValues(readFileSync(envFile, 'utf8'));
const changing = () => shim.calls().filter((c) => c[0] === 'funnel' && c[1] !== 'status');

describe('reach on', () => {
  it('asks for an explicit confirmation that says what it does', async () => {
    const { call } = await start();
    const r = await call('POST', '/v1/public-access/on', {});
    expect(r.statusCode).toBe(400);
    expect(r.json().confirmText).toBe('This makes your sign-in page reachable from the internet.');
    expect(changing()).toEqual([]);
  });

  it('turns on: Funnel is pointed at the public listener and nothing else, the address is set, the record says so', async () => {
    const { h, call, owner } = await start();
    const r = await call('POST', '/v1/public-access/on', { confirm: true });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ on: true, serving: true, listening: true, turnedOn: true, url: `https://${SHIM_DNS}:8443` });
    expect(changing()).toEqual([['funnel', '--bg', '--https=8443', `http://127.0.0.1:${h.port}`]]);
    const cfg = shim.config();
    expect(Object.keys(cfg.AllowFunnel ?? {})).toEqual([`${SHIM_DNS}:8443`]);
    expect(cfg.Web![`${SHIM_DNS}:8443`]!.Handlers['/']!.Proxy).toBe(`http://127.0.0.1:${h.port}`);
    expect(envNow().get('HATCHABOT_PUBLIC_ACCESS')).toBe('funnel');
    expect(envNow().get('HATCHABOT_PUBLIC_ACCESS_URL')).toBe(`https://${SHIM_DNS}:8443`);
    // The listener is really open and serving.
    expect((await h.pub('/v1/config')).json.publicAddress).toBe(true);
    // Links sent to people are made for the public address now; the app's own address stays private.
    expect((await call('GET', '/v1/config')).json()).toMatchObject({ publicAddress: false, linkUrl: `https://${SHIM_DNS}:8443` });
    expect(h.store.listSecurityLog().find((e) => e.kind === 'public.on')).toMatchObject({ ownerId: owner.id });
    // The address as a QR code.
    const qr = await call('GET', '/v1/public-access/qr.svg');
    expect(qr.statusCode).toBe(200);
    expect(qr.body).toContain('<svg');
  });

  it('is refused, naming each safeguard that is off, and nothing is changed', async () => {
    const cases: Array<[string, Record<string, string>, object, (s: Awaited<ReturnType<typeof start>>) => Promise<void> | void]> = [
      ['invited-only', { HATCHABOT_PUBLIC_INVITED_ONLY: '' }, {}, () => {}],
      ['auto-upgrade', {}, { autoUpgrade: async () => ({ ok: false, why: 'The channel timer is not installed.' }) }, () => {}],
      ['second-factor', {}, {}, (s) => { s.h.store.deleteSecondFactors(s.owner.id); }],
      ['separate-listener', { HATCHABOT_ALLOW_OWNER_HEADER: '1' }, {}, () => {}],
      ['rate-limits', { HATCHABOT_LOGIN_FAILS_PER_WINDOW: '500' }, {}, () => {}],
    ];
    for (const [id, env, probes, prep] of cases) {
      const s = await start(env, probes);
      await prep(s);
      const r = await s.call('POST', '/v1/public-access/on', { confirm: true });
      expect(r.statusCode, id).toBe(409);
      expect(r.json().failing.map((c: any) => c.id), id).toEqual([id]);
      expect(r.json().failing[0].detail, id).toBeTruthy();
      expect(changing(), id).toEqual([]);
      expect(envNow().has('HATCHABOT_PUBLIC_ACCESS'), id).toBe(false);
      expect(s.h.app.publicAccess!.status().listening, id).toBe(false);
      await s.h.close(); h = undefined;
    }
  }, 60_000);

  it('is refused in password mode', async () => {
    h = await publicApp({ off: true, fullRoutes: true, mode: 'password', env: { HATCHABOT_TAILSCALE_BIN: shim.bin, HATCHABOT_ENV_FILE: envFile } });
    h.store.insertHost({ id: 'h', ownerId: 'dev-owner', kind: 'local', provider: 'mock', name: 'm', settings: {}, createdAt: 'now' });
    const login = await h.app.inject({ method: 'POST', url: '/v1/login', payload: { password: 'shared-pw' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const r = await h.app.inject({ method: 'POST', url: '/v1/public-access/on', headers: { cookie }, payload: { confirm: true } });
    expect(r.statusCode).toBe(409);
    expect(r.json().failing.map((c: any) => c.id)).toContain('auth-mode');
    expect(changing()).toEqual([]);
  });

  it('only the machine\'s owner may; a member is refused', async () => {
    const { h, call } = await start();
    const m = await h.addAccount('member');
    const login = await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'member', password: m.password } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    for (const [method, url] of [['POST', '/v1/public-access/on'], ['POST', '/v1/public-access/off'], ['GET', '/v1/public-access'], ['POST', '/v1/public-access/invited-only'], ['GET', '/v1/security/log']]) {
      expect((await call(method!, url!, method === 'POST' ? { confirm: true, on: false } : undefined, cookie)).statusCode, url).toBe(403);
    }
    expect(changing()).toEqual([]);
  });

  it('reports exactly what Tailscale is missing, with where to fix it', async () => {
    const { call } = await start();
    shim.setStatus({ CurrentTailnet: { MagicDNSEnabled: false }, CertDomains: [], Self: { DNSName: `${SHIM_DNS}.`, TailscaleIPs: ['100.64.0.1'], CapMap: {} } });
    const r = await call('POST', '/v1/public-access/on', { confirm: true });
    expect(r.statusCode).toBe(409);
    const missing = r.json().missing as Array<{ what: string; link?: string }>;
    expect(missing.map((m) => m.what)).toEqual(['MagicDNS is off for your tailnet.', 'HTTPS certificates are off for your tailnet.', 'This machine is not allowed to use Funnel yet.']);
    for (const m of missing) expect(m.link).toMatch(/^https:\/\/login\.tailscale\.com\/admin\//);
    expect(changing()).toEqual([]);
    shim.setStatus({ BackendState: 'Stopped' });
    expect((await call('POST', '/v1/public-access/on', { confirm: true })).json().missing[0].what).toBe('Tailscale is not connected.');
  });

  it('when Funnel itself refuses, the listener is closed again and Tailscale\'s link is passed on', async () => {
    const { h, call } = await start();
    shim.failFunnel('Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=abc123\n');
    const r = await call('POST', '/v1/public-access/on', { confirm: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().link).toBe('https://login.tailscale.com/f/funnel?node=abc123');
    expect(h.app.publicAccess!.status()).toMatchObject({ on: false, serving: false, listening: false });
    expect(envNow().has('HATCHABOT_PUBLIC_ACCESS')).toBe(false);
    expect(shim.config().AllowFunnel ?? {}).toEqual({});
  });

  it('refuses when Funnel already publishes the PRIVATE port (someone ran tailscale funnel by hand)', async () => {
    const { call } = await start();
    shim.setConfig({ AllowFunnel: { [`${SHIM_DNS}:443`]: true }, Web: { [`${SHIM_DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } } });
    const r = await call('POST', '/v1/public-access/on', { confirm: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().failing.map((c: any) => c.id)).toEqual(['separate-listener']);
    expect(changing()).toEqual([]);
  });

  it('when the setting cannot be saved, everything is taken back', async () => {
    const { h, call } = await start({ HATCHABOT_ENV_FILE: join(dir, 'missing', '.env') });
    const r = await call('POST', '/v1/public-access/on', { confirm: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('turned back off');
    expect(shim.config().AllowFunnel ?? {}).toEqual({});
    expect(h.app.publicAccess!.status()).toMatchObject({ on: false, listening: false });
    expect(changing().map((c) => c.join(' '))).toEqual([`funnel --bg --https=8443 http://127.0.0.1:${h.port}`, 'funnel --https=8443 off']);
  });

  it('cannot be turned on from the public address itself', async () => {
    const { h, call, owner } = await start();
    expect((await call('POST', '/v1/public-access/on', { confirm: true })).statusCode).toBe(200);
    const jar = await h.signIn('owner', owner.password, { totpSecret: owner.totpSecret });
    expect((await h.pub('/v1/public-access/on', { jar, body: { confirm: true } })).status).toBe(403);
    expect((await h.pub('/v1/tailscale', { jar })).status).toBe(403);
  });

  it('leaves `tailscale serve` for the private address alone', async () => {
    const { call } = await start();
    const serve = { TCP: { 443: { HTTPS: true } }, Web: { [`${SHIM_DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } } };
    shim.setConfig(serve);
    expect((await call('POST', '/v1/public-access/on', { confirm: true })).statusCode).toBe(200);
    expect(shim.config().Web![`${SHIM_DNS}:443`]).toEqual(serve.Web[`${SHIM_DNS}:443`]);
    expect(Object.keys(shim.config().AllowFunnel ?? {})).toEqual([`${SHIM_DNS}:8443`]); // 443 is not public
    expect((await call('POST', '/v1/public-access/off', {})).statusCode).toBe(200);
    expect(shim.config().Web![`${SHIM_DNS}:443`]).toEqual(serve.Web[`${SHIM_DNS}:443`]);
    expect(shim.calls().some((c) => c[0] === 'serve' && c[1] !== 'status')).toBe(false);
  });
});

describe('reach off', () => {
  it('undoes all of it: Funnel\'s entry, the listener, the setting and the address', async () => {
    const { h, call } = await start();
    await call('POST', '/v1/public-access/on', { confirm: true });
    const port = h.port;
    expect((await h.pub('/healthz')).status).toBe(200);
    const r = await call('POST', '/v1/public-access/off', {});
    expect(r.json()).toEqual({ on: false, serving: false });
    expect(shim.config().AllowFunnel ?? {}).toEqual({});
    expect(shim.config().Web ?? {}).toEqual({});
    expect(envNow().has('HATCHABOT_PUBLIC_ACCESS')).toBe(false);
    expect(envNow().has('HATCHABOT_PUBLIC_ACCESS_URL')).toBe(false);
    expect(process.env.HATCHABOT_PUBLIC_ACCESS).toBeUndefined();
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow(); // nothing listens there any more
    expect(h.store.listSecurityLog().map((e) => e.kind)).toContain('public.off');
    const st = (await call('GET', '/v1/public-access')).json();
    expect(st).toMatchObject({ on: false, serving: false, listening: false, url: null });
    expect((await call('GET', '/v1/config')).json().linkUrl).not.toBe(`https://${SHIM_DNS}:8443`); // links are private again
  });

  it('when Tailscale will not let go, Hatchabot still stops serving and says what to run', async () => {
    const { h, call } = await start();
    await call('POST', '/v1/public-access/on', { confirm: true });
    shim.failOff(true);
    const r = (await call('POST', '/v1/public-access/off', {})).json();
    expect(r.on).toBe(false);
    expect(r.warning).toContain('tailscale funnel --https=8443 off');
    expect(h.app.publicAccess!.status().listening).toBe(false);
    await expect(fetch(`http://127.0.0.1:${h.port}/healthz`)).rejects.toThrow();
  });

  it('"only invited people" cannot be switched off while public access is on', async () => {
    const { call } = await start();
    await call('POST', '/v1/public-access/on', { confirm: true });
    expect((await call('POST', '/v1/public-access/invited-only', { on: false })).statusCode).toBe(409);
    await call('POST', '/v1/public-access/off', {});
    expect((await call('POST', '/v1/public-access/invited-only', { on: false })).statusCode).toBe(200);
    expect(envNow().has('HATCHABOT_PUBLIC_INVITED_ONLY')).toBe(false);
    expect((await call('POST', '/v1/public-access/invited-only', { on: true })).json().invitedOnly).toBe(true);
    expect(envNow().get('HATCHABOT_PUBLIC_INVITED_ONLY')).toBe('1');
  });
});

describe('the tailscale module', () => {
  it('under a test runner, with no shim named, nothing that changes Tailscale runs', async () => {
    const saved = process.env.HATCHABOT_TAILSCALE_BIN;
    delete process.env.HATCHABOT_TAILSCALE_BIN;
    try {
      for (const r of [await funnelOn(8092, 8443, 8080), await funnelOff(8092, 8443), await enableServe(8080)]) {
        expect(r.ok).toBe(false);
        expect(r.error).toContain('Tests never change');
      }
    } finally { if (saved !== undefined) process.env.HATCHABOT_TAILSCALE_BIN = saved; }
  });

  it('funnelOn refuses a port Funnel does not have, and takes itself back if the result is not what was asked', async () => {
    process.env.HATCHABOT_TAILSCALE_BIN = shim.bin;
    try {
      expect((await funnelOn(8092, 8080, 8080)).error).toContain('443, 8443, 10000');
      const port = await freePort();
      expect(await funnelOn(port, 10000, 8080)).toMatchObject({ ok: true, url: `https://${SHIM_DNS}:10000` });
      expect(await funnelOn(port, 443, 8080)).toMatchObject({ ok: true, url: `https://${SHIM_DNS}` });
      expect((await funnelOff(port, 8443)).ok).toBe(true); // every entry that lands on the public listener goes, whichever port
      expect(shim.config().AllowFunnel).toEqual({});
      expect((await funnelPreflight()).ok).toBe(true);
    } finally { delete process.env.HATCHABOT_TAILSCALE_BIN; }
  });

  it('reads Funnel\'s configuration: what is public, and where it lands', () => {
    const st = parseFunnelStatus(JSON.stringify({
      AllowFunnel: { 'box.example.com:8443': true, 'box.example.com:443': false, 'box.example.com:10000': true },
      Web: { 'box.example.com:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8092' } } }, 'box.example.com:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } },
      TCP: { 10000: { TCPForward: '127.0.0.1:8080' } },
    }));
    expect(st.readable).toBe(true);
    expect(st.entries.map((e) => e.port)).toEqual([8443, 10000]); // 443 is served to the tailnet only
    expect(targetsPort(st.entries[0]!, 8092)).toBe(true);
    expect(targetsPort(st.entries[0]!, 8080)).toBe(false);
    expect(targetsPort(st.entries[0]!, 809)).toBe(false);
    expect(targetsPort(st.entries[1]!, 8080)).toBe(true); // a raw TCP forward to the private port counts
    expect(parseFunnelStatus('{}')).toEqual({ readable: true, entries: [] });
    expect(parseFunnelStatus('')).toEqual({ readable: true, entries: [] });
    expect(parseFunnelStatus('not json').readable).toBe(false);
    expect(parseFunnelStatus(undefined).readable).toBe(false);
  });
});
