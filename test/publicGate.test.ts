import { afterEach, describe, expect, it } from 'vitest';
import { Jar, publicApp, type PublicApp } from './helpers/publicApp.js';
import { totp } from '../src/api/totp.js';
import { PASS_COOKIE } from '../src/api/publicAccess.js';

let h: PublicApp | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe('the public listener: fail closed', () => {
  it('serves while every safeguard holds, and answers 503 to everyone the minute one does not', async () => {
    h = await publicApp();
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    expect((await h.pub('/')).status).toBe(200);
    // The owner's only second factor goes (reset at the private address): safeguard b is off.
    h.store.deleteSecondFactors(h.store.listLocalAccounts()[0]!.id);
    await h.app.publicAccess!.evaluate();
    const r = await h.pub('/');
    expect(r.status).toBe(503);
    expect((await h.pub('/v1/config')).status).toBe(503);
    expect((await h.pub('/v1/login', { body: { username: 'owner', password: 'x' } })).status).toBe(503);
    expect(h.store.listSecurityLog().some((e) => e.kind === 'public.paused')).toBe(true);
  });

  it('a fresh machine (no owner yet) serves nothing publicly, and can not be claimed there', async () => {
    h = await publicApp();
    await h.app.publicAccess!.evaluate();
    expect(h.app.publicAccess!.status().failing.map((c) => c.id)).toContain('second-factor');
    expect((await h.pub('/v1/local-accounts/bootstrap', { body: { username: 'thief', password: 'long-enough-pw' } })).status).toBe(503);
    expect(h.store.countLocalAccounts()).toBe(0);
  });

  it('password mode never serves the public address', async () => {
    h = await publicApp({ mode: 'password' });
    await h.app.publicAccess!.evaluate();
    expect((await h.pub('/')).status).toBe(503);
    expect((await h.pub('/v1/login', { body: { password: 'shared-pw' } })).status).toBe(503);
  });

  it('the private side is untouched by any of it', async () => {
    h = await publicApp();
    const o = await h.addAccount('owner', { owner: true });
    const login = await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'owner', password: o.password } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    // No second factor, no pass, machine routes and unclassified routes all work as before.
    expect((await h.app.inject({ url: '/v1/agents', headers: { cookie } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: '/v1/hosts', headers: { cookie } })).statusCode).toBe(200);
    expect((await h.app.inject({ url: '/v1/unclassified-thing', headers: { cookie } })).statusCode).toBe(200);
    expect(String(login.headers['set-cookie'])).not.toContain(PASS_COOKIE);
  });
});

