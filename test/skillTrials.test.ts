import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURATED_SKILLS } from '../src/openclaw/skills.js';
import { describeSkillTrial, PRACTICE_OPENCLAW, practiceReleaseWords, runSkillTrial, skillTrialScript } from '../src/orchestrator/skills/skillTrials.js';
import type { ExecResult } from '../src/providers/provider.js';
import { USAGE_READER_SCRIPT } from '../src/orchestrator/usage/usage.js';
import Database from 'better-sqlite3';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const target = { runtimeRef: 'fixture://runtime', slug: 'garden-notes' };
const skill = { id: 'hatchabot-writing', content: '---\nname: hatchabot-writing\ndescription: Write short notes.\n---\n\nPreserve the author’s local style.' };
const response = (value: unknown, extra: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '', ...extra });

function sandbox({ mode = 'ok', native = false, providerNative = false, runtimeModelId = 'anthropic/fixture', codeMode = true, version = '2026.9.8', expiresAt, own }: { mode?: string; native?: boolean; providerNative?: boolean; runtimeModelId?: string; codeMode?: boolean; version?: string; expiresAt?: number; own?: 'db' | 'jsonl' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hb-skill-trial-test-')); dirs.push(home);
  const bin = join(home, 'bin'), state = join(home, '.openclaw'), temporary = join(home, 'tmp');
  mkdirSync(bin); mkdirSync(state); mkdirSync(temporary);
  symlinkSync(process.execPath, join(bin, 'node'));
  // The agent's own transcripts, where the usage sampler reads them, with a
  // call from before the run: 2026.9's database, or 2026.7's session files.
  const ownDir = join(state, 'agents', target.slug);
  const before = JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  if (own === 'db') {
    mkdirSync(join(ownDir, 'agent'), { recursive: true });
    const db = new Database(join(ownDir, 'agent', 'openclaw-agent.sqlite'));
    db.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT, event_zstd BLOB)');
    db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL)').run('main', 1, Date.now() - 60_000, before);
    db.close();
  }
  if (own === 'jsonl') { mkdirSync(join(ownDir, 'sessions'), { recursive: true }); writeFileSync(join(ownDir, 'sessions', 'main.jsonl'), before); }
  const cfg = { agents: { defaults: { model: { primary: 'anthropic/fixture' }, models: native ? { [runtimeModelId]: { agentRuntime: { id: 'claude-cli' } } } : {} }, entries: { [target.slug]: {} } },
    tools: { allow: ['exec', 'browser', 'message'], fs: { workspaceOnly: false }, codeMode },
    auth: { profiles: { 'anthropic:fixture': { provider: 'anthropic', mode: 'api_key' } } },
    models: { providers: { anthropic: { apiKey: 'fixture-only', ...(providerNative ? { agentRuntime: { id: 'claude-cli' } } : {}) }, ignored: { apiKey: 'never-copy-this' } } },
    hooks: { enabled: true }, plugins: { enabled: true }, mcp: { servers: { ignored: {} } } };
  const original = JSON.stringify(cfg);
  writeFileSync(join(state, 'openclaw.json'), original);
  const capture = join(home, 'capture.json');
  writeFileSync(join(bin, 'openclaw'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const argv=process.argv.slice(2);
if(argv[0]==='--version'){process.stdout.write(${JSON.stringify(version)});process.exit(0);}
const workspace=argv[argv.indexOf('--cwd')+1],configPath=argv[argv.indexOf('--config')+1];
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
const content=fs.readFileSync(path.join(workspace,'skills','hatchabot-writing','SKILL.md'),'utf8');
const facts=fs.readFileSync(path.join(workspace,'sample.md'),'utf8');
fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv,configPath,workspace,config,content,facts}));
const mode=${JSON.stringify(mode)};
const zlib=require('node:zlib'),sq=require('node:sqlite');
const call=(id,model,usage)=>JSON.stringify({type:'message',id,timestamp:new Date().toISOString(),message:{role:'assistant',model,usage}});
const asked=JSON.stringify({type:'message',id:'p0',timestamp:new Date().toISOString(),message:{role:'user',content:[{type:'text',text:argv[2]}]}});
// The agent's own directory, where the sampler reads (the run's config names it).
const own=path.dirname(config.agents.entries[${JSON.stringify(target.slug)}].agentDir),ownDb=path.join(own,'agent','openclaw-agent.sqlite'),ownMain=path.join(own,'sessions','main.jsonl');
// Its own conversation goes on meanwhile: a call that is not the run's.
try{if(fs.existsSync(ownDb)){const db=new sq.DatabaseSync(ownDb);db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)').run('main',9,Date.now(),call('m9','claude-opus-4-8',{input:777,output:1}),null);db.close();}}catch{}
if(fs.existsSync(ownMain))fs.appendFileSync(ownMain,'\\n'+call('m9','claude-opus-4-8',{input:777,output:1}));
if(mode==='spend-own-quotes'){
  // A conversation of the agent's own meanwhile that quotes the practice's codes (it read them somewhere), with a call (review P2).
  const codes=/\\[skill-check:[a-f0-9]+\\]/.exec(content)[0]+' '+/\\[sample-check:[a-f0-9]+\\]/.exec(facts)[0];
  const quote=JSON.stringify({type:'message',id:'q0',timestamp:new Date().toISOString(),message:{role:'user',content:[{type:'text',text:'What do these say? '+codes}]}});
  if(fs.existsSync(ownDb)){const db=new sq.DatabaseSync(ownDb),put=db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)');put.run('mine',10,Date.now(),quote,null);put.run('mine',11,Date.now(),call('q1','claude-opus-4-8',{input:9999,output:1}),null);db.close();}
  if(fs.existsSync(ownMain))fs.appendFileSync(ownMain,'\\n'+quote+'\\n'+call('q1','claude-opus-4-8',{input:9999,output:1}));
}
if(mode==='spend-unnamed'){
  // A call its transcript names no model for.
  const dir=path.join(argv[argv.indexOf('--state-dir')+1],'agents',${JSON.stringify(target.slug)},'agent');fs.mkdirSync(dir,{recursive:true});
  const db=new sq.DatabaseSync(path.join(dir,'openclaw-agent.sqlite'));
  db.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT, event_zstd BLOB)');
  db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)').run('s1',1,1,JSON.stringify({type:'message',id:'u1',message:{role:'assistant',usage:{input:20,output:5}}}),null);db.close();
}
if(mode==='prompt-then-timeout'){
  // Cut off before a call finished: its folder holds only its prompt (review P1).
  const dir=path.join(argv[argv.indexOf('--state-dir')+1],'agents',${JSON.stringify(target.slug)},'agent');fs.mkdirSync(dir,{recursive:true});
  const db=new sq.DatabaseSync(path.join(dir,'openclaw-agent.sqlite'));
  db.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT, event_zstd BLOB)');
  db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)').run('s1',0,0,asked,null);db.close();
  process.stdout.write(JSON.stringify({ok:false,status:'timeout',usage:{input:150,output:50,total:200}}));process.exit(2);
}
if(mode==='spend-crowded'){
  // Its folder filled with other files first, more than the walk's 400 entries (review Low 4).
  const stateDir=argv[argv.indexOf('--state-dir')+1];
  for(let i=0;i<450;i++)fs.writeFileSync(path.join(stateDir,'cache-'+i+'.bin'),'x');
  const agentDir=path.join(stateDir,'agents',${JSON.stringify(target.slug)},'agent');fs.mkdirSync(agentDir,{recursive:true});
  for(let i=0;i<450;i++)fs.writeFileSync(path.join(agentDir,'blob-'+i+'.bin'),'x');
}
if(mode==='spend'||mode==='spend-killed'||mode==='spend-own-quotes'||mode==='spend-crowded'){
  // The run's own transcript in its state folder, as 2026.9 keeps one: calls in
  // the agent's database (one compressed), a session file, a channel's copy of
  // a reply, a person's line, and one call in both places.
  const stateDir=argv[argv.indexOf('--state-dir')+1];
  const dir=path.join(stateDir,'agents',${JSON.stringify(target.slug)},'agent');fs.mkdirSync(dir,{recursive:true});
  const db=new sq.DatabaseSync(path.join(dir,'openclaw-agent.sqlite'));
  if(mode==='spend-killed')db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT, event_zstd BLOB)');
  const put=db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)');
  put.run('s1',0,0,asked,null);
  put.run('s1',1,1,call('e1','claude-opus-4-8',{input:100,output:40,cacheRead:2000,cacheWrite:300}),null);
  put.run('s1',2,2,null,zlib.zstdCompressSync(Buffer.from(call('e2','claude-opus-4-8',{input:50,output:10,cacheRead:2100,cacheWrite:0}))));
  put.run('s1',3,3,JSON.stringify({type:'message',id:'e3',message:{role:'assistant',model:'delivery-mirror',usage:{input:0,output:0}}}),null);
  put.run('s1',4,4,JSON.stringify({type:'message',id:'e4',message:{role:'user',content:'sample'}}),null);
  const sessions=path.join(stateDir,'agents',${JSON.stringify(target.slug)},'sessions');fs.mkdirSync(sessions,{recursive:true});
  fs.writeFileSync(path.join(sessions,'s2.jsonl'),[call('e1','claude-opus-4-8',{input:100,output:40,cacheRead:2000,cacheWrite:300}),call('e5','claude-haiku-4-5',{input:7,output:3}),'not json'].join('\\n'));
  // Killed at its limit: the database is left open, its writes still in the WAL file.
  if(mode==='spend-killed'){setTimeout(()=>{},10000);return;}
  db.close();
}
if(mode==='delay'){setTimeout(()=>{},10000);return;}
if(mode==='error'){process.stderr.write('private credential fixture must never return');process.exit(2);}
if(mode==='runtime-timeout'){process.stdout.write(JSON.stringify({ok:false,status:'timeout'}));process.exit(2);}
if(mode==='runtime-timeout-usage'){process.stdout.write(JSON.stringify({ok:false,status:'timeout',usage:{input:30,output:4,total:534}}));process.exit(2);}
const skill=/\\[skill-check:([a-f0-9]+)\\]/.exec(content)[0], sample=/\\[sample-check:([a-f0-9]+)\\]/.exec(facts)[0];
const final=(mode==='unicode-chunks'?'A café announcement: grow 🌱.':'The seed library opens Saturday at 10. Please bring envelopes.')+(mode==='missing'?'':' '+skill+' '+sample);
const output=JSON.stringify({ok:true,status:'ok',final,toolSummary:{calls:mode==='no-tools'?0:2,tools:['read']},codeModeEngaged:${String(codeMode)},usage:{input:100,output:40,total:140},costUsd:0.001});
if(mode==='unicode-chunks'){
  const bytes=Buffer.from(output),split=bytes.indexOf(Buffer.from('é'))+1;
  process.stdout.write(bytes.subarray(0,split));setTimeout(()=>process.stdout.write(bytes.subarray(split)),20);
}else process.stdout.write(output);
`, { mode: 0o700 });
  const script = skillTrialScript(target, skill, expiresAt).replaceAll('/home/node/.openclaw', state);
  const run = () => {
    const result = spawnSync('/bin/sh', ['-c', script], { cwd: home,
      env: { HOME: home, PATH: bin, TMPDIR: temporary, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' },
      encoding: 'utf8', timeout: 12000, maxBuffer: 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(state, 'openclaw.json'), 'utf8')).toBe(original);
    return JSON.parse(result.stdout);
  };
  /** The usage sampler's reading of the agent's own transcripts now (usage.ts USAGE_READER_SCRIPT). */
  const sampler = () => {
    const r = spawnSync(process.execPath, ['-e', USAGE_READER_SCRIPT.replace('"/home/node/.openclaw/agents"', JSON.stringify(join(state, 'agents')))], { cwd: home, env: { HOME: home, PATH: bin }, encoding: 'utf8', timeout: 8000 });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout).models as Record<string, { calls: number; input: number }>;
  };
  return { run, capture, state, temporary, sampler, ownDb: join(ownDir, 'agent', 'openclaw-agent.sqlite') };
}

describe('practice metadata and validation', () => {
  it('provides a fixed draft-only sample for every curated pack', () => {
    for (const { id } of CURATED_SKILLS) expect(describeSkillTrial(id)).toMatchObject({ scope: 'practice', timeoutSeconds: 60, maxOutputTokensPerResponse: 512 });
    expect(describeSkillTrial('hatchabot-jira').prompt).toContain('Do not create');
    expect(describeSkillTrial('hatchabot-images').prompt).toContain('Do not generate');
    expect(() => describeSkillTrial('__proto__')).toThrow('Choose a skill');
  });
  it.each(['../outside', '', 'WITH SPACE'])('rejects invalid slug %j before any execution', async (slug) => {
    const execShell = vi.fn();
    await expect(runSkillTrial({ execShell }, { ...target, slug }, skill)).rejects.toThrow('cannot be used');
    expect(execShell).not.toHaveBeenCalled();
  });
  it.each(['', 'x'.repeat(65 * 1024)])('refuses an unreadable or overlarge skill', (content) => {
    expect(() => skillTrialScript(target, { ...skill, content })).toThrow('cannot be used');
  });
});

describe('the generated runner against an isolated CLI shim', () => {
  it('uses copied local instructions and local facts, reports actual evidence, and removes its entire temporary workspace', () => {
    const s = sandbox();
    const r = s.run();
    expect(r).toMatchObject({ status: 'completed', output: 'The seed library opens Saturday at 10. Please bring envelopes.', evidence: { skillRead: true, fixtureRead: true, toolCalls: 2, codeMode: true }, usage: { total: 140, costUsd: 0.001 } });
    const saved = JSON.parse(readFileSync(s.capture, 'utf8'));
    expect(saved.content).toContain(skill.content);
    expect(saved.configPath.startsWith(saved.workspace + '/')).toBe(false);
    expect(saved.config.tools).toEqual({ profile: 'coding', allow: ['read'], fs: { workspaceOnly: true }, codeMode: true });
    expect(saved.config.plugins).toEqual({ enabled: false, slots: { memory: 'none' } });
    expect(saved.config.hooks.enabled).toBe(false);
    expect(saved.config.browser.enabled).toBe(false);
    expect(saved.config.mcp).toBeUndefined();
    expect(saved.config.agents.defaults.params.maxTokens).toBe(512);
    expect(saved.config.agents.entries[target.slug].agentDir).toBe(join(s.state, 'agents', target.slug, 'agent'));
    expect(saved.config.models.providers.ignored).toBeUndefined();
    expect(saved.argv).not.toContain('--deliver');
    expect(saved.argv).toContain('--json');
    expect(saved.argv[saved.argv.indexOf('--state-dir') + 1]).toBe(join(saved.workspace, '..', 'state'));
    expect(existsSync(saved.workspace)).toBe(false);
    expect(existsSync(saved.configPath)).toBe(false);
  });
  it('preserves an explicit direct-tool mode and its separate evidence', () => {
    const s = sandbox({ codeMode: false });
    expect(s.run().evidence.codeMode).toBe(false);
    expect(JSON.parse(readFileSync(s.capture, 'utf8')).config.tools.codeMode).toBe(false);
  });
  it('preserves Unicode when a model response splits a UTF-8 character across stdout chunks', () => {
    expect(sandbox({ mode: 'unicode-chunks' }).run()).toMatchObject({ status: 'completed', output: 'A café announcement: grow 🌱.' });
  });
  it.each(['missing', 'no-tools'])('does not call %s evidence a successful practice', (mode) => {
    expect(sandbox({ mode }).run().status).toBe('not_observed');
  });
  it('never exposes CLI stderr or raw provider failures', () => {
    expect(sandbox({ mode: 'error' }).run()).toEqual({ status: 'unavailable' });
  });
  it.each([{ version: '2026.8.1' }, { native: true }, { providerNative: true }, { native: true, runtimeModelId: 'anthropic/*' }, { native: true, runtimeModelId: 'fixture' }])('refuses unsupported runtime/harness %j before the model command', (options) => {
    const s = sandbox(options);
    expect(s.run()).toEqual({ status: 'unsupported', ...(options.version ? { openclaw: options.version } : {}) });
    expect(existsSync(s.capture)).toBe(false);
  });
  // HB-1253: after an OpenClaw upgrade Practice said only that "this runtime" did not support it.
  it.each([['2026.10.1', '2026.10.1'], ['OpenClaw 2026.10.1 (made-up)', '2026.10.1'], ['OpenClaw 2026.9.8-beta.2', '2026.9.8-beta.2'], ['not a version', undefined]])('names the OpenClaw release it refuses, %s, before the model command', (version, named) => {
    const s = sandbox({ version });
    expect(s.run()).toEqual({ status: 'unsupported', ...(named ? { openclaw: named } : {}) });
    expect(existsSync(s.capture)).toBe(false);
  });
  it('lets in only the release it was checked on, as before', () => {
    for (const version of ['2026.9.8', 'OpenClaw 2026.9.8 (made-up)']) expect(sandbox({ version }).run().status, version).toBe('completed');
  });
  it('rejects symlinked config before starting a model', () => {
    const s = sandbox(), source = join(s.state, 'openclaw.json'), other = join(s.state, 'other.json');
    writeFileSync(other, readFileSync(source)); rmSync(source); symlinkSync(other, source);
    expect(s.run()).toEqual({ status: 'unavailable' });
    expect(existsSync(s.capture)).toBe(false);
  });
  it('kills an over-budget child and cleans up after it before returning', () => {
    const s = sandbox({ mode: 'delay', expiresAt: Date.now() + 7500 });
    expect(s.run()).toEqual({ status: 'timeout' });
    const saved = JSON.parse(readFileSync(s.capture, 'utf8'));
    expect(existsSync(saved.workspace)).toBe(false);
  });
  it('preserves the runtime’s structured timeout even when its CLI exits nonzero', () => {
    expect(sandbox({ mode: 'runtime-timeout' }).run()).toEqual({ status: 'timeout' });
  });
});

describe('what a practice run spent, read before its folder goes, counted once (HB-0933)', () => {
  const byModel = (spent: Array<{ model: string }>) => [...spent].sort((a, b) => a.model.localeCompare(b.model));
  const TRANSCRIPT = [
    { model: 'claude-haiku-4-5', calls: 1, input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
    { model: 'claude-opus-4-8', calls: 2, input: 150, output: 50, cacheRead: 4_100, cacheWrite: 300 },
  ];
  it('its transcript in its state folder: every call by model, each once, a channel copy and a person’s line not calls; the sampler never sees it', () => {
    const s = sandbox({ mode: 'spend', own: 'db' });
    const r = s.run();
    expect(r.status).toBe('completed');
    expect(r.spentFrom).toBe('state');
    expect(byModel(r.spent)).toEqual(TRANSCRIPT);
    expect(existsSync(JSON.parse(readFileSync(s.capture, 'utf8')).workspace)).toBe(false);
    // The agent's own transcripts: its call from before and the one it made meanwhile, not the run's.
    expect(s.sampler()['claude-opus-4-8']).toMatchObject({ calls: 2, input: 5_777 });
    // Its prompt goes as it is: nothing marks it for finding elsewhere.
    expect(JSON.parse(readFileSync(s.capture, 'utf8')).argv[2]).toBe(describeSkillTrial(skill.id).prompt);
  });
  it.each(['db', 'jsonl'] as const)('the agent’s own transcripts (%s) are never taken as the practice’s: a conversation of its own that quotes its codes stays its own (review P2)', (own) => {
    const s = sandbox({ mode: 'spend-own-quotes', own });
    const r = s.run();
    expect(r.spentFrom).toBe('state');
    expect(byModel(r.spent)).toEqual(TRANSCRIPT);
    // That conversation's call is the agent's own, counted by the sampler, once.
    expect(s.sampler()['claude-opus-4-8']).toMatchObject({ calls: 3, input: 5_000 + 777 + 9_999 });
  });
  it('its folder holding only its prompt, a timed-out run: what it reported, and a call of the agent’s own meanwhile stays the agent’s (review P1)', () => {
    const s = sandbox({ mode: 'prompt-then-timeout', own: 'db' });
    expect(s.run()).toEqual({ status: 'timeout', spentFrom: 'reported',
      spent: [{ model: 'fixture', calls: 0, input: 150, output: 50, cacheRead: 0, cacheWrite: 0 }] });
    expect(s.sampler()['claude-opus-4-8']).toMatchObject({ calls: 2, input: 5_777 });
  });
  it('its transcript where 2026.9.8 keeps it is read first, however many other files its folder holds', () => {
    const r = sandbox({ mode: 'spend-crowded' }).run();
    expect(r.spentFrom).toBe('state');
    expect(byModel(r.spent)).toEqual(TRANSCRIPT);
  });
  it('a run cut off at its limit: what its transcript holds by then, from a database it left open', () => {
    const s = sandbox({ mode: 'spend-killed', expiresAt: Date.now() + 8000 });
    const r = s.run();
    expect(r.status).toBe('timeout');
    expect(r.spentFrom).toBe('state');
    expect(byModel(r.spent)).toEqual(TRANSCRIPT);
    expect(existsSync(JSON.parse(readFileSync(s.capture, 'utf8')).workspace)).toBe(false);
  });
  it('a run cut off at its limit is stopped early enough that what it spent is read before the host gives up (expiresAt + 2 s)', () => {
    const expiresAt = Date.now() + 9000;
    const r = sandbox({ mode: 'spend-killed', expiresAt }).run();
    // Stopped 6 s before, 1.5 s for the kill, then the read: done 4 s or more before its deadline.
    expect(Date.now()).toBeLessThanOrEqual(expiresAt - 4000);
    expect([r.status, r.spentFrom]).toEqual(['timeout', 'state']);
  });
  it('its folder holding no call, a timed-out run: what it reported, its four parts only, under the model’s name as transcripts give it', () => {
    expect(sandbox({ mode: 'runtime-timeout-usage', own: 'db' }).run()).toEqual({ status: 'timeout', spentFrom: 'reported',
      spent: [{ model: 'fixture', calls: 0, input: 30, output: 4, cacheRead: 0, cacheWrite: 0 }] });
  });
  it('a call its transcript names no model for: under the run’s model, as transcripts name it', () => {
    const r = sandbox({ mode: 'spend-unnamed' }).run();
    expect([r.spentFrom, r.spent]).toEqual(['state', [{ model: 'fixture', calls: 1, input: 20, output: 5, cacheRead: 0, cacheWrite: 0 }]]);
  });
  it('its folder holding no call, a finished run: what it reported', () => {
    const r = sandbox().run();
    expect(r.spentFrom).toBe('reported');
    expect(r.spent).toEqual([{ model: 'fixture', calls: 0, input: 100, output: 40, cacheRead: 0, cacheWrite: 0 }]);
  });
  it('nothing for a run that never called the model', () => {
    expect(sandbox({ version: '2026.8.1' }).run()).toEqual({ status: 'unsupported', openclaw: '2026.8.1' });
  });
  it('the provider boundary passes it on whatever the run came to, with where it came from, and drops a malformed one', async () => {
    const spent = [{ model: 'anthropic/claude-opus-4-8', calls: 1, input: 5, output: 2, cacheRead: 0, cacheWrite: 0 }];
    const timeout = await runSkillTrial({ execShell: async () => response({ status: 'timeout', spent, spentFrom: 'reported' }) }, target, skill);
    expect(timeout).toMatchObject({ status: 'timeout', spent, spentFrom: 'reported' });
    const lost = await runSkillTrial({ execShell: async () => response({ status: 'completed', spent, spentFrom: 'state' }) }, target, skill);
    expect(lost).toMatchObject({ status: 'unavailable', spent, spentFrom: 'state' });
    for (const bad of [[{ ...spent[0], input: -1 }], [{ ...spent[0], model: 'a b' }], [{ ...spent[0], calls: 1.5 }], Array(21).fill(spent[0]), 'many'])
      expect((await runSkillTrial({ execShell: async () => response({ status: 'timeout', spent: bad, spentFrom: 'state' }) }, target, skill)).spent).toBeUndefined();
    // Not saying where it came from, it is not known whether the sampler counts it: none.
    expect((await runSkillTrial({ execShell: async () => response({ status: 'timeout', spent }) }, target, skill)).spent).toBeUndefined();
    expect((await runSkillTrial({ execShell: async () => response({ status: 'timeout', spent, spentFrom: 'elsewhere' }) }, target, skill)).spent).toBeUndefined();
    // The agent's own transcripts are no place it comes from any more.
    expect((await runSkillTrial({ execShell: async () => response({ status: 'timeout', spent, spentFrom: 'store' }) }, target, skill)).spent).toBeUndefined();
  });
});

describe('provider boundary and safe result projection', () => {
  it("says Practice was refused for the agent's OpenClaw release, by name, and only a release's shape is put in words (HB-1253)", async () => {
    const said = async (value: unknown) => (await runSkillTrial({ execShell: async () => response(value) }, target, skill)).message;
    const plain = 'This runtime or model harness does not support the isolated practice check.';
    expect(await said({ status: 'unsupported', openclaw: '2026.10.1' })).toBe(practiceReleaseWords('2026.10.1'));
    expect(practiceReleaseWords('2026.10.1')).toBe(`Practice runs only on OpenClaw ${PRACTICE_OPENCLAW} so far, and this agent runs OpenClaw 2026.10.1: nothing was run or spent. A later Hatchabot release adds that version once it has been checked.`);
    for (const openclaw of [undefined, 'private words', '2026.10.1; rm', PRACTICE_OPENCLAW, 2026]) expect(await said({ status: 'unsupported', openclaw }), String(openclaw)).toBe(plain);
    // Only an unsupported answer is worded so.
    expect(await said({ status: 'timeout', openclaw: '2026.10.1' })).not.toContain('2026.10.1');
  });
  // Review of HB-1253: an older release was told a later Hatchabot release adds it. Its way out is a rebuild,
  // onto an image that has the release: the Fleet default may not, after a rollback, and the place
  // to pick one is named as the agent's sheet names it (its Advanced tab, the Runtime row, Image).
  it('an older OpenClaw release is told to rebuild onto an image with the one Practice runs on, and where to pick it; only a newer one waits for a later Hatchabot release', async () => {
    const said = async (openclaw: string) => (await runSkillTrial({ execShell: async () => response({ status: 'unsupported', openclaw }) }, target, skill)).message;
    const older = (v: string) => `Practice runs only on OpenClaw ${PRACTICE_OPENCLAW} so far, and this agent runs OpenClaw ${v}, an older one: nothing was run or spent. `
      + `Rebuild it onto an image with OpenClaw ${PRACTICE_OPENCLAW} (its memory, files and members are kept), then try again: in its Advanced tab, under Runtime, `
      + `pick an Image with ${PRACTICE_OPENCLAW} (the list names each image's OpenClaw; Fleet default has ${PRACTICE_OPENCLAW} unless the fleet was moved to another) `
      + 'and press Pin & rebuild, or Rebuild when that one is picked already.';
    const newer = (v: string) => `Practice runs only on OpenClaw ${PRACTICE_OPENCLAW} so far, and this agent runs OpenClaw ${v}: nothing was run or spent. A later Hatchabot release adds that version once it has been checked.`;
    for (const v of ['2026.8.1', '2026.9.6', '2025.12.30', '2026.9.8-beta.2', '2026.7.1-2', '2026.9.7-3']) expect(await said(v), v).toBe(older(v));
    // By number, not as text: 2026.9.10 and 2026.10.1 come after 2026.9.8. A
    // number after the dash is a later build of a release, as OpenClaw names
    // its builds ("OpenClaw 2026.7.1-2"), not one before it: a word is (review).
    for (const v of ['2026.9.10', '2026.10.1', '2027.1.1', '2026.9.9-beta.1', '2026.9.8-2', '2026.9.8-1']) expect(await said(v), v).toBe(newer(v));
  });
  it('uses a bounded sensitive script and fixed metadata, never trusting runtime messages or extra fields', async () => {
    const execShell = vi.fn(async () => response({ status: 'completed', output: 'Sample draft.', evidence: { skillRead: true, fixtureRead: true, toolCalls: 2, codeMode: true, path: 'private' }, usage: { input: 5, output: -1, total: 8, costUsd: 0.001, credential: 'private' }, message: 'private' }));
    const r = await runSkillTrial({ execShell }, target, skill);
    expect(execShell).toHaveBeenCalledWith(target.runtimeRef, expect.stringContaining('node -e '), { timeoutMs: 85000, secret: true });
    expect(r.status).toBe('completed');
    expect(r.usage).toEqual({ input: 5, total: 8, costUsd: 0.001 });
    expect(JSON.stringify(r)).not.toContain('private');
    expect(r.limits).toEqual({ timeoutSeconds: 60, maxOutputTokensPerResponse: 512 });
  });
  it.each([
    null, {}, { status: '__proto__' }, { status: 'completed' },
    { status: 'completed', output: 'draft', evidence: { skillRead: false, fixtureRead: true, toolCalls: 2, codeMode: true } },
    { status: 'completed', output: 'draft', evidence: { skillRead: true, fixtureRead: true, toolCalls: 0, codeMode: true } },
    { status: 'completed', output: 'draft', evidence: { skillRead: true, fixtureRead: true, toolCalls: 1, codeMode: 'yes' } },
  ])('treats malformed or contradictory output as unknown: %j', async (value) => {
    const r = await runSkillTrial({ execShell: async () => response(value) }, target, skill);
    expect(r.status).toBe('unavailable'); expect(r.output).toBeUndefined();
  });
  it('reports a transport timeout separately without returning partial output', async () => {
    vi.useFakeTimers();
    const run = runSkillTrial({ execShell: async () => response({}, { timedOut: true, stdout: 'private' }) }, target, skill);
    await vi.advanceTimersByTimeAsync(77_000);
    expect((await run).status).toBe('timeout');
  });
  it('holds uncertain transport failure through the remote deadline before sanitizing it', async () => {
    vi.useFakeTimers(); let settled = false;
    const run = runSkillTrial({ execShell: async () => { throw Error('private'); } }, target, skill).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(76_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect((await run).status).toBe('unavailable');
  });
  it.each([1, 125, 255])('holds exec transport exit %s through the remote deadline even without failure flags', async (code) => {
    vi.useFakeTimers(); let settled = false;
    const run = runSkillTrial({ execShell: async () => response({}, { code, stdout: '', stderr: 'exec transport closed' }) }, target, skill)
      .then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(76_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect((await run).status).toBe('unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds an unresponsive provider and observes a reply that arrives after the deadline', async () => {
    vi.useFakeTimers(); let release!: (r: ExecResult) => void, settled = false;
    const run = runSkillTrial({ execShell: () => new Promise((resolve) => { release = resolve; }) }, target, skill).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(76_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect((await run).status).toBe('timeout');
    release(response({ status: 'unavailable' })); await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('sanitizes oversized output', async () => {
    expect((await runSkillTrial({ execShell: async () => response({}, { stdout: 'x'.repeat(129 * 1024) }) }, target, skill)).status).toBe('unavailable');
  });
});
