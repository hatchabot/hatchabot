import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { agentsFilter, appSourceArg, pairingTargets, pickProfile } from '../src/cli.js';

/**
 * The deep audit of v2.166.2 (2026-10-24), the CLI's part of the runtime
 * group. The real CLI runs in a child process against a made-up server
 * (test/support/cliFetchFixture.mjs answers fetch and refuses anything
 * else), with a temporary HOME and a PATH holding nothing.
 */

const sandbox = mkdtempSync(join(tmpdir(), 'hb-cli-audit-'));
const emptyPath = mkdtempSync(join(sandbox, 'bin-'));
const work = mkdtempSync(join(sandbox, 'work-'));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

interface Route { path: string; method?: string; status?: number; reply?: unknown }
interface Seen { path: string; method: string; body?: any }
const base: Route[] = [{ path: '/v1/config', reply: { authMode: 'password' } }];

function cli(routes: Route[], args: string[]) {
  const home = mkdtempSync(join(sandbox, 'home-'));
  const r = spawnSync(process.execPath, ['--import', './test/support/cliFetchFixture.mjs', '--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 30_000,
    env: { HOME: home, PATH: emptyPath, HATCHABOT_URL: 'http://fixture.invalid', HATCHABOT_TOKEN: 'fixture-cli-value', HATCHABOT_CWD: work, HB_CLI_FIXTURE: JSON.stringify([...base, ...routes]) },
  });
  expect(r.error).toBeUndefined();
  const requests: Seen[] = r.stdout.split('\n').filter((l) => l.startsWith('FIXTURE_REQUEST ')).map((l) => JSON.parse(l.slice('FIXTURE_REQUEST '.length)));
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, requests };
}

const agents = [
  { id: 'a1', name: 'Homework Helper', slug: 'homework-helper', state: 'RUNNING', webOnly: true, role: 'owner', aiProfileId: 'p1' },
  { id: 'a2', name: 'Soccer Schedule', slug: 'soccer-schedule', state: 'RUNNING', botUsername: 'soccerfixturebot', role: 'owner', aiProfileId: 'p1' },
  { id: 'a3', name: 'Garden Notes', slug: 'garden-notes', state: 'RUNNING', botUsername: 'gardenfixturebot', role: 'member', aiProfileId: 'p1' },
  { id: 'a4', name: 'Recipe Box', slug: 'recipe-box', state: 'RUNNING', otherChannels: [{ kind: 'discord' }], role: 'owner', aiProfileId: 'p1' },
];
const profiles = [
  { id: 'p1', name: 'First source', mine: true, kind: 'api_key' },
  { id: 'p2', name: 'Default source', mine: true, kind: 'api_key', defaultSource: true },
];

describe('app inspect, install and create keep a git address as typed (audit #057)', () => {
  it('helper: addresses pass through; folders resolve from where the command was typed', () => {
    for (const url of ['https://example.org/fixture/app.git', 'ssh://git@example.org/fixture/app.git', 'git@example.org:fixture/app.git']) {
      expect(appSourceArg(url, '/srv/work', '/home/someone')).toBe(url);
    }
    expect(appSourceArg('apps/meal-plan', '/srv/work', '/home/someone')).toBe('/srv/work/apps/meal-plan');
    expect(appSourceArg('~/meal-plan', '/srv/work', '/home/someone')).toBe('/home/someone/meal-plan');
    expect(appSourceArg('/opt/meal-plan', '/srv/work', '/home/someone')).toBe('/opt/meal-plan');
  });

  it('the real commands send the address the server can clone', () => {
    const stop = { status: 400, reply: { error: 'fixture: stops here' } };
    for (const repo of ['https://example.org/fixture/app.git', 'git@example.org:fixture/app.git']) {
      for (const args of [['app', 'inspect', repo], ['app', 'install', 'Homework Helper', repo], ['app', 'create', 'Fixture App', repo]]) {
        const r = cli([{ path: '/v1/agents', method: 'GET', reply: agents }, { path: '/v1/apps/inspect', ...stop }, { path: '/v1/agents/a1/app', ...stop }], args);
        const sent = r.requests.find((x) => x.path === '/v1/apps/inspect' || x.path === '/v1/agents/a1/app');
        expect(sent?.body.source, args.join(' ')).toBe(repo);
      }
    }
    // A folder is still a folder, from the command's own directory.
    const r = cli([{ path: '/v1/apps/inspect', status: 400, reply: { error: 'fixture: stops here' } }], ['app', 'inspect', 'meal-plan']);
    expect(r.requests.find((x) => x.path === '/v1/apps/inspect')?.body.source).toBe(join(work, 'meal-plan'));
  }, 120_000);
});

