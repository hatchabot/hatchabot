import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentBusyError } from '../orchestrator/lifecycle/busy.js';
import { MigrateError, MOVE_HEADER, moveIdFrom } from '../orchestrator/transfer/migrate.js';
import { publicOperation, runInBackground } from '../orchestrator/lifecycle/operations.js';
import { ImageDecisionNeeded, ImportCleanupPending, TransferError } from '../orchestrator/transfer/transfer.js';
import { SourceGoneError } from '../store/store.js';
import { ownerIdOf, principalOf } from './principal.js';
import { HOST_GOING, IMPORT_HEAD_MAX_BYTES, IMPORT_WITH_VALUES, NO_COMPRESS, zodMessage, type RouteContext } from './routeContext.js';

/** The manager lives with its machine: its door, network and tools are this machine's (night review, 2026-09-27). */
const OPS_STAYS_HERE = 'The Hatchabot agent stays on this machine: its locked-down network and its tools belong here. Set one up on the other machine instead.';

/** POST /v1/peers: another Hatchabot server, and an access token minted on it. */
const NewPeer = z
  .object({
    name: z.string().trim().min(1).max(64),
    url: z.string().url(),
    /** An access token minted on THAT server (⚙ AI → CLI access). */
    token: z.string().min(1),
  });
/** POST /v1/agents/preflight: what another server tells us before it sends an agent here. */
const MovePreflight = z
  .object({
    slug: z.string().min(1).max(64),
    accountId: z.string().min(1).max(64),
    vendor: z.string().max(32).optional(),
    // Zod strips unknown keys — omitting this silently discarded the
    // sender's folder list and made the missing-folders refusal dead
    // code for every real (HTTP) migration.
    sharedPaths: z.array(z.string().max(512)).max(40).optional(),
    // The source's runtime-image OpenClaw version, so we can refuse a
    // DOWNGRADE (our image older than the volume's config schema).
    openclawVersion: z.string().max(64).optional(),
    // A source here the owner chose for it (a refusal's sourceChoice).
    aiProfileId: z.string().min(1).max(64).optional(),
  });
/**
 * POST /v1/agents/:id/move-host (HB-0814). `hostId` keeps its own check and
 * words ("Unknown host"); `dropPin`: move it onto the other machine's
 * default image. No body is an empty one.
 */
const MoveHost = z.object({ hostId: z.unknown().optional(), dropPin: z.boolean().nullish() }).nullish();
/**
 * POST /v1/agents/:id/rehost (HB-0814): the server, whether a pinned image
 * may be dropped, and a source there to run on. `aiProfileId` keeps its own
 * check and words.
 */
const Rehost = z.object({ peerId: z.string().nullish(), allowDroppedPin: z.boolean().nullish(), aiProfileId: z.unknown().optional() }).nullish();
/** POST /v1/agents/:id/send (HB-0814): the recipient's address and a note. */
const SendShare = z.object({ toEmail: z.string().nullish(), message: z.string().nullish() }).nullish();
/** Answers to a template's setup fields ({{key}} → value). */
const SetupValues = z
  .record(z.string().max(64), z.string().max(2000))
  .refine((r) => Object.keys(r).length <= 24);
/**
 * POST /v1/inbox/:id/accept (HB-0814): its name, source and machine here, and
 * the answers to its setup fields (`values`, which keeps its own check and
 * words).
 */
const AcceptShare = z.object({ name: z.string().nullish(), aiProfileId: z.string().nullish(), hostId: z.string().nullish(), values: z.unknown().optional() }).nullish();
/** POST /v1/agents/:id/clone (HB-0814): its name, and `telegram: false` for a copy with no bot. */
const CloneBody = z.object({ name: z.string().nullish(), telegram: z.unknown().optional() }).nullish();
/** POST /v1/agents/:id/derive (HB-0814): the child's name and its setup answers (`values`, which keeps its own check and words). */
const DeriveBody = z.object({ name: z.string().nullish(), values: z.unknown().optional() }).nullish();

/** A body of the wrong shape, read where the request was first read: its 400. */
class BodyRefused extends Error {}

