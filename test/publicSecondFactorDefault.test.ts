import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { Jar, publicApp, type PublicApp } from './helpers/publicApp.js';
import { agentRow, at, closeAfterEach, ctx, envNow, extraRoutes, giveWebChat, privCookie, world } from './helpers/publicWorld.js';
import { publicConfig } from '../src/api/safeguards.js';
import { guestMay } from '../src/api/publicRoutes.js';
import { createInvite } from '../src/orchestrator/invite.js';
import { publicAccessFacts, publicAccessLines } from '../src/doctor.js';
import { base32Decode, totp } from '../src/api/totp.js';

/**
 * The owner's decision after the second review (2026-10-01): at the public
 * address a second factor is required of EVERY password account, by default.
 * Google accounts without owner rights stay exempt (Google is their factor).
 * Chat-only web-chat guests are exempt only by the owner's deliberate switch,
 * and then for the chat alone (docs/public-access.md).
 */
let h: PublicApp | undefined;
closeAfterEach();

// ---- A. a second factor, by default ---------------------------------------------

describe('a second factor is required of every password account at the public address', () => {
  it('a member with only a password gets the second-factor screen and nothing else, and is told plainly what to do', async () => {
    h = ctx.h = await publicApp({ extra: extraRoutes });
    await h.addAccount('owner', { owner: true });
    const m = await h.addAccount('member');
    await h.app.publicAccess!.evaluate();
    expect(h.app.publicAccess!.secondFactorNeed(m.id)).toBe('missing');
    const jar = await h.signIn('member', m.password);
    for (const [method, path] of [['GET', '/v1/agents'], ['POST', '/v1/agents'], ['PATCH', '/v1/agents/a1'], ['POST', '/v1/agents/a1/chat'], ['GET', '/v1/hosts'], ['POST', '/v1/hosts'], ['POST', '/v1/cli-tokens'], ['POST', '/v1/account/telegram']] as const) {
      const r = await h.pub(path, { method, jar, ...(method === 'GET' ? {} : { body: {} }) });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json.secondFactor, `${method} ${path}`).toBe('enrol-link');
      expect(r.json.error, `${method} ${path}`).toMatch(/reset link.*private address|private address.*reset link/);
    }
    // The second-factor screen answers (it says they have none)…
    const st = await h.pub('/v1/second-factor', { jar });
    expect(st.status).toBe(200);
    expect(st.json.need).toBe('missing');
    // …and the password, which is what a thief would hold, does not enrol a phone.
    const enrol = await h.pub('/v1/second-factor/totp', { jar, body: { current: m.password } });
    expect(enrol.status).toBe(403);
    expect(enrol.json.secondFactor).toBe('enrol-link');
    expect(h.store.listSecondFactors(m.id, { unconfirmed: true })).toEqual([]);
  }, 30_000);

  it('the old setting cannot switch it off: =0 is ignored (and reported), =1 changes nothing', async () => {
    h = ctx.h = await publicApp({ env: { HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL: '0' } });
    await h.addAccount('owner', { owner: true });
    const m = await h.addAccount('member');
    await h.app.publicAccess!.evaluate();
    const jar = await h.signIn('member', m.password);
    expect((await h.pub('/v1/agents', { jar })).status).toBe(403);
    for (const v of ['0', 'off', 'false', 'no', 'members-are-fine']) expect(publicConfig({ HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL: v }).forAllIgnored, v).toBe(v);
    for (const v of ['1', '', ' ']) expect(publicConfig({ HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL: v }).forAllIgnored, v).toBeUndefined();
    expect(publicConfig({}).forAllIgnored).toBeUndefined();
    // Nothing but exactly "1" turns the guest exemption on.
    for (const v of ['0', 'true', 'yes', 'on', '']) expect(publicConfig({ HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR: v }).guestsWithoutSecondFactor, v).toBe(false);
    expect(publicConfig({}).guestsWithoutSecondFactor).toBe(false);
    // The doctor says so, as a warning, with public access on or off.
    for (const on of [true, false]) {
      const lines = publicAccessLines({ on, port: 8092, safeguards: [], forAllIgnored: '0' });
      const line = lines.find((l) => l.text.includes('HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL=0'));
      expect(line, String(on)).toMatchObject({ level: 'warn' });
      expect(line!.text).toContain('ignored');
      expect(publicAccessLines({ on, port: 8092, safeguards: [] }).some((l) => l.text.includes('SECOND_FACTOR_FOR_ALL'))).toBe(false);
    }
    const facts = await publicAccessFacts({ HATCHABOT_AUTH: 'accounts', HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL: '0', HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR: '1' }, '/nonexistent.sqlite', 8080,
      { autoUpgrade: async () => ({ ok: true }), funnel: async () => ({ readable: true, entries: [] }), envPath: join(tmpdir(), 'no-such-dir-hb', '.env') });
    expect(facts).toMatchObject({ forAllIgnored: '0', guestsExempt: true });
    expect(publicAccessLines(facts).filter((l) => l.level === 'warn').map((l) => l.text).join('\n')).toMatch(/Chat-only guests use the public address without a second factor/);
  }, 30_000);

  it('they are sent to enrolment only when they arrived by a fresh invitation, reset link or recovery code; half an hour later, no more', async () => {
    h = ctx.h = await publicApp();
    await h.addAccount('owner', { owner: true });
    const m = await h.addAccount('member');
    await h.app.publicAccess!.evaluate();
    // A reset link from the owner, used at the public address.
    h.store.setLocalAccountClaim(m.id, 'reset-link-from-the-owner', new Date(Date.now() + 600_000).toISOString());
    const linked = new Jar();
    expect((await h.pub('/v1/local-accounts/claim', { jar: linked, body: { code: 'reset-link-from-the-owner', password: 'a-new-password-they-chose' } })).status).toBe(200);
    const sent = await h.pub('/v1/agents', { jar: linked });
    expect(sent.status).toBe(403);
    expect(sent.json.secondFactor).toBe('enrol');
    // Thirty-one minutes on, the link no longer vouches for this sign-in.
    await at(31 * 60_000, async () => {
      expect((await h!.pub('/v1/agents', { jar: linked })).json.secondFactor).toBe('enrol-link');
      expect((await h!.pub('/v1/second-factor/totp', { jar: linked, body: { current: 'a-new-password-they-chose' } })).json.secondFactor).toBe('enrol-link');
    });
    // A recovery code (made at the private address), used at the public one: the same.
    const cookie = await privCookie(h, 'member', 'a-new-password-they-chose');
    const made = await h.app.inject({ method: 'POST', url: '/v1/local-accounts/me/recovery-code', headers: { cookie }, payload: { current: 'a-new-password-they-chose' } });
    const recovered = new Jar();
    const rec = await h.pub('/v1/local-accounts/recover-with-code', { jar: recovered, body: { username: 'member', code: made.json().recoveryCode, password: 'another-password-of-theirs' } });
    expect(rec.status, JSON.stringify(rec.json)).toBe(200);
    expect((await h.pub('/v1/agents', { jar: recovered })).json.secondFactor).toBe('enrol');
    // They add one (their password as well), and are in.
    const start = await h.pub('/v1/second-factor/totp', { jar: recovered, body: { current: 'another-password-of-theirs' } });
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    expect((await h.pub('/v1/second-factor/totp/confirm', { jar: recovered, body: { id: start.json.id, code: totp(base32Decode(start.json.secret)) } })).status).toBe(200);
    expect((await h.pub('/v1/agents', { jar: recovered })).status).toBe(200);
  }, 30_000);

  it('with Google sign-in: a Google account without owner rights is exempt, a local password account beside it is not', async () => {
    const verifier = { verify: async (t: string) => ({ sub: t, email: `${t}@example.com`, emailVerified: true, expMs: Date.now() + 3_600_000 }) };
    h = ctx.h = await publicApp({ mode: 'identity', verifier, env: { HATCHABOT_LOCAL_ACCOUNTS: '1' } });
    h.store.insertHost({ id: 'h', ownerId: 'user-owner', kind: 'local', provider: 'mock', name: 'm', settings: {}, createdAt: 'now' });
    h.store.recordAccount('user-owner', 'owner@example.com');
    h.store.insertSecondFactor({ id: 'f', ownerId: 'user-owner', kind: 'totp', data: 'sealed' });
    h.store.recordAccount('user-friend', 'friend@example.com');
    const local = await h.addAccount('local-member');
    await h.app.publicAccess!.evaluate();
    expect(h.app.publicAccess!.status().failing).toEqual([]);
    expect(h.app.publicAccess!.secondFactorNeed('user-friend')).toBe('no');
    expect(h.app.publicAccess!.secondFactorNeed(local.id)).toBe('missing');
    const g = new Jar();
    expect((await h.pub('/v1/session', { body: { idToken: 'friend' }, jar: g })).status).toBe(200);
    expect((await h.pub('/v1/agents', { jar: g })).status).toBe(200);
    // What needs a second factor still needs one: Google does not stand in for step-up.
    const stepUp = await h.pub('/v1/cli-tokens', { jar: g, body: {} });
    expect(stepUp.status).toBe(403);
    expect(stepUp.json.secondFactor).toBe('missing');
    // They may add one right after a Google sign-in, and not from a session that has been open a while.
    await at(31 * 60_000, async () => {
      const later = new Jar(); for (const [k, v] of g.cookies) later.cookies.set(k, v); // (a copy: the clock goes back afterwards)
      const late = await h!.pub('/v1/second-factor/totp', { jar: later, body: {} });
      expect(late.status).toBe(403);
      expect(late.json.secondFactor).toBe('enrol-link');
    });
    expect((await h.pub('/v1/second-factor/totp', { jar: g, body: {} })).status).toBe(200);
    const l = new Jar();
    expect((await h.pub('/v1/login', { body: { username: 'local-member', password: local.password }, jar: l })).status).toBe(200);
    expect((await h.pub('/v1/agents', { jar: l })).json.secondFactor).toBe('enrol-link');
  }, 30_000);
});

