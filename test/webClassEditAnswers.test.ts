/**
 * The page's updateClass (web/index.html as shipped) against a class edit
 * that waited behind the class's deletion and answered 404: said as
 * deleted, and the list is read again (HB-0560). A plain answer still says
 * how many it applied to.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeWorld, seedRunningAgent, as } from './support/world.js';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const js = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
function source(name: string): string {
  const m = new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?^\\}`, 'm').exec(js);
  if (!m) throw new Error(`no function ${name} in web/index.html`);
  return m[0];
}

const LIGHT = { id: 'c1', name: 'Light', model: 'claude-haiku-4-5' };
const HEAVY = { id: 'c2', name: 'Heavy', model: 'claude-opus-5-5' };

function page(answer: Record<string, unknown> | Error) {
  const toasts: string[] = [];
  const reloads: string[] = [];
  const c = vm.createContext({
    Promise, String, JSON,
    agentClasses: [{ ...LIGHT }, { ...HEAVY }],
    api: async () => { if (answer instanceof Error) throw answer; return answer; },
    toast: (t: string) => { toasts.push(t); },
    refresh: async () => {},
    // As the real list does: every class's name.
    renderClassList: () => { (c as unknown as { agentClasses: Array<{ name: string }> }).agentClasses.map((k) => k.name.trim()); },
    loadClasses: async () => { reloads.push('classes'); },
  });
  vm.runInContext(source('updateClass'), c);
  return { c: c as Record<string, any>, toasts, reloads };
}

describe('updateClass reads the class edit as it was answered', () => {
  it('an edit answered 404, the class deleted ahead of it, says so and reads the list again', async () => {
    const { c, toasts, reloads } = page(Object.assign(new Error('Not found'), { status: 404 }));
    await c.updateClass('c1', 'model', 'claude-sonnet-5');
    expect(toasts).toEqual(['That class was deleted meanwhile.']);
    expect(reloads).toEqual(['classes']);
  });

  it('any other refusal is said as it came', async () => {
    const { c, toasts, reloads } = page(Object.assign(new Error('That image tag is not valid.'), { status: 400 }));
    await c.updateClass('c1', 'image', 'not a tag');
    expect(toasts).toEqual(['That image tag is not valid.']);
    expect(reloads).toEqual(['classes']);
  });

  it('an edit that reached every member still says how many it applied to', async () => {
    const { c, toasts } = page({ class: LIGHT, applied: 2, needRebuild: 0, skipped: [], modelPending: [] });
    await c.updateClass('c1', 'model', 'claude-haiku-4-5');
    expect(toasts).toEqual(['Class updated — applied to 2.']);
  });
});

describe("the class row's count of members still on an old model", () => {
  it('counts a member pinned to the class model whose runtime still runs the old one, as the agent list sends it', async () => {
    const w = await makeWorld();
    try {
      w.store.insertAIProfile({ id: 'key', ownerId: w.owner, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', models: ['claude-haiku-4-5'], secretRef: 'ai/key', createdAt: 'now' });
      w.store.upsertAgentClass({ id: 'c1', ownerId: w.owner, name: 'Light', model: 'claude-haiku-4-5' });
      const behind = await seedRunningAgent(w), caught = await seedRunningAgent(w, { id: 'a2', name: 'Garden', slug: 'garden', accountId: 'gardenbot' });
      for (const id of [behind, caught]) { w.store.setAgentAIProfile(id, 'key'); w.store.setAgentClassIf(id, w.store.getAgent(id)?.classId ?? null, 'c1'); w.store.setAgentModel(id, 'claude-haiku-4-5'); }
      // The class's model is the pin of both; one runtime refused it and still runs the old.
      w.store.setAgentApplied(behind, 'key', 'claude-sonnet-5');
      w.store.setAgentApplied(caught, 'key', 'claude-haiku-4-5');
      const agents = (await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as() })).json();
      const list = { innerHTML: '' };
      const c = vm.createContext({
        agentClasses: [{ id: 'c1', name: 'Light', model: 'claude-haiku-4-5' }], agents, myAccount: {},
        $: () => list, esc: (x: string) => x, jsq: (x: string) => x,
        classModelOptions: () => '', classSourceOptions: () => '', classImageOptions: () => '', classMemoryOptions: () => '', classSwapOptions: () => '',
      });
      vm.runInContext(source('renderClassList'), c);
      (c as Record<string, any>).renderClassList();
      expect(list.innerHTML).toContain('2 agents');
      expect(list.innerHTML).toContain('1 still on an old model');
    } finally { await w.f.close(); }
  });
});
