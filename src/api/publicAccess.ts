import { routedPath } from './routedPath.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from '../store/store.js';
import { addressBucket, approximateSource, isPublic, markPublicSocket, publicClientAddress } from './trust.js';
import { guestMay, publicRuleFor, type PublicRule } from './publicRoutes.js';
import { cookieFromHeader, readSessionCookie, sessionValue } from './sessionCookie.js';
import type { ConsoleSocketsApi } from './consoleSockets.js';
import { adminAccounts, evaluateSafeguards, failingSafeguards, hostOf, publicConfig, usableFactors, type PublicConfig, type SafeguardCheck } from './safeguards.js';

/**
 * Public access: the gate in front of everything that arrives on the public
 * listener (docs/public-access.md). The listener is a second, plain HTTP
 * server on 127.0.0.1 that hands its requests to the same Fastify app; every
 * socket it accepts is recorded (trust.ts), and that record, not a header, is
 * what makes a request "public".
 *
 * For a public request, in order:
 *   1. Is public access serving at all? Only while it is switched on AND
 *      every safeguard holds (safeguards.ts, re-judged every minute). If not:
 *      503, whoever asks. Fail closed.
 *   2. The request ceilings (all visitors together, and per address).
 *   3. The route's class (publicRoutes.ts). `never`, and any route nobody
 *      classified, is refused here, before the sign-in code sees it.
 *   -- the sign-in hook runs (auth.ts) --
 *   4. The public pass: a second cookie, handed out only by a sign-in made AT
 *      the public address and bound to that session, carrying when it was
 *      last used and when the second factor was last given. No pass, or one
 *      idle too long: sign in again. So a session from the private address
 *      does not carry over, and a public session ends after an idle time far
 *      shorter than the cookie's 30 days.
 *   5. The second factor: required of everyone who signs in with a password
 *      and of every account with owner rights; a Google account without
 *      owner rights is exempt (Google is its factor) unless it has added
 *      one. Until given, only the second-factor screen works. Someone who
 *      must have one and has none is refused (and may add it there only
 *      after a link sent out of band). The one exception is the owner's
 *      deliberate switch for chat-only guests, who then get the chat and
 *      nothing else.
 *   6. Step-up: machine-level and dangerous routes need the second factor
 *      given again within the last few minutes.
 */

export const PASS_COOKIE = '__Host-hatchabot_pub';
export const DEVICE_COOKIE = '__Host-hatchabot_device';
const cookieOpts = { httpOnly: true, sameSite: 'strict' as const, path: '/', secure: true };

export interface PublicAccessOptions {
  store?: Store;
  secret: Buffer;
  mode: 'password' | 'accounts' | 'identity';
  throttle: {
    throttled(req: FastifyRequest, who?: string, scope?: 'link' | '2fa'): boolean;
    noteFailure(req: FastifyRequest, who?: string, scope?: 'link' | '2fa'): void;
    /** A place in the count while a guess is being checked (auth.ts reserve); undefined: refused. */
    reserve?(req: FastifyRequest, who?: string, scope?: 'link' | '2fa'): (() => void) | undefined;
  };
}

/** What the gate cannot know by itself; the routes and the process supply them. */
export interface PublicProbes {
  autoUpgrade(): Promise<{ ok: boolean; why?: string }>;
  /** Is `tailscale funnel` pointed at the PRIVATE port? undefined: unreadable. */
  funnelOnPrivatePort(privatePort: number): Promise<boolean | undefined>;
  /** Tell one person something on Telegram, if they are linked. Best effort. */
  telegram(ownerId: string, text: string): Promise<boolean>;
  /** The private address of the app, for links in notices. */
  appUrl(): string | undefined;
}

export interface PublicStatus {
  on: boolean;
  serving: boolean;
  listening: boolean;
  url?: string;
  port: number;
  funnelPort: number;
  checks: SafeguardCheck[];
  failing: SafeguardCheck[];
  checkedAt?: string;
}

export type SecondFactorNeed = 'no' | 'yes' | 'missing' | 'guest';

/** `en`: until when this sign-in may add the person's FIRST second factor (0: it may not; see FIRST_FACTOR_PROOF). */
interface Pass { sess: string; minted: number; seen: number; sfAt: number; used: boolean; en: number }

