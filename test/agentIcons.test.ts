import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { completeViaCli } from '../src/api/cliChatModel.js';
import { ICON_PALETTE, IDEA_COUNT, WANT_MAX, colorFor, keywordIcon, parseChoices, parseIdeas, pickIcons, suggestIcons, validIcon, validIconColor } from '../src/orchestrator/agentIcons.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { Agent, AIProfile } from '../src/domain/types.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };

function agent(id: string, name: string, extra: Partial<Agent> = {}): Agent {
  return {
    id, ownerId: OWNER, name, slug: id, state: 'RUNNING', aiProfileId: 'p', hostId: 'mock',
    persona: '', sharedMemory: false, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra,
  } as Agent;
}

async function world(reply?: string | Error, stopReason = 'end_turn') {
  const store = new Store(new Database(':memory:'));
  const logs: string[] = [];
  const f = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => { logs.push(line); } } } });
  const calls: string[] = [];
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
    mgmtLlmComplete: async (_s, _p, req) => {
      calls.push(JSON.stringify(req.messages));
      if (reply instanceof Error) throw reply;
      return { stopReason, content: [{ type: 'text', text: reply ?? '[]' }] };
    },
  });
  return { store, f, calls, logs };
}

const PROFILE = {
  id: 'p', ownerId: OWNER, name: 'Key', vendor: 'anthropic', kind: 'api_key',
  model: 'claude-sonnet-5', secretRef: 'ai/p', createdAt: 'now',
} as AIProfile;

describe('icon validation', () => {
  it('accepts one emoji, including ZWJ sequences, flags and variation selectors', () => {
    for (const ok of ['📈', '⚖️', '👩‍💻', '🇨🇦', '👍🏽', '☂️']) expect(validIcon(ok), ok).toBe(true);
  });
  it('accepts a keycap, the one emoji that starts with a digit (audit, 2026-10-22)', () => {
    for (const ok of ['1️⃣', '#️⃣', '*️⃣', '0⃣']) expect(validIcon(ok), ok).toBe(true);
    for (const bad of ['1', '12️⃣', 'a️⃣', '1️⃣1️⃣', '1️⃣x']) expect(validIcon(bad), bad).toBe(false);
  });
  it('refuses text, markup, two emoji and empty', () => {
    for (const bad of ['', 'A', 'ab', '<b>', '📈📈', '1', '📈x', '"><img', ' 📈']) expect(validIcon(bad), bad).toBe(false);
  });
  it('colours must be #rrggbb', () => {
    expect(validIconColor('#3a8fd0')).toBe(true);
    for (const bad of ['red', '#fff', 'url(x)', '#3a8fd0;x']) expect(validIconColor(bad)).toBe(false);
  });
});

