import { existsSync } from 'node:fs';
import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { AgentApp, Store } from '../../store/store.js';
import { appChoices, putTasksBack, TASKS_BACK, type AppOpParams } from './appOperations.js';
import { dropAppPending, onePendingChange, pendingSecretRefs, resolvePendingValues, stashPendingSecrets } from './appPending.js';
import {
  appChat,
  AppError,
  appJobs,
  appPaths,
  appTaskNames,
  checkCodeSize,
  fieldsToAsk,
  installRelease,
  manifestAt,
  mergeConfig,
  mirrorDir,
  outcome,
  parseSource,
  releaseTar,
  removeTasks,
  repoFor,
  resolveRelease,
  sq,
  staleFilledFields,
  switchTo,
  type AgentFacts,
  type AppManifest,
  type Git,
  type InstallDeps,
  type Installed,
} from './apps.js';
import { isBusy, whileBusy } from '../lifecycle/busy.js';
import { beginOperation, rethrowIfCrash, type OpHandle } from '../lifecycle/operations.js';
import { slugify } from '../lifecycle/provision.js';
import { agentTimeZone } from '../schedules/timezone.js';
import { keyedLock } from '../../util/queues.js';

/**
 * The apps installed in agents (HB-0808; docs/apps-in-agents.md): a codebase
 * with a hatchabot.json, installed into an agent as a release with its config,
 * tests and scheduled commands, updated, rolled back and stopped; and an
 * install that waits for a new agent's setup to finish (a new agent "from a
 * repo"). Reading the source and working inside the agent is
 * src/orchestrator/apps/apps.ts; an install cut off by a restart is
 * appOperations.ts; a waiting install's secrets are appPending.ts. This is the
 * rules the API put round them.
 *
 * Its state, both locks (docs/architecture.md, "In-memory state,
 * sorted"):
 *  - `appAccountLocks`: installs and updates of one app on one account, one
 *    at a time (`oneAppAtATime`);
 *  - `pendingRuns`: one run of a waiting install per agent, and one more
 *    wanted (`runPendingApp`). The request itself waits in the store
 *    (agent_app_pending), and the start runs it.
 * No timer.
 *
 * The source is read on the host, so only the machine's owner may install or
 * update: the route checks who is asking. Nothing here knows about HTTP: a
 * route reads its request, asks this, and words the answer; a refusal is an
 * AppError (apps.ts), worded by the route's `appFail`.
 */
export interface AgentApps {
  /** What an install step inside this agent needs (its runtime, the facts it fills in, its timeline). The boot resume uses it too. */
  appDeps(a: Agent): InstallDeps;
  /** The agent's app as its page shows it, or null. */
  appView(a: Agent): AppView | null;
  /** What a repo's manifest says, and what it will ask for. `name`: a new agent's, so its chat comes filled in for it. */
  inspect(source: string, ref: string, name: string | undefined): Promise<AppInspection>;
  /** Install from a source into a running agent and record it (the route and a waiting install share it). */
  installFromSource(a: Agent, source: string, ref: string, values: Record<string, unknown>, allowShared?: boolean, requestedBy?: string): Promise<Installed>;
  /**
   * Save an install to run once the agent is ready (a new agent from a
   * repo): checked now, run after setup. `missing`: required settings with
   * no value; `saved: false`: deleted or archived while the repo was read.
   */
  savePending(a: Agent, o: { source: string; ref: string; values: Record<string, unknown>; allowShared: boolean }): Promise<PendingSaved>;
  /** Install the newest commit (or `ref`) from where it came. */
  update(a: Agent, had: AgentApp, o: { ref: string | null | undefined; values: Record<string, unknown> | null | undefined; allowShared: boolean; requestedBy: string }): Promise<AppUpdate>;
  /** Back to the release before the last install or update. */
  rollback(a: Agent, had: AgentApp, requestedBy: string): Promise<void>;
  /** Stop running it: its scheduled commands go, and a waiting install with them. How many tasks came off. */
  remove(a: Agent, had: AgentApp): Promise<number>;
  /**
   * Run the install waiting for this agent, if it runs. One run per agent at
   * a time; a call while one runs has it look again when it ends. Never
   * rejects.
   */
  runPendingApp(agentId: string): Promise<void>;
  /** A waiting install's manifest where it is on this machine (the folder, or the git address's mirror), never fetched. */
  manifestHere(source: string, ref: string): Promise<AppManifest | undefined>;
}

