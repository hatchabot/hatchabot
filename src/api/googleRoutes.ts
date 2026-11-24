import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Agent } from '../domain/types.js';
import { accessOverview } from '../orchestrator/google/accessOverview.js';
import { DEFAULT_SERVICES, googleAuthUrl, isAccountEmail, isGoogleService, testGmail } from '../orchestrator/google/googleConnections.js';
import { ownerIdOf } from './principal.js';
import { escapeHtml, MACHINE_OWNER_ONLY, zodMessage, type RouteContext } from './routeContext.js';
import { cookieFromHeader, requestIsHttps } from './sessionCookie.js';

/**
 * Binds a Google consent round-trip to the browser that started it. Over
 * HTTPS it is `__Host-` (Secure, Path=/, no Domain): on a hosted Hatchabot a
 * neighbouring tenant is the same site and can set a plain-named cookie for
 * the parent domain — planting their own nonce in this browser, then walking
 * this person through Google's consent with their own state, put this
 * person's Google account in the planter's vault (2026-10-01). Over plain
 * HTTP the prefix is impossible; the plain name stays, scoped to the callback.
 */
const OAUTH_NONCE_COOKIE = 'hb_oauth';
const OAUTH_NONCE_HOST_COOKIE = '__Host-hb_oauth';
const oauthNonceCookie = (https: boolean, nonce: string, maxAgeS: number): string =>
  https
    ? `${OAUTH_NONCE_HOST_COOKIE}=${nonce}; Path=/; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax; Secure`
    : `${OAUTH_NONCE_COOKIE}=${nonce}; Path=/v1/connections/google/callback; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax`;

/**
 * POST /v1/connections/google/start (HB-0814): the services to ask Google
 * for. `services` keeps its own check (a list with at least one, else the
 * default three; what is not a service is left out), so any value is let
 * through to it; a body that is not an object is refused.
 */
const StartConsent = z.object({ services: z.unknown() }).partial().nullish();
/** POST /v1/agents/:id/connections/attach and …/detach (HB-0814): one of the caller's connections; attach may keep it from sending mail. */
const AttachConnection = z.object({ connectionId: z.string().nullish(), gmailNoSend: z.boolean().nullish() }).nullish();
const DetachConnection = z.object({ connectionId: z.string().nullish() }).nullish();

/**
 * Google connections and what each agent can reach: the routes (HB-0808).
 *
 * The accounts an agent's own gog holds, Test Gmail and Disconnect; the
 * installation's OAuth client; the consent round-trip (start, and Google's
 * callback); the caller's connection vault, a connection deleted, attached
 * to an agent and detached; the access overview and Verify now.
 *
 * Each route checks who is asking, reads its request and words the answer;
 * the rules and their state are the Google connections and access service's
 * (`ctx.google`, src/orchestrator/google/): `client`, `delivery`, `vault`
 * and `access`. The consent's cookie and the redirect address are HTTP, so
 * they are here. No hook. The callback is exempt from the sign-in (auth.ts):
 * its single-use state is the credential.
 */
