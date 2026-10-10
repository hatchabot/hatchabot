#!/usr/bin/env node
/**
 * Copies of an agent, end to end on a live install (scripts/live.mjs runs it):
 * clone, a template shared with its memory and imported, and a download that
 * is restored after the agent was deleted (the disaster path). Each copy must
 * run, be web-only when asked, and still find by MEANING a note written into
 * the original (a query that shares no word with it). No AI turns.
 *
 *   node scripts/transfer-scenarios.mjs [--keep]
 *
 * Every agent it makes is named "zz transfer test …" and deleted at the end
 * unless --keep; the files it writes go in a temporary folder.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, byName, cleanupAgents, createAgent, hbt, inAgent, log, putFile, recalls, requireRoom, requireVersion, scenario, settle, summary, workspaceOf } from './live-lib.mjs';

const PREFIX = 'zz transfer test';
const keep = process.argv.includes('--keep');
const work = mkdtempSync(join(tmpdir(), 'hb-transfer-'));

// Made-up facts; each query shares no word with its note.
const DAILY = { file: 'zz-transfer-daily', text: 'Tuesday we planted three rows of garlic beside the greenhouse door.', query: 'which bulbs went into the ground near the glass building' };
const LONG = { text: 'The family reunion is always held at the lakeside cabin in late July.', query: 'where do the relatives gather each summer' };

async function main() {
  // Web-only clones and imports came in 2.150.0: before it, a clone took a
  // free pool bot (2026-10-08). This test must never take one.
  await requireVersion('2.150.0');
  const existing = (await api('/v1/agents')).json.filter((a) => a.name?.startsWith(PREFIX));
  if (existing.length) throw new Error(`Test agents from an earlier run are still there: ${existing.map((a) => a.name).join(', ')} — delete them first.`);
  await requireRoom(3); // it makes 3 agents at once — say so before making any
  let src;
  await scenario('T0 set up: an agent with a daily note and a line in MEMORY.md', async () => {
    src = await createAgent(`${PREFIX} source`);
    await putFile(src, `.openclaw/agents/${src.slug}/agent/memory`, `${DAILY.file}.md`, `# Daily note\n\n${DAILY.text}\n`);
    await putFile(src, `.openclaw/agents/${src.slug}/agent`, 'MEMORY.md', `# Memory\n\n- ${LONG.text}\n`);
    const r = await recalls(src, DAILY.file, DAILY.query);
    const m = await recalls(src, 'MEMORY.md', LONG.query);
    return [['it finds its daily note by meaning', r.ok, r.detail], ['and its MEMORY.md line', m.ok, m.detail]];
  });
  if (!src) return;

  await scenario('T1 clone, web-only: a faithful copy that finds both, and takes no bot', async () => {
    const r = await api(`/v1/agents/${src.id}/clone`, { method: 'POST', body: { name: `${PREFIX} clone`, telegram: false } });
    if (r.status !== 201) return [[`clone: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`, false]];
    const c = await settle(r.json.id, 'RUNNING', 25);
    const d = await recalls(c, DAILY.file, DAILY.query), m = await recalls(c, 'MEMORY.md', LONG.query);
    const still = await recalls(src, DAILY.file, DAILY.query);
    return [
      ['the clone runs', c.state === 'RUNNING'],
      ['web-only: no Telegram link', !c.deepLink],
      ['it finds the daily note', d.ok, d.detail],
      ['and the MEMORY.md line', m.ok, m.detail],
      ['the original still finds it too', still.ok, still.detail],
    ];
  });

  await scenario('T2 a template shared with its memory, imported web-only: MEMORY.md came, the daily notes did not', async () => {
    const file = join(work, 'shared.template.hatchabot');
    const s = hbt(['share', src.name, '--out', file, '--include-memory']);
    if (s.code !== 0 || !existsSync(file)) return [[`share: ${s.out.slice(-300)}`, false]];
    const i = hbt(['import', file, '--name', `${PREFIX} import`, '--no-telegram']);
    if (i.code !== 0) return [[`import: ${i.out.slice(-300)}`, false]];
    const made = await byName(`${PREFIX} import`);
    if (!made) return [['the imported agent is listed', false]];
    const a = await settle(made.id, 'RUNNING', 25);
    const m = await recalls(a, 'MEMORY.md', LONG.query);
    const daily = await inAgent(a, ['test', '-e', `${workspaceOf(a)}/memory/${DAILY.file}.md`]);
    return [
      ['the import runs', a.state === 'RUNNING'],
      ['web-only: no Telegram link', !a.deepLink],
      ['it finds the MEMORY.md line', m.ok, m.detail],
      ['the daily notes stayed behind (a template carries MEMORY.md only)', daily.code !== 0],
    ];
  });

  await scenario('T3 download, delete, restore: the same agent comes back with its memory', async () => {
    const file = join(work, 'full.hatchabot');
    const d = hbt(['download', src.name, '--out', file]);
    if (d.code !== 0 || !existsSync(file)) return [[`download: ${d.out.slice(-300)}`, false]];
    const del = await api(`/v1/agents/${src.id}`, { method: 'DELETE' });
    if (del.status >= 300) return [[`delete: ${del.status}`, false]];
    // The delete finishes in the background: the name is free once it is gone.
    for (let i = 0; i < 60 && (await byName(src.name)); i++) await new Promise((r) => setTimeout(r, 2000));
    const r = hbt(['restore', file]);
    if (r.code !== 0) return [[`restore: ${r.out.slice(-300)}`, false]];
    const back = await byName(src.name);
    if (!back) return [['restored under its own name', false]];
    const a = await settle(back.id, 'RUNNING', 25);
    const dn = await recalls(a, DAILY.file, DAILY.query), m = await recalls(a, 'MEMORY.md', LONG.query);
    return [
      ['restored under its own name, running', a.state === 'RUNNING'],
      ['it finds the daily note', dn.ok, dn.detail],
      ['and the MEMORY.md line', m.ok, m.detail],
    ];
  });
}

main()
  .catch((err) => log(`✗ ${err.message || err}`))
  .finally(async () => {
    if (!keep) await cleanupAgents(PREFIX);
    rmSync(work, { recursive: true, force: true });
    process.exitCode = summary() ? 0 : 1;
  });
