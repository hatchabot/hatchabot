import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { registerAuth } from '../src/api/auth.js';
import { PUBLIC_RULES, publicClassFor, publicClassTable, publicRuleFor, type PublicClass } from '../src/api/publicRoutes.js';

/**
 * The sweep: every route the app registers, in every sign-in mode, has a
 * class at the public address that somebody chose. A route added later with
 * no rule fails here (and is refused at the public address meanwhile).
 */
const routes = new Set<string>();
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hb-routes-'));
  const keyFile = join(dir, 'signin.pub');
  writeFileSync(keyFile, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
  const saved = { ...process.env };
  process.env.HATCHABOT_LOCAL_ACCOUNTS = '1';
  process.env.HATCHABOT_SIGNIN_KEY_FILE = keyFile;
  process.env.HATCHABOT_PUBLIC_URL = 'https://box.example.com';
  try {
    for (const mode of ['accounts', 'identity', 'password'] as const) {
      const store = new Store(new Database(':memory:'));
      const app = Fastify();
      app.addHook('onRoute', (r) => { for (const m of [r.method].flat()) routes.add(`${m} ${r.url}`); });
      await registerAuth(app, { password: 'x', secret: Buffer.alloc(32, 1), mode, store, verifier: { verify: async () => { throw new Error('unused'); } } as never });
      await registerRoutes(app, {
        store, secrets: { put: async () => {}, get: async () => '', delete: async () => {} } as never,
        providers: new Map([['mock', new MockProvider()]]),
        channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never,
        authMode: mode,
        webIndexPath: resolve(import.meta.dirname, '../web/index.html'),
        webJoinPath: resolve(import.meta.dirname, '../web/join.html'),
        publicUrl: 'https://box.example.com',
      });
      await app.ready();
      await app.close();
    }
  } finally {
    for (const k of ['HATCHABOT_LOCAL_ACCOUNTS', 'HATCHABOT_SIGNIN_KEY_FILE', 'HATCHABOT_PUBLIC_URL']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const classOf = (line: string): PublicClass => { const [m, u] = line.split(' '); return publicClassFor(m!, u!); };
const all = () => [...routes].sort();

describe('public route classification', () => {
  it('found the app (a sweep over nothing proves nothing)', () => {
    expect(routes.size).toBeGreaterThan(300);
    for (const must of ['GET /', 'GET /join/:code', 'GET /signin/link', 'POST /v1/login', 'POST /v1/session', 'POST /v1/second-factor/verify', 'POST /v1/public-access/on', 'GET /v1/agents/:id/ui/*']) {
      expect(routes.has(must), must).toBe(true);
    }
  });

  it('every registered route is named by a rule: nothing is public (or refused) by accident', () => {
    const unnamed = all().filter((line) => { const [m, u] = line.split(' '); return !publicRuleFor(m!, u!); });
    expect(unnamed).toEqual([]);
  });

  it('a route no rule names is refused', () => {
    expect(publicClassFor('GET', '/v1/something-new')).toBe('never');
    expect(publicClassFor('POST', '/v1/hosts/:id/brand-new-action')).toBe('step-up'); // a write under a machine group inherits its group's class
    expect(publicClassFor('GET', undefined)).toBe('never');
  });

  it('exactly these routes are open without a sign-in', () => {
    const open = all().filter((l) => classOf(l) === 'open').filter((l) => !l.startsWith('HEAD '));
    expect(open).toEqual([
      'GET /',
      'GET /healthz',
      'GET /icons/:name',
      'GET /join/:code',
      'GET /manifest.webmanifest',
      'GET /privacy',
      'GET /signin/link',
      'GET /sw.js',
      'GET /terms',
      'GET /v1/config',
      'GET /v1/invites/:code',
      'GET /v1/local-accounts/claim',
      'POST /v1/join',
      'POST /v1/local-accounts/claim',
      'POST /v1/local-accounts/recover',
      'POST /v1/local-accounts/recover-with-code',
      'POST /v1/login',
      'POST /v1/logout',
      'POST /v1/session',
    ]);
  });

  it('before the second factor, only the second-factor screen', () => {
    expect(all().filter((l) => classOf(l) === 'second-step' && !l.startsWith('HEAD '))).toEqual([
      'GET /v1/second-factor',
      'POST /v1/second-factor/challenge',
      'POST /v1/second-factor/verify',
    ]);
  });

  it('machine-level and dangerous routes need step-up', () => {
    for (const line of [
      'POST /v1/hosts', 'DELETE /v1/hosts/:id', 'POST /v1/hosts/:id/drain', 'POST /v1/hosts/:id/install-image',
      'GET /v1/runner-setup',
      'POST /v1/images', 'DELETE /v1/images/:name', 'POST /v1/images/:name/rebuild', 'POST /v1/runtime/build', 'POST /v1/runtime/images/promote', 'DELETE /v1/runtime/images/:tag',
      'POST /v1/agents/:id/env', 'DELETE /v1/agents/:id/env/:envId',
      'PUT /v1/machine-defaults', 'PUT /v1/rebuild-policy', 'PUT /v1/rebuild-concurrency',
      'GET /v1/agents/:id/backup', 'GET /v1/agents/:id/export', 'POST /v1/backups/run', 'POST /v1/backups/restore', 'DELETE /v1/backups/:date',
      'GET /v1/ai-profiles/:id/credential', 'POST /v1/ai-profiles', 'PATCH /v1/ai-profiles/:id',
      'GET /v1/agents/:id/bot-token', 'GET /v1/bots/:username/token', 'GET /v1/media-key/reveal', 'GET /v1/search-key/reveal', 'GET /v1/agents/:id/gateway',
      'POST /v1/cli-tokens',
      'POST /v1/ops-agent',
      'POST /v1/local-accounts', 'DELETE /v1/local-accounts/:id', 'POST /v1/local-accounts/:id/reset-link', 'POST /v1/local-accounts/:id/password', 'POST /v1/local-accounts/me/recovery-code',
      'POST /v1/workspaces/inspect', 'POST /v1/agents/:id/adopt-workspace', 'POST /v1/agents/:id/data-sources', 'POST /v1/agents/:id/move-host', 'POST /v1/agents/:id/rehost',
      'DELETE /v1/second-factor/:id', 'POST /v1/second-factor/totp', 'POST /v1/second-factor/passkey', 'POST /v1/second-factor/backup-codes',
      'POST /v1/public-access/off', 'GET /v1/public-access', 'GET /v1/security/log', 'POST /v1/security/sign-out/:ownerId',
      'POST /v1/embedder/start', 'POST /v1/embedder/guests', 'POST /v1/pool', 'DELETE /v1/pool/:username', 'POST /v1/proposals/:id/:verb',
    ]) {
      expect(routes.has(line), `${line} is registered`).toBe(true);
      expect(classOf(line), line).toBe('step-up');
    }
  });

  it('some things are never available there', () => {
    for (const line of [
      'POST /v1/local-accounts/bootstrap', 'POST /v1/auth/family-accounts', 'POST /v1/agents/:id/message',
      'GET /v1/connections/google/callback', 'POST /v1/connections/google/start', 'GET /app-qr.svg',
      'GET /v1/tailscale', 'POST /v1/tailscale/serve', 'POST /v1/tailscale/use-for-links', 'GET /v1/tailscale/qr.svg',
      'POST /v1/public-access/on', 'POST /v1/agents/preflight', 'POST /v1/agents/restore', 'POST /v1/peers', 'POST /v1/second-factor/reset/:id',
    ]) {
      expect(routes.has(line), `${line} is registered`).toBe(true);
      expect(classOf(line), line).toBe('never');
    }
  });

  it('only the first-factor enrolment routes let someone with no second factor past step-up', () => {
    const lax = PUBLIC_RULES.filter((r) => r.firstFactorOk).map((r) => r.pattern.source);
    expect(lax).toHaveLength(1);
    expect(lax[0]).toContain('second-factor');
    expect(publicRuleFor('DELETE', '/v1/second-factor/:id')?.firstFactorOk).toBeUndefined();
  });

  it('every rule names at least one real route (no rule left over from a route that is gone)', () => {
    const dead = PUBLIC_RULES.filter((rule) => !all().some((line) => { const [m, u] = line.split(' '); return (rule.methods === '*' || rule.methods.includes(m!)) && rule.pattern.test(u!); }));
    expect(dead.map((r) => r.pattern.source)).toEqual([]);
  });

  it('the documentation table is generated from the same rules and matches docs/public-access.md', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(resolve(import.meta.dirname, '../docs/public-access.md'), 'utf8');
    for (const row of publicClassTable()) expect(doc, `${row.cls}: ${row.group}`).toContain(`| ${row.cls} | ${row.group} |`);
  });
});
