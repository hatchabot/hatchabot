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
} from '../src/orchestrator/transfer/cronImport.js';
import { WORKSPACE_DIR_TEMPLATE } from '../src/openclaw/configWriter.js';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { retargetImplicitCrons } from '../src/orchestrator/schedules/crons.js';

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

  /**
   * A running agent "tech" and a 2026.9 source store holding `jobs` for
   * garden-advisor, with the ids s0, s1, …. The gateway answers each add with
   * the copy it made (c1, c2, …), as `cron add --json` does; `refuse` fails an
   * add. `before`: the agent was there before adopts kept what they carried.
   * `rolledBack`: an older release made it, after the table was made (an
   * upgrade rolled back); the next start is this release's.
   */
  async function adoptWorld(file: string, jobs: object[], opts: { before?: boolean; rolledBack?: boolean; refuse?: (argv: string[]) => boolean } = {}) {
    const db = new Database(':memory:');
    let store = new Store(db);
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Tech', slug: 'tech', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'x', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    // A database from before the table: the next start makes it.
    if (opts.before) { db.exec('DROP TABLE adopt_carried_tasks'); store = new Store(db); }
    // The older release writes the agent and nothing of this table.
    if (opts.rolledBack) { db.prepare('DELETE FROM adopt_carried_tasks WHERE agent_id = ?').run('a1'); store = new Store(db); }
    let made = 0;
    const exec = provider.exec.bind(provider);
    provider.exec = async (ref, argv, o) => {
      const res = await exec(ref, argv, o);
      if (argv[0] !== 'cron' || argv[1] !== 'add') return res;
      if (opts.refuse?.(argv)) return { code: 1, stdout: '', stderr: 'refused' };
      return res.code === 0 && !res.stdout ? { ...res, stdout: JSON.stringify({ id: `c${++made}` }) } : res;
    };
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
    const list = (jobs: object[]) => provider.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs }) });
    return { db, store, provider, runtimeRef, adopt, adds, list };
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

  describe('which tasks an adopt carried, by their ids in the source (HB-0985)', () => {
    const brief = { schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { kind: 'agentTurn', message: 'Write the brief' } };
    const after = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
    /** The copy the gateway holds after `add`: its schedule and prompt, where the add put it, and `given` for the delivery OpenClaw gives one added with none. */
    function copyOf(id: string, task: Record<string, any>, add: string[], given?: Record<string, any>): Record<string, any> {
      const route = { channel: after(add, '--channel'), to: after(add, '--to'), accountId: after(add, '--account') };
      const delivery = add.includes('--no-deliver') ? { mode: 'none' }
        : add.includes('--announce') ? { mode: 'announce', ...Object.fromEntries(Object.entries(route).filter(([, v]) => v)) } : given;
      const copy: Record<string, any> = { id, enabled: false, name: task.name, ...brief, sessionTarget: after(add, '--session') };
      if (after(add, '--session-key')) copy.sessionKey = after(add, '--session-key');
      if (delivery) copy.delivery = delivery;
      return copy;
    }
    /** A task as the gateway holds it after `cron edit` with these arguments (the ones the sweep sends). */
    function edited(job: Record<string, any>, args: string[]): Record<string, any> {
      const out: Record<string, any> = { ...job, delivery: { ...job.delivery } };
      if (args.includes('--session')) out.sessionTarget = after(args, '--session');
      if (args.includes('--session-key')) out.sessionKey = after(args, '--session-key');
      if (args.includes('--clear-session-key')) delete out.sessionKey;
      if (args.includes('--announce')) out.delivery.mode = 'announce';
      if (args.includes('--channel')) out.delivery.channel = after(args, '--channel');
      if (args.includes('--to')) out.delivery.to = after(args, '--to');
      if (args.includes('--clear-channel')) delete out.delivery.channel;
      if (args.includes('--clear-to')) delete out.delivery.to;
      if (args.includes('--clear-account')) delete out.delivery.accountId;
      return out;
    }
    /**
     * Adopt one task; let the real sweep re-point its copy at `target`; adopt
     * again. `given`: the delivery OpenClaw gives a copy added with none.
     * Returns the adds of each adopt and the copy as the sweep left it.
     */
    async function adoptSweepAdopt(file: string, task: Record<string, any>, target: Parameters<typeof retargetImplicitCrons>[3], given?: Record<string, any>) {
      const { provider, runtimeRef, adopt, adds, list } = await adoptWorld(file, [task]);
      list([]);
      expect(await adopt()).toEqual({ total: 1, carried: 1, failed: 0 });
      const first = adds().length;
      const copy = copyOf('c1', task, adds()[0]!, given);
      list([copy]);
      provider.info = async () => ({ openclawVersion: '2026.9.8' }) as never;
      expect(await retargetImplicitCrons(provider, runtimeRef, 'tech', target)).toMatchObject({ changed: 1, failed: 0 });
      const swept = edited(copy, provider.execLog.filter((a) => a[0] === 'cron' && a[1] === 'edit').at(-1)!);
      list([swept]);
      expect(await adopt()).toEqual({ total: 1, carried: 1, failed: 0 });
      return { first, again: adds().length - first, swept };
    }

    it('reads each task\'s id in its source store', () => {
      const p = join(root, 'ids.sqlite');
      const s = new Database(p);
      s.exec('CREATE TABLE cron_jobs (job_id TEXT, agent_id TEXT, declaration_key TEXT, job_json TEXT, updated_at INTEGER)');
      s.prepare('INSERT INTO cron_jobs VALUES (?,?,?,?,?)').run('t-1', 'garden-advisor', null, JSON.stringify({ id: 't-1', name: 'A', ...brief }), 1);
      s.prepare('INSERT INTO cron_jobs VALUES (?,?,?,?,?)').run(null, 'garden-advisor', null, JSON.stringify({ id: 't-2', name: 'B', ...brief }), 1);
      s.close();
      expect(readOpenclawCronStore('garden-advisor', p, cfg).crons.map((c) => c.sourceId)).toEqual(['t-1', 't-2']);
      // The older store: by its id column, and none when it has none.
      const old = join(root, 'ids-old.sqlite');
      const o = new Database(old);
      o.exec(`CREATE TABLE cron_jobs (id TEXT, agent_id TEXT, name TEXT, description TEXT, schedule_kind TEXT, schedule_expr TEXT,
        schedule_tz TEXT, every_ms INTEGER, at TEXT, payload_kind TEXT, payload_message TEXT, sort_order INTEGER, created_at_ms INTEGER)`);
      o.prepare(`INSERT INTO cron_jobs (id,agent_id,name,schedule_kind,every_ms,payload_kind,payload_message,sort_order,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run('t-3', 'garden-advisor', 'C', 'every', 3_600_000, 'agentTurn', 'x', 0, 1);
      o.close();
      expect(readOpenclawCronStore('garden-advisor', old, cfg).crons.map((c) => c.sourceId)).toEqual(['t-3']);
      expect(readOpenclawCrons('garden-advisor', db).map((c) => c.sourceId)).toEqual([undefined]);
    });

    it('a task there already for another conversation or from another bot is another task, and is added', async () => {
      const bound = { name: 'Console brief', ...brief, sessionTarget: 'current', sessionKey: 'agent:garden-advisor:main', delivery: { mode: 'none' } };
      const sent = { name: 'Daily brief', ...brief, sessionTarget: 'isolated', delivery: { mode: 'announce', channel: 'telegram', to: CHAT, accountId: 'kitchenbot' } };
      const { store, adopt, adds, list } = await adoptWorld('bindings.sqlite', [bound, sent]);
      // The agent has both already, but on another of its conversations and from another of its bots.
      const others = [
        { id: 'x1', enabled: false, ...bound, sessionKey: 'agent:tech:standup' },
        { id: 'x2', enabled: false, ...sent, delivery: { ...sent.delivery, accountId: 'pantrybot' } },
      ];
      list(others);
      expect(await adopt()).toEqual({ total: 2, carried: 2, failed: 0 });
      expect(adds()).toHaveLength(2);
      expect(adds()[0]).toEqual(expect.arrayContaining(['--json', '--session-key', 'agent:tech:main']));
      expect(adds()[1]).toEqual(expect.arrayContaining(['--json', '--account', 'kitchenbot']));
      expect(store.carriedTasks('a1')).toEqual([
        { sourceAgent: 'garden-advisor', sourceId: 's0', copyId: 'c1' },
        { sourceAgent: 'garden-advisor', sourceId: 's1', copyId: 'c2' },
      ]);
      // Adopted again with the two it carried there beside the others: neither is added twice (B37).
      list([...others, copyOf('c1', bound, adds()[0]!), copyOf('c2', sent, adds()[1]!)]);
      expect(await adopt()).toEqual({ total: 2, carried: 2, failed: 0 });
      expect(adds()).toHaveLength(2);
    });

    it('two tasks alike but for their conversation are both carried, the one whose add failed on the retry', async () => {
      const a = { name: 'Daily brief', ...brief, sessionTarget: 'current', sessionKey: 'agent:garden-advisor:main' };
      const b = { ...a, sessionKey: 'agent:garden-advisor:standup' };
      let refuse = true;
      const { adopt, adds, list } = await adoptWorld('alike.sqlite', [a, b], { refuse: (argv) => refuse && argv.includes('agent:tech:main') });
      list([]);
      expect(await adopt()).toEqual({ total: 2, carried: 1, failed: 1 });
      refuse = false;
      const first = adds().length;
      list([copyOf('c1', b, adds()[1]!)]);
      expect(await adopt()).toEqual({ total: 2, carried: 2, failed: 0 });
      expect(adds().slice(first)).toHaveLength(1);
      expect(adds()[first]).toEqual(expect.arrayContaining(['--session-key', 'agent:tech:main']));
      // Both there now: a third adopt adds nothing.
      list([copyOf('c1', b, adds()[1]!), copyOf('c2', a, adds()[first]!)]);
      expect(await adopt()).toEqual({ total: 2, carried: 2, failed: 0 });
      expect(adds()).toHaveLength(first + 1);
    });

    it('a task from another bot than the copy there is added on a retry, though it names no recipient', async () => {
      // The same brief from two of its bots, each to whoever wrote last.
      const fromA = { name: 'Daily brief', ...brief, sessionTarget: 'isolated', delivery: { mode: 'announce', channel: 'telegram', accountId: 'kitchenbot' } };
      const fromB = { ...fromA, delivery: { ...fromA.delivery, accountId: 'pantrybot' } };
      let refuse = true;
      const { adopt, adds, list } = await adoptWorld('two-bots.sqlite', [fromA, fromB], { refuse: (argv) => refuse && argv.includes('kitchenbot') });
      list([]);
      // The first adopt carried only B's (A's add failed): the retry adds A's, and B's once.
      expect(await adopt()).toEqual({ total: 2, carried: 1, failed: 1 });
      refuse = false;
      const first = adds().length;
      list([copyOf('c1', fromB, adds()[1]!)]);
      expect(await adopt()).toEqual({ total: 2, carried: 2, failed: 0 });
      expect(adds().slice(first).map((x) => after(x, '--account'))).toEqual(['kitchenbot']);
    });

    it('a recorded copy gone is added again, and never counted as another task\'s copy', async () => {
      const a = { name: 'Daily brief', ...brief, sessionTarget: 'current', sessionKey: 'agent:garden-advisor:main' };
      const b = { ...a, sessionKey: 'agent:garden-advisor:standup' };
      const { adopt, adds, list } = await adoptWorld('gone.sqlite', [a, b]);
      list([]);
      expect(await adopt()).toEqual({ total: 2, carried: 2, failed: 0 });
      // The owner deleted A's copy; B's looks just like it but for its conversation.
      list([copyOf('c2', b, adds()[1]!)]);
      expect(await adopt()).toEqual({ total: 2, carried: 2, failed: 0 });
      expect(adds()).toHaveLength(3);
      expect(adds()[2]).toEqual(expect.arrayContaining(['--session-key', 'agent:tech:main']));
    });

    it('a task the sweep pointed at the console after an adopt is not added again by the next adopt', async () => {
      const task = { name: 'Daily brief', ...brief, sessionTarget: 'isolated', delivery: { mode: 'announce' } };
      const { first, again, swept } = await adoptSweepAdopt('swept-console.sqlite', task, { session: 'agent:tech:main' });
      // The sweep bound it to the console conversation: another session than the one it came with.
      expect(swept).toMatchObject({ sessionTarget: 'current', sessionKey: 'agent:tech:main' });
      expect([first, again]).toEqual([1, 0]);
    });

    it('a bound task the sweep pointed at the owner\'s chat after an adopt is not added again by the next adopt', async () => {
      const task = { name: 'Console brief', ...brief, sessionTarget: 'current', sessionKey: 'agent:garden-advisor:main', delivery: { mode: 'announce' } };
      const { first, again, swept } = await adoptSweepAdopt('swept-chat.sqlite', task, { channel: 'telegram', to: CHAT });
      // The sweep unbound it to announce in the owner's chat.
      expect(swept).toMatchObject({ sessionTarget: 'isolated', delivery: { mode: 'announce', channel: 'telegram', to: CHAT } });
      expect(swept.sessionKey).toBeUndefined();
      expect([first, again]).toEqual([1, 0]);
    });

    // OpenClaw gives an agent turn or command added with no delivery, on any target but main, `announce`.
    it('an isolated task with no delivery of its own, which OpenClaw gives one the sweep re-points, is not added again', async () => {
      const task = { name: 'Daily brief', ...brief, sessionTarget: 'isolated' };
      const { first, again, swept } = await adoptSweepAdopt('no-delivery-isolated.sqlite', task, { session: 'agent:tech:main' }, { mode: 'announce' });
      expect(swept).toMatchObject({ sessionTarget: 'current', sessionKey: 'agent:tech:main' });
      expect([first, again]).toEqual([1, 0]);
    });

    it('a task on a conversation of its own with no delivery, swept to the console of an agent in no chat app, is not added again', async () => {
      const task = { name: 'Daily brief', ...brief, sessionTarget: 'session:agent:garden-advisor:standup' };
      const { first, again, swept } = await adoptSweepAdopt('no-delivery-session.sqlite', task, { session: 'agent:tech:main' }, { mode: 'announce' });
      expect(swept).toMatchObject({ sessionTarget: 'current', sessionKey: 'agent:tech:main' });
      expect([first, again]).toEqual([1, 0]);
    });

    it('a bound task with no delivery, swept to the owner\'s chat, is not added again', async () => {
      const task = { name: 'Daily brief', ...brief, sessionTarget: 'current', sessionKey: 'agent:garden-advisor:main' };
      const { first, again, swept } = await adoptSweepAdopt('no-delivery-current.sqlite', task, { channel: 'telegram', to: CHAT }, { mode: 'announce' });
      expect(swept).toMatchObject({ sessionTarget: 'isolated', delivery: { mode: 'announce', channel: 'telegram', to: CHAT } });
      expect(swept.sessionKey).toBeUndefined();
      expect([first, again]).toEqual([1, 0]);
    });

    it('a task with no delivery of its own, which the sweep leaves alone, is added beside a copy on another conversation', async () => {
      const bound = { name: 'Console brief', ...brief, sessionTarget: 'current', sessionKey: 'agent:garden-advisor:main' };
      const { provider, runtimeRef, adopt, adds, list } = await adoptWorld('no-delivery.sqlite', [bound]);
      // The agent has it already, on another of its conversations, and the sweep would not touch that copy.
      list([{ id: 'x1', enabled: false, ...bound, sessionKey: 'agent:tech:standup' }]);
      provider.info = async () => ({ openclawVersion: '2026.9.8' }) as never;
      expect(await retargetImplicitCrons(provider, runtimeRef, 'tech', { session: 'agent:tech:main' })).toMatchObject({ changed: 0 });
      expect(await adopt()).toEqual({ total: 1, carried: 1, failed: 0 });
      expect(adds()).toHaveLength(1);
      expect(adds()[0]).toEqual(expect.arrayContaining(['--session-key', 'agent:tech:main']));
    });

    it('on an agent from before these were kept, a copy an older adopt made is matched as before and never added twice', async () => {
      const task = { name: 'Daily brief', ...brief, sessionTarget: 'isolated', delivery: { mode: 'announce' } };
      const { store, adopt, adds, list } = await adoptWorld('before.sqlite', [task], { before: true });
      expect(store.mayHoldUnrecordedCarriedTasks('a1')).toBe(true);
      // The older adopt's copy, which the sweep has since pointed at the console.
      list([{ id: 'x1', enabled: false, ...task, sessionTarget: 'current', sessionKey: 'agent:tech:main' }]);
      expect(await adopt()).toEqual({ total: 1, carried: 1, failed: 0 });
      expect(adds()).toHaveLength(0);
      expect(store.carriedTasks('a1')).toEqual([{ sourceAgent: 'garden-advisor', sourceId: 's0', copyId: 'x1' }]);
      // An agent made since is not one of them; a deleted agent's rows go with it.
      store.insertAgent({ id: 'a2', ownerId: 'o', name: 'Garden', slug: 'garden', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'x', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
      expect(store.mayHoldUnrecordedCarriedTasks('a2')).toBe(false);
      store.scrubAgentResidue('a1');
      expect(store.carriedTasks('a1')).toEqual([]);
      expect(store.mayHoldUnrecordedCarriedTasks('a1')).toBe(false);
    });

    it('an agent an older release made after a rollback is marked at the next start, and its older copy matched by look', async () => {
      const task = { name: 'Daily brief', ...brief, sessionTarget: 'isolated', delivery: { mode: 'announce' } };
      // This release ran (the table is there), then the older one made the agent and adopted into it.
      const { db, store, adopt, adds, list } = await adoptWorld('rolled-back.sqlite', [task], { rolledBack: true });
      expect(store.mayHoldUnrecordedCarriedTasks('a1')).toBe(true);
      // The older adopt's copy, as it carried it: not added a second time.
      list([{ id: 'x1', enabled: false, ...task }]);
      expect(await adopt()).toEqual({ total: 1, carried: 1, failed: 0 });
      expect(adds()).toHaveLength(0);
      expect(store.carriedTasks('a1')).toEqual([{ sourceAgent: 'garden-advisor', sourceId: 's0', copyId: 'x1' }]);
      // One this release made is not taken for an older release's at a start.
      store.insertAgent({ id: 'a2', ownerId: 'o', name: 'Garden', slug: 'garden', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'x', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
      new Store(db);
      expect(store.mayHoldUnrecordedCarriedTasks('a2')).toBe(false);
      expect(store.carriedTasks('a2')).toEqual([]);
    });

    it('a copy the gateway gave no id for is found by look, and added again once its owner deleted it', async () => {
      const task = { name: 'Daily brief', ...brief, sessionTarget: 'isolated', delivery: { mode: 'announce' } };
      const { store, provider, adopt, adds, list } = await adoptWorld('no-id-answer.sqlite', [task]);
      // A gateway that answers the add with no id it can read.
      provider.execResponses.set('cron add', { code: 0, stderr: '', stdout: 'Added.\n' });
      list([]);
      expect(await adopt()).toEqual({ total: 1, carried: 1, failed: 0 });
      expect(store.carriedTasks('a1')).toEqual([{ sourceAgent: 'garden-advisor', sourceId: 's0' }]);
      // Its owner deleted it: the next adopt adds it again.
      list([]);
      expect(await adopt()).toEqual({ total: 1, carried: 1, failed: 0 });
      expect(adds()).toHaveLength(2);
      // There: found by look, and its id kept for the adopts after.
      list([{ id: 'x2', enabled: false, ...task }]);
      expect(await adopt()).toEqual({ total: 1, carried: 1, failed: 0 });
      expect(adds()).toHaveLength(2);
      expect(store.carriedTasks('a1')).toEqual([{ sourceAgent: 'garden-advisor', sourceId: 's0', copyId: 'x2' }]);
    });

    it('in one run, a copy matched to one task is not then matched to a second alike but for its conversation', async () => {
      const b = { name: 'Daily brief', ...brief, sessionTarget: 'current', sessionKey: 'agent:garden-advisor:standup' };
      const a = { ...b, sessionKey: 'agent:garden-advisor:main' };
      for (const [name, order] of [['ba', [b, a]], ['ab', [a, b]]] as const) {
        const { store, adopt, adds, list } = await adoptWorld(`one-run-${name}.sqlite`, [...order], { before: true });
        // The older adopt carried only B's (A's add failed then).
        list([{ id: 'xb', enabled: false, ...b, sessionKey: 'agent:tech:standup' }]);
        expect(await adopt(), name).toEqual({ total: 2, carried: 2, failed: 0 });
        expect(adds(), name).toHaveLength(1);
        expect(adds()[0], name).toEqual(expect.arrayContaining(['--session-key', 'agent:tech:main']));
        expect(store.carriedTasks('a1'), name).toContainEqual({ sourceAgent: 'garden-advisor', sourceId: `s${order.indexOf(b)}`, copyId: 'xb' });
      }
    });

    it('in one run, a task naming its recipient takes the copy for it before one naming none takes any', async () => {
      const ownerChat = ['55', '50', '0', '09'].join(''); // made up
      const a = { name: 'Daily brief', ...brief, sessionTarget: 'isolated', delivery: { mode: 'announce' } };
      const b = { ...a, delivery: { mode: 'announce', channel: 'telegram', to: CHAT } };
      const { adopt, adds, list } = await adoptWorld('named-first.sqlite', [a, b], { before: true });
      // The older adopt's two copies: B's, and A's since pointed at the owner's chat by the sweep.
      list([
        { id: 'xb', enabled: false, ...b },
        { id: 'xa', enabled: false, ...a, delivery: { mode: 'announce', channel: 'telegram', to: ownerChat } },
      ]);
      expect(await adopt()).toEqual({ total: 2, carried: 2, failed: 0 });
      expect(adds()).toHaveLength(0);
    });

    it('a copy from another bot is not the task\'s: in either order, only the task whose copy is missing is added', async () => {
      const a = { name: 'Daily brief', ...brief, sessionTarget: 'isolated', delivery: { mode: 'announce', channel: 'telegram', accountId: 'kitchenbot' } };
      const b = { ...a, delivery: { ...a.delivery, accountId: 'pantrybot' } };
      for (const [name, order] of [['ab', [a, b]], ['ba', [b, a]]] as const) {
        const { adopt, adds, list } = await adoptWorld(`bots-${name}.sqlite`, [...order], { before: true });
        // The older adopt carried only B's (A's add failed then).
        list([{ id: 'xb', enabled: false, ...b }]);
        expect(await adopt(), name).toEqual({ total: 2, carried: 2, failed: 0 });
        expect(adds().map((x) => after(x, '--account')), name).toEqual(['kitchenbot']);
      }
    });

    it('a copy the sweep re-pointed, like two tasks alike but for their conversation, is not given to either: nothing is added', async () => {
      const a = { name: 'Daily brief', ...brief, sessionTarget: 'current', sessionKey: 'agent:garden-advisor:main', delivery: { mode: 'announce' } };
      const b = { ...a, sessionKey: 'agent:garden-advisor:standup' };
      const { sessionKey: _key, ...unbound } = b;
      for (const [name, order] of [['ab', [a, b]], ['ba', [b, a]]] as const) {
        const { adopt, adds, list } = await adoptWorld(`swept-alike-${name}.sqlite`, [...order], { before: true });
        // B's copy, since pointed at the owner's chat: nothing in it says whose it was.
        list([{ id: 'xb', enabled: false, ...unbound, sessionTarget: 'isolated', delivery: { mode: 'announce', channel: 'telegram', to: CHAT } }]);
        expect(await adopt(), name).toEqual({ total: 2, carried: 2, failed: 0 });
        expect(adds(), name).toHaveLength(0);
      }
    });

    it('a task naming its recipient with no session of its own takes the copy for it, beside one naming none', async () => {
      const ownerChat = ['55', '50', '0', '09'].join(''); // made up
      const a = { name: 'Daily brief', ...brief, sessionTarget: 'isolated', delivery: { mode: 'announce' } };
      const b = { name: 'Daily brief', ...brief, delivery: { mode: 'announce', channel: 'telegram', to: CHAT } };
      // Both copies there (A's since pointed at the owner's chat): nothing is added.
      const both = await adoptWorld('named-no-session.sqlite', [a, b], { before: true });
      both.list([
        { id: 'xb', enabled: false, ...b, sessionTarget: 'isolated' },
        { id: 'xa', enabled: false, ...a, delivery: { mode: 'announce', channel: 'telegram', to: ownerChat } },
      ]);
      expect(await both.adopt()).toEqual({ total: 2, carried: 2, failed: 0 });
      expect(both.adds()).toHaveLength(0);
      // Only B's: B takes it, and A, whose copy is gone, is added.
      const one = await adoptWorld('named-no-session-one.sqlite', [a, b], { before: true });
      one.list([{ id: 'xb', enabled: false, ...b, sessionTarget: 'isolated' }]);
      expect(await one.adopt()).toEqual({ total: 2, carried: 2, failed: 0 });
      expect(one.adds()).toHaveLength(1);
      expect(one.adds()[0]).not.toContain('--to');
    });

    it('tasks carried from a store that gives them no ids are matched as before once it does', async () => {
      // The older store: no task ids. Its tasks are carried, and none can be recorded.
      const old = join(root, 'no-ids.sqlite');
      const o = new Database(old);
      o.exec(`CREATE TABLE cron_jobs (agent_id TEXT, name TEXT, description TEXT, schedule_kind TEXT, schedule_expr TEXT,
        schedule_tz TEXT, every_ms INTEGER, at TEXT, payload_kind TEXT, payload_message TEXT, session_target TEXT, delivery_mode TEXT,
        sort_order INTEGER, created_at_ms INTEGER)`);
      o.prepare(`INSERT INTO cron_jobs (agent_id,name,schedule_kind,every_ms,payload_kind,payload_message,session_target,delivery_mode,sort_order,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('garden-advisor', 'Daily brief', 'every', 3_600_000, 'agentTurn', 'Write the brief', 'isolated', 'announce', 0, 1);
      o.close();
      const task = { name: 'Daily brief', ...brief, sessionTarget: 'isolated', delivery: { mode: 'announce' } };
      const { store, provider, adopt, adds, list } = await adoptWorld('with-ids.sqlite', [task]);
      list([]);
      expect(await migrateCrons({ store, provider }, 'a1', join(root, 'ws-tech'), { configPath: cfg, dbPath: old, readyGapMs: 0 })).toEqual({ total: 1, carried: 1, failed: 0 });
      expect(store.carriedTasks('a1')).toEqual([]);
      expect(store.mayHoldUnrecordedCarriedTasks('a1')).toBe(true);
      // Its OpenClaw upgraded, the same task has an id now: adopted again, it is not added twice.
      list([{ ...copyOf('c1', task, adds()[0]!), sessionTarget: 'current', sessionKey: 'agent:tech:main' }]);
      expect(await adopt()).toEqual({ total: 1, carried: 1, failed: 0 });
      expect(adds()).toHaveLength(1);
      expect(store.carriedTasks('a1')).toEqual([{ sourceAgent: 'garden-advisor', sourceId: 's0', copyId: 'c1' }]);
    });
  });
});
