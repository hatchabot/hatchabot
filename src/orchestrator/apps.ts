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

export function appVars(m: AppManifest, facts: AgentFacts) {
  const p = appPaths(m.app);
  const base = { app_dir: p.current, data_dir: p.data, agent: facts.slug, name: m.name, env: '' };
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
}

async function sh(d: InstallDeps, script: string, timeoutMs = 60_000) {
  return d.provider.execShell(d.runtimeRef, script, { timeoutMs });
}

/** The commit `current` points at now (undefined: not installed). */
export async function currentSha(d: InstallDeps, app: string): Promise<string | undefined> {
  const r = await sh(d, `readlink ${sq(appPaths(app).current)} 2>/dev/null || true`);
  const m = /releases\/([0-9a-f]{12,40})$/.exec(r.stdout.trim());
  return m?.[1];
}

/**
 * Install or update: unpack the release, write the config, run the tests, switch
 * `current`, re-sync the tasks. Fails before the switch leave the running
 * version as it was.
 */
export async function installRelease(d: InstallDeps, rel: Resolved, values: Record<string, unknown> = {}): Promise<Installed> {
  const m = rel.manifest;
  const p = appPaths(m.app);
  const short = rel.sha.slice(0, 12);
  const dir = `${p.releases}/${short}`;
  const log = d.log ?? (() => {});
  if (!d.provider.writeToVolume) throw new AppError('This machine cannot copy files into agents (no writeToVolume).');
  const previousSha = await currentSha(d, m.app);

  // 1. the code
  log('app.unpack', { app: m.app, sha: short });
  const un = await d.provider.writeToVolume(d.runtimeRef,
    ['sh', '-c', `rm -rf ${sq(dir)}.tmp && mkdir -p ${sq(dir)}.tmp && tar -x -C ${sq(dir)}.tmp && rm -rf ${sq(dir)} && mv ${sq(dir)}.tmp ${sq(dir)} && mkdir -p ${sq(p.data)}`],
    rel.tar);
  if (un.code !== 0) throw new AppError(`Could not unpack the code: ${(un.stderr || un.stdout).trim().slice(0, 300)}`);

  // 2. the config
  const file = `${p.data}/${m.config?.file ?? 'config.json'}`;
  if (m.config) {
    const read = await sh(d, `cat ${sq(file)} 2>/dev/null || true`);
    let existing: Record<string, unknown> = {};
    try { existing = read.stdout.trim() ? JSON.parse(read.stdout) : {}; } catch { throw new AppError(`${file} in the agent is not valid JSON; fix or remove it.`); }
    const { config, missing } = mergeConfig(m, d.facts, existing, values);
    if (missing.length) throw new AppError(`Needs a value for: ${missing.join(', ')} (give them as key=value).`);
    const w = await d.provider.writeToVolume(d.runtimeRef,
      ['sh', '-c', `umask 077 && cat > ${sq(file)}.tmp && mv ${sq(file)}.tmp ${sq(file)}`], Buffer.from(JSON.stringify(config, null, 2) + '\n'));
    if (w.code !== 0) throw new AppError(`Could not write ${file}.`);
  }

  // 3. its tests, in the new release, with its env
  const vars = appVars(m, d.facts);
  let test: Installed['test'];
  if (m.test?.length) {
    log('app.test', { app: m.app, sha: short });
    const envStr = Object.entries(vars.envMap).map(([k, v]) => `${k}=${sq(v.replace(p.current, dir))}`).join(' ');
    const r = await sh(d, `cd ${sq(dir)} && env ${envStr} ${m.test.map((a) => sq(expand(a, { ...vars, app_dir: dir }))).join(' ')} 2>&1`, 15 * 60_000);
    test = { ok: r.code === 0, output: (r.stdout + r.stderr).slice(-3000) };
    if (!test.ok) {
      log('app.test_failed', { app: m.app, sha: short });
      throw Object.assign(new AppError(`Its tests failed, so ${short} was not switched on:\n${test.output.slice(-1500)}`), { test });
    }
  }

  // 4. switch, atomically; keep the newest releases
  const sw = await sh(d, `cd ${sq(p.root)} && ln -sfn releases/${short} current.new && mv -T current.new current`
    + ` && ls -1t releases | tail -n +${KEEP_RELEASES + 1} | grep -v -x -e ${short} -e ${sq(previousSha?.slice(0, 12) ?? short)} | while read r; do rm -rf "releases/$r"; done`);
  if (sw.code !== 0) throw new AppError(`Could not switch to ${short}: ${(sw.stderr || sw.stdout).trim().slice(0, 300)}`);
  log('app.switched', { app: m.app, sha: short, previous: previousSha?.slice(0, 12) ?? null });

  // 5. its scheduled commands
  const tasks = await syncTasks(d, m);
  return { app: m.app, sha: rel.sha, previousSha, manifest: m, test, tasks };
}

