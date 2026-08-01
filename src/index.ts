import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from './store/store.js';
import { LocalSecretStore } from './secrets/localSecretStore.js';
import { MockProvider } from './providers/mockProvider.js';
import { LocalDockerProvider } from './providers/localDockerProvider.js';
import { TelegramPoolProvisioner } from './channels/telegramPool.js';
import { TelegramManualProvisioner } from './channels/telegramManual.js';
import { CompositeTelegramProvisioner } from './channels/composite.js';
import { registerRoutes } from './api/routes.js';
import { registerAuth } from './api/auth.js';
import { reconcileAgents } from './orchestrator/reconcile.js';
import type { RuntimeProvider } from './providers/provider.js';

const DB_PATH = process.env.AGENTCLAW_DB ?? 'data/agentclaw.sqlite';
const PORT = Number(process.env.PORT ?? 8080);

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
// The DB holds encrypted secrets AND cleartext gateway tokens — no other
// local user has any business reading it. (WAL siblings too.)
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try {
    chmodSync(f, 0o600);
  } catch {
    /* not created yet — sqlite makes them on first write */
  }
}

const store = new Store(db);
const secrets = new LocalSecretStore(db, LocalSecretStore.keyFromEnv());
const pool = new TelegramPoolProvisioner(db, secrets);
const manual = new TelegramManualProvisioner(secrets);
const channel = new CompositeTelegramProvisioner(pool, manual);

const providers = new Map<string, RuntimeProvider>();
providers.set('mock', new MockProvider());
providers.set('local-docker', new LocalDockerProvider({ image: process.env.AGENTCLAW_IMAGE }));

// This box is a host from day one — the MVP is local-first (see memory:
// agentclaw-retail-pivot). A stable id keeps re-runs from duplicating it.
const LOCAL_HOST_ID = 'host-local-default';
if (!store.getHost(LOCAL_HOST_ID)) {
  store.insertHost({
    id: LOCAL_HOST_ID,
    ownerId: 'dev-owner',
    kind: 'local',
    provider: 'local-docker',
    name: `This machine (${hostname()})`,
    settings: {},
    createdAt: new Date().toISOString(),
  });
}

const app = Fastify({ logger: true });

// Mend any state drift from reboots/crashes before serving a single request —
// containers auto-restart with the box, the DB doesn't know that.
await reconcileAgents(store, providers, (e, d) => app.log.info(d, e));
await registerAuth(app, {
  password: process.env.AGENTCLAW_PASSWORD,
  secret: LocalSecretStore.keyFromEnv(),
});
await registerRoutes(app, {
  store,
  secrets,
  providers,
  channel,
  webIndexPath: resolve(import.meta.dirname, '../web/index.html'),
  webJoinPath: resolve(import.meta.dirname, '../web/join.html'),
  publicUrl: process.env.AGENTCLAW_PUBLIC_URL,
});

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(
  { availableBots: pool.availableCount(), localHostId: LOCAL_HOST_ID, url: `http://localhost:${PORT}` },
  'AgentClaw control plane up',
);
