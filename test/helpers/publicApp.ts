import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/store/store.js';
import { registerAuth, _resetLoginThrottle } from '../../src/api/auth.js';
import { hashPassword } from '../../src/api/accountsAuth.js';
import { registerRoutes } from '../../src/api/routes.js';
import { MockProvider } from '../../src/providers/mockProvider.js';
import { totp, base32Decode } from '../../src/api/totp.js';
import type { PublicProbes } from '../../src/api/publicAccess.js';

/**
 * A Hatchabot with its PUBLIC listener really open on a loopback port, for
 * tests of the public address (docs/public-access.md). `priv` talks to the
 * private side (inject, as every other test does); `pub` makes real HTTP
 * requests to the public listener the way tailscaled would, with the
 * visitor's address in X-Forwarded-For.
 */
export const PUBLIC_HOST = 'box.example.com';
export const PUBLIC_URL = `https://${PUBLIC_HOST}:8443`;

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}

const ENV_KEYS = ['HATCHABOT_PUBLIC_ACCESS', 'HATCHABOT_PUBLIC_PORT', 'HATCHABOT_PUBLIC_INVITED_ONLY', 'HATCHABOT_PUBLIC_ACCESS_URL', 'HATCHABOT_PUBLIC_URL',
  'HATCHABOT_PUBLIC_IDLE_MINUTES', 'HATCHABOT_PUBLIC_STEPUP_MINUTES', 'HATCHABOT_PUBLIC_REQS_PER_MIN', 'HATCHABOT_PUBLIC_REQS_PER_MIN_PER_ADDRESS',
  'HATCHABOT_PUBLIC_FAILS_CEILING', 'HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL', 'HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR', 'HATCHABOT_LOGIN_FAILS_PER_WINDOW', 'HATCHABOT_ALLOW_OWNER_HEADER', 'HATCHABOT_LOCAL_ACCOUNTS', 'HATCHABOT_ALLOWED_EMAILS',
  'HATCHABOT_MANAGED_BY', 'HATCHABOT_FUNNEL_PORT', 'HATCHABOT_PUBLIC_FUNNEL_PORT', 'HATCHABOT_ENV_FILE', 'HATCHABOT_TAILSCALE_BIN', 'PORT'];

export class Jar {
  cookies = new Map<string, string>();
  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim(), value = pair!.slice(eq + 1).trim();
      if (value === '' || /max-age=0\b/i.test(line) || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

export interface PublicAppOptions {
  mode?: 'accounts' | 'identity' | 'password';
  /** Register every route of the app (slower), not just sign-in. */
  fullRoutes?: boolean;
  env?: Record<string, string>;
  probes?: Partial<PublicProbes>;
  /** Leave public access off (the listener is not opened). */
  off?: boolean;
  verifier?: unknown;
  /** With fullRoutes: dependencies of the routes to replace (a secret store that answers, a stand-in for fetch). */
  routeDeps?: Record<string, unknown>;
  /** Add routes before the app is ready. */
  extra?: (app: FastifyInstance, store: Store) => void;
}

export interface PublicApp {
  app: FastifyInstance;
  store: Store;
  port: number;
  secret: Buffer;
  /** A request to the public listener. `from` is the visitor's address as tailscaled reports it. */
  pub(path: string, init?: { method?: string; body?: unknown; jar?: Jar; headers?: Record<string, string>; from?: string }): Promise<{ status: number; json: any; res: Response }>;
  /** An owner account with a password (and, unless told otherwise, an authenticator app). */
  addAccount(username: string, opts?: { owner?: boolean; totp?: boolean; password?: string }): Promise<{ id: string; totpSecret?: Buffer; password: string }>;
  /** Sign in at the public address; with `code` also give the second factor. */
  signIn(username: string, password: string, opts?: { totpSecret?: Buffer; from?: string; headers?: Record<string, string> }): Promise<Jar>;
  close(): Promise<void>;
}

export async function publicApp(opts: PublicAppOptions = {}): Promise<PublicApp> {
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const port = await freePort();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    HATCHABOT_PUBLIC_PORT: String(port),
    HATCHABOT_PUBLIC_INVITED_ONLY: '1',
    HATCHABOT_PUBLIC_ACCESS_URL: PUBLIC_URL,
    ...(opts.off ? {} : { HATCHABOT_PUBLIC_ACCESS: 'funnel' }),
    ...(opts.env ?? {}),
  });
  for (const [k, v] of Object.entries(opts.env ?? {})) if (v === '') delete process.env[k];
  _resetLoginThrottle();
  const mode = opts.mode ?? 'accounts';
  const secret = Buffer.alloc(32, 9);
  const store = new Store(new Database(':memory:'));
  const app = Fastify();
  await registerAuth(app, {
    password: mode === 'password' ? 'shared-pw' : undefined, secret, mode, store, verifier: opts.verifier as never,
    cliTokenOwner: (t) => store.ownerForCliToken(t), cliTokenScope: (t) => store.cliTokenScope(t),
  });
  if (opts.fullRoutes) {
    await registerRoutes(app, {
      store, secrets: { put: async () => {}, get: async () => '', delete: async () => {} } as never,
      providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never,
      authMode: mode,
      ...(opts.routeDeps ?? {}),
    } as never);
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<html>app</html>'));
    app.get('/v1/config', async () => ({ authMode: mode }));
    app.get('/v1/agents', async (req) => ({ me: req.principal?.ownerId }));
    app.get('/v1/hosts', async () => []);
    app.post('/v1/hosts', async () => ({ created: true }));
    app.post('/v1/cli-tokens', async (req) => ({ minted: req.principal?.ownerId }));
    app.get('/v1/unclassified-thing', async () => ({ leaked: true }));
    app.post('/v1/agents/:id/message', async () => ({ leaked: true }));
  }
  opts.extra?.(app, store);
  app.publicAccess!.setProbes({
    autoUpgrade: async () => ({ ok: true }),
    // With a tailscale shim named, Funnel's target is read from the shim (reachRoutes.ts); otherwise it is "not on the private port".
    ...(opts.fullRoutes && process.env.HATCHABOT_TAILSCALE_BIN ? {} : { funnelOnPrivatePort: async () => false }),
    ...(opts.probes ?? {}),
  });
  await app.ready();

