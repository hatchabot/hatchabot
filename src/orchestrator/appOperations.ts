/**
 * App installs, updates and roll-backs as durable operations
 * (docs/operations-and-one-interface-design.md, the app row of "After a
 * restart"). The routes record each one (beginOperation, kind app-install /
 * app-update / app-rollback, params below) and installRelease / switchTo
 * report their steps. A restart before the switch changed nothing live; at or
 * after it, the volume's `current` link (and the config) is compared with the
 * `agent_apps` record: the same → done; different → held with
 * [Use the new release] [Go back to the previous one]. The staging folder is
 * cleared whenever the operation settles (a held one keeps it: the config it
 * replaced is kept there until the owner chooses).
 */
import type { AgentApp, Store } from '../store/store.js';
import {
  appJobs, appPaths, clearStaging, currentSha, pointBack, releaseManifest, removeTasks, sq, stagingDir, syncTasks,
  type AppManifest, type InstallDeps,
} from './apps.js';
import { handleFor, stepReached, type OpHandle, type Recovery } from './operations.js';

/** What an app operation records (never the config values: some are secrets). */
export interface AppOpParams {
  app: string;
  /** The release it is switching to. */
  toSha: string;
  /** The release `current` pointed at before (undefined: none). */
  fromSha?: string | null;
  /** The app the record held before, when another one is being replaced. */
  fromApp?: string | null;
  source?: string;
  ref?: string;
}

export interface AppOpDeps {
  store: Store;
  install: InstallDeps;
}

export class AppRecoverError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'AppRecoverError';
  }
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : undefined);

