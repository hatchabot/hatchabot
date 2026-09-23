import { ensureOpsServer } from './ops/opsServer.js';
import { APP_VERSION } from './domain/appVersion.js';
import { defaultDbPath } from './envCompat.js'; // must stay the first import: aliases AGENTCLAW_* env on load
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import Database from 'better-sqlite3';
import { installErrorHandler } from './api/errorHandler.js';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { Store } from './store/store.js';
import { LocalSecretStore } from './secrets/localSecretStore.js';
import { MockProvider } from './providers/mockProvider.js';
import { LocalDockerProvider } from './providers/localDockerProvider.js';
import { TelegramPoolProvisioner } from './channels/telegramPool.js';
import { TelegramManualProvisioner } from './channels/telegramManual.js';
import { CompositeTelegramProvisioner } from './channels/composite.js';
import { registerRoutes } from './api/routes.js';
import { authIsEnabled, authModeFromEnv, bindHostFor, registerAuth } from './api/auth.js';
import { identityConfigFromEnv, IdentityVerifier } from './api/identity.js';
import { reconcileAgents, startReconcileLoop } from './orchestrator/reconcile.js';
import { runPostureSweep } from './orchestrator/posture.js';
import { LOCAL_OWNER } from './api/principal.js';
import type { RuntimeProvider } from './providers/provider.js';

const DB_PATH = process.env.HATCHABOT_DB ?? defaultDbPath();
const PORT = Number(process.env.PORT ?? 8080);

