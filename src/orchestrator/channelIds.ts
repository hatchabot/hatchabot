import type { ChannelKind } from '../domain/types.js';

/**
 * The only shapes a channel user id may have before it reaches a script on
 * the agent's volume, a config allowlist, or a membership binding. One copy:
 * the claim, grant, revoke and door code all judge by the same rule.
 */
export const ID_SHAPE: Record<ChannelKind, RegExp> = {
  telegram: /^\d{1,32}$/,
  slack: /^[UW][A-Z0-9]{2,31}$/,
  discord: /^\d{15,25}$/,
};

/** An account key as the config writer seeds it (a bot username, or `hatchabot`). */
export const ACCOUNT_SHAPE = /^[A-Za-z0-9_]{1,64}$/;
