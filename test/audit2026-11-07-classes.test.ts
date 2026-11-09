/**
 * The 2026-11-07 deep audit of v2.177.0, its model, source, image and class
 * group (HB-0459, HB-0555, HB-0556, HB-0557, HB-0558, HB-0560, HB-0561,
 * HB-0564, HB-0565, HB-0573, HB-0581, HB-0596, HB-0597, HB-0599). Each path
 * that changes an agent's source, model or image checks what it will run as
 * a whole, and says what did not take. Each test asserts the corrected
 * behaviour; the data is made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeWorld, seedRunningAgent, as, type World } from './support/world.js';
import { Broker } from '../src/mgmt/broker.js';
import { HttpApiClient } from '../src/mgmt/apiClient.js';
import { PendingStore } from '../src/mgmt/pendingStore.js';
import { markBusy, clearBusy, isBusy, busyWaiters } from '../src/orchestrator/busy.js';
import { syncDataSourceDocs, syncMemoryBudget } from '../src/orchestrator/provision.js';
import { memoryBudgetSection } from '../src/orchestrator/memoryCap.js';
import { beginOperation } from '../src/orchestrator/operations.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { ProviderError } from '../src/providers/provider.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OPUS55 = 'claude-opus-5-5', SONNET = 'claude-sonnet-5', HAIKU = 'claude-haiku-4-5';
const WHO = { ownerId: 'user-owner', chatId: 7, fromUserId: 7, role: 'operator' as const };
const OLD_IMAGE = 'hatchabot-runtime:older-trial', NEW_IMAGE = 'hatchabot-runtime:newer-trial';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

/** A running agent on an API-key source ("key"), plus a subscription source ("plan") whose default needs OpenClaw 2026.9.7. */
async function setup(): Promise<{ w: World; id: string; ref: string }> {
  const w = await makeWorld();
  closers.push(() => w.f.close());
  w.store.insertAIProfile({ id: 'key', ownerId: w.owner, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: SONNET, models: [OPUS55, HAIKU], secretRef: 'ai/key', createdAt: 'now' });
  w.store.insertAIProfile({ id: 'plan', ownerId: w.owner, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: OPUS55, models: [SONNET], secretRef: 'ai/plan', createdAt: 'now' });
  const id = await seedRunningAgent(w);
  w.store.setAgentAIProfile(id, 'key');
  w.store.setAgentApplied(id, 'key', SONNET);
  w.provider.tags.push({ tag: OLD_IMAGE, imageId: 'older-image', openclawVersion: '2026.9.6' }, { tag: NEW_IMAGE, imageId: 'newer-image', openclawVersion: '2026.9.8' });
  return { w, id, ref: w.store.getAgent(id)!.runtimeRef! };
}
const send = (w: World, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  w.f.inject({ method, url, headers: as(), ...(payload !== undefined ? { payload: payload as object } : {}) });
/** On the subscription, runs OpenClaw `version` now. */
function onPlan(w: World, id: string, ref: string, version: string, pin?: string) {
  w.store.setAgentAIProfile(id, 'plan');
  w.store.setAgentModel(id, pin ?? null);
  w.store.setAgentApplied(id, 'plan', pin ?? OPUS55);
  w.provider.infoOverride.set(ref, { openclawVersion: version });
}
function brokerFor(w: World): Broker {
  const broker = new Broker(new HttpApiClient(async (method, path, body) => {
    const r = await send(w, method as 'GET', path, body);
    if (r.statusCode >= 400) throw new Error(r.json().error ?? String(r.statusCode));
    return r.json();
  }), new PendingStore());
  broker.setMode(true);
  return broker;
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
/**
 * The next `n` reads of `ref`'s container (a class change's checks, made
 * outside the class's queue) each run `meanwhile(i)` first, and wait for it.
 */
function holdChecks(w: World, ref: string, n: number, meanwhile: (i: number) => unknown) {
  const info = w.provider.info.bind(w.provider);
  let i = 0;
  w.provider.info = async (r) => { if (r === ref && i < n) await meanwhile(i++); return info(r); };
}

describe('one check of what an agent will run (HB-0603 A)', () => {
  it('HB-0555: clearing a pin is checked against the source default it falls back to', async () => {
    const { w, id, ref } = await setup();
    onPlan(w, id, ref, '2026.9.6', SONNET);
    const cleared = await send(w, 'POST', `/v1/agents/${id}/model`, { model: null });
    expect(cleared.statusCode).toBe(409);
    expect(cleared.json().error).toMatch(/source's default, and claude-opus-5-5 needs OpenClaw 2026\.9\.7 or newer/);
    expect(w.store.getAgent(id)!.model).toBe(SONNET);
    // PATCH clears through the same check.
    const patched = await send(w, 'PATCH', `/v1/agents/${id}`, { model: null });
    expect(patched.statusCode).toBe(400);
    expect(w.store.getAgent(id)!.model).toBe(SONNET);
    // On a runtime that can run the default, it clears.
    w.provider.infoOverride.set(ref, { openclawVersion: '2026.9.8' });
    expect((await send(w, 'POST', `/v1/agents/${id}/model`, { model: null })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.model).toBeUndefined();
  });

  it('HB-0556: a class with only a source is checked as a source switch is, and a pin it cannot run is dropped', async () => {
    const { w, id } = await setup();
    w.provider.imageOpenclawVersion = '2026.9.6';
    w.store.upsertAgentClass({ id: 'c-plan', ownerId: w.owner, name: 'On the plan', aiProfileId: 'plan' });
    const refused = await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-plan' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/needs OpenClaw 2026\.9\.7 or newer/);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'key' });
    expect(w.store.getAgent(id)!.classId).toBeFalsy();
    // A plan whose default runs there: the pin it cannot run is dropped, as PATCH drops it.
    w.store.insertAIProfile({ id: 'plan2', ownerId: w.owner, name: 'Plan two', vendor: 'anthropic', kind: 'subscription', model: SONNET, models: [OPUS55], secretRef: 'ai/plan2', createdAt: 'now' });
    w.store.upsertAgentClass({ id: 'c-plan2', ownerId: w.owner, name: 'On plan two', aiProfileId: 'plan2' });
    w.store.setAgentModel(id, OPUS55);
    const joined = await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-plan2' });
    expect(joined.statusCode).toBe(200);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'plan2', classId: 'c-plan2' });
    expect(w.store.getAgent(id)!.model).toBeUndefined();
  });

  it('HB-0459: an image pin alone is checked against the model the agent runs', async () => {
    const { w, id, ref } = await setup();
    onPlan(w, id, ref, '2026.9.8');
    const refused = await send(w, 'PATCH', `/v1/agents/${id}`, { image: OLD_IMAGE });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/needs OpenClaw 2026\.9\.7 or newer.*runs 2026\.9\.6/);
    expect(w.store.getAgent(id)!.image).toBeUndefined();
    // A class that only pins that image is refused for it the same way.
    w.store.upsertAgentClass({ id: 'c-old', ownerId: w.owner, name: 'Older image', image: OLD_IMAGE });
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-old' })).statusCode).toBe(400);
    expect(w.store.getAgent(id)!.image).toBeUndefined();
    // An image that can run it is pinned.
    expect((await send(w, 'PATCH', `/v1/agents/${id}`, { image: NEW_IMAGE })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.image).toBe(NEW_IMAGE);
  });

  it('HB-0573: a source change waits for a held operation, directly and through a class, as the bulk switch does', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-p1', ownerId: w.owner, name: 'Back to Claude', aiProfileId: 'p1' });
    const op = beginOperation(w.store, 'migrate', id, { to: 'Garage box' });
    op.hold('The other machine has not answered.', { actions: [{ action: 'retry', label: 'Ask again' }], recommended: 'retry' });
    try {
      const direct = await send(w, 'PATCH', `/v1/agents/${id}`, { aiProfileId: 'p1' });
      expect(direct.statusCode).toBe(409);
      expect(direct.json().error).toMatch(/Choose what to do on its page first/);
      const viaClass = await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-p1' });
      expect(viaClass.statusCode).toBe(400);
      expect(viaClass.json().error).toMatch(/Choose what to do on its page first/);
      expect(w.store.getAgent(id)!.aiProfileId).toBe('key');
      expect(w.store.activeOperationFor(id)?.status).toBe('held');
    } finally { op.done('Test over'); }
    expect((await send(w, 'PATCH', `/v1/agents/${id}`, { aiProfileId: 'p1' })).statusCode).toBe(200);
  });

  it('HB-0597: the manager files set_model only for a model the source menu and its runtime allow', async () => {
    const { w, id, ref } = await setup();
    const broker = brokerFor(w);
    // Offered by the vendor, not on this source's menu: refused before a card, with the menu.
    const off = await broker.handleTool('set_model', { agent: id, model: 'claude-fable-5' }, WHO) as { ok: boolean; error?: { message: string } };
    expect(off.ok).toBe(false);
    expect(off.error!.message).toMatch(/isn’t one of this source’s models.*Options: claude-sonnet-5, claude-opus-5-5, claude-haiku-4-5/);
    // On the menu but missing from the vendor's list: a card, and Confirm puts it on.
    w.store.setAIProfileModels('key', [OPUS55, HAIKU, 'claude-garden-1']);
    const card = await broker.handleTool('set_model', { agent: id, model: 'claude-garden-1' }, WHO) as { ok: boolean; pending: { confirmId: string } };
    expect(card.ok).toBe(true);
    const done = await broker.confirm(card.pending.confirmId, 'confirm', WHO);
    expect(done.ok && done.text).toMatch(/^✅/);
    expect(w.store.getAgent(id)!.model).toBe('claude-garden-1');
    // A subscription model its runtime refuses: no card.
    onPlan(w, id, ref, '2026.9.6', SONNET);
    const tooOld = await broker.handleTool('set_model', { agent: id, model: OPUS55 }, WHO) as { ok: boolean; error?: { message: string } };
    expect(tooOld.ok).toBe(false);
    expect(tooOld.error!.message).toMatch(/needs OpenClaw 2026\.9\.7/);
  });
});

describe('a class says what did not take (HB-0557, HB-0558, HB-0564)', () => {
  it('HB-0557: the manager receipt says a model the runtime refused, and a rebuild still owed', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-big', ownerId: w.owner, name: 'Big model', model: OPUS55 });
    w.provider.execResponses.set('models set', { code: 1, stdout: '', stderr: 'temporarily unavailable' });
    const broker = brokerFor(w);
    const card = await broker.handleTool('set_class', { agent: id, class: 'Big model' }, WHO) as { ok: boolean; pending: { confirmId: string } };
    const done = await broker.confirm(card.pending.confirmId, 'confirm', WHO);
    expect(done.ok && done.text).toMatch(/\n⚠ It joined the class, but its runtime did not take claude-opus-5-5, so it still answers on its old model/);
    expect(w.store.getAgent(id)!.appliedModel).toBe(SONNET);
    // A class that changes the source: the rebuild it waits for is said.
    w.provider.execResponses.delete('models set');
    w.store.upsertAgentClass({ id: 'c-p1', ownerId: w.owner, name: 'Back to Claude', aiProfileId: 'p1' });
    const card2 = await broker.handleTool('set_class', { agent: id, class: 'Back to Claude' }, WHO) as { ok: boolean; pending: { confirmId: string } };
    const done2 = await broker.confirm(card2.pending.confirmId, 'confirm', WHO);
    expect(done2.ok && done2.text).toMatch(/waits for its next rebuild \(rebuild_agent applies it now\)/);
  });

  it('HB-0558: the card shows the swap allowance, and a swap changed after review is refused', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-swap', ownerId: w.owner, name: 'Tier', memoryCap: '4g', swapAllowance: 'off' });
    const broker = brokerFor(w);
    const card = await broker.handleTool('set_class', { agent: id, class: 'Tier' }, WHO) as { ok: boolean; pending: { confirmId: string; summary: string } };
    expect(card.pending.summary).toContain('memory cap 4g, swap allowance off');
    w.store.upsertAgentClass({ id: 'c-swap', ownerId: w.owner, name: 'Tier', memoryCap: '4g', swapAllowance: '2g' });
    const stale = await broker.confirm(card.pending.confirmId, 'confirm', WHO);
    expect(stale.ok && stale.text).toMatch(/^⚠ Failed.*changed after this was shown: it now has swap allowance 2g\. Nothing was changed/);
    expect(w.store.getAgent(id)!.classId).toBeFalsy();
  });

  it('HB-0564: a member busy with another operation is listed as pending, not counted as applied', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    markBusy(id);
    let out;
    try { out = (await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: OPUS55 })).json(); }
    finally { clearBusy(id); }
    expect(out).toMatchObject({ applied: 0, needRebuild: 0 });
    expect(out.modelPending).toEqual([expect.stringMatching(/^Kitchen: it was busy with another operation, so claude-opus-5-5 is recorded but it still answers on its old model/)]);
    // Free again, the same edit applies and is counted.
    const again = (await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: OPUS55 })).json();
    expect(again).toMatchObject({ applied: 1, modelPending: [] });
    expect(w.store.getAgent(id)!.appliedModel).toBe(OPUS55);
  });
});

