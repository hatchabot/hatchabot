import type {
  ExecResult,
  RuntimeInfo,
  RuntimeProvider,
  RuntimeSpec,
  RuntimeStatus,
} from './provider.js';
import { ProviderError } from './provider.js';
import type { CompressedSwap } from '../orchestrator/swap.js';
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
    if (spec.memory) {
      const b = (v: string | undefined) => { const m = /^(\d+(?:\.\d+)?)([mg])$/.exec(v ?? ''); return m ? Math.round(Number(m[1]) * (m[2] === 'g' ? 1024 ** 3 : 1024 ** 2)) : 0; };
      const mem = b(spec.memory), sw = spec.memorySwap && this.swapState.compressed ? Math.min(b(spec.memorySwap), mem) : 0;
      this.dockerLimits.set(`mock://${spec.agentId}`, { memory: mem, memorySwap: mem + sw });
      this.cgroupLimits.delete(`mock://${spec.agentId}`);
    }
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

  /**
   * What the usage reader (orchestrator/usage.ts) finds in each container's
   * transcripts, keyed by runtimeRef ('*' for any): tests set per-call usage
   * here. A value that is an ExecResult is answered as-is (a failed read).
   */
  usage = new Map<string, unknown>();
  /**
   * What each web chat session holds (orchestrator/webChat.ts), keyed by the
   * store key agent:<slug>:web:<hex>: the messages the history reader would
   * print, raw (prefix and all). An ExecResult answers as-is (a failed read).
   */
  webChatSessions = new Map<string, unknown>();
  #webChatRead(script: string): ExecResult | undefined {
    if (!script.includes('/tmp/hatchabot-webchat-')) return undefined;
    const key = /SKEY='([^']*)'/.exec(script)?.[1] ?? '';
    this.execLog.push(['webchat-history', key]);
    const v = this.webChatSessions.get(key);
    if (v && typeof v === 'object' && 'code' in (v as object)) return v as ExecResult;
    return { code: 0, stdout: JSON.stringify({ messages: v ?? [] }), stderr: '' };
  }
  /**
   * Web chat turns (orchestrator/webChat.ts turnScript): each request as the
   * in-container client would get it, in order — and what it answers:
   * `webChatReply` (an ExecResult as-is, or a function of the request),
   * else the reply "ok".
   */
  webChatTurns: Array<{ agentId: string; sessionKey: string; message: string; rights: string; scopes: string[]; timeoutMs: number }> = [];
  webChatReply: ExecResult | ((req: MockProvider['webChatTurns'][number]) => ExecResult | Promise<ExecResult>) | undefined;
  webChatTurnOpts: Array<{ timeoutMs?: number } | undefined> = [];
  async #webChatTurn(script: string, opts?: { timeoutMs?: number }): Promise<ExecResult | undefined> {
    if (!script.includes('/tmp/hatchabot-webturn-')) return undefined;
    const r64 = /REQ='([A-Za-z0-9+/=]*)'/.exec(script)?.[1] ?? '';
    const req = JSON.parse(Buffer.from(r64, 'base64').toString('utf8')) as MockProvider['webChatTurns'][number];
    this.webChatTurns.push(req);
    this.webChatTurnOpts.push(opts);
    const r = this.webChatReply;
    if (typeof r === 'function') return r(req);
    return r ?? { code: 0, stdout: 'ok', stderr: '' };
  }
  /** Scripts sent with `secret` (over stdin in the real provider), in order. */
  secretShells: string[] = [];
  async execShell(runtimeRef: string, script: string, opts?: { timeoutMs?: number; secret?: boolean }): Promise<ExecResult> {
    this.#require(runtimeRef);
    if (opts?.secret) this.secretShells.push(script);
    const chat = this.#webChatRead(script);
    if (chat) return chat;
    const turn = await this.#webChatTurn(script, opts);
    if (turn) return turn;
    if (script.startsWith('node -e "$(echo ') && script.includes('| base64 -d)"')) {
      const u = this.usage.get(runtimeRef) ?? this.usage.get('*');
      this.execLog.push(['usage-read', runtimeRef]);
      if (u && typeof u === 'object' && 'code' in (u as object)) return u as ExecResult;
      return { code: 0, stdout: JSON.stringify(u ?? { models: {}, sessions: 0, first: 0, last: 0 }), stderr: '' };
    }
    this.execLog.push(['sh', script]);
    return this.execResponses.get('sh') ?? { code: 0, stdout: '', stderr: '' };
  }

  async execShellOnVolume(runtimeRef: string, script: string, _opts?: { readOnly?: boolean }): Promise<ExecResult> {
    this.#require(runtimeRef);
    const chat = this.#webChatRead(script);
    if (chat) return chat;
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
  /** Live cap changes, as docker update would see them. */
  /** `swap` is the allowance docker would actually get: withheld (absent) when the host has no compressed swap. */
  memoryUpdates: Array<{ runtimeRef: string; cap: string; swap?: string }> = [];
  async updateMemory(runtimeRef: string, cap: string, swap: string | undefined): Promise<void> {
    this.#require(runtimeRef);
    const given = swap && this.swapState.compressed ? swap : undefined;
    this.memoryUpdates.push(given ? { runtimeRef, cap, swap: given } : { runtimeRef, cap });
    // What docker update does: its record and the cgroup both take the new values.
    const b = (v: string) => { const m = /^(\d+(?:\.\d+)?)([mg])$/.exec(v); return m ? Math.round(Number(m[1]) * (m[2] === 'g' ? 1024 ** 3 : 1024 ** 2)) : 0; };
    const mem = b(cap), sw = given ? Math.min(b(given), mem) : 0;
    this.dockerLimits.set(runtimeRef, { memory: mem, memorySwap: mem + sw });
    if (!this.cgroupStuck.has(runtimeRef)) this.cgroupLimits.set(runtimeRef, { memoryMax: mem, swapMax: sw });
  }
  /** docker's record per runtime (set by provision and updateMemory; tests may set it). */
  dockerLimits = new Map<string, { memory: number; memorySwap: number }>();
  /** The cgroup's own values per runtime; tests set them to model a systemd reload (swapMax null = "max"). */
  cgroupLimits = new Map<string, { memoryMax: number | null; swapMax: number | null }>();
  /** Runtimes whose cgroup a docker update does not fix (to model a reassert that fails). */
  cgroupStuck = new Set<string>();
  /** Every memoryLimitsLive call's refs, in order (tests). */
  liveReads: string[][] = [];
  async memoryLimitsLive(runtimeRefs: string[]) {
    this.liveReads.push([...runtimeRefs]);
    const out = new Map<string, import('./provider.js').LiveMemoryLimits>();
    for (const ref of runtimeRefs) {
      const rt = this.runtimes.get(ref);
      if (!rt || rt.purged) continue;
      const d = this.dockerLimits.get(ref) ?? { memory: 3 * 1024 ** 3, memorySwap: 3 * 1024 ** 3 };
      const c = this.cgroupLimits.get(ref);
      out.set(ref, { running: rt.phase === 'running', dockerMemory: d.memory, dockerMemorySwap: d.memorySwap, ...(c ? { cgroup: c } : {}) });
    }
    return out;
  }
  /** What the host's swap looks like (tests set it); no swap by default. */
  swapState: CompressedSwap = { kind: 'none', compressed: false, why: 'This machine has no swap: agents get none until zswap (with a swap file) or zram is on.', swapDevices: [] };
  swapProbes = 0;
  async compressedSwap(): Promise<CompressedSwap> { this.swapProbes++; return this.swapState; }

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
  /** How the mock image says channel plugins are installed (label plugin-install). */
  imagePluginInstall: 'link' | 'npm' = 'link';
  /** What the mock image claims to run; tests set a 2026.8+ version to see the port paths. */
  imageOpenclawVersion = 'mock';
  async currentImageInfo(image?: string): Promise<RuntimeInfo> {
    // A named tag answers with that tag's id from `tags` (tests set them); the default answers 'mock-image'.
    const known = image ? this.tags.find((t) => t.tag === image) : this.tags.find((t) => t.tag === 'hatchabot-runtime:latest');
    return { imageId: known?.imageId ?? 'mock-image', openclawVersion: known?.openclawVersion ?? this.imageOpenclawVersion, channels: this.imageChannels, embedEngine: this.imageEmbedEngine, plugins: this.imagePlugins, pluginInstall: this.imagePluginInstall };
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
  /** Each agent's browser, as tests see it: agent container → running. */
  browsers = new Map<string, boolean>();
  browserSpecs: Array<import('../orchestrator/browser.js').BrowserSpec> = [];
  async ensureBrowser(spec: import('../orchestrator/browser.js').BrowserSpec) {
    this.browserSpecs.push(spec);
    if (this.browsers.get(spec.agentContainer)) return 'running' as const;
    this.browsers.set(spec.agentContainer, true);
    return 'started' as const;
  }
  async stopBrowser(agentContainer: string) { this.browsers.delete(agentContainer); }
  async listBrowsers() { return [...this.browsers].map(([agentContainer, running]) => ({ name: `${agentContainer}-browser`, agentContainer, running })); }
  /** A runner's key-file copies: the keys file's contents at each copy. */
  pushedKeys: string[] = [];
  async pushEmbedKeys(files: import('../embedder/embedder.js').EmbedKeyFiles) {
    const { readFileSync } = await import('node:fs');
    this.pushedKeys.push(readFileSync(files.keysFile, 'utf8'));
  }
  /** Tests: a runner asleep. */
  awake = true;
  async reachable() { return this.awake; }
  /** Tests: a Stop docker refuses (a hung daemon). */
  failStopEmbedder = false;
  async stopEmbedder() {
    if (this.failStopEmbedder) throw new Error('mock: docker would not stop the service');
    this.embedder = { embedder: 'absent', door: 'absent' };
  }
  /** What docker stats would say about the engine (tests set it). */
  embedderStatsRow: import('./provider.js').ContainerStats | undefined = undefined;
  async embedderStats() { return this.embedderStatsRow; }
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
