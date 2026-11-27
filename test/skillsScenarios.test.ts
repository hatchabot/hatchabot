import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-expect-error — isolated runner with injected boundaries, plain .mjs
import { runSkillsScenarios } from '../scripts/skills-scenarios.mjs';

const PACK = 'hatchabot-writing', RUN = 'fixture-unique-run';
const RECEIPT = '/home/node/.openclaw/skill-acceptance-receipt.json';
const FIXTURE = '/home/node/.local/bin/hatchabot-skill-fixture';
const WORKSPACE = '/home/node/.openclaw/agents/fixture/agent';
const SKILL = `${WORKSPACE}/skills/${PACK}/SKILL.md`;
type Agent = { id: string; name: string; slug: string; hostId: string; state: string; runtimeRef: string; webOnly: boolean; role?: string; botUsername?: string };
type Options = { method?: string; body?: any; timeoutMs?: number; signal?: AbortSignal };
type Faults = { inventory?: boolean; applied?: boolean; custom?: boolean; noInvocation?: boolean; noCodeMode?: boolean; metadataOnly?: boolean; command?: boolean; telegram?: boolean; cleanup?: boolean; lostCreate?: boolean; failedCreate?: boolean; collision?: boolean; conflict?: boolean; profiles?: Promise<void>;
  filePreview?: boolean; unsafeUpdate?: boolean; replaceFailure?: boolean; rollbackBytes?: boolean; staleAllowed?: boolean;
  practiceStatus?: string; practiceBusy?: boolean; practiceMissingReads?: boolean; practiceWrites?: boolean;
  /** Where a practice's tokens land in the agent's usage: its record only (the default: the transcript went with its folder),
   * its record with calls of the agent's own meanwhile on its model (`other`, one small; `otherBig`, one larger than the practice) or
   * another (`otherModel`), its record and the agent's own transcripts both (`twice`; `twiceUnder`: its calls there count fewer tokens
   * than the record, under twice in all, HB-1249), its record written twice (`rows`), a record of what the run reported, with no calls,
   * and the run in the agent's own transcripts too (`reported`, HB-1249 review), recorded but not in the total (`lost`), neither
   * (`none`), or the read fails (`unread`). */
  practiceUsage?: 'other' | 'otherBig' | 'otherModel' | 'twice' | 'twiceUnder' | 'rows' | 'reported' | 'lost' | 'none' | 'unread' };
const PRACTICE_TOKENS = 1_234, PRACTICE_CALLS = 2;

/** All install, runtime and model boundaries are injected. No helper that
 * reads local install configuration is imported or invoked by this fixture. */
