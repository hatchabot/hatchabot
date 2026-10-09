import { randomUUID } from 'node:crypto';
import type { OperationRow, Store } from '../store/store.js';

/**
 * Durable operations (docs/operations-and-one-interface-design.md, Part A).
 *
 * A long change — a move, a move to another Hatchabot, an import — records
 * itself in the `operations` table as it goes: what was asked, the last step
 * known to be done, the outcome, and what the owner may do next. A restart in
 * the middle then leaves a row in status `running` from another process
 * (another boot id), which `resumeOperations()` (operationsResume.ts) finishes
 * or undoes on purpose, or holds for the owner when the direction is not
 * certain.
 *
 * An agent with an operation that is not over (running, interrupted, held) is
 * busy ON DISK: Start, Rebuild, Archive, Move, Delete and Wake refuse with its
 * outcome line (`operationRefusal`). The in-memory busy flag (busy.ts) stays
 * for short operations and for reconcile.
 */

export type OpKind =
  | 'move-host'
  | 'migrate'
  | 'import'
  | 'restore-backup'
  | 'restore-snapshot'
  | 'provision'
  | 'rebuild'
  | 'archive'
  | 'unarchive'
  | 'app-install'
  | 'app-update'
  | 'app-rollback'
  | 'install-image'
  | 'backup-run'
  | 'restore-drill';

export type OpStatus = OperationRow['status'];
export type Operation = OperationRow;

/**
 * What to do when a restart cut the operation off right after this step:
 * nothing was changed; undo it; finish it; ask another server; or hold it for
 * the owner's choice (a restore half-written: either way is right).
 */
export type AfterStep = 'nothing' | 'undo' | 'finish' | 'ask' | 'hold';

export interface StepDef {
  key: string;
  /** For the owner: "copying its memory in". */
  label: string;
  /** Changes something that is not put back by itself (stops, removes, flips). */
  destructive: boolean;
  after: AfterStep;
}

/**
 * Each kind's steps, in order. The resume rules (operationsResume.ts) read
 * `after` for the last step done; the page reads the label and position
 * ("step 4 of 9: copying its memory in").
 */
export const STEPS: Partial<Record<OpKind, StepDef[]>> = {
  'move-host': [
    { key: 'checked', label: 'both machines answered and are different machines', destructive: false, after: 'nothing' },
    { key: 'stopped', label: 'stopped here', destructive: true, after: 'undo' },
    { key: 'exported', label: 'its memory copied out', destructive: false, after: 'undo' },
    { key: 'target-created', label: 'made on the other machine', destructive: false, after: 'undo' },
    { key: 'state-copied', label: 'its memory copied in', destructive: false, after: 'undo' },
    { key: 'host-flipped', label: 'recorded on the other machine', destructive: true, after: 'finish' },
    { key: 'target-configured', label: 'its settings written there', destructive: false, after: 'finish' },
    { key: 'target-started', label: 'started there', destructive: false, after: 'finish' },
    { key: 'settled', label: 'running there', destructive: false, after: 'finish' },
    { key: 'source-removed', label: 'the old copy removed', destructive: true, after: 'finish' },
  ],
  migrate: [
    { key: 'preflight-ok', label: 'the other Hatchabot is ready for it', destructive: false, after: 'nothing' },
    { key: 'exported', label: 'stopped here and packed up', destructive: true, after: 'ask' },
    { key: 'answered', label: 'the other Hatchabot answered', destructive: false, after: 'ask' },
  ],
  import: [
    { key: 'row-made', label: 'its record made', destructive: false, after: 'undo' },
    { key: 'members', label: 'its members added', destructive: false, after: 'undo' },
    { key: 'channel', label: 'its bot added', destructive: false, after: 'undo' },
    { key: 'env', label: 'its environment added', destructive: false, after: 'undo' },
    { key: 'created', label: 'its container made', destructive: false, after: 'undo' },
    { key: 'state-copied', label: 'its memory copied in', destructive: false, after: 'undo' },
    { key: 'configured', label: 'its settings written', destructive: false, after: 'undo' },
    { key: 'started', label: 'started', destructive: false, after: 'undo' },
    { key: 'settled', label: 'its skills settled', destructive: false, after: 'undo' },
  ],
  'restore-backup': [
    { key: 'stopped', label: 'stopped for the restore', destructive: true, after: 'undo' },
    { key: 'safety-taken', label: 'a copy of how it was saved to disk', destructive: false, after: 'hold' },
    { key: 'replaced', label: "that night's copy written in", destructive: true, after: 'hold' },
    { key: 'reapplied', label: 'its current settings put back over it', destructive: false, after: 'finish' },
  ],
  'restore-snapshot': [
    { key: 'safety-taken', label: 'a snapshot of how its files were taken', destructive: false, after: 'hold' },
    { key: 'file-written', label: 'writing its files', destructive: true, after: 'hold' },
    { key: 'written', label: 'its files written', destructive: false, after: 'finish' },
  ],
  archive: [
    { key: 'stopped', label: 'stopped', destructive: true, after: 'undo' },
    { key: 'bot-released', label: 'its bot given back', destructive: true, after: 'finish' },
    { key: 'archived', label: 'put in the archive', destructive: false, after: 'finish' },
  ],
  'app-install': appSteps(),
  'app-update': appSteps(),
  'app-rollback': [
    { key: 'switching', label: 'switching back', destructive: true, after: 'hold' },
    { key: 'tasks', label: 'its scheduled tasks set', destructive: false, after: 'hold' },
  ],
};

