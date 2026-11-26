import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { boundInput, type ReportInput } from '../../orchestrator/diagnostics/problemReport.js';
import type { ReportCaller } from '../../orchestrator/diagnostics/problemReports.js';
import { ownerIdOf } from '../principal.js';
import { zodMessage, type RouteContext } from '../routeContext.js';

/**
 * POST /v1/problem-reports (HB-0814): what the person, or their Hatchabot
 * agent, wrote. Each field is text or left out; `confidence` and `by` keep
 * their own reading (anything but the words they name is none, and a
 * person). No body is an empty one.
 */
const NewReport = z.object({
  title: z.string().nullish(),
  whatHappened: z.string().nullish(),
  steps: z.string().nullish(),
  diagnosis: z.string().nullish(),
  confidence: z.string().nullish(),
  suggestedPatch: z.string().nullish(),
  by: z.string().nullish(),
  agent: z.string().nullish(),
}).nullish();
/** PATCH /v1/problem-reports/:id (HB-0814): a person's edit of their draft; a field left out is kept. */
const EditReport = z.object({ title: z.string().nullish(), body: z.string().nullish() }).nullish();

/**
 * Report a problem: the routes (HB-0808, docs/field-reports.md).
 *
 * The facts a report carries (GET /v1/diagnostics), the playbook entries a
 * symptom most likely is (GET /v1/known-problems), the installed source
 * read-only (GET /v1/source, GET /v1/source/search), and a private draft per
 * person (/v1/problem-reports…). Nothing here sends anything: the person
 * opens the GitHub issue themselves from the draft.
 *
 * Each route reads its request and words the answer; the facts, the masking
 * and the drafts are the Report a problem service's (`ctx.problemReports`,
 * src/orchestrator/diagnostics/problemReports.ts). No hook. Signed in only
 * (src/api/publicRoutes.ts).
 */
export function registerProblemReportRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { ownedAgent, ownsLocalHost } = ctx;
  const reports = ctx.problemReports;
  /** Who is asking, as a report needs it. */
  const callerOf = (req: FastifyRequest): ReportCaller => ({
    ownerId: ownerIdOf(req),
    ownsMachine: () => ownsLocalHost(req),
    owned: (agentId) => ownedAgent(req, agentId),
  });

  app.get<{ Querystring: { agent?: string } }>('/v1/diagnostics', async (req) => reports.reportFacts(callerOf(req), req.query.agent));
  // The playbook entries a symptom most likely is, in full (check_known_problem).
  app.get<{ Querystring: { symptom?: string } }>('/v1/known-problems', async (req, reply) => {
    const symptom = String(req.query.symptom ?? '').slice(0, 4000);
    if (symptom.trim().length < 8) return reply.code(400).send({ error: 'Describe the symptom: the exact error text when there is one.' });
    return reports.knownFor(symptom);
  });

  app.get<{ Querystring: { path?: string; from?: string; to?: string } }>('/v1/source', async (req, reply) => {
    try { return reports.read(String(req.query.path ?? ''), Number(req.query.from ?? 1), req.query.to ? Number(req.query.to) : undefined); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  // Plain text unless regex=1; bounded in a worker either way (problemReport.ts SEARCH_LIMITS, 2026-10-09).
  app.get<{ Querystring: { q?: string; under?: string; regex?: string } }>('/v1/source/search', async (req, reply) => {
    try { return await reports.search(String(req.query.q ?? ''), req.query.under || undefined, req.query.regex === '1' || req.query.regex === 'true', ownerIdOf(req)); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.get('/v1/problem-reports', async (req) =>
    reports.list(ownerIdOf(req)));
  app.get<{ Params: { id: string } }>('/v1/problem-reports/:id', async (req, reply) => {
    const r = await reports.get(callerOf(req), req.params.id);
    return r ?? reply.code(404).send({ error: 'Not found' });
  });
  app.post('/v1/problem-reports', async (req, reply) => {
    const parsed = NewReport.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const b = parsed.data ?? {};
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? boundInput(v, max) : undefined);
    const title = str(b.title, 200), whatHappened = str(b.whatHappened, 8000);
    if (!title || !whatHappened) return reply.code(400).send({ error: 'A title and what happened, in a sentence or two.' });
    const confidence = b.confidence === 'low' || b.confidence === 'medium' || b.confidence === 'high' ? b.confidence : undefined;
    const agentId = typeof b.agent === 'string' && b.agent ? b.agent : undefined;
    const input: ReportInput = {
      title, whatHappened, steps: str(b.steps, 4000), diagnosis: str(b.diagnosis, 10_000), confidence,
      suggestedPatch: str(b.suggestedPatch, 24_000), by: b.by === 'agent' ? 'agent' : 'person',
    };
    return reports.create(callerOf(req), input, agentId);
  });
  app.patch<{ Params: { id: string } }>('/v1/problem-reports/:id', async (req, reply) => {
    const parsed = EditReport.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const edited = await reports.edit(callerOf(req), req.params.id, parsed.data ?? {});
    return edited ?? reply.code(404).send({ error: 'Not found' });
  });
  app.post<{ Params: { id: string } }>('/v1/problem-reports/:id/sent', async (req, reply) => {
    if (!reports.markSent(ownerIdOf(req), req.params.id)) return reply.code(404).send({ error: 'Not found' });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/v1/problem-reports/:id', async (req, reply) =>
    reports.remove(ownerIdOf(req), req.params.id) ? { ok: true } : reply.code(404).send({ error: 'Not found' }));
}
