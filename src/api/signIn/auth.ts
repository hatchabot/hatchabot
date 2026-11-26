import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { z } from 'zod';
import { LOCAL_OWNER, internalPrincipal, type Principal } from '../principal.js';
import { registerAccountRoutes, sessionAccount, signInLocalByLink } from './accountsAuth.js';
import { registerSigninLink, SIGNIN_LINK_PATH, type LinkSignIn, type SigninLinkDeps } from './signinLink.js';
import { clearSessionCookies, readSessionCookie, sessionValue, setSessionCookie, SIGN_OUT_NOT_SAVED, upgradeSessionCookie } from './sessionCookie.js';
import { safeEqual } from '../../util/safeEqual.js';
import { registerOriginCheck } from '../requestOrigin.js';
import { addressBucket, forwardedBucket, isPublic, proxiedClientAddress, publicClientAddress } from '../trust.js';
import { registerPublicAccess } from '../publicAccess.js';
import { publicConfig } from '../safeguards.js';
import { registerSecondFactorRoutes } from './secondFactor.js';
import type { Store } from '../../store/store.js';
import {

  identityConfigFromEnv,
  IdentityError,
  IdentityUnavailableError,
  IdentityVerifier,
  admittedPrincipal,
  allowedEmailProblem,
} from './identity.js';
import { routedPath } from '../routedPath.js';
import { dockerDesktop } from '../../ops/opsServer.js';
/**
 * POST /v1/login and POST /v1/session: the one field each reads, of any type
 * (HB-0814). Nothing here refuses: anything but text is a wrong password
 * (`safeEqual`) or a malformed sign-in token (`IdentityVerifier.verify`), a
 * 401 as before, after the throttle; a body that is not an object is read as
 * without it, as the casts read it.
 */
const LoginBody = z.object({ password: z.unknown().optional() });
const SessionBody = z.object({ idToken: z.unknown().optional() });

/** The page's scripts (src/api/machine/pageRoutes.ts): the static shell, before sign-in like the page. Exactly that shape, nothing under it. */
const PAGE_SCRIPT_PATH = /^\/app\/[a-z0-9-]+\.js$/;

/** The agent-to-agent consult (its caller's token is checked in the handler): only when the router matched that very route. */
const isAgentMessageRoute = (req: FastifyRequest): boolean => req.method === 'POST' && req.routeOptions?.url === '/v1/agents/:id/message';

/**
 * Per-client throttle for the credential endpoints: after LIMIT failures in
 * the window a client gets 429 until it expires. The old flat 400 ms sleep
 * was defeated by parallel connections.
 */
const failLimit = () => Number(process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW ?? 10); // read per call (tests tune it)
const FAIL_WINDOW_MS = Number(process.env.HATCHABOT_LOGIN_WINDOW_MS ?? 15 * 60_000);
/** A bucket's misses in its window. `typed`: its last miss was a name typed at a sign-in (noteFailure). */
type Count = { n: number; until: number; typed?: boolean };
const failures = new Map<string, Count>();
/**
 * The misses and the lockouts (`failures`, `strikes`) are kept in the store
 * as well, in the table the consult limit uses (`rate_hits`), and read back
 * at the start: in memory only, every restart (every deploy) gave a
 * locked-out guesser ten more tries and forgot how often it had been locked
 * out (HB-0836, the owner's choice). The maps are this process's copy. A
 * count is kept once it refuses (at its limit: locked), as that many misses
 * and written once (`keep`), and a lockout's strike always: a count below
 * its limit is lost with a restart, which gives at most the rest of one
 * window's tries. A forwarded-for address is never kept: a peer on this
 * machine that reaches the proxy's port makes up as many as it likes, and
 * the account's count, and the public address's, carry the rule. Read back under the maps' bound. The other limits (recovery messages,
 * new-device notices, the public address's per-minute ceiling) stay in
 * memory: a restart gives one more of each, which opens no door.
 */
let throttleStore: Store | undefined;
const FAIL_BUCKET = 'signin:fail:';
const STRIKE_BUCKET = 'signin:strike:';
/** The store's copy of one count; a write that fails leaves this process's, and is said. */
function saveCount(prefix: string, k: string, v: { n: number; until: number } | undefined, req?: FastifyRequest): void {
  try { throttleStore?.setRateCount(prefix + k, v?.n ?? 0, v?.until ?? 0); }
  catch (err) { req?.log.warn({ err: String(err) }, 'signin.throttle_not_saved'); }
}
/** The store the counts are kept in, and what it holds read back (registerAuth, at the start). */
function keepThrottleIn(store: Store | undefined, log: FastifyInstance['log']): void {
  throttleStore = store;
  if (!store) return;
  try {
    const now = Date.now();
    for (const r of store.rateCounts(FAIL_BUCKET, now)) failures.set(r.bucket.slice(FAIL_BUCKET.length), { n: r.n, until: r.until });
    for (const r of store.rateCounts(STRIKE_BUCKET, now)) strikes.set(r.bucket.slice(STRIKE_BUCKET.length), { n: r.n, until: r.until });
    bound(failures, now);
    bound(strikes, now);
  } catch (err) { log.error({ err: String(err) }, 'signin.throttle_unread: sign-in limits start from nothing'); }
}
/**
 * Whom to count a failure against. Behind `tailscale serve` or a local reverse
 * proxy every client arrives from loopback, so counting the socket address
 * locked EVERYONE out after one person's ten misses (26th audit). On the
 * proxy's own listener (proxyListener.ts, where `tailscale serve` is
 * pointed) the address the proxy added to X-Forwarded-For names the real
 * client; everywhere else the peer's own address counts, whatever its
 * headers say (HB-1239: believed from any loopback peer, it let an agent's
 * container under a rootless daemon or Docker Desktop name a new address for
 * every try). The account being tried is a second bucket, so hopping
 * addresses does not help either.
 */
/**
 * Containers reach this process from loopback: set at boot when the docker
 * daemon is rootless (index.ts), or by an operator; and on Docker Desktop,
 * where `host.docker.internal` is this machine's loopback, so an agent's
 * request looked typed on the machine and could create the first account
 * without the setup code (HB-0024).
 */
export function loopbackIsRemote(): boolean {
  return process.env.HATCHABOT_CONTAINERS_ON_LOOPBACK === '1' || dockerDesktop();
}
/**
 * The account a failure is counted against, as a key of bounded size: anyone
 * can type any "username", and megabyte-long ones, each kept as a map key,
 * were a way to fill the process's memory with no account at all (review,
 * 2026-10-01). A name that starts with `*` is hashed as a long one is: `*…*`
 * keys are the shared buckets' (SharedBucket), and a name typed at the
 * sign-in as `*first-run-setup*` counted against the setup code's, and any
 * starting with `*` got a shared bucket's ten-fold limit (HB-1434). No
 * account's name holds a `*` (usernameProblem).
 */
function accountKey(who: string): string {
  const w = who.trim().toLowerCase();
  return w.length <= 64 && !w.startsWith('*') ? w : `#${createHash('sha256').update(w).digest('hex').slice(0, 32)}`;
}
/**
 * A bucket everyone's misses share (the one password, the first-run setup
 * code), counted as `user:*<name>*`. Never a name: a name someone typed goes
 * through accountKey, which never makes a `*…*` key (HB-1434).
 */
