/**
 * Core domain types. These mirror §4 and §11.4 of the spec.
 *
 * Naming note: the *workspace* (agent files + memory) is decoupled from the
 * *runtime* (the container that runs OpenClaw). Everything here treats runtimes
 * as disposable and workspaces as durable — that decoupling is what makes
 * re-hosting (§5.4) and, later, hibernation (§8) cheap.
 */

export type AgentState =
  | 'PROVISIONING'
  | 'RUNNING'
  | 'REBUILDING'
  | 'STOPPED'
  | 'ARCHIVED'
  | 'DELETING'
  | 'DELETED'
  | 'FAILED';

/** Where a runtime lives. Cloud is the default; Local is a user's own box. */
export type HostKind = 'cloud' | 'local';

/**
 * How the agent's model access is authenticated.
 *
 * `api_key`   — an Anthropic (or Google) API key. Fully supported.
 * `subscription` — a Claude Pro/Max OAuth session. Supported for an agent
 *   running on the *owner's own* machine only; see docs/ai-profiles.md for why
 *   we do not copy these into managed cloud runtimes.
 */
export type AIProfileKind = 'api_key' | 'subscription';

/**
 * `local` is a model server you run yourself (Ollama today). It is the only
 * vendor with no credential at all — nothing to store, nothing to inject, and
 * nothing leaves the machine.
 */
export type AIVendor = 'anthropic' | 'google' | 'local';

export interface AIProfile {
  id: string;
  ownerId: string;
  name: string;
  vendor: AIVendor;
  kind: AIProfileKind;
  /** Model id to hand OpenClaw, e.g. "claude-opus-5". */
  model: string;
  /**
   * Further models of the same vendor the agent may switch to in chat
   * (OpenClaw's /model picker). `model` stays the default; order is the
   * picker's order.
   */
  models?: string[];
  /**
   * Where a `local` vendor's model server listens, as the AGENT sees it —
   * containers can't reach the host's loopback, so this is typically the
   * docker bridge (http://172.17.0.1:11434).
   */
  baseUrl?: string;
  /**
   * Reference into the SecretStore — never the secret itself. Absent for
   * subscription profiles: the OAuth credential stays on the host machine
   * (~/.claude) and is mounted, never copied into AgentClaw's store.
   */
  secretRef?: string;
  /**
   * Owner's pick: the management bot's LLM rides THIS source, via the control
   * plane's server-side proxy (the credential never reaches the bot process).
   * Single-select per owner; needs a portable anthropic credential (api key or
   * setup-token) — machine-login and local sources can't back a raw API call.
   */
  mgmtLlm?: boolean;
  /**
   * Owner opted in to every account on this installation using this source
   * for THEIR agents — deliberately sharing a Max subscription (or a key)
   * with the family. Off by default: sharing spend is an explicit act.
   */
  shared?: boolean;
  createdAt: string;
}

export interface Agent {
  id: string;
  ownerId: string;
  name: string;
  /** Slug used for the OpenClaw agent id and workspace directory. */
  slug: string;
  state: AgentState;
  /** Plain-English reason, set when state is FAILED. Shown in the app. */
  stateReason?: string;
  aiProfileId: string;
  hostId: string;
  /** Opaque handle the RuntimeProvider uses to address this runtime. */
  runtimeRef?: string;
  /** Persona seed used at provision time. */
  persona: string;
  /** One-to-many agents share MEMORY.md across members (§12.5). */
  sharedMemory: boolean;
  /**
   * Optional per-agent model override, chosen from the profile's model menu.
   * Absent = follow the profile's default. Ignored for local profiles (only
   * one local model fits in memory), so it never applies there.
   */
  model?: string;
  /**
   * Legacy read-only host folders. Superseded by DataSource (kind 'folder',
   * access 'ro') but kept working untouched: existing agents' mounts must not
   * churn. New folders — including writable ones — are DataSources.
   */
  sharedPaths?: string[];
  /**
   * Set once this agent has been moved to another server. Its runtime here is
   * a stale copy: starting it would make two pollers fight over one bot token.
   */
  migratedTo?: string;
  /**
   * Pin this agent to a specific runtime image (e.g. a candidate build under
   * test, or a derived image with extra system packages). Absent = the host's
   * default (:latest), which is what fleet-wide promote moves. Applied on the
   * next rebuild, like a model change.
   */
  image?: string;
  /** The AI profile the runtime was last configured with (vs the desired one). */
  appliedProfileId?: string;
  /** The model that configuration actually used. */
  appliedModel?: string;
  /** Owner-defined organization: an optional group label, and a manual order
   *  (ascending) used within the group. Absent group = "ungrouped". */
  group?: string;
  sortOrder?: number;
  /** Setup fields this agent's shares/templates ask the importer to fill. */
  parameters?: TemplateParam[];
  /** The values currently applied (imported agents) — editable, re-rendered. */
  paramValues?: Record<string, string>;
  /** The raw placeholder-bearing layer the values render into: template
   *  SOUL/AGENTS text + persona, kept so values can be changed LATER without
   *  a re-import. Absent on agents that aren't configured template copies. */
  paramFiles?: { soul?: string; agents?: string; persona?: string };
  /** Host port publishing the agent's own OpenClaw Control UI (debug). */
  gatewayPort?: number;
  /** Gateway auth token for that Control UI. */
  gatewayToken?: string;
  /**
   * Set while provisioning is parked on a human step (e.g. the user must
   * paste a bot token). The app renders this as an actionable card; resuming
   * provisioning clears it.
   */
  pendingAction?: PendingAction;
  createdAt: string;
  updatedAt: string;
}

