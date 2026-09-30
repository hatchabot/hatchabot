import type { FastifyInstance } from 'fastify';
import type { Agent } from '../domain/types.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';
import { runWebChatTurn, webChatHistory, type WebChatRights } from '../orchestrator/webChat.js';
import { ownerIdOf } from './principal.js';

/**
 * Chat on the web (2026-09-29): the routes behind the member's 💬 Chat panel.
 * Allowed: the agent's owner, and an ACTIVE member the owner gave web chat.
 * The turn itself is runWebChatTurn (orchestrator/webChat.ts): a guest's is a
 * member's turn (no owner-only tools), the agent's owner's is the owner's.
 */
export interface WebChatDeps {
  store: Store;
  providerFor: (hostId: string) => RuntimeProvider;
  trace: (agentId: string) => (event: string, detail: Record<string, unknown>) => void;
  ensureAwake: (agent: Agent, why: string) => Promise<Agent>;
  /** A rebuild, a move, a change in progress (busy.ts). */
  isBusy: (agentId: string) => boolean;
  /** `${agentId} ${userId}` for each web turn in flight; the idle sweep reads it too. */
  inFlight: Set<string>;
  timeoutMs: number;
  /** After each turn (the sessions list the app caches is stale). */
  afterTurn?: (agentId: string) => void;
}

export const MAX_WEB_CHAT_CHARS = 8000;
const HOUR_MS = 3_600_000;

/** What a guest is told when the agent's gateway could not give them a member's (limited) turn. */
export const webChatNeedsRebuild = (name: string): string =>
  `${name} needs a rebuild before web chat works with guest rights. Rebuild ${name} to turn on guest rights for web chat — ask its owner.`;

/** Read per call, so a changed .env applies at the next restart and tests can tune it. */
function perHour(): number {
  const n = Number(process.env.HATCHABOT_WEB_CHAT_PER_HOUR);
  return Number.isFinite(n) && n >= 1 && process.env.HATCHABOT_WEB_CHAT_PER_HOUR !== '' ? Math.floor(n) : 60;
}

export const webChatKey = (agentId: string, userId: string): string => `${agentId} ${userId}`;
/** Is anyone mid-turn with this agent on the web? (Kept awake meanwhile.) */
export const webChatBusy = (inFlight: Set<string>, agentId: string): boolean =>
  [...inFlight].some((k) => k.startsWith(`${agentId} `));