export interface SharedBucket { readonly shared: string }
function throttleKeys(req: FastifyRequest, who?: string | SharedBucket, scope?: 'link' | '2fa'): string[] {
  const name = typeof who === 'object' ? `*${who.shared}*` : who ? accountKey(who) : undefined;
  // The public listener (trust.ts) counts apart from everything else, so a
  // stranger on the internet can lock an account out of the PUBLIC address
  // only: the owner still signs in at the private one. There the visitor's
  // address is the one tailscaled reports, the account is a second bucket,
  // and `pub:all` is a ceiling on every public failure together.
  if (isPublic(req)) {
    const keys = [`pub:ip:${addressBucket(publicClientAddress(req))}`];
    if (name) keys.push(`pub:user:${name}`);
    keys.push('pub:all');
    return scope ? keys.map((k) => `${scope}:${k}`) : keys;
  }
  let ip = req.ip || 'unknown';
  // Each device behind `tailscale serve` its own bucket: without it, one
  // agent's ten misses locked out everyone behind the proxy (use-case audit,
  // 2026-09-27). Only on the proxy's listener, and only the address the proxy
  // added (trust.ts proxiedClientAddress, HB-1435): on the app's own port a
  // loopback peer (an agent's container, under a rootless daemon or Docker
  // Desktop) is counted as itself, whatever X-Forwarded-For it sends.
  const proxied = proxiedClientAddress(req);
  if (proxied) ip = `fwd:${proxied === 'unknown' ? proxied : forwardedBucket(proxied)}`;
  const keys = [`ip:${ip.slice(0, 80)}`];
  if (name) keys.push(`user:${name}`);
  // A scope is a separate count: sign-in links' misses never lock anyone out
  // of the password form. A junk link costs a page on another site nothing
  // to send (it needs no cookie), so sharing the bucket let ten of them lock
  // the owner out of signing in (2026-10-01).
  return scope ? keys.map((k) => `${scope}:${k}`) : keys;
}
/**
 * The ceiling on every public failure together, in each scope. Anchored, as
 * PUBLIC_KEY: a forged forwarded-for address that ended with `pub:all` got
 * the ceiling's hundred misses (HB-1389 review).
 */
const CEILING_KEY = /^(?:(?:link|2fa):)?pub:all$/;
/** A shared bucket (the one password, the first-run code: `*…*` names), at either address. Anchored, as CEILING_KEY. */
const SHARED_KEY = /^(?:(?:link|2fa):)?(?:pub:)?user:\*/;
/** How many misses a bucket takes before it refuses. */
function limitFor(k: string): number {
  if (CEILING_KEY.test(k)) return publicConfig().failsCeiling;
  // A shared bucket (the one password, the first-run code) is a ceiling on
  // everyone together, not a lock: at the per-client limit, ten misses from
  // anyone locked the owner out too (regression review, 2026-09-28).
  return SHARED_KEY.test(k) ? failLimit() * 10 : failLimit();
}
/**
 * Public lockouts back off: each time the same address or account is locked
 * out again within a day the lock lasts twice as long (one window, two, four,
 * up to a day). A patient guesser at ten tries per window gets ten, then ten
 * more two windows later, then four: a few dozen a day, not a thousand.
 */
const strikes = new Map<string, { n: number; until: number }>();
const STRIKE_MEMORY_MS = 24 * 60 * 60_000;
function lockMsFor(k: string, req?: FastifyRequest): number {
  const now = Date.now();
  const s = strikes.get(k);
  const n = s && now < s.until ? s.n + 1 : 1;
  strikes.set(k, { n, until: now + STRIKE_MEMORY_MS });
  saveCount(STRIKE_BUCKET, k, strikes.get(k), req);
  // Held to the counts' bound: only expired ones went, and past 10,000 live
  // ones nothing did (HB-1389 review).
  bound(strikes, now);
  return Math.min(FAIL_WINDOW_MS * 2 ** (n - 1), STRIKE_MEMORY_MS);
}
export function throttled(req: FastifyRequest, who?: string | SharedBucket, scope?: 'link' | '2fa'): boolean {
  for (const k of throttleKeys(req, who, scope)) {
    const f = failures.get(k);
    if (!f) continue;
    if (Date.now() > f.until) { failures.delete(k); continue; }
    if (f.n >= limitFor(k)) return true;
  }
  return false;
}
/**
 * A place in the count for one guess that is still being checked. A password
 * is verified with scrypt, off the event loop: between `throttled` saying
 * "not yet" and `noteFailure` counting the miss, every other request that
 * arrived was let through too, so one burst of a few hundred requests got a
 * few hundred guesses at an account whose limit is ten (second review,
 * 2026-10-01). A guess in flight now counts as a miss until it is released:
 * undefined means refused (answer 429); otherwise call the function returned
 * when the check is over, whatever its result.
 */
const pending = new Map<string, number>();
export function reserve(req: FastifyRequest, who?: string | SharedBucket, scope?: 'link' | '2fa'): (() => void) | undefined {
  const keys = throttleKeys(req, who, scope);
  const now = Date.now();
  for (const k of keys) {
    const f = failures.get(k);
    if (f && now > f.until) failures.delete(k);
    const counted = (f && now <= f.until ? f.n : 0) + (pending.get(k) ?? 0);
    if (counted >= limitFor(k)) return undefined;
  }
  for (const k of keys) pending.set(k, (pending.get(k) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const k of keys) {
      const n = (pending.get(k) ?? 1) - 1;
      if (n > 0) pending.set(k, n); else pending.delete(k);
    }
  };
}
/**
 * `typed`: `who` is a name someone typed at a sign-in (POST /v1/login), so it
 * may be nobody's account. Counted as any name is, so the answer never says
 * which names are accounts; only how many such counts the store keeps is
 * bounded (`keep`, HB-1240).
 */
export function noteFailure(req: FastifyRequest, who?: string | SharedBucket, scope?: 'link' | '2fa', opts: { typed?: boolean } = {}): void {
  for (const k of throttleKeys(req, who, scope)) {
    const f = failures.get(k);
    const now = Date.now();
    const cur: Count = !f || now > f.until ? { n: 1, until: now + FAIL_WINDOW_MS } : { n: f.n + 1, until: f.until };
    if (opts.typed === true) cur.typed = true;
    failures.set(k, cur);
    // A public bucket that just filled: lock it for its backed-off time, and put it on the record.
    // Only a count at the public address: a forged forwarded-for address holding `pub:` had
    // a strike of its own, kept a day in the store, and a burst on the record, for every
    // address a peer here made up (HB-1389 review).
    if (PUBLIC_KEY.test(k) && cur.n === limitFor(k)) {
      if (!CEILING_KEY.test(k)) cur.until = now + lockMsFor(k, req);
      req.server.publicAccess?.failureBurst(req, k, cur.until);
    }
    keep(k, f, cur, now, req, opts.typed === true);
  }
  bound(failures, Date.now());
}
/**
 * How many typed names that are no account keep their count in the store.
 * Any name typed at /v1/login is counted, and a loopback peer that typed a
 * new one every ten misses wrote ten rows a name (2,000 names: 20,000 rows,
 * kept about 75 minutes; HB-1240). Past this many, such a name's count is
 * this process's only: a restart gives a name that is nobody's another
 * window's tries, at an account that does not exist. An account's own count
 * is always kept, however many made-up ones there are, so no flood of them
 * can make a restart forget a real account's lockout; and below the bound a
 * made-up name is kept like a real one, so a restart does not tell which
 * names are accounts either.
 */
