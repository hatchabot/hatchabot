import { InvalidBotTokenError, sameToken, verifyBotToken } from '../../channels/telegramManual.js';
import type { CompositeTelegramProvisioner } from '../../channels/composite.js';
import type { Agent } from '../../domain/types.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { botPollState, findExistingBot } from '../transfer/adopt.js';
import { refused, said, type Answer } from '../consult/answers.js';

/** The answer to a caller who does not own this machine (MACHINE_OWNER_ONLY's words in src/api/routeContext.ts). */
const MACHINE_OWNER_ONLY =
  'Only the account that set up this machine can do that — it touches the machine itself ' +
  '(its runtime images, hosts and runners), not just your own agents.';
/** The answer when the caller has failed too many token checks (TOKEN_CHECK_THROTTLED's words in src/api/routeContext.ts). */
const TOKEN_CHECK_THROTTLED = 'Too many token checks — wait a few minutes and try again.';

/** What POST /v1/agents/:id/channel-token sends: a BotFather token, a hand-built workspace whose bot to reuse, or "go on without a bot". */
export interface BotTokenAsk { token?: string | null; fromWorkspace?: string | null; webOnly?: unknown }
/** What the step's answer says: the bot taken (or the step already so answered), or web-only. */
export type BotTokenTaken = { username: string; stepAnswered: true } | { webOnly: true };
/** What the caller is, asked only where the old route asked it (each is a read of the request). */
export interface BotTokenCaller {
  /** The account that owns this machine (only it may name a host path). */
  ownsLocalHost: () => boolean;
  /** Too many failed token checks from this caller. */
  throttled: () => boolean;
  /** Count one failed token check. */
  noteFailure: () => void;
}

/**
 * The bot token a parked setup waits for (HB-0808 step 15, part C): the
 * owner pastes a BotFather token, reuses a hand-built workspace's bot (the
 * machine's owner only: it reads a host path), or goes on without a bot.
 * The token is a secret: checked with Telegram, held by the channel for
 * setup to take, compared by hash, never logged or answered. The step is
 * claimed with no wait between the check and the mark, and a post sent
 * again is answered as the first was. No state of its own.
 */
export interface BotTokenStep {
  /** Answer the agent's bot-token step (the route found the agent). Every answer that is not a refusal is a 202. */
  answer(agent: Agent, body: BotTokenAsk, caller: BotTokenCaller): Promise<Answer<BotTokenTaken>>;
}

export interface BotTokenStepDeps {
  store: Store;
  secrets: SecretStore;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The Telegram channel: the manual tokens held for setup and the pool. */
  channel: Pick<CompositeTelegramProvisioner, 'heldBot' | 'discardPending' | 'submitToken' | 'pool'>;
  /** Set the agent up, now or when a setup slot is free (the lifecycle's). */
  provisionWhenFree: (agentId: string) => void;
}