/** An install or update: nothing live changes before the switch (apps.ts, installRelease). */
function appSteps(): StepDef[] {
  return [
    { key: 'unpacked', label: 'its code copied in', destructive: false, after: 'nothing' },
    { key: 'configured', label: 'its configuration staged', destructive: false, after: 'nothing' },
    { key: 'tested', label: 'its tests passed', destructive: false, after: 'nothing' },
    { key: 'switching', label: 'switching to it', destructive: true, after: 'hold' },
    { key: 'switched', label: 'switched to it', destructive: true, after: 'hold' },
    { key: 'tasks', label: 'its scheduled tasks set', destructive: false, after: 'hold' },
  ];
}

/**
 * Kinds whose live guard is in memory (the rebuild queue's `inflight`, the
 * busy flag). They are recorded so a restart keeps a queued rebuild and
 * settles one cut off, but in the process running them they never refuse
 * anything on disk (Start, Archive and Delete wait on a rebuild as they always
 * did; store.activeOperationFor leaves them out), and their lines stay in the
 * journal: their own events (runtime.rebuilt, provision.failed…) are the
 * timeline's.
 */
export const BACKGROUND_KINDS: readonly string[] = ['rebuild', 'provision'];

export const KIND_LABEL: Record<string, string> = {
  'move-host': 'Move to another machine',
  migrate: 'Move to another Hatchabot',
  import: 'Import',
  'restore-backup': 'Restore from a backup',
  'restore-snapshot': 'Restore from a snapshot',
  provision: 'Setup',
  rebuild: 'Rebuild',
  archive: 'Archive',
  unarchive: 'Restore from the archive',
  'app-install': 'App install',
  'app-update': 'App update',
  'app-rollback': 'App roll back',
  'install-image': 'Image install',
  'backup-run': 'Backup',
  'restore-drill': 'Restore drill',
};

const ACTIVE: OpStatus[] = ['queued', 'running', 'interrupted', 'held'];

/** This process. A `running` row with another boot id was cut off by a restart. */
let bootId = `boot_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
export function currentBootId(): string {
  return bootId;
}
/** Tests: start a "new process" (the old one's running rows are now interrupted). */
export function newBootForTests(): string {
  bootId = `boot_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return bootId;
}

/** Where step lines go besides the agent's timeline (the journal). index.ts sets it. */
let journal: (event: string, detail: Record<string, unknown>) => void = () => {};
export function setOperationJournal(fn: (event: string, detail: Record<string, unknown>) => void): void {
  journal = fn;
}

/**
 * Tests only: called before each step is recorded. Throwing `SimulatedCrash`
 * there stops the operation as a killed process would — the orchestrators
 * rethrow it before any rollback (`rethrowIfCrash`), so the state is left as a
 * restart would find it.
 */
let stepHook: ((op: Operation, key: string) => void) | undefined;
export function setStepHookForTests(fn: typeof stepHook): void {
  stepHook = fn;
}
export class SimulatedCrash extends Error {
  constructor() {
    super('simulated process death');
    this.name = 'SimulatedCrash';
  }
}
/** First line of every catch that rolls back: a (simulated) dead process rolls nothing back. */
export function rethrowIfCrash(err: unknown): void {
  if (err instanceof SimulatedCrash) throw err;
}