export interface PendingAction {
  type: 'bot_token';
  instructions: string;
}

/**
 * One thing an agent can access, unified across kinds so "what data does this
 * agent have?" has a single answer. The agent sees it at `/data/<mountName>`.
 *
 * - `folder` — a host directory bind-mounted (`hostPath`). `ro` is kernel-safe;
 *   `rw` lets the agent write to your disk and is gated + warned.
 * - `git` — a repo cloned into the agent's volume (`repoUrl`), edited/committed
 *   there. One ed25519 deploy key is generated either way (private half in the
 *   SecretStore `secretRef`, public half shown via `pubKey`). `access` records
 *   intent and drives the setup hint; whether the clone can actually push is
 *   decided by the "Allow write access" box when the key is registered on the
 *   host — AgentClaw does not itself block a push.
 */
export interface DataSource {
  id: string;
  agentId: string;
  kind: 'folder' | 'git';
  access: 'ro' | 'rw';
  /** Where the agent sees it: `/data/<mountName>`. Unique per agent. */
  mountName: string;
  hostPath?: string;
  /** Bind at the ORIGINAL host path inside the container instead of
   *  `/data/<mountName>`. Set when adopting an OpenClaw agent, so its existing
   *  references to absolute paths (in prompts, memory, and crons) still resolve. */
  mountAtHostPath?: boolean;
  repoUrl?: string;
  secretRef?: string;
  pubKey?: string;
  /** git only: why the last clone/refresh failed (usually the deploy key isn't
   *  on the repo host yet). Cleared on the next successful sync. */
  syncError?: string;
  /** git only: when the last clone/refresh was attempted. */
  syncedAt?: string;
  createdAt: string;
}

/**
 * A per-agent environment variable, injected into the runtime at provision time
 * — an API key or config the agent's own tools need (e.g. a market-data key).
 * The value is treated as a secret: it lives in the SecretStore (`secretRef`),
 * is never returned by the API, and is write-only from the app (only the name is
 * shown). Applies on the next rebuild. Managed AI credentials always win over a
 * same-named var, and a small reserved set is refused at the API.
 */
export interface AgentEnvVar {
  id: string;
  agentId: string;
  name: string;
  secretRef: string;
  createdAt: string;
}

export interface Host {
  id: string;
  ownerId: string;
  kind: HostKind;
  /** Provider key, e.g. "mock", "local-docker", "gce". */
  provider: string;
  name: string;
  /** Provider-specific settings (project id, zone, docker socket, ...). */
  settings: Record<string, unknown>;
  createdAt: string;
}

/**
 * A setup field a template's author declares on their agent (sharing Phase 2a):
 * the importer fills it and the value replaces `{{key}}` placeholders in the
 * seeded SOUL.md/AGENTS.md (and persona). Definitions and defaults only —
 * never the author's own filled values.
 */
export interface TemplateParam {
  key: string;
  label: string;
  help?: string;
  required: boolean;
  type: 'text' | 'longtext' | 'choice' | 'multichoice' | 'boolean';
  default?: string;
  options?: string[];
  target: 'soul' | 'agents' | 'env';
}

export type DerivedImageStatus = 'BUILDING' | 'READY' | 'FAILED';

/**
 * A runtime image an owner built `FROM agentclaw-runtime:<base>` plus their own
 * Dockerfile lines — for system packages a volume install can't provide (apt,
 * root-level setup). The Dockerfile snippet is kept so the image can be rebuilt
 * against a newer base after a fleet promote. Host-owner scoped: building runs
 * a Dockerfile on this box, a privilege the local-host owner already has.
 */
export interface DerivedImage {
  /** kebab name, unique on this host; the tag is `agentclaw-runtime:derived-<name>`. */
  name: string;
  /** The full image tag docker built (what an agent pins to). */
  tag: string;
  /** Base tag it was built FROM (e.g. "agentclaw-runtime:latest"). */
  base: string;
  /** The owner's Dockerfile lines, appended verbatim after the FROM. */
  dockerfile: string;
  status: DerivedImageStatus;
  /** Last build error (FAILED), else null. */
  error: string | null;
  /** Owner who created it (audit; the feature is host-owner gated). */
  createdBy: string;
  createdAt: string;
  /** Last successful build, or null if never built. */
  builtAt: string | null;
}

export type ChannelKind = 'telegram';

export interface Channel {
  id: string;
  agentId: string;
  kind: ChannelKind;
  /** OpenClaw account id — for Telegram this is the bot username. */
  accountId: string;
  /** Reference into the SecretStore holding the bot token. */
  secretRef: string;
  /** Deep link handed to the user once the agent is live. */
  deepLink: string;
  createdAt: string;
}

export type MemberRole = 'owner' | 'admin' | 'user';

export interface Membership {
  id: string;
  agentId: string;
  userId: string;
  role: MemberRole;
  /** Human-readable name, shown in the app's member list. */
  displayName?: string;
  /** Telegram user id, once linked. Drives the bot allowlist (§12.4). */
  channelUserId?: string;
  status: 'active' | 'revoked';
  invitedBy?: string;
  joinedAt?: string;
}
