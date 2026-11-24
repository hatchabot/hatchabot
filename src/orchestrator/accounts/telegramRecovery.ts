import { randomBytes } from 'node:crypto';
import type { ChannelConnector } from '../../channels/connector.js';
import type { Agent } from '../../domain/types.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';

/**
 * "Forgot password?" — without a terminal, and without an email server
 * (HB-0808 step 15 part B; POST /v1/local-accounts/recover).
 *
 * Every account that has used Telegram with Hatchabot has a Telegram id
 * that is provably theirs: the owner linked it with "That's me", a member
 * was admitted by it. A reset link goes to that id, through a bot it has
 * already talked to (a bot cannot message someone first), and to nowhere
 * else. Being able to type a username is not enough to reset anything: you
 * also have to be holding that person's Telegram.
 *
 * The answer is identical whatever happens — an unknown username, an
 * account with no Telegram, a link sent — so this is not a way to learn who
 * has an account. The link is one use and short-lived, the old password
 * keeps working until it is used, and a username can ask at most once every
 * few minutes.
 *
 * At the PUBLIC address the asker is anyone on the internet who knows (or
 * guesses) a username, so there it is held much tighter: a username can ask
 * once an hour and three times a day, an address five times an hour, all
 * visitors together thirty; a link that is still good is never replaced
 * (a stranger asking again must not kill the link the person just got);
 * and an account with owner rights is not reset from there at all (it is
 * told so on Telegram, with no link). The public counts are apart from the
 * private ones, so none of this can keep anyone from recovering at the
 * private address. The answer stays identical in every case.
 *
 * `ask` never says what it did: the route answers the same, in about the
 * same time, whatever happened here.
 */
export interface TelegramRecovery {
  /** Send a reset link (or, for an owner asked from the internet, a note with none), if anything may be sent. */
  ask(username: string, asker: RecoveryAsker): Promise<void>;
  /** Forget every count (for tests: `_resetRecoveryLimits`). */
  resetLimits(): void;
}

/** Who is asking: from the public address or not, and (read only when counted) their address's bucket. */
export interface RecoveryAsker {
  fromPublic: boolean;
  address: () => string;
}

export interface TelegramRecoveryDeps {
  store: Pick<Store, 'localAccountByUsername' | 'knownChannelUserId' | 'identityOfUserAnywhere' | 'listLocalAccounts' | 'listAllActiveAgents' | 'listAllowedChannelUserIds' | 'getChannelForAgent' | 'setLocalAccountClaim'>;
  secrets: Pick<SecretStore, 'get'>;
  /** The public gate's owner rights (an admin as well as the host owner); false with no gate. */
  hasOwnerRights: (accountId: string) => boolean;
  /** The app's addresses (reach/appAddress.ts): the private one, and the one links are made for. */
  appUrlFor: () => string | undefined;
  linkUrlFor: () => string | undefined;
  /** The channel connectors (the channels service's): a Discord bot's DM. */
  connectorFor: (kind: string) => ChannelConnector | undefined;
  /** How a message reaches Telegram (the tests' stand-in, or fetch; read at each send). */
  telegramFetch: () => typeof fetch;
  warn: (detail: Record<string, unknown>, msg: string) => void;
  /** How long one ask's sends may take, all of them together (SEND_WITHIN_MS; tests shorten it). */
  sendWithinMs?: number;
}

/** How a send ended: taken; or not, and either surely not delivered or perhaps delivered (`maybe`), with why. */
type Sent = { taken: true } | { taken: false; maybe: boolean; error: string };

/** A fetch that failed with one of these never reached Telegram: nothing was sent. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL']);

/**
 * Every send of one ask, together, within this: the one send there was had
 * it. Each bot had it of its own, so three that hung took three times as
 * long, and how long the answer takes already says whether the name is an
 * account (HB-0950 review).
 */
const SEND_WITHIN_MS = 8000;

