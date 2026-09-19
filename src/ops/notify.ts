/**
 * Telling the management agent what happened, in its own conversation.
 *
 * A change it files is executed by Hatchabot after the owner presses Confirm,
 * and a base or derived image build then runs for minutes. Until now none of
 * that reached the agent: its chat went quiet and the owner had to ask it what
 * had happened (reported 2026-09-19). Hatchabot now posts a short note into the
 * agent's own conversation when a change resolves and when a background build
 * ends, so the console shows the outcome without being asked.
 *
 * Notes are a courtesy, never part of the change: a failure here is logged and
 * dropped. They are serialised per agent, so two builds finishing together
 * cannot run two turns at once.
 */

export interface OpsNoteAgent {
  id: string;
  slug: string;
  hostId: string;
  state: string;
  runtimeRef?: string;
}

export interface OpsNotifyDeps {
  /** The owner's management agent, if they have one. */
  opsAgent(ownerId: string): OpsNoteAgent | undefined;
  /** Run one turn in that agent's own conversation. */
  runTurn(agent: OpsNoteAgent, message: string): Promise<{ ok: boolean; error?: string }>;
  log?(event: string, detail: Record<string, unknown>): void;
}

/**
 * The note as the agent sees it. Framed as Hatchabot's own voice and marked
 * automatic, so it is never mistaken for the owner asking for something — and
 * it says to report, not to act.
 */
export function opsNoteText(body: string): string {
  return (
    '[Hatchabot note — automatic, from Hatchabot itself, not from a person. ' +
    body.trim() +
    ' Tell your owner what this means, in one or two lines. Do not file another change unless they ask.]'
  );
}

export interface OpsNotifier {
  /** Fire-and-forget; the promise is for tests. */
  notify(ownerId: string, body: string): Promise<void>;
}

export function createOpsNotifier(deps: OpsNotifyDeps): OpsNotifier {
  const chains = new Map<string, Promise<void>>();
  return {
    notify(ownerId, body) {
      const agent = deps.opsAgent(ownerId);
      // No manager, or one that cannot take a turn right now (stopped,
      // rebuilding, moving): the outcome is still on the home screen.
      if (!agent || agent.state !== 'RUNNING' || !agent.runtimeRef) return Promise.resolve();
      const prev = chains.get(agent.id) ?? Promise.resolve();
      const next = prev
        .then(async () => {
          const r = await deps
            .runTurn(agent, opsNoteText(body))
            .catch((err) => ({ ok: false, error: String((err as Error)?.message ?? err) }));
          deps.log?.('ops.note', { agentId: agent.id, ok: r.ok, ...(r.ok ? {} : { error: String(r.error ?? '').slice(0, 200) }) });
        })
        .catch(() => {});
      chains.set(agent.id, next);
      void next.then(() => { if (chains.get(agent.id) === next) chains.delete(agent.id); });
      return next;
    },
  };
}