describe('picking icons', () => {
  it('keywords: name first, then the description, else a robot', () => {
    expect(keywordIcon('Stock Watcher')).toBe('📈');
    expect(keywordIcon('Helper', 'plans our trip to Sicily')).toBe('🧭');
    expect(keywordIcon('Zork')).toBe('🤖');
    expect(keywordIcon('Holiday list')).toBe('🎄');
    expect(keywordIcon('Location scout', 'education')).toBe('🤖'); // "cat" and "pet" only as words
  });
  it('colour is stable and from the palette', () => {
    expect(colorFor('Budget Tracker')).toBe(colorFor('budget tracker'));
    expect(ICON_PALETTE).toContain(colorFor('Budget Tracker'));
  });
  it('keeps only valid AI answers; the rest fall back per agent', async () => {
    const out = await pickIcons(
      [{ id: 'a', name: 'Stock Watcher' }, { id: 'b', name: 'Recipe Box' }, { id: 'c', name: 'Zork' }],
      async () => 'Sure! [{"id":"a","icon":"💹","color":"#3a8fd0"},{"id":"b","icon":"<script>","color":"#3a8fd0"},{"id":"c","icon":"🐉","color":"#123456"}]',
    );
    expect(out[0]).toEqual({ id: 'a', icon: '💹', color: '#3a8fd0', via: 'ai' });
    expect(out[1]).toMatchObject({ id: 'b', icon: '🍳', via: 'keywords' });   // bad icon → keywords
    expect(out[2]).toMatchObject({ id: 'c', icon: '🐉', color: colorFor('Zork'), via: 'ai' }); // off-palette colour → stable pick
  });
  it('a failing AI never blocks: everything falls back', async () => {
    const out = await pickIcons([{ id: 'a', name: 'Contract Reviewer' }], async () => { throw new Error('429'); });
    expect(out).toEqual([{ id: 'a', icon: '⚖️', color: colorFor('Contract Reviewer'), via: 'keywords' }]);
  });
  it('parseChoices ignores junk', () => {
    expect(parseChoices('no json here').size).toBe(0);
    expect(parseChoices('[{"id":1,"icon":"📈"}]').size).toBe(0);
  });
  it('still needs an id, however the reply is shaped: bare emoji and "emoji" entries pick nothing', () => {
    expect(parseChoices('["📈",{"icon":"🐂"},{"id":"a","emoji":"🐝"}]').size).toBe(0);
  });
  it('reads a damaged batch entry by entry, and the rest fall back per agent', async () => {
    const subjects = [{ id: 'a', name: 'Stock Watcher' }, { id: 'b', name: 'Recipe Box' }];
    const heard: unknown[] = [];
    const out = await pickIcons(subjects, async () => 'Note [1]: {"picks":[{"id":"a","icon":"💹","color":"#3a8fd0"},{"id":"b","icon":"🌮","col', (w) => heard.push(w));
    expect(out[0]).toEqual({ id: 'a', icon: '💹', color: '#3a8fd0', via: 'ai' });
    expect(out[1]).toMatchObject({ id: 'b', icon: '🍳', via: 'keywords' });
    expect(heard).toEqual([{ used: 1, of: 2, reply: { length: expect.any(Number), bracket: true, entries: 1, toolShaped: false, cutOff: true } }]);
  });
  it('says why it fell back, with the shape of the reply and none of its text (HB-0382)', async () => {
    const subjects = [{ id: 'a', name: 'Contract Reviewer' }];
    const heard: unknown[] = [];
    const out = await pickIcons(subjects, async () => ({ text: 'SECRETWORD no icons here', stopReason: 'max_tokens' }), (w) => heard.push(w));
    expect(out[0]!.via).toBe('keywords');
    expect(heard).toEqual([{ used: 0, of: 1, reply: { length: 24, bracket: false, entries: 0, toolShaped: false, cutOff: true, stopReason: 'max_tokens' } }]);
    expect(JSON.stringify(heard)).not.toContain('SECRETWORD');
    heard.length = 0;
    await pickIcons(subjects, async () => { throw new Error('429'); }, (w) => heard.push(w));
    expect(heard).toEqual([{ used: 0, of: 1, error: '429' }]);
    heard.length = 0;
    await pickIcons(subjects, async () => '[{"id":"a","icon":"⚖️"}]', (w) => heard.push(w));
    expect(heard).toEqual([]); // all picked: nothing to say
  });
});