export interface Recovery {
  actions: Array<{ action: string; label: string }>;
  recommended?: string;
}

export interface OpHandle {
  readonly id: string;
  /** A queued operation starts now, in this process. */
  start(): void;
  /** The last step confirmed done; `detail` (never a secret) is merged into params. */
  step(key: string, detail?: Record<string, unknown>): void;
  done(outcome: string): void;
  fail(err: unknown, recovery?: Recovery): void;
  rolledBack(why: string): void;
  hold(outcome: string, recovery: Recovery): void;
  /** The row as stored now. */
  get(): Operation;
}

function event(store: Store, op: Operation, name: string, detail: Record<string, unknown>): void {
  const d = { op: op.id, kind: op.kind, ...detail };
  journal(name, { agentId: op.agentId, ...(op.hostId ? { hostId: op.hostId } : {}), ...d });
  // A machine's operation (an image copy, a backup run) has no agent: the
  // Activity list reads it from the operations table itself (GET /v1/events).
  if (!op.agentId || BACKGROUND_KINDS.includes(op.kind)) return;
  try {
    store.recordEvent(op.agentId, name, d);
  } catch {
    /* a timeline write must never break the operation it describes */
  }
}

/** The step's place and words, for the page: "step 4 of 9: copying its memory in". */
export function stepInfo(kind: string, key: string | null | undefined): { n: number; of: number; label: string } | undefined {
  const steps = STEPS[kind as OpKind];
  if (!steps || !key) return undefined;
  const i = steps.findIndex((s) => s.key === key);
  if (i < 0) return undefined;
  return { n: i + 1, of: steps.length, label: steps[i]!.label };
}

/** Is step `a` at or after step `b` in this kind's list? (An unknown `a` is before everything.) */
export function stepReached(kind: string, a: string | null | undefined, b: string): boolean {
  const steps = STEPS[kind as OpKind] ?? [];
  const ia = steps.findIndex((s) => s.key === a);
  const ib = steps.findIndex((s) => s.key === b);
  return ia >= 0 && ib >= 0 && ia >= ib;
}

export function handleFor(store: Store, id: string): OpHandle {
  const get = (): Operation => {
    const op = store.getOperation(id);
    if (!op) throw new Error(`operation ${id} is gone`);
    return op;
  };
  const finish = (status: OpStatus, outcome: string, recovery: Recovery | null, name: string) => {
    const now = new Date().toISOString();
    const over = !ACTIVE.includes(status);
    const was = store.getOperation(id);
    // Tests: a death after the last step, before the outcome is written.
    if (stepHook && was) stepHook(was, `#${status}`);
    const op = store.updateOperation(id, { status, outcome: outcome.slice(0, 600), recovery, finishedAt: over ? now : null })!;
    notify(id);
    // Held again with the same words (the 10-minute question to another
    // server): one line in the timeline, not one every ten minutes.
    if (was?.status === status && was.outcome === op.outcome) return;
    event(store, op, name, { outcome: op.outcome, ...(recovery ? { recovery: recovery.actions.map((a) => a.action) } : {}) });
  };
  return {
    id,
    start() {
      const op = store.updateOperation(id, { status: 'running', bootId: currentBootId() });
      if (op) event(store, op, 'op.started', { label: KIND_LABEL[op.kind] ?? op.kind });
    },
    step(key, detail) {
      const op = get();
      if (stepHook) stepHook(op, key);
      const info = stepInfo(op.kind, key);
      const params = detail ? { ...op.params, ...detail } : op.params;
      store.updateOperation(id, { step: key, stepAt: new Date().toISOString(), ...(detail ? { params } : {}) });
      event(store, op, 'op.step', { step: key, label: info?.label ?? key, ...(info ? { n: info.n, of: info.of } : {}) });
      notify(id);
    },
    done(outcome) { finish('succeeded', outcome, null, 'op.done'); },
    fail(err, recovery) {
      const msg = err instanceof Error ? ((err as { userMessage?: string }).userMessage ?? err.message) : String(err);
      finish('failed', msg, recovery ?? null, 'op.failed');
    },
    rolledBack(why) { finish('rolled_back', why, null, 'op.rolled_back'); },
    hold(outcome, recovery) { finish('held', outcome, recovery, 'op.held'); },
    get,
  };
}

