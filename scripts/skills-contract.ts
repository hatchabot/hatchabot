/**
 * Deterministic execution of the pinned OpenClaw Code Mode guest protocol.
 *
 * node_modules/.bin/tsx scripts/skills-contract.ts /path/to/openclaw-2026.9.8
 *
 * Supply an existing official source checkout/archive extraction; nothing is
 * downloaded. Only the eight hash-checked modules below execute, in a VM with
 * allowlisted imports. No OpenClaw CLI, model, gateway, credentials, or network
 * is used. Shell commands are exact allowlisted fixtures in a temporary HOME.
 *
 * This exercises the real guest controller and prompt-to-skill admission/read
 * functions with scripted calls. It does NOT test full workspace discovery,
 * gateway eligibility, a model choosing a skill from a plain request, or real
 * accounts/sites. Use live acceptance separately for those claims.
 * Primary source: https://github.com/openclaw/openclaw/tree/v2026.9.8/src/agents
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createContext, Script } from 'node:vm';
import { transformSync } from 'esbuild';
import { CURATED_SKILLS, SKILL_TOOL_GUIDANCE } from '../src/openclaw/skills.js';

export const PINNED_CONTRACT_FILES: Readonly<Record<string, string>> = {
  'src/agents/code-mode-controller-source.ts': 'f35cd95eb5ffd24759fab6744bebade8fd15f2c7d0019f701386aee1e867e4ce',
  'src/agents/code-mode-console-source.ts': '98aeb56b71ee73b49c2c67722920705fddc4a8e78dd1eace2ed891765452b3cb',
  'src/agents/code-mode-swarm-controller-source.ts': 'cf015b18c74cbc2419f171d598abad70f69ee0855888acd2c8b0dfe09d1bcc73',
  'src/agents/code-mode-worker-types.ts': '5dafb8f7cff392f607d7c269686ccd46892228481821fa4dc7b165a6f2c6f538',
  'src/agents/code-mode-skills.ts': 'cae49dc208b89875f20bccbdea7b767c46272bd468382dbb4c26b02518b4e99e',
  'src/skills/loading/skill-contract.ts': 'ca59af9a40039d345a612657ec65ed50504b95d50318746e54bf87ce58865929',
  'src/agents/sessions/source-info.ts': '95810371af9a96296f61855a3acf0583b132f2d27471b4e6d06b6596b2e597c2',
  'packages/normalization-core/src/utf16-slice.ts': '12fd3212b08522a1523263c92f654151ad01605ee48a0ff58a1256889fb7cb5f',
};

type Skill = { name: string; description: string; filePath: string; baseDir: string; source: string; sourceInfo: object; disableModelInvocation: boolean };
type AdmittedSkill = { name: string; description: string; location: string; source: { filePath: string } };
type PinnedContract = {
  controller: string;
  format(skills: Skill[]): string;
  admit(input: { skillsPrompt: string; candidates: Skill[] }): AdmittedSkill[];
  read(skill: AdmittedSkill): Promise<string>;
};

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

/** No source module executes before every pinned byte has been verified. */
export function loadPinnedContract(sourceDir: string, workspace: string): PinnedContract {
  const root = realpathSync(sourceDir);
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  assert.equal(version, '2026.9.8', 'This contract test requires OpenClaw 2026.9.8 source.');
  const sources = new Map<string, string>();
  for (const [file, expected] of Object.entries(PINNED_CONTRACT_FILES)) {
    const path = realpathSync(join(root, file));
    assert(within(root, path), `Source module escapes its checkout: ${file}`);
    const source = readFileSync(path, 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), expected, `Pinned source differs: ${file}`);
    sources.set(resolve(root, file), source);
  }
  const loaded = new Map<string, Record<string, unknown>>();
  const load = (file: string): Record<string, unknown> => {
    const cached = loaded.get(file);
    if (cached) return cached;
    const source = sources.get(file);
    assert(source !== undefined, 'Contract import is not allowlisted.');
    const exports: Record<string, unknown> = {};
    loaded.set(file, exports);
    const importModule = (specifier: string): unknown => {
      if (specifier === 'node:fs/promises') return {
        readFile: async (path: string) => {
          const real = realpathSync(path);
          assert(within(workspace, real), 'Skill read escapes the temporary workspace.');
          return readFileSync(real, 'utf8');
        },
      };
      if (specifier === '@openclaw/normalization-core/utf16-slice') {
        return load(resolve(root, 'packages/normalization-core/src/utf16-slice.ts'));
      }
      assert(specifier.startsWith('.'), 'Contract import is not allowlisted.');
      return load(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
    };
    const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
    const module = { exports };
    new Script(code, { filename: relative(root, file) }).runInContext(createContext({ exports, module, require: importModule }, { codeGeneration: { strings: false, wasm: false } }), { timeout: 2_000 });
    loaded.set(file, module.exports);
    return module.exports;
  };
  const controller = load(resolve(root, 'src/agents/code-mode-controller-source.ts'));
  const skills = load(resolve(root, 'src/agents/code-mode-skills.ts'));
  const prompt = load(resolve(root, 'src/skills/loading/skill-contract.ts'));
  return {
    controller: controller.CODE_MODE_CONTROLLER_SOURCE as string,
    format: prompt.formatSkillsForPromptCore as PinnedContract['format'],
    admit: skills.resolveCodeModeSkills as PinnedContract['admit'],
    read: skills.readCodeModeSkill as PinnedContract['read'],
  };
}