/**
 * Moves, import and export: the routes (HB-0808 step 12, docs/moving-agents.md).
 *
 * Moving an agent to another machine of this install (move-host) or to
 * another Hatchabot (rehost), the servers this account knows (/v1/peers), the
 * two questions another server asks (POST /v1/agents/preflight before it
 * sends an agent here, GET /v1/moves/:id after); the whole agent as a file
 * (GET /v1/agents/:id/backup) and back (POST /v1/agents/restore, and
 * POST /v1/agents/import for either kind of file); a template (GET
 * /v1/agents/:id/export) and what it would mention (…/export/scan); sending
 * one to another account's inbox and the inbox; clone and derive.
 *
 * Who may ask, the 404, the manager's, moved, busy and host checks, and every
 * answer's words are here, in the order they have always run; the rules are
 * the moves, import and export service's (`ctx.transfers`,
 * src/orchestrator/transfer/transfers.ts). No hook. The body parsers an
 * import reads (`application/octet-stream`, IMPORT_WITH_VALUES) are the
 * instance's, in routes.ts.
 */
export function registerTransferRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { deps, store, trace, ownedAgent, movedAway, busyNow, capProblem, capRowMade, publicAgent, kickProvision, waitAsked, accepted, backgroundError, hostBeingRemoved } = ctx;
  const { moves, copies, inbox } = ctx.transfers;

  const imageDecisionBody = (e: ImageDecisionNeeded) => ({
    error: e.userMessage,
    code: 'image_decision',
    image: e.image,
    // What would run, shown before anyone agrees to it.
    recipe: e.recipe ? { base: e.recipe.base, packages: e.recipe.packages, lines: e.recipe.lines ?? '' } : undefined,
    problem: e.problem,
    mayBuild: e.mayBuild && !e.problem,
  });

  // ---- peers & migration ---------------------------------------------------

  app.get('/v1/peers', async (req) =>
    moves.peers.list(ownerIdOf(req)),
  );

  app.post(
    '/v1/peers',
    async (req, reply) => {
      const parsed = NewPeer
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      const { name, url, token } = parsed.data;
      const refused = await moves.peers.refusal(url, token);
      if (refused) return reply.code(400).send({ error: refused });
      return reply.code(201).send(await moves.peers.add(ownerIdOf(req), { name, url, token }));
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/peers/:id', async (req, reply) => {
    try {
      if (!(await moves.peers.remove(ownerIdOf(req), req.params.id))) return reply.code(404).send({ error: 'Not found' });
    } catch (err) {
      // Its token could not be removed: it is still listed, to be forgotten again (HB-1024).
      if (err instanceof TransferError) return reply.code(500).send({ error: err.userMessage });
      throw err;
    }
    return { deleted: true };
  });

  /** Asked BY another server before it sends us an agent. Changes nothing. */
  app.post(
    '/v1/agents/preflight',
    async (req, reply) => {
      const parsed = MovePreflight
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      return moves.answerPreflight(ownerIdOf(req), parsed.data);
    },
  );

  // Move an agent to another host on THIS server (local ⇄ runner). Same agent
  // record, same bot, same members — only the Docker daemon changes. Distinct
  // from Rehost below, which ships the agent to another Hatchabot server (a
  // Mesh peer) and tombstones the copy here.
  app.post<{ Params: { id: string } }>(
    '/v1/agents/:id/move-host',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (agent.ops) return reply.code(409).send({ error: OPS_STAYS_HERE });
      if (movedAway(agent, reply)) return reply;
      // A move or import interrupted by a restart, or held for a choice, first.
      // Then anything under way, an archive's checkpoint turn among them: the
      // move's stop would cut it off and defeat the archive (HB-0417).
      if (busyNow(agent, reply)) return reply;
      const body = MoveHost.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: zodMessage(body.error) });
      const targetId = z.string().min(1).safeParse(body.data?.hostId);
      const host = targetId.success ? store.getHost(targetId.data) : undefined;
      if (!host || (host.ownerId !== ownerIdOf(req) && host.kind !== 'local')) {
        return reply.code(400).send({ error: 'Unknown host' });
      }
      if (hostBeingRemoved(host.id)) return reply.code(409).send({ error: HOST_GOING });
      if (host.id === agent.hostId) {
        return reply.code(400).send({ error: 'The agent is already on that host.' });
      }
      // Folders are bind mounts of this machine's disk, which a runner cannot
      // mount: said before anything is stopped (moves.ts).
      const folders = moves.foldersStayHere(agent, host);
      if (folders) return reply.code(409).send(folders);
      // A pinned image lives on the daemon that built it. A runner without it
      // failed deep inside the seed with docker's "pull access denied", after
      // the agent had already been stopped (2026-09-22). Say so up front, and
      // let the caller choose the runner's default image instead.
      // dropPin used to take effect here, before the checks below — a move
      // refused a line later left the agent unpinned where it stood, and its
      // next rebuild silently lost its packages (26th audit). It applies at
      // the end, once nothing else can refuse.
      const dropPin = !!agent.image && body.data?.dropPin === true;
      if (agent.image && !dropPin) {
        {
          // The pin travels as its recipe: rebuild the image there if it is
          // missing (base pulled if need be, then the extra packages or the
          // derived lines). Only if that can't be done does the owner choose.
          // The agent is busy for the build: a Rebuild or Delete landing in
          // those minutes used to proceed underneath it.
          trace(agent.id)('image.ensure', { image: agent.image, on: host.id });
          // Not over another operation's flag: clearBusy below would have
          // cleared a running rebuild's or move's (use-case audit, 2026-09-27).
          if (busyNow(agent, reply)) return reply;
          const got = await moves.ensurePinnedImage(agent, agent.image, host);
          if (!got.ok) {
            // Another image of that name there is not replaced under whoever runs it (HB-1325).
            const why = got.differs
              ? `"${agent.name}" is pinned to the image ${agent.image}, and ${host.name} has a different image of that name (${got.problem}), which is left as it is. `
              : `"${agent.name}" is pinned to the image ${agent.image}, which ${host.name} does not have, and it couldn't be rebuilt there (${got.problem}). `;
            return reply.code(409).send({
              error: why +
                'Move it on that runner\'s default image instead — its extra packages will be missing there.',
              code: 'pinned_image_missing',
              image: agent.image,
            });
          }
          if (got.built) trace(agent.id)('image.rebuilt_from_recipe', { image: agent.image, on: host.id });
        }
      }
      // Same split as create: a machine-login Max profile mounts THIS box's
      // ~/.claude, which can't reach a runner; a setup-token one travels.
      const profile = store.getAIProfile(agent.aiProfileId);
      if (profile?.kind === 'subscription' && host.kind !== 'local' && !profile.secretRef) {
        return reply.code(400).send({
          error:
            "This agent's Claude Max source uses this machine's login, which can't reach a runner. " +
            'Switch it to a setup-token Max source or an API key first, then move it.',
        });
      }
      // No way back across the 2026.8 line on the other machine either: a
      // runner's own :latest may still be 2026.7, which cannot read a volume
      // migrated here (night review, 2026-09-28). Unknown versions pass. Up
      // across the line is the normal path (a 2026.7 volume is healed on its
      // build there). This was inverted — it refused the upward move and let
      // the downward one through — found 2026-10-07, as the promote guard's was.
      const down = await moves.crossesDown(agent, host, dropPin);
      if (down) {
        return reply.code(409).send({ error: `This agent runs OpenClaw ${down.running}; ${host.name} would run ${down.there}, which cannot read its data. Copy this machine's image there first (Settings → Hosts → Check, then Install image).` });
      }
      // Preflight waits for machines and sometimes an image build. The
      // settings it checked must still describe the move that will run.
      // Checked once here and once under the move's lock after daemon probes.
      const preflightRefusal = moves.preflightRefusal(agent, host, () => ownedAgent(req, agent.id));
      const changed = preflightRefusal();
      if (changed) return reply.code(409).send({ error: changed });
      // Every check has passed; a busy agent is the one refusal left, judged again
      // after the waits above, with none from here to the move's lock: an Archive
      // pressed meanwhile has begun its checkpoint turn, and moveHost.ts does not
      // look at that (HB-0417). The pin itself is dropped by the move, on its
      // record (moveHost.ts).
      if (busyNow(agent, reply)) return reply;
      // The runner may have been removed during the awaits above: refused as
      // that, not as a server error from its provider (HB-0275). From here to
      // the move's operation is one tick, so a removal still running sees it.
      if (!store.getHost(host.id) || hostBeingRemoved(host.id)) return reply.code(409).send({ error: HOST_GOING });
      // The move is recorded as an operation (operations.ts) and answers 202
      // with it once it has begun; the move goes on in the background
      // (phase 3). ?wait=1: the old answer, when it is over.
      let operation: string | undefined;
      // A move that did not happen keeps its pin (moveHost.ts puts it back
      // when it undoes the move, after a restart too): the next rebuild on the
      // old host would otherwise drop the image's extra packages.
      const run = (onOperation?: (id: string) => void) => moves.moveToHost(agent, host, {
        requestedBy: ownerIdOf(req), onOperation: (id) => { operation = id; onOperation?.(id); }, dropPin,
        preflightRefusal,
      });
      try {
        if (waitAsked(req)) return { ...publicAgent(await run()), operation };
        const bg = await runInBackground(store, run, { onError: backgroundError });
        return bg.started ? accepted(reply, bg.opId) : { ...publicAgent(bg.value), operation };
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage, operation });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/agents/:id/rehost',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (agent.ops) return reply.code(409).send({ error: OPS_STAYS_HERE });
      // A tombstoned copy still holds the live bot token — migrating it again
      // ships that token to a third server and mints a second poller, the
      // exact thing the tombstone exists to prevent.
      if (movedAway(agent, reply)) return reply;
      if (busyNow(agent, reply)) return reply; // the same as a move to another machine (HB-0417)
      const body = Rehost.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: zodMessage(body.error) });
      const peerId = body.data?.peerId;
      const peer = peerId && store.getPeer(ownerIdOf(req), peerId);
      if (!peer) return reply.code(400).send({ error: 'Unknown server' });
      // Image pins don't travel — moving a pinned agent silently drops its
      // extra packages, so it's refused unless the caller states the choice.
      const allowDroppedPin = body.data?.allowDroppedPin === true;
      // A source on the other server to run on: the one its refusal offered
      // (sourceChoice) when the agent would land on another vendor's.
      const aiProfileId = body.data?.aiProfileId;
      if (aiProfileId !== undefined && (typeof aiProfileId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(aiProfileId))) {
        return reply.code(400).send({ error: 'aiProfileId must be the id of an AI source on that server' });
      }
      let operation: string | undefined;
      const run = (onOperation?: (id: string) => void) => moves.rehost(
        agent,
        peer,
        { allowDroppedPin, ...(aiProfileId ? { aiProfileId } : {}), requestedBy: ownerIdOf(req), onOperation: (id) => { operation = id; onOperation?.(id); } },
      );
      try {
        if (waitAsked(req)) return await run();
        // 202 once the other server has said yes to the preflight (nothing
        // has stopped before that, so its refusal is still this answer); the
        // export, the transfer and the check go on in the background.
        const bg = await runInBackground(store, run, { readyAt: 'preflight-ok', onError: backgroundError });
        return bg.started ? accepted(reply, bg.opId) : bg.value;
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof MigrateError) return reply.code(400).send({ error: err.userMessage, operation, ...(err.sourceChoice ? { code: 'source_choice', sourceChoice: err.sourceChoice } : {}) });
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage, operation });
        throw err;
      }
    },
  );

  // ---- export & import (agent portability) ---------------------------------

  // The archive contains the bot token — it IS the agent's identity — so the
  // download is a credential. The export leaves the agent STOPPED here: once
  // it's imported elsewhere, two pollers on one bot would flip-flop.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/backup', NO_COMPRESS, async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    // A moved-away copy's archive carries the live bot token — refuse it.
    if (movedAway(agent, reply)) return reply;
    if (busyNow(agent, reply)) return reply;
    try {
      // Under the busy flag for the whole export (copies.ts download).
      const { filename, data, dropped } = await copies.download(agent);
      // The channels the archive leaves behind, for a client that can read headers (the CLI).
      if (dropped.length) reply.header('x-hatchabot-dropped', dropped.join(','));
      return reply
        .type('application/octet-stream')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(data);
    } catch (err) {
      if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
      if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
      throw err;
    }
  });

  // Synchronous unless the caller asks `?async=1` (the CLI's `restore`): the
  // other Hatchabot's side of a move to it (migrate.ts) posts here and reads
  // the agent from the answer — a 202 would read as "no answer" and hold the
  // move. Its requests carry no marker of their own, and older servers post
  // too, so the background is the opt-in, never the default.
  app.post<{ Querystring: { aiProfileId?: string; hostId?: string; image?: string; async?: string } }>(
    '/v1/agents/restore',
    async (req, reply) => {
      { const capErr = capProblem(req); if (capErr) return reply.code(429).send({ error: capErr }); }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: 'Send the .hatchabot file as the request body.' });
      }
      const ownerId = ownerIdOf(req);
      // Resolve the host up front so the right provider handles the restore.
      const hosts = store.listHosts(ownerId);
      const host = req.query.hostId
        ? hosts.find((h) => h.id === req.query.hostId)
        : (hosts.find((h) => h.kind === 'local') ?? hosts[0]);
      if (!host) return reply.code(400).send({ error: 'No host available to import onto.' });
      if (hostBeingRemoved(host.id)) return reply.code(409).send({ error: HOST_GOING });
      if (req.query.aiProfileId) {
        const p = store.getAIProfile(req.query.aiProfileId);
        if (!p || (p.ownerId !== ownerId && !p.shared)) {
          return reply.code(400).send({ error: 'Unknown AI profile' });
        }
      }
      let operation: string | undefined;
      // A move from another Hatchabot names itself: recorded now, before the
      // import awaits anything, so GET /v1/moves/:id can answer for it while
      // it has no agent row yet (issue #19, 2026-10-09).
      const receipt = copies.receiveMove(req.headers[MOVE_HEADER], ownerId);
      // Not held while it runs (minutes for a large one, and the source's
      // delete would be refused as long): one deleted meanwhile is refused where the
      // agent is written, before its operation begins, so it is this
      // request's own answer (409), as is one gone by the look above (HB-0570).
      const run = (onOperation?: (id: string) => void) => copies.importCopy(
        host,
        body,
        { ownerId, aiProfileId: req.query.aiProfileId, image: req.query.image,
          onOperation: (id) => { capRowMade(req); operation = id; receipt.operation(id); onOperation?.(id); } },
      ).then(
        (agent) => { receipt.finished('landed'); return agent; },
        (err: unknown) => { if (!(err instanceof ImportCleanupPending)) receipt.finished('failed'); throw err; },
      );
      try {
        if (req.query.async === '1') {
          const bg = await runInBackground(store, run, { onError: backgroundError });
          if (bg.started) return accepted(reply, bg.opId);
          return reply.code(201).send({ ...publicAgent(bg.value), operation });
        }
        const agent = await run();
        return reply.code(201).send({ ...publicAgent(agent), operation });
      } catch (err) {
        if (err instanceof ImageDecisionNeeded) return reply.code(409).send(imageDecisionBody(err));
        if (err instanceof ImportCleanupPending) return reply.code(503).send({ error: err.message, operation });
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage, operation });
        if (err instanceof SourceGoneError) return reply.code(409).send({ error: err.userMessage, operation });
        throw err;
      }
    },
  );

  // The other Hatchabot's question after a move's restore gave no answer:
  // what became of THAT import (moveState). Read-only, and every id gets an
  // answer — `unknown` for one never received — so a 404 means a server
  // older than this route (the mover then reads the agent list instead).
  app.get<{ Params: { id: string } }>('/v1/moves/:id', async (req) => {
    const id = moveIdFrom(req.params.id);
    return { move: id ?? null, state: id ? moves.moveState(id, ownerIdOf(req)) : 'unknown' };
  });

  // ---- shareable template (Export / Import) -------------------------------
  // A copy of its instructions and scheduled tasks, without its bot, members
  // or conversations. Not safe to email unread: agents write names and
  // addresses into their own instructions, so what the copy mentions travels
  // with it (x-hatchabot-personal) and the page shows it before saving
  // (2026-09-30). Import stands up a FRESH agent that provisions its own bot
  // (pool or paste), owned by the importer.
  app.get<{ Params: { id: string }; Querystring: { excludeMemory?: string } }>(
    '/v1/agents/:id/export',
    NO_COMPRESS,
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (agent.ops) return reply.code(409).send({ error: OPS_STAYS_HERE });
      if (busyNow(agent, reply)) return reply;
      try {
        const { filename, data, personal, edited } = await copies.template(agent, req.query.excludeMemory === undefined);
        // Header-sized: the first 20 places, the rest counted. `edited`: the
        // files changed outside the Files editor, which the copy carries
        // without those changes (HB-0117).
        const brief = { ...personal, hits: personal.hits.slice(0, 20), more: personal.more + Math.max(0, personal.hits.length - 20), edited };
        return reply
          .type('application/octet-stream')
          .header('content-disposition', `attachment; filename="${filename}"`)
          .header('x-hatchabot-personal', encodeURIComponent(JSON.stringify(brief)))
          .send(data);
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // What a copy would mention — email addresses, phone numbers, key-shaped
  // strings, and where — without making it. The Send dialog shows it before
  // anything leaves (2026-09-30).
  app.get<{ Params: { id: string }; Querystring: { excludeMemory?: string } }>(
    '/v1/agents/:id/export/scan',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (agent.ops) return reply.code(409).send({ error: OPS_STAYS_HERE });
      if (busyNow(agent, reply)) return reply;
      try {
        const { personal, edited } = await copies.scan(agent, req.query.excludeMemory === undefined);
        return { ...personal, edited };
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // ---- inbox sharing: hand an agent to another user in-app -----------------

  /**
   * Send an agent to another user's inbox — a secret-free TEMPLATE (same bytes
   * as a shared file), delivered in-app instead of by email. The recipient
   * imports it as a fresh agent they own, with their own bot.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/agents/:id/send',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (agent.ops) return reply.code(409).send({ error: OPS_STAYS_HERE });
      if (busyNow(agent, reply)) return reply;
      const body = SendShare.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: zodMessage(body.error) });
      const toEmail = body.data?.toEmail?.trim();
      const message = body.data?.message?.trim();
      // Capped before the regex: on a 1 MiB non-address the pattern backtracked for seconds (CodeQL js/polynomial-redos, 2026-10-24).
      if (!toEmail || toEmail.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail)) {
        return reply.code(400).send({ error: 'A valid recipient email is required.' });
      }
      // Shares bind to the recipient by EMAIL on their sign-in. In password
      // mode nobody has one, so a share would sit unclaimable forever — refuse
      // up front instead of silently swallowing the agent (audit 2026-09-02).
      if (deps.authMode !== 'identity') {
        return reply.code(400).send({
          error: 'Sending an agent to someone in the app needs Google sign-in (HATCHABOT_AUTH=identity) — use Share to a file instead.',
        });
      }
      const me = principalOf(req);
      if (me.email && toEmail.toLowerCase() === me.email.toLowerCase()) {
        return reply.code(400).send({ error: "That's your own address — use Clone to copy an agent to yourself." });
      }
      try {
        if ((await inbox.send(agent, me, toEmail, message)) === 'too-large') {
          return reply.code(413).send({ error: 'That agent is too large to send in-app — use Share to a file instead.' });
        }
        return reply.code(201).send({ sent: true, to: toEmail });
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  /** Agents waiting in my inbox. */
  app.get('/v1/inbox', async (req) => {
    const me = principalOf(req);
    const shares = await inbox.list(me);
    return { shares };
  });

  /** Import a received agent — stands up a fresh agent I own (my bot, my people). */
  app.post<{ Params: { id: string } }>(
    '/v1/inbox/:id/accept',
    async (req, reply) => {
      { const capErr = capProblem(req); if (capErr) return reply.code(429).send({ error: capErr }); }
      const me = principalOf(req);
      const share = store.getShareFor(req.params.id, me.ownerId, me.email);
      if (!share) return reply.code(404).send({ error: 'Not found' });
      const parsed = AcceptShare.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      const body = {
        name: parsed.data?.name ?? undefined, aiProfileId: parsed.data?.aiProfileId ?? undefined, hostId: parsed.data?.hostId ?? undefined,
        /** Answers to the template's setup fields ({{key}} → value). */
        values: parsed.data?.values,
      };
      const vals = SetupValues
        .optional()
        .safeParse(body.values);
      if (!vals.success) return reply.code(400).send({ error: 'Malformed setup values.' });
      if ((body.name?.trim().length ?? 0) > 64) return reply.code(400).send({ error: 'Names cap at 64 characters.' });
      // The host must be one of the caller's before a provider is built for it (26th audit).
      if (body.hostId && !store.listHosts(me.ownerId).some((h) => h.id === body.hostId)) {
        return reply.code(400).send({ error: 'Unknown host.' });
      }
      if (body.hostId && hostBeingRemoved(body.hostId)) return reply.code(409).send({ error: HOST_GOING });
      // Claimed before the first await; a second Accept finds it taken.
      if (!store.setShareStatus(req.params.id, 'accepted', me.ownerId)) {
        return reply.code(409).send({ error: 'That share was already accepted or dismissed.' });
      }
      try {
        // Put back for another try when it fails (inbox.ts).
        const { agent, needs } = await inbox.accept(req.params.id, share, me, { ...body, values: vals.data, onRow: () => capRowMade(req) });
        return reply.code(201).send({ ...publicAgent(agent), needs });
      } catch (err) {
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  /** Turn a received agent away. */
  app.post<{ Params: { id: string } }>('/v1/inbox/:id/dismiss', async (req, reply) => {
    const me = principalOf(req);
    const share = store.getShareFor(req.params.id, me.ownerId, me.email);
    if (!share) return reply.code(404).send({ error: 'Not found' });
    store.setShareStatus(req.params.id, 'dismissed', me.ownerId);
    return { dismissed: true };
  });

  // Clone: a faithful local copy (MEMORY.md, its daily notes and USER.md — you own both copies, so
  // there's no privacy concern), with a fresh identity: new name, its own bot,
  // and only you as owner. Export → import, in one step, on this installation.
  app.post<{ Params: { id: string } }>(
    '/v1/agents/:id/clone',
    async (req, reply) => {
      { const capErr = capProblem(req); if (capErr) return reply.code(429).send({ error: capErr }); }
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (agent.ops) return reply.code(409).send({ error: 'The management agent is not a template: its files name tools only it has.' });
      if (busyNow(agent, reply)) return reply;
      try {
        // The body is read once its template is made, where the request was always read.
        const ask = () => {
          const parsed = CloneBody.safeParse(req.body);
          if (!parsed.success) throw new BodyRefused(zodMessage(parsed.error));
          return parsed.data;
        };
        const { clone, notCopied, envNotCopied, modelNotCopied, carried } = await copies.clone(agent, { owner: ownerIdOf(req), current: () => ownedAgent(req, agent.id), ask, onRow: () => capRowMade(req) });
        return reply.code(201).send({
          ...publicAgent(clone), notCopied, envNotCopied,
          // Its owner's model, which the copy's source does not offer (HB-1165).
          ...(modelNotCopied ? { modelNotCopied } : {}),
          memoryNotCopied: carried.skipped,
          ...(carried.failed ? { memoryCopyFailed: true } : {}),
        });
      } catch (err) {
        if (err instanceof BodyRefused) return reply.code(400).send({ error: err.message });
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  /**
   * Derive a CHILD from a master (the condo-fleet pattern): template export
   * (no memory — a child starts life fresh), import with the child's own
   * setup values, lineage recorded. The fleet view groups children under the
   * master; push-definition (routes.ts) is the master→children update channel.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/agents/:id/derive',
    async (req, reply) => {
      { const capErr = capProblem(req); if (capErr) return reply.code(429).send({ error: capErr }); }
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (agent.ops) return reply.code(409).send({ error: OPS_STAYS_HERE });
      if (busyNow(agent, reply)) return reply;
      const body = DeriveBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: zodMessage(body.error) });
      const name = body.data?.name?.trim();
      if (!name) return reply.code(400).send({ error: 'Name the child agent.' });
      if (name.length > 64) return reply.code(400).send({ error: 'Names cap at 64 characters.' });
      const vals = SetupValues
        .optional()
        .safeParse(body.data?.values);
      if (!vals.success) return reply.code(400).send({ error: 'Malformed setup values.' });
      try {
        const child = await copies.derive(agent, { ownerId: ownerIdOf(req), name, values: vals.data, onRow: () => capRowMade(req) });
        return reply.code(201).send(publicAgent(store.getAgent(child.id)!));
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // Import: one entry point for any .hatchabot file. It sniffs the archive's
  // format and does the right thing — a template becomes a fresh agent, a full
  // copy (a Download) is restored as the same agent. The /restore route above
  // stays for the CLI's explicit `restore` verb.
  app.post<{ Querystring: { aiProfileId?: string; hostId?: string; name?: string; values?: string; image?: string; telegram?: string } }>(
    '/v1/agents/import',
    async (req, reply) => {
      { const capErr = capProblem(req); if (capErr) return reply.code(429).send({ error: capErr }); }
      /** A full copy's import operation (operations.ts), returned either way. */
      let operation: string | undefined;
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return reply.code(400).send({ error: 'Send the .hatchabot file as the request body.' });
      }
      let body: Buffer = req.body;
      // Setup-field answers ride ahead of the file in the body (IMPORT_WITH_VALUES,
      // HB-0093), or, from older pages and scripts, in `?values=`.
      // Phase 2a values are plain text — never secrets (those are 2b, env-typed).
      let values: Record<string, string> | undefined;
      let raw: unknown;
      if (String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase() === IMPORT_WITH_VALUES) {
        const nl = body.subarray(0, IMPORT_HEAD_MAX_BYTES).indexOf(0x0a);
        if (nl < 0) return reply.code(400).send({ error: 'Malformed setup values.' });
        try {
          raw = (JSON.parse(body.subarray(0, nl).toString('utf8')) as { values?: unknown } | null)?.values;
        } catch {
          return reply.code(400).send({ error: 'Malformed setup values.' });
        }
        body = body.subarray(nl + 1);
        if (body.length === 0) return reply.code(400).send({ error: 'Send the .hatchabot file as the request body.' });
      } else if (req.query.values) {
        try {
          raw = JSON.parse(req.query.values.slice(0, 16_000));
        } catch {
          return reply.code(400).send({ error: 'Malformed setup values.' });
        }
      }
      if (raw !== undefined) {
        const v = SetupValues
          .safeParse(raw);
        if (!v.success) return reply.code(400).send({ error: 'Malformed setup values.' });
        values = v.data;
      }
      const ownerId = ownerIdOf(req);
      const hosts = store.listHosts(ownerId);
      const host = req.query.hostId
        ? hosts.find((h) => h.id === req.query.hostId)
        : (hosts.find((h) => h.kind === 'local') ?? hosts[0]);
      if (!host) return reply.code(400).send({ error: 'No host available to import onto.' });
      if (hostBeingRemoved(host.id)) return reply.code(409).send({ error: HOST_GOING });
      if (req.query.aiProfileId) {
        const p = store.getAIProfile(req.query.aiProfileId);
        if (!p || (p.ownerId !== ownerId && !p.shared)) {
          return reply.code(400).send({ error: 'Unknown AI profile' });
        }
      }
      try {
        // One button, two file kinds. A template stands up a FRESH agent (own
        // bot, importer as sole owner); anything else is a full copy (a Download)
        // that restores the SAME agent, carrying its bot token and members.
        if (await copies.isTemplate(body)) {
          const { agent, needs } = await copies.importTemplateFile(host, body, { ownerId, aiProfileId: req.query.aiProfileId, name: req.query.name, values, onRow: () => capRowMade(req) });
          // ?telegram=0: web-only, as create's telegram: false — no pool bot taken.
          if (req.query.telegram === '0') store.setAgentWebOnly(agent.id, true);
          // Fresh agent → its own bot from the pool; none free → web-only, told in Alerts.
          kickProvision(agent.id, { webOnlyIfNoBot: true });
          return reply.code(201).send({ ...publicAgent(agent), kind: 'template', needs });
        }
        // A full copy restores the SAME agent with its bot (its members talk to
        // it there): "no Telegram" was ignored and the bot came back anyway
        // (2026-10-09). Refused, so nobody is surprised by a bot they turned down.
        if (req.query.telegram === '0') {
          return reply.code(400).send({ error: 'This file is a full copy (a Download): it brings the agent back with its own Telegram bot, so "no Telegram" does not apply. Import it without that option; to make a new agent without a bot from it, export it as a template instead.' });
        }
        // Not held while it runs, as the other import: a source deleted
        // meanwhile is refused where the agent is written (HB-0570).
        const run = (onOperation?: (id: string) => void) => copies.importCopy(
          host,
          body,
          { ownerId, aiProfileId: req.query.aiProfileId, image: req.query.image,
            onOperation: (id) => { capRowMade(req); operation = id; onOperation?.(id); } },
        );
        if (waitAsked(req)) return reply.code(201).send({ ...publicAgent(await run()), kind: 'agent', operation });
        // A full copy runs in the background once its record exists (phase
        // 3): minutes for a large one. The file's refusals come first.
        const bg = await runInBackground(store, run, { onError: backgroundError });
        if (bg.started) {
          const op = store.getOperation(bg.opId);
          const made = op?.agentId ? store.getAgent(op.agentId) : undefined;
          return reply.code(202).send({ operation: publicOperation(op), kind: 'agent', ...(made ? { agent: publicAgent(made) } : {}) });
        }
        return reply.code(201).send({ ...publicAgent(bg.value), kind: 'agent', operation });
      } catch (err) {
        if (err instanceof ImageDecisionNeeded) return reply.code(409).send(imageDecisionBody(err));
        if (err instanceof ImportCleanupPending) return reply.code(503).send({ error: err.message, operation });
        if (err instanceof TransferError) return reply.code(400).send({ error: err.userMessage, operation });
        if (err instanceof SourceGoneError) return reply.code(409).send({ error: err.userMessage, operation });
        throw err;
      }
    },
  );
}
