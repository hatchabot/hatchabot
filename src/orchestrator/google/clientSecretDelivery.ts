import type { Store } from '../../store/store.js';
import { isBusy } from '../lifecycle/busy.js';
import { materializeConnections, offAgainIfDetached, withConnectionLock } from './googleConnections.js';
import type { GoogleDeps, GoogleHelpers } from './connectionsAndAccess.js';

/**
 * A new client secret reaching the agents that hold the old one (HB-0808,
 * from src/api/routes.ts; HB-0427, HB-0463). What is owed is the store's
 * (`connectionsOwedClientSecret`, `connectionOwedClientSecret`), so a restart
 * loses nothing; the back-off of an agent whose import keeps failing
 * (`secretRetries`) is a cache, and the pass under way (`secretPassRunning`)
 * a plain flag. The pass every ten minutes is this file's timer, ended by
 * `stop()`.
 */
export interface ClientSecretDelivery {
  /** A new secret saved for this client ID: marked owed by every connection made with it, and pushed. */
  pushClientSecret(clientId: string): { pushing: number; waiting: number };
  /** The running, free agents owed it get it, one at a time, off the request (`done` when they have). */
  deliverClientSecret(clientId: string, opts?: { backoff?: boolean; owed?: OwedSecret[] }): { sent: { pushing: number; waiting: number }; done: Promise<void> };
  /** Saving the client: everyone owed is asked at once, a back-off forgotten. */
  deliverClientSecretNow(clientId: string): { pushing: number; waiting: number };
  /** One agent's owed accounts, in one connection turn and one exec. */
  deliverSecretTo(agentId: string, connectionIds: string[], clientId: string, passAt?: number): Promise<void>;
  /** The pass: undefined while the last one still runs, or with no client set. */
  clientSecretSweep(): Promise<{ pushing: number; waiting: number } | undefined>;
  /** End the pass's timer. */
  stop(): void;
}

export type OwedSecret = ReturnType<Store['connectionsOwedClientSecret']>[number];

