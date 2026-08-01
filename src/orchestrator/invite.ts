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
  const bytes = randomBytes(10);
  let code = '';
  for (let i = 0; i < 10; i++) code += ALPHABET[bytes[i]! % ALPHABET.length];
  return code;
}

export function createInvite(
  store: Store,
  agentId: string,
  createdBy: string,
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
  return { valid: true, agentId: invite.agentId };
}

export interface JoinResult {
  membershipUserId: string;
  agentId: string;
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

  // Keying the membership on the account id is what lets them log in later
  // and see this agent; otherwise it's an opaque per-invite id.
  const userId = accountId ?? `member-${randomUUID()}`;
  if (accountId && store.getMembership(check.agentId, accountId)) {
    throw new InviteInvalidError('used'); // already a member of this agent
  }
  if (!store.markInviteRedeemed(code.trim().toUpperCase(), userId)) {
    throw new InviteInvalidError('used'); // lost the race
  }
  store.insertMembership({
    id: randomUUID(),
    agentId: check.agentId,
    userId,
    role: 'user',
    displayName: displayName.trim().slice(0, 64) || 'Guest',
    status: 'active',
    joinedAt: new Date().toISOString(),
  });
  return { membershipUserId: userId, agentId: check.agentId };
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