export function registerWebChatRoutes(app: FastifyInstance, deps: WebChatDeps): void {
  const { store } = deps;
  // Turns started per (agent, person) in the last hour live in SQLite
  // (rate_hits), not memory: a restart — every deploy — used to hand everyone
  // a fresh hour (2026-09-30).
  const bucketOf = (key: string): string => `webchat:${key}`;

  /** The agent, when this caller may web-chat with it; else the refusal already sent. */
  const allowed = (id: string, userId: string, reply: any): Agent | undefined => {
    const agent = store.getAgent(id);
    // A stranger learns nothing about the agent: the same 404 as a wrong id.
    // Removed: said plainly (they knew the agent); nobody else learns it exists.
    if (agent && agent.state !== 'DELETED' && store.getMembership(agent.id, userId)?.status === 'revoked') {
      reply.code(403).send({ error: 'You were removed from this agent.' });
      return undefined;
    }
    if (!agent || agent.state === 'DELETED' || !store.accessRole(agent.id, userId)) {
      reply.code(404).send({ error: 'Not found' });
      return undefined;
    }
    if (!store.webChatAllowed(agent.id, userId)) {
      reply.code(403).send({ error: 'Web chat is not on for you with this agent. Ask its owner.' });
      return undefined;
    }
    return agent;
  };

  const nameOf = (agent: Agent, userId: string): string =>
    store.getMembership(agent.id, userId)?.displayName || (agent.ownerId === userId ? 'The owner' : 'Someone');

  app.post<{ Params: { id: string }; Body: { text?: string } }>('/v1/agents/:id/chat', async (req, reply) => {
    const me = ownerIdOf(req);
    const found = allowed(req.params.id, me, reply);
    if (!found) return reply;
    const text = String((req.body as { text?: string } | undefined)?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'Say something.' });
    if (text.length > MAX_WEB_CHAT_CHARS) return reply.code(413).send({ error: 'That message is over 8,000 characters.' });
    const key = webChatKey(found.id, me);
    if (deps.inFlight.has(key)) return reply.code(409).send({ error: 'It is still answering your last message.' });
    const now = Date.now();
    const times = store.rateHitsSince(bucketOf(key), now - HOUR_MS + 1);
    if (times.length >= perHour()) {
      const mins = Math.max(1, Math.ceil((times[0]! + HOUR_MS - now) / 60_000));
      return reply.code(429).send({ error: `That's ${perHour()} messages this hour — try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
    }
    // Asleep is not down: a message wakes it, as a chat-app message would.
    // Before this turn is marked in flight — the wake refuses an agent that
    // looks busy, and a web turn counts as busy to the idle sweep.
    const agent = found.hibernatedAt && found.state === 'STOPPED' ? await deps.ensureAwake(found, 'a web chat message') : found;
    if (deps.isBusy(agent.id)) return reply.code(409).send({ error: 'It is busy (being rebuilt or moved) — try again shortly.' });
    if (agent.state !== 'RUNNING' || !agent.runtimeRef) {
      return reply.code(409).send({ error: 'It is not running right now. Ask its owner to start it.' });
    }
    if (deps.inFlight.has(key)) return reply.code(409).send({ error: 'It is still answering your last message.' });
    deps.inFlight.add(key);
    try {
      store.addRateHit(bucketOf(key), now, HOUR_MS);
      // Characters only: what they said stays out of the event log.
      deps.trace(agent.id)('webchat.turn', { userId: me, chars: text.length });
      // The agent's owner keeps an owner's rights; everyone else has a member's —
      // what a Telegram member has: no scheduling, no settings.
      const rights: WebChatRights = agent.ownerId === me ? 'owner' : 'member';
      const res = await runWebChatTurn(deps.providerFor(agent.hostId), agent, { userId: me, displayName: nameOf(agent, me), text, rights }, deps.timeoutMs);
      deps.afterTurn?.(agent.id);
      switch (res.kind) {
        case 'reply':
          return { reply: res.text.slice(0, 50_000) || '(no reply)' };
        case 'timeout':
          return reply.code(504).send({ error: `No answer within ${Math.round(deps.timeoutMs / 1000)} s. It may still be working — reopen the chat in a little while.` });
        case 'busy':
          return reply.code(409).send({ error: 'It is still answering your last message.' });
        case 'owner-only':
          return reply.code(403).send({ error: 'Only its owner can do that. You can chat with it and ask it to use its tools, but not schedule tasks or change its settings.' });
        case 'needs-rebuild':
          // Never the owner's path instead: the guest is refused, the owner sees why in the activity.
          deps.trace(agent.id)('webchat.needs_rebuild', { userId: me, detail: res.detail.slice(0, 200) });
          return reply.code(409).send({ code: 'needs-rebuild', error: webChatNeedsRebuild(agent.name) });
        default:
          deps.trace(agent.id)('webchat.failed', { userId: me, code: res.code });
          return reply.code(502).send({ error: 'The turn did not complete. Try again; if it keeps failing, tell its owner.' });
      }
    } finally {
      deps.inFlight.delete(key);
    }
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id/chat', async (req, reply) => {
    const me = ownerIdOf(req);
    const agent = allowed(req.params.id, me, reply);
    if (!agent) return reply;
    // Nothing built yet, or being rebuilt/moved: nothing to read (and a stopped
    // volume is read off disk; a sleeping one is not woken just to look).
    if (!agent.runtimeRef || !['RUNNING', 'STOPPED'].includes(agent.state) || deps.isBusy(agent.id)) {
      return { messages: [], note: 'Its conversation cannot be read right now.' };
    }
    try {
      return { messages: await webChatHistory(deps.providerFor(agent.hostId), agent, me) };
    } catch (err) {
      app.log.warn({ agent: agent.id, err: String((err as Error).message ?? err) }, 'web chat history read failed');
      return reply.code(502).send({ error: "Couldn't read your conversation just now — try again." });
    }
  });
}