export function createClientSecretDelivery(deps: GoogleDeps, helpers: GoogleHelpers): ClientSecretDelivery {
  const { store, trace } = deps;
  const { getOAuthClient, connSyncDeps, syncGoogleDocs } = helpers;
  /**
   * A client secret reaches an agent only when an account is imported, so a new
   * one for the same client ID left every agent on the old one, shown with a
   * check mark, until the old was deleted at Google and its tools stopped
   * refreshing (HB-0427). Running agents get it now, one at a time, off the
   * request; the rest are marked (secretPending) until their next start, or
   * until the pass for what is still owed reaches them running (HB-0463).
   */
  const pushClientSecret = (clientId: string): { pushing: number; waiting: number } => {
    store.markClientSecretChanged('google', clientId, new Date().toISOString());
    const sent = deliverClientSecretNow(clientId);
    if (sent.pushing + sent.waiting) trace()('google.client_secret_changed', sent);
    return sent;
  };
  /**
   * Who is still owed the client's last saved secret, from one store query
   * (the Connections page's secretPending reads the same): an account attached
   * and never imported, or imported before it. One made with another client
   * is not owed: only connecting it again mends it (needsReconnect).
   */
  const owedClientSecret = (clientId: string): OwedSecret[] =>
    store.connectionsOwedClientSecret('google', clientId)
      .filter((o) => o.state !== 'DELETED' && o.state !== 'ARCHIVED' && !o.migratedTo);
  /** Failed imports of a new secret in a row, per agent and account, and when the pass tries again: 10 minutes, doubling up to a day. */
  const secretRetries = new Map<string, { fails: number; at: number }>();
  const SECRET_RETRY_MS = 10 * 60_000;
  const SECRET_RETRY_MAX_MS = 24 * 3600_000;
  /**
   * An agent's owed accounts, in one connection turn and one exec, judged
   * again once it is its turn: the agent running and free, each account still
   * owed (an import that ran meanwhile, a rebuild's included, has it). Only
   * those accounts are imported, not every one it holds. Each keeps its own
   * result (materializeConnections): its back-off, its stamp, its Setup log
   * line. A back-off counts from the pass that tried it (`passAt`), so the
   * first retry is the next pass ten minutes on, not the one after.
   */
  const deliverSecretTo = async (agentId: string, connectionIds: string[], clientId: string, passAt = Date.now()): Promise<void> => {
    const first = await withConnectionLock(agentId, async (): Promise<boolean> => {
      const a = store.getAgent(agentId);
      if (!a || a.state !== 'RUNNING' || !a.runtimeRef || isBusy(a.id) || a.migratedTo) return false;
      // Each address before the import, as an attach takes it: a connection
      // deleted meanwhile has none to read after, and its account stayed.
      const owed = connectionIds.flatMap((connectionId) => {
        const o = store.connectionOwedClientSecret('google', clientId, agentId, connectionId);
        return o ? [{ connectionId, never: !o.materializedAt, email: store.getConnection(connectionId)?.email }] : [];
      });
      if (!owed.length) return false;
      const deps = connSyncDeps(a.hostId);
      const results = await materializeConnections(deps, { id: a.id, slug: a.slug, runtimeRef: a.runtimeRef }, owed.map((o) => o.connectionId))
        .catch((err: unknown) => owed.map(({ connectionId }) => ({ connectionId, ok: false, error: String(err).slice(0, 200) })));
      let anyFirst = false;
      for (const o of owed) {
        const r = results.find((x) => x.connectionId === o.connectionId) ?? { ok: false, error: 'import failed' };
        // Detached or deleted during the import: off again, as an attach does.
        await offAgainIfDetached(deps, { id: a.id, runtimeRef: a.runtimeRef }, o.connectionId, o.email).catch(() => false);
        const key = `${agentId}\n${o.connectionId}`;
        if (r.ok) {
          secretRetries.delete(key);
          if (o.never) anyFirst = true;
          continue;
        }
        const fails = (secretRetries.get(key)?.fails ?? 0) + 1;
        secretRetries.set(key, { fails, at: passAt + Math.min(SECRET_RETRY_MS * 2 ** (fails - 1), SECRET_RETRY_MAX_MS) });
        trace(a.id)('connection.sync_failed', { error: String(r.error ?? 'import failed').slice(0, 200) });
      }
      return anyFirst;
    });
    // A first import: AGENTS.md names the accounts now, as after an attach (HB-0394). Once for them all.
    if (first) await syncGoogleDocs(agentId).catch(() => {});
  };
  /**
   * The running, free agents still owed it get it, one at a time, off the
   * request; a stopped one at its next start, wake or rebuild. One that was
   * busy, or whose import failed, was never asked again (HB-0463): the
   * 10-minute pass asks it (clientSecretSweep), backing off one that keeps
   * failing, and saving the client again, changed or not, asks at once.
   */
  const deliverClientSecret = (
    clientId: string,
    opts: { backoff?: boolean; owed?: OwedSecret[] } = {},
  ): { sent: { pushing: number; waiting: number }; done: Promise<void> } => {
    // The pass hands in the list it pruned its back-offs by: one query a pass.
    const owed = opts.owed ?? owedClientSecret(clientId);
    const now = Date.now();
    const due = owed.filter(({ agentId, connectionId, state, runtimeRef }) => state === 'RUNNING' && !!runtimeRef && !isBusy(agentId)
      && (!opts.backoff || (secretRetries.get(`${agentId}\n${connectionId}`)?.at ?? 0) <= now));
    // Grouped by agent: one connection turn, and one AGENTS.md, for its accounts.
    const byAgent = new Map<string, string[]>();
    for (const { agentId, connectionId } of due) byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), connectionId]);
    const done = (async () => {
      for (const [agentId, connectionIds] of byAgent) await deliverSecretTo(agentId, connectionIds, clientId, now).catch(() => {});
    })().catch(() => {});
    const pushing = new Set(due.map((d) => d.agentId));
    const waiting = new Set(owed.map((o) => o.agentId).filter((id) => !pushing.has(id)));
    return { sent: { pushing: pushing.size, waiting: waiting.size }, done };
  };
  /** Saving the client: everyone owed is asked at once, a back-off forgotten (the owner may have mended the cause). */
  const deliverClientSecretNow = (clientId: string): { pushing: number; waiting: number } => {
    secretRetries.clear();
    return deliverClientSecret(clientId).sent;
  };
  /**
   * The pass: the running agents still owed the configured client's secret,
   * from the records, so a restart loses nothing. Not while the last pass
   * still runs (undefined then); it ends when its imports have.
   */
  let secretPassRunning = false;
  const clientSecretSweep = async (): Promise<{ pushing: number; waiting: number } | undefined> => {
    if (secretPassRunning) return undefined;
    secretPassRunning = true;
    try {
      const c = await getOAuthClient();
      if (!c) return undefined;
      const owed = owedClientSecret(c.clientId);
      const owedNow = new Set(owed.map(({ agentId, connectionId }) => `${agentId}\n${connectionId}`));
      for (const key of secretRetries.keys()) if (!owedNow.has(key)) secretRetries.delete(key);
      const { sent, done } = deliverClientSecret(c.clientId, { backoff: true, owed });
      await done;
      return sent;
    } finally { secretPassRunning = false; }
  };

  // What is still owed every 10 minutes: a new Google client secret to a
  // running agent that did not take it (HB-0463). Off in tests (routes.ts
  // passes 0 there, as before).
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  if (deps.sweepEveryMs > 0) {
    sweepTimer = setInterval(() => {
      void clientSecretSweep().catch((err: unknown) => deps.warn({ err: String(err) }, 'client secret sweep failed'));
    }, deps.sweepEveryMs);
    sweepTimer.unref();
  }

  return {
    pushClientSecret, deliverClientSecret, deliverClientSecretNow, deliverSecretTo, clientSecretSweep,
    stop: () => { if (sweepTimer) clearInterval(sweepTimer); sweepTimer = undefined; },
  };
}
