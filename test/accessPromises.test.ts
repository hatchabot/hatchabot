import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRoutes } from '../src/api/routes.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { expectedHandle, handleText, NAMES_NOBODY, normalizeHandle, Store } from '../src/store/store.js';
import { claimFirstContact, closeKnockWindow, holdDoorForKnocks, KnockWindowError } from '../src/orchestrator/members/claim.js';
import { grantChannelAccess, grantRoomAccess, inChannelConfigTurn, PRESS_WAIT_MS, setDmPolicy } from '../src/orchestrator/members/members.js';
import { forgetDmPolicy } from '../src/orchestrator/channels/dmPolicyMemo.js';
import type { Agent } from '../src/domain/types.js';

/**
 * Access promises the app makes, each checked against what enforces it
 * (2026-09-30): the Telegram invite's "wants to join" prompt, "Let them in
 * again" opening only the app they joined with, the Hatchabot agent never
 * taking members, and a newly admitted Slack/Discord person being let into
 * the rooms without a rebuild.
 */
const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };
// Made-up chat ids, built here rather than written as long literals.
const tgId = (n: number) => String(40_000 + n);
const discordId = (n: number) => '1' + String(n).padStart(17, '0');

/** A provider whose door writes answer as the script does on a volume that has this bot ("set"). */
function doorProvider(): MockProvider {
  const provider = new MockProvider();
  // The mock alone answers nothing, which is a write that failed.
  const onVolume = provider.execShellOnVolume.bind(provider);
  provider.execShellOnVolume = (async (ref: string, script: string, o?: { readOnly?: boolean }) => {
    const r = await onVolume(ref, script, o);
    return /"policy":"(allowlist|pairing)"/.test(script) && r.code === 0 && !r.stdout ? { ...r, stdout: 'set' } : r;
  }) as never;
  return provider;
}

async function world(opts: { ops?: boolean; secondHost?: MockProvider } = {}) {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  if (opts.secondHost) store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'local', provider: 'mock-there', name: 'other box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({
    id: 'a1', ownerId: OWNER, name: 'Tax', slug: 'a1', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', ...(opts.ops ? { ops: true } : {}),
  } as unknown as Agent);
  const provider = doorProvider();
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
  store.setAgentRuntimeRef('a1', runtimeRef);
  store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'TaxBot', secretRef: 's', deepLink: 'https://t.me/TaxBot', createdAt: 'now' } as never);
  // The owner is linked, so the door rests in allowlist.
  store.insertMembership({ id: 'm0', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' } as never);
  store.bindMembershipChannelUser('a1', OWNER, tgId(1));
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
    providers: new Map<string, MockProvider>([['mock', provider], ...(opts.secondHost ? [['mock-there', opts.secondHost] as [string, MockProvider]] : [])]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never,
  } as never);
  /** The pending requests the container's pairing store holds. */
  const knocks = (requests: Array<{ id: string; code: string; meta?: Record<string, string> }>) => {
    provider.execShell = (async () => ({ code: 0, stdout: JSON.stringify({ version: 1, requests }), stderr: '' })) as never;
  };
  const policies = (on: MockProvider = provider) => on.execLog
    .filter((c) => c[0] === 'sh-volume')
    .map((c) => /"policy":"(allowlist|pairing)"/.exec(c[1] ?? '')?.[1])
    .filter(Boolean);
  return { store, provider, f, knocks, policies };
}

