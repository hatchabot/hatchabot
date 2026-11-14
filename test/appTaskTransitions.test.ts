import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/providers/mockProvider.js';
import type { ExecResult } from '../src/providers/provider.js';
import { parseManifest, syncTasks, taskTransitionPending, type InstallDeps } from '../src/orchestrator/apps.js';
import { SimulatedCrash } from '../src/orchestrator/operations.js';

// The scheduler, transition journal and settled provenance survive a simulated
// restart, while each syncTasks invocation has fresh local state. No shell or
// real agent is used. Keep the files separate so a transition write or clear
// cannot silently replace the last confirmed definitions.
const before = parseManifest(JSON.stringify({
  app: 'demoapp', name: 'Demo App', tasks: ['tick', 'quiet', 'retired'].map((name) => ({ name, every: '1m', command: ['echo', 'before', name] })),
}));
const after = parseManifest(JSON.stringify({
  app: 'demoapp', name: 'Demo App', tasks: ['tick', 'quiet', 'news'].map((name) => ({ name, every: '2m', command: ['echo', 'after', name] })),
}));
type Scheduled = { id: string; name: string; enabled: boolean; every?: string; payload: { kind: 'command' | 'agentTurn'; argv?: string[] } };
type Fault = { at: number; kind: 'refused' | 'lost reply' | 'thrown after applying' | 'crash' };
const ok = (stdout = '{}'): ExecResult => ({ code: 0, stdout, stderr: '' });

class Scheduler extends MockProvider {
  jobs: Scheduled[] = [
    ...before.tasks.map((t) => ({ id: `old-${t.name}`, name: `demoapp-${t.name}`, enabled: t.name !== 'quiet', every: t.every, payload: { kind: 'command' as const, argv: t.command } })),
    { id: 'personal', name: 'demoapp-tick', enabled: true, payload: { kind: 'agentTurn' } },
    { id: 'unrelated', name: 'daily-brief', enabled: true, every: '1h', payload: { kind: 'command', argv: ['echo', 'personal'] } },
  ];
  files = new Map<string, string>();
  commands: string[][] = [];
  states: Scheduled[][] = [];
  fault: Fault | undefined;
  hit = false;
  nextId = 0;

  override async exec(_ref: string, argv: string[]): Promise<ExecResult> {
    this.commands.push([...argv]);
    const fault = !this.hit && this.fault?.at === this.commands.length ? this.fault : undefined;
    if (fault) this.hit = true;
    if (fault?.kind === 'refused') return { code: 1, stdout: '', stderr: 'fixture refusal' };
    let result = ok();
    const verb = argv[1];
    if (verb === 'list') result = ok(JSON.stringify({ jobs: this.jobs }));
    else if (verb === 'add') {
      const value = (key: string) => argv[argv.indexOf(key) + 1]!;
      const job: Scheduled = { id: `added-${++this.nextId}`, name: value('--name'), enabled: !argv.includes('--disabled'), every: value('--every'), payload: { kind: 'command', argv: JSON.parse(value('--command-argv')) } };
      this.jobs.push(job);
      result = ok(JSON.stringify({ id: job.id }));
    } else if (verb === 'enable' || verb === 'disable') {
      const job = this.jobs.find((j) => j.id === argv[2]);
      if (!job) return { code: 1, stdout: '', stderr: 'fixture job missing' };
      job.enabled = verb === 'enable';
    } else if (verb === 'rm') this.jobs = this.jobs.filter((j) => j.id !== argv[2]);
    else throw new Error(`Unexpected scheduler command: ${argv.join(' ')}`);
    if (verb !== 'list') this.states.push(structuredClone(this.jobs));
    if (fault?.kind === 'lost reply') return { code: 1, stdout: '', stderr: 'fixture response lost', timedOut: true };
    if (fault?.kind === 'thrown after applying') throw new Error('fixture disconnected after applying');
    if (fault?.kind === 'crash') throw new SimulatedCrash();
    return result;
  }

  override async execShell(_ref: string, script: string): Promise<ExecResult> {
    const files = [...new Set(script.match(/\.tasks-(?:transition|settled)\.json/g))];
    if (!files.length) throw new Error('Unexpected non-task-state shell operation');
    if (script.startsWith('if [ -e') && files.length === 1) {
      const data = this.files.get(files[0]!);
      return ok(data === undefined ? '' : `present\n${data}`);
    }
    if (script.startsWith('rm -f')) { for (const file of files) this.files.delete(file); return ok(''); }
    throw new Error('Unexpected task-state shell operation');
  }

  override async writeToVolume(_ref: string, argv: string[], input: Buffer): Promise<ExecResult> {
    const file = argv.join(' ').match(/(\.tasks-(?:transition|settled)\.json)\.tmp/)?.[1];
    if (!file) throw new Error('Unexpected non-task-state write');
    this.files.set(file, input.toString());
    return ok('');
  }
}

const deps = (provider: Scheduler): InstallDeps => ({ provider, runtimeRef: 'mock://a1', facts: { slug: 'garden', name: 'Garden', timezone: 'UTC' } });
const appState = (jobs: Scheduled[]) => jobs.filter((j) => j.payload.kind === 'command' && j.name.startsWith('demoapp-'))
  .map((j) => ({ name: j.name, enabled: j.enabled, every: j.every, command: j.payload.argv })).sort((a, b) => a.name.localeCompare(b.name));