function world(fault: Faults = {}) {
  const agents: Agent[] = [{ id: 'unrelated', name: `zz skills test ${RUN}-different`, slug: 'other', hostId: 'local', state: 'RUNNING', runtimeRef: 'docker://other', webOnly: true, role: 'owner' }];
  if (fault.collision) agents.push({ ...agents[0]!, id: 'existing', name: `zz skills test ${RUN}` });
  const calls: { path: string; options: Options }[] = [];
  const commands: { argv: string[]; timeout: number; options: any }[] = [];
  const reports: { name: string; ok: boolean; error?: string }[] = [];
  const files = new Map<string, string>();
  let selected = ['gog'], applied = ['gog'], turns = 0, profileRead = false, fileVersion = 0, backup: string | undefined;
  // The agent's usage as GET /v1/agents/:id/usage folds it: what its own transcripts hold, by model, plus the practice they do not.
  const own = new Map<string, { tokens: number; calls: number }>([['fixture-model', { tokens: 40_000, calls: 12 }]]);
  const ownAdds = (model: string, tokens: number, calls: number) => { const m = own.get(model) ?? { tokens: 0, calls: 0 }; own.set(model, { tokens: m.tokens + tokens, calls: m.calls + calls }); };
  let practiced = 0, practiceCalls = 0, runs = 0, added = 0;
  const catalogContent = '# Fixture writing instructions\n';
  const filePreview = () => ({ revision: createHash('sha256').update(JSON.stringify([files.get(SKILL), fileVersion])).digest('hex'),
    state: files.get(SKILL) === catalogContent ? 'current' : 'customized', installed: { content: files.get(SKILL) },
    catalog: { content: catalogContent, version: '1.0.0' }, canRollback: backup !== undefined });
  const response = (json: any, status = 200) => ({ status, json });
  const lib = {
    requireRoom: vi.fn(async () => {}),
    workspaceOf: () => WORKSPACE,
    sleep: async () => {}, log: () => {},
    async api(path: string, options: Options = {}) {
      calls.push({ path, options });
      options.signal?.throwIfAborted();
      const method = options.method ?? 'GET';
      if (path === '/v1/ai-profiles') {
        profileRead = true;
        await fault.profiles;
        options.signal?.throwIfAborted();
        return response([{ id: 'source', defaultSource: true }]);
      }
      if (path === '/v1/hosts') return response([{ id: 'local', kind: 'local' }]);
      if (path === '/v1/agents' && method === 'GET') return response(agents.map((agent) => ({ ...agent })));
      if (path === '/v1/agents' && method === 'POST') {
        if (fault.conflict) {
          agents.push({ ...agents[0]!, id: 'concurrent', name: options.body.name });
          return response({}, 409);
        }
        const agent: Agent = { id: 'mine', name: options.body.name, slug: 'fixture', hostId: 'local', state: 'RUNNING', runtimeRef: 'docker://fixture', webOnly: !fault.telegram, role: 'owner' };
        if (fault.telegram) agent.botUsername = 'fixture-bot';
        agents.push(agent);
        if (fault.lostCreate) throw new Error('creation response lost');
        if (fault.failedCreate) return response({}, 500);
        return response({ ...agent, webOnly: fault.telegram ? false : undefined }, 202);
      }
      const match = /^\/v1\/agents\/([^/?]+)(.*)$/.exec(path);
      if (!match) throw new Error(`Unexpected API: ${method} ${path}`);
      const agent = agents.find((candidate) => candidate.id === match[1]);
      if (!agent) return response({}, 404);
      if (method === 'DELETE') {
        if (fault.cleanup) return response({}, 503);
        agents.splice(agents.indexOf(agent), 1); return response({});
      }
      const tail = match[2];
      if (!tail) return response({ ...agent });
      if (tail === '/skills') {
        if (method === 'PUT') selected = [...options.body.selected];
        return response({ selected: [...selected], applied: fault.applied ? ['gog'] : [...applied], pending: JSON.stringify(applied) !== JSON.stringify(selected) });
      }
      if (tail === '/skills/status') return response({ status: 'checked', skills: [{ id: PACK, status: fault.inventory ? 'unavailable' : applied.includes(PACK) ? 'available' : 'disabled' }] });
      if (tail === `/skills/${PACK}/file`) {
        if (method === 'GET') return response(fault.filePreview ? {} : filePreview());
        if (options.body.expectedRevision !== filePreview().revision && !fault.staleAllowed) return response({}, 409);
        if (options.body.action === 'update') return response({}, fault.unsafeUpdate ? 200 : 409);
        if (options.body.action === 'replace') {
          if (fault.replaceFailure) return response({}, 503);
          backup = files.get(SKILL); files.set(SKILL, catalogContent);
        } else if (options.body.action === 'rollback') {
          const old = files.get(SKILL); files.set(SKILL, fault.rollbackBytes ? catalogContent : backup!); backup = old;
        } else throw new Error('Unexpected skill file action');
        fileVersion++; return response(filePreview());
      }
      if (tail === `/skills/${PACK}/try`) {
        if (fault.practiceBusy) return response({}, 409);
        if (options.body.expectedRevision !== filePreview().revision) return response({}, 409);
        if (fault.practiceStatus === 'unsupported') return response({ status: 'unsupported' });
        turns++;
        if (fault.practiceWrites) files.set(SKILL, 'unexpected practice edit');
        const lands = fault.practiceUsage;
        if (lands === 'twice' || lands === 'reported') ownAdds('fixture-model', PRACTICE_TOKENS, PRACTICE_CALLS);
        if (lands === 'twiceUnder') ownAdds('fixture-model', 900, PRACTICE_CALLS);
        if (lands === 'other') ownAdds('fixture-model', 300, 1);
        if (lands === 'otherBig') ownAdds('fixture-model', 3_000, 1);
        if (lands === 'otherModel') ownAdds('fixture-other-model', 5_000, 3);
        const records = lands === 'none' ? 0 : lands === 'rows' ? 2 : 1;
        runs += records; practiced += records * PRACTICE_TOKENS; practiceCalls += lands === 'reported' ? 0 : records * PRACTICE_CALLS;
        if (lands !== 'lost') added += records * PRACTICE_TOKENS;
        return response({ status: fault.practiceStatus ?? 'completed', output: 'The seed library opens Saturday at 10.',
          evidence: { skillRead: !fault.practiceMissingReads, fixtureRead: true, toolCalls: 2, codeMode: true } });
      }
      if (tail === '/usage') {
        if (fault.practiceUsage === 'unread') return response({ error: 'fixture read failure' }, 502);
        const byModel = [...own].map(([model, m]) => ({ model, tokens: m.tokens, calls: m.calls }));
        return response({ totalTokens: byModel.reduce((n, m) => n + m.tokens, 0) + added, calls: byModel.reduce((n, m) => n + m.calls, 0) + practiceCalls, byModel,
          ...(runs ? { practice: { runs, calls: practiceCalls, tokens: practiced, byModel: [{ model: 'fixture-model', runs, calls: practiceCalls, tokens: practiced }] } } : {}) });
      }
      if (tail === '/stop?wait=1') agent.state = 'STOPPED';
      else if (tail === '/start?wait=1' || tail === '/rebuild?wait=1') {
        agent.state = 'RUNNING'; applied = [...selected];
        if (applied.includes(PACK) && !files.has(SKILL)) files.set(SKILL, catalogContent);
        if (fault.custom && !applied.includes(PACK)) files.set(SKILL, '# Replaced customized instructions\n');
      } else throw new Error(`Unexpected API: ${method} ${path}`);
      return response({ ...agent });
    },
    async inAgent(_agent: Agent, argv: string[], timeout: number, options: any) {
      commands.push({ argv, timeout, options });
      options.signal.throwIfAborted();
      if (fault.command) return { code: 1, out: 'fixture failure' };
      if (argv[0] === 'node') {
        const path = argv[3]!;
        if (argv[2]!.includes('readFileSync')) {
          if (!files.has(path)) return { code: 1, out: 'missing fixture file' };
          return { code: 0, out: files.get(path)! };
        }
        files.set(path, Buffer.from(argv[4]!, 'base64').toString());
        if (path === FIXTURE) files.delete(RECEIPT);
        return { code: 0, out: '' };
      }
      if (argv[1] === 'config') return { code: 0, out: '' };
      if (argv[1] !== 'agent') throw new Error('Unexpected runtime invocation');
      turns++;
      const receipt = 'a'.repeat(36), phrase = 'The paper kite is ready';
      if (!fault.noInvocation) files.set(RECEIPT, JSON.stringify({ receipt, phrase }) + '\n');
      return { code: 0, out: JSON.stringify({ status: 'ok', result: {
        payloads: [{ text: fault.metadataOnly ? 'A release note.' : `${phrase}; ${receipt}` }],
        meta: { agentMeta: { codeModeEngaged: !fault.noCodeMode }, toolResult: `${phrase}; ${receipt}` },
      } }) };
    },
    async scenario(name: string, fn: () => Promise<[string, boolean][]>) {
      try { const checks = await fn(); reports.push({ name, ok: checks.every(([, ok]) => ok) }); }
      catch (error) { reports.push({ name, ok: false, error: String(error) }); }
    },
    summary: () => reports.length > 0 && reports.every((report) => report.ok),
  };
  return { lib, calls, commands, agents, files, reports, get turns() { return turns; }, get profileRead() { return profileRead; } };
}

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('the live skills acceptance runner, entirely injected', () => {
  it('checks selection and update rollback, then runs one plain Code Mode task and one isolated API practice', async () => {
    const w = world();
    expect(await runSkillsScenarios(w.lib, { runId: RUN })).toEqual({ ok: true, timedOut: false });
    expect(w.turns).toBe(2);
    expect(w.calls.filter(({ path, options }) => path === '/v1/agents' && options.method === 'POST').map(({ options }) => options.body))
      .toEqual([{ name: `zz skills test ${RUN}`, aiProfileId: 'source', hostId: 'local', telegram: false }]);
    expect(w.calls.filter(({ options }) => options.method === 'PUT').map(({ options }) => options.body.selected)).toEqual([[PACK], [], [PACK]]);
    expect(w.calls.filter(({ path }) => path.endsWith('/rebuild?wait=1'))).toHaveLength(2);
    expect(w.calls.filter(({ path }) => path.endsWith('/start?wait=1'))).toHaveLength(1);
    expect(w.files.get(SKILL)).toContain(FIXTURE);
    const turn = w.commands.find(({ argv }) => argv[1] === 'agent')!;
    const prompt = turn.argv[turn.argv.indexOf('--message') + 1]!;
    expect(prompt).not.toContain(FIXTURE); expect(prompt).not.toContain('a'.repeat(36));
    expect(turn.argv).toContain('300'); expect(turn.timeout).toBeLessThanOrEqual(330_000);
    expect(w.commands.some(({ argv }) => argv.join(' ') === 'openclaw config set tools.codeMode true')).toBe(true);
    expect(w.commands.some(({ argv }) => argv[3] === 'tools.deny' && argv[4] === '["browser","web_search","web_fetch"]')).toBe(true);
    expect(w.commands.every(({ options }) => options.host.id === 'local' && options.signal instanceof AbortSignal && Number.isFinite(options.deadline))).toBe(true);
    const fileChanges = w.calls.filter(({ path, options }) => path.endsWith(`/${PACK}/file`) && options.method === 'POST');
    expect(fileChanges.map(({ options }) => options.body.action)).toEqual(['update', 'replace', 'rollback', 'rollback']);
    const practice = w.calls.filter(({ path }) => path.endsWith(`/${PACK}/try`));
    expect(practice).toHaveLength(1); expect(practice[0]!.options.timeoutMs).toBe(90_000);
    expect(w.agents.map((agent) => agent.id)).toEqual(['unrelated']);
    expect(w.calls.filter(({ options }) => options.method === 'DELETE').map(({ path }) => path)).toEqual(['/v1/agents/mine?wait=1']);
  });

  it.each(['inventory', 'applied', 'custom', 'command'] as const)('refuses the model turn after a failed %s check and still removes its agent', async (fault) => {
    const w = world({ [fault]: true });
    expect((await runSkillsScenarios(w.lib, { runId: RUN })).ok).toBe(false);
    expect(w.turns).toBe(0); expect(w.agents.map((agent) => agent.id)).toEqual(['unrelated']);
  });

  it.each(['noInvocation', 'noCodeMode', 'metadataOnly'] as const)('does not report actual use when %s', async (fault) => {
    const w = world({ [fault]: true });
    expect((await runSkillsScenarios(w.lib, { runId: RUN })).ok).toBe(false);
    expect(w.turns).toBe(1); expect(w.agents.map((agent) => agent.id)).toEqual(['unrelated']);
  });

  it.each(['filePreview', 'unsafeUpdate', 'replaceFailure', 'rollbackBytes', 'staleAllowed'] as const)('stops before any model task when file action evidence fails: %s', async (fault) => {
    const w = world({ [fault]: true });
    expect((await runSkillsScenarios(w.lib, { runId: RUN })).ok).toBe(false);
    expect(w.turns).toBe(0); expect(w.agents.map((agent) => agent.id)).toEqual(['unrelated']);
  });

  it.each(['unsupported', 'timeout', 'unavailable', 'not_observed'])('records unsuccessful practice as failure, including %s', async (status) => {
    const w = world({ practiceStatus: status });
    expect((await runSkillsScenarios(w.lib, { runId: RUN })).ok).toBe(false);
    expect(w.reports.some((report) => report.error?.includes(`Practice did not complete (${status})`))).toBe(true);
    expect(w.agents.map((agent) => agent.id)).toEqual(['unrelated']);
  });

  it.each(['practiceBusy', 'practiceMissingReads', 'practiceWrites'] as const)('fails an invalid practice and still cleans up: %s', async (fault) => {
    const w = world({ [fault]: true });
    expect((await runSkillsScenarios(w.lib, { runId: RUN })).ok).toBe(false);
    expect(w.agents.map((agent) => agent.id)).toEqual(['unrelated']);
  });

  // HB-0933: one practice's tokens are in the agent's usage exactly once, from its own record. Told from a call of the
  // agent's own meanwhile, however large, or on another model, which pushed the old check (under twice the practice's) over (HB-1249).
  it('passes a practice counted once, from its own record, with or without calls of its own meanwhile', async () => {
    for (const practiceUsage of [undefined, 'other', 'otherBig', 'otherModel'] as const) {
      const w = world({ practiceUsage });
      expect(await runSkillsScenarios(w.lib, { runId: RUN }), practiceUsage ?? 'record').toEqual({ ok: true, timedOut: false });
      expect(w.calls.filter(({ path }) => path === '/v1/agents/mine/usage')).toHaveLength(2);
    }
  });

  it.each([
    ['twice', /The practice's 2 calls on fixture-model are in the agent's own usage too: it rose by 2 calls \(1234 tokens\) there while it practised/],
    // Under twice the practice's tokens in all, which the old check passed (HB-1249).
    ['twiceUnder', /The practice's 2 calls on fixture-model are in the agent's own usage too: it rose by 2 calls \(900 tokens\) there while it practised/],
    ['rows', /The practice was recorded 2 times in the agent's usage, not once/],
    // A record of what the run reported has no calls to find in the agent's own usage: it passed (HB-1249 review).
    ['reported', /The practice's record in the agent's usage holds no calls: Practice took what the run reported, not its transcript in its own state folder/],
    ['lost', /The agent's practice \(1234 tokens\) is in its usage total not at all$/],
    ['none', /The practice was not recorded in the agent's usage/],
    ['unread', /Could not read the disposable agent's usage \(502\)/],
  ] as const)('fails a practice whose tokens are not in the agent\'s usage exactly once: %s', async (practiceUsage, error) => {
    const w = world({ practiceUsage });
    expect((await runSkillsScenarios(w.lib, { runId: RUN })).ok).toBe(false);
    const failed = w.reports.find((report) => report.name.startsWith('S3b'));
    expect(failed?.ok).toBe(false); expect(failed?.error).toMatch(error);
    expect(w.agents.map((agent) => agent.id)).toEqual(['unrelated']);
  });

  it('refuses an unexpected Telegram agent before any polling or runtime command, then removes it', async () => {
    const w = world({ telegram: true });
    expect((await runSkillsScenarios(w.lib, { runId: RUN })).ok).toBe(false);
    expect(w.commands).toEqual([]);
    expect(w.calls.some(({ path }) => path === '/v1/agents/mine')).toBe(false);
    expect(w.agents.map((agent) => agent.id)).toEqual(['unrelated']);
  });

  it.each(['collision', 'conflict'] as const)('does not delete an existing or concurrent exact-name agent after %s', async (fault) => {
    const w = world({ [fault]: true });
    expect((await runSkillsScenarios(w.lib, { runId: RUN })).ok).toBe(false);
    expect(w.calls.filter(({ options }) => options.method === 'DELETE')).toEqual([]);
    expect(w.agents).toHaveLength(2); expect(w.turns).toBe(0);
  });

  it.each(['lostCreate', 'failedCreate'] as const)('recovers uncertain %s by exact previously absent name, preserving nearby names', async (fault) => {
    const w = world({ [fault]: true });
    expect((await runSkillsScenarios(w.lib, { runId: RUN })).ok).toBe(false);
    expect(w.agents.map((agent) => agent.id)).toEqual(['unrelated']); expect(w.turns).toBe(0);
  });

  it('fails the overall report if cleanup fails', async () => {
    const w = world({ cleanup: true });
    expect((await runSkillsScenarios(w.lib, { runId: RUN })).ok).toBe(false);
    expect(w.reports.at(-1)?.ok).toBe(false); expect(w.agents).toHaveLength(2);
  });

  it('keeps only the explicitly requested diagnostic fixture', async () => {
    const w = world();
    expect((await runSkillsScenarios(w.lib, { runId: RUN, keep: true })).ok).toBe(true);
    expect(w.calls.filter(({ options }) => options.method === 'DELETE')).toEqual([]);
  });

  it('cannot create late when a preflight request finishes after the overall deadline', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const w = world({ profiles: new Promise<void>((resolve) => { release = resolve; }) });
    const work = runSkillsScenarios(w.lib, { runId: RUN, totalMs: 20 });
    await vi.advanceTimersByTimeAsync(0); expect(w.profileRead).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(await work).toEqual({ ok: false, timedOut: true });
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(w.calls.filter(({ options }) => options.method === 'POST' || options.method === 'DELETE')).toEqual([]);
    expect(w.turns).toBe(0);
  });

  it('generates the fixture receipt only when its CLI is invoked, with no install access', async () => {
    const w = world(); await runSkillsScenarios(w.lib, { runId: RUN });
    const home = mkdtempSync(join(tmpdir(), 'hb-skills-fixture-')); dirs.push(home);
    const bin = join(home, 'bin'); mkdirSync(bin);
    const receipt = join(home, 'receipt.jsonl'), script = join(home, 'fixture.cjs');
    writeFileSync(script, w.files.get(FIXTURE)!.replaceAll(RECEIPT, receipt));
    const run = () => spawnSync(process.execPath, [script], { cwd: home, env: { HOME: home, PATH: bin }, encoding: 'utf8', timeout: 5000 });
    const first = run(), second = run();
    expect(first.status, first.stderr).toBe(0); expect(second.status, second.stderr).toBe(0);
    const a = JSON.parse(first.stdout), b = JSON.parse(second.stdout);
    expect(a.receipt).toMatch(/^[a-f0-9]{36}$/); expect(b.receipt).not.toBe(a.receipt);
    expect(readFileSync(receipt, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([a, b]);
  });
});

describe('optional live-lib request and command budgets in a temporary HOME', () => {
  it('propagates cancellation, retains read retry, and never looks up or executes a Docker command after an aborted bounded call', () => {
    const home = mkdtempSync(join(tmpdir(), 'hb-live-budgets-')); dirs.push(home);
    const bin = join(home, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nprintf "fixture docker invoked\\n"\n', { mode: 0o755 });
    const url = pathToFileURL(resolve('scripts/live-lib.mjs')).href;
    const code = `
      import assert from 'node:assert/strict';
      let calls = 0;
      globalThis.fetch = async (_url, options) => { calls++; assert(options.signal instanceof AbortSignal); return new Response('{"ok":true}'); };
      const {api, inAgent} = await import(${JSON.stringify(url)});
      assert.deepEqual(await api('/fixture'), {status:200,json:{ok:true}});
      globalThis.fetch = async () => { if (++calls === 2) throw new Error('ECONNRESET'); return new Response('{}'); };
      await api('/fixture'); assert.equal(calls,3);
      globalThis.fetch = (_url, {signal}) => new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), {once:true});
      });
      const keepAlive = setInterval(() => {}, 1000);
      await assert.rejects(api('/fixture', {timeoutMs:5}), /timeout/i);
      const controller = new AbortController();
      const pending = api('/fixture', {signal:controller.signal});
      controller.abort(new Error('fixture cancellation'));
      await assert.rejects(pending, /fixture cancellation/);
      clearInterval(keepAlive);
      globalThis.fetch = async () => { throw new Error('No install requests are allowed'); };
      const agent = {hostId:'local',runtimeRef:'docker://fixture'};
      const host = {id:'local',kind:'local'};
      await assert.rejects(inAgent(agent,['echo','fixture'],1000,{host,signal:controller.signal,deadline:Date.now()+1000}), /fixture cancellation/);
      await assert.rejects(inAgent(agent,['echo','fixture'],1000,{host,deadline:Date.now()-1}), /deadline/);
      await assert.rejects(inAgent(agent,['echo','fixture'],1000,{host:{id:'other',kind:'local'}}), /moved/);
      const command = await inAgent(agent,['echo','fixture'],1000,{host,deadline:Date.now()+1000});
      assert.equal(command.code,0); assert.equal(command.out,'fixture docker invoked\\n');
      console.log('isolated helper checks passed');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: home,
      env: { HOME: home, PATH: bin, HATCHABOT_URL: 'http://example.invalid', HATCHABOT_TOKEN: 'fixture-only' },
      encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('isolated helper checks passed');
  });
});
