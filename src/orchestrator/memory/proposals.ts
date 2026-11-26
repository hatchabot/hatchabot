import { randomUUID } from 'node:crypto';
import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { AgentBusyError, whileBusy } from '../lifecycle/busy.js';
import { refused, said, type Answer, type Refusal } from '../consult/answers.js';
import type { AgentTurns } from '../consult/consults.js';
import { workspacePath } from '../files/coreFiles.js';
import { TurnRefused } from '../files/coreFileTurns.js';
import { autoSnapshot, CoreFileTooBigError, MAX_FILE_BYTES, readCoreFile, SnapshotError, writeFileInAgent } from '../files/snapshots.js';
import { TransferError } from '../transfer/transfer.js';

/** A proposal waiting on a master, as the store lists it. */
export type Proposal = ReturnType<Store['listProposals']>[number];

/**
 * Child → master distillation and the owner's review (HB-0808 step 13): a
 * child's own model writes up what it learned, parked as a proposal on its
 * master; a merge appends it to the master's AGENTS.md (and its template
 * layer) in the master's core-files turn, snapshot first. Pushing the
 * merged playbook to the children is the push-definition route's, which the
 * route asks after a merge. No state of its own: the distillation takes the
 * child's one turn (`turns`), the merge the files turn and the busy flag.
 */
export interface Proposals {
  /** Why this child cannot distill now (no master, or three proposals already waiting), or nothing. */
  cannotDistill(child: Agent): Refusal | undefined;
  /** Run the distillation turn in a running child and park its text on the master. */
  distill(child: Agent, topic: string): Promise<Answer<{ id: string; text: string }>>;
  /** Merge a pending proposal into a running master's playbook (the route checked it is not busy). */
  merge(master: Agent, proposal: Proposal): Promise<Answer<{ merged: true }>>;
}

export interface ProposalsDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The one turn per agent (the consult service's `turns`). */
  turns: AgentTurns;
  /** The agent's core-files turn (the files service's). */
  withCoreFilesTurn: <T>(agentId: string, fn: () => Promise<T>) => Promise<T>;
  /** The agent as it is now, running, or the turn is refused in these words (the files service's). */
  freshRunning: (agentId: string, notRunning: (a: Agent) => string) => Agent & { runtimeRef: string };
  /** How long a distillation may take (HATCHABOT_ASK_TIMEOUT_MS). */
  askTimeoutMs: number;
}

