import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { parsePairingList, claimFirstContact } from '../src/orchestrator/claim.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { canTransition } from '../src/domain/stateMachine.js';
import { DISCORD_ID } from './support/fixtures.js';
import { eventLabel } from '../src/orchestrator/eventLabels.js';
import { beginOperation } from '../src/orchestrator/operations.js';

describe('parsePairingList', () => {
  it('parses the 2026.6.11 pairing file shape', () => {
    const out = JSON.stringify({
      version: 1,
      requests: [
        { id: '1000000001', code: '4KXAEP9W', createdAt: 'x', meta: { username: 'owner' } },
      ],
    });
    expect(parsePairingList(out)).toEqual([
      { id: '1000000001', code: '4KXAEP9W', meta: { username: 'owner' } },
    ]);
  });

  it('accepts a bare array and rejects garbage', () => {
    expect(parsePairingList('[{"id":1,"code":"AB"}]')).toEqual([
      { id: '1', code: 'AB', meta: undefined },
    ]);
    expect(parsePairingList('not json')).toEqual([]);
    expect(parsePairingList('{"requests":"nope"}')).toEqual([]);
  });
});

describe('claimFirstContact', () => {
  it('approves the first request and binds the owner membership', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1',
      slug: 'a1',
      workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
      env: {},
    });

    // RUNNING, as in real life: the claim watcher only starts once the agent
    // is live, and bails out for itself when the agent stops being RUNNING.
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });

    provider.execResponses.set('sh', {
      code: 0,
      stdout: JSON.stringify({ requests: [{ id: '999', code: 'ZZZZ' }] }),
      stderr: '',
    });
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });

    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 1000 },
    );

    expect(claimed).toBe('999');
    expect(store.listAllowedChannelUserIds('a1')).toEqual(['999']);
    expect(provider.execLog.some((a) => a.join(' ').startsWith('pairing approve telegram ZZZZ'))).toBe(true);
  });

  it('never binds a telegram id that already belongs to another membership', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1',
      workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
      env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    // The owner is already bound to telegram 999 (e.g. a concurrent window
    // just claimed it). An invitee's watcher must NOT re-bind 999 onto the
    // invitee — that swap is the two-identities race.
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', channelUserId: '999', status: 'active' });
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'invitee', role: 'user', status: 'active' });
    provider.execResponses.set('sh', {
      code: 0, stdout: JSON.stringify({ requests: [{ id: '999', code: 'ZZZZ' }] }), stderr: '',
    });
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });

    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'invitee', timeoutMs: 30, pollIntervalMs: 1 },
    );
    expect(claimed).toBeNull(); // 999 was skipped, no other request arrived
    expect(store.getMembership('a1', 'invitee')!.channelUserId).toBeUndefined();
    expect(store.getActiveMembershipByChannelUser('a1', '999')!.userId).toBe('u1'); // still the owner
  });

  // A088: the seat is checked before the approval is awaited; a removal that
  // lands during that await left OpenClaw admitting an id no member row held.
  async function approvalRace(during: (store: Store) => void) {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1',
      workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
      env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'invitee', role: 'user', status: 'active' });
    provider.execResponses.set('sh', {
      code: 0, stdout: JSON.stringify({ requests: [{ id: '4242', code: 'RACE' }] }), stderr: '',
    });
    const exec = provider.exec.bind(provider);
    provider.exec = async (ref, argv, o) => {
      if (argv[0] === 'pairing' && argv[1] === 'approve') during(store);
      return exec(ref, argv, o);
    };
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'famBot', forUserId: 'invitee', timeoutMs: 1000, pollIntervalMs: 1 },
    );
    const scrubs = provider.execLog.filter((a) => a[0] === 'sh-volume' && a[1]!.includes('delete from channel_pairing_allow_entries') && a[1]!.includes('"4242"'));
    return { store, claimed, scrubs };
  }

  it('an approval whose seat was removed meanwhile is taken back, and the window closes', async () => {
    const { store, claimed, scrubs } = await approvalRace((s) => s.revokeMembership('a1', 'invitee'));
    expect(claimed).toBeNull();
    expect(scrubs).toHaveLength(1);
    expect(scrubs[0]![1]).toContain('telegram-fambot-allowFrom.json');
    expect(store.pairingWindowOpen('a1')).toBe(false);
  });

  it('an approval somebody else\'s window bound meanwhile is theirs: not scrubbed', async () => {
    const { store, claimed, scrubs } = await approvalRace((s) => { s.bindMembershipChannelUser('a1', 'u1', '4242'); });
    expect(claimed).toBeNull(); // the window gives up on its own timer; the id stays the owner's
    expect(scrubs).toHaveLength(0);
    expect(store.getActiveMembershipByChannelUser('a1', '4242')!.userId).toBe('u1');
  });

  it('waits through a transient REBUILDING instead of abandoning the window', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1',
      workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
      env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'REBUILDING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    provider.execResponses.set('sh', {
      code: 0, stdout: JSON.stringify({ requests: [{ id: '777', code: 'AAAA' }] }), stderr: '',
    });
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });

    // First poll sees REBUILDING (wait, don't abandon); then it goes RUNNING
    // and the claim completes — a routine rebuild mid-window must not strand.
    let polls = 0;
    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => { if (++polls === 1) store.setAgentState('a1', 'RUNNING'); } },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 50, pollIntervalMs: 1 },
    );
    expect(claimed).toBe('777');
  });

  it('the window\'s time runs only while the agent is up: stopped at attach, a window for a named person is all there when it starts, door open (HB-0468)', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'STOPPED',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [{ id: '555', code: 'BBBB' }] }), stderr: '' });
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
    const real = Date.now;
    let clock = real();
    Date.now = () => clock;
    const MIN = 60_000;
    const start = clock;
    const events: string[] = [];
    let windowWhileDown: string | undefined;
    const opened = () => provider.execLog.filter((c) => c[0] === 'sh-volume' && c[1]!.includes('"policy":"pairing"')).length;
    let openedWhileDown = 0;
    try {
      const claimed = await claimFirstContact({
        store, provider, log: (e) => events.push(e),
        sleep: async (ms) => {
          clock += ms;
          // Two hours down, far past the 30-minute window; then it starts.
          if (clock - start >= 2 * 60 * MIN && store.getAgent('a1')!.state === 'STOPPED') {
            windowWhileDown = store.pairingWindow('a1', new Date(clock))?.until;
            openedWhileDown = opened();
            store.setAgentState('a1', 'RUNNING');
          }
        },
      }, { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', expect: '555', timeoutMs: 30 * MIN, pollIntervalMs: 3000 });
      expect(claimed).toBe('555');
    } finally { Date.now = real; }
    // Up again: the door is asserted open once more.
    expect(opened()).toBe(openedWhileDown + 1);
    // While it was down the stored window kept ahead of the clock, so the build that starts it opens the door.
    expect(windowWhileDown && Date.parse(windowWhileDown) > start + 2 * 60 * MIN).toBe(true);
    expect(events).toContain('claim.bound');
    expect(events).not.toContain('claim.window_closed');
  });

  it('a window waits for a stopped agent a while at most, and a later watcher still takes the seat over (HB-0468)', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'STOPPED',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    const real = Date.now;
    let clock = real();
    Date.now = () => clock;
    const HOUR = 3_600_000;
    const start = clock;
    try {
      const events: string[] = [];
      let looks = 0;
      const r = await claimFirstContact({ store, provider, log: (e) => events.push(e), sleep: async (ms) => { looks++; clock += ms; } },
        { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', expect: '@pat_example', timeoutMs: 30 * 60_000, pollIntervalMs: 3000, maxDownMs: 5 * HOUR });
      expect(r).toBeNull();
      expect(events.filter((e) => e.startsWith('claim.'))).toEqual(['claim.window_abandoned']);
      expect(clock - start).toBeGreaterThan(5 * HOUR);
      expect(clock - start).toBeLessThan(5 * HOUR + 60_000);
      expect(looks).toBeLessThan(5 * 240 + 5); // a look every 15 s while it is down, not every 3 s
      expect(store.pairingWindows('a1', new Date(0))).toEqual([]);

      // Reopened while the first watcher waits: the later one owns the seat, though its deadline is the sooner.
      clock = real();
      const first: string[] = [];
      let second: Promise<string | null> | undefined;
      let n = 0;
      const one = claimFirstContact({ store, provider, log: (e) => first.push(e), sleep: async (ms) => {
        clock += ms;
        if (++n === 200) {
          second = claimFirstContact({ store, provider, sleep: async (ms2) => { clock += ms2; } },
            { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 1, pollIntervalMs: 1, maxDownMs: HOUR });
        }
      } }, { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', expect: '@pat_example', timeoutMs: 30 * 60_000, pollIntervalMs: 3000 });
      expect(await one).toBeNull();
      expect(first).toContain('claim.window_superseded');
      expect(await second).toBeNull();
    } finally { Date.now = real; }
  });

  it('back up after a stop, the stored window runs to the watcher\'s own deadline, its last minute too (HB-0468 review)', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'STOPPED',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [] }), stderr: '' });
    const real = Date.now;
    let clock = real();
    Date.now = () => clock;
    const MIN = 60_000;
    const start = clock;
    const events: string[] = [];
    // While it is up: is its window listed, at each look?
    const looks: Array<{ at: number; listed: boolean }> = [];
    try {
      const r = await claimFirstContact({
        store, provider, log: (e) => events.push(e),
        sleep: async (ms) => {
          clock += ms;
          if (store.getAgent('a1')!.state === 'RUNNING') looks.push({ at: clock, listed: store.pairingWindows('a1', new Date(clock)).length > 0 });
          // Down 10 minutes and a bit (a stretch the minute-by-minute renewal falls behind), then up.
          else if (clock - start >= 10 * MIN + 20_000) store.setAgentState('a1', 'RUNNING');
        },
      }, { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 30 * MIN, pollIntervalMs: 3000 });
      expect(r).toBeNull();
    } finally { Date.now = real; }
    expect(events.filter((e) => e.startsWith('claim.'))).toEqual(['claim.window_closed']);
    // Every look but the one that found its time up saw the window.
    expect(looks.length).toBeGreaterThan(300);
    expect(looks.slice(0, -1).filter((l) => !l.listed)).toEqual([]);
  });

  it('an agent moved to another machine while its window waits: the window ends, and nothing more is done on the old machine (HB-0468, fifth review)', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'STOPPED',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    const real = Date.now;
    let clock = real();
    Date.now = () => clock;
    const MIN = 60_000;
    const start = clock;
    const events: Array<{ e: string; d: Record<string, unknown> }> = [];
    let atMove = -1;
    try {
      const r = await claimFirstContact({
        store, provider, log: (e, d) => events.push({ e, d }),
        sleep: async (ms) => {
          clock += ms;
          // Ten minutes down, then moved: up on another machine.
          if (clock - start >= 10 * MIN && atMove < 0) {
            store.setAgentHost('a1', 'h2');
            store.setAgentState('a1', 'RUNNING');
            atMove = provider.execLog.length;
          }
        },
      }, { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', expect: '@pat_example', timeoutMs: 30 * MIN, pollIntervalMs: 3000 });
      expect(r).toBeNull();
    } finally { Date.now = real; }
    const ended = events.filter((x) => x.e === 'claim.window_abandoned');
    expect(ended).toEqual([{ e: 'claim.window_abandoned', d: { agentId: 'a1', reason: 'moved' } }]);
    expect(eventLabel('claim.window_abandoned', ended[0]!.d)).toMatch(/moved to another machine.*Open a new one/);
    expect(store.pairingWindows('a1', new Date(0))).toEqual([]);
    // Nothing more on the old machine: no door opened, no knocks read.
    expect(atMove).toBeGreaterThan(0);
    expect(provider.execLog.slice(atMove)).toEqual([]);
    // Ended at the first look after the move, not days later.
    expect(clock - start).toBeLessThan(11 * MIN);
  });

  /**
   * A move while the window waits, as moveHost does it: the operation begins
   * and the agent stops, the record is pointed at the new machine before the
   * move has succeeded, and then the move is undone (the old machine put
   * back) or finishes (up there, the operation done a little later).
   */
  async function moveWorld(outcome: 'undone' | 'done', reopenAtMin?: number) {
    const store = new Store(new Database(':memory:'));
    const [oldMachine, newMachine] = [new MockProvider(), new MockProvider()];
    const spec = { agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' as const } }, env: {} };
    const { runtimeRef } = await oldMachine.provision(spec);
    await newMachine.provision(spec);
    for (const m of [oldMachine, newMachine]) m.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [] }), stderr: '' });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'RUNNING', runtimeRef,
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    // Somebody already let in, so a door at rest is an allowlist.
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'u2', role: 'user', status: 'active' });
    store.bindMembershipChannelUser('a1', 'u2', '4242');
    const real = Date.now;
    let clock = real();
    Date.now = () => clock;
    const MIN = 60_000;
    const start = clock;
    const events: Array<{ e: string; d: Record<string, unknown> }> = [];
    let op: ReturnType<typeof beginOperation> | undefined;
    let atMove = -1, upThere = false, ended = -1;
    const windowAt: Array<{ min: number; open: boolean }> = [];
    try {
      const r = await claimFirstContact({
        store, provider: oldMachine, providerFor: (h) => (h === 'h2' ? newMachine : oldMachine),
        log: (e, d) => { events.push({ e, d }); if (e === 'claim.window_abandoned') ended = clock - start; },
        sleep: async (ms) => {
          clock += ms;
          const at = clock - start;
          windowAt.push({ min: at / MIN, open: store.pairingWindows('a1', new Date(0)).length > 0 });
          if (reopenAtMin !== undefined && at >= reopenAtMin * MIN && at < reopenAtMin * MIN + ms) {
            // The owner opens the window again (Reopen): a later watcher has the seat.
            store.openPairingWindow('a1', new Date(clock + 45 * MIN).toISOString(), 'u1', { expect: '@pat_example', kind: 'telegram' });
          }
          if (at >= 1 * MIN && !op) {
            op = beginOperation(store, 'move-host', 'a1', { from: 'h', to: 'h2' }, { hostId: 'h2' });
            store.setAgentState('a1', 'STOPPED');
            atMove = oldMachine.execLog.length;
          }
          if (at >= 2 * MIN && op && store.getAgent('a1')!.hostId === 'h' && !upThere && outcome === 'done') store.setAgentHost('a1', 'h2');
          if (outcome === 'undone') {
            if (at >= 2 * MIN && at < 3 * MIN) store.setAgentHost('a1', 'h2');
            if (at >= 3 * MIN && store.getAgent('a1')!.state === 'STOPPED') {
              store.setAgentHost('a1', 'h');
              store.setAgentState('a1', 'RUNNING');
              op!.rolledBack('The move failed and was undone.');
            }
          } else {
            // Up on the new machine while the move still finishes there.
            if (at >= 3 * MIN && !upThere) { store.setAgentState('a1', 'RUNNING'); upThere = true; }
            if (at >= 4 * MIN && op && store.activeOperationFor('a1')) op.done('Moved.');
          }
        },
      }, { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', expect: '@pat_example', timeoutMs: 30 * MIN, pollIntervalMs: 3000 });
      expect(r).toBeNull();
    } finally { Date.now = real; }
    return { store, oldMachine, newMachine, events, atMove, ended, windowAt, MIN };
  }
  const door = (p: MockProvider) => p.execLog.filter((c) => c[0] === 'sh-volume' && c[1]!.includes('"policy":')).map((c) => /"policy":"(\w+)"/.exec(c[1]!)![1]);

  it('a move that is undone keeps the window: nothing is decided while the record points at the new machine (HB-0468, sixth review)', async () => {
    const w = await moveWorld('undone');
    expect(w.events.filter((x) => x.e === 'claim.window_abandoned')).toEqual([]);
    expect(w.events.map((x) => x.e)).toContain('claim.window_closed');
    // Open all through the move, and long after it.
    expect(w.windowAt.filter((l) => l.min > 1 && l.min < 20 && !l.open)).toEqual([]);
    // Nothing on the new machine; back on the old one, the door is opened again for the person still awaited.
    expect(w.newMachine.execLog).toEqual([]);
    expect(door(w.oldMachine).slice(-2)).toEqual(['pairing', 'allowlist']);
  });

  it('a move that succeeds ends the window once the move is over, and puts the new machine\'s door back to its allowlist (HB-0468, sixth review)', async () => {
    const w = await moveWorld('done');
    expect(w.events.filter((x) => x.e === 'claim.window_abandoned')).toEqual([{ e: 'claim.window_abandoned', d: { agentId: 'a1', reason: 'moved' } }]);
    // Not while the move was still under way, though the agent was up there already.
    expect(w.ended).toBeGreaterThanOrEqual(4 * w.MIN);
    expect(w.ended).toBeLessThan(5 * w.MIN);
    expect(w.store.pairingWindows('a1', new Date(0))).toEqual([]);
    expect(door(w.newMachine)).toEqual(['allowlist']);
    // Nothing more on the old machine once the move began: no knocks read, no door.
    expect(w.atMove).toBeGreaterThan(0);
    expect(w.oldMachine.execLog.slice(w.atMove)).toEqual([]);
  });

  it('reopened on the new machine while the move finished: the older watcher leaves the window and the door to the later one (HB-0468, sixth review)', async () => {
    const w = await moveWorld('done', 4); // in the same moment the move finishes
    expect(w.events.map((x) => x.e).filter((e) => e.startsWith('claim.'))).toEqual(['claim.window_superseded']);
    expect(w.store.pairingWindows('a1', new Date(0))).toHaveLength(1);
    expect(door(w.newMachine)).toEqual([]);
  });

  it('a window open to anyone ends after an hour with the agent down, and its door is not opened again when it comes up (HB-0468 review)', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'STOPPED',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    // Someone already let in: the door's rest is the allowlist.
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'u2', role: 'user', status: 'active', channelUserId: '4242' });
    // A stranger is first to write once it is up.
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [{ id: '777', code: 'CCCC' }] }), stderr: '' });
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
    const real = Date.now;
    let clock = real();
    Date.now = () => clock;
    const MIN = 60_000;
    const start = clock;
    const events: Array<{ e: string; d: Record<string, unknown> }> = [];
    const policies = () => provider.execLog.filter((c) => c[0] === 'sh-volume' && c[1]!.includes('"policy":')).map((c) => /"policy":"(\w+)"/.exec(c[1]!)![1]);
    try {
      const r = await claimFirstContact({
        store, provider, log: (e, d) => events.push({ e, d }),
        sleep: async (ms) => {
          clock += ms;
          // Two hours down, then it starts.
          if (clock - start >= 2 * 60 * MIN && store.getAgent('a1')!.state === 'STOPPED') store.setAgentState('a1', 'RUNNING');
        },
      }, { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 30 * MIN, pollIntervalMs: 3000 });
      expect(r).toBeNull();
    } finally { Date.now = real; }
    const claimEvents = events.filter((x) => x.e.startsWith('claim.'));
    expect(claimEvents).toEqual([{ e: 'claim.window_abandoned', d: { agentId: 'a1', reason: 'open-to-anyone' } }]);
    expect(eventLabel('claim.window_abandoned', claimEvents[0]!.d)).toMatch(/open a new one/);
    // Ended an hour after it opened, while it was still down.
    expect(clock - start).toBeGreaterThanOrEqual(60 * MIN);
    expect(clock - start).toBeLessThan(61 * MIN);
    // No window left for the build that starts it to open the door for.
    expect(store.pairingWindows('a1', new Date(0))).toEqual([]);
    // Opened when it began, back to the allowlist when it ended: never opened again.
    expect(policies()).toEqual(['pairing', 'allowlist']);
    expect(store.getMembership('a1', 'u1')?.channelUserId).toBeUndefined();
  });

  it('a rebuild with 10 s of the window left: the stored window never lapses while it is down, and the door is open again once it is up (HB-0468 review)', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [] }), stderr: '' });
    const real = Date.now;
    let clock = real();
    Date.now = () => clock;
    const MIN = 60_000;
    const start = clock;
    const opened = () => provider.execLog.filter((c) => c[0] === 'sh-volume' && c[1]!.includes('"policy":"pairing"')).length;
    let rebuildAt: number | undefined;
    let upAt: number | undefined;
    let openedBeforeUp = 0;
    const lapsed: number[] = [];
    let listedWhenUp = false;
    try {
      const r = await claimFirstContact({
        store, provider,
        sleep: async (ms) => {
          clock += ms;
          const state = store.getAgent('a1')!.state;
          if (state === 'REBUILDING') {
            // What the build that brings it up sees, between two looks.
            if (!store.pairingWindows('a1', new Date(clock)).length) lapsed.push(clock - rebuildAt!);
            if (clock - rebuildAt! >= 47_000) {
              listedWhenUp = store.pairingWindows('a1', new Date(clock)).length > 0;
              openedBeforeUp = opened();
              store.setAgentState('a1', 'RUNNING');
              upAt = clock;
            }
          } else if (rebuildAt === undefined && clock - start >= 30 * MIN - 10_000) {
            store.setAgentState('a1', 'REBUILDING');
            rebuildAt = clock;
          }
        },
      }, { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 30 * MIN, pollIntervalMs: 3000 });
      expect(r).toBeNull();
    } finally { Date.now = real; }
    expect(rebuildAt).toBeDefined();
    expect(upAt).toBeDefined();
    expect(lapsed).toEqual([]);
    expect(listedWhenUp).toBe(true);
    // Up again with time left: the door is asserted open once more.
    expect(opened()).toBe(openedBeforeUp + 1);
    // And the window still runs the 10 s it had left, after the build.
    expect(clock - upAt!).toBeGreaterThanOrEqual(5_000);
  });

  it('a window closed elsewhere while the agent is stopped ends its watcher, not days of looks (HB-0468 review)', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'STOPPED',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    const real = Date.now;
    let clock = real();
    Date.now = () => clock;
    const events: string[] = [];
    let looks = 0;
    try {
      const r = await claimFirstContact({
        store, provider, log: (e) => events.push(e),
        sleep: async (ms) => {
          clock += ms;
          // Its person let in by hand, which closes the window.
          if (++looks === 5) store.closePairingWindow('a1', Store.pairingSeat('telegram', 'u1'));
        },
      }, { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 30 * 60_000, pollIntervalMs: 3000, maxDownMs: 24 * 3_600_000 });
      expect(r).toBeNull();
    } finally { Date.now = real; }
    expect(events.filter((e) => e.startsWith('claim.'))).toEqual(['claim.window_gone']);
    expect(looks).toBe(5);
    expect(store.pairingWindows('a1', new Date(0))).toEqual([]);
  });

  it('abandons the window when the agent is deleted or failed', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1',
      workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
      env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'FAILED',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 50, pollIntervalMs: 1 },
    );
    expect(claimed).toBeNull();
  });

  // Review, 2026-10-22 (B16, B17).
  async function owner() {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1',
      workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
      env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [{ id: '999', code: 'ZZZZ' }] }), stderr: '' });
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
    return { store, provider, runtimeRef };
  }
  const allowlisted = (p: MockProvider) => p.execLog.some((a) => a[0] === 'sh-volume' && a[1]!.includes('"policy":"allowlist"'));

  it("another chat app's window does not keep this one's door open once it is claimed", async () => {
    const { store, provider, runtimeRef } = await owner();
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'guest', role: 'user', status: 'active' });
    store.openPairingWindow('a1', new Date(Date.now() + 600_000).toISOString(), 'guest', { kind: 'discord' });
    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 1000 },
    );
    expect(claimed).toBe('999');
    expect(allowlisted(provider)).toBe(true);
  });

  it("the same chat app's other window still holds the door", async () => {
    const { store, provider, runtimeRef } = await owner();
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'guest', role: 'user', status: 'active' });
    store.openPairingWindow('a1', new Date(Date.now() + 600_000).toISOString(), 'guest', { kind: 'telegram' });
    await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 1000 },
    );
    expect(allowlisted(provider)).toBe(false);
  });

  it('a pairing read that throws is tried again, not the end of the watcher', async () => {
    const { store, provider, runtimeRef } = await owner();
    const execShell = provider.execShell.bind(provider);
    let n = 0;
    provider.execShell = async (ref, script, o) => {
      if (++n === 1) throw new Error('docker exec: connection reset');
      return execShell(ref, script, o);
    };
    const events: string[] = [];
    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => {}, log: (e) => { events.push(e); } },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 1000, pollIntervalMs: 1 },
    );
    expect(claimed).toBe('999');
    expect(events.filter((e) => e === 'claim.read_failed')).toHaveLength(1);
    expect(store.pairingWindowOpen('a1')).toBe(false);
  });

  it('returns null when the window closes with no contact', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a2',
      slug: 'a2',
      workspace: { files: {}, configPatch: { agentId: 'a2', authMode: 'api-key' } },
      env: {},
    });
    store.insertAgent({
      id: 'a2', ownerId: 'u1', name: 'B', slug: 'a2', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    let now = 0;
    const claimed = await claimFirstContact(
      {
        store,
        provider,
        sleep: async () => {
          now += 5000;
        },
      },
      { agentId: 'a2', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 1, pollIntervalMs: 1 },
    );
    expect(claimed).toBeNull();
  });

  // Review R22, 2026-10-23: the owner's Reopen (or Telegram attached again) starts a
  // second watcher for the same seat before the first has run out. The two share one
  // stored window; the older one used to delete it and shut the door at ITS deadline.
  async function guestSeat() {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a4', slug: 'a4',
      workspace: { files: {}, configPatch: { agentId: 'a4', authMode: 'api-key' } },
      env: {},
    });
    store.insertAgent({
      id: 'a4', ownerId: 'u1', name: 'D', slug: 'a4', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    // The owner is in already, so a window that closes shuts the door (allowlist).
    store.insertMembership({ id: 'm1', agentId: 'a4', userId: 'u1', role: 'owner', channelUserId: '31337', status: 'active' });
    store.insertMembership({ id: 'm2', agentId: 'a4', userId: 'guest', role: 'user', status: 'active' });
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [] }), stderr: '' });
    return { store, provider, runtimeRef };
  }
  const guestWindow = (store: Store) => store.pairingWindows('a4', new Date(0)).find((w) => w.seat === Store.pairingSeat('telegram', 'guest'));

  it('reopened while an older watcher waits: the older one stops, leaving the renewed window and the open door alone', async () => {
    const { store, provider, runtimeRef } = await guestSeat();
    const events: string[] = [];
    const renewedUntil = new Date(Date.now() + 60 * 60_000).toISOString();
    let polls = 0;
    const claimed = await claimFirstContact(
      {
        store, provider, log: (e) => { events.push(e); },
        sleep: async () => { if (++polls === 1) store.openPairingWindow('a4', renewedUntil, 'guest', { kind: 'telegram' }); },
      },
      { agentId: 'a4', runtimeRef, accountId: 'bot', forUserId: 'guest', timeoutMs: 60_000, pollIntervalMs: 1 },
    );
    expect(claimed).toBeNull();
    expect(polls).toBe(1); // noticed on the next round, not at its own deadline
    expect(events).toContain('claim.window_superseded');
    expect(events).not.toContain('claim.window_closed');
    expect(guestWindow(store)?.until).toBe(renewedUntil);
    expect(allowlisted(provider)).toBe(false);
  });

  it("renewed during the older watcher's last sleep: its timeout leaves the window; the later watcher's own timeout closes it", async () => {
    const { store, provider, runtimeRef } = await guestSeat();
    const events: string[] = [];
    const renewedUntil = new Date(Date.now() + 60 * 60_000).toISOString();
    // Real time: the deadline is Date.now() + timeoutMs at the start, and the first round
    // (opening the window and the door) must land before it. 5 ms did not on a busy CI runner
    // (the loop never ran, nothing was renewed, the window closed; 2026-10-24): generous now.
    let polls = 0;
    const claimed = await claimFirstContact(
      {
        store, provider, log: (e) => { events.push(e); },
        sleep: async () => {
          polls++;
          store.openPairingWindow('a4', renewedUntil, 'guest', { kind: 'telegram' });
          await new Promise((r) => setTimeout(r, 700)); // past this watcher's deadline
        },
      },
      { agentId: 'a4', runtimeRef, accountId: 'bot', forUserId: 'guest', timeoutMs: 400, pollIntervalMs: 1 },
    );
    expect(claimed).toBeNull();
    expect(polls, 'the first round ran before the deadline').toBe(1);
    expect(events).toContain('claim.window_superseded');
    expect(events).not.toContain('claim.window_closed');
    expect(guestWindow(store)?.until).toBe(renewedUntil);
    expect(allowlisted(provider)).toBe(false);
    // The later watcher, run to its own end: the window closes and the door shuts.
    const later = await claimFirstContact(
      { store, provider, sleep: async () => {}, log: (e) => { events.push(e); } },
      { agentId: 'a4', runtimeRef, accountId: 'bot', forUserId: 'guest', timeoutMs: 1, pollIntervalMs: 1 },
    );
    expect(later).toBeNull();
    expect(events).toContain('claim.window_closed');
    expect(guestWindow(store)).toBeUndefined();
    expect(allowlisted(provider)).toBe(true);
  });
});