describe('class edits and memory (HB-0560, HB-0561, HB-0596, HB-0599)', () => {
  it('HB-0560: two edits close together leave every member on the second one, with the first one\'s limits and unpin', async () => {
    const { w, id } = await setup();
    const ids = [id];
    for (const n of [2, 3]) {
      const m = await seedRunningAgent(w, { id: `m${n}`, name: `Member ${n}`, slug: `member-${n}`, accountId: `member${n}bot` });
      w.store.setAgentAIProfile(m, 'key');
      ids.push(m);
    }
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET, image: OLD_IMAGE, memoryCap: '4g' });
    for (const m of ids) { w.store.setAgentClassIf(m, w.store.getAgent(m)?.classId ?? null, 'c-tier'); w.store.setAgentImage(m, OLD_IMAGE); w.store.setAgentModel(m, SONNET); }
    const gate = deferred(), reached = deferred();
    const update = w.provider.updateMemory.bind(w.provider);
    let held = false;
    w.provider.updateMemory = async (ref, cap, swap) => { if (!held) { held = true; reached.resolve(); await gate.promise; } return update(ref, cap, swap); };
    // The page saves one field at a time: a smaller cap and no image, then a model, while the first is on its first member.
    const first = Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-tier', { model: OPUS55, memoryCap: '2g', image: null }));
    await reached.promise;
    const second = Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-tier', { model: HAIKU }));
    await new Promise((r) => setTimeout(r, 50)); // time for the second to go through every member, were it not queued
    gate.resolve();
    const [one, two] = await Promise.all([first, second]);
    // Each says all of what it did.
    expect(one.json()).toMatchObject({ applied: 3, needRebuild: 3, skipped: [], modelPending: [] });
    expect(two.json()).toMatchObject({ applied: 3, skipped: [], modelPending: [] });
    expect(one.json().superseded).toBeUndefined();
    expect(w.store.getAgentClass('c-tier')).toMatchObject({ model: HAIKU, memoryCap: '2g' });
    for (const m of ids) {
      const a = w.store.getAgent(m)!;
      expect(w.provider.memoryUpdates.filter((u) => u.runtimeRef === a.runtimeRef).at(-1)?.cap).toBe('2g');
      expect(a.image).toBeUndefined();
      expect(a.model).toBe(HAIKU);
    }
  });

  it('HB-0561: a class dropped by a model change takes its memory limits with it', async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-large', ownerId: w.owner, name: 'Large', model: OPUS55, memoryCap: '8g' });
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-large' })).statusCode).toBe(200);
    expect(w.provider.memoryUpdates.at(-1)).toMatchObject({ runtimeRef: ref, cap: '8g' });
    const r = await send(w, 'POST', `/v1/agents/${id}/model`, { model: SONNET });
    expect(r.json()).toMatchObject({ classDetached: true });
    expect(w.store.getAgent(id)!.classId).toBeFalsy();
    expect(w.provider.memoryUpdates.at(-1)!.cap).not.toBe('8g');
    // A container that refuses them is said, as removing the class by hand says it.
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-large');
    w.store.setAgentModel(id, OPUS55);
    w.provider.updateMemory = async () => { throw new Error('the daemon is away'); };
    const kept = await send(w, 'POST', `/v1/agents/${id}/model`, { model: SONNET });
    expect(kept.json().memoryPending).toMatch(/kept its old memory limits/);
    // Its parts beside the sentence, for the app and the manager to word.
    expect(kept.json().limitsKept).toEqual({ name: 'Kitchen', why: 'memory cap not applied' });
  });

  it('HB-0596: a null class model clears it and a null name is refused, not a 500', async () => {
    const { w } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET });
    const cleared = await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: null });
    expect(cleared.statusCode).toBe(200);
    expect(w.store.getAgentClass('c-tier')!.model).toBeUndefined();
    const noName = await send(w, 'PUT', '/v1/agent-classes/c-tier', { name: null });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error).toBe('A class needs a name.');
    expect(w.store.getAgentClass('c-tier')!.name).toBe('Tier');
  });

  it('HB-0599: a class that moves the memory cap tells the running agent its new budget', async () => {
    const { w, id } = await setup();
    let playbook = '# How I work\n\n## Memory budget\n- Your container has **8 GB** of memory in total.\n';
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, opts) => {
      // Read as bytes by the budget sync (base64), as text by the others.
      if (script.startsWith('cat ') && script.includes('/AGENTS.md')) return { code: 0, stdout: script.endsWith('| base64') ? Buffer.from(playbook).toString('base64') : playbook, stderr: '' };
      // Staged, checked and renamed in one shell (a guarded write), or written in one go.
      const written = /echo "([A-Za-z0-9+/=]+)" \| base64 -d > "[^"]*AGENTS\.md(?:\.tmp-[0-9a-f]+"; \[ "\$\(sha256sum|"\.tmp)/.exec(script)?.[1];
      if (written) { playbook = Buffer.from(written, 'base64').toString(); return { code: 0, stdout: '', stderr: '' }; }
      return shell(ref, script, opts);
    };
    const settle = async (done: () => boolean) => { for (let i = 0; i < 50 && !done(); i++) await new Promise((r) => setTimeout(r, 10)); };
    w.store.upsertAgentClass({ id: 'c-large', ownerId: w.owner, name: 'Large jobs', memoryCap: '8g' });
    w.store.upsertAgentClass({ id: 'c-small', ownerId: w.owner, name: 'Small jobs', memoryCap: '1g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-large');
    // Assigned.
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-small' })).statusCode).toBe(200);
    await settle(() => playbook.includes('**1 GB**'));
    expect(playbook).toMatch(/\*\*1 GB\*\*/);
    // Edited.
    expect((await send(w, 'PUT', '/v1/agent-classes/c-small', { memoryCap: '2g' })).statusCode).toBe(200);
    await settle(() => playbook.includes('**2 GB**'));
    expect(playbook).toMatch(/\*\*2 GB\*\*/);
    // Deleted: back to the fleet's.
    expect((await send(w, 'DELETE', '/v1/agent-classes/c-small')).statusCode).toBe(200);
    await settle(() => !playbook.includes('**2 GB**'));
    expect(playbook).not.toMatch(/\*\*2 GB\*\*/);
  });
});