export interface PublicAccessApi {
  config(): PublicConfig;
  status(): PublicStatus;
  /** Gather the facts and judge every safeguard now. */
  evaluate(): Promise<SafeguardCheck[]>;
  setProbes(p: Partial<PublicProbes>): void;
  /** Open (or close) the public listener to match the configuration. */
  syncListener(): Promise<{ listening: boolean; error?: string }>;
  stopListener(): Promise<void>;
  /** A session was handed out (sessionCookie.ts): at the public address, hand out the pass with it. */
  sessionMinted(req: FastifyRequest, reply: FastifyReply, sessionValue: string): void;
  sessionCleared(req: FastifyRequest, reply: FastifyReply): void;
  /** A public failure bucket filled (auth.ts): put it on the record. */
  failureBurst(req: FastifyRequest, key: string, until: number): void;
  /** The second factor was just given by the signed-in person: note it on their public pass. */
  secondFactorPassed(req: FastifyRequest, reply: FastifyReply): void;
  /**
   * Does this person have to give a second factor at the public address?
   * `yes`: they have one and are asked for it. `missing`: they must and have
   * none. `guest`: a chat-only guest the owner chose to let in without one
   * (the chat and nothing else). `no`: a Google account without owner rights.
   */
  secondFactorNeed(ownerId: string): SecondFactorNeed;
  /** At the public address: has this request's sign-in given the second factor? (Always true at the private address.) */
  secondFactorGiven(req: FastifyRequest): boolean;
  hasOwnerRights(ownerId: string): boolean;
  /**
   * For code that reads the session itself rather than through the gate (a
   * WebSocket upgrade, which Fastify never sees; the open /v1/join route):
   * why this public request does not count as signed in (undefined: it does).
   * `acceptingWebChat`: the request is accepting a web-chat invitation, which
   * is how someone BECOMES a chat-only guest; with the owner's guest switch
   * on, an account that owns nothing may do that one thing without a factor.
   */
  refuseSession(rawReq: IncomingMessage, ownerId: string, opts?: { acceptingWebChat?: boolean }): string | undefined;
  /**
   * For a console socket that is already open (consoleSockets.ts re-judges
   * them): why it must close now (undefined: it may stay). `cookie` is the
   * Cookie header it was opened with; `lastActive` is when the browser last
   * sent anything on it, which is what "idle" means for a socket.
   */
  refuseOpenSocket(cookie: string | undefined, ownerId: string, lastActive: number): string | undefined;
  /**
   * For a route whose class is signed-in but where ONE thing its body can ask
   * for is machine-level (an agent's settings can name folders of this
   * machine): at the public address, why this request must give the second
   * factor again first, as a step-up route would be answered (undefined: go
   * on; always undefined at the private address).
   */
  stepUpRefusal(req: FastifyRequest): { code: number; body: Record<string, unknown> } | undefined;
  /** The site passkeys are made for: the host of the public (or private HTTPS) address. */
  rpId(): string | undefined;
  /** Every https origin this Hatchabot is opened at on that host. */
  origins(): string[];
  afterSignIn(): void;
  throttle: PublicAccessOptions['throttle'];
  secret: Buffer;
}

declare module 'fastify' {
  interface FastifyInstance {
    publicAccess?: PublicAccessApi;
    /** The open console sockets (routes.ts registers it with the console proxy). */
    consoleSockets?: ConsoleSocketsApi;
  }
  interface FastifyRequest {
    /** Set by the gate for public requests: the rule that classified this route. */
    publicRule?: PublicRule;
  }
}

const sha = (s: string): string => createHash('sha256').update(s).digest('base64url');

