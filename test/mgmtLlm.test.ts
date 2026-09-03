import { describe, expect, it } from 'vitest';
import { Broker, type AgentSummary, type ApiClient } from '../src/mgmt/broker.js';
import { PendingStore } from '../src/mgmt/pendingStore.js';
import {
  LlmAgent,
  type AgentSink,
  type ChatModel,
  type ChatResponse,
  type ContentBlock,
} from '../src/mgmt/llm.js';

/** Minimal owner-scoped API stub; records mutations. */
class FakeApi implements ApiClient {
  calls: string[] = [];
  constructor(private agents: AgentSummary[]) {}
  async listAgents() {
    return this.agents;
  }
  async getAgent(id: string) {
    return this.agents.find((a) => a.id === id)!;
  }
  async getLogs() {
    return '';
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
  async listEvents() {
    return [];
  }
  async getHealth() {
    return { status: 'healthy' as const, reachable: true };
  }
  async getUsage() {
    return { totalTokens: 0, sessions: 0, byModel: [] };
  }
  async availableModels() {
    return ['claude-opus-4-8', 'claude-sonnet-5'];
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
  async setModel(id: string, m: string) {
    this.calls.push(`model:${id}:${m}`);
  }
  async approvePairing() {}
  async denyPairing() {}
  async removeMember() {}
  async listProfiles() {
    return [{ id: 'p1', name: 'Claude Max', vendor: 'anthropic' }];
  }
  async listHosts() {
    return [{ id: 'h1', name: 'This machine', kind: 'local' }];
  }
  async createAgent(body: { name: string; aiProfileId: string; hostId: string }) {
    this.calls.push(`create:${body.name}`);
    return { id: 'new1', name: body.name, slug: 'new1', state: 'RUNNING', aiProfileId: body.aiProfileId };
  }
  async getFile() {
    return '';
  }
  async putFile(id: string, name: string) {
    this.calls.push(`put:${id}:${name}`);
  }
  async patchAgent(id: string) {
    this.calls.push(`patch:${id}`);
  }
  async getRuntime() {
    return { upgradeAvailable: false };
  }
  async listImages() {
    return { base: 'agentclaw-runtime:latest', images: [] };
  }
  async imageLog() {
    return { status: 'ready', log: '' };
  }
  async buildImage(body: { name: string }) {
    this.calls.push(`imgbuild:${body.name}`);
  }
  async rebuildImage(name: string) {
    this.calls.push(`imgrebuild:${name}`);
  }
  async removeImage(name: string) {
    this.calls.push(`imgrm:${name}`);
  }
}

/** Plays back a scripted sequence of model turns; records the requests it saw. */
class FakeChatModel implements ChatModel {
  reqs: Array<{ messages: unknown[] }> = [];
  constructor(private script: ChatResponse[]) {}
  async create(req: { messages: unknown[] }): Promise<ChatResponse> {
    this.reqs.push({ messages: [...req.messages] }); // snapshot: the array is mutated across the loop
    const next = this.script.shift();
    if (!next) throw new Error('model script exhausted');
    return next;
  }
}

class FakeSink implements AgentSink {
  texts: string[] = [];
  cards: Array<{ confirmId: string; summary: string }> = [];
  async say(t: string) {
    this.texts.push(t);
  }
  async proposeCard(confirmId: string, summary: string) {
    this.cards.push({ confirmId, summary });
  }
}

const AGENTS: AgentSummary[] = [
  { id: 'a1', name: 'Tech Advisor', slug: 'tech-advisor', state: 'RUNNING', model: 'claude-opus-4-8', aiProfileId: 'p1' },
];
const WHO = { ownerId: 'o', chatId: 100, fromUserId: 555 };

function setup(script: ChatResponse[], opts: { rw?: boolean; maxSteps?: number } = {}) {
  const api = new FakeApi(AGENTS);
  const broker = new Broker(api, new PendingStore({ genId: () => 'c_x' }));
  if (opts.rw) broker.setMode(true);
  const model = new FakeChatModel(script);
  const agent = new LlmAgent(model, broker, { maxSteps: opts.maxSteps });
  return { api, broker, model, agent, sink: new FakeSink() };
}

const toolUse = (id: string, name: string, input: unknown): ChatResponse => ({
  stopReason: 'tool_use',
  content: [{ type: 'tool_use', id, name, input }],
});
const finalText = (text: string): ChatResponse => ({ stopReason: 'end_turn', content: [{ type: 'text', text }] });

describe('LlmAgent tool loop', () => {
  it('runs a read tool and feeds the result back, then speaks', async () => {
    const { agent, sink, model } = setup([toolUse('t1', 'list_agents', {}), finalText('You have 1 agent, running.')]);
    await agent.respond(WHO, 'what agents do I have?', sink);
    expect(sink.texts).toEqual(['You have 1 agent, running.']);
    // The 2nd model call must have received a tool_result for t1.
    const second = model.reqs[1]!.messages.at(-1) as { role: string; content: ContentBlock[] };
    const tr = second.content[0] as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(tr.type).toBe('tool_result');
    expect(tr.tool_use_id).toBe('t1');
    expect(tr.content).toContain('Tech Advisor');
  });

  it('a change tool posts a confirmation card and does NOT execute', async () => {
    const { agent, sink, api, model } = setup(
      [toolUse('t1', 'stop_agent', { agent: 'a1' }), finalText('Queued — tap Confirm to stop it.')],
      { rw: true },
    );
    await agent.respond(WHO, 'stop tech advisor', sink);
    expect(sink.cards).toEqual([{ confirmId: 'c_x', summary: '⏹ Stop "Tech Advisor"' }]);
    expect(api.calls).toEqual([]); // proposed, not executed
    expect(sink.texts).toContain('Queued — tap Confirm to stop it.');
    // The model was told it is not done yet.
    const back = model.reqs[1]!.messages.at(-1) as { content: ContentBlock[] };
    const tr = back.content[0] as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(tr.content).toMatch(/NOT done yet/i);
  });

  it('read-only mode: a change tool comes back as an error, no card', async () => {
    const { agent, sink, model } = setup([
      toolUse('t1', 'stop_agent', { agent: 'a1' }),
      finalText('That needs read-write mode.'),
    ]); // rw not set
    await agent.respond(WHO, 'stop it', sink);
    expect(sink.cards).toEqual([]);
    const back = model.reqs[1]!.messages.at(-1) as { content: ContentBlock[] };
    const tr = back.content[0] as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(tr.is_error).toBe(true);
    expect(tr.content).toMatch(/READ_ONLY_MODE/);
  });

  it('a forbidden tool is refused by the broker, surfaced as an error', async () => {
    const { agent, sink, model } = setup(
      [toolUse('t1', 'delete_agent', { agent: 'a1' }), finalText('I can’t delete agents from here.')],
      { rw: true },
    );
    await agent.respond(WHO, 'delete tech advisor', sink);
    const back = model.reqs[1]!.messages.at(-1) as { content: ContentBlock[] };
    const tr = back.content[0] as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(tr.is_error).toBe(true);
    expect(tr.content).toMatch(/FORBIDDEN_TOOL/);
    expect(sink.texts).toContain('I can’t delete agents from here.');
  });

  it('stops after maxSteps if the model never finishes', async () => {
    const { agent, sink } = setup([toolUse('t1', 'list_agents', {}), toolUse('t2', 'list_agents', {})], {
      maxSteps: 2,
    });
    await agent.respond(WHO, 'loop forever', sink);
    expect(sink.texts.at(-1)).toMatch(/Stopped — too many steps/);
  });
});
