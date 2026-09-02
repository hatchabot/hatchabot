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
    type: { type: 'string', enum: ['text', 'longtext', 'choice', 'boolean'] },
    default: { type: 'string', maxLength: 2000 },
    options: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 120 } },
    target: { type: 'string', enum: ['soul', 'agents'], description: 'default soul' },
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

const BY_NAME = new Map(MANIFEST.map((t) => [t.name, t]));

/** The tool definition, or undefined if the name is not in the manifest
 *  (i.e. FORBIDDEN — never callable). */
export function toolDef(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}
