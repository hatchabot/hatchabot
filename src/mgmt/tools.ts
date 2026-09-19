import { REST_TOOLS } from './restTools.js';
/**
 * The management broker's tool manifest — the SINGLE source of truth for what
 * the model (Phase 2) may propose and what the deterministic slash commands
 * (Phase 1) map onto. See docs/management-broker.md.
 *
 * `tier` is broker-enforced authority and is never shown to the model as
 * something it can change: a tool's tier decides read-now vs confirm-first
 * regardless of what any prompt or injected text "wants". Anything not in this
 * manifest is FORBIDDEN — the model literally cannot call it.
 */

export type Tier = 'read' | 'mutate';

export interface ToolDef {
  name: string;
  tier: Tier;
  description: string;
  /** Claude tool-use input schema (draft 2020-12). Also documents slash args. */
  input_schema: {
    type: 'object';
    additionalProperties: false;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const agentRef = {
  type: 'string',
  description: 'An agent id or exact slug from a prior list result. Prefer the id.',
  minLength: 1,
  maxLength: 64,
} as const;

/** A template setup field — mirrors the control plane's TemplateParamSchema
 *  (orchestrator/template.ts); the broker re-validates with the real zod
 *  schema before any confirmation card is shown. */
const SETUP_FIELD = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: {
      type: 'string',
      pattern: '^[a-z][a-z0-9_]{0,31}$',
      description: 'snake_case; substituted into {{key}} placeholders',
    },
    label: { type: 'string', minLength: 1, maxLength: 64 },
    help: { type: 'string', maxLength: 200 },
    required: { type: 'boolean', description: 'default false' },
    type: { type: 'string', enum: ['text', 'longtext', 'choice', 'multichoice', 'boolean'] },
    default: { type: 'string', maxLength: 2000 },
    options: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 120 } },
    target: {
      type: 'string',
      enum: ['soul', 'agents', 'env', 'datasource'],
      description: 'default soul; env = the value becomes an env var named KEY uppercased (text type only); datasource = the value is a git repo URL that becomes a git data source on the imported copy (text type only, no default)',
    },
  },
  required: ['key', 'label', 'type'],
} as const;

