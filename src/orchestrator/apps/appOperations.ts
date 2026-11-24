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
import type { AgentApp, Store } from '../../store/store.js';
import {
  appJobs, appPaths, appTaskNames, clearStaging, currentSha, MANIFEST_FILE, pointBack, releaseManifest, removeTasks, sq, stagingDir, syncTasks, taskTransitionPending,
  type AppManifest, type InstallDeps,
} from './apps.js';
import { handleFor, stepReached, type OpHandle, type Recovery } from '../lifecycle/operations.js';

/** What an app operation records (never the config values: some are secrets). */
export interface AppOpParams {
  app: string;
  /** The release it is switching to. */
  toSha: string;
  /** The release `current` pointed at before (undefined: none). */
  fromSha?: string | null;
  /** The app the record held before, when another one is being replaced. */
  fromApp?: string | null;
  /** That app's tasks the owner had turned off (its jobs come off for the new app; they go back on turned off). */
  fromAppOff?: string[];
  /** Where the app's `current` pointed as the switch began (a release's short sha, null: none); recorded with the step 'switching'. */
  toWas?: string | null;
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
async function configState(d: InstallDeps, app: string, toShort: string, m: AppManifest | undefined): Promise<'none' | 'staged' | 'moved' | 'restoring'> {
  if (!m?.config) return 'none';
  const name = m.config.file ?? 'config.json';
  const staged = `${stagingDir(app, toShort)}/${name}`;
  const r = await d.provider.execShell(d.runtimeRef,
    `if [ -e ${sq(staged)} ]; then if [ -e ${sq(`${staged}.prev`)} ] || [ -e ${sq(`${staged}.none`)} ]; then echo restoring; else echo staged; fi; elif [ -e ${sq(`${staged}.prev`)} ] || [ -e ${sq(`${staged}.none`)} ]; then echo moved; else echo none; fi`, { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`could not read the agent's app folder: ${(r.stderr || r.stdout).slice(-200)}`);
  const v = r.stdout.trim();
  return v === 'staged' || v === 'moved' || v === 'restoring' ? v : 'none';
}

/** The two ways out of an app change left part way (a restart, or a put-back that failed: routes.ts). */
export function appChoices(kind: string, p: AppOpParams): Recovery {
  const to = short(p.toSha);
  const from = short(p.fromSha);
  return kind === 'app-rollback'
    ? { actions: [{ action: 'use-new', label: `Use the release it went back to (${to})` }, { action: 'go-back', label: `Stay on ${from ?? 'the one it had'}` }], recommended: 'use-new' }
    : { actions: [{ action: 'use-new', label: 'Use the new release' }, { action: 'go-back', label: 'Go back to the previous one' }], recommended: 'go-back' };
}

/** The one choice when a replaced app's tasks could not be put back (after a restart, or a replacement that failed: agentApps.ts). */
export const TASKS_BACK: Recovery = { actions: [{ action: 'put-tasks-back', label: 'Put its scheduled tasks back' }], recommended: 'put-tasks-back' };

/**
 * Put an app's scheduled tasks back on and check they are there, from a fresh
 * list (as syncTasks' own put-back does): undefined when every task is
 * listed, otherwise what is missing (issue #22, 2026-10-09). `off`: those the
 * owner had turned off, put back turned off and checked so (HB-0253).
 */
export async function putTasksBack(d: InstallDeps, m: AppManifest, off: readonly string[] = []): Promise<string | undefined> {
  // Still all there, each once and as the owner left it (a removal that took
  // none off): nothing to put back. Synced anyway, a scheduler refusing every
  // removal left each task twice (HB-1080).
  if (await tasksAsLeft(d, m, off).catch(() => false)) return undefined;
  let failed: string | undefined;
  try { await syncTasks(d, m, undefined, off); } catch (err) { failed = String((err as Error)?.message ?? err).slice(0, 200); }
  try {
    if (await taskTransitionPending(d, m.app)) return `an interrupted scheduled-task change still needs recovery${failed ? ` (${failed})` : ''}`;
  } catch (err) { return `its scheduled-task transition could not be read (${String((err as Error)?.message ?? err).slice(0, 200)})`; }
  let jobs: Awaited<ReturnType<typeof appJobs>>;
  try { jobs = await appJobs(d, appTaskNames(m)); }
  catch (err) { return `the agent's task list could not be read (${String((err as Error)?.message ?? err).slice(0, 200)})`; }
  const listed = new Set(jobs.map((j) => j.name));
  const missing = m.tasks.map((t) => `${m.app}-${t.name}`).filter((n) => !listed.has(n));
  const on = off.filter((n) => listed.has(n) && jobs.some((j) => j.name === n && j.enabled !== false));
  if (!missing.length && !on.length) return undefined;
  return [
    ...(missing.length ? [`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on the agent`] : []),
    ...(on.length ? [`${on.join(', ')} ${on.length === 1 ? 'is' : 'are'} switched on, though you had turned ${on.length === 1 ? 'it' : 'them'} off`] : []),
  ].join('; ') + (failed ? ` (${failed})` : '');
}

/** Each of the app's tasks listed once, turned off only where the owner had (`off`), and no task change left part way. */
async function tasksAsLeft(d: InstallDeps, m: AppManifest, off: readonly string[]): Promise<boolean> {
  if (await taskTransitionPending(d, m.app)) return false;
  const jobs = await appJobs(d, appTaskNames(m));
  const want = m.tasks.map((t) => `${m.app}-${t.name}`);
  return jobs.length === want.length && want.every((n) => jobs.filter((j) => j.name === n).length === 1)
    && jobs.every((j) => (j.enabled === false) === off.includes(j.name));
}

/**
 * Are the app's listed tasks exactly the manifest's, each once? `others`: the
 * app's other manifests (the release it was going to, the one before), whose
 * tasks a sync cut off part way may have left on.
 */
async function tasksAre(d: InstallDeps, m: AppManifest, ...others: Array<AppManifest | undefined>): Promise<boolean> {
  if (await taskTransitionPending(d, m.app)) return false;
  const have = (await appJobs(d, appTaskNames(m, ...others))).map((j) => j.name).sort();
  const want = m.tasks.map((t) => `${m.app}-${t.name}`).sort();
  return have.length === want.length && have.every((n, i) => n === want[i]);
}

/**
 * "Put its scheduled tasks back": rolled back only once the record's app's
 * tasks are confirmed on again, and never with the new release switched on
 * by this operation: that is not "as it was", and it is held again with the
 * two choices (going back puts those tasks back too). Switched on by it: it
 * reached its switch, and `current` is at the new release where it was not
 * before (`toWas`; a replaced app's own link stays on the volume, so the link
 * alone said "switched on" for a reinstall whose tests failed).
 *
 * Nor with any of the new app's scheduled tasks on the agent, or its task
 * change left part way: a switch-back after its tasks went on (a later step
 * cut off) left them running, and this recorded the agent as it was. Held
 * again with the two choices (going back takes them off); a check that cannot
 * be read changes nothing and is tried again.
 */
async function tasksBackAgain(deps: AppOpDeps, op: OpHandle, p: AppOpParams): Promise<void> {
  const d = deps.install;
  const to = short(p.toSha)!;
  const row = op.get();
  const now = stepReached(row.kind, row.step, 'switching') ? await currentSha(d, p.app) : undefined;
  if (now === to && (p.toWas === undefined || p.toWas !== now)) {
    op.hold(`${p.app} ${to} is switched on in the agent, so it is not as it was before: use the new release, or go back to the previous one (its scheduled tasks go back on with it).`,
      appChoices(op.get().kind, p));
    return;
  }
  // What of the new app may be left: its tasks on, its task change left part
  // way, or (its manifest gone or unreadable once it switched: they go on only
  // after the switch) tasks that cannot be named. Each is held with the two
  // choices: going back takes them off from the task journal and the task
  // ids recorded, without the manifest. Only a read that failed just then
  // (the agent out of reach) is "try again".
  let left: 'tasks' | 'change' | 'unnamed' | undefined;
  try {
    const m = await releaseManifest(d, `${appPaths(p.app).releases}/${to}`);
    if (m && (await appJobs(d, appTaskNames(m))).length) left = 'tasks';
    else if (await taskTransitionPending(d, p.app)) left = 'change';
    else if (!m && stepReached(row.kind, row.step, 'switched')) left = 'unnamed';
  } catch (err) {
    throw new AppRecoverError(`Whether ${p.app}'s own scheduled tasks are off could not be checked (${String((err as Error)?.message ?? err).slice(0, 200)}). It is still waiting; try again in a moment.`);
  }
  if (left) {
    const what = left === 'tasks' ? `${p.app}'s scheduled tasks are on the agent`
      : left === 'change' ? `A change of ${p.app}'s scheduled tasks was left part way`
      : `The ${MANIFEST_FILE} of ${p.app} ${to} cannot be read, so whether its scheduled tasks are off cannot be told`;
    op.hold(`${what}, so it is not as it was before: use the new release, or go back to the previous one (which takes ${p.app}'s tasks off${p.fromApp ? ` and puts ${p.fromApp}'s back on` : ''}).`,
      appChoices(op.get().kind, p));
    return;
  }
  const rec = deps.store.getAgentApp(op.get().agentId!);
  if (rec && rec.app === p.fromApp && rec.app !== p.app) {
    const missing = await putTasksBack(d, rec.manifest as AppManifest, p.fromAppOff);
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
    const missing = await putTasksBack(d, rec.manifest as AppManifest, p.fromAppOff);
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
  // The record's app has exactly its record's tasks (a sync cut off part way leaves two of one, or none).
  const tasksOk = recShort ? await tasksAre(d, rec!.manifest as AppManifest, newManifest, rec!.previousManifest as AppManifest | undefined) : true;
  // The record and the link name the new release, nothing is left staged (a
  // finished install clears its staging folder before the record is written)
  // and the tasks are the record's. An update of values on the commit already
  // running (#120) has the record and the link at that commit throughout, so
  // they alone said "done" over a config still staged, or moved in with its
  // tasks never re-synced: the staging and the tasks decide too.
  if (recShort === to && cur === to && cfg === 'none' && tasksOk) {
    await clearStaging(d, p.app, to);
    op.done(`${p.app} is on ${to}.`);
    return;
  }
  // The switch never landed: the link, the config and the record all as before.
  if (cur === short(p.fromSha ?? undefined) && recShort === cur && cfg !== 'moved' && cfg !== 'restoring' && tasksOk) {
    if (!(await replacedBack())) return;
    await clearStaging(d, p.app, to);
    op.rolledBack(`The ${p.app} change was interrupted by a restart before it switched — nothing changed. Try it again.`);
    return;
  }
  op.hold(
    `The ${p.app} change to ${to} was interrupted by a restart part-way through the switch: the agent runs ${cur ?? 'no release'} while Hatchabot's record says ${recShort ?? 'none'}.`,
    appChoices(row.kind, p),
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
  // Another App in its place: its tasks come off first, as an ordinary
  // replacement takes them off (never two Apps on one mailbox). A replacement
  // held with them put back left them running beside this one's, with no
  // record of them (HB-1193). One that fails leaves it waiting; going back
  // puts them back on.
  const replaced = rec && rec.app !== p.app ? rec : undefined;
  if (replaced) await removeTasks(d, replaced.app, replaced.manifest as AppManifest);
  if (kind !== 'app-rollback' && ['staged', 'restoring'].includes(await configState(d, p.app, to, m))) {
    const name = m.config!.file ?? 'config.json';
    const live = `${ap.data}/${name}`;
    const staged = `${stagingDir(p.app, to)}/${name}`;
    const r = await d.provider.execShell(d.runtimeRef,
      `{ if [ ! -e ${sq(`${staged}.prev`)} ] && [ ! -e ${sq(`${staged}.none`)} ]; then if [ -f ${sq(live)} ]; then cp -p ${sq(live)} ${sq(`${staged}.prev`)}; else : > ${sq(`${staged}.none`)}; fi; fi; } && mv -f ${sq(staged)} ${sq(live)}`, { timeoutMs: 60_000 });
    if (r.code !== 0) throw new AppRecoverError(`Its new configuration could not be put in place: ${(r.stderr || r.stdout).slice(-200)}`);
  }
  const ln = await d.provider.execShell(d.runtimeRef, `cd ${sq(ap.root)} && test -d releases/${to} && ln -sfn releases/${to} current.new && mv -T current.new current`, { timeoutMs: 60_000 });
  if (ln.code !== 0) throw new AppRecoverError(`Release ${to} could not be switched on: ${(ln.stderr || ln.stdout).slice(-200)}`);
  const before = rec?.app === p.app ? (rec.manifest as AppManifest) : undefined;
  await syncTasks(d, m, before);
  op.step('tasks');
  const now = new Date().toISOString();
  // A change of values on the commit it had: what it would roll back to stays the one before.
  const same = rec?.app === p.app && rec.sha === p.toSha;
  const next: AgentApp = kind === 'app-rollback' && rec
    ? { ...rec, sha: p.toSha, manifest: m, previousSha: rec.sha, previousManifest: rec.manifest, installedAt: now, testOk: undefined }
    : {
        agentId: op.get().agentId!, app: p.app, source: p.source ?? rec?.source ?? '', ref: p.ref ?? rec?.ref ?? 'HEAD',
        sha: p.toSha, manifest: m,
        previousSha: same ? rec!.previousSha : rec?.app === p.app ? rec.sha : undefined,
        previousManifest: same ? rec!.previousManifest : rec?.app === p.app ? rec.manifest : undefined,
        installedAt: now, testOk: true,
      };
  deps.store.setAgentApp(next);
  await clearStaging(d, p.app, to);
  op.done(`${p.app} is on ${to}${replaced ? `, and ${replaced.app}'s scheduled tasks are off` : ''}.`);
}

async function goBack(deps: AppOpDeps, op: OpHandle, kind: string, p: AppOpParams): Promise<void> {
  const d = deps.install;
  const ap = appPaths(p.app);
  const to = short(p.toSha)!;
  const from = short(p.fromSha);
  const rec = deps.store.getAgentApp(op.get().agentId!);
  if (kind !== 'app-rollback') {
    const m = await releaseManifest(d, `${ap.releases}/${to}`);
    if (['moved', 'restoring'].includes(await configState(d, p.app, to, m))) {
      const name = m!.config!.file ?? 'config.json';
      const live = `${ap.data}/${name}`;
      const staged = `${stagingDir(p.app, to)}/${name}`;
      const r = await d.provider.execShell(d.runtimeRef,
        `{ if [ ! -e ${sq(staged)} ]; then cp -p ${sq(live)} ${sq(staged)}; fi; } && { if [ -f ${sq(`${staged}.prev`)} ]; then cp -p ${sq(`${staged}.prev`)} ${sq(live)}; elif [ -f ${sq(`${staged}.none`)} ]; then rm -f ${sq(live)}; fi; }`, { timeoutMs: 60_000 });
      if (r.code !== 0) throw new AppRecoverError(`Its previous configuration could not be put back: ${(r.stderr || r.stdout).slice(-200)}`);
    }
  }
  const back = await d.provider.execShell(d.runtimeRef, pointBack(ap, from ? `releases/${from}` : ''), { timeoutMs: 60_000 });
  if (back.code !== 0) throw new AppRecoverError(`The previous release could not be switched back on: ${(back.stderr || back.stdout).slice(-200)}`);
  // Its tasks: the record's app, as the record says; the new release's taken off when it is another app (or none).
  if (rec?.app === p.app) {
    // A rollback held part-way leaves the release it rolled back to: its tasks
    // (renamed ones too) come off, or they run on beside the record's (regression audit, 2026-10-22).
    const leaving = await releaseManifest(d, `${ap.releases}/${to}`)
      ?? (kind === 'app-rollback' && short(rec.previousSha) === to ? rec.previousManifest as AppManifest | undefined : undefined);
    await syncTasks(d, rec.manifest as AppManifest, leaving);
  } else {
    await removeTasks(d, p.app, await releaseManifest(d, `${ap.releases}/${to}`));
    if (rec) await syncTasks(d, rec.manifest as AppManifest, undefined, rec.app === p.fromApp ? p.fromAppOff : undefined);
  }
  await clearStaging(d, p.app, to);
  op.rolledBack(`${rec ? `Back on ${rec.app} ${short(rec.sha)}` : `${p.app} switched off again`}, as Hatchabot's record says.`);
}
