import { createHash } from 'node:crypto';
import type { Agent } from '../../domain/types.js';
import { SecretNotFoundError } from '../../secrets/secretStore.js';
import { REMOVED_OWNER, type ConnectionCleanup } from '../../store/store.js';
import { COPY_NOT_DELETED, materializeConnection, offAgainIfDetached, removeQueuedNow, revokeGoogleToken, sameGoogleGrant, withConnectionLock, withGoogleGrantTurn, withVaultTurn } from './googleConnections.js';
import type { GoogleDeps, GoogleHelpers } from './connectionsAndAccess.js';

/**
 * The connection vault and which agent holds which account (HB-0808, from
 * src/api/routes.ts; issues #11, #16, #18). Refresh tokens are in the secret
 * store, the connections and attachments in the store, and each agent's own
 * gog holds what was imported into it. A removal is recorded on the agent
 * (`connection_removals`) before anything is deleted, and cleared only when
 * gog shows the account gone. Every change to what an agent holds runs in
 * its connection turn (`withConnectionLock`). A connection being deleted is
 * refused to an attach (`connectionsDeleting`, a lock). A deleted
 * connection's row gives way to a record of its token still to end
 * (`connection_cleanups`), which goes only once the token has; the pass
 * (`retryCleanups`, every ten minutes and at the start) tries again what a
 * failure or a restart left. Who is asking is the route's: each function
 * takes the caller's account id.
 */
export interface ConnectionVault {
  /**
   * The caller's connections, with where each one reaches and who still
   * holds the old client secret; and the access of their deleted ones still
   * being ended at Google, or given up for them to remove by hand (`ending`,
   * HB-1336).
   */
  list(ownerId: string): Promise<{ connections: Array<Record<string, unknown>>; ending: EndingAccess[] }>;
  /**
   * A connection of the caller's deleted: off every agent first, then revoked
   * at Google, then out of the vault. Undefined: not the caller's.
   * `connectedAgain`: the account was connected again while this ran; it is
   * off its agents, and the newer consent stays in the vault.
   * `stillEnding`: Google did not confirm ending its token (or it was not
   * asked, its token unreadable); the pass tries again, and the Connections
   * page lists it (HB-1336). Not when Google's part is done and only the
   * secret store kept Hatchabot's copy: the page lists that as such.
   */
  remove(connectionId: string, ownerId: string): Promise<{ removed: true; pendingOn: number; stillEnding?: true } | { removed: false; connectedAgain: true; pendingOn: number } | undefined>;
  /** A notice of access given up (`ending`, its `id`) marked done by its owner. False: no such notice of theirs. */
  dismissEnding(ownerId: string, id: string): boolean;
  /**
   * Attach one of the caller's connections to their agent: live now when it
   * runs. Null: no such connection (or it went meanwhile). `agentGone`: the
   * agent was deleted, or is no longer the caller's, while this waited its turn.
   */
  attach(agent: Agent, ownerId: string, connectionId: string | undefined, gmailNoSend: boolean): Promise<{ attached: boolean; live: boolean; error?: string } | { agentGone: true } | null>;
  /** Detach one of the caller's connections from their agent. Null: no such connection. */
  detach(agent: Agent, ownerId: string, connectionId: string | undefined): Promise<{ detached: true; removed: boolean } | null>;
  /**
   * An agent's Disconnect of an account: a platform connection attached to it
   * is detached; any other is removed from its gog. `invalid`: not a mailbox
   * address safe for the shell line.
   */
  disconnect(agent: Agent, email: string): Promise<
    | { removed: boolean; detached: true }
    | { removed: true }
    | { refused: 'invalid' | 'not-running' }
    | { refused: 'failed'; reason: string }>;
  /** The accounts the running agent's own gog lists, or null when no list could be read. */
  accountsIn(agent: Agent & { runtimeRef: string }): Promise<{ accounts: Array<{ email: string; client: string; auth: string; services?: string[] }> } | null>;
  /**
   * The pass for the tokens of deleted connections still to end
   * (`connection_cleanups`, HB-0901): each tried again in its owner's vault
   * turn. Not while the last pass still runs (0 then). How many it ended.
   */
  retryCleanups(): Promise<number>;
  /** End the pass's timer: at shutdown. */
  stop(): void;
}