export const MANIFEST: ToolDef[] = [
  // ---- read tier (auto-execute) ----
  {
    name: 'list_agents',
    tier: 'read',
    description: "List the owner's agents with state, model, and last-active time.",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        state: {
          type: 'string',
          enum: ['PROVISIONING', 'RUNNING', 'REBUILDING', 'STOPPED', 'FAILED'],
        },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'get_agent',
    tier: 'read',
    description: 'Full status for one agent: state, model, members, pending action.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef },
      required: ['agent'],
    },
  },
  {
    name: 'get_logs',
    tier: 'read',
    description: 'Recent log lines for one agent.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef, lines: { type: 'integer', minimum: 1, maximum: 200 } },
      required: ['agent'],
    },
  },
  {
    name: 'list_members',
    tier: 'read',
    description: 'Members of one agent.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef },
      required: ['agent'],
    },
  },
  {
    name: 'list_pending',
    tier: 'read',
    description: 'People waiting to be let into an agent (pairing requests).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef },
      required: ['agent'],
    },
  },
  {
    name: 'get_pool',
    tier: 'read',
    description: 'Telegram bot pool: free vs used.',
    input_schema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'list_events',
    tier: 'read',
    description:
      "Recent fleet activity — provisions, rebuilds, members admitted/removed, snapshots, moves, health changes. Optionally filter to one agent.",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    },
  },
  {
    name: 'get_health',
    tier: 'read',
    description:
      "Whether an agent is actually answering right now: a live gateway probe (event loop, Telegram connection, plugin errors).",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef },
      required: ['agent'],
    },
  },
  {
    name: 'get_usage',
    tier: 'read',
    description: 'Token usage by model for one agent.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef },
      required: ['agent'],
    },
  },

  // ---- mutate tier (propose only; each requires a human confirm) ----
  {
    name: 'start_agent',
    tier: 'mutate',
    description: 'Start a stopped agent. Requires the owner to confirm.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef },
      required: ['agent'],
    },
  },
  {
    name: 'stop_agent',
    tier: 'mutate',
    description: 'Stop a running agent. Requires the owner to confirm.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef },
      required: ['agent'],
    },
  },
  {
    name: 'rebuild_agent',
    tier: 'mutate',
    description: 'Rebuild an agent (memory kept). Requires the owner to confirm.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef },
      required: ['agent'],
    },
  },
  {
    name: 'set_model',
    tier: 'mutate',
    description: "Set an agent's model. Must be one its AI source offers.",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef, model: { type: 'string', minLength: 1, maxLength: 64 } },
      required: ['agent', 'model'],
    },
  },
  {
    name: 'approve_member',
    tier: 'mutate',
    description: 'Admit a pending pairing request (reference a code from list_pending).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      // {4,16} to match members.ts/broker.ts — a 13-16 char code from
      // OpenClaw's external pairing store was approvable via the button path
      // but rejected here (audit 2026-09-02).
      properties: { agent: agentRef, code: { type: 'string', pattern: '^[A-Za-z0-9]{4,16}$' } },
      required: ['agent', 'code'],
    },
  },
  {
    name: 'remove_member',
    tier: 'mutate',
    description: 'Remove a member (reference a userId from list_members).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef, userId: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['agent', 'userId'],
    },
  },

  // ---- images (host-owner surface; the /v1 routes gate on that too) ----
  {
    name: 'get_runtime',
    tier: 'read',
    description:
      "The fleet's base runtime: which OpenClaw version the base image bakes in, the newest on npm, and whether an upgrade is available. To try a new version, propose build_base_candidate.",
    input_schema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'list_images',
    tier: 'read',
    description:
      'The base image plus every derived image (extra packages on top of the base): name, tag, build status, base, and how many agents pin each.',
    input_schema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'get_image_log',
    tier: 'read',
    description: "A derived image's build status and log tail — for diagnosing a failed build.",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1, maxLength: 40 } },
      required: ['name'],
    },
  },
  {
    name: 'list_base_images',
    tier: 'read',
    description:
      'Base runtime images on this machine: the fleet default (:latest) and its OpenClaw version, plus every candidate (a built but not promoted version) with the agents trying it.',
    input_schema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'get_base_build',
    tier: 'read',
    description: 'Progress of the base-image candidate build: running or finished, success or error, and the log tail.',
    input_schema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'build_base_candidate',
    tier: 'mutate',
    description:
      'Build a CANDIDATE base image for an OpenClaw version (default: the newest on npm), optionally with extra system packages baked in. Nothing changes for any agent: the fleet keeps its current image until a candidate is tried on one agent and then promoted in the web app. Requires confirm; runs in the background — check get_base_build.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { type: 'string', minLength: 1, maxLength: 64, description: 'OpenClaw version, e.g. 2026.9.1' },
        packages: {
          type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 64 },
          description: 'System packages to add on top of the standard image, by apt name (e.g. ["iputils-ping"]). The candidate gets its own tag; nothing changes for any agent until the owner promotes it.',
        },
      },
    },
  },
  {
    name: 'try_base_candidate',
    tier: 'mutate',
    description:
      "Try a built candidate on ONE agent: pin that agent to the candidate's tag and rebuild it (memory kept). Use a tag from list_base_images. Requires confirm.",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef, tag: { type: 'string', minLength: 1, maxLength: 160 } },
      required: ['agent', 'tag'],
    },
  },
  {
    name: 'end_base_trial',
    tier: 'mutate',
    description: 'End a trial: unpin the agent from its candidate image and rebuild it back onto the fleet default (memory kept). Requires confirm.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: agentRef },
      required: ['agent'],
    },
  },
  {
    name: 'build_image',
    tier: 'mutate',
    description:
      'Build a NEW derived image: a name and the Dockerfile lines to append after FROM (apt/pip installs etc.). The owner reviews the snippet on a card; the build runs in the background after confirm — check list_images / get_image_log for the result.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 40, description: 'lowercase, digits, dashes' },
        dockerfile: { type: 'string', minLength: 1, maxLength: 20000 },
        base: { type: 'string', minLength: 1, maxLength: 160, description: 'defaults to the fleet base' },
      },
      required: ['name', 'dockerfile'],
    },
  },
  {
    name: 'rebuild_image',
    tier: 'mutate',
    description: 'Rebuild an existing derived image (same Dockerfile), optionally onto a newer base. Requires confirm.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 40 },
        base: { type: 'string', minLength: 1, maxLength: 160 },
      },
      required: ['name'],
    },
  },
  {
    name: 'remove_image',
    tier: 'mutate',
    description: 'Delete a derived image. The server refuses while any agent pins it. Requires confirm.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1, maxLength: 40 } },
      required: ['name'],
    },
  },

  // ---- authoring (mutate; one proposal card carries the FULL spec) ----
  {
    name: 'create_agent',
    tier: 'mutate',
    description:
      'Draft a NEW agent for the owner to approve: name, one-line persona, full SOUL.md ' +
      '(identity & instructions), optional AGENTS.md (playbook), and optional setup fields ' +
      'whose {{key}} placeholders in the files make the agent a reusable template. ' +
      'Nothing is created until the owner confirms the proposal card. Compose complete, ' +
      'production-quality file content — the card shows the owner exactly what you wrote.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 64 },
        persona: { type: 'string', maxLength: 4000, description: 'One-line card description.' },
        soul: {
          type: 'string',
          minLength: 1,
          maxLength: 24000,
          description: 'Full SOUL.md content. May contain {{key}} placeholders matching fields.',
        },
        agents_md: { type: 'string', maxLength: 24000, description: 'Full AGENTS.md content (optional).' },
        fields: { type: 'array', maxItems: 24, items: SETUP_FIELD },
      },
      required: ['name', 'soul'],
    },
  },
  {
    name: 'update_definition',
    tier: 'mutate',
    description:
      "Propose replacing an existing agent's definition: SOUL.md and/or AGENTS.md content " +
      '(full replacement, not a patch), its one-line persona, and/or its setup-field ' +
      'declarations. The owner sees a diff-style summary and full preview before anything ' +
      'is written; a snapshot is taken automatically so the change is reversible. ' +
      'MEMORY.md is never editable here.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: agentRef,
        soul: { type: 'string', minLength: 1, maxLength: 24000 },
        agents_md: { type: 'string', minLength: 1, maxLength: 24000 },
        persona: { type: 'string', maxLength: 4000 },
        fields: { type: 'array', maxItems: 24, items: SETUP_FIELD },
      },
      required: ['agent'],
    },
  },
];

// The one-call tools (restTools.ts) join the menu with the same shape.
MANIFEST.push(...REST_TOOLS.map(({ name, tier, description, input_schema }) => ({ name, tier, description, input_schema } as ToolDef)));

const BY_NAME = new Map(MANIFEST.map((t) => [t.name, t]));

/** The tool definition, or undefined if the name is not in the manifest
 *  (i.e. FORBIDDEN — never callable). */
export function toolDef(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}
