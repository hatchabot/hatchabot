import { CURATED_SKILLS } from '../../openclaw/skills.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import { versionBehind } from '../transfer/migrate.js';

/** Practice exercises use local, invented material. They do not test external accounts. */
const SAMPLES: Record<string, { title: string; prompt: string; facts: string }> = {
  gog: { title: 'Draft a reply from sample mail', prompt: 'Draft a short reply to the sample message in sample.md. Do not send it.', facts: 'Sample incoming message: The seed library opens Saturday at 10. Can you bring three clean envelopes? Reply that the envelopes will be ready.' },
  'hatchabot-research': { title: 'Compare supplied evidence', prompt: 'Compare the two supplied sources in sample.md, cite them by their labels, and explain the uncertainty. Use only the supplied material.', facts: 'Source A, notice dated November 1: the seed library opens at 10 on Saturday. Source B, draft dated October 25: proposed opening time is 9. Neither source confirms holiday hours.' },
  'hatchabot-browser': { title: 'Plan a browser task', prompt: 'Using the page description in sample.md, give the next safe steps for this browser task. This is a written rehearsal; do not open a site or submit anything.', facts: 'The user wants a draft registration for a free gardening workshop. The page shows date, participant count, an email field, and a Submit button. The selected date has not been confirmed and no email was supplied.' },
  'hatchabot-writing': { title: 'Revise a sample announcement', prompt: 'Rewrite the announcement in sample.md as a clear, friendly two-sentence note. Preserve its facts.', facts: 'Draft: We are writing to inform everyone that on the coming Saturday, at 10 in the morning, the seed library is going to open. We have three kinds of seeds and please do bring your own envelopes if possible.' },
  'hatchabot-planning': { title: 'Plan a small project', prompt: 'Make a short practical plan from sample.md, with dependencies and completion checks. Do not schedule or assign anything.', facts: 'Goal: open a seed library on Saturday at 10. Three seed varieties need labels; envelopes are available; the table must be arranged after labels are ready. There are two hours for preparation.' },
  'hatchabot-jira': { title: 'Draft an issue', prompt: 'Draft an issue from sample.md with a concise title, description and acceptance criteria. Do not create or update an issue.', facts: 'A workshop signup form clears the selected date after a validation error. Expected: preserve the date while showing the missing email error. Reproduction: pick Saturday, leave email empty, submit.' },
  'hatchabot-images': { title: 'Prepare an image brief', prompt: 'Turn sample.md into a precise image-generation brief and one prompt. Do not generate an image or call an image provider.', facts: 'A square illustration for a seed-library announcement. Three paper seed envelopes and a small sprout on a warm cream background. No text, no logos, cheerful flat colors, clear space near the top for a later heading.' },
};

