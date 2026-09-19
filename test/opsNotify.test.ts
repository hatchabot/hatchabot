import { describe, expect, it } from 'vitest';
import { createOpsNotifier, opsNoteText, type OpsNoteAgent } from '../src/ops/notify.js';

/**
 * When a change the management agent filed is confirmed, and when a build it
 * started ends, Hatchabot posts a note into the agent's own conversation — so
 * the console says what happened instead of going quiet (2026-09-19).
 */

const live = (over: Partial<OpsNoteAgent> = {}): OpsNoteAgent =>
  ({ id: 'a1', slug: 'hatchabot', hostId: 'h1', state: 'RUNNING', runtimeRef: 'docker://x', ...over });

describe('management agent notes', () => {
  it('frames a note as Hatchabot speaking, automatically, and asks only for a report', () => {
    const text = opsNoteText('The derived image "media" finished building.');
    expect(text).toMatch(/not from a person/i);
    expect(text).toMatch(/media/);
    expect(text).toMatch(/Do not file another change unless they ask/i);
  });

  it('runs one turn in the agent\'s own conversation', async () => {
    const seen: string[] = [];
    const n = createOpsNotifier({
      opsAgent: () => live(),
      runTurn: async (_a, m) => { seen.push(m); return { ok: true }; },
    });
    await n.notify('owner-a', 'Your owner confirmed the change you filed.');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('Your owner confirmed the change you filed.');
  });

  it('says nothing when there is no manager, or it cannot take a turn', async () => {
    let turns = 0;
    const run = async () => { turns++; return { ok: true }; };
    await createOpsNotifier({ opsAgent: () => undefined, runTurn: run }).notify('o', 'x');
    await createOpsNotifier({ opsAgent: () => live({ state: 'STOPPED' }), runTurn: run }).notify('o', 'x');
    await createOpsNotifier({ opsAgent: () => live({ runtimeRef: undefined }), runTurn: run }).notify('o', 'x');
    expect(turns).toBe(0);
  });

  it('serialises notes per agent, so two builds finishing together do not run two turns at once', async () => {
    let live_ = 0, most = 0;
    const n = createOpsNotifier({
      opsAgent: () => live(),
      runTurn: async () => {
        live_++; most = Math.max(most, live_);
        await new Promise((r) => setTimeout(r, 5));
        live_--;
        return { ok: true };
      },
    });
    await Promise.all([n.notify('o', 'one'), n.notify('o', 'two'), n.notify('o', 'three')]);
    expect(most).toBe(1);
  });

  it('a failed turn is logged and dropped — it never breaks the change', async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const n = createOpsNotifier({
      opsAgent: () => live(),
      runTurn: async () => { throw new Error('container gone'); },
      log: (e, d) => events.push([e, d]),
    });
    await expect(n.notify('o', 'x')).resolves.toBeUndefined();
    expect(events[0]?.[0]).toBe('ops.note');
    expect(events[0]?.[1]).toMatchObject({ ok: false });
  });
});

describe('confirming an agent-filed change', () => {
  it('posts the outcome into the management agent\'s own conversation', async () => {
    const [{ default: Database }, { default: Fastify }, { Store }, { MockProvider }, { registerRoutes }] = await Promise.all([
      import('better-sqlite3'), import('fastify'), import('../src/store/store.js'),
      import('../src/providers/mockProvider.js'), import('../src/api/routes.js'),
    ]);
    const OWNER = 'owner-a';
    const H = { 'x-hatchabot-owner': OWNER };
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/x', createdAt: 'now' } as never);
    const { runtimeRef } = await provider.provision({ agentId: 'ops1', slug: 'hatchabot', workspace: { files: {}, configPatch: { agentId: 'hatchabot', authMode: 'api-key' } }, env: {} } as never);
    await provider.start(runtimeRef);
    store.insertAgent({ id: 'ops1', ownerId: OWNER, name: 'Hatchabot', slug: 'hatchabot', state: 'RUNNING', runtimeRef,
      aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.setAgentOps('ops1', true);
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
      providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 } } as never,
    });
    // A card the agent filed, waiting for Confirm.
    const now = Date.now();
    store.putMgmtProposal({
      id: 'c1', ownerId: OWNER, chatId: 0, fromUserId: 0, messageId: 0, tool: 'run_backup',
      resolved: { name: 'run_backup', args: {} } as never, summary: '💾 Back up every agent',
      createdAtMs: now, expiresAtMs: now + 3600_000, status: 'pending', source: 'agent',
    } as never);

    const res = await f.inject({ method: 'POST', url: '/v1/proposals/c1/confirm', headers: H });
    expect(res.statusCode).toBe(200);
    // The turn is fire-and-forget: let it land.
    for (let i = 0; i < 40 && !provider.execLog.some((a) => a[0] === 'agent'); i++) await new Promise((r) => setTimeout(r, 10));
    const note = provider.execLog.find((a) => a[0] === 'agent');
    expect(note).toBeTruthy();
    expect(note!.join(' ')).toMatch(/Hatchabot note/);
    expect(note!.join(' ')).toMatch(/Back up every agent/);
  });
});
