/**
 * One embedding service per machine, for every agent's semantic memory
 * search, instead of an engine baked into each agent (~290 MiB each;
 * docs/embedder-and-openclaw-port-design.md). Two containers:
 *
 *   agent ── POST /v1/embeddings (Bearer: its embed key) ──► embed door
 *                                                              │ keys, limits
 *                                                              ▼
 *                                              embedder (llama.cpp + EmbeddingGemma)
 *
 * Both sit on an internal docker network; only the door is published, on the
 * address agents reach this machine at. The door is its own process so the
 * control plane can restart (every deploy) without memory search pausing.
 * Hatchabot's part: the model file, the server's key, the door's key file
 * (one hash per live agent), and a health loop that restarts what fell over.
 *
 * Nothing uses the service until an agent is switched to it (step 2).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { RuntimeProvider } from '../providers/provider.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { Store } from '../store/store.js';

/** llama.cpp's server image, by digest (proven 2026-09-18 on arm64 and amd64). */
export const EMBEDDER_IMAGE = 'ghcr.io/ggml-org/llama.cpp:server@sha256:f26a6403915b6131b903717458aeeadd2527d2a6b8bf64bc9264bc6d16a40474';
/** The same EmbeddingGemma file the runtime images bake: 768-dimension vectors. */
export const EMBED_MODEL_FILE = 'embeddinggemma-300m-qat-Q8_0.gguf';
export const EMBED_MODEL_URL = 'https://huggingface.co/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/main/embeddinggemma-300m-qat-Q8_0.gguf';
export const EMBED_MODEL_SHA256 = '6fa0c02a9c302be6f977521d399b4de3a46310a4f2621ee0063747881b673f67';
/** Where the runtime image keeps its copy (docker/Dockerfile.runtime). */
export const EMBED_MODEL_IN_IMAGE = `/opt/agentclaw/models/${EMBED_MODEL_FILE}`;
export const EMBED_MODEL_ALIAS = 'embeddinggemma';
/** The server's own key: a machine secret, known to Hatchabot and the door. */
export const EMBEDDER_KEY_REF = 'embedder/key';

export interface EmbedderSpec {
  image: string;
  /** Host path of the model file, mounted read-only. */
  modelPath: string;
  modelAlias: string;
  /** The server's key (llama-server --api-key). */
  key: string;
  /** The door: the runtime image's node, this script, and where it listens. */
  doorImage: string;
  doorScript: string;
  doorPort: number;
  /** Host address the door is published on — where agents reach this machine. */
  doorBind: string;
  /** Host path of the keys file (sha256 → agent id), mounted read-only. */
  keysFile: string;
  /** Host path of the file holding the server's key (0600, beside keysFile). */
  serverKeyFile: string;
  perMin: number;
  /** Run the door as this user so it can read the 0600 keys file. */
  uid: number;
  gid: number;
}

export type ContainerState = 'running' | 'stopped' | 'absent';
export interface EmbedderStatus {
  embedder: ContainerState;
  door: ContainerState;
  /** `host:port` agents call, when the door is published. */
  doorAddress?: string;
}

export interface EmbedderServiceOpts {
  /** The local host's provider (lazily: hosts are resolved per request). */
  provider: () => RuntimeProvider;
  secrets: SecretStore;
  store: Store;
  dataDir: string;
  /** Today's runtime image — the model is copied out of it, so nothing downloads. */
  runtimeImage: string;
  doorScript: string;
  /** Where agents reach this machine (the docker bridge gateway; loopback on Docker Desktop). */
  doorBind: () => Promise<string>;
  log?: (event: string, detail: Record<string, unknown>) => void;
  /** Tests: the checksum of their stand-in model file. */
  modelSha256?: string;
  modelUrl?: string;
}

