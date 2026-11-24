import { randomUUID } from 'node:crypto';
import { ENV_NAME_RE, envValueProblem, MAX_AGENT_ENV_VARS, reservedEnvProblem } from '../../domain/envPolicy.js';
import type { Agent } from '../../domain/types.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { refused, said, type Answer } from '../consult/answers.js';

/** The answer when `agentGone` says so (AGENT_GONE's words in src/api/routeContext.ts). */
const AGENT_GONE = 'It was deleted.';

/**
 * An agent's own environment values (HB-0808 step 15, part C): an API key
 * or a setting its own tools need, injected at provision. Each value is a
 * secret: kept in the secret store (`agent-env/<id>`), never returned, and
 * applied at the next rebuild; the store holds only its name and where the
 * secret is. The name policy is a security boundary shared with the import
 * path (domain/envPolicy.ts). No state of its own.
 */
export interface EnvValues {
  /** Add one (the route found the agent, not gone, and the name and value well formed). */
  add(agent: Agent, name: string, value: string): Promise<Answer<undefined>>;
  /** Remove one, and its secret. */
  remove(agent: Agent, envId: string): Promise<Answer<undefined>>;
}

export interface EnvValuesDeps {
  store: Store;
  secrets: SecretStore;
  /** Deleted or being deleted. */
  agentGone: (id: string) => boolean;
}

export function createEnvValues(deps: EnvValuesDeps): EnvValues {
  const { store, secrets, agentGone } = deps;

  const add: EnvValues['add'] = async (agent, name, value) => {
    if (!ENV_NAME_RE.test(name)) {
      return refused(400,
        'Not a valid variable name — use letters, digits and underscores, not starting with a digit.',
      );
    }
    const reserved = reservedEnvProblem(name);
    if (reserved) return refused(400, reserved);
    const badValue = envValueProblem(name, value);
    if (badValue) return refused(400, badValue);
    const current = store.listAgentEnv(agent.id);
    if (current.some((e) => e.name === name)) {
      return refused(409, `"${name}" is already set — remove it first to change its value.`);
    }
    if (current.length >= MAX_AGENT_ENV_VARS) {
      return refused(409, `An agent can have at most ${MAX_AGENT_ENV_VARS} variables (so that a copy of it can be imported again) — remove one first.`);
    }
    const id = randomUUID();
    const secretRef = `agent-env/${id}`;
    await secrets.put(secretRef, value);
    if (agentGone(agent.id)) {
      await secrets.delete(secretRef).catch(() => {});
      return refused(409, AGENT_GONE);
    }
    // Checked again after the secret store's await (HB-0285): two additions
    // in flight at once each saw room for one more, and the agent ended
    // over the limit its own template has to import under.
    const now = store.listAgentEnv(agent.id);
    const clash = now.some((e) => e.name === name)
      ? `"${name}" is already set — remove it first to change its value.`
      : now.length >= MAX_AGENT_ENV_VARS
        ? `An agent can have at most ${MAX_AGENT_ENV_VARS} variables (so that a copy of it can be imported again) — remove one first.`
        : undefined;
    if (clash) {
      await secrets.delete(secretRef).catch(() => {});
      return refused(409, clash);
    }
    try {
      store.insertAgentEnv({ id, agentId: agent.id, name, secretRef, createdAt: new Date().toISOString() });
    } catch (err) {
      await secrets.delete(secretRef).catch(() => {});
      throw err;
    }
    return said(undefined);
  };

  const remove: EnvValues['remove'] = async (agent, envId) => {
    const e = store.getAgentEnv(agent.id, envId);
    if (!e) return refused(404, 'No such variable.');
    store.deleteAgentEnv(agent.id, envId);
    await secrets.delete(e.secretRef).catch(() => {});
    return said(undefined);
  };

  return { add, remove };
}