export const SKILL_TRIAL_LIMITS = { timeoutSeconds: 60, maxOutputTokensPerResponse: 512 } as const;
export type SkillTrialStatus = 'completed' | 'not_observed' | 'timeout' | 'unavailable' | 'unsupported';
/** What a practice run spent on one model (HB-0933): its calls and their four parts. */
export interface PracticeSpent { model: string; calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export interface SkillTrialResult {
  status: SkillTrialStatus;
  output?: string;
  evidence: { skillRead: boolean; fixtureRead: boolean; toolCalls: number; codeMode: boolean | null };
  usage?: { input?: number; output?: number; total?: number; costUsd?: number };
  limits: typeof SKILL_TRIAL_LIMITS;
  message: string;
  /**
   * What the run spent, per model, whatever became of it (HB-0933), read
   * before its temporary folder went, and where from (`spentFrom`): its state
   * folder's transcript, or, when that held no call, what the run reported.
   * Neither is in the agent's own transcripts, which the usage sampler reads.
   * Practice records it and leaves it out of its answer.
   */
  spent?: PracticeSpent[];
  spentFrom?: PracticeSpentFrom;
}
export type PracticeSpentFrom = 'state' | 'reported';
const SPENT_FROM: readonly PracticeSpentFrom[] = ['state', 'reported'];
export function describeSkillTrial(id: string) {
  const sample = Object.hasOwn(SAMPLES, id) ? SAMPLES[id] : undefined;
  if (!sample || !CURATED_SKILLS.some((skill) => skill.id === id)) throw new Error('Choose a skill from the curated library.');
  return { title: sample.title, prompt: sample.prompt, ...SKILL_TRIAL_LIMITS, scope: 'practice' as const };
}

const MESSAGES: Record<SkillTrialStatus, string> = {
  completed: 'The model used the skill and sample material. This practice did not test external services or actions.',
  not_observed: 'The model answered, but use of both the skill and sample material could not be verified.',
  timeout: 'Practice reached its time limit. It may still have used paid AI tokens.',
  unavailable: 'Practice could not finish. Check the running agent and its AI source, then try again.',
  unsupported: 'This runtime or model harness does not support the isolated practice check.',
};
/**
 * The one OpenClaw release Practice runs on: where its `agent exec --state-dir`
 * keeps the run's transcript was read in it, and what the run spent is counted
 * from there (HB-0933). Another release is let in only once that is read again.
 */
export const PRACTICE_OPENCLAW = '2026.9.8';
/** A release as `openclaw --version` names it, the only shape its words may carry. */
const OPENCLAW_RELEASE = /^\d{4}\.\d{1,2}\.\d{1,3}(?:-[A-Za-z0-9.]{1,24})?$/;
/**
 * Practice refused for the agent's OpenClaw release, named (HB-1253): it said
 * only that "this runtime" did not support it, with no reason, after an upgrade.
 * An older release is the agent's to leave by a rebuild onto an image with
 * PRACTICE_OPENCLAW: the Fleet default has it unless the fleet was moved to
 * another (a rollback), so the words say where an image is picked, as the
 * agent's sheet names it (Advanced, the Runtime row's Image, whose list
 * names each image's OpenClaw). A newer one waits for a Hatchabot release
 * that has checked it.
 * Older as the image-skew guard reads it (versionBehind): a word after the
 * dash is a prerelease, before its release; a number is a later build of it
 * ("OpenClaw 2026.7.1-2"), which a dash alone read as older (review).
 */
export function practiceReleaseWords(release: string): string {
  const said = `Practice runs only on OpenClaw ${PRACTICE_OPENCLAW} so far, and this agent runs OpenClaw ${release}`;
  return versionBehind(release, PRACTICE_OPENCLAW)
    ? `${said}, an older one: nothing was run or spent. Rebuild it onto an image with OpenClaw ${PRACTICE_OPENCLAW} (its memory, files and members are kept), then try again: `
      + `in its Advanced tab, under Runtime, pick an Image with ${PRACTICE_OPENCLAW} (the list names each image's OpenClaw; Fleet default has ${PRACTICE_OPENCLAW} unless the fleet was moved to another) `
      + 'and press Pin & rebuild, or Rebuild when that one is picked already.'
    : `${said}: nothing was run or spent. A later Hatchabot release adds that version once it has been checked.`;
}
const empty = (status: SkillTrialStatus): SkillTrialResult => ({ status, evidence: { skillRead: false, fixtureRead: false, toolCalls: 0, codeMode: null }, limits: SKILL_TRIAL_LIMITS, message: MESSAGES[status] });
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Uses the pinned `agent exec` CLI's temporary state and current auth owner.
 * Policy contracts checked in OpenClaw 2026.9.8: commands/agent-exec-input.ts,
 * commands/agent-exec-result.ts, agents/agent-tools.read.ts. Only the copied
 * skill and fixture are readable. Runtime-managed auth refresh may still occur.
 * No original workspace/config/session file is written by this helper.
 */
export function skillTrialScript(target: { slug: string }, skill: { id: string; content: string }, expiresAt = Date.now() + 75_000): string {
  const sample = describeSkillTrial(skill.id);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(target.slug) || typeof skill.content !== 'string' || !skill.content.trim() || Buffer.byteLength(skill.content) > 64 * 1024 || !Number.isSafeInteger(expiresAt)) throw new Error('The skill cannot be used for practice.');
  const payload = Buffer.from(JSON.stringify({ slug: target.slug, id: skill.id, content: skill.content, sample, facts: SAMPLES[skill.id]!.facts, expiresAt })).toString('base64');
  const code = String.raw`
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto'), cp=require('node:child_process');
const input=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));
const base='/home/node/.openclaw';
let root, ran, reported;
const result=(status,extra={})=>({status,...extra});
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
// What the run spent (HB-0933), counted as the usage reader counts an agent's
// calls (usage.ts USAGE_READER_SCRIPT): every message's usage, each event once.
// On 2026.9.8, the only version let in below, agent exec --state-dir keeps the
// run's transcript in that folder (its OPENCLAW_STATE_DIR: the agent's own
// directory is opened for its auth only), so it is read here before the folder
// goes, and the usage sampler, which reads the agent's own transcripts, never
// sees it: counted once, by Practice. A runtime that wrote it into the agent's
// own would be counted by the sampler too, so a new version is let in only
// once where it writes is checked again.
const zlib=require('node:zlib');
let sqlite=null;try{sqlite=require('node:sqlite');}catch{}
const n=x=>typeof x==='number'&&isFinite(x)&&x>0?x:0;
const MODEL=/^[A-Za-z0-9._:@\/-]{1,240}$/;
function tally(fallback){
  const models={},seen=new Set();
  const t={found:false,
    add(e){
      const msg=object(e)?e.message:null;
      if(!object(msg)||!object(msg.usage))return;
      if(e.id){if(seen.has(e.id))return;seen.add(e.id);}
      const u=msg.usage;
      if(!(n(u.input)+n(u.output)+n(u.cacheRead)+n(u.cacheWrite)))return;
      const k=typeof msg.model==='string'&&MODEL.test(msg.model)?msg.model:fallback;
      const m=models[k]||(models[k]={model:k,calls:0,input:0,output:0,cacheRead:0,cacheWrite:0});
      m.calls++;m.input+=n(u.input);m.output+=n(u.output);m.cacheRead+=n(u.cacheRead);m.cacheWrite+=n(u.cacheWrite);t.found=true;
    },
    line(j){if(typeof j!=='string'||j.indexOf('"usage"')<0)return;try{t.add(JSON.parse(j));}catch{}},
    list(){return Object.values(models).slice(0,20);}};
  return t;
}
const decode=r=>{let j=r.event_json;if(j==null&&r.event_zstd){try{j=zlib.zstdDecompressSync(Buffer.from(r.event_zstd)).toString('utf8');}catch{return null;}}return typeof j==='string'?j:null;};
const SESSION_FILE=/\.jsonl(\.(reset|deleted)\.[^/]*)?$/;
// The run's own state folder: everything in it is the run's. Where 2026.9.8
// keeps its transcript is read first, each agent's database and session files
// there, then the rest of the folder, up to 400 entries of it, so other files
// in it never crowd the transcript out. No file is read twice.
function stateSpent(dir,fallback){
  const t=tally(fallback),done=new Set();
  const read=p=>{
    if(done.has(p))return;done.add(p);
    const name=path.basename(p);
    if(name.indexOf('trajectory')>=0)return;
    try{if(!fs.lstatSync(p).isFile())return;}catch{return;}
    if(/\.sqlite$/.test(name)){
      if(!sqlite)return;
      let db=null;
      try{db=new sqlite.DatabaseSync(p);for(const r of db.prepare('SELECT event_json, event_zstd FROM transcript_events').all())t.line(decode(r));}
      catch{}finally{try{if(db)db.close();}catch{}}
      return;
    }
    if(!SESSION_FILE.test(name))return;
    let text='';
    try{if(fs.statSync(p).size>32*1024*1024)return;const raw=fs.readFileSync(p);text=(name.endsWith('.zst')?zlib.zstdDecompressSync(raw):raw).toString('utf8');}catch{return;}
    for(const line of text.split('\n'))t.line(line);
  };
  const agents=path.join(dir,'agents');
  let ids=[];try{ids=fs.readdirSync(agents).slice(0,50);}catch{}
  for(const id of ids){
    read(path.join(agents,id,'agent','openclaw-agent.sqlite'));
    let names=[];try{names=fs.readdirSync(path.join(agents,id,'sessions')).filter(x=>SESSION_FILE.test(x)).slice(0,200);}catch{}
    for(const x of names)read(path.join(agents,id,'sessions',x));
  }
  let left=400;
  const walk=(d,depth)=>{
    let list=[];try{list=fs.readdirSync(d,{withFileTypes:true});}catch{return;}
    for(const f of list){
      if(--left<0)return;
      const p=path.join(d,f.name);
      if(f.isDirectory()){if(depth<6)walk(p,depth+1);continue;}
      if(f.isFile())read(p);
    }
  };
  walk(dir,0);
  return {found:t.found,models:t.list()};
}
// What the run reported, only when its folder holds no call: its four parts, as
// the usage reader counts a call's (a total beyond them is not booked as any).
function reportedSpent(told,fallback){
  if(!object(told))return [];
  const i=n(told.input),o=n(told.output),r=n(told.cacheRead),w=n(told.cacheWrite);
  return i+o+r+w>0?[{model:fallback,calls:0,input:i,output:o,cacheRead:r,cacheWrite:w}]:[];
}
function loadFile(file) {
  const s=fs.lstatSync(file); if(!s.isFile()||s.isSymbolicLink()||s.size>1024*1024) throw Error('unsupported');
  return fs.readFileSync(file,'utf8');
}
function child(args,env,ms) {
  return new Promise(resolve=>{
    const chunks=[];
    let bytes=0, timedOut=false, capped=false, done=false, force;
    const proc=cp.spawn('openclaw',args,{env,stdio:['ignore','pipe','pipe'],detached:true,cwd:root});
    const kill=signal=>{ if(proc.pid) {try {process.kill(-proc.pid,signal);} catch {try {proc.kill(signal);}catch{}}} };
    const stop=()=>{kill('SIGTERM');force=setTimeout(()=>kill('SIGKILL'),1500);};
    const timer=setTimeout(()=>{timedOut=true;stop();},ms);
    const collect=(chunk,stdout)=>{ bytes+=chunk.length; if(bytes>512*1024){if(!capped){capped=true;stop();}return;} if(stdout)chunks.push(chunk); };
    proc.stdout.on('data',x=>collect(x,true)); proc.stderr.on('data',x=>collect(x,false));
    const finish=code=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(force);kill('SIGKILL');resolve({code,out:Buffer.concat(chunks).toString('utf8'),timedOut,capped});};
    proc.on('error',()=>finish(-1));proc.on('close',code=>finish(code));
  });
}
async function main() {
  if(Date.now()>=input.expiresAt) return result('timeout');
  root=fs.mkdtempSync(path.join(os.tmpdir(),'hb-skill-practice-'));fs.chmodSync(root,0o700);
  const version=await child(['--version'],process.env,Math.min(5000,input.expiresAt-Date.now()));
  // Only 2026.9.8: where it keeps the run's transcript (above) was read in that release.
  // Another is named, so Practice says which it runs (HB-1253).
  if(version.code!==0||!/^OpenClaw\s+${PRACTICE_OPENCLAW.replace(/\./g, '\\.')}(?:\s|$)|^${PRACTICE_OPENCLAW.replace(/\./g, '\\.')}(?:\s|$)/m.test(version.out)){
    const seen=version.code===0?/^(?:OpenClaw\s+)?(\d{4}\.\d{1,2}\.\d{1,3}(?:-[A-Za-z0-9.]{1,24})?)(?:\s|$)/m.exec(version.out):null;
    return result('unsupported',seen?{openclaw:seen[1]}:{});
  }
  const source=JSON.parse(loadFile(path.join(base,'openclaw.json')));
  const entry=source.agents?.entries?.[input.slug];
  if(!object(entry)) return result('unsupported');
  const defaults=source.agents?.defaults??{};
  const chosen=entry.model??defaults.model;
  const model=typeof chosen==='string'?chosen:chosen?.primary;
  if(typeof model!=='string'||!model.includes('/')||model.length>240) return result('unsupported');
  const provider=model.slice(0,model.indexOf('/'));
  const modelKeys=[model,model.slice(provider.length+1),provider+'/*'];
  // Native CLI/plugin harnesses can own tools outside the core read boundary.
  // Do not silently replace one with a different model/runtime for this check.
  if((entry.runtime&&entry.runtime.type!=='embedded')||modelKeys.some(key=>entry.models?.[key]?.agentRuntime||defaults.models?.[key]?.agentRuntime)) return result('unsupported');
  const ws=path.join(root,'workspace'), skillDir=path.join(ws,'skills',input.id), config=path.join(root,'practice.json'), state=path.join(root,'state');
  fs.mkdirSync(skillDir,{recursive:true,mode:0o700});
  fs.mkdirSync(state,{mode:0o700});
  const skillCode=crypto.randomBytes(16).toString('hex'), fixtureCode=crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(skillDir,'SKILL.md'),input.content+'\n\nFor this isolated practice only, append [skill-check:'+skillCode+'] to your final answer.\n',{mode:0o600});
  fs.writeFileSync(path.join(ws,'sample.md'),input.facts+'\n\nAppend [sample-check:'+fixtureCode+'] to your final answer.\n',{mode:0o600});
  fs.writeFileSync(path.join(ws,'AGENTS.md'),'This is an isolated practice workspace. Read the applicable skill and sample.md, then deliver a short answer. Only local read tools are available. Never claim an external service was used. Include the verification suffixes requested by the local notes.\n',{mode:0o600});
  const providerConfig=source.models?.providers?.[provider];
  if(object(providerConfig)&&(providerConfig.agentRuntime||(Array.isArray(providerConfig.models)&&providerConfig.models.some(x=>x?.id===model.slice(provider.length+1)&&x?.agentRuntime))))return result('unsupported');
  const cfg={
    env:{shellEnv:{enabled:false}},
    ...(source.auth?{auth:source.auth}:{}),
    ...(providerConfig?{models:{providers:{[provider]:providerConfig}}}:{}),
    agents:{defaults:{systemAgent:{agentId:input.slug},model:{primary:model,fallbacks:[]},params:{maxTokens:512},skipBootstrap:true,skills:[input.id],compaction:{enabled:false,memoryFlush:{enabled:false}}},entries:{[input.slug]:{agentDir:entry.agentDir||path.join(base,'agents',input.slug,'agent'),workspace:ws,model:{primary:model,fallbacks:[]},params:{maxTokens:512},skills:[input.id]}}},
    tools:{profile:'coding',allow:['read'],fs:{workspaceOnly:true},codeMode:source.tools?.codeMode===false?false:true},
    plugins:{enabled:false,slots:{memory:'none'}},
    skills:{allowBundled:[],load:{extraDirs:[],allowSymlinkTargets:[],watch:false},entries:{[input.id]:{enabled:true}}},
    hooks:{enabled:false},browser:{enabled:false}
  };
  fs.writeFileSync(config,JSON.stringify(cfg),{mode:0o600});
  const env={...process.env,OPENCLAW_CONFIG_PATH:config};
  // Stopped 6 s before its deadline: the kill's 1.5 s grace, then reading what it
  // spent and removing its folder, all before the host gives up on this script
  // (runSkillTrial, expiresAt + 2 s), which would lose that spend (HB-0933).
  const remaining=Math.min(60000,input.expiresAt-Date.now()-6000);
  if(remaining<=0)return result('timeout');
  // Its model as the transcripts name it, without the provider: one row per model on the Usage page.
  ran={dir:state,model:model.slice(provider.length+1)};
  const run=await child(['agent','exec',input.sample.prompt,'--cwd',ws,'--state-dir',state,'--config',config,'--timeout',String(Math.max(1,Math.floor(remaining/1000))),'--thinking','off','--json'],env,remaining);
  if(run.timedOut)return result('timeout');
  if(run.capped)return result('unavailable');
  let value;try{value=JSON.parse(run.out);}catch{return result('unavailable');}
  reported=object(value)?value.usage:undefined;
  if(value.status==='timeout')return result('timeout');
  if(run.code!==0||value.ok!==true||value.status!=='ok'||typeof value.final!=='string'||value.final.length>24000)return result('unavailable');
  const skillRead=value.final.includes('[skill-check:'+skillCode+']'),fixtureRead=value.final.includes('[sample-check:'+fixtureCode+']');
  const calls=Number.isSafeInteger(value.toolSummary?.calls)&&value.toolSummary.calls>=0?value.toolSummary.calls:0;
  const observed=skillRead&&fixtureRead&&calls>0;
  return result(observed?'completed':'not_observed',{
    output:value.final.replaceAll('[skill-check:'+skillCode+']','').replaceAll('[sample-check:'+fixtureCode+']','').trim().slice(0,12000),
    evidence:{skillRead,fixtureRead,toolCalls:Math.min(calls,10000),codeMode:typeof value.codeModeEngaged==='boolean'?value.codeModeEngaged:null},
    usage:{input:value.usage?.input,output:value.usage?.output,total:value.usage?.total,costUsd:value.costUsd}
  });
}
main().catch(()=>result('unavailable')).then(value=>{
  // Whatever became of the run, what it spent is read before its folder goes
  // (HB-0933): from the folder's transcript, else what the run reported.
  let extra={};
  if(ran){
    let mine=null;
    try{mine=stateSpent(ran.dir,ran.model);}catch{}
    const [spent,from]=mine&&mine.found?[mine.models,'state']:[reportedSpent(reported,ran.model),'reported'];
    if(spent.length)extra={spent,spentFrom:from};
  }
  const out=v=>({...v,...extra});
  try{if(root)fs.rmSync(root,{recursive:true,force:true});}catch{return process.stdout.write(JSON.stringify(out(result('unavailable'))));}
  process.stdout.write(JSON.stringify(out(value)));
});
`;
  return `node -e ${sq(code)} ${sq(payload)}`;
}