describe('a bare `hatchabot pairing` asks only agents on a chat app (audit #058)', () => {
  it('helper: running agents of yours with a bot or another chat app', () => {
    expect(pairingTargets(agents).map((a) => a.id)).toEqual(['a2', 'a4']);
  });

  it('a web-only agent first in the list no longer stops the scan; one that lost its chat app is passed over', () => {
    const r = cli([
      { path: '/v1/agents', reply: agents },
      { path: '/v1/agents/a1/pairing', status: 404, reply: { error: 'Not found' } },
      { path: '/v1/agents/a2/pairing', status: 404, reply: { error: 'Not found' } },
      { path: '/v1/agents/a4/pairing', reply: [{ code: 'FIXTURE1', meta: { firstName: 'Visitor' } }] },
    ], ['pairing']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.some((x) => x.path === '/v1/agents/a1/pairing')).toBe(false);
    expect(r.requests.some((x) => x.path === '/v1/agents/a3/pairing')).toBe(false);
    expect(r.stdout).toContain('Recipe Box: Visitor wants to talk');
  }, 60_000);
});

describe('switch-source refuses an --agents list that names nobody (audit #059)', () => {
  it('helper: given and empty is a problem; not given is all', () => {
    expect(agentsFilter(new Map())).toEqual({});
    expect(agentsFilter(new Map([['agents', '']])).problem).toMatch(/names no agent/);
    expect(agentsFilter(new Map([['agents', ' , ']])).problem).toMatch(/names no agent/);
    expect(agentsFilter(new Map([['agents', 'a1, ,a2']])).names).toEqual(['a1', 'a2']);
  });

  it('the real command stops before switching anything', () => {
    for (const list of ['', ' , ']) {
      const r = cli([{ path: '/v1/ai-profiles', reply: profiles }, { path: '/v1/agents', reply: agents }, { path: '/v1/ai-profiles/p2/adopt-agents', reply: { switched: 2 } }], ['switch-source', '--to', 'p2', '--agents', list]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/--agents names no agent/);
      expect(r.requests.some((x) => x.path === '/v1/ai-profiles/p2/adopt-agents')).toBe(false);
    }
    // Left out: every agent of yours, as before (the server reads no list as all).
    const all = cli([{ path: '/v1/ai-profiles', reply: profiles }, { path: '/v1/ai-profiles/p2/adopt-agents', reply: { switched: 2 } }], ['switch-source', '--to', 'p2']);
    expect(all.status, all.stderr).toBe(0);
    expect(all.requests.find((x) => x.path === '/v1/ai-profiles/p2/adopt-agents')?.body.apply).toBeUndefined();
  }, 60_000);
});

