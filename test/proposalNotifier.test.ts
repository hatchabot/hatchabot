import { describe, expect, it } from 'vitest';
import { createProposalNotifier, type WebProposal } from '../src/mgmt/proposalNotifier.js';
import { ManagementBot, type BotTransport } from '../src/mgmt/bot.js';
import { Broker } from '../src/mgmt/broker.js';
import { PendingStore } from '../src/mgmt/pendingStore.js';

/** Approving the management agent's proposals from Hatchabot's own Telegram bot. */

function tx() {
  const sent: Array<{ chatId: number; text: string; buttons?: any }> = [];
  const edits: string[] = []; const answers: string[] = [];
  const t = {
    sendMessage: async (chatId: number, text: string, buttons?: unknown) => { sent.push({ chatId, text, buttons }); return { messageId: sent.length }; },
    editMessage: async (_c: number, _m: number, text: string) => { edits.push(text); },
    answerCallback: async (_id: string, text?: string) => { answers.push(text ?? ''); },
  } as unknown as BotTransport;
  return { t, sent, edits, answers };
}
const NOW = 1_000_000;
const P = (over: Partial<WebProposal>): WebProposal => ({ confirmId: 'c_1', summary: '▶ Stop "Taco Agent"', source: 'agent', risk: 'disruptive', note: 'It has been idle for weeks.', createdAtMs: NOW, ...over });

describe('proposal notifier', () => {
  it('announces each agent-prepared proposal once, with its risk and the agent’s reason', async () => {
    const { t, sent } = tx();
    let pending = [P({}), P({ confirmId: 'c_2', source: 'chat' }), P({ confirmId: 'c_3', createdAtMs: NOW - 3600_000 })];
    const n = createProposalNotifier({ listProposals: async () => ({ pending }), resolveProposal: async () => ({ text: '' }) }, t, [555], { now: () => NOW });
    await n.tick(); await n.tick();
    expect(sent).toHaveLength(1); // not the web chat's own card, not the stale one, not twice
    expect(sent[0]!.text).toMatch(/Hatchabot agent prepared[\s\S]*Restarts or interrupts[\s\S]*Stop "Taco Agent"[\s\S]*Its reason: “It has been idle/);
    expect(sent[0]!.buttons[0].map((b: any) => b.data)).toEqual(['prp:c_1:y', 'prp:c_1:n']);
    pending = [];
    await n.tick();
    expect(sent).toHaveLength(1);
  });
});

describe('the bot’s Confirm tap', () => {
  const bot = (resolve: (id: string, verb: string) => Promise<{ text: string }>) => {
    const x = tx();
    const b = new ManagementBot(new Broker({} as any, new PendingStore()), x.t, {
      ownerId: 'o', allowlist: [555], viewers: [777],
      proposals: { listProposals: async () => ({ pending: [] }), resolveProposal: resolve as any },
    });
    return { b, ...x };
  };
  it('an operator’s tap confirms through the server and rewrites the card', async () => {
    const calls: string[] = [];
    const { b, edits, answers } = bot(async (id, verb) => { calls.push(`${id}:${verb}`); return { text: '✅ ▶ Stop "Taco Agent"' }; });
    await b.onCallback(100, 555, 'cb', 'prp:c_1:y', 9);
    expect(calls).toEqual(['c_1:confirm']);
    expect(answers).toEqual(['Confirmed']);
    expect(edits[0]).toMatch(/✅/);
  });
  it('a viewer, a stranger and a group chat cannot', async () => {
    const calls: string[] = [];
    const { b } = bot(async (id, verb) => { calls.push(`${id}:${verb}`); return { text: '' }; });
    await b.onCallback(100, 777, 'cb', 'prp:c_1:y', 9);
    await b.onCallback(100, 999, 'cb', 'prp:c_1:y', 9);
    await b.onCallback(-100, 555, 'cb', 'prp:c_1:y', 9);
    expect(calls).toEqual([]);
  });
  it('already handled elsewhere: says so and retires the card', async () => {
    const { b, edits, answers } = bot(async () => { throw new Error('Already handled.'); });
    await b.onCallback(100, 555, 'cb', 'prp:c_1:n', 9);
    expect(answers[0]).toMatch(/Already handled/);
    expect(edits[0]).toMatch(/Already handled/);
  });
});