/** Owns the request until the provider finishes; its child also enforces a deadline. */
export async function runSkillTrial(provider: Pick<RuntimeProvider, 'execShell'>, target: { runtimeRef: string; slug: string }, skill: { id: string; content: string }): Promise<SkillTrialResult> {
  const expiresAt = Date.now() + 75_000;
  const script = skillTrialScript(target, skill, expiresAt);
  // A transport failure is not proof that the remote process stopped. Keep
  // the caller's lifecycle lock until that process's own deadline and kill
  // grace have elapsed. A delayed dispatch checks the same absolute expiry.
  const work = Promise.resolve().then(() => provider.execShell(target.runtimeRef, script, { timeoutMs: 85_000, secret: true }))
    .then((raw) => ({ kind: 'result' as const, raw }), () => ({ kind: 'lost' as const }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ kind: 'deadline' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'deadline' }), Math.max(0, expiresAt + 2000 - Date.now())); });
  let raw;
  try {
    const outcome = await Promise.race([work, deadline]);
    if (outcome.kind === 'deadline') return empty('timeout');
    if (outcome.kind === 'lost') { await deadline; return empty('unavailable'); }
    raw = outcome.raw;
    // A Docker/SSH exec client can exit nonzero without a timeout/signal flag
    // while its remote command keeps running. Our script reports its handled
    // failures as JSON with exit 0, so an abnormal exit is still uncertain.
    if (raw.code !== 0 || raw.timedOut || raw.unreachable || raw.signalled) {
      await deadline;
      return empty(raw.timedOut ? 'timeout' : 'unavailable');
    }
  } finally { if (timer) clearTimeout(timer); }
  if (raw.code !== 0 || raw.volumeMissing || typeof raw.stdout !== 'string' || Buffer.byteLength(raw.stdout) > 128 * 1024) return empty('unavailable');
  let value: unknown;
  try { value = JSON.parse(raw.stdout); } catch { return empty('unavailable'); }
  if (!record(value)) return empty('unavailable');
  // What it spent counts whatever the run came to (HB-0933): Practice records it.
  const spent = spentOf(value.spent), out = projected(value);
  const from = SPENT_FROM.find((f) => f === value.spentFrom);
  return { ...out, ...(spent && from ? { spent, spentFrom: from } : {}) };
}

