import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleAccess, type GuestDoor, type GuestLine } from '../src/orchestrator/console/consoleAccess.js';

/**
 * A guest's new console at the door, in one place (HB-0645):
 * ConsoleAccess.admitGuest counts their consoles, promises room past the
 * limit, starts the time it has to connect and notes when it was last used,
 * in that order, from one look at their consoles. The upgrade handler that
 * calls it is tested end to end in consoleGuests.test.ts ("the door, in order").
 */

let now = 1_000_000;
beforeEach(() => {
  now = 1_000_000;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Every agent running and every guest still allowed, so the 30-second sweep closes nothing. */
const consoles = () => new ConsoleAccess({
  store: { getAgent: (id: string) => ({ id, state: 'RUNNING', ownerId: 'user-owner' }), webChatAllowed: () => true } as never,
  providerFor: () => { throw new Error('no runtime in these tests'); },
  gatewayAddr: async () => undefined,
});
const door = (over: Partial<GuestDoor> = {}): GuestDoor & { destroy: ReturnType<typeof vi.fn>; timedOut: ReturnType<typeof vi.fn> } =>
  ({ max: 3, idleFor: 60_000, every: 600_000, connectTimeoutMs: 30_000, destroy: vi.fn(), timedOut: vi.fn(), ...over }) as never;
const line = (answering = false): GuestLine & { close: ReturnType<typeof vi.fn> } => ({ answering: () => answering, close: vi.fn() }) as never;

describe('admitGuest', () => {
  it('counts the ones still connecting first: past the limit it refuses "connecting" before looking for room, and counts, promises and starts nothing', () => {
    const a = consoles();
    const doors = [door(), door(), door()];
    for (const d of doors) expect(a.admitGuest('agent-one', 'user-x', d).admitted).toBeDefined();
    expect(a.openGuests(undefined, 'user-x', 'connecting')).toBe(3);
    const timers = vi.getTimerCount();
    const extra = door();
    expect(a.admitGuest('agent-two', 'user-x', extra)).toEqual({ refused: 'connecting' });
    expect(a.openGuests(undefined, 'user-x')).toBe(3);
    expect(vi.getTimerCount()).toBe(timers);
    // Another guest is not held to theirs.
    expect(a.admitGuest('agent-one', 'user-y', door()).admitted).toBeDefined();
  });

  it('with the limit open and none unused long enough to make room from, refuses "full"; with one, promises it and lets the new one in', () => {
    const a = consoles();
    const lines = [line(), line(), line()];
    for (const l of lines) a.admitGuest('agent-one', 'user-x', door())!.admitted!.connected(l);
    expect(a.openGuests(undefined, 'user-x', 'connecting')).toBe(0);
    const timers = vi.getTimerCount();
    expect(a.admitGuest('agent-one', 'user-x', door())).toEqual({ refused: 'full' });
    expect(vi.getTimerCount()).toBe(timers);
    now += 60_000; // all three unused for idleFor
    const fourth = a.admitGuest('agent-two', 'user-x', door()).admitted!;
    expect(fourth).toBeDefined();
    // The one promised counts as gone, the new one as connecting in its place, so a fifth finds no room.
    expect(a.openGuests(undefined, 'user-x')).toBe(3);
    expect(a.openGuests(undefined, 'user-x', 'connecting')).toBe(1);
    expect(a.admitGuest('agent-two', 'user-x', door())).toEqual({ refused: 'full' });
    // Nothing is closed until it connects; then the least recently active is, as opened in another tab.
    expect(lines.map((l) => l.close.mock.calls.length)).toEqual([0, 0, 0]);
    expect(fourth.connected(line())).toEqual({ closed: 'agent-one' });
    expect(lines[0]!.close.mock.calls).toEqual([[1001, 'opened in another tab']]);
    expect(lines.slice(1).map((l) => l.close.mock.calls.length)).toEqual([0, 0]);
    expect(a.openGuests(undefined, 'user-x')).toBe(3);
  });

  it('a console promised as room is promised once: the next one past the limit takes another, so no more than the limit stay open', () => {
    const a = consoles();
    for (let i = 1; i <= 3; i++) a.admitGuest(`agent-${i}`, 'user-x', door())!.admitted!.connected(line());
    now += 600_000; // all three unused for `every`: each may be closed for room, the window aside
    const fourth = a.admitGuest('agent-4', 'user-x', door()).admitted!;
    const fifth = a.admitGuest('agent-5', 'user-x', door()).admitted!;
    expect(fourth.connected(line())).toEqual({ closed: 'agent-1' });
    // Not the first again (already gone, so nothing would be closed for this one).
    expect(fifth.connected(line())).toEqual({ closed: 'agent-2' });
    expect(a.openGuests(undefined, 'user-x')).toBe(3);
  });

  it('between a time to connect running out and its socket closing, the one timed out still counts as connecting: one more is refused as connecting, though room went back, until the close', () => {
    const a = consoles();
    for (let i = 1; i <= 3; i++) a.admitGuest(`agent-${i}`, 'user-x', door())!.admitted!.connected(line());
    now += 600_000;
    // Three connecting, each on room promised from one of the three; the first a second earlier.
    const first = a.admitGuest('agent-4', 'user-x', door()).admitted!;
    vi.advanceTimersByTime(1_000);
    a.admitGuest('agent-5', 'user-x', door());
    a.admitGuest('agent-6', 'user-x', door());
    vi.advanceTimersByTime(29_000); // the first's time runs out: its room goes back; its socket is not closed yet
    expect(a.openGuests(undefined, 'user-x', 'connecting')).toBe(3);
    const timers = vi.getTimerCount();
    expect(a.admitGuest('agent-7', 'user-x', door())).toEqual({ refused: 'connecting' });
    expect(vi.getTimerCount()).toBe(timers);
    first.closed(); // its socket's close
    expect(a.admitGuest('agent-7', 'user-x', door()).admitted).toBeDefined();
  });

  it('one let in was last used at the door, until it is used; a chat being answered is not idle', () => {
    const a = consoles();
    const first = a.admitGuest('agent-1', 'user-x', door()).admitted!;
    expect(first.usedAt).toBe(1_000_000);
    now += 5_000;
    const answering = line(true);
    first.connected(answering);
    expect(first.usedAt).toBe(1_000_000); // connecting is not using it
    const second = a.admitGuest('agent-2', 'user-x', door()).admitted!;
    second.connected(line());
    const third = a.admitGuest('agent-3', 'user-x', door()).admitted!;
    third.connected(line());
    expect(third.usedAt).toBe(1_005_000);
    now += 60_000;
    second.used(now);
    // The first is the least used (since its door) but is being answered; the second was used just now;
    // the third, unused since its door, is the one promised.
    const fourth = a.admitGuest('agent-4', 'user-x', door()).admitted!;
    expect(fourth.connected(line())).toEqual({ closed: 'agent-3' });
    expect(answering.close).not.toHaveBeenCalled();
    expect(first.usedAt).toBe(1_000_000);
    expect(second.usedAt).toBe(1_065_000);
  });

  it('has connectTimeoutMs from the door to connect: then it says so, is closed, and the room promised for it goes back; connected in time, it is not', () => {
    const a = consoles();
    for (let i = 0; i < 3; i++) a.admitGuest('agent-one', 'user-x', door())!.admitted!.connected(line());
    now += 60_000;
    const slow = door();
    const late = a.admitGuest('agent-two', 'user-x', slow).admitted!;
    expect(a.openGuests(undefined, 'user-x')).toBe(3);
    vi.advanceTimersByTime(29_999);
    expect(slow.timedOut).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(slow.timedOut).toHaveBeenCalledTimes(1);
    expect(slow.destroy).toHaveBeenCalledTimes(1);
    expect(slow.timedOut.mock.invocationCallOrder[0]!).toBeLessThan(slow.destroy.mock.invocationCallOrder[0]!);
    // The room went back: the three count again, and the slow one until its socket's close says it ended.
    expect(a.openGuests(undefined, 'user-x')).toBe(4);
    late.closed();
    expect(a.openGuests(undefined, 'user-x')).toBe(3);
    // One that connects in time is not closed by it.
    const quick = door();
    a.admitGuest('agent-two', 'user-x', quick).admitted!.connected(line());
    vi.advanceTimersByTime(60_000);
    expect(quick.timedOut).not.toHaveBeenCalled();
    expect(quick.destroy).not.toHaveBeenCalled();
  });

  it('connected, when the one promised was used again meanwhile: refused, it is forgotten here, and nothing is closed', () => {
    const a = consoles();
    const firsts = [0, 1, 2].map(() => a.admitGuest('agent-one', 'user-x', door())!.admitted!);
    const lines = firsts.map((f) => { const l = line(); f.connected(l); return l; });
    now += 60_000;
    const late = a.admitGuest('agent-two', 'user-x', door()).admitted!;
    firsts[0]!.used(now); // the one promised, used again
    expect(late.connected(line())).toEqual({ refused: true });
    expect(lines.map((l) => l.close.mock.calls.length)).toEqual([0, 0, 0]);
    expect(a.openGuests(undefined, 'user-x')).toBe(3);
    expect(a.openGuests('agent-two', 'user-x')).toBe(0);
  });

  it('closed before it connects: forgotten, its time stopped, the room given back and what it has open closed; it works once', () => {
    const a = consoles();
    for (let i = 0; i < 3; i++) a.admitGuest('agent-one', 'user-x', door())!.admitted!.connected(line());
    now += 60_000;
    const d = door();
    const left = a.admitGuest('agent-two', 'user-x', d).admitted!;
    expect(a.openGuests(undefined, 'user-x')).toBe(3);
    left.closed();
    expect(d.destroy).toHaveBeenCalled();
    left.closed();
    expect(a.openGuests(undefined, 'user-x')).toBe(3);
    expect(a.openGuests('agent-two', 'user-x')).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(d.timedOut).not.toHaveBeenCalled();
    // The room went back: the next one may take it.
    expect(a.admitGuest('agent-two', 'user-x', door()).admitted).toBeDefined();
  });

  it("looks at each of the guest's consoles once, and at nobody else's: one pass", () => {
    const a = consoles();
    const looks: Array<{ connecting: number; lastActive: number }> = [];
    for (let i = 0; i < 3; i++) {
      const n = { connecting: 0, lastActive: 0 };
      looks.push(n);
      a.trackGuest(`agent-${i}`, 'user-x', () => {}, {
        connecting: () => { n.connecting++; return false; },
        lastActive: () => { n.lastActive++; return i; },
        evict: () => {},
      });
    }
    let others = 0;
    a.trackGuest('agent-0', 'user-y', () => {}, { connecting: () => { others++; return false; }, lastActive: () => { others++; return 0; } });
    expect(a.admitGuest('agent-3', 'user-x', door()).admitted).toBeDefined();
    expect(looks).toEqual([{ connecting: 1, lastActive: 1 }, { connecting: 1, lastActive: 1 }, { connecting: 1, lastActive: 1 }]);
    expect(others).toBe(0);
  });
});
