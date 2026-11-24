import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ownerIdOf } from './principal.js';
import { MACHINE_OWNER_ONLY, type RouteContext } from './routeContext.js';

/** PUT /v1/media-key and PUT /v1/search-key: the key as pasted (trimmed after). */
const PastedKey = z.object({ key: z.string().min(1).max(400) });
/** PUT /v1/web-search: which search the fleet uses, and what a Brave search costs. */
const SearchChoice = z.object({
  mode: z.enum(['auto', 'duckduckgo']).optional(),
  price: z.object({ per1000: z.number().finite().min(0).max(1000), monthlyCredit: z.number().finite().min(0).max(100_000) }).strict().optional(),
}).strict();
/**
 * PUT /v1/machine-defaults: the key and its value, of any type, made text and
 * checked by the service in its own words, as before (a number is a value,
 * HB-0814); a body that is not an object is read as without either.
 */
const DefaultChange = z.object({ key: z.unknown().optional(), value: z.unknown().optional() });

/**
 * Keys, web search and the machine's defaults: the routes (HB-0808 step 15
 * part A).
 *
 * The fleet's Gemini key (/v1/media-key) and Brave key (/v1/search-key),
 * each read as set or not, saved, shown again (…/reveal) and removed; which
 * search the fleet uses (/v1/web-search, its check and its usage) and a real
 * search in one agent (/v1/agents/:id/search-test); Defaults for this
 * machine (/v1/machine-defaults).
 *
 * Each route checks who is asking first, reads its body where it did, and
 * words the answer; the rules are the machine settings service's
 * (`ctx.machineSettings`, src/orchestrator/settings/machineSettings.ts). A
 * read never answers with a key: only the machine's owner sees one again,
 * through the reveal, which the service refuses to anyone else. No hook.
 */
export function registerMachineSettingsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { ownsLocalHost, ownedAgent, movedAway } = ctx;
  const { keys, search, defaults } = ctx.machineSettings;

  // ---- media key -----------------------------------------------------------
  // One fleet-wide Gemini key powering voice-note transcription (OpenClaw's
  // audio understanding sends audio to an audio-capable model). Injected into
  // agents at provision — the Environment tab reserves GEMINI_* on purpose,
  // so this is the managed path. Write-only, like every credential.
  app.get('/v1/media-key', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const set = await keys.isSet('media');
    return { set };
  });

  app.put('/v1/media-key', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const parsed = PastedKey.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Paste a Gemini API key.' });
    const key = parsed.data.key.trim();
    if (!key) return reply.code(400).send({ error: 'Paste a Gemini API key.' });
    await keys.save('media', key);
    return { set: true };
  });

  /**
   * Show the fleet keys again, to the machine owner only — the same two
   * presses as a bot token (Show, then Copy). Each reveal is logged.
   */
  app.get('/v1/media-key/reveal', async (req, reply) => {
    const r = await keys.reveal('media', { ownsMachine: () => ownsLocalHost(req), ownerId: () => ownerIdOf(req) });
    if (!r.ok && r.why === 'machine-owner') return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    if (!r.ok) return reply.code(404).send({ error: 'No Gemini key is set.' });
    return { key: r.key };
  });
  app.get('/v1/search-key/reveal', async (req, reply) => {
    const r = await keys.reveal('search', { ownsMachine: () => ownsLocalHost(req), ownerId: () => ownerIdOf(req) });
    if (!r.ok && r.why === 'machine-owner') return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    if (!r.ok) return reply.code(404).send({ error: 'No Brave key is set.' });
    return { key: r.key };
  });

  app.delete('/v1/media-key', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const r = await keys.remove('media');
    if (!r.ok) return reply.code(500).send({ error: `Couldn't remove the shared Gemini key (${r.error}). It is still set: try again.` });
    return { set: false };
  });

  // ---- fleet search key ----------------------------------------------------
  // One Brave key upgrading EVERY agent's web search from the keyless
  // DuckDuckGo baseline (search itself is always on). Same shape as the media
  // key: write-only, injected at provision, per-agent BRAVE_API_KEY overrides.
  app.get('/v1/search-key', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const set = await keys.isSet('search');
    return { set };
  });

  app.put('/v1/search-key', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const parsed = PastedKey.safeParse(req.body ?? {});
    if (!parsed.success || !parsed.data.key.trim()) {
      return reply.code(400).send({ error: 'Paste a Brave Search API key.' });
    }
    // The search watch checks again (fleetSearch.ts, recheckSearchSoon).
    await keys.save('search', parsed.data.key.trim());
    return { set: true };
  });

  app.delete('/v1/search-key', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const r = await keys.remove('search');
    if (!r.ok) return reply.code(500).send({ error: `Couldn't remove the fleet search key (${r.error}). It is still set: try again.` });
    return { set: false };
  });

  // ---- which search the fleet uses, and whether it works (webSearch.ts) ------
  app.get('/v1/web-search', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    return search.view();
  });
  // A check spends one Brave query; it runs one at a time, however often it is pressed.
  app.post('/v1/web-search/check', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    return search.check();
  });
  // The month's searches: Brave's against what the key allows, per day, per agent, and the cost (HB-0532).
  app.get('/v1/web-search/usage', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    return search.usage();
  });
  // `mode`: which search the fleet uses. `price`: what a Brave search costs, for the usage panel's estimate.
  app.put('/v1/web-search', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const parsed = SearchChoice.safeParse(req.body ?? {});
    if (!parsed.success || (!parsed.data.mode && !parsed.data.price)) {
      return reply.code(400).send({ error: parsed.success || !parsed.error.issues.some((i) => i.path[0] === 'price') ? 'Choose auto or duckduckgo.' : 'A price is dollars per 1,000 searches (0 to 1,000) and dollars of monthly credit (0 or more).' });
    }
    return search.set(parsed.data);
  });
  // A real search in the agent, through its own settings and keys.
  app.post<{ Params: { id: string } }>('/v1/agents/:id/search-test', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    if (movedAway(agent, reply)) return reply;
    if (agent.ops) return reply.code(409).send({ error: 'The Hatchabot agent searches through Hatchabot itself: test it under Settings → AI → Fleet search key.' });
    if (agent.state !== 'RUNNING') return reply.code(409).send({ error: 'Start the agent first: this runs a real search inside it.' });
    return search.agentTest(agent as typeof agent & { runtimeRef: string });
  });

  // ---- Defaults for this machine (machineDefaults.ts): written to .env, applied at once ----
  app.get('/v1/machine-defaults', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    return defaults.view();
  });
  app.put('/v1/machine-defaults', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const body = DefaultChange.safeParse(req.body).data;
    const done = await defaults.set(String(body?.key ?? ''), String(body?.value ?? ''));
    if (!done.ok) return reply.code(done.why === 'invalid' ? 400 : 409).send({ error: done.error });
    return done.answer;
  });
}
