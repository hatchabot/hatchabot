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
      properties: { agent: agentRef, code: { type: 'string', pattern: '^[A-Za-z0-9]{4,12}$' } },
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
];

const BY_NAME = new Map(MANIFEST.map((t) => [t.name, t]));

/** The tool definition, or undefined if the name is not in the manifest
 *  (i.e. FORBIDDEN — never callable). */
export function toolDef(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}
