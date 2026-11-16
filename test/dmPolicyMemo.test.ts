import { beforeEach, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/providers/mockProvider.js';
import { grantChannelAccess, setDmPolicy } from '../src/orchestrator/members.js';
import { dmPolicyAsserted, forgetDmPolicy, rememberDmPolicy } from '../src/orchestrator/dmPolicyMemo.js';

/**
 * The pairing sweep re-asserts every agent's DM policy every five minutes.
 * Each assertion was a throwaway container on the volume — about 39 per
 * sweep, nearly all answering "unchanged" (review, 2026-09-29). What was
 * asserted is remembered until something could have changed it.
 */
const AGENT = 'agent-memo-1';
let provider: MockProvider;
let ref: string;
const deps = () => ({ store: {} as never, provider });
const volumeRuns = () => provider.execLog.filter((c) => c[0] === 'sh-volume').length;
const rest = (admit: string[], policy: 'allowlist' | 'pairing' = 'allowlist') =>
  setDmPolicy(deps(), { agentId: AGENT, runtimeRef: ref, kind: 'telegram', accountId: 'bot1', policy, allowFrom: admit });

beforeEach(async () => {
  forgetDmPolicy(AGENT);
  provider = new MockProvider();
  ({ runtimeRef: ref } = await provider.provision({ agentId: AGENT, slug: 'memo', workspace: { files: {}, configPatch: { agentId: 'memo', authMode: 'api-key' } }, env: {} } as never));
  provider.execResponses.set('sh-volume', { code: 0, stdout: 'unchanged\n', stderr: '' });
});

describe('the DM-policy memo', () => {
  it('a second identical assertion starts no container', async () => {
    expect(await rest(['1001', '1002'])).toBe(true);
    expect(await rest(['1002', '1001'])).toBe(true); // same people, any order
    expect(volumeRuns()).toBe(1);
  });

  it('a different policy or a different list runs again', async () => {
    await rest(['1001']);
    await rest(['1001'], 'pairing');
    await rest(['1001', '1003']);
    expect(volumeRuns()).toBe(3);
  });

  it('forgotten on start, wake, rebuild or a member change: asserted afresh', async () => {
    await rest(['1001']);
    forgetDmPolicy(AGENT);
    await rest(['1001']);
    expect(volumeRuns()).toBe(2);
  });

  it('a failed run is not remembered', async () => {
    provider.execResponses.set('sh-volume', { code: 1, stdout: '', stderr: 'boom' });
    expect(await rest(['1001'])).toBe(false);
    provider.execResponses.set('sh-volume', { code: 0, stdout: 'set\n', stderr: '' });
    expect(await rest(['1001'])).toBe(true);
    expect(volumeRuns()).toBe(2);
  });

  it('an older completion cannot replace a newer policy memo and leave pairing open', async () => {
    const original = provider.execShellOnVolume.bind(provider);
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    let livePolicy = '';
    provider.execShellOnVolume = async (runtimeRef, script, options) => {
      const call = ++calls;
      const result = await original(runtimeRef, script, options);
      livePolicy = script.includes('"policy":"pairing"') ? 'pairing' : 'allowlist';
      if (call === 1) await delayed;
      return result;
    };
    const older = rest(['1001']);
    await Promise.resolve();
    await rest(['1001'], 'pairing');
    expect(livePolicy).toBe('pairing');
    release();
    await older;
    await rest(['1001']);
    expect(calls).toBe(3);
    expect(livePolicy).toBe('allowlist');
  });

  it('an in-flight assertion cannot repopulate the memo after a rebuild invalidated it', async () => {
    const original = provider.execShellOnVolume.bind(provider);
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    provider.execShellOnVolume = async (runtimeRef, script, options) => {
      const result = await original(runtimeRef, script, options);
      if (first) { first = false; await delayed; }
      return result;
    };
    const pending = rest(['1001']);
    await Promise.resolve();
    forgetDmPolicy(AGENT);
    release();
    await pending;
    await rest(['1001']);
    expect(volumeRuns()).toBe(2);
  });

  it('a rejected transport releases its assertion so a later successful write can be remembered', async () => {
    const original = provider.execShellOnVolume.bind(provider);
    let first = true;
    provider.execShellOnVolume = async (runtimeRef, script, options) => {
      if (first) { first = false; throw new Error('fixture transport lost'); }
      return original(runtimeRef, script, options);
    };
    await expect(rest(['1001'])).rejects.toThrow('fixture transport lost');
    await rest(['1001']);
    await rest(['1001']);
    expect(volumeRuns()).toBe(1);
  });

  it('granting someone access writes the config, so the next rest runs', async () => {
    await rest(['1001']);
    await grantChannelAccess(deps(), { agentId: AGENT, runtimeRef: ref, kind: 'telegram', accountId: 'bot1', channelUserId: '1001' });
    await rest(['1001']);
    expect(volumeRuns()).toBe(3);
  });

  it('ages out after a few hours, so a hand edit is still put right', () => {
    const t = { agentId: AGENT, runtimeRef: 'mock://x', kind: 'telegram', accountId: 'bot1' };
    rememberDmPolicy(t, 'allowlist', ['1'], 0);
    expect(dmPolicyAsserted(t, 'allowlist', ['1'], 60 * 60_000)).toBe(true);
    expect(dmPolicyAsserted(t, 'allowlist', ['1'], 7 * 60 * 60_000)).toBe(false);
  });
});