const MADE_UP_NAMES_KEPT = 500;
/**
 * A name's bucket. Anchored: only a `user:` or `pub:user:` key names an
 * account (an address key can hold any text). Its name is any text, line
 * breaks too: with `.`, a typed name holding one was no name key, so it was
 * stored past MADE_UP_NAMES_KEPT and ranked as an address (HB-1389 review).
 */
const NAME_KEY = /^(?:(?:link|2fa):)?(?:pub:)?user:([\s\S]*)$/;
/** A count at the public address. Anchored, as NAME_KEY: a forged forwarded-for address can read like one. */
const PUBLIC_KEY = /^(?:(?:link|2fa):)?pub:/;
/** This machine's accounts' names as their buckets have them (accountKey); undefined with no store, or unread. */
function accountNameKeys(): Set<string> | undefined {
  if (!throttleStore) return undefined;
  try { return new Set(throttleStore.listLocalAccounts().map((a) => accountKey(a.username))); }
  catch { return undefined; }
}
/** A typed-name bucket of a name that is no account here (by its bucket key, as the count is shared: `Kiosk` and `kiosk` are one). */
function madeUpName(k: string, accounts?: Set<string>): boolean {
  const name = NAME_KEY.exec(k)?.[1];
  if (name === undefined) return false;
  const known = accounts ?? accountNameKeys();
  return known !== undefined && !known.has(name); // unread: kept, as an account's would be
}
/** How many typed-name buckets (accounts' and made-up ones, both addresses) the store keeps now. */
function nameCountsKept(now: number): number {
  if (!throttleStore) return 0;
  try { return throttleStore.rateCounts(`${FAIL_BUCKET}user:`, now).length + throttleStore.rateCounts(`${FAIL_BUCKET}pub:user:`, now).length; }
  catch { return 0; }
}
/**
 * The store's copy of a count that refuses: at most its limit's misses, and
 * written only when that number or its end changes (the miss that fills it,
 * which is when a lock begins). Written at every miss past the limit, a
 * burst let through together (a route that checks, waits, then counts) cost
 * each miss a rewrite of all of them: 2,000 made-up tokens at once held the
 * process for five seconds (HB-0836). A typed name that is no account is
 * kept only while the store holds fewer than MADE_UP_NAMES_KEPT name counts
 * (HB-1240).
 */
function keep(k: string, was: { n: number; until: number } | undefined, cur: { n: number; until: number }, now: number, req: FastifyRequest, typed = false): void {
  if (k.replace(/^(?:link|2fa):/, '').startsWith('ip:fwd:')) return;
  const limit = limitFor(k);
  const kept = (v?: { n: number; until: number }) => (v && now <= v.until ? Math.min(v.n, limit) : 0);
  if (kept(cur) < limit || (kept(was) === limit && was?.until === cur.until)) return;
  if (typed && madeUpName(k) && nameCountsKept(now) >= MADE_UP_NAMES_KEPT) return;
  saveCount(FAIL_BUCKET, k, { n: limit, until: cur.until }, req);
}
/**
 * Bounded: expired entries go first, then, fewest misses first among
 * equals: this side's addresses' counts below their limit and names typed
 * here that are nobody's account; then this side's addresses' lockouts (a
 * peer on this machine can forge forwarded-for addresses, so they are worth
 * least); last, every count at the public address (all held to the public
 * ceiling, `pub:all`, so few), the ceiling itself, accounts' counts and the
 * shared buckets. Dropping the oldest by insertion let a flood of junk evict
 * the very account being guessed at, and with it the per-account cap (night
 * review, 2026-09-27); with every name alike, about 12,000 made-up names
 * each missed as often as a locked-out account did the same (HB-1389); with
 * every address alike, 9,500 from a forging peer let a public address's
 * lockout and the ceiling go, a sign-in link's only limits (HB-1389
 * review). The counts read back at the start are held to it too (HB-0836):
 * they carry no `typed`, so they go with the accounts' (the store keeps at
 * most MADE_UP_NAMES_KEPT made-up ones).
 */
function bound(m: Map<string, Count>, now: number): void {
  if (m.size <= 10_000) return;
  for (const [k, f] of m) if (now > f.until) m.delete(k);
  if (m.size > 8_000) {
    const accounts = accountNameKeys();
    // 0: this side's address below its limit, or a name typed here that is nobody's account;
    // 1: this side's address at its limit; 2: anything public, an account's, a shared bucket's
    // (whatever its last miss: a typed one let a flood evict the setup code's, HB-1434).
    const rank = (k: string, f: Count): number =>
      PUBLIC_KEY.test(k) || SHARED_KEY.test(k) ? 2
        : NAME_KEY.test(k) ? (f.typed && accounts !== undefined && madeUpName(k, accounts) ? 0 : 2)
          : f.n >= limitFor(k) ? 1 : 0;
    const order = [...m.entries()].map(([k, f]) => ({ k, n: f.n, r: rank(k, f) })).sort((a, b) => a.r - b.r || a.n - b.n);
    for (const { k } of order.slice(0, m.size - 8_000)) m.delete(k);
  }
}
/**
 * A recovered account starts clean: the lock-out someone ran up on it ends,
 * at both addresses and for its second factor (counted against
 * `2fa:<its id>`, secondFactor.ts), and so do their strikes, which outlive a
 * restart now: kept, its next lockout still doubled (HB-0836). A sign-in
 * link's misses name no account: there is none of its own to clear. The
 * addresses' counts and the public ceiling stay as they were: cleared, they
 * would be a reset button for those limits that anyone with an account
 * could press.
 */
export function clearFailures(who: string, ownerId?: string): void {
  const keys = [`user:${accountKey(who)}`, `pub:user:${accountKey(who)}`];
  if (ownerId) keys.push(`2fa:user:${accountKey(`2fa:${ownerId}`)}`, `2fa:pub:user:${accountKey(`2fa:${ownerId}`)}`);
  for (const k of keys) {
    failures.delete(k);
    saveCount(FAIL_BUCKET, k, undefined);
    strikes.delete(k);
    saveCount(STRIKE_BUCKET, k, undefined);
  }
}
/** Password mode has one password, so one bucket for it: forged forwarded-for addresses each got a fresh client bucket and unlimited guesses (night review). */
const PASSWORD_BUCKET: SharedBucket = { shared: 'shared-password' };
/** Test hook. */
export function _resetLoginThrottle(): void { failures.clear(); strikes.clear(); pending.clear(); }
/** Test hook: the bucket names in use (never their counts). */
export function _loginThrottleKeys(): string[] { return [...failures.keys()]; }
/** Test hook: the buckets with a strike (never their counts). */
export function _loginStrikeKeys(): string[] { return [...strikes.keys()]; }
// The session cookie's name, flags and reading rules: sessionCookie.ts. It is
// `secure` (and `__Host-`) only when the request actually arrived over HTTPS:
// the browser silently DISCARDS a secure cookie on an http:// origin, so a
// plain-HTTP install would log in and then loop.
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/**
 * Identity-mode browser sessions: ours once Google's token is verified. They
 * used to end with that token (Google's last about an hour), so the owner
 * signed in again every hour (Chris, 2026-09-28). The allowed-emails list is
 * still enforced on every request: the email rides in the signed cookie.
 */
