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
  /**
   * Run with no route to anywhere but this host: no internet, no DNS, no other
   * containers, and no published ports (the management agent's jail).
   */
  isolated?: boolean;
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
  /** The agent's Hatchabot name. OpenClaw otherwise shows the slug, so the
   *  console named every agent something the owner never called it. */
  displayName?: string;
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
  provider?: 'anthropic' | 'google' | 'openai' | 'ollama';
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
  /**
   * Semantic memory search through the machine's embedding service instead of
   * the engine baked into the image (src/embedder). Absent = baked, as today.
   */
  embed?: { baseUrl: string; token: string; model: string };
  /** The image's OpenClaw version: which config keys memory search lives under. */
  openclawVersion?: string;
  /** The management agent: lock its tools down to Hatchabot's tool server
   *  (an HTTP MCP server reached with its propose-only key) plus its memory. */
  ops?: { mcpUrl: string; token: string };
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
    /** Reach Telegram through this HTTP proxy (the management agent's jail). */
    proxy?: string;
  };
  /**
   * Messaging plugins the image carries (label org.hatchabot.channels). Slack
   * and Discord config is written only for these — agents on an image without
   * them get exactly the commands they always did.
   */
  channelPlugins?: string[];
  slack?: {
    botToken: string;
    appToken: string;
    allowFrom: string[];
    rooms: ChannelRooms;
  };
  discord?: {
    token: string;
    applicationId: string;
    allowFrom: string[];
    rooms: ChannelRooms;
    /** Reach Discord through this HTTP proxy (the management agent's jail). */
    proxy?: string;
  };
}

/** Where a Slack or Discord agent answers besides DMs: nowhere, or one room (members only, @mention). */
export type ChannelRooms = { mode: 'off' } | { mode: 'room'; roomId: string };

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
  /** The default image, or the named one (an agent's pinned image). */
  currentImageInfo(image?: string): Promise<RuntimeInfo>;

  /** Every tag of the runtime image repo on this daemon (candidates, versions, derived). */
  listImageTags(): Promise<{ tag: string; imageId: string; createdAt?: string; size?: string; openclawVersion?: string; channels?: string[]; extraPackages?: string[] }[]>;

  /** The isolated network's gateway address on this host (created on first
   *  use). Absent on providers without the concept (mock). */
  /**
   * Put a management agent's jail in place and return how it is reached
   * (src/ops/doorman.ts). One jailed network per management agent, with a
   * doorman container as its only neighbour: that works the same on Linux and
   * on Docker Desktop, where the host cannot listen on a Docker address.
   */
  ensureOpsJail?(opts: {
    agentId: string;
    /** The agent's slug (and ref, once it has one): the doorman forwards the console to it. */
    slug: string;
    runtimeRef?: string;
    /** The port Hatchabot's door listens on (reached at Docker's host alias). */
    opsPort: number;
    /** Host port the console is published on (the agent's usual gateway port). */
    consolePort: number;
  }): Promise<{ network: string; doorHost: string; doorPort: number }>;
  /** Take a management agent's jail down: the doorman and the network. */
  removeOpsJail?(agentId: string): Promise<void>;
  /** The addresses this agent's doorman holds — the only peers the door may
   *  accept. Empty when there is no doorman (or it is not running). */
  doormanAddresses?(agentId: string): Promise<string[]>;
  /** The address a container reaches this machine on, if the host can bind it
   *  (Linux: the docker bridge's gateway; Docker Desktop: nothing bindable). */
  hostGatewayAddress?(): Promise<string | undefined>;
  /** A running container's address on its network, for host→container calls
   *  where no port is published (isolated runtimes). */
  containerIp?(runtimeRef: string): Promise<string | undefined>;
  /**
   * Where THIS machine can reach a port an agent published on its host's
   * loopback. Local: that port. A runner over SSH: a tunnel to it. Undefined
   * when there is no way through (a tcp:// runner).
   */
  gatewayEndpoint?(port: number): Promise<{ host: string; port: number } | undefined>;
  /**
   * Make sure a plain base runtime image (`<repo>:<openclaw version>`) is on
   * this host's daemon, pulling the published multi-arch one if it is not.
   * True when it is there afterwards.
   */
  ensureBaseImage?(tag: string): Promise<boolean>;
  /** Copy one file out of an image (docker create + cp). False when the image or path is missing. */
  copyFromImage?(image: string, srcPath: string, destPath: string): Promise<boolean>;
  /** The machine's embedding service (src/embedder): bring both containers up, idempotently. */
  ensureEmbedder?(spec: import('../embedder/embedder.js').EmbedderSpec): Promise<import('../embedder/embedder.js').EmbedderStatus>;
  embedderStatus?(): Promise<import('../embedder/embedder.js').EmbedderStatus>;
  stopEmbedder?(): Promise<void>;
  /** Build `tag` from a Dockerfile on THIS host's daemon (a runner's, over its connection). */
  buildImage?(tag: string, dockerfile: string, labels: Record<string, string>): Promise<{ ok: boolean; error?: string }>;

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
  /** Live CPU and memory of every Hatchabot container on this daemon (docker stats). */
  stats?(): Promise<ContainerStats[]>;

  /** Only the model-call lines ("[model-fetch] response …") logged since `sinceIso`, each prefixed with its timestamp. */
  modelCallLog(runtimeRef: string, sinceIso: string): Promise<string>;

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

export interface ContainerStats {
  /** The container name (an agent's runtimeRef is `docker://<name>`). */
  name: string;
  /** Percent of one core, e.g. 12.5. */
  cpuPct: number;
  memBytes: number;
  memLimitBytes: number;
  pids: number;
}

/** "629.1MiB", "1GiB", "2.5GB", "512kB" → bytes. */
export function parseByteSize(s: string): number {
  const m = /^\s*([\d.]+)\s*([kKMGT]?i?B?)\s*$/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase();
  const scale: Record<string, number> = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: 1024 ** 3, tb: 1e12, tib: 1024 ** 4 };
  return Math.round(n * (scale[u] ?? (u === '' ? 1 : 0)));
}

export interface RuntimeInfo {
  imageId?: string;
  openclawVersion?: string;
  /** Messaging plugins baked into the image (label org.hatchabot.channels), e.g. ['slack', 'discord']. */
  channels?: string[];
  /** System packages this image carries beyond the standard list. */
  extraPackages?: string[];
  /** A container's: the setup generation it was made at (label hatchabot.gen; absent = 0). */
  containerGen?: number;
  /** A container's: on the isolated agents network (false = still on a shared one;
   *  absent = not applicable — the Hatchabot agent's own network, or isolation turned off). */
  onAgentNetwork?: boolean;
}

/** Parse the org.hatchabot.channels label: a comma list, empty when absent. */
export function parseChannelsLabel(v: string | undefined): string[] {
  return (v ?? '').split(',').map((x) => x.trim()).filter((x) => /^[a-z]+$/.test(x));
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
