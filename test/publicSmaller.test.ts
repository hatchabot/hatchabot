import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Jar, PUBLIC_HOST, PUBLIC_URL, publicApp, type PublicApp } from './helpers/publicApp.js';
import { SoftAuthenticator } from './helpers/softAuthenticator.js';
import { agentRow, closeAfterEach, ctx, privCookie, world } from './helpers/publicWorld.js';
import { createInvite } from '../src/orchestrator/invite.js';
import { totp } from '../src/api/totp.js';

/**
 * The smaller findings of the second review that were cheap and clearly
 * right to fix (docs/public-access.md, "Open"): invitation-code guesses are
 * counted, the second-factor screen shows nothing of the factors before the
 * factor is given, an owner's passkey must verify its user, and the page
 * keeps addresses out of script strings.
 */
let h: PublicApp | undefined;
closeAfterEach();

// ---- C. the smaller ones ---------------------------------------------------------

describe('smaller fixes', () => {
  it('guesses at an invitation code are counted: ten misses, then refused; a real link from elsewhere still opens; the password form is not locked by it', async () => {
    const w = await world({}, { on: true });
    w.h.store.insertAgent(agentRow('a1', w.owner.id, { state: 'STOPPED' }));
    const code = createInvite(w.h.store, 'a1', w.owner.id).code;
    const used = createInvite(w.h.store, 'a1', w.owner.id).code;
    w.h.store.rawDb().prepare(`UPDATE invites SET redeemed_at = 'now' WHERE code = ?`).run(used);
    // Coming back to a used link is not a guess, however often.
    for (let i = 0; i < 15; i++) expect((await w.h.pub(`/v1/invites/${used}`, { from: '198.51.100.20' })).json).toEqual({ valid: false, reason: 'used' });
    expect((await w.h.pub(`/v1/invites/${code}`, { from: '198.51.100.20' })).json.valid).toBe(true);
    // Guesses are.
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await w.h.pub(`/v1/invites/GUESS${i}XYZ`, { from: '198.51.100.21' })).status);
    expect(statuses).toEqual([...Array(10).fill(200), 429, 429]);
    // Now even the right code is not answered for that address…
    expect((await w.h.pub(`/v1/invites/${code}`, { from: '198.51.100.21' })).status).toBe(429);
    // …another address is, and the guesser can still sign in (the counts are apart).
    expect((await w.h.pub(`/v1/invites/${code}`, { from: '198.51.100.22' })).json.valid).toBe(true);
    expect((await w.h.pub('/v1/login', { body: { username: 'owner', password: w.owner.password }, from: '198.51.100.21' })).status).toBe(200);
    // The same at the private address.
    const priv: number[] = [];
    for (let i = 0; i < 12; i++) priv.push((await w.h.app.inject({ url: `/v1/invites/GUESS${i}XYZ`, remoteAddress: '10.1.2.3' })).statusCode);
    expect(priv).toEqual([...Array(10).fill(200), 429, 429]);
    expect((await w.h.app.inject({ url: `/v1/invites/${code}`, remoteAddress: '10.1.2.4' })).json().valid).toBe(true);
  }, 60_000);

  it('before the second factor is given, the second-factor screen learns which kinds to offer and nothing about the factors themselves', async () => {
    h = ctx.h = await publicApp();
    const o = await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const id = h.store.listSecondFactors(o.id, { kind: 'totp' })[0]!.id;
    const jar = new Jar();
    await h.pub('/v1/login', { body: { username: 'owner', password: o.password }, jar });
    const before = await h.pub('/v1/second-factor', { jar });
    expect(before.status).toBe(200);
    expect(before.json).toMatchObject({ factors: [], hidden: true, backupCodes: null, need: 'yes' });
    expect(before.json.methods).toEqual(['totp', 'backup']);
    expect(JSON.stringify(before.json)).not.toContain(id);
    expect(JSON.stringify(before.json)).not.toMatch(/lastUsedAt|createdAt|label/);
    // Given: the list is theirs to see.
    expect((await h.pub('/v1/second-factor/verify', { jar, body: { code: totp(o.totpSecret!, Date.now() + 30_000) } })).status).toBe(200);
    const after = await h.pub('/v1/second-factor', { jar });
    expect(after.json.hidden).toBeUndefined();
    expect(after.json.factors).toHaveLength(1);
    expect(after.json.factors[0]).toMatchObject({ id, kind: 'totp' });
    expect(after.json.factors[0].lastUsedAt).toBeTruthy();
    expect(after.json.backupCodes).toBe(10);
    // At the private address, as before.
    const cookie = await privCookie(h, 'owner', o.password);
    expect((await h.app.inject({ url: '/v1/second-factor', headers: { cookie } })).json().factors[0].id).toBe(id);
  }, 30_000);

  it('a passkey of someone with owner rights must verify its user (asked for, and checked in the answer); a member\'s need not', async () => {
    h = ctx.h = await publicApp();
    const o = await h.addAccount('owner', { owner: true });
    const m = await h.addAccount('member');
    await h.app.publicAccess!.evaluate();
    const hdrFor = async (username: string, password: string) => ({ cookie: await privCookie(h!, username, password), origin: PUBLIC_URL, host: `${PUBLIC_HOST}:8443` });
    const register = async (hdr: Record<string, string>, password: string, key: SoftAuthenticator) => {
      const opt = await h!.app.inject({ method: 'POST', url: '/v1/second-factor/passkey/options', headers: hdr, payload: { current: password } });
      const reg = await h!.app.inject({ method: 'POST', url: '/v1/second-factor/passkey', headers: hdr, payload: key.create({ challenge: (opt.json() as { challenge: string }).challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }) });
      return { opt: opt.json() as { authenticatorSelection: { userVerification: string } }, reg };
    };
    const oh = await hdrFor('owner', o.password);
    // A key that is only touched (no PIN, no fingerprint): refused for the owner.
    const touchOnly = new SoftAuthenticator('ES256'); touchOnly.extraFlags = 0;
    const bad = await register(oh, o.password, touchOnly);
    expect(bad.opt.authenticatorSelection.userVerification).toBe('required');
    expect(bad.reg.statusCode).toBe(400);
    expect(bad.reg.json().error).toContain('user verification was required');
    expect(h.store.listSecondFactors(o.id, { kind: 'passkey' })).toEqual([]);
    // One that verifies its user: added.
    const key = new SoftAuthenticator('ES256');
    expect((await register(oh, o.password, key)).reg.statusCode).toBe(200);
    // At sign-in: asked for, and an answer without it is refused though the key and signature are right.
    const answer = async (flags: number) => {
      const jar = new Jar();
      await h!.pub('/v1/login', { body: { username: 'owner', password: o.password }, jar });
      const ch = await h!.pub('/v1/second-factor/challenge', { jar, body: {} });
      expect(ch.json.userVerification).toBe('required');
      key.extraFlags = flags;
      return h!.pub('/v1/second-factor/verify', { jar, body: { passkey: key.get({ challenge: ch.json.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }) } });
    };
    expect((await answer(0)).status).toBe(401);
    expect((await answer(0x04)).status).toBe(200);
    // A member: preferred, and a touch-only key is accepted.
    const mh = await hdrFor('member', m.password);
    const memberKey = new SoftAuthenticator('ES256'); memberKey.extraFlags = 0;
    const ok = await register(mh, m.password, memberKey);
    expect(ok.opt.authenticatorSelection.userVerification).toBe('preferred');
    expect(ok.reg.statusCode, ok.reg.body).toBe(200);
    const mj = new Jar();
    await h.pub('/v1/login', { body: { username: 'member', password: m.password }, jar: mj });
    const mch = await h.pub('/v1/second-factor/challenge', { jar: mj, body: {} });
    expect(mch.json.userVerification).toBe('preferred');
    expect((await h.pub('/v1/second-factor/verify', { jar: mj, body: { passkey: memberKey.get({ challenge: mch.json.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }) } })).status).toBe(200);
  }, 30_000);

  it('the page puts an address a button copies in a data attribute, never inside a script string', () => {
    const html = readFileSync(join(import.meta.dirname, '../web/index.html'), 'utf8');
    // esc() makes text safe for HTML, not for a JavaScript string inside an attribute: after the browser decodes the attribute, a quote is a quote again.
    expect(html).not.toMatch(/on\w+="[^"\n]*\('\$\{esc\(/);
    expect(html).toContain('data-copy="${esc(r.url)}" onclick="copyText(this.dataset.copy)');
  });
});
