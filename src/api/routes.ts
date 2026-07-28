import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { CompositeTelegramProvisioner } from '../channels/composite.js';
import { InvalidBotTokenError } from '../channels/telegramManual.js';
import {
  claudeAuthDir,
  createAgentRecord,
  rebuildAgent,
  runProvisionSteps,
} from '../orchestrator/provision.js';
import {
  approvePairing,
  claimFirstContact,
  listPairingRequests,
} from '../orchestrator/claim.js';
import { checkInvite, createInvite, InviteInvalidError, redeemInvite } from '../orchestrator/invite.js';

export interface ApiDeps {
  store: Store;
  secrets: SecretStore;
  /** Keyed by Host.provider — 'mock', 'local-docker', later 'gce'. */
  providers: Map<string, RuntimeProvider>;
  channel: CompositeTelegramProvisioner;
  /** Absolute path to the single-page app. */
  webIndexPath?: string;
  /** Absolute path to the invitee join page. */
  webJoinPath?: string;
}

const CreateAIProfile = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('api_key'),
    name: z.string().min(1),
    vendor: z.enum(['anthropic', 'google']),
    model: z.string().min(1),
    apiKey: z.string().min(1),
  }),
  z.object({
    kind: z.literal('subscription'),
    name: z.string().min(1),
    vendor: z.literal('anthropic'),
    model: z.string().min(1),
  }),
]);

const CreateAgent = z.object({
  name: z.string().min(1).max(64),
  persona: z.string().max(4000).optional(),
  aiProfileId: z.string().min(1),
  hostId: z.string().min(1),
  sharedMemory: z.boolean().optional(),
});

/**
 * MVP auth is a placeholder: the caller asserts an owner id via header. Swap in
 * a real identity provider before this leaves the workbench — every route here
 * scopes by ownerId, so that swap is one hook, not a rewrite.
 */
function ownerIdOf(headers: Record<string, unknown>): string {
  const raw = headers['x-agentclaw-owner'];
  return typeof raw === 'string' && raw ? raw : 'dev-owner';
}