export function sessionTtlMs(raw = process.env.HATCHABOT_SESSION_DAYS): number {
  // An empty or mistyped value (`HATCHABOT_SESSION_DAYS=` reaches us as '')
  // gave 0 or NaN: every Google sign-in "succeeded" into an already-expired
  // cookie and looped back to the login screen (review, 2026-09-29).
  const days = Number(raw);
  if (raw !== undefined && raw.trim() !== '' && Number.isFinite(days) && days > 0) return days * 24 * 60 * 60 * 1000;
  if (raw !== undefined && !warnedSessionDays) {
    warnedSessionDays = true;
    console.warn(`HATCHABOT_SESSION_DAYS=${JSON.stringify(raw)} is not a positive number of days; using 14.`);
  }
  return 14 * 24 * 60 * 60 * 1000;
}
let warnedSessionDays = false;

export interface AuthOptions {
  /** Shared password (HATCHABOT_PASSWORD). Unset = auth disabled, loudly. */
  password?: string;
  /** Key material for signing session cookies — we reuse the secret-store key. */
  secret: Buffer;
  /**
   * `password` — one shared password for the whole installation (default;
   *   a home install never needs a cloud identity provider).
   * `identity` — per-user accounts via GCP Identity Platform. See
   *   docs/identity.md; the verifier lands in phase 2.
   */
  mode?: AuthMode;
  /** Test seam / DI for identity mode. */
  verifier?: IdentityVerifier;
  /** Accounts mode keeps its credentials in the store. */
  store?: Store;
  /**
   * Called on each successful identity authentication. Phase 3 uses it to
   * hand a password-mode installation's data to its first real account.
   */
  onAuthenticated?: (principal: Principal) => void;
  /**
   * Resolves a long-lived CLI token to its owner. Works in BOTH auth modes,
   * so a Google-only account can still use the CLI (Google has no headless
   * password flow to offer it).
   */
  cliTokenOwner?: (token: string) => string | undefined;
  /** A token's scope: undefined = full owner access, 'rehost' = only what a
   *  peer server needs to move an agent here. */
  cliTokenScope?: (token: string) => string | undefined;
}

export type AuthMode = 'password' | 'accounts' | 'identity';

/** Local username/password accounts alongside Google sign-in (identity mode). */
export function localAccountsEnabled(env = process.env): boolean {
  return env.HATCHABOT_LOCAL_ACCOUNTS === '1';
}

export function authModeFromEnv(env = process.env): AuthMode {
  const raw = (env.HATCHABOT_AUTH ?? 'password').toLowerCase();
  if (raw === 'identity') return 'identity';
  if (raw === 'accounts') return 'accounts';
  if (raw !== 'password') {
    throw new Error(`HATCHABOT_AUTH must be "password", "accounts" or "identity" (got "${raw}")`);
  }
  return 'password';
}

/**
 * Is anyone actually being authenticated? Password mode needs a password to be
 * set; accounts and identity modes authenticate by construction, whatever
 * HATCHABOT_PASSWORD says (accounts mode ignores it entirely).
 */
export function authIsEnabled(mode: AuthMode, password: string | undefined): boolean {
  return mode !== 'password' || !!password;
}

/**
 * Why this process must not start, or undefined. With no sign-in every request
 * is the owner, and binding to loopback does not keep agents out where they
 * reach this process from loopback: under a rootless daemon, and on Docker
 * Desktop, where `host.docker.internal` is this machine's loopback (HB-0238).
 */
export function noSignInRefusal(mode: AuthMode, password: string | undefined): string | undefined {
  if (authIsEnabled(mode, password) || !loopbackIsRemote()) return undefined;
  const where = process.env.HATCHABOT_CONTAINERS_ON_LOOPBACK === '1' ? 'rootless Docker' : 'Docker Desktop';
  return `Refusing to start: sign-in is off, and under ${where} every agent can reach this process as if it were on the machine. Set HATCHABOT_AUTH=accounts (or a HATCHABOT_PASSWORD) in .env.`;
}

/**
 * Where to listen. With auth OFF every request is the owner, and agent
 * containers can reach this process over the docker bridge — so binding
 * 0.0.0.0 there would hand the fleet to any prompt-injected agent. With auth
 * on, listen everywhere so a tailnet or LAN client can reach the app.
 * HATCHABOT_BIND always wins.
 */
export function bindHostFor(env: NodeJS.ProcessEnv, mode: AuthMode): string {
  if (env.HATCHABOT_BIND) return env.HATCHABOT_BIND;
  return authIsEnabled(mode, env.HATCHABOT_PASSWORD) ? '0.0.0.0' : '127.0.0.1';
}

/**
 * LAN-grade auth: one shared password, exchanged for a signed, httpOnly
 * session cookie. This is deliberately not accounts/identity — it is the
 * "don't let anyone on the wifi own my agents" lock. Real identity arrives
 * when Hatchabot leaves the LAN.
 *
 * The page itself (GET /) and /healthz stay open; every /v1/* call except
 * login requires the cookie. The app shows a password screen on 401.
 */
declare module 'fastify' {
  interface FastifyInstance {
    /** Resolve a principal from a raw Cookie header — for a WebSocket upgrade,
     *  which Fastify never sees and so has no `request.principal`. Returns
     *  undefined when the caller is not authenticated. Same session logic as
     *  the onRequest hooks; deliberately the ONLY seam, so the two can't drift.
     *  `https`: whether that request came over HTTPS (sessionCookie.ts
     *  requestIsHttps), which decides which cookie names count. */
    principalFromCookieHeader?: (cookieHeader: string | undefined, https: boolean) => Principal | undefined;
  }
}

/** The session value in a raw `Cookie:` header (a WebSocket upgrade's), by sessionCookie.ts's rules. */
function cookieValue(header: string | undefined, https: boolean): string | undefined {
  return readSessionCookie(header, https)?.value;
}

/**
 * "Sign out everywhere": ends every session the signed-in person has, on every
 * device, by bumping their sign-in epoch (store.session_epochs), and clears
 * this browser's cookie. Plain /v1/logout still only forgets this browser's
 * copy — a cookie copied off a shared device kept working for its full 14
 * days with no way to end it short of rotating the secret key (review,
 * 2026-09-29). Not auth-exempt: only a signed-in person ends their own.
 */