describe('the Telegram invite opens a knock window when sent (finding 1)', () => {
  it('copying opens one 30-minute window: the named person is SHOWN, a stranger is not, and nobody is admitted without a tap', async () => {
    const w = await world();
    const inv = (await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload: { for: '@Maria_K' } })).json();
    expect(w.store.pairingWindows('a1')).toEqual([]); // minting alone opens nothing

    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/a1/invites/${inv.code}/knock-window`, headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ open: true, minutes: 30, for: 'maria_k' });
    const wins = w.store.pairingWindows('a1');
    expect(wins).toHaveLength(1);
    expect(wins[0]!.expect).toBe('maria_k');
    const mins = (Date.parse(wins[0]!.until) - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(29);
    expect(mins).toBeLessThanOrEqual(30);
    expect(w.policies()).toContain('pairing'); // the door answers while it stands

    // Pressing Copy again refreshes the same window, never a second one.
    await w.f.inject({ method: 'POST', url: `/v1/agents/a1/invites/${inv.code}/knock-window`, headers: H });
    expect(w.store.pairingWindows('a1')).toHaveLength(1);

    w.knocks([
      { id: tgId(9), code: 'STRANGER', meta: { username: 'randomer' } },
      { id: tgId(5), code: 'MARIA', meta: { username: 'maria_k', firstName: 'Maria' } },
    ]);
    const pending = (await w.f.inject({ method: 'GET', url: '/v1/agents/a1/pairing', headers: H })).json();
    expect(pending.map((p: { code: string }) => p.code)).toEqual(['MARIA']); // shown as wanting to join
    // Shown, not admitted: no approval ran and nobody new is a member.
    expect(w.provider.execLog.some((c) => c[0] === 'pairing' && c[1] === 'approve')).toBe(false);
    expect(w.store.listMemberships('a1').filter((m) => m.status === 'active')).toHaveLength(1);

    // The owner's tap lets her in, and the window has done its job.
    const ok = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/approve', headers: H, payload: { code: 'MARIA', kind: 'telegram' } });
    expect(ok.statusCode).toBe(200);
    expect(w.store.getActiveMembershipByChannelUser('a1', tgId(5))).toBeTruthy();
    expect(w.store.pairingWindows('a1')).toEqual([]);
    expect(w.policies().at(-1)).toBe('allowlist'); // back to silence
  });

  it('refuses a code of another agent, a web-chat invite, and an agent that is not running', async () => {
    const w = await world();
    const post = (code: string) => w.f.inject({ method: 'POST', url: `/v1/agents/a1/invites/${code}/knock-window`, headers: H });
    expect((await post('NOPE234567')).statusCode).toBe(404);
    w.store.insertInvite({ id: 'i-web', agentId: 'a1', code: 'WEBCHAT234', role: 'user', createdBy: OWNER, createdAt: 'now', expiresAt: new Date(Date.now() + 60_000).toISOString(), webChat: true });
    expect((await post('WEBCHAT234')).statusCode).toBe(404);
    const inv = (await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload: {} })).json();
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/a1/invites/${inv.code}/knock-window`, headers: { 'x-hatchabot-owner': 'someone-else' } })).statusCode).toBe(404);
    w.store.setAgentState('a1', 'STOPPED');
    expect((await post(inv.code)).statusCode).toBe(409);
    expect(w.store.pairingWindows('a1')).toEqual([]);
  });

  it('a door that could not be opened says so, and holds no window open (HB-0953)', async () => {
    const w = await world();
    const inv = (await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload: {} })).json();
    const post = () => w.f.inject({ method: 'POST', url: `/v1/agents/a1/invites/${inv.code}/knock-window`, headers: H });
    const write = w.provider.execShellOnVolume.bind(w.provider);
    let broken: { code: number; stdout: string } | undefined = { code: 1, stdout: '' };
    w.provider.execShellOnVolume = (async (ref: string, script: string, o?: { readOnly?: boolean }) =>
      broken && /"policy":"pairing"/.test(script) ? { ...broken, stderr: 'made-up docker error' } : write(ref, script, o)) as never;

    const failed = await post();
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe("Couldn't open the agent's door for their message just now — copy the invite again in a moment.");
    expect(w.store.pairingWindows('a1')).toEqual([]); // nothing said to be open, and the door rest is not held off
    broken = { code: 0, stdout: 'no-account' };
    expect((await post()).statusCode).toBe(409);
    expect(w.store.pairingWindows('a1')).toEqual([]);

    // Pressed again once Docker answers: open, as before.
    broken = undefined;
    expect((await post()).json()).toMatchObject({ open: true, minutes: 30 });
    const [win] = w.store.pairingWindows('a1');
    // A later press whose write fails leaves that earlier window as it was, not lengthened.
    forgetDmPolicy('a1');
    broken = { code: 1, stdout: '' };
    expect((await post()).statusCode).toBe(502);
    expect(w.store.pairingWindows('a1')).toEqual([win]);
  });

  it('two presses of one invite: the first one failing leaves the second one open (HB-0953)', async () => {
    const w = await world();
    const deps = { store: w.store, provider: w.provider };
    const runtimeRef = w.store.getAgent('a1')!.runtimeRef!;
    const write = w.provider.execShellOnVolume.bind(w.provider);
    // Each door write waits until the test says how it went.
    const held: Array<(r: { code: number; stdout: string }) => void> = [];
    w.provider.execShellOnVolume = (async (ref: string, script: string, o?: { readOnly?: boolean }) =>
      /"policy":"pairing"/.test(script)
        ? new Promise((done) => held.push((r) => done({ ...r, stderr: '' })))
        : write(ref, script, o)) as never;
    const press = () => holdDoorForKnocks(deps, { agentId: 'a1', runtimeRef, accountId: 'TaxBot', key: 'inv-1', noTimer: true })
      .then((r) => r, (e: unknown) => e as Error);
    const writes = async (n: number) => { while (held.length < n) await new Promise((r) => setImmediate(r)); };

    // B opens while A's write is under way, and so reads A's window as its before.
    const a = press(); await writes(1);
    const b = press();
    // B's write waits for A's to land: the two are never on the volume at once (HB-1554).
    await new Promise((r) => setTimeout(r, 20));
    expect(held).toHaveLength(1);
    held[0]!({ code: 1, stdout: '' });
    expect(await a).toBeInstanceOf(KnockWindowError);
    await writes(2);
    held[1]!({ code: 0, stdout: 'set' });
    const opened = await b;
    expect(opened).toMatchObject({ seat: expect.any(String) });
    const [win] = w.store.pairingWindows('a1');
    expect(win).toMatchObject({ until: (opened as { until: string }).until }); // B's window, as B said: A, failing, left it
  });

  describe('a window a failed press puts back closes at its own time (HB-0953)', () => {
    const rig = async () => {
      forgetDmPolicy('a1');
      const w = await world();
      const deps = { store: w.store, provider: w.provider };
      const runtimeRef = w.store.getAgent('a1')!.runtimeRef!;
      const write = w.provider.execShellOnVolume.bind(w.provider);
      // Each door write that opens waits until the test says how it went.
      const held: Array<(r: { code: number; stdout: string }) => void> = [];
      w.provider.execShellOnVolume = (async (ref: string, script: string, o?: { readOnly?: boolean }) =>
        /"policy":"pairing"/.test(script)
          ? new Promise((done) => held.push((r) => done({ ...r, stderr: '' })))
          : write(ref, script, o)) as never;
      const press = (timeoutMs?: number) => (forgetDmPolicy('a1'), holdDoorForKnocks)(deps, { agentId: 'a1', runtimeRef, accountId: 'TaxBot', key: 'inv-1', ...(timeoutMs ? { timeoutMs } : {}) })
        .then((r) => r, (e: unknown) => e as Error);
      const writes = async (n: number) => { while (held.length < n) await new Promise((r) => setImmediate(r)); };
      const rows = () => w.store.pairingWindows('a1', new Date(0));
      return { w, press, held, writes, rows };
    };
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('both presses fail, the earlier first: the window put back closes when it ends, and the door rests', async () => {
      const { w, press, held, writes, rows } = await rig();
      const a = press(300); await writes(1);
      const b = press(30 * 60_000);
      held[0]!({ code: 1, stdout: '' });
      expect(await a).toBeInstanceOf(KnockWindowError);
      await writes(2); // B's write, once A's has landed (HB-1554)
      held[1]!({ code: 1, stdout: '' });
      expect(await b).toBeInstanceOf(KnockWindowError);
      expect(rows()).toHaveLength(1); // A's, put back by B, for A's time
      await wait(1000);
      expect(rows()).toEqual([]);
      expect(w.policies().at(-1)).toBe('allowlist');
    });

    it('a window put back has two timers, its own and the first press\'s: the door is put back to rest once, not twice (HB-1365)', async () => {
      const { w, press, held, writes, rows } = await rig();
      const first = press(300); await writes(1);
      held[0]!({ code: 0, stdout: 'set' });
      expect(await first).toMatchObject({ seat: expect.any(String) });
      const later = press(30 * 60_000); await writes(2);
      held[1]!({ code: 1, stdout: '' });
      expect(await later).toBeInstanceOf(KnockWindowError);
      expect(rows()).toHaveLength(1); // the first press's window, put back with a close of its own
      await wait(1500);
      expect(rows()).toEqual([]);
      // Was: two writes back to rest, the second one's only use to land after whatever came next.
      expect(w.policies().filter((p) => p === 'allowlist')).toEqual(['allowlist']);
    });

    it("an earlier window's timer stood down for a later press that then failed: its spent window is closed, not put back", async () => {
      const { w, press, held, writes, rows } = await rig();
      const first = press(300); await writes(1);
      held[0]!({ code: 0, stdout: 'set' });
      expect(await first).toMatchObject({ seat: expect.any(String) });
      const later = press(30 * 60_000); await writes(2);
      await wait(1100); // the first press's timer fires now, sees the later window, and stands down
      held[1]!({ code: 1, stdout: '' });
      expect(await later).toBeInstanceOf(KnockWindowError);
      expect(rows()).toEqual([]);
      expect(w.policies().at(-1)).toBe('allowlist'); // the first press's open door is put back to rest
    });
  });

  it('letting a knock in when its requests cannot be read says so, not that it is gone (HB-1050)', async () => {
    const w = await world();
    w.provider.execShell = (async () => ({ code: 1, stdout: '', stderr: 'docker exec: connection reset' })) as never;
    const r = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/approve', headers: H, payload: { code: 'MARIA', kind: 'telegram' } });
    expect([r.statusCode, r.json().error]).toEqual([502, "Couldn't read the requests waiting at the agent's door just now — try again in a moment."]);
    expect(w.store.listMemberships('a1').filter((m) => m.status === 'active')).toHaveLength(1);
  });

  it('a plain approve on an agent with two apps whose Discord cannot be read says so, not "no longer pending" (HB-1050)', async () => {
    const w = await world();
    w.store.insertChannel({ id: 'c2', agentId: 'a1', kind: 'discord', accountId: '123456789012345678', secretRef: 's2', deepLink: 'https://discord.com/users/x', createdAt: 'now' } as never);
    w.provider.execShell = (async (_ref: string, script: string) => script.includes('discord-pairing.json')
      ? { code: 1, stdout: '', stderr: 'docker exec: connection reset' }
      : { code: 0, stdout: JSON.stringify({ version: 1, requests: [] }), stderr: '' }) as never;
    for (const url of ['/v1/agents/a1/pairing/approve', '/v1/agents/a1/pairing/deny']) {
      const r = await w.f.inject({ method: 'POST', url, headers: H, payload: { code: 'DSC1' } });
      expect([r.statusCode, r.json().error]).toEqual([502, "Couldn't read the requests waiting at the agent's door just now — try again in a moment."]);
    }
  });

  it('closes itself on time and puts the door back to silence', async () => {
    const w = await world();
    const deps = { store: w.store, provider: w.provider };
    const { seat } = await holdDoorForKnocks(deps, { agentId: 'a1', runtimeRef: w.store.getAgent('a1')!.runtimeRef!, accountId: 'TaxBot', key: 'inv-1', noTimer: true });
    expect(w.store.pairingWindows('a1').map((x) => x.seat)).toEqual([seat]);
    await closeKnockWindow(deps, 'a1', seat);
    expect(w.store.pairingWindows('a1')).toEqual([]);
    expect(w.policies()).toEqual(['pairing', 'allowlist']);
  });

  it('Copy pressed again while its window closes: the door ends open, for the window that press opened (HB-1372)', async () => {
    // The press's write now waits for the close's (HB-1554); the close's look again (doorAsItIs) stays as
    // defence in depth, for two processes overlapping at a deploy.
    forgetDmPolicy('a1');
    const w = await world();
    const deps = { store: w.store, provider: w.provider };
    const runtimeRef = w.store.getAgent('a1')!.runtimeRef!;
    const write = w.provider.execShellOnVolume.bind(w.provider);
    // The door as the volume has it: the last write to land. The close's write back to rest is held until the test lets it go.
    let door: string | undefined;
    let resting = false;
    let letRestLand: () => void = () => {};
    const restHeld = new Promise<void>((r) => { letRestLand = r; });
    w.provider.execShellOnVolume = (async (ref: string, script: string, o?: { readOnly?: boolean }) => {
      const policy = /"policy":"(allowlist|pairing)"/.exec(script)?.[1];
      if (policy === 'allowlist' && !resting) { resting = true; await restHeld; }
      const r = await write(ref, script, o);
      if (policy) door = policy;
      return r;
    }) as never;
    const press = () => holdDoorForKnocks(deps, { agentId: 'a1', runtimeRef, accountId: 'TaxBot', key: 'inv-1', noTimer: true });
    const { seat } = await press();
    expect(door).toBe('pairing');
    // Its half hour is up: the close finds no other window and writes the door back to rest; Copy is pressed during that write.
    const closing = closeKnockWindow(deps, 'a1', seat);
    while (!resting) await new Promise((r) => setImmediate(r));
    // Its window is opened at once; its write of the door waits for the close's (HB-1554).
    const again = press();
    await new Promise((r) => setTimeout(r, 20));
    expect(w.store.pairingWindows('a1').map((x) => x.seat)).toEqual([seat]);
    letRestLand();
    await again;
    await closing;
    expect(w.store.pairingWindows('a1').map((x) => x.seat)).toEqual([seat]);
    // Was: the close's write landed last, and the door stood shut with the press's window open for its half hour.
    expect(door).toBe('pairing');
  });

  it('a close whose agent changes during its write: stopped, rebuilt or moved, the door is not opened again; opened to anyone, it is (HB-1372 review)', async () => {
    for (const change of ['stopped', 'rebuilt', 'moved', 'open to anyone'] as const) {
      forgetDmPolicy('a1');
      const w = await world({ secondHost: doorProvider() });
      const deps = { store: w.store, provider: w.provider };
      const runtimeRef = w.store.getAgent('a1')!.runtimeRef!;
      const write = w.provider.execShellOnVolume.bind(w.provider);
      // The door as the volume has it, and each write as it lands; the close's write back to rest is held.
      let door: string | undefined;
      const landed: string[] = [];
      let resting = false;
      let letRestLand: () => void = () => {};
      const restHeld = new Promise<void>((r) => { letRestLand = r; });
      w.provider.execShellOnVolume = (async (ref: string, script: string, o?: { readOnly?: boolean }) => {
        const policy = /"policy":"(allowlist|pairing)"/.exec(script)?.[1];
        if (policy === 'allowlist' && !resting) { resting = true; await restHeld; }
        const r = await write(ref, script, o);
        if (policy) { door = policy; landed.push(policy); }
        return r;
      }) as never;
      const { seat } = await holdDoorForKnocks(deps, { agentId: 'a1', runtimeRef, accountId: 'TaxBot', key: 'inv-1', noTimer: true });
      const closing = closeKnockWindow(deps, 'a1', seat);
      while (!resting) await new Promise((r) => setImmediate(r));
      const before = landed.length;
      // Each write of the door asked for meanwhile waits for the close's to land (HB-1554).
      let opening: Promise<unknown>;
      if (change === 'open to anyone') {
        // Allow knocks turned on: the route writes every door open.
        w.store.setAllowKnocks('a1', true);
        forgetDmPolicy('a1');
        opening = setDmPolicy(deps, { agentId: 'a1', runtimeRef, kind: 'telegram', accountId: 'TaxBot', policy: 'pairing' });
      } else {
        // Copy is pressed again, its window opened and its door write asked for; then the agent changes under the close.
        opening = holdDoorForKnocks(deps, { agentId: 'a1', runtimeRef, accountId: 'TaxBot', key: 'inv-1', noTimer: true });
        await new Promise((r) => setTimeout(r, 5));
        if (change === 'stopped') w.store.setAgentState('a1', 'STOPPED');
        else if (change === 'rebuilt') w.store.setAgentRuntimeRef('a1', 'made-up-new-container');
        else w.store.setAgentHost('a1', 'h2');
      }
      letRestLand();
      await closing;
      await opening;
      if (change === 'open to anyone') {
        // Was: the close's write landed last and the door stayed shut, though anyone may knock (the sweep leaves such an agent alone).
        // The close's rest lands first now, then the route's write of the door open (and the close's own, on looking again).
        expect(landed.slice(before, before + 2), change).toEqual(['allowlist', 'pairing']);
        expect(door).toBe('pairing');
      } else {
        // The close, then the press's own write: the close opens nothing again on a container it no longer runs on
        // (its next start or build writes the door).
        expect(landed.slice(before), change).toEqual(['allowlist', 'pairing']);
      }
    }
  });

  it('a window whose agent moved to another machine meanwhile puts the door back to rest there, not on the old machine (HB-0649)', async () => {
    const there = doorProvider();
    const w = await world({ secondHost: there });
    const inv = (await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload: {} })).json();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      expect((await w.f.inject({ method: 'POST', url: `/v1/agents/a1/invites/${inv.code}/knock-window`, headers: H })).statusCode).toBe(200);
      // Moved, and up on the other machine with a container of its own.
      const { runtimeRef } = await there.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
      w.store.setAgentHost('a1', 'h2');
      w.store.setAgentRuntimeRef('a1', runtimeRef);
      const here = w.policies().length;
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(w.store.pairingWindows('a1')).toEqual([]);
      expect(w.policies().slice(here)).toEqual([]); // nothing more on the old machine
      expect(w.policies(there)).toEqual(['allowlist']); // the door there is put back to rest
    } finally { vi.useRealTimers(); }
  });
});

