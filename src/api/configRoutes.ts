import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './routeContext.js';
import { isPublic } from './trust.js';

/**
 * The app's config: GET /v1/config (HB-0808 step 15 part B). What the
 * sign-in screen and the page read before anything else, served before
 * anyone has signed in, at the public address too (src/api/publicRoutes.ts:
 * 'open'). Which listener the request arrived on decides what it may see
 * (`publicConfigView`, src/orchestrator/reach/appConfig.ts); the rest is the
 * reach service's (`ctx.reach.config`). No hook.
 */
export function registerConfigRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { config } = ctx.reach;
  app.get('/v1/config', async (req) => config.view(isPublic(req)));
}
