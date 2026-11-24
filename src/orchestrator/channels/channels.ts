import { createChatBots, type ChatBots, type ChatBotsDeps } from './chatBots.js';
import { createKnocks, type Knocks, type KnocksDeps } from './knocks.js';

/**
 * The channels service (HB-0808):
 * Telegram, Discord and Slack, the chat apps an agent answers on. Two parts,
 * each with its own state:
 *
 *  - `bots` (chatBots.ts): the bots themselves — the Slack and Discord
 *    connectors, a bot's name, the messages its people get from this
 *    machine, a parked bot taken from the spare pool, an agent stopped
 *    before its bot is handed on, and every bot this server holds a token
 *    for;
 *  - `knocks` (knocks.ts): the people asking to talk to an agent (pairing
 *    requests), which of them the owner hears about, and the agent's door.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route files on the shared context (`ctx.channels`). Nothing here
 * knows about HTTP: a route reads its request, asks this, and words the
 * answer. `stop()` ends both parts' timers.
 *
 * The Telegram provisioner itself (pool, pasted tokens: src/channels/) and
 * what a person may be let in by (orchestrator/members/members.ts, claim.ts) are
 * their own modules; this is what the API built on them.
 */
export interface Channels {
  bots: ChatBots;
  knocks: Knocks;
  /** End the timers (the bot names owed, the pairing sweep): at shutdown. */
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type ChannelsDeps = ChatBotsDeps & KnocksDeps;

export function createChannels(deps: ChannelsDeps): Channels {
  const bots = createChatBots(deps);
  const knocks = createKnocks(deps);
  return {
    bots, knocks,
    stop: () => { bots.stop(); knocks.stop(); },
  };
}
