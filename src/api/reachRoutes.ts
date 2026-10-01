import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import type { Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { Agent } from '../domain/types.js';
import { internalPrincipal } from './principal.js';
import { isPublic } from './trust.js';
import { autoUpgradeStatus } from '../ops/autoUpgrade.js';
import { funnelOff, funnelOn, funnelPreflight, funnelStatus, targetsPort, unsetEnvVar, writeEnvVar } from '../ops/tailnet.js';

/**
 * "Reach it from anywhere": the public-access switch, with Tailscale Funnel
 * as the provider (docs/public-access.md), plus the security record and the
 * notices that go with it.
 *
 * On is the machine owner's decision, made at the private address, with an
 * explicit confirmation, and only when every safeguard holds; the answer
 * names each one that does not. Off undoes all of it: Funnel's entry, the
 * listener, the setting and the address.
 */
export interface ReachDeps {
  store: Store;
  secrets: SecretStore;
  ownsLocalHost(req: FastifyRequest): boolean;
  appUrlFor(): string | undefined;
  trace(event: string, detail: Record<string, unknown>): void;
  fetchImpl?: typeof fetch;
}

const OWNER_ONLY = 'Only the owner of this machine decides whether it is reachable from the internet.';
export const PUBLIC_CONFIRM_TEXT = 'This makes your sign-in page reachable from the internet.';

export function registerReachRoutes(app: FastifyInstance, deps: ReachDeps): void {
  const api = app.publicAccess;
  if (!api) return; // no sign-in registered (a bare test app): nothing public to switch
  const { store, secrets } = deps;
  const envPath = (): string => process.env.HATCHABOT_ENV_FILE ?? join(process.cwd(), '.env');
  const mainPort = (): number => Number(process.env.PORT ?? 8080) || 8080;
  const inTests = !!process.env.VITEST && !process.env.HATCHABOT_TAILSCALE_BIN?.trim();

  /**
   * Telegram, to someone already linked: through a bot that has talked to
   * them and whose token their own side holds (their agents', or the machine
   * owner's; the manager first). The same rule as a password reset link.
   */
  const telegram = async (ownerId: string, text: string): Promise<boolean> => {
    const tgId = store.accountTelegram(ownerId) ?? store.knownChannelUserId(ownerId);
    if (!tgId) return false;
    const owners = new Set([store.localHostOwnerId(), ...store.listLocalAccounts().filter((x) => x.hostOwner).map((x) => x.id)]);
    const mayCarry = (a: Agent) => a.ownerId === ownerId || owners.has(a.ownerId);
    const candidates = store.listAllActiveAgents()
      .filter((a) => a.state === 'RUNNING' && mayCarry(a) && store.listAllowedChannelUserIds(a.id).includes(tgId))
      .sort((x, y) => Number(!!y.ops) - Number(!!x.ops));
    for (const a of candidates) {
      const ch = store.getChannelForAgent(a.id, 'telegram');
      const token = ch ? await secrets.get(ch.secretRef).catch(() => undefined) : undefined;
      if (!token) continue;
      const ok = await (deps.fetchImpl ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: tgId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8000),
      }).then(async (r) => r.ok && ((await r.json().catch(() => ({}))) as { ok?: boolean }).ok === true).catch(() => false);
      if (ok) return true;
    }
    return false;
  };

  api.setProbes({
    telegram,
    appUrl: deps.appUrlFor,
    // Under a test runner nothing probes this machine's real timer or Tailscale; tests supply their own.
    ...(inTests ? {} : {
      autoUpgrade: () => autoUpgradeStatus(),
      funnelOnPrivatePort: async (privatePort: number) => {
        const st = await funnelStatus();
        return st.readable ? st.entries.some((e) => targetsPort(e, privatePort)) : undefined;
      },
    }),
  });

  const ownerOnly = (req: FastifyRequest): string | undefined => {
    if (internalPrincipal(req)) return 'A person does this, signed in themselves.';
    return deps.ownsLocalHost(req) ? undefined : OWNER_ONLY;
  };

  const statusBody = async (opts: { preflight?: boolean } = {}) => {
    await api.evaluate();
    const st = api.status();
    const preflight = opts.preflight ? await funnelPreflight().catch(() => undefined) : undefined;
    return {
      on: st.on, serving: st.serving, listening: st.listening,
      provider: 'funnel',
      url: st.url ?? null,
      port: st.port, funnelPort: st.funnelPort,
      invitedOnly: api.config().invitedOnly,
      safeguards: st.checks,
      failing: st.failing.map((c) => c.id),
      checkedAt: st.checkedAt,
      confirmText: PUBLIC_CONFIRM_TEXT,
      ...(preflight ? { tailscale: preflight } : {}),
    };
  };

  app.get<{ Querystring: { preflight?: string } }>('/v1/public-access', async (req, reply) => {
    const no = ownerOnly(req);
    if (no) return reply.code(403).send({ error: no });
    return statusBody({ preflight: req.query.preflight === '1' });
  });

  /** The "Only invited people" switch. It cannot be turned off while public access is on. */
  app.post<{ Body: { on?: boolean } }>('/v1/public-access/invited-only', async (req, reply) => {
    const no = ownerOnly(req);
    if (no) return reply.code(403).send({ error: no });
    const on = req.body?.on === true;
    if (!on && api.config().on) return reply.code(409).send({ error: 'Turn public access off first: it stands on this switch.' });
    const wrote = on
      ? await writeEnvVar(envPath(), 'HATCHABOT_PUBLIC_INVITED_ONLY', '1', () => true, 'Written by Hatchabot: at the public address only invited people sign in.')
      : await unsetEnvVar(envPath(), 'HATCHABOT_PUBLIC_INVITED_ONLY');
    if (!wrote.ok) return reply.code(409).send({ error: wrote.error ?? 'Could not write .env' });
    if (on) process.env.HATCHABOT_PUBLIC_INVITED_ONLY = '1'; else delete process.env.HATCHABOT_PUBLIC_INVITED_ONLY;
    deps.trace('public.invited_only', { on });
    return statusBody();
  });

  /** Take everything a failed or finished "on" put in place back out. */
  const undo = async (cfg: { port: number; funnelPort: number }, funnel: boolean, opts: { afterAnswer?: boolean } = {}): Promise<{ funnelError?: string; command?: string }> => {
    let funnelError: string | undefined, command: string | undefined;
    if (funnel) {
      const r = await funnelOff(cfg.port, cfg.funnelPort);
      if (!r.ok) { funnelError = r.error; command = r.command; }
    }
    delete process.env.HATCHABOT_PUBLIC_ACCESS;
    delete process.env.HATCHABOT_PUBLIC_ACCESS_URL;
    // Asked through the public address itself: let the answer leave before the listener closes under it.
    if (opts.afterAnswer) setTimeout(() => { void api.stopListener(); }, 750).unref();
    else await api.stopListener();
    await unsetEnvVar(envPath(), 'HATCHABOT_PUBLIC_ACCESS').catch(() => undefined);
    await unsetEnvVar(envPath(), 'HATCHABOT_PUBLIC_ACCESS_URL').catch(() => undefined);
    return { funnelError, command };
  };

  let switching = false;
  app.post<{ Body: { confirm?: boolean } }>('/v1/public-access/on', async (req, reply) => {
    const no = ownerOnly(req);
    if (no) return reply.code(403).send({ error: no });
    // The route table already refuses this at the public address; the second lock.
    if (isPublic(req)) return reply.code(403).send({ error: 'Public access is turned on from the private address.' });
    if (req.body?.confirm !== true) {
      return reply.code(400).send({ error: `${PUBLIC_CONFIRM_TEXT} Confirm to go on.`, needsConfirm: true, confirmText: PUBLIC_CONFIRM_TEXT });
    }
    if (switching) return reply.code(409).send({ error: 'Public access is being switched right now.' });
    switching = true;
    try {
      if (api.config().on && api.status().serving) return { ...(await statusBody()), alreadyOn: true };
      // 1. Every safeguard, judged now. The answer names each one that is off.
      const failing = (await api.evaluate()).filter((c) => !c.ok);
      if (failing.length) {
        return reply.code(409).send({
          error: `Not yet: ${failing.map((c) => c.title).join('; ')}.`,
          failing: failing.map((c) => ({ id: c.id, letter: c.letter, title: c.title, detail: c.detail, fix: c.fix })),
        });
      }
      // 2. What Funnel itself needs, each missing piece with where to fix it.
      const pre = await funnelPreflight();
      if (!pre.ok) return reply.code(409).send({ error: `Tailscale Funnel is not ready: ${pre.missing.map((m) => m.what).join(' ')}`, missing: pre.missing });
      // 3. The listener, then Funnel pointed at it and at nothing else.
      const cfg = { port: api.config().port, funnelPort: api.config().funnelPort };
      process.env.HATCHABOT_PUBLIC_ACCESS = 'funnel';
      const listen = await api.syncListener();
      if (!listen.listening) { await undo(cfg, false); return reply.code(409).send({ error: listen.error ?? 'The public listener did not open.' }); }
      const fun = await funnelOn(cfg.port, cfg.funnelPort, mainPort());
      if (!fun.ok || !fun.url) {
        await undo(cfg, false);
        return reply.code(409).send({ error: fun.error ?? 'Tailscale Funnel did not turn on.', link: fun.link, command: fun.command });
      }
      // 4. Remember it, so a restart serves the same thing (and the doctor sees it).
      process.env.HATCHABOT_PUBLIC_ACCESS_URL = fun.url;
      const w1 = await writeEnvVar(envPath(), 'HATCHABOT_PUBLIC_ACCESS', 'funnel', () => true, 'Written by Hatchabot: public access (docs/public-access.md).');
      const w2 = w1.ok ? await writeEnvVar(envPath(), 'HATCHABOT_PUBLIC_ACCESS_URL', fun.url, () => true) : w1;
      if (!w2.ok) {
        await undo(cfg, true);
        return reply.code(409).send({ error: `Could not save the setting (${w2.error ?? '.env'}), so public access was turned back off.` });
      }
      // 5. Judged again with the public address known (a passkey counts only if it was made for this host).
      const after = (await api.evaluate()).filter((c) => !c.ok);
      if (after.length || !api.status().serving) {
        await undo(cfg, true);
        return reply.code(409).send({ error: `Turned back off: ${after.map((c) => `${c.title} (${c.detail})`).join('; ') || 'the public listener is not serving'}.`, failing: after });
      }
      store.recordSecurity('public.on', req.principal?.ownerId, { url: fun.url, provider: 'funnel' });
      deps.trace('public.on', { url: fun.url });
      return { ...(await statusBody()), turnedOn: true };
    } finally {
      switching = false;
    }
  });

  app.post('/v1/public-access/off', async (req, reply) => {
    const no = ownerOnly(req);
    if (no) return reply.code(403).send({ error: no });
    if (switching) return reply.code(409).send({ error: 'Public access is being switched right now.' });
    switching = true;
    try {
      const cfg = { port: api.config().port, funnelPort: api.config().funnelPort };
      const was = api.config().on;
      // Answer first when this request itself came through the public address: the listener is about to close under it.
      const out = await undo(cfg, true, { afterAnswer: isPublic(req) });
      if (was) store.recordSecurity('public.off', req.principal?.ownerId, { funnelRemoved: !out.funnelError });
      deps.trace('public.off', { funnelRemoved: !out.funnelError });
      return {
        on: false, serving: false,
        ...(out.funnelError ? { warning: `Hatchabot stopped serving the public address, but Tailscale's Funnel entry could not be removed (${out.funnelError}). Run: ${out.command}`, command: out.command } : {}),
      };
    } finally {
      switching = false;
    }
  });

  /** The public address as a QR code, for the phone that is not on the tailnet. */
  app.get('/v1/public-access/qr.svg', async (req, reply) => {
    const no = ownerOnly(req);
    if (no) return reply.code(403).send({ error: no });
    const url = api.status().url;
    if (!api.config().on || !url) return reply.code(409).send({ error: 'Public access is off.' });
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return reply.header('cache-control', 'no-store').type('image/svg+xml').send(svg);
  });

  // ---- the record, the notices, signing someone out ---------------------------

  app.get('/v1/security/log', async (req, reply) => {
    const no = ownerOnly(req);
    if (no) return reply.code(403).send({ error: no });
    const names = new Map<string, string>();
    const nameOf = (id?: string) => {
      if (!id) return undefined;
      if (!names.has(id)) names.set(id, store.localAccount(id)?.username ?? store.emailForOwner(id) ?? id);
      return names.get(id);
    };
    return { entries: store.listSecurityLog(200).map((e) => ({ ...e, who: nameOf(e.ownerId) })) };
  });

  app.get('/v1/security/notices', async (req) => {
    const me = req.principal?.ownerId;
    if (!me || internalPrincipal(req)) return { notices: [] };
    return { notices: store.listSecurityNotices(me, { unseenOnly: true }), canSignOutOthers: deps.ownsLocalHost(req) };
  });

  app.post<{ Params: { id: string } }>('/v1/security/notices/:id/seen', async (req, reply) => {
    const me = req.principal?.ownerId;
    if (!me || internalPrincipal(req)) return reply.code(401).send({ error: 'auth required' });
    return { ok: store.markSecurityNoticeSeen(me, req.params.id) };
  });

  app.get('/v1/security/devices', async (req) => {
    const me = req.principal?.ownerId;
    if (!me || internalPrincipal(req)) return { devices: [] };
    return { devices: store.listDevices(me) };
  });

  /** The machine's owner ends every session of one person: every browser, every command-line token. */
  app.post<{ Params: { ownerId: string } }>('/v1/security/sign-out/:ownerId', async (req, reply) => {
    const no = ownerOnly(req);
    if (no) return reply.code(403).send({ error: no });
    const target = req.params.ownerId;
    const known = store.localAccount(target) || store.emailForOwner(target) !== undefined || store.listSecurityLog(1, target).length > 0;
    if (!known) return reply.code(404).send({ error: 'Not found' });
    store.bumpSessionEpoch(target);
    const cliTokens = store.revokePersonalCliTokens(target);
    store.forgetDevices(target);
    store.recordSecurity('signed_out_everywhere', target, { by: req.principal?.ownerId });
    deps.trace('security.signed_out_everywhere', { target, cliTokens });
    return { ok: true, cliTokens };
  });
}
