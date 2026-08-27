import { describe, expect, it } from 'vitest';
import { Broker, type AgentSummary, type ApiClient } from '../src/mgmt/broker.js';
import { PendingStore } from '../src/mgmt/pendingStore.js';
import { ManagementBot, type BotTransport, type InlineButton } from '../src/mgmt/bot.js';

/** A fake owner-scoped /v1 client that records the mutations it's asked to do. */
class FakeApi implements ApiClient {
  calls: string[] = [];
  constructor(private agents: AgentSummary[], private models: Record<string, string[]> = {}) {}
  async listAgents() {
    return this.agents;
  }
  async getAgent(id: string) {
    return this.agents.find((a) => a.id === id)!;
  }
  async getLogs() {
    return 'log line';
  }
  async listMembers() {
    return [];
  }
  async listPairing() {
    return [];
  }
  async listAllPending() {
    return [];
  }
  async getPool() {
    return { availableBots: 3 };
  }
  async listEvents(agentId: string | undefined, limit: number) {
    this.calls.push(`events:${agentId ?? 'all'}:${limit}`);
    return [{ agentId: 'a1', agentName: 'Tech Advisor', at: 'now', event: 'runtime.rebuilt' }];
  }
  async getHealth(id: string) {
    this.calls.push(`health:${id}`);
    return { status: 'healthy' as const, reachable: true, telegram: { connected: true, lastError: null } };
  }
  async getUsage(id: string) {
    this.calls.push(`usage:${id}`);
    return { totalTokens: 1500, sessions: 2, byModel: [{ model: 'claude-opus-4-8', tokens: 1500 }] };
  }
  async availableModels(profileId: string) {
    return this.models[profileId] ?? [];
  }
  async startAgent(id: string) {
    this.calls.push(`start:${id}`);
  }
  async stopAgent(id: string) {
    this.calls.push(`stop:${id}`);
  }
  async rebuildAgent(id: string) {
    this.calls.push(`rebuild:${id}`);
  }
  async setModel(id: string, model: string) {
    this.calls.push(`model:${id}:${model}`);
  }
  async approvePairing(id: string, code: string) {
    this.calls.push(`approve:${id}:${code}`);
  }
  async denyPairing(id: string, code: string) {
    this.calls.push(`deny:${id}:${code}`);
  }
  async removeMember(id: string, userId: string) {
    this.calls.push(`remove:${id}:${userId}`);
  }
}

const AGENTS: AgentSummary[] = [
  { id: 'a1', name: 'Tech Advisor', slug: 'tech-advisor', state: 'RUNNING', model: 'claude-opus-4-8', aiProfileId: 'p1' },
  { id: 'a2', name: 'CMT advisor', slug: 'cmt-advisor', state: 'STOPPED', aiProfileId: 'p1' },
  { id: 'a3', name: 'Advisor', slug: 'advisor', state: 'RUNNING', aiProfileId: 'p1' },
];

function make(opts: { rw?: boolean; now?: () => number; models?: Record<string, string[]> } = {}) {
  const api = new FakeApi(AGENTS, opts.models ?? { p1: ['claude-opus-4-8', 'claude-sonnet-5'] });
  let seq = 0;
  const pending = new PendingStore({ now: opts.now, genId: () => `c_${++seq}` });
  const broker = new Broker(api, pending, { now: opts.now });
  if (opts.rw) broker.setMode(true);
  return { api, pending, broker };
}
const WHO = { ownerId: 'o', chatId: 100, fromUserId: 555 };

describe('broker read tier', () => {
  it('executes reads immediately', async () => {
    const { broker } = make();
    const res = await broker.handleTool('list_agents', {}, WHO);
    expect(res.ok).toBe(true);
    expect((res as any).data).toHaveLength(3);
  });

  it('rejects an unknown tool as FORBIDDEN, never runs it', async () => {
    const { broker } = make({ rw: true });
    const res = await broker.handleTool('delete_agent', { agent: 'a1' }, WHO);
    expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN_TOOL' } });
  });

  it('list_events reads the fleet timeline, unfiltered', async () => {
    const { broker, api } = make();
    const res = await broker.handleTool('list_events', {}, WHO);
    expect(res.ok).toBe(true);
    expect((res as any).data).toHaveLength(1);
    expect(api.calls).toContain('events:all:20');
  });

  it('list_events resolves and filters to one agent', async () => {
    const { broker, api } = make();
    const res = await broker.handleTool('list_events', { agent: 'Tech Advisor', limit: 5 }, WHO);
    expect(res.ok).toBe(true);
    expect(api.calls).toContain('events:a1:5');
  });

  it('get_health / get_usage are read-tier and resolve the agent', async () => {
    const { broker, api } = make();
    const h = await broker.handleTool('get_health', { agent: 'Tech Advisor' }, WHO);
    expect(h.ok).toBe(true);
    expect((h as any).data.status).toBe('healthy');
    expect(api.calls).toContain('health:a1');
    const u = await broker.handleTool('get_usage', { agent: 'a1' }, WHO);
    expect(u.ok).toBe(true);
    expect((u as any).data.totalTokens).toBe(1500);
    expect(api.calls).toContain('usage:a1');
  });
});

