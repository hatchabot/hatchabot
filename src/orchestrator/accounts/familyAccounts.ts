import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { activeValues } from '../../config/envFile.js';
import { writeEnvVar } from '../../ops/tailnet.js';
import type { Store } from '../../store/store.js';

/**
 * One shared password → an account per person, without a terminal (HB-0808
 * step 15 part B; POST /v1/auth/family-accounts).
 *
 * The owner, already signed in with the shared password, chooses a username
 * for themselves. Account #1 is created as host owner and adopts everything
 * the password-mode install made — exactly what the first-run bootstrap does
 * — then HATCHABOT_AUTH=accounts is written to the .env and the service
 * restarts itself (systemd's Restart=always and launchd's KeepAlive bring it
 * straight back). Because the account exists before the mode flips, there
 * is no first-run window for anyone else to claim.
 *
 * One way only: going back to a shared password would put every family
 * member's agents behind one owner.
 *
 * A crash between the account and the .env leaves the account with nothing
 * to finish it, and its recovery code lost with the response. The next try
 * replaces that account and carries on (HB-0423). Only that: an account that
 * has been used, or was made some other way, stays.
 */
export const FAMILY_SWITCH_WAITING = 'An account already exists — restart to finish switching.';
export const FAMILY_ACCOUNT_EXISTS = 'This machine already has an account, so family accounts cannot start over. To use that account, set HATCHABOT_AUTH=accounts in .env and restart.';

/** The username and password the owner chose, or why they will not do (the route's words, a 400). */
export type FamilyCredentials = { username: string; password: string } | { problem: string };

export type FamilySwitch =
  | { ok: true; answer: { ok: true; username: string; adopted: number; restarting: boolean; recoveryCode: string; ownerId: string } }
  /** `machine-owner`: not the machine's owner (the route words it). */
  | { ok: false; why: 'machine-owner' }
  | { ok: false; why: 'refused'; status: 400 | 409; error: string };

export interface FamilyAccounts {
  /**
   * The switch, its checks in their order: accounts already (409), the
   * machine's owner only (403), one at a time (409), an account there
   * already (409 unless a crash left it half made), then the credentials,
   * read only now (400). The account, then the .env, then the adoption.
   */
  switchOn(caller: { ownsMachine(): boolean }, credentials: () => FamilyCredentials): Promise<FamilySwitch>;
  /** End the restart's timer (the process is ending anyway). */
  stop(): void;
}

export interface FamilyAccountsDeps {
  store: Pick<Store, 'listLocalAccounts' | 'localAccountNeverUsed' | 'countLocalAccounts' | 'transact' | 'deleteLocalAccount' | 'insertLocalAccount' | 'recordAccount' | 'setLocalAccountRecovery' | 'adoptLocalOwnerData'>;
  /** HATCHABOT_AUTH as the server was started with (undefined: password). */
  authMode: () => 'password' | 'accounts' | 'identity' | undefined;
  /** The .env the service reads (read at each switch). */
  envPath: () => string;
  /** accountsAuth.ts's: the password's hash, a recovery code and its normal form. */
  hashPassword: (password: string) => Promise<{ hash: string; salt: string }>;
  newRecoveryCode: () => string;
  normalizeRecoveryCode: (code: string) => string;
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  warn: (detail: Record<string, unknown>, msg: string) => void;
  /** Run under a supervisor that brings the process back (systemd's INVOCATION_ID, launchd's XPC_SERVICE_NAME). */
  supervised: () => boolean;
  /** Whether the switch may end the process (not under VITEST). */
  restartOn: () => boolean;
  /** End the process, 1.2 s after the answer: the supervisor starts it again in accounts mode. */
  exit: () => void;
}

