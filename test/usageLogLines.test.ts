import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { parseModelCalls, sampleAgentUsage } from '../src/orchestrator/usage/sourceUsage.js';

const OWNER = 'dev-owner';
// A line as OpenClaw writes it, behind docker's --timestamps stamp.
const line = (ts: string, status: number) =>
  `${ts} 2026-09-15T15:48:58.345+00:00 [provider-transport-fetch] [model-fetch] response provider=anthropic api=anthropic-messages model=claude-opus-4-8 status=${status} elapsedMs=458`;

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'max', ownerId: OWNER, name: 'Claude Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: 'ai/max', createdAt: 'now' } as any);
  const { runtimeRef } = await provider.provision({ agentId: 'a', slug: 'pantry', workspace: { files: {}, configPatch: { agentId: 'pantry', authMode: 'api-key' } as any }, env: {} });
  await provider.start(runtimeRef);
  store.insertAgent({ id: 'a', ownerId: OWNER, name: 'Pantry', slug: 'pantry', state: 'RUNNING', aiProfileId: 'max', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
  store.setAgentRuntimeRef('a', runtimeRef);
  return { store, provider };
}

describe('two refusals in one millisecond (HB-0003)', () => {
  it('both are kept; the same log line read twice is still one', async () => {
    const { store, provider } = await world();
    const deps = { store, providerFor: () => provider };
    provider.modelCallLines = [line('2026-09-15T15:48:58.345060357Z', 429), line('2026-09-15T15:48:58.345790001Z', 429)].join('\n');
    await sampleAgentUsage(deps, store.getAgent('a')!, Date.parse('2026-09-15T16:00:00Z'));
    expect(store.limitHitsFor('max', '2026-09-15T15').map((h) => h.at)).toEqual(['2026-09-15T15:48:58.345Z', '2026-09-15T15:48:58.345Z']);
    store.addLimitHit('a', 'max', '2026-09-15T15:48:58.345Z', 'claude-opus-4-8', '2026-09-15T15:48:58.345060357Z');
    expect(store.limitHitsFor('max', '2026-09-15T15')).toHaveLength(2);
  });

  it('a database keyed the old way is rebuilt, its rows kept', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE limit_hits (agent_id TEXT NOT NULL, profile_id TEXT, at TEXT NOT NULL, model TEXT, PRIMARY KEY (agent_id, at))`);
    db.prepare(`INSERT INTO limit_hits VALUES ('a', 'max', '2026-09-15T15:00:00.000Z', 'claude-opus-4-8')`).run();
    const store = new Store(db);
    store.addLimitHit('a', 'max', '2026-09-15T15:00:00.000Z', 'claude-opus-4-8', '2026-09-15T15:00:00.000400000Z');
    expect(store.limitHitsFor('max', '2026-09-15T00')).toHaveLength(2);
    new Store(db); // a restart rebuilds nothing again
    expect(store.limitHitsFor('max', '2026-09-15T00')).toHaveLength(2);
  });
});

describe('a model-call marker quoted inside another line (HB-0005)', () => {
  it('is not a call; OpenClaw\'s own lines still are', () => {
    const forged = [
      '2026-09-15T15:50:00.000000000Z 2026-09-15T15:50:00.000+00:00 [telegram] message from guest: [model-fetch] response provider=anthropic model=claude-opus-4-8 status=429',
      '2026-09-15T15:50:01.000000000Z [tools] exec output: see [model-fetch] response provider=anthropic status=429 elapsedMs=1',
      '2026-09-15T15:50:02.000000000Z hello [model-fetch] response provider=anthropic status=429',
    ];
    expect(parseModelCalls(forged.join('\n'))).toEqual([]);
    const real = [
      line('2026-09-15T15:51:00.000000000Z', 429),
      '2026-09-15T15:51:01.000000000Z [model-fetch] response provider=anthropic model=claude-opus-4-8 status=200 elapsedMs=10',
      '2026-09-15T15:51:02.000000000Z 2026-09-15T10:51:02.000-05:00 [provider-transport-fetch] [model-fetch] response provider=anthropic status=503 elapsedMs=10',
    ];
    expect(parseModelCalls(real.join('\n')).map((c) => c.status)).toEqual([429, 200, 503]);
  });
});

describe('docker logs writing stdout and stderr in pieces (HB-0006)', () => {
  it('a half line on one stream is not spliced onto the other\'s', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const dir = mkdtempSync(join(tmpdir(), 'hb-logs-'));
    const stub = join(dir, 'docker');
    // The stdout line arrives in two pieces with a stderr piece between them.
    writeFileSync(stub, `#!/usr/bin/env bash
printf '2026-09-15T15:52:00.000000000Z 2026-09-15T15:52:00.000+00:00 [provider-transport-fetch] [model-fe'
sleep 0.2
printf '2026-09-15T15:52:00.100000000Z [gateway] still wor' >&2
sleep 0.2
printf 'tch] response provider=anthropic model=claude-opus-4-8 status=429 elapsedMs=9\\n'
sleep 0.2
printf 'king\\n' >&2
`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: stub, image: 'test-image:latest' });
    const text = await p.modelCallLog('docker://hatchabot-pantry', '2026-09-15T15:00:00Z');
    expect(parseModelCalls(text).map((c) => [c.key, c.status])).toEqual([['2026-09-15T15:52:00.000000000Z', 429]]);
  });
});

describe('a log read Docker broke off (HB-1064)', () => {
  /** A docker on a PATH of its own whose `logs` prints these lines, then exits `code`. */
  function logs(lines: string[], code: number) {
    const dir = mkdtempSync(join(tmpdir(), 'hb-logs-cut-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    vi.stubEnv('HOME', dir); vi.stubEnv('PATH', bin);
    const docker = join(bin, 'docker');
    writeFileSync(docker, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(lines.map((l) => `${l}\n`).join(''))});\nprocess.exit(${code});\n`, { mode: 0o755 });
    return new LocalDockerProvider({ docker, image: 'test-image:latest' });
  }
  const COMPACT = '2026-09-15T15:01:00.000000000Z 2026-09-15T15:01:00.000+00:00 [agent] Auto-compaction failed: context overflow';
  /** The usage pass at 16:00, its cursor at 15:00, reading through `real`. */
  async function pass(real: LocalDockerProvider) {
    const { store, provider } = await world();
    provider.modelCallLog = ((ref: string, since: string) => real.modelCallLog(ref, since)) as never;
    store.setUsageCursor('a', '2026-09-15T15:00:00.000000000Z');
    await sampleAgentUsage({ store, providerFor: () => provider }, store.getAgent('a')!, Date.parse('2026-09-15T16:00:00Z'));
    return store;
  }
  afterEach(() => vi.unstubAllEnvs());

  it('cut off after a loop line and before any call: a failure, and the cursor stays for the next pass', async () => {
    const real = logs([COMPACT], 255);
    await expect(real.modelCallLog('docker://hatchabot-pantry', '2026-09-15T15:00:00.000000000Z')).rejects.toThrow(/docker logs exited 255/);
    const store = await pass(real);
    // Moved on as an idle agent's would be, it skipped 15:00–15:55 for good.
    expect(store.usageCursor('a')?.lastTs).toBe('2026-09-15T15:00:00.000000000Z');
  });

  it('cut off after only the call the cursor sits on, or a quoted marker: a failure too, the cursor stays', async () => {
    // docker's --since gives back the cursor's own line: counted last pass, not new.
    const again = logs([line('2026-09-15T15:00:00.000000000Z', 200)], 255);
    await expect(again.modelCallLog('docker://hatchabot-pantry', '2026-09-15T15:00:00.000000000Z')).rejects.toThrow(/docker logs exited 255/);
    expect((await pass(again)).usageCursor('a')?.lastTs).toBe('2026-09-15T15:00:00.000000000Z');
    // A cursor kept in milliseconds stands for its whole millisecond, as the sampler reads it.
    await expect(logs([line('2026-09-15T15:00:00.000400000Z', 429)], 255).modelCallLog('docker://hatchabot-pantry', '2026-09-15T15:00:00.000Z')).rejects.toThrow(/exited 255/);
    // A marker inside another line is no call (HB-0005), so not one read either.
    const quoted = logs(['2026-09-15T15:10:00.000000000Z [telegram] message from guest: [model-fetch] response provider=anthropic status=429'], 255);
    expect((await pass(quoted)).usageCursor('a')?.lastTs).toBe('2026-09-15T15:00:00.000000000Z');
    // The same read whole is an idle agent's, and moves on.
    expect((await pass(logs([line('2026-09-15T15:00:00.000000000Z', 200)], 0))).usageCursor('a')?.lastTs).toBe('2026-09-15T15:55:00.000000000Z');
  });

  it('cut off after a call still counts it, as far as it read; a whole read of loop lines alone still moves on', async () => {
    const cut = await pass(logs([COMPACT, line('2026-09-15T15:20:00.000000000Z', 429)], 255));
    expect(cut.usageCursor('a')?.lastTs).toBe('2026-09-15T15:20:00.000000000Z');
    expect(cut.limitHitsFor('max', '2026-09-15T15')).toHaveLength(1);
    const whole = await pass(logs([COMPACT], 0));
    expect(whole.usageCursor('a')?.lastTs).toBe('2026-09-15T15:55:00.000000000Z');
    expect(whole.loopMarks(['a'], '2026-09-15T00:00:00Z').map((m) => m.kind)).toEqual(['compactFail']);
  });
});