function registerLogoutEverywhere(app: FastifyInstance, store: Store | undefined, signsIn = true): void {
  app.post('/v1/logout/everywhere', async (req, reply) => {
    // The management agent's in-process reads never sign anyone out.
    if (internalPrincipal(req)) return reply.code(403).send({ error: 'Only the person themselves can sign out everywhere.' });
    const who = req.principal?.ownerId;
    if (!who) return reply.code(401).send({ error: 'auth required' });
    if (!signsIn) return reply.code(400).send({ error: 'Nobody signs in to this installation, so there are no sessions to end.' });
    if (!store) return reply.code(503).send({ error: 'This server has no database to record the sign-out in.' });
    store.bumpSessionEpoch(who);
    // …and their command-line sign-ins, which never read the epoch
    // (2026-09-30). A Google-signed-in CLI keeps its own refresh token on
    // that computer; the confirm tells them to run `hatchabot logout` there.
    const cliTokens = store.revokePersonalCliTokens(who);
    // …and the browsers the public address remembers: the next sign-in from each is announced again.
    store.forgetDevices(who);
    if (cliTokens) app.log.warn({ owner: who, revoked: cliTokens }, 'logout_everywhere.cli_tokens_revoked');
    // Every session has ended with the epoch, and every pass with its session.
    clearSessionCookies(reply, req, true);
    return { ok: true, cliTokens };
  });
}

/** The console proxy: a browser reaches an agent's Control UI through here, with its cookie. */
const CONSOLE_PATH = /^\/v1\/agents\/[^/]+\/ui(\/|$)/;

/**
 * One-time sign-in links (docs/signin-links.md), when HATCHABOT_SIGNIN_KEY_FILE
 * is set: each mode says what "sign in as this account" means for it. Spent
 * nonces live in the store, so without one there are no links.
 */
function linkRoute(app: FastifyInstance, opts: AuthOptions, signIn: SigninLinkDeps['signIn']): void {
  if (!process.env.HATCHABOT_SIGNIN_KEY_FILE?.trim()) return;
  if (!opts.store) { app.log.error('signin_link: no database to record spent links in; sign-in links are off'); return; }
  // Its own count (throttleKeys): a link's misses are not the password form's.
  registerSigninLink(app, { store: opts.store, guard: { throttled: (req) => throttled(req, undefined, 'link'), noteFailure: (req) => noteFailure(req, undefined, 'link') }, signIn });
}

export async function registerAuth(app: FastifyInstance, opts: AuthOptions): Promise<void> {
  await app.register(fastifyCookie);
  keepThrottleIn(opts.store, app.log);
  // Before any sign-in hook: a request a page on another site (a neighbouring
  // tenant included) made the browser send changes nothing (requestOrigin.ts).
  registerOriginCheck(app);

  const mode: AuthMode = opts.mode ?? 'password';
  // The public address's gate (publicAccess.ts), in two halves around the
  // sign-in hook: what is refused whoever asks comes before it, what depends
  // on who is asking (the second factor, the idle limit) after it.
  const publicGate = registerPublicAccess(app, { store: opts.store, secret: opts.secret, mode, throttle: { throttled, noteFailure, reserve } });
  if (opts.store && mode !== 'password') registerSecondFactorRoutes(app, { store: opts.store, secret: opts.secret, api: publicGate });
  if (mode === 'identity') {
    await registerIdentityAuth(app, opts);
    publicGate.afterSignIn();
    return;
  }
  if (mode === 'accounts') {
    registerAccountsAuth(app, opts);
    publicGate.afterSignIn();
    return;
  }
  // Password mode: the public listener never serves (safeguard a), and the gate's first half refuses everything there.

  if (!opts.password) {
    app.log.warn(
      'HATCHABOT_PASSWORD is not set — the API is open to anyone who can reach this port.',
    );
  }

  /**
   * Sessions are bound to the current password: its hash rides in the signed
   * payload, so rotating HATCHABOT_PASSWORD invalidates every existing
   * session instead of leaving 30-day cookies valid.
   */
  const pwEpoch = createHmac('sha256', opts.secret)
    .update(`pw:${opts.password ?? ''}`)
    .digest('hex')
    .slice(0, 16);

  // The one owner's sign-in epoch is signed in too, so "sign out everywhere"
  // ends every device's session without changing the password. Epoch 0 signs
  // exactly what it did before, so existing sessions survive the upgrade
  // (review, 2026-09-29).
  const epochNow = (): number => opts.store?.sessionEpoch(LOCAL_OWNER) ?? 0;
  const sign = (exp: number, epoch = epochNow()): string =>
    createHmac('sha256', opts.secret).update(`session:${exp}:${pwEpoch}${epoch ? `:e${epoch}` : ''}`).digest('hex');

  const validSession = (token: string | undefined): boolean => {
    if (!token) return false;
    const [expStr, sig] = token.split('.');
    const exp = Number(expStr);
    if (!expStr || !sig || !Number.isFinite(exp) || exp < Date.now()) return false;
    const expected = sign(exp);
    return safeEqual(sig, expected);
  };

  app.post('/v1/login', async (req, reply) => {
    if (!opts.password) return { ok: true }; // auth disabled
    if (throttled(req, PASSWORD_BUCKET)) return reply.code(429).send({ error: 'Too many failed attempts — try again later.' });
    const given = LoginBody.safeParse(req.body).data?.password ?? '';
    const match = safeEqual(given, opts.password);
    if (!match) {
      // Flat-rate the brute-force path a little; real rate limiting can come
      // with real identity.
      noteFailure(req, PASSWORD_BUCKET);
      await new Promise((r) => setTimeout(r, 400));
      return reply.code(401).send({ error: 'Wrong password' });
    }
    const exp = Date.now() + TTL_MS;
    // Behind HTTPS (Tailscale serve, a terminating proxy) the 30-day cookie
    // must not ride a forced plaintext request; plain-HTTP LAN installs
    // still work because the flag is only set when the request came in
    // encrypted. Same rule in every mode (sessionCookie.ts).
    setSessionCookie(reply, req, `${exp}.${sign(exp)}`, TTL_MS / 1000);
    return { ok: true };
  });

  // Symmetric with identity mode: lock the app on a shared screen, or switch
  // who this tab is. Exempt from auth below — logging out with an already
  // dead session must succeed, not 401.
  app.post('/v1/logout', async (req, reply) => {
    if (!clearSessionCookies(reply, req)) return reply.code(503).send({ error: SIGN_OUT_NOT_SAVED });
    return { ok: true };
  });
  registerLogoutEverywhere(app, opts.store, !!opts.password);

  // Password mode has one person: a link for "owner" is a password session,
  // and a link naming anyone else names nobody here.
  linkRoute(app, opts, (req, reply, who): LinkSignIn => {
    if (!('owner' in who)) return { kind: 'refused', why: 'no-account' };
    if (opts.password) {
      const exp = Date.now() + TTL_MS;
      setSessionCookie(reply, req, `${exp}.${sign(exp)}`, TTL_MS / 1000);
    }
    return { kind: 'session', ownerId: LOCAL_OWNER };
  });

  app.decorate('principalFromCookieHeader', (header: string | undefined, https: boolean): Principal | undefined => {
    if (!opts.password) return { ownerId: LOCAL_OWNER, via: 'password' };
    return validSession(cookieValue(header, https))
      ? { ownerId: LOCAL_OWNER, via: 'password' }
      : undefined;
  });

  app.addHook('onRequest', async (req, reply) => {
    { const internal = internalPrincipal(req); if (internal) { req.principal = internal; return; } }
    if (!opts.password) {
      req.principal = { ownerId: LOCAL_OWNER, via: 'password' };
      return;
    }
    const path = routedPath(req.url);
    // /v1/config tells the login screen which mode to render — it must be
    // readable before anyone is authenticated.
    if (path === '/' || path === '/healthz' || path === '/v1/login' || path === '/v1/config') return;
    if (path === '/v1/logout') return;
    // A one-time sign-in link is its own credential, checked in the route
    // (which exists only when HATCHABOT_SIGNIN_KEY_FILE is set).
    if (path === SIGNIN_LINK_PATH) return;
    // PWA shell assets carry no data — reachable before login so the app can install.
    if (path === '/manifest.webmanifest' || path === '/sw.js' || path === '/app-qr.svg' || path.startsWith('/icons/') || PAGE_SCRIPT_PATH.test(path)) return;
    if (path === '/privacy' || path === '/terms') return; // public legal pages (Google OAuth consent screen)
    // Invitees don't have the LAN password — their invite code is their
    // credential. The join surface validates codes itself.
    if (path.startsWith('/join/') || path === '/v1/join' || path.startsWith('/v1/invites/')) return;
    // Google's OAuth redirect is a CROSS-SITE top-level navigation: the
    // strict-SameSite session cookie deliberately stays home, so this one
    // path authenticates by its single-use state token instead (issued to an
    // authenticated owner at /start; consumed exactly once in the handler).
    if (path === '/v1/connections/google/callback') return;
    // Agent-to-agent consult: authenticated by the CALLER AGENT's own call
    // token inside the handler (not a user session), so it's exempt here.
    if (isAgentMessageRoute(req)) return;
    const cliOwner = cliBearer(req, opts);
    if (cliOwner) {
      req.principal = { ownerId: cliOwner, via: 'identity', subject: cliOwner };
      return;
    }
    if (validSession(sessionValue(req))) {
      // A valid password session IS the installation's single owner. In
      // identity mode this becomes the verified token subject.
      req.principal = { ownerId: LOCAL_OWNER, via: 'password' };
      upgradeSessionCookie(req, reply, TTL_MS / 1000);
      return;
    }
    return reply.code(401).send({ error: 'auth required' });
  });
}