describe('state machine', () => {
  it('enforces §11.4 transitions', () => {
    expect(canTransition('PROVISIONING', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'STOPPED')).toBe(true);
    expect(canTransition('STOPPED', 'RUNNING')).toBe(true);
    expect(canTransition('DELETED', 'RUNNING')).toBe(false);
    expect(canTransition('PROVISIONING', 'STOPPED')).toBe(false);
    expect(canTransition('FAILED', 'PROVISIONING')).toBe(true);
    expect(canTransition('RUNNING', 'REBUILDING')).toBe(true);
    expect(canTransition('STOPPED', 'REBUILDING')).toBe(true);
    expect(canTransition('REBUILDING', 'RUNNING')).toBe(true);
    expect(canTransition('REBUILDING', 'FAILED')).toBe(true);
    expect(canTransition('REBUILDING', 'DELETING')).toBe(true);
    expect(canTransition('PROVISIONING', 'REBUILDING')).toBe(false);
  });
});

describe('the claim says hello', () => {
  it('greets the owner the moment their first contact binds, so they do not type "hi" twice', async () => {
    const { claimFirstContact } = await import('../src/orchestrator/claim.js');
    const { Store } = await import('../src/store/store.js');
    const Database = (await import('better-sqlite3')).default;
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
    store.insertAgent({
      id: 'a1', ownerId: 'o', name: 'October Agent', slug: 'october', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      runtimeRef: 'docker://a1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    } as never);
    store.insertMembership({ id: 'm0', agentId: 'a1', userId: 'o', role: 'owner', status: 'active' } as never);

    const sent: string[] = [];
    const provider = {
      execShell: async () => ({ code: 0, stdout: JSON.stringify({ version: 1, requests: [{ id: '424242', code: 'C6STF628', meta: { firstName: 'Robin' } }] }), stderr: '' }),
      execShellOnVolume: async () => ({ code: 0, stdout: 'set', stderr: '' }),
      exec: async (_ref: string, argv: string[]) => {
        if (argv[0] === 'message') sent.push(argv[argv.indexOf('-m') + 1]!);
        return { code: 0, stdout: '', stderr: '' };
      },
    } as never;

    // The window is wall-clock time from its opening: 60 ms ran out before the
    // first poll on a busy CI machine (main's run of v2.179.0, HB-0673). The
    // request is there at once and the sleep is a stub, so 5 s costs nothing.
    const bound = await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef: 'docker://a1', accountId: 'bot', forUserId: 'o', timeoutMs: 5_000, pollIntervalMs: 5 },
    );
    expect(bound).toBe('424242');
    expect(sent.join(' ')).toContain('Robin');
    expect(sent.join(' ')).toMatch(/Connected/);
  }, 10_000);
});