/** GET /v1/agents/:id/app's `app`. */
export interface AppView {
  app: string; name: string; source: string; ref: string; sha: string; previousSha: string | null;
  installedAt: string; testOk: boolean | null; tasks: string[];
}

/** POST /v1/apps/inspect's answer. */
export interface AppInspection {
  sha: string; manifest: AppManifest; ask: ReturnType<typeof fieldsToAsk>; connections: NonNullable<AppManifest['connections']>;
  chat?: string | null;
}

export type PendingSaved = { missing: string[] } | { saved: false } | { saved: true; app: string; name: string };

/** `otherApp`: the source holds another app now (its manifest's `app`), at `sha`. */
export type AppUpdate = { unchanged: true } | { otherApp: string; sha: string } | { done: Installed; refreshed: string[] };

/** What the apps need from the process they run in. Functions only, so a test hands them fakes. */
export interface AgentAppsDeps {
  store: Store;
  /** A waiting install's secret values (appPending.ts). */
  secrets: SecretStore;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Deleted or being deleted. */
  agentGone: (id: string) => boolean;
  /** Git for reading app sources on the host; tests hand in their own. */
  appGit: Git;
  /** Where the mirror of a git address is kept (beside the database). */
  appCacheDir: string;
  /** A line to the service's own log (not an agent's timeline). */
  warn: (detail: Record<string, unknown>, event: string) => void;
}

