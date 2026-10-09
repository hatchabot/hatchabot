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
  | 'install-image';

export type OpStatus = OperationRow['status'];
export type Operation = OperationRow;

/** What to do when a restart cut the operation off right after this step. */
export type AfterStep = 'nothing' | 'undo' | 'finish' | 'ask';

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
};

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
  journal(name, { agentId: op.agentId, ...d });
  if (!op.agentId) return;
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
    // Held again with the same words (the 10-minute question to another
    // server): one line in the timeline, not one every ten minutes.
    if (was?.status === status && was.outcome === op.outcome) return;
    event(store, op, name, { outcome: op.outcome, ...(recovery ? { recovery: recovery.actions.map((a) => a.action) } : {}) });
  };
  return {
    id,
    step(key, detail) {
      const op = get();
      if (stepHook) stepHook(op, key);
      const info = stepInfo(op.kind, key);
      const params = detail ? { ...op.params, ...detail } : op.params;
      store.updateOperation(id, { step: key, stepAt: new Date().toISOString(), ...(detail ? { params } : {}) });
      event(store, op, 'op.step', { step: key, label: info?.label ?? key, ...(info ? { n: info.n, of: info.of } : {}) });
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
  opts: { hostId?: string; requestedBy?: string } = {},
): OpHandle {
  const now = new Date().toISOString();
  const id = `op_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  store.insertOperation({
    id, agentId, hostId: opts.hostId ?? null, kind, requestedBy: opts.requestedBy ?? null,
    requestedAt: now, params, step: null, stepAt: null, status: 'running', outcome: null,
    recovery: null, bootId: currentBootId(), updatedAt: now, finishedAt: null,
  });
  const op = store.getOperation(id)!;
  event(store, op, 'op.started', { label: KIND_LABEL[kind] ?? kind });
  return handleFor(store, id);
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
  return {
    id: op.id,
    agentId: op.agentId,
    kind: op.kind,
    kindLabel: KIND_LABEL[op.kind] ?? op.kind,
    status: op.status === 'running' && op.bootId !== currentBootId() ? 'interrupted' : op.status,
    step: op.step,
    stepLabel: info?.label,
    stepN: info?.n,
    steps: info?.of ?? STEPS[op.kind as OpKind]?.length,
    outcome: op.outcome,
    requestedAt: op.requestedAt,
    updatedAt: op.updatedAt,
    finishedAt: op.finishedAt,
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