describe('every write of the door to rest looks again once it lands (HB-1521)', () => {
  // Since HB-1554 the door's writes on one agent take turns, so a press no
  // longer lands in the middle of another's write in one process: these
  // drive the press during the held write, and its write waits. The look
  // again (doorAsItIs) stays, as defence in depth: two processes overlap for
  // a moment at a deploy, each with turns of its own.
  /**
   * The door as the volume has it (the last write to land), and each write as
   * it lands; the first write that `hold` names is held until the test lets
   * it go (a slow volume), so a press can land in the middle of it.
   */
  function heldDoor(w: Awaited<ReturnType<typeof world>>, hold: (policy: string) => boolean) {
    const write = w.provider.execShellOnVolume.bind(w.provider);
    const v = { door: undefined as string | undefined, landed: [] as string[], held: false, letGo: () => {} };
    const gate = new Promise<void>((r) => { v.letGo = r; });
    w.provider.execShellOnVolume = (async (ref: string, script: string, o?: { readOnly?: boolean }) => {
      const policy = /"policy":"(allowlist|pairing)"/.exec(script)?.[1];
      if (policy && !v.held && hold(policy)) { v.held = true; await gate; }
      const r = await write(ref, script, o);
      if (policy) { v.door = policy; v.landed.push(policy); }
      return r;
    }) as never;
    return v;
  }
  const until = async (cond: () => boolean) => { while (!cond()) await new Promise((r) => setImmediate(r)); };

  it("a first-message window's end: Copy pressed while its door is put back to rest leaves the door open for that press's window", async () => {
    forgetDmPolicy('a1');
    const w = await world();
    const deps = { store: w.store, provider: w.provider };
    const runtimeRef = w.store.getAgent('a1')!.runtimeRef!;
    w.knocks([]);
    const v = heldDoor(w, (p) => p === 'allowlist');
    // An invitee's window that nobody answers: it ends, and its door is put back to rest.
    w.store.insertMembership({ id: 'm9', agentId: 'a1', userId: 'member-invitee', role: 'user', status: 'active', displayName: 'Invitee' } as never);
    const watching = claimFirstContact({ store: w.store, provider: w.provider, sleep: async () => {} }, { agentId: 'a1', runtimeRef, accountId: 'TaxBot', forUserId: 'member-invitee', timeoutMs: 5 });
    await until(() => v.held);
    // Its window opens at once; its write of the door waits for the rest's (HB-1554).
    const pressing = holdDoorForKnocks(deps, { agentId: 'a1', runtimeRef, accountId: 'TaxBot', key: 'inv-1', noTimer: true });
    await new Promise((r) => setTimeout(r, 20));
    v.letGo();
    const { seat } = await pressing;
    expect(await watching).toBeNull();
    expect(w.store.pairingWindows('a1').map((x) => x.seat)).toEqual([seat]);
    // Was: the rest landed last, and the door stood shut with the press's window open for its half hour.
    expect(v.door).toBe('pairing');
  });

  it('the rest that Allow knocks turned off makes: Copy pressed during it leaves the door open for that press\'s window', async () => {
    forgetDmPolicy('a1');
    const w = await world();
    const deps = { store: w.store, provider: w.provider };
    const runtimeRef = w.store.getAgent('a1')!.runtimeRef!;
    w.store.setAllowKnocks('a1', true);
    const v = heldDoor(w, (p) => p === 'allowlist');
    const off = w.f.inject({ method: 'POST', url: '/v1/agents/a1/allow-knocks', headers: H, payload: { on: false } });
    await until(() => v.held);
    const pressing = holdDoorForKnocks(deps, { agentId: 'a1', runtimeRef, accountId: 'TaxBot', key: 'inv-1', noTimer: true });
    await new Promise((r) => setTimeout(r, 20));
    v.letGo();
    const { seat } = await pressing;
    expect((await off).json()).toEqual({ allowKnocks: false });
    expect(w.store.pairingWindows('a1').map((x) => x.seat)).toEqual([seat]);
    // Was: the rest (restDoor) landed last, the door shut.
    expect(v.door).toBe('pairing');
  });

  it("a knock window's close that opens the door again for another press: that press's window closing meanwhile leaves the door at rest", async () => {
    forgetDmPolicy('a1');
    const w = await world();
    const deps = { store: w.store, provider: w.provider };
    const runtimeRef = w.store.getAgent('a1')!.runtimeRef!;
    const press = (key: string) => holdDoorForKnocks(deps, { agentId: 'a1', runtimeRef, accountId: 'TaxBot', key, noTimer: true });
    const first = await press('inv-1');
    // The close's write to rest is held; a second invite's Copy lands during it.
    let v = heldDoor(w, (p) => p === 'allowlist');
    const closing = closeKnockWindow(deps, 'a1', first.seat);
    await until(() => v.held);
    // Its window opens at once; its write of the door waits for the close's (HB-1554).
    const pressing = press('inv-2');
    await new Promise((r) => setTimeout(r, 20));
    const secondSeat = w.store.pairingWindows('a1')[0]!.seat;
    // Now the next write of the door open is held, and the second press's window closes during it.
    const resting = v;
    v = heldDoor(w, (p) => p === 'pairing');
    resting.letGo();
    await until(() => v.held);
    const closingSecond = closeKnockWindow(deps, 'a1', secondSeat);
    v.letGo();
    expect(await pressing).toMatchObject({ seat: secondSeat });
    await closingSecond;
    await closing;
    expect(w.store.pairingWindows('a1')).toEqual([]);
    // Was: the close's write of the door open landed last, and it stood in pairing with no window until the next sweep.
    expect(v.door).toBe('allowlist');
  });

  it('Allow knocks turned on, then off while its write of the door open is slow: the door is put back to rest once that write lands (HB-1521 review)', async () => {
    forgetDmPolicy('a1');
    const w = await world();
    const v = heldDoor(w, (p) => p === 'pairing');
    const on = w.f.inject({ method: 'POST', url: '/v1/agents/a1/allow-knocks', headers: H, payload: { on: true } });
    await until(() => v.held);
    // Turned off during it: its rest waits for that write to land (HB-1554).
    const off = w.f.inject({ method: 'POST', url: '/v1/agents/a1/allow-knocks', headers: H, payload: { on: false } });
    await new Promise((r) => setTimeout(r, 20));
    v.letGo();
    expect((await off).json()).toEqual({ allowKnocks: false });
    expect((await on).json()).toEqual({ allowKnocks: true });
    expect(w.store.getAgent('a1')?.allowKnocks).toBe(false);
    expect(w.store.pairingWindows('a1')).toEqual([]);
    // Was: the write of the door open landed last, and it stood in pairing, Allow knocks off and no window, until the next sweep.
    expect(v.door).toBe('allowlist');
  });

  it('Copy pressed while another write of its door is slow: refused after half a minute, in words, and no window is left open (HB-1554)', async () => {
    forgetDmPolicy('a1');
    const w = await world();
    const runtimeRef = w.store.getAgent('a1')!.runtimeRef!;
    const inv = (await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload: {} })).json();
    // A rest of the door, on a machine that answers slowly.
    const v = heldDoor(w, (p) => p === 'allowlist');
    const slow = setDmPolicy({ store: w.store, provider: w.provider }, { agentId: 'a1', runtimeRef, kind: 'telegram', accountId: 'TaxBot', policy: 'allowlist', allowFrom: [tgId(1)] });
    await until(() => v.held);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let res: Awaited<ReturnType<typeof w.f.inject>>;
    try {
      let answered: typeof res | undefined;
      const pressed = w.f.inject({ method: 'POST', url: `/v1/agents/a1/invites/${inv.code}/knock-window`, headers: H }).then((r) => { answered = r; return r; });
      for (let s = 0; s < PRESS_WAIT_MS / 1000 + 5 && !answered; s++) {
        await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(1000);
      }
      // Was: it waited as long as the write ahead took, the button pressed and nothing said.
      expect(answered).toBeDefined();
      res = await pressed;
    } finally { vi.useRealTimers(); }
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Another change to Tax's chat apps is still being written: try again in a minute." });
    expect(w.store.pairingWindows('a1')).toEqual([]);
    v.letGo();
    await slow;
    expect(v.landed).toEqual(['allowlist']);
  });

  it('Allow knocks turned off during a slow change, then on again: the rest left waiting does not shut the door once it is on (HB-1554 review)', async () => {
    forgetDmPolicy('a1');
    const w = await world();
    w.store.setAllowKnocks('a1', true);
    const landed: string[] = [];
    const write = w.provider.execShellOnVolume.bind(w.provider);
    w.provider.execShellOnVolume = (async (ref: string, script: string, o?: { readOnly?: boolean }) => {
      const policy = /"policy":"(allowlist|pairing)"/.exec(script)?.[1];
      const r = await write(ref, script, o);
      if (policy) landed.push(policy);
      return r;
    }) as never;
    // A slow change to its chat apps (a removal on a machine that answers slowly).
    let letSlowGo!: () => void;
    const slow = inChannelConfigTurn(w.store, 'a1', () => new Promise<void>((r) => { letSlowGo = r; }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let off: Awaited<ReturnType<typeof w.f.inject>>;
    try {
      let answered: typeof off | undefined;
      const pressed = w.f.inject({ method: 'POST', url: '/v1/agents/a1/allow-knocks', headers: H, payload: { on: false } }).then((r) => { answered = r; return r; });
      for (let s = 0; s < PRESS_WAIT_MS / 1000 + 5 && !answered; s++) {
        await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(answered).toBeDefined();
      off = await pressed;
    } finally { vi.useRealTimers(); }
    expect(off.json()).toEqual({ allowKnocks: false });
    // On again, while off's rest still waits behind the slow change.
    const on = w.f.inject({ method: 'POST', url: '/v1/agents/a1/allow-knocks', headers: H, payload: { on: true } });
    await new Promise((r) => setTimeout(r, 20));
    letSlowGo();
    await slow;
    expect((await on).json()).toEqual({ allowKnocks: true });
    await until(() => landed.includes('pairing'));
    await new Promise((r) => setTimeout(r, 30));
    // Was: the rest, asked for while it was off, shut the door though it was on by then; only its look again opened
    // it, and when that write failed Allow knocks showed on with the door shut.
    expect(landed).toEqual(['pairing']);
  });

  it("Allow knocks turned on, its look again once its write lands stuck behind a slow change: the press is answered within half a minute, and the look again lands after (HB-1554)", async () => {
    forgetDmPolicy('a1');
    const w = await world();
    const v = heldDoor(w, (p) => p === 'pairing');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let res: Awaited<ReturnType<typeof w.f.inject>>;
    let letSlowGo!: () => void;
    let slow!: Promise<void>;
    try {
      let answered: typeof res | undefined;
      const pressed = w.f.inject({ method: 'POST', url: '/v1/agents/a1/allow-knocks', headers: H, payload: { on: true } }).then((r) => { answered = r; return r; });
      await until(() => v.held);
      // A slow change to its chat apps asked for meanwhile (a removal on a machine that answers slowly), and Allow
      // knocks turned off again by the time the door's write lands: its look again must write the door back to rest.
      slow = inChannelConfigTurn(w.store, 'a1', () => new Promise<void>((r) => { letSlowGo = r; }));
      w.store.setAllowKnocks('a1', false);
      v.letGo();
      for (let s = 0; s < PRESS_WAIT_MS / 1000 + 5 && !answered; s++) {
        await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(1000);
      }
      // Was: the look again waited behind the slow change as long as it took, and the press with it.
      expect(answered).toBeDefined();
      res = await pressed;
    } finally { vi.useRealTimers(); }
    expect(res.json()).toEqual({ allowKnocks: true });
    expect(v.door).toBe('pairing');
    letSlowGo();
    await slow;
    // Gone on by itself: the door at rest once the slow change is done.
    await until(() => v.door === 'allowlist');
    expect(v.landed).toEqual(['pairing', 'allowlist']);
  });

  it('Allow knocks pressed while another write of its door is slow: on is refused after half a minute, in words, and put back; off is answered, and the door shuts once that write lands (HB-1554)', async () => {
    for (const press of ['on', 'off'] as const) {
      forgetDmPolicy('a1');
      const w = await world();
      const runtimeRef = w.store.getAgent('a1')!.runtimeRef!;
      if (press === 'off') w.store.setAllowKnocks('a1', true);
      // A window's write of the door open, on a machine that answers slowly.
      const v = heldDoor(w, (p) => p === 'pairing');
      const slow = setDmPolicy({ store: w.store, provider: w.provider }, { agentId: 'a1', runtimeRef, kind: 'telegram', accountId: 'TaxBot', policy: 'pairing' });
      await until(() => v.held);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let res: Awaited<ReturnType<typeof w.f.inject>>;
      try {
        let answered: typeof res | undefined;
        const pressed = w.f.inject({ method: 'POST', url: '/v1/agents/a1/allow-knocks', headers: H, payload: { on: press === 'on' } }).then((r) => { answered = r; return r; });
        // Half a minute and a little, a second at a time: the press reaches its wait in its own time.
        for (let s = 0; s < PRESS_WAIT_MS / 1000 + 5 && !answered; s++) {
          await new Promise((r) => setImmediate(r));
          await vi.advanceTimersByTimeAsync(1000);
        }
        // Was: it waited as long as the write ahead took, the button pressed and nothing said.
        expect(answered, press).toBeDefined();
        res = await pressed;
      } finally { vi.useRealTimers(); }
      if (press === 'on') {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ allowKnocks: false, error: "Another change to Tax's chat apps is still being written: try again in a minute. It stays invite only." });
        expect(w.store.getAgent('a1')?.allowKnocks).toBe(false);
      } else {
        expect(res.json()).toEqual({ allowKnocks: false });
      }
      v.letGo();
      await slow;
      // The rest left waiting on its own lands after it: the door ends at rest either way.
      await until(() => v.door === 'allowlist');
      expect(v.landed, press).toEqual(['pairing', 'allowlist']);
    }
  });
});

