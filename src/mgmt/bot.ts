import { AUTHORING_TOOLS, Broker, type AgentSummary, type Proposer, type ToolResult } from './broker.js';
import type { AgentSink, LlmAgent } from './llm.js';

/**
 * Transport-agnostic management bot logic: deterministic slash commands plus
 * the LLM plain-text path. It maps commands and confirm-button taps onto the broker
 * and renders the results. The actual Telegram transport (grammY, etc.) plugs in
 * behind BotTransport, so all of this is testable with a fake.
 *
 * The allowlist is enforced HERE, before the broker is ever touched, and the
 * broker enforces it again for mutates via the proposer identity.
 */

export interface InlineButton {
  text: string;
  data: string;
}

export interface BotTransport {
  sendMessage(chatId: number, text: string, buttons?: InlineButton[][]): Promise<{ messageId: number }>;
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
}

export interface ManagementBotOptions {
  ownerId: string;
  /** Telegram user ids permitted to control the fleet. */
  allowlist: Iterable<number>;
  /** Phase 2: if present, plain-text (non-slash) messages go to the LLM. */
  llm?: LlmAgent;
}

export class ManagementBot {
  #allow: Set<number>;
  #ownerId: string;
  #llm?: LlmAgent;

  constructor(
    private readonly broker: Broker,
    private readonly tx: BotTransport,
    opts: ManagementBotOptions,
  ) {
    this.#allow = new Set(opts.allowlist);
    this.#ownerId = opts.ownerId;
    this.#llm = opts.llm;
  }

  #who(chatId: number, fromUserId: number): Proposer {
    return { ownerId: this.#ownerId, chatId, fromUserId };
  }

