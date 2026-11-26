import { Transform, pipeline } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { catArgv, cleanFileName, cleanRelPath, downloadName, inlineType, tarArgv, uploadAllowed } from '../../orchestrator/files/agentFiles.js';
import { EDITABLE_FILES, type FileRefusal } from '../../orchestrator/files/coreFiles.js';
import { MAX_FILE_BYTES } from '../../orchestrator/files/snapshots.js';
import { NO_COMPRESS, type RouteContext } from '../routeContext.js';

/**
 * PUT /v1/agents/:id/files/:name (HB-0814; was a cast of the body read for `content`):
 * the file's new text. Anything else (no `content`, one that is not text, a
 * body that is not an object) keeps its words, "content required".
 */
const SaveCoreFile = z.object({ content: z.string() });

/**
 * An agent's files: the routes (HB-0808 step 13).
 *
 * Its core files read and saved from the Personality and Knowledge panes
 * (GET and PUT /v1/agents/:id/files/:name), and its home browsed (GET
 * /v1/agents/:id/fs), downloaded (GET …/fs/file, GET …/fs/archive) and
 * uploaded to (PUT …/fs/file, a raw body). The owner only: members never see
 * this, as the home holds the agent's config, tokens included. Each route
 * checks who asks, the path and the body, in that order as before, then asks
 * the agent files service (`ctx.files`, src/orchestrator/files/files.ts). A
 * download's headers and stream are made here. No hook; the raw body of an
 * upload is read by the `application/octet-stream` parser routes.ts registers
 * for the instance (its limit, HATCHABOT_FILE_MAX_MB, covers this route).
 */
