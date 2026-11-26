import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { createAgentDefinition, type AgentDefinition } from '../src/orchestrator/definition/agentDefinition.js';
import { createCoreFileTurns } from '../src/orchestrator/files/coreFileTurns.js';
import { workspacePath } from '../src/orchestrator/files/coreFiles.js';
import { clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import type { Agent, TemplateParam } from '../src/domain/types.js';
import type { ExecResult } from '../src/providers/provider.js';

/**
 * The definition service (HB-0808 step 15, part C), driven as
 * src/api/agents/definitionRoutes.ts drives it, with no HTTP server: a real store
 * on an in-memory database, the real core-files turns, and containers whose
 * core files are a Map the test reads and writes.
 */
const OWNER = 'user-owner';
const TOWN: TemplateParam = { key: 'town', label: 'Town', required: false, type: 'text', default: 'Springfield', target: 'soul' };
const KEY: TemplateParam = { key: 'api_key', label: 'Key', required: false, type: 'text', target: 'env' };

interface World {
  store: Store; d: AgentDefinition;
  /** Each agent's files, by their path in the container. */
  files: Map<string, string>;
  /** Paths whose write fails. */
  failWrites: Set<string>;
  /** Paths whose next write lands, but answers as a timed-out failure. */
  landsButFails: Set<string>;
  /** Paths whose reads and writes are not run: the machine does not answer. */
  outOfReach: Set<string>;
  /** The core-files turns taken, and the AGENTS.md syncs asked for, in order. */
  asked: string[];
  agent(id: string, o?: { state?: 'STOPPED'; parent?: string; params?: TemplateParam[]; values?: Record<string, string>; soul?: string; agents?: string }): Agent;
}

function world(): World {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const w = { store, files: new Map(), failWrites: new Set(), landsButFails: new Set(), outOfReach: new Set(), asked: [] } as unknown as World;
  const provider = {
    exec: async (): Promise<ExecResult> => ({ code: 0, stdout: '', stderr: '' }),
    execShell: async (_ref: string, script: string): Promise<ExecResult> => {
      if (script.startsWith('head -c ')) {
        const path = JSON.parse(/^head -c \d+ ("[^"]*")/.exec(script)![1]!) as string;
        if (w.outOfReach.has(path)) return { code: 255, stdout: '', stderr: '', unreachable: true };
        const text = w.files.get(path);
        return text === undefined ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: text, stderr: text === '' ? 'EMPTY' : '' };
      }
      if (script.includes('mv -fT -- ')) {
        const b64 = JSON.parse(/echo ("[^"]*") \| base64 -d/.exec(script)![1]!) as string;
        const path = JSON.parse(/mv -fT -- \S+ ("[^"]*")$/.exec(script)![1]!) as string;
        if (w.outOfReach.has(path)) return { code: 255, stdout: '', stderr: '', unreachable: true };
        if (w.failWrites.has(path)) return { code: 1, stdout: '', stderr: 'disk full' };
        w.files.set(path, Buffer.from(b64, 'base64').toString('utf8'));
        if (w.landsButFails.delete(path)) return { code: 1, stdout: '', stderr: '', timedOut: true };
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const turns = createCoreFileTurns({ store, agentGone: (id) => !store.getAgent(id) });
  w.d = createAgentDefinition({
    store, providerFor: () => provider as never, trace: () => () => {},
    withCoreFilesTurn: (id, fn, waitMs) => { w.asked.push(`turn ${id}`); return turns.withCoreFilesTurn(id, fn, waitMs); },
    freshRunning: turns.freshRunning,
    syncDocsHeld: async (a) => { w.asked.push(`sync ${a.id}`); },
  });
  w.agent = (id, o = {}) => {
    store.insertAgent({
      id, ownerId: OWNER, name: `Agent ${id}`, slug: id, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    } as unknown as Agent);
    store.setAgentRuntimeRef(id, `ref-${id}`);
    store.setAgentState(id, 'RUNNING');
    if (o.state === 'STOPPED') store.setAgentState(id, 'STOPPED');
    if (o.parent) store.setAgentParent(id, o.parent);
    if (o.params) store.setAgentParameters(id, o.params);
    if (o.values) store.setAgentParamState(id, o.values);
    if (o.soul !== undefined) w.files.set(workspacePath(id, 'SOUL.md'), o.soul);
    if (o.agents !== undefined) w.files.set(workspacePath(id, 'AGENTS.md'), o.agents);
    return store.getAgent(id)!;
  };
  return w;
}

/** As the route does it: the checks, the busy check, the change. */
async function apply(w: World, a: Agent, body: { values?: unknown; reset?: unknown }) {
  const ready = w.d.values.prepare(a, body);
  if (!ready.ok) return ready;
  return ready.body();
}

describe('setup values', () => {
  it('refuses, in its words and its order, an agent with no fields, only env fields, not running, and a body that asks nothing', () => {
    const w = world();
    expect(w.d.values.prepare(w.agent('none'), { values: {} })).toEqual({ ok: false, status: 400, error: 'This agent declares no setup fields — add them under 📖 Definition → Setup fields first.' });
    expect(w.d.values.prepare(w.agent('env', { params: [KEY] }), { values: {} })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/^All of this agent's setup fields are env credentials/) });
    expect(w.d.values.prepare(w.agent('off', { params: [TOWN], state: 'STOPPED' }), {})).toEqual({ ok: false, status: 409, error: 'Start the agent to change its setup values.' });
    const a = w.agent('a', { params: [TOWN] });
    expect(w.d.values.prepare(a, {})).toEqual({ ok: false, status: 400, error: 'Send { values } to apply, or { reset: true } to restore defaults.' });
    expect(w.d.values.prepare(a, { values: { town: 5 } })).toEqual({ ok: false, status: 400, error: 'Malformed setup values.' });
    expect(w.d.values.prepare(a, { values: { town: 'Shelbyville' } }).ok).toBe(true);
    expect(w.asked).toEqual([]); // nothing is written before the route's busy check
  });

  it('seeds a master\'s layer from its own files on its first edit, renders them in its files turn, snapshot first', async () => {
    const w = world();
    const m = w.agent('m', { params: [TOWN], soul: '# The soul of {{town}}\n', agents: 'Rules for {{ town }}.\n' });
    expect(await apply(w, m, { values: { town: 'Shelbyville' } })).toEqual({ ok: true, body: { applied: true, values: { town: 'Shelbyville' } } });
    expect(w.files.get(workspacePath('m', 'SOUL.md'))).toBe('# The soul of Shelbyville\n');
    expect(w.files.get(workspacePath('m', 'AGENTS.md'))).toBe('Rules for Shelbyville.\n');
    const now = w.store.getAgent('m')!;
    expect(now.paramValues).toEqual({ town: 'Shelbyville' });
    expect(now.paramFiles).toMatchObject({ soul: '# The soul of {{town}}\n', agents: 'Rules for {{ town }}.\n' });
    expect(w.store.listSnapshots('m').map((s) => s.reason)).toEqual(['pre-params']);
    // Named for why it was taken, not as one taken by hand.
    expect(w.store.listSnapshots('m').map((s) => s.label)).toEqual(['before its setup values or definition changed']);
    expect(w.asked).toEqual(['turn m']);
    // A reset renders the defaults from the stored layer.
    expect(await apply(w, w.store.getAgent('m')!, { reset: true })).toMatchObject({ ok: true, body: { values: { town: 'Springfield' } } });
    expect(w.files.get(workspacePath('m', 'SOUL.md'))).toBe('# The soul of Springfield\n');
  });

  it('says so when the files have no placeholders, and writes nothing', async () => {
    const w = world();
    const m = w.agent('m', { params: [TOWN], soul: '# Plain\n', agents: 'Plain rules.\n' });
    const r = await apply(w, m, { values: { town: 'Shelbyville' } });
    expect(r).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/^No \{\{placeholders\}\} found/) });
    expect(w.files.get(workspacePath('m', 'SOUL.md'))).toBe('# Plain\n');
    expect(w.store.getAgent('m')!.paramValues).toBeUndefined();
  });

  it('puts SOUL.md back when AGENTS.md cannot be written: all the files or none', async () => {
    const w = world();
    const m = w.agent('m', { params: [TOWN], soul: '# The soul of {{town}}\n', agents: 'Rules for {{town}}.\n' });
    w.failWrites.add(workspacePath('m', 'AGENTS.md'));
    expect(await apply(w, m, { values: { town: 'Shelbyville' } })).toEqual({ ok: false, status: 500, error: 'Write failed. Nothing was changed.' });
    expect(w.files.get(workspacePath('m', 'SOUL.md'))).toBe('# The soul of {{town}}\n');
    expect(w.store.getAgent('m')!.paramValues).toBeUndefined();
  });

  it('puts a file back that was written although its write answered with a failure (HB-1083)', async () => {
    const w = world();
    const m = w.agent('m', { params: [TOWN], soul: '# The soul of {{town}}\n', agents: 'Rules for {{town}}.\n' });
    w.landsButFails.add(workspacePath('m', 'AGENTS.md'));
    expect(await apply(w, m, { values: { town: 'Shelbyville' } })).toEqual({ ok: false, status: 500, error: 'Write failed. Nothing was changed.' });
    expect(w.files.get(workspacePath('m', 'SOUL.md'))).toBe('# The soul of {{town}}\n');
    expect(w.files.get(workspacePath('m', 'AGENTS.md'))).toBe('Rules for {{town}}.\n');
    expect(w.store.getAgent('m')!.paramValues).toBeUndefined();
    // One whose answer was a failure and that did not land is not written again.
    w.failWrites.add(workspacePath('m', 'AGENTS.md'));
    expect(await apply(w, w.store.getAgent('m')!, { values: { town: 'Shelbyville' } })).toEqual({ ok: false, status: 500, error: 'Write failed. Nothing was changed.' });
    expect(w.files.get(workspacePath('m', 'AGENTS.md'))).toBe('Rules for {{town}}.\n');
  });

  it('keeps the sections Hatchabot keeps in AGENTS.md as they are now, not as the layer has them (HB-0959)', async () => {
    const w = world();
    const at = workspacePath('m', 'AGENTS.md');
    const m = w.agent('m', { params: [TOWN], soul: '# The soul of {{town}}\n',
      agents: 'Rules for {{town}}.\n\n## Google accounts\n\n- old-mailbox@example.org\n\n## Data sources\n\n- /data/recipes\n' });
    expect(await apply(w, m, { values: { town: 'Shelbyville' } })).toMatchObject({ ok: true });
    // Since then: another account attached, the folder taken away, a peer granted.
    w.files.set(at, 'Rules for Shelbyville.\n\n## Google accounts\n\n- new-mailbox@example.org\n\n## Data sources\n\n(none)\n\n## Peers\n\n- Meal Planner\n');
    expect(await apply(w, w.store.getAgent('m')!, { values: { town: 'Ogdenville' } })).toMatchObject({ ok: true });
    expect(w.files.get(at)).toBe('Rules for Ogdenville.\n\n## Google accounts\n\n- new-mailbox@example.org\n\n## Data sources\n\n(none)\n\n## Peers\n\n- Meal Planner\n');
    // The account detached: its section is gone from the file, and stays gone.
    w.files.set(at, 'Rules for Ogdenville.\n\n## Data sources\n\n(none)\n');
    expect(await apply(w, w.store.getAgent('m')!, { values: { town: 'Shelbyville' } })).toMatchObject({ ok: true });
    expect(w.files.get(at)).toBe('Rules for Shelbyville.\n\n## Data sources\n\n(none)\n');
    expect(w.store.getAgent('m')!.paramFiles!.agents).toContain('old-mailbox@example.org');
    // A section whose place the file's code fences leave unsure is refused, and nothing is written.
    w.files.set(at, 'Rules for Shelbyville.\n\n```bash\necho hi\n````\n## Data sources\n\n(none)\n');
    expect(await apply(w, w.store.getAgent('m')!, { values: { town: 'Ogdenville' } })).toEqual({ ok: false, status: 400,
      error: 'AGENTS.md has a code fence that doesn\'t close above "Data sources"; fix it, then apply the values again.' });
    expect(w.files.get(workspacePath('m', 'SOUL.md'))).toBe('# The soul of Shelbyville\n');
  });

  it('is refused at its turn when the agent stopped while it waited', async () => {
    const w = world();
    const m = w.agent('m', { params: [TOWN], soul: '# {{town}}\n' });
    const ready = w.d.values.prepare(m, { values: { town: 'Shelbyville' } });
    w.store.setAgentState('m', 'STOPPED');
    expect(ready.ok && await ready.body()).toEqual({ ok: false, status: 409, error: 'Start the agent to change its setup values.' });
  });

  it('is refused while the agent is busy with something else', async () => {
    const w = world();
    const m = w.agent('m', { params: [TOWN], soul: '# {{town}}\n' });
    const ready = w.d.values.prepare(m, { values: { town: 'Shelbyville' } });
    markBusy('m');
    try { expect(ready.ok && await ready.body()).toMatchObject({ ok: false, status: 409 }); } finally { clearBusy('m'); }
  });
});

describe('a master\'s definition pushed to its children', () => {
  it('renders each running child from the master\'s files with its own values, and says why a stopped one was not', async () => {
    const w = world();
    const m = w.agent('m', { params: [TOWN], soul: '# The soul of {{town}}\n', agents: 'Rules for {{town}}.\n' });
    w.agent('c', { parent: 'm', values: { town: 'Ogdenville' }, soul: 'old soul\n', agents: 'old rules\n' });
    w.agent('s', { parent: 'm', state: 'STOPPED' });
    const r = await w.d.push.push(m, OWNER, (id) => w.store.getAgent(id));
    expect(r).toEqual({ ok: true, body: { pushed: 1, results: expect.arrayContaining([
      { id: 'c', name: 'Agent c', ok: true },
      { id: 's', name: 'Agent s', ok: false, error: 'not running (STOPPED)' },
    ]) } });
    expect(w.files.get(workspacePath('c', 'SOUL.md'))).toBe('# The soul of Ogdenville\n');
    expect(w.files.get(workspacePath('c', 'AGENTS.md'))).toBe('Rules for Ogdenville.\n');
    const child = w.store.getAgent('c')!;
    expect(child.paramFiles).toMatchObject({ soul: '# The soul of {{town}}\n' });
    expect(child.parameters?.map((p) => p.key)).toEqual(['town']);
    expect(w.store.listSnapshots('c').map((s) => s.reason)).toEqual(['pre-params']);
    // A push takes it for the same reason, and its name is true of both.
    expect(w.store.listSnapshots('c').map((s) => s.label)).toEqual(['before its setup values or definition changed']);
    expect(w.asked).toEqual(['turn c', 'sync c']);
  });

  it('refuses a master with no children of this owner, and one with nothing to push', async () => {
    const w = world();
    const m = w.agent('m', { params: [TOWN] });
    expect(await w.d.push.push(m, OWNER, (id) => w.store.getAgent(id))).toEqual({ ok: false, status: 400, error: 'This agent has no derived children.' });
    w.agent('c', { parent: 'm' });
    expect(await w.d.push.push(m, 'user-someone-else', (id) => w.store.getAgent(id))).toEqual({ ok: false, status: 400, error: 'This agent has no derived children.' });
    expect(await w.d.push.push(m, OWNER, (id) => w.store.getAgent(id))).toEqual({ ok: false, status: 400, error: 'The master has neither a SOUL.md nor an AGENTS.md to push.' });
  });

  it('puts a child\'s file back that was written although its write answered with a failure (HB-1194)', async () => {
    const w = world();
    const m = w.agent('m', { params: [TOWN], soul: '# The soul of {{town}}\n', agents: 'Rules for {{town}}.\n' });
    w.agent('c', { parent: 'm', values: { town: 'Ogdenville' }, soul: 'old soul\n', agents: 'old rules\n' });
    w.landsButFails.add(workspacePath('c', 'AGENTS.md'));
    expect(await w.d.push.push(m, OWNER, (id) => w.store.getAgent(id))).toEqual({ ok: true, body: { pushed: 0, results: [
      { id: 'c', name: 'Agent c', ok: false, error: 'write failed' },
    ] } });
    expect(w.files.get(workspacePath('c', 'SOUL.md'))).toBe('old soul\n');
    expect(w.files.get(workspacePath('c', 'AGENTS.md'))).toBe('old rules\n');
    expect(w.store.getAgent('c')!.paramFiles).toBeUndefined();
    // One whose answer was a failure and that did not land is not written again.
    let writes = 0;
    const set = w.files.set.bind(w.files);
    w.files.set = (k, v) => { if (k === workspacePath('c', 'AGENTS.md')) writes++; return set(k, v); };
    w.failWrites.add(workspacePath('c', 'AGENTS.md'));
    expect((await w.d.push.push(m, OWNER, (id) => w.store.getAgent(id))).ok).toBe(true);
    expect(w.files.get(workspacePath('c', 'SOUL.md'))).toBe('old soul\n');
    expect(w.files.get(workspacePath('c', 'AGENTS.md'))).toBe('old rules\n');
    expect(writes).toBe(0);
  });

  it('a write that was never run (the machine did not answer) is not one to put back, and the push says only that it failed (HB-1194)', async () => {
    const w = world();
    const m = w.agent('m', { params: [TOWN], soul: '# The soul of {{town}}\n', agents: 'Rules for {{town}}.\n' });
    w.agent('c', { parent: 'm', values: { town: 'Ogdenville' }, soul: 'old soul\n', agents: 'old rules\n' });
    w.outOfReach.add(workspacePath('c', 'SOUL.md'));
    expect(await w.d.push.push(m, OWNER, (id) => w.store.getAgent(id))).toEqual({ ok: true, body: { pushed: 0, results: [
      { id: 'c', name: 'Agent c', ok: false, error: 'write failed' },
    ] } });
    expect(w.files.get(workspacePath('c', 'SOUL.md'))).toBe('old soul\n');
    expect(w.files.get(workspacePath('c', 'AGENTS.md'))).toBe('old rules\n');
  });

  it('checks the master again after reading it: one the caller no longer has is refused, nothing written', async () => {
    const w = world();
    const m = w.agent('m', { params: [TOWN], soul: '# {{town}}\n' });
    w.agent('c', { parent: 'm', soul: 'old soul\n' });
    let reads = 0;
    const owned = (id: string) => (id === 'm' && ++reads > 1 ? undefined : w.store.getAgent(id));
    expect(await w.d.push.push(m, OWNER, owned)).toEqual({ ok: false, status: 400, error: 'The master changed while preparing its definition. Refresh and try again.' });
    expect(w.files.get(workspacePath('c', 'SOUL.md'))).toBe('old soul\n');
  });
});
