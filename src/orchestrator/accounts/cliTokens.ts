import type { Store } from '../../store/store.js';

/**
 * CLI tokens (HB-0808 step 15 part B; /v1/cli-tokens): how a non-browser
 * client authenticates. Minted from an already-signed-in session, so it
 * works the same whether the owner uses Google, email, or the shared
 * password.
 *
 * A token is a credential: it is answered once, when it is made, and only
 * its hash is kept (`Store.createCliToken`). A list shows its label and
 * dates, never the token. Each lasts 90 days; one with the `rehost` scope is
 * for another Hatchabot server that will move agents here, and can do that
 * and nothing else. The agents' own call tokens are not listed or revoked
 * here (the store leaves them out).
 */
export interface CliTokens {
  /** The caller's tokens, newest first: never a token itself. */
  list(ownerId: string): ReturnType<Store['listCliTokens']>;
  /** A new token: its id, and the token, shown this once. */
  mint(ownerId: string, label: string, scope?: 'rehost'): { id: string; token: string };
  /** Revoke one of the caller's tokens: false when there is no such token of theirs. */
  revoke(ownerId: string, id: string): boolean;
}

/** How long a token lasts. */
export const CLI_TOKEN_DAYS = 90;

export function createCliTokens(deps: { store: Pick<Store, 'listCliTokens' | 'createCliToken' | 'revokeCliToken'> }): CliTokens {
  const { store } = deps;
  return {
    list: (ownerId) => store.listCliTokens(ownerId),
    mint: (ownerId, label, scope) => {
      const { id, token } = store.createCliToken(ownerId, label, CLI_TOKEN_DAYS, scope);
      // Shown once — only the hash is kept.
      return { id, token };
    },
    revoke: (ownerId, id) => store.revokeCliToken(ownerId, id),
  };
}