describe('switch-source reads --to and --agents the way every other command does (HB-0354, HB-0355)', () => {
  const shared = [
    { id: 'p-theirs', name: 'Shared', mine: false, kind: 'api_key' },
    { id: 'p-mine', name: 'shared', mine: true, kind: 'api_key' },
  ];
  const adopt = (id: string): Route => ({ path: `/v1/ai-profiles/${id}/adopt-agents`, reply: { switched: 1 } });

  it('a name two sources share is refused with their ids, and nothing moves', () => {
    const r = cli([{ path: '/v1/ai-profiles', reply: shared }, adopt('p-theirs'), adopt('p-mine')], ['switch-source', '--to', 'shared']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/names 2 AI sources — use its id: p-theirs, p-mine/);
    expect(r.requests.some((x) => x.path.endsWith('/adopt-agents'))).toBe(false);
    // Its id picks it.
    const ok = cli([{ path: '/v1/ai-profiles', reply: shared }, adopt('p-mine')], ['switch-source', '--to', 'p-mine']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.requests.some((x) => x.path === '/v1/ai-profiles/p-mine/adopt-agents')).toBe(true);
    // An empty --to is a usage error, never the default source.
    const empty = cli([{ path: '/v1/ai-profiles', reply: profiles }, adopt('p2')], ['switch-source', '--to', ' ']);
    expect(empty.status).toBe(1);
    expect(empty.requests.some((x) => x.path.endsWith('/adopt-agents'))).toBe(false);
  }, 60_000);

  it('a whole id in --agents is its own agent, even with another named after it listed first', () => {
    const list = [
      { id: 'agent-y', name: 'agent-x', slug: 'agent-x', state: 'RUNNING', role: 'owner', aiProfileId: 'p1' },
      { id: 'agent-x', name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', role: 'owner', aiProfileId: 'p1' },
    ];
    const r = cli([{ path: '/v1/ai-profiles', reply: profiles }, { path: '/v1/agents', reply: list }, adopt('p2')], ['switch-source', '--to', 'p2', '--agents', 'agent-x']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.find((x) => x.path === '/v1/ai-profiles/p2/adopt-agents')?.body.apply).toEqual(['agent-x']);
  }, 60_000);

  it('a name two agents share, or one nobody has, stops the whole switch', () => {
    const twins = [...agents, { id: 'a5', name: 'homework helper', slug: 'homework-helper-2', state: 'RUNNING', role: 'owner', aiProfileId: 'p1' }];
    for (const [names, why] of [['HOMEWORK HELPER,Recipe Box', /names 2 agents/], ['Recipe Box,Nobody Here', /no agent matches "Nobody Here"/]] as const) {
      const r = cli([{ path: '/v1/ai-profiles', reply: profiles }, { path: '/v1/agents', reply: twins }, adopt('p2')], ['switch-source', '--to', 'p2', '--agents', names]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(why);
      expect(r.stderr).toMatch(/nothing was switched/);
      expect(r.requests.some((x) => x.path.endsWith('/adopt-agents'))).toBe(false);
    }
  }, 60_000);
});

describe('adopt puts the new agent on the default AI source (audit #060)', () => {
  it('the ⭐ default, wherever it sits in the list; --profile still wins', () => {
    expect(pickProfile(profiles).hit?.id).toBe('p2');
    const routes: Route[] = [
      { path: '/v1/workspaces/inspect', reply: { path: '/srv/fixture-workspace', markdownFiles: [], files: [], bytes: 0 } },
      { path: '/v1/ai-profiles', reply: profiles },
      { path: '/v1/hosts', reply: [{ id: 'h1', kind: 'local' }] },
      { path: '/v1/agents', method: 'POST', reply: { id: 'new-agent' } },
      { path: '/v1/agents/new-agent', reply: { id: 'new-agent', name: 'Fixture Agent', state: 'RUNNING' } },
      { path: '/v1/agents/new-agent/adopt-workspace', reply: { files: 0, bytes: 0 } },
    ];
    const r = cli(routes, ['adopt', '/srv/fixture-workspace', 'Fixture Agent', '--no-telegram']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.find((x) => x.path === '/v1/agents' && x.method === 'POST')?.body.aiProfileId).toBe('p2');
    const named = cli(routes, ['adopt', '/srv/fixture-workspace', 'Fixture Agent', '--no-telegram', '--profile', 'First source']);
    expect(named.requests.find((x) => x.path === '/v1/agents' && x.method === 'POST')?.body.aiProfileId).toBe('p1');
  }, 60_000);
});
