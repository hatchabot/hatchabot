import type Database from 'better-sqlite3';

/**
 * What must be true before this Hatchabot's sign-in page may be reachable
 * from the internet (docs/public-access.md). One list, judged by one pure
 * function, used by everything that decides: the switch (the API refuses to
 * turn public access on and names what is missing), the process at start and
 * every minute after (the public listener answers 503 while anything is
 * off), and `hatchabot doctor` (which fails).
 *
 * Some safeguards are settings or facts that can be off: those are checked.
 * The rest are mechanisms in the code that cannot be switched off (the route
 * table, the session rules, the record); they are listed as "built in", with
 * the file that enforces each, so the report shows the whole list.
 */

export interface PublicConfig {
  /** HATCHABOT_PUBLIC_ACCESS: the one switch. Anything but "funnel" is off; an unknown value is ON AND BROKEN (fail closed). */
  on: boolean;
  /** The value was set to something that is neither off nor a provider we know. */
  unknownProvider?: string;
  /** The local port of the public listener (loopback only). Funnel is pointed here and nowhere else. */
  port: number;
  /** Funnel's own port on the tailnet name: 443, 8443 or 10000. */
  funnelPort: number;
  /** https://<machine>.<tailnet>.ts.net[:port], written when Funnel was turned on. */
  url?: string;
  invitedOnly: boolean;
  /**
   * HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR=1: the owner's deliberate
   * choice to let chat-only web-chat guests (store.isChatOnlyGuest) use the
   * public address with their password alone. Everyone else with a password
   * needs a second factor there, always.
   */
  guestsWithoutSecondFactor: boolean;
  /**
   * HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL was the opt-in before a second
   * factor became the rule. =1 changes nothing now. Any other value used to
   * mean "members need none": it is NOT a way to weaken the rule, it is
   * ignored, and this says so (the doctor warns).
   */
  forAllIgnored?: string;
  idleMs: number;
  stepUpMs: number;
  requestsPerMinute: number;
  requestsPerMinutePerAddress: number;
  failsCeiling: number;
}

const num = (v: string | undefined, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= min && n <= max ? n : dflt;
};

export function publicConfig(env: NodeJS.ProcessEnv = process.env): PublicConfig {
  const raw = (env.HATCHABOT_PUBLIC_ACCESS ?? '').trim().toLowerCase();
  const off = raw === '' || raw === 'off' || raw === '0' || raw === 'no' || raw === 'false';
  return {
    on: !off,
    unknownProvider: !off && raw !== 'funnel' ? raw : undefined,
    port: num(env.HATCHABOT_PUBLIC_PORT, 8092, 1, 65535),
    funnelPort: [443, 8443, 10000].includes(Number(env.HATCHABOT_PUBLIC_FUNNEL_PORT)) ? Number(env.HATCHABOT_PUBLIC_FUNNEL_PORT) : 8443,
    url: env.HATCHABOT_PUBLIC_ACCESS_URL?.trim().replace(/\/$/, '') || undefined,
    invitedOnly: env.HATCHABOT_PUBLIC_INVITED_ONLY === '1',
    guestsWithoutSecondFactor: env.HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR === '1',
    forAllIgnored: ((v) => (v !== undefined && v.trim() !== '' && v.trim() !== '1' ? v.trim() : undefined))(env.HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL),
    idleMs: num(env.HATCHABOT_PUBLIC_IDLE_MINUTES, 720, 5, 60 * 24 * 30) * 60_000,
    stepUpMs: num(env.HATCHABOT_PUBLIC_STEPUP_MINUTES, 10, 1, 120) * 60_000,
    requestsPerMinute: num(env.HATCHABOT_PUBLIC_REQS_PER_MIN, 3000, 10, 1_000_000),
    requestsPerMinutePerAddress: num(env.HATCHABOT_PUBLIC_REQS_PER_MIN_PER_ADDRESS, 600, 5, 1_000_000),
    failsCeiling: num(env.HATCHABOT_PUBLIC_FAILS_CEILING, 100, 5, 100_000),
  };
}

/** The host a public URL names (the passkey RP ID), lower case, without a port. */
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname.toLowerCase() || undefined; } catch { return undefined; }
}

export interface AdminAccount {
  id: string;
  name: string;
  /** Confirmed authenticator apps. */
  totp: number;
  /** Passkeys, with the site each was made for. */
  passkeyRpIds: string[];
}