/**
 * Start recording an operation. `params` is JSON and never a secret: host
 * ids, peer id, wasRunning, the memory-search key row's HASHES, refs.
 */
export function beginOperation(
  store: Store,
  kind: OpKind,
  agentId: string | null,
  params: Record<string, unknown>,
  opts: { hostId?: string; requestedBy?: string; queued?: boolean } = {},
): OpHandle {
  const now = new Date().toISOString();
  const id = `op_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  store.insertOperation({
    id, agentId, hostId: opts.hostId ?? null, kind, requestedBy: opts.requestedBy ?? null,
    requestedAt: now, params, step: null, stepAt: null, status: opts.queued ? 'queued' : 'running', outcome: null,
    recovery: null, bootId: currentBootId(), updatedAt: now, finishedAt: null,
  });
  const op = store.getOperation(id)!;
  // A queued one says "started" when it does (start()).
  if (!opts.queued) event(store, op, 'op.started', { label: KIND_LABEL[kind] ?? kind });
  return handleFor(store, id);
}

// ---- what the page and the CLI show (phase 3) -------------------------------

/** One operation's words: what it is, while it runs, once it is done. */
export interface OpTitles {
  /** "Move to Laptop runner" */
  what: string;
  /** "Moving to Laptop runner" */
  doing: string;
  /** "Moved to Laptop runner" */
  done: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : undefined);

/** From the kind and its params (never a secret): host and server names, a date, a label, an app. */
export function operationTitles(kind: string, params: Record<string, unknown> | null | undefined): OpTitles {
  const p = params ?? {};
  const three = (what: string, doing: string, done: string): OpTitles => ({ what, doing, done });
  switch (kind) {
    case 'move-host': {
      const to = str(p.toName);
      return to ? three(`Move to ${to}`, `Moving to ${to}`, `Moved to ${to}`) : three('Move to another machine', 'Moving to another machine', 'Moved to another machine');
    }
    case 'migrate': {
      const to = str(p.peerName);
      return to ? three(`Move to ${to}`, `Moving to ${to}`, `Moved to ${to}`) : three('Move to another Hatchabot', 'Moving to another Hatchabot', 'Moved to another Hatchabot');
    }
    case 'import': return three('Import', 'Importing', 'Imported');
    case 'restore-backup': {
      const d = str(p.date);
      return d ? three(`Restore from the ${d} backup`, `Restoring from the ${d} backup`, `Restored from the ${d} backup`)
        : three('Restore from a backup', 'Restoring from a backup', 'Restored from a backup');
    }
    case 'restore-snapshot': {
      const l = str(p.label);
      return l ? three(`Restore of its files from "${l}"`, `Restoring its files from "${l}"`, `Restored its files from "${l}"`)
        : three('Restore from a snapshot', 'Restoring from a snapshot', 'Restored from a snapshot');
    }
    case 'archive': return three('Archive', 'Archiving', 'Archived');
    case 'unarchive': return three('Restore from the archive', 'Restoring from the archive', 'Restored from the archive');
    case 'app-install': { const a = str(p.app); return three(`Install of ${a ?? 'its app'}`, `Installing ${a ?? 'its app'}`, `Installed ${a ?? 'its app'}`); }
    case 'app-update': { const a = str(p.app); return three(`Update of ${a ?? 'its app'}`, `Updating ${a ?? 'its app'}`, `Updated ${a ?? 'its app'}`); }
    case 'app-rollback': { const a = str(p.app); return three(`Roll back of ${a ?? 'its app'}`, `Rolling back ${a ?? 'its app'}`, `Rolled back ${a ?? 'its app'}`); }
    case 'install-image': {
      const h = str(p.host);
      return h ? three(`Image install on ${h}`, `Copying the image to ${h}`, `Copied the image to ${h}`) : three('Image install', 'Copying the image', 'Copied the image');
    }
    case 'backup-run': return three('Backup', 'Backing up', 'Backed up');
    case 'restore-drill': return three('Restore drill', 'Drilling a restore from the backups', 'Restore drill passed');
    case 'rebuild': return three('Rebuild', 'Rebuilding', 'Rebuilt');
    case 'provision': return three('Setup', 'Setting up', 'Set up');
    default: { const k = KIND_LABEL[kind] ?? kind; return three(k, k, k); }
  }
}

/** The Activity row's words for how it ended (or where it is): "Moved to Laptop runner", "Move to Laptop runner failed". */
export function operationSummary(kind: string, status: string, params: Record<string, unknown> | null | undefined): string {
  const t = operationTitles(kind, params);
  switch (status) {
    case 'succeeded': return t.done;
    case 'failed': return `${t.what} failed`;
    case 'rolled_back': return `${t.what} undone`;
    case 'held': return `${t.what} is waiting for your choice`;
    case 'interrupted': return `${t.what} was interrupted by a restart`;
    case 'queued': return `${t.what} is waiting its turn`;
    default: return t.doing;
  }
}

/** The timeline event an operation's status reads as (the Activity row's colour). */
export const STATUS_EVENT: Record<string, string> = {
  queued: 'op.started', running: 'op.started', succeeded: 'op.done', failed: 'op.failed',
  rolled_back: 'op.rolled_back', held: 'op.held', interrupted: 'op.interrupted',
};

/** How long it took, as people say it: "40 s", "3 min", "2 h 5 min", "3 days". */
export function spanWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${Math.max(s, 1)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.round(h / 24)} days`;
}