export function registerGoogleRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { deps, store, providerFor, trace, ownedAgent, movedAway, ownsLocalHost } = ctx;
  const { client: oauth, vault, access } = ctx.google;

  // ---- connections (gog: Google accounts the agent is signed into) --------
  // The credentials live on the agent's volume (GOG_HOME), managed by the
  // agent itself in chat — the control plane only LISTS and REVOKES, it never
  // reads a token. Owner-only, both ways: what accounts an agent can act as
  // is the owner's business, and so is cutting one off.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/connections', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if (!agent.runtimeRef || agent.state !== 'RUNNING') {
      return reply.code(409).send({ error: 'Start the agent to view its connections.' });
    }
    const listed = await vault.accountsIn({ ...agent, runtimeRef: agent.runtimeRef });
    if (!listed) {
      return reply.code(502).send({ error: "Couldn't read which Google accounts it is signed into just now — try again in a moment. Nothing was changed." });
    }
    return listed;
  });

  // Is this agent's Gmail working? Real calls at Google from inside it; reads no mail, sends nothing.
  app.post<{ Params: { id: string; email: string } }>('/v1/agents/:id/connections/:email/test', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    if (movedAway(agent, reply)) return reply;
    if (!isAccountEmail(req.params.email)) return reply.code(400).send({ error: 'Not a recognizable account email.' });
    if (agent.state !== 'RUNNING') return reply.code(409).send({ error: 'Start the agent first: this test runs inside it.' });
    const out = await testGmail({ store, provider: providerFor(agent.hostId) }, { id: agent.id, runtimeRef: agent.runtimeRef }, req.params.email);
    if (!out.ok) trace(agent.id)('connection.test_failed', { email: req.params.email, why: out.why, detail: out.detail });
    return out;
  });

  app.delete<{ Params: { id: string; email: string } }>(
    '/v1/agents/:id/connections/:email',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      // The email's shape is checked first (it reaches a shell line), then a
      // platform connection is detached, else gog removes it (vault.disconnect).
      const out = await vault.disconnect(agent, req.params.email);
      if ('refused' in out) {
        if (out.refused === 'failed') return reply.code(502).send({ error: `Couldn't remove it: ${out.reason}` });
        if (out.refused === 'invalid') return reply.code(400).send({ error: 'Not a recognizable account email.' });
        return reply.code(409).send({ error: 'Start the agent to disconnect an account.' });
      }
      return out;
    },
  );

  // ---- platform-managed Google connections (Phase 2) ----------------------
  // The control plane owns the OAuth dance: one per-installation client, a
  // normal browser consent redirect, refresh tokens in the SecretStore, and
  // per-agent attachment materialized via `gog auth import`. See
  // orchestrator/google/googleConnections.ts for the design note.
  const oauthRedirectUri = (req: { headers: Record<string, unknown>; protocol: string }): string => {
    const origin =
      deps.publicUrl?.replace(/\/$/, '') ??
      `${typeof req.headers['x-forwarded-proto'] === 'string' ? req.headers['x-forwarded-proto'] : req.protocol}://${String(req.headers.host ?? '')}`;
    return `${origin}/v1/connections/google/callback`;
  };

  /** Status any account may read; the secret half never leaves the vault. */
  app.get('/v1/google-oauth/client', async (req) => {
    const client = await oauth.get();
    return {
      configured: !!client,
      clientId: client?.clientId,
      redirectUri: oauthRedirectUri(req as any),
    };
  });

  // The client is an installation resource, like the runtime image — only
  // the machine owner sets or clears it.
  // A different client ID is asked for (`confirm`), naming how many
  // connections will need reconnecting (oauth.save).
  app.put<{ Body: { clientId?: string; clientSecret?: string; confirm?: boolean } }>('/v1/google-oauth/client', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const parsed = z
      .object({ clientId: z.string().trim().min(10).max(200), clientSecret: z.string().trim().min(10).max(200) })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Both the client ID and client secret are required.' });
    const saved = await oauth.save(parsed.data, req.body?.confirm === true);
    if ('refused' in saved) {
      const breaks = saved.breaks;
      return reply.code(409).send({
        error: `${breaks} Google connection${breaks === 1 ? ' was' : 's were'} made with a different OAuth client. With this one, ${breaks === 1 ? 'it stops' : 'they stop'} working until each account is connected again.`,
        code: 'google_client_change',
        reconnect: breaks,
      });
    }
    return { configured: true, clientId: parsed.data.clientId, reconnect: saved.breaks, ...saved.sent };
  });

  app.delete('/v1/google-oauth/client', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    if (!(await oauth.remove())) {
      return reply.code(500).send({ error: 'The Google OAuth client could not be removed from the secret store, so it is still set. Try again; if it keeps failing, check the server log.' });
    }
    return { configured: false };
  });

  /** Begin the consent round-trip: returns the Google URL to open. */
  app.post('/v1/connections/google/start', async (req, reply) => {
    const client = await oauth.get();
    if (!client) {
      return reply.code(409).send({ error: 'No Google OAuth client configured yet — the server owner sets it up under ⚙ Settings → Connections.' });
    }
    const parsed = StartConsent.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const body = parsed.data ?? {};
    // Guard the shape: a non-array `services` with a truthy `.length` (e.g. a
    // string) used to TypeError → 500 (audit 2026-09-06).
    const requested = Array.isArray(body.services) && body.services.length ? body.services : DEFAULT_SERVICES;
    const services = [...new Set(requested.filter(isGoogleService))].slice(0, 8);
    if (!services.length) return reply.code(400).send({ error: 'Pick at least one service.' });
    // The browser that asks is the browser that must come back: a Lax cookie
    // (it rides Google's top-level redirect home), scoped to the callback.
    // Google returns to the public address; a cookie set on another address
    // (the LAN IP, localhost) never reaches it, so say where to connect from
    // rather than fail at the end (regression review, 2026-09-28).
    if (deps.publicUrl) {
      let publicHost = '';
      try { publicHost = new URL(deps.publicUrl).host; } catch { /* unparsable: no check */ }
      const fwdHost = req.headers['x-forwarded-host'];
      const here = String((Array.isArray(fwdHost) ? fwdHost[0] : fwdHost) ?? req.headers.host ?? '');
      if (publicHost && here && here.toLowerCase() !== publicHost.toLowerCase()) {
        return reply.code(409).send({ error: `Google sends you back to ${deps.publicUrl}. Open Hatchabot there, then press Connect again.` });
      }
    }
    const nonce = randomBytes(18).toString('base64url');
    const state = oauth.issueState(ownerIdOf(req), services, nonce);
    reply.header('set-cookie', oauthNonceCookie(requestIsHttps(req), nonce, 600));
    return { url: googleAuthUrl(client.clientId, oauthRedirectUri(req as any), state, services) };
  });

  /**
   * Google's redirect lands here in the SAME browser session (the cookie
   * rides along, so this stays behind auth); `state` additionally binds the
   * code to whoever started the flow. Replies with a tiny page, not JSON —
   * a human is looking at this tab.
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/v1/connections/google/callback',
    async (req, reply) => {
      // Escapes its OWN arguments — callers pass raw values, so a future
      // caller can't reintroduce an XSS by forgetting to escape (audit
      // 2026-09-06 hardening; the args are already trusted/static today).
      const page = (title: string, body: string, ok: boolean) =>
        reply.type('text/html').code(ok ? 200 : 400).send(
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center"><h2>${escapeHtml(title)}</h2><p style="color:#556">${escapeHtml(body)}</p></body>`,
        );
      // This path is auth-exempt (the cross-site redirect can't carry the
      // strict-SameSite session cookie) — the single-use state token IS the
      // credential, and claim.ownerId names whose vault the result joins.
      // Over HTTPS only the __Host- cookie is believed: a plain one may have been planted.
      const https = requestIsHttps(req);
      const nonce = cookieFromHeader(req.headers.cookie, https ? OAUTH_NONCE_HOST_COOKIE : OAUTH_NONCE_COOKIE);
      const claim = req.query.state ? oauth.consumeState(req.query.state, nonce ?? '') : null;
      reply.header('set-cookie', https ? [oauthNonceCookie(true, '', 0), oauthNonceCookie(false, '', 0)] : oauthNonceCookie(false, '', 0));
      if (!claim) {
        return page("That didn't match", 'This consent link expired, was already used, or was opened in a different browser from the one that pressed Connect — go back to Hatchabot there and press Connect again.', false);
      }
      if (req.query.error || !req.query.code) {
        return page('Not connected', `Google reported: ${req.query.error ?? 'no code returned'}. Nothing was stored.`, false);
      }
      const client = await oauth.get();
      if (!client) return page('Not connected', 'The OAuth client was removed mid-flow.', false);
      try {
        // The code exchanged, and only what Google granted kept (oauth.link).
        const { email, granted, refused } = await oauth.link(claim, client, oauthRedirectUri(req as any), req.query.code);
        const names = (list: string[]) => list.map((s) => s[0]!.toUpperCase() + s.slice(1)).join(', ');
        if (!granted.length) {
          return page('Not connected', `Google granted none of the services asked for (${names(refused)}). Nothing was stored — press Connect again and leave them ticked.`, false);
        }
        return page(`✅ ${email} connected`,
          (refused.length ? `Connected for ${names(granted)} only: ${names(refused)} ${refused.length === 1 ? 'was' : 'were'} not granted (to add ${refused.length === 1 ? 'it' : 'them'}, press Connect again and leave ${refused.length === 1 ? 'it' : 'them'} ticked). ` : '') +
          'You can close this tab. Back in Hatchabot, attach this account to any agent under its ⚙ Settings → Connections.', true);
      } catch (err) {
        return page('Not connected', String((err as Error).message ?? err).slice(0, 300), false);
      }
    },
  );

  /** The caller's connection vault, with where each one reaches. */
  app.get('/v1/connections', async (req) => vault.list(ownerIdOf(req)));

  app.delete<{ Params: { id: string } }>('/v1/connections/:id', async (req, reply) => {
    const out = await vault.remove(req.params.id, ownerIdOf(req));
    if (!out) return reply.code(404).send({ error: 'Not found' });
    return out;
  });

  /** Attach a vault connection to an agent — live immediately when RUNNING,
   *  and re-materialized on every future provision/rebuild. */
  app.post<{ Params: { id: string } }>(
    '/v1/agents/:id/connections/attach',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const parsed = AttachConnection.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      const body = parsed.data ?? {};
      // Only the caller's own connection, judged again in the agent's connection turn (vault.attach).
      const out = await vault.attach(agent, ownerIdOf(req), body.connectionId ?? undefined, body.gmailNoSend === true);
      if (!out) return reply.code(404).send({ error: 'No such connection.' });
      // Deleted (or given to another account) while the attach waited its turn.
      if ('agentGone' in out) return reply.code(404).send({ error: 'Not found' });
      return out;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/agents/:id/connections/detach',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const parsed = DetachConnection.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      const body = parsed.data ?? {};
      const out = await vault.detach(agent, ownerIdOf(req), body.connectionId ?? undefined);
      if (!out) return reply.code(404).send({ error: 'No such connection.' });
      return out;
    },
  );

  // ---- What each agent can reach (docs/access-overview-design.md) ---------
  // Intended (Hatchabot's records) against the last check inside the running
  // agent, pending removals, and what Hatchabot cannot see. Names, addresses
  // and times only — never a secret. An agent's owner; the machine's owner
  // sees every agent (as the agent list's ?all=1 does).
  const accessAgent = (req: FastifyRequest, id: string): Agent | undefined => {
    const a = store.getAgent(id);
    if (!a || a.state === 'DELETED') return undefined;
    return a.ownerId === ownerIdOf(req) || ownsLocalHost(req) ? a : undefined;
  };
  app.get('/v1/access', async (req) => {
    const list = ownsLocalHost(req) ? store.listAllActiveAgents() : store.listAgents(ownerIdOf(req));
    const now = Date.now();
    const agents = list.filter((a) => a.state !== 'DELETED').map((a) => ({
      ...accessOverview(store, a, now),
      ...(a.ownerId !== ownerIdOf(req) ? { ownerId: a.ownerId } : {}),
    }));
    // Mismatches first, then what was not found, then by name.
    agents.sort((x, y) => (y.summary.mismatches - x.summary.mismatches) || (y.summary.missing - x.summary.missing) || x.name.localeCompare(y.name));
    return { agents };
  });
  app.get<{ Params: { id: string } }>('/v1/agents/:id/access', async (req, reply) => {
    const agent = accessAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return accessOverview(store, agent);
  });
  /** Verify now: look inside the running agent (no side effects) and record what is there (access.verify, one at a time). */
  app.post<{ Params: { id: string } }>('/v1/agents/:id/access/verify', async (req, reply) => {
    const agent = accessAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const out = await access.verify(agent);
    if (out === 'busy') return reply.code(409).send({ error: 'This agent\'s access is being verified already — wait for it.' });
    return out;
  });
}