export interface SafeguardFacts {
  authMode: string;
  /** A hosted install (HATCHABOT_MANAGED_BY): already public through its provider; Funnel is not for it. */
  managed: boolean;
  /** Everyone with owner rights over this machine. Empty: nobody has claimed it yet. */
  admins: AdminAccount[];
  invitedOnly: boolean;
  /** HATCHABOT_ALLOW_OWNER_HEADER=1: a header chooses the owner. Tests only. */
  ownerHeader: boolean;
  ports: { main: number; public: number; ops: number; embed: number };
  autoUpgrade: { ok: boolean; why?: string };
  /** `tailscale funnel` is pointed at the PRIVATE port (someone ran it by hand). undefined: could not be read. */
  funnelOnPrivatePort?: boolean;
  /** Public access is switched on: then Funnel's target must be READABLE, not merely not known to be wrong. */
  publicOn?: boolean;
  loginFailLimit: number;
  /** The public host, when known: a passkey counts only if it was made for it. */
  publicHost?: string;
  /** Chat-only guests are let in without a second factor (the owner's switch). For the report only. */
  guestsExempt?: boolean;
}

export interface SafeguardCheck {
  id: string;
  /** The letter in docs/public-access.md. */
  letter: string;
  title: string;
  ok: boolean;
  /** Cannot be off: a mechanism in the code, listed for completeness. */
  builtIn?: boolean;
  detail: string;
  fix?: string;
}

/** A factor that works at the public address: an authenticator app, or a passkey made for that host. */
export function usableFactors(a: AdminAccount, publicHost?: string): number {
  return a.totp + a.passkeyRpIds.filter((rp) => !publicHost || rp === publicHost).length;
}

export function evaluateSafeguards(f: SafeguardFacts): SafeguardCheck[] {
  const out: SafeguardCheck[] = [];
  const modeOk = f.authMode === 'accounts' || f.authMode === 'identity';
  out.push({
    id: 'auth-mode', letter: 'a', title: 'A sign-in per person', ok: modeOk && !f.managed,
    detail: f.managed ? 'This Hatchabot is hosted for you; it is already reachable through its provider.'
      : modeOk ? `Sign-in mode: ${f.authMode}.`
      : 'One shared password guards everything. That is refused at a public address.',
    ...(modeOk || f.managed ? {} : { fix: 'Settings → You → turn on an account per person (HATCHABOT_AUTH=accounts).' }),
  });
  const claimed = f.admins.length > 0;
  const without = f.admins.filter((a) => usableFactors(a, f.publicHost) === 0);
  out.push({
    id: 'second-factor', letter: 'b', title: 'A second factor for everyone with owner rights',
    ok: claimed && without.length === 0,
    detail: !claimed ? 'Nobody owns this machine yet (first run). A machine cannot be claimed from the internet.'
      : without.length ? `No passkey or authenticator app yet: ${without.map((a) => a.name).join(', ')}.${f.publicHost && without.some((a) => a.passkeyRpIds.length) ? ` (A passkey made at another address does not work at ${f.publicHost}.)` : ''}`
      : `${f.admins.map((a) => `${a.name}: ${[a.passkeyRpIds.length && `${a.passkeyRpIds.length} passkey${a.passkeyRpIds.length === 1 ? '' : 's'}`, a.totp && 'authenticator app'].filter(Boolean).join(' + ')}`).join('; ')}. Everyone else who signs in with a password is asked for one at the public address too${f.guestsExempt ? ', EXCEPT chat-only guests (your choice: their password alone lets them chat)' : ''}.`,
    ...(claimed && !without.length ? {} : { fix: claimed ? 'Each of them: Settings → You → Second factor (from the private address).' : 'Create the first account on the machine itself, then add a second factor.' }),
  });
  out.push({
    id: 'invited-only', letter: 'c', title: 'Only invited people', ok: f.invitedOnly,
    detail: f.invitedOnly ? 'At the public address only existing accounts and pending invitations may sign in; nobody can register, and the machine cannot be claimed there.'
      : 'The "Only invited people" switch is off.',
    ...(f.invitedOnly ? {} : { fix: 'Settings → Reach it from anywhere → Only invited people (HATCHABOT_PUBLIC_INVITED_ONLY=1).' }),
  });
  const clash = [f.ports.main, f.ports.ops, f.ports.embed].includes(f.ports.public);
  const unreadable = !!f.publicOn && f.funnelOnPrivatePort === undefined;
  const listenerOk = !clash && !f.ownerHeader && f.funnelOnPrivatePort !== true && !unreadable;
  out.push({
    id: 'separate-listener', letter: 'd', title: 'Public traffic on its own port, never trusted as local',
    ok: listenerOk,
    detail: f.ownerHeader ? 'HATCHABOT_ALLOW_OWNER_HEADER=1 lets a request header choose the owner. Never with public access.'
      : clash ? `The public port ${f.ports.public} is also used for something else (app ${f.ports.main}, management door ${f.ports.ops}, memory search ${f.ports.embed}).`
      : f.funnelOnPrivatePort === true ? `Tailscale Funnel is pointed at the private port ${f.ports.main}: internet traffic would arrive looking like this machine.`
      : unreadable ? 'Public access is on, but Tailscale Funnel\'s configuration cannot be read, so where it points cannot be confirmed.'
      : `The public listener is 127.0.0.1:${f.ports.public}; everything arriving there is treated as a stranger whatever its headers say.${f.funnelOnPrivatePort === undefined ? ' (Funnel\'s current target could not be read.)' : ''}`,
    ...(listenerOk ? {} : { fix: f.ownerHeader ? 'Remove HATCHABOT_ALLOW_OWNER_HEADER from .env.' : clash ? 'Choose another HATCHABOT_PUBLIC_PORT.' : unreadable ? 'Check that the tailscale command works for this user (tailscale funnel status), or turn public access off.' : `Run: tailscale funnel reset   (then turn public access on from Hatchabot, which points Funnel at port ${f.ports.public} only).` }),
  });
  out.push({ id: 'route-table', letter: 'e', title: 'Only what outsiders need is served there', ok: true, builtIn: true,
    detail: 'Every route has a class; machine-level and dangerous ones need the second factor again; a route nobody classified is refused (src/api/publicRoutes.ts).' });
  const limitOk = f.loginFailLimit >= 1 && f.loginFailLimit <= 20;
  out.push({
    id: 'rate-limits', letter: 'f', title: 'Sign-in limits and lockouts', ok: limitOk,
    detail: limitOk ? `${f.loginFailLimit} failed sign-ins per address or account, then a lockout that doubles each time; a ceiling on all failures together.`
      : `HATCHABOT_LOGIN_FAILS_PER_WINDOW=${f.loginFailLimit} is too generous for a public address (20 at most).`,
    ...(limitOk ? {} : { fix: 'Set HATCHABOT_LOGIN_FAILS_PER_WINDOW to 20 or less (the default is 10).' }),
  });
  out.push({ id: 'new-device-notice', letter: 'g', title: 'A notice when someone signs in from a new device', ok: true, builtIn: true,
    detail: 'To the person and to the machine\'s owner: in the app, and on Telegram when they are linked (src/api/publicAccess.ts).' });
  out.push({ id: 'session-hardening', letter: 'h', title: 'Stricter sessions at the public address', ok: true, builtIn: true,
    detail: 'A __Host- cookie, a shorter idle time, the second factor again for sensitive actions, HSTS and a content security policy (src/api/publicAccess.ts).' });
  out.push({
    id: 'auto-upgrade', letter: 'i', title: 'Automatic upgrades on the stable channel', ok: f.autoUpgrade.ok,
    detail: f.autoUpgrade.ok ? 'This install follows the stable channel on its own.' : (f.autoUpgrade.why ?? 'Automatic upgrades are off.'),
    ...(f.autoUpgrade.ok ? {} : { fix: 'scripts/follow-channel.sh --install stable   (and, if pinned: hatchabot upgrade stable)' }),
  });
  out.push({ id: 'security-record', letter: 'j', title: 'A record of every public sign-in', ok: true, builtIn: true,
    detail: 'Sign-ins, bursts of failures and the switch going on or off are kept (Settings → Reach it from anywhere → Record).' });
  return out;
}

