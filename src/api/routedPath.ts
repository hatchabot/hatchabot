/**
 * The path the router routes: what comes before "?" or "#" (Fastify's router
 * stops at both). A check that reads more than that can be steered: a request
 * for "/v1/agents/<id>#/message" matched the old agent-to-agent exemption in
 * the sign-in hooks and skipped the sign-in check, while the router served
 * "/v1/agents/<id>" (2026-10-09). Exemptions use the matched route itself
 * (req.routeOptions.url); everything else that looks at a path uses this.
 */
export const routedPath = (url: string): string => url.split(/[?#]/)[0] ?? '';