type Binding = { name: string; callableName: string; source: 'openclaw'; description: string };
type Dispatch = (method: string, args: unknown[]) => unknown | Promise<unknown>;

/** Runs fixed test programs only; this VM is not an untrusted-code sandbox. */
export async function runContractCell(controller: string, code: string, bindings: Binding[], dispatch: Dispatch): Promise<unknown> {
  const requests: Array<{ method: string; args: unknown[]; id: string }> = [];
  const context = createContext({
    __openclawCatalog: bindings,
    __openclawNamespaces: [],
    __openclawApiFiles: [],
    __openclawMaxPendingToolCalls: 16,
    __openclawHostRequest: (method: string, args: string, id: string) => { requests.push({ method, args: JSON.parse(args), id }); },
    __openclawHostCancelRequest: () => { throw new Error('Unexpected cancellation.'); },
    __openclawHostObserveNetworkContent: () => {},
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(controller).runInContext(context, { timeout: 2_000 });
  let finished = false;
  let value: unknown;
  let failure: unknown;
  const running = new Script(`__openclawRunCell(async () => { ${code}\n})`).runInContext(context, { timeout: 2_000 }) as Promise<string>;
  void running.then((result) => { value = JSON.parse(result); finished = true; })
    .catch((error) => { failure = error; finished = true; });
  // Every fixture bridge is immediate. The bound also catches a forgotten await
  // or unresolved cell without leaving a timer/worker behind.
  for (let step = 0; step < 100 && !finished; step++) {
    await new Promise<void>((done) => setImmediate(done));
    const batch = requests.splice(0);
    for (const request of batch) {
      let ok = true;
      let result: unknown;
      try { result = await dispatch(request.method, request.args); }
      catch (error) { ok = false; result = { message: error instanceof Error ? error.message : String(error) }; }
      context.reply = JSON.stringify({ id: request.id, ok, json: JSON.stringify(result ?? null) });
      new Script('(() => { const r = JSON.parse(reply); __openclawSettleBridge(r.id, r.ok, r.json); delete globalThis.reply; })()', { filename: 'fixture-reply' })
        .runInContext(context, { timeout: 2_000 });
    }
    new Script('__openclawDrainQueuedRequests()').runInContext(context, { timeout: 2_000 });
  }
  assert(finished, 'The scripted Code Mode cell did not settle.');
  if (failure) throw failure;
  return value;
}

export const FIXTURE_COMMANDS = {
  'gog auth list --json': { binary: 'gog', output: '{"accounts":[{"email":"pat@example.org","services":["gmail"]}]}' },
  'gog gmail search newer_than:7d --json': { binary: 'gog', output: '{"threads":[{"subject":"Seed library opening"}]}' },
  'call-agent "Garden Notes" "What is ready?"': { binary: 'call-agent', output: 'The blue planter is ready.' },
  'garden-plan status --json': { binary: 'garden-plan', output: '{"watered":3}' },
} as const;

/** Every process has a temporary HOME and shim-only PATH; arbitrary commands fail. */
export function fixtureShell(home: string, command: string): string {
  assert(Object.hasOwn(FIXTURE_COMMANDS, command), 'Shell command is not a fixture.');
  const result = spawnSync('/bin/sh', ['-c', command], {
    cwd: home, timeout: 2_000, encoding: 'utf8', maxBuffer: 16_384,
    env: { HOME: home, PATH: join(home, 'bin'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function seedFixtureShell(home: string): void {
  mkdirSync(join(home, 'bin'), { recursive: true });
  // Constants only. These shims use shell builtins, never real host programs.
  writeFileSync(join(home, 'bin', 'gog'), '#!/bin/sh\ncase "$1 $2" in\n "auth list") printf \'%s\\n\' \'{"accounts":[{"email":"pat@example.org","services":["gmail"]}]}\';;\n "gmail search") printf \'%s\\n\' \'{"threads":[{"subject":"Seed library opening"}]}\';;\n *) exit 1;;\nesac\n', { mode: 0o700 });
  writeFileSync(join(home, 'bin', 'call-agent'), '#!/bin/sh\nprintf \'%s\\n\' \'The blue planter is ready.\'\n', { mode: 0o700 });
  writeFileSync(join(home, 'bin', 'garden-plan'), '#!/bin/sh\nprintf \'%s\\n\' \'{"watered":3}\'\n', { mode: 0o700 });
}

export async function checkPinnedSkillContract(sourceDir: string): Promise<string[]> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hb-skills-contract-')));
  try {
    const contract = loadPinnedContract(sourceDir, home);
    seedFixtureShell(home);
    const candidates: Skill[] = CURATED_SKILLS.map((skill) => {
      const baseDir = join(home, 'skills', skill.id);
      mkdirSync(baseDir, { recursive: true });
      const filePath = join(baseDir, 'SKILL.md');
      writeFileSync(filePath, skill.content, { mode: 0o600 });
      return { name: skill.id, description: skill.description, filePath, baseDir, source: 'openclaw-workspace', sourceInfo: {}, disableModelInvocation: false };
    });
    const admitted = contract.admit({ skillsPrompt: contract.format(candidates), candidates });
    assert.deepEqual(Array.from(admitted, (skill) => skill.name), CURATED_SKILLS.map((skill) => skill.id));
    const calls: Array<{ tool: string; input: unknown }> = [];
    const bindings = ['exec', 'process', 'browser', 'web_search', 'web_fetch', 'image_generate'].map((name): Binding => ({ name, callableName: name, source: 'openclaw', description: `Fixture ${name}` }));
    let pending: string | undefined;
    const dispatch: Dispatch = async (method, args) => {
      if (method === 'skillsList') return admitted.map(({ name, description, location }) => ({ name, description, location }));
      if (method === 'skillsRead') {
        const skill = admitted.find((entry) => entry.name === args[0]);
        assert(skill, 'Unknown skill.');
        return contract.read(skill);
      }
      if (method === 'search') return bindings.filter((binding) => binding.name === args[0]).map((binding) => binding.callableName);
      if (method === 'describe') { assert(bindings.some((binding) => binding.name === args[0])); return { name: args[0], input: { type: 'object' } }; }
      assert.equal(method, 'callValue');
      const [tool, raw] = args;
      const input = raw as Record<string, unknown>;
      calls.push({ tool: String(tool), input });
      if (tool === 'exec') {
        const output = fixtureShell(home, String(input.command));
        if (String(input.command).startsWith('call-agent ')) { pending = output; return { status: 'running', sessionId: 'fixture-peer' }; }
        return { status: 'completed', exitCode: 0, aggregated: output };
      }
      if (tool === 'process') {
        assert.equal(input.action, 'poll'); assert.equal(input.sessionId, 'fixture-peer'); assert(pending);
        const aggregated = pending; pending = undefined;
        return { status: 'completed', exitCode: 0, aggregated };
      }
      if (tool === 'browser') {
        assert.equal(input.action, 'snapshot'); assert.equal(input.profile, 'hatchabot');
        return input.targetId === 'fixture-jira'
          ? { snapshot: 'GARDEN-1: Repair the planter. Status: To Do. Acceptance: the planter holds water.', targetId: 'fixture-jira' }
          : { snapshot: 'Seed library: opens Saturday at 10.', targetId: 'fixture-tab' };
      }
      if (tool === 'web_search') return { results: [{ title: 'Seed library hours', url: 'https://library.example.test/hours' }] };
      if (tool === 'web_fetch') { assert.equal(input.url, 'https://library.example.test/hours'); return { text: 'Saturday: 10–12', url: input.url }; }
      if (tool === 'image_generate') {
        if (input.action === 'list') return { providers: [{ id: 'fixture', ready: true }] };
        assert.equal(input.action, 'generate'); assert.equal(input.count, 1);
        assert.equal(input.outputFormat, 'png'); assert.equal(input.background, 'transparent');
        return { status: 'completed', images: [{ path: 'fixture-generated.png' }] };
      }
      throw new Error('Tool unavailable.');
    };
    const cell = (code: string) => runContractCell(contract.controller, code, bindings, dispatch);
    const reads = await cell('const entries = await skills.list(); return await Promise.all(entries.map(async s => ({name:s.name, content:await skills.read(s.name)})));');
    assert.deepEqual(reads, CURATED_SKILLS.map(({ id, content }) => ({ name: id, content })));
    const browser = await cell('const [tool] = await catalog.search("browser"); await tool.describe(); return await tool({action:"snapshot",profile:"hatchabot"});') as { snapshot: string };
    assert.match(browser.snapshot, /Saturday at 10/);
    const research = await cell('await skills.read("hatchabot-research"); const hits = await web_search({query:"seed library hours"}); return await web_fetch({url:hits.results[0].url});') as { text: string };
    assert.equal(research.text, 'Saturday: 10–12');
    // Execute the actual managed-guide example, not a separate approximation.
    const example = /`(const r = await exec\(\{ command: "gog auth list --json" \}\); return r;)`/.exec(SKILL_TOOL_GUIDANCE)?.[1];
    assert(example);
    const accounts = await cell(example) as { aggregated: string };
    assert.equal(JSON.parse(accounts.aggregated).accounts[0].email, 'pat@example.org');
    const mail = await cell('return await exec({command:"gog gmail search newer_than:7d --json"});') as { aggregated: string };
    assert.equal(JSON.parse(mail.aggregated).threads[0].subject, 'Seed library opening');
    const peer = await cell('const r = await exec({command:\'call-agent "Garden Notes" "What is ready?"\'}); return r.status === "running" ? await process({action:"poll",sessionId:r.sessionId}) : r;') as { aggregated: string };
    assert.equal(peer.aggregated, 'The blue planter is ready.');
    const app = await cell('return await exec({command:"garden-plan status --json"});') as { aggregated: string };
    assert.equal(JSON.parse(app.aggregated).watered, 3);
    const jira = await cell('await skills.read("hatchabot-jira"); const [tool] = await catalog.search("browser"); await tool.describe(); return await tool({action:"snapshot",profile:"hatchabot",targetId:"fixture-jira"});') as { snapshot: string };
    assert.match(jira.snapshot, /GARDEN-1: Repair the planter/);
    const generated = await cell('await skills.read("hatchabot-images"); const [tool] = await catalog.search("image_generate"); await tool.describe(); await tool({action:"list"}); return await tool({action:"generate",prompt:"A community garden",count:1,outputFormat:"png",background:"transparent"});') as { images: Array<{ path: string }> };
    assert.equal(generated.images[0]?.path, 'fixture-generated.png');
    assert.equal(calls.filter((call) => call.tool === 'image_generate' && (call.input as { action: string }).action === 'generate').length, 1);
    assert.equal(calls.filter((call) => call.tool === 'exec' && String((call.input as { command: string }).command).startsWith('call-agent ')).length, 1);
    assert.deepEqual(await cell('return (await catalog.search("gog")).length;'), 0);
    await assert.rejects(cell('return await skills.read("missing-skill");'), /Unknown skill/);
    await assert.rejects(runContractCell(contract.controller, 'return await browser({action:"snapshot"});', [], dispatch), /browser is not defined/);
    await assert.rejects(runContractCell(contract.controller, 'return await image_generate({action:"list"});', [], dispatch), /image_generate is not defined/);
    assert.equal(contract.admit({ skillsPrompt: contract.format([]), candidates }).length, 0);
    assert.equal(calls.filter((call) => call.tool === 'browser' && (call.input as { action: string }).action !== 'snapshot').length, 0);
    return ['all seven skills admitted and read from temporary files', 'browser lookup, schema read, and snapshot', 'research search and page result', 'Google guide example and mailbox fixture', 'peer CLI with process polling, executed once', 'installed-app CLI fixture', 'Jira browser-read fixture with no changes', 'image provider-list and one generation fixture; no provider called', 'missing skill/tool and CLI-catalog boundaries'];
  } finally { rmSync(home, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = process.argv[2];
  if (!source || process.argv.length !== 3) {
    console.error('Usage: node_modules/.bin/tsx scripts/skills-contract.ts /path/to/openclaw-2026.9.8');
    process.exitCode = 2;
  } else {
    checkPinnedSkillContract(source).then((checks) => {
      console.log('PASS: pinned Code Mode protocol with scripted fixtures; no model or live service was tested.');
      for (const check of checks) console.log(`  ${check}`);
    }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
  }
}