  const addAccount: PublicApp['addAccount'] = async (username, o = {}) => {
    const password = o.password ?? `pw-${username}-long-enough`;
    const { hash, salt } = await hashPassword(password);
    const id = `acct-${randomUUID()}`;
    store.insertLocalAccount({ id, username, pwHash: hash, pwSalt: salt, hostOwner: !!o.owner, disabled: false, createdAt: new Date().toISOString() });
    if (o.owner && !store.localHostId()) store.insertHost({ id: 'host-local', ownerId: id, kind: 'local', provider: 'mock', name: 'This machine', settings: {}, createdAt: 'now' });
    let totpSecret: Buffer | undefined;
    if (o.totp ?? o.owner) {
      // Enrol through the real routes, at the private address.
      const login = await app.inject({ method: 'POST', url: '/v1/login', payload: { username, password } });
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const start = await app.inject({ method: 'POST', url: '/v1/second-factor/totp', headers: { cookie }, payload: { current: password } });
      const body = start.json() as { id: string; secret: string };
      totpSecret = base32Decode(body.secret);
      const confirm = await app.inject({ method: 'POST', url: '/v1/second-factor/totp/confirm', headers: { cookie }, payload: { id: body.id, code: totp(totpSecret) } });
      if (confirm.statusCode !== 200) throw new Error(`totp enrol failed: ${confirm.body}`);
    }
    return { id, totpSecret, password };
  };

  if (!opts.off) await app.publicAccess!.syncListener();

  const pub: PublicApp['pub'] = async (path, init = {}) => {
    const headers: Record<string, string> = {
      'x-forwarded-for': init.from ?? '203.0.113.7',
      'x-forwarded-host': `${PUBLIC_HOST}:8443`,
      'x-forwarded-proto': 'https',
      'tailscale-funnel-request': '?1',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.jar && init.jar.cookies.size ? { cookie: init.jar.header() } : {}),
      ...(init.headers ?? {}),
    };
    for (const [k, v] of Object.entries(headers)) if (v === '') delete headers[k];
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined, redirect: 'manual',
    });
    init.jar?.take(res);
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, res };
  };

  const signIn: PublicApp['signIn'] = async (username, password, o = {}) => {
    const jar = new Jar();
    const r = await pub('/v1/login', { body: { username, password }, jar, from: o.from, headers: o.headers });
    if (r.status !== 200) throw new Error(`public sign-in failed: ${r.status} ${JSON.stringify(r.json)}`);
    if (o.totpSecret) {
      // A code is good once: wait for a step this secret has not used yet.
      const v = await pub('/v1/second-factor/verify', { body: { code: totp(o.totpSecret, Date.now() + 30_000) }, jar, from: o.from });
      if (v.status !== 200) throw new Error(`second factor failed: ${v.status} ${JSON.stringify(v.json)}`);
    }
    return jar;
  };

  return {
    app, store, port, secret, pub, addAccount, signIn,
    close: async () => {
      await app.close();
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      _resetLoginThrottle();
    },
  };
}
