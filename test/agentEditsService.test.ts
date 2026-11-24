import { afterEach, describe, expect, it } from 'vitest';
import { MACHINE_OWNER_ONLY } from '../src/api/routeContext.js';
import { beginOperation } from '../src/orchestrator/lifecycle/operations.js';
import { AgentEditBody, createAgentEdits, type AgentEditsDeps, type EditCaller } from '../src/orchestrator/lifecycle/agentEdits.js';
import { patchWorld, runningAgent, type PatchWorld } from './support/patchWorld.js';

/**
 * The agent edits service on its own (HB-0825): its refusals are values,
 * nothing it is handed runs on one, and the change goes on in the same tick
 * as its last look at the source (HB-0570). What PATCH /v1/agents/:id
 * answers, and in which order, is pinned through HTTP in
 * agentEditRefusals.test.ts and agentEditEffects.test.ts.
 *
 * The data is made up.
 */
const worlds: PatchWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) { w.routes?.stop(); await w.f.close(); }
});

async function service(over: Partial<AgentEditsDeps> = {}) {
  const w = await patchWorld();
  worlds.push(w);
  const id = await runningAgent(w);
  w.store.insertAIProfile({ id: 'p2', ownerId: w.owner, name: 'Source p2', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' } as never);
  const looks: string[] = [];
  const store = new Proxy(w.store, {
    get(target, key, recv) {
      const v = Reflect.get(target, key, recv);
      if (key !== 'getAIProfile') return typeof v === 'function' ? v.bind(target) : v;
      return (pid: string) => {
        looks.push(`look:${pid}`);
        // Anything that runs after this look, before the change goes on.
        queueMicrotask(() => looks.push('tick'));
        return target.getAIProfile(pid);
      };
    },
  });
  // What only the change asks for: none of it is reached by the checks.
  const notByCheck = (what: string) => () => { throw new Error(`the checks asked for ${what}`); };
  const edits = createAgentEdits({
    trace: notByCheck('trace'), providerFor: notByCheck('providerFor'), channel: w.channel, agentGone: notByCheck('agentGone'),
    withSourceHold: notByCheck('withSourceHold'), inLimitsTurn: notByCheck('inLimitsTurn'), applyCurrentLimits: notByCheck('applyCurrentLimits'),
    setMemoryCap: notByCheck('setMemoryCap'), setSwapAllowance: notByCheck('setSwapAllowance'), tellMemoryBudget: notByCheck('tellMemoryBudget'),
    detachClassIfDrifted: notByCheck('detachClassIfDrifted'), oweRebuild: notByCheck('oweRebuild'), rebuildOrOwe: notByCheck('rebuildOrOwe'),
    applyCronTriggers: notByCheck('applyCronTriggers'), applyFilesCap: notByCheck('applyFilesCap'), forgetBotName: notByCheck('forgetBotName'),
    connectorFor: notByCheck('connectorFor'), renameChannelBot: notByCheck('renameChannelBot'), view: notByCheck('view'),
    store, secrets: w.secrets, searchServiceOn: () => false,
    imagePinCheck: async () => ({ sameImage: false }),
    finalModelCheck: async () => ({}),
    ...over,
  });
  const caller: EditCaller = { ownerId: w.owner, ownsLocalHost: () => true, holdName: () => true, stepUp: () => undefined, ledger: () => undefined };
  return { w, id, edits, caller, looks };
}

describe('the agent edits service', () => {
  it('answers a machine-owner refusal in the routes\' words', async () => {
    const { w, id, edits, caller } = await service();
    let went = false;
    const out = await edits.check(w.store.getAgent(id)!, { image: 'hatchabot-runtime:trial' }, { ...caller, ownsLocalHost: () => false }, async () => { went = true; return 'went'; });
    expect(out).toEqual({ ok: false, status: 403, error: MACHINE_OWNER_ONLY });
    expect(went).toBe(false);
  });

  it('a refusal is a value with what goes beside its words; nothing it was handed runs', async () => {
    const { w, id, edits, caller } = await service();
    const op = beginOperation(w.store, 'move-host', id, {});
    let went = false;
    const out = await edits.check(w.store.getAgent(id)!, { browser: true }, caller, async () => { went = true; return 'went'; });
    expect(out).toEqual({ ok: false, status: 409, error: 'Move to another machine is under way — wait for it to finish.', extra: { operation: op.id } });
    expect(went).toBe(false);
    expect(await edits.check(w.store.getAgent(id)!, {}, caller, async () => 'went')).toEqual({ ok: false, status: 400, error: 'Nothing to update' });
  });

  it('the change goes on in the tick of its last look at the source, after the runtime check', async () => {
    let checked = false;
    const { w, id, edits, caller, looks } = await service({ finalModelCheck: async () => { checked = true; await new Promise((r) => setTimeout(r, 5)); return {}; } });
    const out = await edits.check(w.store.getAgent(id)!, { aiProfileId: 'p2' }, caller, async (edit) => {
      looks.push('then');
      return edit;
    });
    expect(checked).toBe(true);
    expect(looks.slice(-3)).toEqual(['look:p2', 'then', 'tick']);
    expect(out).toMatchObject({ switchingProfile: true, target: { id: 'p2' }, dropRuntimePin: false });
  });

  it('its body: what PATCH /v1/agents/:id parses', () => {
    expect(AgentEditBody.safeParse({ name: '  Larder ', memoryCap: null }).data).toEqual({ name: 'Larder', memoryCap: null });
    expect(AgentEditBody.safeParse({ nonsense: 1 }).data).toEqual({});
  });
});