describe('models and budgets (HB-0565, HB-0581)', () => {
  it('HB-0565: the source menu comes from the newest runtime, past the twelfth agent', async () => {
    const { w } = await setup();
    for (let i = 2; i <= 14; i++) {
      const id = await seedRunningAgent(w, { id: `g${i}`, name: `Garden ${i}`, slug: `garden-${i}`, accountId: `garden${i}bot` });
      w.store.setAgentAIProfile(id, 'key');
    }
    // The newest runtime is on the agent listed last, past the first twelve.
    const refs = w.store.listAgents(w.owner).filter((a) => a.aiProfileId === 'key' && a.state === 'RUNNING').map((a) => a.runtimeRef!);
    expect(refs).toHaveLength(14);
    const newest = refs.at(-1)!;
    for (const ref of refs) w.provider.infoOverride.set(ref, { openclawVersion: ref === newest ? '2026.9.8' : '2026.9.6' });
    const exec = w.provider.exec.bind(w.provider);
    w.provider.exec = async (ref, args, opts) => (args[0] === 'models' && args[1] === 'list'
      ? { code: 0, stdout: JSON.stringify({ models: [{ key: `anthropic/${ref === newest ? OPUS55 : SONNET}`, name: 'A model' }] }), stderr: '' }
      : exec(ref, args, opts));
    const r = (await send(w, 'GET', '/v1/ai-profiles/key/available-models')).json();
    expect(r).toMatchObject({ source: 'runtime', openclawVersion: '2026.9.8', models: [OPUS55] });
  });

  it('HB-0581: a failed budget switch down leaves a model the owner chose meanwhile, and puts it on', async () => {
    const { w, id } = await setup();
    // On "p1", whose default is claude-opus-4-8; the owner may also choose Sonnet.
    w.store.setAgentAIProfile(id, 'p1');
    w.store.setAIProfileModels('p1', [HAIKU, SONNET]);
    w.store.setAgentApplied(id, 'p1', 'claude-opus-4-8');
    w.store.setCostDays(id, new Map([[new Date().toISOString().slice(0, 10), 25]]));
    const gate = deferred(), reached = deferred();
    const exec = w.provider.exec.bind(w.provider);
    const set: string[] = [];
    w.provider.exec = async (ref, args, opts) => {
      if (args[0] === 'models' && args[1] === 'set') {
        set.push(args[2]!);
        if (set.length === 1) { reached.resolve(); await gate.promise; return { code: 1, stdout: '', stderr: 'made-up refusal' }; }
      }
      return exec(ref, args, opts);
    };
    const budget = Promise.resolve(send(w, 'PUT', `/v1/agents/${id}/budget`, { usd: 20, atLimit: 'cheaper' }));
    await reached.promise;
    const owner = Promise.resolve(send(w, 'POST', `/v1/agents/${id}/model`, { model: SONNET }));
    for (let i = 0; i < 100 && w.store.getAgent(id)!.model !== SONNET; i++) await new Promise((r) => setTimeout(r, 1));
    expect(w.store.getAgent(id)!.model).toBe(SONNET);
    gate.resolve();
    const [, chosen] = await Promise.all([budget, owner]);
    expect(chosen.json()).toMatchObject({ model: SONNET, live: true });
    expect(w.store.getAgent(id)!.model).toBe(SONNET);
    expect(w.store.getAgent(id)!.appliedModel).toBe(SONNET);
    expect(set.map((m) => m.replace(/^anthropic\//, ''))).toEqual([HAIKU, SONNET]);
  });

  it('HB-0581: the owner choosing the budget\'s own cheaper model while it applies keeps it when the runtime refuses the budget', async () => {
    const { w, id } = await setup();
    w.store.setAgentAIProfile(id, 'p1');
    w.store.setAIProfileModels('p1', [HAIKU, SONNET]);
    w.store.setAgentApplied(id, 'p1', 'claude-opus-4-8');
    w.store.setCostDays(id, new Map([[new Date().toISOString().slice(0, 10), 25]]));
    const gate = deferred(), reached = deferred();
    const exec = w.provider.exec.bind(w.provider);
    const set: string[] = [];
    w.provider.exec = async (ref, args, opts) => {
      if (args[0] === 'models' && args[1] === 'set') {
        set.push(args[2]!);
        if (set.length === 1) { reached.resolve(); await gate.promise; return { code: 1, stdout: '', stderr: 'made-up refusal' }; }
      }
      return exec(ref, args, opts);
    };
    const budget = Promise.resolve(send(w, 'PUT', `/v1/agents/${id}/budget`, { usd: 20, atLimit: 'cheaper' }));
    await reached.promise;
    // The same model the budget is putting on, chosen by its owner.
    const owner = Promise.resolve(send(w, 'POST', `/v1/agents/${id}/model`, { model: HAIKU }));
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    const [, chosen] = await Promise.all([budget, owner]);
    expect(chosen.json()).toMatchObject({ model: HAIKU, live: true });
    expect(w.store.getAgent(id)!.model).toBe(HAIKU);
    expect(w.store.getAgent(id)!.appliedModel).toBe(HAIKU);
    expect(set.map((m) => m.replace(/^anthropic\//, ''))).toEqual([HAIKU, HAIKU]);
  });

  it("HB-0581: a source switched while the budget's switch down applies stands with its model when the runtime refuses the budget", async () => {
    const { w, id } = await setup();
    w.store.setAgentAIProfile(id, 'p1');
    w.store.setAIProfileModels('p1', [HAIKU, SONNET]);
    w.store.setAgentApplied(id, 'p1', 'claude-opus-4-8');
    w.store.setCostDays(id, new Map([[new Date().toISOString().slice(0, 10), 25]]));
    const gate = deferred(), reached = deferred();
    const exec = w.provider.exec.bind(w.provider);
    w.provider.exec = async (ref, args, opts) => {
      if (args[0] === 'models' && args[1] === 'set') { reached.resolve(); await gate.promise; return { code: 1, stdout: '', stderr: 'made-up refusal' }; }
      return exec(ref, args, opts);
    };
    const budget = Promise.resolve(send(w, 'PUT', `/v1/agents/${id}/budget`, { usd: 20, atLimit: 'cheaper' }));
    await reached.promise;
    expect(w.store.getAgent(id)!.model).toBe(HAIKU);
    // Its owner moves it to another source that offers the same model: no model write.
    const moved = await send(w, 'PATCH', `/v1/agents/${id}`, { aiProfileId: 'key' });
    expect(moved.statusCode, moved.body).toBe(200);
    gate.resolve();
    await budget;
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'key', model: HAIKU });
  });

  /** On "p1" (default claude-opus-4-8, also Haiku and Sonnet), over a $20 cheaper-model budget, its first switch held and refused. */
  async function switchDownHeld(w: World, id: string) {
    w.store.setAgentAIProfile(id, 'p1');
    w.store.setAIProfileModels('p1', [HAIKU, SONNET]);
    w.store.setCostDays(id, new Map([[new Date().toISOString().slice(0, 10), 25]]));
    const gate = deferred(), reached = deferred();
    const exec = w.provider.exec.bind(w.provider);
    let first = true;
    w.provider.exec = async (ref, args, opts) => {
      if (args[0] === 'models' && args[1] === 'set' && first) { first = false; reached.resolve(); await gate.promise; return { code: 1, stdout: '', stderr: 'made-up refusal' }; }
      return exec(ref, args, opts);
    };
    const budget = Promise.resolve(send(w, 'PUT', `/v1/agents/${id}/budget`, { usd: 20, atLimit: 'cheaper' }));
    await reached.promise;
    expect(w.store.getAgent(id)!.model).toBe(HAIKU);
    return { budget, release: () => gate.resolve() };
  }

  it("a budget's refused switch down goes back after a source's new default held that same model", async () => {
    const { w, id } = await setup();
    w.store.setAgentModel(id, SONNET);
    w.store.setAgentApplied(id, 'p1', SONNET);
    const { budget, release } = await switchDownHeld(w, id);
    // The sweep holds it on what its record says it runs: the budget's Haiku, the same value again.
    const swept = await send(w, 'POST', '/v1/ai-profiles/p1/apply-default-model', { model: SONNET, models: [HAIKU, 'claude-opus-4-8'], apply: [] });
    expect(swept.statusCode, swept.body).toBe(200);
    release();
    await budget;
    expect(w.store.getAgent(id)!.model).toBe(SONNET);
  });

  it("a follower's refused switch down goes back to the default it followed when the sweep moved the default", async () => {
    const { w, id } = await setup();
    w.store.setAgentModel(id, null);
    w.store.setAgentApplied(id, 'p1', 'claude-opus-4-8');
    const { budget, release } = await switchDownHeld(w, id);
    expect((await send(w, 'POST', '/v1/ai-profiles/p1/apply-default-model', { model: SONNET, models: [HAIKU, 'claude-opus-4-8'], apply: [] })).statusCode).toBe(200);
    release();
    await budget;
    expect(w.store.getAgent(id)!.model).toBe('claude-opus-4-8');
  });

  it("a class edit checked before the budget switched a member down applies to it, and its new model is the one the budget puts back", async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    w.store.setAgentModel(id, SONNET);
    w.store.setCostDays(id, new Map([[new Date().toISOString().slice(0, 10), 25]]));
    // While the edit checks it, its budget switches it to the cheapest model.
    holdChecks(w, ref, 1, async () => {
      const b = await send(w, 'PUT', `/v1/agents/${id}/budget`, { usd: 20, atLimit: 'cheaper' });
      expect(b.statusCode, b.body).toBe(200);
      expect(w.store.getAgent(id)!.model).toBe(HAIKU);
    });
    const edit = await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: OPUS55, image: NEW_IMAGE });
    expect(edit.json()).toMatchObject({ applied: 1, skipped: [], modelPending: [] });
    // It stays on the cheaper model while its budget is reached, in its class, on the class's image.
    expect(w.store.getAgent(id)).toMatchObject({ model: HAIKU, image: NEW_IMAGE, classId: 'c-tier' });
    // Its budget raised: the class's new model comes back, and it stays in the class.
    expect((await send(w, 'PUT', `/v1/agents/${id}/budget`, { usd: 100, atLimit: 'cheaper' })).statusCode).toBe(200);
    expect(w.store.getAgent(id)).toMatchObject({ model: OPUS55, classId: 'c-tier' });
  });
});

describe('the class fixes, reviewed', () => {
  /**
   * AGENTS.md as the agent's container holds it: a sync reads it with cat
   * and writes it whole, only while it is still what it read (sha256sum).
   * `hold.read`: the first read waits for that promise. `staged`: each
   * file staged beside it, as it is staged (the guarded write's).
   */
  function playbookOf(w: World, hold: { read?: Promise<void> } = {}) {
    const book = { text: '# How I work\n\n## Memory budget\n- Your container has **8 GB** of memory in total.\n', reads: 0, refused: 0, reading: deferred(), staged: [] as string[] };
    const staged = new Map<string, string>();
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, opts) => {
      if (script.startsWith('cat ') && script.includes('/AGENTS.md')) {
        // The file as it was when read, answered after the hold.
        const text = book.text;
        book.reads++;
        book.reading.resolve();
        if (book.reads === 1 && hold.read) await hold.read;
        // Read as bytes by the budget sync (base64), as text by the others.
        return { code: 0, stdout: script.endsWith('| base64') ? Buffer.from(text).toString('base64') : text, stderr: '' };
      }
      // A guarded write: staged to a file of its own, checked and renamed, in one shell (writeFileInAgent).
      const stage = /echo "([A-Za-z0-9+/=]+)" \| base64 -d > "([^"]*AGENTS\.md\.tmp-[0-9a-f]+)"/.exec(script);
      if (stage) { staged.set(stage[2]!, Buffer.from(stage[1]!, 'base64').toString()); book.staged.push(stage[2]!); }
      const swap = /\[ "\$\(sha256sum < "[^"]*AGENTS\.md" \| cut -d' ' -f1\)" = "([0-9a-f]{64})" \] \|\| .*; mv -f "([^"]*)" "[^"]*AGENTS\.md"$/.exec(script);
      if (stage && !swap) return { code: 0, stdout: '', stderr: '' };
      if (swap) {
        const next = staged.get(swap[2]!);
        staged.delete(swap[2]!);
        if (swap[1] !== createHash('sha256').update(book.text, 'utf8').digest('hex')) { book.refused++; return { code: 3, stdout: '', stderr: 'it changed meanwhile' }; }
        book.text = next!;
        return { code: 0, stdout: '', stderr: '' };
      }
      const b64 = /echo "([A-Za-z0-9+/=]+)" \| base64 -d > "[^"]*AGENTS\.md"\.tmp && mv/.exec(script)?.[1];
      if (b64) { book.text = Buffer.from(b64, 'base64').toString(); return { code: 0, stdout: '', stderr: '' }; }
      return shell(ref, script, opts);
    };
    return book;
  }
  const settle = async (done: () => boolean, ms = 1000) => { for (let i = 0; i < ms / 10 && !done(); i++) await new Promise((r) => setTimeout(r, 10)); };
  /** Its rebuild over, busy flag and all: the flags are the module's, and the next test's agent has the same id. */
  const rebuilt = async (w: World, id: string) => {
    await settle(() => !w.store.activeOperationFor(id) && !isBusy(id), 10_000);
    expect(isBusy(id)).toBe(false);
  };

  it('a class dropped by an image pin leaves the rebuild sent after it free to start', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-img', ownerId: w.owner, name: 'Trial image', image: NEW_IMAGE, memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-img');
    w.store.setAgentImage(id, NEW_IMAGE);
    const gate = deferred();
    const book = playbookOf(w, { read: gate.promise });
    const pinned = await send(w, 'PATCH', `/v1/agents/${id}`, { image: OLD_IMAGE });
    expect(pinned.statusCode).toBe(200);
    expect(w.store.getAgent(id)!.classId).toBeFalsy();
    const r = await send(w, 'POST', `/v1/agents/${id}/rebuild`, {});
    gate.resolve();
    expect(r.statusCode).toBe(202);
    expect(book.reads).toBeLessThanOrEqual(1); // the rebuild's own, if it got that far
    await rebuilt(w, id);
  });

  it('joining a class whose image needs a rebuild tells the budget now, and the Rebuild sent after it starts', async () => {
    const { w, id } = await setup();
    expect(isBusy(id)).toBe(false); // the busy flags are the module's: none left by an earlier test
    w.store.upsertAgentClass({ id: 'c-img', ownerId: w.owner, name: 'Trial image', image: NEW_IMAGE, memoryCap: '2g' });
    const gate = deferred();
    const book = playbookOf(w, { read: gate.promise });
    const joined = await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-img' });
    expect(joined.json()).toMatchObject({ classId: 'c-img', rebuild: true });
    await book.reading.promise; // the request started no rebuild: the agent hears its budget now
    const r = await send(w, 'POST', `/v1/agents/${id}/rebuild`, {});
    gate.resolve();
    expect(r.statusCode).toBe(202);
    await rebuilt(w, id);
    await settle(() => book.text.includes('**2 GB**'));
    expect(book.text).toMatch(/\*\*2 GB\*\*/);
    await new Promise((r) => setTimeout(r, 100));
    expect(isBusy(id)).toBe(false);
  });

  it('a class edit whose image needs a rebuild tells its members their budget now', async () => {
    const { w, id } = await setup();
    expect(isBusy(id)).toBe(false); // the busy flags are the module's: none left by an earlier test
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    const book = playbookOf(w);
    const edited = await send(w, 'PUT', '/v1/agent-classes/c-tier', { image: NEW_IMAGE, memoryCap: '1g' });
    expect(edited.json()).toMatchObject({ applied: 1, needRebuild: 1 });
    expect(w.provider.memoryUpdates.at(-1)!.cap).toBe('1g');
    await settle(() => book.text.includes('**1 GB**'));
    expect(book.text).toMatch(/\*\*1 GB\*\*/);
  });

  it('a budget sync at work holds off neither a Rebuild nor a model change, which answers at once, and does not write over a save', async () => {
    const { w, id } = await setup();
    expect(isBusy(id)).toBe(false); // the busy flags are the module's: none left by an earlier test
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    // The sync reads AGENTS.md and waits there.
    const read = deferred();
    const book = playbookOf(w, { read: read.promise });
    expect((await send(w, 'PUT', '/v1/agent-classes/c-tier', { memoryCap: '1g' })).statusCode).toBe(200);
    await book.reading.promise;
    // A model chosen meanwhile goes on at once: the sync is in no queue of its.
    const chosen = Promise.resolve(send(w, 'POST', `/v1/agents/${id}/model`, { model: HAIKU }));
    const first = await Promise.race([chosen, new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 500))]);
    expect(first).not.toBe('waiting');
    expect((await chosen).json()).toMatchObject({ model: HAIKU, live: true });
    expect(w.store.getAgent(id)!.appliedModel).toBe(HAIKU);
    read.resolve();
    await settle(() => book.text.includes('**1 GB**'));
    expect(book.text).toMatch(/\*\*1 GB\*\*/);

    // A save made between its read and its write stands, and the sync,
    // refused, reads it again: the owner's text, with the new budget.
    const read2 = deferred();
    const book2 = playbookOf(w, { read: read2.promise });
    expect((await send(w, 'PUT', '/v1/agent-classes/c-tier', { memoryCap: '2g' })).statusCode).toBe(200);
    await book2.reading.promise;
    const saved = await send(w, 'PUT', `/v1/agents/${id}/files/AGENTS.md`, { content: '# Saved by its owner\n' });
    expect(saved.statusCode).toBe(200);
    read2.resolve();
    await settle(() => book2.text.includes('**2 GB**'));
    expect(book2.refused).toBe(1);
    expect(book2.text.startsWith('# Saved by its owner\n')).toBe(true);
    expect(book2.text).toMatch(/## Memory budget[\s\S]*\*\*2 GB\*\*/);

    // And a Rebuild asked for while one works is started.
    const read3 = deferred();
    const book3 = playbookOf(w, { read: read3.promise });
    expect((await send(w, 'PUT', '/v1/agent-classes/c-tier', { memoryCap: '1g' })).statusCode).toBe(200);
    await book3.reading.promise;
    const r = await send(w, 'POST', `/v1/agents/${id}/rebuild`, {});
    read3.resolve();
    expect(r.statusCode).toBe(202);
    await rebuilt(w, id);
    // Its own section is written, the rebuild started all the same.
    await settle(() => book3.text.includes('**1 GB**'));
    expect(book3.text).toMatch(/\*\*1 GB\*\*/);
    await new Promise((r) => setTimeout(r, 100));
    expect(isBusy(id)).toBe(false);
  });

  it('budget syncs asked for while one works are one more, not one each', async () => {
    const { w, id } = await setup();
    expect(isBusy(id)).toBe(false);
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    const read = deferred();
    const book = playbookOf(w, { read: read.promise });
    expect((await send(w, 'PUT', '/v1/agent-classes/c-tier', { memoryCap: '1g' })).statusCode).toBe(200);
    await book.reading.promise;
    for (const cap of ['3g', '4g', '5g']) expect((await send(w, 'PUT', '/v1/agent-classes/c-tier', { memoryCap: cap })).statusCode).toBe(200);
    read.resolve();
    await settle(() => book.reads >= 2 && book.text.includes('**5 GB**'));
    await new Promise((r) => setTimeout(r, 50));
    expect(book.reads).toBe(2);
    expect(book.text).toMatch(/\*\*5 GB\*\*/);
  });

  it("a member's own model change made while a class edit checks it stands, and whether it leaves is decided by that edit", async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    let own: { json: () => unknown } | undefined;
    holdChecks(w, ref, 1, async () => { own = await send(w, 'POST', `/v1/agents/${id}/model`, { model: HAIKU }); });
    const edit = await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: OPUS55, image: NEW_IMAGE });
    // An edit of its class under way: decided once it is done.
    expect(own!.json()).toMatchObject({ model: HAIKU, classDetached: 'pending' });
    expect(edit.json()).toMatchObject({ applied: 0, skipped: ['Kitchen: its own model, source or image was changed while this applied, and keeps that change; it left the class'] });
    await settle(() => !w.store.getAgent(id)!.classId);
    expect(w.store.listEvents([id], 200).some((e) => e.event === 'class.detached')).toBe(true);
    expect(w.store.getAgent(id)).toMatchObject({ model: HAIKU });
    expect(w.store.getAgent(id)!.image).toBeUndefined();
    expect(w.store.getAgent(id)!.classId).toBeFalsy();
  });

  it('a default-model sweep during a class edit leaves the members the edit has not reached in the class, and the edit reaches them', async () => {
    const { w, id, ref } = await setup();
    const m2 = await seedRunningAgent(w, { id: 'm2', name: 'Member 2', slug: 'member-2', accountId: 'member2bot' });
    w.store.setAgentAIProfile(m2, 'key');
    w.store.setAgentApplied(m2, 'key', SONNET);
    // A class with only a source: its members follow the source's default.
    w.store.upsertAgentClass({ id: 'c-key', ownerId: w.owner, name: 'Key jobs', aiProfileId: 'key' });
    for (const a of [id, m2]) w.store.setAgentClassIf(a, w.store.getAgent(a)?.classId ?? null, 'c-key');
    // The edit's image check reads the first member's container: it waits there.
    const gate = deferred(), reached = deferred();
    const refs = new Map([[ref, id], [w.store.getAgent(m2)!.runtimeRef!, m2]]);
    const info = w.provider.info.bind(w.provider);
    let first: string | undefined;
    w.provider.info = async (r) => { if (!first && refs.has(String(r))) { first = refs.get(String(r)); reached.resolve(); await gate.promise; } return info(r); };
    const edit = Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-key', { model: OPUS55, image: NEW_IMAGE }));
    await reached.promise;
    const notYet = first === id ? m2 : id;
    // The source's default moves, and the member the edit has not reached
    // is ticked to follow it: it looks drifted from the edited class only
    // because the edit has not reached it yet.
    const swept = Promise.resolve(send(w, 'POST', '/v1/ai-profiles/key/apply-default-model', { model: HAIKU, models: [SONNET, OPUS55], apply: [notYet] }));
    await new Promise((r) => setTimeout(r, 30));
    expect(w.store.getAgent(notYet)!.classId).toBe('c-key');
    gate.resolve();
    expect((await edit).json()).toMatchObject({ skipped: [] });
    expect((await swept).json()).toMatchObject({ classDetached: 0 });
    for (const a of [id, m2]) expect(w.store.getAgent(a)).toMatchObject({ classId: 'c-key', model: OPUS55, image: NEW_IMAGE });
  });

  it("a member's own model change made while a class edit applies is in the ledger once, as its own", async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-mem', ownerId: w.owner, name: 'Memory', aiProfileId: 'key', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-mem');
    const gate = deferred(), reached = deferred();
    const update = w.provider.updateMemory.bind(w.provider);
    let first = true;
    w.provider.updateMemory = async (r, cap, swap) => { if (first && r === ref) { first = false; reached.resolve(); await gate.promise; } return update(r, cap, swap); };
    const edit = Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '1g' }));
    await reached.promise;
    // The class names no model: this change keeps it in the class, and answers at once.
    expect((await send(w, 'POST', `/v1/agents/${id}/model`, { model: HAIKU })).json()).toMatchObject({ model: HAIKU, classDetached: false });
    gate.resolve();
    expect((await edit).statusCode).toBe(200);
    expect(w.store.listModelChanges({ agentId: id }).filter((r) => r.to === HAIKU).map((r) => r.source)).toEqual(['model']);
  });

  it('a budget tell whose machine is gone is traced, and the next one still runs', async () => {
    const { w, id } = await setup();
    const book = playbookOf(w);
    w.store.upsertAgentClass({ id: 'c-mem', ownerId: w.owner, name: 'Memory', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-mem');
    // Its machine goes from the list once the class's cap is on its container.
    const update = w.provider.updateMemory.bind(w.provider);
    let gone = true;
    w.provider.updateMemory = async (r, cap, swap) => { await update(r, cap, swap); if (gone) w.store.setAgentHost(id, 'h-gone'); };
    expect((await send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '4g' })).statusCode).toBe(200);
    await settle(() => w.store.listEvents([id], 200).some((e) => e.event === 'memory.budget_not_told'));
    expect(w.store.listEvents([id], 200).find((e) => e.event === 'memory.budget_not_told')?.detail).toMatchObject({ why: expect.stringMatching(/h-gone/) });
    // Back on its machine, the next tell runs: the one that threw is not left in the way.
    gone = false;
    w.store.setAgentHost(id, 'h1');
    expect((await send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '3g' })).statusCode).toBe(200);
    await settle(() => book.text.includes('**3 GB**'));
    expect(book.text).toMatch(/\*\*3 GB\*\*/);
  });

  it("a member whose machine is gone is named, and a class's limits still reach the members after it", async () => {
    const { w, id } = await setup();
    const m2 = await seedRunningAgent(w, { id: 'm2', name: 'Member 2', slug: 'member-2', accountId: 'member2bot' });
    const ref2 = w.store.getAgent(m2)!.runtimeRef!;
    w.store.upsertAgentClass({ id: 'c-mem', ownerId: w.owner, name: 'Memory', memoryCap: '2g' });
    for (const a of [id, m2]) w.store.setAgentClassIf(a, w.store.getAgent(a)?.classId ?? null, 'c-mem');
    w.store.setAgentHost(id, 'h-gone');
    const edit = await send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '1g' });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().skipped).toEqual([expect.stringMatching(/^Kitchen: its machine is not known here/)]);
    expect(w.provider.memoryUpdates.filter((u) => u.runtimeRef === ref2).at(-1)?.cap).toBe('1g');
    const del = await send(w, 'DELETE', '/v1/agent-classes/c-mem');
    expect(del.statusCode).toBe(200);
    expect(del.json().skipped).toEqual([expect.stringMatching(/^Kitchen: its machine is not known here/)]);
    expect(w.provider.memoryUpdates.filter((u) => u.runtimeRef === ref2).at(-1)?.cap).not.toBe('1g');
  });

  it('a class taken off tells the agent nothing when no limits went on', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET, memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    const book = playbookOf(w);
    // A machine that cannot change a container's limits: none go on.
    (w.provider as unknown as { updateMemory?: unknown }).updateMemory = undefined;
    expect((await send(w, 'POST', `/v1/agents/${id}/model`, { model: HAIKU })).json()).toMatchObject({ classDetached: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(book.reads).toBe(0);
    expect(w.store.listEvents([id], 200).some((e) => e.event === 'memory.budget_told')).toBe(false);
  });

  it('a bulk switch made while a class edit checks its agent answers at once, and the agent leaves the class with the edit', async () => {
    const { w, id, ref } = await setup();
    w.store.insertAIProfile({ id: 'key2', ownerId: w.owner, name: 'Key 2', vendor: 'anthropic', kind: 'api_key', model: SONNET, models: [HAIKU], secretRef: 'ai/key2', createdAt: 'now' });
    w.store.upsertAgentClass({ id: 'c-key', ownerId: w.owner, name: 'On the key', aiProfileId: 'key' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-key');
    let switched: { json: () => unknown } | undefined;
    holdChecks(w, ref, 1, async () => { switched = await send(w, 'POST', '/v1/ai-profiles/key2/adopt-agents', { apply: [id] }); });
    const edit = await send(w, 'PUT', '/v1/agent-classes/c-key', { image: NEW_IMAGE });
    expect(switched!.json()).toMatchObject({ switched: 1, classDetached: 0, classDetachPending: 1 });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ applied: 0, skipped: [expect.stringMatching(/^Kitchen: its own model, source or image was changed while this applied, and keeps that change; it left the class/)] });
    await settle(() => !w.store.getAgent(id)!.classId);
    expect(w.store.getAgent(id)!.classId).toBeFalsy();
    expect(w.store.getAgent(id)!.aiProfileId).toBe('key2');
    expect(w.store.getAgent(id)!.image).toBeUndefined();
  });

  it("an agent's own swap allowance goes on the machine it is on when its turn comes", async () => {
    const { w, id, ref } = await setup();
    const runner = new MockProvider();
    w.providers.set('mock2', runner);
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Runner', settings: {}, createdAt: 'now' } as never);
    await runner.provision({ agentId: id, slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {} });
    // A class's limits hold its turn, and it is moved meanwhile.
    w.store.upsertAgentClass({ id: 'c-mem', ownerId: w.owner, name: 'Memory', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-mem');
    const gate = deferred(), reached = deferred();
    const update = w.provider.updateMemory.bind(w.provider);
    let first = true;
    w.provider.updateMemory = async (r, cap, swap) => { if (first) { first = false; reached.resolve(); await gate.promise; } return update(r, cap, swap); };
    const edit = Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '1g' }));
    await reached.promise;
    const own = Promise.resolve(send(w, 'PATCH', `/v1/agents/${id}`, { swapAllowance: '512m' }));
    await new Promise((r) => setTimeout(r, 20));
    w.store.setAgentHost(id, 'h2');
    const here = w.provider.memoryUpdates.length;
    gate.resolve();
    expect((await edit).statusCode).toBe(200);
    expect((await own).statusCode).toBe(200);
    expect(runner.memoryUpdates.filter((u) => u.runtimeRef === ref)).toHaveLength(1);
    expect(w.provider.memoryUpdates.length - here).toBe(1); // the class's, already under way
  });

  it('a member that left the class while an edit checked it is no longer one of its members', async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    const gate = deferred(), reached = deferred();
    const info = w.provider.info.bind(w.provider);
    let held = false;
    w.provider.info = async (r) => { if (!held && r === ref) { held = true; reached.resolve(); await gate.promise; } return info(r); };
    const edit = Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-tier', { model: OPUS55, image: NEW_IMAGE }));
    await reached.promise;
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, null);
    gate.resolve();
    expect((await edit).json()).toMatchObject({ applied: 0, skipped: [] });
    expect(w.store.getAgent(id)!.model).not.toBe(OPUS55);
    expect(w.store.getAgent(id)!.image).toBeUndefined();
  });

  it("a join that waited behind its old class's deletion goes ahead", async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-a', ownerId: w.owner, name: 'A', memoryCap: '2g' });
    w.store.upsertAgentClass({ id: 'c-b', ownerId: w.owner, name: 'B' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-a');
    // An edit of A waits at its member's container; A's deletion, then the join, queue behind it.
    const gate = deferred(), reached = deferred();
    const update = w.provider.updateMemory.bind(w.provider);
    let first = true;
    w.provider.updateMemory = async (r, cap, swap) => { if (first && r === ref) { first = false; reached.resolve(); await gate.promise; } return update(r, cap, swap); };
    const edit = Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-a', { memoryCap: '1g' }));
    await reached.promise;
    const del = Promise.resolve(send(w, 'DELETE', '/v1/agent-classes/c-a'));
    await new Promise((r) => setTimeout(r, 10));
    const join = Promise.resolve(send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-b' }));
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    expect((await edit).statusCode).toBe(200);
    expect((await del).statusCode).toBe(200);
    const joined = await join;
    expect(joined.statusCode, joined.body).toBe(200);
    expect(w.store.getAgent(id)!.classId).toBe('c-b');
  });

  it("a budget is written into an AGENTS.md with a byte that is not UTF-8, and every other byte kept", async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-mem', ownerId: w.owner, name: 'Memory', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-mem');
    // A stray Latin-1 byte (0xE9) in the owner's notes.
    let bytes: Buffer = Buffer.concat([Buffer.from('# Caf'), Buffer.from([0xe9]), Buffer.from(' notes\n\n## Memory budget\n- Your container has **8 GB** of memory in total.\n')]);
    const staged = new Map<string, Buffer>();
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, opts) => {
      if (script.startsWith('cat ') && script.includes('/AGENTS.md')) {
        // As bytes; as text, the way a shell's output is read, the byte is lost.
        return { code: 0, stdout: script.endsWith('| base64') ? bytes.toString('base64') : bytes.toString('utf8'), stderr: '' };
      }
      const stage = /echo "([A-Za-z0-9+/=]+)" \| base64 -d > "([^"]*AGENTS\.md\.tmp-[0-9a-f]+)"/.exec(script);
      if (stage) staged.set(stage[2]!, Buffer.from(stage[1]!, 'base64'));
      const swap = /= "([0-9a-f]{64})" \] \|\| .*; mv -f "([^"]*)" "[^"]*AGENTS\.md"$/.exec(script);
      if (swap) {
        if (swap[1] !== createHash('sha256').update(bytes).digest('hex')) return { code: 3, stdout: '', stderr: 'it changed meanwhile' };
        bytes = staged.get(swap[2]!)!;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (stage) return { code: 0, stdout: '', stderr: '' };
      return shell(ref, script, opts);
    };
    expect((await send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '1g' })).statusCode).toBe(200);
    await settle(() => bytes.includes('**1 GB**'));
    expect(bytes.toString('latin1')).toMatch(/\*\*1 GB\*\*/);
    expect(bytes.subarray(0, 14)).toEqual(Buffer.concat([Buffer.from('# Caf'), Buffer.from([0xe9]), Buffer.from(' notes\n\n')]));
  });

  it("an agent's own cap or swap is kept, and said, when its machine can't be reached", async () => {
    const { w, id } = await setup();
    // Its machine gone from the list: the cap is its own, and that is said.
    w.store.setAgentHost(id, 'h-gone');
    const gone = await send(w, 'PATCH', `/v1/agents/${id}`, { memoryCap: '2g' });
    expect(gone.statusCode, gone.body).toBe(200);
    expect(gone.json().memoryPending).toMatch(/its machine is not known here/);
    expect(w.store.getAgent(id)!.memoryCap).toBe('2g');
    w.store.setAgentHost(id, 'h1');
    // A runner asleep: its docker call fails, and its connect test says it isn't there.
    w.provider.awake = false;
    w.provider.updateMemory = async () => { throw new ProviderError('cannot connect', "The machine isn't answering."); };
    const asleep = await send(w, 'PATCH', `/v1/agents/${id}`, { swapAllowance: '512m' });
    expect(asleep.statusCode, asleep.body).toBe(200);
    expect(asleep.json().memoryPending).toMatch(/kept its old memory limits \(The machine isn't answering\.\)/);
    expect(asleep.json().limitsKept).toEqual({ name: 'Kitchen', why: "The machine isn't answering." });
    expect(w.store.getAgent(id)!.swapAllowance).toBe('512m');
  });

  it('any error from a machine that answers refuses a cap of its own: 502, nothing stored', async () => {
    const { w, id } = await setup();
    expect((await send(w, 'PATCH', `/v1/agents/${id}`, { memoryCap: '2g' })).statusCode).toBe(200);
    // Not docker's own refusal, but its machine answers: not kept either.
    w.provider.updateMemory = async () => { throw new Error('made-up failure'); };
    const failed = await send(w, 'PATCH', `/v1/agents/${id}`, { memoryCap: '3g' });
    expect(failed.statusCode, failed.body).toBe(502);
    expect(failed.json().error).toBe("Couldn't change the container's memory cap.");
    expect(w.store.getAgent(id)!.memoryCap).toBe('2g');
  });

  it("a class's limits asked while an agent's own cap goes on wait until it is stored, and put that cap on", async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-mem', ownerId: w.owner, name: 'Memory', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-mem');
    const gate = deferred(), reached = deferred();
    const update = w.provider.updateMemory.bind(w.provider);
    let first = true;
    w.provider.updateMemory = async (r, cap, swap) => { if (first) { first = false; reached.resolve(); await gate.promise; } return update(r, cap, swap); };
    // Its own cap's docker call is held; the class's cap is changed meanwhile.
    const own = Promise.resolve(send(w, 'PATCH', `/v1/agents/${id}`, { memoryCap: '3g' }));
    await reached.promise;
    const edit = Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '1g' }));
    await new Promise((r) => setTimeout(r, 30));
    gate.resolve();
    expect((await own).statusCode).toBe(200);
    expect((await edit).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.memoryCap).toBe('3g');
    // The class's apply read it once its own cap was stored: the container keeps 3g, not the class's 1g.
    expect(w.provider.memoryUpdates.filter((u) => u.runtimeRef === ref).map((u) => u.cap)).toEqual(['3g', '3g']);
  });

  it('a cap whose swap is then refused goes back with the rest of the save: neither is stored, nor told as its budget', async () => {
    const { w, id } = await setup();
    const book = playbookOf(w);
    const update = w.provider.updateMemory.bind(w.provider);
    let calls = 0;
    w.provider.updateMemory = async (r, cap, swap) => {
      if (++calls === 2) throw new ProviderError('docker update failed: made-up', "Couldn't change the container's memory cap.");
      return update(r, cap, swap);
    };
    const r = await send(w, 'PATCH', `/v1/agents/${id}`, { memoryCap: '2g', swapAllowance: '1g' });
    expect(r.statusCode, r.body).toBe(502);
    expect(w.store.getAgent(id)!.memoryCap).toBeUndefined();
    expect(w.store.getAgent(id)!.swapAllowance).toBeUndefined();
    // The cap, the swap refused, and the stored limits put back (HB-0570).
    expect(calls).toBe(3);
    await new Promise((r) => setTimeout(r, 300));
    expect(book.reads).toBe(0);
    expect(book.text).toMatch(/\*\*8 GB\*\*/);
  });

  it("a cap or swap its container's docker refuses answers 502 and stores nothing, so no rebuild puts it on", async () => {
    const { w, id } = await setup();
    expect((await send(w, 'PATCH', `/v1/agents/${id}`, { memoryCap: '2g' })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.memoryCap).toBe('2g');
    const events = () => w.store.listEvents([id], 200).filter((e) => e.event === 'memory.cap_set' || e.event === 'memory.swap_set').length;
    const before = events();
    // Its machine answers, and docker says no (a cap below what it uses now).
    w.provider.updateMemory = async () => { throw new ProviderError('docker update failed: below current usage', "Couldn't change the container's memory cap."); };
    const cap = await send(w, 'PATCH', `/v1/agents/${id}`, { memoryCap: '512m' });
    expect(cap.statusCode, cap.body).toBe(502);
    expect(cap.json().error).toBe("Couldn't change the container's memory cap.");
    expect(w.store.getAgent(id)!.memoryCap).toBe('2g');
    const swap = await send(w, 'PATCH', `/v1/agents/${id}`, { swapAllowance: '1g' });
    expect(swap.statusCode, swap.body).toBe(502);
    expect(w.store.getAgent(id)!.swapAllowance).toBeUndefined();
    expect(events()).toBe(before);
  });

  it('a cap stored while its container kept its old limits is not told to the agent as its budget', async () => {
    const { w, id } = await setup();
    const book = playbookOf(w);
    // A runner asleep: the cap is its own, its container still has the old one.
    w.provider.awake = false;
    const update = w.provider.updateMemory.bind(w.provider);
    w.provider.updateMemory = async () => { throw new ProviderError('cannot connect', "The machine isn't answering."); };
    const kept = await send(w, 'PATCH', `/v1/agents/${id}`, { memoryCap: '2g' });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json().memoryPending).toMatch(/kept its old memory limits/);
    await new Promise((r) => setTimeout(r, 300));
    expect(book.reads).toBe(0);
    expect(book.text).toMatch(/\*\*8 GB\*\*/);
    // Awake again, a cap its container takes is told.
    w.provider.awake = true;
    w.provider.updateMemory = update;
    expect((await send(w, 'PATCH', `/v1/agents/${id}`, { memoryCap: '3g' })).statusCode).toBe(200);
    await settle(() => book.text.includes('**3 GB**'));
    expect(book.text).toMatch(/\*\*3 GB\*\*/);
  });

  it('an agent with a cap and swap of its own leaves or loses its class on a runner asleep with nothing to warn of', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-mem', ownerId: w.owner, name: 'Memory', memoryCap: '2g', swapAllowance: '512m' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-mem');
    w.store.setAgentMemoryCap(id, '3g');
    w.store.setAgentSwapAllowance(id, '1g');
    w.provider.awake = false;
    let calls = 0;
    w.provider.updateMemory = async () => { calls++; throw new ProviderError('cannot connect', "The machine isn't answering."); };
    // Its limits never depended on the class: nothing to put on, nothing kept.
    const left = await send(w, 'POST', `/v1/agents/${id}/class`, { classId: null });
    expect(left.statusCode, left.body).toBe(200);
    expect(left.json().memoryPending).toBeUndefined();
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-mem');
    const gone = await send(w, 'DELETE', '/v1/agent-classes/c-mem');
    expect(gone.statusCode, gone.body).toBe(200);
    expect(gone.json().skipped).toEqual([]);
    expect(calls).toBe(0);
    // Its own cap set by hand still goes through the one limits step.
    const own = await send(w, 'PATCH', `/v1/agents/${id}`, { memoryCap: '4g' });
    expect(own.json().memoryPending).toMatch(/kept its old memory limits/);
    expect(calls).toBe(1);
  });

  it('thirty agents leaving their class in one bulk switch, on a runner asleep, are not waited for one after another', async () => {
    const { w, id } = await setup();
    w.store.insertAIProfile({ id: 'key2', ownerId: w.owner, name: 'Key two', vendor: 'anthropic', kind: 'api_key', model: SONNET, models: [OPUS55, HAIKU], secretRef: 'ai/key2', createdAt: 'now' });
    w.store.upsertAgentClass({ id: 'c-key', ownerId: w.owner, name: 'Keyed', aiProfileId: 'key', memoryCap: '2g' });
    const ids = [id];
    for (let i = 2; i <= 30; i++) {
      const g = await seedRunningAgent(w, { id: `g${i}`, name: `Garden ${i}`, slug: `garden-${i}`, accountId: `garden${i}bot` });
      w.store.setAgentAIProfile(g, 'key');
      ids.push(g);
    }
    for (const a of ids) w.store.setAgentClassIf(a, w.store.getAgent(a)?.classId ?? null, 'c-key');
    w.provider.awake = false;
    let at = 0, most = 0;
    w.provider.updateMemory = async () => {
      most = Math.max(most, ++at);
      await new Promise((r) => setTimeout(r, 150));
      at--;
      throw new ProviderError('cannot connect', "The machine isn't answering.");
    };
    const r = await send(w, 'POST', '/v1/ai-profiles/key2/adopt-agents', { apply: ids });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().switched).toBe(30);
    expect(r.json().classDetached).toBe(30);
    // Every one said, in the batch's order, and more than one at a time.
    expect(r.json().memoryPending).toHaveLength(30);
    expect(r.json().memoryPending).toContainEqual(expect.stringMatching(/^Kitchen: Its container kept its old memory limits/));
    expect(r.json().limitsKept).toHaveLength(30);
    expect(r.json().limitsKept).toContainEqual({ name: 'Kitchen', why: "The machine isn't answering." });
    expect(most).toBeGreaterThan(1);
  }, 30_000);

  it("an edit whose member's runner is slow to answer its checks holds up no join to the class", async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c1', ownerId: w.owner, name: 'Tier', model: SONNET });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c1');
    const g = await seedRunningAgent(w, { id: 'g2', name: 'Garden 2', slug: 'garden-2', accountId: 'garden2bot' });
    w.store.setAgentAIProfile(g, 'key');
    w.store.setAgentApplied(g, 'key', SONNET);
    // The member's runner is asleep: the edit's image check of it waits for an answer.
    const slow = deferred(), reached = deferred();
    const info = w.provider.info.bind(w.provider);
    w.provider.info = async (r) => { if (r === ref) { reached.resolve(); await slow.promise; } return info(r); };
    const edit = Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c1', { image: NEW_IMAGE }));
    await reached.promise;
    let joined: Awaited<ReturnType<typeof send>> | undefined;
    const join = Promise.resolve(send(w, 'POST', `/v1/agents/${g}/class`, { classId: 'c1' })).then((res) => { joined = res; });
    try {
      await settle(() => !!joined, 3000);
      expect(joined?.statusCode, joined?.body).toBe(200);
      expect(w.store.getAgent(g)!.classId).toBe('c1');
    } finally { slow.resolve(); }
    await join;
    const e = await edit;
    expect(e.statusCode, e.body).toBe(200);
    // It joined between the edit's checks and its write: checked again, the edit reached it too.
    expect(e.json().applied).toBe(2);
    expect(w.store.getAgent(id)!.image).toBe(NEW_IMAGE);
    expect(w.store.getAgent(g)!.image).toBe(NEW_IMAGE);
  }, 15_000);

  it("a join into the class answers while an edit's slow member is still updating", async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c1', ownerId: w.owner, name: 'Tier', model: SONNET });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c1');
    const g = await seedRunningAgent(w, { id: 'g2', name: 'Garden 2', slug: 'garden-2', accountId: 'garden2bot' });
    w.store.setAgentAIProfile(g, 'key');
    w.store.setAgentApplied(g, 'key', SONNET);
    const slow = deferred(), reached = deferred();
    const exec = w.provider.exec.bind(w.provider);
    w.provider.exec = async (r, argv, opts) => {
      if (r === ref && argv[0] === 'models') { reached.resolve(); await slow.promise; }
      return exec(r, argv, opts);
    };
    const edit = send(w, 'PUT', '/v1/agent-classes/c1', { model: HAIKU });
    await reached.promise;
    let joined: Awaited<ReturnType<typeof send>> | undefined;
    const join = send(w, 'POST', `/v1/agents/${g}/class`, { classId: 'c1' }).then((res) => { joined = res; });
    try {
      await settle(() => !!joined, 3000);
      expect(joined?.statusCode, joined?.body).toBe(200);
      // It joined the class as the edit wrote it.
      expect(w.store.getAgent(g)!.model).toBe(HAIKU);
      expect(w.store.getAgent(g)!.appliedModel).toBe(HAIKU);
    } finally { slow.resolve(); }
    const e = await edit;
    expect(e.statusCode, e.body).toBe(200);
    expect(e.json().applied).toBe(1);
    expect(w.store.getAgent(id)!.appliedModel).toBe(HAIKU);
    await join;
  }, 15_000);

  it('a budget tell for an agent busy past half an hour gives up, traced, and the next change tells it afresh', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-mem', ownerId: w.owner, name: 'Memory', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-mem');
    const book = playbookOf(w);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    markBusy(id);
    try {
      const put = Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '1g' }));
      let answered = false;
      void put.then(() => { answered = true; }, () => { answered = true; });
      for (let i = 0; i < 200 && !answered; i++) await vi.advanceTimersByTimeAsync(10);
      expect((await put).statusCode).toBe(200);
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
      const gaveUp = w.store.listEvents([id], 200).filter((e) => e.event === 'memory.budget_not_told');
      expect(JSON.stringify(gaveUp)).toMatch(/stayed busy/);
      // Its wait is let go, not left among the agent's waiters.
      expect(busyWaiters(id)).toBe(0);
    } finally { clearBusy(id); vi.useRealTimers(); }
    expect(book.reads).toBe(0);
    // Free, a later change is not held behind the one that gave up.
    expect((await send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '3g' })).statusCode).toBe(200);
    await settle(() => book.text.includes('**3 GB**'));
    expect(book.text).toMatch(/\*\*3 GB\*\*/);
  });

  it('a budget tell that gives up on a busy agent still runs the ask made while it waited', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-mem', ownerId: w.owner, name: 'Memory', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-mem');
    const book = playbookOf(w);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    markBusy(id);
    const answered = async (p: Promise<{ statusCode: number }>) => {
      let done = false;
      void p.then(() => { done = true; }, () => { done = true; });
      for (let i = 0; i < 200 && !done; i++) await vi.advanceTimersByTimeAsync(10);
      return p;
    };
    try {
      expect((await answered(Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '1g' })))).statusCode).toBe(200);
      expect(busyWaiters(id)).toBe(1);
      // Asked again while the first waits.
      expect((await answered(Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '3g' })))).statusCode).toBe(200);
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
      expect(JSON.stringify(w.store.listEvents([id], 200).filter((e) => e.event === 'memory.budget_not_told'))).toMatch(/stayed busy/);
      // The first wait is let go; the ask made meanwhile waits its own.
      expect(busyWaiters(id)).toBe(1);
    } finally { clearBusy(id); vi.useRealTimers(); }
    await settle(() => book.text.includes('**3 GB**'));
    expect(book.text).toMatch(/\*\*3 GB\*\*/);
  });

  it('a data-source sync leaves a budget section that already says its cap as it was', async () => {
    const { w, id, ref } = await setup();
    w.store.setAgentMemoryCap(id, '2g');
    const book = playbookOf(w);
    // As a seed wrote it, and as a cap change made while it ran wrote it.
    for (const section of [memoryBudgetSection('2g'), memoryBudgetSection('2g', { live: true })]) {
      book.text = `# How I work\n\n${section}\n`;
      await syncDataSourceDocs({ store: w.store, provider: w.provider } as never, id, ref, () => {}, { turn: (write) => write() });
      expect(book.text).toContain('## Memory policy'); // its other sections were written
      expect(book.text).toContain(section);
    }
  });

  it("an edit checked while another writes the class is checked again, and does not take that edit's writes for its members' own changes", async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    // The second edit's check waits while the first is checked and writes the class and its member.
    let first: { statusCode: number; json: () => unknown } | undefined;
    holdChecks(w, ref, 1, async () => { first = await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: OPUS55, image: NEW_IMAGE }); });
    const second = await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: HAIKU, image: NEW_IMAGE });
    expect(first!.json()).toMatchObject({ applied: 1, skipped: [] });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ applied: 1, skipped: [] });
    expect(w.store.getAgent(id)).toMatchObject({ model: HAIKU, image: NEW_IMAGE, classId: 'c-tier' });
  });

  it('a class change whose checks never fit, three tries running, is refused with nothing written, and nothing asks a machine in its queue', async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    // An edit: the class renamed under each of its checks.
    holdChecks(w, ref, 3, (i) => { w.store.upsertAgentClass({ ...w.store.getAgentClass('c-tier')!, name: `Renamed ${i}` }); });
    const edit = await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: OPUS55, image: NEW_IMAGE });
    expect(edit.statusCode, edit.body).toBe(409);
    expect(edit.json().error).toBe('The class or its members kept changing while this applied. Nothing was changed; try again.');
    expect(w.store.getAgentClass('c-tier')).toMatchObject({ name: 'Renamed 2', model: SONNET });
    expect(w.store.getAgentClass('c-tier')!.image).toBeUndefined();
    expect(w.store.getAgent(id)!.image).toBeUndefined();
    expect(w.store.getAgent(id)!.model).not.toBe(OPUS55);
    // A join: the class's model changed under each of its checks.
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, null);
    w.store.upsertAgentClass({ id: 'c-new', ownerId: w.owner, name: 'New', model: SONNET, image: NEW_IMAGE });
    holdChecks(w, ref, 3, (i) => { w.store.upsertAgentClass({ ...w.store.getAgentClass('c-new')!, model: i % 2 ? SONNET : HAIKU }); });
    const join = await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-new' });
    expect(join.statusCode, join.body).toBe(409);
    expect(join.json().error).toMatch(/kept changing while this applied/);
    expect(w.store.getAgent(id)!.classId).toBeFalsy();
    expect(w.store.getAgent(id)!.image).toBeUndefined();
  });

  it('a move out of a class whose edit wrote the agent while the move checked it is checked again and goes ahead', async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-x', ownerId: w.owner, name: 'X', model: SONNET });
    w.store.upsertAgentClass({ id: 'c-y', ownerId: w.owner, name: 'Y', model: HAIKU, image: NEW_IMAGE });
    w.store.setAgentClassIf(id, null, 'c-x');
    w.store.setAgentModel(id, SONNET);
    // While the move checks it, an edit of the class it leaves writes it a new model.
    let edited: { json: () => unknown } | undefined;
    holdChecks(w, ref, 1, async () => { edited = await send(w, 'PUT', '/v1/agent-classes/c-x', { model: OPUS55 }); });
    const moved = await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-y' });
    expect(edited!.json()).toMatchObject({ applied: 1, skipped: [] });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(w.store.getAgent(id)).toMatchObject({ classId: 'c-y', model: HAIKU, image: NEW_IMAGE });
  });

  it('a held sync that finds the budget stale on a running container writes the live words; only a fresh start writes the seed\'s', async () => {
    const { w, id, ref } = await setup();
    w.store.setAgentMemoryCap(id, '2g');
    const book = playbookOf(w);
    book.text = `# How I work\n\n${memoryBudgetSection('2g')}\n`;
    // Its cap changed while it ran, and a data-source sync writes AGENTS.md before the budget is told.
    w.store.setAgentMemoryCap(id, '3g');
    await syncDataSourceDocs({ store: w.store, provider: w.provider } as never, id, ref, () => {}, { turn: (write) => write() });
    expect(book.text).toContain(memoryBudgetSection('3g', { live: true }));
    expect(await syncMemoryBudget({ store: w.store, provider: w.provider }, id, ref, () => {})).toBe('current');
    // Started afresh on another cap (a seed or a rebuild: no turn): the seed's words.
    w.store.setAgentMemoryCap(id, '4g');
    await syncDataSourceDocs({ store: w.store, provider: w.provider } as never, id, ref, () => {});
    expect(book.text).toContain(memoryBudgetSection('4g'));
    expect(book.text).not.toContain(memoryBudgetSection('4g', { live: true }));
  });

  it('a Memory budget section its code fences leave unsure is left as it is, and said, not a crash (HB-0520)', async () => {
    const { w, id, ref } = await setup();
    w.store.setAgentMemoryCap(id, '2g');
    const book = playbookOf(w);
    // An example above the section never closes the way it opens: some readers take the four
    // backticks to close it, others do not, so the heading may be quoted or real.
    book.text = ['# How I work', '```bash', 'an example never closed', '````', '## Memory budget', 'old words', '````', ''].join('\n');
    const before = book.text;
    const events: string[] = [];
    expect(await syncMemoryBudget({ store: w.store, provider: w.provider }, id, ref, (e) => { events.push(e); })).toBe('failed');
    expect(book.text).toBe(before);
    expect(events).toContain('agentsmd.sync_unsure');
    expect(events).not.toContain('agentsmd.sync_error');
    // Told again (a class edit tells every member): the same file is not said twice.
    expect(await syncMemoryBudget({ store: w.store, provider: w.provider }, id, ref, (e) => { events.push(e); })).toBe('failed');
    expect(events.filter((e) => e === 'agentsmd.sync_unsure')).toHaveLength(1);
    // Another cap not told for the same file is said; the file put right, then back, is said again.
    w.store.setAgentMemoryCap(id, '4g');
    await syncMemoryBudget({ store: w.store, provider: w.provider }, id, ref, (e) => { events.push(e); });
    expect(events.filter((e) => e === 'agentsmd.sync_unsure')).toHaveLength(2);
    const unsure = book.text;
    book.text = `# How I work\n\n${memoryBudgetSection('4g')}\n`;
    expect(await syncMemoryBudget({ store: w.store, provider: w.provider }, id, ref, () => {})).toBe('current');
    book.text = unsure;
    await syncMemoryBudget({ store: w.store, provider: w.provider }, id, ref, (e) => { events.push(e); });
    expect(events.filter((e) => e === 'agentsmd.sync_unsure')).toHaveLength(3);
  });

  it('limits a container kept are traced the same way from a join, an edit and a class deleted', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-mem', ownerId: w.owner, name: 'Memory', memoryCap: '2g' });
    w.provider.awake = false;
    w.provider.updateMemory = async () => { throw new ProviderError('cannot connect', "The machine isn't answering."); };
    expect((await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-mem' })).json()).toMatchObject({ limitsKept: { why: "The machine isn't answering." } });
    expect((await send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '3g' })).statusCode).toBe(200);
    expect((await send(w, 'DELETE', '/v1/agent-classes/c-mem')).statusCode).toBe(200);
    const kept = w.store.listEvents([id], 200).filter((e) => e.event === 'memory.limits_kept').map((e) => JSON.stringify(e));
    expect(kept).toHaveLength(3);
    for (const when of ['it joined a class', "its class's limits changed", 'its class was deleted']) expect(kept.some((k) => k.includes(when) && k.includes("The machine isn't answering."))).toBe(true);
  });

  it('a stopped agent whose cap changed while it was down is told its budget once Start has it up', async () => {
    const { w, id } = await setup();
    w.store.setAgentMemoryCap(id, '2g');
    const book = playbookOf(w);
    book.text = `# How I work\n\n${memoryBudgetSection('2g')}\n`;
    w.store.setAgentState(id, 'STOPPED');
    expect((await send(w, 'PATCH', `/v1/agents/${id}`, { memoryCap: '3g' })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(book.text).toContain(memoryBudgetSection('2g')); // not told while it was down
    const started = await send(w, 'POST', `/v1/agents/${id}/start`);
    expect(started.statusCode, started.body).toBe(200);
    await settle(() => book.text.includes(memoryBudgetSection('3g', { live: true })));
    expect(book.text).toContain(memoryBudgetSection('3g', { live: true }));
  });

  it("a member whose own image changed while an edit of its class's model applied leaves the class, said, rather than stay on the old model", async () => {
    const { w, id, ref } = await setup();
    onPlan(w, id, ref, '2026.9.8', SONNET);
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET });
    w.store.setAgentClassIf(id, null, 'c-tier');
    // While the edit checks it, its own image is changed: the class sets none, so it stays in for now.
    let patched: { statusCode: number; body: string } | undefined;
    holdChecks(w, ref, 1, async () => { patched = await send(w, 'PATCH', `/v1/agents/${id}`, { image: NEW_IMAGE }); });
    const edit = await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: OPUS55 });
    expect(patched!.statusCode, patched!.body).toBe(200);
    expect(edit.json()).toMatchObject({ applied: 0, skipped: ['Kitchen: its own model, source or image was changed while this applied, and keeps that change; it left the class'] });
    expect(w.store.getAgent(id)).toMatchObject({ image: NEW_IMAGE, model: SONNET });
    expect(w.store.getAgent(id)!.classId).toBeFalsy();
    expect(w.store.listEvents([id], 200).some((e) => e.event === 'class.detached')).toBe(true);
  });

  it("a member on its budget's cheaper model keeps its class across a later image-only change", async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET });
    w.store.setAgentClassIf(id, null, 'c-tier');
    w.store.setAgentModel(id, SONNET);
    w.store.setCostDays(id, new Map([[new Date().toISOString().slice(0, 10), 25]]));
    expect((await send(w, 'PUT', `/v1/agents/${id}/budget`, { usd: 20, atLimit: 'cheaper' })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.model).toBe(HAIKU);
    const patched = await send(w, 'PATCH', `/v1/agents/${id}`, { image: NEW_IMAGE });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(w.store.getAgent(id)).toMatchObject({ classId: 'c-tier', image: NEW_IMAGE, model: HAIKU });
  });

  /** A class member on "key" pinned to Sonnet, over a $20 cheaper-model budget, whose first switch waits at its runtime until `release` (refused when `refuse`). */
  async function memberSwitchHeld(w: World, id: string, refuse: boolean) {
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET });
    w.store.setAgentClassIf(id, null, 'c-tier');
    w.store.setAgentModel(id, SONNET);
    w.store.setCostDays(id, new Map([[new Date().toISOString().slice(0, 10), 25]]));
    const gate = deferred(), reached = deferred();
    const exec = w.provider.exec.bind(w.provider);
    let first = true;
    w.provider.exec = async (ref, args, opts) => {
      if (args[0] === 'models' && args[1] === 'set' && first) {
        first = false; reached.resolve(); await gate.promise;
        if (refuse) return { code: 1, stdout: '', stderr: 'made-up refusal' };
      }
      return exec(ref, args, opts);
    };
    const budget = Promise.resolve(send(w, 'PUT', `/v1/agents/${id}/budget`, { usd: 20, atLimit: 'cheaper' }));
    await reached.promise;
    // Its pause row is open before the cheaper model is applied.
    expect(w.store.openCheaperPause(id)).toMatchObject({ fromModel: SONNET, toModel: HAIKU });
    const edit = Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-tier', { model: OPUS55 }));
    await settle(() => w.store.openCheaperPause(id)?.fromModel === OPUS55);
    gate.resolve();
    return { budget: await budget, edit: await edit };
  }

  it("a class's model written while the budget's switch down applies is the one the budget puts back", async () => {
    const { w, id } = await setup();
    const { budget, edit } = await memberSwitchHeld(w, id, false);
    expect(budget.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({ applied: 1, skipped: [] });
    expect(w.store.getAgent(id)).toMatchObject({ model: HAIKU, classId: 'c-tier' });
    expect(w.store.openCheaperPause(id)).toMatchObject({ fromModel: OPUS55, toModel: HAIKU });
    expect((await send(w, 'PUT', `/v1/agents/${id}/budget`, { usd: 100, atLimit: 'cheaper' })).statusCode).toBe(200);
    expect(w.store.getAgent(id)).toMatchObject({ model: OPUS55, classId: 'c-tier' });
  });

  it("a switch down refused after a class's model was written meanwhile puts that model back, and drops its pause", async () => {
    const { w, id } = await setup();
    await memberSwitchHeld(w, id, true);
    expect(w.store.getAgent(id)).toMatchObject({ model: OPUS55, classId: 'c-tier' });
    expect(w.store.openCheaperPause(id)).toBeUndefined();
  });

  it("a deleted agent's count of model writes goes with it", async () => {
    const { w, id } = await setup();
    w.store.setAgentModel(id, HAIKU);
    expect(w.store.modelGeneration(id)).toBeGreaterThan(0);
    w.store.setAgentState(id, 'DELETING');
    w.store.setAgentState(id, 'DELETED');
    expect(w.store.modelGeneration(id)).toBe(0);
  });

  it('a sleeping agent whose cap changed while it slept is told its budget once it wakes', async () => {
    const { w, id } = await setup();
    w.store.setAgentMemoryCap(id, '2g');
    const book = playbookOf(w);
    book.text = `# How I work\n\n${memoryBudgetSection('2g')}\n`;
    w.store.setAgentState(id, 'STOPPED');
    w.store.setHibernated(id, new Date().toISOString());
    expect((await send(w, 'PATCH', `/v1/agents/${id}`, { memoryCap: '3g' })).statusCode).toBe(200);
    const woken = await send(w, 'POST', `/v1/agents/${id}/wake`);
    expect(woken.statusCode, woken.body).toBe(200);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
    await settle(() => book.text.includes(memoryBudgetSection('3g', { live: true })));
    expect(book.text).toContain(memoryBudgetSection('3g', { live: true }));
  });

  it('a bulk switch keeps a pin its owner set while the batch ran, when the new source offers it', async () => {
    const { w, id, ref } = await setup();
    const g = await seedRunningAgent(w, { id: 'g2', name: 'Garden 2', slug: 'garden-2', accountId: 'garden2bot' });
    w.store.setAgentAIProfile(g, 'key');
    // A pin the plan does not offer: dropped by the switch, as the batch read it.
    w.store.setAgentModel(id, HAIKU);
    w.store.setAgentApplied(id, 'key', HAIKU);
    for (const r of [ref, w.store.getAgent(g)!.runtimeRef!]) w.provider.infoOverride.set(r, { openclawVersion: '2026.9.8' });
    // While the batch checks its first agent's runtime, Kitchen's owner pins a model the plan offers.
    const imageInfo = w.provider.currentImageInfo.bind(w.provider);
    let first = true;
    w.provider.currentImageInfo = async (tag) => {
      if (first) { first = false; expect((await send(w, 'POST', `/v1/agents/${id}/model`, { model: OPUS55 })).statusCode).toBe(200); }
      return imageInfo(tag);
    };
    const switched = await send(w, 'POST', '/v1/ai-profiles/plan/adopt-agents', { apply: [id, g] });
    expect(switched.json()).toMatchObject({ switched: 2, skipped: [] });
    expect(first).toBe(false);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'plan', model: OPUS55 });
  });

  it("a member whose class's model waits for the rebuild its new image needs is listed as waiting for a rebuild, not behind", async () => {
    const { w, id, ref } = await setup();
    onPlan(w, id, ref, '2026.9.6', SONNET);
    w.store.upsertAgentClass({ id: 'c-plan', ownerId: w.owner, name: 'Plan', model: SONNET });
    w.store.setAgentClassIf(id, null, 'c-plan');
    const edit = await send(w, 'PUT', '/v1/agent-classes/c-plan', { model: OPUS55, image: NEW_IMAGE });
    expect(edit.json()).toMatchObject({ applied: 1, needRebuild: 1, skipped: [], modelPending: [] });
    const listed = (await send(w, 'GET', '/v1/agents')).json() as Array<{ id: string; pendingModel?: string; rebuildWaits?: boolean }>;
    expect(listed.find((a) => a.id === id)).toMatchObject({ pendingModel: OPUS55, rebuildWaits: true });
  });

  it("a member whose own model was set while an edit moving its class's image checked it leaves the class, said", async () => {
    const { w, id, ref } = await setup();
    w.store.setAgentModel(id, null);
    w.store.upsertAgentClass({ id: 'c-img', ownerId: w.owner, name: 'Image' });
    w.store.setAgentClassIf(id, null, 'c-img');
    // Pinned to the model it already runs (its source's default): not a change of what it runs.
    holdChecks(w, ref, 1, async () => { expect((await send(w, 'POST', `/v1/agents/${id}/model`, { model: SONNET })).statusCode).toBe(200); });
    const edit = await send(w, 'PUT', '/v1/agent-classes/c-img', { image: NEW_IMAGE });
    expect(edit.json()).toMatchObject({ applied: 0, skipped: ['Kitchen: its own model was set while this was checked, and it keeps it; it left the class'] });
    expect(w.store.getAgent(id)).toMatchObject({ model: SONNET });
    expect(w.store.getAgent(id)!.image).toBeUndefined();
    expect(w.store.getAgent(id)!.classId).toBeFalsy();
  });

  it("a detach waits only while an edit of its class is under way, not after one that was refused", async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET });
    w.store.setAgentClassIf(id, null, 'c-tier');
    // An edit refused after three tries: none is under way after it.
    holdChecks(w, ref, 3, (i) => { w.store.upsertAgentClass({ ...w.store.getAgentClass('c-tier')!, name: `Renamed ${i}` }); });
    expect((await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: OPUS55, image: NEW_IMAGE })).statusCode).toBe(409);
    const own = await send(w, 'POST', `/v1/agents/${id}/model`, { model: HAIKU });
    expect(own.json()).toMatchObject({ model: HAIKU, classDetached: true });
    expect(w.store.getAgent(id)!.classId).toBeFalsy();
  });

  it('leaving a class with no memory limits does not touch the container: a model change on a runner asleep answers at once', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-model', ownerId: w.owner, name: 'Model', model: SONNET });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-model');
    w.provider.awake = false;
    const gate = deferred();
    let asked = 0;
    w.provider.updateMemory = async () => { asked++; await gate.promise; throw new ProviderError('cannot connect', "The machine isn't answering."); };
    try {
      const r = await Promise.race([Promise.resolve(send(w, 'POST', `/v1/agents/${id}/model`, { model: HAIKU })), new Promise<'waiting'>((t) => setTimeout(() => t('waiting'), 1000))]);
      expect(r).not.toBe('waiting');
      const body = (r as { json: () => Record<string, unknown> }).json();
      expect(body).toMatchObject({ model: HAIKU, classDetached: true });
      expect(body).not.toHaveProperty('limitsKept');
      expect(asked).toBe(0);
    } finally { gate.resolve(); }
  });

  it("limits a container kept when it left its class are traced with the container's own reason", async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-mem', ownerId: w.owner, name: 'Memory', model: SONNET, memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-mem');
    w.provider.awake = false;
    w.provider.updateMemory = async () => { throw new ProviderError('cannot connect', "The machine isn't answering."); };
    const r = await send(w, 'POST', `/v1/agents/${id}/model`, { model: HAIKU });
    expect(r.json()).toMatchObject({ classDetached: true, limitsKept: { name: 'Kitchen', why: "The machine isn't answering." } });
    const kept = w.store.listEvents([id], 200).filter((e) => e.event === 'memory.limits_kept');
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept[0])).toContain("The machine isn't answering.");
    expect(JSON.stringify(kept[0])).toContain('its class was taken off');
  });

  it('a budget tell finds a section that says its cap in the seed\'s words current, and writes another cap in the live words', async () => {
    const { w, id, ref } = await setup();
    w.store.setAgentMemoryCap(id, '2g');
    const book = playbookOf(w);
    book.text = `# How I work\n\n${memoryBudgetSection('2g')}\n`;
    expect(await syncMemoryBudget({ store: w.store, provider: w.provider }, id, ref, () => {})).toBe('current');
    expect(book.text).toBe(`# How I work\n\n${memoryBudgetSection('2g')}\n`);
    w.store.setAgentMemoryCap(id, '3g');
    expect(await syncMemoryBudget({ store: w.store, provider: w.provider }, id, ref, () => {})).toBe('written');
    expect(book.text).toContain(memoryBudgetSection('3g', { live: true }));
  });

  it("the manager says a class decision still to come, and a refused model with the limits its container kept", async () => {
    const pending = new HttpApiClient(async () => ({ model: HAIKU, live: true, classDetached: 'pending' }));
    expect(await pending.setModel('a1', HAIKU)).toMatch(/Its class is applying a change; whether it leaves the class is decided after\./);
    const refused = new HttpApiClient(async () => ({ model: HAIKU, failed: true, classDetached: true, limitsKept: { name: 'Kitchen', why: 'a made-up reason' } }));
    await expect(refused.setModel('a1', HAIKU)).rejects.toThrow(/did not take .*try set_model again\. It left its class, but its container kept its old memory limits \(a made-up reason\)/);
  });

  it('the source menu leaves out an agent on a machine not known here, rather than failing', async () => {
    const { w } = await setup();
    const g = await seedRunningAgent(w, { id: 'g2', name: 'Garden 2', slug: 'garden-2', accountId: 'garden2bot' });
    w.store.setAgentAIProfile(g, 'key');
    w.store.setAgentHost(g, 'h-gone');
    const r = await send(w, 'GET', '/v1/ai-profiles/key/available-models');
    expect(r.statusCode, r.body).toBe(200);
  });

  it("a class edit's members are worked through six at a time, not one by one", async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-mem', ownerId: w.owner, name: 'Memory', memoryCap: '2g' });
    const ids = [id];
    for (let i = 2; i <= 8; i++) {
      const g = await seedRunningAgent(w, { id: `g${i}`, name: `Garden ${i}`, slug: `garden-${i}`, accountId: `garden${i}bot` });
      w.store.setAgentAIProfile(g, 'key');
      ids.push(g);
    }
    for (const a of ids) w.store.setAgentClassIf(a, w.store.getAgent(a)?.classId ?? null, 'c-mem');
    const update = w.provider.updateMemory.bind(w.provider);
    let at = 0, most = 0;
    w.provider.updateMemory = async (r, cap, swap) => {
      most = Math.max(most, ++at);
      await new Promise((t) => setTimeout(t, 50));
      at--;
      return update(r, cap, swap);
    };
    const edit = await send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '1g' });
    expect(edit.json()).toMatchObject({ applied: 8, skipped: [] });
    expect(most).toBe(6);
    most = 0;
    const gone = await send(w, 'DELETE', '/v1/agent-classes/c-mem');
    expect(gone.json()).toMatchObject({ removed: true, skipped: [] });
    expect(most).toBe(6);
  });

  it('a budget tell waits for its busy agent however long that takes, and tells it once free', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-mem', ownerId: w.owner, name: 'Memory', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-mem');
    const book = playbookOf(w);
    markBusy(id);
    try {
      expect((await send(w, 'PUT', '/v1/agent-classes/c-mem', { memoryCap: '1g' })).statusCode).toBe(200);
      // Longer than a tell that looked again every so often would wait before giving up.
      await new Promise((r) => setTimeout(r, 8_000));
      expect(book.reads).toBe(0);
    } finally { clearBusy(id); }
    await settle(() => book.text.includes('**1 GB**'));
    expect(book.text).toMatch(/\*\*1 GB\*\*/);
    expect(w.store.listEvents([id], 200).some((e) => e.event === 'memory.budget_not_told')).toBe(false);
  }, 20_000);

  it("the manager's set_model receipt says a memory limit its container kept when it left its class", async () => {
    // Worded from the parts beside the sentence, never from the sentence itself.
    const api = new HttpApiClient(async () => ({ model: HAIKU, live: true, classDetached: true, memoryPending: 'Words the manager does not read.', limitsKept: { name: 'Kitchen', why: 'the daemon is away' } }));
    expect(await api.setModel('a1', HAIKU)).toBe(`It answers on ${HAIKU} from its next message. It left its class, but its container kept its old memory limits (the daemon is away); a rebuild applies them.`);
  });

  it('a join whose class was changed by another path while it waited writes nothing, and says so', async () => {
    const { w, id, ref } = await setup();
    for (const [c, name] of [['c-a', 'A'], ['c-z', 'Z']] as const) w.store.upsertAgentClass({ id: c, ownerId: w.owner, name, memoryCap: '4g' });
    w.store.upsertAgentClass({ id: 'c-b', ownerId: w.owner, name: 'B', memoryCap: '4g', image: NEW_IMAGE });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-a');
    // The join's image check reads its container: it waits there.
    const gate = deferred(), reached = deferred();
    const info = w.provider.info.bind(w.provider);
    w.provider.info = async (r) => { if (r === ref) { reached.resolve(); await gate.promise; } return info(r); };
    const join = Promise.resolve(send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-b' }));
    await reached.promise;
    // Meanwhile the agent is put in Z by a path outside the queues.
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-z');
    gate.resolve();
    const joined = await join;
    expect(joined.statusCode).toBe(409);
    expect(joined.json().error).toMatch(/changed while this applied\. Nothing was changed/);
    expect(w.store.getAgent(id)!.classId).toBe('c-z');
  });

  it("an agent's own model change made while it joins a class stands, and the join is refused", async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: OPUS55, image: NEW_IMAGE });
    // The join's image check reads its container: it waits there.
    const gate = deferred(), reached = deferred();
    const info = w.provider.info.bind(w.provider);
    let held = false;
    w.provider.info = async (r) => { if (!held && r === ref) { held = true; reached.resolve(); await gate.promise; } return info(r); };
    const join = Promise.resolve(send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-tier' }));
    await reached.promise;
    const own = await send(w, 'POST', `/v1/agents/${id}/model`, { model: HAIKU });
    expect(own.json()).toMatchObject({ model: HAIKU });
    gate.resolve();
    const joined = await join;
    expect(joined.statusCode).toBe(409);
    expect(w.store.getAgent(id)).toMatchObject({ model: HAIKU });
    expect(w.store.getAgent(id)!.classId).toBeFalsy();
    expect(w.store.getAgent(id)!.image).toBeUndefined();
  });

  it("a class edit's memory limits never land on an agent that left the class while they applied", async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: SONNET, memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    const gate = deferred(), reached = deferred();
    const update = w.provider.updateMemory.bind(w.provider);
    let first = true;
    w.provider.updateMemory = async (r, cap, swap) => { if (first && r === ref) { first = false; reached.resolve(); await gate.promise; } return update(r, cap, swap); };
    const edit = Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-tier', { memoryCap: '1g' }));
    await reached.promise;
    // It leaves the class (its own model) while the class's limits are on their
    // way: the edit's records are written, so it leaves at once, and its own
    // limits go on after the edit's, in its turn.
    const moved = Promise.resolve(send(w, 'POST', `/v1/agents/${id}/model`, { model: HAIKU }));
    await settle(() => !w.store.getAgent(id)!.classId);
    gate.resolve();
    expect((await moved).json()).toMatchObject({ classDetached: true });
    expect((await edit).statusCode).toBe(200);
    await settle(() => w.provider.memoryUpdates.filter((u) => u.runtimeRef === ref).length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(w.store.getAgent(id)!.classId).toBeFalsy();
    expect(w.provider.memoryUpdates.filter((u) => u.runtimeRef === ref).at(-1)!.cap).not.toBe('1g');
  });

  it("a peer revoked while a budget tell works is not put back by it: the tell writes its section alone", async () => {
    const { w, id } = await setup();
    expect(isBusy(id)).toBe(false);
    const m2 = await seedRunningAgent(w, { id: 'm2', name: 'Member 2', slug: 'member-2', accountId: 'member2bot' });
    w.store.setAgentPeers(id, [m2]);
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    const book = playbookOf(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    // Its call-agent tool, installed and removed; the first install after the edit waits.
    // Put back once removed, it was undone, even if a later sync removed it again.
    let installed = true, undone = false;
    const gate = deferred(), reached = deferred();
    let holding = true, revoked = false;
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (r, script, opts) => {
      if (r === ref && script.includes('base64 -d > ~/.openclaw/peers.json')) {
        if (holding) { holding = false; reached.resolve(); await gate.promise; }
        if (revoked) undone = true;
        installed = true;
      }
      if (r === ref && script.startsWith('rm -f ~/.local/bin/call-agent')) installed = false;
      return shell(r, script, opts);
    };
    expect((await send(w, 'PUT', '/v1/agent-classes/c-tier', { memoryCap: '1g' })).statusCode).toBe(200);
    await Promise.race([reached.promise, settle(() => book.text.includes('**1 GB**'), 2000)]);
    // Revoked, and a sync that holds the agent takes the tool away.
    expect((await send(w, 'PUT', `/v1/agents/${id}/peers`, { peerIds: [] })).statusCode).toBe(200);
    revoked = true;
    expect((await send(w, 'PUT', '/v1/operator-profile', { content: 'The Example household.' })).statusCode).toBe(202);
    await settle(() => !installed);
    expect(installed).toBe(false);
    gate.resolve();
    await settle(() => book.text.includes('**1 GB**'));
    await new Promise((r) => setTimeout(r, 50));
    expect(undone).toBe(false);
    expect(installed).toBe(false);
    expect(book.text).toMatch(/\*\*1 GB\*\*/);
  });

  it('a member left busy holds up none of the others: each is told its budget on its own', async () => {
    const { w, id } = await setup();
    const m2 = await seedRunningAgent(w, { id: 'm2', name: 'Member 2', slug: 'member-2', accountId: 'member2bot' });
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier'); w.store.setAgentClassIf(m2, w.store.getAgent(m2)?.classId ?? null, 'c-tier');
    const book = playbookOf(w);
    markBusy(id); // the first member: a backup that takes a while
    try {
      expect((await send(w, 'PUT', '/v1/agent-classes/c-tier', { memoryCap: '1g' })).statusCode).toBe(200);
      await settle(() => book.text.includes('**1 GB**'), 1000);
      expect(book.text).toMatch(/\*\*1 GB\*\*/); // the second member's, while the first still waits
      expect(book.reads).toBe(1);
    } finally { clearBusy(id); }
    await settle(() => book.reads >= 2);
  });

  it("an agent's own memory cap set while a class's limits are on their way is the one its container keeps", async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    const gate = deferred(), reached = deferred();
    const update = w.provider.updateMemory.bind(w.provider);
    let first = true;
    w.provider.updateMemory = async (r, cap, swap) => { if (first && r === ref) { first = false; reached.resolve(); await gate.promise; } return update(r, cap, swap); };
    const edit = Promise.resolve(send(w, 'PUT', '/v1/agent-classes/c-tier', { memoryCap: '1g' }));
    await reached.promise;
    const own = Promise.resolve(send(w, 'PATCH', `/v1/agents/${id}`, { memoryCap: '3g' }));
    await new Promise((r) => setTimeout(r, 50));
    gate.resolve();
    expect((await own).statusCode).toBe(200);
    expect((await edit).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.memoryCap).toBe('3g');
    expect(w.provider.memoryUpdates.filter((u) => u.runtimeRef === ref).at(-1)!.cap).toBe('3g');
  });

  it("the budget's check and rename take the AGENTS.md turn a save takes, not the busy flag", async () => {
    const { w, id, ref } = await setup();
    expect(isBusy(id)).toBe(false);
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    const book = playbookOf(w);
    const gate = deferred(), reached = deferred();
    const order: string[] = [];
    let busyAtSwap: boolean | undefined;
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (r, script, opts) => {
      if (r === ref && /sha256sum[\s\S]*mv -f/.test(script)) { busyAtSwap = isBusy(id); order.push('budget'); reached.resolve(); await gate.promise; }
      else if (r === ref && /AGENTS\.md"\.tmp && mv/.test(script)) order.push('save');
      return shell(r, script, opts);
    };
    expect((await send(w, 'PUT', '/v1/agent-classes/c-tier', { memoryCap: '1g' })).statusCode).toBe(200);
    await reached.promise;
    expect(busyAtSwap).toBe(false);
    // A save asked now waits for its turn.
    const save = Promise.resolve(send(w, 'PUT', `/v1/agents/${id}/files/AGENTS.md`, { content: '# Saved by its owner\n' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(['budget']);
    gate.resolve();
    expect((await save).statusCode).toBe(200);
    expect(order).toEqual(['budget', 'save']);
    expect(book.text).toBe('# Saved by its owner\n');
  });

  it('a budget sync that finds its agent busy waits and tells it once it is free', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    const book = playbookOf(w);
    markBusy(id);
    try {
      expect((await send(w, 'PUT', '/v1/agent-classes/c-tier', { memoryCap: '1g' })).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 200));
      expect(book.reads).toBe(0);
    } finally { clearBusy(id); }
    await settle(() => book.text.includes('**1 GB**'));
    expect(book.text).toMatch(/\*\*1 GB\*\*/);
  });

  it("the budget sync's write is staged, checked and renamed in one go, all in the AGENTS.md turn", async () => {
    const scripts: string[] = [];
    const held: string[] = [];
    const provider = {
      execShell: async (_ref: string, script: string) => { scripts.push(script); return { code: 0, stdout: '', stderr: '' }; },
    } as unknown as import('../src/providers/provider.js').RuntimeProvider;
    const sha = 'a'.repeat(64);
    const { writeFileInAgent, ARGV_SAFE_B64 } = await import('../src/orchestrator/snapshots.js');
    // Without a turn: one shell, the content first, then the hash, then the rename.
    await writeFileInAgent(provider, 'mock://x', '/home/node/AGENTS.md', 'IyBIZWxsbwo=', {}, { sha256: sha });
    const one = scripts[0]!;
    expect(one.indexOf('base64 -d')).toBeLessThan(one.indexOf('sha256sum'));
    expect(one.indexOf('sha256sum')).toBeLessThan(one.indexOf('mv -f'));
    // With one: nothing at all until the turn is ours, then that same one shell
    // in it. The staged file never waits in the workspace for the turn.
    scripts.length = 0;
    const turn = deferred();
    const writing = writeFileInAgent(provider, 'mock://x', '/home/node/AGENTS.md', 'IyBIZWxsbwo=', {}, {
      sha256: sha,
      hold: async (commit) => { await turn.promise; held.push(`from ${scripts.length}`); const out = await commit(); held.push(`to ${scripts.length}`); return out; },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(scripts).toEqual([]);
    turn.resolve();
    await writing;
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/base64 -d > "\/home\/node\/AGENTS\.md\.tmp-[0-9a-f]+"; \[ "\$\(sha256sum[\s\S]*mv -f/);
    expect(held).toEqual(['from 0', 'to 1']);
    // Larger content: staged on the volume and renamed, both in the turn.
    const order: string[] = [];
    const big = {
      execShell: async (_ref: string, script: string) => { order.push(script.startsWith('rm -f') ? 'rm' : 'swap'); return { code: 0, stdout: '', stderr: '' }; },
      writeToVolume: async () => { order.push('stage'); return { code: 0, stdout: '', stderr: '' }; },
    } as unknown as import('../src/providers/provider.js').RuntimeProvider;
    await writeFileInAgent(big, 'mock://x', '/home/node/AGENTS.md', 'A'.repeat(ARGV_SAFE_B64 + 4), {}, {
      sha256: sha, hold: async (commit) => { order.push('turn'); const out = await commit(); order.push('end'); return out; },
    });
    expect(order).toEqual(['turn', 'stage', 'swap', 'end']);
    // The turn failing before it is ours: nothing staged, nothing to remove.
    scripts.length = 0;
    await expect(writeFileInAgent(provider, 'mock://x', '/home/node/AGENTS.md', 'IyBIZWxsbwo=', {}, {
      sha256: sha, hold: async () => { throw new Error('made-up failure'); },
    })).rejects.toThrow('made-up failure');
    expect(scripts).toEqual([]);
    // Refused, failed or thrown in the turn: the staged file removed, in the turn.
    for (const fail of [
      () => ({ code: 3, stdout: '', stderr: 'it changed meanwhile' }),
      () => ({ code: 1, stdout: '', stderr: 'made-up: no space left' }),
      () => { throw new Error('made-up exec failure'); },
    ]) {
      const seen: string[] = [];
      const failing = {
        execShell: async (_ref: string, script: string) => { seen.push(script); return seen.length === 1 ? fail() : { code: 0, stdout: '', stderr: '' }; },
      } as unknown as import('../src/providers/provider.js').RuntimeProvider;
      let inTurn = 0;
      await writeFileInAgent(failing, 'mock://x', '/home/node/AGENTS.md', 'IyBIZWxsbwo=', {}, {
        sha256: sha, hold: async (commit) => { try { return await commit(); } finally { inTurn = seen.length; } },
      }).catch(() => undefined);
      expect(seen).toHaveLength(2);
      expect(seen[1]).toMatch(/^rm -f "\/home\/node\/AGENTS\.md\.tmp-[0-9a-f]+"$/);
      expect(inTurn).toBe(2);
    }
  });

  it('a pin that drops its class tells the agent its budget, as no rebuild was started with it', async () => {
    const { w, id } = await setup();
    w.store.upsertAgentClass({ id: 'c-img', ownerId: w.owner, name: 'Trial image', image: NEW_IMAGE, memoryCap: '2g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-img');
    w.store.setAgentImage(id, NEW_IMAGE);
    const book = playbookOf(w);
    const pinned = await send(w, 'PATCH', `/v1/agents/${id}`, { image: OLD_IMAGE });
    expect(pinned.statusCode).toBe(200);
    expect(w.store.getAgent(id)!.classId).toBeFalsy();
    await settle(() => book.reads > 0 && !book.text.includes('**8 GB**'));
    expect(book.text).toMatch(/## Memory budget/);
    expect(book.text).not.toMatch(/\*\*8 GB\*\*|\*\*2 GB\*\*/);
  });

  it('a class model the rebuild under way did not put on, nor a try after it, is traced and shown as still to come', async () => {
    const { w, id } = await setup();
    expect(isBusy(id)).toBe(false);
    w.store.setAgentAIProfile(id, 'p1');
    w.store.setAIProfileModels('p1', [HAIKU, SONNET]);
    w.store.setAgentApplied(id, 'p1', 'claude-opus-4-8');
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: HAIKU });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    // The rebuild waits, then fails; the runtime refuses the model after it.
    const gate = deferred(), reached = deferred();
    w.provider.provision = async () => { reached.resolve(); await gate.promise; throw new Error('made-up provision failure'); };
    const exec = w.provider.exec.bind(w.provider);
    w.provider.exec = async (ref, args, opts) => (args[0] === 'models' && args[1] === 'set' ? { code: 1, stdout: '', stderr: 'made-up refusal' } : exec(ref, args, opts));
    expect((await send(w, 'POST', `/v1/agents/${id}/rebuild`, {})).statusCode).toBe(202);
    await reached.promise;
    const out = (await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: SONNET })).json();
    expect(out).toMatchObject({ applied: 1, modelPending: [] });
    gate.resolve();
    await rebuilt(w, id);
    await settle(() => w.store.listEvents([id], 200).some((e) => e.event === 'model.apply_failed'));
    expect(w.store.listEvents([id], 200).find((e) => e.event === 'model.apply_failed')?.detail).toMatchObject({ model: SONNET });
    const seen = (await send(w, 'GET', `/v1/agents/${id}`)).json();
    expect((seen.agent ?? seen).pendingModel).toBe(SONNET);
  });

  it('a class model put on while a rebuild is under way is applied there, not said to be pending', async () => {
    const { w, id } = await setup();
    expect(isBusy(id)).toBe(false);
    // On "p1", whose key the made-up world holds, so a rebuild renders.
    w.store.setAgentAIProfile(id, 'p1');
    w.store.setAIProfileModels('p1', [HAIKU, SONNET]);
    w.store.setAgentApplied(id, 'p1', 'claude-opus-4-8');
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: HAIKU });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    // The rebuild waits past the step that writes the model.
    const gate = deferred(), reached = deferred();
    const provision = w.provider.provision.bind(w.provider);
    w.provider.provision = async (spec) => { reached.resolve(); await gate.promise; return provision(spec); };
    expect((await send(w, 'POST', `/v1/agents/${id}/rebuild`, {})).statusCode).toBe(202);
    await reached.promise;
    const out = (await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: SONNET })).json();
    expect(out).toMatchObject({ applied: 1, modelPending: [] });
    gate.resolve();
    await rebuilt(w, id);
    await settle(() => w.store.getAgent(id)!.appliedModel === SONNET);
    expect(w.store.getAgent(id)!.appliedModel).toBe(SONNET);
  });

  it('a switch whose rebuild is refused puts the limits that apply on now', async () => {
    const { w, id, ref } = await setup();
    // A copy moved away is never rebuilt here: the kick is refused.
    w.store.setAgentMigratedTo(id, 'garage-box');
    w.store.upsertAgentClass({ id: 'c-key', ownerId: w.owner, name: 'On the key', aiProfileId: 'key' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-key');
    const before = w.provider.memoryUpdates.length;
    const moved = await send(w, 'POST', '/v1/ai-profiles/p1/adopt-agents', { apply: [id], rebuild: true });
    expect(moved.json()).toMatchObject({ switched: 1, classDetached: 1, rebuilding: 0 });
    // A class with no limits of its own: its container's are left as they are.
    expect(w.provider.memoryUpdates.slice(before).filter((u) => u.runtimeRef === ref)).toHaveLength(0);
    // One with a memory cap: its limits come off now after all.
    w.store.upsertAgentClass({ id: 'c-large', ownerId: w.owner, name: 'Large jobs', aiProfileId: 'p1', memoryCap: '8g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-large');
    const back = await send(w, 'POST', '/v1/ai-profiles/key/adopt-agents', { apply: [id], rebuild: true });
    expect(back.json()).toMatchObject({ switched: 1, classDetached: 1, rebuilding: 0 });
    expect(w.provider.memoryUpdates.at(-1)).toMatchObject({ runtimeRef: ref });
    expect(w.provider.memoryUpdates.at(-1)!.cap).not.toBe('8g');
  });

  it('a switch with a rebuild leaves the old container alone and puts the limits on the new one; without one, the limits go on now', async () => {
    const { w, id, ref } = await setup();
    w.store.upsertAgentClass({ id: 'c-large', ownerId: w.owner, name: 'Large jobs', aiProfileId: 'key', memoryCap: '8g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-large');
    const book = playbookOf(w);
    const log: string[] = [];
    const provision = w.provider.provision.bind(w.provider), update = w.provider.updateMemory.bind(w.provider);
    w.provider.provision = async (spec) => { log.push('create'); return provision(spec); };
    w.provider.updateMemory = async (r, cap, swap) => { if (r === ref) log.push(`update ${cap}`); return update(r, cap, swap); };
    const moved = await send(w, 'POST', '/v1/ai-profiles/p1/adopt-agents', { apply: [id], rebuild: true });
    expect(moved.json()).toMatchObject({ switched: 1, classDetached: 1, rebuilding: 1 });
    await rebuilt(w, id);
    await settle(() => log.some((l) => l.startsWith('update')));
    // Nothing on the container the rebuild replaced; the limits that apply, on the one it made.
    expect(log[0]).toBe('create');
    expect(log.filter((l) => l.startsWith('update'))).not.toContain('update 8g');
    // Without a rebuild: the limits that apply now, and the agent hears its
    // budget, which is its container's, whatever source it waits to switch to.
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-large');
    w.store.upsertAgentClass({ id: 'c-large', ownerId: w.owner, name: 'Large jobs', aiProfileId: 'p1', memoryCap: '8g' });
    book.text = book.text.replace(/\*\*[^*]+\*\* of memory/, '**8 GB** of memory');
    const reads = book.reads;
    const back = await send(w, 'POST', '/v1/ai-profiles/key/adopt-agents', { apply: [id] });
    expect(back.json()).toMatchObject({ switched: 1, classDetached: 1, rebuilding: 0 });
    expect(w.provider.memoryUpdates.at(-1)).toMatchObject({ runtimeRef: ref });
    expect(w.provider.memoryUpdates.at(-1)!.cap).not.toBe('8g');
    await settle(() => book.reads > reads && !book.text.includes('**8 GB**'));
    expect(book.text).not.toMatch(/\*\*8 GB\*\*/);
  });

  it('the default-model sweep tells a detached agent its budget, and names a container that kept its limits', async () => {
    const { w, id } = await setup();
    expect(isBusy(id)).toBe(false); // the busy flags are the module's: none left by an earlier test
    const book = playbookOf(w);
    w.store.upsertAgentClass({ id: 'c-sonnet', ownerId: w.owner, name: 'Sonnet jobs', model: SONNET, memoryCap: '1g' });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-sonnet');
    w.store.setAgentModel(id, SONNET);
    book.text = '# How I work\n\n## Memory budget\n- Your container has **1 GB** of memory in total.\n';
    const swept = await send(w, 'POST', '/v1/ai-profiles/key/apply-default-model', { model: HAIKU, models: [SONNET, OPUS55], apply: [id] });
    expect(swept.json()).toMatchObject({ applied: 1, classDetached: 1, live: 1 });
    expect(swept.json().memoryPending).toBeUndefined();
    await settle(() => !book.text.includes('**1 GB**'));
    expect(book.text).toMatch(/## Memory budget/);
    expect(book.text).not.toMatch(/\*\*1 GB\*\*/);
    // A container that keeps its limits is named in the answer.
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-sonnet');
    w.store.setAgentModel(id, SONNET);
    w.provider.updateMemory = async () => { throw new Error('the daemon is away'); };
    const kept = await send(w, 'POST', '/v1/ai-profiles/key/apply-default-model', { model: OPUS55, models: [SONNET, HAIKU], apply: [id] });
    expect(kept.json().memoryPending).toEqual([expect.stringMatching(/^Kitchen: Its container kept its old memory limits/)]);
  });

  it('HB-0560: an agent joining a class while the class is edited gets the edit', async () => {
    const { w, id, ref } = await setup();
    onPlan(w, id, ref, '2026.9.8');
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: OPUS55 });
    // The runtime check reads its container: the join waits there.
    const gate = deferred(), reached = deferred();
    const info = w.provider.info.bind(w.provider);
    let held = false;
    w.provider.info = async (r) => { if (!held && r === ref) { held = true; reached.resolve(); await gate.promise; } return info(r); };
    const joining = Promise.resolve(send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c-tier' }));
    await reached.promise;
    // The edit is written while the join is checked (outside the queues): the
    // join then finds its check made for the class as it was, checks again,
    // and takes the edit.
    expect((await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: SONNET })).json()).toMatchObject({ applied: 0 });
    gate.resolve();
    expect((await joining).statusCode).toBe(200);
    expect(w.store.getAgent(id)).toMatchObject({ classId: 'c-tier', model: SONNET });
  });

  it('HB-0564: a busy member that already runs the class model as its source default is not pending', async () => {
    const { w, id } = await setup();
    w.store.restoreAgentApplied(id, {});
    w.store.setAgentModel(id, null);
    w.store.upsertAgentClass({ id: 'c-tier', ownerId: w.owner, name: 'Tier', model: HAIKU });
    w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c-tier');
    markBusy(id);
    let out;
    try { out = (await send(w, 'PUT', '/v1/agent-classes/c-tier', { model: SONNET })).json(); }
    finally { clearBusy(id); }
    expect(out).toMatchObject({ applied: 1, modelPending: [] });
  });

  it("a pin its source no longer offers is named in a refusal, not called no model of its own", async () => {
    const { w, id, ref } = await setup();
    onPlan(w, id, ref, '2026.9.8', 'claude-retired-1');
    const refused = await send(w, 'PATCH', `/v1/agents/${id}`, { image: OLD_IMAGE });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/Its model claude-retired-1 is no longer on its source's menu, so it would run the source's default, and claude-opus-5-5 needs OpenClaw 2026\.9\.7/);
    expect(refused.json().error).not.toMatch(/Without a model of its own/);
  });

  it('HB-0565: the source menu reads the runtime versions from one listing per machine, not an inspect per agent', async () => {
    const { w } = await setup();
    for (let i = 2; i <= 14; i++) {
      const id = await seedRunningAgent(w, { id: `g${i}`, name: `Garden ${i}`, slug: `garden-${i}`, accountId: `garden${i}bot` });
      w.store.setAgentAIProfile(id, 'key');
    }
    let inspects = 0;
    const info = w.provider.info.bind(w.provider);
    w.provider.info = async (r) => { inspects++; return info(r); };
    expect((await send(w, 'GET', '/v1/ai-profiles/key/available-models')).statusCode).toBe(200);
    expect(inspects).toBe(0);
    expect(w.provider.versionListings).toBe(1);
  });

  it('where the listing fails, the menu inspects no more than twelve agents', async () => {
    const { w } = await setup();
    for (let i = 2; i <= 14; i++) {
      const id = await seedRunningAgent(w, { id: `g${i}`, name: `Garden ${i}`, slug: `garden-${i}`, accountId: `garden${i}bot` });
      w.store.setAgentAIProfile(id, 'key');
    }
    w.provider.openclawVersions = async () => { throw new Error('made-up listing failure'); };
    let inspects = 0;
    const info = w.provider.info.bind(w.provider);
    w.provider.info = async (r) => { inspects++; return info(r); };
    expect((await send(w, 'GET', '/v1/ai-profiles/key/available-models')).statusCode).toBe(200);
    expect(inspects).toBe(12);
  });

  it("the docker provider's listing gives each container's OpenClaw label", async () => {
    const d = mkdtempSync(join(tmpdir(), 'hb-versions-'));
    closers.push(async () => rmSync(d, { recursive: true, force: true }));
    const log = join(d, 'argv.log'), stub = join(d, 'docker');
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nprintf 'hatchabot-garden-1|2026.9.8\\nhatchabot-garden-2|\\nsomething-else|1.0\\n'\n`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: stub });
    const v = await p.openclawVersions(['docker://hatchabot-garden-1', 'docker://hatchabot-garden-2', 'docker://hatchabot-garden-3']);
    expect([...v]).toEqual([['docker://hatchabot-garden-1', '2026.9.8']]);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([expect.stringMatching(/^ps --format /)]);
  });

  it("the docker provider keeps its listing a while, as it keeps an inspect, and asks again after a failure", async () => {
    const d = mkdtempSync(join(tmpdir(), 'hb-versions-'));
    closers.push(async () => rmSync(d, { recursive: true, force: true }));
    const log = join(d, 'argv.log'), stub = join(d, 'docker'), fail = join(d, 'fail');
    writeFileSync(stub, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ -e ${JSON.stringify(fail)} ]; then echo 'made-up daemon error' >&2; exit 1; fi
printf 'hatchabot-garden-1|2026.9.8\\n'
`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: stub });
    const refs = ['docker://hatchabot-garden-1'];
    const [a, b] = await Promise.all([p.openclawVersions(refs), p.openclawVersions(refs)]);
    const c = await p.openclawVersions(refs);
    for (const v of [a, b, c]) expect([...v]).toEqual([['docker://hatchabot-garden-1', '2026.9.8']]);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    // A failed listing is not kept: the next call asks again.
    const q = new LocalDockerProvider({ docker: stub });
    writeFileSync(fail, '');
    await expect(q.openclawVersions(refs)).rejects.toThrow(/docker ps failed/);
    rmSync(fail);
    expect([...(await q.openclawVersions(refs))]).toEqual([['docker://hatchabot-garden-1', '2026.9.8']]);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('a container started after the kept listing still gets its version: the machine is listed again, once', async () => {
    const d = mkdtempSync(join(tmpdir(), 'hb-versions-'));
    closers.push(async () => rmSync(d, { recursive: true, force: true }));
    const log = join(d, 'argv.log'), stub = join(d, 'docker'), started = join(d, 'started');
    writeFileSync(stub, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
printf 'hatchabot-garden-1|2026.9.8\\nhatchabot-garden-3|\\n'
if [ -e ${JSON.stringify(started)} ]; then printf 'hatchabot-garden-2|2026.9.9\\n'; fi
`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: stub });
    expect([...(await p.openclawVersions(['docker://hatchabot-garden-1']))]).toEqual([['docker://hatchabot-garden-1', '2026.9.8']]);
    // Started by another path since the listing was kept.
    writeFileSync(started, '');
    const v = await p.openclawVersions(['docker://hatchabot-garden-1', 'docker://hatchabot-garden-2']);
    expect([...v]).toEqual([['docker://hatchabot-garden-1', '2026.9.8'], ['docker://hatchabot-garden-2', '2026.9.9']]);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
    // One listed without a label is not "missing": no listing again for it.
    await p.openclawVersions(['docker://hatchabot-garden-3']);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('an exited container is not listed again on every ask: the second listing is kept as long as the first', async () => {
    const d = mkdtempSync(join(tmpdir(), 'hb-versions-'));
    closers.push(async () => rmSync(d, { recursive: true, force: true }));
    const log = join(d, 'argv.log'), stub = join(d, 'docker');
    writeFileSync(stub, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
printf 'hatchabot-garden-1|2026.9.8\\n'
`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: stub });
    const lines = () => readFileSync(log, 'utf8').trim().split('\n').length;
    expect([...(await p.openclawVersions(['docker://hatchabot-garden-1']))]).toHaveLength(1);
    // garden-2 has exited: the kept listing lacks it, so it is listed again, once.
    const refs = ['docker://hatchabot-garden-1', 'docker://hatchabot-garden-2'];
    expect([...(await p.openclawVersions(refs))]).toEqual([['docker://hatchabot-garden-1', '2026.9.8']]);
    expect(lines()).toBe(2);
    // Still not there: not running, from that listing, with no third.
    for (let i = 0; i < 3; i++) expect([...(await p.openclawVersions(refs))]).toEqual([['docker://hatchabot-garden-1', '2026.9.8']]);
    expect(lines()).toBe(2);
  });

  it("the docker provider's listing rejects when docker ps fails, rather than saying no versions", async () => {
    const d = mkdtempSync(join(tmpdir(), 'hb-versions-'));
    closers.push(async () => rmSync(d, { recursive: true, force: true }));
    const stub = join(d, 'docker');
    writeFileSync(stub, `#!/usr/bin/env bash
echo 'made-up daemon error' >&2
exit 1
`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: stub });
    await expect(p.openclawVersions(['docker://hatchabot-garden-1'])).rejects.toThrow(/docker ps failed/);
  });

  it('the machines are listed at once, not one after another', async () => {
    const { w } = await setup();
    const runner = new MockProvider();
    w.providers.set('mock2', runner);
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Runner', settings: {}, createdAt: 'now' } as never);
    const g = await seedRunningAgent(w, { id: 'g2', name: 'Garden 2', slug: 'garden-2', accountId: 'garden2bot' });
    w.store.setAgentAIProfile(g, 'key');
    w.store.setAgentHost(g, 'h2');
    // Each machine's listing answers only once the other's has started, or after a while.
    const started = { here: deferred(), there: deferred() };
    let together = true;
    const wait = (other: Promise<void>) => Promise.race([other, new Promise<void>((r) => setTimeout(() => { together = false; r(); }, 300))]);
    const here = w.provider.openclawVersions.bind(w.provider), there = runner.openclawVersions.bind(runner);
    w.provider.openclawVersions = async (refs) => { started.here.resolve(); await wait(started.there.promise); return here(refs); };
    runner.openclawVersions = async (refs) => { started.there.resolve(); await wait(started.here.promise); return there(refs); };
    expect((await send(w, 'GET', '/v1/ai-profiles/key/available-models')).statusCode).toBe(200);
    expect(together).toBe(true);
  });

  it('a machine whose listing failed is read by inspecting its agents, six at a time, and its newest runtime is still found', async () => {
    const { w } = await setup();
    for (let i = 2; i <= 14; i++) {
      const id = await seedRunningAgent(w, { id: `g${i}`, name: `Garden ${i}`, slug: `garden-${i}`, accountId: `garden${i}bot` });
      w.store.setAgentAIProfile(id, 'key');
    }
    const refs = w.store.listAgents(w.owner).filter((a) => a.aiProfileId === 'key' && a.state === 'RUNNING').map((a) => a.runtimeRef!);
    // Within the first twelve, the most a failed listing has inspected.
    const newest = refs[5]!;
    for (const ref of refs) w.provider.infoOverride.set(ref, { openclawVersion: ref === newest ? '2026.9.8' : '2026.9.6' });
    w.provider.openclawVersions = async () => { throw new Error('made-up listing failure'); };
    let open = 0, most = 0;
    const info = w.provider.info.bind(w.provider);
    w.provider.info = async (r) => { open++; most = Math.max(most, open); await new Promise((t) => setTimeout(t, 5)); try { return await info(r); } finally { open--; } };
    const asked: string[] = [];
    const exec = w.provider.exec.bind(w.provider);
    w.provider.exec = async (ref, args, opts) => { if (args[0] === 'models' && args[1] === 'list') asked.push(ref); return exec(ref, args, opts); };
    const res = await send(w, 'GET', '/v1/ai-profiles/key/available-models');
    expect(res.statusCode).toBe(200);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(6);
    expect(asked[0]).toBe(newest);
  });
});
