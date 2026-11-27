#!/usr/bin/env node
/** Later live-session acceptance only. One disposable web-only agent, two AI
 * turns, no Google/browser/web service requirements. Unit tests inject every live
 * boundary; merely importing this module does not read the install's env. */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACK = 'hatchabot-writing';
const TOTAL_MS = 35 * 60_000;
const FIXTURE = '/home/node/.local/bin/hatchabot-skill-fixture';
const RECEIPT = '/home/node/.openclaw/skill-acceptance-receipt.json';
const PROMPT = 'Write a one-sentence release note using the current local release phrase, and include its verification receipt.';
const fixtureSource = `#!/usr/bin/env node
const fs = require('node:fs'), crypto = require('node:crypto');
const result = { phrase: 'The paper kite is ready', receipt: crypto.randomBytes(18).toString('hex') };
fs.appendFileSync(${JSON.stringify(RECEIPT)}, JSON.stringify(result) + '\\n', { mode: 0o600 });
process.stdout.write(JSON.stringify(result));
`;
const skillAddition = `
## This disposable workspace's release-note fixture

For a release note using the current local release phrase, first run
\`${FIXTURE}\` as a shell command. It prints the current phrase and a verification
receipt. Use that phrase in the requested note and include the receipt exactly.
The fixture is local; do not use web, browser or Google services for this task.
`;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const row = (status) => status.skills?.find((skill) => skill.id === PACK);

