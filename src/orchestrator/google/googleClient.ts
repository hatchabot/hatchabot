import { randomUUID } from 'node:crypto';
import { COPY_NOT_DELETED, exchangeGoogleCode, GOOGLE_CLIENT_REF, grantedServices, OAuthStateJar, revokeGoogleToken, sameGoogleGrant, withGoogleGrantTurn, withVaultTurn, type OAuthClient } from './googleConnections.js';
import type { ClientSecretDelivery } from './clientSecretDelivery.js';
import type { GoogleDeps, GoogleHelpers } from './connectionsAndAccess.js';

/**
 * The installation's Google OAuth client and the consent round-trip (HB-0808,
 * from src/api/routes.ts). The client is one per installation, in the secret
 * store (`GOOGLE_CLIENT_REF`); its secret half never leaves it. The consent's
 * single-use states are one `OAuthStateJar` (googleConnections.ts), in
 * memory on purpose: a restart mid-consent means pressing Connect again.
 * Who may set the client, the browser's cookie and the redirect address are
 * the route's (src/api/data/googleRoutes.ts).
 */
export interface GoogleClient {
  /** The client set now, or null. */
  get(): Promise<OAuthClient | null>;
  /**
   * Save the client, after the machine owner's check and the body's. A
   * different client ID breaks every connection made with the old one, so it
   * is refused (`client-change`, with how many) until `confirmed`; a new
   * secret, or the same client saved again, reaches the agents owed it.
   */
  save(client: { clientId: string; clientSecret: string }, confirmed: boolean): Promise<{ refused: 'client-change'; breaks: number } | { breaks: number; sent: { pushing: number; waiting: number } }>;
  /** Clear the client. False when the secret store would not: it is still set. */
  remove(): Promise<boolean>;
  /** A consent begun: its single-use state, bound to the owner, the services asked for and the browser's nonce. */
  issueState(ownerId: string, services: string[], nonce: string): string;
  /** Google sent the person back: the state's owner and services, once, when the nonce is the browser's. */
  consumeState(state: string, nonce: string): { ownerId: string; services: string[] } | null;
  /**
   * The code exchanged and the account in the owner's vault, with only what
   * Google granted. None granted: nothing is stored (`granted` empty). Throws
   * with words for the page when Google refuses.
   */
  link(claim: { ownerId: string; services: string[] }, client: OAuthClient, redirectUri: string, code: string): Promise<{ email: string; granted: string[]; refused: string[] }>;
}

