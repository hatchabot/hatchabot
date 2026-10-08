#!/usr/bin/env node
/**
 * An agent's own browser, end to end on a live install (scripts/live.mjs runs
 * it; docs/browser.md). A web-only test agent gets its browser switched on;
 * OpenClaw's browser tool then opens and reads a real page through it. Its
 * isolation is checked (none of the agent's files, its memory limit, not
 * reachable from the machine), it follows an agent restart, and switching it
 * off removes it. No AI turns: the browser is driven with `openclaw browser`.
 *
 *   node scripts/browser-scenarios.mjs [--keep]
 *
 * The agent is "zz browser test …" and is deleted at the end unless --keep.
 * (example.org does not resolve on every network; a real page is used.)
 */
import { spawnSync } from 'node:child_process';
import { api, cleanupAgents, createAgent, hbt, inAgent, log, scenario, settle, sleep, summary } from './live-lib.mjs';

const PREFIX = 'zz browser test';
const keep = process.argv.includes('--keep');
const PAGE = 'https://www.iana.org/help/example-domains';
const docker = (...a) => { const r = spawnSync('docker', a, { encoding: 'utf8', timeout: 120_000 }); return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }; };
const containerOf = (a) => String(a.runtimeRef || '').replace(/^docker:\/\//, '');

/** Wait until its browser runs (the sweep starts it within a minute of the agent). */
async function browserUp(agent, secs = 150) {
  for (let i = 0; i < secs / 5; i++) {
    const b = (await api(`/v1/agents/${agent.id}/browser`)).json;
    if (b.running) return true;
    await sleep(5000);
  }
  return false;
}
/** OpenClaw's browser tool, through the agent: open the page and read it back. */
async function reads(agent) {
  await inAgent(agent, ['openclaw', 'browser', 'open', PAGE], 120_000);
  await sleep(3000);
  const snap = await inAgent(agent, ['openclaw', 'browser', 'snapshot'], 120_000);
  return { ok: /Example Domains/i.test(snap.out), out: snap.out.slice(0, 300) };
}
/** Switch it, and wait for the rebuild that applies it. */
async function setBrowser(agent, on) {
  const r = await api(`/v1/agents/${agent.id}`, { method: 'PATCH', body: { browser: on } });
  if (r.status >= 300) throw new Error(`switch: ${r.status} ${JSON.stringify(r.json)}`);
  await sleep(8000);
  return settle(agent.id, 'RUNNING', 15);
}

async function main() {
  const existing = (await api('/v1/agents')).json.filter((a) => a.name?.startsWith(PREFIX));
  if (existing.length) throw new Error(`Test agents from an earlier run are still there: ${existing.map((a) => a.name).join(', ')} — delete them first.`);
  let agent = await createAgent(`${PREFIX} agent`);
  await scenario('B0 off by default: no browser, and the tool is off', async () => {
    const st = await inAgent(agent, ['openclaw', 'browser', 'status', '--json'], 120_000);
    const b = (await api(`/v1/agents/${agent.id}/browser`)).json;
    return [['the agent has no browser', !b.on && !b.running], ['OpenClaw\'s browser tool is off', /"enabled":\s*false/.test(st.out), st.out.slice(0, 200)]];
  });
  await scenario('B1 switched on: its browser starts, and the agent opens and reads a real page with it', async () => {
    agent = await setBrowser(agent, true);
    const up = await browserUp(agent);
    const r = up ? await reads(agent) : { ok: false, out: '' };
    return [['its browser is running', up], ['it opened and read the page', r.ok, r.out]];
  });
  await scenario('B2 isolated: none of the agent\'s files, its own memory limit, unreachable from the machine', async () => {
    const name = `${containerOf(agent)}-browser`;
    const files = docker('exec', name, 'ls', '/home/node/.openclaw');
    const mem = docker('inspect', name, '--format', '{{.HostConfig.Memory}}').out.trim();
    const net = docker('inspect', name, '--format', '{{.HostConfig.NetworkMode}}').out.trim();
    const fromHost = spawnSync('curl', ['-s', '-m', '3', 'http://127.0.0.1:9222/json/version'], { encoding: 'utf8' });
    return [
      ['the agent\'s files are not in it', files.code !== 0],
      [`its memory limit (${mem} bytes)`, Number(mem) === 1024 ** 3],
      [`it lives in the agent's network (${net})`, net === `container:${containerOf(agent)}`],
      ['the machine itself cannot reach it', !/webSocketDebuggerUrl/.test(fromHost.stdout ?? '')],
    ];
  });
  await scenario('B3 the agent restarts: its browser follows, and still works', async () => {
    const before = docker('inspect', `${containerOf(agent)}-browser`, '--format', '{{.Id}}').out.trim();
    const s = hbt(['stop', agent.name, '--wait']), t = hbt(['start', agent.name, '--wait']);
    agent = await settle(agent.id, 'RUNNING', 10);
    const up = await browserUp(agent);
    const after = docker('inspect', `${containerOf(agent)}-browser`, '--format', '{{.Id}}').out.trim();
    const r = up ? await reads(agent) : { ok: false, out: '' };
    return [
      ['stopped and started', s.code === 0 && t.code === 0, `${s.out} ${t.out}`.slice(-200)],
      ['a new browser, in its new network', up && !!after && after !== before],
      ['it still opens and reads the page', r.ok, r.out],
    ];
  });
  await scenario('B4 switched off: its browser is gone and the tool is off', async () => {
    agent = await setBrowser(agent, false);
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) { gone = docker('inspect', `${containerOf(agent)}-browser`).code !== 0; if (!gone) await sleep(5000); }
    const st = await inAgent(agent, ['openclaw', 'browser', 'status', '--json'], 120_000);
    return [['its browser container is gone', gone], ['OpenClaw\'s browser tool is off', /"enabled":\s*false/.test(st.out), st.out.slice(0, 200)]];
  });
}

main()
  .catch((err) => log(`✗ ${err.message || err}`))
  .finally(async () => {
    if (!keep) await cleanupAgents(PREFIX);
    process.exitCode = summary() ? 0 : 1;
  });