export function createProposals(deps: ProposalsDeps): Proposals {
  const { store, providerFor, trace, turns, withCoreFilesTurn, freshRunning } = deps;
  const ASK_TIMEOUT_MS = deps.askTimeoutMs;
  // Built once per process, at its start: a merge the last one was in the
  // middle of is waiting for the owner again, not hidden as merged (HB-0888).
  const reopened = store.reopenInterruptedMerges();
  if (reopened) trace()('proposal.merges_reopened', { count: reopened });
  const snapshotDeps = (agent: Agent) => ({
    store,
    provider: providerFor(agent.hostId),
    log: trace(agent.id),
  });

  /**
   * Child → master distillation (the return half of the lineage flows). The
   * CHILD's own model writes up its generalizable learning — explicitly told
   * to strip names/specifics — and the result parks as a PROPOSAL on the
   * master for the owner's review. Nothing merges without the owner's click:
   * the owner is the privacy filter between one condo's history and the
   * template every other condo receives.
   */
  const cannotDistill: Proposals['cannotDistill'] = (child) => {
    if (!child.parentAgentId || !store.getAgent(child.parentAgentId) || store.getAgent(child.parentAgentId)!.state === 'DELETED') {
      return refused(400, 'This agent has no master to propose to.');
    }
    // The master may belong to a DIFFERENT owner (cross-household shares
    // record lineage too), and its owner is the one who has to review
    // these. Cap pending per child so a looped endpoint can't flood the
    // master's queue with 20KB blobs (10th audit).
    const alreadyPending = store.listProposals(child.parentAgentId)
      .filter((p) => p.childAgentId === child.id).length;
    if (alreadyPending >= 3) {
      return refused(409, 'This agent already has 3 proposals waiting on its master — they need review (or dismissal) first.');
    }
    return undefined;
  };

  const distill: Proposals['distill'] = async (child, topicSent) => {
    const topic = topicSent.trim().slice(0, 400);
    const prompt =
      'System note: write a proposal to improve the MASTER playbook you were derived from. ' +
      (topic ? `Focus: ${topic}. ` : '') +
      'Distill the most valuable GENERALIZABLE procedure or lesson you have learned in service — ' +
      'something every sibling agent should know. STRICT RULES: no names, no addresses, no amounts, ' +
      'no dates, no identifying specifics of the people or organization you serve — generalize ' +
      'everything. Output ONLY the proposal text as markdown (a heading + concise body), no preamble.';
    // A model turn: the provider's default exec timeout (60 s) killed any
    // distillation over a minute and called it "no usable distillation";
    // and held like a consult, so it does not interleave with one (audit, 2026-10-23).
    if (!turns.take(child.id)) return refused(429, 'It is already answering something — try again when that finishes.');
    let res;
    try {
      res = await providerFor(child.hostId).exec(child.runtimeRef!, [
        'agent', '--agent', child.slug, '-m', prompt,
      ], { timeoutMs: ASK_TIMEOUT_MS });
    } finally { turns.release(child.id); }
    const text = (res.stdout || '').trim();
    if (res.code !== 0 || text.length < 40) {
      return refused(502, 'The agent produced no usable distillation — try again or give a topic.');
    }
    // The master and the lineage as they are now, after the model's turn:
    // one deleted meanwhile got a proposal nobody could review, which
    // outlived its delete's clean-up (HB-1015).
    const master = store.getAgent(child.parentAgentId!);
    if (store.getAgent(child.id)?.parentAgentId !== child.parentAgentId || !master || master.state === 'DELETING' || master.state === 'DELETED') {
      return refused(409, 'Its master was deleted, or it was taken off it, while it wrote this: nothing was proposed.');
    }
    const id = randomUUID();
    store.insertProposal({
      id, masterAgentId: child.parentAgentId!, childAgentId: child.id, childName: child.name,
      text: text.slice(0, 20_000),
    });
    trace(child.id)('proposal.created', { masterAgentId: child.parentAgentId, proposalId: id });
    return said({ id, text: text.slice(0, 20_000) });
  };

  /** Owner's review verdict: merge appends to the master's AGENTS.md under a
   *  "Distilled learnings" section (snapshot first). */
  const merge: Proposals['merge'] = async (master, proposal) => {
    // Claim FIRST (atomic pending→merging): two concurrent merges both passed
    // the pending check and appended the text twice (10th audit). The loser
    // of the race now 404s here; a failed write below reopens the claim, and
    // one a restart cut off is reopened at the next start (HB-0888). It is
    // 'merged' only once the text is in.
    if (!store.resolveProposal(master.id, proposal.id, 'merging')) {
      return refused(404, 'No such pending proposal.');
    }
    const stamp = new Date().toISOString().slice(0, 10);
    // The proposal's id marks its block: a write that landed although its
    // answer was lost reopened the proposal, and the retry appended it a
    // second time (HB-0571). Found there, it is not written again.
    const mark = `(proposal ${proposal.id}) -->`;
    const distilledBlock = `\n\n<!-- distilled from ${proposal.childName}, ${stamp} ${mark}\n${proposal.text}\n`;
    const tooBig = (what: string) => new TransferError(
      `Merged, ${what} would be over ${MAX_FILE_BYTES / 1024}KB, which the master's files cannot be — trim its AGENTS.md before merging more. Nothing was merged; the proposal is still waiting.`,
    );
    try {
      // The files turn first, then the busy flag, as a file save takes
      // them: a snapshot by hand reading the files meanwhile kept the old
      // AGENTS.md with the new layer, or the reverse (HB-0566).
      await withCoreFilesTurn(master.id, () => whileBusy(master.id, 'proposal-merge', async () => {
        const fresh = freshRunning(master.id, () => 'Start the master to merge into its playbook.');
        // Keep the master's own template layer coherent: append the SAME block
        // to the raw placeholder-bearing layer. (Reading the live file back
        // froze its RENDERED text — placeholders gone — into the layer, so the
        // next Apply-values had nothing to substitute; 10th audit.) As it is
        // at its turn: a file saved meanwhile stored its own.
        const layerAgents = fresh.paramFiles?.agents !== undefined
          ? (fresh.paramFiles.agents ?? '').includes(mark) ? fresh.paramFiles.agents : `${(fresh.paramFiles.agents ?? '').trimEnd()}${distilledBlock}`
          : undefined;
        const path = workspacePath(fresh.slug, 'AGENTS.md');
        // Read as it is, capped: a corrupt multi-MB AGENTS.md fails loudly,
        // and one that is there but cannot be read (or a read that failed)
        // refuses the merge. `head … || true` read it as empty, and the
        // merge wrote the proposal alone over the whole playbook (audit #018).
        // Only a file that is not there starts empty.
        let existing: string | undefined;
        try {
          existing = await readCoreFile(providerFor(fresh.hostId), fresh.runtimeRef, fresh.slug, 'AGENTS.md');
        } catch (err) {
          if (err instanceof CoreFileTooBigError) throw new TransferError(`The master's AGENTS.md is over ${MAX_FILE_BYTES / 1024}KB — trim it before merging more.`);
          throw err;
        }
        // Found there: merged already, by a write whose answer was lost.
        if (!(existing ?? '').includes(mark)) {
          const merged = `${(existing ?? '').trimEnd()}${distilledBlock}`;
          // The result is held to the core-file limit too, not just what was
          // there: a merge past it made a playbook that editing, snapshots,
          // export and push all refuse (audit #019).
          if (Buffer.byteLength(merged, 'utf8') > MAX_FILE_BYTES) throw tooBig('its AGENTS.md');
          if (layerAgents !== undefined && Buffer.byteLength(layerAgents, 'utf8') > MAX_FILE_BYTES) throw tooBig('its AGENTS.md setup layer');
          await autoSnapshot(snapshotDeps(fresh), master.id, 'pre-edit');
          const b64 = Buffer.from(merged, 'utf8').toString('base64');
          const r = await writeFileInAgent(providerFor(fresh.hostId), fresh.runtimeRef, path, b64);
          if (r.code !== 0) throw new Error('write failed');
        }
        // Its one key: a persona changed during the write stays (HB-0567).
        // Before the turn ends, so a snapshot after it has the pair.
        if (layerAgents !== undefined) store.setAgentParamFile(master.id, 'agents', layerAgents);
      }));
    } catch (err) {
      store.reopenProposal(master.id, proposal.id);
      if (err instanceof TurnRefused) return refused(err.status, err.message);
      if (err instanceof AgentBusyError) return refused(409, err.userMessage);
      if (err instanceof TransferError) return refused(400, err.userMessage);
      if (err instanceof SnapshotError) return refused(502, `Couldn't read the master's playbook: ${err.userMessage} Nothing was merged; the proposal is still waiting.`);
      throw err;
    }
    store.finishProposalMerge(master.id, proposal.id);
    trace(master.id)('proposal.merged', { proposalId: proposal.id, from: proposal.childName });
    return said({ merged: true });
  };

  return { cannotDistill, distill, merge };
}
