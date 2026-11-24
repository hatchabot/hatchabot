import { randomUUID } from 'node:crypto';
import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { importTemplate, readTemplate, templateParameters } from './template.js';
import type { Copies } from './copies.js';

/** Who is asking, as a share needs it: their account, and the address a share to them is sent to. */
export interface ShareCaller { ownerId: string; email?: string }

/**
 * Sharing an agent in the app (HB-0808 step 12): its template sent to
 * another account's inbox (the same bytes as a shared file, with no bot,
 * members or secrets), the inbox, and a share accepted (a fresh agent the
 * recipient owns, with their own bot) or turned away.
 *
 * Its state: none. A share is the store's (`shares`); one accepted is
 * claimed before anything is made, and put back when the import fails.
 *
 * Nothing here knows about HTTP: a route checks who is asking and what they
 * sent, asks this, and words the answer.
 */
export interface Inbox {
  /** Send its template to `toEmail`'s inbox. 'too-large' past 8 MB; TransferError when it cannot be made. */
  send(agent: Agent, from: ShareCaller, toEmail: string, message: string | undefined): Promise<'sent' | 'too-large'>;
  /**
   * The shares waiting for the caller, each with its template's setup fields
   * (none when its file does not read): kept beside the share when it was
   * sent, so a list does not inflate every file (HB-0960).
   */
  list(me: ShareCaller): Promise<Array<Record<string, unknown>>>;
  /**
   * Stand a claimed share up as a fresh agent the caller owns, set up in the
   * background. On a failure the share is put back for another try and the
   * error thrown (TransferError for the file's refusals).
   */
  accept(shareId: string, share: { blob: Buffer; sourceAgentId?: string | null }, me: ShareCaller, o: { name?: string; aiProfileId?: string; hostId?: string; values?: Record<string, string>; onRow?: () => void }): Promise<{ agent: Agent; needs: unknown }>;
}

/** What the inbox needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface InboxDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Set up a new agent in the background (the setup and rebuild queue). */
  kickProvision: (agentId: string, opts?: { webOnlyIfNoBot?: boolean }) => void;
  /** The setup answers' credentials and repo bindings (the copies' `materializeImportEffects`), and its template as sent. */
  copies: Pick<Copies, 'materializeImportEffects' | 'template'>;
}

export function createInbox(deps: InboxDeps): Inbox {
  const { store, providerFor, trace, kickProvision } = deps;
  const { materializeImportEffects } = deps.copies;
  return {
    send: async (agent, me, toEmail, message) => {
      // The template is exactly what a shared file carries: SOUL/AGENTS,
      // its tasks, declared needs, NO bot/members/secrets — and whatever
      // personal notes the agent wrote there, which the dialog showed first.
      // In its core-files turn, as every copy of its template is made (copies.ts, HB-0964).
      const { data } = await deps.copies.template(agent, false);
      if (data.length > 8 * 1024 * 1024) return 'too-large';
      // Its setup fields, read once here, as the list shows them (HB-0960).
      const parameters = await templateParameters(data);
      store.insertShare({
        id: randomUUID(),
        fromOwner: me.ownerId,
        fromEmail: me.email,
        toEmail,
        // Bind now if the recipient has signed in; else it binds on their
        // first sign-in (claimSharesForEmail).
        toOwner: store.ownerForEmail(toEmail),
        agentName: agent.name,
        message: message?.slice(0, 500),
        blob: data,
        parameters,
        createdAt: new Date().toISOString(),
        sourceAgentId: agent.id, // lineage: an accepted copy records its master
      });
      return 'sent';
    },

    list: async (me) => {
      // Each share with its template's setup fields, so the Import dialog can
      // render the form before accepting. They are kept beside the share:
      // read from every file on every list, a full inbox inflated them all
      // in one go and held every other request up (HB-0960). A share sent
      // before they were kept has its file read once, off the event loop,
      // and its fields kept then. Best-effort: a share whose file won't
      // parse still lists, with none (Accept will surface the real error).
      const out: Array<Record<string, unknown>> = [];
      for (const { parameters, ...s } of store.listInbox(me.ownerId, me.email)) {
        if (parameters) { out.push({ ...s, parameters }); continue; }
        const blob = store.getShareFor(s.id, me.ownerId, me.email)?.blob;
        if (!blob) { out.push({ ...s, parameters: [] }); continue; }
        const read = await templateParameters(blob);
        store.setShareParameters(s.id, read);
        out.push({ ...s, parameters: read });
      }
      return out;
    },

    accept: async (shareId, share, me, body) => {
      const host = body.hostId ? undefined : store.listHosts(me.ownerId).find((h) => h.kind === 'local');
      try {
        // Read off the event loop, then made in one turn (HB-1162).
        const manifest = await readTemplate(share.blob);
        const { agent, needs, envValues, dataSourceValues } = importTemplate(
          { store, provider: providerFor((body.hostId ?? host?.id)!), log: trace() },
          manifest,
          { ownerId: me.ownerId, name: body.name?.trim(), aiProfileId: body.aiProfileId, hostId: body.hostId ?? host?.id, values: body.values },
        );
        body.onRow?.();
        await materializeImportEffects(agent, envValues, dataSourceValues, { shareId });
        // Lineage: if the master still lives on this installation, record it —
        // the fleet view groups children under it and the master's push-
        // definition flow targets them.
        if (share.sourceAgentId && store.getAgent(share.sourceAgentId)?.state !== 'DELETED' && store.getAgent(share.sourceAgentId)) {
          store.setAgentParent(agent.id, share.sourceAgentId);
        }
        kickProvision(agent.id, { webOnlyIfNoBot: true });
        return { agent, needs };
      } catch (err) {
        store.reopenShare(shareId);
        throw err;
      }
    },
  };
}
