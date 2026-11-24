import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Agent } from '../domain/types.js';
import { browserImage, browserRefreshDate, containerOf } from '../orchestrator/console/browser.js';
import { browserSteerers } from '../orchestrator/console/browserLogins.js';
import { PANEL_IDLE_MS, panelAddress, panelCommands, panelSize, panelTransportOk, type PanelSink } from '../orchestrator/console/browserPanel.js';
import { browserLoginsVolume, newBrowserLogins } from '../providers/browserContainer.js';
import { onThisMachine } from './accountsAuth.js';
import { NO_COMPRESS, type RouteContext } from './routeContext.js';
import { readSessionCookie, requestIsHttps } from './sessionCookie.js';
import { isPublic } from './trust.js';

/**
 * An agent's own browser: the routes (HB-0808; docs/browser.md).
 *
 *  - Its state (GET /v1/agents/:id/browser): on, running, which Chromium,
 *    and with Keep its logins whether it does, the sites, the size and who
 *    besides the owner can steer it. It is switched on and off by PATCH
 *    /v1/agents/:id (`browser`), which stays in the registry.
 *  - "Sign in to a site" (…/browser/panel…): open, the stream of frames,
 *    input, close. The owner only, over an encrypted connection.
 *  - Keep its logins (…/browser/logins): keep, stop keeping, forget.
 *
 * Each route checks the agent, reads its request and words the answer; the
 * sweep that keeps the browsers in step and the open panels with what let
 * each in are the service's (`ctx.consoles`, src/orchestrator/console/):
 * `browsers` and `panels`. Registered where these routes stood in
 * registerRoutes, so the panels' hooks keep their place among the others.
 */
