import { describe, expect, it } from 'vitest';
import { runFolders, fmtHealth, fmtUsage, fmtFleetUsage, type FoldersIo } from '../src/cli.js';

/**
 * The `folders` command's real logic — especially the rm branch that must route
 * a legacy shared-path removal to a PATCH but a data-source removal to a DELETE.
 * A regression here fails silently (prints "removed", removes nothing).
 */

function harness(agent: any) {
  const calls: Array<[string, string, unknown?, string?]> = [];
  const logs: string[] = [];
  const gitReply = { dataSources: [{ kind: 'git', mountName: 'defs', pubKey: 'ssh-ed25519 AAAAKEY' }] };
  const io: FoldersIo = {
    resolveAgent: async () => agent,
    jsonPost: async (path, body, method) => {
      calls.push(['post', path, body, method]);
      return { json: async () => gitReply };
    },
    apiDelete: async (path) => { calls.push(['delete', path]); },
    log: (m) => { logs.push(m); },
    fail: (m) => { throw new Error(m); },
    resolvePath: (raw) => raw, // identity in tests
  };
  const flags = (...on: string[]) => ({ has: (k: string) => on.includes(k) });
  return { io, calls, logs, flags };
}

const AGENT = {
  id: 'a1', name: 'Kitchen',
  sharedPaths: ['/home/me/docs', '/home/me/other'],
  dataSources: [
    { id: 'ds1', kind: 'folder', access: 'ro', mountName: 'notes', hostPath: '/home/me/notes', legacy: false },
    { id: 'ds2', kind: 'git', access: 'rw', mountName: 'defs', repoUrl: 'git@github.com:o/defs.git', legacy: false },
    { id: 'legacy:/home/me/docs', kind: 'folder', access: 'ro', mountName: 'docs', hostPath: '/home/me/docs', legacy: true },
  ],
};

describe('runFolders', () => {
  it('lists all data sources, tagging legacy ones', async () => {
    const { io, logs, flags } = harness(AGENT);
    await runFolders(io, ['Kitchen'], flags());
    const out = logs.join('\n');
    expect(out).toMatch(/ro folder\s+notes/);
    expect(out).toMatch(/rw git\s+defs/);
    expect(out).toMatch(/docs.*\(legacy\)/);
  });

  it('reports an empty fleet cleanly', async () => {
    const { io, logs, flags } = harness({ id: 'a1', name: 'Bare', dataSources: [] });
    await runFolders(io, ['Bare'], flags());
    expect(logs.join('\n')).toMatch(/no data sources/);
  });

  it('add posts a folder data source with the chosen access', async () => {
    const { io, calls, flags } = harness(AGENT);
    await runFolders(io, ['Kitchen', 'add', '/home/me/x'], flags('rw'));
    expect(calls).toContainEqual(['post', '/v1/agents/a1/data-sources', { kind: 'folder', access: 'rw', path: '/home/me/x' }, undefined]);
  });

  it('add-repo posts a git source and prints the deploy key', async () => {
    const { io, calls, logs, flags } = harness(AGENT);
    await runFolders(io, ['Kitchen', 'add-repo', 'git@github.com:o/r.git'], flags());
    expect(calls).toContainEqual(['post', '/v1/agents/a1/data-sources', { kind: 'git', access: 'ro', repoUrl: 'git@github.com:o/r.git' }, undefined]);
    expect(logs.join('\n')).toMatch(/ssh-ed25519 AAAAKEY/);
  });

  it('add-repo --public posts public:true and prints no key; --public with --rw is refused', async () => {
    const { io, calls, logs, flags } = harness(AGENT);
    await runFolders(io, ['Kitchen', 'add-repo', 'https://github.com/hatchabot/hatchabot'], flags('public'));
    expect(calls).toContainEqual(['post', '/v1/agents/a1/data-sources', { kind: 'git', access: 'ro', repoUrl: 'https://github.com/hatchabot/hatchabot', public: true }, undefined]);
    expect(logs.join('\n')).toMatch(/No deploy key needed/);
    await expect(runFolders(io, ['Kitchen', 'add-repo', 'https://github.com/o/r'], flags('public', 'rw'))).rejects.toThrow(/read-only/);
  });

  it('rm of a DATA SOURCE issues a DELETE by id', async () => {
    const { io, calls, flags } = harness(AGENT);
    await runFolders(io, ['Kitchen', 'rm', 'notes'], flags());
    expect(calls).toContainEqual(['delete', '/v1/agents/a1/data-sources/ds1']);
  });

  it('rm of a LEGACY folder PATCHes sharedPaths with just that path removed', async () => {
    const { io, calls, flags } = harness(AGENT);
    await runFolders(io, ['Kitchen', 'rm', 'docs'], flags());
    expect(calls).toContainEqual(['post', '/v1/agents/a1', { sharedPaths: ['/home/me/other'] }, 'PATCH']);
  });

  it('rm of an unknown name fails rather than silently no-op', async () => {
    const { io, flags } = harness(AGENT);
    await expect(runFolders(io, ['Kitchen', 'rm', 'nope'], flags())).rejects.toThrow(/no data source named/);
  });

  it('--none clears the legacy folder list', async () => {
    const { io, calls, flags } = harness(AGENT);
    await runFolders(io, ['Kitchen'], flags('none'));
    expect(calls).toContainEqual(['post', '/v1/agents/a1', { sharedPaths: [] }, 'PATCH']);
  });

  it('rejects an unknown subcommand', async () => {
    const { io, flags } = harness(AGENT);
    await expect(runFolders(io, ['Kitchen', 'wat'], flags())).rejects.toThrow(/unknown subcommand/);
  });
});

