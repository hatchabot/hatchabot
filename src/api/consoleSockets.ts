/**
 * The console WebSockets that are open right now, each remembered with what
 * let it in, so it can be judged again.
 *
 * A WebSocket is checked once, when it is opened: the session cookie, the
 * agent's owner or a web-chat guest, and at the public address the public
 * pass and the second factor (docs/public-access.md). After that it is two
 * sockets spliced together and nothing looks at it again. So "Sign out on
 * every device", a password change, a second-factor reset, an account being
 * disabled or removed, a guest's web chat being switched off and the public
 * address's idle limit all ended the person's requests and left their open
 * console (for an owner, a shell in that agent's container) running for as
 * long as the tab stayed open (second review, 2026-10-01).
 *
 * Now every open socket is re-judged by the same rules that admitted it:
 * right after any request that changed something, when someone signs out, and
 * on a timer for what no request announces (idleness, a session that ran
 * out, a change made by another process). A socket that would not be let in
 * now is closed.
 */
export interface ConsoleSocket {
  ownerId: string;
  agentId: string;
  role: 'owner' | 'guest';
  /** The Cookie header it was opened with: its session (and, publicly, its pass). */
  cookie: string | undefined;
  https: boolean;
  /** It arrived on the public listener (trust.ts). */
  public: boolean;
  /** When the browser last sent anything on it. */
  lastActive: number;
  close(): void;
}

export interface ConsoleSocketsApi {
  /** Re-judge every open socket now; closes those no longer allowed. Returns how many it closed. */
  revalidate(): number;
  /** Close one person's sockets whatever their standing (their second factor was reset or removed). */
  closeFor(ownerId: string, opts?: { publicOnly?: boolean }): number;
  size(): number;
}

export class ConsoleSockets {
  private readonly open = new Set<ConsoleSocket>();

  /** Remember an open socket. Returns the function that forgets it (call it when either side closes). */
  add(s: ConsoleSocket): () => void {
    this.open.add(s);
    return () => { this.open.delete(s); };
  }

  size(): number { return this.open.size; }

  /** Close every socket `judge` gives a reason for. */
  sweep(judge: (s: ConsoleSocket) => string | undefined, onClosed?: (s: ConsoleSocket, why: string) => void): number {
    let closed = 0;
    for (const s of [...this.open]) {
      let why: string | undefined;
      // A judge that cannot answer (the database is gone) is a "no": closed, not kept.
      try { why = judge(s); } catch { why = 'could not be checked'; }
      if (!why) continue;
      this.open.delete(s);
      try { s.close(); } catch { /* already gone */ }
      onClosed?.(s, why);
      closed++;
    }
    return closed;
  }
}
