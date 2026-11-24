import type { FastifyInstance } from 'fastify';
import { INSPECTABLE_FILES, InspectReadError, listInspectableFiles, readInspectableFile, readTranscript } from '../orchestrator/diagnostics/inspect.js';
import { queryLimit, type RouteContext } from './routeContext.js';

/**
 * Read-only inspection (archived / stopped agents).
 *
 * Look back at what an agent knew and discussed WITHOUT running its
 * container — the volume survives archiving even though the bot went back
 * to the pool. Everything here reads the volume through a one-shot mount
 * (execShellOnVolume); nothing writes or starts anything.
 *
 * The first feature file written against RouteContext (HB-0806): it keeps no
 * state of its own, and asks the context only who owns the agent and where
 * it runs.
 */
export function registerInspectRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { ownedAgent, providerFor } = ctx;

  app.get<{ Params: { id: string } }>('/v1/agents/:id/inspect', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if (!agent.runtimeRef) return reply.code(409).send({ error: 'This agent has no stored volume to inspect.' });
    const provider = providerFor(agent.hostId);
    // A read that failed is said, not shown as an agent with no files (#151).
    // A chat history that cannot be read does not hide the files: its count
    // is null, and the Chat history tab says why when it is opened.
    let files: Awaited<ReturnType<typeof listInspectableFiles>>, transcriptTurns: number | null;
    try {
      [files, transcriptTurns] = await Promise.all([
        listInspectableFiles(provider, agent.runtimeRef, agent.slug),
        readTranscript(provider, agent.runtimeRef, agent.slug, { maxTurns: 0 }).then((t) => t.totalTurns, () => null),
      ]);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof InspectReadError ? err.message : "Couldn't read the agent's stored files." });
    }
    return { files, transcriptTurns, name: agent.name, state: agent.state };
  });

  app.get<{ Params: { id: string; name: string } }>('/v1/agents/:id/inspect/file/:name', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if (!agent.runtimeRef) return reply.code(409).send({ error: 'This agent has no stored volume to inspect.' });
    if (!(INSPECTABLE_FILES as readonly string[]).includes(req.params.name)) {
      return reply.code(400).send({ error: 'Not an inspectable file.' });
    }
    let file: Awaited<ReturnType<typeof readInspectableFile>>;
    try { file = await readInspectableFile(providerFor(agent.hostId), agent.runtimeRef, agent.slug, req.params.name); }
    catch (err) { return reply.code(502).send({ error: err instanceof InspectReadError ? err.message : "Couldn't read the agent's stored files." }); }
    if (!file) return reply.code(404).send({ error: 'No such file on the volume.' });
    return file;
  });

  app.get<{ Params: { id: string }; Querystring: { maxTurns?: string } }>('/v1/agents/:id/inspect/transcript', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if (!agent.runtimeRef) return reply.code(409).send({ error: 'This agent has no stored volume to inspect.' });
    const maxTurns = queryLimit(req.query.maxTurns, 400, 2000);
    try { return await readTranscript(providerFor(agent.hostId), agent.runtimeRef, agent.slug, { maxTurns }); }
    catch (err) { return reply.code(502).send({ error: err instanceof InspectReadError ? err.message : "Couldn't read the agent's stored files." }); }
  });
}