describe('"Let them in again" opens only the app they joined with (finding 3)', () => {
  async function withDiscord() {
    const w = await world();
    w.store.insertChannel({ id: 'c2', agentId: 'a1', kind: 'discord', accountId: '123456789012345678', secretRef: 's2', deepLink: 'https://discord.com/users/x', createdAt: 'now' } as never);
    return w;
  }

  it('joined on Telegram: reopens Telegram, not Discord', async () => {
    const w = await withDiscord();
    const inv = (await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload: {} })).json();
    const join = await w.f.inject({ method: 'POST', url: '/v1/join', payload: { code: inv.code, name: 'Maria', channel: 'telegram' } });
    expect(join.statusCode).toBe(201);
    const member = w.store.listMemberships('a1').find((m) => m.displayName === 'Maria')!;
    w.store.closePairingWindow('a1'); // the join's own window lapsed
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/a1/members/${member.userId}/reopen`, headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.json().on).toEqual(['telegram']);
    await new Promise((res) => setTimeout(res, 20)); // the detached claim opens its window
    expect(w.store.pairingWindows('a1').map((x) => x.seat)).toEqual([`telegram:${member.userId}`]);
    w.store.closePairingWindow('a1');
  });

  it('the members list names the handle their invite named, the one a door is then for (invitedAs, HB-1439 review)', async () => {
    const w = await withDiscord();
    const inv = (await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload: { for: 'https://t.me/Maria_K' } })).json();
    expect((await w.f.inject({ method: 'POST', url: '/v1/join', payload: { code: inv.code, name: 'Maria', channel: 'telegram' } })).statusCode).toBe(201);
    const open = (await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload: {} })).json();
    expect((await w.f.inject({ method: 'POST', url: '/v1/join', payload: { code: open.code, name: 'Sam', channel: 'telegram' } })).statusCode).toBe(201);
    w.store.closePairingWindow('a1');
    const rows = (await w.f.inject({ method: 'GET', url: '/v1/agents/a1/members', headers: H })).json() as Array<{ displayName?: string; invitedAs?: string }>;
    expect(Object.fromEntries(rows.filter((m) => m.displayName).map((m) => [m.displayName, m.invitedAs ?? null]))).toEqual({ Maria: 'maria_k', Sam: null });
    const maria = w.store.listMemberships('a1').find((m) => m.displayName === 'Maria')!;
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/a1/members/${maria.userId}/reopen`, headers: H, payload: {} });
    expect([r.statusCode, r.json().for]).toEqual([200, 'maria_k']);
    w.store.closePairingWindow('a1');
  });

  it('refused while their removal scrubs: no window opens for them, and nothing lets them into the rooms (HB-1522 review)', async () => {
    const w = await withDiscord();
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'member-sam', role: 'user', status: 'active', displayName: 'Sam' } as never);
    w.store.bindMembershipChannelUser('a1', 'member-sam', tgId(2));
    // The removal's scrub is held: their seat is still active while it runs.
    const onVolume = w.provider.execShellOnVolume.bind(w.provider);
    let letScrubGo!: () => void;
    const held = new Promise<void>((r) => { letScrubGo = r; });
    let scrubbing = false;
    const grants: string[] = [];
    w.provider.execShellOnVolume = (async (ref: string, script: string, o?: { readOnly?: boolean }) => {
      if (script.includes('r.users.push(t.id)')) grants.push(script);
      if (script.includes('-allowFrom.json') && !scrubbing) { scrubbing = true; await held; }
      return onVolume(ref, script, o);
    }) as never;
    const removing = w.f.inject({ method: 'DELETE', url: '/v1/agents/a1/members/member-sam', headers: H });
    while (!scrubbing) await new Promise((r) => setImmediate(r));
    // "Let them in again", pressed during it.
    w.knocks([{ id: '100000000000000042', code: 'DSCCODE1' }]);
    const r = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/members/member-sam/reopen', headers: H, payload: { handle: '@sam_made_up' } });
    // Was: a Discord window opened, their message bound and let into the rooms after the scrub had read its list.
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('Another operation is already running on this agent.');
    await new Promise((res) => setTimeout(res, 20));
    expect(w.store.pairingWindows('a1')).toEqual([]);
    letScrubGo();
    expect((await removing).statusCode).toBe(200);
    expect(w.store.getMembership('a1', 'member-sam')?.status).toBe('revoked');
    expect(grants).toEqual([]);
    expect(w.provider.execLog.some((x) => x.join(' ').startsWith('pairing approve'))).toBe(false);
  });

  it('app never recorded: refuses without a handle, and with one narrows every window to it', async () => {
    const w = await withDiscord();
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'member-old', role: 'user', status: 'active', displayName: 'Old' } as never);
    const url = '/v1/agents/a1/members/member-old/reopen';
    const bare = await w.f.inject({ method: 'POST', url, headers: H, payload: {} });
    expect(bare.statusCode).toBe(409);
    expect(bare.json().code).toBe('needs-handle');
    expect(w.store.pairingWindows('a1')).toEqual([]);
    const named = await w.f.inject({ method: 'POST', url, headers: H, payload: { handle: '@Old_One' } });
    expect(named.statusCode).toBe(200);
    expect(named.json().for).toBe('Old_One');
    await new Promise((res) => setTimeout(res, 20));
    const wins = w.store.pairingWindows('a1');
    expect(wins.length).toBe(2);
    expect(wins.every((x) => x.expect === 'old_one')).toBe(true);
    w.store.closePairingWindow('a1');
  });

  it('refuses a handle it cannot use, in words, and opens nothing: it was dropped and the door opened to anyone (HB-1439 review)', async () => {
    const w = await withDiscord();
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'member-old', role: 'user', status: 'active', displayName: 'Old' } as never);
    const url = '/v1/agents/a1/members/member-old/reopen';
    const NOT_A_HANDLE = 'That is not an @handle: give theirs (no more than 64 characters after the @), or leave it empty.';
    for (const handle of [`@${'a'.repeat(65)}`, '@', ' @ ', 't.me/', 'https://t.me/@', 42, ['@old_one'], { at: 'old_one' }]) {
      const r = await w.f.inject({ method: 'POST', url, headers: H, payload: { handle } });
      expect([r.statusCode, r.json().error], JSON.stringify(handle)).toEqual([400, NOT_A_HANDLE]);
    }
    await new Promise((res) => setTimeout(res, 20));
    expect(w.store.pairingWindows('a1')).toEqual([]);
    // Empty, null or left out: no handle, as always (here, asked for one).
    for (const payload of [{}, { handle: '' }, { handle: '   ' }, { handle: null }]) {
      const r = await w.f.inject({ method: 'POST', url, headers: H, payload });
      expect([r.statusCode, r.json().code], JSON.stringify(payload)).toEqual([409, 'needs-handle']);
    }
    // 64 after the @ is one, and a t.me link is its name.
    const longest = await w.f.inject({ method: 'POST', url, headers: H, payload: { handle: `@${'b'.repeat(64)}` } });
    expect([longest.statusCode, longest.json().for]).toEqual([200, 'b'.repeat(64)]);
    w.store.closePairingWindow('a1');
    const linked = await w.f.inject({ method: 'POST', url, headers: H, payload: { handle: ' https://t.me/Old_One ' } });
    expect([linked.statusCode, linked.json().for]).toEqual([200, 'Old_One']);
    await new Promise((res) => setTimeout(res, 20));
    expect(w.store.pairingWindows('a1').map((x) => x.expect)).toEqual(['old_one', 'old_one']);
    w.store.closePairingWindow('a1');
  });
});

