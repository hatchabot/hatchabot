import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { RuntimeProvider } from '../providers/provider.js';
import { pingRunner, resolveProvider } from '../providers/resolveProvider.js';
import type { CompositeTelegramProvisioner } from '../channels/composite.js';
import { InvalidBotTokenError, verifyBotToken } from '../channels/telegramManual.js';
import {
  claudeAuthDir,
  createAgentRecord,
  effectiveModel,
  sharePathProblem,
  rebuildAgent,
  runProvisionSteps,
  skipPoolOnce,
  slugify,
  MEDIA_KEY_REF,
} from '../orchestrator/provision.js';
import { generateDeployKey, normalizeGitUrl } from '../orchestrator/gitSource.js';
import QRCode from 'qrcode';
import { claimFirstContact, listPairingRequests } from '../orchestrator/claim.js';
import { AgentBusyError, isBusy, whileBusy } from '../orchestrator/busy.js';
import { listCrons, setCronEnabled, runCronNow, deleteCron } from '../orchestrator/crons.js';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { setTelegramDisplayName } from '../channels/telegramName.js';
import { agentUsage } from '../orchestrator/usage.js';
import { runtimeModels } from '../orchestrator/runtimeModels.js';
import { estimateCost } from '../orchestrator/pricing.js';
import { fetchOpenclawDistTags, type OpenclawDistTags } from '../openclaw/npmVersion.js';
import {
  agentArchiveName,
  backupRunState,
  backupsDir,
  keepDays,
  listBackups,
  pruneBackup,
  restoreAgentFromBackup,
  RestoreError,
  startBackup,
} from '../orchestrator/backups.js';
import { auditBots, type HostBots } from '../orchestrator/bots.js';
import { discoverOpenclawAgents, quiesceOpenclawBots } from '../orchestrator/openclawImport.js';
import { scanWorkspacePaths } from '../orchestrator/dataPaths.js';
import {
  migrateCrons,
  openclawAgentEntryForWorkspace,
  readOpenclawCrons,
  rewriteWorkspaceFiles,
  selfPathReplacements,
} from '../orchestrator/cronImport.js';
import { exportTemplate, importTemplate, TEMPLATE_FORMAT } from '../orchestrator/template.js';
import { agentHealth, doctorLint } from '../orchestrator/health.js';
import { checkInvite, createInvite, InviteInvalidError, redeemInvite } from '../orchestrator/invite.js';
import { admitMember, AdmitError, denyPairing, revokeMember, RevokeError } from '../orchestrator/members.js';
import { memoryPolicySection, replaceMemoryPolicy } from '../openclaw/workspace.js';
import { exportAgent, importAgent, peekFormat, TransferError } from '../orchestrator/transfer.js';
import { migrateAgent, MigrateError, preflight } from '../orchestrator/migrate.js';
import { moveAgentToHost } from '../orchestrator/moveHost.js';
import {
  ensureRunnerKey,
  ensureSshConfigBlock,
  installRuntimeImage,
  runnerSetupSnippet,
} from '../orchestrator/runnerSetup.js';
import { probeImageCapabilities } from '../orchestrator/runtimeCaps.js';
import {
  AdoptError,
  applyWorkspace,
  findExistingBot,
  inspectWorkspace,
  botPollState,
} from '../orchestrator/adopt.js';
import type { Agent, AIProfile } from '../domain/types.js';
import { ownerIdOf } from './principal.js';
import type { IdentityVerifier } from './identity.js';
import {
  autoSnapshot,
  captureSnapshot,
  restoreSnapshot,
  SnapshotError,
} from '../orchestrator/snapshots.js';

export interface ApiDeps {
  store: Store;
  secrets: SecretStore;
  /** Keyed by Host.provider — 'mock', 'local-docker', later 'gce'. */
  providers: Map<string, RuntimeProvider>;
  channel: CompositeTelegramProvisioner;
  /** Absolute path to the single-page app. */
  webIndexPath?: string;
  /** Absolute path to the invitee join page. */
  webJoinPath?: string;
  /**
   * Canonical origin others should use to reach this control plane, e.g.
   * http://my-host.example.ts.net:8080. Invite links are built from it,
   * so a link minted while the owner browses localhost still works from the
   * invitee's phone.
   */
  publicUrl?: string;
  /** Drives the login screen the unauthenticated page renders. */
  authMode?: 'password' | 'identity';
  /** Set in identity mode: lets the join flow bind a membership to an account. */
  verifier?: IdentityVerifier;
  /** Override the OpenClaw npm dist-tags lookup (tests). Defaults to the real
   *  registry fetch; the endpoint caches the result. */
  openclawDistTags?: () => Promise<OpenclawDistTags>;
}

const LocalProfile = z.object({
  kind: z.literal('local'),
  name: z.string().min(1),
  model: z.string().min(1),
  models: z.array(z.string().min(1)).max(16).optional(),
  /** As the AGENT sees it — containers can't reach the host's loopback. */
  /**
   * Must be a private address: "nothing leaves this machine" has to be
   * enforced, not just documented. z.string().url() alone accepts
   * https://evil.com and file:// — both silently break the promise.
   */
  baseUrl: z
    .string()
    .url()
    .refine(isPrivateModelUrl, 'Must be an http:// address on this machine or a private network')
    .default('http://172.17.0.1:11434/v1'),
});

const CreateAIProfile = z.union([
  LocalProfile,
  z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('api_key'),
    name: z.string().min(1),
    vendor: z.enum(['anthropic', 'google']),
    model: z.string().min(1),
    models: z.array(z.string().min(1)).max(16).optional(),
    apiKey: z.string().min(1),
  }),
  z.object({
    kind: z.literal('subscription'),
    name: z.string().min(1),
    vendor: z.literal('anthropic'),
    model: z.string().min(1),
    models: z.array(z.string().min(1)).max(16).optional(),
    /** From `claude setup-token` — the subscription path for hosts where the
     *  login lives in the macOS Keychain instead of ~/.claude. */
    oauthToken: z.string().min(1).optional(),
  }),
  ]),
]);

/** Zod issues render as "Request failed" in the app; send a sentence. */
function zodMessage(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return 'Invalid input';
  const where = i.path.length ? `${i.path.join('.')}: ` : '';
  return `${where}${i.message}`;
}

/** Shown when a non-machine-owner tries to name a host path. */
const HOST_PATH_DENIED =
  'Only the account that set up this machine can mount or adopt host folders. ' +
  'Ask them to share the folder with your agent, or import an exported agent instead.';

const CreateAgent = z.object({
  name: z.string().min(1).max(64),
  persona: z.string().max(4000).optional(),
  aiProfileId: z.string().min(1),
  hostId: z.string().min(1),
  sharedMemory: z.boolean().optional(),
  /** Optional per-agent model override, chosen from the profile's menu. */
  model: z.string().min(1).max(64).optional(),
  /** Telegram user ids to admit without pairing — carried from an adopted
   *  agent, so the people already talking to it are not made to knock. */
  seedMembers: z.array(z.string().regex(/^\d{1,32}$/)).max(32).optional(),
  /** Owner unchecked "use a pool bot": walk BotFather even if the pool has
   *  bots (they want a bespoke @handle for this agent). */
  skipPool: z.boolean().optional(),
});

/**
 * A per-agent model override is only valid for a cloud profile and must be one
 * the profile actually offers — its default plus its switchable menu — so a
 * typo can't provision green and fail on first use. Returns an error string,
 * or undefined when the override is acceptable (or absent).
 */
function modelOverrideProblem(profile: AIProfile, model: string | null | undefined): string | undefined {
  if (model == null) return undefined; // clearing / not setting is always fine
  if (profile.vendor === 'local') {
    return 'Local sources run one model at a time, so agents follow the source’s model — set it on the source, not per agent.';
  }
  const menu = new Set([profile.model, ...(profile.models ?? [])]);
  if (!menu.has(model)) {
    return `"${model}" isn’t one of this source’s models. Add it to the source’s switchable list first.`;
  }
  return undefined;
}


/**
 * Reachability + model check for a local model server. The control plane can
 * reach the docker bridge (it owns it), so this validates the same address
 * the agent will use.
 */
/** A local model server must live on this box or a private network. */
export function isPrivateModelUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname;
  return (
    h === 'localhost' ||
    h === '::1' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  );
}

async function checkLocalServer(
  baseUrl: string,
  model: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Loopback is the trap: the control plane runs on the host and CAN reach
  // it, so a naive reachability probe passes — but the agent runs in a
  // container where localhost is the container itself. Reject it outright.
  const host = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return '';
    }
  })();
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) {
    return {
      ok: false,
      error:
        `${baseUrl} points at this machine's loopback, which an agent container ` +
        `cannot reach — inside a container "localhost" is the container itself. ` +
        `Use the docker bridge instead: http://172.17.0.1:11434/v1`,
    };
  }

  const root = baseUrl.replace(/\/v1\/?$/, '');
  let tags: { models?: Array<{ name?: string }> };
  try {
    const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `The model server answered ${res.status} at ${root}.` };
    tags = (await res.json()) as typeof tags;
  } catch {
    return {
      ok: false,
      error:
        `Couldn't reach a model server at ${baseUrl}. Note this address must work ` +
        `from inside a container — the host's own localhost does not. Try ` +
        `http://172.17.0.1:11434/v1, and make sure the server listens on more ` +
        `than loopback (Ollama: OLLAMA_HOST=0.0.0.0:11434).`,
    };
  }
  const names = (tags.models ?? []).map((m) => m.name).filter(Boolean) as string[];
  if (names.length && !names.includes(model)) {
    return {
      ok: false,
      error: `That server has no model "${model}". It offers: ${names.slice(0, 8).join(', ')}.`,
    };
  }
  return { ok: true };
}

/** The running version, stamped into the app shell so a stale tab is visible. */
const APP_VERSION: string = (() => {
  try {
    return createRequire(import.meta.url)('../../package.json').version ?? 'dev';
  } catch {
    return 'dev';
  }
})();

