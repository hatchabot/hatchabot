import type {
  ExecResult,
  RuntimeInfo,
  RuntimeProvider,
  RuntimeSpec,
  RuntimeStatus,
} from './provider.js';
import { ProviderError } from './provider.js';
import { Readable } from 'node:stream';

interface MockRuntime {
  spec: RuntimeSpec;
  phase: 'stopped' | 'running';
  purged: boolean;
}

/**
 * In-memory provider used to exercise the full tap-+ → first-reply loop with
 * zero cloud cost. It is also where we test failure handling: set
 * `failOn` to make a step throw and watch the orchestrator roll back (§11.3).
 */
export class MockProvider implements RuntimeProvider {
  readonly key = 'mock';
  readonly runtimes = new Map<string, MockRuntime>();
  /** Programmable responses for exec(), keyed by the joined argv prefix. */
  readonly execResponses = new Map<string, ExecResult>();
  readonly execLog: string[][] = [];

  constructor(
    private readonly opts: {
      failOn?: 'provision' | 'start';
      /** Number of status() calls before the runtime reports healthy. */
      healthyAfter?: number;
      /** Daemon identity — two instances sharing a value model one daemon
       *  reached two ways (the move aliased-daemon case). Defaults unique. */
      daemonId?: string;
    } = {},
  ) {}

  #daemonId?: string;
  async daemonId(): Promise<string> {
    // Unique per instance unless the test pins one (the same-daemon case).
    return (this.#daemonId ??=
      this.opts.daemonId ?? `mock-daemon-${Math.random().toString(36).slice(2)}`);
  }

  #healthChecks = 0;

  /** The most recent spec provisioned — lets tests assert what docker would see. */
  lastSpec?: RuntimeSpec;

  async provision(spec: RuntimeSpec): Promise<{ runtimeRef: string }> {
    this.lastSpec = spec;
    if (this.opts.failOn === 'provision') {
      throw new ProviderError(
        'mock provision failure',
        "Couldn't reach your cloud account — reconnect?",
      );
    }
    // Idempotent: the ref is derived from the agent id, so a retry after a
    // partial failure reuses the same runtime instead of orphaning one.
    const runtimeRef = `mock://${spec.agentId}`;
    const existing = this.runtimes.get(runtimeRef);
    if (existing && !existing.purged) {
      existing.spec = spec;
      return { runtimeRef };
    }
    this.runtimes.set(runtimeRef, { spec, phase: 'stopped', purged: false });
    return { runtimeRef };
  }

  async start(runtimeRef: string): Promise<void> {
    if (this.opts.failOn === 'start') {
      throw new ProviderError('mock start failure', 'The agent could not start. Try again?');
    }
    const rt = this.#require(runtimeRef);
    rt.phase = 'running';
  }

  async stop(runtimeRef: string): Promise<void> {
    this.#require(runtimeRef).phase = 'stopped';
  }

  async destroy(runtimeRef: string, opts?: { purge?: boolean }): Promise<void> {
    const rt = this.runtimes.get(runtimeRef);
    if (!rt) return; // destroy is idempotent — nothing to do
    rt.phase = 'stopped';
    if (opts?.purge) rt.purged = true;
  }

  async status(runtimeRef: string): Promise<RuntimeStatus> {
    const rt = this.runtimes.get(runtimeRef);
    if (!rt || rt.purged) return { phase: 'absent' };
    if (rt.phase === 'stopped') return { phase: 'stopped' };
    const threshold = this.opts.healthyAfter ?? 0;
    const healthy = this.#healthChecks++ >= threshold;
    return { phase: 'running', healthy };
  }

