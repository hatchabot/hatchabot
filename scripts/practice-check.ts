/**
 * The candidate gate's practice turn (scripts/candidate-gate.sh, HB-1418):
 * may Practice run on the OpenClaw a candidate image carries?
 *
 * Practice counts what a run spent from the transcript `agent exec --state-dir`
 * keeps in the run's own folder, which the usage sampler never reads: counted
 * once (src/orchestrator/skills/skillTrials.ts, HB-0933). Where a release keeps
 * it was read in PRACTICE_OPENCLAW alone, so Practice runs on no other. This
 * runs one practice, of the Writing skill on its sample, in the agent's
 * container with the candidate's release let in, and checks both halves: the
 * run's calls are in its state folder, where Practice reads them, and none of
 * them is in the agent's own usage as the sampler reads it, by their event
 * ids, nor did that usage rise at all meanwhile (a copy under other ids, or
 * a call that carries none). When both
 * hold on another release, a Hatchabot release may move PRACTICE_OPENCLAW to
 * it; this never moves it.
 *
 *   node_modules/.bin/tsx scripts/practice-check.ts <container> <agent slug> <OpenClaw release> [--ask-at <ms>] [--settle-ms <ms>]
 *
 * --ask-at: when the agent's last turn began (the gate's ask, just before),
 * which the usage reader must see before a quiet usage can mean anything.
 * --settle-ms: how long after the run ends the agent's own usage must stay as
 * it was, read again then (8000 by default): a release could copy the run
 * there a moment after it ends.
 *
 * One model turn, on the agent's own AI source. Exit 0 when both hold, 1 when
 * either does not, 3 when it could not tell, 2 for a wrong call. The last line
 * is what the gate says of Practice as it ends: that it may move to this
 * release, or that it stays where it is, and why. The gate only warns: a
 * release Practice does not run on leaves Practice refusing itself there, in
 * words of its own, not the image unready (HB-1418).
 */
import { spawnSync } from 'node:child_process';
import { CURATED_SKILLS } from '../src/openclaw/skills.js';
import { PRACTICE_OPENCLAW, skillTrialScript, type PracticeSpent } from '../src/orchestrator/skills/skillTrials.js';
import { USAGE_READER_SCRIPT } from '../src/orchestrator/usage/usage.js';

const [container, slug, release, ...flags] = process.argv.slice(2);
/** Each flag at most once, with a whole number of milliseconds. */
const flagged: Record<string, number> = {};
for (let i = 0; i < flags.length; i += 2) {
  const [name, ms] = [flags[i]!, flags[i + 1] ?? ''];
  if (!['--ask-at', '--settle-ms'].includes(name) || name in flagged || !/^\d{1,15}$/.test(ms)) { flagged['bad'] = 1; break; }
  flagged[name] = Number(ms);
}
if (!container || !slug || !release || 'bad' in flagged) {
  console.error('usage: node_modules/.bin/tsx scripts/practice-check.ts <container> <agent slug> <OpenClaw release> [--ask-at <ms>] [--settle-ms <ms>]');
  process.exit(2);
}
const askAt = flagged['--ask-at'];
const settleMs = flagged['--settle-ms'] ?? 8000;
const end = (code: 0 | 1 | 3, words: string): never => { console.log(words); process.exit(code); };
const P = PRACTICE_OPENCLAW;
/** Both hold: Practice may run on this release. */
const holds = (how: string): never => end(0, release === P
  ? `Practice holds on OpenClaw ${release}, the release it runs on: ${how}`
  : `Practice may move to OpenClaw ${release}: ${how}. A Hatchabot release may now move PRACTICE_OPENCLAW (src/orchestrator/skills/skillTrials.ts) from ${P} to ${release}`);
/** One does not: Practice stays where it is, or, on the release it runs on, counts wrong there. */
const fails = (why: string): never => end(1, release === P
  ? `Practice runs on OpenClaw ${P} and counts it wrong there: ${why}. That is Practice's to fix (src/orchestrator/skills/skillTrials.ts), not this image's`
  : `Practice stays on OpenClaw ${P}: ${why}`);