mkdirSync(dirname(DB_PATH), { recursive: true });
// The data dir holds the DB, CLI scratch homes, and build logs — no other
// local user has any business even listing it (audit 2026-09-04 #4).
try {
  chmodSync(dirname(DB_PATH), 0o700);
} catch {
  /* best-effort — a shared/system-owned dir shouldn't block boot */
}
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
// HATCHABOT_PREFIX namespaces docker container/volume names so a second
// installation on the same box (another unix user) never collides. Docker is
// host-wide even though systemd --user, HOME, and the DB are per-user.
providers.set(
  'local-docker',
  new LocalDockerProvider({
    image: process.env.HATCHABOT_IMAGE,
    prefix: process.env.HATCHABOT_PREFIX,
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

// Optional native TLS: point HATCHABOT_TLS_CERT and HATCHABOT_TLS_KEY at PEM
// files to serve HTTPS directly, no reverse proxy needed. It's both or neither
// — a cert without a key (or vice versa) is a misconfiguration we'd rather fail
// loudly on than silently fall back to plaintext for.
const tlsCertPath = process.env.HATCHABOT_TLS_CERT;
const tlsKeyPath = process.env.HATCHABOT_TLS_KEY;
if (!!tlsCertPath !== !!tlsKeyPath) {
  throw new Error(
    'TLS is half-configured: set BOTH HATCHABOT_TLS_CERT and HATCHABOT_TLS_KEY (PEM file paths), or neither.',
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
installErrorHandler(app);

// Mend any state drift from reboots/crashes before serving a single request —
// containers auto-restart with the box, the DB doesn't know that.
// Time-boxed: a stalled daemon must not keep the API (and /healthz) down for
// the whole sweep — the periodic loop below finishes whatever this didn't.
await Promise.race([
  reconcileAgents(store, providers, (e, d) => app.log.info(d, e)),
  new Promise<void>((r) => setTimeout(r, Number(process.env.HATCHABOT_BOOT_RECONCILE_MS ?? 30_000)).unref()),
]);

// Bot-token secrets no table references anymore are dead weight holding a live
// credential (a failed best-effort pool release on delete leaks them). All
// referencing stores are constructed above, so the sweep sees every table.
const sweptRefs = store.sweepOrphanBotSecrets();
if (sweptRefs.length) app.log.warn({ refs: sweptRefs }, 'deleted orphaned bot-token secrets');
await registerAuth(app, {
  password: process.env.HATCHABOT_PASSWORD,
  store,
  secret: LocalSecretStore.keyFromEnv(),
  mode: authModeFromEnv(),
  cliTokenOwner: (token) => store.ownerForCliToken(token),
  cliTokenScope: (token) => store.cliTokenScope(token),
  onAuthenticated: (principal) => {
    // Register the account (email <-> owner) so agents can be shared to it by
    // email, and bind any shares that were addressed to this email before its
    // first sign-in. Cheap and idempotent; runs per authenticated request but
    // the writes are no-ops once steady.
    if (principal.ownerId !== LOCAL_OWNER) {
      store.recordAccount(principal.ownerId, principal.email);
      if (principal.email) store.claimSharesForEmail(principal.ownerId, principal.email);
    }
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
  publicUrl: process.env.HATCHABOT_PUBLIC_URL,
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

// First run in accounts mode: creating account #1 is the one action with no
// credential behind it. From this machine it needs nothing; from anywhere else
// it needs this code, which is why it goes to the log and nowhere else.
if (authModeFromEnv() === 'accounts' && store.countLocalAccounts() === 0) {
  const { setupCode } = await import('./api/accountsAuth.js');
  app.log.warn(
    { setupCode: setupCode() },
    'first-run setup code — needed only to create the first account from another machine',
  );
}

// Without a password every request is treated as the owner. Agent containers
// can reach this process on the docker bridge, so binding 0.0.0.0 in that
// state hands the whole fleet to any prompt-injected agent. Bind loopback
// instead and say so.
const bindHost = bindHostFor(process.env, authModeFromEnv());
if (!authIsEnabled(authModeFromEnv(), process.env.HATCHABOT_PASSWORD)) {
  app.log.warn(
    `HATCHABOT_PASSWORD is not set — auth is disabled, so binding ${bindHost} only. ` +
      'Set a password, switch to HATCHABOT_AUTH=accounts, or set HATCHABOT_BIND ' +
      'to accept connections from elsewhere.',
  );
}
// Reachable from off-box but serving plaintext: the password and every request
// travel in the clear. Loud warning, not a refusal — a TLS-terminating proxy in
// front (Caddy/nginx/LB) is a valid setup where the app itself needn't do TLS.
if (bindHost !== '127.0.0.1' && !tls) {
  app.log.warn(
    'Serving plain HTTP on a non-loopback address — the password and all traffic are ' +
      'unencrypted in transit. Set HATCHABOT_TLS_CERT/HATCHABOT_TLS_KEY, or put a TLS ' +
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
}, Number(process.env.HATCHABOT_NAME_REPAIR_MS ?? 120_000));
nameRepair.unref();

// Daily security-posture sweep: snapshot each owner's config-risk set and log
// anything that newly appeared (a shared machine-login source, an agent that
// gained send-email while reachable by a group). Runs once shortly after boot,
// then daily — a cheap DB-only pass. The UI's "Run check" button shows the same.
const postureSweep = () => {
  try {
    runPostureSweep(store, { authMode: authModeFromEnv(), log: (e, d) => app.log.info(d, e) });
  } catch (err) {
    app.log.warn({ err: String(err) }, 'security.posture_sweep_failed');
  }
};
setTimeout(postureSweep, 60_000).unref();
const postureDaily = setInterval(postureSweep, Number(process.env.HATCHABOT_POSTURE_SWEEP_MS ?? 86_400_000));
postureDaily.unref();

await app.listen({ port: PORT, host: bindHost });
// Management agents reach their tools and their AI provider only through the
// ops server; bring it up with the control plane whenever one exists.
if (store.listOpsAgents().length) {
  // The same candidates provisioning uses: the door must land on the address
  // Docker's host alias points at, or no doorman can reach it.
  const localProvider = providers.get('local-docker');
  void ensureOpsServer([await localProvider?.hostGatewayAddress?.()])
    .catch((err) => app.log.error({ err: String(err) }, 'ops server failed to start'));

  // A management agent asks Hatchabot for its tool list ONCE, when its gateway
  // starts. After an upgrade that adds or changes a tool it would keep
  // describing the old set — and tell its owner it cannot do something it now
  // can (reported 2026-09-19: it refused to add a package to a base image, a
  // release after that became possible). Restarting the container is enough;
  // its memory lives on the volume.
  for (const a of store.listOpsAgents()) {
    if (a.state !== 'RUNNING' || !a.runtimeRef) continue;
    if (store.appliedAppVersion(a.id) === APP_VERSION) continue;
    void (async () => {
      try {
        const provider = providers.get(store.getHost(a.hostId)?.provider ?? 'local-docker');
        if (!provider) return;
        await provider.stop(a.runtimeRef!);
        await provider.start(a.runtimeRef!);
        store.setAppliedAppVersion(a.id, APP_VERSION);
        app.log.info({ agentId: a.id, version: APP_VERSION }, 'ops.restarted_for_tools');
      } catch (err) {
        app.log.error({ agentId: a.id, err: String(err) }, 'ops.restart_for_tools_failed');
      }
    })();
  }
}
app.log.info(
  {
    availableBots: pool.availableCount(),
    localHostId: LOCAL_HOST_ID,
    tls: !!tls,
    url: `${tls ? 'https' : 'http'}://localhost:${PORT}`,
  },
  'Hatchabot control plane up',
);
