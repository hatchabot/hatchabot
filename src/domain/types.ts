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
   * Host folders mounted read-only into this agent's container, so it can
   * read your data. Deliberately per-agent: the homework tutor should not
   * inherit what the finance agent can see.
   */
  sharedPaths?: string[];
  /**
   * Set once this agent has been moved to another server. Its runtime here is
   * a stale copy: starting it would make two pollers fight over one bot token.
   */
  migratedTo?: string;
  /** The AI profile the runtime was last configured with (vs the desired one). */
  appliedProfileId?: string;
  /** The model that configuration actually used. */
  appliedModel?: string;
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
