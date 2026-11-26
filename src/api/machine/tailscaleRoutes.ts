import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { MACHINE_OWNER_ONLY, type RouteContext } from '../routeContext.js';

/**
 * Tailscale for this machine's own address: the routes (HB-0808 step 15
 * part B). Whether the machine is on a tailnet and served on it
 * (/v1/tailscale), `tailscale serve` turned on (…/serve), that address
 * written for links (…/use-for-links), and its QR code (…/qr.svg).
 *
 * Each is the machine owner's, checked first; the rules are the reach
 * service's (`ctx.reach.tailscale`, src/orchestrator/reach/tailscaleSetup.ts),
 * and every probe tells the app's address what it found. Never at the
 * public address (src/api/publicRoutes.ts: 'never'). No hook.
 */
export function registerTailscaleRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { ownsLocalHost } = ctx;
  const { tailscale } = ctx.reach;

  /**
   * Is this machine on a tailnet, and is Hatchabot already served over HTTPS
   * on it? The setup guide used to hand out a command and leave the person to
   * work out their own address; usually the machine knows both.
   */
  app.get('/v1/tailscale', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    return tailscale.status();
  });

  /** Turn on `tailscale serve` (tailscaleSetup.ts): the machine owner's call and nothing else. */
  app.post('/v1/tailscale/serve', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const done = await tailscale.serve();
    if (!done.ok) return reply.code(409).send(done.refusal);
    return done.answer;
  });

  /** Remember this address for links, in the .env the service reads (tailscaleSetup.ts). */
  app.post('/v1/tailscale/use-for-links', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const done = await tailscale.useForLinks();
    if (!done.ok) return reply.code(409).send(done.refusal);
    return done.answer;
  });

  /** A QR for the tailnet address, so a phone can open it without typing. */
  app.get('/v1/tailscale/qr.svg', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const url = await tailscale.qrAddress();
    if (!url) return reply.code(409).send({ error: 'No HTTPS address to encode yet.' });
    const svg = await QRCode.toString(url.replace(/\/$/, ''), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return reply.header('cache-control', 'no-cache').type('image/svg+xml').send(svg);
  });
}
