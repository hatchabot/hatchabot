import { defaultDbPath } from '../src/envCompat.js'; // first import: aliases AGENTCLAW_* env on load
/**
 * Admin tool: add hand-minted BotFather bots to the instant pool.
 *
 *   HATCHABOT_SECRET_KEY=… npx tsx scripts/pool-add.ts <token> [<token>…]
 *
 * Each token is verified against Telegram (getMe) before storing, so a typo
 * fails here instead of during someone's agent creation.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LocalSecretStore } from '../src/secrets/localSecretStore.js';
import { TelegramPoolProvisioner } from '../src/channels/telegramPool.js';
import { verifyBotToken } from '../src/channels/telegramManual.js';

const tokens = process.argv.slice(2);
if (tokens.length === 0) {
  console.error('Usage: pool-add.ts <bot-token> [<bot-token>…]');
  process.exit(1);
}

const DB_PATH = process.env.HATCHABOT_DB ?? defaultDbPath();
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
const secrets = new LocalSecretStore(db, LocalSecretStore.keyFromEnv());
const pool = new TelegramPoolProvisioner(db, secrets);

for (const token of tokens) {
  try {
    const username = await verifyBotToken(token);
    await pool.addToPool(username, token);
    console.log(`✅ @${username} added to pool`);
  } catch (err) {
    console.error(`❌ token ${token.slice(0, 12)}…: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
console.log(`Pool now has ${pool.availableCount()} available bot(s).`);
