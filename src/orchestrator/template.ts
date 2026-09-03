import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { Agent, TemplateParam } from '../domain/types.js';
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

// TemplateParam (domain/types.ts): a setup field the template's AUTHOR
// declares — the importer fills it and the value is substituted into {{key}}
// placeholders. The manifest carries DEFINITIONS and defaults only, never the
// author's own filled values — the no-secrets guarantee stays intact. `target`
// records where the author expects the placeholder; substitution itself
// follows the placeholders.
export type { TemplateParam } from '../domain/types.js';

/** Placeholder syntax: {{ key }} — keys are snake_case, author-friendly. */
export const PARAM_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const PLACEHOLDER_RE = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;

export const TemplateParamSchema = z.object({
  key: z.string().regex(PARAM_KEY_RE, 'keys are snake_case, ≤32 chars'),
  label: z.string().min(1).max(64),
  help: z.string().max(200).optional(),
  required: z.boolean(),
  type: z.enum(['text', 'longtext', 'choice', 'multichoice', 'boolean']),
  default: z.string().max(2000).optional(),
  options: z.array(z.string().min(1).max(120)).max(12).optional(),
  target: z.enum(['soul', 'agents']),
});

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
  /** Setup fields the importer fills; substituted into {{key}} placeholders. */
  parameters: TemplateParam[];
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
  // Optional + defaulted: templates from before Phase 2a parse as having none,
  // and older apps reading a newer template strip the unknown key (zod objects
  // are non-strict) — no version bump needed in either direction.
  parameters: z.array(TemplateParamSchema).max(24).default([]),
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
    parameters: collectParameters(agent, files),
  };
  deps.log?.('template.exported', { agentId });
  return {
    filename: `${agent.slug}.template.agentclaw`,
    data: gzipSync(Buffer.from(JSON.stringify(manifest))),
  };
}

/**
 * The template's setup fields: what the author DECLARED on the agent, plus any
 * {{key}} placeholder hand-written into SOUL/AGENTS/persona that was never
 * declared — auto-derived as a required text field, so writing a placeholder is
 * enough to make sharing ask for it (no declaration UI required).
 */
function collectParameters(
  agent: Agent,
  files: Record<string, string>,
): TemplateParam[] {
  const declared = (agent.parameters ?? []).slice(0, 24);
  const seen = new Set(declared.map((p) => p.key));
  const derived: TemplateParam[] = [];
  const scan = (text: string | undefined, target: 'soul' | 'agents') => {
    for (const m of (text ?? '').matchAll(PLACEHOLDER_RE)) {
      const key = m[1]!;
      if (seen.has(key)) continue;
      seen.add(key);
      derived.push({ key, label: key.replace(/_/g, ' '), required: true, type: 'text', target });
    }
  };
  scan(files['SOUL.md'], 'soul');
  scan(agent.persona, 'soul');
  scan(files['AGENTS.md'], 'agents');
  return [...declared, ...derived].slice(0, 24);
}

/**
 * Replace {{key}} placeholders with the importer's values (or the declared
 * default). Unknown placeholders are left verbatim — a doc showing the syntax
 * must not get mangled.
 */
export function applyParamValues(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (whole, key: string) =>
    Object.hasOwn(values, key) ? values[key]! : whole,
  );
}

/**
 * Validate the importer's values against the template's declared fields.
 * Returns the effective values (importer's, else defaults) or throws a
 * TransferError naming every problem at once — the caller renders one form,
 * the importer should see one list.
 */
export function resolveParamValues(
  params: TemplateParam[],
  values: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const problems: string[] = [];
  for (const p of params) {
    let v = values[p.key] ?? p.default;
    if (p.type === 'boolean' && v !== undefined) {
      v = /^(true|yes|1|on)$/i.test(v) ? 'true' : 'false';
    }
    if (p.type === 'choice' && v !== undefined && p.options?.length && !p.options.includes(v)) {
      problems.push(`"${p.label}" must be one of: ${p.options.join(', ')}`);
      continue;
    }
    // multichoice: the value is a comma-separated SUBSET of the options,
    // normalized to "a, b" — that string is what lands in the {{placeholder}},
    // so it must read naturally in prose.
    if (p.type === 'multichoice' && v !== undefined && v !== '' && p.options?.length) {
      const picks = v.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = picks.filter((s) => !p.options!.includes(s));
      if (bad.length) {
        problems.push(`"${p.label}" allows only: ${p.options.join(', ')} (got ${bad.join(', ')})`);
        continue;
      }
      v = picks.join(', ');
    }
    if (p.required && (v === undefined || v === '')) {
      problems.push(`"${p.label}" is required`);
      continue;
    }
    if (v !== undefined) out[p.key] = v;
  }
  if (problems.length) {
    throw new TransferError(`This template needs setup values — ${problems.join('; ')}.`);
  }
  return out;
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
  opts: {
    ownerId: string;
    aiProfileId?: string;
    hostId?: string;
    name?: string;
    /** Importer's answers to the template's setup fields ({{key}} → value). */
    values?: Record<string, string>;
  },
): ImportTemplateResult {
  const { store } = deps;
  const manifest = parseTemplate(data);
  // Validate BEFORE creating anything — a missing required value must not
  // leave a half-made agent behind.
  const values = resolveParamValues(manifest.parameters, opts.values);

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
      persona: applyParamValues(manifest.agent.persona, values),
      aiProfileId: profile.id,
      hostId: host.id,
      sharedMemory: manifest.agent.sharedMemory,
    });
  } catch {
    throw new TransferError(`Couldn't create "${name}" — an agent with that name may already exist here. Import under a different name.`);
  }

  // Seed the trained files (and MEMORY.md if the template carried it).
  // Setup-field values are substituted into the TRAINED files only — memory is
  // verbatim history, never a substitution surface.
  const seed: Record<string, string> = {};
  for (const n of SEEDABLE_FILES) {
    if (typeof manifest.files[n] !== 'string') continue;
    seed[n] = TRAINED_FILES.includes(n)
      ? applyParamValues(manifest.files[n], values)
      : manifest.files[n];
  }
  store.setAgentSeed(agent.id, seed);

  // A configured copy stays RE-configurable: keep the field declarations (so
  // re-sharing works and the values panel knows its schema), the values as
  // applied, and the raw placeholder-bearing layer they rendered into — so
  // values can be edited or reset later without a re-import.
  if (manifest.parameters.length) {
    store.setAgentParameters(agent.id, manifest.parameters);
    store.setAgentParamState(agent.id, values, {
      soul: manifest.files['SOUL.md'],
      agents: manifest.files['AGENTS.md'],
      persona: manifest.agent.persona,
    });
  }

  deps.log?.('template.imported', { agentId: agent.id });
  return { agent, needs: { dataSources: manifest.dataNeeds, envVars: manifest.envNeeds } };
}