/**
 * Accounts mode: several local accounts, each with its own username and
 * password, kept in this installation's database. Same session cookie shape as
 * the other modes; the difference is that the cookie names WHICH account, and
 * every route then scopes to that owner id.
 */
function registerAccountsAuth(app: FastifyInstance, opts: AuthOptions): void {
  const store = opts.store;
  if (!store) throw new Error('accounts mode needs a store (registerAuth opts.store)');

  registerAccountRoutes(app, { store, secret: opts.secret, onAuthenticated: opts.onAuthenticated, cliTokenOwner: opts.cliTokenOwner }, { throttled, noteFailure, clearFailures, reserve });

  app.post('/v1/logout', async (req, reply) => {
    if (!clearSessionCookies(reply, req)) return reply.code(503).send({ error: SIGN_OUT_NOT_SAVED });
    return { ok: true };
  });
  registerLogoutEverywhere(app, store);

  linkRoute(app, opts, (req, reply, who): LinkSignIn => {
    const account = 'owner' in who ? store.listLocalAccounts().find((a) => a.hostOwner) : store.localAccountByUsername(who.user);
    const r = signInLocalByLink(store, opts.secret, req, reply, account);
    if (r.kind === 'session' && account) opts.onAuthenticated?.({ ownerId: account.id, via: 'password' });
    return r;
  });

  app.decorate('principalFromCookieHeader', (header: string | undefined, https: boolean): Principal | undefined => {
    const id = sessionAccount(store, opts.secret, cookieValue(header, https));
    return id ? { ownerId: id, via: 'password', subject: id } : undefined;
  });

  app.addHook('onRequest', async (req, reply) => {
    { const internal = internalPrincipal(req); if (internal) { req.principal = internal; return; } }
    const path = routedPath(req.url);
    if (path === '/' || path === '/healthz' || path === '/v1/config') return;
    if (path === '/v1/login' || path === '/v1/logout') return;
    if (path === SIGNIN_LINK_PATH) return; // the link is the credential; the route checks it
    // First run has no accounts and therefore no way to authenticate; the
    // route itself refuses once account #1 exists.
    if (path === '/v1/local-accounts/bootstrap') return;
    // An invitation is claimed by someone who cannot sign in yet — the code is
    // the credential, and the route validates it.
    if (path === '/v1/local-accounts/claim') return;
    // "Forgot password?" is asked by someone who cannot sign in. The route
    // answers the same whatever the username, rate-limits, and only ever sends
    // a link to a Telegram account already proven to be that person's.
    if (path === '/v1/local-accounts/recover') return;
    // …and so is using a recovery code: it IS the credential, checked in the route.
    if (path === '/v1/local-accounts/recover-with-code') return;
    if (path.startsWith('/join/') || path === '/v1/join' || path.startsWith('/v1/invites/')) return;
    if (path === '/manifest.webmanifest' || path === '/sw.js' || path === '/app-qr.svg' || path.startsWith('/icons/') || PAGE_SCRIPT_PATH.test(path)) return;
    if (path === '/privacy' || path === '/terms') return;
    if (path === '/v1/connections/google/callback') return;
    if (isAgentMessageRoute(req)) return;

    const cliOwner = cliBearer(req, opts);
    if (cliOwner) {
      // ownerForCliToken checks only the hash and expiry, so a token minted by
      // an account that has since been removed or disabled would still
      // authenticate as that owner — removal has to mean revoked (audit
      // 2026-09-16).
      const owner = store.localAccount(cliOwner);
      if (!owner || owner.disabled) {
        return reply.code(401).send({ error: 'That access token belongs to an account that no longer exists.' });
      }
      req.principal = { ownerId: cliOwner, via: 'identity', subject: cliOwner };
      return;
    }
    const id = sessionAccount(store, opts.secret, sessionValue(req));
    if (id) {
      req.principal = { ownerId: id, via: 'password', subject: id };
      upgradeSessionCookie(req, reply, TTL_MS / 1000);
      opts.onAuthenticated?.(req.principal);
      return;
    }
    return reply.code(401).send({ error: 'auth required' });
  });
}

/** With an allowlist set, is this Google owner still on it? True = refuse. */
function cliAllowlistProblem(opts: AuthOptions, ownerId: string): boolean {
  const raw = process.env.HATCHABOT_ALLOWED_EMAILS?.trim();
  if (!raw || !opts.store) return false;
  const allowed = raw.split(/[\s,]+/).filter(Boolean);
  return !allowed.some((e) => opts.store!.ownerForEmail(e) === ownerId);
}

/**
 * Identity mode: the caller proves who they are with an Identity Platform ID
 * token (Authorization: Bearer …, or a cookie the browser got by posting one
 * to /v1/session). The control plane never sees a password — Google does the
 * authenticating, we do the verifying.
 */