  /** A text message from a user. */
  async onMessage(chatId: number, fromUserId: number, text: string): Promise<void> {
    if (!this.#allow.has(fromUserId)) {
      await this.tx.sendMessage(chatId, '⛔ Not authorized.');
      return;
    }
    const trimmed = text.trim();

    // Non-slash text is natural language → the LLM (Phase 2), if configured.
    // The LLM proposes tools through the SAME broker; mutations still confirm.
    if (!trimmed.startsWith('/')) {
      if (!this.#llm) {
        await this.tx.sendMessage(chatId, `I only understand commands here.\n${HELP}`);
        return;
      }
      const sink: AgentSink = {
        say: async (t) => void (await this.tx.sendMessage(chatId, t)),
        proposeCard: async (confirmId, summary) => this.#postCard(chatId, confirmId, summary),
      };
      try {
        await this.#llm.respond(this.#who(chatId, fromUserId), trimmed, sink);
      } catch (e) {
        await this.tx.sendMessage(chatId, `⚠ Assistant error: ${(e as Error).message}`);
      }
      return;
    }

    const [cmd, ...rest] = trimmed.split(/\s+/);
    const arg = rest.join(' ');

    switch (cmd) {
      case '/help':
      case '/start':
        return void (await this.tx.sendMessage(chatId, HELP));
      case '/mode': {
        if (rest[0] === 'readwrite') this.broker.setMode(true);
        else if (rest[0] === 'readonly') this.broker.setMode(false);
        else return void (await this.tx.sendMessage(chatId, 'Usage: /mode readwrite|readonly'));
        return void (await this.tx.sendMessage(chatId, `Mode: ${this.broker.readWrite ? 'read-write' : 'read-only'}`));
      }
      case '/pause':
        this.broker.pause();
        return void (await this.tx.sendMessage(chatId, '⏸ Paused — all tools disabled.'));
      case '/resume':
        this.broker.resume();
        return void (await this.tx.sendMessage(chatId, '▶ Resumed.'));
      case '/list':
        return this.#run(chatId, fromUserId, 'list_agents', rest[0] ? { state: rest[0].toUpperCase() } : {});
      case '/agent':
        return this.#run(chatId, fromUserId, 'get_agent', { agent: arg });
      case '/logs':
        return this.#run(chatId, fromUserId, 'get_logs', { agent: rest[0], lines: rest[1] ? Number(rest[1]) : undefined });
      case '/members':
        return this.#run(chatId, fromUserId, 'list_members', { agent: arg });
      case '/pending':
        return this.#run(chatId, fromUserId, 'list_pending', { agent: arg });
      case '/pool':
        return this.#run(chatId, fromUserId, 'get_pool', {});
      case '/events':
        return this.#run(chatId, fromUserId, 'list_events', {
          agent: rest[0],
          limit: rest[1] ? Number(rest[1]) : undefined,
        });
      case '/health':
        return this.#run(chatId, fromUserId, 'get_health', { agent: arg });
      case '/usage':
        return this.#run(chatId, fromUserId, 'get_usage', { agent: arg });
      case '/start_agent':
        return this.#run(chatId, fromUserId, 'start_agent', { agent: arg });
      case '/stop':
        return this.#run(chatId, fromUserId, 'stop_agent', { agent: arg });
      case '/rebuild':
        return this.#run(chatId, fromUserId, 'rebuild_agent', { agent: arg });
      case '/model':
        return this.#run(chatId, fromUserId, 'set_model', { agent: rest[0], model: rest[1] });
      case '/approve':
        return this.#run(chatId, fromUserId, 'approve_member', { agent: rest[0], code: rest[1] });
      default:
        return void (await this.tx.sendMessage(chatId, `Unknown command. ${HELP}`));
    }
  }

  async #run(chatId: number, fromUserId: number, tool: string, input: unknown): Promise<void> {
    const res = await this.broker.handleTool(tool, input, this.#who(chatId, fromUserId));
    await this.#render(chatId, res);
  }

  async #render(chatId: number, res: ToolResult): Promise<void> {
    if (!res.ok) {
      await this.tx.sendMessage(chatId, `⚠ ${res.error.code}: ${res.error.message}`);
      return;
    }
    if ('pending' in res) {
      await this.#postCard(chatId, res.pending.confirmId, res.pending.summary);
      return;
    }
    await this.tx.sendMessage(chatId, renderData(res.tool, res.data));
  }

  /** Post a mutate confirmation card and remember its message id, so both the
   *  slash path and the LLM path present confirmations identically.
   *
   *  Authoring/build proposals FIRST send the complete spec (full SOUL.md,
   *  AGENTS.md, Dockerfile lines) as plain messages, then the card. The tap is
   *  the review — a card whose preview clips at 14 lines while 24k chars
   *  execute let injected content ride below the fold (audit 2026-09-03).
   *  The card is a summary; the messages above it are the truth. */
  async #postCard(chatId: number, confirmId: string, summary: string): Promise<void> {
    const rec = this.broker.pending.peek(confirmId);
    const spec = rec?.resolved.spec;
    if (spec) {
      const full: Array<[string, string | undefined]> = [
        ['SOUL.md', spec.soul],
        ['AGENTS.md', spec.agentsMd],
        ['Dockerfile lines', spec.dockerfile],
      ];
      for (const [label, text] of full) {
        if (typeof text !== 'string' || !text.length) continue;
        // Telegram messages cap at 4096 chars — chunk, labeled and numbered.
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += 3500) chunks.push(text.slice(i, i + 3500));
        for (let i = 0; i < chunks.length; i++) {
          await this.tx.sendMessage(
            chatId,
            `📄 ${label}${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''} — full content:\n${chunks[i]}`,
          );
        }
      }
    }
    const { messageId } = await this.tx.sendMessage(chatId, `Confirm: ${summary}?`, [
      [
        { text: '✅ Confirm', data: `cfm:${confirmId}:y` },
        { text: '✖ Cancel', data: `cfm:${confirmId}:n` },
      ],
    ]);
    this.broker.pending.attachMessage(confirmId, messageId);
  }

  /** A button tap. `data` is `cfm:<id>:<y|n>`. */
  async onCallback(
    chatId: number,
    fromUserId: number,
    callbackId: string,
    data: string,
    messageId: number,
  ): Promise<void> {
    if (!this.#allow.has(fromUserId)) {
      await this.tx.answerCallback(callbackId, 'Not authorized');
      return;
    }
    // Approval-push buttons: one tap to admit or turn away a pending joiner the
    // notifier surfaced. `apr:<agentId>:<code>` / `apd:<agentId>:<code>`.
    const join = /^(apr|apd):([0-9a-f-]{16,40}):([A-Za-z0-9]{4,16})$/.exec(data);
    if (join) {
      const [, kind, agentId, code] = join;
      const approving = kind === 'apr';
      const who = this.#who(chatId, fromUserId);
      const out = approving
        ? await this.broker.approveJoin(agentId!, code!, who)
        : await this.broker.denyJoin(agentId!, code!, who);
      if (!out.ok) {
        await this.tx.answerCallback(callbackId, out.message.slice(0, 190));
        return;
      }
      await this.tx.answerCallback(callbackId, approving ? 'Approved' : 'Turned away');
      await this.tx.editMessage(
        chatId,
        messageId,
        approving
          ? '✅ Let in — they can chat with the agent now.'
          : '🚫 Turned away. Not a ban — they can ask again by messaging the bot.',
      );
      return;
    }
    const m = /^cfm:([A-Za-z0-9_-]+):(y|n)$/.exec(data);
    if (!m) {
      await this.tx.answerCallback(callbackId, 'Unrecognized');
      return;
    }
    const id = m[1]!;
    const yn = m[2]!;
    // Authoring confirms do real work (create agent → wait for RUNNING → write
    // files) that outlives Telegram's ~15s callback window — answer the tap
    // first and mark the card as working, so the button never hangs and a late
    // answerCallback never throws. The slow path is PROPOSER-BOUND: a second
    // operator's tap must fall through to claim() and get "not yours" as a
    // toast — editing the card first destroyed a still-pending proposal
    // (editMessageText drops the inline keyboard) and lied "Already handled"
    // (audit 2026-09-03).
    const peeked = this.broker.pending.peek(id);
    const slow =
      yn === 'y' &&
      peeked?.status === 'pending' &&
      AUTHORING_TOOLS.has(peeked.tool) &&
      peeked.fromUserId === fromUserId &&
      peeked.chatId === chatId;
    if (slow) {
      await this.tx.answerCallback(callbackId);
      await this.tx.editMessage(chatId, messageId, '⏳ Working — this can take a minute…');
      // DETACHED: a confirmed create awaits provisioning for up to 150s, and
      // grammY processes updates sequentially — awaiting here froze every
      // other message and button behind one build (audit 2026-09-03 backlog
      // #1). The claim is single-use, so nothing can double-run; the card is
      // the completion signal.
      void this.broker
        .confirm(id, 'confirm', { fromUserId, chatId })
        .then(async (out) => {
          if (!out.ok) {
            await this.tx.editMessage(chatId, messageId, '⚠ Already handled.');
            return;
          }
          await this.tx.editMessage(chatId, out.rec.messageId || messageId, out.text);
        })
        .catch(async (e) => {
          await this.tx
            .editMessage(chatId, messageId, `⚠ Failed: ${String((e as Error).message ?? e).slice(0, 300)}`)
            .catch(() => {});
        });
      return;
    }
    const out = await this.broker.confirm(id, yn === 'y' ? 'confirm' : 'cancel', { fromUserId, chatId });
    if (!out.ok) {
      const why =
        out.reason === 'expired' ? 'Expired'
        : out.reason === 'not_yours' ? 'Not your confirmation'
        : 'Already handled';
      await this.tx.answerCallback(callbackId, why);
      return;
    }
    await this.tx.answerCallback(callbackId);
    await this.tx.editMessage(chatId, out.rec.messageId || messageId, out.text);
  }
}