describe('broker resolution (owner-scoped)', () => {
  it('resolves by id, slug, and unique name', async () => {
    const { broker } = make();
    for (const ref of ['a1', 'tech-advisor', 'Tech Advisor']) {
      const r = await broker.handleTool('get_agent', { agent: ref }, WHO);
      expect((r as any).data.id).toBe('a1');
    }
  });

  it('refuses an ambiguous reference rather than guessing', async () => {
    const { broker } = make({ rw: true });
    // "advisor" substring-matches all three; exact-name matches one (a3) — exact wins.
    const exact = await broker.handleTool('get_agent', { agent: 'Advisor' }, WHO);
    expect((exact as any).data.id).toBe('a3');
    // A substring with no exact match and >1 hit must be AMBIGUOUS.
    const amb = await broker.handleTool('stop_agent', { agent: 'advis' }, WHO);
    expect(amb).toMatchObject({ ok: false, error: { code: 'AMBIGUOUS' } });
  });

  it('NOT_FOUND for a reference that matches nothing', async () => {
    const { broker } = make();
    const r = await broker.handleTool('get_agent', { agent: 'nope' }, WHO);
    expect(r).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('broker mutate tier — propose, never act', () => {
  it('blocks mutations in read-only mode', async () => {
    const { broker, api } = make();
    const r = await broker.handleTool('stop_agent', { agent: 'a1' }, WHO);
    expect(r).toMatchObject({ ok: false, error: { code: 'READ_ONLY_MODE' } });
    expect(api.calls).toEqual([]);
  });

  it('returns a pending confirmation and does NOT call the API', async () => {
    const { broker, api } = make({ rw: true });
    const r = await broker.handleTool('stop_agent', { agent: 'a1' }, WHO);
    expect(r).toMatchObject({ ok: true, pending: { confirmId: 'c_1' } });
    expect(api.calls).toEqual([]); // nothing happened yet
  });

  it('executes only on confirm', async () => {
    const { broker, api } = make({ rw: true });
    await broker.handleTool('stop_agent', { agent: 'a1' }, WHO);
    const out = await broker.confirm('c_1', 'confirm', { fromUserId: 555, chatId: 100 });
    expect(out.ok).toBe(true);
    expect(api.calls).toEqual(['stop:a1']);
  });

  it('cancel does not act', async () => {
    const { broker, api } = make({ rw: true });
    await broker.handleTool('rebuild_agent', { agent: 'a1' }, WHO);
    const out = await broker.confirm('c_1', 'cancel', { fromUserId: 555, chatId: 100 });
    expect(out.ok).toBe(true);
    expect(api.calls).toEqual([]);
  });

  it('validates set_model against the source menu BEFORE proposing', async () => {
    const { broker, pending } = make({ rw: true });
    const bad = await broker.handleTool('set_model', { agent: 'a1', model: 'claude-fable-5' }, WHO);
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(pending.peek('c_1')).toBeUndefined(); // no confirmation was created
    const good = await broker.handleTool('set_model', { agent: 'a1', model: 'claude-sonnet-5' }, WHO);
    expect((good as any).pending).toBeTruthy();
  });
});

describe('confirm token — single-use, TTL, user-bound', () => {
  it('is single-use: a replayed confirm no-ops', async () => {
    const { broker, api } = make({ rw: true });
    await broker.handleTool('stop_agent', { agent: 'a1' }, WHO);
    await broker.confirm('c_1', 'confirm', { fromUserId: 555, chatId: 100 });
    const again = await broker.confirm('c_1', 'confirm', { fromUserId: 555, chatId: 100 });
    expect(again).toMatchObject({ ok: false, reason: 'already' });
    expect(api.calls).toEqual(['stop:a1']); // exactly once
  });

  it('expires after its TTL', async () => {
    let t = 1_000;
    const { broker } = make({ rw: true, now: () => t });
    await broker.handleTool('stop_agent', { agent: 'a1' }, WHO);
    t += 200_000; // past the 120s TTL
    const out = await broker.confirm('c_1', 'confirm', { fromUserId: 555, chatId: 100 });
    expect(out).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rejects a confirm from a different user or chat', async () => {
    const { broker, api } = make({ rw: true });
    await broker.handleTool('stop_agent', { agent: 'a1' }, WHO);
    const wrongUser = await broker.confirm('c_1', 'confirm', { fromUserId: 999, chatId: 100 });
    expect(wrongUser).toMatchObject({ ok: false, reason: 'not_yours' });
    const wrongChat = await broker.confirm('c_1', 'confirm', { fromUserId: 555, chatId: 200 });
    expect(wrongChat).toMatchObject({ ok: false, reason: 'not_yours' });
    expect(api.calls).toEqual([]);
  });
});

// ---- bot dispatch (transport-agnostic) ----

class FakeTx implements BotTransport {
  sent: Array<{ chatId: number; text: string; buttons?: InlineButton[][]; messageId: number }> = [];
  edits: Array<{ messageId: number; text: string }> = [];
  answers: string[] = [];
  #id = 0;
  async sendMessage(chatId: number, text: string, buttons?: InlineButton[][]) {
    const messageId = ++this.#id;
    this.sent.push({ chatId, text, buttons, messageId });
    return { messageId };
  }
  async editMessage(_chatId: number, messageId: number, text: string) {
    this.edits.push({ messageId, text });
  }
  async answerCallback(_id: string, text?: string) {
    this.answers.push(text ?? '');
  }
}

describe('ManagementBot dispatch', () => {
  const bot = (rw = true) => {
    const { broker, api } = make({ rw });
    const tx = new FakeTx();
    const b = new ManagementBot(broker, tx, { ownerId: 'o', allowlist: [555] });
    return { b, tx, api };
  };

  it('rejects a non-allowlisted user before touching the broker', async () => {
    const { b, tx, api } = bot();
    await b.onMessage(100, 42, '/list');
    expect(tx.sent[0]!.text).toMatch(/Not authorized/);
    expect(api.calls).toEqual([]);
  });

  it('/stop posts a confirm card, and the button executes it', async () => {
    const { b, tx, api } = bot();
    await b.onMessage(100, 555, '/stop a1');
    const card = tx.sent[0]!;
    expect(card.text).toMatch(/Confirm: ⏹ Stop "Tech Advisor"/);
    const btn = card.buttons![0]![0]!;
    expect(btn.data).toMatch(/^cfm:c_1:y$/);
    expect(api.calls).toEqual([]); // still nothing

    await b.onCallback(100, 555, 'cbid', btn.data, card.messageId);
    expect(api.calls).toEqual(['stop:a1']);
    expect(tx.edits.at(-1)!.text).toMatch(/✅ ⏹ Stop "Tech Advisor"/);
  });

  it('a stranger cannot press someone else\'s confirm button', async () => {
    const { b, tx, api } = bot();
    await b.onMessage(100, 555, '/stop a1');
    await b.onCallback(100, 999, 'cbid', 'cfm:c_1:y', tx.sent[0]!.messageId);
    expect(tx.answers.at(-1)).toMatch(/Not authorized/);
    expect(api.calls).toEqual([]);
  });

  it('the approval-push Approve button admits in one tap (no read-write needed)', async () => {
    const { b, tx, api } = bot(false); // read-ONLY: approval push still works
    await b.onCallback(100, 555, 'cbid', 'apr:11111111-2222-3333-4444-555555555555:AB12CD', 7);
    expect(api.calls).toEqual(['approve:11111111-2222-3333-4444-555555555555:AB12CD']);
    expect(tx.answers.at(-1)).toBe('Approved');
    expect(tx.edits.at(-1)!.text).toMatch(/Let in/);
  });

  it('the "Not now" button actually turns the request away (and says it is not a ban)', async () => {
    const { b, tx, api } = bot(false);
    await b.onCallback(100, 555, 'cbid', 'apd:11111111-2222-3333-4444-555555555555:AB12CD', 7);
    expect(api.calls).toEqual(['deny:11111111-2222-3333-4444-555555555555:AB12CD']);
    expect(tx.answers.at(-1)).toBe('Turned away');
    expect(tx.edits.at(-1)!.text).toMatch(/Not a ban/);
  });

  it('a non-allowlisted user cannot approve via the push button', async () => {
    const { b, tx, api } = bot();
    await b.onCallback(100, 999, 'cbid', 'apr:11111111-2222-3333-4444-555555555555:AB12CD', 7);
    expect(tx.answers.at(-1)).toMatch(/Not authorized/);
    expect(api.calls).toEqual([]);
  });
});

describe('broker.approveJoin (one-tap approval push)', () => {
  it('approves directly, bypassing propose→confirm and read-write mode', async () => {
    const { broker, api } = make(); // read-only by default
    const out = await broker.approveJoin('a1', 'AB12CD', WHO);
    expect(out).toEqual({ ok: true });
    expect(api.calls).toEqual(['approve:a1:AB12CD']);
  });

  it('refuses while paused, and refuses an invalid code', async () => {
    const { broker, api } = make();
    broker.pause();
    expect(await broker.approveJoin('a1', 'AB12CD', WHO)).toMatchObject({ ok: false });
    broker.resume();
    expect(await broker.approveJoin('a1', 'bad code!', WHO)).toMatchObject({ ok: false });
    expect(api.calls).toEqual([]); // neither reached the API
  });

  it('denyJoin turns the request away, under the same gates', async () => {
    const { broker, api } = make(); // read-only: still allowed, it's per-person
    expect(await broker.denyJoin('a1', 'AB12CD', WHO)).toEqual({ ok: true });
    expect(api.calls).toEqual(['deny:a1:AB12CD']);
    broker.pause();
    expect(await broker.denyJoin('a1', 'AB12CD', WHO)).toMatchObject({ ok: false });
    expect(api.calls).toHaveLength(1); // the paused one never reached the API
  });
});