export function createTelegramRecovery(deps: TelegramRecoveryDeps): TelegramRecovery {
  const { store, secrets, appUrlFor, linkUrlFor, connectorFor } = deps;
  const recoverySentAt = new Map<string, number>();
  const RECOVERY_EVERY_MS = 5 * 60_000;
  const RECOVERY_TTL_MS = 15 * 60_000;
  const PUBLIC_RECOVERY_EVERY_MS = 60 * 60_000;
  const PUBLIC_RECOVERY_PER_DAY = 3;
  const PUBLIC_RECOVERY_PER_ADDRESS = 5;
  const PUBLIC_RECOVERY_ALL = 30;
  const publicRecovery = { perName: new Map<string, number[]>(), perAddress: new Map<string, number[]>(), all: [] as number[] };
  /** How many bots one ask tries, one after another while each refuses (HB-0950). */
  const MAX_ROUTES = 3;
  /**
   * One message through a Telegram bot. A rejected fetch was the only
   * failure seen, so an answer of 403 or 500, or `ok: false`, was logged as
   * sent (HB-0950). Refused is only what surely did not arrive: Telegram's
   * own no (its JSON with `ok: false`, at any status, a 429 among them), a
   * 4xx, or a fetch that never reached it. A send that timed out, or lost
   * its connection once the request had gone, may have arrived (`maybe`),
   * and so may any other answer not in Telegram's words: a 502 or 504 from
   * its front can come after the message was sent (HB-0950 round 3).
   */
  const sendTelegram = async (token: string, chatId: string, text: string, deadline: AbortSignal): Promise<Sent> => {
    // A URL that will not parse is quoted whole in the error: never the token.
    const why = (s: unknown) => String(s).split(token).join('…').slice(0, 160);
    let res: Response;
    try {
      res = await deps.telegramFetch()(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // No parse_mode: nothing in this message is markup.
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: deadline,
      });
    } catch (err) {
      // undici's "fetch failed" is both kinds; its cause's code tells them apart.
      const e = err as { message?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
      const code = e?.cause?.code ?? e?.code;
      const neverSent = typeof code === 'string' && NEVER_SENT.has(code);
      return { taken: false, maybe: !neverSent, error: why(`${String(e?.message ?? err)}${typeof code === 'string' ? ` (${code})` : ''}`) };
    }
    const body = (await res.json().catch(() => undefined)) as { ok?: unknown; description?: unknown } | null | undefined;
    if (res.ok && body?.ok === true) return { taken: true };
    if (body?.ok === false || (res.status >= 400 && res.status < 500)) return { taken: false, maybe: false, error: why(body?.description ?? `Telegram answered ${res.status}`) };
    return { taken: false, maybe: true, error: `Telegram answered ${res.status}, not in its own words` };
  };
  /** One more ask in this window, unless that would pass `max`: false = over (and not counted). */
  const underCeiling = (asks: number[], windowMs: number, max: number, now: number): boolean => {
    while (asks.length && now - asks[0]! >= windowMs) asks.shift();
    if (asks.length >= max) return false;
    asks.push(now);
    return true;
  };
  const publicRecoveryAllowed = (asker: RecoveryAsker, key: string): boolean => {
    const now = Date.now();
    const pr = publicRecovery;
    for (const m of [pr.perName, pr.perAddress]) {
      if (m.size > 2000) for (const [k, v] of m) if (!v.length || now - v[v.length - 1]! >= 86_400_000) m.delete(k);
      if (m.size > 4000) m.clear(); // a flood of made-up names: start over rather than grow (the ceilings below still hold)
    }
    const addr = asker.address();
    const byAddr = pr.perAddress.get(addr) ?? [];
    pr.perAddress.set(addr, byAddr);
    // The address first, then everyone together, then the name: an address over its count costs the name nothing.
    if (!underCeiling(byAddr, 3_600_000, PUBLIC_RECOVERY_PER_ADDRESS, now)) return false;
    if (!underCeiling(pr.all, 3_600_000, PUBLIC_RECOVERY_ALL, now)) return false;
    const byName = pr.perName.get(key) ?? [];
    pr.perName.set(key, byName);
    while (byName.length && now - byName[0]! >= 86_400_000) byName.shift();
    if (byName.length && now - byName[byName.length - 1]! < PUBLIC_RECOVERY_EVERY_MS) return false;
    if (byName.length >= PUBLIC_RECOVERY_PER_DAY) return false;
    byName.push(now);
    return true;
  };

  const ask = async (username: string, asker: RecoveryAsker): Promise<void> => {
    if (!username || username.length > 64) return;
    const key = username.toLowerCase();
    const fromPublic = asker.fromPublic;
    if (fromPublic) {
      if (!publicRecoveryAllowed(asker, key)) return;
    } else {
      // Anyone can post any username here, so the map must not grow without
      // bound: forget entries past their window once it gets large.
      if (recoverySentAt.size > 1000) {
        const cutoff = Date.now() - RECOVERY_EVERY_MS;
        for (const [k, t] of recoverySentAt) if (t < cutoff) recoverySentAt.delete(k);
      }
      const last = recoverySentAt.get(key) ?? 0;
      if (Date.now() - last < RECOVERY_EVERY_MS) return;
      recoverySentAt.set(key, Date.now());
    }

    const account = store.localAccountByUsername(username);
    if (!account || account.disabled || account.pwHash === '') return;
    // Asked from the internet: a link that is still good stays as it is.
    if (fromPublic && account.claimCode && account.claimExpires && Date.parse(account.claimExpires) > Date.now()) return;
    // Owner rights are recovered at the private address only (accountsAuth.ts): no link is made from here.
    const ownerFromPublic = fromPublic && (account.hostOwner || deps.hasOwnerRights(account.id));
    const tgId = store.knownChannelUserId(account.id);
    const dcId = store.identityOfUserAnywhere(account.id, 'discord');
    if (!tgId && !dcId) return;

    // Only a bot whose token the account's own side holds: its own agents',
    // or the machine owner's (who can read every stored token here anyway).
    // Another member's pasted bot or Discord app would let THAT member read
    // the link back and take the account (night review, 2026-09-28).
    const hostOwners = new Set(store.listLocalAccounts().filter((x) => x.hostOwner).map((x) => x.id));
    const mayCarry = (a: Agent) => a.ownerId === account.id || hostOwners.has(a.ownerId);
    // A bot that has already talked to this person — the manager first.
    const candidates = tgId ? store.listAllActiveAgents()
      .filter((a) => a.state === 'RUNNING' && mayCarry(a) && store.listAllowedChannelUserIds(a.id).includes(tgId))
      .sort((x, y) => Number(!!y.ops && y.ownerId === account.id) - Number(!!x.ops && x.ownerId === account.id)) : [];
    // The ways it can go, in order, at most MAX_ROUTES: one that does not
    // take it hands the same message to the next (HB-0950).
    const routes: Array<{ via: string; send: (text: string, deadline: AbortSignal) => Promise<Sent> }> = [];
    for (const a of candidates) {
      if (routes.length >= MAX_ROUTES) break;
      const ch = store.getChannelForAgent(a.id, 'telegram');
      if (!ch) continue;
      const token = await secrets.get(ch.secretRef).catch(() => undefined);
      if (token) routes.push({ via: ch.accountId, send: (text, deadline) => sendTelegram(token, tgId!, text, deadline) });
    }
    // Then a Discord bot the person is linked on (a DM from the bot needs
    // only a shared server, not a running agent).
    const conn = dcId && routes.length < MAX_ROUTES ? connectorFor('discord') : undefined;
    if (dcId && conn?.dm) {
      const a = store.listAllActiveAgents()
        .filter(mayCarry)
        .sort((x, y) => Number(y.ownerId === account.id) - Number(x.ownerId === account.id))
        .find((x) => store.listAllowedChannelUserIds(x.id, 'discord').includes(dcId) && store.getChannelForAgent(x.id, 'discord'));
      const ch = a && store.getChannelForAgent(a.id, 'discord');
      if (ch) {
        routes.push({
          via: `discord:${ch.accountId}`,
          send: async (text, deadline) => {
            const secret = await secrets.get(ch.secretRef).catch(() => undefined);
            if (!secret) return { taken: false, maybe: false, error: 'its Discord token could not be read' };
            if (deadline.aborted) return { taken: false, maybe: false, error: 'no time was left to send it' };
            // The DM takes no signal: its answer is waited for until the deadline, and one later may have arrived.
            let onLate = () => {};
            const late = new Promise<'late'>((resolve) => { onLate = () => resolve('late'); deadline.addEventListener('abort', onLate, { once: true }); });
            try {
              const took = await Promise.race([conn.dm!(secret, dcId, text).catch(() => false), late]);
              if (took === 'late') return { taken: false, maybe: true, error: 'Discord did not answer in time' };
              return took ? { taken: true } : { taken: false, maybe: false, error: 'Discord did not take it' };
            } finally { deadline.removeEventListener('abort', onLate); }
          },
        });
      }
    }
    if (!routes.length) return;

    const ownerRights = account.hostOwner || deps.hasOwnerRights(account.id);
    const code = ownerFromPublic ? undefined : randomBytes(16).toString('base64url');
    // The link they have now, if any: kept when this one reaches nobody.
    const before = { code: account.claimCode ?? null, expires: account.claimExpires ?? null };
    if (code) store.setLocalAccountClaim(account.id, code, new Date(Date.now() + RECOVERY_TTL_MS).toISOString());
    // Never from the request's Host header: this route is unauthenticated, and
    // a stranger's Host would have put THEIR address, with the real code, in
    // the owner's own chat (use-case audit, 2026-09-27). With no known address
    // the link is only the path, to be opened where Hatchabot usually is.
    // An owner's link works at the private address only, so it is made for that one.
    const base = ownerRights ? appUrlFor() : linkUrlFor();
    const text = (code ? [
      `🔑 Hatchabot password reset for ${account.username}.`,
      base ? `Open this within 15 minutes to choose a new password:` : `Within 15 minutes, open Hatchabot at the address you always use and add this to it:`,
      base ? `${base}/?claim=${code}` : `/?claim=${code}`,
      ...(ownerRights ? [`This account has owner rights: the link works at the private address only, not the public one.`] : []),
      `If you did not ask for this, ignore it — nothing changes unless the link is used.`,
    ] : [
      `🔑 Someone asked at this Hatchabot's public address to reset the password of ${account.username}.`,
      `An account with owner rights is recovered at the private address only, so no link was made. If it was you: open Hatchabot at its private address${base ? ` (${base})` : ''} and choose "Forgot password?" there.`,
      `If it was not you, nothing has changed.`,
    ]).join('\n\n');
    const notTaken: Array<{ via: string; error: string }> = [];
    const unconfirmed: Array<{ via: string; error: string }> = [];
    let via: string | undefined;
    let outOfTime = false;
    const deadline = AbortSignal.timeout(deps.sendWithinMs ?? SEND_WITHIN_MS);
    for (const r of routes) {
      if (deadline.aborted) { outOfTime = true; break; }
      const out = await r.send(text, deadline);
      if (out.taken) { via = r.via; break; }
      (out.maybe ? unconfirmed : notTaken).push({ via: r.via, error: out.error });
    }
    const where = { account: account.id, ...(fromPublic ? { from: 'the public address' } : {}), ...(code ? {} : { link: false }) };
    const tries = { ...(notTaken.length ? { notTaken } : {}), ...(unconfirmed.length ? { unconfirmed } : {}), ...(outOfTime ? { outOfTime } : {}) };
    if (via) {
      deps.warn({ ...where, via, ...tries }, 'account.recovery_link_sent');
    } else if (unconfirmed.length) {
      // It may have arrived: Telegram can deliver a message it answers too
      // late, so the link it carries stays good (HB-0950 review).
      deps.warn({ ...where, ...tries }, 'account.recovery_link_unconfirmed');
    } else {
      // Surely reached nobody: the link made for it goes, and one they had
      // before stays. The asks are counted all the same (HB-0950).
      if (code && store.localAccountByUsername(username)?.claimCode === code) store.setLocalAccountClaim(account.id, before.code, before.expires);
      deps.warn({ ...where, ...tries }, 'account.recovery_not_delivered');
    }
  };

  return {
    ask,
    resetLimits: () => { recoverySentAt.clear(); publicRecovery.perName.clear(); publicRecovery.perAddress.clear(); publicRecovery.all.length = 0; },
  };
}
