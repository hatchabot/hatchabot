import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURATED_SKILLS } from '../src/openclaw/skills.js';
import { describeSkillTrial, runSkillTrial, skillTrialScript } from '../src/orchestrator/skillTrials.js';
import type { ExecResult } from '../src/providers/provider.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const target = { runtimeRef: 'fixture://runtime', slug: 'garden-notes' };
const skill = { id: 'hatchabot-writing', content: '---\nname: hatchabot-writing\ndescription: Write short notes.\n---\n\nPreserve the author’s local style.' };
const response = (value: unknown, extra: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '', ...extra });

function sandbox({ mode = 'ok', native = false, providerNative = false, runtimeModelId = 'anthropic/fixture', codeMode = true, version = '2026.9.8', expiresAt }: { mode?: string; native?: boolean; providerNative?: boolean; runtimeModelId?: string; codeMode?: boolean; version?: string; expiresAt?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hb-skill-trial-test-')); dirs.push(home);
  const bin = join(home, 'bin'), state = join(home, '.openclaw'), temporary = join(home, 'tmp');
  mkdirSync(bin); mkdirSync(state); mkdirSync(temporary);
  symlinkSync(process.execPath, join(bin, 'node'));
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
if(mode==='delay'){setTimeout(()=>{},10000);return;}
if(mode==='error'){process.stderr.write('private credential fixture must never return');process.exit(2);}
if(mode==='runtime-timeout'){process.stdout.write(JSON.stringify({ok:false,status:'timeout'}));process.exit(2);}
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
      encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(state, 'openclaw.json'), 'utf8')).toBe(original);
    return JSON.parse(result.stdout);
  };
  return { run, capture, state, temporary };
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
    expect(s.run()).toEqual({ status: 'unsupported' });
    expect(existsSync(s.capture)).toBe(false);
  });
  it('rejects symlinked config before starting a model', () => {
    const s = sandbox(), source = join(s.state, 'openclaw.json'), other = join(s.state, 'other.json');
    writeFileSync(other, readFileSync(source)); rmSync(source); symlinkSync(other, source);
    expect(s.run()).toEqual({ status: 'unavailable' });
    expect(existsSync(s.capture)).toBe(false);
  });
  it('kills an over-budget child and cleans up after it before returning', () => {
    const s = sandbox({ mode: 'delay', expiresAt: Date.now() + 2800 });
    expect(s.run()).toEqual({ status: 'timeout' });
    const saved = JSON.parse(readFileSync(s.capture, 'utf8'));
    expect(existsSync(saved.workspace)).toBe(false);
  });
  it('preserves the runtime’s structured timeout even when its CLI exits nonzero', () => {
    expect(sandbox({ mode: 'runtime-timeout' }).run()).toEqual({ status: 'timeout' });
  });
});

describe('provider boundary and safe result projection', () => {
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
