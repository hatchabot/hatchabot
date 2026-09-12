import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { Agent, MemberRole } from '../domain/types.js';
import {
  buildRuntimeSpec,
  recordApplied,
  runRebuildHook,
  slugify,
  waitForHealthy,
  waitForSkillsSettled,
  type ProvisionDeps,
} from './provision.js';
import { clearBusy, markBusy } from './busy.js';
import { ENV_NAME_RE, reservedEnvProblem } from './envPolicy.js';

/**
 * Export/import: an agent as a single portable file, so "move it to another
 * machine" is download-here, upload-there (§ the distributed-hosts direction).
 *
 * The archive is gzipped JSON: a manifest (identity, members, channel + bot
 * token, AI hints) plus the runtime volume snapshot base64-inlined. The bot
 * token IS the agent's Telegram identity — it must travel, which makes the
 * file itself a credential. Handle like one.
 *
 * The cardinal rule of a move: the source copy must never poll again once the
 * import runs — Telegram delivers each message to exactly one poller, and two
 * copies flip-flop. Export therefore leaves the source agent STOPPED.
 */

export const EXPORT_FORMAT = 'hatchabot-export';
/** Files exported before the rename. */
export const LEGACY_EXPORT_FORMAT = 'agentclaw-export';
export const EXPORT_VERSION = 1;

/** Best-effort read of an archive's `format` tag (no full validation), so one
 *  Import path can route a Download (full agent) vs a Share (template) file.
 *  Bounded like the real import — a bomb (or anything unreadable) yields
 *  `undefined`, which the caller treats as a full restore that re-validates. */
export function peekFormat(data: Buffer): string | undefined {
  try {
    const json = gunzipSync(data, { maxOutputLength: MAX_STATE_BYTES }).toString('utf8');
    const o = JSON.parse(json) as { format?: unknown };
    return typeof o?.format === 'string' ? o.format : undefined;
  } catch {
    return undefined;
  }
}

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  agent: {
    name: string;
    slug: string;
    persona: string;
    sharedMemory: boolean;
    /** Host folders it could read. Paths are machine-specific — carried as a
     *  declaration so the destination can check them, never auto-applied. */
    sharedPaths?: string[];
    /** Per-agent model override. Applied on import only if the destination
     *  profile's menu still offers it; otherwise dropped to the default. */
    model?: string;
  };
  ai: { vendor: string; model: string; models?: string[] };
  channel: { kind: 'telegram'; accountId: string; deepLink: string; botToken: string };
  memberships: Array<{
    userId: string;
    role: MemberRole;
    displayName?: string;
    channelUserId?: string;
    status: 'active' | 'revoked';
  }>;
  /**
   * Per-agent env vars WITH their secret values. A full export is a private
   * identity backup (it already carries the bot token — treat like a
   * password); an agent that arrives without its env secrets is silently
   * broken, which is worse. Templates (template.ts) still carry NAMES only.
   */
  envVars?: Array<{ name: string; value: string }>;
  /** base64 gzipped tarball of the OpenClaw state dir. */
  state: string;
}

export class TransferError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'TransferError';
  }
}

/**
 * An archive is untrusted input — it crosses machines and may arrive from
 * someone else. Everything below is validated before a single value reaches
 * the store, a shell string, or a docker name. The slug matters most: it is
 * interpolated into container/volume names and workspace paths.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ManifestSchema = z.object({
  format: z.enum([EXPORT_FORMAT, LEGACY_EXPORT_FORMAT]),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.string().max(64),
  agent: z.object({
    name: z.string().min(1).max(64),
    slug: z.string().regex(SLUG_RE),
    persona: z.string().max(8000),
    sharedMemory: z.boolean(),
    sharedPaths: z.array(z.string().max(512)).max(8).optional(),
    model: z.string().max(64).optional(),
  }),
  ai: z.object({
    vendor: z.string().max(32),
    model: z.string().max(64),
    models: z.array(z.string().max(64)).max(16).optional(),
  }),
  channel: z.object({
    kind: z.literal('telegram'),
    accountId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/),
    // Must be a real Telegram link. Unvalidated, this string reached an
    // href="" in the app, so an imported archive could carry a `javascript:`
    // URI and run script in the app's origin when the owner clicked it.
    deepLink: z.string().max(256).startsWith('https://t.me/'),
    botToken: z.string().min(1).max(256),
  }),
  memberships: z
    .array(
      z.object({
        userId: z.string().min(1).max(128),
        role: z.enum(['owner', 'admin', 'user']),
        displayName: z.string().max(64).optional(),
        channelUserId: z.string().regex(/^\d{1,32}$/).optional(),
        status: z.enum(['active', 'revoked']),
      }),
    )
    .max(256),
  envVars: z
    .array(
      z.object({
        // Same shape rule as the env route; the reserved-name POLICY is
        // enforced at import time via envPolicy.ts (the archive is untrusted).
        name: z.string().regex(ENV_NAME_RE).max(128),
        value: z.string().min(1).max(8192),
      }),
    )
    .max(64)
    .optional(),
  state: z.string(),
});

/** Uncompressed ceiling — a gzip bomb must not OOM the control plane. */
const MAX_STATE_BYTES = 256 * 1024 * 1024;

