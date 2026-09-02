/**
 * Management bot entry point (Phase 1: deterministic slash commands, no LLM).
 *
 * Runs as its own process, separate from the control plane, and holds two
 * secrets from the environment: its own BotFather token and a cli-token that
 * grants it owner-level /v1 access. Start it as a systemd unit — see
 * deploy/agentclaw-mgmt-bot.service and docs/control-interfaces.md.
 *
 * Required env:
 *   AGENTCLAW_MGMT_BOT_TOKEN   BotFather token for the management bot
 *   AGENTCLAW_MGMT_TOKEN       a cli-token (POST /v1/cli-tokens) — the bearer
 *   AGENTCLAW_MGMT_ALLOWLIST   comma-separated Telegram user ids allowed to control
 * Optional:
 *   AGENTCLAW_URL              control plane base URL (default http://localhost:8080)
 *   AGENTCLAW_MGMT_OWNER       owner id for audit/proposer records (default "local")
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

// Phase 2 (optional): natural-language control via an LLM. Enabled only when an
// Anthropic key is present — without it, the bot is slash-commands only. The LLM
// proposes tools through the SAME broker, so it gains no extra authority.
const anthropicKey = process.env.AGENTCLAW_MGMT_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;
const llm = anthropicKey
  ? new LlmAgent(new AnthropicChatModel(anthropicKey, process.env.AGENTCLAW_MGMT_MODEL ?? 'claude-sonnet-5'), broker)
  : undefined;

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
const llmModel = llm ? (process.env.AGENTCLAW_MGMT_MODEL ?? 'claude-sonnet-5') : undefined;
const startHeartbeat = (botUsername: string) => {
  const beat = () =>
    api
      .heartbeat({
        botUsername,
        mode: broker.readWrite ? 'read-write' : 'read-only',
        llm: llmModel,
        allowlisted: allowlist.length,
      })
      .catch((e) => console.error('mgmt heartbeat failed', (e as Error).message));
  void beat();
  setInterval(beat, 30_000).unref();
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
        llm: llmModel ?? 'off (no API key)',
      }),
    );
  },
});