/** How the config switch stands for a release: still staged, moved in (the old one kept aside), or nothing staged. */
async function configState(d: InstallDeps, app: string, toShort: string, m: AppManifest | undefined): Promise<'none' | 'staged' | 'moved'> {
  if (!m?.config) return 'none';
  const name = m.config.file ?? 'config.json';
  const staged = `${stagingDir(app, toShort)}/${name}`;
  const r = await d.provider.execShell(d.runtimeRef,
    `if [ -e ${sq(staged)} ]; then echo staged; elif [ -e ${sq(`${staged}.prev`)} ] || [ -e ${sq(`${staged}.none`)} ]; then echo moved; else echo none; fi`, { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`could not read the agent's app folder: ${(r.stderr || r.stdout).slice(-200)}`);
  const v = r.stdout.trim();
  return v === 'staged' || v === 'moved' ? v : 'none';
}

function choices(kind: string, p: AppOpParams): Recovery {
  const to = short(p.toSha);
  const from = short(p.fromSha);
  return kind === 'app-rollback'
    ? { actions: [{ action: 'use-new', label: `Use the release it went back to (${to})` }, { action: 'go-back', label: `Stay on ${from ?? 'the one it had'}` }], recommended: 'use-new' }
    : { actions: [{ action: 'use-new', label: 'Use the new release' }, { action: 'go-back', label: 'Go back to the previous one' }], recommended: 'go-back' };
}

/** The one choice when a replaced app's tasks could not be put back after a restart. */
const TASKS_BACK: Recovery = { actions: [{ action: 'put-tasks-back', label: 'Put its scheduled tasks back' }], recommended: 'put-tasks-back' };

/**
 * Put an app's scheduled tasks back on and check they are there, from a fresh
 * list (as syncTasks' own put-back does): undefined when every task is
 * listed, otherwise what is missing (issue #22, 2026-10-09).
 */
async function putTasksBack(d: InstallDeps, m: AppManifest): Promise<string | undefined> {
  let failed: string | undefined;
  try { await syncTasks(d, m); } catch (err) { failed = String((err as Error)?.message ?? err).slice(0, 200); }
  let listed: Set<string>;
  try { listed = new Set((await appJobs(d, m.app)).map((j) => j.name)); }
  catch (err) { return `the agent's task list could not be read (${String((err as Error)?.message ?? err).slice(0, 200)})`; }
  const missing = m.tasks.map((t) => `${m.app}-${t.name}`).filter((n) => !listed.has(n));
  if (!missing.length) return undefined;
  return `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on the agent${failed ? ` (${failed})` : ''}`;
}

/** "Put its scheduled tasks back": rolled back only once the record's app's tasks are confirmed on again. */
async function tasksBackAgain(deps: AppOpDeps, op: OpHandle, p: AppOpParams): Promise<void> {
  const d = deps.install;
  const rec = deps.store.getAgentApp(op.get().agentId!);
  if (rec && rec.app === p.fromApp && rec.app !== p.app) {
    const missing = await putTasksBack(d, rec.manifest as AppManifest);
    if (missing) throw new AppRecoverError(`${rec.app}'s scheduled tasks could not be put back: ${missing}. It is still waiting; try again in a moment.`);
  }
  await clearStaging(d, p.app, short(p.toSha)!);
  op.rolledBack(`${rec ? `${rec.app}'s scheduled tasks are back on, so` : 'So'} the agent is as it was before the ${p.app} install. Try it again when you are ready.`);
}

/**
 * After a restart (operationsResume.ts). Before the switch nothing live
 * changed (an install that replaced another app had already taken that app's
 * tasks off: they go back on). From the switch on, the volume and the record
 * decide.
 */
export async function resumeAppOperation(deps: AppOpDeps, opId: string): Promise<void> {
  const op = handleFor(deps.store, opId);
  const row = op.get();
  const p = row.params as unknown as AppOpParams;
  const d = deps.install;
  const rec = deps.store.getAgentApp(row.agentId!);
  const to = short(p.toSha)!;
  // An install that replaced another app took its tasks off first: on again, so the agent matches its record.
  // Confirmed, or held: "nothing changed" was said over tasks that never went back (issue #22, 2026-10-09).
  const replacedBack = async (): Promise<boolean> => {
    if (!(p.fromApp && p.fromApp !== p.app && rec?.app === p.fromApp)) return true;
    const missing = await putTasksBack(d, rec.manifest as AppManifest);
    if (!missing) return true;
    op.hold(
      `The ${p.app} install was interrupted by a restart before it switched anything on, but ${rec.app}'s scheduled tasks, ` +
        `taken off for it, could not be put back: ${missing}. ${rec.app} itself is as it was.`,
      TASKS_BACK,
    );
    return false;
  };
  if (!stepReached(row.kind, row.step, 'switching')) {
    if (!(await replacedBack())) return;
    await clearStaging(d, p.app, to);
    op.rolledBack(`The ${p.app} ${row.kind === 'app-update' ? 'update' : 'install'} was interrupted by a restart before it switched anything on — nothing changed. Try it again.`);
    return;
  }
  const cur = await currentSha(d, p.app);
  const recShort = rec?.app === p.app ? short(rec.sha) : undefined;
  const newManifest = row.kind === 'app-rollback' ? undefined : await releaseManifest(d, `${appPaths(p.app).releases}/${to}`);
  const cfg = row.kind === 'app-rollback' ? 'none' : await configState(d, p.app, to, newManifest);
  if (recShort === to && cur === to) {
    await clearStaging(d, p.app, to);
    op.done(`${p.app} is on ${to}.`);
    return;
  }
  // The switch never landed: the link, the config and the record all as before.
  if (cur === short(p.fromSha ?? undefined) && recShort === cur && cfg !== 'moved') {
    if (!(await replacedBack())) return;
    await clearStaging(d, p.app, to);
    op.rolledBack(`The ${p.app} change was interrupted by a restart before it switched — nothing changed. Try it again.`);
    return;
  }
  op.hold(
    `The ${p.app} change to ${to} was interrupted by a restart part-way through the switch: the agent runs ${cur ?? 'no release'} while Hatchabot's record says ${recShort ?? 'none'}.`,
    choices(row.kind, p),
  );
}

/** The owner's choice on a held app operation. */
export async function recoverAppOperation(deps: AppOpDeps, opId: string, action: string): Promise<void> {
  const op = handleFor(deps.store, opId);
  const row = op.get();
  const p = row.params as unknown as AppOpParams;
  try {
    if (action === 'put-tasks-back') await tasksBackAgain(deps, op, p);
    else if (action === 'use-new') await useNew(deps, op, row.kind, p);
    else await goBack(deps, op, row.kind, p);
  } catch (err) {
    if (err instanceof AppRecoverError) throw err;
    throw new AppRecoverError(`That did not finish: ${String((err as Error)?.message ?? err).slice(0, 300)}. It is still waiting for your choice.`);
  }
}

async function useNew(deps: AppOpDeps, op: OpHandle, kind: string, p: AppOpParams): Promise<void> {
  const d = deps.install;
  const ap = appPaths(p.app);
  const to = short(p.toSha)!;
  const rec = deps.store.getAgentApp(op.get().agentId!);
  const m = await releaseManifest(d, `${ap.releases}/${to}`);
  if (!m) throw new AppRecoverError(`Release ${to} is no longer in the agent; go back to the previous one instead.`);
  if (kind !== 'app-rollback' && (await configState(d, p.app, to, m)) === 'staged') {
    const name = m.config!.file ?? 'config.json';
    const live = `${ap.data}/${name}`;
    const staged = `${stagingDir(p.app, to)}/${name}`;
    const r = await d.provider.execShell(d.runtimeRef,
      `{ if [ -f ${sq(live)} ]; then cp -p ${sq(live)} ${sq(`${staged}.prev`)}; else : > ${sq(`${staged}.none`)}; fi; } && mv -f ${sq(staged)} ${sq(live)}`, { timeoutMs: 60_000 });
    if (r.code !== 0) throw new AppRecoverError(`Its new configuration could not be put in place: ${(r.stderr || r.stdout).slice(-200)}`);
  }
  const ln = await d.provider.execShell(d.runtimeRef, `cd ${sq(ap.root)} && test -d releases/${to} && ln -sfn releases/${to} current.new && mv -T current.new current`, { timeoutMs: 60_000 });
  if (ln.code !== 0) throw new AppRecoverError(`Release ${to} could not be switched on: ${(ln.stderr || ln.stdout).slice(-200)}`);
  const before = rec?.app === p.app ? (rec.manifest as AppManifest) : undefined;
  await syncTasks(d, m, before);
  op.step('tasks');
  const now = new Date().toISOString();
  const next: AgentApp = kind === 'app-rollback' && rec
    ? { ...rec, sha: p.toSha, manifest: m, previousSha: rec.sha, previousManifest: rec.manifest, installedAt: now, testOk: undefined }
    : {
        agentId: op.get().agentId!, app: p.app, source: p.source ?? rec?.source ?? '', ref: p.ref ?? rec?.ref ?? 'HEAD',
        sha: p.toSha, manifest: m,
        previousSha: rec?.app === p.app ? rec.sha : undefined, previousManifest: rec?.app === p.app ? rec.manifest : undefined,
        installedAt: now, testOk: true,
      };
  deps.store.setAgentApp(next);
  await clearStaging(d, p.app, to);
  op.done(`${p.app} is on ${to}.`);
}

async function goBack(deps: AppOpDeps, op: OpHandle, kind: string, p: AppOpParams): Promise<void> {
  const d = deps.install;
  const ap = appPaths(p.app);
  const to = short(p.toSha)!;
  const from = short(p.fromSha);
  const rec = deps.store.getAgentApp(op.get().agentId!);
  if (kind !== 'app-rollback') {
    const m = await releaseManifest(d, `${ap.releases}/${to}`);
    if ((await configState(d, p.app, to, m)) === 'moved') {
      const name = m!.config!.file ?? 'config.json';
      const live = `${ap.data}/${name}`;
      const staged = `${stagingDir(p.app, to)}/${name}`;
      const r = await d.provider.execShell(d.runtimeRef,
        `if [ -f ${sq(`${staged}.prev`)} ]; then mv -f ${sq(`${staged}.prev`)} ${sq(live)}; elif [ -f ${sq(`${staged}.none`)} ]; then rm -f ${sq(live)}; fi`, { timeoutMs: 60_000 });
      if (r.code !== 0) throw new AppRecoverError(`Its previous configuration could not be put back: ${(r.stderr || r.stdout).slice(-200)}`);
    }
  }
  const back = await d.provider.execShell(d.runtimeRef, pointBack(ap, from ? `releases/${from}` : ''), { timeoutMs: 60_000 });
  if (back.code !== 0) throw new AppRecoverError(`The previous release could not be switched back on: ${(back.stderr || back.stdout).slice(-200)}`);
  // Its tasks: the record's app, as the record says; the new release's taken off when it is another app (or none).
  if (rec?.app === p.app) {
    const leaving = kind === 'app-rollback' ? undefined : await releaseManifest(d, `${ap.releases}/${to}`);
    await syncTasks(d, rec.manifest as AppManifest, leaving);
  } else {
    await removeTasks(d, p.app);
    if (rec) await syncTasks(d, rec.manifest as AppManifest);
  }
  await clearStaging(d, p.app, to);
  op.rolledBack(`${rec ? `Back on ${rec.app} ${short(rec.sha)}` : `${p.app} switched off again`}, as Hatchabot's record says.`);
}