/** Names a sender may have (on Slack and Discord their name is free text) that a NAMES_NOBODY door must never match. */
const NOBODY_NAMES_ALL = ['#nobody/', '#NOBODY/', '@#nobody/', '@@', '@', ' @ @ ', '@ @ @', '@@@x', 't.me/', 'https://t.me/@', '@ t.me/@@'];

describe('an invite for a handle: refused when it is none, kept as it is matched (HB-1439 review, round 2)', () => {
  const NOT_A_HANDLE = 'That is not an @handle: give theirs (no more than 64 characters after the @), or leave it empty.';
  const make = (w: Awaited<ReturnType<typeof world>>, payload: Record<string, unknown>) =>
    w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload });

  it('a for that names nobody is a 400, never an invite for anyone: it was kept as none, and its window was anyone\'s', async () => {
    const w = await world();
    for (const handle of ['@', ' @ ', '@@', 't.me/', 'https://t.me/', 'https://t.me/@', 'https://www.t.me/', 'telegram.me/?start=x', `@${'m'.repeat(65)}`, `https://t.me/${'m'.repeat(65)}`]) {
      const r = await make(w, { for: handle });
      expect([r.statusCode, r.json().error], JSON.stringify(handle)).toEqual([400, NOT_A_HANDLE]);
    }
    expect((w.store as unknown as { db: Database.Database }).db.prepare('SELECT COUNT(*) n FROM invites').get()).toEqual({ n: 0 });
    // None: an invite for anyone, as always, and it says it is for nobody named.
    for (const payload of [{}, { for: '' }, { for: '  ' }, { for: null }]) {
      const r = await make(w, payload);
      expect([r.statusCode, 'for' in r.json()], JSON.stringify(payload)).toEqual([201, false]);
    }
  });

  it('kept as it is matched, and answered so: the name in a link (64 of it, though the link is longer), with one @ or two', async () => {
    const w = await world();
    const long = 'm'.repeat(64);
    for (const [given, kept] of [['@@Maria_K', 'maria_k'], ['https://t.me/Maria_K/', 'maria_k'], ['t.me/maria_k?start=x', 'maria_k'], ['telegram.me/@maria_k#top', 'maria_k'], [`https://t.me/${long}`, long]] as const) {
      const r = await make(w, { for: given });
      expect([r.statusCode, r.json().for], given).toEqual([201, kept]);
      const knock = await w.f.inject({ method: 'POST', url: `/v1/agents/a1/invites/${r.json().code}/knock-window`, headers: H });
      expect([knock.json().for, w.store.pairingWindows('a1').map((x) => x.expect)], given).toEqual([kept, [kept]]);
      w.store.closePairingWindow('a1');
    }
  });

  /** Senders whose names a NAMES_NOBODY door was once matched by, or could be (HB-1439 review): none is let in or shown. */
  const NOBODY_NAMES = ['#nobody/', '#NOBODY/', '@#nobody/', '@@', '@', ' @ @ ', '@ @ @', 't.me/', 'https://t.me/@', NAMES_NOBODY];

  it('a handle an older release kept as typed: a bare link names nobody (never anyone), a link with a name is that name', async () => {
    const w = await world();
    const db = (w.store as unknown as { db: Database.Database }).db;
    const inv = async (raw: string) => {
      const code = (await make(w, {})).json().code as string;
      db.prepare('UPDATE invites SET expect_handle = ? WHERE code = ?').run(raw, code);
      return code;
    };
    const bare = await inv('t.me/'), linked = await inv('https://t.me/Maria_K');
    expect([w.store.getInviteByCode(bare)?.expectHandle, w.store.getInviteByCode(linked)?.expectHandle]).toEqual([NAMES_NOBODY, 'maria_k']);
    // Its knock window: was opened for anyone; now for nobody, and says no handle. No sender is shown, whatever their name.
    const knock = (await w.f.inject({ method: 'POST', url: `/v1/agents/a1/invites/${bare}/knock-window`, headers: H })).json();
    expect(['for' in knock, w.store.pairingWindows('a1').map((x) => x.expect)]).toEqual([false, [NAMES_NOBODY]]);
    w.knocks(NOBODY_NAMES.map((username, i) => ({ id: tgId(20 + i), code: `NOBODY${i}`, meta: { username } })));
    expect((await w.f.inject({ method: 'GET', url: '/v1/agents/a1/pairing', headers: H })).json()).toEqual([]);
    w.store.closePairingWindow('a1');
    w.knocks([]); // nobody writes yet
    // Not used yet: refused, left unused, and not counted as a guess (HB-1439 review: used, it led nowhere).
    const refused = await w.f.inject({ method: 'POST', url: '/v1/join', payload: { code: bare, name: 'Bare', channel: 'telegram' } });
    expect([refused.statusCode, refused.json().error]).toEqual([400, 'This invite names nobody: ask its owner for a new one.']);
    expect([w.store.getInviteByCode(bare)?.redeemedAt, (await w.f.inject({ method: 'GET', url: `/v1/invites/${bare}` })).json()])
      .toEqual([undefined, { valid: false, reason: 'names-nobody' }]);
    // One used under the older release (made for nobody named, kept so after): the members list asks for their handle.
    const older = (await make(w, {})).json().code as string;
    for (const [code, name] of [[older, 'Bare'], [linked, 'Linked']] as const) {
      expect((await w.f.inject({ method: 'POST', url: '/v1/join', payload: { code, name, channel: 'telegram' } })).statusCode).toBe(201);
    }
    db.prepare('UPDATE invites SET expect_handle = ? WHERE code = ?').run('t.me/', older);
    await new Promise((res) => setTimeout(res, 20));
    const seats = Object.fromEntries(w.store.listMemberships('a1').filter((m) => m.displayName).map((m) => [m.displayName, m.userId]));
    expect(w.store.pairingWindows('a1').find((x) => x.seat === `telegram:${seats.Linked}`)?.expect).toBe('maria_k');
    w.store.closePairingWindow('a1');
    const rows = (await w.f.inject({ method: 'GET', url: '/v1/agents/a1/members', headers: H })).json() as Array<{ displayName?: string; invitedAs?: string; needsHandle?: boolean }>;
    expect(Object.fromEntries(rows.filter((m) => m.displayName).map((m) => [m.displayName, [m.invitedAs ?? null, m.needsHandle ?? null]])))
      .toEqual({ Bare: [null, true], Linked: ['maria_k', null] });
    // Reopened: the bare one asks for their handle, though the app they joined with is known; the other is for its name.
    const reopen = (who: string, payload: Record<string, unknown>) => w.f.inject({ method: 'POST', url: `/v1/agents/a1/members/${who}/reopen`, headers: H, payload });
    const asked = await reopen(seats.Bare!, {});
    expect([asked.statusCode, asked.json()]).toEqual([409, { error: "Their invite named them by a link with no name in it, so Hatchabot can't tell who to let in: give their @handle.", code: 'needs-handle' }]);
    expect(w.store.pairingWindows('a1')).toEqual([]);
    const given = await reopen(seats.Bare!, { handle: '@bare_one' });
    expect([given.statusCode, given.json().for]).toEqual([200, 'bare_one']);
    w.store.closePairingWindow('a1');
    const named = await reopen(seats.Linked!, {});
    expect([named.statusCode, named.json().for]).toEqual([200, 'maria_k']);
    w.store.closePairingWindow('a1');
  });

  it('a window an older release kept for a bare link, and a join kept with one, match nobody, never the first to write', async () => {
    forgetDmPolicy('a1');
    const w = await world();
    const db = (w.store as unknown as { db: Database.Database }).db;
    w.store.openPairingWindow('a1', new Date(Date.now() + 60_000).toISOString(), 'member-x', { expect: 'maria_k' });
    db.prepare('UPDATE pairing_windows SET expect = ? WHERE agent_id = ?').run('t.me/', 'a1');
    expect(w.store.pairingWindows('a1').map((x) => x.expect)).toEqual([NAMES_NOBODY]);
    w.store.closePairingWindow('a1');
    expect(w.store.openPairingWindow('a1', new Date(Date.now() + 60_000).toISOString(), 'member-x', { expect: 'https://t.me/@' })).toBeTruthy();
    expect(w.store.pairingWindows('a1').map((x) => x.expect)).toEqual([NAMES_NOBODY]);
    w.store.closePairingWindow('a1');
    // The claim of a join kept with a bare link (an older release's agent_holds): the first to write is not bound.
    w.store.insertMembership({ id: 'm9', agentId: 'a1', userId: 'member-invitee', role: 'user', status: 'active', displayName: 'Invitee' } as never);
    w.knocks([{ id: tgId(9), code: 'STRANGER', meta: { username: 'randomer' } },
      ...NOBODY_NAMES.map((username, i) => ({ id: tgId(20 + i), code: `NOBODY${i}`, meta: { username } }))]);
    const runtimeRef = w.store.getAgent('a1')!.runtimeRef!;
    for (const kept of ['t.me/', NAMES_NOBODY]) {
      const bound = await claimFirstContact({ store: w.store, provider: w.provider, sleep: async () => {} },
        { agentId: 'a1', runtimeRef, accountId: 'TaxBot', forUserId: 'member-invitee', expect: kept, timeoutMs: 30 });
      expect(bound, kept).toBeNull();
    }
    expect([9, ...NOBODY_NAMES.map((_, i) => 20 + i)].map((n) => w.store.getActiveMembershipByChannelUser('a1', tgId(n))?.userId ?? null).filter(Boolean)).toEqual([]);
  });
});

