/**
 * What the per-request log may say about a URL. Fastify's default logged the
 * full URL, so OpenClaw's `mediaTicket=<JWT>` capability links (console media)
 * landed in the journal in the clear (review, 2026-09-29). Query strings are
 * dropped wholesale — any of them may carry a ticket, a state token or a
 * code — and the invitation code in a join link is masked the same way.
 */
export function redactUrlForLog(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const masked = path.replace(/^(\/join|\/v1\/invites)\/[^/]+/, '$1/…');
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
}): Record<string, unknown> {
  return {
    method: req.method,
    url: redactUrlForLog(req.url),
    host: req.host ?? req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}
