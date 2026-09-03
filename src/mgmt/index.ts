/**
 * Management bot entry point: deterministic slash commands + an LLM assistant
 * (plain-language control and authoring, every change confirm-gated).
 *
 * Runs as its own process, separate from the control plane, and holds two
 * secrets from the environment: its own BotFather token and a cli-token that
 * grants it owner-level /v1 access. The LLM needs NO credential here — by
 * default calls ride the control plane's proxy (the 🛠 Management-flagged AI
 * source). Start it as a systemd unit — see deploy/agentclaw-mgmt-bot.service
 * and docs/control-interfaces.md.
 *
 * Required env:
 *   AGENTCLAW_MGMT_BOT_TOKEN   BotFather token for the management bot
 *   AGENTCLAW_MGMT_TOKEN       a cli-token (POST /v1/cli-tokens) — the bearer
 *   AGENTCLAW_MGMT_ALLOWLIST   comma-separated Telegram user ids allowed to control
 * Optional:
 *   AGENTCLAW_URL                    control plane base URL (default http://localhost:8080)
 *   AGENTCLAW_MGMT_OWNER             owner id for audit/proposer records (default "local")
 *   AGENTCLAW_MGMT_ANTHROPIC_KEY     dedicated LLM credential — overrides the proxy path
 *   AGENTCLAW_MGMT_MODEL             model for the dedicated-key path (default claude-sonnet-5)
 *   AGENTCLAW_MGMT_PAIRING_POLL_MS   approval-push poll interval (default 20000)
 */
import { readFileSync } from 'node:fs';
import { Bot } from 'grammy';
import { HttpApiClient } from './apiClient.js';
import { Broker } from './broker.js';
import { PendingStore } from './pendingStore.js';
import { ManagementBot } from './bot.js';
import { GrammyTransport } from './telegram.js';
import { createPairingNotifier } from './notifier.js';
import { LlmAgent } from './llm.js';
import { AnthropicChatModel } from './anthropicModel.js';
import { ProxyChatModel } from './proxyModel.js';

// Load .env.mgmt from the working directory if present, so `npm run mgmt` works
// straight after `agentclaw mgmt-bot setup`. Under systemd the EnvironmentFile
// has already set these — existing values win, so this never overrides them.
try {
  for (const line of readFileSync('.env.mgmt', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const key = t.slice(0, t.indexOf('='));
    let val = t.slice(t.indexOf('=') + 1);
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1).replace(/'\\''/g, "'");
    else if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  /* no .env.mgmt — rely on the ambient environment */
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env ${name}. See src/mgmt/index.ts header.`);
    process.exit(1);
  }
  return v;
}

const botToken = required('AGENTCLAW_MGMT_BOT_TOKEN');
const apiToken = required('AGENTCLAW_MGMT_TOKEN');
const baseUrl = process.env.AGENTCLAW_URL ?? 'http://localhost:8080';
const ownerId = process.env.AGENTCLAW_MGMT_OWNER ?? 'local';

// A management bot with NO allowlist would accept nobody (bot.ts rejects
// unknown ids), which is a silent misconfiguration. Refuse to start instead, so
// the operator sets it — never accidentally ship an open control bot.
const allowlist = (process.env.AGENTCLAW_MGMT_ALLOWLIST ?? '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
if (allowlist.length === 0) {
  console.error('AGENTCLAW_MGMT_ALLOWLIST is empty — set the Telegram id(s) allowed to control the fleet.');
  process.exit(1);
}

const api = new HttpApiClient(baseUrl, apiToken);
const pending = new PendingStore();
const broker = new Broker(api, pending, {
  audit: (event, detail) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...detail })),
});

// Phase 2: natural-language control via an LLM. Default path is the control
// plane's server-side proxy — it rides whichever AI source the owner flagged
// (⚙ Settings → AI sources), and this process never holds an AI credential.
// AGENTCLAW_MGMT_ANTHROPIC_KEY remains as an explicit override for a dedicated
// key. Either way the LLM proposes tools through the SAME broker, so it gains
// no extra authority; if no source is usable, each chat message answers with
// the server's clear 409 instead of silence.
const anthropicKey = process.env.AGENTCLAW_MGMT_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;
const llm = anthropicKey
  ? new LlmAgent(new AnthropicChatModel(anthropicKey, process.env.AGENTCLAW_MGMT_MODEL ?? 'claude-sonnet-5'), broker)
  : new LlmAgent(new ProxyChatModel(api), broker);

const bot = new Bot(botToken);
const transport = new GrammyTransport(bot.api);
const mgmt = new ManagementBot(broker, transport, { ownerId, allowlist, llm });

// Approval push: DM the owner a one-tap Approve card whenever an invitee
// messages one of their agents' bots, so a Telegram-only invite needs no web UI.
const pairingNotifier = createPairingNotifier(api, transport, allowlist, {
  intervalMs: Number(process.env.AGENTCLAW_MGMT_PAIRING_POLL_MS) || 20_000,
  log: (event, detail) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...detail })),
});
void pairingNotifier.tick(); // catch anyone already waiting at boot

bot.on('message:text', async (ctx) => {
  if (!ctx.from) return;
  await mgmt.onMessage(ctx.chat.id, ctx.from.id, ctx.message.text);
});

bot.on('callback_query:data', async (ctx) => {
  const cq = ctx.callbackQuery;
  if (!ctx.from || !cq.message) return;
  await mgmt.onCallback(cq.message.chat.id, ctx.from.id, cq.id, cq.data, cq.message.message_id);
});

bot.catch((err) => console.error('mgmt bot error', err.error));

// Drop resolved/expired confirmations periodically.
setInterval(() => pending.sweep(), 60_000).unref();

// Phase-A presence: heartbeat to the control plane every 30s so the web UI
// can show a live management-bot card (online/offline derives from seen_at).
// The llm string is resolved per beat: with a dedicated key it's the env
// model; on the proxy path it's whatever source the server picks right now.
const startHeartbeat = (botUsername: string) => {
  const beat = async () => {
    let llmLabel: string | undefined;
    if (anthropicKey) {
      llmLabel = process.env.AGENTCLAW_MGMT_MODEL ?? 'claude-sonnet-5';
    } else {
      try {
        const s = await api.llmStatus();
        // MgmtHeartbeat caps llm at 64 chars and a zod failure 400s the WHOLE
        // beat — profile names are unbounded, so an over-long label silently
        // killed the presence feature (audit 2026-09-03). Truncate, never fail.
        if (s.available) llmLabel = `${s.model} via ${s.profileName}`.slice(0, 64);
      } catch {
        /* status is best-effort; the beat itself still goes out */
      }
    }
    await api
      .heartbeat({
        botUsername,
        mode: broker.readWrite ? 'read-write' : 'read-only',
        llm: llmLabel,
        allowlisted: allowlist.length,
      })
      .catch((e) => console.error('mgmt heartbeat failed', (e as Error).message));
  };
  void beat();
  setInterval(() => void beat(), 30_000).unref();
};

await bot.start({
  onStart: (me) => {
    startHeartbeat(me.username);
    console.log(
      JSON.stringify({
        event: 'mgmt.up',
        bot: `@${me.username}`,
        baseUrl,
        allowlisted: allowlist.length,
        mode: broker.readWrite ? 'read-write' : 'read-only',
        llm: anthropicKey ? (process.env.AGENTCLAW_MGMT_MODEL ?? 'claude-sonnet-5') : 'via control-plane proxy',
      }),
    );
  },
});
