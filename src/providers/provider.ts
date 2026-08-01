/**
 * §7.4: the Provider interface is non-negotiable even though only one provider
 * is wired at launch. Everything the control plane knows about a runtime goes
 * through here — no provider-specific types leak into the orchestrator.
 */

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
  /**
   * Set when this spec re-provisions an existing runtime (rebuild, retry).
   * The provider MUST keep using the same underlying storage so the agent's
   * memory survives; the returned ref stays equal to this one.
   */
  previousRef?: string;
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
   * `claude setup-token` value for subscription auth without a mountable
   * ~/.claude (macOS hosts). Registered into OpenClaw's auth store at seed
   * time; models then ride the native anthropic provider.
   */
  setupToken?: string;
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
  };
}

export type RuntimeStatus =
  | { phase: 'absent' }
  | { phase: 'starting' }
  | { phase: 'running'; healthy: boolean }
  | { phase: 'stopped' }
  | { phase: 'error'; message: string };

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
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
  exec(runtimeRef: string, openclawArgv: string[]): Promise<ExecResult>;

  /**
   * Run a shell script inside the runtime. Escape hatch for the few state
   * surgeries OpenClaw's CLI has no verb for (e.g. removing a revoked member
   * from the pairing allowlist file). Prefer exec() whenever a CLI verb exists.
   */
  execShell(runtimeRef: string, script: string): Promise<ExecResult>;

  /** What this runtime is actually running (image identity, OpenClaw version). */
  info(runtimeRef: string): Promise<RuntimeInfo>;

  /**
   * What a runtime provisioned right now would run. Comparing this against
   * info() is how "update available" is detected — by image id, never by tag
   * (tags like :latest are reassigned in place).
   */
  currentImageInfo(): Promise<RuntimeInfo>;

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