async function registerIdentityAuth(app: FastifyInstance, opts: AuthOptions): Promise<void> {
  const verifier = opts.verifier ?? new IdentityVerifier(identityConfigFromEnv());
  // HATCHABOT_LOCAL_ACCOUNTS=1 keeps local username/password accounts alongside
  // Google sign-in: the owner signs in with Google, everyone else gets an
  // invitation link — nobody else needs a cloud project to exist.
  const localAccounts = opts.store && localAccountsEnabled();
  if (localAccounts && opts.store) {
    registerAccountRoutes(
      app,
      { store: opts.store, secret: opts.secret, onAuthenticated: opts.onAuthenticated, cliTokenOwner: opts.cliTokenOwner },
      { throttled, noteFailure, clearFailures, reserve },
      { bootstrap: false }, // the host owner is the Google account; nobody bootstraps
    );
  }

  // The browser trades a verified ID token for a short session cookie, so the
  // token itself never sits in localStorage and every page load isn't a
  // round-trip to Google.
  const sign = (payload: string): string =>
    createHmac('sha256', opts.secret).update(payload).digest('hex');

  // Payload: sub:exp:e<epoch>[:email]. The epoch field starts with "e" and
  // has no "@", so it never reads as an email; a cookie from before it
  // (sub:exp[:email]) is epoch 0 and keeps working until the person's first
  // "sign out everywhere" (review, 2026-09-29).
  const epochOf = (ownerId: string): number => opts.store?.sessionEpoch(ownerId) ?? 0;
  const mintSession = (sub: string, expMs: number, email?: string): string => {
    const epoch = epochOf(`user-${sub}`);
    const payload = `${sub}:${expMs}:e${epoch}${email ? `:${email}` : ''}`;
    return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
  };

  const readSession = (cookie: string | undefined): { sub: string; email?: string } | undefined => {
    if (!cookie) return undefined;
    const [b64, sig] = cookie.split('.');
    if (!b64 || !sig) return undefined;
    const payload = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = sign(payload);
    if (!safeEqual(sig, expected)) return undefined;
    const [sub, expStr, ...rest] = payload.split(':');
    // NaN never compares true, so a missing exp would fail OPEN — guard it
    // the same way password-mode's validSession does.
    const exp = Number(expStr);
    if (!sub || !Number.isFinite(exp) || exp < Date.now()) return undefined;
    // Minted before the person's last "sign out everywhere": over.
    const epochField = rest[0] !== undefined && /^e\d+$/.test(rest[0]) ? rest.shift()! : 'e0';
    if (Number(epochField.slice(1)) < epochOf(`user-${sub}`)) return undefined;
    // A long session still answers to the allowed-emails list, checked now.
    // (Sessions from before the email rode along were an hour long; they
    // are refused once a list is set.)
    const email = rest.length ? rest.join(':') : undefined;
    if (process.env.HATCHABOT_ALLOWED_EMAILS?.trim() && allowedEmailProblem(email)) return undefined;
    // The email rides along to the principal: without it shares were stored
    // "from another user" and the own-address guard never fired (review,
    // 2026-09-29). Only verified emails are ever minted (see /v1/session).
    return { sub, email };
  };

  app.post('/v1/session', async (req, reply) => {
    const idToken = SessionBody.safeParse(req.body).data?.idToken;
    if (!idToken) return reply.code(400).send({ error: 'idToken required' });
    if (throttled(req)) return reply.code(429).send({ error: 'Too many failed attempts — try again later.' });
    try {
      const token = await verifier.verify(idToken);
      // Admission refuses an unverified email. It ran AFTER the cookie
      // was set, so the 401 carried a working 14-day session and "verify
      // your email" gated nothing (review, 2026-09-29). Judge first, mint last.
      const principal = admittedPrincipal(token);
      // "Only invited people": at the public address a Google account this
      // installation has never met, and nobody invited, is a stranger. It
      // cannot become an account by signing in there (safeguard c).
      if (isPublic(req) && !(opts.store?.identityIsInvited(token.sub, token.email) ?? false)) {
        noteFailure(req);
        opts.store?.recordSecurity('public.signin_refused', undefined, { why: 'not invited', from: publicClientAddress(req) });
        return reply.code(403).send({ error: 'Only people who were invited can sign in at this address. Ask whoever runs this Hatchabot for an invitation.' });
      }
      const exp = Date.now() + sessionTtlMs();
      setSessionCookie(reply, req, mintSession(token.sub, exp, token.email), (exp - Date.now()) / 1000);
      opts.onAuthenticated?.(principal);
      return { ok: true, ownerId: principal.ownerId, email: principal.email };
    } catch (err) {
      // Could not check is not a guess: counted, an outage locked people out after it ended (HB-0424).
      if (err instanceof IdentityUnavailableError) return reply.code(503).header('retry-after', '60').send({ error: err.userMessage });
      if (err instanceof IdentityError && err.statusCode === 403) return reply.code(403).send({ error: err.userMessage });
      noteFailure(req);
      if (err instanceof IdentityError) return reply.code(401).send({ error: err.userMessage });
      throw err;
    }
  });

  app.post('/v1/logout', async (req, reply) => {
    if (!clearSessionCookies(reply, req)) return reply.code(503).send({ error: SIGN_OUT_NOT_SAVED });
    return { ok: true };
  });
  registerLogoutEverywhere(app, opts.store);

  // A link names the machine's owner or an email. A Google account is found
  // by the verified email its last sign-in recorded (so someone who never
  // signed in here has no account to sign in to), and answers to the
  // allowed-emails list like any session; a local account (when those are
  // on) signs in as in accounts mode.
  linkRoute(app, opts, (req, reply, who): LinkSignIn => {
    const store = opts.store!;
    const ownerId = 'owner' in who ? store.localHostOwnerId() : store.identityOwnerForEmail(who.user);
    if (ownerId?.startsWith('user-')) {
      const email = store.emailForOwner(ownerId);
      if (process.env.HATCHABOT_ALLOWED_EMAILS?.trim() && allowedEmailProblem(email)) return { kind: 'refused', why: 'not-allowed' };
      const exp = Date.now() + sessionTtlMs();
      setSessionCookie(reply, req, mintSession(ownerId.slice('user-'.length), exp, email), (exp - Date.now()) / 1000);
      opts.onAuthenticated?.({ ownerId, via: 'identity', subject: ownerId.slice('user-'.length), email });
      return { kind: 'session', ownerId };
    }
    if (!localAccounts) return { kind: 'refused', why: 'no-account' };
    const account = 'owner' in who
      ? (ownerId ? store.localAccount(ownerId) : undefined)
      : store.localAccountByUsername(who.user);
    return signInLocalByLink(store, opts.secret, req, reply, account);
  });

  app.decorate('principalFromCookieHeader', (header: string | undefined, https: boolean): Principal | undefined => {
    const session = readSession(cookieValue(header, https));
    if (session) return { ownerId: `user-${session.sub}`, via: 'identity', subject: session.sub, email: session.email };
    // A local account's session, as the request hook accepts it: without this
    // their console's WebSocket was always refused (night review).
    if (localAccounts && opts.store) {
      const id = sessionAccount(opts.store, opts.secret, cookieValue(header, https));
      const owner = id ? opts.store.localAccount(id) : undefined;
      if (id && owner && !owner.disabled) return { ownerId: id, via: 'password', subject: id };
    }
    return undefined;
  });

  app.addHook('onRequest', async (req, reply) => {
    { const internal = internalPrincipal(req); if (internal) { req.principal = internal; return; } }
    const path = routedPath(req.url);
    if (path === '/' || path === '/healthz' || path === '/v1/config') return;
    if (path === '/v1/session' || path === '/v1/logout') return;
    if (path === SIGNIN_LINK_PATH) return; // the link is the credential; the route checks it
    // Sign-in, claiming an invitation, and the bootstrap route (which answers
    // with "this installation signs in with Google" rather than a bare 401).
    // Recovery too: local accounts forget passwords here as anywhere (the
    // Telegram link was unreachable in this mode — 24th audit, low).
    if (localAccounts && (path === '/v1/login' || path === '/v1/local-accounts/claim' || path === '/v1/local-accounts/bootstrap'
      || path === '/v1/local-accounts/recover' || path === '/v1/local-accounts/recover-with-code')) return;
    if (path.startsWith('/join/') || path === '/v1/join' || path.startsWith('/v1/invites/')) return;
    // PWA shell assets carry no data — reachable before login so the app can install.
    if (path === '/manifest.webmanifest' || path === '/sw.js' || path === '/app-qr.svg' || path.startsWith('/icons/') || PAGE_SCRIPT_PATH.test(path)) return;
    if (path === '/privacy' || path === '/terms') return; // public legal pages (Google OAuth consent screen)
    // Cross-site OAuth redirect: strict-SameSite keeps the session cookie
    // home, so the single-use state token is this path's credential.
    if (path === '/v1/connections/google/callback') return;
    // Agent-to-agent consult: authenticated by the CALLER AGENT's own call
    // token inside the handler (not a user session), so it's exempt here.
    if (isAgentMessageRoute(req)) return;

    const cliOwner = cliBearer(req, opts);
    if (cliOwner) {
      // Same rule as accounts mode: a local account that was disabled or
      // removed takes its tokens with it (26th audit).
      const local = localAccounts ? opts.store?.localAccount(cliOwner) : undefined;
      if (local?.disabled) return reply.code(401).send({ error: 'That access token belongs to an account that no longer exists.' });
      // A Google account's token answers to the allowlist too: an email taken
      // off HATCHABOT_ALLOWED_EMAILS kept working through its 90-day tokens
      // (night review). Its email is the one its last sign-in recorded.
      if (!local && cliAllowlistProblem(opts, cliOwner)) {
        return reply.code(403).send({ error: 'That access token belongs to an account this installation no longer allows.' });
      }
      req.principal = { ownerId: cliOwner, via: 'identity', subject: cliOwner };
      return;
    }

    // Bearer token (CLI, phone app) — verified on every call. Not on the
    // console proxy: OpenClaw 2026.9's Control UI sends the AGENT's gateway
    // token as `Authorization: Bearer …` on its own fetches (workspace icon,
    // avatar, config). That token is for the gateway, not for us; judging it
    // here refused the request before the owner's cookie was even looked at,
    // and the UI retried the icon thousands of times an hour (2026-09-24).
    // The cookie decides those requests; the proxy still strips our tokens.
    // Not at the public address: there a browser session is the only way in
    // (a bearer skips the second factor and the idle limit).
    const authz = req.headers.authorization;
    if (typeof authz === 'string' && authz.startsWith('Bearer ') && !CONSOLE_PATH.test(path) && !isPublic(req)) {
      try {
        const token = await verifier.verify(authz.slice(7));
        req.principal = admittedPrincipal(token);
        opts.onAuthenticated?.(req.principal);
        return;
      } catch (err) {
        const msg = err instanceof IdentityError ? err.userMessage : 'auth required';
        return reply.code(err instanceof IdentityError ? err.statusCode : 401).send({ error: msg });
      }
    }

    // Browser session cookie minted from an already-verified token.
    const session = readSession(sessionValue(req));
    if (session) {
      req.principal = { ownerId: `user-${session.sub}`, via: 'identity', subject: session.sub, email: session.email };
      upgradeSessionCookie(req, reply, sessionTtlMs() / 1000);
      opts.onAuthenticated?.(req.principal);
      return;
    }
    // …or a local account's session, when those run alongside Google. The two
    // cookie shapes are signed with different material, so one never validates
    // as the other.
    if (localAccounts && opts.store) {
      const id = sessionAccount(opts.store, opts.secret, sessionValue(req));
      if (id) {
        const owner = opts.store.localAccount(id);
        if (owner && !owner.disabled) {
          req.principal = { ownerId: id, via: 'password', subject: id };
          upgradeSessionCookie(req, reply, TTL_MS / 1000);
          opts.onAuthenticated?.(req.principal);
          return;
        }
      }
    }
    return reply.code(401).send({ error: 'auth required' });
  });
}


