import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { archivedBotLine } from '../src/cli.js';

/**
 * HB-0476 on the CLI: `hatchabot archive` always said "its bot is back in the
 * pool", also when the bot could not be parked, was left to a downloaded copy,
 * or there was none. It now says what the server says happened (botReturn),
 * and the old line only to a server too old to say. The real CLI runs in a
 * child process against a made-up server (test/support/cliFetchFixture.mjs),
 * with a temporary HOME and a PATH holding nothing.
 */

const sandbox = mkdtempSync(join(tmpdir(), 'hb-cli-archive-'));
const emptyPath = mkdtempSync(join(sandbox, 'bin-'));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const AGENT = { id: 'agent-0001-test', name: 'Pantry Helper', slug: 'pantry-helper', state: 'RUNNING', botUsername: 'made_up_pantry_bot' };

function archive(reply: unknown) {
  const routes = [
    { path: '/v1/config', reply: { authMode: 'accounts' } },
    { path: '/v1/agents', method: 'GET', reply: [AGENT] },
    { path: `/v1/agents/${AGENT.id}/archive`, method: 'POST', reply },
  ];
  const r = spawnSync(process.execPath, ['--import', './test/support/cliFetchFixture.mjs', '--import', 'tsx', 'src/cli.ts', 'archive', AGENT.name, '--yes'], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 30_000,
    env: { HOME: mkdtempSync(join(sandbox, 'home-')), PATH: emptyPath, HATCHABOT_URL: 'http://made-up.invalid:8080', HATCHABOT_TOKEN: 'hatchabot_made-up-value', HB_CLI_FIXTURE: JSON.stringify(routes) },
  });
  expect(r.error).toBeUndefined();
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split('\n').filter((l) => l && !l.startsWith('FIXTURE_REQUEST ')).join('\n');
}

describe('hatchabot archive says where the bot went (HB-0476)', () => {
  it('a bot that could not be parked is said so, with what to do', () => {
    expect(archive({ ...AGENT, state: 'ARCHIVED', botReturn: { username: 'made_up_pantry_bot', outcome: 'not-parked' } }))
      .toBe('"Pantry Helper" archived — its bot @made_up_pantry_bot could not be put back in the pool; to use it again, paste its token into an agent.');
  }, 60_000);

  it('back in the pool, left to a copy, or no bot at all', () => {
    expect(archivedBotLine({ botReturn: { username: 'made_up_pantry_bot', outcome: 'pool' } })).toBe(' — its bot is back in the pool');
    expect(archivedBotLine({ botReturn: { username: 'made_up_pantry_bot', outcome: 'left-to-copy' } }))
      .toBe(' — bot @made_up_pantry_bot was left to the downloaded copy, not put back in the pool');
    expect(archivedBotLine({ botReturn: null })).toBe('');
  });

  it('a server too old to say gets the old line', () => {
    expect(archive({ ...AGENT, state: 'ARCHIVED' })).toBe('"Pantry Helper" archived — its bot is back in the pool.');
  }, 60_000);
});