export interface EmbedderView extends EmbedderStatus {
  /** The owner turned it on; the health loop keeps it up. */
  enabled: boolean;
  modelPresent: boolean;
  /** An external server (HATCHABOT_EMBED_URL) is used instead of a container. */
  external?: string;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

export class EmbedderService {
  readonly #o: EmbedderServiceOpts;
  #busy: Promise<unknown> = Promise.resolve();
  constructor(opts: EmbedderServiceOpts) { this.#o = opts; }

  get dir(): string { return join(this.#o.dataDir, 'embed'); }
  get enabledFile(): string { return join(this.dir, 'enabled'); }
  get keysFile(): string { return join(this.dir, 'keys.json'); }
  /** The server's key: a file, never an argument (argv is world-readable in /proc). */
  get serverKeyFile(): string { return join(this.dir, 'server-key'); }
  get modelPath(): string { return join(this.#o.dataDir, 'models', EMBED_MODEL_FILE); }
  get external(): string | undefined { return process.env.HATCHABOT_EMBED_URL?.trim() || undefined; }
  get enabled(): boolean { return existsSync(this.enabledFile); }
  get doorPort(): number { return Number(process.env.HATCHABOT_EMBED_PORT) || 8093; }

  /** One operation at a time: a health tick must not race a Stop. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#busy.then(fn, fn);
    this.#busy = next.catch(() => {});
    return next;
  }

  async status(): Promise<EmbedderView> {
    const provider = this.#o.provider();
    const s = provider.embedderStatus ? await provider.embedderStatus().catch(() => ({ embedder: 'absent', door: 'absent' } as EmbedderStatus)) : { embedder: 'absent' as const, door: 'absent' as const };
    return { ...s, enabled: this.enabled, modelPresent: existsSync(this.modelPath), external: this.external };
  }

  /** The model file: out of the runtime image if possible, else downloaded — checked either way. */
  async ensureModel(): Promise<void> {
    const want = this.#o.modelSha256 ?? EMBED_MODEL_SHA256;
    const dest = this.modelPath;
    mkdirSync(join(dest, '..'), { recursive: true });
    if (existsSync(dest) && (await sha256File(dest)) === want) return;
    rmSync(dest, { force: true });
    const provider = this.#o.provider();
    if (provider.copyFromImage && (await provider.copyFromImage(this.#o.runtimeImage, EMBED_MODEL_IN_IMAGE, dest).catch(() => false))) {
      if ((await sha256File(dest)) === want) { this.#o.log?.('embedder.model_copied', { from: this.#o.runtimeImage }); return; }
      rmSync(dest, { force: true });
    }
    const url = this.#o.modelUrl ?? EMBED_MODEL_URL;
    this.#o.log?.('embedder.model_download', { url });
    const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`model download failed: ${res.status}`);
    const part = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
    const got = await sha256File(part);
    if (got !== want) { rmSync(part, { force: true }); throw new Error(`model checksum mismatch: ${got}`); }
    renameSync(part, dest);
  }

  /** The door's key file: every live agent's key hash. Rewritten whenever keys change. */
  syncKeys(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // Every agent that still exists: a STOPPED one cannot call, and must find
    // its key valid when started again without a rebuild (27th audit). Only
    // archive and delete retire a key (setAgentState drops the row).
    const gone = new Set(['ARCHIVED', 'DELETING', 'DELETED']);
    const keys: Record<string, string> = {};
    for (const t of this.#o.store.listEmbedTokens()) if (!gone.has(t.state)) keys[t.tokenHash] = t.agentId;
    const tmp = `${this.keysFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(keys), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.keysFile); // atomic: the door never reads a half-written file
  }

  async #key(): Promise<string> {
    try { return await this.#o.secrets.get(EMBEDDER_KEY_REF); } catch { /* first start */ }
    const key = randomBytes(24).toString('base64url');
    await this.#o.secrets.put(EMBEDDER_KEY_REF, key);
    return key;
  }

  async #spec(): Promise<EmbedderSpec> {
    const key = await this.#key();
    writeFileSync(this.serverKeyFile, `${key}\n`, { mode: 0o600 });
    chmodSync(this.serverKeyFile, 0o600);
    return {
      image: process.env.HATCHABOT_EMBEDDER_IMAGE?.trim() || EMBEDDER_IMAGE,
      modelPath: this.modelPath,
      modelAlias: EMBED_MODEL_ALIAS,
      key,
      serverKeyFile: this.serverKeyFile,
      doorImage: this.#o.runtimeImage,
      doorScript: this.#o.doorScript,
      doorPort: this.doorPort,
      doorBind: process.env.HATCHABOT_EMBED_BIND?.trim() || (await this.#o.doorBind()),
      keysFile: this.keysFile,
      perMin: Number(process.env.HATCHABOT_EMBED_PER_MIN) || 600,
      uid: typeof process.getuid === 'function' ? process.getuid() : 1000,
      gid: typeof process.getgid === 'function' ? process.getgid() : 1000,
    };
  }

  /**
   * Bring both containers up (idempotent) and remember that they should stay
   * up. `onlyIfEnabled` (the health loop): a Stop that landed meanwhile wins.
   */
  start(opts: { onlyIfEnabled?: boolean } = {}): Promise<EmbedderView> {
    return this.#serial(async () => {
      if (opts.onlyIfEnabled && !this.enabled) return this.status();
      if (this.external) throw new Error(`An external embedding server is configured (HATCHABOT_EMBED_URL=${this.external}); nothing to start here.`);
      const provider = this.#o.provider();
      if (!provider.ensureEmbedder) throw new Error('This host cannot run the embedding service.');
      await this.ensureModel();
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.syncKeys();
      const spec = await this.#spec();
      let s: EmbedderStatus;
      try {
        s = await provider.ensureEmbedder(spec);
      } catch (err) {
        // Half up is worse than down: nothing would manage what was left running.
        await provider.stopEmbedder?.().catch(() => {});
        throw err;
      }
      writeFileSync(this.enabledFile, `${new Date().toISOString()}\n`);
      this.#o.log?.('embedder.started', { door: s.doorAddress });
      return this.status();
    });
  }

  stop(): Promise<EmbedderView> {
    return this.#serial(async () => {
      rmSync(this.enabledFile, { force: true });
      await this.#o.provider().stopEmbedder?.();
      this.#o.log?.('embedder.stopped', {});
      return this.status();
    });
  }

  async restart(): Promise<EmbedderView> {
    await this.#serial(async () => { await this.#o.provider().stopEmbedder?.(); });
    return this.start();
  }

  /** The health loop: an enabled service that fell over comes back. */
  async healthTick(): Promise<'ok' | 'restarted' | 'off'> {
    if (!this.enabled || this.external) return 'off';
    const s = await this.status();
    if (s.embedder === 'running' && s.door === 'running') {
      this.syncKeys(); // retired keys (archive, delete) leave the file within a tick
      return 'ok';
    }
    this.#o.log?.('embedder.unhealthy', { embedder: s.embedder, door: s.door });
    await this.start({ onlyIfEnabled: true });
    return this.enabled ? 'restarted' : 'off';
  }
}

/** Which engine a NEW agent gets: the fleet default (HATCHABOT_EMBED_DEFAULT), baked unless the owner flipped it. */
export function embedDefault(env: NodeJS.ProcessEnv = process.env): 'baked' | 'shared' {
  return env.HATCHABOT_EMBED_DEFAULT?.trim() === 'shared' ? 'shared' : 'baked';
}

/** Tests and the store use the same hashing as the door. */
export function embedKeyHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function fileMode(path: string): number { return statSync(path).mode & 0o777; }
