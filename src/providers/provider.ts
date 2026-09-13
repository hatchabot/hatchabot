/**
 * §7.4: the Provider interface is non-negotiable even though only one provider
 * is wired at launch. Everything the control plane knows about a runtime goes
 * through here — no provider-specific types leak into the orchestrator.
 */
import type { GroupAccess } from '../domain/types.js';

export interface RuntimeSpec {
  /** Stable id of the agent this runtime serves. */
  agentId: string;
  /** OpenClaw agent id / workspace directory name. */
  slug: string;
  /**
   * Rendered OpenClaw config fragment plus workspace seed files. The provider
   * is responsible for getting these onto the runtime's persistent volume.
   */
  workspace: WorkspaceSeed;
  /** Environment injected at boot — resolved secrets live here, briefly. */
  env: Record<string, string>;
  /** Container hostname (`<agent>.<host>`), so "where am I running?" asked of
   *  the agent has a true, always-current answer. Optional: providers without
   *  a hostname concept ignore it. */
  hostname?: string;
  /**
   * Image override for THIS runtime — an agent pinned to a candidate build or
   * a derived image with extra packages. Absent = the provider's default,
   * which is what fleet-wide promote moves.
   */
  image?: string;
  /**
   * Set when this spec re-provisions an existing runtime (rebuild, retry).
   * The provider MUST keep using the same underlying storage so the agent's
   * memory survives; the returned ref stays equal to this one.
   */
  previousRef?: string;
  /**
   * Ports to publish host→container (e.g. the agent's Control UI). Providers
   * that cannot publish (mock) ignore these.
   */
  ports?: Array<{ host: number; container: number }>;
  /**
   * Host directories to expose inside the runtime. Used for subscription auth:
   * the owner's ~/.claude is mounted so every agent on the box shares the one
   * OAuth credential in place (same file, same host — refresh stays coherent).
   * Providers that cannot mount (mock, future remote clouds) ignore these.
   */
  hostMounts?: HostMount[];
}

export interface HostMount {
  source: string;
  target: string;
  readonly?: boolean;
}

export interface WorkspaceSeed {
  /** Relative path -> file contents, written into the agent's workspace. */
  files: Record<string, string>;
  /**
   * Surgical patch applied to the runtime's openclaw.json. We deliberately
   * do not template the whole file — see src/openclaw/configWriter.ts.
   */
  configPatch: OpenClawConfigPatch;
}

export interface OpenClawConfigPatch {
  agentId: string;
  /** Bare model id, e.g. "claude-opus-4-8". Prefixing is the writer's job. */
  model?: string;
  /**
   * Every model the agent may use, primary first, bare ids. Drives the
   * runtime's model allowlist and the /model picker in chat.
   */
  models?: string[];
  /**
   * How the runtime authenticates to the model vendor.
   * `oauth-claude-cli` — OpenClaw drives the Claude Code CLI, which reads the
   *   subscription credential from the mounted ~/.claude.
   * `api-key` — key arrives via env (ANTHROPIC_API_KEY / GEMINI_API_KEY).
   */
  authMode: 'oauth-claude-cli' | 'api-key';
  /**
   * `anthropic` (default) or `ollama` — a model server the owner runs. The
   * writer prefixes model refs with this and, for ollama, emits the provider
   * block pointing at `baseUrl`.
   */
  provider?: 'anthropic' | 'google' | 'ollama';
  /** Where the local model server listens, as the container sees it. */
  baseUrl?: string;
  /**
   * `claude setup-token` value for subscription auth without a mountable
   * ~/.claude (macOS hosts). Registered into OpenClaw's auth store at seed
   * time; models then ride the native anthropic provider.
   */
  setupToken?: string;
  /**
   * When set, the container gateway binds 0.0.0.0 behind token auth so the
   * provider can publish its port — the per-agent Control UI debug door.
   */
  gatewayToken?: string;
  /** cron.triggers.enabled — see Agent.cronTriggers. Written convergently. */
  cronTriggers?: boolean;
  telegram?: {
    accountId: string;
    botToken: string;
    /**
     * 'pairing'  — fresh agent: first contact triggers a pairing request the
     *              control plane approves (the §12.4 claim flow).
     * 'allowlist' — members already known; enforce allowFrom.
     */
    dmPolicy: 'pairing' | 'allowlist';
    allowFrom?: string[];
    /** Group-chat access. Absent converges to members-only on rebuild. */
    groupAccess?: GroupAccess;
    /** Rich Telegram formatting; written unconditionally (true unless the
     *  owner turned it off), so the fleet converges on rebuild. */
    richMessages?: boolean;
  };
}

