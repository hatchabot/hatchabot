import { randomBytes, randomUUID } from 'node:crypto';
import type { Store } from '../store/store.js';

/**
 * §12.3 invite & join, MVP-shaped for a world without user accounts yet:
 * the invite code IS the invitee's credential. Owner mints a single-use,
 * 48h link; the invitee opens it on their phone, sees the shared-memory
 * disclosure (§12.6), gives a name, and joins as a `user`-role member.
 * Their Telegram identity binds afterwards through the same pairing-claim
 * mechanism the owner used.
 */

const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

// No 0/O/1/I — these codes get read off phone screens.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateInviteCode(): string {
  // Rejection sampling instead of `byte % 31`: 256 isn't a multiple of 31, so
  // the modulo mapping biased toward the alphabet's first 8 symbols. Draw
  // fresh bytes and discard the top non-uniform tail so every symbol is
  // equally likely (it matters little for 49 bits of entropy, but it's free).
  const max = 256 - (256 % ALPHABET.length); // 248 — the unbiased range
  let code = '';
  while (code.length < 10) {
    for (const b of randomBytes(16)) {
      if (b >= max) continue;
      code += ALPHABET[b % ALPHABET.length];
      if (code.length === 10) break;
    }
  }
  return code;
}

export function createInvite(
  store: Store,
  agentId: string,
  createdBy: string,
  /** Who it is for — a Telegram @handle. The claim window it opens then
   *  admits only that person, instead of whoever knocks first. */
  expectHandle?: string,
): { code: string; expiresAt: string } {
  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  store.insertInvite({
    id: randomUUID(),
    agentId,
    code,
    role: 'user',
    createdBy,
    createdAt: new Date().toISOString(),
    expiresAt,
    expectHandle,
  });
  return { code, expiresAt };
}

export type InviteCheck =
  | { valid: true; agentId: string }
  | { valid: false; reason: 'unknown' | 'expired' | 'used' };

export function checkInvite(store: Store, code: string): InviteCheck {
  const invite = store.getInviteByCode(code.trim().toUpperCase());
  if (!invite) return { valid: false, reason: 'unknown' };
  if (invite.redeemedAt) return { valid: false, reason: 'used' };
  if (new Date(invite.expiresAt).getTime() < Date.now()) return { valid: false, reason: 'expired' };
  // The agent may have been deleted after the link was minted — joining a
  // tombstone would create a membership against an agent with no bot to talk
  // to and a triumphant "you're in!" page. Treat it as a dead link.
  const agent = store.getAgent(invite.agentId);
  if (!agent || agent.state === 'DELETED' || agent.state === 'DELETING') {
    return { valid: false, reason: 'unknown' };
  }
  return { valid: true, agentId: invite.agentId };
}

export interface JoinResult {
  membershipUserId: string;
  agentId: string;
  /** Who the invite named, if anyone — the claim window narrows to them. */
  expectHandle?: string;
}

/**
 * Redeems the invite and creates the membership. Atomic on the invite row, so
 * two people racing the same link produce exactly one member.
 */
export function redeemInvite(
  store: Store,
  code: string,
  displayName: string,
  /**
   * The invitee's verified account id, when they signed in while joining
   * (the "full invite" of docs/identity.md phase 4). Absent = lightweight
   * membership: chat access only, no login.
   */
  accountId?: string,
): JoinResult {
  const check = checkInvite(store, code);
  if (!check.valid) throw new InviteInvalidError(check.reason);
  const invite = store.getInviteByCode(code.trim().toUpperCase());

  // Keying the membership on the account id is what lets them log in later
  // and see this agent; otherwise it's an opaque per-invite id.
  const userId = accountId ?? `member-${randomUUID()}`;
  const existing = accountId ? store.getMembership(check.agentId, accountId) : undefined;
  if (existing && existing.status === 'active') {
    throw new InviteInvalidError('used'); // already a member of this agent
  }
  const name = displayName.trim().slice(0, 64) || 'Guest';
  // Atomic: burn the code AND create/reactivate the membership together, or
  // neither. A crash between them used to leave a single-use code spent with
  // no member — "already used" for someone who never actually joined.
  store.transact(() => {
    if (!store.markInviteRedeemed(code.trim().toUpperCase(), userId)) {
      throw new InviteInvalidError('used'); // lost the race — rolls back
    }
    if (existing) {
      // A previously-revoked account member is re-admitted, not blocked forever
      // (insertMembership would also hit UNIQUE(agent_id, user_id)). Reactivate
      // the row and let the caller's claim re-bind their telegram id.
      store.reactivateMembership(check.agentId, userId, name);
    } else {
      store.insertMembership({
        id: randomUUID(),
        agentId: check.agentId,
        userId,
        role: 'user',
        displayName: name,
        status: 'active',
        joinedAt: new Date().toISOString(),
      });
    }
  });
  return { membershipUserId: userId, agentId: check.agentId, expectHandle: invite?.expectHandle };
}

export class InviteInvalidError extends Error {
  constructor(readonly reason: 'unknown' | 'expired' | 'used') {
    super(`Invite invalid: ${reason}`);
    this.name = 'InviteInvalidError';
  }
  get userMessage(): string {
    switch (this.reason) {
      case 'expired':
        return 'This invite has expired. Ask for a new one.';
      case 'used':
        return 'This invite was already used. Ask for a new one.';
      default:
        return "This invite link isn't valid.";
    }
  }
}
