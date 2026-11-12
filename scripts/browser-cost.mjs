#!/usr/bin/env node
/**
 * What an agent's browser costs in tokens, with OpenClaw's default page reads
 * against its "efficient" ones (HB-0676; docs/browser.md). A measurement, not
 * a test: scripts/live.mjs does not list it, and it gates nothing. It SPENDS
 * AI TURNS on the install's default AI source: three tasks, each done once
 * per mode (six turns by default; a browsing turn has cost 315,000 tokens).
 *
 *   node scripts/browser-cost.mjs [--runs <n>] [--only read,form,path] [--modes default,efficient] [--out <file>] [--keep]
 *
 * --only and --modes finish a run cut short without paying again for the
 * turns it did.
 *
 * A web-only test agent, "zz browser cost …", gets its browser switched on.
 * Per mode it sets (or removes) browser.snapshotDefaults.mode in the agent
 * and restarts it; per task it reads the agent's usage, runs one turn in a
 * fresh conversation, and reads the usage again. The agent does nothing
 * else, so the difference is that turn's. The agent is deleted at the end
 * unless --keep.
 *
 * Each task's answer is checked: a cheaper mode that fails the task is not
 * cheaper. The pages are public and were read on 2026-11-11.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { api, cleanupAgents, createAgent, hbt, inAgent, log, requireRoom, settle, sleep } from './live-lib.mjs';

const PREFIX = 'zz browser cost';
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const keep = argv.includes('--keep');
const runs = Math.max(1, Math.min(5, Number(flag('--runs') ?? 1) || 1));
const only = flag('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const onlyModes = flag('--modes')?.split(',').map((s) => s.trim()).filter(Boolean);
const outFile = flag('--out');

const WITH = 'Use your browser tool for this, not web search and not web fetch. ';
export const TASKS = [
  {
    key: 'read', what: 'read a page',
    ask: `${WITH}Open https://www.iana.org/help/example-domains and tell me the numbers of the two RFCs that page names.`,
    ok: (reply) => /2606/.test(reply) && /6761/.test(reply),
  },
  {
    key: 'form', what: 'fill in a form',
    ask: `${WITH}Open https://httpbin.org/forms/post. Type "Robin Vale" as the customer name, choose the pizza size Medium, tick the topping Onion, and submit the order. Then tell me exactly what the next page shows for custname, size and topping.`,
    ok: (reply) => /Robin Vale/.test(reply) && /medium/i.test(reply) && /onion/i.test(reply),
    // The request names all three, so the answer alone proves little: the
    // browser must also be on the page the form posts to.
    verify: async (agent) => /httpbin\.org\/post(\s|$)/m.test((await inAgent(agent, ['openclaw', 'browser', 'tabs'], 120_000)).out),
  },
  {
    key: 'path', what: 'follow a link and read',
    ask: `${WITH}Open https://www.iana.org/help/example-domains, click its link "IANA-managed Reserved Domains" (click it; do not type the address), and tell me the reserved test domain that page lists for Japanese: the name that starts with xn--.`,
    ok: (reply) => /xn--zckzah/i.test(reply),
  },
];
export const MODES = [
  { key: 'default', set: ['openclaw', 'config', 'unset', 'browser.snapshotDefaults'] },
  { key: 'efficient', set: ['openclaw', 'config', 'set', 'browser.snapshotDefaults.mode', 'efficient'] },
];

/** The reply's text out of `openclaw agent --json`, or the raw output when it is not JSON. */
export function replyText(out) {
  const start = out.indexOf('{');
  if (start < 0) return out;
  try {
    const found = [];
    const walk = (v, key) => {
      if (typeof v === 'string') { if (/^(text|reply|content|message|output)$/i.test(key ?? '')) found.push(v); return; }
      if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(JSON.parse(out.slice(start, out.lastIndexOf('}') + 1)));
    return found.length ? found.join('\n') : out;
  } catch { return out; }
}

/** What one turn used: the difference of two usage reads. */
export function used(before, after) {
  const d = (k) => Math.max(0, (Number(after?.[k]) || 0) - (Number(before?.[k]) || 0));
  return { tokens: d('totalTokens'), input: d('input'), output: d('output'), cacheRead: d('cacheRead'), cacheWrite: d('cacheWrite'), calls: d('calls') };
}

const n = (x) => x.toLocaleString('en-US');
/** The results as a Markdown table, with the totals per mode. */
export function table(rows) {
  const lines = ['| Task | Reads | Done | Model calls | Tokens | fresh in | out | cache read | cache write | Seconds |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const r of rows) lines.push(`| ${r.what} | ${r.mode} | ${r.ok ? 'yes' : 'NO'} | ${n(r.calls)} | ${n(r.tokens)} | ${n(r.input)} | ${n(r.output)} | ${n(r.cacheRead)} | ${n(r.cacheWrite)} | ${r.seconds} |`);
  for (const m of MODES) {
    const mine = rows.filter((r) => r.mode === m.key);
    if (!mine.length) continue;
    const sum = (k) => mine.reduce((s, r) => s + r[k], 0);
    lines.push(`| **all tasks** | **${m.key}** | ${mine.filter((r) => r.ok).length} of ${mine.length} | ${n(sum('calls'))} | **${n(sum('tokens'))}** | ${n(sum('input'))} | ${n(sum('output'))} | ${n(sum('cacheRead'))} | ${n(sum('cacheWrite'))} | ${sum('seconds')} |`);
  }
  return lines.join('\n');
}

async function usage(agent) {
  const r = await api(`/v1/agents/${agent.id}/usage`);
  if (r.status >= 300) throw new Error(`usage: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json;
}
async function browserUp(agent, secs = 180) {
  for (let i = 0; i < secs / 5; i++) {
    if ((await api(`/v1/agents/${agent.id}/browser`)).json.running) return true;
    await sleep(5000);
  }
  return false;
}

async function main() {
  const tasks = TASKS.filter((t) => !only || only.includes(t.key));
  if (!tasks.length) throw new Error(`--only names no task (${TASKS.map((t) => t.key).join(', ')})`);
  const modes = MODES.filter((m) => !onlyModes || onlyModes.includes(m.key));
  if (!modes.length) throw new Error(`--modes names no mode (${MODES.map((m) => m.key).join(', ')})`);
  const existing = (await api('/v1/agents')).json.filter((a) => a.name?.startsWith(PREFIX));
  if (existing.length) throw new Error(`An agent from an earlier run is still there: ${existing.map((a) => a.name).join(', ')}. Delete it first.`);
  await requireRoom(1);
  log(`${tasks.length} task(s) × ${modes.length} mode(s) × ${runs} run(s) = ${tasks.length * modes.length * runs} AI turns on the default AI source`);
  let agent = await createAgent(`${PREFIX} ${Date.now().toString(36)}`);
  const on = await api(`/v1/agents/${agent.id}`, { method: 'PATCH', body: { browser: true } });
  if (on.status >= 300) throw new Error(`browser on: ${on.status} ${JSON.stringify(on.json)}`);
  await sleep(8000);
  agent = await settle(agent.id, 'RUNNING', 15);

  const rows = [];
  for (let run = 1; run <= runs; run++) {
    // The second run the other way round: whichever mode goes first pays for a cold prompt cache.
    for (const mode of run % 2 ? modes : [...modes].reverse()) {
      const set = await inAgent(agent, mode.set, 120_000);
      if (set.code !== 0 && mode.key !== 'default') throw new Error(`${mode.key}: ${set.out.slice(-300)}`);
      // A restart, not a rebuild: the setting is read when its gateway starts, and a rebuild would write Hatchabot's own again.
      const s = hbt(['stop', agent.name, '--wait']), t = hbt(['start', agent.name, '--wait']);
      if (s.code !== 0 || t.code !== 0) throw new Error(`restart: ${`${s.out} ${t.out}`.slice(-300)}`);
      agent = await settle(agent.id, 'RUNNING', 10);
      if (!(await browserUp(agent))) throw new Error('its browser did not start');
      // Right after a start its settings can be locked a while ("undergoing offline maintenance", 2026-11-12).
      let held;
      for (let i = 0; i < 12; i++) {
        held = await inAgent(agent, ['openclaw', 'config', 'get', 'browser'], 120_000);
        if (!/offline maintenance|could not be read/.test(held.out)) break;
        await sleep(10_000);
      }
      const efficient = /"mode":\s*"efficient"/.test(held.out);
      if (efficient !== (mode.key === 'efficient')) throw new Error(`the agent does not hold the ${mode.key} setting: ${held.out.slice(0, 300)}`);
      for (const task of tasks) {
        const before = await usage(agent);
        // Right after the restart its gateway may not answer yet (the first
        // run, 2026-11-12: "Gateway not reachable … ECONNREFUSED", 0 tokens).
        // Such a try reached no model, so it is tried again.
        let turn, began;
        for (let i = 0; i < 8; i++) {
          began = Date.now();
          turn = await inAgent(agent, ['openclaw', 'agent', '--agent', agent.slug, '--session-id', `cost-${mode.key}-${task.key}-${run}-${Date.now().toString(36)}`,
            '--message', task.ask, '--json', '--timeout', '600'], 660_000);
          if (!/Gateway not reachable|ECONNREFUSED/.test(turn.out)) break;
          await sleep(15_000);
        }
        const seconds = Math.round((Date.now() - began) / 1000);
        await sleep(3000); // the last call's row is written as the turn ends
        const u = used(before, await usage(agent));
        const reply = replyText(turn.out);
        const there = task.verify ? await task.verify(agent).catch(() => false) : true;
        const row = { task: task.key, what: task.what, mode: mode.key, run, ok: turn.code === 0 && task.ok(reply) && there, seconds, ...u };
        rows.push(row);
        log(`${row.ok ? '✓' : '✗'} ${task.key} / ${mode.key}: ${n(u.tokens)} tokens in ${u.calls} call(s), ${seconds} s${row.ok ? '' : ` — ${reply.slice(-300).replace(/\s+/g, ' ')}`}`);
      }
      // HB-0678 on the way: what the mode's conversations left open, before the next restart replaces the browser.
      const tabs = (await inAgent(agent, ['openclaw', 'browser', 'tabs'], 120_000)).out.match(/\[use: /g)?.length ?? '?';
      const mem = spawnSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', `${String(agent.runtimeRef || '').replace(/^docker:\/\//, '')}-browser`], { encoding: 'utf8', timeout: 60_000 }).stdout?.trim() || '?';
      log(`after the ${mode.key} tasks: ${tabs} tab(s) open, browser memory ${mem}`);
    }
  }
  const md = table(rows);
  console.log(`\n${md}\n`);
  const tot = (key) => rows.filter((r) => r.mode === key).reduce((s, r) => s + r.tokens, 0);
  const done = (key) => rows.filter((r) => r.mode === key && r.ok).length;
  const d = tot('default'), e = tot('efficient');
  if (d > 0 && e > 0) console.log(`efficient used ${Math.round((e / d) * 100)}% of the default's tokens; tasks done: default ${done('default')}, efficient ${done('efficient')}, of ${rows.length / modes.length} each.`);
  if (outFile) { writeFileSync(outFile, `${md}\n`); log(`written to ${outFile}`); }
  if (rows.some((r) => r.tokens === 0)) throw new Error('a turn shows no tokens: the usage read did not see it, so the numbers above are not to be trusted');
}

// Imported by its test for the pure parts; run only as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  let failed = false;
  main()
    .catch((err) => { failed = true; log(`✗ ${err.message || err}`); })
    .finally(async () => {
      if (!keep) await cleanupAgents(PREFIX);
      process.exitCode = failed ? 1 : 0;
    });
}
