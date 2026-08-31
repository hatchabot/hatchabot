import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import Database from 'better-sqlite3';
import Fastify, { type FastifyServerOptions } from 'fastify';
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
import { LOCAL_OWNER } from './api/principal.js';
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
// The log callback is deferred on purpose: `app` is built further down, and
// nothing here logs before then. Rename outcomes are worth having — a lease
// that silently failed to rename its bot was undiagnosable without them.
const pool = new TelegramPoolProvisioner(db, secrets, {
  log: (event, detail) => app.log.info(detail, event),
});
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

// Optional native TLS: point AGENTCLAW_TLS_CERT and AGENTCLAW_TLS_KEY at PEM
// files to serve HTTPS directly, no reverse proxy needed. It's both or neither
// — a cert without a key (or vice versa) is a misconfiguration we'd rather fail
// loudly on than silently fall back to plaintext for.
const tlsCertPath = process.env.AGENTCLAW_TLS_CERT;
const tlsKeyPath = process.env.AGENTCLAW_TLS_KEY;
if (!!tlsCertPath !== !!tlsKeyPath) {
  throw new Error(
    'TLS is half-configured: set BOTH AGENTCLAW_TLS_CERT and AGENTCLAW_TLS_KEY (PEM file paths), or neither.',
  );
}
const tls =
  tlsCertPath && tlsKeyPath
    ? { cert: readFileSync(tlsCertPath), key: readFileSync(tlsKeyPath) }
    : undefined;

// Fastify reads `https` at runtime to build a TLS server, but that option lives
// on a different overload that infers a secure-server instance type — which the
// rest of the app (registerRoutes/registerAuth expecting the default instance)
// then rejects. Attach it past the base type so `app` stays the default type;
// the runtime behaviour is identical.
const serverOptions: FastifyServerOptions = { logger: true };
if (tls) (serverOptions as FastifyServerOptions & { https: unknown }).https = tls;
const app = Fastify(serverOptions);

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
    // Only a REAL account can adopt. A leftover dev-owner CLI token
    // authenticating first (a cron/script after a mode switch) would
    // otherwise consume the one-shot latch and adopt nothing, leaving the
    // human's first sign-in facing an empty fleet.
    if (principal.ownerId === LOCAL_OWNER) return;
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
// Reachable from off-box but serving plaintext: the password and every request
// travel in the clear. Loud warning, not a refusal — a TLS-terminating proxy in
// front (Caddy/nginx/LB) is a valid setup where the app itself needn't do TLS.
if (bindHost !== '127.0.0.1' && !tls) {
  app.log.warn(
    'Serving plain HTTP on a non-loopback address — the password and all traffic are ' +
      'unencrypted in transit. Set AGENTCLAW_TLS_CERT/AGENTCLAW_TLS_KEY, or put a TLS ' +
      'proxy in front, before exposing this to an untrusted network.',
  );
}
// Keep mending state after boot: a container that wedges at 3am should not
// stay green until someone notices.
startReconcileLoop(store, providers, (e, d) => app.log.info(d, e));

// Finish any bot rename that didn't land. Renaming happens at the worst moment
// for network calls — mid-provision, while the box is churning docker — and a
// failure used to leave the bot advertising the wrong agent (or "unassigned")
// until someone rebuilt it. Nothing to do unless a rename actually failed, so
// this is free on a healthy pool.
const nameRepair = setInterval(() => {
  void pool
    .retryPendingNames()
    .then((n) => { if (n) app.log.info({ fixed: n }, 'channel.names_repaired'); })
    .catch((err) => app.log.warn({ err: String(err) }, 'channel.name_repair_failed'));
}, Number(process.env.AGENTCLAW_NAME_REPAIR_MS ?? 120_000));
nameRepair.unref();

await app.listen({ port: PORT, host: bindHost });
app.log.info(
  {
    availableBots: pool.availableCount(),
    localHostId: LOCAL_HOST_ID,
    tls: !!tls,
    url: `${tls ? 'https' : 'http'}://localhost:${PORT}`,
  },
  'AgentClaw control plane up',
);