describe('icon ideas (the icon dialog)', () => {
  it('asks once for several, keeps valid ones, and never repeats what was shown', async () => {
    const seen: string[] = [];
    const out = await suggestIcons({ name: 'Stock Watcher', persona: 'watches our shares' }, {
      exclude: ['📈', '⚖️'],
      complete: async (_system, user) => {
        seen.push(user);
        return '```json\n[{"icon":"📈","color":"#3aa36b"},{"icon":"⚖","color":"#3aa36b"},{"icon":"🔭","color":"#5a7fd6"},'
          + '{"icon":"<b>","color":"#5a7fd6"},{"icon":"🐂","color":"#123456"},{"icon":"🔭","color":"#d05a5a"},{"icon":"🪙"}]\n```';
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('Already shown: ["📈","⚖️"]');
    expect(seen[0]).toContain(`Give ${IDEA_COUNT}.`);
    // Shown ones are left out (⚖ without its selector too), markup is dropped, a repeat counts once,
    // and a missing or invented colour takes a stable palette pick.
    expect(out.via).toBe('ai');
    expect(out.ideas.map((i) => i.icon)).toEqual(['🔭', '🐂', '🪙']);
    expect(out.ideas[0]!.color).toBe('#5a7fd6');
    expect(ICON_PALETTE).toContain(out.ideas[1]!.color as (typeof ICON_PALETTE)[number]);
    expect(out.ideas[2]!.color).toBe(colorFor('Stock Watcher 🪙'));
  });
  it('caps the answer at the count asked for', async () => {
    const many = JSON.stringify(['🔭', '🐂', '🪙', '🧩', '🐝', '🌱', '🗺️', '🎯', '🧭', '🛰️'].map((icon) => ({ icon, color: '#3a8fd0' })));
    const out = await suggestIcons({ name: 'Stock Watcher' }, { complete: async () => many });
    expect(out.ideas).toHaveLength(IDEA_COUNT);
  });
  it('an AI answer with only repeats is an AI answer with nothing new', async () => {
    const out = await suggestIcons({ name: 'Stock Watcher' }, { exclude: ['🔭'], complete: async () => '[{"icon":"🔭","color":"#3a8fd0"}]' });
    expect(out).toEqual({ via: 'ai', ideas: [] });
  });
  it('without an AI, or when it fails or answers junk, the keyword table stands in', async () => {
    const cases = [
      [undefined, 'no-ai', undefined],
      [async () => { throw new Error('429 rate limited'); }, 'ai-failed', '429 rate limited'],
      [async () => 'no idea', 'ai-no-ideas', 'its answer held no emoji'],
    ] as const;
    for (const [complete, why, error] of cases) {
      const out = await suggestIcons({ name: 'Stock Watcher', persona: 'and our taxes' }, { complete });
      expect(out.via).toBe('keywords');
      expect(out.ideas.map((i) => i.icon)).toEqual(['📈', '🧾', '🤖']);
      expect([out.why, out.error]).toEqual([why, error]);
    }
    const again = await suggestIcons({ name: 'Stock Watcher', persona: 'and our taxes' }, { exclude: ['📈', '🧾', '🤖'] });
    expect(again).toEqual({ via: 'keywords', ideas: [], why: 'no-ai' });
  });
  it('what the owner asks for reaches the prompt, bounded, as data', async () => {
    const seen: string[] = [];
    const complete = async (_system: string, user: string) => { seen.push(user); return '[{"icon":"🎂","color":"#3aa36b"}]'; };
    const out = await suggestIcons({ name: 'Gift Planner' }, { complete, want: '  a   birthday cake ' + 'x'.repeat(200) });
    expect(out).toEqual({ via: 'ai', ideas: [{ icon: '🎂', color: '#3aa36b' }] });
    expect(seen[0]).toContain('The owner wants it to show: "a birthday cake x');
    expect(seen[0]).not.toContain('x'.repeat(WANT_MAX));
    await suggestIcons({ name: 'Gift Planner' }, { complete });
    expect(seen[1]).not.toContain('The owner wants');
  });
  it('without an AI, the owner\'s words come before the name in the keyword table', async () => {
    // Before: "Holiday list" matched nothing, and the only idea was 🤖.
    const named = await suggestIcons({ name: 'Holiday list' });
    expect(named.ideas.map((i) => i.icon)).toEqual(['🎄', '📝', '🤖']);
    const asked = await suggestIcons({ name: 'Recipe Box' }, { want: 'a gift for my mum' });
    expect(asked.ideas.map((i) => i.icon)).toEqual(['🎁', '🍳', '🤖']);
  });
  it('a reply held no ideas: the shape of it is kept for the log, never its text (HB-0382)', async () => {
    const shape = async (text: string, stopReason?: string) =>
      (await suggestIcons({ name: 'Stock Watcher' }, { complete: async () => (stopReason ? { text, stopReason } : text) })).reply;
    expect(await shape('')).toEqual({ length: 0, bracket: false, entries: 0, toolShaped: false, cutOff: false });
    expect(await shape('SECRETWORD [see above]')).toEqual({ length: 22, bracket: true, entries: 0, toolShaped: false, cutOff: false });
    expect(await shape('[{"name":"SECRETWORD"}]')).toMatchObject({ bracket: true, entries: 1, cutOff: false });
    expect(await shape('[{"ic')).toMatchObject({ bracket: true, entries: 0, cutOff: true });
    // A CLI that gave no stop reason gives the empty string: the text decides.
    expect(await shape('[{"ic', '')).toMatchObject({ entries: 0, cutOff: true });
    expect(await shape('He said ["x" then left.')).toMatchObject({ entries: 0, cutOff: false }); // prose, not cut off
    expect(await shape('{"tool":"SECRETWORD","input":{}}')).toMatchObject({ toolShaped: true });
    expect(await shape('```json\n{ "tool": "x" }\n```')).toMatchObject({ toolShaped: true });
    expect(await shape('nothing', 'max_tokens')).toMatchObject({ cutOff: true, stopReason: 'max_tokens' });
    // Finished by its own account, a stray bracket is not a reply that was too long.
    expect(await shape('I cannot help with that, see the list [1', 'end_turn')).toMatchObject({ entries: 0, cutOff: false, stopReason: 'end_turn' });
    expect(await shape('[{"ic', 'end_turn')).toMatchObject({ cutOff: false });
    // With no word from the source: a number after a bracket is prose, an array open past an entry is not.
    expect(await shape('see the list [1')).toMatchObject({ cutOff: false });
    expect(await shape('see items [1, 2')).toMatchObject({ cutOff: false });
    expect(await shape('[{"name":"x"},')).toMatchObject({ entries: 1, cutOff: true });
    // A complete array with a bracket in one of its strings.
    expect(await shape('[{"icon":"not emoji","note":"see [1"}]')).toMatchObject({ entries: 1, cutOff: false });
    // A stop reason that is not one (a word, from something other than the API) stays out.
    const odd = await shape('nothing', 'SECRET WORD');
    expect(odd).not.toHaveProperty('stopReason');
    expect(JSON.stringify(await suggestIcons({ name: 'Stock Watcher' }, { complete: async () => 'SECRETWORD' }))).not.toContain('SECRETWORD');
  });
  it('a failed call and a reply with no ideas are told apart (HB-0382)', async () => {
    const failed = await suggestIcons({ name: 'Stock Watcher' }, { complete: async () => { throw new Error('429'); } });
    expect(failed).toMatchObject({ why: 'ai-failed', error: '429' });
    expect(failed).not.toHaveProperty('reply');
    const empty = await suggestIcons({ name: 'Stock Watcher' }, { complete: async () => '' });
    expect(empty).toMatchObject({ why: 'ai-no-ideas', via: 'keywords' });
  });
  describe('reading a reply that is not just the array (HB-0382)', () => {
    const IDEAS = [{ icon: '🐂', color: '#3a8fd0' }, { icon: '🐝', color: '#c9b03a' }];
    const ARR = JSON.stringify(IDEAS);
    const cases: Array<[string, string, Array<{ icon: string; color: string }>]> = [
      ['the array alone', ARR, IDEAS],
      ['a stray bracket before', `[SessionStart] hook ran\n${ARR}`, IDEAS],
      ['a stray bracket after', `${ARR}\nSee [1] for more.`, IDEAS],
      ['stray brackets both sides', `[note] ${ARR} [done]`, IDEAS],
      ['a lone close bracket before', `] oops ${ARR}`, IDEAS],
      ['an unclosed bracket before', `[oops ${ARR}`, IDEAS],
      ['an unclosed object in a stray bracket before', `[ {oops ] ${ARR}`, IDEAS],
      ['an unclosed quote in a stray bracket before', `[ "oops ${ARR}`, IDEAS],
      ['a number list before', `[1, 2] ${ARR}`, IDEAS],
      ['an array inside an object', `{"array":${ARR}}`, IDEAS],
      ['an array inside an object in an array', `[{"ideas":${ARR}}]`, IDEAS],
      ['an array inside an array', `[${ARR}]`, IDEAS],
      ['an invented line first', `{"name":"Stock Watcher"}\n${ARR}`, IDEAS],
      ['a bracket in a string of the wrapper', `{"note":"see [1]","ideas":${ARR}}`, IDEAS],
      ['a code fence', '```json\n' + ARR + '\n```', IDEAS],
      ['a trailing comma in the array', '[{"icon":"🐂","color":"#3a8fd0"},{"icon":"🐝","color":"#c9b03a"},]', IDEAS],
      ['a trailing comma in an entry', '[{"icon":"🐂","color":"#3a8fd0",},{"icon":"🐝","color":"#c9b03a"}]', IDEAS],
      ['cut off inside an entry', '[{"icon":"🐂","color":"#3a8fd0"},{"icon":"🐝","color":"#c9b03a"},{"icon":"🪙","co', IDEAS],
      ['cut off between entries', '[{"icon":"🐂","color":"#3a8fd0"},{"icon":"🐝","color":"#c9b03a"},', IDEAS],
      ['cut off inside a wrapper', '{"ideas":[{"icon":"🐂","color":"#3a8fd0"},{"icon":"🐝","color":"#c9b03a"}', IDEAS],
      ['a damaged entry between good ones', '[{"icon":"🐂","color":"#3a8fd0"},{"icon":oops},{"icon":"🐝","color":"#c9b03a"}]', IDEAS],
      ['a literal between entries', '[{"icon":"🐂","color":"#3a8fd0"},null,3,{"icon":"🐝","color":"#c9b03a"}]', IDEAS],
      ['"emoji" for "icon"', '[{"emoji":"🐂","color":"#3a8fd0"},{"emoji":"🐝","color":"#c9b03a"}]', IDEAS],
      ['bare emoji', '["🐂","🐝"]', [{ icon: '🐂', color: '' }, { icon: '🐝', color: '' }]],
      ['bare emoji, cut off', '["🐂","🐝","🪙', [{ icon: '🐂', color: '' }, { icon: '🐝', color: '' }]],
    ];
    for (const [what, text, want] of cases) it(what, () => expect(parseIdeas(text)).toEqual(want));
    it('an unescaped quote costs only its own entry, not those after it', () => {
      expect(parseIdeas('[{"icon":"🐝","note":"5" wide"},{"icon":"🦋","color":"#3aa36b"}]')).toEqual([{ icon: '🦋', color: '#3aa36b' }]);
      expect(parseIdeas('[{"icon":"🐝","note":"5" wide"},{"icon":"🦋"},{"icon":"🐂","note":"6" tall"},{"icon":"🐞"}]').map((i) => i.icon)).toEqual(['🦋', '🐞']);
    });
    it('leaves prose alone: emoji in sentences or unquoted in brackets are not ideas', () => {
      for (const text of ['Try 🐂 or 🐝.', 'Maybe [🐂, 🐝] would do', '🐂 🐝', '- 🐂\n- 🐝', '{"icon":"🐂"}', '']) expect(parseIdeas(text), text).toEqual([]);
    });
    it('everything found still passes the emoji and palette checks', () => {
      expect(parseIdeas('["<b>","ab","🐂🐝",{"emoji":"<img>"},{"icon":"x","emoji":"🐝","color":"url(x)"},7]')).toEqual([{ icon: '🐝', color: '' }]);
    });
    it('a pathological reply costs no time to speak of', () => {
      const started = Date.now();
      expect(parseIdeas('[{'.repeat(2_000_000))).toEqual([]);
      expect(parseIdeas('[' + '{"},'.repeat(2_000_000))).toEqual([]);
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });
  it('parseIdeas keeps one emoji each and palette colours only', () => {
    expect(parseIdeas('nothing')).toEqual([]);
    expect(parseIdeas('[{"icon":"📈📈"},{"icon":"🐂","color":"#3A8FD0"},{"icon":"🐝","color":"red"}]'))
      .toEqual([{ icon: '🐂', color: '#3a8fd0' }, { icon: '🐝', color: '' }]);
  });
});

describe('the Claude CLI as a plain completion (HB-0382)', () => {
  const withDb = async <T>(run: () => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-icons-'));
    const prevDb = process.env.HATCHABOT_DB;
    process.env.HATCHABOT_DB = join(dir, 'hatchabot.sqlite');
    try { return await run(); } finally {
      if (prevDb === undefined) delete process.env.HATCHABOT_DB; else process.env.HATCHABOT_DB = prevDb;
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const cli = (out: string, tools: unknown[]) => withDb(async () => {
    let prompt = '';
    const r = await completeViaCli(
      { model: 'claude-sonnet-5', runner: async (_argv, stdin) => { prompt = stdin; return out; } },
      { system: 'Reply with JSON only.', tools, messages: [{ role: 'user', content: 'Give 8.' }], maxTokens: 100 },
    );
    return { r, prompt };
  });
  const TOOLS = [{ name: 'list_agents', description: 'List them', input_schema: { type: 'object' } }];
  const result = (text: string, extra = {}) => JSON.stringify({ result: text, ...extra });

  it('no tools: no catalogue and no protocol, and the prompt still carries the request', async () => {
    const { prompt } = await cli(result('[]'), []);
    expect(prompt).not.toMatch(/TOOLS AVAILABLE|PROTOCOL|plain prose|"tool"/);
    expect(prompt).toContain('Reply with JSON only.');
    expect(prompt).toContain('Owner: Give 8.');
  });
  it('no tools: a reply shaped like a tool call stays text', async () => {
    for (const text of ['{"tool":"list_agents","input":{}}', 'Sure.\n{"tool":"list_agents","input":{}}']) {
      const { r } = await cli(result(text), []);
      expect(r).toEqual({ stopReason: '', content: [{ type: 'text', text }] });
    }
  });
  it('no tools: the CLI\'s stop reason comes through where it gives one', async () => {
    expect((await cli(result('[', { stop_reason: 'max_tokens' }), [])).r.stopReason).toBe('max_tokens');
    expect((await cli(result('[', { stop_reason: null }), [])).r.stopReason).toBe('');
  });
  it('with tools, nothing changes: the protocol is there, and tool calls are tool calls', async () => {
    const { r, prompt } = await cli(result('{"tool":"list_agents","input":{}}', { stop_reason: 'end_turn' }), TOOLS);
    expect(prompt).toContain('TOOLS AVAILABLE TO YOU:\n- list_agents: List them');
    expect(prompt).toContain('PROTOCOL — follow exactly:');
    expect(prompt).toContain('Otherwise reply in plain prose');
    expect(r.stopReason).toBe('tool_use');
    expect(r.content[0]).toMatchObject({ type: 'tool_use', name: 'list_agents' });
    const mixed = (await cli(result('Sure.\n{"tool":"list_agents","input":{}}'), TOOLS)).r;
    expect(mixed.content.map((c: any) => c.type)).toEqual(['text', 'tool_use']);
    const prose = (await cli(result('All fine.', { stop_reason: 'max_tokens' }), TOOLS)).r;
    expect(prose).toEqual({ stopReason: 'end_turn', content: [{ type: 'text', text: 'All fine.' }] });
  });
  it('through the ideas: a tool-shaped reply is an unreadable one, not an empty one', async () => {
    const out = await withDb(() => suggestIcons({ name: 'Stock Watcher' }, {
      complete: async (system, user) => {
        const r = await completeViaCli(
          { model: 'claude-sonnet-5', runner: async () => result('{"tool":"pick","input":{}}') },
          { system, tools: [], messages: [{ role: 'user', content: user }], maxTokens: 100 },
        );
        return (r.content[0] as { text: string }).text;
      },
    }));
    expect(out).toMatchObject({ why: 'ai-no-ideas', reply: { toolShaped: true } });
  });
});

describe('clearing an agent from Alerts', () => {
  it('PATCH stores the fingerprint of what was flagged, the list carries it, and null shows it again', async () => {
    const { store, f } = await world();
    store.insertAgent(agent('a1', 'Stock Watcher'));
    let r = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { attentionAck: 'rebuild:the fleet default moved\nrestart:1' } });
    expect(r.statusCode).toBe(200);
    expect(store.getAgent('a1')?.attentionAck).toBe('rebuild:the fleet default moved\nrestart:1');
    const list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json();
    expect(list.find((a: any) => a.id === 'a1').attentionAck).toBe('rebuild:the fleet default moved\nrestart:1');
    r = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { attentionAck: null } });
    expect(r.statusCode).toBe(200);
    expect(store.getAgent('a1')?.attentionAck).toBeUndefined();
    // Someone else's agent cannot be cleared.
    expect((await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: { 'x-hatchabot-owner': 'user-other' }, payload: { attentionAck: 'x' } })).statusCode).toBe(404);
    await f.close();
  });
});

describe('a Clear from Alerts lasts as long as what it cleared (HB-0409)', () => {
  it('a failure that ended, or a new failure, is no longer covered, and the Recent line says so', async () => {
    const { store, f } = await world();
    store.insertAgent(agent('a1', 'Stock Watcher', { state: 'RUNNING' } as Partial<Agent>));
    const ack = (id = 'a1') => store.getAgent(id)?.attentionAck;
    store.setAgentState('a1', 'FAILED', 'first failure');
    store.setAgentAttentionAck('a1', 'failed\nstate:FAILED');
    store.setAgentState('a1', 'FAILED', 'the same failure, said again');
    expect(ack(), 'still the same failure').toBe('failed\nstate:FAILED');
    store.setAgentState('a1', 'PROVISIONING');
    expect(ack(), 'a retry ends it').toBeUndefined();
    store.setAgentState('a1', 'RUNNING');
    // What else was cleared stays cleared.
    store.setAgentAttentionAck('a1', 'disk:12\nfailed\nstate:FAILED');
    store.setAgentState('a1', 'FAILED', 'an ack from before the upgrade, then a second failure');
    expect(ack()).toBe('disk:12');
    await f.close();
  });

  it('a step that was waiting on the owner and is done, or a new one, is no longer covered', async () => {
    const { store, f } = await world();
    store.insertAgent(agent('a1', 'Stock Watcher'));
    const step = { type: 'bot_token' } as never;
    store.setAgentPendingAction('a1', step);
    store.setAgentAttentionAck('a1', 'pending');
    store.setAgentPendingAction('a1', step);
    expect(store.getAgent('a1')?.attentionAck, 'the same step, written again').toBe('pending');
    store.setAgentPendingAction('a1', null);
    expect(store.getAgent('a1')?.attentionAck).toBeUndefined();
    store.setAgentAttentionAck('a1', 'pending'); // from before the upgrade
    store.setAgentPendingAction('a1', step);
    expect(store.getAgent('a1')?.attentionAck).toBeUndefined();
    await f.close();
  });

  it("the keys the store drops are the ones the page's Alerts use", () => {
    const page = readFileSync('web/index.html', 'utf8');
    for (const k of ["'state:FAILED'", "key: 'failed'", "key: 'pending'", "key: 'opsDrift'", "key: 'restart:'", "key: 'memory'"]) expect(page, k).toContain(k);
  });
});

describe('icon routes', () => {
  it('PATCH sets and clears an icon, and rejects a non-emoji', async () => {
    const { store, f } = await world();
    store.insertAgent(agent('a1', 'Stock Watcher'));
    let r = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { icon: '📈', iconColor: '#3aa36b' } });
    expect(r.statusCode).toBe(200);
    expect(store.getAgent('a1')).toMatchObject({ icon: '📈', iconColor: '#3aa36b' });
    r = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { icon: '<img src=x>' } });
    expect(r.statusCode).toBe(400);
    r = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { icon: null } });
    expect(r.statusCode).toBe(200);
    expect(store.getAgent('a1')?.icon).toBeUndefined();
    expect(store.getAgent('a1')?.iconColor).toBe('#3aa36b');
    await f.close();
  });

  it('auto fills only agents without an icon, via the management AI', async () => {
    const { store, f, calls } = await world('[{"id":"a2","icon":"🌮","color":"#e0a13a"}]');
    store.insertAIProfile(PROFILE);
    store.insertAgent(agent('a1', 'Stock Watcher', { icon: '💹' }));
    store.insertAgent(agent('a2', 'Recipe Box'));
    const r = await f.inject({ method: 'POST', url: '/v1/agents/icons/auto', headers: H, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ assigned: 1, via: 'ai' });
    expect(store.getAgent('a1')?.icon).toBe('💹'); // chosen by the owner: untouched
    expect(store.getAgent('a2')).toMatchObject({ icon: '🌮', iconColor: '#e0a13a' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('Stock Watcher'); // only the ones being picked are sent
    await f.close();
  });

  it('auto without any AI source uses keywords; never touches another owner', async () => {
    const { store, f } = await world();
    store.insertAgent(agent('a1', 'Contract Reviewer'));
    store.insertAgent({ ...agent('x1', 'Stock Watcher'), ownerId: 'someone-else' });
    const r = await f.inject({ method: 'POST', url: '/v1/agents/icons/auto', headers: H, payload: {} });
    expect(r.json()).toMatchObject({ assigned: 1, via: 'keywords' });
    expect(store.getAgent('a1')?.icon).toBe('⚖️');
    expect(store.getAgent('x1')?.icon).toBeUndefined();
    await f.close();
  });

  it('redo re-picks the named agents even when they have one', async () => {
    const { store, f } = await world('[{"id":"a1","icon":"💹","color":"#3a8fd0"}]');
    store.insertAIProfile(PROFILE);
    store.insertAgent(agent('a1', 'Stock Watcher', { icon: '📈' }));
    const r = await f.inject({ method: 'POST', url: '/v1/agents/icons/auto', headers: H, payload: { ids: ['a1'], redo: true } });
    expect(r.json().icons).toEqual([{ id: 'a1', icon: '💹', color: '#3a8fd0' }]);
    expect(store.getAgent('a1')?.icon).toBe('💹');
    await f.close();
  });

  it('suggest gives ideas for one agent and saves nothing', async () => {
    const { store, f, calls } = await world('[{"icon":"🔭","color":"#5a7fd6"},{"icon":"🐂","color":"#d05a5a"}]');
    store.insertAIProfile(PROFILE);
    store.insertAgent(agent('a1', 'Stock Watcher', { icon: '📈', iconColor: '#3aa36b', persona: 'watches our shares' }));
    const r = await f.inject({ method: 'POST', url: '/v1/agents/a1/icons/suggest', headers: H, payload: { exclude: ['🪙', 'not an emoji'] } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ via: 'ai', ideas: [{ icon: '🔭', color: '#5a7fd6' }, { icon: '🐂', color: '#d05a5a' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('watches our shares');
    expect(calls[0]).toContain('🪙');
    expect(calls[0]).not.toContain('not an emoji'); // only emoji reach the prompt
    expect(store.getAgent('a1')).toMatchObject({ icon: '📈', iconColor: '#3aa36b' });
    await f.close();
  });

  it('suggest is for the owner only, and refuses a bad exclude list', async () => {
    const { store, f, calls } = await world('[]');
    store.insertAIProfile(PROFILE);
    store.insertAgent({ ...agent('x1', 'Stock Watcher'), ownerId: 'someone-else' });
    store.insertAgent(agent('a1', 'Recipe Box'));
    expect((await f.inject({ method: 'POST', url: '/v1/agents/x1/icons/suggest', headers: H, payload: {} })).statusCode).toBe(404);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/icons/suggest', headers: H, payload: { exclude: 'x' } })).statusCode).toBe(400);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/icons/suggest', headers: H, payload: { exclude: [1] } })).statusCode).toBe(400);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/icons/suggest', headers: H, payload: { want: 5 } })).statusCode).toBe(400);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/icons/suggest', headers: H, payload: { want: 'x'.repeat(501) } })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    await f.close();
  });

  it('suggest without any AI source answers from the keyword table', async () => {
    const { store, f } = await world();
    store.insertAgent(agent('a1', 'Recipe Box'));
    const r = await f.inject({ method: 'POST', url: '/v1/agents/a1/icons/suggest', headers: H, payload: {} });
    expect(r.json()).toMatchObject({ via: 'keywords', why: 'no-ai', ideas: [{ icon: '🍳' }, { icon: '🤖' }] });
    await f.close();
  });

  it('suggest follows what the owner asked for, and keeps why the AI failed out of the answer', async () => {
    const { store, f, calls } = await world('[{"icon":"🎂","color":"#3aa36b"}]');
    store.insertAIProfile(PROFILE);
    store.insertAgent(agent('a1', 'Gift Planner'));
    const r = await f.inject({ method: 'POST', url: '/v1/agents/a1/icons/suggest', headers: H, payload: { want: 'a birthday cake' } });
    expect(r.json()).toEqual({ via: 'ai', ideas: [{ icon: '🎂', color: '#3aa36b' }] });
    expect(calls[0]).toContain('The owner wants it to show: \\"a birthday cake\\"');
    await f.close();
    const failing = await world('nothing usable');
    failing.store.insertAIProfile(PROFILE);
    failing.store.insertAgent(agent('a1', 'Holiday list'));
    const k = (await failing.f.inject({ method: 'POST', url: '/v1/agents/a1/icons/suggest', headers: H, payload: {} })).json();
    expect(k).toMatchObject({ via: 'keywords', why: 'ai-no-ideas', ideas: [{ icon: '🎄' }, { icon: '📝' }, { icon: '🤖' }] });
    expect(k).not.toHaveProperty('error');
    expect(k).not.toHaveProperty('reply');
    await failing.f.close();
  });

  it('a reply with no ideas is logged by its shape, and its text reaches neither the log nor the page (HB-0382)', async () => {
    const { store, f, logs } = await world('SECRETWORD [but no ideas', 'max_tokens');
    store.insertAIProfile(PROFILE);
    store.insertAgent(agent('a1', 'Holiday list'));
    const r = await f.inject({ method: 'POST', url: '/v1/agents/a1/icons/suggest', headers: H, payload: {} });
    expect(r.json().why).toBe('ai-no-ideas');
    expect(r.body).not.toContain('SECRETWORD');
    const line = logs.map((l) => JSON.parse(l)).find((l) => /icon ideas/.test(l.msg));
    expect(line).toMatchObject({
      agent: 'a1', error: 'its answer held no emoji',
      reply: { length: 24, bracket: true, entries: 0, toolShaped: false, cutOff: true, stopReason: 'max_tokens' },
    });
    expect(logs.join('')).not.toContain('SECRETWORD');
    await f.close();
  });

  it('a failed call says why in the log, and the page only that it failed', async () => {
    const { store, f, logs } = await world(new Error('429 for the account SECRETWORD'));
    store.insertAIProfile(PROFILE);
    store.insertAgent(agent('a1', 'Holiday list'));
    const r = await f.inject({ method: 'POST', url: '/v1/agents/a1/icons/suggest', headers: H, payload: {} });
    expect(r.json().why).toBe('ai-failed');
    expect(r.body).not.toContain('SECRETWORD');
    expect(logs.map((l) => JSON.parse(l)).find((l) => /icon ideas/.test(l.msg))).toMatchObject({ error: '429 for the account SECRETWORD' });
    await f.close();
  });

  it('auto logs a batch the AI gave nothing for, without its text, and each agent still gets a keyword pick (HB-0382)', async () => {
    const { store, f, logs } = await world('SECRETWORD and nothing else');
    store.insertAIProfile(PROFILE);
    store.insertAgent(agent('a1', 'Contract Reviewer'));
    store.insertAgent(agent('a2', 'Recipe Box'));
    const r = await f.inject({ method: 'POST', url: '/v1/agents/icons/auto', headers: H, payload: {} });
    expect(r.json()).toMatchObject({ assigned: 2, via: 'keywords' });
    expect(store.getAgent('a1')?.icon).toBe('⚖️');
    expect(store.getAgent('a2')?.icon).toBe('🍳');
    expect(logs.map((l) => JSON.parse(l)).find((l) => /agent icons/.test(l.msg))).toMatchObject({ used: 0, of: 2, reply: { bracket: false, entries: 0 } });
    expect(logs.join('')).not.toContain('SECRETWORD');
    await f.close();
  });

  it('auto says nothing when the AI covered every agent', async () => {
    const { store, f, logs } = await world('[{"id":"a1","icon":"🌮","color":"#e0a13a"}]');
    store.insertAIProfile(PROFILE);
    store.insertAgent(agent('a1', 'Recipe Box'));
    await f.inject({ method: 'POST', url: '/v1/agents/icons/auto', headers: H, payload: {} });
    expect(logs.join('')).not.toContain('agent icons');
    await f.close();
  });
});

describe('a stray quote in a string entry', () => {
  it('costs only that entry', () => {
    expect(parseIdeas('["🎂","bad"x","🍰","🎉"]').map((i) => i.icon)).toEqual(['🎂', '🍰', '🎉']);
    expect(parseIdeas('["🎂","🍰"]').map((i) => i.icon)).toEqual(['🎂', '🍰']);
    expect(parseIdeas('["🎂" "🍰"\n"🎉"]').map((i) => i.icon)).toEqual(['🎂', '🍰', '🎉']); // a missing comma costs nothing
  });
});
