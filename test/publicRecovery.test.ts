import { describe, expect, it } from 'vitest';
import { Jar } from './helpers/publicApp.js';
import { SHIM_DNS } from './helpers/tailscaleShim.js';
import { at, closeAfterEach, privCookie, resetRecoveryLimits, withTelegram, world, type World } from './helpers/publicWorld.js';

/**
 * Recovery at the public address (the owner's decisions after the second
 * review, 2026-10-01): an account with owner rights is recovered at the
 * private address only, and "Forgot password?" asked from the internet is
 * held tight (docs/public-access.md).
 */
closeAfterEach();

// ---- B1. owner-rights recovery is refused at the public address ------------------

describe('an account with owner rights is recovered at the private address only', () => {
  it('a reset link for the owner: refused there (page and form), plainly, and still good at the private address', async () => {
    const w = await world({}, { on: true });
    const before = w.h.store.localAccount(w.owner.id)!.pwHash;
    w.h.store.setLocalAccountClaim(w.owner.id, 'owner-reset-link', new Date(Date.now() + 600_000).toISOString());
    const page = await w.h.pub('/v1/local-accounts/claim?code=owner-reset-link');
    expect(page.status).toBe(403);
    expect(page.json.error).toContain('private address only');
    const jar = new Jar();
    const form = await w.h.pub('/v1/local-accounts/claim', { jar, body: { code: 'owner-reset-link', password: 'a-thief-chose-this-one' } });
    expect(form.status).toBe(403);
    expect(form.json).toMatchObject({ privateOnly: true });
    expect(jar.cookies.size).toBe(0);
    expect(w.h.store.localAccount(w.owner.id)!.pwHash).toBe(before);
    // The link was not spent by the refusal: at the private address it works.
    const priv = await w.h.app.inject({ method: 'POST', url: '/v1/local-accounts/claim', payload: { code: 'owner-reset-link', password: 'the-owner-chose-this-one' } });
    expect(priv.statusCode, priv.body).toBe(200);
    // Owner rights held through the machine's row (not the account's own flag) count the same.
    const co = await w.h.addAccount('co-owner', { totp: true });
    w.h.store.rawDb().prepare(`UPDATE hosts SET owner_id = ? WHERE kind = 'local'`).run(co.id);
    expect(w.h.app.publicAccess!.hasOwnerRights(co.id)).toBe(true);
    w.h.store.setLocalAccountClaim(co.id, 'co-owner-reset-link', new Date(Date.now() + 600_000).toISOString());
    expect((await w.h.pub('/v1/local-accounts/claim?code=co-owner-reset-link')).status).toBe(403);
    expect((await w.h.pub('/v1/local-accounts/claim', { body: { code: 'co-owner-reset-link', password: 'a-thief-chose-this-one' } })).json).toMatchObject({ privateOnly: true });
    // A member's reset link works at the public address, as before.
    const m = await w.h.addAccount('member');
    w.h.store.setLocalAccountClaim(m.id, 'member-reset-link', new Date(Date.now() + 600_000).toISOString());
    expect((await w.h.pub('/v1/local-accounts/claim?code=member-reset-link')).json).toMatchObject({ username: 'member', reset: true });
    expect((await w.h.pub('/v1/local-accounts/claim', { body: { code: 'member-reset-link', password: 'the-member-chose-this' } })).status).toBe(200);
  }, 60_000);

  it('the owner\'s recovery code: refused there even when right (and not spent); a wrong one is answered as for anyone; a member\'s works', async () => {
    const w = await world({}, { on: true });
    const cookie = await privCookie(w.h, 'owner', w.owner.password);
    const code: string = (await w.h.app.inject({ method: 'POST', url: '/v1/local-accounts/me/recovery-code', headers: { cookie }, payload: { current: w.owner.password } })).json().recoveryCode;
    const before = w.h.store.localAccount(w.owner.id)!.pwHash;
    const jar = new Jar();
    const right = await w.h.pub('/v1/local-accounts/recover-with-code', { jar, body: { username: 'owner', code, password: 'a-thief-chose-this-one' } });
    expect(right.status).toBe(403);
    expect(right.json.error).toContain('private address only');
    expect(jar.cookies.size).toBe(0);
    expect(w.h.store.localAccount(w.owner.id)!.pwHash).toBe(before);
    // A wrong code tells a stranger nothing about whose account this is.
    const wrong = await w.h.pub('/v1/local-accounts/recover-with-code', { body: { username: 'owner', code: 'AAAAA-BBBBB-CCCCC-DDDDD', password: 'a-thief-chose-this-one' } });
    const nobody = await w.h.pub('/v1/local-accounts/recover-with-code', { body: { username: 'nobody-here', code: 'AAAAA-BBBBB-CCCCC-DDDDD', password: 'a-thief-chose-this-one' } });
    expect(wrong.status).toBe(401);
    expect(wrong.json).toEqual(nobody.json);
    // The same code, at the private address: the owner is back in.
    const priv = await w.h.app.inject({ method: 'POST', url: '/v1/local-accounts/recover-with-code', payload: { username: 'owner', code, password: 'the-owner-chose-this-one' } });
    expect(priv.statusCode, priv.body).toBe(200);
    // A member's recovery code works at the public address.
    const m = await w.h.addAccount('member');
    const mc = await privCookie(w.h, 'member', m.password);
    const mcode: string = (await w.h.app.inject({ method: 'POST', url: '/v1/local-accounts/me/recovery-code', headers: { cookie: mc }, payload: { current: m.password } })).json().recoveryCode;
    expect((await w.h.pub('/v1/local-accounts/recover-with-code', { body: { username: 'member', code: mcode, password: 'the-member-chose-this' } })).status).toBe(200);
  }, 60_000);

  it('"Forgot password?" for the owner at the public address makes no link: Telegram says where to go; asked privately, the link is for the private address', async () => {
    const w = await world({}, { on: true });
    withTelegram(w, w.owner.id, '424242');
    const r = await w.h.pub('/v1/local-accounts/recover', { body: { username: 'owner' } });
    expect(r.json).toEqual({ ok: true });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.text).not.toContain('claim=');
    expect(w.sent[0]!.text).toContain('private address only');
    expect(w.sent[0]!.text).toContain(`https://${SHIM_DNS}`);       // the private address
    expect(w.sent[0]!.text).not.toContain(':8443');                   // not the public one
    expect(w.h.store.localAccount(w.owner.id)!.claimCode).toBeUndefined();
    // Asked at the private address: a link, made for the private address (the public one would refuse it).
    w.sent.length = 0;
    await w.h.app.inject({ method: 'POST', url: '/v1/local-accounts/recover', payload: { username: 'owner' } });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.text).toMatch(new RegExp(`https://${SHIM_DNS.replace(/\./g, '\\.')}/\\?claim=[A-Za-z0-9_-]{20,}`));
    expect(w.sent[0]!.text).not.toContain(':8443');
    // A member's link is made for the public address while it is on (they may not be on the tailnet).
    const m = await w.h.addAccount('member');
    withTelegram(w, m.id, '515151');
    w.sent.length = 0;
    await w.h.app.inject({ method: 'POST', url: '/v1/local-accounts/recover', payload: { username: 'member' } });
    expect(w.sent[0]!.text).toContain(`https://${SHIM_DNS}:8443/?claim=`);
  }, 60_000);
});

