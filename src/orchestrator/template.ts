import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { Agent } from '../domain/types.js';
import type { Store } from '../store/store.js';
import type { RuntimeProvider } from '../providers/provider.js';
import { CORE_FILES, workspacePath } from './snapshots.js';
import { createAgentRecord } from './provision.js';
import { TransferError } from './transfer.js';

/**
 * A "template" is a SHAREABLE copy of an agent — its training (SOUL.md +
 * AGENTS.md) and what it expects to run against, with NONE of its identity: no
 * bot token, no members, no conversation history; memory only when the sharer
 * explicitly opts in (includeMemory). It's safe to email. Import stands up a
 * FRESH agent: the importer owns it, supplies
 * their own bot (the normal create flow), and re-invites their own people.
 *
 * This is deliberately separate from Save/Load (transfer.ts), which carries the
 * whole identity for re-hosting the SAME agent.
 */
export const TEMPLATE_FORMAT = 'agentclaw-template';
export const TEMPLATE_VERSION = 1;

/** Always carried: the agent's persona and instructions. */
const TRAINED_FILES = ['SOUL.md', 'AGENTS.md'];
/** Files a template may seed on import — the same core set snapshots protect. */
const SEEDABLE_FILES = CORE_FILES;

export interface TemplateManifest {
  format: typeof TEMPLATE_FORMAT;
  version: number;
  exportedAt: string;
  agent: { name: string; persona: string; sharedMemory: boolean };
  files: Record<string, string>;
  ai: { vendor: string };
  /** What the agent expects to read — declarations only, never secrets. */
  dataNeeds: Array<{ kind: string; access: string; mountName: string; repoUrl?: string }>;
  /** Env var NAMES the agent's tools expect — the importer supplies the values. */
  envNeeds: string[];
}

const TemplateSchema = z.object({
  format: z.literal(TEMPLATE_FORMAT),
  version: z.literal(TEMPLATE_VERSION),
  exportedAt: z.string().max(64),
  agent: z.object({
    name: z.string().min(1).max(64),
    persona: z.string().max(8000),
    sharedMemory: z.boolean(),
  }),
  files: z
    .record(z.string().max(200), z.string().max(200_000))
    .refine((r) => Object.keys(r).length <= 200, { message: 'too many files in template' }),
  ai: z.object({ vendor: z.string().max(32) }),
  dataNeeds: z
    .array(
      z.object({
        kind: z.string().max(16),
        access: z.string().max(8),
        mountName: z.string().max(128),
        repoUrl: z.string().max(512).optional(),
      }),
    )
    .max(32)
    .default([]),
  envNeeds: z.array(z.string().max(128)).max(64).default([]),
});