export async function registerRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { store, secrets } = deps;

  const providerFor = (hostId: string): RuntimeProvider => {
    const host = store.getHost(hostId);
    if (!host) throw new Error(`No such host: ${hostId}`);
    const provider = deps.providers.get(host.provider);
    if (!provider) throw new Error(`No provider registered for "${host.provider}"`);
    return provider;
  };

  // ---- background provisioning ------------------------------------------
  // POST /v1/agents returns in milliseconds; the slow steps (docker, health
  // check) run here. One in-flight run per agent; the app polls GET /v1/agents.
  const inflight = new Map<string, Promise<void>>();
  const kickProvision = (agentId: string): void => {
    if (inflight.has(agentId)) return;
    const task = (async () => {
      const agent = store.getAgent(agentId);
      if (!agent) return;
      const provider = providerFor(agent.hostId);
      const log = (e: string, d: Record<string, unknown>) => app.log.info(d, e);
      const result = await runProvisionSteps(
        { store, secrets, provider, channel: deps.channel, log },
        agentId,
      );
      // Fresh agent went live in pairing mode → watch for the owner's first
      // message and bind it (the §12.4 claim).
      const channelRow = store.getChannelForAgent(agentId);
      if (result.agent.state === 'RUNNING' && result.agent.runtimeRef && channelRow) {
        await claimFirstContact(
          { store, provider, log },
          {
            agentId,
            runtimeRef: result.agent.runtimeRef,
            accountId: channelRow.accountId,
            forUserId: result.agent.ownerId,
          },
        );
      }
    })();
    inflight.set(
      agentId,
      task
        .catch((err) => app.log.error({ err, agentId }, 'provision task failed'))
        .finally(() => inflight.delete(agentId)),
    );
  };

  // ---- app ----------------------------------------------------------------

  if (deps.webIndexPath) {
    app.get('/', async (_req, reply) => {
      // Re-read per request: dev-friendly, and this page is tiny.
      const html = readFileSync(deps.webIndexPath!, 'utf8');
      return reply.type('text/html; charset=utf-8').send(html);
    });
  }

  app.get('/healthz', async () => ({ ok: true }));

  // ---- profiles & hosts ----------------------------------------------------

  app.get('/v1/ai-profiles', async (req) => {
    return store
      .listAIProfiles(ownerIdOf(req.headers as Record<string, unknown>))
      .map(({ secretRef: _s, ...safe }) => safe);
  });

  app.get('/v1/hosts', async (req) => {
    return store.listHosts(ownerIdOf(req.headers as Record<string, unknown>));
  });

  app.get('/v1/pool', async () => {
    return { availableBots: deps.channel.pool.availableCount() };
  });

  app.post('/v1/ai-profiles', async (req, reply) => {
    const parsed = CreateAIProfile.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const body = parsed.data;

    const id = randomUUID();
    let secretRef: string | undefined;

    if (body.kind === 'api_key') {
      secretRef = `ai-profile/${id}`;
      await secrets.put(secretRef, body.apiKey);
    } else {
      // Subscription: nothing to store — the OAuth credential stays on the
      // host machine and is mounted at boot. Just check it exists so the
      // failure happens here, with a fixable message, not inside a container.
      if (!existsSync(`${claudeAuthDir()}/.credentials.json`)) {
        return reply.code(400).send({
          error:
            'No Claude subscription login found on this host. Run `claude` once ' +
            'and log in, then create this profile again. See docs/ai-profiles.md.',
        });
      }
    }

    const profile = {
      id,
      ownerId: ownerIdOf(req.headers as Record<string, unknown>),
      name: body.name,
      vendor: body.vendor,
      kind: body.kind,
      model: body.model,
      secretRef,
      createdAt: new Date().toISOString(),
    };
    store.insertAIProfile(profile);
    // Never echo the key back.
    const { secretRef: _omit, ...safe } = profile;
    return reply.code(201).send(safe);
  });

  // ---- agents ---------------------------------------------------------------

  app.post('/v1/agents', async (req, reply) => {
    const parsed = CreateAgent.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const ownerId = ownerIdOf(req.headers as Record<string, unknown>);

    const profile = store.getAIProfile(parsed.data.aiProfileId);
    const host = store.getHost(parsed.data.hostId);
    if (!profile) return reply.code(400).send({ error: 'Unknown AI profile' });
    if (!host) return reply.code(400).send({ error: 'Unknown host' });
    if (profile.kind === 'subscription' && host.kind !== 'local') {
      return reply.code(400).send({
        error:
          'A subscription profile can only power agents on your own machine. ' +
          'Pick a local host, or use an API-key profile for cloud hosting.',
      });
    }

    const agent = createAgentRecord(store, { ownerId, ...parsed.data });
    kickProvision(agent.id);
    return reply.code(202).send(agent);
  });

  app.get('/v1/agents', async (req) => {
    const agents = store.listAgents(ownerIdOf(req.headers as Record<string, unknown>));
    return agents.map((a) => ({
      ...a,
      deepLink: store.getChannelForAgent(a.id)?.deepLink,
    }));
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const channel = store.getChannelForAgent(agent.id);
    return { ...agent, deepLink: channel?.deepLink };
  });

  // The parked-provisioning resume: user pasted their BotFather token.
  app.post<{ Params: { id: string }; Body: { token?: string } }>(
    '/v1/agents/:id/channel-token',
    async (req, reply) => {
      const agent = store.getAgent(req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const token = (req.body as { token?: string } | null)?.token?.trim();
      if (!token) return reply.code(400).send({ error: 'token required' });
      try {
        const { username } = await deps.channel.submitToken(agent.id, token);
        const inUseBy = store.findAgentUsingAccount(username);
        if (inUseBy && inUseBy.id !== agent.id) {
          return reply.code(400).send({
            error: `That bot is already connected to "${inUseBy.name}". Each agent needs its own bot — create another with @BotFather.`,
          });
        }
        kickProvision(agent.id);
        return reply.code(202).send({ username });
      } catch (err) {
        if (err instanceof InvalidBotTokenError) {
          return reply.code(400).send({ error: err.userMessage });
        }
        throw err;
      }
    },
  );

  // Rebuild: new container from the current image, volume (memory) kept.
  app.post<{ Params: { id: string } }>('/v1/agents/:id/rebuild', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
      return reply.code(409).send({ error: `Cannot rebuild while ${agent.state}` });
    }
    if (!inflight.has(agent.id)) {
      const task = rebuildAgent(
        { store, secrets, provider: providerFor(agent.hostId), channel: deps.channel,
          log: (e, d) => app.log.info(d, e) },
        agent.id,
      );
      inflight.set(
        agent.id,
        task
          .then(() => undefined)
          .catch((err) => app.log.error({ err, agentId: agent.id }, 'rebuild task failed'))
          .finally(() => inflight.delete(agent.id)),
      );
    }
    return reply.code(202).send({ rebuilding: true });
  });

  // Retry after FAILED (or nudge a stuck PROVISIONING after a restart).
  app.post<{ Params: { id: string } }>('/v1/agents/:id/provision', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    kickProvision(agent.id);
    return reply.code(202).send(store.getAgent(agent.id));
  });

  // ---- invites & join (§12.3) --------------------------------------------

  app.post<{ Params: { id: string } }>('/v1/agents/:id/invites', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const ownerId = ownerIdOf(req.headers as Record<string, unknown>);
    const { code, expiresAt } = createInvite(store, agent.id, ownerId);
    return reply.code(201).send({ code, expiresAt, path: `/join/${code}` });
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id/members', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return store.listMemberships(agent.id);
  });

  // Unauthenticated (code-gated): what the join page needs to render.
  app.get<{ Params: { code: string } }>('/v1/invites/:code', async (req) => {
    const check = checkInvite(store, req.params.code);
    if (!check.valid) return { valid: false, reason: check.reason };
    const agent = store.getAgent(check.agentId)!;
    return { valid: true, agentName: agent.name, sharedMemory: agent.sharedMemory };
  });

  // Unauthenticated (code-gated): redeem + start watching for the invitee's
  // first Telegram contact, exactly like the owner's claim.
  app.post<{ Body: { code?: string; name?: string } }>('/v1/join', async (req, reply) => {
    const body = (req.body ?? {}) as { code?: string; name?: string };
    if (!body.code) return reply.code(400).send({ error: 'code required' });
    try {
      const joined = redeemInvite(store, body.code, body.name ?? '');
      const agent = store.getAgent(joined.agentId)!;
      const channelRow = store.getChannelForAgent(agent.id);
      if (agent.runtimeRef && channelRow && agent.state === 'RUNNING') {
        void claimFirstContact(
          { store, provider: providerFor(agent.hostId), log: (e, d) => app.log.info(d, e) },
          {
            agentId: agent.id,
            runtimeRef: agent.runtimeRef,
            accountId: channelRow.accountId,
            forUserId: joined.membershipUserId,
            timeoutMs: 30 * 60_000,
          },
        ).catch((err) => app.log.error({ err }, 'invitee claim failed'));
      }
      return reply.code(201).send({
        agentName: agent.name,
        botUsername: channelRow?.accountId,
        deepLink: channelRow?.deepLink,
      });
    } catch (err) {
      if (err instanceof InviteInvalidError) {
        return reply.code(400).send({ error: err.userMessage });
      }
      throw err;
    }
  });

  if (deps.webJoinPath) {
    app.get('/join/:code', async (_req, reply) => {
      const html = readFileSync(deps.webJoinPath!, 'utf8');
      return reply.type('text/html; charset=utf-8').send(html);
    });
  }

  // Pending pairing requests on a live agent — the app renders these as
  // "someone wants to talk to <agent>" cards for the owner to approve.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/pairing', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    const channel = agent && store.getChannelForAgent(agent.id);
    if (!agent?.runtimeRef || !channel) return reply.code(404).send({ error: 'Not found' });
    if (agent.state !== 'RUNNING') return [];
    return listPairingRequests(providerFor(agent.hostId), agent.runtimeRef, channel.accountId);
  });

  app.post<{ Params: { id: string }; Body: { code?: string } }>(
    '/v1/agents/:id/pairing/approve',
    async (req, reply) => {
      const agent = store.getAgent(req.params.id);
      const channel = agent && store.getChannelForAgent(agent.id);
      const code = (req.body as { code?: string } | null)?.code;
      if (!agent?.runtimeRef || !channel) return reply.code(404).send({ error: 'Not found' });
      if (!code) return reply.code(400).send({ error: 'code required' });
      const ok = await approvePairing(
        providerFor(agent.hostId),
        agent.runtimeRef,
        channel.accountId,
        code,
      );
      return ok ? { approved: true } : reply.code(400).send({ error: 'Approval failed' });
    },
  );

  app.post<{ Params: { id: string } }>('/v1/agents/:id/stop', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    await providerFor(agent.hostId).stop(agent.runtimeRef);
    return store.setAgentState(agent.id, 'STOPPED');
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/start', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    await providerFor(agent.hostId).start(agent.runtimeRef);
    return store.setAgentState(agent.id, 'RUNNING');
  });

  app.delete<{ Params: { id: string } }>('/v1/agents/:id', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    store.setAgentState(agent.id, 'DELETING');
    if (agent.runtimeRef) {
      await providerFor(agent.hostId).destroy(agent.runtimeRef, { purge: true });
    }
    const channel = store.getChannelForAgent(agent.id);
    if (channel) {
      await deps.channel.release(channel.accountId);
      store.deleteChannelForAgent(agent.id);
    }
    return store.setAgentState(agent.id, 'DELETED');
  });
}