/**
 * A `hatchabot_…` bearer is a long-lived token this installation minted, not
 * an identity-provider token — resolve it locally.
 */
/** What a rehost-scoped token may call: the other server's move, and nothing else. */
const REHOST_PATHS = new Set(['/v1/agents/preflight', '/v1/agents/restore', '/v1/agents']);
/**
 * …and the receipt of a move it announced (GET /v1/moves/:id, migrate.ts
 * askAboutMove): left out, the mover's question after a lost answer was a 401,
 * read as "no answer", and a move the destination knew had failed stayed held
 * (audit #008). Answered for the token's owner only (moveState). The id's shape
 * is moveIdFrom's, so nothing else under /v1/moves/ matches.
 */
const REHOST_MOVE_RECEIPT = /^\/v1\/moves\/[A-Za-z0-9_-]{8,80}$/;
function cliBearer(req: FastifyRequest, opts: AuthOptions): string | undefined {
  // Command-line and peer tokens are long-lived bearers with no second
  // factor: they are for the private address. At the public one they are not
  // looked at, whatever they are worth elsewhere.
  if (isPublic(req)) return undefined;
  const authz = req.headers.authorization;
  if (typeof authz !== 'string') return undefined;
  if (!authz.startsWith('Bearer hatchabot_') && !authz.startsWith('Bearer agentclaw_')) return undefined;
  const token = authz.slice(7);
  const owner = opts.cliTokenOwner?.(token);
  if (!owner) return undefined;
  // The token a peer server holds for moving agents here used to be a full
  // owner token: a hostile peer could read bot tokens and credentials, delete
  // agents, mint more tokens (26th audit). A scoped one opens the move's routes.
  const scope = opts.cliTokenScope?.(token);
  if (scope === 'rehost') {
    const path = routedPath(req.url);
    const ok = (REHOST_PATHS.has(path) && (path === '/v1/agents' ? req.method === 'GET' : req.method === 'POST')) ||
      (REHOST_MOVE_RECEIPT.test(path) && req.method === 'GET');
    if (!ok) return undefined;
  }
  return owner;
}
