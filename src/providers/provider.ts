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
  model?: string;
  telegram?: {
    accountId: string;
    botToken: string;
    /** Telegram user ids permitted to DM this bot (§12.4). */
    allowFrom: string[];
  };
}

export type RuntimeStatus =
  | { phase: 'absent' }
  | { phase: 'starting' }
  | { phase: 'running'; healthy: boolean }
  | { phase: 'stopped' }
  | { phase: 'error'; message: string };

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