const personalState = (jobs: Scheduled[]) => jobs.filter((j) => j.id === 'personal' || j.id === 'unrelated');
const noOverlap = (p: Scheduler, context = '') => {
  for (const jobs of p.states) {
    const enabled = jobs.filter((j) => j.enabled);
    expect(enabled.some((j) => j.payload.argv?.[1] === 'before') && enabled.some((j) => j.payload.argv?.[1] === 'after'), context).toBe(false);
    const appNames = enabled.filter((j) => j.payload.kind === 'command' && j.name.startsWith('demoapp-')).map((j) => j.name);
    // A retry can replace jobs with identical commands: IDs still must not
    // overlap and run the same named app task twice.
    expect(new Set(appNames).size, context).toBe(appNames.length);
  }
};
const desired = () => after.tasks.map((t) => ({ name: `demoapp-${t.name}`, enabled: t.name !== 'quiet', every: t.every, command: t.command })).sort((a, b) => a.name.localeCompare(b.name));

describe('app scheduled-task transitions withstand scheduler faults (HB-0691)', () => {
  it('keeps unrelated jobs and owner-disabled jobs, with no enabled old/new overlap at any mutation', async () => {
    const p = new Scheduler();
    const personal = structuredClone(personalState(p.jobs));
    expect(await syncTasks(deps(p), after, before)).toEqual(['demoapp-tick', 'demoapp-quiet', 'demoapp-news']);
    noOverlap(p);
    expect(appState(p.jobs)).toEqual(desired());
    expect(personalState(p.jobs)).toEqual(personal);
    expect(await taskTransitionPending(deps(p), after.app)).toBe(false);
  });

  for (const retry of [false, true]) {
    it.each(['refused', 'lost reply', 'thrown after applying'] as const)(`reconciles a %s at every scheduler boundary${retry ? ' when retrying a completed update with a stale app record (HB-0701)' : ''}`, async (kind) => {
      const prepare = async () => {
        const p = new Scheduler();
        if (retry) {
          // The scheduler committed, then the process ended before updating
          // the app record: the next caller still supplies "before".
          await syncTasks(deps(p), after, before);
          p.commands = [];
          p.states = [];
        }
        return p;
      };
      // Discover the successful path so added readbacks gain fault coverage too.
      const baseline = await prepare();
      await syncTasks(deps(baseline), after, before);
      for (let at = 1; at <= baseline.commands.length; at++) {
        const p = await prepare();
        const original = structuredClone(appState(p.jobs));
        const personal = structuredClone(personalState(p.jobs));
        p.fault = { at, kind };
        const context = `${kind} at ${baseline.commands[at - 1]!.slice(0, 3).join(' ')} (#${at})`;
        let failure: unknown;
        try { await syncTasks(deps(p), after, before); } catch (err) { failure = err; }
        expect(p.hit, context).toBe(true);
        expect(failure, context).toBeInstanceOf(Error);
        noOverlap(p, context);
        expect(personalState(p.jobs), context).toEqual(personal);
        // Every injected failure is transient: readback/rollback can finish.
        expect((failure as { tasksUnconfirmed?: boolean }).tasksUnconfirmed, context).not.toBe(true);
        expect(appState(p.jobs), context).toEqual(original);
        expect(await taskTransitionPending(deps(p), after.app), context).toBe(false);
      }
    });
  }

  it('a new sync after a crash restores intent before reading disabled staging jobs as owner choices', async () => {
    const baseline = new Scheduler();
    await syncTasks(deps(baseline), after, before);
    const mutations = baseline.commands.flatMap((argv, i) => argv[1] === 'list' ? [] : [i + 1]);
    for (const at of mutations) {
      const p = new Scheduler();
      const personal = structuredClone(personalState(p.jobs));
      p.fault = { at, kind: 'crash' };
      await expect(syncTasks(deps(p), after, before)).rejects.toBeInstanceOf(SimulatedCrash);
      expect(p.hit).toBe(true);
      expect(await taskTransitionPending(deps(p), after.app)).toBe(true);
      noOverlap(p, `before recovery at ${at}`);
      // Fresh invocation, same persisted journal and scheduler, no fault.
      p.fault = undefined;
      await syncTasks(deps(p), after, before);
      noOverlap(p, `after recovery at ${at}`);
      expect(appState(p.jobs), `crash at ${at}`).toEqual(desired());
      expect(personalState(p.jobs)).toEqual(personal);
      expect(await taskTransitionPending(deps(p), after.app)).toBe(false);
    }
  });

  it('rollback does not claim another command from a stale provenance manifest (HB-0701)', async () => {
    const p = new Scheduler();
    await syncTasks(deps(p), after, before);
    // The owner replaces a task that the current app record does not name.
    // The settled file knows its former id, not this new personal job.
    const replaced = p.jobs.find((j) => j.name === 'demoapp-news')!;
    replaced.id = 'replacement-personal';
    replaced.payload.argv = ['echo', 'personal-news'];
    const personal = structuredClone(replaced);
    p.commands = [];
    p.states = [];
    p.fault = { at: 2, kind: 'refused' };
    await expect(syncTasks(deps(p), before, before)).rejects.toThrow('Its tasks are as they were');
    expect(p.hit).toBe(true);
    expect(p.jobs.find((j) => j.id === personal.id)).toEqual(personal);
    expect(p.commands.some((argv) => ['disable', 'rm'].includes(argv[1]!) && argv[2] === personal.id)).toBe(false);
    expect(await taskTransitionPending(deps(p), before.app)).toBe(false);
  });
});
