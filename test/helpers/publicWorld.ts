import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { publicApp, type PublicApp, type PublicAppOptions } from './publicApp.js';
import { SHIM_DNS, tailscaleShim, type Shim } from './tailscaleShim.js';
import { activeValues } from '../../src/config/envFile.js';

/**
 * What the tests of the owner's decisions after the second review share
 * (test/publicSecondFactorDefault, publicRecovery, publicNoticeLimits,
 * publicCrash, publicSmaller): one app at a time, closed after each test, and
 * a "world" with every route, a stand-in for tailscale and a temp .env.
 */
export const ctx: { h?: PublicApp; cleanups: Array<() => void> } = { cleanups: [] };
export function closeAfterEach(): void {
  afterEach(async () => {
    try { ctx.h?.app.server.closeAllConnections(); } catch { /* not listening */ }
    await ctx.h?.close(); ctx.h = undefined;
    for (const c of ctx.cleanups) { try { c(); } catch { /* gone */ } }
    ctx.cleanups = [];
  });
}

export const agentRow = (id: string, ownerId: string, extra: Record<string, unknown> = {}) =>
  ({ id, ownerId, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'host-local', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now', ...extra }) as never;
/** Someone the owner gave web chat on one of the owner's agents. */
export const giveWebChat = (app: PublicApp, agentId: string, userId: string, extra: Record<string, unknown> = {}) =>
  app.store.insertMembership({ id: `m-${agentId}-${userId}`, agentId, userId, role: 'member', status: 'active', webChat: true, ...extra } as never);
export const privCookie = async (app: PublicApp, username: string, password: string): Promise<string> =>
  String((await app.app.inject({ method: 'POST', url: '/v1/login', payload: { username, password } })).headers['set-cookie']).split(';')[0]!;
/** Run with the clock this far ahead (Date.now only), and put it back. */
export const at = async <T>(msFromNow: number, fn: () => Promise<T>): Promise<T> => {
  const realNow = Date.now;
  Date.now = () => realNow() + msFromNow;
  try { return await fn(); } finally { Date.now = realNow; }
};
/** Stand-ins for a few routes the small app does not have, so the gate's answer can be told from the route's. */
export const extraRoutes: NonNullable<PublicAppOptions['extra']> = (app) => {
  app.post('/v1/agents', async () => ({ created: true }));
  app.patch('/v1/agents/:id', async () => ({ patched: true }));
  app.post('/v1/agents/:id/chat', async () => ({ sent: true }));
  app.post('/v1/account/telegram', async () => ({ linked: true }));
  app.post('/v1/security/notices/:id/seen', async () => ({ ok: true }));
};

// ---- the switch itself, and what stands on files: a shim for tailscale, a temp .env --------

export interface World { h: PublicApp; owner: { id: string; password: string; totpSecret?: Buffer }; call: (method: string, url: string, payload?: unknown, cookie?: string) => Promise<{ statusCode: number; body: string; json: () => any }>; shim: Shim; envFile: string; dir: string; sent: Array<{ chat: string; text: string }> }
export async function world(env: Record<string, string> = {}, opts: { on?: boolean; reuse?: { shim: Shim; dir: string } } = {}): Promise<World> {
  const shim = opts.reuse?.shim ?? tailscaleShim();
  const dir = opts.reuse?.dir ?? mkdtempSync(join(tmpdir(), 'hb-hardening-'));
  const envFile = join(dir, '.env');
  if (!opts.reuse) {
    writeFileSync(envFile, 'HATCHABOT_AUTH=accounts\nHATCHABOT_SECRET_KEY=x\n');
    ctx.cleanups.push(() => { shim.cleanup(); rmSync(dir, { recursive: true, force: true }); });
  }
  const sent: World['sent'] = [];
  const h = ctx.h = await publicApp({
    off: true, fullRoutes: true,
    env: { HATCHABOT_TAILSCALE_BIN: shim.bin, HATCHABOT_ENV_FILE: envFile, HATCHABOT_PUBLIC_ACCESS_URL: '', HATCHABOT_PUBLIC_URL: `https://${SHIM_DNS}`, ...env },
    routeDeps: {
      publicUrl: `https://${SHIM_DNS}`,
      secrets: { put: async () => {}, get: async () => '123:bot-token', delete: async () => {} },
      oauthFetch: async (_url: string, init: { body: string }) => {
        const b = JSON.parse(init.body) as { chat_id: string; text: string }; sent.push({ chat: String(b.chat_id), text: b.text });
        return new Response(JSON.stringify({ ok: true }));
      },
    },
  });
  const owner = await h.addAccount('owner', { owner: true });
  const cookie = await privCookie(h, 'owner', owner.password);
  const call: World['call'] = (method, url, payload, c = cookie) => h.app.inject({ method: method as 'GET', url, headers: { cookie: c }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  if (opts.on) {
    const r = await call('POST', '/v1/public-access/on', { confirm: true });
    if (r.statusCode !== 200) throw new Error(`could not turn public access on: ${r.body}`);
  }
  return { h, owner, call, shim, envFile, dir, sent };
}
export const envNow = (envFile: string) => activeValues(readFileSync(envFile, 'utf8'));
export const changing = (shim: Shim) => shim.calls().filter((c) => c[0] === 'funnel' && c[1] !== 'status').map((c) => c.join(' '));
/** The owner's agent with a Telegram bot, and `userId` known to it under this Telegram id: what a reset link needs to be sent. */
export const withTelegram = (w: World, userId: string, tgId: string): void => {
  if (!w.h.store.getAgent('tg-agent')) {
    w.h.store.insertAgent(agentRow('tg-agent', w.owner.id));
    w.h.store.insertChannel({ id: 'c-tg', agentId: 'tg-agent', kind: 'telegram', accountId: 'somebot', secretRef: 'chan/tg', deepLink: 'x', createdAt: 'now' } as never);
  }
  w.h.store.insertMembership({ id: `tg-${userId}`, agentId: 'tg-agent', userId, role: userId === w.owner.id ? 'owner' : 'member', status: 'active' } as never);
  w.h.store.bindMembershipChannelUser('tg-agent', userId, tgId);
};
export const resetRecoveryLimits = (app: PublicApp): void => (app.app as unknown as { _resetRecoveryLimits: () => void })._resetRecoveryLimits();