/** A short description of the browser, for the notice: "Chrome on Android". Never the whole string. */
export function deviceLabel(ua: string | undefined): string {
  const s = String(ua ?? '');
  if (!s) return 'an unknown browser';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari' : /curl\//i.test(s) ? 'curl' : 'a browser';
  const os = /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'macOS' : /Windows/.test(s) ? 'Windows'
    : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** The content security policy for the app's own pages at the public address: as strict as one inline-scripted page allows. */
export function publicCsp(mode: string): string {
  const google = mode === 'identity';
  return [
    `default-src 'self'`,
    // The app is one page with its script and handlers inline; that is what 'unsafe-inline' is for. No other script source.
    `script-src 'self' 'unsafe-inline'${google ? ' https://accounts.google.com' : ''}`,
    `style-src 'self' 'unsafe-inline'${google ? ' https://accounts.google.com' : ''}`,
    `img-src 'self' data: blob: https:`,
    `media-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self'${google ? ' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://accounts.google.com' : ''}`,
    `frame-src 'self'${google ? ' https://accounts.google.com' : ''}`,
    `worker-src 'self'`,
    `manifest-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'self'`,
  ].join('; ');
}

const CONSOLE_PATH = /^\/v1\/agents\/[^/]+\/ui(\/|$|\?)/;
/** The largest body read from someone who has not finished signing in (a passkey answer is a few kilobytes). */
const PRE_SIGNIN_BODY_MAX = 256 * 1024;
/**
 * …and how long that body may take to arrive. The listener allows a request
 * ten minutes (a signed-in upload); a stranger sending a sign-in form one
 * byte at a time held a connection for all of it (second review, 2026-10-01).
 */
const PRE_SIGNIN_READ_MS = 15_000;
/**
 * Connections the public listener holds at once; more are refused at accept.
 * tailscaled opens one per request in flight, so this is "requests at once
 * from the whole internet": far above a household's use, far below what would
 * cost this process (and so the private address) its memory or its file
 * descriptors.
 */
const PUBLIC_MAX_CONNECTIONS = 512;
/** How long a signed-out pass is remembered: longer than any session cookie lasts (30 days, or HATCHABOT_SESSION_DAYS). */
const revokedPassMs = (): number => (Math.max(30, Number(process.env.HATCHABOT_SESSION_DAYS) || 0) + 1) * 86_400_000;
/**
 * Adding your FIRST second factor at the public address. The password is all
 * a person without a factor has shown, and it is exactly what a thief would
 * have: if it were enough, whoever held a member's password would enrol their
 * own phone, and "everyone has a second factor" would mean nothing for an
 * account that had not got round to it (second review, 2026-10-01). So the
 * sign-in must also have come, within this time, from something sent to the
 * person out of band: an invitation or reset link, the Telegram recovery
 * link, a recovery code, or (Google sign-in) a Google sign-in just made. At
 * the private address nothing changes.
 */
const FIRST_FACTOR_PROOF = /^\/v1\/(local-accounts\/(claim|recover-with-code)|session)$/;
const FIRST_FACTOR_WINDOW_MS = 30 * 60_000;
const FIRST_FACTOR_NEEDS_LINK = 'Your password alone cannot add your first second factor at this address. Add it at the private address, or ask whoever runs this Hatchabot for a reset link and add it right after using the link.';
/** Someone who must have a second factor here and has none, by how they arrived. */
const MUST_ENROL_NOW = 'This Hatchabot asks for a second factor at the public address. Add one now under Settings → You → Second factor: you have half an hour from the link you used.';
const MUST_ENROL_NEEDS_LINK = 'This Hatchabot asks for a second factor at the public address, and your account has none yet. Ask whoever runs this Hatchabot for a reset link and add one right after using it, or add one at the private address (Settings → You → Second factor).';
const GUEST_CHAT_ONLY = 'Without a second factor you can chat here and nothing else. Add one at the private address, or ask whoever runs this Hatchabot for a reset link and add one right after using it.';
/** New-device notices: one per recipient and account in this long, and at most this many a day per recipient and overall. */
const NOTICE_EVERY_MS = 10 * 60_000;
const NOTICE_DAILY_PER_PERSON = 20;
const NOTICE_DAILY_ALL = 100;
const NOT_SERVING = 'Public access to this Hatchabot is paused. Open it at its private address.';
const NOT_HERE = 'This is not available at the public address. Open Hatchabot at its private address for it.';

export function registerPublicAccess(app: FastifyInstance, opts: PublicAccessOptions): PublicAccessApi {
  const { store, secret } = opts;
  const sign = (body: string): string => createHmac('sha256', secret).update(`public-pass:${body}`).digest('base64url');

  let probes: PublicProbes = {
    autoUpgrade: async () => ({ ok: false, why: 'Automatic upgrades have not been checked yet.' }),
    funnelOnPrivatePort: async () => undefined,
    telegram: async () => false,
    appUrl: () => undefined,
  };
  let checks: SafeguardCheck[] = [];
  let checkedAt: string | undefined;
  let serving = false;
  /** What the log last said about serving; undefined until the first judgement with public access on. */
  let announcedServing: boolean | undefined;
  let warnedForAll = false;
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;

  const mainPort = (): number => Number(process.env.PORT ?? 8080) || 8080;

  const rpId = (): string | undefined => hostOf(publicConfig().url) ?? hostOf(probes.appUrl()) ?? hostOf(process.env.HATCHABOT_PUBLIC_URL);
  const origins = (): string[] => {
    const host = rpId();
    if (!host) return [];
    // Only addresses this Hatchabot is configured to be opened at: the private
    // https one, the public one, and the public one's port before it is on.
    const fp = publicConfig().funnelPort;
    const out = new Set<string>([`https://${host}${fp === 443 ? '' : `:${fp}`}`]);
    for (const u of [publicConfig().url, probes.appUrl(), process.env.HATCHABOT_PUBLIC_URL]) {
      try { if (u && new URL(u).hostname.toLowerCase() === host && new URL(u).protocol === 'https:') out.add(new URL(u).origin); } catch { /* not an address */ }
    }
    return [...out];
  };

  const admins = () => (store ? adminAccounts(store.rawDb(), opts.mode) : []);
  const hasOwnerRights = (ownerId: string): boolean => admins().some((a) => a.id === ownerId);
  const secondFactorNeed = (ownerId: string): SecondFactorNeed => {
    if (!store) return 'missing';
    const host = rpId();
    const mine = store.listSecondFactors(ownerId).filter((f) => f.kind === 'totp' || (f.kind === 'passkey' && (!host || (f.rpId ?? '').toLowerCase() === host)));
    if (mine.length) return 'yes';
    if (hasOwnerRights(ownerId)) return 'missing';
    // Signed in with Google and no owner rights: Google is their factor.
    if (!store.localAccount(ownerId)) return 'no';
    // Everyone with a password needs one. The owner may exempt chat-only guests, and nobody else.
    if (publicConfig().guestsWithoutSecondFactor && store.isChatOnlyGuest(ownerId)) return 'guest';
    return 'missing';
  };

  const evaluate = async (): Promise<SafeguardCheck[]> => {
    const [autoUpgrade, funnelOnPrivatePort] = await Promise.all([
      probes.autoUpgrade().catch((err: unknown) => ({ ok: false, why: `Automatic upgrades could not be checked (${String((err as Error)?.message ?? err).slice(0, 80)}).` })),
      probes.funnelOnPrivatePort(mainPort()).catch(() => undefined),
    ]);
    // Read AFTER the probes answered: a judgement that began while public
    // access was on must not say "serving" once it has been turned off.
    const cfg = publicConfig();
    const next = evaluateSafeguards({
      authMode: opts.mode,
      managed: !!process.env.HATCHABOT_MANAGED_BY?.trim(),
      admins: admins(),
      invitedOnly: cfg.invitedOnly,
      ownerHeader: process.env.HATCHABOT_ALLOW_OWNER_HEADER === '1',
      ports: { main: mainPort(), public: cfg.port, ops: Number(process.env.HATCHABOT_OPS_PORT ?? 8091), embed: Number(process.env.HATCHABOT_EMBED_PORT ?? 8093) },
      autoUpgrade,
      funnelOnPrivatePort,
      publicOn: cfg.on,
      loginFailLimit: Number(process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW ?? 10),
      publicHost: hostOf(cfg.url) ?? rpId(),
      guestsExempt: cfg.guestsWithoutSecondFactor,
    });
    const failing = failingSafeguards(next);
    checks = next;
    checkedAt = new Date().toISOString();
    serving = cfg.on && !cfg.unknownProvider && !!store && opts.mode !== 'password' && failing.length === 0;
    // Said once: someone who set the old opt-in to "off" expects it to do something. It does not.
    if (cfg.on && cfg.forAllIgnored !== undefined && !warnedForAll) {
      warnedForAll = true;
      app.log.warn({ value: cfg.forAllIgnored }, 'HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL is ignored: a second factor is required of every password account at the public address');
    }
    if (!cfg.on) announcedServing = undefined;
    else if (announcedServing !== serving) {
      announcedServing = serving;
      if (serving) app.log.warn({ url: cfg.url }, 'public.serving');
      else {
        dropUpgraded(); // open console sockets do not outlive the safeguard
        // Fail closed, and say why: in the log and on the record.
        const why = cfg.unknownProvider ? [`unknown provider "${cfg.unknownProvider}"`] : failing.map((c) => `${c.letter}. ${c.title}: ${c.detail}`);
        app.log.error({ failing: why }, 'public.refusing: public access is on but a safeguard is off; the public listener answers 503 until it is fixed');
        try { store?.recordSecurity('public.paused', undefined, { failing: failing.map((c) => c.id) }); } catch { /* the record must not break the gate */ }
      }
    }
    return next;
  };

  const status = (): PublicStatus => {
    const cfg = publicConfig();
    return { on: cfg.on, serving, listening: !!server?.listening, url: cfg.url, port: cfg.port, funnelPort: cfg.funnelPort, checks, failing: failingSafeguards(checks), checkedAt };
  };

  // ---- the pass ------------------------------------------------------------

  const encodePass = (p: Pass): string => {
    const body = `1.${p.sess}.${p.minted}.${p.seen}.${p.sfAt}.${p.used ? 1 : 0}.${p.en}`;
    return `${body}.${sign(body)}`;
  };
  const decodePass = (raw: string | undefined): Pass | undefined => {
    if (!raw) return undefined;
    const i = raw.lastIndexOf('.');
    if (i < 0) return undefined;
    const body = raw.slice(0, i), sig = raw.slice(i + 1), want = sign(body);
    if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return undefined;
    const [v, sess, minted, seen, sfAt, used, en] = body.split('.');
    if (v !== '1' || !sess) return undefined;
    const n = [minted, seen, sfAt, en].map(Number);
    if (n.some((x) => !Number.isFinite(x) || x < 0)) return undefined;
    return { sess, minted: n[0]!, seen: n[1]!, sfAt: n[2]!, used: used === '1', en: n[3]! };
  };
  const cookieHeaderOf = (req: { headers: Record<string, string | string[] | undefined> }): string | undefined => {
    const h = req.headers.cookie;
    return Array.isArray(h) ? h.join('; ') : h;
  };
  /**
   * Passes that were signed out. The pass is a signed cookie, so a copy of it
   * (taken from a shared computer before "Sign out" was pressed) would
   * otherwise keep working, step-up included, for as long as it was kept
   * refreshed. Signing out at the public address ends that sign-in for every
   * copy: its name (session hash + when it was made, the same for every
   * refreshed copy) is remembered here and in the database.
   */
  const revoked = new Set<string>();
  const passName = (p: Pass): string => `${p.sess}.${p.minted}`;
  try { for (const id of store?.revokedPublicPasses(Date.now()) ?? []) revoked.add(id); } catch { /* a database from before the table: none yet */ }
  /** The pass this request carries, genuine, for the session it carries and not signed out. Says nothing about idleness. */
  const boundPass = (req: { headers: Record<string, string | string[] | undefined> }, session: string | undefined): Pass | undefined => {
    const pass = decodePass(cookieFromHeader(cookieHeaderOf(req), PASS_COOKIE));
    if (!pass || !session) return undefined;
    const want = sha(session);
    if (pass.sess.length !== want.length || !timingSafeEqual(Buffer.from(pass.sess), Buffer.from(want))) return undefined;
    if (revoked.has(passName(pass))) return undefined;
    return pass;
  };
  /** The valid pass this request carries for the session it carries, or why there is none. */
  const passOf = (req: { headers: Record<string, string | string[] | undefined> }, session: string | undefined): Pass | undefined => {
    const pass = boundPass(req, session);
    if (!pass) return undefined;
    const now = Date.now();
    if (pass.seen > now + 60_000 || now - pass.seen > publicConfig().idleMs) return undefined;
    return pass;
  };
  const setPass = (reply: FastifyReply, p: Pass): void => {
    reply.setCookie(PASS_COOKIE, encodePass(p), { ...cookieOpts, maxAge: Math.floor(publicConfig().idleMs / 1000) });
  };

  const sessionMinted = (req: FastifyRequest, reply: FastifyReply, value: string): void => {
    if (!isPublic(req)) return;
    const now = Date.now();
    // Changing your own password hands out a new session: the second factor
    // already given on the old one carries over. Nowhere else: a sign-in as
    // someone else must never inherit it.
    let sfAt = 0;
    // A sign-in made with something sent out of band may add the person's first factor for a while.
    let en = FIRST_FACTOR_PROOF.test(req.routeOptions?.url ?? '') ? now + FIRST_FACTOR_WINDOW_MS : 0;
    if (req.principal && req.routeOptions?.url === '/v1/local-accounts/:id/password') {
      const old = passOf(req, sessionValue(req));
      sfAt = old?.sfAt ?? 0;
      en = old?.en ?? 0;
    }
    setPass(reply, { sess: sha(value), minted: now, seen: now, sfAt, used: sfAt > 0, en });
    if (!cookieFromHeader(cookieHeaderOf(req), DEVICE_COOKIE)) {
      reply.setCookie(DEVICE_COOKIE, randomBytes(16).toString('base64url'), { ...cookieOpts, maxAge: 400 * 86_400 });
    }
  };
  const sessionCleared = (req: FastifyRequest, reply: FastifyReply): void => {
    if (!isPublic(req)) return;
    // Signed out here: this sign-in is over for every copy of its cookies, not only this browser's.
    const pass = boundPass(req, sessionValue(req));
    if (pass) {
      revoked.add(passName(pass));
      try { store?.revokePublicPass(passName(pass), Date.now() + revokedPassMs()); } catch (err) { app.log.error({ err: String(err) }, 'public.pass_revoke_failed'); }
      app.consoleSockets?.revalidate();
    }
    reply.clearCookie(PASS_COOKIE, cookieOpts);
  };

  const secondFactorGiven = (req: FastifyRequest): boolean => {
    if (!isPublic(req)) return true;
    const pass = passOf(req, sessionValue(req));
    return !!pass && pass.sfAt > 0;
  };

  const secondFactorPassed = (req: FastifyRequest, reply: FastifyReply): void => {
    if (!isPublic(req)) return;
    const pass = passOf(req, sessionValue(req));
    if (!pass) return;
    setPass(reply, { ...pass, seen: Date.now(), sfAt: Date.now() });
  };

  // ---- the record and the notices -------------------------------------------

  const record = (kind: string, ownerId: string | undefined, detail: Record<string, unknown>): void => {
    try { store?.recordSecurity(kind, ownerId, detail); } catch (err) { app.log.error({ err: String(err), kind }, 'public.record_failed'); }
    app.log.warn({ ownerId, ...detail }, kind);
  };

  const failureBurst = (req: FastifyRequest, key: string, until: number): void => {
    const account = /pub:user:(.+)$/.exec(key)?.[1];
    record('public.failure_burst', undefined, {
      bucket: key.endsWith('pub:all') ? 'all public sign-ins' : account ? `account ${account}` : `address ${approximateSource(publicClientAddress(req))}`,
      lockedUntil: new Date(until).toISOString(),
      path: routedPath(req.url),
    });
  };

  const nameOf = (ownerId: string): string =>
    store?.localAccount(ownerId)?.username ?? store?.emailForOwner(ownerId) ?? ownerId;

  /**
   * New-device notices are limited. A sign-in needs only the password to be
   * "a sign-in from a new device" (the second factor comes after), so whoever
   * holds one valid password could otherwise send the person and the owner a
   * Telegram message per request. Per recipient and account: one notice in
   * NOTICE_EVERY_MS, the next one saying how many were left out. Per
   * recipient, and for everyone together: a ceiling a day. The record
   * (`public.signin`) is never limited: every sign-in is there.
   */
  const noticePairs = new Map<string, { last: number; suppressed: number }>();
  const noticeDay = { day: 0, all: 0, per: new Map<string, number>() };
  const noticeAllowed = (to: string, about: string): { send: boolean; suppressed: number } => {
    const now = Date.now();
    const day = Math.floor(now / 86_400_000);
    if (day !== noticeDay.day) { noticeDay.day = day; noticeDay.all = 0; noticeDay.per.clear(); }
    const key = `${to}\n${about}`;
    const pair = noticePairs.get(key) ?? { last: 0, suppressed: 0 };
    noticePairs.set(key, pair);
    const soon = pair.last > 0 && now - pair.last < NOTICE_EVERY_MS && now >= pair.last;
    const mine = noticeDay.per.get(to) ?? 0;
    if (soon || mine >= NOTICE_DAILY_PER_PERSON || noticeDay.all >= NOTICE_DAILY_ALL) { pair.suppressed += 1; return { send: false, suppressed: pair.suppressed }; }
    const suppressed = pair.suppressed;
    pair.last = now; pair.suppressed = 0;
    noticeDay.per.set(to, mine + 1); noticeDay.all += 1;
    return { send: true, suppressed };
  };

  /** The first authenticated request of a public sign-in: the record, and the new-device notice. */
  const announced = new Map<string, number>();
  const firstUse = (req: { headers: Record<string, string | string[] | undefined> }, ownerId: string, pass: Pass): void => {
    const key = `${pass.sess}.${pass.minted}`;
    if (announced.has(key)) return;
    announced.set(key, Date.now());
    if (announced.size > 5000) for (const [k, t] of announced) if (Date.now() - t > 3_600_000) announced.delete(k);
    const from = publicClientAddress(req);
    const label = deviceLabel(typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined);
    const device = cookieFromHeader(cookieHeaderOf(req), DEVICE_COOKIE);
    const source = approximateSource(from);
    let isNew = true;
    try { if (device && store) isNew = store.noteDevice(ownerId, sha(device), label, source); } catch { /* treated as new */ }
    record('public.signin', ownerId, { from, device: label, newDevice: isNew });
    if (!isNew || !store) return;
    const who = nameOf(ownerId);
    const at = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const base = probes.appUrl();
    const mine = `New sign-in to Hatchabot as ${who}: ${label}, from about ${source}, ${at}, through the public address. If this was not you: change your password and choose "Sign out on every device"${base ? ` at ${base}` : ''}.`;
    const theirs = `New sign-in to Hatchabot as ${who}: ${label}, from about ${source}, ${at}, through the public address. If they do not recognise it: Settings → Reach it from anywhere → sign ${who} out everywhere${base ? ` (${base})` : ''}.`;
    const tell = (to: string, said: string): void => {
      const limit = noticeAllowed(to, ownerId);
      if (!limit.send) { app.log.warn({ to, about: ownerId, suppressed: limit.suppressed }, 'public.notice_suppressed'); return; }
      const text = limit.suppressed ? `${said} (${limit.suppressed} more new-device sign-in${limit.suppressed === 1 ? '' : 's'} as ${who} since the last notice ${limit.suppressed === 1 ? 'was' : 'were'} not announced; the record lists every one.)` : said;
      try { store.addSecurityNotice({ id: `sn-${randomBytes(9).toString('base64url')}`, ownerId: to, kind: 'new-device', aboutOwner: ownerId, text }); } catch { /* best effort */ }
      void probes.telegram(to, `🔐 ${text}`).catch(() => false);
    };
    tell(ownerId, mine);
    for (const a of admins()) if (a.id !== ownerId) tell(a.id, theirs);
  };

  // ---- ceilings --------------------------------------------------------------

  let minute = 0;
  let total = 0;
  const perAddress = new Map<string, number>();
  const overCeiling = (visitor: string): boolean => {
    // An IPv6 visitor is its /64, as for the sign-in limits: counted by the
    // single address, one visitor had 2^64 counts of their own (second review).
    const addr = addressBucket(visitor);
    const cfg = publicConfig();
    const m = Math.floor(Date.now() / 60_000);
    if (m !== minute) { minute = m; total = 0; perAddress.clear(); }
    total += 1;
    const n = (perAddress.get(addr) ?? 0) + 1;
    if (perAddress.size < 20_000 || perAddress.has(addr)) perAddress.set(addr, n);
    return total > cfg.requestsPerMinute || n > cfg.requestsPerMinutePerAddress;
  };

  // ---- the gate: first half (before the sign-in hook) -------------------------

  app.addHook('onRequest', async (req, reply) => {
    if (!isPublic(req)) return;
    if (!serving) return reply.code(503).header('retry-after', '300').send({ error: NOT_SERVING });
    if (overCeiling(publicClientAddress(req))) return reply.code(429).header('retry-after', '60').send({ error: 'Too many requests. Try again in a minute.' });
    // The name the visitor asked for must be the public one (tailscaled passes it on as X-Forwarded-Host).
    const asked = req.headers['x-forwarded-host'];
    const askedHost = (Array.isArray(asked) ? asked[0] : asked)?.split(',')[0]?.trim().toLowerCase().replace(/:\d+$/, '');
    const mine = hostOf(publicConfig().url);
    if (askedHost && mine && askedHost !== mine) return reply.code(421).send({ error: 'This address is not this Hatchabot\'s public address.' });
    const rule = publicRuleFor(req.method, req.routeOptions?.url);
    if (!rule || rule.cls === 'never') {
      app.log.warn({ method: req.method, route: req.routeOptions?.url ?? null }, 'public.route_refused');
      return reply.code(403).send({ error: NOT_HERE });
    }
    req.publicRule = rule;
    // Bodies. A request with no declared length is refused; before sign-in
    // (open and second-step routes) nothing over a few hundred kilobytes is
    // read at all. The app accepts uploads of hundreds of megabytes on any
    // route, and a stranger could otherwise make it hold that much per
    // request (review, 2026-10-01). Signed-in routes are answered 401 by the
    // sign-in hook before a byte of body is read.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const te = req.headers['transfer-encoding'];
      const len = Number(req.headers['content-length'] ?? 0);
      if (te !== undefined || !Number.isFinite(len) || len < 0) return reply.code(411).header('connection', 'close').send({ error: 'Send a Content-Length.' });
      if ((rule.cls === 'open' || rule.cls === 'second-step') && len > PRE_SIGNIN_BODY_MAX) {
        return reply.code(413).header('connection', 'close').send({ error: 'That request is too large.' });
      }
      // …and a small body arrives promptly or the connection is closed.
      if ((rule.cls === 'open' || rule.cls === 'second-step') && len > 0) {
        const raw = req.raw;
        const slow = setTimeout(() => { if (!raw.complete) raw.destroy(); }, PRE_SIGNIN_READ_MS);
        slow.unref();
        const done = (): void => clearTimeout(slow);
        raw.once('end', done); raw.once('close', done); reply.raw.once('close', done); reply.raw.once('finish', done);
      }
    }
  });

  // ---- the gate: second half (after the sign-in hook) --------------------------

  const afterSignIn = (): void => {
    app.addHook('onRequest', async (req, reply) => {
      if (!isPublic(req)) return;
      const rule = req.publicRule;
      if (!rule) return reply.code(403).send({ error: NOT_HERE }); // unreachable: the first half refuses
      if (rule.cls === 'open') return;
      const principal = req.principal;
      // Signed in by a session cookie and nothing else: no header, no in-process call, no token.
      if (!principal || principal.via === 'header') return reply.code(401).send({ error: 'auth required' });
      const pass = passOf(req, sessionValue(req));
      if (!pass) {
        // A session from the private address, or a public one left idle too long.
        reply.clearCookie(PASS_COOKIE, cookieOpts);
        return reply.code(401).send({ error: 'auth required', publicSignIn: true });
      }
      if (!pass.used) firstUse(req, principal.ownerId, pass);
      const now = Date.now();
      if (!pass.used || now - pass.seen > 60_000) setPass(reply, { ...pass, seen: now, used: true });

      const need = secondFactorNeed(principal.ownerId);
      if (rule.cls === 'second-step') return;
      if (need === 'missing' || need === 'guest') {
        // Someone with owner rights enrols at the private address, always.
        if (need === 'missing' && hasOwnerRights(principal.ownerId)) {
          return reply.code(403).send({ error: 'Your account has owner rights and no second factor. Add one at the private address (Settings → You → Second factor); until then it cannot be used here.', secondFactor: 'missing' });
        }
        // A chat-only guest the owner chose to let in with a password alone: the chat, and nothing else.
        if (need === 'guest' && guestMay(req.method, req.routeOptions?.url)) return;
        // Adding the first factor (and changing one's own password): let
        // through to the route, which asks for the current password; adding
        // one also needs a sign-in that came by a link or code sent out of band.
        if (rule.cls === 'step-up' && rule.firstFactorOk) {
          if (rule.enrols && !(pass.en > now)) return reply.code(403).send({ error: FIRST_FACTOR_NEEDS_LINK, secondFactor: 'enrol-link' });
          return;
        }
        if (need === 'guest') return reply.code(403).send({ error: GUEST_CHAT_ONLY, secondFactor: 'guest' });
        // Sent to enrolment only when they arrived by a fresh invitation, reset link or recovery; otherwise told where to get one.
        if (pass.en > now) return reply.code(403).send({ error: MUST_ENROL_NOW, secondFactor: 'enrol' });
        return reply.code(403).send({ error: MUST_ENROL_NEEDS_LINK, secondFactor: 'enrol-link' });
      }
      if (need === 'yes' && pass.sfAt === 0) {
        return reply.code(401).send({ error: 'second factor required', secondFactor: 'required' });
      }
      if (rule.cls === 'step-up') {
        if (need === 'no') {
          if (rule.firstFactorOk && rule.enrols && !(pass.en > now)) return reply.code(403).send({ error: FIRST_FACTOR_NEEDS_LINK, secondFactor: 'enrol-link' });
          if (rule.firstFactorOk) return;
          return reply.code(403).send({ error: 'This needs a second factor at the public address. Add one under Settings → You → Second factor, or use the private address.', secondFactor: 'missing' });
        }
        if (now - pass.sfAt > publicConfig().stepUpMs) {
          return reply.code(401).send({ error: 'second factor required', secondFactor: 'step-up' });
        }
      }
    });
  };

  const refuseSession = (rawReq: IncomingMessage, ownerId: string, o: { acceptingWebChat?: boolean } = {}): string | undefined => {
    if (!isPublic(rawReq)) return undefined;
    if (!serving) return 'public access is not serving';
    const headers = rawReq.headers as Record<string, string | string[] | undefined>;
    const pass = passOf({ headers }, sessionValue({ headers, socket: rawReq.socket }));
    if (!pass) return 'no public pass';
    // A sign-in used only for a socket is still a sign-in: recorded and announced like any other.
    if (!pass.used) firstUse({ headers }, ownerId, pass);
    const need = secondFactorNeed(ownerId);
    if (need === 'missing') {
      // Accepting a web-chat invitation makes a chat-only guest of someone who owns nothing: allowed when guests are.
      const becomesGuest = !!o.acceptingWebChat && publicConfig().guestsWithoutSecondFactor && !!store?.localAccount(ownerId) && !hasOwnerRights(ownerId) && !!store?.ownsNothing(ownerId);
      if (!becomesGuest) return 'no second factor';
    }
    if (need === 'yes' && pass.sfAt === 0) return 'second factor not given';
    return undefined;
  };

  const stepUpRefusal = (req: FastifyRequest): { code: number; body: Record<string, unknown> } | undefined => {
    if (!isPublic(req)) return undefined;
    const principal = req.principal;
    const pass = principal && principal.via !== 'header' ? passOf(req, sessionValue(req)) : undefined;
    if (!principal || !pass) return { code: 401, body: { error: 'auth required', publicSignIn: true } };
    if (secondFactorNeed(principal.ownerId) !== 'yes') { // (a guest let in without one included)
      return { code: 403, body: { error: 'This needs a second factor at the public address. Add one under Settings → You → Second factor, or use the private address.', secondFactor: 'missing' } };
    }
    if (pass.sfAt === 0 || Date.now() - pass.sfAt > publicConfig().stepUpMs) return { code: 401, body: { error: 'second factor required', secondFactor: 'step-up' } };
    return undefined;
  };

  const refuseOpenSocket = (cookie: string | undefined, ownerId: string, lastActive: number): string | undefined => {
    if (!serving) return 'public access is not serving';
    const headers = { cookie };
    // The public listener is HTTPS by definition (sessionCookie.ts requestIsHttps).
    const pass = boundPass({ headers }, readSessionCookie(cookie, true)?.value);
    if (!pass) return 'signed out';
    if (Date.now() - lastActive > publicConfig().idleMs) return 'idle';
    const need = secondFactorNeed(ownerId);
    if (need === 'missing') return 'no second factor';
    if (need === 'yes' && pass.sfAt === 0) return 'second factor not given';
    return undefined;
  };

  // ---- headers on everything the public address answers -----------------------

  app.addHook('onSend', async (req, reply, payload) => {
    if (!isPublic(req)) return payload;
    // A week, not a year: it binds the whole host name (the private HTTPS
    // address too, which is HTTPS anyway), and must fade soon after public
    // access is turned off.
    reply.header('strict-transport-security', 'max-age=604800');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('x-robots-tag', 'noindex, nofollow');
    const path = routedPath(req.url) ?? '';
    // The OpenClaw console is another program's page with its own needs and its own framing rule.
    if (!CONSOLE_PATH.test(path)) {
      if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', publicCsp(opts.mode));
      reply.header('x-frame-options', 'SAMEORIGIN');
      if (path.startsWith('/v1/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  // ---- the listener ------------------------------------------------------------

  /**
   * Every socket the public listener has open, upgraded ones (a console's
   * WebSocket) included: Node's closeAllConnections does not close those, and
   * close() waits for them, so "off" would otherwise hang on one open chat
   * and leave it working (review, 2026-10-01).
   */
  const sockets = new Set<import('node:net').Socket>();
  const upgraded = new Set<import('node:net').Socket>();
  function dropUpgraded(): void {
    for (const s of upgraded) s.destroy();
    upgraded.clear();
  }
  const stopListener = async (): Promise<void> => {
    announcedServing = undefined;
    if (timer) { clearInterval(timer); timer = undefined; }
    const s = server;
    server = undefined;
    serving = false;
    dropUpgraded();
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      for (const sock of sockets) sock.destroy();
      sockets.clear();
    });
  };

  const syncListener = async (): Promise<{ listening: boolean; error?: string }> => {
    const cfg = publicConfig();
    if (!cfg.on) { await stopListener(); return { listening: false }; }
    await evaluate();
    if (!timer) {
      timer = setInterval(() => { void evaluate().catch((err: unknown) => { serving = false; app.log.error({ err: String(err) }, 'public.evaluate_failed'); }); }, 60_000);
      timer.unref();
    }
    if (server?.listening) return { listening: true };
    const s = createServer((req, res) => {
      // An address the router cannot decode is answered by Fastify itself,
      // before any hook: here it would skip the gate. Refuse it first.
      try { decodeURI((req.url ?? '').split('?')[0] ?? ''); }
      catch { res.writeHead(400, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', connection: 'close' }).end('{"error":"Bad request"}'); return; }
      app.routing(req, res);
    });
    s.on('connection', (socket) => {
      markPublicSocket(socket);
      sockets.add(socket);
      socket.once('close', () => { sockets.delete(socket); upgraded.delete(socket as never); });
    });
    // The console's WebSocket: handed to the app's own upgrade handler, which
    // sees a public socket and asks refuseUpgrade. Anything else is dropped.
    s.on('upgrade', (req, socket, head) => {
      if (!serving || !CONSOLE_PATH.test(req.url ?? '') || app.server.listenerCount('upgrade') === 0) { socket.destroy(); return; }
      // Sockets count against the request ceilings like anything else.
      if (overCeiling(publicClientAddress(req as never))) { socket.destroy(); return; }
      upgraded.add(socket as never);
      app.server.emit('upgrade', req, socket, head);
    });
    s.headersTimeout = 20_000;
    s.requestTimeout = 10 * 60_000;
    s.maxHeadersCount = 100;
    s.maxConnections = PUBLIC_MAX_CONNECTIONS;
    try {
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        // Loopback only: tailscaled is on this machine. Nothing on the LAN or the tailnet can reach this port.
        s.listen(cfg.port, '127.0.0.1', () => { s.off('error', reject); resolve(); });
      });
    } catch (err) {
      serving = false;
      const error = `The public listener could not open 127.0.0.1:${cfg.port}: ${String((err as Error)?.message ?? err)}`;
      app.log.error({ port: cfg.port }, error);
      return { listening: false, error };
    }
    server = s;
    app.log.warn({ port: cfg.port, serving }, 'public.listener_open');
    return { listening: true };
  };
  app.addHook('onClose', async () => { await stopListener(); });

  const api: PublicAccessApi = {
    config: publicConfig, status, evaluate,
    setProbes: (p) => { probes = { ...probes, ...p }; },
    syncListener, stopListener, sessionMinted, sessionCleared, failureBurst, secondFactorPassed, secondFactorNeed, secondFactorGiven, hasOwnerRights,
    refuseSession, refuseOpenSocket, stepUpRefusal, rpId, origins, afterSignIn, throttle: opts.throttle, secret,
  };
  app.decorate('publicAccess', api);
  return api;
}

/** Re-exported for the settings page and the doctor: a factor that works at the public host. */
export { usableFactors };