export async function runSkillsScenarios(lib, { keep = false, runId = randomBytes(10).toString('hex'), totalMs = TOTAL_MS } = {}) {
  assert(/^[a-z0-9-]{8,40}$/.test(runId), 'Invalid isolated run id');
  const name = `zz skills test ${runId}`;
  const deadline = Date.now() + totalMs;
  const controller = new AbortController();
  let timer, timedOut = false, agent, host, createdId, uncertainCreation = false;
  const current = () => assert(!controller.signal.aborted && Date.now() < deadline, 'The skills acceptance deadline expired');
  const request = (path, options = {}) => { current(); return lib.api(path, { timeoutMs: 45_000, signal: controller.signal, ...options }); };
  const webOnly = (candidate) => assert(candidate.name === name && candidate.webOnly === true && !candidate.deepLink && !candidate.botUsername,
    'The throwaway agent must be web-only and belong to this test run');
  const settle = async (want = 'RUNNING') => {
    for (;;) {
      current();
      const response = await request(`/v1/agents/${agent.id}`);
      assert(response.status === 200, 'Could not read the disposable agent');
      webOnly(response.json);
      agent = response.json;
      if (agent.state === want && !agent.busy) return;
      assert(agent.state !== 'FAILED', 'The disposable agent failed to start');
      await lib.sleep(Math.min(5000, Math.max(1, deadline - Date.now())));
    }
  };
  const command = async (argv, cap = 60_000) => {
    const remaining = deadline - Date.now();
    assert(remaining > 0, 'The skills acceptance deadline expired');
    current();
    const result = await lib.inAgent(agent, argv, Math.min(cap, remaining), { host, signal: controller.signal, deadline });
    assert(result.code === 0, `Agent command failed (${result.code})`);
    return result.out;
  };
  const change = async (path, body) => {
    const response = await request(`/v1/agents/${agent.id}${path}`, { method: 'POST', body, timeoutMs: Math.max(1, deadline - Date.now()) });
    assert(response.status < 300, `Agent operation failed (${response.status})`);
    return response.json;
  };
  const select = async (selected) => {
    const response = await request(`/v1/agents/${agent.id}/skills`, { method: 'PUT', body: { selected } });
    assert(response.status === 200 && JSON.stringify(response.json.selected) === JSON.stringify(selected), 'Selection was not saved');
  };
  const inspect = async (expected) => {
    const selected = expected === 'disabled' ? [] : [PACK];
    const choice = await request(`/v1/agents/${agent.id}/skills`);
    assert(choice.status === 200 && choice.json.pending === false, 'Selection still waits for a build');
    assert(JSON.stringify(choice.json.selected) === JSON.stringify(selected) && JSON.stringify(choice.json.applied) === JSON.stringify(selected), 'Saved and applied selections do not match');
    const response = await request(`/v1/agents/${agent.id}/skills/status`);
    assert(response.status === 200 && response.json.status === 'checked', 'Runtime inventory could not be checked');
    assert(row(response.json)?.status === expected, `Writing instructions were not ${expected}`);
  };
  const phase = async (label, work) => {
    let passed = false;
    await lib.scenario(label, async () => {
      await work(); passed = true;
      return [[label, true]];
    });
    assert(passed, `${label} failed; later steps were not run`);
  };
  const readFile = (path) => command(['node', '-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))', path]);
  const usage = async () => {
    const response = await request(`/v1/agents/${agent.id}/usage`);
    assert(response.status === 200 && Number.isFinite(response.json?.totalTokens), `Could not read the disposable agent's usage (${response.status})`);
    return response.json;
  };
  const preview = async () => {
    const response = await request(`/v1/agents/${agent.id}/skills/${PACK}/file`);
    assert(response.status === 200 && /^[a-f0-9]{64}$/.test(response.json.revision) && typeof response.json.catalog?.content === 'string', 'Could not preview the disposable skill file');
    return response.json;
  };
  const main = async () => {
    await lib.requireRoom(1, { timeoutMs: 45_000, signal: controller.signal });
    current();
    const existing = await request('/v1/agents');
    assert(existing.status === 200 && Array.isArray(existing.json), 'Could not check the disposable name');
    assert(!existing.json.some((candidate) => candidate.name === name), 'The disposable name already exists; refusing to reuse it');
    // The same web-only creation as live-lib.createAgent, with this runner's
    // abort signal on every request so late preflight reads cannot create an
    // agent after the outer deadline and cleanup have already finished.
    const profiles = await request('/v1/ai-profiles');
    assert(profiles.status === 200 && Array.isArray(profiles.json), 'Could not read AI sources');
    const profile = profiles.json.find((candidate) => candidate.defaultSource) ?? profiles.json[0];
    assert(profile?.id, 'A configured AI source is required');
    const hosts = await request('/v1/hosts');
    assert(hosts.status === 200 && Array.isArray(hosts.json), 'Could not read machines');
    host = hosts.json.find((candidate) => candidate.kind === 'local');
    assert(host?.id, 'This acceptance test needs the local machine');
    current();
    uncertainCreation = true;
    const created = await request('/v1/agents', { method: 'POST', body: { name, aiProfileId: profile.id, hostId: host.id, telegram: false } });
    if (created.status >= 300 && created.status < 500) uncertainCreation = false;
    assert(created.status < 300 && created.json?.id, 'Could not create the disposable agent');
    agent = created.json;
    createdId = agent.id;
    uncertainCreation = false;
    // Creation returns the pre-update record on some releases. The fresh
    // read below must confirm webOnly; any returned bot is refused at once.
    assert(!agent.deepLink && !agent.botUsername && agent.webOnly !== false, 'The disposable agent was given Telegram access');
    await settle();
    const skillPath = `${lib.workspaceOf(agent)}/skills/${PACK}/SKILL.md`;
    await phase('S1 saved selection is applied and discovered after rebuild', async () => {
      await select([PACK]);
      await change('/rebuild?wait=1', {});
      await settle();
      await inspect('available');
    });
    let customized;
    await phase('S2 custom instructions survive disable and next-start re-enable', async () => {
      customized = (await readFile(skillPath)) + skillAddition;
      // argv + base64: no shell interpolation of names or skill text.
      await command(['node', '-e', 'const fs=require("node:fs"); fs.writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64"))', skillPath, Buffer.from(customized).toString('base64')]);
      await select([]);
      await change('/rebuild?wait=1', {});
      await settle();
      await inspect('disabled');
      assert(await readFile(skillPath) === customized, 'Disabling replaced the customized skill');
      await change('/stop?wait=1', {});
      await settle('STOPPED');
      await select([PACK]);
      const stopped = await request(`/v1/agents/${agent.id}`);
      assert(stopped.json.state === 'STOPPED', 'Saving selection unexpectedly started the agent');
      await change('/start?wait=1', {});
      await settle();
      await inspect('available');
      assert(await readFile(skillPath) === customized, 'Re-enabling replaced the customized skill');
    });
    await phase('S2b preview, guarded replacement and rollback preserve customized bytes', async () => {
      const before = await preview();
      assert(['customized', 'untracked'].includes(before.state) && before.installed?.content === customized, 'Preview did not report the actual customized instructions');
      const path = `/v1/agents/${agent.id}/skills/${PACK}/file`;
      const refused = await request(path, { method: 'POST', body: { action: 'update', expectedRevision: before.revision } });
      assert(refused.status === 409 && await readFile(skillPath) === customized, 'An ordinary update did not preserve custom instructions');
      const replaced = await request(path, { method: 'POST', body: { action: 'replace', expectedRevision: before.revision } });
      assert(replaced.status === 200 && replaced.json.revision !== before.revision && replaced.json.installed?.content === before.catalog.content && replaced.json.canRollback === true,
        'Explicit replacement did not install the catalog with rollback evidence');
      assert(await readFile(skillPath) === before.catalog.content, 'Replacement did not reach the actual skill file');
      const stale = await request(path, { method: 'POST', body: { action: 'rollback', expectedRevision: before.revision } });
      assert(stale.status === 409 && await readFile(skillPath) === before.catalog.content, 'A stale preview changed the file');
      const restored = await request(path, { method: 'POST', body: { action: 'rollback', expectedRevision: replaced.json.revision } });
      assert(restored.status === 200 && restored.json.revision !== replaced.json.revision && restored.json.installed?.content === customized,
        'Rollback did not report the previous customized bytes');
      assert(await readFile(skillPath) === customized, 'Rollback did not restore the actual custom instructions');
    });
    await phase('S3 one plain request uses the skill fixture under Code Mode', async () => {
      await command(['node', '-e', 'const fs=require("node:fs"),p=require("node:path"); fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true}); fs.writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64"),{mode:0o755}); fs.rmSync(process.argv[3],{force:true})', FIXTURE, Buffer.from(fixtureSource).toString('base64'), RECEIPT]);
      await command(['openclaw', 'config', 'set', 'tools.codeMode', 'true'], 120_000);
      await command(['openclaw', 'config', 'set', 'tools.deny', '["browser","web_search","web_fetch"]'], 120_000);
      const output = await command(['openclaw', 'agent', '--agent', agent.slug, '--session-id', `skills-${runId}`,
        '--message', PROMPT, '--json', '--timeout', '300'], 330_000);
      const turn = JSON.parse(output), result = turn.result ?? turn;
      assert(!turn.status || turn.status === 'ok', 'The model turn did not finish successfully');
      assert(/"codeModeEngaged"\s*:\s*true/.test(JSON.stringify(result.meta)), 'The model turn did not report Code Mode engagement');
      const reply = (result.payloads ?? []).map((payload) => typeof payload.text === 'string' ? payload.text : '').join('\n');
      const evidence = (await readFile(RECEIPT)).trim().split('\n').map((line) => JSON.parse(line));
      assert(evidence.some((item) => typeof item.receipt === 'string' && /^[a-f0-9]{36}$/.test(item.receipt) &&
        typeof item.phrase === 'string' && reply.includes(item.receipt) && reply.includes(item.phrase)), 'The final answer did not use a real fixture invocation result');
    });
    await phase('S3b API practice observes both skill and sample reads', async () => {
      const before = await preview();
      // The agent's usage before: its practice must show up in it exactly once (HB-0933).
      const usageBefore = await usage();
      const response = await request(`/v1/agents/${agent.id}/skills/${PACK}/try`, { method: 'POST',
        body: { expectedRevision: before.revision }, timeoutMs: Math.max(1, Math.min(90_000, deadline - Date.now())) });
      assert(response.status === 200, `Practice request failed (${response.status})`);
      const result = response.json;
      assert(result.status === 'completed', `Practice did not complete (${['unsupported','timeout','unavailable','not_observed'].includes(result.status) ? result.status : 'invalid result'})`);
      assert(result.evidence?.skillRead === true && result.evidence?.fixtureRead === true && Number.isInteger(result.evidence?.toolCalls) && result.evidence.toolCalls > 0,
        'Practice did not verify reads of both the skill and sample');
      assert(typeof result.output === 'string' && result.output.trim(), 'Practice returned no answer');
      assert(await readFile(skillPath) === customized, 'Practice modified the actual skill instructions');
      // Counted once: the practice's own record (what Practice wrote, one run,
      // with its calls, from its transcript in its own state folder) is in the
      // agent's total once, not lost with its folder, and its calls are not in
      // the agent's own usage (its transcripts, by model) too. Each part is read
      // apart in the answer: the total is the agent's own models' tokens plus
      // its practice's, so a call of the agent's own meanwhile (a heartbeat,
      // say) on another model, or fewer calls on its model than the practice
      // made there, is told from a copy of the run; as many there reads as a
      // copy, and the words ask for another run. Held to the rise of the whole
      // total, under twice the practice's tokens, a large call of its own failed
      // it and a copy counting fewer tokens than the record passed (HB-1249).
      const usageAfter = await usage();
      const p0 = usageBefore.practice ?? {}, p1 = usageAfter.practice ?? {};
      const practiced = (p1.tokens ?? 0) - (p0.tokens ?? 0), runs = (p1.runs ?? 0) - (p0.runs ?? 0);
      assert(practiced > 0, "The practice was not recorded in the agent's usage");
      assert(runs === 1, `The practice was recorded ${runs} times in the agent's usage, not once`);
      // A record of only what the run reported has no calls (skillTrials.ts reportedSpent),
      // and nothing to look for in the agent's own usage: a copy there went unseen (HB-1249 review).
      assert((p1.calls ?? 0) - (p0.calls ?? 0) > 0, "The practice's record in the agent's usage holds no calls: Practice took what the run reported, not its transcript in its own state folder, so whether the run is in the agent's own usage too cannot be told");
      const ownOn = (u, model) => (u.byModel ?? []).filter((m) => model === undefined || m.model === model)
        .reduce((n, m) => ({ tokens: n.tokens + (m.tokens ?? 0), calls: n.calls + (m.calls ?? 0) }), { tokens: 0, calls: 0 });
      const folded = usageAfter.totalTokens - ownOn(usageAfter).tokens;
      assert(folded === p1.tokens, `The agent's practice (${p1.tokens} tokens) is in its usage total ${folded <= 0 ? 'not at all' : folded === 2 * p1.tokens ? 'twice' : `as ${folded} tokens`}`);
      for (const m of p1.byModel ?? []) {
        const calls = (m.calls ?? 0) - ((p0.byModel ?? []).find((b) => b.model === m.model)?.calls ?? 0);
        if (!(calls > 0)) continue;
        const was = ownOn(usageBefore, m.model), is = ownOn(usageAfter, m.model);
        const rose = { calls: is.calls - was.calls, tokens: is.tokens - was.tokens };
        assert(rose.calls < calls, `The practice's ${calls} call${calls === 1 ? '' : 's'} on ${m.model} are in the agent's own usage too: it rose by ${rose.calls} calls (${rose.tokens} tokens) there while it practised, which counts them twice, unless another turn of the agent's ran on ${m.model} meanwhile (run the test again)`);
      }
    });
  };
  try {
    await Promise.race([
      main(),
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('Skills acceptance exceeded its total deadline')); }, totalMs); }),
    ]);
  } catch (error) {
    await lib.scenario('Skills acceptance completed', async () => { throw error; });
  } finally {
    clearTimeout(timer);
    if (keep) lib.log(`kept ${name} (--keep)`);
    else if (createdId || uncertainCreation) await lib.scenario('S4 only this run’s disposable agent is removed', async () => {
      // Separate cleanup budget after an aborted main request. Exact unique
      // name recovers an uncertain creation only after its absence was checked.
      const all = await lib.api('/v1/agents', { timeoutMs: 30_000 });
      assert(all.status === 200 && Array.isArray(all.json), 'Could not find the disposable agent for cleanup');
      const mine = all.json.filter((candidate) => candidate.name === name && (!createdId || candidate.id === createdId) && (!candidate.role || candidate.role === 'owner') && candidate.state !== 'DELETED');
      assert(mine.length <= 1, 'Ambiguous disposable agent identity; cleanup refused');
      for (const candidate of mine) {
        const removed = await lib.api(`/v1/agents/${encodeURIComponent(candidate.id)}?wait=1`, { method: 'DELETE', timeoutMs: 30_000 });
        assert(removed.status < 300 || removed.status === 404, 'Disposable agent cleanup failed');
      }
      return [['only the uniquely named test agent was removed', true]];
    });
  }
  return { ok: lib.summary(), timedOut };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const lib = await import('./live-lib.mjs');
  const result = await runSkillsScenarios(lib, { keep: process.argv.includes('--keep') });
  process.exitCode = result.ok ? 0 : 1;
  // Abort any helper read still pending after the outer budget. Give the
  // small summary a turn to flush; cleanup already had its separate budget.
  if (result.timedOut) setTimeout(() => process.exit(1), 100);
}
