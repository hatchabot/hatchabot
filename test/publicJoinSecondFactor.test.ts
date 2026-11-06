import { describe, expect, it } from 'vitest';
import { Jar } from './helpers/publicApp.js';
import { agentRow, at, closeAfterEach, privCookie, world, type World } from './helpers/publicWorld.js';
import { publicConfig } from '../src/api/safeguards.js';
import { createInvite } from '../src/orchestrator/invite.js';

/**
 * HB-0400: at the public address, a web-chat invitation refused for want of a
 * second factor looked the same as no sign-in at all, so the join page asked
 * for the right password again, for ever, with no message. The refusal stands;
 * the answer now says why, and only to someone whose sign-in is good.
 */
closeAfterEach();

const NO_SIGN_IN = { error: 'Sign in to this Hatchabot first.', signIn: true };

async function invited(w: World): Promise<{ code: () => string; seats: () => number }> {
  if (!w.h.store.getAgent('a1')) w.h.store.insertAgent(agentRow('a1', w.owner.id, { state: 'STOPPED' }));
  return {
    code: () => createInvite(w.h.store, 'a1', w.owner.id, undefined, { webChat: true }).code,
    seats: () => (w.h.store.rawDb().prepare(`SELECT COUNT(*) AS n FROM memberships WHERE agent_id = 'a1'`).get() as { n: number }).n,
  };
}

