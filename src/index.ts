import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from './store/store.js';
import { LocalSecretStore } from './secrets/localSecretStore.js';
import { MockProvider } from './providers/mockProvider.js';
import { TelegramPoolProvisioner } from './channels/telegramPool.js';
import { registerRoutes } from './api/routes.js';

const DB_PATH = process.env.AGENTCLAW_DB ?? 'data/agentclaw.sqlite';
const PORT = Number(process.env.PORT ?? 8080);

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

const store = new Store(db);
const secrets = new LocalSecretStore(db, LocalSecretStore.keyFromEnv());
const provider = new MockProvider();
const channel = new TelegramPoolProvisioner(db, secrets);

const app = Fastify({ logger: true });
await registerRoutes(app, { store, secrets, provider, channel });

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(
  { availableBots: channel.availableCount() },
  'AgentClaw control plane up (mock runtime provider)',
);
