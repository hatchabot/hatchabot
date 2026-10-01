import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { Jar, PUBLIC_HOST, publicApp, type PublicApp } from './helpers/publicApp.js';
import { deviceLabel, publicCsp } from '../src/api/publicAccess.js';

let h: PublicApp | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

describe('new-device notices and the security record', () => {
  it('a first sign-in from a browser is announced to the person and to the owner; the same browser again is not', async () => {
    const sent: Array<{ to: string; text: string }> = [];
    h = await publicApp({ probes: { telegram: async (to, text) => { sent.push({ to, text }); return true; }, appUrl: () => `https://${PUBLIC_HOST}` } });
    const o = await h.addAccount('owner', { owner: true });
    const m = await h.addAccount('member');
    await h.app.publicAccess!.evaluate();

    const jar = new Jar();
    await h.pub('/v1/login', { body: { username: 'member', password: m.password }, jar, headers: { 'user-agent': CHROME }, from: '203.0.113.77' });
    expect(sent).toEqual([]); // nothing until the session is first used
    await h.pub('/v1/agents', { jar, headers: { 'user-agent': CHROME }, from: '203.0.113.77' });
    await h.pub('/v1/agents', { jar, headers: { 'user-agent': CHROME }, from: '203.0.113.77' });
    // The person, and the owner: once each.
    expect(sent.map((s) => s.to).sort()).toEqual([m.id, o.id].sort());
    const mine = sent.find((s) => s.to === m.id)!.text;
    expect(mine).toContain('member');
    expect(mine).toContain('Chrome on Android');
    expect(mine).toContain('203.0.113.x'); // approximate, not the full address
    expect(mine).not.toContain('203.0.113.77');
    expect(mine).toContain('Sign out on every device');
    expect(sent.find((s) => s.to === o.id)!.text).toContain('sign member out everywhere');
    // In the app too, for both.
    expect(h.store.listSecurityNotices(m.id)).toHaveLength(1);
    expect(h.store.listSecurityNotices(o.id)[0]).toMatchObject({ kind: 'new-device', aboutOwner: m.id });
    // The record has the sign-in, with the full address.
    expect(h.store.listSecurityLog().find((e) => e.kind === 'public.signin')).toMatchObject({ ownerId: m.id, detail: { from: '203.0.113.77', device: 'Chrome on Android', newDevice: true } });

    // The same browser signs in again (it kept its device cookie): recorded, not announced.
    sent.length = 0;
    await h.pub('/v1/login', { body: { username: 'member', password: m.password }, jar, headers: { 'user-agent': CHROME } });
    await h.pub('/v1/agents', { jar, headers: { 'user-agent': CHROME } });
    expect(sent).toEqual([]);
    expect(h.store.listSecurityLog().filter((e) => e.kind === 'public.signin').map((e) => e.detail.newDevice)).toEqual([false, true]);

    // Another browser: announced again.
    const other = new Jar();
    await h.pub('/v1/login', { body: { username: 'member', password: m.password }, jar: other });
    await h.pub('/v1/agents', { jar: other });
    expect(sent.map((s) => s.to).sort()).toEqual([m.id, o.id].sort());
  });

  it('the owner is told even when the second factor is never given (someone has the password)', async () => {
    const sent: string[] = [];
    h = await publicApp({ probes: { telegram: async (to) => { sent.push(to); return true; } } });
    const o = await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const jar = new Jar();
    await h.pub('/v1/login', { body: { username: 'owner', password: o.password }, jar });
    expect((await h.pub('/v1/agents', { jar })).status).toBe(401);
    expect(sent).toEqual([o.id]);
    expect(h.store.listSecurityNotices(o.id)).toHaveLength(1);
  });

  it('"sign out everywhere" ends the public session and forgets the browsers', async () => {
    h = await publicApp({ fullRoutes: true });
    const o = await h.addAccount('owner', { owner: true });
    const m = await h.addAccount('member');
    await h.app.publicAccess!.evaluate();
    const jar = await h.signIn('member', m.password);
    expect((await h.pub('/v1/agents', { jar })).status).toBe(200);
    expect(h.store.listDevices(m.id)).toHaveLength(1);
    // The owner, from the notice, signs the member out everywhere (at the private address).
    const login = await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'owner', password: o.password } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const notices = (await h.app.inject({ url: '/v1/security/notices', headers: { cookie } })).json();
    expect(notices.canSignOutOthers).toBe(true);
    expect(notices.notices[0].aboutOwner).toBe(m.id);
    expect((await h.app.inject({ method: 'POST', url: `/v1/security/sign-out/${m.id}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await h.pub('/v1/agents', { jar })).status).toBe(401);
    expect(h.store.listDevices(m.id)).toEqual([]);
    // A notice is dismissed by its own reader only.
    const id = notices.notices[0].id;
    expect((await h.app.inject({ method: 'POST', url: `/v1/security/notices/${id}/seen`, headers: { cookie } })).json().ok).toBe(true);
    expect((await h.app.inject({ url: '/v1/security/notices', headers: { cookie } })).json().notices).toEqual([]);
    // A member cannot sign anyone out, nor read the record.
    const ml = await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'member', password: m.password } });
    const mc = String(ml.headers['set-cookie']).split(';')[0]!;
    expect((await h.app.inject({ method: 'POST', url: `/v1/security/sign-out/${o.id}`, headers: { cookie: mc } })).statusCode).toBe(403);
    expect((await h.app.inject({ url: '/v1/security/log', headers: { cookie: mc } })).statusCode).toBe(403);
    const log = (await h.app.inject({ url: '/v1/security/log', headers: { cookie } })).json().entries;
    expect(log.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['public.signin', 'signed_out_everywhere']));
    expect(log.find((e: any) => e.kind === 'public.signin').who).toBe('member');
  });

  it('describes a browser in a few words', () => {
    expect(deviceLabel(CHROME)).toBe('Chrome on Android');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0')).toBe('Firefox on Windows');
    expect(deviceLabel('curl/8.5.0')).toBe('curl');
    expect(deviceLabel(undefined)).toBe('an unknown browser');
  });

  it('the content security policy allows Google only in Google sign-in mode', () => {
    expect(publicCsp('accounts')).not.toContain('google');
    expect(publicCsp('identity')).toContain('https://accounts.google.com');
    for (const mode of ['accounts', 'identity']) {
      expect(publicCsp(mode)).toContain("frame-ancestors 'self'");
      expect(publicCsp(mode)).toContain("base-uri 'self'");
      expect(publicCsp(mode)).not.toContain('unsafe-eval');
      expect(publicCsp(mode)).not.toMatch(/(script|default)-src[^;]*\*/);
    }
  });
});

describe('only invited people (Google sign-in)', () => {
  const verifier = { verify: async (t: string) => ({ sub: t, email: `${t}@example.com`, emailVerified: true, expMs: Date.now() + 3_600_000 }) };

  it('at the public address a Google account nobody invited is refused; one that is known signs in', async () => {
    h = await publicApp({ mode: 'identity', verifier });
    // The machine's owner (a Google account), with an authenticator app, set up at the private address.
    h.store.insertHost({ id: 'h', ownerId: 'user-owner', kind: 'local', provider: 'mock', name: 'm', settings: {}, createdAt: 'now' });
    const s = await h.app.inject({ method: 'POST', url: '/v1/session', payload: { idToken: 'owner' } });
    expect(s.statusCode).toBe(200);
    h.store.recordAccount('user-owner', 'owner@example.com');
    h.store.insertSecondFactor({ id: 'f', ownerId: 'user-owner', kind: 'totp', data: 'sealed' });
    await h.app.publicAccess!.evaluate();
    expect(h.app.publicAccess!.status().failing).toEqual([]);

    const stranger = await h.pub('/v1/session', { body: { idToken: 'stranger' } });
    expect(stranger.status).toBe(403);
    expect(stranger.json.error).toContain('invited');
    expect(stranger.res.headers.getSetCookie().join()).not.toContain('hatchabot_session=');
    expect(h.store.emailForOwner('user-stranger')).toBeUndefined(); // no account came of it
    // The same stranger at the private address is this install's own business (unchanged).
    expect((await h.app.inject({ method: 'POST', url: '/v1/session', payload: { idToken: 'tailnet-friend' } })).statusCode).toBe(200);
    // Someone already known (they have signed in here before) may sign in publicly.
    h.store.recordAccount('user-friend', 'friend@example.com');
    const jar = new Jar();
    expect((await h.pub('/v1/session', { body: { idToken: 'friend' }, jar })).status).toBe(200);
    expect((await h.pub('/v1/agents', { jar })).json.me).toBe('user-friend');
    // The owner signs in with Google and is still asked for the second factor.
    const oj = new Jar();
    expect((await h.pub('/v1/session', { body: { idToken: 'owner' }, jar: oj })).status).toBe(200);
    expect((await h.pub('/v1/agents', { jar: oj })).json.secondFactor).toBe('required');
    // A Google token as a bearer is not accepted there at all…
    expect((await h.pub('/v1/agents', { headers: { authorization: 'Bearer friend' } })).status).toBe(401);
    // …and beside a valid public session it is ignored: the session decides who this is.
    h.store.recordAccount('user-other', 'other@example.com');
    expect((await h.pub('/v1/agents', { jar, headers: { authorization: 'Bearer other' } })).json.me).toBe('user-friend');
    expect(h.store.listSecurityLog().some((e) => e.kind === 'public.signin_refused')).toBe(true);
  });

  it('an invitation counts: a pending share addressed to them, or a seat on an agent', async () => {
    h = await publicApp({ mode: 'identity', verifier });
    expect(h.store.identityIsInvited('new', 'new@example.com')).toBe(false);
    h.store.rawDb().prepare(`INSERT INTO agent_shares (id, from_owner, to_email, agent_name, blob, status, created_at) VALUES ('s1', 'user-owner', 'New@Example.com', 'A', x'00', 'pending', 'now')`).run();
    expect(h.store.identityIsInvited('new', 'new@example.com')).toBe(true);
    expect(h.store.identityIsInvited('other', 'other@example.com')).toBe(false);
    h.store.rawDb().prepare(`INSERT INTO memberships (id, agent_id, user_id, role, status) VALUES ('m1', 'a1', 'user-other', 'member', 'active')`).run();
    expect(h.store.identityIsInvited('other', undefined)).toBe(true);
  });
});

describe('the console\'s WebSocket at the public address', () => {
  const upgrade = (port: number, path: string, cookie: string) => new Promise<string>((resolve) => {
    const s = connect(port, '127.0.0.1', () => {
      s.write(`GET ${path} HTTP/1.1\r\nHost: ${PUBLIC_HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`);
    });
    let got = '';
    s.on('data', (d) => { got += String(d); });
    s.on('close', () => resolve(got || 'closed'));
    s.on('error', () => resolve('closed'));
    setTimeout(() => { s.destroy(); resolve(got || 'open'); }, 1500);
  });

  it('is dropped without the public pass and the second factor, and for any path that is not a console', async () => {
    const reasons: Array<string | undefined> = [];
    h = await publicApp({ extra: (app) => {
      // Stands in for the console proxy's handler (routes.ts): it asks the gate exactly as that one does.
      app.server.on('upgrade', (req, socket) => {
        const principal = app.principalFromCookieHeader!(req.headers.cookie, true);
        if (!principal) { reasons.push('no session'); socket.destroy(); return; }
        const why = app.publicAccess!.refuseUpgrade(req, principal.ownerId);
        reasons.push(why);
        if (why) { socket.destroy(); return; }
        socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
      });
    } });
    const o = await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    expect(await upgrade(h.port, '/v1/agents/a1/ui/', '')).toBe('closed');
    expect(await upgrade(h.port, '/v1/something-else', '')).toBe('closed');
    // A session from the private address: no pass.
    const login = await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'owner', password: o.password }, headers: { 'x-forwarded-proto': 'https' } });
    expect(await upgrade(h.port, '/v1/agents/a1/ui/', String(login.headers['set-cookie']).split(';')[0]!)).toBe('closed');
    // Signed in publicly, second factor not given yet.
    const half = new Jar();
    await h.pub('/v1/login', { body: { username: 'owner', password: o.password }, jar: half });
    expect(await upgrade(h.port, '/v1/agents/a1/ui/', half.header())).toBe('closed');
    // Fully signed in: through.
    const jar = await h.signIn('owner', o.password, { totpSecret: o.totpSecret });
    expect(await upgrade(h.port, '/v1/agents/a1/ui/', jar.header())).toContain('101');
    expect(reasons).toEqual(['no session', 'no public pass', 'second factor not given', undefined]);
  });
});
