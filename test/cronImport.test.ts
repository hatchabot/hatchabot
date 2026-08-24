import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cronAddArgs, readOpenclawCrons, openclawAgentIdForWorkspace } from '../src/orchestrator/cronImport.js';

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

  it('maps every/command and returns null for an unrepresentable schedule', () => {
    expect(cronAddArgs({ scheduleKind: 'every', everyMs: 3_600_000, payloadKind: 'command', payloadMessage: 'backup.sh' }, 'a')).toEqual([
      'cron', 'add', '--agent', 'a', '--disabled', '--every', '1h', '--command', 'backup.sh',
    ]);
    expect(cronAddArgs({ scheduleKind: 'every', everyMs: 90_000, payloadKind: 'agentTurn', payloadMessage: 'hi' }, 'a')).toContain('90s');
    expect(cronAddArgs({ scheduleKind: 'cron', payloadKind: 'agentTurn' }, 'a')).toBeNull(); // no expr
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
});
