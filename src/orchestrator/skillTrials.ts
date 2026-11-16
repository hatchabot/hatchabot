import { CURATED_SKILLS } from '../openclaw/skills.js';
import type { RuntimeProvider } from '../providers/provider.js';

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
export interface SkillTrialResult {
  status: SkillTrialStatus;
  output?: string;
  evidence: { skillRead: boolean; fixtureRead: boolean; toolCalls: number; codeMode: boolean | null };
  usage?: { input?: number; output?: number; total?: number; costUsd?: number };
  limits: typeof SKILL_TRIAL_LIMITS;
  message: string;
}
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
let root;
const result=(status,extra={})=>({status,...extra});
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
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
  if(version.code!==0||!/^OpenClaw\s+2026\.9\.8(?:\s|$)|^2026\.9\.8(?:\s|$)/m.test(version.out)) return result('unsupported');
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
  const remaining=Math.min(60000,input.expiresAt-Date.now()-2000);
  if(remaining<=0)return result('timeout');
  const run=await child(['agent','exec',input.sample.prompt,'--cwd',ws,'--state-dir',state,'--config',config,'--timeout',String(Math.max(1,Math.floor(remaining/1000))),'--thinking','off','--json'],env,remaining);
  if(run.timedOut)return result('timeout');
  if(run.capped)return result('unavailable');
  let value;try{value=JSON.parse(run.out);}catch{return result('unavailable');}
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
main().catch(()=>result('unavailable')).then(value=>{try{if(root)fs.rmSync(root,{recursive:true,force:true});}catch{return process.stdout.write(JSON.stringify(result('unavailable')));}process.stdout.write(JSON.stringify(value));});
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
  if (!record(value) || typeof value.status !== 'string' || !Object.hasOwn(MESSAGES, value.status)) return empty('unavailable');
  const status = value.status as SkillTrialStatus, out = empty(status);
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
