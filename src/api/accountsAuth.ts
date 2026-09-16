import { createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from '../store/store.js';
import type { Principal } from './principal.js';

/**
 * Accounts mode (HATCHABOT_AUTH=accounts): the middle rung between one shared
 * password and a cloud identity provider.
 *
 *   password  — one implicit user, one password. No accounts at all.
 *   accounts  — several people, each with their own username and password,
 *               stored on this machine. No Google project, no GCP billing,
 *               nothing to register: the reason this mode exists.
 *   identity  — per-user sign-in through GCP Identity Platform (Google).
 *
 * Each account's id IS its owner id, so the per-owner scoping every route
 * already does gives real separation: your agents, sources and invites are
 * yours. Account #1 is the host owner and manages the rest.
 */

const scrypt = promisify(scryptCb) as (p: string | Buffer, s: string | Buffer, k: number) => Promise<Buffer>;
const KEYLEN = 32;

export async function hashPassword(password: string, salt = randomBytes(16).toString('hex')): Promise<{ hash: string; salt: string }> {
  const key = await scrypt(password, salt, KEYLEN);
  return { hash: key.toString('hex'), salt };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const key = await scrypt(password, salt, KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  // Length-mismatched buffers make timingSafeEqual throw; a stored hash of the
  // wrong shape is simply a non-match.
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Usernames are free-form but predictable: no spaces, no colons (the cookie separator). */
export function usernameProblem(username: string): string | undefined {
  if (username.length < 3 || username.length > 64) return 'Username must be 3–64 characters.';
  if (!/^[A-Za-z0-9._@+-]+$/.test(username)) return 'Use letters, digits and . _ @ + - only.';
  return undefined;
}

export function passwordProblem(password: string): string | undefined {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 200) return 'Password must be at most 200 characters.';
  return undefined;
}

export interface AccountsAuthDeps {
  store: Store;
  secret: Buffer;
  /** Called with the account's owner id after a successful sign-in. */
  onAuthenticated?: (principal: Principal) => void;
  cliTokenOwner?: (token: string) => string | undefined;
}

const COOKIE = 'hatchabot_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Session signature. The account's password hash rides in the material, so
 *  changing (or resetting) a password invalidates that account's sessions
 *  everywhere without touching anyone else's. */
function signSession(secret: Buffer, accountId: string, pwHash: string, exp: number): string {
  return createHmac('sha256', secret).update(`acct:${accountId}:${exp}:${pwHash}`).digest('hex');
}

export function mintSession(secret: Buffer, accountId: string, pwHash: string, exp: number): string {
  return `${accountId}:${exp}.${signSession(secret, accountId, pwHash, exp)}`;
}

/** Resolve a session cookie to an account id, or undefined. */
export function sessionAccount(store: Store, secret: Buffer, token: string | undefined): string | undefined {
  if (!token) return undefined;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return undefined;
  const head = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const sep = head.lastIndexOf(':');
  if (sep < 0) return undefined;
  const accountId = head.slice(0, sep);
  const exp = Number(head.slice(sep + 1));
  if (!accountId || !Number.isFinite(exp) || exp < Date.now()) return undefined;
  const account = store.localAccount(accountId);
  if (!account || account.disabled) return undefined;
  const expected = signSession(secret, accountId, account.pwHash, exp);
  if (sig.length !== expected.length) return undefined;
  return timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8')) ? accountId : undefined;
}

function setSessionCookie(reply: FastifyReply, req: FastifyRequest, value: string): void {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  reply.setCookie(COOKIE, value, {
    httpOnly: true,
    sameSite: 'strict',
    secure: (proto ?? req.protocol) === 'https',
    path: '/',
    maxAge: Math.floor(TTL_MS / 1000),
  });
}

/**
 * Routes for accounts mode. `guard` is the shared throttle from auth.ts so a
 * brute-force attempt is counted the same way in every mode.
 */
export function registerAccountRoutes(
  app: FastifyInstance,
  deps: AccountsAuthDeps,
  guard: { throttled: (req: FastifyRequest) => boolean; noteFailure: (req: FastifyRequest) => void },
): void {
  const { store, secret } = deps;

  /**
   * First run: with no accounts yet, anyone who can reach the port may create
   * account #1 — the same trust model as the password screen on a fresh
   * install, where whoever gets there first sets the password. It closes the
   * moment that account exists.
   */
  app.post<{ Body: { username?: string; password?: string; displayName?: string } }>(
    '/v1/accounts/bootstrap',
    async (req, reply) => {
      if (store.countLocalAccounts() > 0) {
        return reply.code(403).send({ error: 'This installation already has accounts — sign in instead.' });
      }
      const username = (req.body?.username ?? '').trim();
      const password = req.body?.password ?? '';
      const problem = usernameProblem(username) ?? passwordProblem(password);
      if (problem) return reply.code(400).send({ error: problem });
      const { hash, salt } = await hashPassword(password);
      const id = `acct-${randomUUID()}`;
      store.insertLocalAccount({
        id,
        username,
        displayName: req.body?.displayName?.trim() || undefined,
        pwHash: hash,
        pwSalt: salt,
        hostOwner: true,
        disabled: false,
        createdAt: new Date().toISOString(),
      });
      // An install that ran in password mode has rows under the local owner;
      // account #1 adopts them, exactly as the first identity sign-in does.
      const adopted = store.adoptLocalOwnerData(id);
      store.recordAccount(id, username.includes('@') ? username : undefined);
      if (adopted > 0) app.log.warn({ ownerId: id, rows: adopted }, 'first account adopted this installation\'s data');
      setSessionCookie(reply, req, mintSession(secret, id, hash, Date.now() + TTL_MS));
      return reply.code(201).send({ ok: true, id, username, hostOwner: true, adopted });
    },
  );

  app.post<{ Body: { username?: string; password?: string } }>('/v1/login', async (req, reply) => {
    if (guard.throttled(req)) return reply.code(429).send({ error: 'Too many failed attempts — try again later.' });
    const username = (req.body?.username ?? '').trim();
    const password = req.body?.password ?? '';
    const account = username ? store.localAccountByUsername(username) : undefined;
    // One message for every failure: a different answer for "no such user"
    // would turn this endpoint into a username oracle.
    const ok = account && !account.disabled && (await verifyPassword(password, account.pwHash, account.pwSalt));
    if (!account || !ok) {
      guard.noteFailure(req);
      await new Promise((r) => setTimeout(r, 400));
      return reply.code(401).send({ error: 'Wrong username or password' });
    }
    setSessionCookie(reply, req, mintSession(secret, account.id, account.pwHash, Date.now() + TTL_MS));
    deps.onAuthenticated?.({ ownerId: account.id, via: 'password', email: account.username.includes('@') ? account.username : undefined });
    return { ok: true, id: account.id, username: account.username, hostOwner: account.hostOwner };
  });

  /** Who am I, for the app's header and the Access tab. */
  app.get('/v1/accounts/me', async (req, reply) => {
    const account = store.localAccount(req.principal?.ownerId ?? '');
    if (!account) return reply.code(404).send({ error: 'Not found' });
    return { id: account.id, username: account.username, displayName: account.displayName, hostOwner: account.hostOwner };
  });

  /** The roster. Host owner only: who else can reach this installation is not
   *  ordinary-user business, and the list is a map of the household. */
  app.get('/v1/accounts', async (req, reply) => {
    const me = store.localAccount(req.principal?.ownerId ?? '');
    if (!me?.hostOwner) return reply.code(403).send({ error: 'Only the host owner manages accounts.' });
    return store.listLocalAccounts().map((a) => ({
      id: a.id,
      username: a.username,
      displayName: a.displayName,
      hostOwner: a.hostOwner,
      disabled: a.disabled,
      createdAt: a.createdAt,
      agents: store.listAgents(a.id).filter((x) => x.state !== 'DELETED').length,
    }));
  });

  app.post<{ Body: { username?: string; password?: string; displayName?: string } }>(
    '/v1/accounts',
    async (req, reply) => {
      const me = store.localAccount(req.principal?.ownerId ?? '');
      if (!me?.hostOwner) return reply.code(403).send({ error: 'Only the host owner adds accounts.' });
      const username = (req.body?.username ?? '').trim();
      const password = req.body?.password ?? '';
      const problem = usernameProblem(username) ?? passwordProblem(password);
      if (problem) return reply.code(400).send({ error: problem });
      if (store.localAccountByUsername(username)) {
        return reply.code(409).send({ error: 'That username is taken.' });
      }
      const { hash, salt } = await hashPassword(password);
      const id = `acct-${randomUUID()}`;
      store.insertLocalAccount({
        id,
        username,
        displayName: req.body?.displayName?.trim() || undefined,
        pwHash: hash,
        pwSalt: salt,
        hostOwner: false,
        disabled: false,
        createdAt: new Date().toISOString(),
      });
      store.recordAccount(id, username.includes('@') ? username : undefined);
      return reply.code(201).send({ id, username, hostOwner: false });
    },
  );

  /** Change a password: your own (current password required) or, for the host
   *  owner, anyone's (a reset — the person is told to change it after). */
  app.post<{ Params: { id: string }; Body: { current?: string; password?: string } }>(
    '/v1/accounts/:id/password',
    async (req, reply) => {
      const me = store.localAccount(req.principal?.ownerId ?? '');
      if (!me) return reply.code(401).send({ error: 'Sign in first.' });
      const target = req.params.id === 'me' ? me : store.localAccount(req.params.id);
      if (!target) return reply.code(404).send({ error: 'Not found' });
      const self = target.id === me.id;
      if (!self && !me.hostOwner) return reply.code(403).send({ error: "You can only change your own password." });
      const password = req.body?.password ?? '';
      const problem = passwordProblem(password);
      if (problem) return reply.code(400).send({ error: problem });
      if (self && !(await verifyPassword(req.body?.current ?? '', target.pwHash, target.pwSalt))) {
        guard.noteFailure(req);
        return reply.code(401).send({ error: 'Current password is wrong.' });
      }
      const { hash, salt } = await hashPassword(password);
      store.setLocalAccountPassword(target.id, hash, salt);
      // Every session of that account dies with the old hash. Re-issue one for
      // the caller when it's their own, so changing it doesn't log them out.
      if (self) setSessionCookie(reply, req, mintSession(secret, target.id, hash, Date.now() + TTL_MS));
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/accounts/:id', async (req, reply) => {
    const me = store.localAccount(req.principal?.ownerId ?? '');
    if (!me?.hostOwner) return reply.code(403).send({ error: 'Only the host owner removes accounts.' });
    const target = store.localAccount(req.params.id);
    if (!target) return reply.code(404).send({ error: 'Not found' });
    if (target.hostOwner) return reply.code(400).send({ error: 'The host owner account cannot be removed.' });
    // Their agents would become unreachable — no owner can see them, and
    // nothing would ever clean them up. Make the human deal with them first.
    const agents = store.listAgents(target.id).filter((a) => a.state !== 'DELETED');
    if (agents.length) {
      return reply.code(409).send({
        error: `${target.username} still has ${agents.length} agent${agents.length === 1 ? '' : 's'}. Delete or hand them over first.`,
      });
    }
    store.deleteLocalAccount(target.id);
    return { ok: true };
  });
}
