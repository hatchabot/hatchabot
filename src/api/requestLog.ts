import { isPublic, publicClientAddress } from './trust.js';
/**
 * What the per-request log may say about a URL. Fastify's default logged the
 * full URL, so OpenClaw's `mediaTicket=<JWT>` capability links (console media)
 * landed in the journal in the clear (review, 2026-09-29). Query strings are
 * dropped wholesale — any of them may carry a ticket, a state token or a
 * code — and an invitation code in the path is masked the same way: a join
 * link's, and the segment after any `/invites/`, nested routes included
 * (`/v1/agents/:id/invites/:code/knock-window` kept it, C046).
 */
export function redactUrlForLog(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const masked = path.replace(/^\/join\/[^/]+/, '/join/…').replace(/\/invites\/[^/]+/g, '/invites/…');
  return q === -1 ? masked : `${masked}?…`;
}

/** Fastify's default `req` serializer, with the URL redacted. */
export function requestLogSerializer(req: {
  method?: string;
  url?: string;
  hostname?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
  headers?: Record<string, string | string[] | undefined>;
}): Record<string, unknown> {
  // A request through the public address arrives from 127.0.0.1 (tailscaled):
  // the journal says it was public, and from where.
  const pub = isPublic(req as never);
  return {
    method: req.method,
    url: redactUrlForLog(req.url),
    host: req.host ?? req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
    ...(pub ? { public: true, client: publicClientAddress({ headers: req.headers ?? {} }) } : {}),
  };
}