export function createFamilyAccounts(deps: FamilyAccountsDeps): FamilyAccounts {
  const { store, hashPassword, newRecoveryCode, normalizeRecoveryCode, trace } = deps;
  const refused = (status: 400 | 409, error: string): FamilySwitch => ({ ok: false, why: 'refused', status, error });
  const halfMadeFamilyAccount = (): string | undefined => {
    const rows = store.listLocalAccounts();
    const a = rows.length === 1 ? rows[0]! : undefined;
    // What the switch below writes in its transaction, and no use since: not `hatchabot accounts create`, which has no password yet.
    return a && a.hostOwner && !a.disabled && a.pwHash !== '' && a.recoveryHash && !a.claimCode && store.localAccountNeverUsed(a.id) ? a.id : undefined;
  };
  let familySwitchRunning = false;
  let restartTimer: NodeJS.Timeout | undefined;

  const switchOn = async (caller: { ownsMachine(): boolean }, credentials: () => FamilyCredentials): Promise<FamilySwitch> => {
    if ((deps.authMode() ?? 'password') !== 'password') {
      return refused(409, 'This installation already has accounts.');
    }
    if (!caller.ownsMachine()) return { ok: false, why: 'machine-owner' };
    const envPath = deps.envPath();
    // One at a time: to a second request, the first's account would look half made while its .env is being written.
    if (familySwitchRunning) return refused(409, FAMILY_SWITCH_WAITING);
    if (store.countLocalAccounts() > 0) {
      let envSays: string | undefined;
      try { envSays = activeValues(readFileSync(envPath, 'utf8')).get('HATCHABOT_AUTH'); } catch { /* unreadable: nothing here says the switch finished */ }
      if (envSays === 'accounts') return refused(409, FAMILY_SWITCH_WAITING);
      if (!halfMadeFamilyAccount()) return refused(409, FAMILY_ACCOUNT_EXISTS);
    }
    const given = credentials();
    if ('problem' in given) return refused(400, given.problem);
    const { username, password } = given;

    familySwitchRunning = true;
    try {
      const { hash, salt } = await hashPassword(password);
      // The host owner is the one person nobody can send a reset link to: a
      // recovery code, shown once, as the first-run bootstrap gives one.
      const recoveryCode = newRecoveryCode();
      const rc = await hashPassword(normalizeRecoveryCode(recoveryCode));
      // The account first, then the .env: written first, a crash before the
      // account left an install in accounts mode with nobody to sign in as
      // (HB-0063). Checked again in one transaction: another request may have
      // made one while this one hashed.
      const id = `acct-${randomUUID()}`;
      const made = store.transact((): boolean => {
        const halfMade = halfMadeFamilyAccount();
        if (store.countLocalAccounts() > 0 && !halfMade) return false;
        if (halfMade) {
          store.deleteLocalAccount(halfMade);
          deps.warn({ replaced: halfMade }, 'family accounts: replaced the account a crash left half made');
        }
        store.insertLocalAccount({
          id, username, pwHash: hash, pwSalt: salt, hostOwner: true, disabled: false,
          createdAt: new Date().toISOString(),
        });
        store.recordAccount(id, username.includes('@') ? username : undefined);
        store.setLocalAccountRecovery(id, rc.hash, rc.salt);
        return true;
      });
      if (!made) return refused(409, FAMILY_ACCOUNT_EXISTS);

      const wrote = await writeEnvVar(envPath, 'HATCHABOT_AUTH', 'accounts', (cur) => cur === 'password',
        'Written by Hatchabot: one account per person (Settings → You).')
        .catch((err: unknown) => ({ ok: false, error: String(err) }));
      if (!wrote.ok) {
        // Nothing has changed then: the account goes again.
        store.deleteLocalAccount(id);
        return refused(409, wrote.error ?? 'Could not write .env');
      }
      // Adopted last: in password mode the install's data must stay where the
      // shared password sees it until the switch is certain. A crash before
      // this, the first sign-in adopts it (index.ts).
      const adopted = store.adoptLocalOwnerData(id);
      trace()('auth.family_accounts_on', { adopted });

      // Only a supervised process may exit to restart: under `npm run dev`
      // nothing would bring it back, so say so instead.
      const supervised = deps.supervised();
      if (supervised && deps.restartOn()) restartTimer = setTimeout(() => deps.exit(), 1200).unref();
      // ownerId: whose the code is, the new account's (HB-0500).
      return { ok: true, answer: { ok: true, username, adopted, restarting: supervised, recoveryCode, ownerId: id } };
    } finally { familySwitchRunning = false; }
  };

  return { switchOn, stop: () => { if (restartTimer) clearTimeout(restartTimer); } };
}
