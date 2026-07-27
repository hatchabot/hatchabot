import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { ChannelProvisioner } from '../channels/channel.js';
import { provisionAgent, claudeAuthDir } from '../orchestrator/provision.js';
import {
  approvePairing,
  claimFirstContact,
  listPairingRequests,
} from '../orchestrator/claim.js';

export interface ApiDeps {
  store: Store;
  secrets: SecretStore;
  /** Keyed by Host.provider — 'mock', 'local-docker', later 'gce'. */
  providers: Map<string, RuntimeProvider>;
  channel: ChannelProvisioner;
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

  const providerForAgent = (agentId: string): RuntimeProvider => {
    const agent = store.getAgent(agentId);
    if (!agent) throw new Error(`No such agent: ${agentId}`);
    return providerFor(agent.hostId);
  };

  app.get('/healthz', async () => ({ ok: true }));

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

    const provider = providerFor(parsed.data.hostId);
    const result = await provisionAgent(
      { ...deps, provider, log: (e, d) => app.log.info(d, e) },
      { ownerId, ...parsed.data },
    );

    // Kick off the first-contact claim in the background: the deep link is
    // about to be shown to the owner, and their first message binds them.
    const channelRow = store.getChannelForAgent(result.agent.id);
    if (result.agent.state === 'RUNNING' && result.agent.runtimeRef && channelRow) {
      void claimFirstContact(
        { store, provider, log: (e, d) => app.log.info(d, e) },
        {
          agentId: result.agent.id,
          runtimeRef: result.agent.runtimeRef,
          accountId: channelRow.accountId,
          ownerId,
        },
      ).catch((err) => app.log.error({ err }, 'claim failed'));
    }

    return reply.code(202).send(result);
  });

  app.get('/v1/agents', async (req) => {
    return store.listAgents(ownerIdOf(req.headers as Record<string, unknown>));
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const channel = store.getChannelForAgent(agent.id);
    return { ...agent, deepLink: channel?.deepLink };
  });

  // Pending pairing requests on a live agent — the app renders these as
  // "someone wants to talk to <agent>" cards for the owner to approve.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/pairing', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    const channel = agent && store.getChannelForAgent(agent.id);
    if (!agent?.runtimeRef || !channel) return reply.code(404).send({ error: 'Not found' });
    const provider = providerForAgent(agent.id);
    return listPairingRequests(provider, agent.runtimeRef, channel.accountId);
  });

  app.post<{ Params: { id: string }; Body: { code?: string } }>(
    '/v1/agents/:id/pairing/approve',
    async (req, reply) => {
      const agent = store.getAgent(req.params.id);
      const channel = agent && store.getChannelForAgent(agent.id);
      const code = (req.body as { code?: string } | null)?.code;
      if (!agent?.runtimeRef || !channel) return reply.code(404).send({ error: 'Not found' });
      if (!code) return reply.code(400).send({ error: 'code required' });
      const provider = providerForAgent(agent.id);
      const ok = await approvePairing(provider, agent.runtimeRef, channel.accountId, code);
      return ok ? { approved: true } : reply.code(400).send({ error: 'Approval failed' });
    },
  );

  app.post<{ Params: { id: string } }>('/v1/agents/:id/stop', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    await providerForAgent(agent.id).stop(agent.runtimeRef);
    return store.setAgentState(agent.id, 'STOPPED');
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/start', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    await providerForAgent(agent.id).start(agent.runtimeRef);
    return store.setAgentState(agent.id, 'RUNNING');
  });

  app.delete<{ Params: { id: string } }>('/v1/agents/:id', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    store.setAgentState(agent.id, 'DELETING');
    if (agent.runtimeRef) {
      await providerForAgent(agent.id).destroy(agent.runtimeRef, { purge: true });
    }
    const channel = store.getChannelForAgent(agent.id);
    if (channel) {
      await deps.channel.release(channel.accountId);
      store.deleteChannelForAgent(agent.id);
    }
    return store.setAgentState(agent.id, 'DELETED');
  });
}
