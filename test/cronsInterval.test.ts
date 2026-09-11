import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/providers/mockProvider.js';
import { listCrons } from '../src/orchestrator/crons.js';

describe('cron listing reads the gateway\'s camelCase schedule keys (2026-09-11)', () => {
  it('surfaces everyMs for interval jobs and at for one-shots', async () => {
    const p = new MockProvider();
    const { runtimeRef } = await p.provision({ agentId: 'a', slug: 'k', workspace: { files: {}, configPatch: { agentId: 'k', authMode: 'api-key' } as any }, env: {} });
    p.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [
      { id: '1', name: 'poll', enabled: true, schedule: { kind: 'every', everyMs: 90000, anchorMs: 1 }, payload: { kind: 'agentTurn', message: 'Inbox poll.' } },
      { id: '2', name: 'brief', enabled: true, schedule: { kind: 'cron', expr: '0 8 * * 1-5', tz: 'America/Toronto' }, payload: { kind: 'agentTurn', message: 'x' } },
      { id: '3', name: 'once', enabled: true, schedule: { kind: 'at', at: 1789000000000 }, payload: { kind: 'agentTurn', message: 'y' } },
    ] }) });
    const crons = await listCrons(p, runtimeRef, 'k');
    expect(crons.find((c) => c.id === '1')).toMatchObject({ scheduleKind: 'every', everyMs: 90000 });
    expect(crons.find((c) => c.id === '2')).toMatchObject({ scheduleExpr: '0 8 * * 1-5', scheduleTz: 'America/Toronto' });
    expect(crons.find((c) => c.id === '3')).toMatchObject({ atMs: 1789000000000 });
  });
});
