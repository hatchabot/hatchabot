import { LOCAL_OWNER, type Principal } from './principal.js';

/** The wait after the first failed adoption; it doubles after each failure. */
export const ADOPTION_RETRY_MS = 30_000;
/** The longest wait between two tries. */
export const ADOPTION_RETRY_MAX_MS = 60 * 60_000;
/** How to hand the data to another account when the pinned one is gone. */
export const RELEASE_PIN = 'sqlite3 data/hatchabot.sqlite "DELETE FROM first_account" (or the database HATCHABOT_DB names), then restart Hatchabot';

/**
 * The first real account adopts what password mode owned (Phase 3 of
 * docs/identity.md), run from the auth hook on an authenticated request.
 * Once it has gone through it is not tried again in this process: it fires on
 * every request. One that failed (a busy or broken database) is tried again
 * on a later request: the latch used to be set before the attempt, so a
 * failure left the fleet under dev-owner, and the owner facing an empty one,
 * until the next restart (HB-0548).
 *
 * The account that tried first is the one it is for: it is recorded before
 * the hand-over runs (in the store, so a restart keeps it too), and a retry
 * runs only on that account's requests. Without that, a member who signed in
 * during the wait after a failure took the owner's agents. Only an account
 * that may take the install over is pinned (in accounts mode, the host
 * owner), and nothing is pinned when nothing is left to hand over, or when
 * it went to an account already. Once all is handed over the pin is marked
 * done: what the old owner gets later goes to nobody. The waits double from
 * 30 seconds up to an hour.
 */
export function firstAccountAdoption(
  store: {
    adoptLocalOwnerData(ownerId: string, localOwner?: string, opts?: { pinned?: boolean }): number;
    pinFirstAccount(ownerId: string): { ownerId: string; done: boolean } | undefined;
    localOwnerHasData(): boolean;
    localOwnerHasAnything(): boolean;
    mayTakeOverInstall(ownerId: string): boolean;
    accountExists(ownerId: string): boolean;
  },
  log: { warn(detail: object, msg: string): void; error(detail: object, msg: string): void },
  now: () => number = Date.now,
): (principal: Pick<Principal, 'ownerId' | 'email'>) => void {
  let done = false;
  // Only ever what the store holds: set from its answer, never ahead of it.
  let pinned: string | undefined;
  // The hand-over went through; only the look at what stayed behind is left.
  let adopted = false;
  // Accounts that may not take the install over (members), and those that
  // may: asked once each.
  const refused = new Set<string>();
  const allowed = new Set<string>();
  let failures = 0;
  let retryAt = 0;
  let toldSkip = false;
  const skip = (ownerId: string): void => {
    if (toldSkip) return;
    toldSkip = true;
    // How to release it only when the account it is held for is gone: told
    // to anyone else, it handed the owner's data to whoever asked next.
    const held = `this installation's data is held for the account that signed in first, so this account's sign-in does not take it.`;
    // A store that cannot say: the line without advice. Thrown, it counted
    // as a failed hand-over and pushed back the held account's retry.
    let gone: boolean | undefined;
    try { gone = !store.accountExists(pinned!); } catch { /* said without advice */ }
    log.warn({ ownerId, heldFor: pinned }, gone === undefined ? held : !gone ? `${held} That account takes it at its next sign-in.`
      : `${held} That account no longer exists; to hand the data to the next account that signs in: ${RELEASE_PIN}`);
  };
  return (principal) => {
    if (done) return;
    // Only a REAL account can adopt. A leftover dev-owner CLI token
    // authenticating first (a cron/script after a mode switch) would
    // otherwise end the check and adopt nothing, leaving the human's first
    // sign-in facing an empty fleet.
    if (principal.ownerId === LOCAL_OWNER) return;
    if (refused.has(principal.ownerId)) return;
    if (now() < retryAt) return;
    try {
      // A member is never who it is for, held or not: nothing to say to them.
      if (!allowed.has(principal.ownerId)) {
        if (!store.mayTakeOverInstall(principal.ownerId)) { refused.add(principal.ownerId); return; }
        allowed.add(principal.ownerId);
      }
      if (pinned !== undefined && principal.ownerId !== pinned) return skip(principal.ownerId);
      if (!adopted) {
        if (pinned === undefined) {
          // Handed over long ago, or never anything to hand over: no pin.
          // Anything it moves counts, not only an agent, source or host: a
          // connection or a spare pool bot left alone stayed orphaned.
          if (!store.localOwnerHasAnything()) { done = true; return; }
          // The stored pin, or this account's once it is stored. Held in
          // memory ahead of the store, a pin the store could not read was
          // this account's, and the stored account was turned away until a
          // restart (fifth review).
          const pin = store.pinFirstAccount(principal.ownerId);
          // It went to an account already: what the old owner gets later is nobody's.
          if (!pin || pin.done) { done = true; return; }
          pinned = pin.ownerId;
          if (principal.ownerId !== pinned) return skip(principal.ownerId);
        }
        const rows = store.adoptLocalOwnerData(principal.ownerId, LOCAL_OWNER, { pinned: true });
        adopted = true;
        if (rows > 0) {
          log.warn({ ownerId: principal.ownerId, email: principal.email, rows }, 'adopted this installation\'s data into the first signed-in account');
        }
      }
      // In the try: a busy database here is asked again on the next request,
      // not a failed request after a hand-over that went through.
      const left = store.localOwnerHasData();
      done = true;
      if (left) {
        log.warn({ ownerId: principal.ownerId }, 'some of this installation\'s agents stayed with the old owner, because you have agents with the same names. '
          + 'An AI source, machine or Google connection only they use stays with them too. Rename or delete yours, then restart Hatchabot to take them over');
      }
    } catch (err) {
      if (adopted) return; // only the look at what stayed failed: again on the next request
      failures++;
      const wait = Math.min(ADOPTION_RETRY_MS * 2 ** (failures - 1), ADOPTION_RETRY_MAX_MS);
      retryAt = now() + wait;
      const detail = { ownerId: pinned, err: String(err), failures, retryInSeconds: wait / 1000 };
      const msg = 'could not hand this installation\'s data to the first signed-in account. '
        + 'It is tried again on that account\'s next request after the wait. '
        + 'If it keeps failing, check that the disk has room (df -h), read the error here, then restart Hatchabot';
      if (failures === 1) log.error(detail, msg);
      else log.warn(detail, msg);
    }
  };
}
