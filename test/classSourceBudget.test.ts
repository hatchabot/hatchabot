/**
 * A class that moves an agent to another AI source while its budget has it
 * on the cheaper model (HB-1477). The move drops that model, and the budget's
 * switch ends as the class's doing, not its owner's: the next pass, once the
 * rebuild the move needs is done, moves it to the new source's cheapest
 * model, and the class's model comes back when the budget lets it go. Before,
 * the next pass took the class's model for the owner's choice and left it
 * there, over its budget, until the 1st, and Usage said "you took over".
 * Every name and id is made up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, seedRunningAgent, as, type World } from './support/world.js';
import { CLASS_SOURCE, CLASS_SOURCE_CHEAPEST, machineTz, monthKey, prevMonth } from '../src/orchestrator/usage/budgets.js';

const OPUS55 = 'claude-opus-5-5', SONNET = 'claude-sonnet-5', HAIKU = 'claude-haiku-4-5';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

const send = (w: World, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  w.f.inject({ method, url, headers: as(), ...(payload !== undefined ? { payload: payload as object } : {}) });

/**
 * An agent on "key" (Sonnet by default, also Opus 5.5 and Haiku) pinned to
 * Opus 5.5, over a $20 cheaper-model budget: its budget has it on Haiku.
 * "far" offers Opus 5.5 (its default) and Sonnet, not Haiku.
 */
async function onCheaper(own: string | null = OPUS55): Promise<{ w: World; id: string; month: string }> {
  const { w, id } = await agentOn(own);
  expect((await send(w, 'PUT', `/v1/agents/${id}/budget`, { usd: 20, atLimit: 'cheaper' })).statusCode).toBe(200);
  expect(w.store.getAgent(id)!.model).toBe(HAIKU);
  expect(w.store.openCheaperPause(id)).toMatchObject({ fromModel: own, toModel: HAIKU });
  return { w, id, month: monthKey(Date.now(), machineTz()) };
}
/** The agent on "key", on `own` (null: its default), $25 spent this month; "far2" offers Sonnet (its default) and Opus 5.5, not Haiku. */
async function agentOn(own: string | null): Promise<{ w: World; id: string }> {
  const w = await makeWorld();
  closers.push(() => w.f.close());
  w.store.insertAIProfile({ id: 'key', ownerId: w.owner, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: SONNET, models: [OPUS55, HAIKU], secretRef: 'ai/key', createdAt: 'now' });
  w.store.insertAIProfile({ id: 'far', ownerId: w.owner, name: 'Far', vendor: 'anthropic', kind: 'api_key', model: OPUS55, models: [SONNET], secretRef: 'ai/far', createdAt: 'now' });
  w.store.insertAIProfile({ id: 'far2', ownerId: w.owner, name: 'Far two', vendor: 'anthropic', kind: 'api_key', model: SONNET, models: [OPUS55], secretRef: 'ai/far', createdAt: 'now' });
  await w.secrets.put('ai/far', 'sk-made-up');
  const id = await seedRunningAgent(w);
  w.store.setAgentAIProfile(id, 'key');
  w.store.setAgentModel(id, own);
  w.store.setAgentApplied(id, 'key', own ?? SONNET);
  w.store.setCostDays(id, new Map([[new Date().toISOString().slice(0, 10), 25]]));
  return { w, id };
}
/** The rebuild the source switch needs, done (the routes leave it to the caller): its container runs the new source, as a rebuild records. */
const rebuilt = (w: World, id: string) => {
  const a = w.store.getAgent(id)!;
  w.store.setAgentApplied(id, a.aiProfileId, a.model ?? w.store.getAIProfile(a.aiProfileId)!.model);
};
/** A budget pass, as a budget saved runs one at once. */
const pass = async (w: World, id: string, usd = 20) => expect((await send(w, 'PUT', `/v1/agents/${id}/budget`, { usd, atLimit: 'cheaper' })).statusCode).toBe(200);
const lineOf = async (w: World, id: string): Promise<string> =>
  ((await send(w, 'GET', '/v1/agents')).json() as Array<{ id: string; budget?: { line?: string } }>).find((a) => a.id === id)!.budget?.line ?? '';

