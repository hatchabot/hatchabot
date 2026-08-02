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
import { authModeFromEnv, registerAuth } from './api/auth.js';
import { identityConfigFromEnv, IdentityVerifier } from './api/identity.js';
import { reconcileAgents, startReconcileLoop } from './orchestrator/reconcile.js';
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

// Keep the main DB file current. In WAL mode all writes land in -wal until a
// checkpoint, so an un-checkpointed database copies as an EMPTY file — which
// has already produced one worthless backup on this host.
db.pragma('wal_autocheckpoint = 256');

const store = new Store(db);
const secrets = new LocalSecretStore(db, LocalSecretStore.keyFromEnv());
const pool = new TelegramPoolProvisioner(db, secrets);
const manual = new TelegramManualProvisioner(secrets);
const channel = new CompositeTelegramProvisioner(pool, manual);

let adoptionChecked = false;
const providers = new Map<string, RuntimeProvider>();
providers.set('mock', new MockProvider());
// AGENTCLAW_PREFIX namespaces docker container/volume names so a second
// installation on the same box (another unix user) never collides. Docker is
// host-wide even though systemd --user, HOME, and the DB are per-user.
providers.set(
  'local-docker',
  new LocalDockerProvider({
    image: process.env.AGENTCLAW_IMAGE,
    prefix: process.env.AGENTCLAW_PREFIX,
  }),
);

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
  mode: authModeFromEnv(),
  cliTokenOwner: (token) => store.ownerForCliToken(token),
  onAuthenticated: (principal) => {
    // Phase 3: the first real account adopts what password mode owned. Runs
    // at most once per process — it fires on every authenticated request.
    if (adoptionChecked) return;
    adoptionChecked = true;
    const rows = store.adoptLocalOwnerData(principal.ownerId);
    if (rows > 0) {
      app.log.warn(
        { ownerId: principal.ownerId, email: principal.email, rows },
        'adopted this installation\'s data into the first signed-in account',
      );
    }
  },
});
await registerRoutes(app, {
  store,
  secrets,
  providers,
  channel,
  webIndexPath: resolve(import.meta.dirname, '../web/index.html'),
  webJoinPath: resolve(import.meta.dirname, '../web/join.html'),
  publicUrl: process.env.AGENTCLAW_PUBLIC_URL,
  authMode: authModeFromEnv(),
  verifier:
    authModeFromEnv() === 'identity'
      ? new IdentityVerifier(identityConfigFromEnv())
      : undefined,
});

// Checkpoint and close cleanly so the on-disk file is whole after a restart.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (err) {
      app.log.error({ err }, 'shutdown checkpoint failed');
    }
    process.exit(0);
  });
}

// Without a password every request is treated as the owner. Agent containers
// can reach this process on the docker bridge, so binding 0.0.0.0 in that
// state hands the whole fleet to any prompt-injected agent. Bind loopback
// instead and say so.
const bindHost = process.env.AGENTCLAW_BIND ?? (process.env.AGENTCLAW_PASSWORD ? '0.0.0.0' : '127.0.0.1');
if (bindHost === '127.0.0.1' && !process.env.AGENTCLAW_PASSWORD) {
  app.log.warn(
    'AGENTCLAW_PASSWORD is not set — auth is disabled, so binding 127.0.0.1 only. ' +
      'Set a password (or AGENTCLAW_BIND) to accept connections from elsewhere.',
  );
}
// Keep mending state after boot: a container that wedges at 3am should not
// stay green until someone notices.
startReconcileLoop(store, providers, (e, d) => app.log.info(d, e));

await app.listen({ port: PORT, host: bindHost });
app.log.info(
  { availableBots: pool.availableCount(), localHostId: LOCAL_HOST_ID, url: `http://localhost:${PORT}` },
  'AgentClaw control plane up',
);
