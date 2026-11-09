import { describe, expect, it } from 'vitest';
import { Broker } from '../src/mgmt/broker.js';
import { HttpApiClient } from '../src/mgmt/apiClient.js';
import { PendingStore } from '../src/mgmt/pendingStore.js';

/**
 * What the manager says after a confirm is what happened: the answer's
 * operation is followed and its warnings are told (the 2026-11-07 deep audit).
 * The API is a fake that answers in the routes' shapes; every name is made up.
 */

const WHO = { ownerId: 'user-household', chatId: 1, fromUserId: 1, role: 'operator' as const };
const AGENTS = [{ id: 'a1', name: 'Garden Notes', slug: 'garden-notes', state: 'STOPPED', aiProfileId: 'p1' }];

function broker(answer: (method: string, path: string) => unknown) {
  const calls: string[] = [];
  const api = new HttpApiClient(async (method, path) => {
    calls.push(`${method} ${path}`);
    if (path === '/v1/agents') return AGENTS;
    const out = answer(method, path);
    if (out === undefined) throw new Error(`unexpected call ${method} ${path}`);
    return out;
  });
  const b = new Broker(api, new PendingStore());
  b.setMode(true);
  const run = async (tool: string, input: Record<string, unknown>) => {
    const proposal = (await b.handleTool(tool, input, WHO)) as { ok: boolean; pending: { confirmId: string } };
    expect(proposal.ok).toBe(true);
    return ((await b.confirm(proposal.pending.confirmId, 'confirm', WHO)) as { text: string }).text;
  };
  return { run, calls };
}

describe('start_agent when the start is a rebuild (HB-0562)', () => {
  const started = { id: 'a1', slug: 'garden-notes', state: 'STOPPED', rebuilding: true, operation: { id: 'op-1', status: 'queued' } };

  it('follows the rebuild, and a rebuild that failed is a failure', async () => {
    const { run, calls } = broker((_m, path) => {
      if (path === '/v1/agents/a1/start') return started;
      if (path === '/v1/operations/op-1') return { id: 'op-1', status: 'failed', outcome: 'The runtime did not come up.' };
      return undefined;
    });
    const text = await run('start_agent', { agent: 'a1' });
    expect(calls).toContain('GET /v1/operations/op-1');
    expect(text).toMatch(/^⚠ Failed/);
    expect(text).toContain('The runtime did not come up.');
  });

  it('says how the rebuild ended when it worked', async () => {
    const { run } = broker((_m, path) => {
      if (path === '/v1/agents/a1/start') return started;
      if (path === '/v1/operations/op-1') return { id: 'op-1', status: 'succeeded', outcome: 'Rebuilt and running.' };
      return undefined;
    });
    const text = await run('start_agent', { agent: 'a1' });
    expect(text).toMatch(/^✅/);
    expect(text).toContain('Rebuilt and running.');
  });

  it('a plain start is a plain ✅', async () => {
    const { run, calls } = broker((_m, path) => (path === '/v1/agents/a1/start' ? { id: 'a1', slug: 'garden-notes', state: 'RUNNING' } : undefined));
    expect(await run('start_agent', { agent: 'a1' })).toBe('✅ ▶ Start "Garden Notes"');
    expect(calls.some((c) => c.includes('/operations/'))).toBe(false);
  });
});

describe('run_backup (HB-0563)', () => {
  it('a backup that could not start is a failure, with its reason', async () => {
    const { run } = broker((_m, path) => (path === '/v1/backups/run' ? { run: { status: 'error', summary: 'Backup could not start: no backup script available.' } } : undefined));
    const text = await run('run_backup', {});
    expect(text).toMatch(/^⚠ Failed/);
    expect(text).toContain('no backup script available');
  });

  it('one under way says where to see how it ends', async () => {
    const { run } = broker((_m, path) => (path === '/v1/backups/run' ? { run: { status: 'running', startedAt: 1 } } : undefined));
    const text = await run('run_backup', {});
    expect(text).toMatch(/^✅/);
    expect(text).toContain('list_backups');
  });
});

describe('clone_agent (HB-0572)', () => {
  it('names what the copy does not have, beside how its setup ended', async () => {
    const reply = { id: 'clone-1', name: 'Garden Notes copy', slug: 'garden-notes-copy', state: 'PROVISIONING', operation: { id: 'clone-op', status: 'running' }, notCopied: ['seed-catalog'], envNotCopied: ['SEED_SHOP_KEY'], memoryNotCopied: [], memoryCopyFailed: true };
    const { run } = broker((_m, path) => {
      if (path === '/v1/agents/a1/clone') return reply;
      if (path === '/v1/operations/clone-op') return { id: 'clone-op', status: 'succeeded', outcome: 'Set up and running.' };
      return undefined;
    });
    const text = await run('clone_agent', { agent: 'a1', name: 'Garden Notes copy' });
    expect(text).toContain('Set up and running.');
    expect(text).toContain('seed-catalog');
    expect(text).toContain('SEED_SHOP_KEY');
    expect(text).toMatch(/daily notes/);
  });

  it('a complete copy adds nothing', async () => {
    const reply = { id: 'clone-1', name: 'Garden Notes copy', slug: 'garden-notes-copy', state: 'PROVISIONING', operation: { id: 'clone-op', status: 'running' }, notCopied: [], envNotCopied: [], memoryNotCopied: [] };
    const { run } = broker((_m, path) => {
      if (path === '/v1/agents/a1/clone') return reply;
      if (path === '/v1/operations/clone-op') return { id: 'clone-op', status: 'succeeded', outcome: 'Set up and running.' };
      return undefined;
    });
    expect(await run('clone_agent', { agent: 'a1', name: 'Garden Notes copy' })).not.toMatch(/⚠/);
  });
});