export function createBotTokenStep(deps: BotTokenStepDeps): BotTokenStep {
  const { store, secrets, trace, channel, provisionWhenFree } = deps;

  /**
   * The bot this agent holds for setup, or was set up with, when a post
   * brings that very token again. Compared by hash (sameToken); the token is
   * never logged.
   */
  const sameTokenAgain = async (agentId: string, token: string | undefined): Promise<string | undefined> => {
    if (!token) return undefined;
    const held = await channel.heldBot?.(agentId, token).catch(() => undefined);
    if (held) return held;
    const ch = store.getChannelForAgent(agentId);
    const taken = ch ? await secrets.get(ch.secretRef).catch(() => undefined) : undefined;
    return ch && taken !== undefined && sameToken(taken, token) ? ch.accountId : undefined;
  };

  // The parked-provisioning resume: user pasted their BotFather token.
  const answer: BotTokenStep['answer'] = async (agent, body, caller) => {
    // Open: parked on this very step and not answered yet. Anywhere else a
    // token was stashed, nothing ran, and the answer was 202 (HB-0064).
    const open = () => {
      const now = store.getAgent(agent.id);
      const step = now?.pendingAction;
      return now?.state !== 'DELETING' && now?.state !== 'DELETED' && step?.type === 'bot_token' && !step.received;
    };
    // The workspace's bot token, for a reuse post sent again (machine owner only, as below).
    const workspaceToken = () => {
      if (!body.fromWorkspace || !caller.ownsLocalHost()) return undefined;
      try { return findExistingBot(body.fromWorkspace)?.botToken; } catch { return undefined; }
    };
    // Not open: a post sent again (a proxy's 504 after this server took the
    // first) is answered as the first was; any other answer is refused.
    const notOpen = async (): Promise<Answer<BotTokenTaken>> => {
      const now = store.getAgent(agent.id);
      if (!now || now.state === 'DELETING' || now.state === 'DELETED') return refused(409, 'It is being deleted.');
      // "Go on without a bot" again: only where this agent's step was so answered.
      if (body.webOnly === true && now?.webOnly && store.telegramSkippedByOwner(agent.id)) return said({ webOnly: true });
      const again = await sameTokenAgain(agent.id, body.token?.trim() || workspaceToken());
      if (again) return said({ username: again, stepAnswered: true });
      return refused(409, now?.pendingAction?.type === 'bot_token' ? 'A bot token came in already, and setup is taking it.' : 'This agent is not waiting for a bot token.');
    };
    // The step stays until setup takes the answer (provision.ts), marked
    // answered meanwhile: cleared here, a setup still running or a restart
    // before setup ran left the agent with no step and no setup, and
    // reconcile failed it (HB-0542). Claimed with no wait between the
    // check and the mark: two posts at once both passed a check made before
    // their waits, and the second's token replaced the first's.
    const claim = () => {
      const step = store.getAgent(agent.id)!.pendingAction!;
      store.setAgentPendingAction(agent.id, { ...step, received: true });
    };
    // The step put back as it was (not asked again): a Clear stands.
    const unclaim = () => {
      const step = store.getAgent(agent.id)?.pendingAction;
      if (step?.received) store.setAgentPendingAction(agent.id, { type: step.type, instructions: step.instructions }, { keepClear: true });
    };
    if (!open()) return notOpen();
    // No bot to give it (the pool is empty and there is no spare token):
    // go on without Telegram — the agent becomes web-only, as if created so,
    // and provisioning resumes. A token held from before is not wanted now.
    if (body.webOnly === true) {
      store.setAgentWebOnly(agent.id, true);
      claim();
      channel.discardPending?.(agent.id);
      trace(agent.id)('telegram.skipped', { why: 'no bot available' });
      provisionWhenFree(agent.id);
      return said({ webOnly: true });
    }
    let token = body.token?.trim();
    // The bot's name, from Telegram, before the step is claimed: submitToken
    // then holds the token at once, with no other wait.
    let checked: string | undefined;
    if (token) {
      if (caller.throttled()) return refused(429, TOKEN_CHECK_THROTTLED);
      try { checked = await verifyBotToken(token); }
      catch (err) {
        if (err instanceof InvalidBotTokenError) { caller.noteFailure(); return refused(400, err.userMessage); }
        throw err;
      }
    }

    // Reuse: the bot a hand-built workspace already owns. Resolved here
    // rather than sent by the client, so the token stays on the server that
    // already holds it — a reuse flow that round-trips a live credential
    // through a terminal is a worse trade than the bot slot it saves.
    if (!token && body.fromWorkspace) {
      // Reading an OpenClaw config off an arbitrary host path is the same
      // host-path privilege as inspect/adopt — machine owner only.
      if (!caller.ownsLocalHost()) return refused(403, MACHINE_OWNER_ONLY);
      const existing = findExistingBot(body.fromWorkspace);
      if (!existing) {
        return refused(400,
          `No existing Telegram bot is bound to ${body.fromWorkspace}.`,
        );
      }
      // Deterministic check first: if that instance still has the account
      // switched on it will poll this bot, and two pollers on one token lose
      // messages silently rather than failing.
      // Telegram off for the whole instance is not the account off: switched
      // back on there, it polls this bot again (HB-1031). Said so, and how.
      if (existing.enabledInSource && existing.channelOffInSource) {
        return refused(409,
          `Telegram is switched off in your hand-built instance's config, but its account "${existing.accountId}" ` +
          `for "${existing.sourceAgentId}" is still on: switched back on there, Telegram would poll this bot in both copies. ` +
          `Switch that account off too (enabled: false under channels.telegram.accounts.${existing.accountId}), then try again.`,
        );
      }
      if (existing.enabledInSource) {
        return refused(409,
          `@${existing.accountId} is still enabled for "${existing.sourceAgentId}" in your ` +
          `hand-built instance. Turn it off there first, or both copies will fight over ` +
          `every message.`,
        );
      }
      if ((await botPollState(existing.botToken)) === 'busy') {
        return refused(409,
          `Something is still polling @${existing.accountId}. Stop it, then try again.`,
        );
      }
      try { checked = await verifyBotToken(existing.botToken); }
      catch (err) {
        if (err instanceof InvalidBotTokenError) return refused(400, err.userMessage);
        throw err;
      }
      token = existing.botToken;
    }
    if (!token || !checked) return refused(400, 'token required');
    // A spare pool bot's token went down the manual path and left its pool
    // row unleased; the pool later leased the same bot to the next agent,
    // which then failed with "already belongs to…" (audit, 2026-10-23). The
    // attach route refuses this; so does this step, for a pasted token and
    // for a workspace's alike: the workspace's was let through (HB-1091).
    // A token problem, not the agent's state: 400, so a client asks for another (the CLI's tokenTurnedDown).
    if (channel.pool.owns(checked)) {
      return refused(400, `@${checked} is a spare bot in the pool. Use "a ready bot from the pool" instead, or remove it from the pool first.`);
    }
    const inUseBy = store.findAgentUsingAccount(checked);
    if (inUseBy && inUseBy.id !== agent.id) {
      // Not taken: a later Retry would provision the agent onto the other
      // agent's bot, and both would poll the same token.
      return refused(400,
        `That bot is already connected to "${inUseBy.name}". Each agent needs its own bot — create another with @BotFather.`,
      );
    }
    // After every wait above: checked and claimed together.
    if (!open()) return notOpen();
    claim();
    let username: string;
    try {
      // Held in memory at once and on disk (telegramManual.ts) for setup to take.
      ({ username } = await channel.submitToken(agent.id, token, checked));
    } catch (err) {
      unclaim();
      channel.discardPending?.(agent.id);
      if (err instanceof InvalidBotTokenError) return refused(400, err.userMessage);
      throw err;
    }
    provisionWhenFree(agent.id);
    // `stepAnswered`: the step shows as setting up until setup takes the
    // token, so a step shown after this is a refusal (the CLI's pollAgent;
    // v2.177 and before showed it until then, and said nothing of it).
    return said({ username, stepAnswered: true });
  };

  return { answer };
}