export interface TemplateDeps {
  store: Store;
  provider: RuntimeProvider;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export async function exportTemplate(
  deps: TemplateDeps,
  agentId: string,
  opts: { includeMemory?: boolean } = {},
): Promise<{ filename: string; data: Buffer }> {
  const { store, provider } = deps;
  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new TransferError('This agent has no runtime to export yet.');
  if (agent.state !== 'RUNNING') {
    throw new TransferError(`Start the agent to export a template (it's ${agent.state}).`);
  }
  const profile = store.getAIProfile(agent.aiProfileId);

  // Persona + instructions always; MEMORY.md unless excluded (default: include,
  // so the copy is faithful to its parent — the caller opts out when the memory
  // is personal and headed to someone else).
  const includeMemory = opts.includeMemory !== false;
  const wanted = includeMemory ? [...TRAINED_FILES, 'MEMORY.md'] : TRAINED_FILES;
  const files: Record<string, string> = {};
  for (const name of wanted) {
    const res = await provider.execShell(
      agent.runtimeRef,
      `cat ${JSON.stringify(workspacePath(agent.slug, name))} 2>/dev/null || true`,
    );
    files[name] = res.stdout;
  }

  const manifest: TemplateManifest = {
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    exportedAt: new Date().toISOString(),
    agent: { name: agent.name, persona: agent.persona, sharedMemory: agent.sharedMemory },
    files,
    ai: { vendor: profile?.vendor ?? 'anthropic' },
    dataNeeds: store.listDataSources(agentId).map((d) => ({
      kind: d.kind,
      access: d.access,
      mountName: d.mountName,
      repoUrl: d.repoUrl,
    })),
    envNeeds: store.listAgentEnv(agentId).map((e) => e.name),
  };
  deps.log?.('template.exported', { agentId });
  return {
    filename: `${agent.slug}.template.agentclaw`,
    data: gzipSync(Buffer.from(JSON.stringify(manifest))),
  };
}

// A template is trained text files; 64 MB decompressed is already generous and
// bounds a decompression bomb even if a future caller reaches parseTemplate
// without the peekFormat gate in front of it.
const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024;

export function parseTemplate(data: Buffer): TemplateManifest {
  let json: unknown;
  try {
    json = JSON.parse(gunzipSync(data, { maxOutputLength: MAX_TEMPLATE_BYTES }).toString('utf8'));
  } catch {
    throw new TransferError('That file is not a readable AgentClaw template.');
  }
  const parsed = TemplateSchema.safeParse(json);
  if (!parsed.success) {
    throw new TransferError('That template file is malformed or from an incompatible version.');
  }
  return parsed.data as TemplateManifest;
}

export interface ImportTemplateResult {
  agent: Agent;
  /** What the importer still needs to wire up (data sources, env-var names). */
  needs: { dataSources: TemplateManifest['dataNeeds']; envVars: string[] };
}

export function importTemplate(
  deps: TemplateDeps,
  data: Buffer,
  opts: { ownerId: string; aiProfileId?: string; hostId?: string; name?: string },
): ImportTemplateResult {
  const { store } = deps;
  const manifest = parseTemplate(data);

  // The importer's OWN profile, vendor-matched — same rule as a full Load, so a
  // template never silently bills someone else's shared subscription.
  const profiles = store.listAIProfiles(opts.ownerId);
  const mine = profiles.filter((p) => p.ownerId === opts.ownerId);
  const profile = opts.aiProfileId
    ? store.getAIProfile(opts.aiProfileId)
    : (mine.find((p) => p.vendor === manifest.ai.vendor) ??
      mine[0] ??
      profiles.find((p) => p.vendor === manifest.ai.vendor) ??
      profiles[0]);
  if (!profile) throw new TransferError('Set up an AI source before importing a template.');
  const host = opts.hostId
    ? store.getHost(opts.hostId)
    : (store.listHosts(opts.ownerId).find((h) => h.kind === 'local') ??
      store.listHosts(opts.ownerId)[0]);
  if (!host) throw new TransferError('No host available to import onto.');

  const name = (opts.name ?? manifest.agent.name).trim();
  let agent: Agent;
  try {
    // Fresh identity: importer owns it, provisions their own bot, invites their
    // own people. createAgentRecord slugifies the name and binds the owner seat.
    agent = createAgentRecord(store, {
      ownerId: opts.ownerId,
      name,
      persona: manifest.agent.persona,
      aiProfileId: profile.id,
      hostId: host.id,
      sharedMemory: manifest.agent.sharedMemory,
    });
  } catch {
    throw new TransferError(`Couldn't create "${name}" — an agent with that name may already exist here. Import under a different name.`);
  }

  // Seed the trained files (and MEMORY.md if the template carried it) verbatim;
  // anything absent falls back to the fresh generated default.
  const seed: Record<string, string> = {};
  for (const n of SEEDABLE_FILES) {
    if (typeof manifest.files[n] === 'string') seed[n] = manifest.files[n];
  }
  store.setAgentSeed(agent.id, seed);

  deps.log?.('template.imported', { agentId: agent.id });
  return { agent, needs: { dataSources: manifest.dataNeeds, envVars: manifest.envNeeds } };
}
