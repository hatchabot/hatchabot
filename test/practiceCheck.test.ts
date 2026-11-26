import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { PRACTICE_OPENCLAW } from '../src/orchestrator/skills/skillTrials.js';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * The candidate gate's practice turn (HB-1418) with no Docker and no OpenClaw:
 * `docker` here runs what it is asked in a sandbox standing in for the agent's
 * container (its /home/node/.openclaw a temp folder, its PATH only shims), and
 * `openclaw` is a stand-in that answers each of the gate's steps and whose
 * practice run keeps its transcript where the test says. Nothing reaches the
 * real machine, a model or the network. It does not prove where a real
 * OpenClaw keeps one: the gate, run on a real candidate, does.
 */
const ROOT = resolve(__dirname, '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const SLUG = 'gate-agent';
const CONTAINER = `hatchabot-${SLUG}-1`;
const P = PRACTICE_OPENCLAW;
const TOOLS = ['bash', 'sh', 'date', 'od', 'tr', 'sed', 'sort', 'grep', 'tail', 'head', 'seq', 'sleep', 'cat', 'dirname', 'mkdir'];
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
// One temp folder for tsx's compile cache across the file's runs.
const shared = mkdtempSync(join(tmpdir(), 'hb-practice-check-tsx-'));
afterAll(() => rmSync(shared, { recursive: true, force: true }));

/**
 * Where the stand-in's practice run keeps its two calls: its state folder, the
 * agent's own transcripts, or both; in both but only its last call ('part'), or
 * that under another id ('part-new-id'); or with no event ids at all, in its
 * state folder alone ('no-ids') or in both ('no-ids-both').
 */
type Keeps = 'state' | 'both' | 'own' | 'part' | 'part-new-id' | 'no-ids' | 'no-ids-both';
/**
 * `ends`: how the run ends, answered (ok) or cut off at its limit (timeout). `slowRead`: the first usage
 * read takes 2 s. `seen`: whether the agent's own transcripts hold a call from before ('before'), and
 * whether the gate's ask adds one where the usage reader reads ('ask'), or neither ('none').
 */
function sandbox({ keeps = 'state', runs = '2026.10.1', harness = false, heartbeat = '"0m"', ends = 'ok', slowRead = false, seen = 'ask', later }: { keeps?: Keeps; runs?: string; harness?: boolean; heartbeat?: string; ends?: 'ok' | 'timeout'; slowRead?: boolean; seen?: 'ask' | 'before' | 'none'; later?: 'copy' | 'other' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hb-practice-check-')); dirs.push(root);
  const bin = join(root, 'bin'), home = join(root, 'home'), state = join(home, '.openclaw'), inside = join(root, 'container-tmp');
  const agentDir = join(state, 'agents', SLUG, 'agent');
  for (const d of [bin, home, inside, agentDir, join(state, 'agents', SLUG, 'sessions'), join(state, 'devices'), join(state, 'credentials')]) mkdirSync(d, { recursive: true });
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const t of TOOLS) {
    const p = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
    expect(p, t).not.toBe('');
    symlinkSync(p, join(bin, t));
  }
  // The agent's config, the files the gate looks for, and its own transcripts, with one call from before.
  writeFileSync(join(state, 'openclaw.json'), JSON.stringify({ agents: { defaults: { model: { primary: 'anthropic/fixture' }, models: harness ? { 'anthropic/fixture': { agentRuntime: { id: 'claude-cli' } } } : {} }, entries: { [SLUG]: {} } } }));
  writeFileSync(join(state, 'agents', SLUG, 'sessions', 'sessions.json'), JSON.stringify({ [`agent:${SLUG}:main`]: { updatedAt: 1 } }));
  writeFileSync(join(state, 'devices', 'pending.json'), '{}');
  writeFileSync(join(state, 'credentials', 'telegram-pairing.json'), '{}');
  const own = new Database(join(agentDir, 'openclaw-agent.sqlite'));
  own.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT, event_zstd BLOB)');
  if (seen !== 'none') own.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL)').run('main', 1, Date.now() - 60_000,
    JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 } } }));
  own.close();
  // The gate's ask, answered: its call in the agent's own transcripts, as a real turn leaves one.
  const askLands = join(root, 'ask-lands.js');
  writeFileSync(askLands, `const db=new (require('node:sqlite').DatabaseSync)(${JSON.stringify(join(agentDir, 'openclaw-agent.sqlite'))});
db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL)').run('main',2,Date.now(),JSON.stringify({type:'message',id:'a1',timestamp:new Date().toISOString(),message:{role:'assistant',model:'claude-opus-4-8',usage:{input:300,output:5,cacheRead:0,cacheWrite:0}}}));db.close();`);
  // later: a writer, left running as the run ends, puts a copy of it (its ids, or other ones) in the agent's own store 1 s on.
  const laterJs = join(root, 'later.js');
  writeFileSync(laterJs, `const [file,rows]=process.argv.slice(2);setTimeout(()=>{const db=new (require('node:sqlite').DatabaseSync)(file);
const put=db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL)');
JSON.parse(rows).forEach(([id,u],i)=>put.run('p1-later',i+1,Date.now(),JSON.stringify({type:'message',id,timestamp:new Date().toISOString(),message:{role:'assistant',model:'claude-opus-4-8',usage:u}})));db.close();},1000);`);
  const log = join(root, 'docker.log'), timing = join(root, 'timing.log');
  // docker: `exec` runs in the stand-in container; the gate's image questions get the candidate's answers.
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a.map(x=>x.length>60?x.slice(0,60)+'…':x))+'\\n');
const sub=s=>s.replaceAll('/home/node/.openclaw',${JSON.stringify(state)});
if(a[0]==='exec'){
  let i=1;const stdin=a[i]==='-i';if(stdin)i++;
  if(a[i]!==${JSON.stringify(CONTAINER)}){process.stderr.write('Error: No such container: '+a[i]+'\\n');process.exit(1);}
  // A login shell would read the machine's profile: plain bash here.
  const cmd=a.slice(i+1).map(sub).map(x=>x==='-lc'?'-c':x);
  const reader=cmd[0]==='node'&&cmd[1]==='-e',input=stdin?fs.readFileSync(0,'utf8'):'';
  if(reader&&${JSON.stringify(slowRead)}&&!fs.existsSync(${JSON.stringify(timing)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);
  // When each usage read ended, and the deadline the practice was given.
  const payload=/'([A-Za-z0-9+\\/=]+)'\\s*\\}\\s*<\\/dev\\/null\\s*$/.exec(input);
  if(payload)fs.appendFileSync(${JSON.stringify(timing)},JSON.stringify({practiceExpiresAt:JSON.parse(Buffer.from(payload[1],'base64').toString()).expiresAt})+'\\n');
  const r=cp.spawnSync(cmd[0],cmd.slice(1),{input:sub(input),env:{HOME:${JSON.stringify(home)},PATH:${JSON.stringify(bin)},TMPDIR:${JSON.stringify(inside)}},encoding:'utf8',maxBuffer:16*1024*1024});
  if(reader)fs.appendFileSync(${JSON.stringify(timing)},JSON.stringify({readEnded:Date.now()})+'\\n');
  process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);
}
if(a[0]==='image'&&a[1]==='inspect'){process.stdout.write(a.join(' ').includes('openclaw-version')?${JSON.stringify(runs)}+'\\n':'\\n');process.exit(0);}
if(a[0]==='ps'){process.stdout.write(${JSON.stringify(CONTAINER)}+'\\n');process.exit(0);}
if(a[0]==='inspect'){process.stdout.write('hatchabot-runtime:'+${JSON.stringify(runs)}+'\\n');process.exit(0);}
process.exit(1);
`, { mode: 0o755 });
  // openclaw: each gate step's answer, and a practice run that keeps its calls where the test says.
  writeFileSync(join(bin, 'openclaw'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const argv=process.argv.slice(2),say=(x)=>{process.stdout.write(typeof x==='string'?x:JSON.stringify(x));process.exit(0);};
const own=${JSON.stringify(agentDir)};
if(argv[0]==='--version')say('OpenClaw '+${JSON.stringify(runs)}+'\\n');
if(argv[0]==='config'&&argv[1]==='get')say({'memory.search.provider':'"local"','agents.defaults.heartbeat.every':${JSON.stringify(heartbeat)}}[argv[2]]||'');
if(argv[0]==='memory'&&argv[1]==='status')say('Embeddings: ready\\nSemantic vectors: ready\\n');
if(argv[0]==='memory'&&argv[1]==='search')say({results:[{snippet:fs.readFileSync(path.join(own,'MEMORY.md'),'utf8')}]});
if(argv[0]==='sessions')say({sessions:[{key:'agent:${SLUG}:main',updatedAt:1}]});
if(argv[0]==='cron')say({jobs:[]});
if(argv[0]==='models')say([{key:'anthropic/fixture-model'}]);
if(argv[0]==='devices')say({pending:[],paired:[]});
if(argv[0]==='plugins')say([{id:'duckduckgo',enabled:true}]);
if(argv[0]!=='agent'||argv[1]!=='exec')say('{}');
const sq=require('node:sqlite');
const config=JSON.parse(fs.readFileSync(argv[argv.indexOf('--config')+1],'utf8'));
const workspace=argv[argv.indexOf('--cwd')+1];
const keeps=${JSON.stringify(keeps)},noIds=keeps.startsWith('no-ids');
const call=(id,usage)=>JSON.stringify({type:'message',...(noIds?{}:{id}),timestamp:new Date().toISOString(),message:{role:'assistant',model:'claude-opus-4-8',usage}});
const RUN=[['e1',{input:100,output:40,cacheRead:2000,cacheWrite:300}],['e2',{input:50,output:10,cacheRead:2100,cacheWrite:0}]];
const keep=(file,which)=>{
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const db=new sq.DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS transcript_events (session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT, event_zstd BLOB)');
  const put=db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL)');
  which.forEach(([id,u],i)=>put.run('p1',i+1,Date.now(),call(id,u)));
  db.close();
};
if(keeps!=='own')keep(path.join(argv[argv.indexOf('--state-dir')+1],'agents',${JSON.stringify(SLUG)},'agent','openclaw-agent.sqlite'),RUN);
const ownCopy={own:RUN,both:RUN,'no-ids-both':RUN,part:[RUN[1]],'part-new-id':[['e2-copy',RUN[1][1]]]}[keeps];
if(ownCopy)keep(path.join(config.agents.entries[${JSON.stringify(SLUG)}].agentDir,'openclaw-agent.sqlite'),ownCopy);
const later=${JSON.stringify(later ?? null)};
if(later)require('node:child_process').spawn(process.execPath,[${JSON.stringify(laterJs)},path.join(config.agents.entries[${JSON.stringify(SLUG)}].agentDir,'openclaw-agent.sqlite'),JSON.stringify(later==='copy'?RUN:[['e9-later',RUN[1][1]]])],{detached:true,stdio:'ignore'}).unref();
if(${JSON.stringify(ends)}==='timeout'){process.stdout.write(JSON.stringify({ok:false,status:'timeout',usage:{input:150,output:50,total:200}}));process.exit(2);}
const skill=/\\[skill-check:[a-f0-9]+\\]/.exec(fs.readFileSync(path.join(workspace,'skills','hatchabot-writing','SKILL.md'),'utf8'))[0];
const sample=/\\[sample-check:[a-f0-9]+\\]/.exec(fs.readFileSync(path.join(workspace,'sample.md'),'utf8'))[0];
say({ok:true,status:'ok',final:'The seed library opens Saturday at 10. '+skill+' '+sample,toolSummary:{calls:2},usage:{input:100,output:40,total:140}});
`, { mode: 0o755 });
  // curl, for the gate's console step: the console answers.
  writeFileSync(join(bin, 'curl'), '#!/bin/bash\nprintf 200\n', { mode: 0o755 });
  // hatchabot: the gate's CLI, for one agent that is made, answers and goes.
  writeFileSync(join(bin, 'hatchabot'), `#!/bin/bash
echo "$*" >> ${JSON.stringify(join(root, 'hatchabot.log'))}
case "$1" in
  create) printf '%s' "$2" > ${JSON.stringify(join(root, 'name'))}; echo "Agent $2 is RUNNING" ;;
  list) printf '[{"name":"%s","slug":"${SLUG}","state":"RUNNING","busy":false}]\\n' "$(cat ${JSON.stringify(join(root, 'name'))})" ;;
  image) echo "$2 already runs that image" ;;
  ask) ${seen === 'ask' ? `node ${JSON.stringify(askLands)} 2>/dev/null; ` : ''}printf '%s\\n' "$3" | grep -o 'PING-[0-9a-f]*' ;;
  console|delete) exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const env = scriptEnv(home, bin, { TMPDIR: shared });
  const check = (release = runs, more: string[] = []) => {
    // A short settle, so each check is quick, unless the test names one; the gate's own is 8 s.
    const settle = more.includes('--settle-ms') ? [] : ['--settle-ms', '100'];
    const r = spawnSync(TSX, ['scripts/practice-check.ts', CONTAINER, SLUG, release, ...more, ...settle], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, last: r.stdout.trim().split('\n').pop() ?? '', stderr: r.stderr };
  };
  // noTsx: the gate run from a copy of the repo with no node_modules, its practice source beside it;
  // crashes: that copy's tsx stops at once, as a check that throws does.
  const gate = (o: { noTsx?: boolean; crashes?: boolean } = {}) => {
    let from = ROOT;
    if (o.noTsx || o.crashes) {
      from = join(root, 'repo');
      mkdirSync(join(from, 'scripts'), { recursive: true });
      mkdirSync(join(from, 'src', 'orchestrator', 'skills'), { recursive: true });
      copyFileSync(join(ROOT, 'scripts', 'candidate-gate.sh'), join(from, 'scripts', 'candidate-gate.sh'));
      copyFileSync(join(ROOT, 'src', 'orchestrator', 'skills', 'skillTrials.ts'), join(from, 'src', 'orchestrator', 'skills', 'skillTrials.ts'));
      if (o.crashes) {
        mkdirSync(join(from, 'node_modules', '.bin'), { recursive: true });
        writeFileSync(join(from, 'node_modules', '.bin', 'tsx'), '#!/bin/bash\necho "    at made-up frame (practice-check.ts:1:1)" >&2\necho "TypeError: a made-up crash" >&2\nexit 7\n', { mode: 0o755 });
      }
    }
    const r = spawnSync('bash', [join(from, 'scripts', 'candidate-gate.sh'), `hatchabot-runtime:${runs}`], { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
    return { code: r.status, out: r.stdout + r.stderr, from };
  };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
  const timings = () => readFileSync(timing, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { readEnded?: number; practiceExpiresAt?: number });
  return { check, gate, calls, timings, root, inside };
}

const STEP = 'one practice turn: its transcript is where Practice reads it, and it is counted once';
const held = (settled = '0.1 s') => `the run's 2 calls (4600 tokens) are in its own state folder, where Practice reads them, and none of them is in the agent's own usage (by their ids), which did not rise, then or in the ${settled} after the run ended: counted once`;
const HELD = held();
const move = (settled?: string) => `Practice may move to OpenClaw 2026.10.1: ${held(settled)}. A Hatchabot release may now move PRACTICE_OPENCLAW (src/orchestrator/skills/skillTrials.ts) from ${P} to 2026.10.1`;
const MOVE = move();
const TWICE = 'the agent\'s own transcripts hold 2 of the run\'s 2 calls too (by their ids), where the usage sampler counts them again: counted twice';

describe('the candidate gate checks that Practice may run on its OpenClaw (HB-1418)', () => {
  it('holds when the run keeps its transcript in its own state folder and the agent\'s usage does not rise by it, and says the pin may move to that release', () => {
    const s = sandbox();
    const r = s.check();
    expect(r.code, r.stderr).toBe(0);
    expect(r.last).toBe(MOVE);
    // The practice went over stdin, as Practice sends it, and its folder is gone.
    expect(s.calls()).toContainEqual(['exec', '-i', CONTAINER, 'bash', '-s']);
    expect(readdirSync(s.inside).filter((f) => f.startsWith('hb-skill-practice-'))).toEqual([]);
  });

  it('says so on the release Practice already runs on, and says a wrong count there is Practice\'s to fix', () => {
    const r = sandbox({ runs: P }).check();
    expect(r.code, r.stderr).toBe(0);
    expect(r.last).toBe(`Practice holds on OpenClaw ${P}, the release it runs on: ${HELD}`);
    const wrong = sandbox({ runs: P, keeps: 'both' }).check();
    expect(wrong.code).toBe(1);
    expect(wrong.last).toBe(`Practice runs on OpenClaw ${P} and counts it wrong there: ${TWICE}. That is Practice's to fix (src/orchestrator/skills/skillTrials.ts), not this image's`);
  });

  it('does not hold when the run is in the agent\'s own transcripts too, where the usage sampler would count it again', () => {
    const r = sandbox({ keeps: 'both' }).check();
    expect(r.code).toBe(1);
    expect(r.last).toBe(`Practice stays on OpenClaw ${P}: ${TWICE}`);
  });

  // Review (M1): a run whose last call alone was copied into the agent's own store passed as
  // "rose by 2160: counted once", the rise being under the run's 4600.
  it('does not hold when any one of the run\'s calls is in the agent\'s own transcripts too, found by its id', () => {
    const r = sandbox({ keeps: 'part' }).check();
    expect(r.code).toBe(1);
    expect(r.last).toBe(`Practice stays on OpenClaw ${P}: the agent's own transcripts hold 1 of the run's 2 calls too (by their ids), where the usage sampler counts them again: counted twice`);
  });

  it('could not check when the agent\'s own usage rose by calls the ids do not find, and says so', () => {
    const r = sandbox({ keeps: 'part-new-id' }).check();
    expect(r.code).toBe(3);
    expect(r.last).toBe(`Practice stays on OpenClaw ${P}: could not check: the agent's own usage rose by 2160 tokens in 1 call while the practice ran, none of them the run's by their ids: another turn ran meanwhile, or this release keeps a copy of the run under other ids. Run the gate again`);
  });

  it('with calls that carry no ids, holds only by the totals with the heartbeat off, and says which it went by', () => {
    const quiet = sandbox({ keeps: 'no-ids' }).check();
    expect(quiet.code, quiet.stderr).toBe(0);
    expect(quiet.last).toBe(`Practice may move to OpenClaw 2026.10.1: the run's 2 calls (4600 tokens) are in its own state folder, where Practice reads them, and the agent's own usage did not rise, then or in the 0.1 s after the run ended (by its totals: the run's calls carry no ids; the agent's heartbeat is off): counted once. A Hatchabot release may now move PRACTICE_OPENCLAW (src/orchestrator/skills/skillTrials.ts) from ${P} to 2026.10.1`);
    const beating = sandbox({ keeps: 'no-ids', heartbeat: '"30m"' }).check();
    expect(beating).toMatchObject({ code: 3, last: `Practice stays on OpenClaw ${P}: could not check: the run's calls carry no ids, and the agent's heartbeat is not off, so another turn could have hidden a copy of the run. Run the gate again` });
    const copied = sandbox({ keeps: 'no-ids-both' }).check();
    expect(copied).toMatchObject({ code: 3, last: `Practice stays on OpenClaw ${P}: could not check: the agent's own usage rose by 4600 tokens in 2 calls while the practice ran, and the run's calls carry no ids to tell them apart. Run the gate again` });
  });

  // Review (N1): a copy written into the agent's own store a moment after the run ended passed as "may move".
  it('does not hold, or could not check, when the agent\'s own usage changes in the moment after the run ends', () => {
    const copy = sandbox({ later: 'copy' }).check('2026.10.1', ['--settle-ms', '3000']);
    expect(copy).toMatchObject({ code: 1, last: `Practice stays on OpenClaw ${P}: the agent's own transcripts hold 2 of the run's 2 calls too (by their ids), copied there within 3 s of the run's end, where the usage sampler counts them again: counted twice` });
    const other = sandbox({ later: 'other' }).check('2026.10.1', ['--settle-ms', '3000']);
    expect(other).toMatchObject({ code: 3, last: `Practice stays on OpenClaw ${P}: could not check: the agent's own usage changed after the run ended (by 2160 tokens in 1 call within 3 s): this release may keep a copy of the run there a moment later, or another turn ran. Run the gate again` });
  });

  // Review (L1): a run cut off at its limit, its calls in its state folder, passed as "counted once".
  it('could not check when the practice did not finish, wherever its calls were', () => {
    const r = sandbox({ ends: 'timeout' }).check();
    expect(r.code).toBe(3);
    expect(r.last).toBe(`Practice stays on OpenClaw ${P}: could not check: the practice did not finish (timeout), and a run cut short tells nothing of where a finished one is kept. Check the agent's AI source, then run the gate again`);
  });

  it('gives the practice its whole time from after the first usage read, however long that took', () => {
    const s = sandbox({ slowRead: true });
    expect(s.check().code).toBe(0);
    const t = s.timings(), firstRead = t.find((x) => x.readEnded)!.readEnded!, deadline = t.find((x) => x.practiceExpiresAt)!.practiceExpiresAt!;
    expect(deadline - firstRead).toBeGreaterThanOrEqual(74_000);
  });

  // Review (L2): with the agent's own transcripts where the usage reader does not read, before and after
  // were both nothing, and the check passed as "counted once" by default.
  it('could not check when the usage reader sees none of the agent\'s turns, or not the gate\'s ask', () => {
    const none = sandbox({ seen: 'none' }).check();
    expect(none).toMatchObject({ code: 3, last: `Practice stays on OpenClaw ${P}: could not check: the usage reader sees none of this agent's turns on OpenClaw 2026.10.1` });
    const s = sandbox({ seen: 'before' });
    const missed = s.check('2026.10.1', ['--ask-at', String(Date.now() - 1000)]);
    expect(missed).toMatchObject({ code: 3, last: `Practice stays on OpenClaw ${P}: could not check: the usage reader does not see this agent's last turn, the gate's ask, on OpenClaw 2026.10.1` });
    // Nothing was run.
    expect(s.calls().some((c) => c.includes('bash') && c.includes('-s'))).toBe(false);
    expect(s.check('2026.10.1', ['--ask-at', String(Date.now() - 120_000)]).code).toBe(0);
  });

  it('does not hold when the run keeps its transcript somewhere Practice does not read', () => {
    const r = sandbox({ keeps: 'own' }).check();
    expect(r.code).toBe(1);
    expect(r.last).toBe(`Practice stays on OpenClaw ${P}: the run's transcript is not in its state folder, where Practice reads what a run spent (it had only what the run reported, 140 tokens)`);
  });

  it('could not check on another release than the one asked about, or under a CLI harness, runs nothing, and says why', () => {
    const other = sandbox({ runs: '2026.10.2' }).check('2026.10.1');
    expect(other).toMatchObject({ code: 3, last: `Practice stays on OpenClaw ${P}: could not check: the agent's container runs OpenClaw 2026.10.2, not 2026.10.1: nothing was run` });
    const harness = sandbox({ harness: true }).check();
    expect(harness.code).toBe(3);
    expect(harness.last).toBe(`Practice stays on OpenClaw ${P}: could not check: Practice cannot run on this agent's model (it has none, or a CLI harness runs it rather than OpenClaw itself): nothing was run. Run the gate again with --profile and an AI source OpenClaw runs itself`);
  });

  it('refuses a release not named as openclaw --version names one', () => {
    const s = sandbox();
    const r = s.check('latest');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Practice runs only on an OpenClaw release named as openclaw --version names one.');
    expect(existsSync(join(s.root, 'docker.log'))).toBe(false);
  });

  it('the gate runs the practice turn on its candidate and says at the end that Practice may move to it', () => {
    const s = sandbox();
    const { code, out } = s.gate();
    expect(out).toMatch(new RegExp(`▸ ${STEP} … ok \\(\\d+s\\)`));
    expect(out).toContain(`✓ ${STEP}`);
    expect(out).toContain(`Results (18 passed, 0 failed) for hatchabot-runtime:2026.10.1:`);
    expect(out).toContain(`\n${move('8 s')}\n`);
    // Its own usage read once more, 8 s after the run's end (review, N1).
    const reads = s.timings().filter((t) => t.readEnded).map((t) => t.readEnded!);
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...reads.slice(1).map((t, i) => t - reads[i]!))).toBeGreaterThanOrEqual(8000);
    // When its ask began, by the container's clock, which the transcripts' times come from (review).
    expect(s.calls()).toContainEqual(['exec', CONTAINER, 'date', '+%s%3N']);
    expect(out).toContain('✅ hatchabot-runtime:2026.10.1 passes the gate.');
    expect(code).toBe(0);
    expect(readFileSync(join(s.root, 'hatchabot.log'), 'utf8')).toMatch(/^delete gate-\S+ --yes$/m);
  }, 150_000);

  // The owner's choice (2026-11-24): the gate judges whether the image is ready for agents, and Practice
  // refuses itself, in words of its own, on a release it does not run on. Its step warns, never fails.
  it.each([
    ['would be counted twice', { keeps: 'both' as const }, `Practice stays on OpenClaw ${P}: ${TWICE}`],
    ['could not be checked (the usage reader does not see its ask)', { seen: 'before' as const }, `Practice stays on OpenClaw ${P}: could not check: the usage reader does not see this agent's last turn, the gate's ask, on OpenClaw 2026.10.1`],
    ['could not be checked (a CLI harness)', { harness: true }, `Practice stays on OpenClaw ${P}: could not check: Practice cannot run on this agent's model (it has none, or a CLI harness runs it rather than OpenClaw itself): nothing was run. Run the gate again with --profile and an AI source OpenClaw runs itself`],
    // Review: the closing line names the release Practice stays on here too.
    ['could not be checked (no tsx where the gate runs)', { noTsx: true }, `Practice stays on OpenClaw ${P}: could not check: no node_modules/.bin/tsx in <repo>: run npm ci there first`],
    // Review: a check that stopped (a throw, a wrong call) left its last line as the verdict.
    ['could not be checked (the check stopped)', { crashes: true }, `Practice stays on OpenClaw ${P}: could not check: the practice check stopped (TypeError: a made-up crash)`],
  ])('the gate warns, and still passes its candidate, when the practice turn %s, and says Practice stays where it is', (_, opts, expected) => {
    const s = sandbox(opts as Parameters<typeof sandbox>[0]);
    const { code, out, from } = s.gate(opts as { noTsx?: boolean; crashes?: boolean });
    const words = expected.replace('<repo>', from);
    expect(out).toContain(`▸ ${STEP} … WARNING — ${words}\n`);
    expect(out).toContain(`⚠ ${STEP} — ${words}`);
    expect(out).toContain('Results (17 passed, 0 failed, 1 warned) for hatchabot-runtime:2026.10.1:');
    expect(out).toContain(`\n${words}\n`);
    expect(out).toContain('✅ hatchabot-runtime:2026.10.1 passes the gate.');
    expect(code).toBe(0);
  }, 150_000);
});