const HELP = [
  'Fleet: /list [state] · /agent <ref> · /logs <ref> [n] · /members <ref> · /pending <ref> · /pool · /events [ref] [n]',
  'Check: /health <ref> · /usage <ref>',
  'Change (needs /mode readwrite): /stop <ref> · /start_agent <ref> · /rebuild <ref> · /model <ref> <model> · /approve <ref> <code>',
  'Author (plain language, needs /mode readwrite): ask me to draft a new agent or rewrite one\'s definition — you approve the full spec on a card before anything is created or changed.',
  'Images (plain language): runtime/upgrade status, list derived images, build/rebuild/delete them — builds show their Dockerfile lines on the card first.',
  'Safety: /mode readwrite|readonly · /pause · /resume',
].join('\n');

function renderData(tool: string, data: unknown): string {
  if (tool === 'list_agents' && Array.isArray(data)) {
    const rows = (data as AgentSummary[]).map(
      (a) => `• ${a.name} — ${a.state}${a.model ? ` · ${a.model}` : ''}`,
    );
    return rows.length ? rows.join('\n') : 'No agents.';
  }
  if (tool === 'get_pool' && data && typeof data === 'object') {
    return `Bots available: ${(data as { availableBots: number }).availableBots}`;
  }
  if (tool === 'get_runtime' && data && typeof data === 'object') {
    const r = data as { imageVersion?: string; npmLatest?: string; upgradeAvailable: boolean };
    return `Base image: OpenClaw ${r.imageVersion ?? 'unknown'} · npm latest ${r.npmLatest ?? 'unknown'} · ${
      r.upgradeAvailable ? '⬆ upgrade available (base builds run on the host: scripts/build-runtime.sh)' : '✓ up to date'
    }`;
  }
  if (tool === 'list_images' && data && typeof data === 'object') {
    const d = data as { base: string; images: Array<{ name: string; status: string; pinnedBy: number; error?: string }> };
    const rows = (d.images ?? []).map(
      (i) => `• ${i.name} — ${i.status}${i.pinnedBy ? ` · pinned by ${i.pinnedBy}` : ''}${i.error ? ` · ⚠ ${i.error.slice(0, 120)}` : ''}`,
    );
    return `Base: ${d.base}\n${rows.join('\n') || 'No derived images.'}`;
  }
  if (tool === 'get_image_log' && data && typeof data === 'object') {
    const l = data as { status: string; error?: string; log: string };
    return `${l.status}${l.error ? ` — ${l.error}` : ''}\n\`\`\`\n${(l.log || '(no log)').slice(-3000)}\n\`\`\``;
  }
  if (tool === 'get_logs' && typeof data === 'string') {
    return data.slice(-3500) || '(no logs)';
  }
  if (tool === 'list_events' && Array.isArray(data)) {
    const rows = (data as Array<{ agentName?: string; event: string }>).map(
      (e) => `• ${e.agentName ?? 'agent'} — ${e.event.replace(/[._]/g, ' ')}`,
    );
    return rows.length ? rows.join('\n') : 'No recent activity.';
  }
  if (tool === 'get_health' && data && typeof data === 'object') {
    const h = data as any;
    const label = { healthy: '✅ responding', degraded: '⚠️ degraded', unreachable: '❌ not answering' }[h.status as string] ?? String(h.status);
    const bits = [label];
    if (h.reachable && h.telegram) bits.push(`telegram ${h.telegram.connected ? 'connected' : `disconnected${h.telegram.lastError ? ` (${h.telegram.lastError})` : ''}`}`);
    if (h.eventLoop?.degraded) bits.push('event loop degraded');
    if (h.pluginErrors?.length) bits.push(`${h.pluginErrors.length} plugin error(s)`);
    return bits.join(' · ');
  }
  if (tool === 'get_usage' && data && typeof data === 'object') {
    const u = data as any;
    if (!u.sessions) return 'No sessions yet.';
    const rows = (u.byModel ?? []).map((m: any) => `• ${m.model} — ${m.tokens}`);
    return `${u.totalTokens} tokens · ${u.sessions} session(s)\n${rows.join('\n')}`;
  }
  return '```\n' + JSON.stringify(data, null, 2).slice(0, 3500) + '\n```';
}