describe('the owner claim never takes a known person (2026-09-25)', () => {
  // An owner window with no named handle is "the first knock". A Discord bot
  // is visible to a whole server and a recycled Telegram bot has just written
  // to its previous agent's regulars, so the first knock is only claimed when
  // the id is nobody this machine knows.
  async function world(kind: 'telegram' | 'discord', requests: Array<{ id: string; code: string }>) {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} });
    for (const [id, owner] of [['a1', 'u1'], ['b1', 'u2']] as const) {
      store.insertAgent({ id, ownerId: owner, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
      store.insertMembership({ id: `m-${id}`, agentId: id, userId: owner, role: 'owner', status: 'active' });
    }
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests }), stderr: '' });
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
    const claim = (extra: Record<string, unknown> = {}) => claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', kind, timeoutMs: 1000, pollIntervalMs: 1, ...extra } as never,
    );
    return { store, claim };
  }

  it('Telegram: a member of another owner\'s agent, or another account\'s link, is passed over for a fresh id', async () => {
    const { store, claim } = await world('telegram', [{ id: '555', code: 'AAAA' }, { id: '777', code: 'BBBB' }, { id: '999', code: 'CCCC' }]);
    store.insertMembership({ id: 'm-x', agentId: 'b1', userId: 'u9', role: 'user', channelUserId: '555', status: 'active' });
    store.setAccountTelegram('u2', '777');
    expect(await claim()).toBe('999');
    expect(store.getMembership('a1', 'u1')?.channelUserId).toBe('999');
  });

  it('Telegram: the recycled bot\'s previous regulars are excluded even when unknown to the store; nobody else → the window closes unclaimed', async () => {
    const { store, claim } = await world('telegram', [{ id: '4242', code: 'AAAA' }]);
    expect(await claim({ excludeIds: ['4242'] })).toBeNull();
    expect(store.getMembership('a1', 'u1')?.channelUserId).toBeFalsy();
  });

  it('Discord: an identity bound on any agent is never the owner\'s first message; a malformed id is never bound', async () => {
    const { store, claim } = await world('discord', [{ id: 'not-an-id', code: 'AAAA' }, { id: '123456789012345678', code: 'BBBB' }, { id: '987654321098765432', code: 'CCCC' }]);
    store.insertMembership({ id: 'm-y', agentId: 'b1', userId: 'u3', role: 'user', status: 'active' });
    store.bindMemberIdentity('b1', 'u3', 'discord', DISCORD_ID);
    expect(await claim()).toBe('987654321098765432');
    expect(store.memberIdentities('a1', 'u1').discord).toBe('987654321098765432');
  });

  it('a window that names its person still claims exactly them, known or not', async () => {
    const { store, claim } = await world('telegram', [{ id: '555', code: 'AAAA' }]);
    store.insertMembership({ id: 'm-x', agentId: 'b1', userId: 'u9', role: 'user', channelUserId: '555', status: 'active' });
    expect(await claim({ expect: '555' })).toBe('555');
  });
});

