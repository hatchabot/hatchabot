import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { Store } from '../src/store/store.js';
import type { RuntimeProvider } from '../src/providers/provider.js';
import { createProblemReports, type ProblemReports, type ReportCaller } from '../src/orchestrator/diagnostics/problemReports.js';
import { MemSecrets } from './support/world.js';

/**
 * The Report a problem service (HB-0808, docs/field-reports.md), driven as
 * its routes drive it but with no HTTP server: the facts a report carries,
 * a draft masked before it is kept and again as it leaves, a member's view
 * of the machine, the known problems and the installed source. A real store
 * on an in-memory database and the repository as the installed release.
 * Every name is made up; the credential is built at run time.
 */
const OWNER = 'user-owner';
const MEMBER = 'user-member';
const APP_DIR = resolve(import.meta.dirname, '..');
/** Shaped like nothing real: made here so no scanner sees a key in the file. */
const KEY = ['made', 'up', 'credential', 'x'.repeat(8), String(4242)].join('-');

interface World {
  store: Store; secrets: MemSecrets; svc: ProblemReports; logs: string;
  /** Run while doctor's lines are being gathered (a step of the facts that takes a while). */
  onDoctor?: () => Promise<void>;
}

function world(): World {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const w = { store, secrets, logs: '' } as World;
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'pantry-box', settings: {}, createdAt: 'now' });
  const provider = {
    currentImageInfo: async () => ({ openclawVersion: '2026.9.8' }),
    logs: async () => w.logs,
  } as unknown as RuntimeProvider;
  w.svc = createProblemReports({
    store, secrets,
    providerFor: () => provider,
    appDir: APP_DIR,
    version: 'v9.9.9',
    reportDoctor: async () => { await w.onDoctor?.(); return [{ ok: true, label: 'Doctor ran', detail: 'on pantry-box' }] as never; },
    addressHosts: () => ['hatch.example.test'],
  });
  return w;
}
const caller = (ownerId: string, ownsMachine: boolean, store: Store): ReportCaller => ({
  ownerId, ownsMachine: () => ownsMachine,
  owned: (id) => { const a = store.getAgent(id); return a && a.ownerId === ownerId ? a : undefined; },
});
function agent(w: World, id: string, ownerId: string, name: string): void {
  w.store.insertAIProfile({ id: `p-${id}`, ownerId, name: 'key', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: `ai/${id}`, createdAt: 'now' } as never);
  w.store.insertAgent({
    id, ownerId, name, slug: name.toLowerCase(), state: 'RUNNING', aiProfileId: `p-${id}`, hostId: 'h1',
    persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `rt-${id}`,
  } as never);
}

describe('a draft', () => {
  it('is made from what was written and the facts, masked before it is kept', async () => {
    const w = world();
    agent(w, 'a1', OWNER, 'Bramblewick');
    await w.secrets.put('ai/a1', KEY);
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u-x', role: 'member', displayName: 'Ottoline Fernsby', status: 'active' } as never);
    w.store.recordEvent('a1', 'provision.failed', { error: `Bramblewick could not start with ${KEY}`, by: 'Ottoline Fernsby' });
    w.logs = `Bramblewick saw ${KEY} on pantry-box`;
    const me = caller(OWNER, true, w.store);
    const view = await w.svc.create(me, { title: 'Bramblewick will not start', whatHappened: 'Ottoline Fernsby asked and nothing came back.', by: 'person' }, 'a1');
    const kept = w.store.getProblemReport(OWNER, view.id)!;
    for (const text of [kept.title, kept.body, view.title, view.body, view.issueUrl]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('Bramblewick');
      expect(text).not.toContain('Ottoline');
      expect(text).not.toContain('pantry-box');
    }
    expect(kept.body).toContain('v9.9.9');
    expect(view).toMatchObject({ agentId: 'a1', by: 'person', reviewPath: `/#report=${view.id}` });
    expect(view.fileName).toMatch(/^hatchabot-report-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}\.md$/);
    expect(w.svc.list(OWNER)).toEqual([expect.not.objectContaining({ body: expect.anything() })]);
    expect(await w.svc.get(me, view.id)).toMatchObject({ id: view.id, title: kept.title });
  });

  it('a credential changed while the facts are gathered is masked under both values, in the kept draft and its link (HB-0920)', async () => {
    const w = world();
    agent(w, 'a1', OWNER, 'Bramblewick');
    const OLD = `${KEY}-old`, NEW = `${KEY}-new`;
    w.store.insertAgentEnv({ id: 'e1', agentId: 'a1', name: 'PANTRY_TOKEN', secretRef: 'env/a1/e1', createdAt: 'now' } as never);
    await w.secrets.put('env/a1/e1', OLD);
    w.store.recordEvent('a1', 'tool.failed', { error: `refused ${OLD}` });
    // Changed after the masking first read it, and a failure naming the new one recorded while doctor runs.
    w.onDoctor = async () => {
      await w.secrets.put('env/a1/e1', NEW);
      w.store.recordEvent('a1', 'tool.failed', { error: `refused ${NEW}` });
    };
    const view = await w.svc.create(caller(OWNER, true, w.store), { title: 'A tool keeps failing', whatHappened: 'It keeps failing.', by: 'person' }, 'a1');
    const kept = w.store.getProblemReport(OWNER, view.id)!;
    expect(kept.body).toMatch(/tool\.failed/);
    for (const text of [kept.body, view.body, view.issueUrl, decodeURIComponent(view.issueUrl)]) {
      expect(text).not.toContain(NEW);
      expect(text).not.toContain(OLD);
    }
  });

  it('an edit is masked like the rest before it is kept; a field left out is kept', async () => {
    const w = world();
    agent(w, 'a1', OWNER, 'Bramblewick');
    const me = caller(OWNER, true, w.store);
    const view = await w.svc.create(me, { title: 'It stopped', whatHappened: 'It stopped answering.', by: 'agent' }, undefined);
    const edited = await w.svc.edit(me, view.id, { body: 'Bramblewick stopped again.' });
    expect(edited?.title).toBe(view.title);
    expect(w.store.getProblemReport(OWNER, view.id)!.body).not.toContain('Bramblewick');
    expect(await w.svc.edit(me, 'no-such', { title: 'x' })).toBeUndefined();
  });

  it('is only its writer\'s: another account cannot read, mark, edit or delete it', async () => {
    const w = world();
    const me = caller(OWNER, true, w.store);
    const them = caller(MEMBER, false, w.store);
    const view = await w.svc.create(me, { title: 'It stopped', whatHappened: 'It stopped answering.', by: 'person' }, undefined);
    expect(await w.svc.get(them, view.id)).toBeUndefined();
    expect(await w.svc.edit(them, view.id, { title: 'mine now' })).toBeUndefined();
    expect(w.svc.markSent(MEMBER, view.id)).toBe(false);
    expect(w.svc.remove(MEMBER, view.id)).toBe(false);
    expect(w.svc.markSent(OWNER, view.id)).toBe(true);
    expect(w.store.getProblemReport(OWNER, view.id)!.sentAt).toBeTruthy();
    expect(w.svc.remove(OWNER, view.id)).toBe(true);
    expect(w.svc.list(OWNER)).toEqual([]);
  });
});