/** Nothing tells: Practice stays where it is. */
const unknown = (why: string): never => end(3, `Practice stays on OpenClaw ${P}: could not check: ${why}`);
const tail = (s: string) => s.trim().split('\n').slice(-1)[0]!.slice(0, 200);
type Parts = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number };
const tokens = (p: Parts) => p.input + p.output + p.cacheRead + p.cacheWrite;
const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);

/**
 * The agent's own usage as the sampler reads it (usage.ts USAGE_READER_SCRIPT),
 * summed over its models, and the event ids of the calls it counted (--ids).
 */
function ownUsage(when: string): { sum: Parts; ids: Set<string>; last: number } {
  const r = spawnSync('docker', ['exec', container!, 'node', '-e', USAGE_READER_SCRIPT, '--', '--ids'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  let read: { models?: Record<string, Partial<Parts>>; ids?: unknown; last?: unknown } | undefined;
  try { read = r.status === 0 ? JSON.parse(r.stdout) : undefined; } catch { /* below */ }
  if (!read || !read.models || typeof read.models !== 'object' || !Array.isArray(read.ids)) unknown(`could not read the agent's own usage ${when} the practice: ${tail(r.stderr || r.error?.message || `exit ${r.status}`) || 'no answer'}`);
  const sum: Parts = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of Object.values(read!.models!)) for (const k of Object.keys(sum) as (keyof Parts)[]) sum[k] += count(m?.[k]);
  return { sum, ids: new Set((read!.ids as unknown[]).map(String)), last: count(read!.last) };
}

/** The agent's heartbeat setting, as `openclaw config get` gives it: off is "0m" (configWriter.ts). */
function heartbeatOff(): boolean {
  const r = spawnSync('docker', ['exec', container!, 'openclaw', 'config', 'get', 'agents.defaults.heartbeat.every'], { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 && /^"?0[a-z]*"?$/.test(r.stdout.trim());
}

const skill = CURATED_SKILLS.find((s) => s.id === 'hatchabot-writing')!;
const practice = (expiresAt: number) => skillTrialScript({ slug }, { id: skill.id, content: skill.content }, expiresAt, { release });
// A release it cannot be run on is refused before anything is asked of the container.
try { practice(Date.now() + 75_000); }
catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }

const before = ownUsage('before');
// A quiet usage means nothing from a reader that sees none of this release's
// transcripts: it must see the agent's turns, the gate's ask among them (review, L2).
if (!before.sum.calls) unknown(`the usage reader sees none of this agent's turns on OpenClaw ${release}`);
if (askAt !== undefined && before.last < askAt) unknown(`the usage reader does not see this agent's last turn, the gate's ask, on OpenClaw ${release}`);
// Its 75 s from now: the read above can take a minute of them (review, L1).
const script = practice(Date.now() + 75_000);
// Over stdin, as Practice runs it (execShell's secret mode, localDockerProvider.ts stdinScript):
// one brace group, read whole before anything runs.
const run = spawnSync('docker', ['exec', '-i', container, 'bash', '-s'], { input: `{\n${script}\n} </dev/null\n`, encoding: 'utf8', timeout: 85_000, maxBuffer: 1024 * 1024 });
const after = ownUsage('after');
let value: { status?: unknown; openclaw?: unknown; spent?: unknown; spentFrom?: unknown; spentIds?: unknown } | undefined;
try { value = run.status === 0 ? JSON.parse(run.stdout) : undefined; } catch { /* below */ }
if (!value || typeof value !== 'object') unknown(`the practice did not run (${run.error ? run.error.message : `exit ${run.status}`}): ${tail(run.stderr) || 'no answer'}`);
const status = String(value!.status);

if (status === 'unsupported') {
  unknown(typeof value!.openclaw === 'string'
    ? `the agent's container runs OpenClaw ${value!.openclaw}, not ${release}: nothing was run`
    : 'Practice cannot run on this agent\'s model (it has none, or a CLI harness runs it rather than OpenClaw itself): nothing was run. Run the gate again with --profile and an AI source OpenClaw runs itself');
}
// Only a run that finished tells where a finished one is kept: a release that
// copies a run into the agent's own transcripts as it ends is never caught by
// one cut short (review, L1).
if (status !== 'completed' && status !== 'not_observed') {
  unknown(`the practice did not finish (${status}), and a run cut short tells nothing of where a finished one is kept. Check the agent's AI source, then run the gate again`);
}
const spent = (Array.isArray(value!.spent) ? value!.spent : []) as PracticeSpent[];
const ran: Parts = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
for (const m of spent) for (const k of Object.keys(ran) as (keyof Parts)[]) ran[k] += count(m?.[k]);
if (value!.spentFrom !== 'state') {
  fails(`the run's transcript is not in its state folder, where Practice reads what a run spent (${value!.spentFrom === 'reported' ? `it had only what the run reported, ${tokens(ran)} tokens` : 'nothing of it was there'})`);
}
// Counted once: none of the run's calls among the agent's own, by their event
// ids, and nothing new there at all (HB-1418 review). The agent makes no call
// of its own meanwhile (its heartbeat is off, configWriter.ts), so a call the
// ids do not find, a copy of the run under other ids say, still shows as a rise.
const runIds = Array.isArray(value!.spentIds) ? (value!.spentIds as unknown[]).map(String) : [];
const byIds = runIds.length > 0 && runIds.length === ran.calls;
const twice = runIds.filter((id) => after.ids.has(id)).length;
if (twice) fails(`the agent's own transcripts hold ${twice} of the run's ${ran.calls} calls too (by their ids), where the usage sampler counts them again: counted twice`);
const rose = tokens(after.sum) - tokens(before.sum), added = after.sum.calls - before.sum.calls;
if (rose || added) {
  unknown(`the agent's own usage rose by ${rose} tokens in ${added} call${added === 1 ? '' : 's'} while the practice ran, `
    + (byIds ? 'none of them the run\'s by their ids: another turn ran meanwhile, or this release keeps a copy of the run under other ids' : 'and the run\'s calls carry no ids to tell them apart')
    + '. Run the gate again');
}
if (!byIds && !heartbeatOff()) unknown('the run\'s calls carry no ids, and the agent\'s heartbeat is not off, so another turn could have hidden a copy of the run. Run the gate again');
// Counted once a moment later too: the agent's own usage read again once the
// run has settled, unchanged in its ids, calls and tokens (review, N1): a copy
// the release writes there just after the run ends was missed by the read above.
const seconds = `${+(settleMs / 1000).toFixed(1)} s`;
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settleMs);
const settled = ownUsage('after the run ended');
const late = runIds.filter((id) => settled.ids.has(id)).length;
if (late) fails(`the agent's own transcripts hold ${late} of the run's ${ran.calls} calls too (by their ids), copied there within ${seconds} of the run's end, where the usage sampler counts them again: counted twice`);
const lateRose = tokens(settled.sum) - tokens(after.sum), lateAdded = settled.sum.calls - after.sum.calls;
const lateIds = [...settled.ids].filter((id) => !after.ids.has(id)).length + [...after.ids].filter((id) => !settled.ids.has(id)).length;
if (lateRose || lateAdded || lateIds) {
  unknown(`the agent's own usage changed after the run ended (by ${lateRose} tokens in ${lateAdded} call${lateAdded === 1 ? '' : 's'} within ${seconds}): this release may keep a copy of the run there a moment later, or another turn ran. Run the gate again`);
}
const held = `the run's ${ran.calls} call${ran.calls === 1 ? '' : 's'} (${tokens(ran)} tokens) are in its own state folder, where Practice reads them, and `
  + (byIds ? `none of them is in the agent's own usage (by their ids), which did not rise, then or in the ${seconds} after the run ended: counted once`
    : `the agent's own usage did not rise, then or in the ${seconds} after the run ended (by its totals: the run's calls carry no ids; the agent's heartbeat is off): counted once`)
  + (status === 'completed' ? '' : ' (the model did not show it read both the skill and the sample: the skills live test checks that)');
holds(held);
