/**
 * Apps in agents (docs/apps-in-agents.md): a codebase with a `hatchabot.json`
 * manifest, installed into an agent as a release, with its config, its tests run
 * before it goes live, and its scheduled commands. Update installs a newer
 * commit the same way; rollback points back at the previous release.
 *
 * The source is read on the host (only the machine's owner may do this: it uses
 * the host's paths and git credentials). Everything that lands in the agent goes
 * through the runtime provider: a tarball onto its volume (writeToVolume), shell
 * steps in its container (execShell), OpenClaw's CLI for the tasks (exec).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import type { RuntimeProvider } from '../providers/provider.js';
import { SimulatedCrash } from './operations.js';

export const MANIFEST_FILE = 'hatchabot.json';
export const APPS_ROOT = '/home/node/.openclaw/apps';
const KEEP_RELEASES = 3;
const MAX_TAR_BYTES = 100 * 1024 * 1024;

// -- the manifest ---------------------------------------------------------------------
const FROM = ['agent.openclawId', 'agent.telegramAccount', 'agent.name', 'owner.telegram', 'owner.email', 'host.timezone'] as const;
const field = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  label: z.string().max(200).optional(),
  type: z.enum(['text', 'email', 'number', 'bool', 'list']).optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  from: z.enum(FROM).optional(),
  secret: z.boolean().optional(),
});
const task = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  every: z.string().regex(/^\d{1,4}[smhd]$/).optional(),
  cron: z.string().max(100).optional(),
  command: z.array(z.string().max(500)).min(1).max(40),
  timeoutSeconds: z.number().int().min(10).max(3600).optional(),
}).refine((t) => !!t.every !== !!t.cron, { message: 'a task needs exactly one of "every" or "cron"' });
export const manifestSchema = z.object({
  app: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'app: 2-40 characters, a-z, 0-9 and -'),
  name: z.string().min(1).max(80),
  description: z.string().max(1000).optional(),
  model: z.string().max(80).optional(),
  chat: z.string().max(4000).optional(),
  test: z.array(z.string().max(500)).min(1).max(40).optional(),
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), z.string().max(500)).optional(),
  tasks: z.array(task).max(10).default([]),
  config: z.object({
    file: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default('config.json'),
    fields: z.array(field).max(60).default([]),
  }).optional(),
  connections: z.array(z.object({
    kind: z.literal('google'),
    purpose: z.string().max(200),
    field: z.string().max(64).optional(),
  })).max(5).optional(),
});
export type AppManifest = z.infer<typeof manifestSchema>;

export function parseManifest(text: string): AppManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new AppError(`${MANIFEST_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  const r = manifestSchema.safeParse(raw);
  if (!r.success) throw new AppError(`${MANIFEST_FILE}: ${r.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** The fields the owner is asked for (the rest Hatchabot fills). */
export function fieldsToAsk(m: AppManifest) {
  return (m.config?.fields ?? []).filter((f) => !f.from);
}

export class AppError extends Error {}

// -- the source, on the host --------------------------------------------------------------
export type AppSource = { kind: 'dir'; path: string } | { kind: 'git'; url: string };

export function parseSource(s: string, home = homedir()): AppSource {
  const t = (s ?? '').trim();
  if (!t) throw new AppError('Give a repo: a folder on this machine (~/myapp) or a git address.');
  if (t.startsWith('~/') || t === '~' || isAbsolute(t)) {
    return { kind: 'dir', path: resolvePath(t.replace(/^~(?=\/|$)/, home)) };
  }
  if (/^(https:\/\/|ssh:\/\/|git@)[^\s'"`$;|&<>]+$/.test(t)) return { kind: 'git', url: t };
  throw new AppError('That is neither a folder (start it with / or ~/) nor a git address (https://… or git@…).');
}

export type Git = (args: string[], cwd?: string) => Promise<{ code: number; stdout: Buffer; stderr: string }>;

export const hostGit: Git = (args, cwd) => new Promise((done) => {
  execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: MAX_TAR_BYTES + 1024 * 1024, timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
    done({ code: err ? ((err as { code?: number }).code && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 1) : 0,
      stdout: stdout as Buffer, stderr: String(stderr ?? '') });
  });
});