/** Point `current` back at an earlier release that is still there. */
export async function switchTo(d: InstallDeps, m: AppManifest, sha: string): Promise<void> {
  const p = appPaths(m.app);
  const short = sha.slice(0, 12);
  const r = await sh(d, `cd ${sq(p.root)} && test -d releases/${short} && ln -sfn releases/${short} current.new && mv -T current.new current`);
  if (r.code !== 0) throw new AppError(`Release ${short} is no longer in the agent.`);
  await syncTasks(d, m);
}

/** OpenClaw command tasks named "<app>-<task>": the manifest's set, exactly. */
export async function syncTasks(d: InstallDeps, m: AppManifest): Promise<string[]> {
  const vars = appVars(m, d.facts);
  const list = await d.provider.exec(d.runtimeRef, ['cron', 'list', '--json'], { timeoutMs: 60_000 });
  let jobs: Array<{ id: string; name: string }> = [];
  try { jobs = (JSON.parse(list.stdout).jobs ?? []) as typeof jobs; } catch { /* none readable: add below */ }
  for (const j of jobs.filter((x) => x.name?.startsWith(`${m.app}-`))) {
    await d.provider.exec(d.runtimeRef, ['cron', 'rm', j.id], { timeoutMs: 60_000 });
  }
  const made: string[] = [];
  for (const t of m.tasks) {
    const argv = ['cron', 'add', '--name', `${m.app}-${t.name}`, '--agent', d.facts.slug,
      ...(t.every ? ['--every', t.every] : ['--cron', t.cron!, '--tz', d.facts.timezone]),
      '--command-argv', JSON.stringify(t.command.map((a) => expand(a, vars))),
      '--command-cwd', vars.app_dir,
      ...Object.entries(vars.envMap).flatMap(([k, v]) => ['--command-env', `${k}=${v}`]),
      '--timeout-seconds', String(t.timeoutSeconds ?? 300), '--no-deliver', '--json'];
    const r = await d.provider.exec(d.runtimeRef, argv, { timeoutMs: 60_000 });
    if (r.code !== 0) throw new AppError(`Could not schedule ${m.app}-${t.name}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    made.push(`${m.app}-${t.name}`);
  }
  return made;
}

/** Take its tasks off; the code and data stay on the volume. */
export async function removeTasks(d: InstallDeps, app: string): Promise<number> {
  const list = await d.provider.exec(d.runtimeRef, ['cron', 'list', '--json'], { timeoutMs: 60_000 });
  let jobs: Array<{ id: string; name: string }> = [];
  try { jobs = (JSON.parse(list.stdout).jobs ?? []) as typeof jobs; } catch { return 0; }
  let n = 0;
  for (const j of jobs.filter((x) => x.name?.startsWith(`${app}-`))) {
    const r = await d.provider.exec(d.runtimeRef, ['cron', 'rm', j.id], { timeoutMs: 60_000 });
    if (r.code === 0) n++;
  }
  return n;
}
