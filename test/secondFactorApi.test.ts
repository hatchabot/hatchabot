import { afterEach, describe, expect, it } from 'vitest';
import { Jar, PUBLIC_HOST, PUBLIC_URL, publicApp, type PublicApp } from './helpers/publicApp.js';
import { base32Decode, totp } from '../src/api/totp.js';
import { SoftAuthenticator } from './helpers/softAuthenticator.js';

let h: PublicApp | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const priv = async (h: PublicApp, username: string, password: string) => {
  const login = await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username, password } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  return (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({ method: method as 'GET', url, headers: { cookie, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
};

describe('second factors: enrolment', () => {
  it('an authenticator app: the secret counts only once a code from it is confirmed; backup codes come with the first factor', async () => {
    h = await publicApp({ off: true });
    const o = await h.addAccount('owner', { owner: true, totp: false });
    const call = await priv(h, 'owner', o.password);
    // Proof beyond the session: the current password.
    expect((await call('POST', '/v1/second-factor/totp', {})).statusCode).toBe(401);
    expect((await call('POST', '/v1/second-factor/totp', { current: 'wrong' })).statusCode).toBe(401);
    const start = (await call('POST', '/v1/second-factor/totp', { current: o.password })).json();
    expect(start.uri).toMatch(/^otpauth:\/\/totp\/Hatchabot%3Aowner\?secret=/);
    expect(start.qr).toContain('<svg');
    expect(h.app.publicAccess!.secondFactorNeed(o.id)).toBe('missing'); // not confirmed: counts for nothing
    expect((await call('POST', '/v1/second-factor/totp/confirm', { id: start.id, code: '000000' })).statusCode).toBe(401);
    const secret = base32Decode(start.secret);
    const done = (await call('POST', '/v1/second-factor/totp/confirm', { id: start.id, code: totp(secret) })).json();
    expect(done.backupCodes).toHaveLength(10);
    expect(h.app.publicAccess!.secondFactorNeed(o.id)).toBe('yes');
    const st = (await call('GET', '/v1/second-factor')).json();
    expect(st.factors.map((f: any) => f.kind)).toEqual(['totp']);
    expect(st.backupCodes).toBe(10);
    // The secret is not readable from the database.
    const row = h.store.listSecondFactors(o.id, { kind: 'totp' })[0]!;
    expect(row.data).not.toContain(start.secret);
    expect(Buffer.from(row.data).includes(secret)).toBe(false);
  });

  it('a passkey: made at the https address it will be used at, refused anywhere else', async () => {
    h = await publicApp({ off: true });
    const o = await h.addAccount('owner', { owner: true, totp: false });
    const call = await priv(h, 'owner', o.password);
    const at = { origin: `https://${PUBLIC_HOST}`, host: PUBLIC_HOST };
    // From localhost: a passkey made there would be for "localhost".
    const wrong = await call('POST', '/v1/second-factor/passkey/options', { current: o.password }, { origin: 'http://localhost:8080', host: 'localhost:8080' });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error).toContain(`https://${PUBLIC_HOST}`);
    expect((await call('POST', '/v1/second-factor/passkey/options', {}, at)).statusCode).toBe(401); // the password
    const opts = (await call('POST', '/v1/second-factor/passkey/options', { current: o.password }, at)).json();
    expect(opts.rp.id).toBe(PUBLIC_HOST);
    expect(opts.attestation).toBe('none');
    expect(opts.pubKeyCredParams.map((p: any) => p.alg)).toEqual([-7, -8, -257]);
    const key = new SoftAuthenticator('ES256');
    // An answer made for another origin is refused, and its challenge is spent.
    const bad = await call('POST', '/v1/second-factor/passkey', key.create({ challenge: opts.challenge, origin: 'https://evil.example', rpId: PUBLIC_HOST }), at);
    expect(bad.statusCode).toBe(400);
    expect((await call('POST', '/v1/second-factor/passkey', key.create({ challenge: opts.challenge, origin: at.origin, rpId: PUBLIC_HOST }), at)).statusCode).toBe(409);
    const opts2 = (await call('POST', '/v1/second-factor/passkey/options', { current: o.password }, at)).json();
    const added = await call('POST', '/v1/second-factor/passkey', { label: 'Laptop', ...key.create({ challenge: opts2.challenge, origin: at.origin, rpId: PUBLIC_HOST }) }, at);
    expect(added.statusCode).toBe(200);
    expect(added.json().backupCodes).toHaveLength(10);
    // The same passkey twice: refused.
    const opts3 = (await call('POST', '/v1/second-factor/passkey/options', { current: o.password }, at)).json();
    expect(opts3.excludeCredentials).toHaveLength(1);
    expect((await call('POST', '/v1/second-factor/passkey', key.create({ challenge: opts3.challenge, origin: at.origin, rpId: PUBLIC_HOST }), at)).statusCode).toBe(409);
    expect(h.app.publicAccess!.secondFactorNeed(o.id)).toBe('yes');
    return { o, key };
  });
});

describe('second factors: at the public address', () => {
  it('a passkey signs in; its challenge is single use; someone else\'s passkey does not', async () => {
    h = await publicApp();
    const o = await h.addAccount('owner', { owner: true, totp: false });
    const m = await h.addAccount('member');
    const call = await priv(h, 'owner', o.password);
    const at = { origin: `https://${PUBLIC_HOST}`, host: PUBLIC_HOST };
    const opts = (await call('POST', '/v1/second-factor/passkey/options', { current: o.password }, at)).json();
    const key = new SoftAuthenticator('ES256');
    await call('POST', '/v1/second-factor/passkey', key.create({ challenge: opts.challenge, origin: at.origin, rpId: PUBLIC_HOST }), at);
    await h.app.publicAccess!.evaluate();
    expect(h.app.publicAccess!.status().serving).toBe(true);

    const jar = new Jar();
    await h.pub('/v1/login', { body: { username: 'owner', password: o.password }, jar });
    const ch = (await h.pub('/v1/second-factor/challenge', { jar, body: {} })).json;
    expect(ch.allowCredentials).toHaveLength(1);
    const answer = key.get({ challenge: ch.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST });
    expect((await h.pub('/v1/second-factor/verify', { jar, body: { passkey: answer } })).status).toBe(200);
    expect((await h.pub('/v1/agents', { jar })).status).toBe(200);
    // The same answer again (a replay): its challenge is gone.
    const jar2 = new Jar();
    await h.pub('/v1/login', { body: { username: 'owner', password: o.password }, jar: jar2 });
    expect((await h.pub('/v1/second-factor/verify', { jar: jar2, body: { passkey: answer } })).status).toBe(401);
    expect((await h.pub('/v1/agents', { jar: jar2 })).status).toBe(401);
    // A member with a passkey of their own gets a challenge of their own; the OWNER's passkey answering it is not theirs.
    const mcall = await priv(h, 'member', m.password);
    const mopts = (await mcall('POST', '/v1/second-factor/passkey/options', { current: m.password }, at)).json();
    const mkey = new SoftAuthenticator('ES256');
    expect((await mcall('POST', '/v1/second-factor/passkey', mkey.create({ challenge: mopts.challenge, origin: at.origin, rpId: PUBLIC_HOST }), at)).statusCode).toBe(200);
    const mj = new Jar();
    await h.pub('/v1/login', { body: { username: 'member', password: m.password }, jar: mj });
    const mch = (await h.pub('/v1/second-factor/challenge', { jar: mj, body: {} })).json;
    expect(mch.allowCredentials.map((c: any) => c.id)).toEqual([mkey.credentialId.toString('base64url')]);
    expect((await h.pub('/v1/second-factor/verify', { jar: mj, body: { passkey: key.get({ challenge: mch.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }) } })).status).toBe(401);
    expect((await h.pub('/v1/agents', { jar: mj })).status).toBe(401);
    // Their own passkey, on a fresh challenge: yes.
    const mch2 = (await h.pub('/v1/second-factor/challenge', { jar: mj, body: {} })).json;
    expect((await h.pub('/v1/second-factor/verify', { jar: mj, body: { passkey: mkey.get({ challenge: mch2.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }) } })).status).toBe(200);
  });

  it('an authenticator code is good once; a backup code is good once', async () => {
    h = await publicApp();
    const o = await h.addAccount('owner', { owner: true, totp: false });
    const call = await priv(h, 'owner', o.password);
    const start = (await call('POST', '/v1/second-factor/totp', { current: o.password })).json();
    const secret = base32Decode(start.secret);
    const { backupCodes } = (await call('POST', '/v1/second-factor/totp/confirm', { id: start.id, code: totp(secret) })).json();
    await h.app.publicAccess!.evaluate();
    const fresh = async () => { const jar = new Jar(); await h!.pub('/v1/login', { body: { username: 'owner', password: o.password }, jar }); return jar; };
    const code = totp(secret, Date.now() + 30_000);
    const j1 = await fresh();
    expect((await h.pub('/v1/second-factor/verify', { jar: j1, body: { code } })).status).toBe(200);
    const j2 = await fresh();
    expect((await h.pub('/v1/second-factor/verify', { jar: j2, body: { code } })).status).toBe(401); // the same code, a second time
    expect((await h.pub('/v1/second-factor/verify', { jar: j2, body: { code: totp(secret) } })).status).toBe(401); // and an earlier step
    const used = await h.pub('/v1/second-factor/verify', { jar: j2, body: { code: backupCodes[0].toLowerCase() } });
    expect(used.status).toBe(200);
    expect(used.json).toMatchObject({ method: 'backup', backupCodes: 9 });
    const j3 = await fresh();
    expect((await h.pub('/v1/second-factor/verify', { jar: j3, body: { code: backupCodes[0] } })).status).toBe(401);
    expect((await h.pub('/v1/second-factor/verify', { jar: j3, body: { code: backupCodes[1] } })).status).toBe(200);
    expect(h.store.listSecurityLog().filter((e) => e.kind === 'public.second_factor').map((e) => e.detail.method)).toEqual(['backup', 'backup', 'totp']);
  });

  it('a password reset does not get around the second factor', async () => {
    h = await publicApp();
    const o = await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    // A reset link (as Telegram recovery would send), used at the public address.
    h.store.setLocalAccountClaim(o.id, 'reset-code-123', new Date(Date.now() + 600_000).toISOString());
    const jar = new Jar();
    expect((await h.pub('/v1/local-accounts/claim', { body: { code: 'reset-code-123', password: 'a-brand-new-password' }, jar })).status).toBe(200);
    expect((await h.pub('/v1/agents', { jar })).json.secondFactor).toBe('required');
  });

  it('removing or replacing a factor there needs the second factor again; adding the first needs the password', async () => {
    h = await publicApp({ env: { HATCHABOT_PUBLIC_STEPUP_MINUTES: '1' } });
    const o = await h.addAccount('owner', { owner: true });
    const m = await h.addAccount('member');
    await h.app.publicAccess!.evaluate();
    const jar = await h.signIn('owner', o.password, { totpSecret: o.totpSecret });
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 2 * 60_000;
      const r = await h.pub('/v1/second-factor/backup-codes', { jar, body: {} });
      expect(r.status).toBe(401);
      expect(r.json.secondFactor).toBe('step-up');
      const id = h.store.listSecondFactors(o.id, { kind: 'totp' })[0]!.id;
      expect((await h.pub(`/v1/second-factor/${id}`, { jar, method: 'DELETE' })).json.secondFactor).toBe('step-up');
    } finally { Date.now = realNow; }
    // A member with no factor may add their first one there, with their password.
    const mj = await h.signIn('member', m.password);
    expect((await h.pub('/v1/second-factor/totp', { jar: mj, body: {} })).status).toBe(401);
    const start = await h.pub('/v1/second-factor/totp', { jar: mj, body: { current: m.password } });
    expect(start.status).toBe(200);
    const done = await h.pub('/v1/second-factor/totp/confirm', { jar: mj, body: { id: start.json.id, code: totp(base32Decode(start.json.secret)) } });
    expect(done.status).toBe(200);
    // …and from then on they are asked for it.
    const again = await h.signIn('member', m.password);
    expect((await h.pub('/v1/agents', { jar: again })).json.secondFactor).toBe('required');
  });

  it('the owner\'s last factor cannot be removed while public access is on; a reset by the owner pauses public access at once', async () => {
    h = await publicApp();
    const o = await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const call = await priv(h, 'owner', o.password);
    const id = h.store.listSecondFactors(o.id, { kind: 'totp' })[0]!.id;
    const no = await call('DELETE', `/v1/second-factor/${id}`, { current: o.password });
    expect(no.statusCode).toBe(409);
    expect(h.store.listSecondFactors(o.id)).not.toHaveLength(0);
    // The reset (a lost phone) is the private address's, and public access stops serving in the same breath.
    const jar = await h.signIn('owner', o.password, { totpSecret: o.totpSecret });
    expect((await h.pub('/v1/second-factor/reset/me', { jar, body: {} })).status).toBe(403);
    const reset = await call('POST', '/v1/second-factor/reset/owner', {});
    expect(reset.json()).toMatchObject({ ok: true, publicAccess: 'paused' });
    expect((await h.pub('/')).status).toBe(503);
    // A member cannot reset anyone.
    const m = await h.addAccount('member');
    const mcall = await priv(h, 'member', m.password);
    expect((await mcall('POST', '/v1/second-factor/reset/owner', {})).statusCode).toBe(403);
  });
});
