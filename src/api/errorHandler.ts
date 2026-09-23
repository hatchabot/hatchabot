import type { FastifyInstance } from 'fastify';

/**
 * Fastify's default handler sends err.message to the client. A rethrown
 * ProviderError's message holds docker's stderr — container names, runner
 * endpoints, daemon paths (26th audit). Only the user-facing text goes out;
 * the detail goes to the log. Client errors (validation, 4xx) keep their text.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; userMessage?: string };
    if (e.userMessage) {
      req.log.warn({ err }, 'provider error');
      return reply.code(e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 500).send({ error: e.userMessage });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: e.message });
    }
    req.log.error({ err }, 'unhandled route error');
    return reply.code(500).send({ error: 'Something went wrong on the server — its log has the details.' });
  });
}
