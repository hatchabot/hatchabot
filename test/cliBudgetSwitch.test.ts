import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { budgetSwitchNote } from '../src/cli.js';

/**
 * HB-1299 on the CLI: a budget's switch to a cheaper model does not travel.
 * A download or a move carries the owner's own model (HB-1165), and no budget
 * holds the copy on the cheaper one, so `hatchabot download` and `hatchabot
 * rehost` say so. The real CLI runs in a child process against a made-up
 * server (test/support/cliFetchFixture.mjs), with a temporary HOME and a PATH
 * holding nothing.
 */

const sandbox = mkdtempSync(join(tmpdir(), 'hb-cli-budget-switch-'));
const emptyPath = mkdtempSync(join(sandbox, 'bin-'));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const AGENT = { id: 'agent-0002-test', name: 'Pantry Helper', slug: 'pantry-helper', state: 'RUNNING', botUsername: 'made_up_pantry_bot' };
const SWITCHED = { ...AGENT, budgetSwitch: { to: 'anthropic/claude-haiku-4-5', own: 'claude-opus-4-8', scope: 'agent' } };
const NOTE = 'note: its budget had switched it to claude-haiku-4-5; on the other machine it runs on your own model (claude-opus-4-8) if the AI source there offers it, else its default, until you set a budget on that machine.';

function cli(args: string[], agent: unknown, extra: unknown[]) {
  const routes = [
    { path: '/v1/config', reply: { authMode: 'accounts' } },
    { path: '/v1/agents', method: 'GET', reply: [agent] },
    ...extra,
  ];
  const r = spawnSync(process.execPath, ['--import', './test/support/cliFetchFixture.mjs', '--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 30_000,
    env: { HOME: mkdtempSync(join(sandbox, 'home-')), PATH: emptyPath, HATCHABOT_URL: 'http://made-up.invalid:8080', HATCHABOT_TOKEN: 'hatchabot_made-up-value', HB_CLI_FIXTURE: JSON.stringify(routes) },
  });
  expect(r.error).toBeUndefined();
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split('\n').filter((l) => l && !l.startsWith('FIXTURE_REQUEST '));
}
const rehost = (agent: unknown) => cli(['rehost', AGENT.name, 'Other Box'], agent, [
  { path: '/v1/peers', method: 'GET', reply: [{ id: 'peer-1', name: 'Other Box', url: 'https://other.example.invalid' }] },
  { path: `/v1/agents/${AGENT.id}/rehost`, method: 'POST', reply: { movedTo: 'Other Box', remoteAgentId: 'agent-0099-there', sourceState: 'STOPPED' } },
]);
const download = (agent: unknown) => {
  const out = join(mkdtempSync(join(sandbox, 'out-')), 'copy.hatchabot');
  const lines = cli(['download', AGENT.name, '--out', out], agent, [{ path: `/v1/agents/${AGENT.id}/backup`, method: 'GET', reply: { made: 'up' } }]);
  expect(existsSync(out)).toBe(true);
  return lines;
};

describe("a download or a move says a budget's cheaper model does not travel (HB-1299)", () => {
  it('rehost says so before it moves, and only when a switch has it', () => {
    const said = rehost(SWITCHED);
    expect(said[0]).toBe('rehosting "Pantry Helper" to Other Box…');
    expect(said[1]).toBe(NOTE);
    expect(rehost(AGENT)).not.toContain(NOTE);
  }, 60_000);

  it('download says so with its other notes, and only when a switch has it', () => {
    expect(download(SWITCHED)).toContain(NOTE);
    expect(download(AGENT).some((l) => l.includes('had switched it'))).toBe(false);
  }, 60_000);

  it("names this Hatchabot's budget when it was the machine's, and the source's default there when it has no model of its own", () => {
    expect(budgetSwitchNote({ budgetSwitch: { to: 'claude-haiku-4-5', own: 'claude-sonnet-5', scope: 'machine' } }))
      .toBe("note: this Hatchabot's budget had switched it to claude-haiku-4-5; on the other machine it runs on your own model (claude-sonnet-5) if the AI source there offers it, else its default, until you set a budget on that machine.");
    expect(budgetSwitchNote({ budgetSwitch: { to: 'claude-haiku-4-5', scope: 'agent' } }))
      .toBe("note: its budget had switched it to claude-haiku-4-5; on the other machine it runs on the default model of its AI source there until you set a budget on that machine.");
    expect(budgetSwitchNote({})).toBe('');
  });
});