describe('the public listener: who gets what', () => {
  it('open routes need no sign-in; everything else does; never-routes and unclassified routes are refused whoever asks', async () => {
    h = await publicApp();
    const o = await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    expect((await h.pub('/')).status).toBe(200);
    expect((await h.pub('/v1/config')).status).toBe(200);
    expect((await h.pub('/v1/agents')).status).toBe(401);
    expect((await h.pub('/v1/unclassified-thing')).status).toBe(403);
    expect((await h.pub('/v1/agents/a1/message', { body: {} })).status).toBe(403);
    expect((await h.pub('/v1/no-such-route')).status).toBe(403);
    // Signed in with the second factor given: still refused.
    const jar = await h.signIn('owner', o.password, { totpSecret: o.totpSecret });
    expect((await h.pub('/v1/agents', { jar })).status).toBe(200);
    expect((await h.pub('/v1/unclassified-thing', { jar })).status).toBe(403);
    expect((await h.pub('/v1/agents/a1/message', { jar, body: {} })).status).toBe(403);
  });

  it('an owner is asked for the second factor: until then only the second-factor screen works', async () => {
    h = await publicApp();
    const o = await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const jar = new Jar();
    expect((await h.pub('/v1/login', { body: { username: 'owner', password: o.password }, jar })).status).toBe(200);
    const blocked = await h.pub('/v1/agents', { jar });
    expect(blocked.status).toBe(401);
    expect(blocked.json.secondFactor).toBe('required');
    expect((await h.pub('/v1/second-factor', { jar })).status).toBe(200);
    // A wrong code is a 401 and changes nothing.
    expect((await h.pub('/v1/second-factor/verify', { jar, body: { code: '000000' } })).status).toBe(401);
    expect((await h.pub('/v1/agents', { jar })).status).toBe(401);
    expect((await h.pub('/v1/second-factor/verify', { jar, body: { code: totp(o.totpSecret!, Date.now() + 30_000) } })).status).toBe(200);
    expect((await h.pub('/v1/agents', { jar })).json.me).toBe(o.id);
  });

  it('a member without a second factor signs in with a password; one who enrolled is asked for it', async () => {
    h = await publicApp();
    await h.addAccount('owner', { owner: true });
    const m = await h.addAccount('member');
    const m2 = await h.addAccount('careful', { totp: true });
    await h.app.publicAccess!.evaluate();
    const jar = await h.signIn('member', m.password);
    expect((await h.pub('/v1/agents', { jar })).status).toBe(200);
    const jar2 = await h.signIn('careful', m2.password);
    expect((await h.pub('/v1/agents', { jar: jar2 })).json.secondFactor).toBe('required');
  });

  it('machine-level routes need the second factor given again recently (step-up); a member without one is refused', async () => {
    h = await publicApp({ env: { HATCHABOT_PUBLIC_STEPUP_MINUTES: '1' } });
    const o = await h.addAccount('owner', { owner: true });
    const m = await h.addAccount('member');
    await h.app.publicAccess!.evaluate();
    const jar = await h.signIn('owner', o.password, { totpSecret: o.totpSecret });
    expect((await h.pub('/v1/hosts', { jar, body: {} })).status).toBe(200);
    expect((await h.pub('/v1/cli-tokens', { jar, body: {} })).status).toBe(200);
    // …and once the step-up window has passed, it is asked for again; reads still work.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 2 * 60_000;
      const again = await h.pub('/v1/hosts', { jar, body: {} });
      expect(again.status).toBe(401);
      expect(again.json.secondFactor).toBe('step-up');
      expect((await h.pub('/v1/hosts', { jar })).status).toBe(200);
      expect((await h.pub('/v1/second-factor/verify', { jar, body: { code: totp(o.totpSecret!, Date.now() + 30_000) } })).status).toBe(200);
      expect((await h.pub('/v1/hosts', { jar, body: {} })).status).toBe(200);
    } finally { Date.now = realNow; }
    const mj = await h.signIn('member', m.password);
    const refused = await h.pub('/v1/cli-tokens', { jar: mj, body: {} });
    expect(refused.status).toBe(403);
    expect(refused.json.secondFactor).toBe('missing');
  });

  it('a session from the private address does not carry over: the public address wants its own sign-in', async () => {
    h = await publicApp();
    const o = await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const login = await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'owner', password: o.password }, headers: { 'x-forwarded-proto': 'https' } });
    const jar = new Jar();
    const pair = String(login.headers['set-cookie']).split(';')[0]!;
    jar.cookies.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
    expect(pair.startsWith('__Host-hatchabot_session=')).toBe(true);
    const r = await h.pub('/v1/agents', { jar });
    expect(r.status).toBe(401);
    expect(r.json.publicSignIn).toBe(true);
  });

  it('a public session left idle ends, long before the session cookie does', async () => {
    h = await publicApp({ env: { HATCHABOT_PUBLIC_IDLE_MINUTES: '5' } });
    const m = await h.addAccount('member');
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const jar = await h.signIn('member', m.password);
    expect((await h.pub('/v1/agents', { jar })).status).toBe(200);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 6 * 60_000;
      expect((await h.pub('/v1/agents', { jar })).status).toBe(401);
    } finally { Date.now = realNow; }
  });

  it('the pass is bound to its session and cannot be forged or moved to another', async () => {
    h = await publicApp();
    const o = await h.addAccount('owner', { owner: true });
    const m = await h.addAccount('member');
    await h.app.publicAccess!.evaluate();
    const ownerJar = await h.signIn('owner', o.password, { totpSecret: o.totpSecret });
    const memberJar = await h.signIn('member', m.password);
    // The attack the binding is for: someone with an account of their own and
    // their own second factor (given), and the OWNER's password but not the
    // owner's second factor, puts their own pass beside the owner's session.
    const mallory = await h.addAccount('mallory', { totp: true });
    const malloryJar = await h.signIn('mallory', mallory.password, { totpSecret: mallory.totpSecret });
    const stolen = new Jar();
    await h.pub('/v1/login', { body: { username: 'owner', password: o.password }, jar: stolen }); // password only
    const mixed = new Jar();
    mixed.cookies.set('__Host-hatchabot_session', stolen.cookies.get('__Host-hatchabot_session')!);
    mixed.cookies.set(PASS_COOKIE, malloryJar.cookies.get(PASS_COOKIE)!);
    const r = await h.pub('/v1/agents', { jar: mixed });
    expect(r.status).toBe(401);
    expect(r.json.publicSignIn).toBe(true); // the pass is not this session's: not even "second factor wanted"
    // …and a member's session with the owner's pass is no session of the owner's.
    const mixed2 = new Jar();
    mixed2.cookies.set('__Host-hatchabot_session', memberJar.cookies.get('__Host-hatchabot_session')!);
    mixed2.cookies.set(PASS_COOKIE, ownerJar.cookies.get(PASS_COOKIE)!);
    expect((await h.pub('/v1/agents', { jar: mixed2 })).status).toBe(401);
    // A pass with its second-factor time edited: the signature no longer matches.
    const forged = new Jar();
    forged.cookies.set('__Host-hatchabot_session', ownerJar.cookies.get('__Host-hatchabot_session')!);
    const parts = ownerJar.cookies.get(PASS_COOKIE)!.split('.');
    parts[4] = String(Date.now());
    forged.cookies.set(PASS_COOKIE, parts.join('.'));
    expect((await h.pub('/v1/agents', { jar: forged })).status).toBe(401);
  });

  it('cookies at the public address are __Host-, Secure, HttpOnly, SameSite=Strict whatever the headers say', async () => {
    h = await publicApp();
    const m = await h.addAccount('member');
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    // No X-Forwarded-Proto at all: a plain-http cookie would be handed out if the header decided.
    const r = await h.pub('/v1/login', { body: { username: 'member', password: m.password }, headers: { 'x-forwarded-proto': '' } });
    const cookies = r.res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThanOrEqual(3);
    for (const c of cookies.filter((x) => !/Max-Age=0/i.test(x))) {
      expect(c).toMatch(/^__Host-/);
      expect(c).toMatch(/; Secure/i);
      expect(c).toMatch(/; HttpOnly/i);
      expect(c).toMatch(/; SameSite=Strict/i);
    }
  });

  it('answers carry HSTS, a content security policy, no-sniff, no referrer, and frame-ancestors', async () => {
    h = await publicApp();
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const r = await h.pub('/');
    expect(r.res.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
    const csp = r.res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*https?:/); // accounts mode: no script from anywhere else
    expect(r.res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.res.headers.get('referrer-policy')).toBe('no-referrer');
    // …and none of that is added at the private address.
    const priv = await h.app.inject({ url: '/' });
    expect(priv.headers['strict-transport-security']).toBeUndefined();
    expect(priv.headers['content-security-policy']).toBeUndefined();
  });
});
