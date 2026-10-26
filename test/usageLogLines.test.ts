import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { parseModelCalls, sampleAgentUsage } from '../src/orchestrator/sourceUsage.js';

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