export const failingSafeguards = (checks: SafeguardCheck[]): SafeguardCheck[] => checks.filter((c) => !c.ok);

/**
 * Everyone with owner rights, and their second factors, read straight from
 * the database: the running app and `hatchabot doctor` (which opens the file
 * read-only, without the app) must see the same thing.
 */
export function adminAccounts(db: Database.Database, authMode: string): AdminAccount[] {
  const admins = new Map<string, string>();
  const all = <T>(sql: string, ...args: unknown[]): T[] => {
    try { return db.prepare(sql).all(...args) as T[]; } catch { return []; }
  };
  if (authMode !== 'password') {
    for (const r of all<{ id: string; username: string }>(`SELECT id, username FROM local_accounts WHERE host_owner = 1 AND disabled = 0`)) admins.set(r.id, r.username);
    // Whoever owns the row for this machine: in identity mode, the Google account that set it up.
    for (const r of all<{ owner_id: string }>(`SELECT owner_id FROM hosts WHERE kind = 'local'`)) {
      if (r.owner_id === 'dev-owner' || admins.has(r.owner_id)) continue;
      const email = all<{ email: string | null }>(`SELECT email FROM accounts WHERE owner_id = ?`, r.owner_id)[0]?.email;
      const local = all<{ username: string }>(`SELECT username FROM local_accounts WHERE id = ? AND disabled = 0`, r.owner_id)[0]?.username;
      if (r.owner_id.startsWith('user-') || local) admins.set(r.owner_id, local ?? email ?? r.owner_id);
    }
  }
  return [...admins].map(([id, name]) => {
    const rows = all<{ kind: string; rp_id: string | null }>(`SELECT kind, rp_id FROM second_factors WHERE owner_id = ? AND confirmed_at IS NOT NULL`, id);
    return {
      id, name,
      totp: rows.filter((r) => r.kind === 'totp').length,
      passkeyRpIds: rows.filter((r) => r.kind === 'passkey').map((r) => (r.rp_id ?? '').toLowerCase()),
    };
  });
}