/**
 * A deleted connection's access still being ended at Google, as the
 * Connections page lists it (HB-1336): never its token or its secret ref.
 * `givenUpAt`: the pass stopped asking, deleted the token, and its owner is
 * to remove the access by hand; listed until they mark it done (`id`).
 */
export interface EndingAccess {
  id: string; email: string; since: string; tries: number; lastTriedAt: string | null; lastAnswer: string | null; givenUpAt: string | null;
  /** Not a deleted connection's: the token a reconnect with another Google Cloud project's client replaced (HB-1396). */
  replaced?: true;
  /** Google's part is done (revoked, gone already, or kept for another connection's grant); only Hatchabot's copy is left, which the secret store kept. */
  copyLeft?: true;
}
/** The id the page names a cleanup by: not its secret ref. */
const endingId = (secretRef: string) => createHash('sha256').update(secretRef).digest('hex').slice(0, 16);
/** A cleanup of the token a reconnect replaced (googleClient.ts, link: `<ref>/replaced/<n>`), not of a deleted connection's. */
const replacedToken = (secretRef: string) => secretRef.includes('/replaced/');

/** How long the pass asks Google to revoke a deleted connection's token before it stops, deletes it, and tells its owner (HB-1203). */
export const REVOKE_TRIED_FOR_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;
const REVOKE_TRIED_FOR_MS = REVOKE_TRIED_FOR_DAYS * DAY_MS;
/**
 * And how many tries it takes first: a day of passes at the ten-minute pace.
 * Age alone gave up on one try: a machine off for the week, whose first pass
 * at the start ran before its network answered. The count is already kept
 * on each record, where tries on separate days would need a record of their
 * own; a machine on for only part of each day takes longer, and still ends.
 */
export const REVOKE_TRIES_AT_LEAST = 144;

