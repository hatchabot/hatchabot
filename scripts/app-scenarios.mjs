#!/usr/bin/env node
/**
 * Apps in agents, end to end on a live install (scripts/live.mjs runs it;
 * docs/apps-in-agents.md). A made-up app in a throwaway git repo — a scheduled
 * command that appends a line to its data folder every minute — is installed
 * into a web-only agent, then updated, offered a release whose tests fail,
 * rolled back and stopped. Each step is checked where it shows: the release
 * the agent runs, its OpenClaw command task, and the lines the task writes on
 * its own. No AI turns (command tasks run no model).
 *
 *   node scripts/app-scenarios.mjs [--keep]
 *
 * The agent is "zz app test …" and is deleted at the end unless --keep; the
 * repo is under ~/.cache (the service may not see this shell's /tmp).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { api, cleanupAgents, createAgent, hbt, inAgent, log, scenario, sleep, summary } from './live-lib.mjs';

const PREFIX = 'zz app test';
const APP = 'zztestapp';
const keep = process.argv.includes('--keep');
mkdirSync(join(homedir(), '.cache'), { recursive: true });
const repo = mkdtempSync(join(homedir(), '.cache', 'hb-app-test-'));
const DATA = `/home/node/.openclaw/apps/${APP}/data`;

const git = (...a) => {
  const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.org', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.org' } });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
/** One release of the app: `version` is what its task writes; `testsPass` false ships a failing test. */
function release(version, testsPass = true) {
  writeFileSync(join(repo, 'hatchabot.json'), JSON.stringify({
    app: APP, name: 'ZZ Test App', description: 'A made-up app for the live test.',
    test: ['python3', '-m', 'unittest', 'discover', '-s', 'tests'],
    env: { APP_DATA: '{data_dir}' },
    tasks: [{ name: 'tick', every: '1m', command: ['python3', 'tick.py'], timeoutSeconds: 60 }],
    config: { file: 'config.json', fields: [
      { key: 'greeting', label: 'a word the task writes', default: 'hello' },
      { key: 'agent_name', from: 'agent.name' },
    ] },
  }, null, 2));
  writeFileSync(join(repo, 'tick.py'), `import json, os
VERSION = ${JSON.stringify(version)}
data = os.environ["APP_DATA"]
cfg = json.load(open(os.path.join(data, "config.json")))
with open(os.path.join(data, "ticks.log"), "a") as f:
    f.write(f"{VERSION} {cfg.get('greeting')} {cfg.get('agent_name')}\\n")
`);
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'tests', 'test_tick.py'), `import unittest
class T(unittest.TestCase):
    def test_it(self):
        self.assertTrue(${testsPass ? 'True' : 'False'}, "a test made to fail")
`);
  git('add', '-A'); git('commit', '-q', '-m', version);
  return git('rev-parse', 'HEAD').slice(0, 12);
}
const status = async (agent) => (await api(`/v1/agents/${agent.id}/app`)).json.app;
/** The last lines its task wrote, waiting up to `secs` for `want` to appear. */
async function ticks(agent, want, secs = 180) {
  const deadline = Date.now() + secs * 1000;
  let out = '';
  while (Date.now() < deadline) {
    out = (await inAgent(agent, ['tail', '-n', '3', `${DATA}/ticks.log`])).out.trim();
    if (out.split('\n').at(-1)?.startsWith(want)) return { ok: true, out };
    await sleep(10_000);
  }
  return { ok: false, out };
}
const taskThere = async (agent) => (await inAgent(agent, ['openclaw', 'cron', 'list', '--all', '--json'])).out.includes(`${APP}-tick`);

async function main() {
  const existing = (await api('/v1/agents')).json.filter((a) => a.name?.startsWith(PREFIX));
  if (existing.length) throw new Error(`Test agents from an earlier run are still there: ${existing.map((a) => a.name).join(', ')} — delete them first.`);
  git('init', '-q', '-b', 'main');
  const v1 = release('v1');
  let agent;
  await scenario('P1 install: its tests pass in the agent, its task is set up, its config filled', async () => {
    agent = await createAgent(`${PREFIX} host`);
    const r = hbt(['app', 'install', agent.name, repo, 'greeting=hi']);
    const st = await status(agent);
    const cfg = (await inAgent(agent, ['cat', `${DATA}/config.json`])).out;
    return [
      [`installed: ${r.out.trim().split('\n').at(-1)}`, r.code === 0, r.out.slice(-300)],
      [`it runs ${String(st?.sha ?? '').slice(0, 12)}`, String(st?.sha ?? '').startsWith(v1)],
      ['its tests passed', st?.testOk === true],
      ['its command task is in OpenClaw', await taskThere(agent)],
      ['its config has the value asked for and the one filled in', cfg.includes('"hi"') && cfg.includes(agent.name)],
    ];
  });
  if (!agent) return;
  await scenario('P2 the task runs by itself, every minute', async () => {
    const t = await ticks(agent, `v1 hi ${agent.name}`);
    return [['it wrote "v1 hi …" on its own', t.ok, t.out]];
  });
  const v2 = release('v2');
  await scenario('P3 update: the new release switches in, its config is kept', async () => {
    const r = hbt(['app', 'update', agent.name]);
    const st = await status(agent);
    const t = await ticks(agent, `v2 hi ${agent.name}`);
    return [
      ['updated', r.code === 0, r.out.slice(-300)],
      [`it runs ${String(st?.sha ?? '').slice(0, 12)}`, String(st?.sha ?? '').startsWith(v2)],
      ['the task now writes "v2 hi …" (config kept)', t.ok, t.out],
    ];
  });
  const v3 = release('v3', false);
  await scenario('P4 a release whose tests fail is not switched in', async () => {
    const r = hbt(['app', 'update', agent.name]);
    const st = await status(agent);
    const t = await ticks(agent, 'v2', 90);
    return [
      ['the update is refused, naming the failed tests', r.code !== 0 && /test/i.test(r.out), r.out.slice(-300)],
      [`still on ${v2}, not ${v3}`, String(st?.sha ?? '').startsWith(v2)],
      ['the task still writes v2', t.ok, t.out],
    ];
  });
  await scenario('P5 roll back: the previous release runs again', async () => {
    const r = hbt(['app', 'rollback', agent.name]);
    const st = await status(agent);
    const t = await ticks(agent, `v1 hi ${agent.name}`);
    return [
      ['rolled back', r.code === 0, r.out.slice(-300)],
      [`it runs ${String(st?.sha ?? '').slice(0, 12)}`, String(st?.sha ?? '').startsWith(v1)],
      ['the task writes v1 again', t.ok, t.out],
    ];
  });
  await scenario('P6 stop the app: its task is gone, its data stays', async () => {
    const r = hbt(['app', 'remove', agent.name]);
    const gone = !(await taskThere(agent));
    const data = (await inAgent(agent, ['test', '-s', `${DATA}/ticks.log`])).code === 0;
    return [['stopped', r.code === 0, r.out.slice(-300)], ['its task is gone from OpenClaw', gone], ['its data is still there', data]];
  });
}

main()
  .catch((err) => log(`✗ ${err.message || err}`))
  .finally(async () => {
    if (!keep) await cleanupAgents(PREFIX);
    rmSync(repo, { recursive: true, force: true });
    process.exitCode = summary() ? 0 : 1;
  });