describe('a web-chat invitation at the public address, refused for want of a second factor (HB-0400)', () => {
  it('no sign-in that is good gets exactly the old answer, and learns nothing of the account', async () => {
    const w = await world({}, { on: true });
    const inv = await invited(w);
    const m = await w.h.addAccount('member');
    // No session at all.
    const none = await w.h.pub('/v1/join', { body: { code: inv.code(), name: 'N' } });
    expect([none.status, none.json]).toEqual([401, NO_SIGN_IN]);
    // A wrong password makes no session, whether or not the name is real.
    for (const username of ['member', 'nobody-here']) {
      const jar = new Jar();
      expect((await w.h.pub('/v1/login', { jar, body: { username, password: 'not-the-password' } })).status).toBe(401);
      const after = await w.h.pub('/v1/join', { jar, body: { code: inv.code(), name: 'N' } });
      expect([after.status, after.json], username).toEqual([401, NO_SIGN_IN]);
    }
    // A session cookie that has been changed.
    const good = await w.h.signIn('member', m.password);
    const forged = good.header().replace(/=(.)/g, (_all, c: string) => `=${c === 'A' ? 'B' : 'A'}`);
    const changed = await w.h.pub('/v1/join', { headers: { cookie: forged }, body: { code: inv.code(), name: 'N' } });
    expect([changed.status, changed.json]).toEqual([401, NO_SIGN_IN]);
    // A public sign-in left idle past its limit: the pass is gone.
    await at(publicConfig().idleMs + 120_000, async () => {
      const idle = await w.h.pub('/v1/join', { jar: good, body: { code: inv.code(), name: 'N' } });
      expect([idle.status, idle.json]).toEqual([401, NO_SIGN_IN]);
    });
    // A good session from the private address has no public pass: it signs in here first, as before.
    const priv = await privCookie(w.h, 'member', m.password);
    const noPass = await w.h.pub('/v1/join', { headers: { cookie: priv }, body: { code: inv.code(), name: 'N' } });
    expect([noPass.status, noPass.json]).toEqual([401, NO_SIGN_IN]);
    expect(inv.seats()).toBe(0);
  }, 60_000);

  it('a right password with no factor is told what to do, instead of being asked for the password again', async () => {
    const w = await world({}, { on: true });
    const inv = await invited(w);
    const newcomer = await w.h.addAccount('newcomer');
    const jar = await w.h.signIn('newcomer', newcomer.password);
    const r = await w.h.pub('/v1/join', { jar, body: { code: inv.code(), name: 'N' } });
    expect(r.status).toBe(401);
    expect(r.json.signIn).toBeUndefined();
    expect(r.json.secondFactor).toBe('enrol-link');
    expect(r.json.error).toMatch(/second factor/);
    expect(r.json.error).toMatch(/reset link/);
    // Someone who owns nothing could also be let in as a guest, by the owner's switch.
    expect(r.json.error).toMatch(/chat-only guests/);
    expect(inv.seats()).toBe(0);
    // The refusal is as strict as ever, and the page's next try still gets it.
    expect((await w.h.pub('/v1/join', { jar, body: { code: inv.code(), name: 'N' } })).json.secondFactor).toBe('enrol-link');
  }, 60_000);

  it('someone who owns an agent cannot become a guest, so is not told to ask for that', async () => {
    const w = await world({}, { on: true });
    const inv = await invited(w);
    const member = await w.h.addAccount('member');
    w.h.store.insertAgent(agentRow('m1', member.id));
    const jar = await w.h.signIn('member', member.password);
    const off = await w.h.pub('/v1/join', { jar, body: { code: inv.code(), name: 'M' } });
    expect(off.json.secondFactor).toBe('enrol-link');
    expect(off.json.error).not.toMatch(/guest/);
    // The switch on changes nothing for them.
    expect((await w.call('POST', '/v1/public-access/guests', { on: true, confirm: true })).statusCode).toBe(200);
    const on = await w.h.pub('/v1/join', { jar, body: { code: inv.code(), name: 'M' } });
    expect(on.status).toBe(401);
    expect(on.json.secondFactor).toBe('enrol-link');
    expect(on.json.error).not.toMatch(/guest/);
    expect(inv.seats()).toBe(0);
  }, 60_000);

  it('a factor not yet given in this browser is asked for, and the same link then works', async () => {
    const w = await world({}, { on: true });
    const inv = await invited(w);
    const member = await w.h.addAccount('member', { totp: true });
    const jar = await w.h.signIn('member', member.password);
    const code = inv.code();
    const r = await w.h.pub('/v1/join', { jar, body: { code, name: 'M' } });
    expect(r.status).toBe(401);
    expect(r.json.signIn).toBeUndefined();
    expect(r.json.secondFactor).toBe('required');
    expect(r.json.error).toMatch(/second factor/);
    expect(inv.seats()).toBe(0);
    // Once given, in the same browser: the invitation was not spent by the refusal.
    const given = await w.h.signIn('member', member.password, { totpSecret: member.totpSecret });
    const ok = await w.h.pub('/v1/join', { jar: given, body: { code, name: 'M' } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(inv.seats()).toBe(1);
  }, 60_000);

  it('arriving by a fresh out-of-band link: told to add the factor now', async () => {
    const w = await world({}, { on: true });
    const inv = await invited(w);
    const member = await w.h.addAccount('member');
    const cookie = await privCookie(w.h, 'member', member.password);
    const made = await w.h.app.inject({ method: 'POST', url: '/v1/local-accounts/me/recovery-code', headers: { cookie }, payload: { current: member.password } });
    expect(made.statusCode, made.body).toBe(200);
    const jar = new Jar();
    const rec = await w.h.pub('/v1/local-accounts/recover-with-code', { jar, body: { username: 'member', code: made.json().recoveryCode, password: 'a-new-long-made-up-passphrase' } });
    expect(rec.status, JSON.stringify(rec.json)).toBe(200);
    const r = await w.h.pub('/v1/join', { jar, body: { code: inv.code(), name: 'M' } });
    expect(r.status).toBe(401);
    expect(r.json.secondFactor).toBe('enrol');
    expect(r.json.signIn).toBeUndefined();
    expect(r.json.error).toMatch(/half an hour/);
    expect(inv.seats()).toBe(0);
  }, 60_000);

  it('an account with owner rights and no factor is sent to the private address', async () => {
    const w = await world({}, { on: true });
    const inv = await invited(w);
    const other = await w.h.addAccount('coowner', { owner: true, totp: false });
    const jar = await w.h.signIn('coowner', other.password);
    const r = await w.h.pub('/v1/join', { jar, body: { code: inv.code(), name: 'C' } });
    expect(r.status).toBe(401);
    expect(r.json.secondFactor).toBe('missing');
    expect(r.json.error).toMatch(/private address/);
    expect(r.json.error).not.toMatch(/guest/);
    expect(inv.seats()).toBe(0);
  }, 60_000);

  it('a chat-only guest allowed by the switch still joins, and a signed-in member with the factor given', async () => {
    const w = await world({}, { on: true });
    const inv = await invited(w);
    expect((await w.call('POST', '/v1/public-access/guests', { on: true, confirm: true })).statusCode).toBe(200);
    const newcomer = await w.h.addAccount('newcomer');
    const jar = await w.h.signIn('newcomer', newcomer.password);
    const ok = await w.h.pub('/v1/join', { jar, body: { code: inv.code(), name: 'N' } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.webChat).toBe(true);
  }, 60_000);
});