export function createAgentApps(deps: AgentAppsDeps): AgentApps {
  const { store, secrets, providerFor, trace, agentGone, appGit, appCacheDir } = deps;

  const appFacts = (a: Agent): AgentFacts => ({
    slug: a.slug, name: a.name, timezone: agentTimeZone(),
    telegramAccount: store.getChannelForAgent(a.id, 'telegram')?.accountId,
    ownerTelegram: store.accountTelegram(a.ownerId), ownerEmail: store.emailForOwner(a.ownerId),
  });
  const appDeps = (a: Agent): InstallDeps => ({
    provider: providerFor(a.hostId), runtimeRef: a.runtimeRef!, facts: appFacts(a),
    log: (step, detail) => trace(a.id)(step, detail ?? {}),
  });
  const appView = (a: Agent): AppView | null => {
    const r = store.getAgentApp(a.id);
    if (!r) return null;
    const m = r.manifest as AppManifest;
    return { app: r.app, name: m.name, source: r.source, ref: r.ref, sha: r.sha, previousSha: r.previousSha ?? null,
      installedAt: r.installedAt, testOk: r.testOk ?? null, tasks: m.tasks.map((t) => `${m.app}-${t.name}`) };
  };
  /**
   * Judged again once the lifecycle lock is held. The release fetch before it
   * can take minutes, and the agent row and app record read before it could
   * be gone by then: a move, a stop or another install landed meanwhile, and
   * the install then ran on the old host's runtime or recorded over the other
   * install (concurrency review, 2026-10-09).
   */
  const appStillAsWas = (a: Agent, had: ReturnType<typeof store.getAgentApp>): Agent => {
    const stale = (msg: string) => Object.assign(new AppError(msg), { stale: true });
    const now = store.getAgent(a.id);
    if (!now || now.state !== 'RUNNING' || !now.runtimeRef || now.migratedTo || now.hostId !== a.hostId || now.runtimeRef !== a.runtimeRef) {
      throw stale(`${a.name} changed while the release was fetched (it is ${now ? now.state.toLowerCase() : 'gone'}${now && now.hostId !== a.hostId ? ', on another machine' : ''}). Try again.`);
    }
    const cur = store.getAgentApp(a.id);
    if ((cur?.app ?? null) !== (had?.app ?? null) || (cur?.sha ?? null) !== (had?.sha ?? null) || (cur?.installedAt ?? null) !== (had?.installedAt ?? null)) {
      throw stale('Its app changed meanwhile (another install or update finished). Look again, then try again.');
    }
    return now;
  };

  /**
   * The accounts another agent's copy of an app runs on: the fields its own
   * manifest names for them, read from its config file in that agent.
   * Undefined when that cannot be told (not running, no such field, a file
   * that cannot be read): counted as a clash, as every attached agent was.
   */
  const appAccountsOf = async (other: Agent, theirs: NonNullable<ReturnType<typeof store.getAgentApp>>, kind: string): Promise<Set<string> | undefined> => {
    const om = theirs.manifest as AppManifest;
    const keys = (om?.connections ?? []).filter((c) => c.kind === kind && c.field).map((c) => c.field!);
    if (!keys.length || other.state !== 'RUNNING' || !other.runtimeRef) return undefined;
    try {
      const r = await providerFor(other.hostId).execShell(other.runtimeRef, `cat ${sq(`${appPaths(theirs.app).data}/${om.config?.file ?? 'config.json'}`)}`, { timeoutMs: 15_000 });
      if (r.code !== 0) return undefined;
      const cfg = JSON.parse(r.stdout) as Record<string, unknown>;
      return new Set(keys.map((k) => String(cfg?.[k] ?? '').trim().toLowerCase()).filter(Boolean));
    } catch { return undefined; }
  };
  /**
   * Other live agents already running this app on the account the values name
   * (e.g. the same mailbox): the account their copy is configured with, not
   * every account attached to them (one attached for something else blocked
   * it, HB-0261). `seen`: their accounts, read once per check. Each clash is
   * that agent and that account (`key`); its name is only for saying so.
   */
  const sharedAppConflicts = async (a: Agent, m: AppManifest, values: Record<string, unknown>,
    seen = new Map<string, Promise<Set<string> | undefined>>()): Promise<Array<{ key: string; name: string }>> => {
    const out: Array<{ key: string; name: string }> = [];
    for (const c of m.connections ?? []) {
      const email = c.field ? String(values[c.field] ?? '').trim().toLowerCase() : '';
      if (!email) continue;
      const conn = store.listConnections(a.ownerId).find((x) => x.kind === c.kind && x.email.toLowerCase() === email);
      if (!conn) continue;
      for (const at of store.listConnectionAttachments(conn.id)) {
        const other = store.getAgent(at.agentId);
        if (!other || other.id === a.id || other.state === 'ARCHIVED' || other.state === 'DELETED') continue;
        const theirs = store.getAgentApp(other.id);
        if (theirs?.app !== m.app) continue;
        const key = `${other.id}\n${c.kind}`;
        if (!seen.has(key)) seen.set(key, appAccountsOf(other, theirs, c.kind));
        const used = await seen.get(key);
        if (!used || used.has(email)) out.push({ key: `${other.id}\n${c.kind}\n${email}`, name: other.name });
      }
    }
    return out;
  };
  const sharedRefusal = (clashes: Array<{ name: string }>, m: AppManifest) => {
    const names = [...new Set(clashes.map((c) => c.name))];
    return Object.assign(new AppError(
      `${names.join(' and ')} already ${names.length > 1 ? 'run' : 'runs'} ${m.name} on the same account. Two copies would both answer every email. ` +
      'Stop the app there first, or use another account; or confirm you want both (allowShared).'), { conflict: names });
  };
  /**
   * The same check on the config the install will actually write (installRelease's
   * checkConfig): a mailbox from the manifest's default or the agent's old file
   * passed the check on the values alone, and an update never checked at all.
   * `kept`: the app is already this agent's, so a clash its old file already had
   * was accepted then (allowShared) and stays allowed; only a new one is refused.
   * The same agent on the same account, never the same name: another agent
   * of that name on another account passed as the one accepted (HB-0961).
   */
  const sharedConfigCheck = (a: Agent, m: AppManifest, allowShared: boolean, kept: boolean) => {
    const seen = new Map<string, Promise<Set<string> | undefined>>();
    return async (config: Record<string, unknown>, existing: Record<string, unknown>) => {
      if (allowShared) return;
      const before = new Set((kept ? await sharedAppConflicts(a, m, existing, seen) : []).map((c) => c.key));
      const clash = (await sharedAppConflicts(a, m, config, seen)).filter((c) => !before.has(c.key));
      if (clash.length) throw sharedRefusal(clash, m);
    };
  };
  /**
   * Installs and updates of one app on one account, one at a time: each checks
   * the others' records, and two running side by side both found none and both
   * went in on the same mailbox.
   */
  const appAccountLocks = keyedLock();
  const oneAppAtATime = <T>(ownerId: string, app: string, fn: () => Promise<T>): Promise<T> => appAccountLocks.run(`${ownerId}\n${app}`, fn);

  /** Recorded as it goes (appOperations.ts): its steps, and how it ended. A (simulated) dead process records nothing more. */
  const appOpFailed = (op: OpHandle | undefined, e: unknown) => {
    rethrowIfCrash(e);
    if (!op || op.get().status !== 'running') return;
    // Not put back (apps.ts kept its staging folder): held for the owner's
    // choice, as after a restart, not failed as if nothing were left to do (#106).
    if ((e as { held?: boolean })?.held) {
      const row = op.get();
      op.hold(String((e as Error)?.message ?? e).slice(0, 500),
        (e as { tasksBack?: boolean }).tasksBack ? TASKS_BACK : appChoices(row.kind, row.params as unknown as AppOpParams));
    } else op.fail(e);
  };
  const withSteps = (d: InstallDeps, op: OpHandle): InstallDeps => ({ ...d, step: (k, detail) => op.step(k, detail) });
  const installFromSource = async (a: Agent, source: string, ref: string, values: Record<string, unknown>, allowShared = false, requestedBy?: string) => {
    // What it had when asked, before the fetch: taken after it, an older
    // request slow to fetch went in over the App a newer one installed
    // meanwhile. Now the later request wins and the older is refused as
    // stale, as an update is (HB-0264).
    const had = store.getAgentApp(a.id);
    const src = parseSource(source);
    const label = src.kind === 'dir' ? src.path : src.url;
    const repo = await repoFor(appGit, src, appCacheDir);
    const rel = await resolveRelease(appGit, repo, ref);
    // The values alone first: refused at once, before anything starts. The
    // config the install would write is judged again inside it.
    const clash = allowShared ? [] : await sharedAppConflicts(a, rel.manifest, values);
    if (clash.length) throw sharedRefusal(clash, rel.manifest);
    return oneAppAtATime(a.ownerId, rel.manifest.app, async () => {
      // Another app in its place: its tasks come off first (never two apps on one mailbox),
      // and go back on if this install fails, so the agent still matches the record.
      const replaced = had && had.app !== rel.manifest.app ? had : undefined;
      let op: OpHandle | undefined;
      const done = await whileBusy(a.id, 'app-install', async () => {
        a = appStillAsWas(a, had);
        // The tasks the owner had turned off go back on turned off, and the
        // operation records which before any comes off, for a restart too:
        // put back from the manifest alone, they came back on and the
        // install said "unchanged" (HB-0253).
        const fromAppOff = replaced
          ? (await appJobs(appDeps(a), appTaskNames(replaced.manifest as AppManifest)).catch((e: unknown) => { throw outcome(e, { unchanged: true }); }))
            .filter((j) => j.enabled === false).map((j) => j.name)
          : [];
        op = beginOperation(store, 'app-install', a.id, {
          app: rel.manifest.app, toSha: rel.sha, fromSha: had?.app === rel.manifest.app ? had.sha : null,
          fromApp: had?.app ?? null, source: label, ref, ...(fromAppOff.length ? { fromAppOff } : {}),
        }, { requestedBy: requestedBy ?? a.ownerId });
        try {
          // Inside the put-back: a removal that took some of them off and
          // then failed left the old App part-stopped, its operation failed,
          // and nothing put them back (HB-1080).
          if (replaced) {
            await removeTasks(appDeps(a), replaced.app, replaced.manifest as AppManifest)
              .catch((e: unknown) => { rethrowIfCrash(e); throw outcome(e, { unchanged: true }); });
          }
          const check = sharedConfigCheck(a, rel.manifest, allowShared, had?.app === rel.manifest.app);
          return await installRelease({ ...withSteps(appDeps(a), op), checkConfig: check, ...(had?.app === rel.manifest.app ? { recorded: had } : {}) }, rel, values);
        } catch (e) {
          rethrowIfCrash(e);
          if (replaced) {
            // Its tasks put back as they were, and confirmed so. Not
            // confirmed: held for "Put its scheduled tasks back", as after a
            // restart, not failed with nothing left to put them back (HB-1080).
            // Only when the new App left nothing at all (its outcome
            // "unchanged"): one held because its own switch-back failed keeps
            // its two choices, and going back puts these tasks back too
            // (appOperations.ts, goBack). Any other outcome (its own tasks
            // could not be confirmed off) fails as before, saying what is
            // left: "as it was" could not be said for it.
            // The new App's own tasks left on (a step after them failed):
            // the old App's stay off, or both ran on one mailbox. Going back
            // puts them back (HB-1192).
            if ((e as { tasksOn?: boolean })?.tasksOn) {
              if (e instanceof Error) e.message += ` ${replaced.app}'s tasks stay off while ${rel.manifest.app}'s are on; going back to the previous one puts them back.`;
              throw e;
            }
            const missing = await putTasksBack(appDeps(a), replaced.manifest as AppManifest, fromAppOff);
            const left = e as { held?: boolean; unchanged?: boolean };
            if (missing && left?.held) {
              if (e instanceof Error) e.message += ` ${replaced.app}'s tasks could not be put back either: ${missing}. Going back to the previous one puts them back.`;
              outcome(e, { unchanged: false });
            } else if (missing && left?.unchanged === true) {
              if (e instanceof Error) e.message += ` ${replaced.app}'s tasks could not be put back: ${missing}. It waits on its page for you to put them back.`;
              outcome(e, { unchanged: false, held: true });
              if (e && typeof e === 'object') Object.assign(e, { tasksBack: true });
            } else if (missing) {
              if (e instanceof Error) e.message += ` ${replaced.app}'s tasks could not be put back: ${missing}`;
              outcome(e, { unchanged: false });
            }
          }
          throw e;
        }
      }).catch((e: unknown) => { appOpFailed(op, e); throw e; });
      store.setAgentApp({ agentId: a.id, app: done.app, source: label, ref, sha: done.sha, manifest: done.manifest,
        previousSha: had?.app === done.app ? had.sha : undefined, previousManifest: had?.app === done.app ? had.manifest : undefined,
        installedAt: new Date().toISOString(), testOk: done.test?.ok });
      trace(a.id)('app.installed', { app: done.app, sha: done.sha.slice(0, 12), source: label });
      op?.done(`${done.app} ${done.sha.slice(0, 12)} installed.`);
      return done;
    });
  };
  /**
   * A new agent "from a repo": install once it runs; a failure stays on the
   * record for its page. One run per agent at a time: a call while one runs
   * (a newer request saved, setup finishing) has it look again when it ends,
   * so a request saved meanwhile goes in after it rather than being missed
   * (HB-0255, HB-0256). `retry`: a request that already failed is left for
   * Try again.
   */
  const pendingRuns = new Map<string, { again: boolean }>();
  const runPendingOnce = async (agentId: string, retry: boolean) => {
    const p = store.getAppPending(agentId);
    const a = store.getAgent(agentId);
    if (!p || (p.error && !retry) || !a || a.state !== 'RUNNING' || !a.runtimeRef || isBusy(a.id) || store.activeOperationFor(a.id)) return;
    try {
      // Its secrets read back under the waiting row's lock, and only while
      // the row is still this request: a newer one saved meanwhile writes the
      // same refs, and read across it this install got some of each, its own
      // App with the other's credentials (HB-0929). Replaced before it was
      // read, it is not installed: the newer one runs next (its save asked).
      const read = await onePendingChange(agentId, async () => {
        const now = store.getAppPending(agentId);
        if (!now || now.gen !== p.gen) return undefined;
        const { __allowShared, ...kept } = now.values as Record<string, unknown> & { __allowShared?: boolean };
        return { values: await resolvePendingValues(secrets, agentId, kept), allowShared: __allowShared === true };
      });
      if (!read) return;
      await installFromSource(a, p.source, p.ref, read.values, read.allowShared);
      // In: its secrets are in the app's config now, and nowhere else. Only
      // this request: one saved while it ran is still to go in.
      await dropAppPending(store, secrets, agentId, p.gen);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      store.setAppPendingError(agentId, msg.slice(0, 2000), p.gen);
      trace(agentId)('app.install_failed', { error: msg.slice(0, 300) });
    }
  };
  const runPendingApp = async (agentId: string) => {
    const running = pendingRuns.get(agentId);
    if (running) { running.again = true; return; }
    const run = { again: false };
    pendingRuns.set(agentId, run);
    try {
      await runPendingOnce(agentId, true);
      while (run.again) { run.again = false; await runPendingOnce(agentId, false); }
    } catch (err) {
      // The database itself failed (a full disk): recording the failure, or
      // reading the request, threw. Run from `void`: it must not end the process.
      deps.warn({ agentId, err: String(err) }, 'app.pending_run_failed');
    } finally { pendingRuns.delete(agentId); }
  };

  return {
    appDeps,
    appView,

    inspect: async (source, ref, name) => {
      const src = parseSource(source);
      const repo = await repoFor(appGit, src, appCacheDir);
      // The manifest, and the code's size from its listing: the code is
      // packed when it is installed (HB-1017). Over the limit it is refused
      // here, before the page makes an agent or attaches an account for it.
      const rel = await manifestAt(appGit, repo, ref);
      await checkCodeSize(appGit, repo, rel.sha);
      return { sha: rel.sha, manifest: rel.manifest, ask: fieldsToAsk(rel.manifest), connections: rel.manifest.connections ?? [],
        ...(name ? { chat: appChat(rel.manifest, slugify(name)) ?? null } : {}) };
    },

    installFromSource,

    savePending: async (a, { source, ref, values, allowShared }) => {
      // Packed, where an inspection only lists the files (HB-1017): this is where a new agent's
      // install is accepted, so code over the size limit is refused here, not
      // after the agent is set up.
      const rel = await resolveRelease(appGit, await repoFor(appGit, parseSource(source), appCacheDir), ref);
      const missing = fieldsToAsk(rel.manifest).filter((f) => f.required && !String(f.default ?? '').trim() && !String(values[f.key] ?? '').trim()).map((f) => f.key);
      if (missing.length) return { missing };
      // Judged on what it would be installed with: a mailbox left to the
      // manifest's default (or filled from the owner's address) counts too.
      const effective = { ...values, ...mergeConfig(rel.manifest, appFacts(a), {}, values).config };
      const clash = allowShared ? [] : await sharedAppConflicts(a, rel.manifest, effective);
      if (clash.length) throw sharedRefusal(clash, rel.manifest);
      // Secret fields go to the secret store; the row keeps where. One waiting
      // before this is replaced: its secrets go unless this one reuses them.
      // One change to the waiting row at a time (appPending.ts): a run that
      // finished meanwhile forgot its request's secrets, which share these refs.
      // Deleted or archived while the repository was read: nothing is saved
      // for it, or the request sat behind a tombstone for good (HB-0569).
      const gone = () => agentGone(a.id) || store.getAgent(a.id)?.state === 'ARCHIVED';
      const saved = await onePendingChange(a.id, async () => {
        if (gone()) return false;
        const was = store.getAppPending(a.id);
        const before = was ? pendingSecretRefs(a.id, was.values) : [];
        const stash = await stashPendingSecrets(secrets, a.id, rel.manifest, values);
        const kept = stash.values;
        // And after its secrets were stored: they go again. This request's
        // secrets share the waiting row's refs, so a ref that row still names
        // (archived, its row stays) holds what it did; one no row names goes.
        if (gone()) {
          const row = store.getAppPending(a.id);
          const named = new Set(row ? pendingSecretRefs(a.id, row.values) : []);
          await stash.undo((r) => named.has(r));
          return false;
        }
        store.setAppPending(a.id, { source, ref, values: { ...kept, ...(allowShared ? { __allowShared: true } : {}) } });
        const now = new Set(pendingSecretRefs(a.id, kept));
        for (const r of before) if (!now.has(r)) await secrets.delete(r).catch(() => {});
        return true;
      });
      if (!saved) return { saved: false };
      trace(a.id)('app.pending', { app: rel.manifest.app });
      // Its state now, not as it was before the fetch: setup that finished
      // during it found no row to install, and this one still saw it setting
      // up, so nobody started the install (HB-0255).
      if (store.getAgent(a.id)?.state === 'RUNNING') void runPendingApp(a.id);
      return { saved: true, app: rel.manifest.app, name: rel.manifest.name };
    },

    update: async (a, had, o) => {
      const repo = await repoFor(appGit, parseSource(had.source), appCacheDir);
      const ref = o.ref || had.ref;
      const at = await manifestAt(appGit, repo, ref);
      // The same commit has nothing new, unless what Hatchabot fills has moved
      // on (its bot changed): then Update writes it, as the same commit's install does.
      // One that cannot be told is said, not taken for "nothing new" (HB-1016).
      const refreshed = at.sha === had.sha && !o.values
        ? await staleFilledFields(appDeps(a), at.manifest).catch((e: unknown) => {
          rethrowIfCrash(e);
          throw outcome(e instanceof AppError ? e : new AppError(`Could not check the settings Hatchabot fills for ${had.app} (${(e as Error)?.message ?? e}). Nothing was changed; try again.`), { unchanged: true });
        })
        : [];
      if (at.sha === had.sha && !o.values && !refreshed.length) return { unchanged: true };
      // Another app at its source now (its manifest's "app" changed): an
      // update would schedule its tasks beside the old app's and record them
      // under the old name, leaving the old ones running for good (audit #012).
      // Replacing one app with another is an install, which takes the old
      // app's tasks off first and puts them back if it fails.
      if (at.manifest.app !== had.app) return { otherApp: at.manifest.app, sha: at.sha };
      // Only now the code itself: an Update with nothing new packed the whole repository to say so (HB-1017).
      const rel = { ...at, tar: await releaseTar(appGit, repo, at.sha) };
      let op: OpHandle | undefined;
      const done = await oneAppAtATime(a.ownerId, had.app, async () => {
        const d = await whileBusy(a.id, 'app-update', () => {
          const now = appStillAsWas(a, had);
          op = beginOperation(store, 'app-update', a.id, { app: had.app, toSha: rel.sha, fromSha: had.sha, fromApp: had.app, source: had.source, ref }, { requestedBy: o.requestedBy });
          // An update that points it at another mailbox (new values, or a new
          // default) is judged like an install; it never was.
          const check = sharedConfigCheck(now, rel.manifest, o.allowShared, had.app === rel.manifest.app);
          return installRelease({ ...withSteps(appDeps(now), op), checkConfig: check, recorded: had }, rel, o.values ?? {});
        }).catch((e: unknown) => { appOpFailed(op, e); throw e; });
        store.setAgentApp({ ...had, ref, sha: d.sha, manifest: d.manifest,
          previousSha: rel.sha === had.sha ? had.previousSha : had.sha, previousManifest: rel.sha === had.sha ? had.previousManifest : had.manifest,
          installedAt: new Date().toISOString(), testOk: d.test?.ok });
        return d;
      });
      trace(a.id)('app.updated', { app: done.app, from: had.sha.slice(0, 12), to: done.sha.slice(0, 12) });
      op?.done(`${done.app} updated to ${done.sha.slice(0, 12)}.`);
      return { done, refreshed };
    },

    rollback: async (a, had, requestedBy) => {
      let op: OpHandle | undefined;
      await whileBusy(a.id, 'app-rollback', () => {
        op = beginOperation(store, 'app-rollback', a.id, { app: had.app, toSha: had.previousSha!, fromSha: had.sha, fromApp: had.app }, { requestedBy });
        return switchTo(withSteps(appDeps(a), op), had.previousManifest as AppManifest, had.previousSha!, had.manifest as AppManifest);
      }).catch((e: unknown) => { appOpFailed(op, e); throw e; });
      store.setAgentApp({ ...had, sha: had.previousSha!, manifest: had.previousManifest, previousSha: had.sha, previousManifest: had.manifest,
        installedAt: new Date().toISOString(), testOk: undefined });
      trace(a.id)('app.rolled_back', { app: had.app, from: had.sha.slice(0, 12), to: had.previousSha!.slice(0, 12) });
      op?.done(`${had.app} is back on ${had.previousSha!.slice(0, 12)}.`);
    },

    remove: async (a, had) => {
      const n = await whileBusy(a.id, 'app-remove', async () => {
        appStillAsWas(a, had);
        const removed = await removeTasks(appDeps(a), had.app, had.manifest as AppManifest);
        store.deleteAgentApp(a.id);
        // An install still waiting for it goes too: kept, the next start
        // installed the App again and its tasks came back (HB-0252). One
        // whose source is being read now is refused once it has it (its app
        // changed meanwhile: appStillAsWas).
        await dropAppPending(store, secrets, a.id);
        return removed;
      });
      trace(a.id)('app.removed', { app: had.app, tasks: n });
      return n;
    },

    runPendingApp,

    manifestHere: async (source, ref) => {
      const src = parseSource(source);
      // Read from its git folder, as repoFor finds it; a mirror as it is, never fetched.
      if (src.kind === 'dir') return existsSync(src.path) ? (await manifestAt(appGit, await repoFor(appGit, src, appCacheDir), ref)).manifest : undefined;
      const mirror = mirrorDir(appCacheDir, src.url);
      return existsSync(mirror) ? (await manifestAt(appGit, mirror, ref)).manifest : undefined;
    },
  };
}