export type RuntimeStatus =
  /** The runtime host itself could not be reached — say nothing about the agent. */
  | { phase: 'unknown' }
  | { phase: 'absent' }
  | { phase: 'starting' }
  | { phase: 'running'; healthy: boolean }
  | { phase: 'stopped' }
  | { phase: 'error'; message: string };

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The command was killed for taking too long — a hung daemon, not a
   *  command that ran and failed. Callers must not read "gone" into it. */
  timedOut?: boolean;
}

export interface RuntimeProvider {
  readonly key: string;

  /**
   * Create the runtime and its persistent volume, seed the workspace, and
   * leave it stopped. Must be idempotent: calling twice with the same spec
   * returns the same ref without creating a second runtime.
   */
  provision(spec: RuntimeSpec): Promise<{ runtimeRef: string }>;

  start(runtimeRef: string): Promise<void>;
  stop(runtimeRef: string): Promise<void>;

  /** Tear down the runtime. The workspace volume survives unless purge=true. */
  destroy(runtimeRef: string, opts?: { purge?: boolean }): Promise<void>;

  status(runtimeRef: string): Promise<RuntimeStatus>;

  /**
   * Run an `openclaw` subcommand inside the runtime. This is how the control
   * plane talks to a live agent (pairing list/approve, config nudges) without
   * caring where the runtime physically lives.
   */
  /** Run an `openclaw …` command in the agent's container. `timeoutMs` overrides
   *  the provider's default for long turns (a memory checkpoint, a consult). */
  exec(runtimeRef: string, openclawArgv: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;

  /**
   * Run a shell script inside the runtime. Escape hatch for the few state
   * surgeries OpenClaw's CLI has no verb for (e.g. removing a revoked member
   * from the pairing allowlist file). Prefer exec() whenever a CLI verb exists.
   */
  execShell(runtimeRef: string, script: string): Promise<ExecResult>;

  /**
   * Run a shell script against the agent's VOLUME in a one-shot container,
   * independent of the agent's own container — works while it is stopped,
   * and while it runs (durable state is all on the volume; writers must be
   * safe against concurrent reads). The volume is mounted at the same path
   * the agent sees it, so scripts use the same file paths either way.
   */
  execShellOnVolume(runtimeRef: string, script: string, opts?: { readOnly?: boolean }): Promise<ExecResult>;

  /** What this runtime is actually running (image identity, OpenClaw version). */
  info(runtimeRef: string): Promise<RuntimeInfo>;

  /**
   * What a runtime provisioned right now would run. Comparing this against
   * info() is how "update available" is detected — by image id, never by tag
   * (tags like :latest are reassigned in place).
   */
  currentImageInfo(): Promise<RuntimeInfo>;

  /** Every tag of the runtime image repo on this daemon (candidates, versions, derived). */
  listImageTags(): Promise<{ tag: string; imageId: string; createdAt?: string; size?: string; openclawVersion?: string }[]>;

  /** Point `to` at the image `from` names (e.g. promote a candidate to :latest). */
  tagImage(from: string, to: string): Promise<void>;

  /** Build steps baked into an image (what's inside), newest layer first. */
  imageHistory(ref: string): Promise<{ step: string; size: string }[]>;

  /** Remove a tag. Throws a ProviderError when a container still uses the image. */
  removeImageTag(ref: string): Promise<void>;

  /** Stable identity of the DAEMON this provider talks to. Two providers with
   *  equal daemonId() point at the same Docker daemon even if their endpoint
   *  strings differ (ssh://h vs ssh://h:22, IP vs hostname, local vs a runner
   *  aliasing localhost). Move uses this to never purge a volume it just
   *  moved onto the same daemon. Throws if the daemon can't be reached — the
   *  caller must treat "can't verify" as "don't do the destructive thing". */
  daemonId(): Promise<string>;

  /** Recent runtime output for the observability card. */
  logs(runtimeRef: string, lines: number): Promise<string>;

  /**
   * Snapshot the runtime's persistent state (the OpenClaw state dir) as a
   * gzipped tarball. The runtime should be stopped first for a consistent
   * snapshot — the orchestrator owns that dance, not the provider.
   */
  exportState(runtimeRef: string): Promise<Buffer>;

  /**
   * Restore a snapshot produced by exportState into the runtime's volume,
   * overwriting same-named files. Called between provision() and start() on
   * the import path, so the seeded skeleton is replaced by the real state.
   */
  importState(runtimeRef: string, data: Buffer): Promise<void>;

  /**
   * Restore a tarball into ONE agent's workspace directory, leaving the rest
   * of the runtime's state alone. Used to adopt an existing OpenClaw agent's
   * files (SOUL/MEMORY/AGENTS and everything else it has accumulated).
   */
  importWorkspace(runtimeRef: string, slug: string, data: Buffer): Promise<void>;
}

export interface RuntimeInfo {
  imageId?: string;
  openclawVersion?: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    /** Plain-English text safe to show a non-technical user (§11.3). */
    readonly userMessage: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }
}