  /** Per-call exec options seen, in order (tests assert the timeouts long turns ask for). */
  execOpts: Array<{ timeoutMs?: number } | undefined> = [];
  async exec(runtimeRef: string, openclawArgv: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    this.execOpts.push(opts);
    this.#require(runtimeRef);
    this.execLog.push(openclawArgv);
    // Longest-prefix match lets tests program `pairing list` and
    // `pairing approve` independently.
    for (let n = openclawArgv.length; n > 0; n--) {
      const key = openclawArgv.slice(0, n).join(' ');
      const canned = this.execResponses.get(key);
      if (canned) return canned;
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  async execShell(runtimeRef: string, script: string): Promise<ExecResult> {
    this.#require(runtimeRef);
    this.execLog.push(['sh', script]);
    return this.execResponses.get('sh') ?? { code: 0, stdout: '', stderr: '' };
  }

  async execShellOnVolume(runtimeRef: string, script: string, _opts?: { readOnly?: boolean }): Promise<ExecResult> {
    this.#require(runtimeRef);
    this.execLog.push(['sh-volume', script]);
    return this.execResponses.get('sh-volume') ?? { code: 0, stdout: '', stderr: '' };
  }

  /** What a volume stream would carry (tests set it); the argv is logged like a shell. */
  streamBytes: Buffer | undefined = undefined;
  streamFromVolume(runtimeRef: string, argv: string[]) {
    this.#require(runtimeRef);
    this.execLog.push(['stream', argv.join(' ')]);
    return Readable.from(this.streamBytes ? [this.streamBytes] : []);
  }

  /** Uploads as the mock saw them: the argv and the bytes; `writeFails` = the exit code to answer. */
  written: Array<{ argv: string[]; bytes: Buffer }> = [];
  writeFails = 0;
  async writeToVolume(runtimeRef: string, argv: string[], input: Buffer) {
    this.#require(runtimeRef);
    this.written.push({ argv, bytes: input });
    return { code: this.writeFails, stdout: '', stderr: this.writeFails ? 'refused' : '' };
  }

  /** Per-runtime overrides of what info() reports (containerGen, onAgentNetwork…). */
  infoOverride = new Map<string, Partial<RuntimeInfo>>();
  async info(runtimeRef?: string): Promise<RuntimeInfo> {
    return { imageId: 'mock-image', openclawVersion: 'mock', ...(runtimeRef ? this.infoOverride.get(runtimeRef) : {}) };
  }

  /** What the mock image claims to carry; tests narrow it to check the "image lacks it" path. */
  imageChannels: string[] = ['slack', 'discord'];
  /** What the mock image says about its memory search engine (label embed-engine). */
  imageEmbedEngine: 'baked' | 'none' = 'baked';
  /** Other plugins the mock image bakes (label org.hatchabot.plugins). */
  imagePlugins: string[] = [];
  /** What the mock image claims to run; tests set a 2026.8+ version to see the port paths. */
  imageOpenclawVersion = 'mock';
  async currentImageInfo(_image?: string): Promise<RuntimeInfo> {
    return { imageId: 'mock-image', openclawVersion: this.imageOpenclawVersion, channels: this.imageChannels, embedEngine: this.imageEmbedEngine, plugins: this.imagePlugins };
  }

  tags: { tag: string; imageId: string; createdAt?: string; size?: string; openclawVersion?: string; channels?: string[]; extraPackages?: string[]; embedEngine?: 'baked' | 'none' }[] = [{ tag: 'hatchabot-runtime:latest', imageId: 'mock-image' }];
  /** Plain base tags a pull would find in the published registry. */
  publishedBases = new Set<string>();
  pulled: string[] = [];
  built: Array<{ tag: string; dockerfile: string; labels: Record<string, string> }> = [];
  buildFails = false;
  async ensureBaseImage(tag: string): Promise<boolean> {
    if (this.tags.some((t) => t.tag === tag)) return true;
    if (!this.publishedBases.has(tag)) return false;
    this.pulled.push(tag);
    this.tags.push({ tag, imageId: `pulled-${tag}` });
    return true;
  }
  async buildImage(tag: string, dockerfile: string, labels: Record<string, string>) {
    if (this.buildFails) return { ok: false, error: 'E: Unable to locate package' };
    this.built.push({ tag, dockerfile, labels });
    this.tags.push({ tag, imageId: `built-${tag}` });
    return { ok: true };
  }
  tagged: [string, string][] = [];
  async listImageTags() { return this.tags; }
  /** What docker stats would say; tests set it. */
  statsRows: import('./provider.js').ContainerStats[] = [];
  async stats() { return this.statsRows; }

  /** The embedding service, as tests see it: a status the test can set, and what start/stop did. */
  embedder: { embedder: 'running' | 'stopped' | 'absent'; door: 'running' | 'stopped' | 'absent'; doorAddress?: string } = { embedder: 'absent', door: 'absent' };
  embedderSpecs: Array<import('../embedder/embedder.js').EmbedderSpec> = [];
  copyFromImageWorks = false;
  async copyFromImage(_image: string, _src: string, dest: string) {
    if (!this.copyFromImageWorks) return false;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(dest, 'copied-model');
    return true;
  }
  async ensureEmbedder(spec: import('../embedder/embedder.js').EmbedderSpec) {
    this.embedderSpecs.push(spec);
    this.embedder = { embedder: 'running', door: 'running', doorAddress: `${spec.doorBind}:${spec.doorPort}` };
    return this.embedder;
  }
  async embedderStatus() { return this.embedder; }
  async stopEmbedder() { this.embedder = { embedder: 'absent', door: 'absent' }; }
  async tagImage(from: string, to: string) { this.tagged.push([from, to]); }
  removed: string[] = [];
  async imageHistory() { return [{ step: 'RUN npm i -g openclaw@mock', size: '100MB' }]; }
  async removeImageTag(ref: string) { this.removed.push(ref); this.tags = this.tags.filter((t) => t.tag !== ref); }

  modelCallLines = '';
  async modelCallLog(): Promise<string> { return this.modelCallLines; }

  async logs(): Promise<string> {
    return '';
  }

  /** In-memory "volumes" so transfer round-trips are testable. */
  readonly stateStore = new Map<string, Buffer>();

  async exportState(runtimeRef: string): Promise<Buffer> {
    this.#require(runtimeRef);
    return this.stateStore.get(runtimeRef) ?? Buffer.from('mock-state');
  }

  async importState(runtimeRef: string, data: Buffer): Promise<void> {
    this.#require(runtimeRef);
    this.stateStore.set(runtimeRef, data);
  }

  readonly workspaceStore = new Map<string, Buffer>();

  async importWorkspace(runtimeRef: string, slug: string, data: Buffer): Promise<void> {
    this.#require(runtimeRef);
    this.workspaceStore.set(`${runtimeRef}:${slug}`, data);
  }

  #require(runtimeRef: string): MockRuntime {
    const rt = this.runtimes.get(runtimeRef);
    if (!rt || rt.purged) {
      throw new ProviderError(`unknown runtime ${runtimeRef}`, 'That agent is no longer available.');
    }
    return rt;
  }
}
