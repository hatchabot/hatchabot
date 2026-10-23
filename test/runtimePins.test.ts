import { describe, expect, it } from 'vitest';
import { clearStaleRuntimePins, clearStaleRuntimePinsWhenUp, listRuntimePins } from '../src/orchestrator/runtimePins.js';
import { as, makeWorld, seedRunningAgent } from './support/world.js';

/**
 * Stale runtime pins (runtimePins.ts): a conversation pinned to a runtime the
 * config no longer names (the pre-setup-token claude-cli) is patched back to
 * configured routing; pins the config still names, implicit ones and locked
 * sessions are left alone.
 */

const listing = (sessions: unknown[]) => ({ code: 0, stdout: JSON.stringify({ sessions }), stderr: '' });
const rt = (id: string, source = 'session-key') => ({ id, source, cloudPlacementSupported: true });

describe('stale runtime pins', () => {
  it('clears a pin to a runtime the config no longer names; leaves implicit, configured and locked ones', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { slug: 'pinned' });
    const a = w.store.getAgent(id)!;
    w.provider.execResponses.set('gateway call sessions.list', listing([
      { key: 'agent:pinned:main', agentRuntime: rt('claude-cli') },
      { key: 'agent:pinned:cron:1', agentRuntime: rt('openclaw', 'implicit') },
      { key: 'agent:pinned:group:9', agentRuntime: rt('codex'), runtimeSelectionLocked: true },
      { key: 'agent:pinned:x', agentRuntime: rt('openclaw') },
      { key: 'agent:pinned:legacy', agentRuntime: 'claude-cli' },
    ]));
    w.provider.execResponses.set('config get agents.defaults.models', { code: 0, stdout: JSON.stringify({ 'anthropic/claude-opus-4-8': {} }), stderr: '' });
    w.provider.execResponses.set('gateway call sessions.patch', { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' });
    expect(await listRuntimePins(w.provider, a.runtimeRef!, 'pinned')).toEqual([
      { key: 'agent:pinned:main', runtime: 'claude-cli', locked: false },
      { key: 'agent:pinned:group:9', runtime: 'codex', locked: true },
      { key: 'agent:pinned:x', runtime: 'openclaw', locked: false },
      { key: 'agent:pinned:legacy', runtime: 'claude-cli', locked: false },
    ]);
    const events: Array<[string, Record<string, unknown>]> = [];
    const cleared = await clearStaleRuntimePins(w.provider, a.runtimeRef!, 'pinned', (e, d) => events.push([e, d]));
    expect(cleared).toEqual(['agent:pinned:main', 'agent:pinned:legacy']);
    const patches = w.provider.execLog.filter((argv) => argv[2] === 'sessions.patch').map((argv) => JSON.parse(argv[5]!));
    expect(patches).toEqual([
      { key: 'agent:pinned:main', agentId: 'pinned', agentRuntime: null },
      { key: 'agent:pinned:legacy', agentId: 'pinned', agentRuntime: null },
    ]);
    // The list asks for this agent's sessions only, and nothing is confirmed or deleted.
    expect(JSON.parse(w.provider.execLog.find((argv) => argv[2] === 'sessions.list')![5]!)).toMatchObject({ agentId: 'pinned' });
    expect(events).toEqual([['runtime.pins_cleared', { sessions: ['agent:pinned:main', 'agent:pinned:legacy'], runtime: 'claude-cli' }]]);
  });

  it('a pin the config still names (a machine-login profile rides claude-cli) stays; a refused patch is an event, not a throw', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { slug: 'cli' });
    const a = w.store.getAgent(id)!;
    w.provider.execResponses.set('gateway call sessions.list', listing([{ key: 'agent:cli:main', agentRuntime: rt('claude-cli') }]));
    w.provider.execResponses.set('config get agents.defaults.models', { code: 0, stdout: JSON.stringify({ 'anthropic/claude-opus-4-8': { agentRuntime: { id: 'claude-cli' } } }), stderr: '' });
    expect(await clearStaleRuntimePins(w.provider, a.runtimeRef!, 'cli')).toEqual([]);
    expect(w.provider.execLog.some((argv) => argv[2] === 'sessions.patch')).toBe(false);
    // Now the config drops it and the gateway refuses the patch.
    w.provider.execResponses.set('config get agents.defaults.models', { code: 0, stdout: '{}', stderr: '' });
    w.provider.execResponses.set('gateway call sessions.patch', { code: 0, stdout: JSON.stringify({ ok: false, error: { message: 'locked' } }), stderr: '' });
    const events: string[] = [];
    expect(await clearStaleRuntimePins(w.provider, a.runtimeRef!, 'cli', (e) => events.push(e))).toEqual([]);
    expect(events).toEqual(['runtime.pin_failed']);
    // No sessions at all: nothing is asked of the config.
    w.provider.execLog.length = 0;
    w.provider.execResponses.set('gateway call sessions.list', listing([]));
    expect(await clearStaleRuntimePins(w.provider, a.runtimeRef!, 'cli')).toEqual([]);
    expect(w.provider.execLog.map((argv) => argv.slice(0, 2).join(' '))).toEqual(['gateway call']);
  });

  it('a config that cannot be read clears nothing: a valid claude-cli pin is not taken for stale (#72)', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { slug: 'cli' });
    const a = w.store.getAgent(id)!;
    w.provider.execResponses.set('gateway call sessions.list', listing([{ key: 'agent:cli:main', agentRuntime: rt('claude-cli') }]));
    w.provider.execResponses.set('gateway call sessions.patch', { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' });
    for (const unread of [{ code: 1, stdout: '', stderr: 'gateway timeout' }, { code: 0, stdout: '{"anthropic/claude-opus-4-8": {"agentRun', stderr: '' }]) {
      w.provider.execResponses.set('config get agents.defaults.models', unread);
      const events: string[] = [];
      expect(await clearStaleRuntimePins(w.provider, a.runtimeRef!, 'cli', (e) => events.push(e))).toEqual([]);
      expect(events).toEqual(['runtime.pin_check_skipped']);
    }
    expect(w.provider.execLog.some((argv) => argv[2] === 'sessions.patch')).toBe(false);
  });

  it('after a start or a wake it waits for the gateway, then clears; a start over the API triggers it', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { slug: 'sleepy' });
    const a = w.store.getAgent(id)!;
    w.provider.execResponses.set('gateway call sessions.list', listing([{ key: 'agent:sleepy:main', agentRuntime: rt('claude-cli') }]));
    w.provider.execResponses.set('gateway call sessions.patch', { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' });
    // Stopped: nothing to do, and no waiting around for it.
    await w.provider.stop(a.runtimeRef!);
    expect(await clearStaleRuntimePinsWhenUp(w.provider, a.runtimeRef!, 'sleepy', () => {}, async () => {}, 3)).toEqual([]);
    await w.provider.start(a.runtimeRef!);
    expect(await clearStaleRuntimePinsWhenUp(w.provider, a.runtimeRef!, 'sleepy', () => {}, async () => {}, 3)).toEqual(['agent:sleepy:main']);
    // Over the API: stop, start — the pin is cleared once the gateway is up, and the trail says so.
    w.provider.execLog.length = 0;
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/stop`, headers: as() })).statusCode).toBe(200);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() })).statusCode).toBe(200);
    for (let i = 0; i < 50 && !w.provider.execLog.some((argv) => argv[2] === 'sessions.patch'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(w.provider.execLog.some((argv) => argv[2] === 'sessions.patch')).toBe(true);
    for (let i = 0; i < 50 && !w.store.listEvents([id]).some((e) => e.event === 'runtime.pins_cleared'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(w.store.listEvents([id]).some((e) => e.event === 'runtime.pins_cleared')).toBe(true);
  });
});

describe('more conversations than one list call returns (report B27, 2026-10-22)', () => {
  // 1,201 conversations; the stale pin is on the last.
  const rows = Array.from({ length: 1201 }, (_, i) => ({ key: `s${i}`, agentRuntime: rt(i === 1200 ? 'claude-cli' : 'openclaw') }));
  const fake = (failOffset?: number) => {
    const asked: Array<Record<string, unknown>> = [];
    const provider: any = {
      exec: async (_r: string, args: string[]) => {
        if (args.includes('sessions.list')) {
          const p = JSON.parse(args[args.indexOf('--params') + 1]!);
          asked.push(p);
          if (failOffset !== undefined && p.offset === failOffset) return { code: 1, stdout: '', stderr: 'unknown property offset' };
          return listing(rows.slice(p.offset ?? 0, (p.offset ?? 0) + p.limit));
        }
        if (args.includes('sessions.patch')) return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
        return { code: 0, stdout: JSON.stringify({ 'anthropic/claude-opus-4-8': {} }), stderr: '' };
      },
    };
    return { provider, asked };
  };

  it('reads every page, and clears the pin on the last one', async () => {
    const { provider, asked } = fake();
    expect(await clearStaleRuntimePins(provider, 'ref', 'sample')).toEqual(['s1200']);
    expect(asked).toEqual([{ agentId: 'sample', limit: 500 }, { agentId: 'sample', limit: 500, offset: 500 }, { agentId: 'sample', limit: 500, offset: 1000 }]);
  });

  it('a gateway that ignores offset (the same page again) is asked twice, not forty times', async () => {
    let calls = 0;
    const provider: any = { exec: async () => { calls++; return listing(rows.slice(0, 500)); } };
    expect(await listRuntimePins(provider, 'ref', 'sample')).toHaveLength(500);
    expect(calls).toBe(2);
  });

  it('a later page that cannot be read is logged; the pages read still count', async () => {
    const { provider } = fake(500);
    const events: Array<[string, Record<string, unknown>]> = [];
    expect(await listRuntimePins(provider, 'ref', 'sample', (e, d) => events.push([e, d]))).toHaveLength(500);
    expect(events).toEqual([['runtime.pin_failed', { error: expect.stringContaining('after the first 500') }]]);
  });
});
