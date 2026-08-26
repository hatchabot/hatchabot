import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cronAddArgs,
  readOpenclawCrons,
  openclawAgentIdForWorkspace,
  migrateCrons,
  selfPathReplacements,
  applyReplacements,
  rewriteWorkspaceFiles,
} from '../src/orchestrator/cronImport.js';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';

describe('cronAddArgs', () => {
  it('maps a cron-schedule agentTurn job to a disabled `cron add`', () => {
    const args = cronAddArgs(
      {
        name: 'Daily Portfolio Import',
        description: 'imports the portfolio',
        scheduleKind: 'cron',
        scheduleExpr: '30 8 * * *',
        scheduleTz: 'America/Toronto',
        payloadKind: 'agentTurn',
        payloadMessage: 'Import the portfolio.',
      },
      'stock-advisor',
    );
    expect(args).toEqual([
      'cron', 'add', '--agent', 'stock-advisor', '--disabled',
      '--name', 'Daily Portfolio Import',
      '--description', 'imports the portfolio',
      '--cron', '30 8 * * *', '--tz', 'America/Toronto',
      '--message', 'Import the portfolio.',
    ]);
  });

  it('carries the source delivery route (isolated + announce → the same telegram chat)', () => {
    // Without this, adopt dropped delivery and the cron announced to "last"
    // (no route → fail-closed, or the isolated agent's reply leaking to Chris).
    const args = cronAddArgs(
      {
        name: 'TSCC 2405 check', scheduleKind: 'cron', scheduleExpr: '0 9 * * *',
        payloadKind: 'agentTurn', payloadMessage: 'scan',
        sessionTarget: 'isolated', deliveryMode: 'announce',
        deliveryChannel: 'telegram', deliveryTo: 'telegram:1000000001',
      },
      'condo-adviser',
    );
    expect(args).toContain('--session'); expect(args).toContain('isolated');
    expect(args).toContain('--announce');
    expect(args).toContain('--channel'); expect(args).toContain('telegram');
    // The telegram: prefix is stripped — --to wants the bare chat id.
    expect(args).toContain('--to'); expect(args).toContain('1000000001');
    expect(args).not.toContain('telegram:1000000001');
  });

  it('maps every/command and returns null for an unrepresentable schedule', () => {
    expect(cronAddArgs({ scheduleKind: 'every', everyMs: 3_600_000, payloadKind: 'command', payloadMessage: 'backup.sh' }, 'a')).toEqual([
      'cron', 'add', '--agent', 'a', '--disabled', '--every', '1h', '--command', 'backup.sh',
    ]);
    expect(cronAddArgs({ scheduleKind: 'every', everyMs: 90_000, payloadKind: 'agentTurn', payloadMessage: 'hi' }, 'a')).toContain('90s');
    expect(cronAddArgs({ scheduleKind: 'cron', payloadKind: 'agentTurn' }, 'a')).toBeNull(); // no expr
  });
});

describe('self-path rewriting', () => {
  const entry = {
    id: 'tech',
    workspace: '/home/u/.openclaw/workspace-tech',
    agentDir: '/home/u/.openclaw/agents/tech/agent',
  };
  const container = '/home/node/.openclaw/agents/tech-2/agent';

  it('maps both source paths to the container, longest first', () => {
    const pairs = selfPathReplacements(entry, 'tech-2');
    // agentDir is longer than workspace → rewritten first, so a nested match
    // never gets half-rewritten by the parent.
    expect(pairs[0]).toEqual([entry.agentDir, container]);
    expect(pairs).toContainEqual([entry.workspace, container]);
  });

  it('applyReplacements rewrites references in text, leaving the rest alone', () => {
    const pairs = selfPathReplacements(entry, 'tech-2');
    const msg = `Read ${entry.workspace}/memory/today.md and keep /home/u/taxes untouched.`;
    expect(applyReplacements(msg, pairs)).toBe(
      `Read ${container}/memory/today.md and keep /home/u/taxes untouched.`,
    );
    expect(applyReplacements(undefined, pairs)).toBeUndefined();
  });

  it('rewriteWorkspaceFiles runs a container node pass with the pairs, and no-ops on empty', async () => {
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'tech-2', workspace: { files: {}, configPatch: { agentId: 'tech-2', authMode: 'api-key' } }, env: {} });
    const pairs = selfPathReplacements(entry, 'tech-2');
    const r = await rewriteWorkspaceFiles({ provider }, runtimeRef, 'tech-2', pairs);
    expect(r.rewrote).toBe(true);
    const shell = provider.execLog.map((a) => a.join(' ')).find((s) => s.includes('node -e'));
    expect(shell).toContain('/home/node/.openclaw/agents/tech-2/agent'); // WSDIR
    expect(shell).toContain(entry.agentDir); // pair present in PAIRS json
    // empty pairs → nothing issued
    provider.execLog.length = 0;
    expect((await rewriteWorkspaceFiles({ provider }, runtimeRef, 'tech-2', [])).rewrote).toBe(false);
    expect(provider.execLog.length).toBe(0);
  });
});

