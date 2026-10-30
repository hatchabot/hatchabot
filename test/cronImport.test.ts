import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  cronAddArgs,
  readOpenclawCrons,
  readOpenclawCronStore,
  openclawAgentIdForWorkspace,
  migrateCrons,
  pathPattern,
  selfPathReplacements,
  applyReplacements,
  rewriteWorkspaceFiles,
} from '../src/orchestrator/cronImport.js';
import { WORKSPACE_DIR_TEMPLATE } from '../src/openclaw/configWriter.js';
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
      'stock-watcher',
    );
    expect(args).toEqual([
      'cron', 'add', '--agent', 'stock-watcher', '--disabled',
      '--name', 'Daily Portfolio Import',
      '--description', 'imports the portfolio',
      '--cron', '30 8 * * *', '--tz', 'America/Toronto',
      '--message', 'Import the portfolio.',
    ]);
  });

  it('carries the source delivery route (isolated + announce → the same telegram chat)', () => {
    // Without this, adopt dropped delivery and the cron announced to "last"
    // (no route → fail-closed, or the isolated agent's reply leaking to the owner).
    const args = cronAddArgs(
      {
        name: 'Board check', scheduleKind: 'cron', scheduleExpr: '0 9 * * *',
        payloadKind: 'agentTurn', payloadMessage: 'scan',
        sessionTarget: 'isolated', deliveryMode: 'announce',
        deliveryChannel: 'telegram', deliveryTo: 'telegram:1000000001',
      },
      'hoa-helper',
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
    expect(shell).toContain(JSON.stringify(pathPattern(entry.agentDir)).slice(1, -1)); // pair present in PAIRS json
    // empty pairs → nothing issued
    provider.execLog.length = 0;
    expect((await rewriteWorkspaceFiles({ provider }, runtimeRef, 'tech-2', [])).rewrote).toBe(false);
    expect(provider.execLog.length).toBe(0);
  });

  // Review 2026-10-22: A11, A12, A35.
  it('a ~/ path is rewritten as written and as its absolute form; a +, @, % or = sibling is another folder', () => {
    const to = WORKSPACE_DIR_TEMPLATE.replace('{slug}', 'agent-2');
    const pairs = selfPathReplacements({ id: 'agent', workspace: '~/work' }, 'agent-2', '/home/u');
    const text = 'See ~/work/a.md and /home/u/work/b.md, not /home/u/work+archive/c.md, /home/u/work@old or /home/u/work=2.';
    expect(applyReplacements(text, pairs)).toBe(`See ${to}/a.md and ${to}/b.md, not /home/u/work+archive/c.md, /home/u/work@old or /home/u/work=2.`);
  });

  it('a path after = is still rewritten: it ends a setting, not a name', () => {
    const to = WORKSPACE_DIR_TEMPLATE.replace('{slug}', 'agent-2');
    const pairs = selfPathReplacements({ id: 'agent', workspace: '/home/u/work' }, 'agent-2', '/home/u');
    expect(applyReplacements('WS=/home/u/work python3 a.py --dir=/home/u/work/notes', pairs))
      .toBe(`WS=${to} python3 a.py --dir=${to}/notes`);
  });

  it('an apostrophe in the source path is quoted for the shell, not a reason to skip the files', async () => {
    const src = { id: 'agent', workspace: "/data/owner's workspace" };
    const pairs = selfPathReplacements(src, 'agent-2');
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'agent-2', workspace: { files: {}, configPatch: { agentId: 'agent-2', authMode: 'api-key' } }, env: {} });
    expect((await rewriteWorkspaceFiles({ provider }, runtimeRef, 'agent-2', pairs)).rewrote).toBe(true);
    const shell = provider.execLog.map((a) => a.join(' ')).find((s) => s.includes('node -e'))!;
    // The command as the container's shell runs it, with WSDIR pointed at a temp folder.
    const dir = mkdtempSync(join(tmpdir(), 'acl-rw-'));
    try {
      writeFileSync(join(dir, 'MEMORY.md'), "Notes in /data/owner's workspace/notes.md.");
      const wsdir = WORKSPACE_DIR_TEMPLATE.replace('{slug}', 'agent-2');
      execFileSync('sh', ['-c', shell.replace(`WSDIR='${wsdir}'`, `WSDIR='${dir}'`).replace(/^.*?PAIRS=/, 'PAIRS=')]);
      expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe(`Notes in ${wsdir}/notes.md.`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rewrites only whole paths, never a sibling that starts the same (#80)', async () => {
    const src = { id: 'agent', workspace: '/source/agent' };
    const pairs = selfPathReplacements(src, 'agent-2');
    const to = WORKSPACE_DIR_TEMPLATE.replace('{slug}', 'agent-2');
    const text = 'Read /source/agent/notes.md, /source/agent-two/x.md, /source/agent.bak and /old/source/agent. Done in /source/agent.';
    const want = `Read ${to}/notes.md, /source/agent-two/x.md, /source/agent.bak and /old/source/agent. Done in ${to}.`;
    expect(applyReplacements(text, pairs)).toBe(want);

    // The same rule inside the container: run the command's node script on a real folder.
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'agent-2', workspace: { files: {}, configPatch: { agentId: 'agent-2', authMode: 'api-key' } }, env: {} });
    await rewriteWorkspaceFiles({ provider }, runtimeRef, 'agent-2', pairs);
    const shell = provider.execLog.map((a) => a.join(' ')).find((s) => s.includes('node -e'))!;
    const json = /PAIRS='([^']*)'/.exec(shell)![1]!;
    const script = /node -e '([^']*)'/.exec(shell)![1]!;
    const dir = mkdtempSync(join(tmpdir(), 'acl-rw-'));
    try {
      writeFileSync(join(dir, 'MEMORY.md'), text);
      execFileSync(process.execPath, ['-e', script], { env: { PAIRS: json, WSDIR: dir } });
      expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe(want);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
             VALUES (?,?,?,?,?,?,?,?,?)`).run('garden-advisor', 'Daily brief', 'cron', '0 8 * * *', 'America/Toronto', 'agentTurn', 'Write the brief', 0, 1);
  d.prepare(`INSERT INTO cron_jobs (agent_id,name,schedule_kind,schedule_expr,payload_kind,payload_message,sort_order,created_at_ms)
             VALUES (?,?,?,?,?,?,?,?)`).run('other-agent', 'Not mine', 'cron', '0 9 * * *', 'agentTurn', 'x', 0, 1);
  d.close();

  writeFileSync(cfg, JSON.stringify({ agents: { list: [{ id: 'garden-advisor', workspace: join(root, 'ws-tech') }] } }));

  it('reads only the named agent\'s crons', () => {
    const crons = readOpenclawCrons('garden-advisor', db);
    expect(crons).toHaveLength(1);
    expect(crons[0]).toMatchObject({ name: 'Daily brief', scheduleExpr: '0 8 * * *', payloadMessage: 'Write the brief' });
  });

  it('resolves a workspace path to its OpenClaw agent id', () => {
    expect(openclawAgentIdForWorkspace(join(root, 'ws-tech'), cfg)).toBe('garden-advisor');
    expect(openclawAgentIdForWorkspace(join(root, 'ws-unknown'), cfg)).toBeUndefined();
  });

  it('returns [] for a missing DB', () => {
    expect(readOpenclawCrons('garden-advisor', join(root, 'nope.sqlite'))).toEqual([]);
    expect(readOpenclawCronStore('garden-advisor', join(root, 'nope.sqlite'))).toEqual({ crons: [] });
  });

  const CHAT = ['55', '50', '0', '03'].join(''); // made up, built at run time
  it('reads 2026.9\'s one-job_json-per-task store, skipping OpenClaw\'s own upkeep (review A45)', () => {
    const p = join(root, 'state-2026-9.sqlite');
    const s = new Database(p);
    s.exec('CREATE TABLE cron_jobs (job_id TEXT, agent_id TEXT, declaration_key TEXT, job_json TEXT, updated_at INTEGER)');
    const add = s.prepare('INSERT INTO cron_jobs VALUES (?,?,?,?,?)');
    add.run('j1', 'garden-advisor', null, JSON.stringify({ id: 'j1', name: 'Daily brief', schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'America/Toronto' }, payload: { kind: 'agentTurn', message: 'Write the brief' }, sessionTarget: 'isolated', delivery: { mode: 'announce', channel: 'telegram', to: CHAT } }), 1);
    add.run('j2', 'garden-advisor', null, JSON.stringify({ id: 'j2', name: 'Water reminder', schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { kind: 'systemEvent', text: 'Water the plants' }, sessionTarget: 'main' }), 1);
    add.run('j3', 'garden-advisor', 'openclaw.dreaming', JSON.stringify({ id: 'j3', name: 'upkeep', declarationKey: 'openclaw.dreaming', schedule: { kind: 'cron', expr: '0 3 * * *' }, payload: { kind: 'agentTurn', message: 'x' } }), 1);
    add.run('j4', 'other-agent', null, JSON.stringify({ id: 'j4', name: 'Not mine', schedule: { kind: 'cron', expr: '0 9 * * *' }, payload: { kind: 'agentTurn', message: 'x' } }), 1);
    s.close();
    const r = readOpenclawCronStore('garden-advisor', p);
    expect(r.error).toBeUndefined();
    expect(r.crons).toEqual([
      expect.objectContaining({ name: 'Daily brief', scheduleKind: 'cron', scheduleExpr: '0 8 * * *', scheduleTz: 'America/Toronto', payloadKind: 'agentTurn', payloadMessage: 'Write the brief', sessionTarget: 'isolated', deliveryMode: 'announce', deliveryChannel: 'telegram', deliveryTo: CHAT }),
      expect.objectContaining({ name: 'Water reminder', scheduleKind: 'every', everyMs: 3_600_000, payloadKind: 'systemEvent', payloadMessage: 'Water the plants', sessionTarget: 'main' }),
    ]);
    // …and the reminder goes back in as a system event, not an agent turn (B36).
    const args = cronAddArgs(r.crons[1]!, 'garden');
    expect(args).toEqual(expect.arrayContaining(['--system-event', 'Water the plants', '--session', 'main']));
    expect(args).not.toContain('--message');
  });

  it('a task stored with no agent is the default agent\'s: OpenClaw runs it as that one (final audit, 2026-10-22)', () => {
    const p = join(root, 'state-unowned.sqlite');
    const s = new Database(p);
    s.exec('CREATE TABLE cron_jobs (job_id TEXT, agent_id TEXT, declaration_key TEXT, job_json TEXT, updated_at INTEGER)');
    const add = s.prepare('INSERT INTO cron_jobs VALUES (?,?,?,?,?)');
    add.run('j1', null, null, JSON.stringify({ id: 'j1', name: 'Made with the CLI', schedule: { kind: 'cron', expr: '0 7 * * *' }, payload: { kind: 'agentTurn', message: 'x' } }), 1);
    add.run('j2', 'garden-advisor', null, JSON.stringify({ id: 'j2', name: 'Its own', schedule: { kind: 'cron', expr: '0 8 * * *' }, payload: { kind: 'agentTurn', message: 'x' } }), 1);
    s.close();
    const two = join(root, 'openclaw-two.json');
    writeFileSync(two, JSON.stringify({ agents: { list: [{ id: 'kitchen' }, { id: 'garden-advisor', default: true }] } }));
    expect(readOpenclawCronStore('garden-advisor', p, two).crons.map((c) => c.name)).toEqual(['Made with the CLI', 'Its own']);
    expect(readOpenclawCronStore('kitchen', p, two).crons).toEqual([]);
    // No default marked: the first entry.
    expect(readOpenclawCronStore('garden-advisor', p, cfg).crons.map((c) => c.name)).toEqual(['Made with the CLI', 'Its own']);
  });

  it('an unknown store shape or a corrupt file is an error, never "no tasks" (review A45, A13)', () => {
    const odd = join(root, 'odd.sqlite');
    const s = new Database(odd);
    s.exec('CREATE TABLE cron_jobs (job_id TEXT, agent_id TEXT, blob BLOB)');
    s.close();
    expect(readOpenclawCronStore('garden-advisor', odd)).toEqual({ crons: [], error: expect.stringMatching(/shape/) });
    const corrupt = join(root, 'corrupt.sqlite');
    writeFileSync(corrupt, 'this is not a database, just bytes '.repeat(200));
    expect(readOpenclawCronStore('garden-advisor', corrupt)).toEqual({ crons: [], error: expect.stringMatching(/could not be (read|opened)/) });
  });

  it('an interval that is not whole seconds is not rounded to another one (B49)', () => {
    expect(cronAddArgs({ scheduleKind: 'every', everyMs: 1500, payloadMessage: 'x' }, 'a')).toBeNull();
    expect(cronAddArgs({ scheduleKind: 'every', everyMs: 15_000, payloadMessage: 'x' }, 'a')).toEqual(expect.arrayContaining(['--every', '15s']));
    expect(cronAddArgs({ scheduleKind: 'every', everyMs: 90_000, payloadMessage: 'x' }, 'a')).toEqual(expect.arrayContaining(['--every', '90s']));
  });

  it('a payload kind it does not know is not guessed at (review B36)', () => {
    expect(cronAddArgs({ scheduleKind: 'every', everyMs: 60_000, payloadKind: 'webhook', payloadMessage: 'x' }, 'a')).toBeNull();
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

    // Adopted again (or retried): the task brought over before is there, disabled; no second copy (B37).
    provider.execResponses.set('cron list', { code: 0, stdout: JSON.stringify({ jobs: [{ id: 'j9', name: 'Daily brief', enabled: false, schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'America/Toronto' }, payload: { kind: 'agentTurn', message: 'Write the brief' } }] }), stderr: '' });
    const before = provider.execLog.filter((a) => a[0] === 'cron' && a[1] === 'add').length;
    const again = await migrateCrons({ store, provider }, 'a1', join(root, 'ws-tech'), { configPath: cfg, dbPath: db, readyGapMs: 0 });
    expect(again).toEqual({ total: 1, carried: 1, failed: 0 });
    expect(provider.execLog.filter((a) => a[0] === 'cron' && a[1] === 'add').length).toBe(before);
  });

  it('a task there already with the same name but another time, prompt or zone is another task, and is added (review R20)', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Tech', slug: 'tech', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'x', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'tech', workspace: { files: {}, configPatch: { agentId: 'tech', authMode: 'api-key' } }, env: {} });
    store.setAgentRuntimeRef('a1', runtimeRef);
    await provider.start(runtimeRef);
    store.setAgentState('a1', 'RUNNING');
    // The source: a one-shot reminder for December, and the daily brief.
    const src = join(root, 'two.sqlite');
    const d2 = new Database(src);
    d2.exec(`CREATE TABLE cron_jobs (agent_id TEXT, name TEXT, description TEXT, schedule_kind TEXT, schedule_expr TEXT,
      schedule_tz TEXT, every_ms INTEGER, at TEXT, payload_kind TEXT, payload_message TEXT, sort_order INTEGER, created_at_ms INTEGER)`);
    d2.prepare(`INSERT INTO cron_jobs (agent_id,name,schedule_kind,at,payload_kind,payload_message,sort_order,created_at_ms) VALUES (?,?,?,?,?,?,?,?)`)
      .run('garden-advisor', 'Reminder', 'at', '2026-12-01T12:00:00Z', 'agentTurn', 'new reminder', 0, 1);
    d2.prepare(`INSERT INTO cron_jobs (agent_id,name,schedule_kind,schedule_expr,schedule_tz,payload_kind,payload_message,sort_order,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('garden-advisor', 'Daily brief', 'cron', '0 8 * * *', 'America/Toronto', 'agentTurn', 'Write the brief', 1, 2);
    d2.close();
    // The agent already has a "Reminder" for November and a "Daily brief" with another prompt: two other tasks.
    const jobs = (reminderAt: string, briefMessage: string) => JSON.stringify({ jobs: [
      { id: 'j1', name: 'Reminder', enabled: false, schedule: { kind: 'at', at: reminderAt }, payload: { kind: 'agentTurn', message: 'unrelated reminder' } },
      { id: 'j2', name: 'Daily brief', enabled: false, schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'America/Toronto' }, payload: { kind: 'agentTurn', message: briefMessage } },
    ] });
    provider.execResponses.set('cron list', { code: 0, stdout: jobs('2026-11-01T12:00:00Z', 'Something else'), stderr: '' });
    const adds = () => provider.execLog.filter((a) => a[0] === 'cron' && a[1] === 'add');
    expect(await migrateCrons({ store, provider }, 'a1', join(root, 'ws-tech'), { configPath: cfg, dbPath: src, readyGapMs: 0 })).toEqual({ total: 2, carried: 2, failed: 0 });
    expect(adds().map((a) => a[a.indexOf('--name') + 1])).toEqual(['Reminder', 'Daily brief']);
    expect(adds()[0]).toEqual(expect.arrayContaining(['--at', '2026-12-01T12:00:00Z']));
    // Brought over, both are there as they were made: adopted again, neither is added twice (B37 still holds).
    provider.execResponses.set('cron list', { code: 0, stdout: JSON.stringify({ jobs: [
      { id: 'j3', name: 'Reminder', enabled: false, schedule: { kind: 'at', at: '2026-12-01T12:00:00Z' }, payload: { kind: 'agentTurn', message: 'new reminder' } },
      { id: 'j4', name: 'Daily brief', enabled: false, schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'America/Toronto' }, payload: { kind: 'agentTurn', message: 'Write the brief' } },
    ] }), stderr: '' });
    const before = adds().length;
    expect(await migrateCrons({ store, provider }, 'a1', join(root, 'ws-tech'), { configPath: cfg, dbPath: src, readyGapMs: 0 })).toEqual({ total: 2, carried: 2, failed: 0 });
    expect(adds().length).toBe(before);
  });

  /** A running agent "tech" and a 2026.9 source store holding `jobs` for garden-advisor. */
  async function adoptWorld(file: string, jobs: object[]) {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Tech', slug: 'tech', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'x', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'tech', workspace: { files: {}, configPatch: { agentId: 'tech', authMode: 'api-key' } }, env: {} });
    store.setAgentRuntimeRef('a1', runtimeRef);
    await provider.start(runtimeRef);
    store.setAgentState('a1', 'RUNNING');
    const src = join(root, file);
    const s = new Database(src);
    s.exec('CREATE TABLE cron_jobs (job_id TEXT, agent_id TEXT, declaration_key TEXT, job_json TEXT, updated_at INTEGER)');
    jobs.forEach((j, i) => s.prepare('INSERT INTO cron_jobs VALUES (?,?,?,?,?)').run(`s${i}`, 'garden-advisor', null, JSON.stringify(j), 1));
    s.close();
    const adopt = () => migrateCrons({ store, provider }, 'a1', join(root, 'ws-tech'), { configPath: cfg, dbPath: src, readyGapMs: 0 });
    const adds = () => provider.execLog.filter((a) => a[0] === 'cron' && a[1] === 'add');
    return { provider, adopt, adds };
  }

  it('a task there already for another recipient is another task, and is added (HB-0287)', async () => {
    const OTHER = ['55', '50', '0', '04'].join('');
    const brief = { name: 'Daily brief', schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { kind: 'agentTurn', message: 'Write the brief' } };
    const { provider, adopt, adds } = await adoptWorld('recipients.sqlite', [{ ...brief, sessionTarget: 'isolated', delivery: { mode: 'announce', channel: 'telegram', to: CHAT } }]);
    provider.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [
      { id: 'j1', enabled: false, ...brief, delivery: { mode: 'announce', channel: 'telegram', to: OTHER } },
    ] }) });
    expect(await adopt()).toEqual({ total: 1, carried: 1, failed: 0 });
    expect(adds()).toHaveLength(1);
    expect(adds()[0]).toEqual(expect.arrayContaining(['--channel', 'telegram', '--to', CHAT]));
    // The one brought over (its recipient written channel-qualified) is not added twice.
    provider.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [
      { id: 'j1', enabled: false, ...brief, delivery: { mode: 'announce', channel: 'telegram', to: OTHER } },
      { id: 'j2', enabled: false, ...brief, delivery: { mode: 'announce', channel: 'telegram', to: `telegram:${CHAT}` } },
    ] }) });
    expect(await adopt()).toEqual({ total: 1, carried: 1, failed: 0 });
    expect(adds()).toHaveLength(1);
  });

  it('a task bound to a conversation is bound to the same conversation of the adopted agent (HB-0288)', async () => {
    const { provider, adopt, adds } = await adoptWorld('bound.sqlite', [
      { name: 'Console brief', schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { kind: 'agentTurn', message: 'Write the brief' }, sessionTarget: 'current', sessionKey: 'agent:garden-advisor:main', delivery: { mode: 'announce' } },
      { name: 'Elsewhere', schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { kind: 'agentTurn', message: 'x' }, sessionTarget: 'current', sessionKey: 'agent:other-agent:main', delivery: { mode: 'announce' } },
    ]);
    // The second is bound to another agent's conversation: reported, not carried unbound.
    expect(await adopt()).toEqual({ total: 2, carried: 1, failed: 1 });
    expect(adds()).toHaveLength(1);
    expect(adds()[0]).toEqual(expect.arrayContaining(['--session', 'current', '--session-key', 'agent:tech:main']));
    // Its conversation is made sure of first, as for a task the app binds.
    const created = provider.execLog.find((a) => a[0] === 'gateway' && a[2] === 'sessions.create');
    expect(created && JSON.parse(created[4]!)).toEqual({ key: 'agent:tech:main', agentId: 'tech' });
  });

  it('a task on a custom conversation of its own (session:standup) is carried as it is (HB-0288)', async () => {
    const { adopt, adds } = await adoptWorld('custom.sqlite', [
      { name: 'Standup', schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { kind: 'agentTurn', message: 'Plan the day' }, sessionTarget: 'session:standup', delivery: { mode: 'none' } },
      { name: 'Mapped', schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { kind: 'agentTurn', message: 'Water the beds' }, sessionTarget: 'session:agent:garden-advisor:beds', delivery: { mode: 'none' } },
    ]);
    // OpenClaw scopes a key with no agent: prefix to the agent that runs it.
    expect(await adopt()).toEqual({ total: 2, carried: 2, failed: 0 });
    expect(adds()[0]).toEqual(expect.arrayContaining(['--session', 'session:standup']));
    expect(adds()[1]).toEqual(expect.arrayContaining(['--session', 'session:agent:tech:beds']));
  });
});
