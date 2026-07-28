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

export type AIVendor = 'anthropic' | 'google';

export interface AIProfile {
  id: string;
  ownerId: string;
  name: string;
  vendor: AIVendor;
  kind: AIProfileKind;
  /** Model id to hand OpenClaw, e.g. "claude-opus-5". */
  model: string;
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
