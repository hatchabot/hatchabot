import { createContextRecovery, type ContextRecovery, type ContextRecoveryDeps } from './contextRecovery.js';
import { createMemoryTurns, type MemoryTurns, type MemoryTurnsDeps } from './memoryTurns.js';
import { createProposals, type Proposals, type ProposalsDeps } from './proposals.js';
import { createTokenSteward, type TokenSteward, type TokenStewardDeps } from './tokenSteward.js';

/**
 * An agent's memory and the turns that run in its conversation (HB-0808
 * step 13, part 2c). Four parts:
 *
 *  - `turns` (memoryTurns.ts): a checkpoint (save the conversation to memory
 *    now) and an owner's ask;
 *  - `history` (contextRecovery.ts): the chat history read, and Recover
 *    context, with its slots (`recovering`), which a source switch's
 *    rebuild reserves too (`afterRebuild`, handed to the AI sources
 *    service);
 *  - `steward` (tokenSteward.ts): compact a conversation, and the context
 *    cap;
 *  - `proposals` (proposals.ts): a child's distillation, and its merge into
 *    the master's playbook.
 *
 * Built once in `registerRoutes` and on the route context as `ctx.memory`;
 * its routes are in src/api/chat/memoryRoutes.ts. The checkpoint, the ask and
 * the distillation take the agent's one turn, the consult service's
 * `turns` (`a2aInFlight`), so none of them interleaves with a consult.
 * Nothing here knows HTTP. `stop()` ends the recovery slots' timers.
 */
export interface AgentMemory {
  turns: MemoryTurns;
  history: ContextRecovery;
  steward: TokenSteward;
  proposals: Proposals;
  /** End the timers (the recovery slots'): at shutdown. */
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type AgentMemoryDeps = MemoryTurnsDeps & ContextRecoveryDeps & TokenStewardDeps & ProposalsDeps;

export function createAgentMemory(deps: AgentMemoryDeps): AgentMemory {
  const turns = createMemoryTurns(deps);
  const history = createContextRecovery(deps);
  const steward = createTokenSteward(deps);
  const proposals = createProposals(deps);
  return {
    turns, history, steward, proposals,
    stop: () => { history.stop(); },
  };
}