export function registerFileRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { ownedAgent, busyNow } = ctx;
  const { core, home, fileMaxBytes: FILE_MAX_BYTES } = ctx.files;
  const refusal = (reply: FastifyReply, r: FileRefusal) => reply.code(r.status).send({ error: r.error });

  app.get<{ Params: { id: string; name: string } }>(
    '/v1/agents/:id/files/:name',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
      if (!EDITABLE_FILES.has(req.params.name)) return reply.code(400).send({ error: 'Not editable' });
      if (agent.state !== 'RUNNING') {
        return reply.code(409).send({ error: 'Start the agent to edit its files.' });
      }
      const r = await core.read(agent, req.params.name);
      return r.ok ? r.body : refusal(reply, r);
    },
  );

  // ---- the agent's files: browse and download (owner only, read-only) ----
  // Read-only one-shots on the volume: works stopped or archived, cannot
  // write. Paths are relative to the agent's home; cleaned here and resolved
  // again inside (src/orchestrator/files/agentFiles.ts). Members never see this:
  // the home holds the agent's config, tokens included — the owner's, like
  // the export.
  const fsAgent = (req: FastifyRequest, reply: FastifyReply, id: string, path: unknown) => {
    const agent = ownedAgent(req, id);
    if (!agent?.runtimeRef) { reply.code(404).send({ error: 'Not found' }); return undefined; }
    const rel = cleanRelPath(path);
    if (rel === undefined) { reply.code(400).send({ error: 'That is not a path inside the agent.' }); return undefined; }
    return { agent, rel };
  };

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/v1/agents/:id/fs', async (req, reply) => {
    const t = fsAgent(req, reply, req.params.id, req.query.path); if (!t) return reply;
    const r = await home.list(t.agent, t.rel);
    return r.ok ? r.body : refusal(reply, r);
  });

  /**
   * What a download is checked for before a byte streams: the agent and the path, a machine that
   * streams, and the file (or folder) there, of the kind asked for and not too big. Refused: the
   * answer is sent, and undefined comes back. The file route's check=1 answers with this alone.
   */
  const fsReadable = async (req: FastifyRequest, reply: FastifyReply, id: string, path: unknown, kind: 'file' | 'archive') => {
    const t = fsAgent(req, reply, id, path); if (!t) return undefined;
    const r = await home.readable(t.agent, t.rel, kind);
    if (!r.ok) { refusal(reply, r); return undefined; }
    return { ...t, streamFrom: r.streamFrom, size: r.size };
  };
  const fsStream = async (req: FastifyRequest, reply: FastifyReply, id: string, path: unknown, kind: 'file' | 'archive', inline = false) => {
    const t = await fsReadable(req, reply, id, path, kind); if (!t) return reply;
    const size = t.size;
    const name = downloadName(t.rel, t.agent.slug) + (kind === 'archive' ? '.tar.gz' : '');
    const stream = t.streamFrom(t.agent.runtimeRef!, kind === 'file' ? catArgv(t.rel, size) : tarArgv(t.rel));
    // Opened in the browser (the Files tab's links) when the type is one it
    // shows; always sandboxed (originless: no cookies, no scripts, no reach
    // into the app) and never sniffed, so an agent-written page cannot act
    // as this app. Anything else is a download.
    const shown = kind === 'file' && inline ? inlineType(name) : undefined;
    reply.type(shown ?? (kind === 'file' ? 'application/octet-stream' : 'application/gzip'))
      .header('content-disposition', `${shown ? 'inline' : 'attachment'}; filename="${name.replace(/"/g, '')}"`)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', 'sandbox');
    if (kind !== 'file') return reply.send(stream);
    reply.header('content-length', String(size));
    // Exactly the bytes announced: `head -c` caps a file that grew, and a file
    // that shrank meanwhile (a log rotated, a file rewritten) ends the body
    // short. Ended cleanly, a short body on a kept-alive connection was taken
    // as complete, or as the start of the next response (review R23, 2026-10-23);
    // an error here makes Fastify destroy the response instead.
    let sent = 0;
    const exact = new Transform({
      transform(chunk: Buffer, _enc, cb) { sent += chunk.length; cb(null, chunk); },
      flush(cb) { cb(sent < size ? new Error(`${name} shrank while it was being read (${sent} of ${size} bytes)`) : null); },
    });
    pipeline(stream, exact, () => { /* the error reaches the response through `exact` */ });
    return reply.send(exact);
  };
  // check=1: whether the file may be read now, answered with what the download checks first
  // (there, a file, not too big: its own refusal) and none of its bytes. The Files tab asks it
  // before a PDF frame or a tab, and after a picture, sound or video fails, and says the reason.
  // By here the gates have passed: at the public address, a second factor that lapsed got its
  // 401 (secondFactor 'step-up') before this, which the page answers by asking for it.
  app.get<{ Params: { id: string }; Querystring: { path?: string; inline?: string; check?: string } }>('/v1/agents/:id/fs/file', NO_COMPRESS, async (req, reply) => {
    if (req.query.check === '1') return (await fsReadable(req, reply, req.params.id, req.query.path, 'file')) ? reply.code(204).send() : reply;
    return fsStream(req, reply, req.params.id, req.query.path, 'file', req.query.inline === '1');
  });

  /** Upload one file into a folder of the agent's home (raw body). */
  app.put<{ Params: { id: string }; Querystring: { path?: string; name?: string; overwrite?: string } }>('/v1/agents/:id/fs/file', async (req, reply) => {
    const t = fsAgent(req, reply, req.params.id, req.query.path); if (!t) return reply;
    const name = cleanFileName(req.query.name);
    if (!name) return reply.code(400).send({ error: 'Give the file a plain name (no folders in it).' });
    if (!uploadAllowed(t.rel, t.agent.slug, name)) {
      return reply.code(400).send({ error: uploadAllowed(t.rel, t.agent.slug)
        ? `${name} is OpenClaw's own live state (its conversations or logins) — an upload cannot replace it. Give the file another name.`
        : "Files go in the agent's workspace or anywhere outside .openclaw — not into OpenClaw's own state." });
    }
    const body = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: 'Send the file as the request body (application/octet-stream).' });
    if (body.length > FILE_MAX_BYTES) return reply.code(413).send({ error: `Too big (${Math.round(body.length / 1048576)} MB; the limit is ${FILE_MAX_BYTES / 1048576} MB — HATCHABOT_FILE_MAX_MB).` });
    // The busy guard: an export or restore must not interleave with a write.
    if (busyNow(t.agent, reply)) return reply;
    const r = await home.upload(t.agent, t.rel, name, body, { overwrite: req.query.overwrite === '1', owned: (agentId) => ownedAgent(req, agentId) });
    return r.ok ? r.body : refusal(reply, r);
  });
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/v1/agents/:id/fs/archive', NO_COMPRESS, (req, reply) => fsStream(req, reply, req.params.id, req.query.path, 'archive'));

  app.put<{ Params: { id: string; name: string } }>(
    '/v1/agents/:id/files/:name',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
      if (!EDITABLE_FILES.has(req.params.name)) return reply.code(400).send({ error: 'Not editable' });
      const parsed = SaveCoreFile.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'content required' });
      const { content } = parsed.data;
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
        return reply.code(413).send({ error: `Too large — core files cap at ${MAX_FILE_BYTES / 1024}KB.` });
      }
      if (agent.state !== 'RUNNING') {
        return reply.code(409).send({ error: 'Start the agent to edit its files.' });
      }
      // Hold the busy guard for the write: an export/migrate/restore that tars
      // or replaces this same volume must not interleave a torn edit.
      if (busyNow(agent, reply)) return reply;
      const r = await core.save(agent, req.params.name, content);
      return r.ok ? r.body : refusal(reply, r);
    },
  );
}