/** What a finished operation leaves for the caller that asked (the old synchronous answers), never a secret. */
function operationResult(op: Operation): Record<string, unknown> | undefined {
  const p = op.params ?? {};
  if (op.kind === 'restore-snapshot') {
    return { restored: Array.isArray(p.restored) ? p.restored : [], ...(typeof p.safetySnapshotId === 'string' ? { safetySnapshotId: p.safetySnapshotId } : {}) };
  }
  if (op.kind === 'migrate') {
    return { movedTo: str(p.peerName), ...(typeof p.remoteAgentId === 'string' ? { remoteAgentId: p.remoteAgentId } : {}) };
  }
  if (op.kind === 'move-host') return { movedTo: str(p.toName), hostId: typeof p.to === 'string' ? p.to : undefined };
  return undefined;
}

// ---- running one in the background (phase 3) ---------------------------------

/** Called when an operation's row changes (a step, an outcome): runInBackground's waits. */
const watchers = new Map<string, Set<() => void>>();
function notify(id: string): void {
  for (const fn of [...(watchers.get(id) ?? [])]) fn();
}
function watch(id: string, fn: () => void): () => void {
  let set = watchers.get(id);
  if (!set) watchers.set(id, (set = new Set()));
  set.add(fn);
  return () => { set!.delete(fn); if (!set!.size) watchers.delete(id); };
}

export type Background<T> =
  /** The operation began (and reached `readyAt`): the request answers 202 now; the work goes on. */
  | { started: true; opId: string; done: Promise<T | undefined> }
  /** The work ended before that: a quick end, with the old answer. */
  | { started: false; value: T };

/**
 * Run a long change so its request can answer as soon as the operation has
 * begun: `run` is the orchestrator call, given the `onOperation` hook it
 * reports its row's id through. Resolves `started` once the row exists — and,
 * with `readyAt`, once it has reached that step (a move to another Hatchabot
 * waits for the other server's preflight, so its refusal is still the
 * request's answer) or is over. A refusal thrown before that rejects, so the
 * route answers it synchronously, as before.
 *
 * After `started`, the work goes on in this process. What it throws is the
 * operation's outcome (the orchestrators record it); one that escapes without
 * an outcome — a bug — is recorded as failed here, so the row never stays
 * "running" in a process that is no longer running it. A simulated death
 * (tests) records nothing, as a dead process would not.
 */
