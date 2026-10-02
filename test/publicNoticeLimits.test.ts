import { describe, expect, it } from 'vitest';
import { Jar, publicApp, type PublicApp } from './helpers/publicApp.js';
import { at, closeAfterEach, ctx } from './helpers/publicWorld.js';

/**
 * New-device notices are limited per person and overall, so one valid
 * password cannot be used to spam the owner (docs/public-access.md).
 */
let h: PublicApp | undefined;
closeAfterEach();

// ---- B3. new-device notices are limited ----------------------------------------

describe('new-device notices cannot be used to spam', () => {
  const newBrowser = async (app: PublicApp, username: string, password: string): Promise<void> => {
    const jar = new Jar();
    await app.pub('/v1/login', { body: { username, password }, jar });
    await app.pub('/v1/agents', { jar });
  };

  it('one notice per person and account in ten minutes, the next saying how many were left out; the record keeps every sign-in', async () => {
    const sent: Array<{ to: string; text: string }> = [];
    h = ctx.h = await publicApp({ probes: { telegram: async (to, text) => { sent.push({ to, text }); return true; } } });
    const o = await h.addAccount('owner', { owner: true });
    const m = await h.addAccount('member');   // a valid password is all this takes: the second factor comes after the notice
    const m2 = await h.addAccount('second');
    await h.app.publicAccess!.evaluate();
    for (let i = 0; i < 6; i++) await newBrowser(h, 'member', m.password);
    expect(sent.map((s) => s.to).sort()).toEqual([m.id, o.id].sort());
    expect(h.store.listSecurityNotices(m.id)).toHaveLength(1);
    expect(h.store.listSecurityNotices(o.id)).toHaveLength(1);
    expect(h.store.listSecurityLog().filter((e) => e.kind === 'public.signin' && e.detail.newDevice === true)).toHaveLength(6);
    // Another account's sign-in is its own matter: the owner hears of it at once.
    await newBrowser(h, 'second', m2.password);
    expect(sent.filter((s) => s.to === o.id)).toHaveLength(2);
    expect(sent.filter((s) => s.to === m2.id)).toHaveLength(1);
    // Eleven minutes on: the next one goes out, and says five were not announced.
    sent.length = 0;
    await at(11 * 60_000, async () => { await newBrowser(h!, 'member', m.password); });
    expect(sent.map((s) => s.to).sort()).toEqual([m.id, o.id].sort());
    for (const s of sent) expect(s.text).toContain('5 more new-device sign-ins as member');
    expect(h.store.listSecurityNotices(o.id)[0]!.text).toContain('5 more');
    // …and the one after that, with nothing left out in between, says nothing of the kind.
    sent.length = 0;
    await at(22 * 60_000, async () => { await newBrowser(h!, 'member', m.password); });
    expect(sent).toHaveLength(2);
    for (const s of sent) expect(s.text).not.toContain('more new-device');
  }, 60_000);

  it('a ceiling a day for each person, and for everyone together', async () => {
    const sent: Array<{ to: string; text: string }> = [];
    h = ctx.h = await publicApp({ probes: { telegram: async (to, text) => { sent.push({ to, text }); return true; } }, env: { HATCHABOT_PUBLIC_REQS_PER_MIN_PER_ADDRESS: '100000', HATCHABOT_PUBLIC_REQS_PER_MIN: '100000' } });
    const o = await h.addAccount('owner', { owner: true });
    const members = [] as Array<{ id: string; password: string; name: string }>;
    for (const name of ['m1', 'm2', 'm3', 'm4', 'm5']) members.push({ ...(await h.addAccount(name)), name });
    await h.app.publicAccess!.evaluate();
    // Start at the top of a day, so the whole run is inside one.
    const dayStart = (Math.floor(Date.now() / 86_400_000) + 2) * 86_400_000 - Date.now();
    // A sign-in every eleven minutes, 25 times, for five accounts: 125 sign-ins, each a new browser.
    for (let round = 0; round < 25; round++) {
      await at(dayStart + round * 11 * 60_000, async () => { for (const m of members) await newBrowser(h!, m.name, m.password); });
    }
    const to = (id: string) => sent.filter((s) => s.to === id).length;
    for (const m of members) expect(to(m.id), m.name).toBeLessThanOrEqual(20);
    expect(to(o.id)).toBe(20);                    // the owner, told about five accounts: twenty a day, not 125
    expect(sent.length).toBe(100);                // everyone together
    expect(h.store.listSecurityLog(1000).filter((e) => e.kind === 'public.signin')).toHaveLength(125);
    // The next day it starts again.
    sent.length = 0;
    await at(dayStart + 86_400_000 + 60_000, async () => { await newBrowser(h!, 'm1', members[0]!.password); });
    expect(sent.map((s) => s.to).sort()).toEqual([members[0]!.id, o.id].sort());
  }, 180_000);
});

