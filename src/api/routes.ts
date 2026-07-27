import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { ChannelProvisioner } from '../channels/channel.js';
import { provisionAgent } from '../orchestrator/provision.js';

export interface ApiDeps {
  store: Store;
  secrets: SecretStore;
  provider: RuntimeProvider;
  channel: ChannelProvisioner;
}

const CreateAIProfile = z.object({
  name: z.string().min(1),
  vendor: z.enum(['anthropic', 'google']),
  kind: z.enum(['api_key', 'subscription']),
  model: z.string().min(1),
  apiKey: z.string().min(1),
});

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

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/v1/ai-profiles', async (req, reply) => {
    const parsed = CreateAIProfile.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const body = parsed.data;

    if (body.kind === 'subscription') {
      return reply.code(400).send({
        error:
          'Subscription credentials are only supported on agents you host yourself. ' +
          'Use an API key for cloud-hosted agents. See docs/ai-profiles.md.',
      });
    }

    const id = randomUUID();
    const secretRef = `ai-profile/${id}`;
    await secrets.put(secretRef, body.apiKey);
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

    const result = await provisionAgent(deps, {
      ownerId: ownerIdOf(req.headers as Record<string, unknown>),
      ...parsed.data,
    });
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

  app.post<{ Params: { id: string } }>('/v1/agents/:id/stop', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    await deps.provider.stop(agent.runtimeRef);
    return store.setAgentState(agent.id, 'STOPPED');
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/start', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    await deps.provider.start(agent.runtimeRef);
    return store.setAgentState(agent.id, 'RUNNING');
  });

  app.delete<{ Params: { id: string } }>('/v1/agents/:id', async (req, reply) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    store.setAgentState(agent.id, 'DELETING');
    if (agent.runtimeRef) await deps.provider.destroy(agent.runtimeRef, { purge: true });
    const channel = store.getChannelForAgent(agent.id);
    if (channel) {
      await deps.channel.release(channel.accountId);
      store.deleteChannelForAgent(agent.id);
    }
    return store.setAgentState(agent.id, 'DELETED');
  });
}