export function createConnectionVault(deps: GoogleDeps, helpers: GoogleHelpers): ConnectionVault {
  const { store, secrets, providerFor, trace, oauthFetch } = deps;
  const { getOAuthClient, connSyncDeps, syncGoogleDocs } = helpers;

  /**
   * A deleted connection's token out of the secret store, and its record
   * with it. A store that will not delete it now keeps the record, with
   * why, for the pass: the connection's row is gone, so nothing else
   * names the token any more (HB-0901). True: it is gone.
   */
  const dropToken = async (c: ConnectionCleanup, gaveUp?: string): Promise<boolean> => {
    try {
      await secrets.delete(c.secretRef);
    } catch (err) {
      const why = String((err as Error)?.message ?? err);
      // COPY_NOT_DELETED leads only where Google's part is done: on the way to
      // giving up, Google never confirmed it, and the page must not say it did
      // (HB-1336 review). The pass tries it again either way.
      store.connectionCleanupFailed(c.secretRef, gaveUp !== undefined
        ? `Google did not revoke it: ${gaveUp}; the secret store did not delete its copy: ${why}`
        : `${COPY_NOT_DELETED}: ${why}`);
      return false;
    }
    // Given up: the record stays, as its owner's notice to remove the access
    // by hand, shown on the Connections page until they mark it done (HB-1336);
    // not when their account was removed, as nobody is left to read it.
    if (gaveUp !== undefined && c.ownerId !== REMOVED_OWNER) store.giveUpConnectionCleanup(c.secretRef, `Google did not revoke it: ${gaveUp}`);
    else store.settleConnectionCleanup(c.secretRef);
    return true;
  };

  /**
   * End a deleted connection's token: revoked at Google unless a connection
   * still here shares its grant (any account's, the same one connected
   * again included: revoking ends it for them too, night review,
   * 2026-09-28; a client of another Google Cloud project is a grant of its
   * own, HB-0968), then out of the secret store. Judged and revoked in the
   * installation's grant turn, which a link's exchange takes too: another
   * account's consent of the address lands before the judging, and is seen,
   * or after the revoke, on a grant of its own. A revoke Google
   * did not confirm keeps the token, and its record, for the next try
   * (HB-1203). `done`: nothing is left of it. `alreadyGone`: Google knew no
   * such token (expired, or revoked already), so this revoked nothing.
   * For the pass (`mayGiveUp`), one still not confirmed REVOKE_TRIED_FOR_MS
   * after its delete, at its REVOKE_TRIES_AT_LEAST-th try or later, is
   * deleted all the same (`gaveUp`, Google's last answer): asking on for
   * ever kept a live token and its address, with nobody told.
   */
  const endToken = async (c: ConnectionCleanup, opts: { mayGiveUp?: boolean } = {}): Promise<{ done: boolean; revoked: boolean; alreadyGone?: true; gaveUp?: string; shared: boolean }> => {
    let token: string | undefined;
    try {
      token = await secrets.get(c.secretRef);
    } catch (err) {
      if (!(err instanceof SecretNotFoundError)) {
        store.connectionCleanupFailed(c.secretRef, `its token could not be read: ${String((err as Error)?.message ?? err)}`);
        return { done: false, revoked: false, shared: false };
      }
      // Nothing stored under it: nothing to revoke or delete.
    }
    const { shared, r } = await withGoogleGrantTurn(async () => {
      const shared = !!token && store.connectionClientsOf(c.kind, c.email).some((id) => sameGoogleGrant(c.clientId, id));
      return { shared, r: token && !shared ? await revokeGoogleToken(token, oauthFetch) : undefined };
    });
    let revoked = false, alreadyGone = false;
    if (r) {
      if (!r.ended) {
        if (opts.mayGiveUp && Date.now() - Date.parse(c.createdAt) >= REVOKE_TRIED_FOR_MS && c.tries + 1 >= REVOKE_TRIES_AT_LEAST) {
          return { done: await dropToken(c, r.error), revoked: false, gaveUp: r.error, shared };
        }
        store.connectionCleanupFailed(c.secretRef, `Google did not revoke it: ${r.error}`);
        return { done: false, revoked: false, shared };
      }
      if (r.already) alreadyGone = true; else revoked = true;
    }
    return { done: await dropToken(c), revoked, ...(alreadyGone ? { alreadyGone: true as const } : {}), shared };
  };

  let cleanupPassRunning = false;
  const retryCleanups: ConnectionVault['retryCleanups'] = async () => {
    if (cleanupPassRunning) return 0;
    cleanupPassRunning = true;
    let ended = 0;
    try {
      for (const listed of store.connectionCleanups()) {
        // In its owner's vault turn, as the delete's own try was: a delete
        // still finishing it goes first, and this finds it settled.
        const out = await withVaultTurn(listed.ownerId, async () => {
          const c = store.connectionCleanup(listed.secretRef);
          // Its tries as they are now: a delete's own try may have counted one since the listing.
          return c ? { ...(await endToken(c, { mayGiveUp: true })), tries: c.tries + 1, ownerRemoved: c.ownerId === REMOVED_OWNER } : undefined;
        });
        if (out?.done && out.gaveUp !== undefined) {
          ended++;
          // Its owner is told to remove the access by hand, after the turn:
          // a message may take a while to send (HB-1203).
          // What was done, as it was: how many times, over how long.
          const days = Math.floor((Date.now() - Date.parse(listed.createdAt)) / DAY_MS);
          const replaced = replacedToken(listed.secretRef);
          const access = replaced
            ? `the access ${listed.email} gave the OAuth client Hatchabot used before it was connected again`
            : `its access to ${listed.email}`;
          const where = replaced ? ' (the app of that earlier client, not the one connected now)' : '';
          // An account removed since has nobody to tell.
          const told = out.ownerRemoved ? false : await Promise.resolve()
            .then(() => deps.tellOwner(listed.ownerId, `Hatchabot asked Google ${out.tries} times over ${days} days to end ${access}, and Google never confirmed it. It has stopped asking and deleted its copy of the token. To be sure the access is gone, remove it by hand: in that Google Account, Security → Your connections to third-party apps & services${where}. It is listed in Hatchabot under ⚙ Settings → Connections until you mark it done.`))
            .catch(() => false);
          trace()('connection.revoke_given_up', { email: listed.email, since: listed.createdAt, tries: out.tries, days, error: out.gaveUp, told, ...(replaced ? { replaced } : {}), ...(out.ownerRemoved ? { ownerRemoved: true } : {}) });
        } else if (out?.done) {
          ended++;
          trace()('connection.token_ended', { email: listed.email, revoked: out.revoked, ...(out.alreadyGone ? { alreadyGone: true } : {}), keptForOtherAccount: out.shared, tries: out.tries, ...(replacedToken(listed.secretRef) ? { replaced: true } : {}) });
        }
      }
    } finally { cleanupPassRunning = false; }
    return ended;
  };
  // Every ten minutes, with the client-secret pass, and once as the service
  // is built: what a restart cut off, or a failure left, is tried again.
  // Off in tests (routes.ts passes 0 there).
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  if (deps.sweepEveryMs > 0) {
    const pass = () => { void retryCleanups().catch((err: unknown) => deps.warn({ err: String(err) }, 'connection cleanup pass failed')); };
    pass();
    cleanupTimer = setInterval(pass, deps.sweepEveryMs);
    cleanupTimer.unref();
  }

  const accountsIn: ConnectionVault['accountsIn'] = async (agent) => {
    // The same read as gogAccounts: its wrapper (which unlocks the keyring) when there is one.
    const res = await providerFor(agent.hostId).execShell(agent.runtimeRef, '~/.local/bin/gog auth list --json 2>/dev/null || gog auth list --json 2>/dev/null').catch(() => undefined);
    // An image without gog (the shell's "command not found") holds no account.
    if (res?.code === 127) return { accounts: [] };
    // Only a list gog gave is an answer, as gogAccounts reads it: a failed
    // exec or output that is not its list read as "none connected", which
    // hid the accounts and their Disconnect exactly when the read failed
    // (audit #075).
    let parsed: { accounts?: unknown } | null = null;
    try { parsed = res?.code === 0 ? JSON.parse(res.stdout) as { accounts?: unknown } | null : null; } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.accounts)) return null;
    // gog names no services for an imported account: what was granted is on the connection.
    const attachedServices = new Map(store.listAgentConnections(agent.id).flatMap((at) => {
      const c = store.getConnection(at.connectionId);
      return c ? [[c.email.toLowerCase(), c.services] as const] : [];
    }));
    const accounts = (parsed.accounts as Array<{ email?: unknown; client?: unknown; auth?: unknown; services?: unknown } | null>)
      .filter((a): a is { email: string; client?: unknown; auth?: unknown; services?: unknown } => !!a && typeof a.email === 'string' && !!a.email)
      // The listing also reports a per-account token-read warning when run
      // without a TTY — that's about THIS probe's shell, not the account's
      // health, so it is deliberately not surfaced.
      .map((a) => ({
        email: a.email, client: typeof a.client === 'string' && a.client ? a.client : 'default', auth: typeof a.auth === 'string' && a.auth ? a.auth : 'oauth',
        ...(attachedServices.has(a.email.toLowerCase())
          ? { services: attachedServices.get(a.email.toLowerCase()) }
          : Array.isArray(a.services) ? { services: a.services.filter((s): s is string => typeof s === 'string') } : {}),
      }));
    return { accounts };
  };

  const disconnect: ConnectionVault['disconnect'] = async (agent, email) => {
    // Strict shape gate — the email is interpolated into a shell line, so
    // only unambiguous mailbox characters may pass (no $, backticks,
    // quotes), and the FIRST char must be alphanumeric: a leading dash
    // would reach gog's flag parser as an option. `--` below is the belt
    // to that suspender.
    if (!/^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+$/.test(email) || email.length > 254) {
      return { refused: 'invalid' };
    }
    // A platform connection attached to this agent is detached, as the
    // Detach route does: only taking it out of gog left the attachment,
    // and the next start, wake or rebuild imported it again. The removal
    // is recorded first, so a failed or deferred one is retried.
    const platform = store.listAgentConnections(agent.id)
      .map((a) => store.getConnection(a.connectionId))
      .filter((c): c is NonNullable<typeof c> => !!c && c.email.toLowerCase() === email.toLowerCase());
    if (platform.length) {
      const removed = await withConnectionLock(agent.id, async () => {
        for (const c of platform) {
          store.addConnectionRemoval(agent.id, c.email);
          store.detachConnection(agent.id, c.id);
        }
        const now = store.getAgent(agent.id) ?? agent;
        let all = true;
        for (const e of new Set(platform.map((c) => c.email))) all = (await removeQueuedNow(connSyncDeps(now.hostId), now, e)) && all;
        return all;
      });
      trace(agent.id)('connection.detached', { email, removed });
      await syncGoogleDocs(agent.id);
      return { removed, detached: true };
    }
    if (!agent.runtimeRef || agent.state !== 'RUNNING') {
      return { refused: 'not-running' };
    }
    // --force: without it gog refuses removal in a non-interactive shell
    // (verified live — every docker-exec disconnect failed with exit 2).
    const res = await providerFor(agent.hostId).execShell(
      agent.runtimeRef,
      `gog auth remove --force -- "${email}"`,
    );
    if (res.code !== 0) {
      return { refused: 'failed', reason: (res.stderr || res.stdout || 'gog gave no reason').slice(0, 200) };
    }
    trace(agent.id)('connection.removed', { email });
    return { removed: true };
  };

  const list: ConnectionVault['list'] = async (ownerId) => {
    const mine = store.listConnections(ownerId);
    const client = await getOAuthClient();
    // Who still holds the old client secret: the query the pass that delivers
    // it reads, so the two cannot disagree (HB-0463).
    const owedSecret = new Set(client ? store.connectionsOwedClientSecret('google', client.clientId, { ownerId }).map((p) => `${p.agentId}\n${p.connectionId}`) : []);
    return {
      connections: mine.map(({ clientId, clientSecretAt, ...c }) => {
        const attachedTo = store
          .listConnectionAttachments(c.id)
          .map((at) => ({ at, a: store.getAgent(at.agentId) }))
          .filter((x) => x.a && x.a.state !== 'DELETED')
          .map(({ at, a }) => ({
            id: a!.id,
            name: a!.name,
            state: a!.state,
            // The app it runs (apps in agents): two copies of one app on one account both answer every email.
            app: store.getAgentApp(a!.id)?.app ?? null,
            attachedAt: at.attachedAt,
            materializedAt: at.materializedAt,
            // Stale = the agent's materialized token predates the connection's
            // last consent — the account was reconnected but this agent didn't
            // re-attach. A NULL materializedAt means "not tracked yet" (the
            // attachment predates this bookkeeping), NOT stale — asserting
            // staleness needs a known pull time, or every pre-migration
            // attachment would false-flag on first load.
            stale: !!at.materializedAt && at.materializedAt < c.createdAt,
            // It holds the client secret from before the last one saved (HB-0427).
            secretPending: owedSecret.has(`${a!.id}\n${c.id}`),
          }));
        // Made with a client other than the one set now: its token no longer
        // works, and only connecting the account again mends it.
        const needsReconnect = !!client && !!clientId && clientId !== client.clientId;
        return { ...c, attachedTo, staleCount: attachedTo.filter((x) => x.stale).length, secretPendingCount: needsReconnect ? 0 : attachedTo.filter((x) => x.secretPending).length, needsReconnect };
      }),
      // Deleted ones whose access is still being ended, or was given up: shown
      // nowhere but the server log and a chat message before (HB-1336).
      ending: store.connectionCleanupsOf(ownerId).map((c) => ({
        id: endingId(c.secretRef), email: c.email, since: c.createdAt, tries: c.tries, lastTriedAt: c.triedAt, lastAnswer: c.error, givenUpAt: c.givenUpAt,
        ...(replacedToken(c.secretRef) ? { replaced: true as const } : {}),
        ...(!c.givenUpAt && c.error?.startsWith(COPY_NOT_DELETED) ? { copyLeft: true as const } : {}),
      })),
    };
  };

  const dismissEnding: ConnectionVault['dismissEnding'] = (ownerId, id) => {
    const c = store.connectionCleanupsOf(ownerId).find((x) => endingId(x.secretRef) === id);
    return !!c && store.dismissGivenUpCleanup(ownerId, c.secretRef);
  };

  /** Connections whose DELETE is under way: an attach refuses them. */
  const connectionsDeleting = new Set<string>();
  const remove: ConnectionVault['remove'] = async (connectionId, ownerId) => {
    const conn = store.getConnection(connectionId);
    if (!conn || conn.ownerId !== ownerId) return undefined;
    // Record the removal on every attached agent BEFORE anything is deleted
    // (the record carries the email the vault row is about to lose), pull it
    // off the RUNNING ones now, then revoke at Google, then drop the vault
    // entry — so a half-failure errs toward less access. A record clears only
    // when the account is verifiably off; a stopped agent or a failed remove
    // is retried at its next start, wake or rebuild (issue #11).
    // From here no attach takes it (one already importing is a holder below
    // and finishes first): an attach landing between this agent's removal and
    // the vault row going put the account back with its record cleared
    // (issue #16, 2026-10-09).
    connectionsDeleting.add(conn.id);
    let pendingOn = 0;
    let revoked = false;
    let alreadyGone = false;
    let shared = false;
    let connectedAgain = false;
    let tokenLeft = false, stillEnding = false;
    try {
      const holders = store.listAgentsForConnection(conn.id)
        .map((aid) => store.getAgent(aid))
        .filter((a): a is NonNullable<typeof a> => !!a);
      for (const a of holders) store.addConnectionRemoval(a.id, conn.email);
      for (const a of holders) {
        // In that agent's connection turn, so an import in flight lands first.
        // Detached inside the turn, in the database: the vault row stays until
        // the revocation below, and a sync (rebuild, start, wake) in that gap
        // saw the attachment still there and imported the account again, with
        // its record already cleared — under a shared grant nothing else ends
        // that access (issue #18, 2026-10-09).
        const off = await withConnectionLock(a.id, async () => {
          store.detachConnection(a.id, conn.id);
          const now = store.getAgent(a.id);
          return !!now && removeQueuedNow(connSyncDeps(now.hostId), now, conn.email);
        });
        if (!off) pendingOn++;
        await syncGoogleDocs(a.id);
      }
      // The rest in the owner's vault turn, which a link takes too (HB-0879):
      // a reconnect of this account that finished while the agents were
      // being taken off saved a new token in the same place, and this went
      // on to revoke and delete it after the person was told "connected".
      // Connected again since this began (its row's time is its last
      // consent's, as `stale` reads it): the newer consent stays.
      connectedAgain = await withVaultTurn(conn.ownerId, async () => {
        const now = store.getConnection(conn.id);
        if (!now) return false; // another delete of it finished first
        if (now.createdAt !== conn.createdAt) return true;
        // The row goes and the record of its token comes, in one step, and
        // only then is the grant judged, by the connections left (endToken).
        // Two accounts deleting the last two connections of one Google
        // account at once each saw the other's row, kept the grant for it,
        // and neither revoked it (HB-0903); with its own row gone first, the
        // later one finds none left and revokes. A secret store that would
        // not delete the token left it with nothing naming it (HB-0901), and
        // a revoke Google did not confirm was forgotten (HB-1203): the
        // record stays until both are done, and the pass tries again, after
        // a restart too.
        const left = store.retireConnection(conn.id);
        if (left) {
          const out = await endToken(left);
          revoked = out.revoked;
          alreadyGone = !!out.alreadyGone;
          shared = out.shared;
          tokenLeft = !out.done;
          // Google's part done, only the copy kept: not "not confirmed at Google" (HB-1336 review).
          stillEnding = tokenLeft && !out.revoked && !out.alreadyGone && !out.shared;
        }
        return false;
      });
    } finally {
      connectionsDeleting.delete(conn.id);
    }
    trace()('connection.unlinked', { email: conn.email, revoked, ...(alreadyGone ? { alreadyGone } : {}), keptForOtherAccount: shared, pendingOn, ...(connectedAgain ? { connectedAgain } : {}), ...(tokenLeft ? { tokenLeft } : {}) });
    return connectedAgain ? { removed: false, connectedAgain: true, pendingOn } : { removed: true, pendingOn, ...(stillEnding ? { stillEnding: true as const } : {}) };
  };

  /** Attach a vault connection to an agent — live immediately when RUNNING,
   *  and re-materialized on every future provision/rebuild. */
  const attach: ConnectionVault['attach'] = async (agent, ownerId, connectionId, gmailNoSend) => {
    const conn = connectionId ? store.getConnection(connectionId) : undefined;
    // The connection must be the CALLER's: attaching someone else's Gmail
    // to your agent is exactly the cross-owner grant this vault must not
    // allow (sharing, if ever, is an explicit owner opt-in like AI sources).
    if (!conn || conn.ownerId !== ownerId) return null;
    // In the agent's connection turn, judged afresh once it is ours: a
    // detach that ran while this import was in flight took the account off
    // and cleared its record, then the import put it back with nothing
    // left to undo it (issue #16, 2026-10-09).
    const out = await withConnectionLock(agent.id, async () => {
      // Deleted, or being deleted, while this waited its turn.
      if (!store.getConnection(conn.id) || connectionsDeleting.has(conn.id)) return null;
      // The agent as it is now, judged before anything is written: one
      // deleted while this waited had its attachments scrubbed, and the row
      // put back here outlived it, with nothing left to take it off (HB-0899).
      const now = store.getAgent(agent.id);
      if (!now || now.ownerId !== ownerId || now.state === 'DELETING' || now.state === 'DELETED') return { agentGone: true as const };
      store.attachConnection(agent.id, conn.id, gmailNoSend);
      // Attached again on purpose: a removal still pending from an earlier
      // detach must not take the account off at the next start (issue #11).
      store.clearConnectionRemoval(agent.id, conn.email);
      if (now.state !== 'RUNNING' || !now.runtimeRef) return { attached: true, live: false };
      const deps = connSyncDeps(now.hostId);
      const r = await materializeConnection(deps, { id: now.id, slug: now.slug, runtimeRef: now.runtimeRef }, conn.id);
      // Defence for a path outside the turn: detached during the import → off again.
      if (await offAgainIfDetached(deps, { id: now.id, runtimeRef: now.runtimeRef }, conn.id, conn.email)) {
        return { attached: false, live: false, error: 'Detached while it was being attached.' };
      }
      return { attached: true, live: r.ok, error: r.ok ? undefined : r.error };
    });
    if (!out || 'agentGone' in out) return out;
    trace(agent.id)('connection.attached', { email: conn.email, live: out.live, attached: out.attached });
    await syncGoogleDocs(agent.id);
    return out;
  };

  const detach: ConnectionVault['detach'] = async (agent, ownerId, connectionId) => {
    const conn = connectionId ? store.getConnection(connectionId) : undefined;
    if (!conn || conn.ownerId !== ownerId) return null;
    // The removal is recorded before the attachment goes: a STOPPED agent
    // used to lose it here, and deleting the vault entry afterwards erased
    // the last place its email was known (issue #11). Running → removed now;
    // otherwise (or on failure) at its next start, wake or rebuild.
    // In the agent's connection turn: an attach still importing finishes
    // first, so this removal lands after it (issue #16, 2026-10-09).
    const removed = await withConnectionLock(agent.id, async () => {
      store.addConnectionRemoval(agent.id, conn.email);
      store.detachConnection(agent.id, conn.id);
      const now = store.getAgent(agent.id) ?? agent;
      return removeQueuedNow(connSyncDeps(now.hostId), now, conn.email);
    });
    trace(agent.id)('connection.detached', { email: conn.email, removed });
    await syncGoogleDocs(agent.id);
    return { detached: true, removed };
  };

  return {
    list, remove, dismissEnding, attach, detach, disconnect, accountsIn, retryCleanups,
    stop: () => { if (cleanupTimer) clearInterval(cleanupTimer); cleanupTimer = undefined; },
  };
}