describe('chat-only guests: exempt only by the owner\'s switch, and then for the chat alone', () => {
  it('who is a chat-only guest: web chat on someone else\'s agent, and nothing of their own', async () => {
    h = ctx.h = await publicApp();
    const owner = await h.addAccount('owner', { owner: true });
    const mk = async (name: string) => (await h!.addAccount(name)).id;
    h.store.insertAgent(agentRow('a1', owner.id));
    h.store.insertAgent(agentRow('gone', owner.id, { state: 'DELETED' }));
    h.store.insertAgent(agentRow('mgr', owner.id, { ops: true }));

    const guest = await mk('guest'); giveWebChat(h, 'a1', guest);
    expect(h.store.isChatOnlyGuest(guest)).toBe(true);
    // No membership at all; a seat without web chat; a seat that was taken away; one on a deleted agent; one on the management agent.
    expect(h.store.isChatOnlyGuest(await mk('nobody'))).toBe(false);
    const tg = await mk('telegram-only'); giveWebChat(h, 'a1', tg, { webChat: false });
    expect(h.store.isChatOnlyGuest(tg)).toBe(false);
    const revoked = await mk('revoked'); giveWebChat(h, 'a1', revoked, { status: 'revoked' });
    expect(h.store.isChatOnlyGuest(revoked)).toBe(false);
    const dead = await mk('dead-agent'); giveWebChat(h, 'gone', dead);
    expect(h.store.isChatOnlyGuest(dead)).toBe(false);
    const ops = await mk('ops-seat'); giveWebChat(h, 'mgr', ops);
    expect(h.store.isChatOnlyGuest(ops)).toBe(false);
    // A guest who also has something of their own is a member, not a guest: an agent (even stopped or archived), an AI source, a host.
    for (const state of ['RUNNING', 'STOPPED', 'ARCHIVED', 'DRAFT']) {
      const id = await mk(`has-agent-${state.toLowerCase()}`); giveWebChat(h, 'a1', id);
      h.store.insertAgent(agentRow(`own-${state}`, id, { state }));
      expect(h.store.isChatOnlyGuest(id), state).toBe(false);
    }
    const hadAgent = await mk('had-agent'); giveWebChat(h, 'a1', hadAgent);
    h.store.insertAgent(agentRow('own-deleted', hadAgent, { state: 'DELETED' }));
    expect(h.store.isChatOnlyGuest(hadAgent)).toBe(true);
    const src = await mk('has-source'); giveWebChat(h, 'a1', src);
    h.store.insertAIProfile({ id: 'p-src', ownerId: src, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p-src', createdAt: 'now' } as never);
    expect(h.store.isChatOnlyGuest(src)).toBe(false);
    const host = await mk('has-host'); giveWebChat(h, 'a1', host);
    h.store.insertHost({ id: 'h-runner', ownerId: host, kind: 'runner', provider: 'mock', name: 'r', settings: {}, createdAt: 'now' } as never);
    expect(h.store.isChatOnlyGuest(host)).toBe(false);
    // Their own agent does not make them a guest of themselves.
    const self = await mk('self'); h.store.insertAgent(agentRow('self-agent', self));
    giveWebChat(h, 'self-agent', self);
    expect(h.store.isChatOnlyGuest(self)).toBe(false);
  }, 30_000);

  it('the switch is off by default: a chat-only guest needs a second factor like everyone else', async () => {
    h = ctx.h = await publicApp({ extra: extraRoutes });
    const owner = await h.addAccount('owner', { owner: true });
    const guest = await h.addAccount('guest');
    h.store.insertAgent(agentRow('a1', owner.id));
    giveWebChat(h, 'a1', guest.id);
    await h.app.publicAccess!.evaluate();
    expect(h.store.isChatOnlyGuest(guest.id)).toBe(true);
    expect(h.app.publicAccess!.secondFactorNeed(guest.id)).toBe('missing');
    const jar = await h.signIn('guest', guest.password);
    expect((await h.pub('/v1/agents', { jar })).json.secondFactor).toBe('enrol-link');
    expect((await h.pub('/v1/agents/a1/chat', { jar, body: { text: 'hello' } })).status).toBe(403);
  }, 30_000);

  it('with the switch on: a guest chats with a password alone, and can do nothing else; nobody else is exempt', async () => {
    const upgrades: string[] = [];
    h = ctx.h = await publicApp({ env: { HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR: '1' }, extra: (app, store) => {
      extraRoutes!(app, store);
      app.server.on('upgrade', (req, socket) => {
        const p = app.principalFromCookieHeader!(req.headers.cookie, true);
        const why = p ? app.publicAccess!.refuseSession(req, p.ownerId) : 'no session';
        upgrades.push(why ?? 'ok');
        if (why) { socket.destroy(); return; }
        socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
      });
    } });
    const owner = await h.addAccount('owner', { owner: true });
    const guest = await h.addAccount('guest');
    const member = await h.addAccount('member');           // has an agent of their own
    const plain = await h.addAccount('plain');             // an account, and nothing else
    h.store.insertAgent(agentRow('a1', owner.id));
    h.store.insertAgent(agentRow('m1', member.id));
    giveWebChat(h, 'a1', guest.id);
    giveWebChat(h, 'a1', member.id);
    await h.app.publicAccess!.evaluate();
    expect(h.app.publicAccess!.secondFactorNeed(guest.id)).toBe('guest');
    expect(h.app.publicAccess!.secondFactorNeed(member.id)).toBe('missing');
    expect(h.app.publicAccess!.secondFactorNeed(plain.id)).toBe('missing');

    const jar = await h.signIn('guest', guest.password);
    // The chat, reading, and the console socket: let through.
    expect((await h.pub('/v1/agents', { jar })).status).toBe(200);
    expect((await h.pub('/v1/agents/a1/chat', { jar, body: { text: 'hello' } })).json).toEqual({ sent: true });
    expect((await h.pub('/v1/security/notices/n1/seen', { jar, body: {} })).status).toBe(200);
    const sock = async (cookie: string): Promise<string> => new Promise((resolve) => {
      const s = connect(h!.port, '127.0.0.1', () => s.write(`GET /v1/agents/a1/ui/ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${cookie}\r\n\r\n`));
      let got = ''; s.on('data', (d) => { got += d.toString(); }); s.on('error', () => resolve(got)); s.on('close', () => resolve(got));
    });
    expect(await sock(jar.header())).toContain('101');
    // Everything that makes or changes something: refused, and it says what a guest may do.
    for (const [method, path] of [['POST', '/v1/agents'], ['PATCH', '/v1/agents/a1'], ['POST', '/v1/account/telegram'], ['POST', '/v1/hosts'], ['POST', '/v1/cli-tokens']] as const) {
      const r = await h.pub(path, { method, jar, body: {} });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json.secondFactor, `${method} ${path}`).toBe('guest');
      expect(r.json.error, `${method} ${path}`).toContain('chat here and nothing else');
    }
    // Nor does the password alone add a factor (the rule for everyone).
    expect((await h.pub('/v1/second-factor/totp', { jar, body: { current: guest.password } })).json.secondFactor).toBe('enrol-link');
    // The route table's own word on it: reads of the signed-in class, the chat, signing out, dismissing a notice.
    expect(guestMay('POST', '/v1/agents/:id/chat')).toBe(true);
    expect(guestMay('GET', '/v1/agents/:id/ui/*')).toBe(true);
    expect(guestMay('POST', '/v1/logout/everywhere')).toBe(true);
    for (const [method, pattern] of [['POST', '/v1/agents'], ['PATCH', '/v1/agents/:id'], ['DELETE', '/v1/agents/:id'], ['POST', '/v1/agents/:id/provision'], ['POST', '/v1/account/telegram'],
      ['DELETE', '/v1/cli-tokens/:id'], ['POST', '/v1/cli-tokens'], ['GET', '/v1/security/log'], ['GET', '/v1/agents/:id/bot-token'], ['POST', '/v1/agents/:id/invites'], ['GET', '/v1/unclassified-thing'], ['POST', '/v1/public-access/on']] as const) {
      expect(guestMay(method, pattern), `${method} ${pattern}`).toBe(false);
    }

    // A member with an agent of their own, and an account with no seat anywhere: not exempt, sockets included.
    for (const who of [member, plain]) {
      const j = new Jar();
      await h.pub('/v1/login', { body: { username: who === member ? 'member' : 'plain', password: who.password }, jar: j });
      expect(await sock(j.header())).not.toContain('101');
      expect((await h.pub('/v1/agents', { jar: j })).json.secondFactor).toBe('enrol-link');
      expect((await h.pub('/v1/agents/a1/chat', { jar: j, body: { text: 'hello' } })).status).toBe(403);
    }
    expect(upgrades).toEqual(['ok', 'no second factor', 'no second factor']);

    // The moment the guest has an agent of their own, the exemption is over: on the very next request.
    h.store.insertAgent(agentRow('g1', guest.id, { state: 'STOPPED' }));
    expect((await h.pub('/v1/agents', { jar })).json.secondFactor).toBe('enrol-link');
    expect((await h.pub('/v1/agents/a1/chat', { jar, body: { text: 'hello' } })).status).toBe(403);
    expect(await sock(jar.header())).not.toContain('101');
    // An owner is never a guest, whatever seats they hold.
    h.store.insertAgent(agentRow('m2', member.id));
    giveWebChat(h, 'm2', owner.id);
    h.store.deleteSecondFactors(owner.id);
    expect(h.app.publicAccess!.secondFactorNeed(owner.id)).toBe('missing');
  }, 30_000);
});

describe('the guest switch', () => {
  it('is the owner\'s, asks first with a plain warning, is turned on at the private address only, and is written down', async () => {
    const w = await world({}, { on: true });
    const guest = await w.h.addAccount('guest');
    const member = await w.h.addAccount('member');
    w.h.store.insertAgent(agentRow('a1', w.owner.id));
    w.h.store.insertAgent(agentRow('m1', member.id));
    giveWebChat(w.h, 'a1', guest.id);
    // Status says who has no second factor yet, and which of them the switch would let in.
    const before = (await w.call('GET', '/v1/public-access')).json();
    expect(before.guestsWithoutSecondFactor).toBe(false);
    expect(before.withoutSecondFactor).toEqual([{ name: 'guest', chatOnlyGuest: true }, { name: 'member', chatOnlyGuest: false }]);
    // Not without a confirmation, and the answer says what it costs.
    const ask = await w.call('POST', '/v1/public-access/guests', { on: true });
    expect(ask.statusCode).toBe(400);
    expect(ask.json().confirmText).toContain('password alone');
    expect(ask.json().confirmText).toContain('from the internet');
    // Not by a member.
    const mc = await privCookie(w.h, 'member', member.password);
    expect((await w.call('POST', '/v1/public-access/guests', { on: true, confirm: true }, mc)).statusCode).toBe(403);
    // Not from the public address, even by the owner with the second factor just given.
    const oj = await w.h.signIn('owner', w.owner.password, { totpSecret: w.owner.totpSecret });
    const pubOn = await w.h.pub('/v1/public-access/guests', { jar: oj, body: { on: true, confirm: true } });
    expect(pubOn.status).toBe(403);
    expect(pubOn.json.error).toContain('private address');
    expect(envNow(w.envFile).get('HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR')).toBeUndefined();
    expect(w.h.app.publicAccess!.secondFactorNeed(guest.id)).toBe('missing');

    // On, by the owner, at the private address.
    const on = await w.call('POST', '/v1/public-access/guests', { on: true, confirm: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().guestsWithoutSecondFactor).toBe(true);
    expect(envNow(w.envFile).get('HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR')).toBe('1');
    expect(w.h.store.listSecurityLog().find((e) => e.kind === 'public.guests_without_second_factor')).toMatchObject({ ownerId: w.owner.id, detail: { on: true } });
    expect(w.h.app.publicAccess!.secondFactorNeed(guest.id)).toBe('guest');
    expect(w.h.app.publicAccess!.secondFactorNeed(member.id)).toBe('missing');
    const gj = await w.h.signIn('guest', guest.password);
    expect((await w.h.pub('/v1/agents', { jar: gj })).status).toBe(200);
    // The safeguard report says so too.
    expect(on.json().safeguards.find((c: { id: string }) => c.id === 'second-factor').detail).toContain('EXCEPT chat-only guests');

    // Off again (allowed from the public address too: it only tightens).
    const oj2 = await at(45_000, async () => {
      const j = new Jar();
      await w.h.pub('/v1/login', { body: { username: 'owner', password: w.owner.password }, jar: j });
      await w.h.pub('/v1/second-factor/verify', { jar: j, body: { code: totp(w.owner.totpSecret!, Date.now() + 30_000) } });
      const off = await w.h.pub('/v1/public-access/guests', { jar: j, body: { on: false } });
      expect(off.status, JSON.stringify(off.json)).toBe(200);
      return j;
    });
    void oj2;
    expect(envNow(w.envFile).get('HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR')).toBeUndefined();
    expect((await w.h.pub('/v1/agents', { jar: gj })).json.secondFactor).toBe('enrol-link');
  }, 60_000);

  it('accepting a web-chat invitation at the public address without a factor: only with the switch on, and only for someone who owns nothing', async () => {
    const w = await world({}, { on: true });
    const newcomer = await w.h.addAccount('newcomer');
    const member = await w.h.addAccount('member');
    w.h.store.insertAgent(agentRow('a1', w.owner.id, { state: 'STOPPED' }));
    w.h.store.insertAgent(agentRow('m1', member.id));
    const invite = () => createInvite(w.h.store, 'a1', w.owner.id, undefined, { webChat: true }).code;
    const nj = await w.h.signIn('newcomer', newcomer.password);
    // Off: no.
    expect((await w.h.pub('/v1/join', { jar: nj, body: { code: invite(), name: 'N' } })).status).toBe(401);
    expect((await w.call('POST', '/v1/public-access/guests', { on: true, confirm: true })).statusCode).toBe(200);
    // On: someone with an agent of their own is still refused…
    const mj = await w.h.signIn('member', member.password);
    expect((await w.h.pub('/v1/join', { jar: mj, body: { code: invite(), name: 'M' } })).status).toBe(401);
    expect(w.h.store.rawDb().prepare(`SELECT COUNT(*) AS n FROM memberships WHERE agent_id = 'a1'`).get()).toEqual({ n: 0 });
    // …someone who owns nothing becomes a guest, and then has the chat and nothing else.
    const ok = await w.h.pub('/v1/join', { jar: nj, body: { code: invite(), name: 'N' } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(w.h.app.publicAccess!.secondFactorNeed(newcomer.id)).toBe('guest');
    const made = await w.h.pub('/v1/agents', { jar: nj, body: { name: 'Mine' } });
    expect(made.status).toBe(403);
    expect(made.json.secondFactor).toBe('guest');
  }, 60_000);
});

