import { randomBytes } from 'node:crypto';

/**
 * Server-stored, single-use, TTL'd confirmations for mutate tools. The Telegram
 * button only carries the id (`cfm:<id>:y`) — the concrete resolved action lives
 * here, so the 64-byte callback_data limit is a non-issue and the id is a short
 * unguessable capability rather than a secret to verify.
 *
 * See docs/management-broker.md §6.
 */

/** The full agent spec an authoring proposal carries. The Telegram card shows
 *  a preview; THIS is what executes on confirm — the card is never the truth. */
export interface AuthorSpec {
  name?: string;
  persona?: string;
  soul?: string;
  agentsMd?: string;
  fields?: Array<Record<string, unknown>>;
  /** create_agent placement, chosen by the broker (never by the model). */
  aiProfileId?: string;
  aiProfileName?: string;
  hostId?: string;
  /** update_definition: precomputed change-size line, shown on the card. */
  diff?: string;
  /** build_image / rebuild_image: the Dockerfile snippet and base tag. */
  dockerfile?: string;
  base?: string;
  /** build_base_candidate: the OpenClaw version; try/end_base_trial: the tag. */
  version?: string;
  tag?: string;
  current?: string;
}

export interface Resolved {
  agentId: string;
  agentName: string;
  /** set_model */ model?: string;
  /** approve_member */ code?: string;
  /** remove_member */ userId?: string;
  /** create_agent / update_definition */ spec?: AuthorSpec;
}

export interface PendingConfirm {
  id: string;
  ownerId: string;
  chatId: number;
  /** The allowlisted user who proposed it — only they may confirm. */
  fromUserId: number;
  /** The card message, edited in place on resolve (0 until the card is sent). */
  messageId: number;
  tool: string;
  resolved: Resolved;
  summary: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired';
}

export interface PendingStoreOptions {
  ttlMs?: number;
  now?: () => number;
  /** Injectable for tests; defaults to a CSPRNG-backed short id. */
  genId?: () => string;
}

export type ClaimResult =
  | { ok: true; rec: PendingConfirm }
  | { ok: false; reason: 'missing' | 'expired' | 'already' | 'not_yours' };

export class PendingStore {
  #map = new Map<string, PendingConfirm>();
  #ttlMs: number;
  #now: () => number;
  #genId: () => string;

  constructor(opts: PendingStoreOptions = {}) {
    this.#ttlMs = opts.ttlMs ?? 120_000;
    this.#now = opts.now ?? (() => Date.now());
    this.#genId = opts.genId ?? (() => 'c_' + randomBytes(6).toString('base64url'));
  }

  create(
    fields: Omit<PendingConfirm, 'id' | 'createdAtMs' | 'expiresAtMs' | 'status' | 'messageId'>,
    /** Per-record override — authoring proposals give the owner longer to
     *  read a full spec than the 2 minutes a stop/start needs. */
    ttlMs?: number,
  ): PendingConfirm {
    const now = this.#now();
    const rec: PendingConfirm = {
      ...fields,
      id: this.#genId(),
      messageId: 0,
      createdAtMs: now,
      expiresAtMs: now + (ttlMs ?? this.#ttlMs),
      status: 'pending',
    };
    this.#map.set(rec.id, rec);
    return rec;
  }

  /** Attach the card's message id so we can edit it in place on resolve. */
  attachMessage(id: string, messageId: number): void {
    const rec = this.#map.get(id);
    if (rec) rec.messageId = messageId;
  }

  peek(id: string): PendingConfirm | undefined {
    return this.#map.get(id);
  }

  /**
   * Atomically consume a pending confirmation: verifies it exists, is still
   * pending, unexpired, and belongs to this user+chat, then flips its status so
   * a replay finds it already handled. This is the single-use gate.
   */
  claim(
    id: string,
    verb: 'confirm' | 'cancel',
    by: { fromUserId: number; chatId: number },
  ): ClaimResult {
    const rec = this.#map.get(id);
    if (!rec) return { ok: false, reason: 'missing' };
    if (rec.status !== 'pending') return { ok: false, reason: 'already' };
    if (this.#now() > rec.expiresAtMs) {
      rec.status = 'expired';
      return { ok: false, reason: 'expired' };
    }
    // Confused-deputy / cross-chat replay: only the proposer, in the same chat.
    if (rec.fromUserId !== by.fromUserId || rec.chatId !== by.chatId) {
      return { ok: false, reason: 'not_yours' };
    }
    rec.status = verb === 'confirm' ? 'confirmed' : 'cancelled';
    return { ok: true, rec };
  }

  /** Drop expired/resolved records; call periodically. Returns count removed. */
  sweep(): number {
    const now = this.#now();
    let n = 0;
    for (const [id, rec] of this.#map) {
      if (rec.status !== 'pending' || now > rec.expiresAtMs) {
        this.#map.delete(id);
        n++;
      }
    }
    return n;
  }
}
