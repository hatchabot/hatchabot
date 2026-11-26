import { describe, expect, it } from 'vitest';
import { agentRow, closeAfterEach, privCookie, world, type World } from './helpers/publicWorld.js';
import { checkInvite, createInvite, InviteInvalidError, redeemInvite } from '../src/orchestrator/members/invite.js';

/**
 * HB-1149: someone signed in here with a password account who joined an
 * ordinary chat-app invitation became a member nobody could sign in as
 * (`member-…`), never their own account, so the agent was not on their home
 * screen and web chat could not be given to them. The owner's decision
 * (2026-11-24): the join page asks, "Join as <name>" or "Join with <app>
 * only", and only an explicit "Join as" binds the seat to the account. Never
 * silently: on a shared computer it would bind whoever is signed in.
 */
closeAfterEach();

const NO_SIGN_IN = { error: 'Sign in to this Hatchabot first.', signIn: true };

async function invited(w: World) {
  if (!w.h.store.getAgent('a1')) w.h.store.insertAgent(agentRow('a1', w.owner.id, { name: 'Homework Helper' }));
  const robin = await w.h.addAccount('robin', { totp: false });
  const cookie = await privCookie(w.h, 'robin', robin.password);
  const code = () => createInvite(w.h.store, 'a1', w.owner.id).code;
  const look = async (c: string, cookieHeader?: string) => (await w.h.app.inject({ method: 'GET', url: `/v1/invites/${c}`, headers: cookieHeader ? { cookie: cookieHeader } : {} })).json();
  const join = (c: string, body: Record<string, unknown>, cookieHeader?: string) =>
    w.h.app.inject({ method: 'POST', url: '/v1/join', headers: cookieHeader ? { cookie: cookieHeader } : {}, payload: { code: c, name: 'Robin', channel: 'telegram', ...body } });
  const seats = () => w.h.store.listMemberships('a1').filter((m) => m.role !== 'owner');
  return { robin, cookie, code, look, join, seats };
}