/**
 * Largest raw (gzipped-tar) state that still fits under MAX_STATE_BYTES once
 * base64-inflated (×4/3) and wrapped in the manifest JSON. Beyond this the
 * export would either produce a file no import could ever accept, or trip
 * Node's max-string-length inside JSON.stringify with an opaque RangeError —
 * so we refuse it up front with a message the owner can act on.
 */
const MAX_RAW_STATE_BYTES = Math.floor((MAX_STATE_BYTES - 8192) * 0.75);

export async function exportAgent(
  deps: ProvisionDeps,
  agentId: string,
): Promise<{ filename: string; data: Buffer }> {
  const { store, secrets, provider } = deps;
  const log = deps.log ?? (() => {});

  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new TransferError('This agent has no runtime to export yet.');
  if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
    throw new TransferError(`Can't export while the agent is ${agent.state}.`);
  }
  const channel = store.getChannelForAgent(agentId);
  if (!channel) throw new TransferError('This agent has no messaging channel to export.');
  const profile = store.getAIProfile(agent.aiProfileId);

  // Quiesce for a consistent snapshot, and LEAVE it stopped: the whole point
  // of an export is usually that the agent is about to live somewhere else.
  const wasRunning = agent.state === 'RUNNING';
  if (wasRunning) {
    await provider.stop(agent.runtimeRef);
    store.setAgentState(agentId, 'STOPPED');
  }

  // If the snapshot fails AFTER quiescing, a plain export (not a migrate,
  // which owns its own undo) would strand a running agent silently STOPPED —
  // it stops answering Telegram with no error the owner ever sees. Put it back.
  const restoreIfRunning = async () => {
    if (!wasRunning) return;
    // Only claim RUNNING if the container actually came back — matching
    // migrate's undo. Setting RUNNING after a swallowed start() failure would
    // leave the DB lying (RUNNING over a stopped container) until reconcile.
    try {
      await provider.start(agent.runtimeRef!);
      store.setAgentState(agentId, 'RUNNING');
    } catch (startErr) {
      log('export.restart_failed', { agentId, error: String(startErr) });
    }
  };

  let state: Buffer;
  try {
    state = await provider.exportState(agent.runtimeRef);
  } catch (err) {
    // If the snapshot fails AFTER quiescing, a plain export (not a migrate,
    // which owns its own undo) would strand a running agent silently STOPPED.
    await restoreIfRunning();
    throw err;
  }
  if (state.length > MAX_RAW_STATE_BYTES) {
    await restoreIfRunning();
    throw new TransferError(
      `This agent's saved state is ${(state.length / 1e6).toFixed(0)} MB — too large to move as ` +
        `a single file (the limit is about ${(MAX_RAW_STATE_BYTES / 1e6).toFixed(0)} MB). Trim old ` +
        `sessions, or keep the bulk data in a shared folder instead of the agent's own volume.`,
    );
  }
  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    agent: {
      name: agent.name,
      slug: agent.slug,
      persona: agent.persona,
      sharedMemory: agent.sharedMemory,
      sharedPaths: agent.sharedPaths,
      model: agent.model,
    },
    ai: {
      vendor: profile?.vendor ?? 'anthropic',
      model: profile?.model ?? '',
      models: profile?.models,
    },
    channel: {
      kind: channel.kind,
      accountId: channel.accountId,
      deepLink: channel.deepLink,
      botToken: await secrets.get(channel.secretRef),
    },
    memberships: store.listMemberships(agentId).map((m) => ({
      ...m,
      role: m.role as MemberRole,
      status: m.status as 'active' | 'revoked',
    })),
    envVars: await Promise.all(
      store.listAgentEnv(agentId).map(async (e) => {
        try {
          return { name: e.name, value: await secrets.get(e.secretRef) };
        } catch {
          // A missing secret means the var is already broken here — say so
          // rather than exporting an archive that silently lacks it.
          await restoreIfRunning();
          throw new TransferError(
            `Env var "${e.name}" has no stored value (its secret is missing). Remove it in ` +
              'Settings → Environment, then export again.',
          );
        }
      }),
    ),
    state: state.toString('base64'),
  };
  log('agent.exported', { agentId, bytes: state.length });
  return {
    filename: `${agent.slug}.hatchabot`,
    data: gzipSync(Buffer.from(JSON.stringify(manifest), 'utf8')),
  };
}