describe('readOpenclawCrons + workspace resolution', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-cron-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const db = join(root, 'openclaw.sqlite');
  const cfg = join(root, 'openclaw.json');

  // Minimal cron_jobs table with the columns the reader selects.
  const d = new Database(db);
  d.exec(`CREATE TABLE cron_jobs (
    agent_id TEXT, name TEXT, description TEXT, schedule_kind TEXT, schedule_expr TEXT,
    schedule_tz TEXT, every_ms INTEGER, at TEXT, payload_kind TEXT, payload_message TEXT,
    sort_order INTEGER, created_at_ms INTEGER)`);
  d.prepare(`INSERT INTO cron_jobs (agent_id,name,schedule_kind,schedule_expr,schedule_tz,payload_kind,payload_message,sort_order,created_at_ms)
             VALUES (?,?,?,?,?,?,?,?,?)`).run('tech-advisor', 'Daily brief', 'cron', '0 8 * * *', 'America/Toronto', 'agentTurn', 'Write the brief', 0, 1);
  d.prepare(`INSERT INTO cron_jobs (agent_id,name,schedule_kind,schedule_expr,payload_kind,payload_message,sort_order,created_at_ms)
             VALUES (?,?,?,?,?,?,?,?)`).run('other-agent', 'Not mine', 'cron', '0 9 * * *', 'agentTurn', 'x', 0, 1);
  d.close();

  writeFileSync(cfg, JSON.stringify({ agents: { list: [{ id: 'tech-advisor', workspace: join(root, 'ws-tech') }] } }));

  it('reads only the named agent\'s crons', () => {
    const crons = readOpenclawCrons('tech-advisor', db);
    expect(crons).toHaveLength(1);
    expect(crons[0]).toMatchObject({ name: 'Daily brief', scheduleExpr: '0 8 * * *', payloadMessage: 'Write the brief' });
  });

  it('resolves a workspace path to its OpenClaw agent id', () => {
    expect(openclawAgentIdForWorkspace(join(root, 'ws-tech'), cfg)).toBe('tech-advisor');
    expect(openclawAgentIdForWorkspace(join(root, 'ws-unknown'), cfg)).toBeUndefined();
  });

  it('returns [] for a missing DB', () => {
    expect(readOpenclawCrons('tech-advisor', join(root, 'nope.sqlite'))).toEqual([]);
  });

  it('migrateCrons recreates each cron in the container, disabled', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Tech', slug: 'tech', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'x', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'tech', workspace: { files: {}, configPatch: { agentId: 'tech', authMode: 'api-key' } }, env: {} });
    store.setAgentRuntimeRef('a1', runtimeRef);
    await provider.start(runtimeRef);
    store.setAgentState('a1', 'RUNNING');

    const res = await migrateCrons({ store, provider }, 'a1', join(root, 'ws-tech'), { configPath: cfg, dbPath: db, readyGapMs: 0 });
    expect(res).toEqual({ total: 1, carried: 1, failed: 0 });
    // the actual `cron add` was issued for the container's slug, disabled
    const add = provider.execLog.find((a) => a[0] === 'cron' && a[1] === 'add');
    expect(add).toContain('--agent');
    expect(add).toContain('tech');
    expect(add).toContain('--disabled');
    expect(add).toContain('--cron');
    expect(add).toContain('0 8 * * *');
  });
});