export function createGoogleClient(deps: GoogleDeps, helpers: GoogleHelpers, delivery: ClientSecretDelivery): GoogleClient {
  const { store, secrets, trace, oauthFetch } = deps;
  const { getOAuthClient } = helpers;
  const { pushClientSecret, deliverClientSecretNow } = delivery;
  const stateJar = new OAuthStateJar();

  // A refresh token works only with the client that issued it: a different
  // client ID breaks every connection made with the old one, for everyone on
  // the server. So that change is asked for (`confirm`), naming how many will
  // need reconnecting; a new secret for the same client ID is not.
  const save: GoogleClient['save'] = async (client, confirmed) => {
    const old = await getOAuthClient();
    if (old) store.adoptConnectionClient('google', old.clientId);
    const breaks = store.countConnectionsFromOtherClient('google', client.clientId);
    if (breaks && !confirmed) return { refused: 'client-change', breaks };
    await secrets.put(GOOGLE_CLIENT_REF, JSON.stringify(client));
    if (breaks) trace()('google.client_replaced', { reconnect: breaks });
    const changed = old?.clientId !== client.clientId || old?.clientSecret !== client.clientSecret;
    return { breaks, sent: changed ? pushClientSecret(client.clientId) : deliverClientSecretNow(client.clientId) };
  };

  const remove = async (): Promise<boolean> => {
    // Remember which client made the connections there are, so saving a
    // different one later still knows what it breaks.
    const old = await getOAuthClient();
    if (old) store.adoptConnectionClient('google', old.clientId);
    // A failed delete leaves the client in place: say so, rather than
    // "removed" with the next read still showing it configured.
    try {
      await secrets.delete(GOOGLE_CLIENT_REF);
    } catch (err) {
      trace()('google.client_remove_failed', { error: String((err as Error)?.message ?? err).slice(0, 200) });
      return false;
    }
    return true;
  };

  // In the owner's vault turn, the exchange too (HB-0879): a delete of the
  // same account finishing meanwhile revokes at Google before this code is
  // exchanged or after its token is saved, never between, and sees this
  // consent if it landed first (connectionVault.ts, remove). And in the
  // installation's grant turn, which every revoke takes: another account's
  // delete, or the vault's pass, does the same.
  const link: GoogleClient['link'] = (claim, client, redirectUri, code) => withVaultTurn(claim.ownerId, () => withGoogleGrantTurn(async () => {
    const { refreshToken, email, scope } = await exchangeGoogleCode(client, redirectUri, code, oauthFetch);
    // Record only what Google granted: an unticked service would be
    // offered to agents and fail them with permission errors (#174).
    const { granted, refused } = grantedServices(claim.services, scope);
    if (!granted.length) return { email, granted, refused };
    // Upsert: reconnecting the same account refreshes its token in place
    // (and every agent it's attached to picks the new token up on its
    // next rebuild/materialization).
    const existing = store.findConnection(claim.ownerId, 'google', email);
    const id = existing?.id ?? randomUUID();
    const secretRef = existing?.secretRef ?? `connection/${id}`;
    // The token this one replaces, and the client that made it (HB-1338).
    const was = existing ? store.getConnection(existing.id) : undefined;
    const replaced = was ? await secrets.get(secretRef).catch(() => undefined) : undefined;
    // Made with a client of another Google Cloud project, it may be a grant
    // of its own, to revoke below. It is kept under a ref of its own, with a
    // record of it still to end, before the new token takes its place: a
    // revoke Google did not confirm was logged and never tried again, the
    // record being keyed by the ref the new token now holds (HB-1396). The
    // vault's pass tries it again, judging the grant afresh, and gives it up
    // as it does a deleted connection's.
    const ownProject = !!was && !!replaced && replaced !== refreshToken && !sameGoogleGrant(was.clientId, client.clientId);
    let kept: string | undefined;
    if (ownProject) {
      kept = `${secretRef}/replaced/${randomUUID().slice(0, 8)}`;
      try {
        store.recordConnectionCleanup({ secretRef: kept, kind: 'google', ownerId: claim.ownerId, email, clientId: was.clientId ?? null });
        await secrets.put(kept, replaced);
      } catch (err) {
        store.settleConnectionCleanup(kept);
        kept = undefined;
        deps.warn({ email, error: String((err as Error)?.message ?? err).slice(0, 200) }, 'connection.replaced_token_not_kept');
      }
    }
    await secrets.put(secretRef, refreshToken);
    store.insertConnection({ id, ownerId: claim.ownerId, kind: 'google', email, services: granted, secretRef, clientId: client.clientId });
    // The replaced token was left working at Google, and agents that had
    // imported it kept a working copy (HB-1338). It is revoked when it is
    // a grant of its own: made with a client of another Google Cloud
    // project, and held by no connection here, anyone's (endToken's rule).
    // Under the same grant, revoking it would end the new token as well,
    // so it stays. A revoke Google does not confirm is logged, and its
    // record kept for the pass; the reconnect stands.
    let oldToken: Record<string, unknown> = {};
    /** The copy kept for the pass, deleted and its record settled; one the secret store keeps stays on record, and the pass deletes it. */
    const dropKept = async (ref: string): Promise<void> => {
      try { await secrets.delete(ref); store.settleConnectionCleanup(ref); }
      catch (err) { store.connectionCleanupFailed(ref, `${COPY_NOT_DELETED}: ${String((err as Error)?.message ?? err)}`); }
    };
    if (ownProject && !store.connectionClientsOf('google', email).some((other) => sameGoogleGrant(was!.clientId, other))) {
      const r = await revokeGoogleToken(replaced!, oauthFetch);
      oldToken = r.ended ? { oldTokenRevoked: true, ...(r.already ? { alreadyGone: true } : {}) } : { oldTokenNotRevoked: r.error, ...(kept ? { triedAgainLater: true } : {}) };
      if (!r.ended) deps.warn({ email, error: r.error }, 'connection.replaced_token_not_revoked');
      if (kept) {
        if (r.ended) await dropKept(kept);
        else store.connectionCleanupFailed(kept, `Google did not revoke it: ${r.error}`);
      }
    } else if (kept) {
      // Another connection here shares its grant: revoking it would end theirs too.
      await dropKept(kept);
    }
    trace()('connection.linked', { email, services: granted, ...(refused.length ? { refused } : {}), ...oldToken });
    return { email, granted, refused };
  }));

  return {
    get: getOAuthClient,
    save,
    remove,
    issueState: (ownerId, services, nonce) => stateJar.issue(ownerId, services, nonce),
    consumeState: (state, nonce) => stateJar.consume(state, nonce),
    link,
  };
}