describe('a handle in one comparable shape (normalizeHandle, HB-1439 review)', () => {
  it('the same read again is the same (handleText): @@name was kept as @name and expected as name', () => {
    for (const v of ['@@Maria_K', ' @ @maria_k', '@ @ @x', '@ @ @', '@t.me/maria_k', 'https://t.me/@@maria_k/', 'https://t.me/@ @x', 't.me/t.me/maria_k', 'maria_k/', 'https://telegram.me/maria_k?start=1#x', 'Maria K', '', NAMES_NOBODY]) {
      expect(handleText(handleText(v)), v).toBe(handleText(v));
    }
    expect(['@@Maria_K', 'https://t.me/@@Maria_K/', 't.me/Maria_K?start=x', 'telegram.me/Maria_K#top'].map(handleText)).toEqual(['Maria_K', 'Maria_K', 'Maria_K', 'Maria_K']);
    // Only after a link is a name cut at / ? #: a name of another app is kept whole.
    expect(handleText('maria_k/')).toBe('maria_k/');
    expect([handleText('@ @ @x'), handleText('@ @ @')]).toEqual(['x', '']);
    // NAMES_NOBODY is what no one can be compared as: no name read starts with an @, and it reads back as itself.
    for (const v of NOBODY_NAMES_ALL) expect(normalizeHandle(v) ?? '', JSON.stringify(v)).not.toMatch(/^@/);
    expect([normalizeHandle(NAMES_NOBODY), expectedHandle(NAMES_NOBODY), expectedHandle('t.me/'), expectedHandle(expectedHandle('t.me/'))]).toEqual([undefined, NAMES_NOBODY, NAMES_NOBODY, NAMES_NOBODY]);
  });

  it('drops the @ and a t.me or telegram.me link pasted before the name, and is nothing when nothing is left', () => {
    for (const v of ['@Maria_K', 'maria_k', ' https://t.me/Maria_K ', 'http://t.me/maria_k', 't.me/@maria_k', 'T.ME/maria_k', 'https://telegram.me/maria_k', 'telegram.me/maria_k', 'https://www.t.me/maria_k']) {
      expect(normalizeHandle(v), v).toBe('maria_k');
    }
    expect(normalizeHandle('123456789')).toBe('123456789');
    for (const v of ['', '  ', '@', 't.me/', 'https://t.me/@', undefined, null]) expect(normalizeHandle(v), String(v)).toBeUndefined();
    // Only a link at the start: a name with t.me in it is kept as it is.
    expect(normalizeHandle('maria.t.me/x')).toBe('maria.t.me/x');
  });
});

