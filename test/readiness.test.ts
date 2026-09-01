import { describe, expect, it } from 'vitest';
import { waitForSkillsSettled } from '../src/orchestrator/provision.js';
import type { RuntimeProvider } from '../src/providers/provider.js';

/**
 * The gate exists because "healthy" and "ready" turned out to be different
 * things: an agent messaged 35s after a restore started a NEW session and
 * archived the old one, while the same agent messaged five minutes later
 * carried on. It waits for the agent to stop changing underneath us, and it is
 * bounded — a late agent beats a failed one.
 */

const noSleep = async () => {};
const provider = (outputs: string[]): RuntimeProvider => {
  let i = 0;
  return {
    exec: async () => {
      const stdout = outputs[Math.min(i++, outputs.length - 1)]!;
      return stdout === 'FAIL'
        ? { code: 1, stdout: '', stderr: 'not up yet' }
        : { code: 0, stdout, stderr: '' };
    },
  } as unknown as RuntimeProvider;
};

describe('the readiness gate waits for the agent to stop moving', () => {
  it('returns as soon as two readings match', async () => {
    const events: Array<[string, any]> = [];
    await waitForSkillsSettled(provider(['a', 'a']), 'ref', 'slug', noSleep, (e, d) => events.push([e, d]));
    expect(events[0]![0]).toBe('runtime.ready');
    expect(events[0]![1].settled).toBe(true);
    expect(events[0]![1].polls).toBe(2);
  });

  it('keeps waiting while the skill list is still changing', async () => {
    // This is the real shape: runRebuildHook installs skills seconds before the
    // agent goes live, so early readings genuinely differ.
    const events: Array<[string, any]> = [];
    await waitForSkillsSettled(provider(['a', 'ab', 'abc', 'abc']), 'ref', 'slug', noSleep,
      (e, d) => events.push([e, d]));
    expect(events[0]![1]).toMatchObject({ settled: true, polls: 4 });
  });

  it('treats a failing probe as "not ready", not as settled', async () => {
    // Two identical failures must NOT count as agreement — a CLI that can't
    // answer yet is precisely the state being waited out.
    const events: Array<[string, any]> = [];
    await waitForSkillsSettled(provider(['FAIL', 'FAIL', 'ok', 'ok']), 'ref', 'slug', noSleep,
      (e, d) => events.push([e, d]));
    expect(events[0]![1]).toMatchObject({ settled: true, polls: 4 });
  });

  it('gives up and lets the agent go live rather than blocking it', async () => {
    // Never-settling agent: refusing to go live would be an outage, so the gate
    // reports failure and stands aside.
    const events: Array<[string, any]> = [];
    let n = 0;
    const churning = { exec: async () => ({ code: 0, stdout: `changes-${n++}`, stderr: '' }) } as unknown as RuntimeProvider;
    await waitForSkillsSettled(churning, 'ref', 'slug', noSleep, (e, d) => events.push([e, d]),
      { intervalMs: 0, timeoutMs: 30 });
    expect(events.at(-1)![1].settled).toBe(false);
  });

  it('never throws, even if the provider does', async () => {
    const broken = { exec: async () => { throw new Error('docker gone'); } } as unknown as RuntimeProvider;
    await expect(
      waitForSkillsSettled(broken, 'ref', 'slug', noSleep, () => {}, { intervalMs: 0, timeoutMs: 20 }),
    ).resolves.toBeUndefined();
  });
});
