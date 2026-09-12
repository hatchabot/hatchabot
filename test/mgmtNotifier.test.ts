import { describe, expect, it } from 'vitest';
import { createPairingNotifier, joinerLabel, APPROVE_PREFIX, DENY_PREFIX } from '../src/mgmt/notifier.js';
import type { BotTransport, InlineButton } from '../src/mgmt/bot.js';
import type { PendingJoin } from '../src/mgmt/broker.js';

class FakeTx implements BotTransport {
  sent: Array<{ chatId: number; text: string; buttons?: InlineButton[][] }> = [];
  #id = 0;
  async sendMessage(chatId: number, text: string, buttons?: InlineButton[][]) {
    this.sent.push({ chatId, text, buttons });
    return { messageId: ++this.#id };
  }
  async editMessage() {}
  async answerCallback() {}
}

/** A pending source whose list is swapped between ticks. */
class FakeApi {
  pending: PendingJoin[] = [];
  calls = 0;
  async listAllPending() {
    this.calls++;
    return this.pending;
  }
}

const REQ = (over: Partial<PendingJoin> = {}): PendingJoin => ({
  agentId: 'a1', agentName: 'Condo Adviser', code: 'AB12CD',
  telegramId: '7777', username: 'maria_k', firstName: 'Maria', ...over,
});

describe('joinerLabel', () => {
  it('prefers name + @username, falls back gracefully', () => {
    expect(joinerLabel(REQ())).toBe('Maria (@maria_k)');
    expect(joinerLabel(REQ({ username: undefined }))).toBe('Maria');
    expect(joinerLabel(REQ({ firstName: undefined, lastName: undefined }))).toBe('@maria_k');
    expect(joinerLabel(REQ({ firstName: undefined, lastName: undefined, username: undefined }))).toBe('Someone');
  });
});

describe('createPairingNotifier', () => {
  it('notifies each allowlisted admin once per request, with Approve/Dismiss buttons', async () => {
    const api = new FakeApi();
    const tx = new FakeTx();
    api.pending = [REQ()];
    const n = createPairingNotifier(api, tx, [555, 556], { intervalMs: 1_000_000 });
    await n.tick();
    n.stop();

    // Two admins, one request → two messages, then no repeats on the next tick.
    const forReq = tx.sent.filter((m) => m.text.includes('Condo Adviser'));
    expect(forReq.map((m) => m.chatId).sort()).toEqual([555, 556]);
    expect(forReq[0]!.text).toMatch(/Maria \(@maria_k\) wants to join "Condo Adviser"/);
    const [approve, deny] = forReq[0]!.buttons![0]!;
    expect(approve!.data).toBe(`${APPROVE_PREFIX}:a1:AB12CD`);
    expect(deny!.data).toBe(`${DENY_PREFIX}:a1:AB12CD`);
  });

  it('does not re-notify a request already seen', async () => {
    const api = new FakeApi();
    const tx = new FakeTx();
    api.pending = [REQ()];
    const n = createPairingNotifier(api, tx, [555], { intervalMs: 1_000_000 });
    await n.tick();
    await n.tick();
    n.stop();
    expect(tx.sent.filter((m) => m.text.includes('Condo Adviser'))).toHaveLength(1);
  });

  it('re-notifies if the same code recurs after the request cleared (seen is pruned)', async () => {
    const api = new FakeApi();
    const tx = new FakeTx();
    api.pending = [REQ()];
    const n = createPairingNotifier(api, tx, [555], { intervalMs: 1_000_000 });
    await n.tick();          // notify #1
    api.pending = [];        // approved/expired → gone
    await n.tick();          // prunes 'a1:AB12CD' from seen
    api.pending = [REQ()];   // same code appears again
    await n.tick();          // notify #2 (not suppressed)
    n.stop();
    expect(tx.sent.filter((m) => m.text.includes('Condo Adviser'))).toHaveLength(2);
  });

  it('a poll error does not throw or wedge the poller', async () => {
    const api = { listAllPending: async () => { throw new Error('control plane down'); } };
    const tx = new FakeTx();
    const n = createPairingNotifier(api, tx, [555], { intervalMs: 1_000_000 });
    await expect(n.tick()).resolves.toBeUndefined();
    n.stop();
    expect(tx.sent).toHaveLength(0);
  });
});