// ---- B2. Telegram recovery asked for from the internet ----------------------------

describe('"Forgot password?" at the public address is held tight', () => {
  const ask = (w: World, username: string, from = '198.51.100.9') => w.h.pub('/v1/local-accounts/recover', { body: { username }, from });

  it('a username: once an hour, three times a day; a link that is still good is never replaced; the private address is untouched by it', async () => {
    const w = await world({}, { on: true });
    const m = await w.h.addAccount('member');
    withTelegram(w, m.id, '515151');
    expect((await ask(w, 'member')).json).toEqual({ ok: true });
    expect(w.sent).toHaveLength(1);
    const first = w.h.store.localAccount(m.id)!.claimCode;
    expect(first).toBeTruthy();
    // Again at once, and after six minutes (the private interval), from other addresses: nothing sent, the link not replaced.
    expect((await ask(w, 'member', '198.51.100.10')).json).toEqual({ ok: true });
    await at(6 * 60_000, async () => { await ask(w, 'MEMBER', '198.51.100.11'); });
    expect(w.sent).toHaveLength(1);
    expect(w.h.store.localAccount(m.id)!.claimCode).toBe(first);
    // An hour on (the first link has expired): the second of the day. Two hours: the third. Three: refused until tomorrow.
    await at(61 * 60_000, async () => { await ask(w, 'member', '198.51.100.12'); });
    expect(w.sent).toHaveLength(2);
    await at(122 * 60_000, async () => { await ask(w, 'member', '198.51.100.13'); });
    expect(w.sent).toHaveLength(3);
    await at(183 * 60_000, async () => { await ask(w, 'member', '198.51.100.14'); });
    await at(10 * 3_600_000, async () => { await ask(w, 'member', '198.51.100.15'); });
    expect(w.sent).toHaveLength(3);
    // The private address counts apart: the person on the tailnet is not kept out by what the internet asked.
    await at(10 * 3_600_000, async () => { await w.h.app.inject({ method: 'POST', url: '/v1/local-accounts/recover', payload: { username: 'member' } }); });
    expect(w.sent).toHaveLength(4);
    // The next day it may be asked for again.
    await at(25 * 3_600_000, async () => { await ask(w, 'member', '198.51.100.16'); });
    expect(w.sent).toHaveLength(5);
  }, 60_000);

  it('a pending link (the owner\'s reset link, good for two days) is not replaced from the internet; at the private address it is, as before', async () => {
    const w = await world({}, { on: true });
    const m = await w.h.addAccount('member');
    withTelegram(w, m.id, '515151');
    w.h.store.setLocalAccountClaim(m.id, 'the-owner-sent-this', new Date(Date.now() + 48 * 3_600_000).toISOString());
    await ask(w, 'member');
    expect(w.sent).toEqual([]);
    expect(w.h.store.localAccount(m.id)!.claimCode).toBe('the-owner-sent-this');
    // An expired one is not "pending".
    resetRecoveryLimits(w.h);
    w.h.store.setLocalAccountClaim(m.id, 'long-gone', new Date(Date.now() - 1000).toISOString());
    await ask(w, 'member');
    expect(w.sent).toHaveLength(1);
    expect(w.h.store.localAccount(m.id)!.claimCode).not.toBe('long-gone');
    // At the private address a pending link is replaced, as it always was.
    w.h.store.setLocalAccountClaim(m.id, 'the-owner-sent-this', new Date(Date.now() + 48 * 3_600_000).toISOString());
    await w.h.app.inject({ method: 'POST', url: '/v1/local-accounts/recover', payload: { username: 'member' } });
    expect(w.sent).toHaveLength(2);
    expect(w.h.store.localAccount(m.id)!.claimCode).not.toBe('the-owner-sent-this');
  }, 60_000);

  it('an address: five asks an hour; everyone together: thirty; and the answer is the same whatever happened', async () => {
    const w = await world({ HATCHABOT_PUBLIC_REQS_PER_MIN_PER_ADDRESS: '1000' }, { on: true });
    const m = await w.h.addAccount('member');
    withTelegram(w, m.id, '515151');
    const answers: string[] = [];
    const note = (r: { status: number; json: unknown }) => { answers.push(`${r.status} ${JSON.stringify(r.json)}`); };
    // Five made-up names from one address, then a real one: the sixth is not acted on.
    const all = async (asks: Array<Promise<{ status: number; json: unknown }>>) => { for (const r of await Promise.all(asks)) note(r); };
    await all(Array.from({ length: 5 }, (_, i) => ask(w, `made-up-${i}`, '203.0.113.50')));
    note(await ask(w, 'member', '203.0.113.50'));
    expect(w.sent).toEqual([]);
    // The name was not charged for the address's excess: from another address it is acted on.
    note(await ask(w, 'member', '203.0.113.51'));
    expect(w.sent).toHaveLength(1);
    // An IPv6 visitor is their /64, not each address in it.
    resetRecoveryLimits(w.h); w.sent.length = 0;
    w.h.store.setLocalAccountClaim(m.id, null, null);
    await all(Array.from({ length: 5 }, (_, i) => ask(w, `made-up-${i}`, `2001:db8:7:7::${(i + 1).toString(16)}`)));
    note(await ask(w, 'member', '2001:db8:7:7::ffff'));
    expect(w.sent).toEqual([]);
    // Everyone together: thirty asks an hour, each from its own address; the thirty-first, for a real account, is not acted on.
    resetRecoveryLimits(w.h);
    await all(Array.from({ length: 30 }, (_, i) => ask(w, `made-up-${i}`, `198.51.${i}.1`)));
    note(await ask(w, 'member', '192.0.2.99'));
    expect(w.sent).toEqual([]);
    // …and an hour later it is.
    await at(61 * 60_000, async () => { note(await ask(w, 'member', '192.0.2.99')); });
    expect(w.sent).toHaveLength(1);
    // A stranger sees one answer, always: sent, limited, unknown, an owner, no Telegram.
    const other = await w.h.addAccount('no-telegram');
    void other;
    note(await ask(w, 'no-telegram', '192.0.2.100'));
    note(await ask(w, 'owner', '192.0.2.101'));
    expect(new Set(answers)).toEqual(new Set(['200 {"ok":true}']));
  }, 120_000);
});