describe('fmtHealth / fmtUsage (CLI parity output)', () => {
  it('summarizes a healthy probe with its Telegram state', () => {
    const out = fmtHealth('Kitchen', { status: 'healthy', reachable: true, telegram: { connected: true, lastError: null } });
    expect(out).toMatch(/Kitchen: responding/);
    expect(out).toMatch(/telegram: connected/);
  });

  it('surfaces a degraded probe with the last error and reasons', () => {
    const out = fmtHealth('Kitchen', {
      status: 'degraded', reachable: true,
      telegram: { connected: false, lastError: 'auth failed' },
      eventLoop: { degraded: true, reasons: ['lag'] },
      pluginErrors: ['telegram: boom'],
    });
    expect(out).toMatch(/degraded/);
    expect(out).toMatch(/disconnected \(auth failed\)/);
    expect(out).toMatch(/event loop: degraded — lag/);
    expect(out).toMatch(/plugin errors: telegram: boom/);
  });

  it('renders usage by model, and an empty state', () => {
    const out = fmtUsage('Kitchen', { totalTokens: 1_500_000, sessions: 3, byModel: [{ model: 'claude-opus-4-8', tokens: 1_500_000 }] });
    expect(out).toMatch(/1\.5M tokens · 3 sessions/);
    expect(out).toMatch(/claude-opus-4-8\s+1\.5M/);
    expect(fmtUsage('Bare', { sessions: 0, byModel: [] })).toMatch(/no sessions yet/);
  });

  it('renders the fleet rollup ranked, with cost cells, a total and a live-only note', () => {
    const out = fmtFleetUsage({
      agents: [
        { name: 'Den', totalTokens: 9000, sessions: 1, billing: 'api', cost: { low: 0.045, high: 0.225, partial: false }, byModel: [{ model: 'claude-opus-4-8' }] },
        { name: 'Kitchen', totalTokens: 1750, sessions: 3, billing: 'included', cost: null, byModel: [{ model: 'claude-opus-4-8' }, { model: 'claude-sonnet-5' }] },
      ],
      totalTokens: 10750, totalSessions: 4, counted: 2, skipped: 1,
      cost: { low: 0.045, high: 0.225, partial: false, agents: 1 },
    });
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/Den/); // top consumer first
    expect(lines[0]).toMatch(/\$0.04–\$0.23/); // its cost range
    expect(lines[1]).toMatch(/Kitchen/);
    expect(lines[1]).toMatch(/incl\./); // subscription agent → no per-token cost
    expect(out).toMatch(/claude-opus-4-8 \+1/); // "+N other models" hint
    expect(out).toMatch(/2 running, 1 not counted — live-only/);
    expect(out).toMatch(/est\. API cost across 1 API-keyed agent: \$0.04–\$0.23/);
    expect(fmtFleetUsage({ agents: [], skipped: 2 })).toMatch(/2 stopped — usage is live-only/);
  });
});