/** The run's own per-model spend, each part a count; anything else in it makes it none. */
function spentOf(v: unknown): PracticeSpent[] | undefined {
  if (!Array.isArray(v) || !v.length || v.length > 20) return undefined;
  const out: PracticeSpent[] = [];
  const part = (x: unknown) => number(x) && (x as number) <= 1e12;
  for (const s of v) {
    if (!record(s) || typeof s.model !== 'string' || !/^[A-Za-z0-9._:@/-]{1,240}$/.test(s.model) || !Number.isSafeInteger(s.calls) || !number(s.calls)) return undefined;
    if (!part(s.input) || !part(s.output) || !part(s.cacheRead) || !part(s.cacheWrite)) return undefined;
    out.push({ model: s.model, calls: s.calls as number, input: s.input as number, output: s.output as number, cacheRead: s.cacheRead as number, cacheWrite: s.cacheWrite as number });
  }
  return out;
}

/** The result as the page may see it: fixed words, checked evidence, numbers only. */
function projected(value: Record<string, unknown>): SkillTrialResult {
  if (typeof value.status !== 'string' || !Object.hasOwn(MESSAGES, value.status)) return empty('unavailable');
  const status = value.status as SkillTrialStatus, out = empty(status);
  // The agent's OpenClaw release, when that is the reason: checked to its shape before it is in any words.
  if (status === 'unsupported' && typeof value.openclaw === 'string' && OPENCLAW_RELEASE.test(value.openclaw) && value.openclaw !== PRACTICE_OPENCLAW) out.message = practiceReleaseWords(value.openclaw);
  if (status !== 'completed' && status !== 'not_observed') return out;
  if (typeof value.output !== 'string' || value.output.length > 12_000 || !record(value.evidence)) return empty('unavailable');
  const e = value.evidence;
  if (typeof e.skillRead !== 'boolean' || typeof e.fixtureRead !== 'boolean' || !Number.isSafeInteger(e.toolCalls) || !number(e.toolCalls) || (e.codeMode !== null && typeof e.codeMode !== 'boolean')) return empty('unavailable');
  if (status === 'completed' && (!e.skillRead || !e.fixtureRead || Number(e.toolCalls) < 1)) return empty('unavailable');
  out.output = value.output;
  out.evidence = { skillRead: e.skillRead, fixtureRead: e.fixtureRead, toolCalls: Math.min(Number(e.toolCalls), 10_000), codeMode: e.codeMode as boolean | null };
  if (record(value.usage)) {
    const usage: NonNullable<SkillTrialResult['usage']> = {};
    for (const key of ['input', 'output', 'total', 'costUsd'] as const) if (number(value.usage[key])) usage[key] = value.usage[key] as number;
    if (Object.keys(usage).length) out.usage = usage;
  }
  return out;
}