describe('a chat-app invitation and someone signed in here (HB-1149)', () => {
  it('the invitation says who this browser is signed in as, and whether it is their own agent; signed out, neither', async () => {
    const w = await world();
    const inv = await invited(w);
    const c = inv.code();
    const anon = await inv.look(c);
    expect(anon).toMatchObject({ valid: true, agentName: 'Homework Helper', authMode: 'accounts', localAccounts: true });
    expect(anon.webChat).toBeUndefined();
    expect(anon.signedInAs).toBeUndefined();
    expect(anon.own).toBeUndefined();
    const robin = await inv.look(c, inv.cookie);
    expect(robin.signedInAs).toBe('robin');
    expect(robin.own).toBeUndefined();
    const owner = await privCookie(w.h, 'owner', w.owner.password);
    expect(await inv.look(c, owner)).toMatchObject({ signedInAs: 'owner', own: true });
  }, 60_000);

  it('"Join as" binds the seat to the account: the agent is theirs to open, and web chat can be given', async () => {
    const w = await world();
    const inv = await invited(w);
    const c = inv.code();
    const r = await inv.join(c, { asAccount: true }, inv.cookie);
    expect(r.statusCode, r.body).toBe(201);
    expect(inv.seats().map((m) => m.userId)).toEqual([inv.robin.id]);
    expect(checkInvite(w.h.store, c)).toEqual({ valid: false, reason: 'used' });
    const theirs = (await w.h.app.inject({ method: 'GET', url: '/v1/agents', headers: { cookie: inv.cookie } })).json() as Array<{ id: string }>;
    expect(theirs.map((a) => a.id)).toContain('a1');
    const on = await w.call('PUT', `/v1/agents/a1/members/${inv.robin.id}/web-chat`, { on: true });
    expect(on.statusCode, on.body).toBe(200);
  }, 60_000);

  it('never silently: signed in but joining with the app only makes a seat of its own, as before', async () => {
    const w = await world();
    const inv = await invited(w);
    for (const body of [{}, { asAccount: false }]) {
      const r = await inv.join(inv.code(), body, inv.cookie);
      expect(r.statusCode, r.body).toBe(201);
    }
    const seats = inv.seats();
    expect(seats).toHaveLength(2);
    expect(seats.every((m) => m.userId !== inv.robin.id && m.userId.startsWith('member-'))).toBe(true);
  }, 60_000);

  it('someone on the agent already is told so, not "already used": no "Join as" offered, and the invitation left as it was (HB-1149 review)', async () => {
    const w = await world();
    const inv = await invited(w);
    expect((await inv.join(inv.code(), { asAccount: true }, inv.cookie)).statusCode).toBe(201);
    const again = inv.code();
    expect(await inv.look(again, inv.cookie)).toMatchObject({ valid: true, signedInAs: 'robin', alreadyMember: true });
    expect((await inv.look(again)).alreadyMember).toBeUndefined();
    const r = await inv.join(again, { asAccount: true }, inv.cookie);
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'You are already on this agent, so this invite was not used.', alreadyMember: true }]);
    expect(checkInvite(w.h.store, again)).toMatchObject({ valid: true });
    expect(inv.seats().map((m) => m.userId)).toEqual([inv.robin.id]);
    // Any other way in as that account (a Google sign-in) says the same, and leaves the invitation too.
    let thrown: unknown;
    try { redeemInvite(w.h.store, again, 'Robin', inv.robin.id); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(InviteInvalidError);
    expect((thrown as InviteInvalidError).userMessage).toBe('You are already on this agent, so this invite was not used.');
    expect(checkInvite(w.h.store, again)).toMatchObject({ valid: true });
  }, 60_000);

  it('"Join as" with no sign-in, or by the agent\'s owner, is refused and leaves the invitation as it was', async () => {
    const w = await world();
    const inv = await invited(w);
    const c = inv.code();
    const none = await inv.join(c, { asAccount: true });
    expect([none.statusCode, none.json()]).toEqual([401, NO_SIGN_IN]);
    const forged = await inv.join(c, { asAccount: true }, inv.cookie.replace(/=(.)/, (_all, ch: string) => `=${ch === 'A' ? 'B' : 'A'}`));
    expect([forged.statusCode, forged.json()]).toEqual([401, NO_SIGN_IN]);
    const owner = await privCookie(w.h, 'owner', w.owner.password);
    const own = await inv.join(c, { asAccount: true }, owner);
    expect(own.statusCode, own.body).toBe(400);
    expect(own.json().error).toBe('This is your own agent — you can already talk to it.');
    expect(inv.seats()).toHaveLength(0);
    expect(checkInvite(w.h.store, c)).toMatchObject({ valid: true });
  }, 60_000);

  it('at the public address, "Join as" counts a session only with what the gate asks of it', async () => {
    const w = await world({}, { on: true });
    const inv = await invited(w);
    // A good session from the private address has no public pass there.
    const noPass = await w.h.pub('/v1/join', { headers: { cookie: inv.cookie }, body: { code: inv.code(), name: 'R', channel: 'telegram', asAccount: true } });
    expect([noPass.status, noPass.json]).toEqual([401, NO_SIGN_IN]);
    // Signed in at the public address, short of a second factor: told so, not bound.
    const jar = await w.h.signIn('robin', inv.robin.password);
    const c = inv.code();
    const look = await w.h.pub(`/v1/invites/${c}`, { jar });
    expect(look.json.signedInAs).toBeUndefined();
    expect(look.json.factor?.secondFactor).toBe('enrol-link');
    const short = await w.h.pub('/v1/join', { jar, body: { code: c, name: 'R', channel: 'telegram', asAccount: true } });
    expect(short.status).toBe(401);
    expect(short.json.secondFactor).toBe('enrol-link');
    expect(inv.seats()).toHaveLength(0);
    expect(checkInvite(w.h.store, c)).toMatchObject({ valid: true });
  }, 60_000);
});