export function runInBackground<T>(
  store: Store,
  run: (onOperation: (id: string) => void) => Promise<T>,
  opts: { readyAt?: string; onError?: (err: unknown, opId: string) => void } = {},
): Promise<Background<T>> {
  return new Promise((resolve, reject) => {
    let opId: string | undefined;
    let answered = false;
    let unwatch: (() => void) | undefined;
    let settle!: (v: T | undefined) => void;
    const done = new Promise<T | undefined>((r) => { settle = r; });
    // Ready: begun, and at `readyAt` or past it (or held there). An operation
    // that ENDED before `readyAt` is a refusal: its rejection is the answer.
    const ready = (): boolean => {
      if (!opId) return false;
      if (!opts.readyAt) return true;
      const row = store.getOperation(opId);
      return !!row && (row.status === 'held' || (ACTIVE.includes(row.status) && stepReached(row.kind, row.step, opts.readyAt)));
    };
    const answerStarted = () => {
      if (answered || !opId) return;
      answered = true;
      unwatch?.();
      resolve({ started: true, opId, done });
    };
    const onOperation = (id: string) => {
      opId = id;
      if (ready()) answerStarted();
      else unwatch = watch(id, () => { if (ready()) answerStarted(); });
    };
    const work = run(onOperation);
    work.then(
      (value) => {
        settle(value);
        if (answered) return;
        answered = true;
        unwatch?.();
        resolve({ started: false, value });
      },
      (err) => {
        settle(undefined);
        if (!answered) {
          answered = true;
          unwatch?.();
          reject(err);
          return;
        }
        if (err instanceof SimulatedCrash) return;
        const row = opId ? store.getOperation(opId) : undefined;
        if (row && (row.status === 'running' || row.status === 'queued') && row.bootId === currentBootId()) handleFor(store, row.id).fail(err);
        opts.onError?.(err, opId!);
      },
    );
  });
}

/** The agent's operation that is not over, if any. */
export function activeOperation(store: Store, agentId: string): Operation | undefined {
  return store.activeOperationFor(agentId);
}

/**
 * Why a lifecycle action must wait: the agent's operation that is not over, in
 * the owner's words. Undefined when there is none.
 */
export function operationRefusal(store: Store, agentId: string): string | undefined {
  const op = store.activeOperationFor(agentId);
  if (!op) return undefined;
  if (op.status === 'held') {
    return `${op.outcome ?? `${KIND_LABEL[op.kind] ?? op.kind} was interrupted.`} Choose what to do on its page first (Alerts).`;
  }
  const what = KIND_LABEL[op.kind] ?? op.kind;
  if (op.status === 'interrupted' || (op.status === 'running' && op.bootId !== currentBootId())) {
    return `${what} was interrupted by a restart and is being put right — try again in a minute.`;
  }
  const info = stepInfo(op.kind, op.step);
  return `${what} is under way${info ? ` (step ${info.n} of ${info.of}: ${info.label})` : ''} — wait for it to finish.`;
}

/** The part of an operation the page and the CLI show. */
export function publicOperation(op: Operation | undefined, opts: { recovery?: boolean } = {}): Record<string, unknown> | undefined {
  if (!op) return undefined;
  const info = stepInfo(op.kind, op.step);
  const status = op.status === 'running' && op.bootId !== currentBootId() ? 'interrupted' : op.status;
  const titles = operationTitles(op.kind, op.params);
  const result = !ACTIVE.includes(op.status) ? operationResult(op) : undefined;
  return {
    id: op.id,
    agentId: op.agentId,
    kind: op.kind,
    kindLabel: KIND_LABEL[op.kind] ?? op.kind,
    /** "Moving to Laptop runner" — the Working on line, the CLI's progress. */
    title: titles.doing,
    /** "Moved to Laptop runner", "Move to Laptop runner failed" — the Activity row. */
    summary: operationSummary(op.kind, status, op.params),
    status,
    step: op.step,
    stepLabel: info?.label,
    stepN: info?.n,
    steps: info?.of ?? STEPS[op.kind as OpKind]?.length,
    outcome: op.outcome,
    requestedAt: op.requestedAt,
    updatedAt: op.updatedAt,
    finishedAt: op.finishedAt,
    ...(result ? { result } : {}),
    ...(opts.recovery === false ? {} : { recovery: op.recovery ?? undefined }),
  };
}

/**
 * At boot, before anything else reads them: every `running` row from another
 * process was cut off. They become `interrupted` (still busy on disk) for
 * resumeOperations() to settle.
 */
export function markInterrupted(store: Store): Operation[] {
  const out: Operation[] = [];
  for (const op of store.operationsWithStatus(['running'])) {
    if (op.bootId === currentBootId()) continue;
    const row = store.updateOperation(op.id, { status: 'interrupted' })!;
    event(store, row, 'op.interrupted', { step: op.step });
    out.push(row);
  }
  return out;
}