/** The local repository to read from: the folder itself, or a mirror of the URL kept beside the database. */
export async function repoFor(git: Git, src: AppSource, cacheDir: string): Promise<string> {
  if (src.kind === 'dir') {
    if (!existsSync(src.path)) throw new AppError(`No folder at ${src.path}.`);
    const r = await git(['-C', src.path, 'rev-parse', '--git-dir']);
    if (r.code !== 0) throw new AppError(`${src.path} is not a git repository.`);
    return src.path;
  }
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const dir = join(cacheDir, createHash('sha256').update(src.url).digest('hex').slice(0, 16) + '.git');
  const r = existsSync(dir)
    ? await git(['-C', dir, 'fetch', '--prune', '--force', 'origin', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'])
    : await git(['clone', '--mirror', '--', src.url, dir]);
  if (r.code !== 0) throw new AppError(`Could not fetch ${src.url}: ${r.stderr.trim().split('\n').pop() ?? 'git failed'}`);
  return dir;
}

export interface Resolved { sha: string; manifest: AppManifest; tar: Buffer }

/** A ref to its commit, the manifest at that commit, and the commit's files as a tarball. */
export async function resolveRelease(git: Git, repo: string, ref = 'HEAD'): Promise<Resolved> {
  if (!/^[A-Za-z0-9._\/^~-]{1,200}$/.test(ref) || ref.startsWith('-')) throw new AppError(`Not a ref: ${ref}`);
  const rev = await git(['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`]);
  if (rev.code !== 0) throw new AppError(`No commit "${ref}" in the repo.`);
  const sha = rev.stdout.toString().trim();
  const man = await git(['-C', repo, 'show', `${sha}:${MANIFEST_FILE}`]);
  if (man.code !== 0) throw new AppError(`The repo has no ${MANIFEST_FILE} at ${sha.slice(0, 12)} (see docs/apps-in-agents.md).`);
  const manifest = parseManifest(man.stdout.toString());
  const tar = await git(['-C', repo, 'archive', '--format=tar', sha]);
  if (tar.code !== 0) throw new AppError(`git archive failed: ${tar.stderr.trim()}`);
  if (tar.stdout.length > MAX_TAR_BYTES) throw new AppError(`The code is ${Math.round(tar.stdout.length / 1048576)} MB; apps are limited to ${MAX_TAR_BYTES / 1048576} MB.`);
  return { sha, manifest, tar: tar.stdout };
}

// -- inside the agent -----------------------------------------------------------------------
export interface AgentFacts {
  slug: string;              // its OpenClaw agent id inside the container
  name: string;
  telegramAccount?: string;
  ownerTelegram?: string;
  ownerEmail?: string;
  timezone: string;
}

export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function appPaths(app: string) {
  const root = `${APPS_ROOT}/${app}`;
  return { root, releases: `${root}/releases`, current: `${root}/current`, data: `${root}/data` };
}

/** {app_dir} {data_dir} {agent} {name} {env} in a manifest string. */
export function expand(t: string, vars: { [k: string]: unknown }): string {
  return t.replace(/\{(app_dir|data_dir|agent|name|env)\}/g, (_, k: string) => (typeof vars[k] === 'string' ? (vars[k] as string) : ''));
}

/** The placeholders for a release. `at` points them elsewhere (its tests run in the candidate, against the staged data folder). */
export function appVars(m: AppManifest, facts: AgentFacts, at: { app_dir?: string; data_dir?: string } = {}) {
  const p = appPaths(m.app);
  const base = { app_dir: at.app_dir ?? p.current, data_dir: at.data_dir ?? p.data, agent: facts.slug, name: m.name, env: '' };
  const env = Object.fromEntries(Object.entries(m.env ?? {}).map(([k, v]) => [k, expand(v, base)]));
  return { ...base, env: Object.entries(env).map(([k, v]) => `${k}=${sq(v)}`).join(' '), envMap: env };
}

/** The config file's new contents: asked values, Hatchabot's facts, existing values kept, defaults for the rest. */
export function mergeConfig(m: AppManifest, facts: AgentFacts, existing: Record<string, unknown>, values: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...existing };
  const missing: string[] = [];
  const fact: Record<(typeof FROM)[number], unknown> = {
    'agent.openclawId': facts.slug, 'agent.telegramAccount': facts.telegramAccount ?? '', 'agent.name': facts.name,
    'owner.telegram': facts.ownerTelegram ?? '', 'owner.email': facts.ownerEmail ?? '', 'host.timezone': facts.timezone,
  };
  for (const f of m.config?.fields ?? []) {
    if (f.from) { out[f.key] = fact[f.from]; continue; }
    if (values[f.key] !== undefined && values[f.key] !== '') out[f.key] = coerce(f.type, values[f.key]);
    else if (out[f.key] !== undefined) continue;
    else if (f.default !== undefined) out[f.key] = f.default;
    else if (f.required) missing.push(f.label ? `${f.key} (${f.label})` : f.key);
  }
  return { config: out, missing };
}

function coerce(type: string | undefined, v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (type === 'number') return Number(v);
  if (type === 'bool') return /^(1|true|yes|on)$/i.test(v);
  if (type === 'list') return v.split(',').map((x) => x.trim()).filter(Boolean);
  return v;
}

export interface Installed { app: string; sha: string; previousSha?: string; manifest: AppManifest; test?: { ok: boolean; output: string }; tasks: string[] }

export interface InstallDeps {
  provider: RuntimeProvider;
  runtimeRef: string;
  facts: AgentFacts;
  log?: (step: string, detail?: Record<string, unknown>) => void;
  /** The operation's record (operations.ts): each step as it is done (appOperations.ts). */
  step?: (key: string) => void;
}

async function sh(d: InstallDeps, script: string, timeoutMs = 60_000) {
  return d.provider.execShell(d.runtimeRef, script, { timeoutMs });
}

/** Where `current` points now, as the link says it ('' when not installed). */
async function currentLink(d: InstallDeps, app: string): Promise<string> {
  const r = await sh(d, `readlink ${sq(appPaths(app).current)} 2>/dev/null || true`);
  return r.stdout.trim();
}
const shaOf = (link: string) => /releases\/([0-9a-f]{12,40})$/.exec(link)?.[1];

/** The commit `current` points at now (undefined: not installed). */
export async function currentSha(d: InstallDeps, app: string): Promise<string | undefined> {
  return shaOf(await currentLink(d, app));
}

/** Point `current` at `link` again, atomically ('' = there was none). */
export function pointBack(p: ReturnType<typeof appPaths>, link: string) {
  return link ? `cd ${sq(p.root)} && ln -sfn ${sq(link)} current.new && mv -T current.new current` : `rm -f ${sq(p.current)}`;
}

/** The manifest a release on the volume was installed with (to put its tasks back). */
export async function releaseManifest(d: InstallDeps, dir: string): Promise<AppManifest | undefined> {
  const r = await sh(d, `cat ${sq(`${dir}/${MANIFEST_FILE}`)} 2>/dev/null || true`);
  try { return parseManifest(r.stdout); } catch { return undefined; }
}

const errText = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().slice(0, 300);

/**
 * Install or update: unpack the release, stage its config, run its tests
 * against the staged config, then switch: the config and `current` together,
 * then the tasks. Until the switch nothing live changes; a failure in the
 * switch or the tasks puts back the previous release, its config (to the
 * byte) and its tasks, so the agent, its jobs and the record agree.
 */
export async function installRelease(d: InstallDeps, rel: Resolved, values: Record<string, unknown> = {}): Promise<Installed> {
  const m = rel.manifest;
  const p = appPaths(m.app);
  const short = rel.sha.slice(0, 12);
  const dir = `${p.releases}/${short}`;
  const stage = `${p.root}/staging/${short}`;
  const log = d.log ?? (() => {});
  if (!d.provider.writeToVolume) throw new AppError('This machine cannot copy files into agents (no writeToVolume).');
  const previousLink = await currentLink(d, m.app);
  const previousSha = shaOf(previousLink);
  const name = m.config?.file ?? 'config.json';
  const live = `${p.data}/${name}`;
  const staged = `${stage}/${name}`;
  const step = d.step ?? (() => {});
  let switching = false;
  let crashed = false;
  try {
    // 1. the code, and an empty staging folder for its data while it is tested
    log('app.unpack', { app: m.app, sha: short });
    const un = await d.provider.writeToVolume(d.runtimeRef,
      ['sh', '-c', `rm -rf ${sq(dir)}.tmp && mkdir -p ${sq(dir)}.tmp && tar -x -C ${sq(dir)}.tmp && rm -rf ${sq(dir)} && mv ${sq(dir)}.tmp ${sq(dir)}`
        + ` && mkdir -p ${sq(p.data)} && rm -rf ${sq(stage)} && mkdir -p ${sq(stage)}`],
      rel.tar);
    if (un.code !== 0) throw new AppError(`Could not unpack the code: ${errText(un)}`);
    step('unpacked');

    // 2. the config, staged: the live file is not touched until the switch
    if (m.config) {
      const read = await sh(d, `cat ${sq(live)} 2>/dev/null || true`);
      let existing: Record<string, unknown> = {};
      try { existing = read.stdout.trim() ? JSON.parse(read.stdout) : {}; } catch { throw new AppError(`${live} in the agent is not valid JSON; fix or remove it.`); }
      const { config, missing } = mergeConfig(m, d.facts, existing, values);
      if (missing.length) throw new AppError(`Needs a value for: ${missing.join(', ')} (give them as key=value).`);
      const w = await d.provider.writeToVolume(d.runtimeRef,
        ['sh', '-c', `umask 077 && cat > ${sq(staged)}`], Buffer.from(JSON.stringify(config, null, 2) + '\n'));
      if (w.code !== 0) throw new AppError(`Could not write ${staged}.`);
    }
    step('configured');

    // 3. its tests: the new release, with its env, {data_dir} = the staged folder (the new config, none of the live data)
    let test: Installed['test'];
    if (m.test?.length) {
      log('app.test', { app: m.app, sha: short });
      const tv = appVars(m, d.facts, { app_dir: dir, data_dir: stage });
      const envStr = Object.entries(tv.envMap).map(([k, v]) => `${k}=${sq(v)}`).join(' ');
      const r = await sh(d, `cd ${sq(dir)} && env ${envStr} ${m.test.map((a) => sq(expand(a, tv))).join(' ')} 2>&1`, 15 * 60_000);
      test = { ok: r.code === 0, output: (r.stdout + r.stderr).slice(-3000) };
      if (!test.ok) {
        log('app.test_failed', { app: m.app, sha: short });
        throw Object.assign(new AppError(`Its tests failed, so ${short} was not switched on:\n${test.output.slice(-1500)}`), { test });
      }
    }
    step('tested');

    // 4. switch: the config (the old one kept aside, or a note there was none), then `current`, atomically
    step('switching');
    switching = true;
    const cfg = m.config
      ? `{ if [ -f ${sq(live)} ]; then cp -p ${sq(live)} ${sq(`${staged}.prev`)}; else : > ${sq(`${staged}.none`)}; fi; } && mv -f ${sq(staged)} ${sq(live)} && `
      : '';
    const sw = await sh(d, `cd ${sq(p.root)} && ${cfg}ln -sfn releases/${short} current.new && mv -T current.new current`);
    if (sw.code !== 0) throw new AppError(`Could not switch to ${short}: ${errText(sw)}`);
    log('app.switched', { app: m.app, sha: short, previous: previousSha ?? null });
    step('switched');

    // 5. its scheduled commands (syncTasks leaves the old set in place when it fails)
    const before = previousSha ? await releaseManifest(d, `${p.releases}/${previousSha}`) : undefined;
    const tasks = await syncTasks(d, m, before);
    step('tasks');

    // 6. keep the newest releases (never the live one or the one before it)
    const prune = await sh(d, `cd ${sq(p.root)} && ls -1t releases | tail -n +${KEEP_RELEASES + 1} | grep -v -x -e ${short} -e ${sq(previousSha ?? short)} | while read r; do rm -rf "releases/$r"; done`);
    if (prune.code !== 0) log('app.prune_failed', { app: m.app, error: errText(prune) });
    return { app: m.app, sha: rel.sha, previousSha, manifest: m, test, tasks };
  } catch (e) {
    // A (simulated) dead process puts nothing back and clears nothing: the
    // restart finds it as it is (appOperations.ts, resumeAppOperation).
    if (e instanceof SimulatedCrash) { crashed = true; throw e; }
    if (!switching) throw e;
    // Put the previous release back: its config (when this one was moved in) and `current`.
    const cfgBack = m.config
      ? `if [ ! -e ${sq(staged)} ]; then if [ -f ${sq(`${staged}.prev`)} ]; then mv -f ${sq(`${staged}.prev`)} ${sq(live)} || rc=1;`
        + ` elif [ -f ${sq(`${staged}.none`)} ]; then rm -f ${sq(live)} || rc=1; fi; fi; `
      : '';
    const back = await sh(d, `rc=0; ${cfgBack}{ ${pointBack(p, previousLink)}; } || rc=1; exit $rc`)
      .catch((err: unknown) => ({ code: 1, stdout: '', stderr: (err as Error)?.message ?? String(err) }));
    log(back.code === 0 ? 'app.restored' : 'app.restore_failed', { app: m.app, sha: short, previous: previousSha ?? null });
    const said = back.code === 0
      ? (previousSha ? ` ${previousSha} is running as before, with its configuration.` : ' Nothing was left switched on.')
      : ` Putting ${previousSha ?? 'the agent'} back failed too (${errText(back) || 'no output'}); use Roll back or Update again.`;
    if (e instanceof Error) e.message += said;
    throw e;
  } finally {
    if (!crashed) await clearStaging(d, m.app, short);
  }
}

/** Where an install stages a release's data while it is tested ({data_dir} for its tests, the config's way in). */
export function stagingDir(app: string, short: string): string {
  return `${appPaths(app).root}/staging/${short}`;
}

/** Remove a release's staging folder (and the staging folder when empty); never throws. */
export async function clearStaging(d: InstallDeps, app: string, short?: string): Promise<void> {
  const root = appPaths(app).root;
  const what = short ? sq(stagingDir(app, short)) : `${sq(`${root}/staging`)}/*`;
  await sh(d, `rm -rf ${what}; rmdir ${sq(`${root}/staging`)} 2>/dev/null; true`).catch(() => undefined);
}

/**
 * Point `current` back at an earlier release that is still there, and give it
 * its tasks. `from` is the manifest of the release being left (its tasks are
 * the ones put back if the new set cannot be scheduled; `current` goes back too).
 */
export async function switchTo(d: InstallDeps, m: AppManifest, sha: string, from?: AppManifest): Promise<void> {
  const p = appPaths(m.app);
  const short = sha.slice(0, 12);
  const before = await currentLink(d, m.app);
  d.step?.('switching');
  const r = await sh(d, `cd ${sq(p.root)} && test -d releases/${short} && ln -sfn releases/${short} current.new && mv -T current.new current`);
  if (r.code !== 0) throw new AppError(`Release ${short} is no longer in the agent.`);
  try {
    await syncTasks(d, m, from);
    d.step?.('tasks');
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e;
    const back = await sh(d, pointBack(p, before)).catch(() => ({ code: 1, stdout: '', stderr: '' }));
    if (e instanceof Error) e.message += back.code === 0 ? ` Still on ${shaOf(before) ?? 'the release it had'}.` : ' Pointing back at the release it had failed too.';
    throw e;
  }
}

type Job = { id: string; name: string };

/** The agent's jobs named "<app>-…"; throws when the list cannot be read (a sync must know what is there). */
export async function appJobs(d: InstallDeps, app: string): Promise<Job[]> {
  const list = await d.provider.exec(d.runtimeRef, ['cron', 'list', '--json'], { timeoutMs: 60_000 });
  if (list.code !== 0) throw new AppError(`Could not read the agent's scheduled tasks: ${errText(list)}`);
  let jobs: unknown;
  try { jobs = JSON.parse(list.stdout).jobs; } catch { throw new AppError("The agent's scheduled tasks did not read as JSON."); }
  if (!Array.isArray(jobs) || jobs.some((j) => !j || typeof j.id !== 'string' || typeof j.name !== 'string')) throw new AppError("The agent's scheduled task list is incomplete or malformed. Try again.");
  return (jobs as Job[]).filter((x) => typeof x?.name === 'string' && x.name.startsWith(`${app}-`));
}

function addArgv(d: InstallDeps, m: AppManifest, t: AppManifest['tasks'][number]): string[] {
  const vars = appVars(m, d.facts);
  return ['cron', 'add', '--name', `${m.app}-${t.name}`, '--agent', d.facts.slug,
    ...(t.every ? ['--every', t.every] : ['--cron', t.cron!, '--tz', d.facts.timezone]),
    '--command-argv', JSON.stringify(t.command.map((a) => expand(a, vars))),
    '--command-cwd', vars.app_dir,
    ...Object.entries(vars.envMap).flatMap(([k, v]) => ['--command-env', `${k}=${v}`]),
    '--timeout-seconds', String(t.timeoutSeconds ?? 300), '--no-deliver', '--json'];
}

/**
 * OpenClaw command tasks named "<app>-<task>": the manifest's set, exactly.
 * The new jobs go in first and the old ones come off after, so a failure part
 * way puts the old set back: new jobs taken off again, old ones gone re-added
 * from `previous` (the manifest they were made from). The error says what
 * could not be put back.
 *
 * The put-back goes by what the agent has, not by what each call answered
 * (2026-10-09, #17): a `cron add` or `cron rm` can take effect and still
 * answer an error (its reply lost, a timeout). So it lists the jobs, takes off
 * any that were not there before, re-adds the old ones that are gone, and lists
 * again; only that second list may say the tasks are as they were.
 */
export async function syncTasks(d: InstallDeps, m: AppManifest, previous?: AppManifest): Promise<string[]> {
  const run = (argv: string[]) => d.provider.exec(d.runtimeRef, argv, { timeoutMs: 60_000 });
  const old = await appJobs(d, m.app);
  const oldIds = new Set(old.map((j) => j.id));
  const prev = previous?.app === m.app ? previous : undefined;
  /** Put the old set back; what is still wrong after a fresh list ([] = confirmed as it was). */
  const putBack = async (): Promise<string[]> => {
    const unread = (e: unknown) => [`the list could not be read (${(e as Error)?.message ?? e})`];
    let now: Job[];
    try { now = await appJobs(d, m.app); } catch (e) { return unread(e); }
    const seen = new Set(now.map((j) => j.id));
    for (const j of now.filter((x) => !oldIds.has(x.id))) await run(['cron', 'rm', j.id]);
    for (const j of old.filter((x) => !seen.has(x.id))) {
      const t = prev?.tasks.find((x) => `${m.app}-${x.name}` === j.name);
      if (t) await run(addArgv(d, prev!, t));
    }
    let after: Job[];
    try { after = await appJobs(d, m.app); } catch (e) { return unread(e); }
    // Listed before the put-back and not in the old set: a new job that would not come off.
    // Not listed before: added by the put-back, whatever its add answered.
    const stray = after.filter((j) => seen.has(j.id) && !oldIds.has(j.id)).map((j) => j.name);
    const count = (jobs: Job[]) => jobs.reduce((n, j) => n.set(j.name, (n.get(j.name) ?? 0) + 1), new Map<string, number>());
    const want = count(old);
    const have = count(after.filter((j) => oldIds.has(j.id) || !seen.has(j.id)));
    const missing = [...want].filter(([name, n]) => (have.get(name) ?? 0) < n).map(([name]) => name);
    const twice = [...have].filter(([name, n]) => n > (want.get(name) ?? 0)).map(([name]) => name);
    return [
      ...(stray.length ? [`still there: ${stray.join(', ')}`] : []),
      ...(missing.length ? [`not re-added: ${missing.join(', ')}`] : []),
      ...(twice.length ? [`more than once: ${twice.join(', ')}`] : []),
    ];
  };
  const fail = async (what: string) => {
    const problems = await putBack();
    return new AppError(`${what} ${problems.length
      ? `Its scheduled tasks could not be confirmed: ${problems.join('; ')}. Check them with \`openclaw cron list\` in the agent's console (jobs named ${m.app}-…), then Update or Roll back again.`
      : 'Its tasks are as they were.'}`);
  };

  const made: string[] = [];
  for (const t of m.tasks) {
    const r = await run(addArgv(d, m, t));
    if (r.code !== 0) throw await fail(`Could not schedule ${m.app}-${t.name}: ${errText(r)}.`);
    made.push(`${m.app}-${t.name}`);
  }
  for (const j of old) {
    const r = await run(['cron', 'rm', j.id]);
    if (r.code !== 0) throw await fail(`Could not take off the old task ${j.name}: ${errText(r)}.`);
  }
  return made;
}

/** Take its tasks off; the code and data stay on the volume. */
export async function removeTasks(d: InstallDeps, app: string): Promise<number> {
  const jobs = await appJobs(d, app);
  for (const j of jobs) {
    // A lost response may mean it was removed. The fresh list decides.
    await d.provider.exec(d.runtimeRef, ['cron', 'rm', j.id], { timeoutMs: 60_000 }).catch(() => undefined);
  }
  const left = await appJobs(d, app);
  if (left.length) throw new AppError(`Could not remove ${app}'s scheduled tasks: ${left.map((j) => j.name).join(', ')} remain. Try again; the app record has been kept.`);
  return jobs.length;
}