describe('your Hatchabot agent is yours alone (finding 4)', () => {
  it('refuses invites, known people, admitting a knock and "anyone can knock" — but lets you link yourself', async () => {
    const w = await world({ ops: true });
    const said = (r: { statusCode: number; json: () => { error?: string } }) => [r.statusCode, r.json().error];
    const alone = [400, 'Your Hatchabot agent is yours alone.'];
    expect(said(await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload: {} }))).toEqual(alone);
    expect(said(await w.f.inject({ method: 'POST', url: '/v1/agents/a1/members/known', headers: H, payload: { userId: 'user-x' } }))).toEqual(alone);
    expect(said(await w.f.inject({ method: 'POST', url: '/v1/agents/a1/allow-knocks', headers: H, payload: { on: true } }))).toEqual(alone);
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/allow-knocks', headers: H, payload: { on: false } })).statusCode).toBe(200);
    w.knocks([{ id: tgId(7), code: 'K1', meta: { firstName: 'Stranger' } }]);
    expect(said(await w.f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/approve', headers: H, payload: { code: 'K1', kind: 'telegram' } }))).toEqual(alone);
    expect(w.store.getActiveMembershipByChannelUser('a1', tgId(7))).toBeFalsy();
    // The owner seat is already tgId(1). Calling the stranger "me" must not
    // leave that seat on one identity and the account linked to another.
    const other = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/approve', headers: H, payload: { code: 'K1', kind: 'telegram', asSelf: true } });
    expect(other.statusCode).toBe(400);
    expect(w.store.accountTelegram(OWNER)).toBeUndefined();
    expect(w.provider.execLog.some((c) => c[0] === 'pairing' && c[1] === 'approve')).toBe(false);
    w.knocks([{ id: tgId(1), code: 'ME1', meta: { firstName: 'Owner' } }]);
    const me = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/approve', headers: H, payload: { code: 'ME1', kind: 'telegram', asSelf: true } });
    expect(me.statusCode).toBe(200);
    expect(w.store.accountTelegram(OWNER)).toBe(tgId(1));
    expect(w.store.getMembership('a1', OWNER)?.channelUserId).toBe(tgId(1));
    expect(w.store.getActiveMembershipByChannelUser('a1', tgId(7))).toBeUndefined();
    // A link minted for it before the refusal existed opens nothing either.
    w.store.insertInvite({ id: 'i-old', agentId: 'a1', code: 'OLDLINK234', role: 'user', createdBy: OWNER, createdAt: 'now', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect((await w.f.inject({ method: 'POST', url: '/v1/join', payload: { code: 'OLDLINK234', name: 'X', channel: 'telegram' } })).statusCode).toBe(400);
  });
});

describe('a newly admitted Slack/Discord person is let into the rooms live (finding 7)', () => {
  const HOME = '/home/node/.openclaw';
  function volume() {
    const dir = mkdtempSync(join(tmpdir(), 'rooms-'));
    mkdirSync(join(dir, 'credentials'));
    writeFileSync(join(dir, 'openclaw.json'), JSON.stringify({ channels: {
      discord: {
        accounts: { hatchabot: { dmPolicy: 'allowlist', allowFrom: [discordId(1)] } },
        guilds: { [discordId(900)]: { requireMention: true, users: [discordId(1)] }, [discordId(901)]: { requireMention: true } },
      },
      slack: { accounts: { hatchabot: { allowFrom: ['U0OWNER01'] } }, channels: { C0ROOM0001: { enabled: true, users: ['U0OWNER01'] } } },
    } }));
    const provider = {
      execShellOnVolume: async (_ref: string, script: string) => {
        try { return { code: 0, stdout: execFileSync('sh', ['-c', script.replaceAll(HOME, dir)], { encoding: 'utf8' }), stderr: '' }; }
        catch (e) { return { code: 1, stdout: '', stderr: String(e) }; }
      },
    } as never;
    const cfg = () => JSON.parse(readFileSync(join(dir, 'openclaw.json'), 'utf8'));
    return { dir, provider, cfg, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('grantRoomAccess adds them to every room Hatchabot wrote, never to an open or empty one', async () => {
    const v = volume();
    try {
      const deps = { store: new Store(new Database(':memory:')), provider: v.provider };
      expect(await grantRoomAccess(deps, { agentId: 'a1', runtimeRef: 'r', kind: 'discord', channelUserId: discordId(2) })).toBe(true);
      const g = v.cfg().channels.discord.guilds;
      expect(g[discordId(900)].users).toEqual([discordId(1), discordId(2)]);
      expect(g[discordId(901)].users).toBeUndefined(); // no list = not ours to narrow
      // Twice is once.
      await grantRoomAccess(deps, { agentId: 'a1', runtimeRef: 'r', kind: 'discord', channelUserId: discordId(2) });
      expect(v.cfg().channels.discord.guilds[discordId(900)].users).toEqual([discordId(1), discordId(2)]);
      // Telegram has no per-room list: nothing to do.
      expect(await grantRoomAccess(deps, { agentId: 'a1', runtimeRef: 'r', kind: 'telegram', channelUserId: tgId(3) })).toBe(false);
    } finally { v.done(); }
  });

  it('grantChannelAccess (someone you already know) writes the rooms too', async () => {
    const v = volume();
    try {
      const deps = { store: new Store(new Database(':memory:')), provider: v.provider };
      await grantChannelAccess(deps, { agentId: 'a1', runtimeRef: 'r', kind: 'slack', accountId: 'hatchabot', channelUserId: 'U0GUEST001' });
      const sl = v.cfg().channels.slack;
      expect(sl.accounts.hatchabot.allowFrom).toEqual(['U0OWNER01', 'U0GUEST001']);
      expect(sl.channels.C0ROOM0001.users).toEqual(['U0OWNER01', 'U0GUEST001']);
    } finally { v.done(); }
  });
});