export interface ImportOptions {
  ownerId: string;
  /** Explicit AI profile; defaults to a vendor match, then the first one. */
  aiProfileId?: string;
  hostId?: string;
}

export async function importAgent(
  deps: ProvisionDeps,
  data: Buffer,
  opts: ImportOptions,
): Promise<Agent> {
  return importAgentInner(deps, data, opts);
}

async function importAgentInner(
  deps: ProvisionDeps,
  data: Buffer,
  opts: ImportOptions,
): Promise<Agent> {
  const { store, secrets, provider } = deps;
  const log = deps.log ?? (() => {});

  let raw: unknown;
  try {
    raw = JSON.parse(
      gunzipSync(data, { maxOutputLength: MAX_STATE_BYTES }).toString('utf8'),
    );
  } catch {
    throw new TransferError("That file isn't a Hatchabot export (or is too large).");
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const bad = parsed.error.issues[0];
    throw new TransferError(
      raw && typeof raw === 'object' && [EXPORT_FORMAT, LEGACY_EXPORT_FORMAT].includes((raw as any).format)
        ? `That export is malformed or from an incompatible version (${bad?.path.join('.') || 'manifest'}).`
        : "That file isn't a Hatchabot export.",
    );
  }
  const manifest: ExportManifest = parsed.data as ExportManifest;
  // Belt and suspenders: the slug also has to survive our own slugifier
  // unchanged before it becomes a container name or workspace path.
  if (slugify(manifest.agent.slug) !== manifest.agent.slug) {
    throw new TransferError('That export has an unusable agent id.');
  }

  // Cap the state on import the way export already caps it (transfer.ts:187) —
  // the import side had no bound at all, so an oversized/crafted `.hatchabot`
  // went straight into `tar xz` on the shared volume. This rejects anything past
  // the ~190 MB gzipped ceiling before it can fill the host disk. (A tighter
  // extracted-size quota is tracked as a follow-up; decompressing here would
  // either spike control-plane RAM or reject legit large agents.)
  const stateBuf = Buffer.from(manifest.state, 'base64');
  if (stateBuf.length > MAX_RAW_STATE_BYTES) {
    throw new TransferError(
      `This archive's state is ~${(stateBuf.length / 1e6).toFixed(0)} MB — too large to import ` +
        `(the limit is about ${(MAX_RAW_STATE_BYTES / 1e6).toFixed(0)} MB).`,
    );
  }

  if (store.listAllActiveAgents().some((a) => a.slug === manifest.agent.slug)) {
    throw new TransferError(`An agent with slug "${manifest.agent.slug}" already lives here.`);
  }
  // A previously deleted agent's tombstone may still hold the slug.
  store.releaseDeletedSlug(opts.ownerId, manifest.agent.slug);
  if (store.findAgentUsingAccount(manifest.channel.accountId)) {
    throw new TransferError(
      `Bot @${manifest.channel.accountId} is already wired to an agent here.`,
    );
  }

  // Prefer the importer's OWN profile over a profile merely shared with the
  // installation — defaulting onto someone else's shared subscription would
  // silently bill them. Own+vendor-match → own → any vendor-match → anything.
  const profiles = store.listAIProfiles(opts.ownerId);
  const mine = profiles.filter((p) => p.ownerId === opts.ownerId);
  const profile = opts.aiProfileId
    ? store.getAIProfile(opts.aiProfileId)
    : (mine.find((p) => p.vendor === manifest.ai.vendor) ??
      mine[0] ??
      profiles.find((p) => p.vendor === manifest.ai.vendor) ??
      profiles[0]);
  if (!profile) throw new TransferError('Set up an AI source before importing.');
  const host = opts.hostId
    ? store.getHost(opts.hostId)
    : (store.listHosts(opts.ownerId).find((h) => h.kind === 'local') ??
      store.listHosts(opts.ownerId)[0]);
  if (!host) throw new TransferError('No host available to import onto.');

  const now = new Date().toISOString();
  const agent: Agent = {
    id: randomUUID(),
    ownerId: opts.ownerId,
    name: manifest.agent.name,
    slug: manifest.agent.slug,
    state: 'PROVISIONING',
    aiProfileId: profile.id,
    hostId: host.id,
    persona: manifest.agent.persona,
    sharedMemory: manifest.agent.sharedMemory,
    // The per-agent model override survives the move only if the destination
    // profile is cloud and still offers it — landing on a different profile
    // (or a local one) drops it back to that profile's default rather than
    // pinning a model the new source can't serve.
    model:
      profile.vendor !== 'local' &&
      manifest.agent.model &&
      [profile.model, ...(profile.models ?? [])].includes(manifest.agent.model)
        ? manifest.agent.model
        : undefined,
    // Deliberately NOT carried over: a path that exists on the source may not
    // exist here, and silently mounting a same-named folder would be worse
    // than mounting nothing. Preflight warns; the owner re-shares explicitly.
    createdAt: now,
    updatedAt: now,
  };
  store.insertAgent(agent);
  // From here the agent exists but is mid-build: reconcile must not judge it.
  markBusy(agent.id);

  const secretRef = `channel/${agent.id}/bot-token`;
  const envSecretRefs: string[] = [];
  let runtimeRef: string | undefined;
  try {
    // Memberships travel verbatim, except the owner seat belongs to whoever
    // imports — it's their installation now. Inside the try: a malformed row
    // must roll back with everything else, not strand a half-made agent.
    // Owner rows first, so a `user` row whose id already equals the importer
    // can never be inserted BEFORE the owner seat and demote the importer to
    // a plain member (revocable, no owner privileges). Dedup then drops the
    // duplicate. Guards against a manifest whose row order isn't joined_at.
    const ordered = [...manifest.memberships].sort(
      (a, b) => (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1),
    );
    const seen = new Set<string>();
    for (const m of ordered) {
      const userId = m.role === 'owner' ? opts.ownerId : m.userId;
      // Dedup by RESULTING userId: a `user` row whose id already equals the
      // importer (same Google account on both installs — "family member takes
      // the agent home") would otherwise collide with the remapped owner row
      // on UNIQUE(agent_id, user_id) and roll the whole import back.
      if (seen.has(userId)) continue;
      seen.add(userId);
      store.insertMembership({
        id: randomUUID(),
        agentId: agent.id,
        userId,
        role: m.role,
        displayName: m.displayName,
        // The owner seat's telegram id is the PREVIOUS owner's — the importer
        // is a different person, so drop it and let them claim first contact.
        // Carrying it over would (a) admit the stranger to this bot and
        // (b) poison knownChannelUserId so every future agent seeds and skips
        // the claim onto that stranger's id.
        channelUserId: m.role === 'owner' ? undefined : m.channelUserId,
        status: m.status,
        joinedAt: now,
      });
    }

    await secrets.put(secretRef, manifest.channel.botToken);
    store.insertChannel({
      id: randomUUID(),
      agentId: agent.id,
      kind: manifest.channel.kind,
      accountId: manifest.channel.accountId,
      secretRef,
      // Derived, not imported: accountId is regex-validated, so this cannot be
      // anything but a t.me link no matter what the archive claimed.
      deepLink: `https://t.me/${manifest.channel.accountId}`,
      createdAt: now,
    });

    // Recreate the env vars BEFORE provisioning renders the runtime spec, so
    // the container boots with them (an agent without its env secrets is
    // silently broken). The archive is untrusted: the same reserved-name
    // policy the web route enforces applies here — a crafted archive must not
    // smuggle in a proxy/credential/loader variable. Refuse loudly rather
    // than skip: a quietly dropped var is this bug in a new costume.
    for (const v of manifest.envVars ?? []) {
      const reserved = reservedEnvProblem(v.name);
      if (reserved) {
        throw new TransferError(`This archive sets env var "${v.name}", which is not allowed: ${reserved}`);
      }
    }
    for (const v of manifest.envVars ?? []) {
      const envId = randomUUID();
      const envRef = `agent-env/${envId}`;
      await secrets.put(envRef, v.value);
      envSecretRefs.push(envRef);
      store.insertAgentEnv({ id: envId, agentId: agent.id, name: v.name, secretRef: envRef, createdAt: now });
    }

    // Provision creates + seeds the volume; the snapshot then overwrites it
    // with the real state; a second provision re-applies THIS installation's
    // config (model, auth mode) over the imported openclaw.json — the seed
    // never touches existing workspace files, so memory survives.
    const spec = await buildRuntimeSpec(deps, agent.id);
    ({ runtimeRef } = await provider.provision(spec));
    store.setAgentRuntimeRef(agent.id, runtimeRef);
    await provider.importState(runtimeRef, stateBuf);
    const respec = await buildRuntimeSpec(deps, agent.id);
    await provider.provision(respec);
    recordApplied(store, agent.id);
    await provider.start(runtimeRef);
    // First boot on an import can be slow (cold image on Docker Desktop's VM,
    // imported sessions to load) — give it 2 minutes, not the default 30s.
    await waitForHealthy(
      provider,
      runtimeRef,
      deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      120,
    );
    // $HOME rode the archive, but tools installed OUTSIDE it (apt, /usr/local)
    // come from the image — re-run the on-rebuild hook so an imported agent's
    // system tools are reconstituted, as rebuild does (audit 2026-09-08).
    await runRebuildHook(deps, agent.id, runtimeRef, log);
    // Let the skills/gateway settle before flipping to RUNNING, or a message
    // landing in the first ~30s starts a fresh session and archives the
    // imported conversation thread — the same guard rebuild uses (audit 2026-09-08).
    await waitForSkillsSettled(provider, runtimeRef, agent.slug, deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), log);
    log('agent.imported', { agentId: agent.id, slug: agent.slug, from: manifest.exportedAt });
    return store.setAgentState(agent.id, 'RUNNING');
  } catch (err) {
    // Roll back completely: a "Retry" on a half-imported agent would boot it
    // with a fresh seeded volume — an empty-headed impostor of the archive.
    // Leaving nothing behind keeps "import again" the one true retry path.
    // Each step guarded: one rollback step failing (a store hiccup, a state
    // moved out from under us) must not abandon the rest half-done.
    // Each step guarded on its own so one failing does not skip the rest —
    // above all the tombstone MUST land, or the half-made PROVISIONING row
    // keeps the slug and bot accountId and refuses the "import again" retry.
    const step = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        log('import.rollback_step_failed', { agentId: agent.id, error: String(e) });
      }
    };
    if (runtimeRef) await provider.destroy(runtimeRef, { purge: true }).catch(() => {});
    await secrets.delete(secretRef).catch(() => {});
    for (const ref of envSecretRefs) await secrets.delete(ref).catch(() => {});
    step(() => store.deleteChannelForAgent(agent.id));
    step(() => store.deleteMemberships(agent.id));
    // Env rows too — their secrets are already deleted above; a tombstone
    // keeping references to swept secrets is the residue class the v0.90
    // audit scrubbed.
    step(() => store.scrubAgentResidue(agent.id));
    step(() => {
      store.setAgentState(agent.id, 'DELETING');
      store.setAgentState(agent.id, 'DELETED');
    });
    log('import.rolled_back', { agentId: agent.id, error: String(err) });
    throw new TransferError(
      `Import failed and was rolled back — fix the cause and import again. (${String(
        err instanceof Error ? err.message : err,
      ).slice(0, 300)})`,
    );
  } finally {
    // However this ends, the busy flag must not outlive it: a stuck flag makes
    // reconcile skip this agent forever.
    clearBusy(agent.id);
  }
}