export function registerBrowserRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, trace, providerFor, ownedAgent, agentGone } = ctx;
  const { browsersNow } = ctx.consoles.browsers;
  const {
    panels, panelSessionValid, panelAccessValid, revalidatePanels, panelAccessOf, rememberPanel, pendingPanelOpen, signedOut,
    stop: stopPanelSweep,
  } = ctx.consoles.panels;
  // ---- each agent's own browser (src/orchestrator/console/browser.ts) -----------------
  (app as unknown as { browsersNow?: typeof browsersNow }).browsersNow = browsersNow;
  app.get<{ Params: { id: string } }>('/v1/agents/:id/browser', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const agent = ownedAgent(req, req.params.id);
    if (!agent || agentGone(agent.id)) return reply.code(404).send({ error: 'Not found' });
    const context = (a: Agent) => JSON.stringify([a.hostId, a.runtimeRef, a.state, a.browser, a.browserLogins, store.getHost(a.hostId)]);
    const before = context(agent);
    const p = agent.runtimeRef ? providerFor(agent.hostId) : undefined;
    const c = containerOf(agent.runtimeRef, p);
    const b = p && c ? (await p.listBrowsers?.().catch(() => []))?.find((x) => x.agentContainer === c) : undefined;
    // Which Chromium it is, and the day the image's was last refreshed (HB-0677).
    const chromium = b?.running && c ? await p?.browserVersion?.(c).catch(() => undefined) : undefined;
    const refreshed = browserRefreshDate();
    // Keep its logins (HB-0680): whether it does, the sites its panel opened,
    // how big the profile is, and who besides the owner can steer it (the dialog names them).
    const kept = agent.browserLogins && b?.running && b.logins === agent.browserLogins && c ? await p?.browserProfileBytes?.(c).catch(() => undefined) : undefined;
    const fresh = ownedAgent(req, agent.id);
    if (!fresh || agentGone(agent.id)) return reply.code(404).send({ error: 'Not found' });
    if (context(fresh) !== before) return reply.code(409).send({ error: 'Its browser changed while it was checked. Check again.' });
    return {
      on: !!agent.browser, running: !!b?.running, image: browserImage().image, ...(chromium ? { chromium } : {}), ...(refreshed ? { refreshed } : {}),
      keepsLogins: !!fresh.browserLogins, sites: fresh.browserSites ?? [], ...(kept !== undefined ? { profileMB: Math.max(1, Math.round(kept / 1048576)) } : {}),
      steeredBy: fresh.browser ? browserSteerers(store, fresh) : [],
    };
  });

  // ---- "Sign in to a site": the owner sees the agent's browser and clicks and
  // types in it (src/orchestrator/console/browserPanel.ts, HB-0680). The agent's owner
  // only (ownedAgent): never a guest, another member or the manager. Over an
  // encrypted connection only, since what is typed is a password; nothing of
  // it is stored or logged. A panel lasts until it is closed, ten minutes pass
  // with no input, or the browser goes (the agent stops or restarts). The open
  // panels and what let each in are the service's (signInPanels.ts).
  const panelRequestAccess = (req: FastifyRequest) => ({ cookie: req.headers.cookie, https: requestIsHttps(req), public: isPublic(req), lastActive: Date.now() });
  // After any request that changed something. At onSend, which comes with
  // every answer: onResponse never comes for a caller that hung up (HB-1405,
  // as the request holds in routes.ts, HB-0630), and a sign-out whose tab
  // closed left its panels open until the sweep. What it throws never turns
  // the request's own answer into an error.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || reply.statusCode >= 400) return payload;
    try {
      // Private logout forgets only the cookie in that browser, not its signed
      // value on the server. End active and pending panels for that browser.
      if (req.routeOptions.url === '/v1/logout' && req.headers.cookie) {
        signedOut(readSessionCookie(req.headers.cookie, requestIsHttps(req))?.value);
      }
      revalidatePanels();
    } catch (err) { app.log.warn({ err }, 'browser.panel_revalidate_failed'); }
    return payload;
  });
  // The 30-second sweep is the service's; it ends with the app as before.
  app.addHook('onClose', async () => { stopPanelSweep(); panels.closeAll('shutdown'); });
  const PANEL_PLAIN_HTTP = 'The sign-in panel opens only over an encrypted connection: this Hatchabot\'s https address, a device on your tailnet, or this machine itself. What you type in it is a password, so over plain http on your network it stays shut.';
  const PANEL_SESSION = 'Sign in to Hatchabot in this browser to open the sign-in panel.';
  const PANEL_GONE = 'That panel has closed. Open it again.';
  /** The open panel a request names: that person's, on that agent, over a connection fit to type a password on. */
  const openPanel = (req: FastifyRequest<{ Params: { id: string; panel: string } }>, reply: FastifyReply) => {
    if (!panelTransportOk(req, requestIsHttps(req), onThisMachine(req))) { void reply.code(403).send({ error: PANEL_PLAIN_HTTP }); return undefined; }
    const agent = ownedAgent(req, req.params.id);
    if (agent && !panelSessionValid(panelRequestAccess(req), agent.ownerId)) { void reply.code(401).send({ error: PANEL_SESSION }); return undefined; }
    revalidatePanels();
    const panel = agent ? panels.get(req.params.panel, agent.id, agent.ownerId) : undefined;
    if (!panel) void reply.code(404).send({ error: PANEL_GONE });
    return panel;
  };
  app.post<{ Params: { id: string }; Body: { w?: unknown; h?: unknown; mobile?: unknown; dpr?: unknown; url?: unknown } | undefined }>('/v1/agents/:id/browser/panel', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if (!panelTransportOk(req, requestIsHttps(req), onThisMachine(req))) return reply.code(403).send({ error: PANEL_PLAIN_HTTP });
    const access = panelRequestAccess(req);
    if (!panelSessionValid(access, agent.ownerId)) return reply.code(401).send({ error: PANEL_SESSION });
    if (agent.ops || !agent.browser) return reply.code(409).send({ error: 'Its browser is off: turn it on under Advanced → Browser first.' });
    if (agent.state !== 'RUNNING') return reply.code(409).send({ error: 'It is not running: start it, and its browser starts with it.' });
    const size = panelSize(req.body);
    if (!size) return reply.code(400).send({ error: 'Say the panel\'s size: w and h, in pixels.' });
    const typed = req.body?.url;
    const url = typed === undefined || typed === '' ? undefined : panelAddress(typed);
    if (typed !== undefined && typed !== '' && !url) return reply.code(400).send({ error: 'That is not a web address (http or https) the panel can open.' });
    const p = providerFor(agent.hostId);
    const c = containerOf(agent.runtimeRef, p);
    if (!p.openBrowserPanel || !c) return reply.code(409).send({ error: 'This machine cannot show an agent\'s browser.' });
    const pending = pendingPanelOpen(readSessionCookie(access.cookie, access.https)?.value);
    try {
      const b = (await p.listBrowsers?.().catch(() => []))?.find((x) => x.agentContainer === c);
      // Listing a runner can take time. Ownership, the session and the exact
      // browser must still be the ones checked before that wait. Private
      // logout also cancels this request even though its cookie is stateless.
      const fresh = ownedAgent(req, agent.id);
      if (!fresh) return reply.code(404).send({ error: 'Not found' });
      if (pending.revoked() || !panelSessionValid(access, agent.ownerId)) return reply.code(401).send({ error: PANEL_SESSION });
      if (!panelAccessValid({ id: '', agent, ...access })) return reply.code(409).send({ error: 'Its browser changed while the panel was opening. Open it again.' });
      if (!b?.running) return reply.code(409).send({ error: 'Its browser is not running yet: it starts within a minute of the agent. Try again shortly.' });
      const id = panels.open(agent.id, agent.ownerId, p.openBrowserPanel(c), size, url);
      rememberPanel(agent.id, { id, agent, ...access });
      return reply.code(201).send({ panel: id, idleMinutes: PANEL_IDLE_MS / 60_000 });
    } finally { pending.done(); }
  });
  // The page's frames and the address, as server-sent events read by fetch.
  // A frame is acknowledged once written here, so a slow connection gets
  // fewer frames, not a growing queue. Closing it closes the panel.
  app.get<{ Params: { id: string; panel: string } }>('/v1/agents/:id/browser/panel/:panel/stream', NO_COMPRESS, async (req, reply) => {
    const panel = openPanel(req, reply);
    if (!panel) return reply;
    const access = panelAccessOf(panel.agentId)!;
    // A second stream can replace the first; its own browser session is the
    // one that must remain signed in from this point onward.
    Object.assign(access, panelRequestAccess(req));
    const out = new PassThrough();
    const sink: PanelSink = (ev) => new Promise<void>((resolve) => {
      if (out.destroyed || out.writableEnded) { resolve(); return; }
      if (ev.t !== 'closed' && !panelAccessValid(access)) { panel.close('access'); resolve(); return; }
      const done = () => { out.off('drain', done); out.off('close', done); resolve(); };
      if (out.write(`data: ${JSON.stringify(ev)}\n\n`)) resolve();
      else { out.once('drain', done); out.once('close', done); }
      if (ev.t === 'closed') out.end();
    });
    // A comment now and then, so a proxy does not end a stream while the page is still.
    const beat = setInterval(() => {
      if (!panelAccessValid(access)) { panel.close('access'); return; }
      if (!out.writableEnded && !out.writableNeedDrain) out.write(': \n\n');
    }, 25_000);
    beat.unref();
    reply.raw.on('close', () => {
      clearInterval(beat);
      if (!out.writableEnded) out.end();
      if (panel.detach(sink)) panel.close('person');
    });
    panel.attach(sink);
    return reply
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-accel-buffering', 'no')
      .send(out);
  });
  // Input: what the person clicked and typed, as a few kinds of input the
  // panel turns into commands from its fixed list (panelCommands). Not in
  // the request log (a post per few keys would fill it); its failures are.
  app.post<{ Params: { id: string; panel: string }; Body: { ops?: unknown } | undefined }>('/v1/agents/:id/browser/panel/:panel/input', { logLevel: 'warn' }, async (req, reply) => {
    const panel = openPanel(req, reply);
    if (!panel) return reply;
    const r = panelCommands(req.body?.ops);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const access = panelAccessOf(panel.agentId);
    if (access) access.lastActive = Date.now();
    panel.touch();
    panel.run(r.commands);
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string; panel: string } }>('/v1/agents/:id/browser/panel/:panel', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (agent) panels.get(req.params.panel, agent.id, agent.ownerId)?.close('person');
    return reply.code(204).send();
  });

  // ---- Keep its logins (HB-0680, docs/browser.md): the browser's profile on a
  // volume of its own, so a sign-in survives restarts, until it is forgotten.
  // The owner only, never a guest or the manager; switching it on is a step-up
  // at the public address. Each change gives it a new profile (an id on the
  // agent), so its browser starts again, empty; the old profile is never
  // mounted again, and the sweep deletes it from the machine once it can.
  const applyLogins = async (agent: Agent, was: string | undefined): Promise<{ done: boolean; message: string }> => {
    panels.closeAgent(agent.id, 'restarted');
    const p = providerFor(agent.hostId);
    const c = containerOf(agent.runtimeRef, p);
    const oldVol = was && c ? browserLoginsVolume(c, was) : undefined;
    const swept = await Promise.race([browsersNow(agent.id), new Promise<undefined>((r) => setTimeout(() => r(undefined), 20_000).unref())]);
    // Still there, or not known to be gone: a machine that does not answer lists nothing.
    const answers = p.reachable ? await p.reachable().catch(() => false) : true;
    const listed = answers ? await p.listBrowserLogins?.().catch(() => undefined) : undefined;
    const left = !!oldVol && !(swept?.removed ?? []).includes(oldVol) && (!listed || listed.some((v) => v.name === oldVol));
    const now = store.getAgent(agent.id) ?? agent;
    const running = now.state === 'RUNNING';
    const message = left
      ? 'Its browser will not use them again. Its machine has not deleted them yet: that happens within minutes once it answers.'
      : running ? (now.browserLogins ? 'Its browser starts again, empty, keeping what you sign in to from now on.' : 'Its browser starts again, empty, and keeps nothing past a restart.')
      : 'Saved: its browser starts that way when the agent next runs.';
    return { done: !left, message };
  };
  app.put<{ Params: { id: string }; Body: { keep?: unknown } | undefined }>('/v1/agents/:id/browser/logins', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if (typeof req.body?.keep !== 'boolean') return reply.code(400).send({ error: 'Say keep: true or false.' });
    if (agent.ops || !agent.browser) return reply.code(409).send({ error: 'Its browser is off: turn it on under Advanced → Browser first.' });
    if (agent.state === 'ARCHIVED') return reply.code(409).send({ error: 'It is archived: restore it first.' });
    const keep = req.body.keep;
    if (keep === !!agent.browserLogins) return { keepsLogins: keep, done: true, message: keep ? 'It already keeps its logins.' : 'It keeps no logins.' };
    store.setAgentBrowserLogins(agent.id, keep ? newBrowserLogins() : null);
    trace(agent.id)(keep ? 'browser.logins_kept' : 'browser.logins_forgotten', keep ? {} : { why: 'switched off' });
    return { keepsLogins: keep, ...(await applyLogins(agent, agent.browserLogins)) };
  });
  // Forget logins: a new, empty profile; it goes on keeping what comes next.
  app.delete<{ Params: { id: string } }>('/v1/agents/:id/browser/logins', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if (!agent.browserLogins) return reply.code(409).send({ error: 'It keeps no logins: a restart already forgets what it signed in to.' });
    store.setAgentBrowserLogins(agent.id, newBrowserLogins());
    trace(agent.id)('browser.logins_forgotten', { why: 'forget' });
    const r = await applyLogins(agent, agent.browserLogins);
    return { keepsLogins: true, ...r, message: r.done ? `Forgotten. ${r.message}` : `Forgotten: ${r.message[0]!.toLowerCase()}${r.message.slice(1)}` };
  });
}