describe("a class's source switch over a budget's cheaper model (HB-1477)", () => {
  it("with a model of its own: the switch ends as the class's, the next pass moves it to the new source's cheapest, and the class's model comes back", async () => {
    const { w, id, month } = await onCheaper();
    w.store.upsertAgentClass({ id: 'c-far', ownerId: w.owner, name: 'Far tier', aiProfileId: 'far', model: OPUS55 });
    const joined = await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-far' });
    expect(joined.statusCode, joined.body).toBe(200);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'far', model: OPUS55, classId: 'c-far' });
    // Ended with a reason of its own, in the class's write: not the owner's.
    expect(w.store.getBudgetPause(id, month)).toMatchObject({ resumedBy: CLASS_SOURCE });
    const line = await lineOf(w, id);
    expect(line).not.toMatch(/you took over/);
    expect(line).toMatch(/its class moved it to another AI source, which ended its budget's cheaper model: its budget's first check after it is rebuilt there moves it to that source's cheapest model, if one costs less/);
    rebuilt(w, id);
    await pass(w, id);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'far', model: SONNET, classId: 'c-far' });
    expect(w.store.openCheaperPause(id)).toMatchObject({ fromModel: OPUS55, toModel: SONNET });
    // Its budget raised: the class's model comes back, and it stays in the class.
    await pass(w, id, 100);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'far', model: OPUS55, classId: 'c-far' });
  });

  it("with only a source that lacks the cheaper model: its owner's own model comes back there, as with no switch, and the next pass moves it down (HB-1477 review)", async () => {
    const { w, id, month } = await onCheaper();
    w.store.upsertAgentClass({ id: 'c-src2', ownerId: w.owner, name: 'Far two only', aiProfileId: 'far2' });
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-src2' })).statusCode).toBe(200);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'far2', model: OPUS55, classId: 'c-src2' });
    expect(w.store.getBudgetPause(id, month)).toMatchObject({ resumedBy: CLASS_SOURCE });
    rebuilt(w, id);
    await pass(w, id);
    expect(w.store.getAgent(id)).toMatchObject({ model: SONNET, classId: 'c-src2' });
    expect(w.store.openCheaperPause(id)).toMatchObject({ fromModel: OPUS55, toModel: SONNET });
    await pass(w, id, 100);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'far2', model: OPUS55, classId: 'c-src2' });
  });

  it("with only a source, on a plan whose runtime cannot run its owner's model: that source's default (HB-1477 review)", async () => {
    const { w, id } = await onCheaper();
    w.store.insertAIProfile({ id: 'plan2', ownerId: w.owner, name: 'Plan two', vendor: 'anthropic', kind: 'subscription', model: SONNET, models: [OPUS55], secretRef: 'ai/plan2', createdAt: 'now' });
    w.store.upsertAgentClass({ id: 'c-plan2', ownerId: w.owner, name: 'On plan two', aiProfileId: 'plan2' });
    // Claude Opus 5.5 needs OpenClaw 2026.9.7 or newer: the image it is rebuilt on runs 2026.9.6.
    w.provider.imageOpenclawVersion = '2026.9.6';
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-plan2' })).statusCode).toBe(200);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'plan2', classId: 'c-plan2' });
    expect(w.store.getAgent(id)!.model).toBeUndefined();
    // On one that can run it, its own model.
    const b = await onCheaper();
    b.w.store.insertAIProfile({ id: 'plan2', ownerId: b.w.owner, name: 'Plan two', vendor: 'anthropic', kind: 'subscription', model: SONNET, models: [OPUS55], secretRef: 'ai/plan2', createdAt: 'now' });
    b.w.store.upsertAgentClass({ id: 'c-plan2', ownerId: b.w.owner, name: 'On plan two', aiProfileId: 'plan2' });
    b.w.provider.imageOpenclawVersion = '2026.9.8';
    expect((await send(b.w, 'POST', `/v1/agents/${b.id}/class`, { classId: 'c-plan2' })).statusCode).toBe(200);
    expect(b.w.store.getAgent(b.id)).toMatchObject({ aiProfileId: 'plan2', model: OPUS55 });
  });

  it("with only a source that lacks the cheaper model, and no model of its own: back to that source's default", async () => {
    const { w, id, month } = await onCheaper(null);
    w.store.upsertAgentClass({ id: 'c-src', ownerId: w.owner, name: 'Far only', aiProfileId: 'far' });
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-src' })).statusCode).toBe(200);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'far', classId: 'c-src' });
    expect(w.store.getAgent(id)!.model).toBeUndefined();
    expect(w.store.getBudgetPause(id, month)).toMatchObject({ resumedBy: CLASS_SOURCE });
    rebuilt(w, id);
    await pass(w, id);
    expect(w.store.getAgent(id)).toMatchObject({ model: SONNET, classId: 'c-src' });
    expect(w.store.openCheaperPause(id)).toMatchObject({ fromModel: null, toModel: SONNET });
    await pass(w, id, 100);
    expect(w.store.getAgent(id)!.model).toBeUndefined();
  });

  it('a pass before the rebuild leaves it to the pass after, with no refused switch on its timeline', async () => {
    const { w, id, month } = await onCheaper();
    w.store.upsertAgentClass({ id: 'c-far', ownerId: w.owner, name: 'Far tier', aiProfileId: 'far', model: OPUS55 });
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-far' })).statusCode).toBe(200);
    rebuilt(w, id);
    // As if its rebuild had not run yet: the container still runs "key".
    w.store.setAgentApplied(id, 'key', OPUS55);
    await pass(w, id);
    expect(w.store.getAgent(id)!.model).toBe(OPUS55);
    expect(w.store.getBudgetPause(id, month)).toMatchObject({ resumedBy: CLASS_SOURCE });
    expect(w.store.listEvents([id], 200).some((e) => e.event === 'budget.downgrade_failed')).toBe(false);
    w.store.setAgentApplied(id, 'far', OPUS55);
    await pass(w, id);
    expect(w.store.getAgent(id)!.model).toBe(SONNET);
  });

  it("last month's switch, which its class ended this month before the 1st's pass: the pass before the rebuild leaves it too (HB-1477 review)", async () => {
    const { w, id } = await agentOn(OPUS55);
    const month = monthKey(Date.now(), machineTz()), last = prevMonth(month), at = new Date().toISOString();
    w.store.setBudget(id, w.owner, 20, 'cheaper', at);
    w.store.setAgentModel(id, HAIKU);
    w.store.addBudgetPause(id, last, id, at, { fromModel: OPUS55, toModel: HAIKU });
    w.store.upsertAgentClass({ id: 'c-far', ownerId: w.owner, name: 'Far tier', aiProfileId: 'far', model: OPUS55 });
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-far' })).statusCode).toBe(200);
    expect(w.store.getBudgetPause(id, last)).toMatchObject({ resumedBy: CLASS_SOURCE });
    await pass(w, id);
    expect(w.store.getAgent(id)!.model).toBe(OPUS55);
    expect(w.store.listEvents([id], 200).some((e) => e.event === 'budget.downgrade_failed')).toBe(false);
    rebuilt(w, id);
    await pass(w, id);
    expect(w.store.getAgent(id)!.model).toBe(SONNET);
  });

  it('a model set by hand after the class ended the switch wins for the rest of the month (HB-1477 review)', async () => {
    const { w, id, month } = await onCheaper();
    w.store.upsertAgentClass({ id: 'c-far', ownerId: w.owner, name: 'Far tier', aiProfileId: 'far', model: OPUS55 });
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-far' })).statusCode).toBe(200);
    rebuilt(w, id);
    const patched = await send(w, 'PATCH', `/v1/agents/${id}`, { model: SONNET });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(w.store.getBudgetPause(id, month)).toMatchObject({ resumedBy: 'owner' });
    w.store.setAgentModel(id, OPUS55);
    await pass(w, id);
    // Left alone: the pass did not switch it down.
    expect(w.store.getAgent(id)!.model).toBe(OPUS55);
    expect(await lineOf(w, id)).toMatch(/you took over/);
    // The model route the same.
    const b = await onCheaper();
    b.w.store.upsertAgentClass({ id: 'c-far', ownerId: b.w.owner, name: 'Far tier', aiProfileId: 'far', model: OPUS55 });
    expect((await send(b.w, 'POST', `/v1/agents/${b.id}/class`, { classId: 'c-far' })).statusCode).toBe(200);
    rebuilt(b.w, b.id);
    expect((await send(b.w, 'POST', `/v1/agents/${b.id}/model`, { model: SONNET })).statusCode).toBe(200);
    await pass(b.w, b.id);
    expect(b.w.store.getAgent(b.id)!.model).toBe(SONNET);
    expect(b.w.store.getBudgetPause(b.id, month)).toMatchObject({ resumedBy: 'owner' });
  });

  it("a model set by hand after its class ended last month's switch this month wins for the rest of the month too (HB-1552)", async () => {
    const { w, id } = await agentOn(OPUS55);
    const month = monthKey(Date.now(), machineTz()), last = prevMonth(month), at = new Date().toISOString();
    w.store.setBudget(id, w.owner, 20, 'cheaper', at);
    w.store.setAgentModel(id, HAIKU);
    w.store.addBudgetPause(id, last, id, at, { fromModel: OPUS55, toModel: HAIKU });
    w.store.upsertAgentClass({ id: 'c-far', ownerId: w.owner, name: 'Far tier', aiProfileId: 'far', model: OPUS55 });
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-far' })).statusCode).toBe(200);
    expect(w.store.getBudgetPause(id, last)).toMatchObject({ resumedBy: CLASS_SOURCE });
    expect(w.store.getBudgetPause(id, month)).toBeUndefined();
    rebuilt(w, id);
    const patched = await send(w, 'PATCH', `/v1/agents/${id}`, { model: SONNET });
    expect(patched.statusCode, patched.body).toBe(200);
    w.store.setAgentModel(id, OPUS55);
    await pass(w, id);
    // The pass, with this month's $25 over its $20, leaves their model alone (was: switched down to the new source's cheapest, Sonnet).
    expect(w.store.getAgent(id)!.model).toBe(OPUS55);
    // This month's row is the owner's.
    expect(w.store.getBudgetPause(id, month)).toMatchObject({ resumedBy: 'owner' });
    expect(await lineOf(w, id)).toMatch(/you took over/);
    // The model route the same.
    const b = await agentOn(OPUS55);
    b.w.store.setBudget(b.id, b.w.owner, 20, 'cheaper', at);
    b.w.store.setAgentModel(b.id, HAIKU);
    b.w.store.addBudgetPause(b.id, last, b.id, at, { fromModel: OPUS55, toModel: HAIKU });
    b.w.store.upsertAgentClass({ id: 'c-far', ownerId: b.w.owner, name: 'Far tier', aiProfileId: 'far', model: OPUS55 });
    expect((await send(b.w, 'POST', `/v1/agents/${b.id}/class`, { classId: 'c-far' })).statusCode).toBe(200);
    rebuilt(b.w, b.id);
    expect((await send(b.w, 'POST', `/v1/agents/${b.id}/model`, { model: SONNET })).statusCode).toBe(200);
    b.w.store.setAgentModel(b.id, OPUS55);
    await pass(b.w, b.id);
    expect(b.w.store.getAgent(b.id)!.model).toBe(OPUS55);
    expect(b.w.store.getBudgetPause(b.id, month)).toMatchObject({ resumedBy: 'owner' });
  });

  it('a class whose model is the cheaper model keeps it when the switch ends (HB-1477 review)', async () => {
    const { w, id } = await onCheaper();
    w.store.upsertAgentClass({ id: 'c-cheap', ownerId: w.owner, name: 'Thrifty', model: HAIKU });
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-cheap' })).statusCode).toBe(200);
    expect(w.store.getAgent(id)).toMatchObject({ model: HAIKU, classId: 'c-cheap' });
    expect(w.store.openCheaperPause(id)).toMatchObject({ fromModel: HAIKU, toModel: HAIKU });
    // Nothing to switch back to: its line says only that it is over, on its class's model (HB-1477 review).
    const line = await lineOf(w, id);
    expect(line).toMatch(/^Over its \$20 budget for \w+ \(\$25\.00\): on claude-haiku-4-5, its class's model$/);
    expect(line).not.toMatch(/switch back|until/);
    await pass(w, id, 100);
    expect(w.store.getAgent(id)).toMatchObject({ model: HAIKU, classId: 'c-cheap' });
  });

  it("judged again on the new source with nothing cheaper there: its line says so (HB-1477 review)", async () => {
    const { w, id, month } = await onCheaper();
    w.store.upsertAgentClass({ id: 'c-far-s', ownerId: w.owner, name: 'Far, thrifty', aiProfileId: 'far', model: SONNET });
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-far-s' })).statusCode).toBe(200);
    expect(await lineOf(w, id)).toMatch(/its budget's first check after it is rebuilt there moves it/);
    rebuilt(w, id);
    await pass(w, id);
    expect(w.store.getAgent(id)!.model).toBe(SONNET);
    expect(w.store.getBudgetPause(id, month)).toMatchObject({ resumedBy: CLASS_SOURCE_CHEAPEST });
    const line = await lineOf(w, id);
    expect(line).toMatch(/its class moved it to another AI source, which ended its budget's cheaper model: it is already on the cheapest model it can run there\)$/);
    expect(line).not.toMatch(/first check after/);
    // Moved again, to a dearer model on another source: judged again there, and said to wait for that (HB-1477 review).
    w.store.upsertAgentClass({ id: 'c-far2-o', ownerId: w.owner, name: 'Far two, best', aiProfileId: 'far2', model: OPUS55 });
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-far2-o' })).statusCode).toBe(200);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'far2', model: OPUS55 });
    expect(w.store.getBudgetPause(id, month)).toMatchObject({ resumedBy: CLASS_SOURCE });
    const again = await lineOf(w, id);
    expect(again).toMatch(/its budget's first check after it is rebuilt there moves it to that source's cheapest model/);
    expect(again).not.toMatch(/already on the cheapest/);
    rebuilt(w, id);
    await pass(w, id);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'far2', model: SONNET });
    expect(w.store.openCheaperPause(id)).toMatchObject({ fromModel: OPUS55, toModel: SONNET });
  });

  it('a source that offers the cheaper model keeps it, and the switch open', async () => {
    const { w, id } = await onCheaper();
    w.store.insertAIProfile({ id: 'near', ownerId: w.owner, name: 'Near', vendor: 'anthropic', kind: 'api_key', model: SONNET, models: [HAIKU, OPUS55], secretRef: 'ai/far', createdAt: 'now' });
    w.store.upsertAgentClass({ id: 'c-near', ownerId: w.owner, name: 'Near only', aiProfileId: 'near' });
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-near' })).statusCode).toBe(200);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'near', model: HAIKU });
    expect(w.store.openCheaperPause(id)).toMatchObject({ fromModel: OPUS55, toModel: HAIKU });
  });
});