describe('the facts and the masking', () => {
  it('the machine\'s owner gets doctor\'s lines and every agent\'s failures; a member only their own, and no doctor', async () => {
    const w = world();
    agent(w, 'a1', OWNER, 'Bramblewick');
    agent(w, 'a2', MEMBER, 'Quillfeather');
    w.store.recordEvent('a1', 'provision.failed', { error: 'one' });
    w.store.recordEvent('a2', 'provision.failed', { error: 'two' });
    const owner = await w.svc.reportFacts(caller(OWNER, true, w.store));
    expect(owner).toMatchObject({ version: 'v9.9.9', openclaw: '2026.9.8', doctor: [expect.objectContaining({ label: 'Doctor ran' })] });
    expect(owner.failures?.map((f) => f.agent).sort()).toEqual(['Bramblewick', 'Quillfeather']);
    const member = await w.svc.reportFacts(caller(MEMBER, false, w.store));
    expect(member.doctor).toBeUndefined();
    expect(member.failures?.map((f) => f.agent)).toEqual(['Quillfeather']);
    // A member cannot name another person's agent for its facts.
    expect((await w.svc.reportFacts(caller(MEMBER, false, w.store), 'a1')).agent).toBeUndefined();
  });

  it('a recent failure is in the facts though other agents logged hundreds of ordinary lines since (HB-1100)', async () => {
    const w = world();
    agent(w, 'a1', OWNER, 'Bramblewick');
    w.store.recordEvent('a1', 'runtime.failed', { error: 'the gateway stopped' });
    for (const [id, name] of [['a2', 'Quillfeather'], ['a3', 'Marrowdale'], ['a4', 'Thistlecombe']] as const) {
      agent(w, id, OWNER, name);
      for (let i = 0; i < 150; i++) w.store.recordEvent(id, 'agent.started');
    }
    const facts = await w.svc.reportFacts(caller(OWNER, true, w.store));
    expect(facts.failures?.map((f) => [f.agent, f.event])).toEqual([['Bramblewick', 'runtime.failed']]);
  });

  it('the masking knows the agents\' names, the machines and the install\'s address, and a member\'s only their own', async () => {
    const w = world();
    agent(w, 'a1', OWNER, 'Bramblewick');
    agent(w, 'a2', MEMBER, 'Quillfeather');
    const all = await w.svc.reportRedaction(caller(OWNER, true, w.store));
    expect(all.names).toEqual(expect.arrayContaining(['Bramblewick', 'Quillfeather']));
    expect(all.hosts).toEqual(expect.arrayContaining(['pantry-box', 'hatch.example.test']));
    const mine = await w.svc.reportRedaction(caller(MEMBER, false, w.store));
    expect(mine.names).toEqual(['Quillfeather', 'quillfeather']);
  });
});

describe('known problems and the installed source', () => {
  it('finds the playbook entry a symptom is, against this release', () => {
    const got = w0().svc.knownFor('Your Hatchabot agent did not answer: busy');
    expect(got.installed).toBe('v9.9.9');
    expect(got.matches[0]?.title).toContain('Your Hatchabot agent did not answer');
  });

  it('reads a file of the source, and refuses a path out of it', () => {
    const svc = w0().svc;
    expect(svc.read('src/orchestrator/diagnostics/problemReports.ts', 1, 3)).toMatchObject({ from: 1, to: 3 });
    expect(() => svc.read('../outside.txt', 1, undefined)).toThrow();
  });

  it('searches the source for plain text', async () => {
    const got = await w0().svc.search('createProblemReports', 'src/orchestrator/diagnostics', false, OWNER);
    expect(JSON.stringify(got)).toContain('problemReports.ts');
  });
});

function w0(): World { return world(); }
