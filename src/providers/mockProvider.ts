import type {
  ExecResult,
  RuntimeInfo,
  RuntimeProvider,
  RuntimeSpec,
  RuntimeStatus,
} from './provider.js';
import { ProviderError } from './provider.js';

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
    } = {},
  ) {}

  #healthChecks = 0;

  async provision(spec: RuntimeSpec): Promise<{ runtimeRef: string }> {
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

  async exec(runtimeRef: string, openclawArgv: string[]): Promise<ExecResult> {
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

  async info(): Promise<RuntimeInfo> {
    return { imageId: 'mock-image', openclawVersion: 'mock' };
  }

  async currentImageInfo(): Promise<RuntimeInfo> {
    return { imageId: 'mock-image', openclawVersion: 'mock' };
  }

  async logs(): Promise<string> {
    return '';
  }

  #require(runtimeRef: string): MockRuntime {
    const rt = this.runtimes.get(runtimeRef);
    if (!rt || rt.purged) {
      throw new ProviderError(`unknown runtime ${runtimeRef}`, 'That agent is no longer available.');
    }
    return rt;
  }
}