export async function registerRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { store, secrets } = deps;

  /**
   * Orchestrators already report what they do; this sends it to the log AND
   * to the agent's timeline, so the app can answer "what happened to this
   * agent?" instead of only "what state is it in now?".
   */
  const trace =
    (agentId?: string) =>
    (event: string, detail: Record<string, unknown>): void => {
      app.log.info(detail, event);
      const id = agentId ?? (typeof detail.agentId === 'string' ? detail.agentId : undefined);
      if (id) {
        try {
          store.recordEvent(id, event, detail);
        } catch {
          /* a timeline write must never break the operation it describes */
        }
      }
    };

  // Agent archives arrive as raw bytes (import). 512 MB ceiling — a family
  // agent's volume snapshot is MBs, but sessions grow.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 512 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  /**
   * Resolve an agent by id AND check it belongs to the caller. Every by-id
   * route goes through this — without it, ownerId scoping exists only on the
   * list endpoints and provides no isolation the moment a second owner exists
   * (docs/identity.md phase 1).
   */
  const ownedAgent = (req: FastifyRequest, id: string): Agent | undefined => {
    const agent = store.getAgent(id);
    if (!agent || agent.ownerId !== ownerIdOf(req)) return undefined;
    return agent;
  };

  /**
   * Phase 4 (docs/identity.md): an agent a member may *see* — theirs by
   * ownership or by active membership. Read-only surfaces use this; anything
   * that changes the agent's life (lifecycle, files, members, export, delete)
   * stays on ownedAgent so a `user` member can't touch it.
   */
  const visibleAgent = (req: FastifyRequest, id: string): Agent | undefined => {
    const agent = store.getAgent(id);
    if (!agent) return undefined;
    return store.accessRole(agent.id, ownerIdOf(req)) ? agent : undefined;
  };

  /**
   * The only shape an Agent leaves this process in. gatewayToken is a
   * credential for full agent control (served on demand by /gateway), so
   * stripping it belongs here rather than in each route's spread — four
   * mutation routes previously leaked it by returning the raw row.
   */
  const publicAgent = (agent: Agent, extra: Record<string, unknown> = {}) => {
    const desired = store.getAIProfile(agent.aiProfileId);
    // What this agent WILL run: its own override if any, else the profile
    // default (local ignores the override — effectiveModel handles that).
    const desiredModel = desired ? effectiveModel(agent, desired) : undefined;
    const switched =
      (agent.appliedProfileId && agent.appliedProfileId !== agent.aiProfileId) ||
      (!!agent.appliedModel && !!desiredModel && agent.appliedModel !== desiredModel);
    return {
      ...agent,
      gatewayToken: undefined,
      hasGateway: !!(agent.gatewayPort && agent.gatewayToken),
      /** What the runtime is actually running right now. */
      model: agent.appliedModel ?? desiredModel,
      /** What it WILL run after a rebuild, when that differs from now. */
      pendingModel: switched ? desiredModel : undefined,
      /** The models this agent could switch to (its profile's menu), so the
       *  app can offer a per-agent picker without another round-trip. */
      profileModels: desired && desired.vendor !== 'local'
        ? [desired.model, ...(desired.models ?? [])].filter((m, i, a) => a.indexOf(m) === i)
        : [],
      profileDefaultModel: desired?.model,
      /** The raw per-agent override (undefined = follows the default), so the
       *  picker can show which choice is currently in effect. */
      modelOverride: agent.model,
      /** Everything this agent can access, unified: legacy read-only folders
       *  plus richer DataSources. One list so the app can show "what data does
       *  this agent have" at a glance. */
      dataSources: dataSourcesFor(agent),
      dataSummary: dataSummaryFor(agent),
      /** Per-agent environment variables — names only; the secret values are
       *  write-only and never leave the SecretStore. */
      envVars: store.listAgentEnv(agent.id).map((e) => ({ id: e.id, name: e.name, createdAt: e.createdAt })),
      /** Mid-operation (move, backup, export, adopt…): the state alone reads
       *  as a lie — a move shows STOPPED for a minute — so the app can show
       *  "working" instead of leaving the owner to think nothing is happening. */
      busy: isBusy(agent.id),
      ...extra,
    };
  };

  /** Legacy shared_paths + data_sources, as one uniform list for the app. */
  const dataSourcesFor = (agent: Agent) => [
    ...(agent.sharedPaths ?? []).map((p) => ({
      id: `legacy:${p}`,
      kind: 'folder' as const,
      access: 'ro' as const,
      mountName: basename(p),
      hostPath: p,
      legacy: true,
    })),
    ...store.listDataSources(agent.id).map((d) => ({
      id: d.id,
      kind: d.kind,
      access: d.access,
      mountName: d.mountName,
      hostPath: d.hostPath,
      mountAtHostPath: d.mountAtHostPath,
      repoUrl: d.repoUrl,
      // Public half of the deploy key — safe to show, and the owner needs it to
      // grant the repo access (as a read, or write for rw, deploy key).
      pubKey: d.pubKey,
      /** Why the last clone failed, so the card can say which repo is stuck
       *  instead of the owner digging through the audit log. */
      syncError: d.syncError,
      legacy: false,
    })),
  ];

  /** One-line "reads 2 folders · 1 writable folder" for the card. */
  const dataSummaryFor = (agent: Agent): string | undefined => {
    const all = dataSourcesFor(agent);
    if (!all.length) return undefined;
    const ro = all.filter((d) => d.kind === 'folder' && d.access === 'ro').length;
    const rw = all.filter((d) => d.kind === 'folder' && d.access === 'rw').length;
    const git = all.filter((d) => d.kind === 'git').length;
    const parts: string[] = [];
    if (ro) parts.push(`reads ${ro} folder${ro > 1 ? 's' : ''}`);
    if (rw) parts.push(`${rw} writable folder${rw > 1 ? 's' : ''}`);
    if (git) parts.push(`${git} git repo${git > 1 ? 's' : ''}`);
    return parts.join(' · ');
  };

  /**
   * A moved agent's bot now belongs to another server. Starting, rebuilding
   * or retrying this copy would put two runtimes on one token and they would
   * fight over every message — so refuse until the owner explicitly says the
   * move was undone.
   */
  const movedAway = (agent: Agent, reply: any): boolean => {
    if (!agent.migratedTo) return false;
    reply.code(409).send({
      error:
        `"${agent.name}" was moved to ${agent.migratedTo}. Starting this copy would make two ` +
        `agents poll the same Telegram bot and messages would go to whichever answers first. ` +
        `If the move was undone, clear it first (Edit → "Runs here again").`,
    });
    return true;
  };

  /**
   * A lifecycle request against an agent mid-migrate/adopt/import. Those
   * operations hold the busy flag precisely because, from the outside, the
   * agent looks like an ordinary stopped one — and acting on that look is how
   * a mid-migration Start ends with two runtimes polling one bot token.
   */
  const busyNow = (agent: Agent, reply: any): boolean => {
    if (!isBusy(agent.id)) return false;
    reply.code(409).send({ error: 'Another operation is already running on this agent.' });
    return true;
  };

  const snapshotDeps = (agent: Agent) => ({
    store,
    provider: providerFor(agent.hostId),
    log: trace(agent.id),
  });

  /**
   * May this caller name arbitrary HOST paths (inspect / adopt / sharedPaths /
   * fromWorkspace)? Only the account that owns the local host — i.e. the
   * person who set the machine up. Those routes mount or read host
   * directories at uid 1000; the `sharePathProblem` blocklist protects a few
   * well-known secrets but is owner-blind, so on a shared box a second
   * account could otherwise mount another user's home and read it through
   * their own agent. Refuse rather than widen the blocklist.
   */
  const ownsLocalHost = (req: FastifyRequest): boolean => {
    const ownerId = ownerIdOf(req);
    const local = store.listHosts(ownerId).find((h) => h.kind === 'local');
    return !!local && local.ownerId === ownerId;
  };

  // Remote runner providers (Cluster mode) are built per host from its stored
  // Docker endpoint and kept for the process — this cache is that store.
  const remoteProviderCache = new Map<string, RuntimeProvider>();
  const providerFor = (hostId: string): RuntimeProvider => {
    const host = store.getHost(hostId);
    if (!host) throw new Error(`No such host: ${hostId}`);
    return resolveProvider(host, deps.providers, remoteProviderCache, {
      image: process.env.AGENTCLAW_IMAGE,
      prefix: process.env.AGENTCLAW_PREFIX,
    });
  };

  // ---- background provisioning ------------------------------------------
  // POST /v1/agents returns in milliseconds; the slow steps (docker, health
  // check) run here. One in-flight run per agent; the app polls GET /v1/agents.
  const inflight = new Map<string, Promise<void>>();
  const kickProvision = (agentId: string): void => {
    if (inflight.has(agentId)) return;
    const task = (async () => {
      const agent = store.getAgent(agentId);
      if (!agent) return;
      const provider = providerFor(agent.hostId);
      const log = trace(agentId);
      const result = await runProvisionSteps(
        { store, secrets, provider, channel: deps.channel, log },
        agentId,
      );
      // Fresh agent went live in pairing mode → watch for the owner's first
      // message and bind it (the §12.4 claim). DETACHED: the claim window is
      // 10 minutes of idle polling on an agent that is already live — holding
      // `inflight` for it made Delete hang and Rebuild answer 409 that whole
      // time. The watcher notices for itself when the agent goes away.
      // Skipped entirely when the owner's Telegram identity was carried over
      // from an earlier agent (createAgentRecord): they're in allowFrom
      // already, so there is no pairing request to watch for.
      const channelRow = store.getChannelForAgent(agentId);
      const ownerBound = store
        .listMemberships(agentId)
        .some((m) => m.userId === result.agent.ownerId && m.channelUserId);
      if (result.agent.state === 'RUNNING' && result.agent.runtimeRef && channelRow && !ownerBound) {
        void claimFirstContact(
          { store, provider, log },
          {
            agentId,
            runtimeRef: result.agent.runtimeRef,
            accountId: channelRow.accountId,
            forUserId: result.agent.ownerId,
          },
        ).catch((err) => app.log.error({ err, agentId }, 'owner claim failed'));
      }
    })();
    inflight.set(
      agentId,
      task
        .catch((err) => app.log.error({ err, agentId }, 'provision task failed'))
        .finally(() => inflight.delete(agentId)),
    );
  };

  /**
   * Start a rebuild in the background (the snapshot runs as its first step, so
   * this returns at once). Returns false if the agent is already changing or
   * has no runtime — callers turn that into a 409 or just skip it in a batch.
   */
  const kickRebuild = (agentId: string): boolean => {
    if (inflight.has(agentId)) return false;
    const agent = store.getAgent(agentId);
    if (!agent?.runtimeRef) return false;
    const task = rebuildAgent(
      { store, secrets, provider: providerFor(agent.hostId), channel: deps.channel, log: trace(agentId) },
      agentId,
    );
    inflight.set(
      agentId,
      task
        .then(() => undefined)
        .catch((err) => app.log.error({ err, agentId }, 'rebuild task failed'))
        .finally(() => inflight.delete(agentId)),
    );
    return true;
  };

  // ---- app ----------------------------------------------------------------

  if (deps.webIndexPath) {
    app.get('/', async (_req, reply) => {
      // Re-read per request: dev-friendly, and this page is tiny.
      const html = readFileSync(deps.webIndexPath!, 'utf8');
      // The whole app is this one file. With no cache headers the browser was
      // free to keep an old copy, so a shipped fix could sit unused behind a
      // stale tab — indistinguishable from "the fix doesn't work". Never store
      // it, and stamp the running version in so what's loaded is checkable.
      return reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store, must-revalidate')
        .header('x-agentclaw-version', APP_VERSION)
        .send(html.replace('</head>', `<script>window.AGENTCLAW_VERSION=${JSON.stringify(APP_VERSION)};console.info('AgentClaw '+window.AGENTCLAW_VERSION);</script></head>`));
    });

    // PWA assets so the web app is installable to a phone home screen. Served
    // unauthenticated by design — they're the static shell (no data); the auth
    // hook exempts these exact paths. The service worker never caches /v1/*.
    const webDir = dirname(deps.webIndexPath);
    app.get('/manifest.webmanifest', async (_req, reply) =>
      reply.type('application/manifest+json').send(readFileSync(join(webDir, 'manifest.webmanifest'))),
    );
    app.get('/sw.js', async (_req, reply) =>
      reply
        .header('service-worker-allowed', '/')
        .header('cache-control', 'no-cache')
        .type('text/javascript; charset=utf-8')
        .send(readFileSync(join(webDir, 'sw.js'), 'utf8')),
    );
    app.get<{ Params: { name: string } }>('/icons/:name', async (req, reply) => {
      // Whitelist the filename shape — no path traversal reaches the disk read.
      if (!/^[a-z0-9-]+\.png$/.test(req.params.name)) return reply.code(404).send({ error: 'Not found' });
      const p = join(webDir, 'icons', req.params.name);
      if (!existsSync(p)) return reply.code(404).send({ error: 'Not found' });
      return reply.header('cache-control', 'public, max-age=86400').type('image/png').send(readFileSync(p));
    });
    // A QR of the app's own address, so a phone can scan-to-open it. Public
    // (like the other PWA shell assets) — it encodes only the reachable URL,
    // which just opens the login screen, and an <img> can't carry auth anyway.
    app.get('/app-qr.svg', async (req, reply) => {
      const origin = deps.publicUrl?.replace(/\/$/, '') || `${req.protocol}://${req.headers.host}`;
      const svg = await QRCode.toString(origin, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      return reply.header('cache-control', 'no-cache').type('image/svg+xml').send(svg);
    });
  }

  app.get('/healthz', async () => ({ ok: true }));

  // What the login screen needs before anyone is authenticated. The API key
  // is publishable by design (Google: "API keys for Firebase services do not
  // need to be treated as secrets") — it identifies the project, it doesn't
  // authorise anything on its own.
  app.get('/v1/config', async () => ({
    authMode: deps.authMode ?? 'password',
    identity:
      deps.authMode === 'identity'
        ? {
            projectId: process.env.AGENTCLAW_GCP_PROJECT,
            apiKey: process.env.AGENTCLAW_IDENTITY_API_KEY,
            googleClientId: process.env.AGENTCLAW_GOOGLE_CLIENT_ID,
          }
        : undefined,
  }));

  // ---- profiles & hosts ----------------------------------------------------

  app.get('/v1/ai-profiles', async (req) => {
    // `mine` tells the app which rows the caller may edit/share/delete —
    // a shared profile appears in everyone's list but has one owner.
    // `credential` says WHAT authenticates this source (never the secret
    // itself): the two subscription flavours are indistinguishable in the
    // UI otherwise, and "did I paste a setup-token or is this the machine
    // login?" is a question the owner should not need the database for.
    return store.listAIProfiles(ownerIdOf(req)).map(({ secretRef, ownerId, baseUrl, ...safe }) => {
      const mine = ownerId === ownerIdOf(req);
      return {
        ...safe,
        mine,
        // Don't leak another account's identifier or their internal model-
        // server address just because they shared a profile with the box.
        ownerId: mine ? ownerId : undefined,
        baseUrl: mine ? baseUrl : undefined,
        credential:
          safe.vendor === 'local'
            ? 'none'
            : safe.kind === 'subscription'
              ? secretRef
                ? 'setup-token'
                : 'machine-login'
              : 'api-key',
      };
    });
  });

  app.get('/v1/hosts', async (req) => {
    // Annotate each host with how many agents run on it — the load signal for
    // placement and the "can I delete this?" check in the UI. The host owner
    // (admin) sees the true fleet-wide count; a plain user sees only THEIR own
    // agents' count, never a window onto others' fleet size.
    const ownerId = ownerIdOf(req);
    const admin = ownsLocalHost(req);
    const active = store.listAllActiveAgents().filter((a) => admin || a.ownerId === ownerId);
    return store.listHosts(ownerId).map((h) => ({
      ...h,
      agentCount: active.filter((a) => a.hostId === h.id).length,
    }));
  });

  /** On-demand reachability check for a runner host's Docker endpoint. */
  app.get<{ Params: { id: string } }>('/v1/hosts/:id/ping', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const host = store.getHost(req.params.id);
    if (!host) return reply.code(404).send({ error: 'Not found' });
    const dockerHost = typeof host.settings?.dockerHost === 'string' ? host.settings.dockerHost : '';
    if (!dockerHost) return { reachable: true, serverVersion: 'local' }; // the local daemon
    // Adapt pingRunner's {ok, version, error} to the shape the UI reads
    // ({reachable, serverVersion, error}) — the same mapping the add path does.
    // Without this a *successful* probe renders as "unreachable — no response".
    const ping = await pingRunner(dockerHost);
    return { reachable: ping.ok, serverVersion: ping.version, hasImage: ping.hasImage, error: ping.error };
  });

  // The control plane's dedicated runner key (created on first ask) plus the
  // paste-on-the-runner setup snippet — the two halves of "add a runner
  // without an SSH treasure hunt". Host-owner only: the snippet authorizes
  // THIS box onto another machine.
  app.get('/v1/runner-setup', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    try {
      const pubKey = await ensureRunnerKey();
      return { pubKey, snippet: runnerSetupSnippet(pubKey) };
    } catch (err) {
      return reply.code(500).send({
        error: `Couldn't prepare the runner key (is ssh-keygen installed?): ${String(
          err instanceof Error ? err.message : err,
        ).slice(0, 200)}`,
      });
    }
  });

  // Copy this box's runtime image onto a runner (docker save | docker -H load).
  // Slow — minutes for a multi-GB image — so the UI treats it as a long job.
  app.post<{ Params: { id: string } }>('/v1/hosts/:id/install-image', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const host = store.getHost(req.params.id);
    if (!host) return reply.code(404).send({ error: 'Not found' });
    const dockerHost = typeof host.settings?.dockerHost === 'string' ? host.settings.dockerHost : '';
    if (!dockerHost) return reply.code(400).send({ error: 'The local host already has the image.' });
    const res = await installRuntimeImage(dockerHost, { image: process.env.AGENTCLAW_IMAGE });
    if (!res.ok) return reply.code(502).send({ error: `Image install failed: ${res.error}` });
    return { installed: true };
  });

  // Register a runner host (Cluster mode): a remote Docker endpoint that the
  // control plane places agents on. Host-owner only — it adds fleet capacity.
  // The endpoint is reachability-checked best-effort so a typo fails here.
  app.post<{ Body: { name?: string; dockerHost?: string } }>('/v1/hosts', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(64),
        // ssh://user@host is the simplest secure transport; tcp:// needs TLS set
        // up out of band. Reject anything that isn't one of those schemes.
        dockerHost: z.string().trim().regex(/^(ssh|tcp):\/\/\S+$/, 'Use ssh://user@host or tcp://host:port'),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const { name, dockerHost } = parsed.data;

    // For ssh:// endpoints, pin our dedicated key + accept-new in ~/.ssh/config
    // BEFORE the first probe — this is what makes the headless service (no
    // ssh-agent) authenticate deterministically. Best-effort: a config we
    // can't write just means the ping reports whatever ssh can do without it.
    try {
      await ensureRunnerKey();
      await ensureSshConfigBlock(dockerHost);
    } catch {
      /* surfaced by the ping below if it actually matters */
    }
    const ping = await pingRunner(dockerHost);
    const host = {
      id: randomUUID(),
      ownerId: ownerIdOf(req),
      kind: 'cloud' as const,
      provider: 'remote-docker',
      name,
      settings: { dockerHost },
      createdAt: new Date().toISOString(),
    };
    store.insertHost(host);
    // Saved regardless — a runner that's briefly unreachable now may be up at
    // provision time — but surface the probe so the owner sees a bad endpoint.
    return reply.code(201).send({
      ...host,
      reachable: ping.ok,
      serverVersion: ping.version,
      hasImage: ping.hasImage,
      pingError: ping.error,
    });
  });

  // Drain a host: stop every running agent on it (take it out of service before
  // decommissioning). Best-effort per agent; a busy one is skipped and reported.
  app.post<{ Params: { id: string } }>('/v1/hosts/:id/drain', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const host = store.getHost(req.params.id);
    if (!host) return reply.code(404).send({ error: 'Not found' });
    const running = store
      .listAllActiveAgents()
      .filter((a) => a.hostId === host.id && a.state === 'RUNNING' && a.runtimeRef);
    let stopped = 0;
    const skipped: string[] = [];
    for (const a of running) {
      if (isBusy(a.id)) { skipped.push(a.name); continue; }
      try {
        // Hold the busy flag for the stop so an export/migrate can't start
        // between the check and the stop and get its container killed mid-tar.
        await whileBusy(a.id, async () => {
          await providerFor(host.id).stop(a.runtimeRef!);
          store.setAgentState(a.id, 'STOPPED');
        });
        stopped++;
      } catch (err) {
        skipped.push(a.name);
        trace(a.id)('host.drain_stop_failed', { error: String(err).slice(0, 200) });
      }
    }
    return { stopped, skipped };
  });

  app.delete<{ Params: { id: string } }>('/v1/hosts/:id', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const host = store.getHost(req.params.id);
    if (!host) return reply.code(404).send({ error: 'Not found' });
    if (host.kind === 'local') {
      return reply.code(400).send({ error: 'The local host is this machine — it cannot be removed.' });
    }
    const still = store.listAllActiveAgents().filter((a) => a.hostId === host.id);
    if (still.length) {
      return reply.code(409).send({
        error: `${still.length} agent${still.length === 1 ? '' : 's'} still run on this host — move or delete them first.`,
      });
    }
    store.deleteHost(host.id);
    return { ok: true };
  });

  /**
   * Which local models are resident right now. A cold model means the next
   * message stalls ~10s while tens of GB load — worth showing rather than
   * letting the owner wonder whether the agent is broken.
   */
  // Keyed by baseUrl: two local profiles point at different model servers, so
  // a single global cache reported the FIRST server's warm set for the second
  // agent's card for up to 15s. One entry per server instead.
  const warmCache = new Map<string, { at: number; models: string[] }>();
  const warmLocalModels = async (baseUrl: string): Promise<string[]> => {
    const hit = warmCache.get(baseUrl);
    if (hit && Date.now() - hit.at < 15_000) return hit.models;
    let models: string[] = [];
    try {
      const root = baseUrl.replace(/\/v1\/?$/, '');
      const res = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(2000) });
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      models = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    } catch {
      models = [];
    }
    warmCache.set(baseUrl, { at: Date.now(), models });
    return models;
  };

  app.get('/v1/pool', async (req) => {
    return {
      // Per-user: YOUR bots plus shared house bots — what a create by this
      // user could actually lease. Tokens are personally owned (their minter
      // can revoke them at BotFather), so one user's parked bot is never
      // another user's next lease.
      availableBots: deps.channel.pool.availableCount(ownerIdOf(req)),
      // The roster is host-owner detail (it names bots and their leases);
      // everyone else only needs the count for the "N instant bots" header.
      ...(ownsLocalHost(req)
        ? {
            bots: deps.channel.pool
              .list()
              .map((b) => ({
                username: b.username,
                leasedTo: b.leasedTo,
                // Which agent wears this bot right now — names beat ids in
                // a roster meant for humans.
                leasedToName: b.leasedTo ? store.getAgent(b.leasedTo)?.name : undefined,
                ownerId: b.ownerId, // undefined = shared house bot
                shared: !b.ownerId,
                mine: b.ownerId === ownerIdOf(req),
              })),
          }
        : {}),
    };
  });

  // ---- media key -----------------------------------------------------------
  // One fleet-wide Gemini key powering voice-note transcription (OpenClaw's
  // audio understanding sends audio to an audio-capable model). Injected into
  // agents at provision — the Environment tab reserves GEMINI_* on purpose,
  // so this is the managed path. Write-only, like every credential.
  app.get('/v1/media-key', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const set = await secrets.get(MEDIA_KEY_REF).then(() => true, () => false);
    return { set };
  });

  app.put<{ Body: { key?: string } }>('/v1/media-key', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const parsed = z.object({ key: z.string().min(1).max(400) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Paste a Gemini API key.' });
    const key = parsed.data.key.trim();
    if (!key) return reply.code(400).send({ error: 'Paste a Gemini API key.' });
    await secrets.put(MEDIA_KEY_REF, key);
    return { set: true };
  });

  app.delete('/v1/media-key', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    await secrets.delete(MEDIA_KEY_REF).catch(() => {});
    return { set: false };
  });

  // Stock the pool from the app: verify the token against Telegram, then store
  // it. Refuses a bot that is currently some agent's live identity.
  app.post<{ Body: { token?: string; shared?: boolean } }>('/v1/pool', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const parsed = z
      .object({ token: z.string().min(1).max(256), shared: z.boolean().optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Paste a bot token from @BotFather.' });
    const body = parsed.data;
    const token = body.token.trim();
    if (!token) return reply.code(400).send({ error: 'Paste a bot token from @BotFather.' });
    let username: string;
    try {
      username = await verifyBotToken(token);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof InvalidBotTokenError ? err.message : 'Could not verify that token with Telegram.',
      });
    }
    const using = store.findAgentUsingAccount(username);
    if (using) {
      return reply.code(409).send({
        error: `@${username} is the live identity of agent "${using.name}" — it can't also sit in the pool.`,
      });
    }
    // Yours by default — a token belongs to whoever minted it. `shared: true`
    // explicitly donates it as a house bot anyone here can lease.
    await deps.channel.pool.addToPool(username, token, body?.shared ? null : ownerIdOf(req));
    return reply
      .code(201)
      .send({ username, availableBots: deps.channel.pool.availableCount(ownerIdOf(req)) });
  });

  app.delete<{ Params: { username: string } }>('/v1/pool/:username', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    try {
      await deps.channel.pool.removeFromPool(req.params.username);
    } catch (err) {
      return reply.code(409).send({ error: String(err instanceof Error ? err.message : err) });
    }
    return { removed: true, availableBots: deps.channel.pool.availableCount(ownerIdOf(req)) };
  });

  // A Telegram-bot census: this install's bots (and, with ?consolidated=1, each
  // registered peer's) so the owner can spot idle slots. ?live=1 adds a Telegram
  // getMe/poll check per bot — slower, and it touches the network.
  app.get<{ Querystring: { live?: string; consolidated?: string } }>('/v1/bots', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const ownerId = ownerIdOf(req);
    const live = req.query.live === '1' || req.query.live === 'true';
    const hostName = store.listHosts(ownerId).find((h) => h.kind === 'local')?.name ?? 'this server';
    const local = await auditBots({ store, secrets, pool: deps.channel.pool, hostName }, ownerId, { live });
    const hosts: HostBots[] = [local];

    if (req.query.consolidated === '1' || req.query.consolidated === 'true') {
      for (const peer of store.listPeers(ownerId)) {
        try {
          const token = await secrets.get(peer.secretRef);
          // NOT consolidated — the peer returns only its own install, so a ring
          // of peers can't recurse or double-count.
          const res = await fetch(`${peer.url.replace(/\/$/, '')}/v1/bots?live=${live ? 1 : 0}`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) {
            hosts.push({ host: peer.name, bots: [], mgmtBotConfigured: false, error: `answered ${res.status}` });
            continue;
          }
          const body = (await res.json()) as { hosts?: HostBots[] };
          const peerLocal = body.hosts?.[0];
          hosts.push(peerLocal ? { ...peerLocal, host: peer.name } : { host: peer.name, bots: [], mgmtBotConfigured: false, error: 'no data' });
        } catch (err) {
          hosts.push({ host: peer.name, bots: [], mgmtBotConfigured: false, error: `unreachable (${String((err as Error)?.message ?? err).slice(0, 60)})` });
        }
      }
    }
    return { hosts };
  });

  app.post('/v1/ai-profiles', async (req, reply) => {
    const parsed = CreateAIProfile.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const body = parsed.data;

    const id = randomUUID();
    let secretRef: string | undefined;

    if (body.kind === 'local') {
      // No credential to store — which makes this the ONE profile kind where
      // the config is the only thing that can be wrong. Check it here, where
      // the error is fixable, instead of letting the agent provision green
      // and then stay silent on Telegram forever.
      const check = await checkLocalServer(body.baseUrl, body.model);
      if (!check.ok) return reply.code(400).send({ error: check.error });
    } else if (body.kind === 'api_key') {
      secretRef = `ai-profile/${id}`;
      await secrets.put(secretRef, body.apiKey);
    } else if (body.oauthToken) {
      // Subscription via a `claude setup-token` token — for hosts (macOS)
      // where the login lives in the Keychain and can't be file-mounted.
      secretRef = `ai-profile/${id}`;
      await secrets.put(secretRef, body.oauthToken);
    } else {
      // Subscription via the on-disk login: nothing to store — the OAuth
      // credential stays on the host machine and is mounted at boot. That
      // file is the MACHINE OWNER'S Claude login, so on a shared local host
      // only the account that owns the host row may lean on it; anyone else
      // would silently bill their agents to someone else's subscription.
      // They can still paste a setup-token of their own (the branch above).
      const localHost = store.listHosts(ownerIdOf(req)).find((h) => h.kind === 'local');
      if (localHost && localHost.ownerId !== ownerIdOf(req)) {
        return reply.code(400).send({
          error:
            "This machine's Claude login belongs to the account that set the server up — " +
            'they can share their AI source with everyone here (Settings → AI sources → ' +
            'Shared). Or run `claude setup-token` under your own Claude account and paste ' +
            'that token here — or use an API key or a local model.',
        });
      }
      if (!existsSync(`${claudeAuthDir()}/.credentials.json`)) {
        return reply.code(400).send({
          error:
            'No Claude login file found on this host. On Linux: run `claude` once and log in. ' +
            'On macOS the login lives in the Keychain, so instead run `claude setup-token` ' +
            'and paste the token here. See docs/ai-profiles.md.',
        });
      }
    }

    const isLocal = body.kind === 'local';
    const profile = {
      id,
      ownerId: ownerIdOf(req),
      name: body.name,
      // A local profile is its own vendor, and always api_key-shaped as far
      // as the rest of the system is concerned (no OAuth, no mount).
      vendor: (isLocal ? 'local' : body.vendor) as 'anthropic' | 'google' | 'local',
      kind: (isLocal ? 'api_key' : body.kind) as 'api_key' | 'subscription',
      model: body.model,
      models: body.models,
      baseUrl: isLocal ? body.baseUrl : undefined,
      secretRef,
      createdAt: new Date().toISOString(),
    };
    store.insertAIProfile(profile);
    // Never echo the key back.
    const { secretRef: _omit, ...safe } = profile;
    return reply.code(201).send(safe);
  });

  // Update the switchable-model list on a profile. Running agents pick the
  // change up on their next rebuild (config is written at provision time).
  app.patch<{ Params: { id: string }; Body: { models?: string[] } }>(
    '/v1/ai-profiles/:id',
    async (req, reply) => {
      const profile = store.getAIProfile(req.params.id);
      if (!profile || profile.ownerId !== ownerIdOf(req)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const parsed = z
        .object({
          model: z.string().trim().min(1).optional(),
          models: z.array(z.string().min(1)).max(16).optional(),
          /** Owner opt-in: every account on this installation may use this
           *  source for their agents. Shared spend, so explicit only. */
          shared: z.boolean().optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      if (parsed.data.model !== undefined) store.setAIProfileModel(profile.id, parsed.data.model);
      if ('models' in ((req.body ?? {}) as object)) {
        store.setAIProfileModels(profile.id, parsed.data.models);
      }
      if (parsed.data.shared !== undefined) {
        store.setAIProfileShared(profile.id, parsed.data.shared);
      }
      // Editing the model or its switchable list can orphan a per-agent pin.
      // effectiveModel already refuses to run a stale pin; also clear it from
      // stored state so the app doesn't misreport what an agent runs.
      if (parsed.data.model !== undefined || 'models' in ((req.body ?? {}) as object)) {
        const fresh = store.getAIProfile(profile.id)!;
        // Owner-scoped: on a SHARED profile another account's pin may be
        // perfectly valid for them, and clearing it silently moved their agent
        // onto our new default at its next rebuild.
        store.clearStaleAgentModels(fresh.id, [fresh.model, ...(fresh.models ?? [])], ownerIdOf(req));
      }
      const updated = store.getAIProfile(profile.id)!;
      const { secretRef: _s, ...safe } = updated;
      return safe;
    },
  );

  // Change the default model with EXPLICIT control over which of the caller's
  // existing agents adopt it (the "select agents, hold the rest" apply). The
  // plain PATCH above lets followers drift to the new default on their next
  // rebuild; this instead:
  //   • sets the new default,
  //   • clears the override on every SELECTED agent so it follows the new
  //     default (and optionally rebuilds it now), and
  //   • PINS every other agent of yours on this source to the model it runs
  //     today, so it never silently switches — the pinned models are kept on
  //     the menu so the pins stay valid.
  // Only your own agents are touched; a shared source's other users keep theirs.
  // Local sources run one model for the whole GPU, so they can't hold
  // individuals — they use the plain PATCH instead.
  app.post<{ Params: { id: string }; Body: { model?: string; models?: string[]; apply?: string[]; rebuild?: boolean } }>(
    '/v1/ai-profiles/:id/apply-default-model',
    async (req, reply) => {
      const profile = store.getAIProfile(req.params.id);
      if (!profile || profile.ownerId !== ownerIdOf(req)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      if (profile.vendor === 'local') {
        return reply.code(400).send({
          error: 'Local sources run one model for every agent — set the default and rebuild.',
        });
      }
      const parsed = z
        .object({
          model: z.string().trim().min(1),
          /** The owner's "also switchable" extras; the final menu adds held
           *  models on top so their pins stay valid. */
          models: z.array(z.string().min(1)).max(16).optional(),
          /** Agent ids that should switch TO the new default. Everything else
           *  of yours on this source is held on its current model. */
          apply: z.array(z.string()).max(500).optional(),
          /** Rebuild the switched agents now (else they show "rebuild to apply"). */
          rebuild: z.boolean().optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      const newDefault = parsed.data.model;
      const applyIds = new Set(parsed.data.apply ?? []);
      const oldDefault = profile.model;

      const mine = store.listAgents(ownerIdOf(req)).filter((a) => a.aiProfileId === profile.id);

      // First pin/clear each agent, collecting the models the held ones must
      // keep. Held = "runs today": its override, or the OLD default if it was a
      // follower. Selected = clear the override so it follows the new default.
      const heldModels = new Set<string>();
      let held = 0;
      let applied = 0; // agents actually changed — NOT the ids the caller sent
      for (const a of mine) {
        if (applyIds.has(a.id)) {
          applied++;
          if (a.model) store.setAgentModel(a.id, null);
        } else {
          const current = a.model ?? oldDefault;
          store.setAgentModel(a.id, current); // pin (no-op if already this override)
          heldModels.add(current);
          held++;
        }
      }

      // Menu must contain the new default, the owner's extras, AND every held
      // model — otherwise effectiveModel treats a held pin as stale and the
      // agent drifts to the new default, defeating the hold.
      const extras = parsed.data.models ?? (profile.models ?? []);
      const menu = [...new Set([newDefault, ...extras, ...heldModels])];
      store.setAIProfileModel(profile.id, newDefault);
      store.setAIProfileModels(profile.id, menu);
      // `menu` is built from OUR held models only, so scope the sweep to us —
      // another owner's pin isn't ours to clear.
      store.clearStaleAgentModels(profile.id, menu, ownerIdOf(req));

      let rebuilding = 0;
      if (parsed.data.rebuild) {
        for (const a of mine) {
          if (!applyIds.has(a.id)) continue;
          const fresh = store.getAgent(a.id);
          if (!fresh?.runtimeRef || fresh.migratedTo) continue; // moved-away copy: never rebuild
          if (fresh.state !== 'RUNNING' && fresh.state !== 'STOPPED') continue;
          if (kickRebuild(a.id)) rebuilding++;
        }
      }

      const { secretRef: _s, ...safe } = store.getAIProfile(profile.id)!;
      // `applied` counts agents this call actually touched. It previously
      // echoed applyIds.size, which over-reported when the caller passed ids
      // that aren't theirs (a shared profile's other users) — they're filtered
      // out of `mine`, so nothing happened to them.
      return { profile: safe, applied, held, rebuilding };
    },
  );

  // What models this profile could switch between — so the app can offer a
  // pick-list instead of making the owner hand-type IDs (a typo like
  // "claude-opus-4.8" provisions green and only fails on first use). Live for
  // a local server (it knows what it has pulled); a curated current list for
  // the cloud vendors. Own profile only.
  app.get<{ Params: { id: string } }>('/v1/ai-profiles/:id/available-models', async (req, reply) => {
    const profile = store.getAIProfile(req.params.id);
    if (!profile || (profile.ownerId !== ownerIdOf(req) && !profile.shared)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (profile.vendor === 'local') {
      if (!profile.baseUrl) return { models: [] };
      const root = profile.baseUrl.replace(/\/v1\/?$/, '');
      try {
        const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return { models: [], error: `The model server answered ${res.status}.` };
        const data = (await res.json()) as { models?: Array<{ name?: string }> };
        return { models: (data.models ?? []).map((m) => m.name ?? '').filter(Boolean) };
      } catch {
        return { models: [], error: "Couldn't reach the model server to list its models." };
      }
    }
    if (profile.vendor === 'google') {
      // Live list, since key holders get exactly what their key can call.
      const key = profile.secretRef ? await secrets.get(profile.secretRef).catch(() => undefined) : undefined;
      if (!key) return { models: [] };
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
          { signal: AbortSignal.timeout(6000) },
        );
        if (!res.ok) return { models: [] };
        const data = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
        const models = (data.models ?? [])
          .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
          .map((m) => (m.name ?? '').replace(/^models\//, ''))
          .filter(Boolean);
        return { models };
      } catch {
        return { models: [] };
      }
    }
    // Anthropic. Prefer asking a LIVE agent on this profile what its runtime
    // actually serves: a static list once offered claude-opus-5, which the
    // claude-cli (Max) runtime has no catalog entry for — it became a fleet
    // default and every conversation broke on compaction. See runtimeModels.
    const live = store
      .listAgents(ownerIdOf(req))
      .find((a) => a.aiProfileId === profile.id && a.state === 'RUNNING' && a.runtimeRef);
    if (live) {
      const found = await runtimeModels(providerFor(live.hostId), live.runtimeRef!, 'anthropic');
      const usable = found.filter((m) => m.catalogued).map((m) => m.id);
      // Only trust a non-empty answer; an old CLI without --all returns nothing.
      if (usable.length) {
        // Anything this profile still lists that the runtime does NOT serve is
        // junk (claude-opus-5 was exactly this). Report it separately instead of
        // blending it into the offered list, so the app can strip it from the
        // menu rather than keep presenting a model that breaks on compaction.
        const listed = [profile.model, ...(profile.models ?? [])].filter(Boolean) as string[];
        const stale = [...new Set(listed.filter((m) => !usable.includes(m)))];
        return { models: usable, stale, source: 'runtime' as const };
      }
    }
    // Fallback: a curated current list (no live agent to ask yet, e.g. the
    // profile's first agent hasn't been created). Offline-safe.
    return {
      models: [
        'claude-opus-4-8',
        'claude-sonnet-5',
        'claude-haiku-4-5',
        'claude-fable-5',
      ],
      source: 'curated' as const,
    };
  });

  app.delete<{ Params: { id: string } }>('/v1/ai-profiles/:id', async (req, reply) => {
    const profile = store.getAIProfile(req.params.id);
    if (!profile || profile.ownerId !== ownerIdOf(req)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    // In-use check must span all owners (a shared profile may power another
    // account's agent), but the message must not name THEIR agents to you.
    const using = store.listAllActiveAgents().filter((a) => a.aiProfileId === profile.id);
    if (using.length > 0) {
      const mine = using.filter((a) => a.ownerId === ownerIdOf(req));
      const others = using.length - mine.length;
      const parts = [
        ...mine.map((a) => a.name),
        ...(others > 0 ? [`${others} agent(s) on other accounts`] : []),
      ];
      return reply.code(400).send({
        error:
          `Still in use by ${parts.join(', ')} — ` +
          `switch ${using.length === 1 ? 'it' : 'them'} to another AI source first, or ` +
          `unshare this one and let those agents keep it until they move.`,
      });
    }
    if (profile.secretRef) await secrets.delete(profile.secretRef).catch(() => {});
    store.deleteAIProfile(profile.id);
    return { deleted: true };
  });

  // ---- CLI tokens ----------------------------------------------------------
  // How a non-browser client authenticates. Minted from an already-signed-in
  // session, so it works the same whether the owner uses Google, email, or
  // the shared password.

  app.get('/v1/cli-tokens', async (req) => store.listCliTokens(ownerIdOf(req)));

  app.post<{ Body: { label?: string } }>('/v1/cli-tokens', async (req, reply) => {
    const label = (req.body as { label?: string } | null)?.label ?? 'CLI';
    const { id, token } = store.createCliToken(ownerIdOf(req), label);
    // Shown once — only the hash is kept.
    return reply.code(201).send({ id, token });
  });

  app.delete<{ Params: { id: string } }>('/v1/cli-tokens/:id', async (req, reply) => {
    if (!store.revokeCliToken(ownerIdOf(req), req.params.id)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return { revoked: true };
  });

  // ---- agents ---------------------------------------------------------------

  app.post('/v1/agents', async (req, reply) => {
    const parsed = CreateAgent.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const ownerId = ownerIdOf(req);

    // Ownership, not mere existence: without this any authenticated caller
    // could run a container using the owner's AI credentials. Unknown-vs-
    // not-yours are the same answer on purpose. The one exception is a LOCAL
    // host: the machine is shared with every account on this installation
    // (see Store.listHosts) — what stays per-account is the AI credential.
    const profile = store.getAIProfile(parsed.data.aiProfileId);
    const host = store.getHost(parsed.data.hostId);
    if (!profile || (profile.ownerId !== ownerId && !profile.shared)) {
      return reply.code(400).send({ error: 'Unknown AI profile' });
    }
    if (!host || (host.ownerId !== ownerId && host.kind !== 'local')) {
      return reply.code(400).send({ error: 'Unknown host' });
    }
    // A Claude Max profile reaches a runner only as a setup-token (secretRef
    // present) — that credential is injected as data. The machine-login flavour
    // mounts this box's ~/.claude, which a remote runner can't see.
    // ⚠ ACCEPTED RISK — see docs/pre-production.md. A machine-login Max source
    // is its owner's ~/.claude; letting another account select it mounts that
    // directory into their container. Deliberately permitted on this trusted
    // single-household installation. Re-add the owner check here (and in the
    // profile-switch path below, and in buildRuntimeSpec) before production.
    if (profile.kind === 'subscription' && host.kind !== 'local' && !profile.secretRef) {
      return reply.code(400).send({
        error:
          "This Claude Max profile uses this machine's login, which can't reach a runner. " +
          'Run `claude setup-token` and add it as a setup-token AI source, or use an API-key profile.',
      });
    }

    // A per-agent model override, if given, must belong to the profile's menu
    // and never applies to a local source.
    const modelProblem = modelOverrideProblem(profile, parsed.data.model);
    if (modelProblem) return reply.code(400).send({ error: modelProblem });

    // Optional per-account ceiling: on a shared box this bounds how many
    // agents (and pool bots, ports, containers) one account can consume.
    // Unset = no limit, preserving the single-owner default.
    const maxPerAccount = Number(process.env.AGENTCLAW_MAX_AGENTS_PER_ACCOUNT ?? 0);
    if (maxPerAccount > 0 && store.listAgents(ownerId).length >= maxPerAccount) {
      return reply.code(429).send({
        error: `You've reached the limit of ${maxPerAccount} agents on this server. Delete one first.`,
      });
    }

    // The slug is derived from the name and is UNIQUE per owner — it becomes
    // a container name and a workspace path. Catch the collision here: letting
    // it reach the INSERT surfaces a raw SQLite error as "Internal Server
    // Error", which tells the owner nothing about what to do next.
    const slug = slugify(parsed.data.name);
    const clash = store
      .listAllActiveAgents()
      .find((a) => a.ownerId === ownerId && a.slug === slug);
    if (clash) {
      return reply.code(409).send({
        error:
          `You already have an agent called "${clash.name}" (${clash.state.toLowerCase()}). ` +
          `Pick a different name, or delete that one first.`,
      });
    }

    const { seedMembers, skipPool, ...create } = parsed.data;
    const agent = createAgentRecord(store, { ownerId, ...create });
    // One-shot preference for the provision that's about to run: skip the
    // pool and walk BotFather. After the manual flow parks the agent with a
    // pendingAction, that persisted state drives every retry — the flag only
    // needs to survive until the first channel.provision call.
    if (skipPool) skipPoolOnce.add(agent.id);
    // Must land before provisioning renders the config: allowFrom is seeded
    // onto the fresh volume there, and a member added afterwards would have to
    // pair like a stranger.
    for (const channelUserId of seedMembers ?? []) {
      // Skip anyone already admitted. Most importantly the OWNER: adopt seeds
      // from the source bot's allowFrom, which includes the owner's own
      // Telegram id — and createAgentRecord already bound it to the owner seat
      // via pair-once. Seeding it again would list the owner twice (owner seat
      // + a member row), the exact split link-owner-telegram.ts had to repair.
      // Also dedupes any repeated ids within seedMembers itself.
      if (store.getActiveMembershipByChannelUser(agent.id, channelUserId)) continue;
      store.insertMembership({
        id: randomUUID(),
        agentId: agent.id,
        userId: `telegram:${channelUserId}`,
        role: 'user',
        channelUserId,
        status: 'active',
        joinedAt: new Date().toISOString(),
      });
    }
    kickProvision(agent.id);
    return reply.code(202).send(agent);
  });

  // "Last active" = newest OpenClaw session update inside the runtime. The
  // CLI costs ~1s to start in-container, and the app polls the agent list
  // every few seconds — so cache per agent and refresh at most once a minute.
  const lastActiveCache = new Map<string, { fetchedAt: number; value?: string }>();
  const lastActiveFor = async (a: Agent): Promise<string | undefined> => {
    if (!a.runtimeRef || a.state !== 'RUNNING') return undefined;
    const hit = lastActiveCache.get(a.id);
    if (hit && Date.now() - hit.fetchedAt < 60_000) return hit.value;
    let value: string | undefined;
    try {
      const res = await providerFor(a.hostId).exec(a.runtimeRef, [
        'sessions', 'list', '--agent', a.slug, '--json',
      ]);
      if (res.code === 0) {
        const sessions: Array<{ updatedAt?: number }> = JSON.parse(res.stdout).sessions ?? [];
        const newest = Math.max(0, ...sessions.map((s) => s.updatedAt ?? 0));
        if (newest > 0) value = new Date(newest).toISOString();
      }
    } catch {
      /* diagnostic only — omit rather than fail the list */
    }
    lastActiveCache.set(a.id, { fetchedAt: Date.now(), value });
    return value;
  };

  app.get<{ Querystring: { all?: string } }>('/v1/agents', async (req, reply) => {
    // ?all=1: the HOST OWNER's admin view — every user's agents, with their
    // ownerId, so orphans from other logins (an old test account's leftovers)
    // are findable and cleanable. Listing metadata only: memory, files, and
    // conversations stay behind the per-agent ownership checks as always.
    const all = req.query.all === '1';
    if (all && !ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const agents = all ? store.listAllActiveAgents() : store.listVisibleAgents(ownerIdOf(req));
    return Promise.all(
      agents.map(async (a) => {
        let openclawVersion: string | undefined;
        let latestOpenclawVersion: string | undefined;
        let updateAvailable = false;
        if (a.runtimeRef && (a.state === 'RUNNING' || a.state === 'STOPPED')) {
          try {
            const provider = providerFor(a.hostId);
            const [running, current] = await Promise.all([
              provider.info(a.runtimeRef),
              provider.currentImageInfo(),
            ]);
            openclawVersion = running.openclawVersion;
            latestOpenclawVersion = current.openclawVersion;
            // Compare image ids, never tags — :latest gets reassigned in place.
            // Note this fires for ANY image rebuild, including a same-version one
            // (e.g. base tooling added), not only an OpenClaw version bump — the
            // app words it from the two versions so it doesn't over-claim.
            updateAvailable = !!(
              running.imageId && current.imageId && running.imageId !== current.imageId
            );
          } catch {
            /* provider hiccup — omit version info rather than fail the list */
          }
        }
        const chan = store.getChannelForAgent(a.id);
        return publicAgent(a, {
          /** What the viewer may do — drives which controls the app renders. */
          role: store.accessRole(a.id, ownerIdOf(req)),
          deepLink: chan?.deepLink,
          botUsername: chan?.accountId,
          /** Pool-leased bots auto-recycle on delete; pasted ones are offered
           *  a trip INTO the pool — the app needs to know which is which. */
          botPooled: chan ? deps.channel.pool.owns(chan.accountId) : undefined,
          // Default model from the agent's AI profile. Applied config can lag
          // one rebuild behind, and /model can switch a single chat session —
          // this is "what it runs by default", which is what the card answers.
          lastActiveAt: await lastActiveFor(a),
          modelWarm: await (async () => {
            const p = store.getAIProfile(a.aiProfileId);
            if (p?.vendor !== 'local' || !p.baseUrl) return undefined;
            return (await warmLocalModels(p.baseUrl)).includes(a.appliedModel ?? p.model);
          })(),
          openclawVersion,
          latestOpenclawVersion,
          updateAvailable,
        });
      }),
    );
  });

  // Recent runtime output — the "is it alive and what is it doing" view.
  app.get<{ Params: { id: string }; Querystring: { lines?: string } }>(
    '/v1/agents/:id/logs',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
      // Clamp both ends: a negative `?lines` slipped through Math.min into
      // `docker logs --tail -5`, which means "everything".
      const lines = Math.min(Math.max(Math.floor(Number(req.query.lines ?? 80)) || 80, 1), 500);
      const text = await providerFor(agent.hostId).logs(agent.runtimeRef, lines);
      return { text };
    },
  );

  // Workspace file editing — the "full OpenClaw interface" promise (§9.3):
  // the persona and memory are the user's files, editable from the app.
  const EDITABLE_FILES = new Set(['SOUL.md', 'AGENTS.md', 'MEMORY.md']);
  const workspacePath = (slug: string, name: string) =>
    `/home/node/.openclaw/agents/${slug}/agent/${name}`;

  // Owner-editable agent settings. `name` is display-only (the slug, workspace
  // and bot identity never change). `sharedMemory` flips memory between shared
  // and private — only while the agent has no other members (the disclosure
  // people joined under must not change shape beneath them) and only while
  // RUNNING, because the AGENTS.md policy section is rewritten in place.
  app.patch<{ Params: { id: string }; Body: { name?: string; sharedMemory?: boolean; aiProfileId?: string } }>(
    '/v1/agents/:id',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const parsed = z
        .object({
          name: z.string().trim().min(1).max(64).optional(),
          /** The card's one-line description (stored persona). Cosmetic and
           *  immediate — it does NOT touch the running SOUL.md, which is edited
           *  as a file in the Definition tab. Empty string clears it. */
          persona: z.string().max(4000).optional(),
          sharedMemory: z.boolean().optional(),
          /** Switch which AI drives this agent — applied on the next rebuild. */
          aiProfileId: z.string().min(1).optional(),
          /**
           * Per-agent model override, chosen from the profile's menu — applied
           * on the next rebuild. `null` clears it (back to the profile default).
           */
          model: z.string().min(1).max(64).nullable().optional(),
          /** Clear the moved-away tombstone: "this really does run here now". */
          runsHere: z.literal(true).optional(),
          /** Host folders this agent may READ. Applied on the next rebuild. */
          sharedPaths: z.array(z.string().min(1).max(512)).max(8).optional(),
          /** Organize into a group; empty string or null clears it. Cosmetic —
           *  takes effect immediately, no rebuild. */
          group: z.string().trim().max(48).nullable().optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      const { name, persona, sharedMemory: shared, aiProfileId, model, runsHere, group } = parsed.data;
      if (
        name === undefined &&
        persona === undefined &&
        shared === undefined &&
        aiProfileId === undefined &&
        model === undefined &&
        !runsHere &&
        parsed.data.sharedPaths === undefined &&
        group === undefined
      ) {
        return reply.code(400).send({ error: 'Nothing to update' });
      }

      if (persona !== undefined) store.setAgentPersona(agent.id, persona.trim());

      if (group !== undefined) store.setAgentGroup(agent.id, group ? group : null);

      if (runsHere) store.setAgentMigratedTo(agent.id, null);

      if (parsed.data.sharedPaths) {
        const paths = parsed.data.sharedPaths.map((p) => p.trim()).filter(Boolean);
        // Mounting host folders is the machine owner's privilege only — the
        // blocklist below is owner-blind, so on a shared box a second account
        // could otherwise read another user's files through their own agent.
        if (paths.length && !ownsLocalHost(req)) {
          return reply.code(403).send({ error: HOST_PATH_DENIED });
        }
        for (const p of paths) {
          // Refuse the dangerous ones by name, and require the folder to
          // exist — a typo would otherwise mount an empty directory and the
          // agent would simply report finding nothing.
          const problem = sharePathProblem(p);
          if (problem) return reply.code(400).send({ error: problem });
          if (!existsSync(p)) {
            return reply.code(400).send({ error: `No such folder on this machine: ${p}` });
          }
        }
        if (new Set(paths.map((p) => p.replace(/\/+$/, '').split('/').pop())).size !== paths.length) {
          return reply.code(400).send({
            error: 'Two folders share a name — the agent would see them at the same place.',
          });
        }
        // A legacy folder must not shadow a data source at the same /data/<name>:
        // both mount there and Docker would silently keep only one.
        const dsNames = new Set(store.listDataSources(agent.id).map((d) => d.mountName));
        const clash = paths.map((p) => p.replace(/\/+$/, '').split('/').pop()!).find((n) => dsNames.has(n));
        if (clash) {
          return reply.code(409).send({
            error: `A data source already lives at /data/${clash}. Remove it before mounting a folder with the same name.`,
          });
        }
        store.setAgentSharedPaths(agent.id, paths);
      }

      // Validate the AI-source switch AND the model override together, BEFORE
      // writing either. A combined request with a valid profile but an off-menu
      // model must be rejected whole — not leave the agent half-switched.
      let switchingProfile = false;
      let target = store.getAIProfile(agent.aiProfileId); // the profile it WILL have
      if (aiProfileId !== undefined && aiProfileId !== agent.aiProfileId) {
        // The caller's own profile, or one shared with the installation —
        // same rule as agent creation.
        const next = store.getAIProfile(aiProfileId);
        if (!next || (next.ownerId !== ownerIdOf(req) && !next.shared)) {
          return reply.code(400).send({ error: 'Unknown AI profile' });
        }
        // ⚠ ACCEPTED RISK — see docs/pre-production.md; the cross-owner check
        // that belongs here is deliberately omitted for this trusted install.
        const host = store.getHost(agent.hostId);
        // Same rule as create/move: a setup-token Max profile (secretRef
        // present) rides to a runner; only the machine-login flavour is
        // desktop-only. Without the secretRef check a runner agent couldn't be
        // switched to a setup-token source it could have been created with.
        if (
          next.vendor !== 'local' &&
          next.kind === 'subscription' &&
          host?.kind !== 'local' &&
          !next.secretRef
        ) {
          return reply.code(400).send({
            error:
              "This Claude Max profile uses this machine's login, which can't reach a runner. " +
              'Use a setup-token Max source or an API key for a runner agent.',
          });
        }
        target = next;
        switchingProfile = true;
      }
      if (model !== undefined) {
        if (!target) return reply.code(400).send({ error: 'Unknown AI profile' });
        const problem = modelOverrideProblem(target, model);
        if (problem) return reply.code(400).send({ error: problem });
      }

      // The memory-policy rewrite is the ONLY failable write here (it touches
      // the container and can 502). Do its checks and the write FIRST, so that a
      // 400/409/502 leaves the agent entirely unchanged — the DB writes below
      // are infallible, so applying them last keeps the whole PATCH atomic.
      const flippingMemory = shared !== undefined && shared !== agent.sharedMemory;
      if (flippingMemory) {
        const others = store
          .listMemberships(agent.id)
          .filter((m) => m.status === 'active' && m.role !== 'owner');
        if (others.length > 0) {
          return reply.code(400).send({
            error: 'This agent has members. Remove them first — what they were told about memory must stay true.',
          });
        }
        if (agent.state !== 'RUNNING' || !agent.runtimeRef) {
          return reply.code(409).send({ error: 'Start the agent to change its memory policy.' });
        }
        // Rewrite AGENTS.md; the flag is persisted below only because we reached
        // it (the write succeeded). Persisting the flag before the write left the
        // stored policy and the agent's file permanently disagreeing on failure —
        // nothing reconciles them (rebuild never overwrites an existing AGENTS.md).
        const provider = providerFor(agent.hostId);
        const path = workspacePath(agent.slug, 'AGENTS.md');
        // Hold the busy guard for the read-modify-write so it can't interleave a
        // volume tar (export/migrate/restore) mid-rewrite.
        let write;
        try {
          write = await whileBusy(agent.id, async () => {
            const read = await provider.execShell(
              agent.runtimeRef!,
              `cat ${JSON.stringify(path)} 2>/dev/null || true`,
            );
            const next = replaceMemoryPolicy(read.stdout, memoryPolicySection(shared!));
            const b64 = Buffer.from(next, 'utf8').toString('base64');
            return provider.execShell(
              agent.runtimeRef!,
              `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(path)}`,
            );
          });
        } catch (err) {
          if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
          throw err;
        }
        if (write.code !== 0) {
          app.log.warn({ agentId: agent.id, stderr: write.stderr }, 'memory policy rewrite failed');
          return reply.code(502).send({
            error: "Couldn't update the agent's memory policy — nothing was changed. Try again in a moment.",
          });
        }
      }

      // All checks passed and the only failable write succeeded — apply the
      // infallible DB writes together, so nothing was half-committed on a 502.
      if (name !== undefined && name !== agent.name) {
        store.setAgentName(agent.id, name);
        // Keep Telegram in step: the bot's display name is what people see in
        // the chat header, and it previously froze at whatever the agent was
        // called when its token was first leased (or, for a hand-pasted bot,
        // at whatever BotFather was told). Fire-and-forget — cosmetic, and
        // Telegram rate-limits setMyName.
        const chan = store.getChannelForAgent(agent.id);
        if (chan?.kind === 'telegram') {
          void secrets
            .get(chan.secretRef)
            .then((tok) => setTelegramDisplayName(tok, name))
            .then((ok) => trace(agent.id)('channel.renamed', { name, ok }))
            .catch(() => {});
        }
      }
      if (switchingProfile) store.setAgentAIProfile(agent.id, aiProfileId!);
      if (model !== undefined) {
        store.setAgentModel(agent.id, model);
      } else if (switchingProfile && agent.model && target && modelOverrideProblem(target, agent.model)) {
        // The switch strands the old pin (new source lacks it, or is local).
        // Drop it so the agent falls back to the new source's default.
        store.setAgentModel(agent.id, null);
      }
      if (flippingMemory) store.setAgentSharedMemory(agent.id, shared!);

      return publicAgent(store.getAgent(agent.id)!);
    },
  );

  app.get<{ Params: { id: string; name: string } }>(
    '/v1/agents/:id/files/:name',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
      if (!EDITABLE_FILES.has(req.params.name)) return reply.code(400).send({ error: 'Not editable' });
      if (agent.state !== 'RUNNING') {
        return reply.code(409).send({ error: 'Start the agent to edit its files.' });
      }
      const res = await providerFor(agent.hostId).execShell(
        agent.runtimeRef,
        `cat ${JSON.stringify(workspacePath(agent.slug, req.params.name))} 2>/dev/null || true`,
      );
      return { name: req.params.name, content: res.stdout };
    },
  );

  app.put<{ Params: { id: string; name: string }; Body: { content?: string } }>(
    '/v1/agents/:id/files/:name',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
      if (!EDITABLE_FILES.has(req.params.name)) return reply.code(400).send({ error: 'Not editable' });
      const content = (req.body as { content?: string } | null)?.content;
      if (typeof content !== 'string') return reply.code(400).send({ error: 'content required' });
      if (agent.state !== 'RUNNING') {
        return reply.code(409).send({ error: 'Start the agent to edit its files.' });
      }
      // Hold the busy guard for the write: an export/migrate/restore that tars
      // or replaces this same volume must not interleave a torn edit.
      if (busyNow(agent, reply)) return reply;
      // base64 through the shell so arbitrary content can't break quoting.
      const b64 = Buffer.from(content, 'utf8').toString('base64');
      const path = workspacePath(agent.slug, req.params.name);
      try {
        const res = await whileBusy(agent.id, async () => {
          // Version the files BEFORE overwriting — a bad save must be recoverable.
          await autoSnapshot(snapshotDeps(agent), agent.id, 'pre-edit');
          return providerFor(agent.hostId).execShell(
            agent.runtimeRef!,
            `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(path)}`,
          );
        });
        if (res.code !== 0) return reply.code(500).send({ error: 'Write failed' });
        return { saved: true };
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // ---- snapshots (core-file history) ---------------------------------------

  app.get<{ Params: { id: string } }>('/v1/agents/:id/snapshots', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return store.listSnapshots(agent.id);
  });

  app.post<{ Params: { id: string }; Body: { label?: string } }>(
    '/v1/agents/:id/snapshots',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      try {
        const snap = await captureSnapshot(snapshotDeps(agent), agent.id, {
          label: (req.body as { label?: string } | null)?.label,
        });
        return reply.code(201).send(snap);
      } catch (err) {
        if (err instanceof SnapshotError) return reply.code(409).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string; snapId: string } }>(
    '/v1/agents/:id/snapshots/:snapId',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      const snap = agent && store.getSnapshot(agent.id, req.params.snapId);
      if (!snap) return reply.code(404).send({ error: 'Not found' });
      return snap;
    },
  );

  app.post<{ Params: { id: string; snapId: string } }>(
    '/v1/agents/:id/snapshots/:snapId/restore',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      // Restore writes the volume — the one mutating route that lacked a busy
      // guard, so a restore could interleave with a migrate/adopt/export
      // reading or replacing the same volume. Hold the flag for the write.
      if (busyNow(agent, reply)) return reply;
      try {
        return await whileBusy(agent.id, () =>
          restoreSnapshot(snapshotDeps(agent), agent.id, req.params.snapId),
        );
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof SnapshotError) return reply.code(409).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string; snapId: string } }>(
    '/v1/agents/:id/snapshots/:snapId',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (!store.deleteSnapshot(agent.id, req.params.snapId)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return { deleted: true };
    },
  );

  app.get<{ Params: { id: string } }>('/v1/agents/:id', async (req, reply) => {
    const agent = visibleAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const channel = store.getChannelForAgent(agent.id);
    return publicAgent(agent, { deepLink: channel?.deepLink });
  });

  // On-demand Control UI credential — same shape as the bot-token reveal, so
  // the token is fetched by an explicit click, not broadcast in every poll.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/gateway', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.gatewayPort || !agent.gatewayToken) {
      return reply.code(404).send({ error: 'This agent has no debug gateway yet — rebuild it.' });
    }
    return { port: agent.gatewayPort, token: agent.gatewayToken };
  });

  /**
   * Reverse-proxy an agent's OpenClaw Control UI through the control plane.
   *
   * The gateway port is published on the HOST's loopback only — deliberately,
   * since it grants full control of that agent and must not be reachable from
   * the LAN/tailnet. But that also meant the "OpenClaw (debug)" button opened
   * `http://<whatever-host-you-browse>:<port>` and simply hung: correct for
   * someone sitting at the machine, broken for everyone else.
   *
   * Proxying instead keeps the port closed and reuses the session you already
   * have. The gateway's own bearer token still rides in the URL *fragment*,
   * which browsers never send to a server, so it stays client-side exactly as
   * before. Relative asset paths resolve under this prefix, so the UI loads
   * unmodified.
   */
  const gatewayTarget = (req: FastifyRequest, id: string): { port: number } | undefined => {
    const agent = ownedAgent(req, id);
    if (!agent?.gatewayPort || !agent.gatewayToken || agent.state !== 'RUNNING') return undefined;
    return { port: agent.gatewayPort };
  };

  app.all<{ Params: { id: string; '*': string } }>('/v1/agents/:id/ui', async (req, reply) => {
    // The UI is a SPA served from a directory; without the trailing slash its
    // relative asset paths would resolve one level too high.
    return reply.redirect(`/v1/agents/${req.params.id}/ui/`);
  });

  app.all<{ Params: { id: string; '*': string } }>('/v1/agents/:id/ui/*', async (req, reply) => {
    const target = gatewayTarget(req, req.params.id);
    if (!target) return reply.code(404).send({ error: 'No debug gateway for this agent.' });
    const path = `/${req.params['*'] ?? ''}`;
    const qs = req.raw.url?.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
    const upstream = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>(
      (resolve, reject) => {
        const r = httpRequest(
          {
            host: '127.0.0.1',
            port: target.port,
            path: path + qs,
            method: req.method,
            // Drop hop-by-hop and our own host header; keep auth/content ones.
            headers: { ...req.headers, host: `127.0.0.1:${target.port}`, connection: 'close' },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }),
            );
          },
        );
        r.on('error', reject);
        if (req.body !== undefined && req.body !== null) {
          r.end(typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body));
        } else r.end();
      },
    ).catch(() => undefined as never);
    if (!upstream) return reply.code(502).send({ error: "The agent's gateway did not answer." });
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (v !== undefined && !/^(transfer-encoding|connection|content-length)$/i.test(k)) reply.header(k, v);
    }
    return reply.code(upstream.status).send(upstream.body);
  });

  // The Control UI opens a WebSocket for live updates; without it the page
  // loads but never comes alive ("Could not connect"). Fastify never sees an
  // upgrade, so hook the raw server and splice the sockets together.
  //
  // Authorization goes through auth.ts's own resolver rather than a re-implementation:
  // deriving the principal here by hand would duplicate session logic across
  // password and identity modes, and anything that silently fell back to
  // LOCAL_OWNER would forward an UNAUTHENTICATED upgrade on a password-mode
  // install. No resolver (or no session) means the socket is destroyed.
  app.server.on('upgrade', (rawReq, socket, head) => {
    const url = rawReq.url ?? '';
    const m = /^\/v1\/agents\/([^/]+)\/ui\/?([^?]*)/.exec(url);
    if (!m) return; // not ours — leave it alone
    const deny = () => socket.destroy();
    const resolve = app.principalFromCookieHeader;
    if (!resolve) return deny();
    const principal = resolve(rawReq.headers.cookie);
    if (!principal) return deny();

    // Same ownership rule as every other agent route, against the real caller.
    const agent = store.getAgent(m[1]!);
    if (
      !agent ||
      agent.ownerId !== principal.ownerId ||
      agent.state !== 'RUNNING' ||
      !agent.gatewayPort
    ) {
      return deny();
    }

    const qs = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    const up = httpRequest({
      host: '127.0.0.1',
      port: agent.gatewayPort,
      path: `/${m[2] ?? ''}${qs}`,
      method: 'GET',
      headers: { ...rawReq.headers, host: `127.0.0.1:${agent.gatewayPort}` },
    });
    up.on('upgrade', (upRes, upSocket, upHead) => {
      socket.write(
        [
          `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`,
          ...Object.entries(upRes.headers).flatMap(([k, v]) =>
            Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v !== undefined ? [`${k}: ${v}`] : [],
          ),
          '',
          '',
        ].join('\r\n'),
      );
      if (upHead?.length) upSocket.unshift(upHead);
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
      upSocket.pipe(socket).pipe(upSocket);
    });
    up.on('error', deny);
    up.end(head?.length ? head : undefined);
  });

  // Add a data source. Folders are host mounts (ro/rw), gated to the machine
  // owner + blocklist. Git repos are cloned onto the agent's own volume with a
  // generated deploy key — no host access, so any agent owner may add one; the
  // clone happens on the next rebuild. Both apply on rebuild.
  app.post<{
    Params: { id: string };
    Body: { kind?: string; access?: string; path?: string; repoUrl?: string; atHostPath?: boolean };
  }>('/v1/agents/:id/data-sources', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const parsed = z
      .object({
        kind: z.enum(['folder', 'git']),
        access: z.enum(['ro', 'rw']),
        path: z.string().min(1).max(512).optional(),
        repoUrl: z.string().min(1).max(512).optional(),
        /** Adopted agents: bind at the original host path, not /data/<name>. */
        atHostPath: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const { kind, access } = parsed.data;

    // Reject a mount-name clash across legacy folders + every data source.
    const clashes = (name: string) =>
      new Set([
        ...(agent.sharedPaths ?? []).map((x) => basename(x.replace(/\/+$/, ''))),
        ...store.listDataSources(agent.id).map((d) => d.mountName),
      ]).has(name);

    if (kind === 'folder') {
      const p = (parsed.data.path ?? '').trim();
      if (!p) return reply.code(400).send({ error: 'A folder path is required.' });
      if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
      const problem = sharePathProblem(p);
      if (problem) return reply.code(400).send({ error: problem });
      if (!existsSync(p)) return reply.code(400).send({ error: `No such folder on this machine: ${p}` });
      const atHostPath = parsed.data.atHostPath === true;
      // Host-path mounts key their unique name off the full path (two folders
      // can share a basename); /data mounts key off the basename as before.
      const mountName = atHostPath
        ? p.replace(/^\/+|\/+$/g, '').replace(/[^\w.-]+/g, '-')
        : basename(p.replace(/\/+$/, ''));
      if (clashes(mountName)) {
        return reply.code(409).send({
          error: atHostPath
            ? `${p} is already shared with this agent.`
            : `Another source already lives at /data/${mountName}. Rename or remove it first.`,
        });
      }
      store.insertDataSource({
        id: randomUUID(), agentId: agent.id, kind: 'folder', access, mountName,
        hostPath: p, mountAtHostPath: atHostPath, createdAt: new Date().toISOString(),
      });
      return publicAgent(store.getAgent(agent.id)!);
    }

    // git
    const git = normalizeGitUrl(parsed.data.repoUrl ?? '');
    if (!git) {
      return reply.code(400).send({ error: 'Not a recognizable git repo. Use git@host:owner/repo.git or https://host/owner/repo.' });
    }
    // git repos clone beside OpenClaw's own dirs under ~/.openclaw; a repo whose
    // name matches one of them (or a dotfile) would collide with runtime state.
    const RESERVED = new Set(['agents', 'sessions', 'config', 'logs', 'pylibs', 'skills', 'memory', 'workspace']);
    if (RESERVED.has(git.repoName) || git.repoName.startsWith('.')) {
      return reply.code(400).send({ error: `"${git.repoName}" is a reserved name — it would collide with the agent's own files. Use a differently named repo.` });
    }
    if (clashes(git.repoName)) {
      return reply.code(409).send({ error: `Another source is already named "${git.repoName}". Remove it first.` });
    }
    const id = randomUUID();
    let key: { privateKey: string; publicKey: string };
    try {
      key = generateDeployKey(`agentclaw-${agent.slug}-${git.repoName}-deploy`);
    } catch {
      return reply.code(500).send({ error: 'Could not generate a deploy key — this server needs `ssh-keygen` (openssh-client).' });
    }
    const secretRef = `data-source/${id}`;
    await secrets.put(secretRef, key.privateKey);
    store.insertDataSource({
      id, agentId: agent.id, kind: 'git', access, mountName: git.repoName,
      repoUrl: git.sshUrl, secretRef, pubKey: key.publicKey, createdAt: new Date().toISOString(),
    });
    return publicAgent(store.getAgent(agent.id)!);
  });

  // Flip a source between read-only and writable, without the remove-and-re-add
  // dance (which for a git repo meant a fresh clone AND a new deploy key).
  // Applies on the next rebuild: a container's bind mounts are fixed once it's
  // running. For git this is a documented intent, not an enforcement — the repo
  // is cloned onto the volume, so what a push is actually allowed to do is the
  // deploy key's permission on the host.
  app.patch<{ Params: { id: string; dsId: string }; Body: { access?: string } }>(
    '/v1/agents/:id/data-sources/:dsId',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const src = store.getDataSource(agent.id, req.params.dsId);
      if (!src) return reply.code(404).send({ error: 'No such data source.' });
      const parsed = z.object({ access: z.enum(['ro', 'rw']) }).safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      // Same gate as creating a writable folder: granting write to a host folder
      // is the machine owner's call, not any agent owner's.
      if (src.kind === 'folder' && parsed.data.access === 'rw' && !ownsLocalHost(req)) {
        return reply.code(403).send({ error: HOST_PATH_DENIED });
      }
      store.setDataSourceAccess(agent.id, src.id, parsed.data.access);
      return publicAgent(store.getAgent(agent.id)!);
    },
  );

  app.delete<{ Params: { id: string; dsId: string } }>(
    '/v1/agents/:id/data-sources/:dsId',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const src = store.getDataSource(agent.id, req.params.dsId);
      if (!src) return reply.code(404).send({ error: 'No such data source.' });
      store.deleteDataSource(agent.id, req.params.dsId);
      // Drop the deploy key's private half too. The on-volume clone/key linger
      // until the next rebuild — harmless, and the portable secret is gone.
      if (src.secretRef) await secrets.delete(src.secretRef).catch(() => {});
      return publicAgent(store.getAgent(agent.id)!);
    },
  );

  // ---- Per-agent environment variables -----------------------------------
  // An API key or config the agent's own tools need, injected at provision.
  // Values are secrets: stored in the SecretStore, never returned, applied on
  // the next rebuild.
  //
  // Names are refused by SHAPE, not an exact deny-list. This is a security
  // boundary, not just hygiene: an agent can run on a profile SHARED by another
  // account (§multi-user), so a per-agent var must never be able to redirect
  // where that owner's model credential is sent, or alter code/cert loading.
  // Blocking only the credential *names* left `ANTHROPIC_BASE_URL` / `HTTPS_PROXY`
  // open — enough to point the shared key at an attacker and exfiltrate it.
  const RESERVED_ENV_EXACT = new Set([
    'PATH', 'HOME', 'PYTHONPATH', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'BASH_ENV',
    'SHELL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  ]);
  const reservedEnvProblem = (name: string): string | undefined => {
    const u = name.toUpperCase();
    if (RESERVED_ENV_EXACT.has(u)) return `"${name}" is managed by AgentClaw and can't be set here.`;
    // Proxy vars (read in either case by curl/requests) redirect all traffic.
    if (/(^|_)(HTTP|HTTPS|ALL|NO)_PROXY$/.test(u)) {
      return `"${name}" could redirect the agent's traffic and can't be set here.`;
    }
    // Model-provider / cloud credential + endpoint families — the exfil vector.
    if (/^(ANTHROPIC|CLAUDE|GEMINI|GOOGLE|GCP|VERTEX|OPENAI|AZURE|AWS|COHERE|MISTRAL)_/.test(u)) {
      return `"${name}" is reserved — model-provider and credential variables can't be set here.`;
    }
    // Loader / TLS knobs that alter how the agent loads code or trusts certs.
    if (/^(LD_|NODE_|OPENSSL_|SSL_)/.test(u)) {
      return `"${name}" is reserved — it could change how the agent loads code or trusts certificates.`;
    }
    return undefined;
  };

  app.post<{ Params: { id: string }; Body: { name?: string; value?: string } }>(
    '/v1/agents/:id/env',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const parsed = z
        .object({ name: z.string().trim().min(1).max(128), value: z.string().min(1).max(8192) })
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      const { name, value } = parsed.data;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return reply.code(400).send({
          error: 'Not a valid variable name — use letters, digits and underscores, not starting with a digit.',
        });
      }
      const reserved = reservedEnvProblem(name);
      if (reserved) return reply.code(400).send({ error: reserved });
      if (store.listAgentEnv(agent.id).some((e) => e.name === name)) {
        return reply.code(409).send({ error: `"${name}" is already set — remove it first to change its value.` });
      }
      const id = randomUUID();
      const secretRef = `agent-env/${id}`;
      await secrets.put(secretRef, value);
      try {
        store.insertAgentEnv({ id, agentId: agent.id, name, secretRef, createdAt: new Date().toISOString() });
      } catch (err) {
        await secrets.delete(secretRef).catch(() => {});
        throw err;
      }
      return publicAgent(store.getAgent(agent.id)!);
    },
  );

  app.delete<{ Params: { id: string; envId: string } }>(
    '/v1/agents/:id/env/:envId',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const e = store.getAgentEnv(agent.id, req.params.envId);
      if (!e) return reply.code(404).send({ error: 'No such variable.' });
      store.deleteAgentEnv(agent.id, req.params.envId);
      await secrets.delete(e.secretRef).catch(() => {});
      return publicAgent(store.getAgent(agent.id)!);
    },
  );

  // Reorder within the agent's group section. Cosmetic, immediate, no rebuild.
  app.post<{ Params: { id: string }; Body: { dir?: string } }>(
    '/v1/agents/:id/move',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const dir = (req.body as { dir?: string } | null)?.dir;
      if (dir !== 'up' && dir !== 'down') {
        return reply.code(400).send({ error: 'dir must be "up" or "down".' });
      }
      store.moveAgent(agent.id, dir);
      return { ok: true };
    },
  );

  // Reorder a whole group section up/down in the caller's list.
  app.post<{ Body: { group?: string; dir?: string } }>('/v1/groups/move', async (req, reply) => {
    const { group, dir } = (req.body ?? {}) as { group?: string; dir?: string };
    if (!group || (dir !== 'up' && dir !== 'down')) {
      return reply.code(400).send({ error: 'group and dir ("up" | "down") are required.' });
    }
    store.moveGroup(ownerIdOf(req), group, dir);
    return { ok: true };
  });

  // ---- Scheduled tasks (OpenClaw crons) ----------------------------------
  // Crons live in the agent's own OpenClaw gateway store on its durable volume
  // (they survive rebuilds like MEMORY.md). We drive them through the
  // in-container `openclaw cron` CLI — never the store directly — exactly as
  // sessions/pairing do. The gateway must be up, so every route needs RUNNING.
  const runningAgent = (
    req: FastifyRequest,
    id: string,
    reply: any,
    action = 'manage its scheduled tasks',
  ): Agent | undefined => {
    const agent = ownedAgent(req, id);
    if (!agent) {
      reply.code(404).send({ error: 'Not found' });
      return undefined;
    }
    if (agent.state !== 'RUNNING' || !agent.runtimeRef) {
      reply.code(409).send({ error: `Start the agent to ${action}.` });
      return undefined;
    }
    return agent;
  };

  app.get<{ Params: { id: string } }>('/v1/agents/:id/crons', async (req, reply) => {
    const agent = runningAgent(req, req.params.id, reply);
    if (!agent) return reply;
    const crons = await listCrons(providerFor(agent.hostId), agent.runtimeRef!, agent.slug);
    return { crons };
  });

  // Per-agent token usage, read from its OpenClaw session store. Accurate usage,
  // not a cost figure — the app renders billing context from the AI profile.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/usage', async (req, reply) => {
    const agent = runningAgent(req, req.params.id, reply, 'see its usage');
    if (!agent) return reply;
    return agentUsage(providerFor(agent.hostId), agent.runtimeRef!, agent.slug);
  });

  // Fleet usage rollup: every RUNNING agent the caller can see, ranked by
  // tokens. Live-only — usage is read from each agent's live container, so
  // STOPPED agents have no session data to report and are counted as `skipped`
  // rather than shown as zero. One flaky container never sinks the list: its
  // read is caught and it drops to `skipped` too.
  app.get('/v1/usage', async (req) => {
    const running = store
      .listVisibleAgents(ownerIdOf(req))
      .filter((a) => a.state === 'RUNNING' && a.runtimeRef);
    const skipped = store
      .listVisibleAgents(ownerIdOf(req))
      .filter((a) => a.state !== 'RUNNING' || !a.runtimeRef).length;
    const results = await Promise.all(
      running.map(async (a) => {
        try {
          const u = await agentUsage(providerFor(a.hostId), a.runtimeRef!, a.slug);
          // Billing context drives the cost estimate: a subscription (Max) is
          // included, a local model is free, only an API key has a per-token
          // cost. We bracket it as a range — OpenClaw reports combined in+out
          // tokens, so an exact figure is impossible (see pricing.ts).
          const p = store.getAIProfile(a.aiProfileId);
          const billing = p?.vendor === 'local' ? 'local' : p?.kind === 'subscription' ? 'included' : 'api';
          const cost = billing === 'api' ? estimateCost(u.byModel) : null;
          return { id: a.id, name: a.name, ...u, billing, profileName: p?.name, cost };
        } catch {
          return null; // unreachable container — treat as skipped, not zero
        }
      }),
    );
    const agentsUsage = results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((x, y) => y.totalTokens - x.totalTokens);
    // Fleet cost = the summed range over API-keyed agents only. `partial` if any
    // priced agent used a model with no known price.
    const billed = agentsUsage.filter((a) => a.cost);
    const cost = billed.length
      ? {
          low: billed.reduce((s, a) => s + a.cost!.low, 0),
          high: billed.reduce((s, a) => s + a.cost!.high, 0),
          partial: billed.some((a) => a.cost!.partial),
          agents: billed.length,
        }
      : null;
    return {
      agents: agentsUsage,
      totalTokens: agentsUsage.reduce((s, a) => s + a.totalTokens, 0),
      totalSessions: agentsUsage.reduce((s, a) => s + a.sessions, 0),
      counted: agentsUsage.length,
      skipped: skipped + (results.length - agentsUsage.length),
      cost,
    };
  });

  // Live health probe of the agent's own gateway (event loop, Telegram
  // connection, plugin errors). Distinct from the tracked state: an agent can be
  // RUNNING here yet have a gateway that stopped answering.
  app.get<{ Params: { id: string }; Querystring: { doctor?: string } }>('/v1/agents/:id/health', async (req, reply) => {
    const agent = runningAgent(req, req.params.id, reply, 'check its health');
    if (!agent) return reply;
    const provider = providerFor(agent.hostId);
    const health = await agentHealth(provider, agent.runtimeRef!);
    // ?doctor=1 additionally runs `openclaw doctor --lint` — ~4s of read-only
    // config checks that catch silent degradations (disabled search provider,
    // missing memory-search key). The fleet sweep asks for it; the cheap
    // gateway probe stays the default.
    if (req.query.doctor === '1' && health.reachable) {
      return { ...health, doctor: await doctorLint(provider, agent.runtimeRef!) };
    }
    return health;
  });

  // Enable / disable a task.
  app.patch<{ Params: { id: string; jobId: string }; Body: { enabled?: boolean } }>(
    '/v1/agents/:id/crons/:jobId',
    async (req, reply) => {
      const agent = runningAgent(req, req.params.id, reply);
      if (!agent) return reply;
      const enabled = (req.body as { enabled?: boolean } | null)?.enabled;
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled must be true or false.' });
      }
      if (busyNow(agent, reply)) return reply;
      try {
        const ok = await whileBusy(agent.id, () =>
          setCronEnabled(providerFor(agent.hostId), agent.runtimeRef!, req.params.jobId, enabled),
        );
        if (!ok) {
          return reply.code(502).send({ error: `Couldn't ${enabled ? 'enable' : 'disable'} that task — it may no longer exist.` });
        }
        return { ok: true, enabled };
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // Fire a task now ("test fire"). Its output is delivered the task's own way
  // (e.g. a Telegram announce), so this only reports that it was triggered.
  app.post<{ Params: { id: string; jobId: string } }>(
    '/v1/agents/:id/crons/:jobId/run',
    async (req, reply) => {
      const agent = runningAgent(req, req.params.id, reply);
      if (!agent) return reply;
      if (busyNow(agent, reply)) return reply;
      try {
        const ok = await whileBusy(agent.id, () =>
          runCronNow(providerFor(agent.hostId), agent.runtimeRef!, req.params.jobId),
        );
        if (!ok) return reply.code(502).send({ error: "Couldn't run that task — it may no longer exist." });
        return { ok: true };
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // Delete a task.
  app.delete<{ Params: { id: string; jobId: string } }>(
    '/v1/agents/:id/crons/:jobId',
    async (req, reply) => {
      const agent = runningAgent(req, req.params.id, reply);
      if (!agent) return reply;
      if (busyNow(agent, reply)) return reply;
      try {
        const ok = await whileBusy(agent.id, () =>
          deleteCron(providerFor(agent.hostId), agent.runtimeRef!, req.params.jobId),
        );
        if (!ok) return reply.code(502).send({ error: "Couldn't delete that task — it may no longer exist." });
        return { ok: true };
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // The parked-provisioning resume: user pasted their BotFather token.
  app.post<{ Params: { id: string }; Body: { token?: string; fromWorkspace?: string } }>(
    '/v1/agents/:id/channel-token',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const body = (req.body ?? {}) as { token?: string; fromWorkspace?: string };
      let token = body.token?.trim();

      // Reuse: the bot a hand-built workspace already owns. Resolved here
      // rather than sent by the client, so the token stays on the server that
      // already holds it — a reuse flow that round-trips a live credential
      // through a terminal is a worse trade than the bot slot it saves.
      if (!token && body.fromWorkspace) {
        // Reading an OpenClaw config off an arbitrary host path is the same
        // host-path privilege as inspect/adopt — machine owner only.
        if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
        const existing = findExistingBot(body.fromWorkspace);
        if (!existing) {
          return reply.code(400).send({
            error: `No existing Telegram bot is bound to ${body.fromWorkspace}.`,
          });
        }
        // Deterministic check first: if that instance still has the account
        // switched on it will poll this bot, and two pollers on one token lose
        // messages silently rather than failing.
        if (existing.enabledInSource) {
          return reply.code(409).send({
            error:
              `@${existing.accountId} is still enabled for "${existing.sourceAgentId}" in your ` +
              `hand-built instance. Turn it off there first, or both copies will fight over ` +
              `every message.`,
          });
        }
        if ((await botPollState(existing.botToken)) === 'busy') {
          return reply.code(409).send({
            error: `Something is still polling @${existing.accountId}. Stop it, then try again.`,
          });
        }
        token = existing.botToken;
      }
      if (!token) return reply.code(400).send({ error: 'token required' });
      try {
        const { username } = await deps.channel.submitToken(agent.id, token);
        const inUseBy = store.findAgentUsingAccount(username);
        if (inUseBy && inUseBy.id !== agent.id) {
          // submitToken() has already stashed it as this agent's pending
          // identity. Forget it, or a later Retry provisions the agent onto
          // the other agent's bot and both poll the same token.
          deps.channel.discardPending?.(agent.id);
          return reply.code(400).send({
            error: `That bot is already connected to "${inUseBy.name}". Each agent needs its own bot — create another with @BotFather.`,
          });
        }
        kickProvision(agent.id);
        return reply.code(202).send({ username });
      } catch (err) {
        if (err instanceof InvalidBotTokenError) {
          return reply.code(400).send({ error: err.userMessage });
        }
        throw err;
      }
    },
  );

  // Owner-facing reveal of the agent's bot token — for recycling a hand-made
  // bot into a new agent after deleting this one. Owner-authed like all /v1.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/bot-token', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    const channel = agent && store.getChannelForAgent(agent.id);
    if (!agent || !channel) return reply.code(404).send({ error: 'Not found' });
    return {
      accountId: channel.accountId,
      botToken: await secrets.get(channel.secretRef),
      // Pool bots recycle automatically on delete; manual bots don't — the
      // app uses this to tell the owner which kind they're looking at.
      pooled: deps.channel.pool.owns(channel.accountId),
    };
  });

  /** Recent activity across every agent the caller can see. */
  app.get<{ Querystring: { limit?: string; agentId?: string } }>('/v1/events', async (req) => {
    const visible = store.listVisibleAgents(ownerIdOf(req));
    const names = new Map(visible.map((a) => [a.id, a.name]));
    // Clamp low too: a negative `?limit` became SQLite `LIMIT -1` (no limit),
    // dumping the whole event table.
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit ?? 40)) || 40, 1), 200);
    // Optional filter to one agent — but only one the caller can see, so this
    // can't be used to probe another owner's timeline.
    let ids = [...names.keys()];
    if (req.query.agentId) {
      if (!names.has(req.query.agentId)) return [];
      ids = [req.query.agentId];
    }
    return store.listEvents(ids, limit).map((e) => ({
      ...e,
      agentName: names.get(e.agentId),
    }));
  });

  // ---- runtime image / OpenClaw version status ----------------------------
  // What OpenClaw version the shared runtime image is on, vs the latest stable
  // on npm. The image is fleet-wide (every agent rebuilds onto :latest); the
  // actual rebuild is a deliberate host op (`agentclaw upgrade-image`), so this
  // is read-only — it tells you *whether* to upgrade, not a button that does it.
  const getDistTags = deps.openclawDistTags ?? (() => fetchOpenclawDistTags());
  let distTagsCache: { at: number; tags: OpenclawDistTags } | undefined;
  // What the runtime image can do — probed from the image itself (cached per
  // tag), so the Settings list can't drift from reality. Host-owner only:
  // it spins a one-shot container on first ask.
  app.get('/v1/runtime/capabilities', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    try {
      return await probeImageCapabilities(process.env.AGENTCLAW_IMAGE ?? 'agentclaw-runtime:latest');
    } catch (err) {
      return reply.code(502).send({
        error: `Couldn't probe the runtime image: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
      });
    }
  });

  app.get('/v1/runtime', async (req) => {
    const localHost = store.listHosts(ownerIdOf(req)).find((h) => h.kind === 'local');
    let imageVersion: string | undefined;
    if (localHost) {
      try {
        imageVersion = (await providerFor(localHost.id).currentImageInfo()).openclawVersion;
      } catch {
        /* image not built yet / docker hiccup — report unknown, don't fail */
      }
    }
    // npm changes rarely and Settings may poll; cache for an hour.
    if (!distTagsCache || Date.now() - distTagsCache.at > 3_600_000) {
      distTagsCache = { at: Date.now(), tags: await getDistTags() };
    }
    const { latest, extendedStable } = distTagsCache.tags;
    return {
      imageVersion,
      npmLatest: latest,
      npmExtendedStable: extendedStable,
      upgradeAvailable: !!(imageVersion && latest && imageVersion !== latest),
    };
  });

  // ---- scheduled backups (Settings → Backups) -----------------------------
  // These sets hold the whole fleet's data plus the decryption key in the
  // clear, so every route is gated to the machine's owner and returns only
  // metadata — never the backup files themselves.
  app.get('/v1/backups', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    // Match each backed-up volume to a live agent so the panel can offer a
    // per-agent Restore (and show its real name). Backups are machine-level (the
    // nightly script captures EVERY volume, across all owners) and this route is
    // already gated to the machine owner — so match against every active agent,
    // not just the caller's. Scoping to the caller made a family host's other
    // owners' agents all show up as "deleted".
    const all = store.listAllActiveAgents();
    const byArchive = new Map(all.filter((a) => a.runtimeRef).map((a) => [agentArchiveName(a.runtimeRef!), a]));
    const backups = listBackups().map((set) => ({
      ...set,
      volumes: set.volumes.map((v) => {
        const a = byArchive.get(v.file);
        return a ? { ...v, agentId: a.id, name: a.name } : v;
      }),
    }));
    return { dir: backupsDir(), keepDays: keepDays(), run: backupRunState(), backups };
  });

  app.post('/v1/backups/run', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    return { run: startBackup(Date.now()) };
  });

  app.delete<{ Params: { date: string } }>('/v1/backups/:date', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    try {
      const removed = pruneBackup(req.params.date);
      if (!removed) return reply.code(404).send({ error: 'No backup for that date.' });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: String((err as Error)?.message ?? err) });
    }
  });

  // Restore ONE agent's whole volume from a backup set. Destructive and
  // owner-only; it overwrites live memory, so it holds the busy guard for the
  // stop → import → start swap the same way a snapshot restore does.
  app.post<{ Body: { agentId?: string; date?: string } }>('/v1/backups/restore', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const { agentId, date } = (req.body as { agentId?: string; date?: string } | null) ?? {};
    if (!agentId || !date) return reply.code(400).send({ error: 'agentId and date are required.' });
    // Machine-level, like the panel above: the host owner can restore any agent
    // on this box, not only ones they personally own.
    const agent = store.getAgent(agentId);
    if (!agent || agent.state === 'DELETED') return reply.code(404).send({ error: 'Not found' });
    if (busyNow(agent, reply)) return reply;
    try {
      return await whileBusy(agent.id, () =>
        restoreAgentFromBackup(snapshotDeps(agent), agent.id, date),
      );
    } catch (err) {
      if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
      if (err instanceof RestoreError) return reply.code(400).send({ error: err.userMessage });
      throw err;
    }
  });

  // ---- adopting an existing OpenClaw agent ---------------------------------

  /** Every OpenClaw agent installed for the user this server runs as, so the
   *  owner can bring them in without hunting down workspace paths. */
  app.get('/v1/openclaw/agents', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    return { agents: await discoverOpenclawAgents({ store, secrets }) };
  });

  /** Disable the named bots in OpenClaw and restart its gateway once, so their
   *  pollers actually stop before AgentClaw takes them over. Host-owner only —
   *  it edits the config file and runs the gateway's systemd unit. */
  app.post<{ Body: { accountIds?: string[] } }>('/v1/openclaw/quiesce', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const ids = (req.body as { accountIds?: string[] } | null)?.accountIds;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
      return reply.code(400).send({ error: 'accountIds (string[]) required.' });
    }
    if (!ids.length) return { quiet: [], stillBusy: [] };
    try {
      return await quiesceOpenclawBots(ids);
    } catch (err) {
      return reply.code(400).send({ error: String((err as Error)?.message ?? err) });
    }
  });

  /** External host folders an adopted workspace references — candidates to
   *  share so the agent isn't blind to its data. Host-owner only (reads paths). */
  app.post<{ Body: { path?: string } }>('/v1/workspaces/scan-paths', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const path = (req.body as { path?: string } | null)?.path;
    if (!path) return reply.code(400).send({ error: 'path required' });
    return { candidates: scanWorkspacePaths(path) };
  });

  /** Look before you leap: what would be adopted from this folder? */
  app.post<{ Body: { path?: string } }>('/v1/workspaces/inspect', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const path = (req.body as { path?: string } | null)?.path;
    if (!path) return reply.code(400).send({ error: 'path required' });
    try {
      const preview = inspectWorkspace(path);
      // Surface the bot this workspace already owns. The token never leaves
      // the server — the caller only needs to know one exists, and whether
      // taking it over is safe right now.
      const bot = findExistingBot(path);
      return {
        ...preview,
        existingBot: bot
          ? {
              accountId: bot.accountId,
              sourceAgentId: bot.sourceAgentId,
              allowFrom: bot.allowFrom,
              enabledInSource: bot.enabledInSource,
              polling: await botPollState(bot.botToken),
            }
          : undefined,
      };
    } catch (err) {
      if (err instanceof AdoptError) return reply.code(400).send({ error: err.userMessage });
      throw err;
    }
  });

  /** Copy an existing workspace into an agent that already exists here. */
  app.post<{ Params: { id: string }; Body: { path?: string } }>(
    '/v1/agents/:id/adopt-workspace',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
      if (busyNow(agent, reply)) return reply;
      const path = (req.body as { path?: string } | null)?.path;
      if (!path) return reply.code(400).send({ error: 'path required' });
      // Same cheap insurance as a rebuild: the copy overwrites memory files.
      if (agent.state === 'RUNNING') {
        await autoSnapshot(snapshotDeps(agent), agent.id, 'pre-adopt');
      }
      try {
        const res = await applyWorkspace(
          { store, secrets, provider: providerFor(agent.hostId), channel: deps.channel,
            log: trace(agent.id) },
          agent.id,
          path,
        );
        // Repoint the agent's OWN absolute paths (its old workspace/agentDir) at
        // the container copy, in both its files and its crons, so references
        // resolve. Best-effort — neither ever fails the adopt itself. Held under
        // the busy guard (the long cron migration must not race a rebuild/delete)
        // and only attempted when the agent is actually RUNNING — against a
        // STOPPED container the cron gateway never answers, so it would hang the
        // readiness probe and then mislabel every cron "failed".
        const freshAgent = store.getAgent(agent.id)!;
        let crons: { total: number; carried: number; failed: number; deferred?: number } = { total: 0, carried: 0, failed: 0 };
        const selfEntry = openclawAgentEntryForWorkspace(path);
        if (freshAgent.runtimeRef && freshAgent.state === 'RUNNING') {
          await whileBusy(agent.id, async () => {
            if (selfEntry) {
              try {
                await rewriteWorkspaceFiles(
                  { provider: providerFor(agent.hostId), log: trace(agent.id) },
                  freshAgent.runtimeRef!,
                  freshAgent.slug,
                  selfPathReplacements(selfEntry, freshAgent.slug),
                );
              } catch (err) {
                trace(agent.id)('adopt.path_rewrite_skipped', { error: String(err).slice(0, 200) });
              }
            }
            try {
              crons = await migrateCrons(
                { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
                agent.id,
                path,
              );
            } catch (err) {
              trace(agent.id)('cron.migrate_skipped', { error: String(err).slice(0, 200) });
            }
          }).catch((err) => {
            // A concurrent op holds the flag — repointing is deferred, not fatal.
            trace(agent.id)('adopt.repoint_busy', { error: String(err).slice(0, 120) });
          });
        } else if (selfEntry) {
          // Agent isn't running (adopted into a STOPPED agent): defer the crons
          // rather than attempt them against a down gateway. Report honestly.
          const pending = readOpenclawCrons(selfEntry.id).length;
          if (pending > 0) crons = { total: pending, carried: 0, failed: 0, deferred: pending };
        }
        return { ...res, crons };
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof AdoptError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // ---- peers & migration ---------------------------------------------------

  app.get('/v1/peers', async (req) =>
    store.listPeers(ownerIdOf(req)).map(({ secretRef: _s, ...safe }) => safe),
  );

  app.post<{ Body: { name?: string; url?: string; token?: string } }>(
    '/v1/peers',
    async (req, reply) => {
      const parsed = z
        .object({
          name: z.string().trim().min(1).max(64),
          url: z.string().url(),
          /** An access token minted on THAT server (⚙ AI → CLI access). */
          token: z.string().min(1),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      const { name, url, token } = parsed.data;

      // Prove the token works before storing it, so a typo fails here rather
      // than halfway through a migration.
      try {
        const probe = await fetch(`${url.replace(/\/$/, '')}/v1/agents`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8000),
        });
        if (probe.status === 401) {
          return reply.code(400).send({ error: 'That server rejected the token.' });
        }
        if (!probe.ok) {
          return reply.code(400).send({ error: `That server answered ${probe.status}.` });
        }
      } catch {
        return reply.code(400).send({ error: `Couldn't reach an AgentClaw server at ${url}.` });
      }

      const id = randomUUID();
      const secretRef = `peer/${id}/token`;
      await secrets.put(secretRef, token);
      store.insertPeer({
        id,
        ownerId: ownerIdOf(req),
        name,
        url,
        secretRef,
        createdAt: new Date().toISOString(),
      });
      return reply.code(201).send({ id, name, url });
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/peers/:id', async (req, reply) => {
    const peer = store.getPeer(ownerIdOf(req), req.params.id);
    if (!peer) return reply.code(404).send({ error: 'Not found' });
    await secrets.delete(peer.secretRef).catch(() => {});
    store.deletePeer(ownerIdOf(req), peer.id);
    return { deleted: true };
  });

  /** Asked BY another server before it sends us an agent. Changes nothing. */
  app.post<{ Body: { slug?: string; accountId?: string; vendor?: string } }>(
    '/v1/agents/preflight',
    async (req, reply) => {
      const parsed = z
        .object({
          slug: z.string().min(1).max(64),
          accountId: z.string().min(1).max(64),
          vendor: z.string().max(32).optional(),
          // Zod strips unknown keys — omitting this silently discarded the
          // sender's folder list and made the missing-folders refusal dead
          // code for every real (HTTP) migration.
          sharedPaths: z.array(z.string().max(512)).max(8).optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      return preflight(store, ownerIdOf(req), parsed.data);
    },
  );

  // Move an agent to another host on THIS server (local ⇄ runner). Same agent
  // record, same bot, same members — only the Docker daemon changes. Distinct
  // from Rehost below, which ships the agent to another AgentClaw server (a
  // Mesh peer) and tombstones the copy here.
  app.post<{ Params: { id: string }; Body: { hostId?: string } }>(
    '/v1/agents/:id/move-host',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (movedAway(agent, reply)) return reply;
      const targetId = z.string().min(1).safeParse((req.body as { hostId?: unknown } | null)?.hostId);
      const host = targetId.success ? store.getHost(targetId.data) : undefined;
      if (!host || (host.ownerId !== ownerIdOf(req) && host.kind !== 'local')) {
        return reply.code(400).send({ error: 'Unknown host' });
      }
      if (host.id === agent.hostId) {
        return reply.code(400).send({ error: 'The agent is already on that host.' });
      }
      // Same split as create: a machine-login Max profile mounts THIS box's
      // ~/.claude, which can't reach a runner; a setup-token one travels.
      const profile = store.getAIProfile(agent.aiProfileId);
      if (profile?.kind === 'subscription' && host.kind !== 'local' && !profile.secretRef) {
        return reply.code(400).send({
          error:
            "This agent's Claude Max source uses this machine's login, which can't reach a runner. " +
            'Switch it to a setup-token Max source or an API key first, then move it.',
        });
      }
      try {
        const moved = await moveAgentToHost(
          { store, secrets, channel: deps.channel, log: trace(agent.id),
            source: providerFor(agent.hostId), target: providerFor(host.id) },
          agent.id,
          host.id,
        );
        return publicAgent(moved);
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { peerId?: string } }>(
    '/v1/agents/:id/rehost',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      // A tombstoned copy still holds the live bot token — migrating it again
      // ships that token to a third server and mints a second poller, the
      // exact thing the tombstone exists to prevent.
      if (movedAway(agent, reply)) return reply;
      const peerId = (req.body as { peerId?: string } | null)?.peerId;
      const peer = peerId && store.getPeer(ownerIdOf(req), peerId);
      if (!peer) return reply.code(400).send({ error: 'Unknown server' });
      try {
        return await migrateAgent(
          { store, secrets, provider: providerFor(agent.hostId), channel: deps.channel,
            log: trace(agent.id) },
          agent.id,
          peer,
        );
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof MigrateError) return reply.code(400).send({ error: err.userMessage });
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // ---- export & import (agent portability) ---------------------------------

  // The archive contains the bot token — it IS the agent's identity — so the
  // download is a credential. The export leaves the agent STOPPED here: once
  // it's imported elsewhere, two pollers on one bot would flip-flop.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/backup', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    // A moved-away copy's archive carries the live bot token — refuse it.
    if (movedAway(agent, reply)) return reply;
    if (busyNow(agent, reply)) return reply;
    try {
      // HOLD the busy flag for the whole export, not just check it: exportAgent
      // quiesces then tars the volume (minutes on a large agent), and without
      // the flag a concurrent Start passed its guards and booted the container
      // to write the volume mid-`tar`, silently tearing the archive.
      const { filename, data } = await whileBusy(agent.id, () =>
        exportAgent(
          { store, secrets, provider: providerFor(agent.hostId), channel: deps.channel,
            log: trace(agent.id) },
          agent.id,
        ),
      );
      return reply
        .type('application/octet-stream')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(data);
    } catch (err) {
      if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
      if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
      throw err;
    }
  });

  app.post<{ Querystring: { aiProfileId?: string; hostId?: string } }>(
    '/v1/agents/restore',
    async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: 'Send the .agentclaw file as the request body.' });
      }
      const ownerId = ownerIdOf(req);
      // Resolve the host up front so the right provider handles the restore.
      const hosts = store.listHosts(ownerId);
      const host = req.query.hostId
        ? hosts.find((h) => h.id === req.query.hostId)
        : (hosts.find((h) => h.kind === 'local') ?? hosts[0]);
      if (!host) return reply.code(400).send({ error: 'No host available to import onto.' });
      if (req.query.aiProfileId) {
        const p = store.getAIProfile(req.query.aiProfileId);
        if (!p || (p.ownerId !== ownerId && !p.shared)) {
          return reply.code(400).send({ error: 'Unknown AI profile' });
        }
      }
      try {
        const agent = await importAgent(
          // No id yet — trace() picks it up from the orchestrator's log detail.
          { store, secrets, provider: providerFor(host.id), channel: deps.channel, log: trace() },
          body,
          { ownerId, aiProfileId: req.query.aiProfileId, hostId: host.id },
        );
        return reply.code(201).send(publicAgent(agent));
      } catch (err) {
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // ---- shareable template (Export / Import) -------------------------------
  // A trained copy with NO identity (no token, members, or memory) — safe to
  // email. Export reads the agent's SOUL.md/AGENTS.md; Import stands up a FRESH
  // agent that provisions its own bot (pool or paste), owned by the importer.
  app.get<{ Params: { id: string }; Querystring: { excludeMemory?: string } }>(
    '/v1/agents/:id/export',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (busyNow(agent, reply)) return reply;
      try {
        const { filename, data } = await exportTemplate(
          { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
          agent.id,
          { includeMemory: req.query.excludeMemory === undefined },
        );
        return reply
          .type('application/octet-stream')
          .header('content-disposition', `attachment; filename="${filename}"`)
          .send(data);
      } catch (err) {
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // Clone: a faithful local copy (memory included — you own both copies, so
  // there's no privacy concern), with a fresh identity: new name, its own bot,
  // and only you as owner. Export → import, in one step, on this installation.
  app.post<{ Params: { id: string }; Body: { name?: string } }>(
    '/v1/agents/:id/clone',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (busyNow(agent, reply)) return reply;
      const deps = { store, provider: providerFor(agent.hostId), log: trace() };
      try {
        const { data } = await exportTemplate(deps, agent.id, { includeMemory: true });
        const name = (req.body as { name?: string } | null)?.name?.trim() || `${agent.name} (copy)`;
        const { agent: clone } = importTemplate(deps, data, { ownerId: ownerIdOf(req), name });
        kickProvision(clone.id);
        return reply.code(201).send(publicAgent(clone));
      } catch (err) {
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // Import: one entry point for any .agentclaw file. It sniffs the archive's
  // format and does the right thing — a template becomes a fresh agent, a full
  // copy (a Download) is restored as the same agent. The /restore route above
  // stays for the CLI's explicit `restore` verb.
  app.post<{ Querystring: { aiProfileId?: string; hostId?: string; name?: string } }>(
    '/v1/agents/import',
    async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: 'Send the .agentclaw file as the request body.' });
      }
      const ownerId = ownerIdOf(req);
      const hosts = store.listHosts(ownerId);
      const host = req.query.hostId
        ? hosts.find((h) => h.id === req.query.hostId)
        : (hosts.find((h) => h.kind === 'local') ?? hosts[0]);
      if (!host) return reply.code(400).send({ error: 'No host available to import onto.' });
      if (req.query.aiProfileId) {
        const p = store.getAIProfile(req.query.aiProfileId);
        if (!p || (p.ownerId !== ownerId && !p.shared)) {
          return reply.code(400).send({ error: 'Unknown AI profile' });
        }
      }
      try {
        // One button, two file kinds. A template stands up a FRESH agent (own
        // bot, importer as sole owner); anything else is a full copy (a Download)
        // that restores the SAME agent, carrying its bot token and members.
        if (peekFormat(body) === TEMPLATE_FORMAT) {
          const { agent, needs } = importTemplate(
            { store, provider: providerFor(host.id), log: trace() },
            body,
            { ownerId, aiProfileId: req.query.aiProfileId, hostId: host.id, name: req.query.name },
          );
          // Fresh agent → provision its own bot the normal way (pool or paste).
          kickProvision(agent.id);
          return reply.code(201).send({ ...publicAgent(agent), kind: 'template', needs });
        }
        const agent = await importAgent(
          { store, secrets, provider: providerFor(host.id), channel: deps.channel, log: trace() },
          body,
          { ownerId, aiProfileId: req.query.aiProfileId, hostId: host.id },
        );
        return reply.code(201).send({ ...publicAgent(agent), kind: 'agent' });
      } catch (err) {
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // Rebuild: new container from the current image, volume (memory) kept.
  app.post<{ Params: { id: string } }>('/v1/agents/:id/rebuild', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    if (movedAway(agent, reply)) return reply;
    if (busyNow(agent, reply)) return reply;
    if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
      return reply.code(409).send({ error: `Cannot rebuild while ${agent.state}` });
    }
    // The pre-rebuild snapshot now runs as the first step of the background
    // rebuild task (see rebuildAgentInner), so this returns 202 immediately
    // instead of blocking on a ~1-2s docker-exec snapshot per agent.
    if (!kickRebuild(agent.id)) {
      return reply.code(409).send({ error: 'Another operation is already running on this agent.' });
    }
    return reply.code(202).send({ rebuilding: true });
  });

  // Retry after FAILED (or nudge a stuck PROVISIONING after a restart).
  app.post<{ Params: { id: string } }>('/v1/agents/:id/provision', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if (movedAway(agent, reply)) return reply;
    if (busyNow(agent, reply)) return reply;
    kickProvision(agent.id);
    return reply.code(202).send(publicAgent(store.getAgent(agent.id)!));
  });

  // ---- invites & join (§12.3) --------------------------------------------

  app.post<{ Params: { id: string } }>('/v1/agents/:id/invites', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const ownerId = ownerIdOf(req);
    const { code, expiresAt } = createInvite(store, agent.id, ownerId);
    const path = `/join/${code}`;
    return reply.code(201).send({
      code,
      expiresAt,
      path,
      url: deps.publicUrl ? `${deps.publicUrl.replace(/\/$/, '')}${path}` : undefined,
    });
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id/members', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return store.listMemberships(agent.id).filter((m) => m.status === 'active');
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    '/v1/agents/:id/members/:userId',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      try {
        await revokeMember(
          { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
          agent.id,
          req.params.userId,
        );
        return { revoked: true };
      } catch (err) {
        if (err instanceof RevokeError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // Unauthenticated (code-gated): what the join page needs to render.
  app.get<{ Params: { code: string } }>('/v1/invites/:code', async (req) => {
    const check = checkInvite(store, req.params.code);
    if (!check.valid) return { valid: false, reason: check.reason };
    const agent = store.getAgent(check.agentId)!;
    return { valid: true, agentName: agent.name, sharedMemory: agent.sharedMemory };
  });

  // Unauthenticated (code-gated): redeem + start watching for the invitee's
  // first Telegram contact, exactly like the owner's claim.
  app.post<{ Body: { code?: string; name?: string; idToken?: string } }>('/v1/join', async (req, reply) => {
    const body = (req.body ?? {}) as { code?: string; name?: string; idToken?: string };
    if (!body.code) return reply.code(400).send({ error: 'code required' });
    try {
      // Full invite (phase 4): when the invitee signs in, the membership is
      // keyed to their real account, so they can log in and see this agent.
      // Without a token it stays a lightweight, Telegram-only membership.
      let accountId: string | undefined;
      if (body.idToken && deps.verifier) {
        try {
          const token = await deps.verifier.verify(body.idToken);
          accountId = `user-${token.sub}`;
        } catch {
          return reply.code(401).send({ error: "That sign-in didn't verify — try again." });
        }
      }
      const joined = redeemInvite(store, body.code, body.name ?? '', accountId);
      const agent = store.getAgent(joined.agentId)!;
      const channelRow = store.getChannelForAgent(agent.id);
      if (agent.runtimeRef && channelRow && agent.state === 'RUNNING') {
        void claimFirstContact(
          { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
          {
            agentId: agent.id,
            runtimeRef: agent.runtimeRef,
            accountId: channelRow.accountId,
            forUserId: joined.membershipUserId,
            timeoutMs: 30 * 60_000,
          },
        ).catch((err) => app.log.error({ err }, 'invitee claim failed'));
      }
      return reply.code(201).send({
        agentName: agent.name,
        botUsername: channelRow?.accountId,
        deepLink: channelRow?.deepLink,
      });
    } catch (err) {
      if (err instanceof InviteInvalidError) {
        return reply.code(400).send({ error: err.userMessage });
      }
      throw err;
    }
  });

  if (deps.webJoinPath) {
    app.get('/join/:code', async (_req, reply) => {
      const html = readFileSync(deps.webJoinPath!, 'utf8');
      return reply.type('text/html; charset=utf-8').send(html);
    });
  }

  // The agent's Telegram deep link as a scannable QR — the invite dialog shows
  // it so an off-tailnet invitee can join by pointing their camera at the
  // owner's screen instead of retyping a link.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/qr.svg', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    const channel = agent && store.getChannelForAgent(agent.id);
    if (!channel?.deepLink) return reply.code(404).send({ error: 'Not found' });
    const svg = await QRCode.toString(channel.deepLink, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    return reply.type('image/svg+xml').send(svg);
  });

  // Pending pairing requests on a live agent — the app renders these as
  // "someone wants to talk to <agent>" cards for the owner to approve.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/pairing', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    const channel = agent && store.getChannelForAgent(agent.id);
    if (!agent?.runtimeRef || !channel) return reply.code(404).send({ error: 'Not found' });
    if (agent.state !== 'RUNNING') return [];
    return listPairingRequests(providerFor(agent.hostId), agent.runtimeRef, channel.accountId);
  });

  // Every pending "wants to join" request across the caller's RUNNING agents,
  // flattened — one cheap call for the management bot to poll and push an
  // approval prompt, so the owner never has to open the web UI to notice one.
  app.get('/v1/pending', async (req) => {
    const mine = store
      .listAgents(ownerIdOf(req))
      .filter((a) => a.state === 'RUNNING' && a.runtimeRef && store.getChannelForAgent(a.id));
    const perAgent = await Promise.all(
      mine.map(async (a) => {
        try {
          const channel = store.getChannelForAgent(a.id)!;
          const reqs = await listPairingRequests(providerFor(a.hostId), a.runtimeRef!, channel.accountId);
          return reqs.map((r) => ({
            agentId: a.id,
            agentName: a.name,
            code: r.code,
            telegramId: r.id,
            username: r.meta?.username,
            firstName: r.meta?.firstName,
            lastName: r.meta?.lastName,
          }));
        } catch {
          return []; // an unreachable agent shouldn't sink the whole list
        }
      }),
    );
    return perAgent.flat();
  });

  app.post<{ Params: { id: string }; Body: { code?: string } }>(
    '/v1/agents/:id/pairing/approve',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      const channel = agent && store.getChannelForAgent(agent.id);
      const code = (req.body as { code?: string } | null)?.code;
      if (!agent?.runtimeRef || !channel) return reply.code(404).send({ error: 'Not found' });
      if (!code) return reply.code(400).send({ error: 'code required' });
      try {
        const admitted = await admitMember(
          { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
          {
            agentId: agent.id,
            runtimeRef: agent.runtimeRef,
            accountId: channel.accountId,
            code,
            agentName: agent.name,
            sharedMemory: agent.sharedMemory,
          },
        );
        return { approved: true, member: admitted };
      } catch (err) {
        if (err instanceof AdmitError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // Turn a pending request away. OpenClaw has no deny verb, so this is a file
  // surgery on the pairing store (see denyPairing) — and it's "not now", not a
  // ban: they can ask again by messaging the bot.
  app.post<{ Params: { id: string }; Body: { code?: string } }>(
    '/v1/agents/:id/pairing/deny',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      const channel = agent && store.getChannelForAgent(agent.id);
      const code = (req.body as { code?: string } | null)?.code;
      if (!agent?.runtimeRef || !channel) return reply.code(404).send({ error: 'Not found' });
      if (!code) return reply.code(400).send({ error: 'code required' });
      try {
        const out = await denyPairing(
          { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
          { agentId: agent.id, runtimeRef: agent.runtimeRef, code },
        );
        return out;
      } catch (err) {
        if (err instanceof AdmitError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>('/v1/agents/:id/stop', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    if (busyNow(agent, reply)) return reply;
    // Guard the transition here so a mid-rebuild stop is a 409, not a 500.
    if (agent.state !== 'RUNNING') {
      return reply.code(409).send({ error: `Cannot stop while ${agent.state}` });
    }
    await providerFor(agent.hostId).stop(agent.runtimeRef);
    return publicAgent(store.setAgentState(agent.id, 'STOPPED'));
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/start', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    if (movedAway(agent, reply)) return reply;
    if (busyNow(agent, reply)) return reply;
    if (agent.state !== 'STOPPED') {
      return reply.code(409).send({ error: `Cannot start while ${agent.state}` });
    }
    await providerFor(agent.hostId).start(agent.runtimeRef);
    return publicAgent(store.setAgentState(agent.id, 'RUNNING'));
  });

  app.delete<{ Params: { id: string }; Querystring: { recycleBot?: string } }>('/v1/agents/:id', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    // Fully gone — say so. A DELETING agent, by contrast, is a delete that was
    // interrupted (destroy threw, or the process was killed mid-teardown); we
    // let a retry RE-ENTER and finish it, rather than 404-ing it into a
    // permanent tombstone with secrets un-scrubbed and the bot never released.
    if (agent.state === 'DELETED') {
      return reply.code(404).send({ error: 'Not found' });
    }
    // A migrate/adopt/import mid-flight: refuse rather than wait — those run
    // for minutes, and purging the volume under an in-progress export is loss.
    if (busyNow(agent, reply)) return reply;
    // Wait for any in-flight provision/rebuild: deleting underneath one would
    // let it re-create the container AFTER the purge, leaving an orphan that
    // still holds the bot token and keeps polling Telegram.
    const running = inflight.get(agent.id);
    if (running) await running.catch(() => {});
    // Re-check busy AFTER that wait: a migrate/adopt could have grabbed the
    // flag the instant the rebuild released it, and purging the volume under
    // an in-progress export is loss.
    if (isBusy(agent.id)) {
      return reply.code(409).send({ error: 'Another operation is already running on this agent.' });
    }
    if (agent.state !== 'DELETING') store.setAgentState(agent.id, 'DELETING');
    if (agent.runtimeRef) {
      try {
        await providerFor(agent.hostId).destroy(agent.runtimeRef, { purge: true });
      } catch (err) {
        // The runtime may still be alive (holding the bot token). Do NOT
        // release the bot or mark DELETED — that would orphan a poller. Park in
        // FAILED (a legal DELETING→FAILED move) so Delete stays retryable.
        store.setAgentState(agent.id, 'FAILED', 'Delete could not remove the runtime — tap Delete again.');
        app.log.error({ agentId: agent.id, err: String(err) }, 'destroy failed during delete');
        return reply.code(502).send({ error: "Couldn't remove the agent's runtime — try Delete again in a moment." });
      }
    }
    // The runtime is gone; everything below is idempotent, so a retry after an
    // interrupted delete safely finishes the teardown.
    const channel = store.getChannelForAgent(agent.id);
    if (channel) {
      // A migrated-away agent's bot now belongs to the peer that received it.
      // Releasing it back into THIS pool would let a new local agent lease it
      // and fight the peer for the same token — release only when it stays ours.
      if (!agent.migratedTo) {
        // A PASTED bot's token is parked in the pool BY DEFAULT — bots are the
        // scarce resource (Telegram's per-account ceiling), and the Bot pool
        // tab is where a token gets discarded on purpose. ?recycleBot=0 opts
        // out. (Pool-leased bots already return via release() below.)
        // Best-effort END TO END: recycling is a bonus, so no failure in it —
        // not even a pool without the newer methods — may block the delete.
        if (req.query.recycleBot !== '0') {
          try {
            if (!deps.channel.pool.owns(channel.accountId)) {
              // Parked under the AGENT'S OWNER: their token, their pool slot —
              // never another user's next lease.
              const token = await secrets.get(channel.secretRef);
              await deps.channel.pool.addToPool(channel.accountId, token, agent.ownerId);
            }
          } catch (err) {
            app.log.warn({ agentId: agent.id, err: String(err) }, 'bot recycle into pool failed');
          }
        }
        await deps.channel.release(channel.accountId);
      }
      // An imported agent's token lives under channel/<agentId>/bot-token,
      // which release() (keyed by username) never touches — scrub it here so
      // deletion doesn't leave a live credential in the store.
      if (channel.secretRef.startsWith('channel/')) {
        await secrets.delete(channel.secretRef).catch(() => {});
      }
      store.deleteChannelForAgent(agent.id);
    }
    // Scrub the agent's other stored secrets so a tombstone leaves no live
    // credentials: data-source deploy keys and env-var values (both keyed by
    // the source/var id, so release() never touches them).
    for (const d of store.listDataSources(agent.id)) {
      if (d.secretRef) await secrets.delete(d.secretRef).catch(() => {});
    }
    for (const e of store.listAgentEnv(agent.id)) {
      await secrets.delete(e.secretRef).catch(() => {});
    }
    store.deleteSnapshotsFor(agent.id);
    store.deleteEventsFor(agent.id);
    // Kill any outstanding invite links: redeeming one after deletion would
    // mint a membership against a tombstone with no bot to talk to.
    store.expireInvitesFor(agent.id);
    return publicAgent(store.setAgentState(agent.id, 'DELETED'));
  });
}
