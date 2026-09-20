import { describe, expect, it } from 'vitest';
import { Broker, type AgentSummary, type ApiClient } from '../src/mgmt/broker.js';
import { PendingStore } from '../src/mgmt/pendingStore.js';

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

  // ---- authoring ----
  files: Record<string, string> = { 'SOUL.md': 'old line one\nold line two' };
  /** States the freshly created agent walks through on successive getAgent
   *  polls — lets tests exercise the wait-for-RUNNING loop. */
  createdStates: string[] = ['RUNNING'];
  async listProfiles() {
    return [
      { id: 'p1', name: 'Claude Max', vendor: 'anthropic', model: 'claude-opus-4-8' },
      { id: 'p2', name: 'Spare Key', vendor: 'anthropic', model: 'claude-sonnet-5' },
    ];
  }
  async listHosts() {
    return [
      { id: 'h1', name: 'This machine', kind: 'local' },
      { id: 'h2', name: 'MacBook', kind: 'runner' },
    ];
  }
  async createAgent(body: { name: string; persona?: string; aiProfileId: string; hostId: string }) {
    this.calls.push(`create:${body.name}:${body.aiProfileId}:${body.hostId}`);
    const created: AgentSummary = {
      id: 'new1',
      name: body.name,
      slug: 'new1',
      state: this.createdStates[0] ?? 'RUNNING',
      aiProfileId: body.aiProfileId,
    };
    let poll = 0;
    this.agents = [...this.agents, created];
    const states = this.createdStates;
    this.getAgent = async (id: string) => {
      if (id !== 'new1') return this.agents.find((a) => a.id === id)!;
      poll = Math.min(poll + 1, states.length - 1);
      return { ...created, state: states[poll]! };
    };
    return created;
  }
  async getFile(_id: string, name: string) {
    return this.files[name] ?? '';
  }
  async putFile(id: string, name: string, content: string) {
    this.calls.push(`put:${id}:${name}:${content.length}`);
    this.files[name] = content;
  }
  async patchAgent(id: string, body: { persona?: string; parameters?: Array<Record<string, unknown>> }) {
    this.calls.push(`patch:${id}:${Object.keys(body).sort().join('+')}`);
  }

  // ---- images ----
  images = [{ name: 'ml-tools', tag: 'hatchabot-runtime:derived-ml-tools', status: 'ready', base: 'hatchabot-runtime:latest', pinnedBy: 2 }];
  async getRuntime() {
    return { imageVersion: '2026.8.1', npmLatest: '2026.9.0', upgradeAvailable: true };
  }
  async listImages() {
    return { base: 'hatchabot-runtime:latest', images: this.images };
  }
  async imageLog(name: string) {
    this.calls.push(`imglog:${name}`);
    return { status: 'ready', log: 'Step 1/3 …' };
  }
  async buildImage(body: { name: string; dockerfile: string; base?: string }) {
    this.calls.push(`imgbuild:${body.name}:${body.base ?? 'default'}:${body.dockerfile.length}`);
  }
  async rebuildImage(name: string, base?: string) {
    this.calls.push(`imgrebuild:${name}:${base ?? 'same'}`);
  }
  async removeImage(name: string) {
    this.calls.push(`imgrm:${name}`);
  }

  // ---- base-image candidates ----
  building = false;
  baseTags = [
    { tag: 'hatchabot-runtime:latest', exists: true, isDefault: true, isLatest: true, openclawVersion: '2026.8.1', relation: 'same', derived: null, pinned: [] as Array<{ id: string; name: string }> },
    { tag: 'hatchabot-runtime:2026.9.0', exists: true, isDefault: false, isLatest: false, openclawVersion: '2026.9.0', relation: 'newer', derived: null, pinned: [] as Array<{ id: string; name: string }> },
    { tag: 'hatchabot-runtime:derived-ml-tools', exists: true, isDefault: false, isLatest: false, relation: 'derived', derived: { name: 'ml-tools' }, pinned: [] as Array<{ id: string; name: string }> },
    { tag: 'hatchabot-runtime:2026.9.9', exists: false, isDefault: false, isLatest: false, relation: 'missing', derived: null, pinned: [] as Array<{ id: string; name: string }> },
  ];
  async listBaseImages() {
    return { default: 'hatchabot-runtime:latest', defaultInfo: { openclawVersion: '2026.8.1' }, tags: this.baseTags };
  }
  async baseBuild() {
    return { running: this.building, log: 'x'.repeat(5000) };
  }
  async buildBaseCandidate(version?: string) {
    this.calls.push(`basebuild:${version}`);
  }
  async setAgentImage(id: string, image: string | null) {
    this.calls.push(`image:${id}:${image ?? 'default'}`);
  }

  // ---- one-call tools (restTools.ts) ----
  async raw(method: string, path: string, body?: unknown) {
    if (method === 'GET') {
      if (path === '/v1/ai-profiles') return [{ id: 'p1', name: 'Claude Max' }, { id: 'p2', name: 'Spare Key' }];
      if (path === '/v1/agent-classes') return { classes: [{ id: 'k1', name: 'Heavy' }] };
      return { path };
    }
    this.calls.push(`${method} ${path} ${body === undefined ? '' : JSON.stringify(body)}`.trim());
    if (path.endsWith('/invites')) return { code: 'abc123', url: 'https://example.test/join/abc123' };
    return {};
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
  const broker = new Broker(api, pending, { now: opts.now, pollIntervalMs: 1, pollTimeoutMs: 2000 });
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

describe('authoring tools — the full spec rides the confirmation', () => {
  const FIELDS = [
    { key: 'risk_tolerance', label: 'Risk tolerance', type: 'choice', options: ['low', 'high'] },
    { key: 'enable_leaps', label: 'Enable LEAPS', type: 'boolean', default: 'false' },
  ];

  it('create_agent is read-only-gated like every mutate', async () => {
    const { broker, api } = make();
    const r = await broker.handleTool('create_agent', { name: 'X', soul: 's' }, WHO);
    expect(r).toMatchObject({ ok: false, error: { code: 'READ_ONLY_MODE' } });
    expect(api.calls).toEqual([]);
  });

  it('proposes with a spec card (name, placement, fields) and a long TTL — nothing created yet', async () => {
    const { broker, api, pending } = make({ rw: true });
    const r = await broker.handleTool(
      'create_agent',
      { name: 'Stock Broker', persona: 'Markets copilot', soul: 'You are {{risk_tolerance}}.\nLine 2.', fields: FIELDS },
      WHO,
    );
    expect(r.ok).toBe(true);
    const summary = (r as any).pending.summary as string;
    expect(summary).toContain('Create agent "Stock Broker"');
    expect(summary).toContain('Claude Max'); // broker-chosen placement is on the card
    expect(summary).toContain('risk_tolerance, enable_leaps');
    expect(summary).toContain('SOUL.md'); // preview present
    expect(api.calls).toEqual([]); // proposal only
    const rec = pending.peek('c_1')!;
    expect(rec.expiresAtMs - rec.createdAtMs).toBe(600_000); // authoring TTL, not 120s
    expect(rec.resolved.spec?.hostId).toBe('h1'); // local host, never the runner
  });

  it('refuses a name clash and bad fields BEFORE showing a card', async () => {
    const { broker, pending } = make({ rw: true });
    const clash = await broker.handleTool('create_agent', { name: 'tech advisor', soul: 's' }, WHO);
    expect(clash).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const badKey = await broker.handleTool(
      'create_agent',
      { name: 'Fresh', soul: 's', fields: [{ key: 'Bad-Key', label: 'x', type: 'text' }] },
      WHO,
    );
    expect(badKey).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const dupKeys = await broker.handleTool(
      'create_agent',
      { name: 'Fresh', soul: 's', fields: [FIELDS[0], FIELDS[0]] },
      WHO,
    );
    expect(dupKeys).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(pending.peek('c_1')).toBeUndefined();
  });

  it('confirm creates, waits for RUNNING, then writes files and declares fields', async () => {
    const { broker, api } = make({ rw: true });
    api.createdStates = ['PROVISIONING', 'PROVISIONING', 'RUNNING'];
    await broker.handleTool(
      'create_agent',
      { name: 'Fresh', soul: 'soul body', agents_md: 'playbook', fields: FIELDS },
      WHO,
    );
    const out = await broker.confirm('c_1', 'confirm', { fromUserId: 555, chatId: 100 });
    expect(out.ok).toBe(true);
    expect((out as any).text).toContain('✅');
    expect(api.calls).toEqual([
      'create:Fresh:p1:h1',
      'put:new1:SOUL.md:9',
      'put:new1:AGENTS.md:8',
      'patch:new1:parameters',
    ]);
  });

  it('a FAILED provision surfaces as a failure, not silence', async () => {
    const { broker, api } = make({ rw: true });
    api.createdStates = ['PROVISIONING', 'FAILED'];
    await broker.handleTool('create_agent', { name: 'Fresh', soul: 's' }, WHO);
    const out = await broker.confirm('c_1', 'confirm', { fromUserId: 555, chatId: 100 });
    expect(out.ok).toBe(true);
    expect((out as any).text).toContain('⚠ Failed');
    expect(api.calls.some((c) => c.startsWith('put:'))).toBe(false); // no files onto a failed agent
  });

  it('update_definition shows a diff stat and rejects an empty change', async () => {
    const { broker, api } = make({ rw: true });
    const empty = await broker.handleTool('update_definition', { agent: 'a1' }, WHO);
    expect(empty).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const r = await broker.handleTool(
      'update_definition',
      { agent: 'a1', soul: 'old line one\nnew line two\nnew line three' },
      WHO,
    );
    const summary = (r as any).pending.summary as string;
    expect(summary).toContain('Update definition of "Tech Advisor"');
    expect(summary).toContain('2 → 3 lines'); // measured against the LIVE file
    expect(api.calls).toEqual([]);
    const out = await broker.confirm('c_1', 'confirm', { fromUserId: 555, chatId: 100 });
    expect(out.ok).toBe(true);
    expect(api.calls).toEqual(['put:a1:SOUL.md:40']);
  });

  it('update_definition patches persona and fields through the agent PATCH', async () => {
    const { broker, api } = make({ rw: true });
    await broker.handleTool(
      'update_definition',
      { agent: 'a1', persona: 'sharper one-liner', fields: FIELDS },
      WHO,
    );
    await broker.confirm('c_1', 'confirm', { fromUserId: 555, chatId: 100 });
    expect(api.calls).toEqual(['patch:a1:parameters+persona']);
  });
});

describe('authoring hardening (audit 2026-09-03)', () => {
  it('update_definition refuses empty-string files (an empty soul would zero-byte SOUL.md)', async () => {
    const { broker, api } = make({ rw: true });
    const r = await broker.handleTool('update_definition', { agent: 'a1', soul: '   ' }, WHO);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(api.calls).toEqual([]);
  });

  it('option-less choice fields are refused by the real schema at propose time', async () => {
    const { broker } = make({ rw: true });
    const r = await broker.handleTool(
      'create_agent',
      { name: 'Fresh', soul: 's {{pick}}', fields: [{ key: 'pick', label: 'Pick', type: 'choice' }] },
      WHO,
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect((r as any).error.message).toMatch(/option/);
  });

});

describe('image tools', () => {
  it('runtime + image list + build log are read-tier', async () => {
    const { broker, api } = make();
    expect(((await broker.handleTool('get_runtime', {}, WHO)) as any).data.upgradeAvailable).toBe(true);
    expect(((await broker.handleTool('list_images', {}, WHO)) as any).data.images).toHaveLength(1);
    await broker.handleTool('get_image_log', { name: 'ml-tools' }, WHO);
    expect(api.calls).toEqual(['imglog:ml-tools']);
  });

  it('build_image shows the Dockerfile on the card, refuses a name that exists, executes on confirm', async () => {
    const { broker, api, pending } = make({ rw: true });
    const dup = await broker.handleTool('build_image', { name: 'ml-tools', dockerfile: 'RUN apt-get install -y ffmpeg' }, WHO);
    expect(dup).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const r = await broker.handleTool('build_image', { name: 'av-tools', dockerfile: 'RUN apt-get install -y ffmpeg' }, WHO);
    const summary = (r as any).pending.summary as string;
    expect(summary).toContain('Build derived image "av-tools"');
    expect(summary).toContain('apt-get install -y ffmpeg'); // the snippet IS the review
    const rec = pending.peek((r as any).pending.confirmId)!;
    expect(rec.expiresAtMs - rec.createdAtMs).toBe(600_000); // reading a Dockerfile, not a verb
    await broker.confirm(rec.id, 'confirm', { fromUserId: 555, chatId: 100 });
    expect(api.calls).toEqual(['imgbuild:av-tools:default:29']);
  });

  it('remove_image refuses a pinned image BEFORE any card; rebuild targets must exist', async () => {
    const { broker, api } = make({ rw: true });
    const pinned = await broker.handleTool('remove_image', { name: 'ml-tools' }, WHO);
    expect(pinned).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect((pinned as any).error.message).toContain('pinned by 2');
    const ghost = await broker.handleTool('rebuild_image', { name: 'nope' }, WHO);
    expect(ghost).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    api.images[0]!.pinnedBy = 0;
    await broker.handleTool('remove_image', { name: 'ml-tools' }, WHO);
    await broker.confirm('c_1', 'confirm', { fromUserId: 555, chatId: 100 });
    expect(api.calls).toEqual(['imgrm:ml-tools']);
  });

  it('rebuild_image can move onto a new base', async () => {
    const { broker, api } = make({ rw: true });
    await broker.handleTool('rebuild_image', { name: 'ml-tools', base: 'hatchabot-runtime:2026.9.0' }, WHO);
    await broker.confirm('c_1', 'confirm', { fromUserId: 555, chatId: 100 });
    expect(api.calls).toEqual(['imgrebuild:ml-tools:hatchabot-runtime:2026.9.0']);
  });
});

describe('broker limits (audit 2026-09-03 coverage)', () => {
  it('the mutate rate gate trips past the window cap', async () => {
    const api = new FakeApi(AGENTS, { p1: [] });
    let seq = 0;
    const pending = new PendingStore({ genId: () => `c_${++seq}` });
    const broker = new Broker(api, pending, { mutateLimit: 2, mutateWindowMs: 60_000 });
    broker.setMode(true);
    expect((await broker.handleTool('stop_agent', { agent: 'a1' }, WHO)).ok).toBe(true);
    expect((await broker.handleTool('stop_agent', { agent: 'a1' }, WHO)).ok).toBe(true);
    const third = await broker.handleTool('stop_agent', { agent: 'a1' }, WHO);
    expect(third).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
  });

  it('a create that never reaches RUNNING times out with a next step, and writes nothing', async () => {
    const api = new FakeApi(AGENTS, { p1: [] });
    let seq = 0;
    const pending = new PendingStore({ genId: () => `c_${++seq}` });
    // real clock, tiny budget: the deadline branch is the thing under test
    const broker = new Broker(api, pending, { pollIntervalMs: 1, pollTimeoutMs: 25 });
    broker.setMode(true);
    api.createdStates = ['PROVISIONING']; // stuck forever (e.g. pool empty, parked on bot_token)
    await broker.handleTool('create_agent', { name: 'Fresh', soul: 's' }, WHO);
    const out = await broker.confirm('c_1', 'confirm', { fromUserId: 555, chatId: 100 });
    expect(out.ok).toBe(true);
    expect((out as any).text).toContain('⚠ Failed');
    expect((out as any).text).toContain('still provisioning');
    expect(api.calls.some((c) => c.startsWith('put:'))).toBe(false);
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

describe('base-image candidates from chat — candidate first, promote stays in the app', () => {
  it('build_base_candidate defaults to the newest version, and only runs on confirm', async () => {
    const { broker, api } = make({ rw: true });
    const r = await broker.handleTool('build_base_candidate', {}, WHO);
    expect(r).toMatchObject({ ok: true, pending: { confirmId: 'c_1' } });
    expect(api.calls).toEqual([]);
    expect((r as any).pending.summary).toMatch(/CANDIDATE for OpenClaw 2026\.9\.0/);
    expect((r as any).pending.summary).toMatch(/Promote in the web app/);
    await broker.confirm('c_1', 'confirm', { fromUserId: 555, chatId: 100 });
    expect(api.calls).toEqual(['basebuild:2026.9.0']);
  });

  it('refuses while a build is running, and refuses :latest / derived / junk versions', async () => {
    const { broker, api } = make({ rw: true });
    for (const version of ['latest', 'derived-x', 'a b']) {
      const r = await broker.handleTool('build_base_candidate', { version }, WHO);
      expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    api.building = true;
    const r = await broker.handleTool('build_base_candidate', { version: '2026.9.1' }, WHO);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('try_base_candidate pins ONE agent and rebuilds it — only for a built, non-default, non-derived tag', async () => {
    const { broker, api } = make({ rw: true });
    for (const tag of ['hatchabot-runtime:latest', 'hatchabot-runtime:derived-ml-tools', 'hatchabot-runtime:2026.9.9', 'nope']) {
      const bad = await broker.handleTool('try_base_candidate', { agent: 'a1', tag }, WHO);
      expect(bad.ok).toBe(false);
    }
    const r = await broker.handleTool('try_base_candidate', { agent: 'Tech Advisor', tag: 'hatchabot-runtime:2026.9.0' }, WHO);
    expect(r.ok).toBe(true);
    expect(api.calls).toEqual([]);
    await broker.confirm((r as any).pending.confirmId, 'confirm', { fromUserId: 555, chatId: 100 });
    expect(api.calls).toEqual(['image:a1:hatchabot-runtime:2026.9.0', 'rebuild:a1']);
  });

  it('end_base_trial unpins and rebuilds; refuses an agent that is not on trial', async () => {
    const { broker, api } = make({ rw: true });
    const not = await broker.handleTool('end_base_trial', { agent: 'a1' }, WHO);
    expect(not).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    api.baseTags[1]!.pinned.push({ id: 'a1', name: 'Tech Advisor' });
    const r = await broker.handleTool('end_base_trial', { agent: 'a1' }, WHO);
    await broker.confirm((r as any).pending.confirmId, 'confirm', { fromUserId: 555, chatId: 100 });
    expect(api.calls).toEqual(['image:a1:default', 'rebuild:a1']);
  });

  it('there is no promote tool at all', async () => {
    const { MANIFEST } = await import('../src/mgmt/tools.js');
    expect(MANIFEST.map((t) => t.name).filter((n) => /promote/i.test(n))).toEqual([]);
    const { broker } = make({ rw: true });
    const r = await broker.handleTool('promote_image', { tag: 'hatchabot-runtime:2026.9.0' }, WHO);
    expect(r).toMatchObject({ ok: false, error: { code: 'FORBIDDEN_TOOL' } });
  });

  it('reads: the candidate list, and the build log trimmed for chat', async () => {
    const { broker } = make();
    const l = await broker.handleTool('list_base_images', {}, WHO);
    expect((l as any).data.tags).toHaveLength(4);
    const b = await broker.handleTool('get_base_build', {}, WHO);
    expect((b as any).data.log.length).toBe(3000);
  });
});

describe('one-call tools (restTools.ts) — resolved at propose time, replayed on confirm', () => {
  const confirm = (broker: Broker, r: any) => broker.confirm(r.pending.confirmId, 'confirm', { fromUserId: 555, chatId: 100 });

  it('a read runs straight away, through the owner-scoped client', async () => {
    const { broker } = make();
    const r = await broker.handleTool('list_crons', { agent: 'Tech Advisor' }, WHO);
    expect((r as any).data).toEqual({ path: '/v1/agents/a1/crons' });
  });

  it('archive: the card names the agent, nothing happens until confirm, then exactly that call', async () => {
    const { broker, api } = make({ rw: true });
    const r = await broker.handleTool('archive_agent', { agent: 'tech-advisor' }, WHO);
    expect((r as any).pending.summary).toMatch(/Archive "Tech Advisor"/);
    expect(api.calls).toEqual([]);
    await confirm(broker, r);
    expect(api.calls).toEqual(['POST /v1/agents/a1/archive {"checkpoint":true}']);
  });

  it('set_source resolves a source NAME to its id, names it on the card, and rebuilds after', async () => {
    const { broker, api } = make({ rw: true });
    const r = await broker.handleTool('set_source', { agent: 'a1', source: 'spare key' }, WHO);
    expect((r as any).pending.summary).toMatch(/"Spare Key"/);
    await confirm(broker, r);
    expect(api.calls).toEqual(['PATCH /v1/agents/a1 {"aiProfileId":"p2"}', 'rebuild:a1']);
  });

  it('an unknown source is refused before any card, listing the options', async () => {
    const { broker } = make({ rw: true });
    const r = await broker.handleTool('set_source', { agent: 'a1', source: 'Nope' }, WHO);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect((r as any).error.message).toMatch(/Claude Max, Spare Key/);
  });

  it('set_peers resolves every peer against the owner’s fleet and names them on the card', async () => {
    const { broker, api } = make({ rw: true });
    const r = await broker.handleTool('set_peers', { agent: 'a1', peers: ['CMT advisor', 'a3'], allow_actions: ['a3'] }, WHO);
    expect((r as any).pending.summary).toMatch(/may ask: CMT advisor, Advisor/);
    expect((r as any).pending.summary).toMatch(/ask these to act: Advisor/);
    await confirm(broker, r);
    expect(api.calls).toEqual(['PUT /v1/agents/a1/peers {"peerIds":["a2","a3"],"allowActions":["a3"]}', 'rebuild:a1']);
  });

  it('create_invite puts the link in the done message', async () => {
    const { broker } = make({ rw: true });
    const r = await broker.handleTool('create_invite', { agent: 'a1' }, WHO);
    const out = await confirm(broker, r);
    expect((out as any).text).toMatch(/Invite link: https:\/\/example\.test\/join\/abc123/);
  });

  it('add_cron needs a schedule; delete_base_image refuses the fleet default', async () => {
    const { broker } = make({ rw: true });
    const a = await broker.handleTool('add_cron', { agent: 'a1', name: 'x', message: 'y' }, WHO);
    expect(a).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const d = await broker.handleTool('delete_base_image', { tag: 'hatchabot-runtime:latest' }, WHO);
    expect(d).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('changes are still refused in read-only mode', async () => {
    const { broker, api } = make();
    const r = await broker.handleTool('remove_telegram', { agent: 'a1' }, WHO);
    expect(r).toMatchObject({ ok: false, error: { code: 'READ_ONLY_MODE' } });
    expect(api.calls).toEqual([]);
  });
});

describe('a base candidate with extra packages', () => {
  it('names them on the card, and refuses anything that is not a package name', async () => {
    const { broker } = make({ rw: true });
    const bad = await broker.handleTool('build_base_candidate', { version: '2026.7.1-2', packages: ['ping; rm -rf /'] }, WHO);
    expect(JSON.stringify(bad)).toMatch(/not a package name/);

    const ok = await broker.handleTool('build_base_candidate', { version: '2026.7.1-2', packages: ['iputils-ping', 'dnsutils'] }, WHO);
    const text = JSON.stringify(ok);
    expect(text).toMatch(/iputils-ping, dnsutils/);   // the card says what it adds
    expect(text).toMatch(/CANDIDATE/);                 // and that nothing changes yet
  });
});
