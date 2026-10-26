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
import type { ExecResult, RuntimeProvider } from '../providers/provider.js';
import { SimulatedCrash } from './operations.js';

export const MANIFEST_FILE = 'hatchabot.json';
export const APPS_ROOT = '/home/node/.openclaw/apps';
const KEEP_RELEASES = 3;
const MAX_TAR_BYTES = 100 * 1024 * 1024;

// -- the manifest ---------------------------------------------------------------------
const FROM = ['agent.openclawId', 'agent.telegramAccount', 'agent.name', 'owner.telegram', 'owner.email', 'host.timezone'] as const;
const field = z.object({
  // "__proto__" is not a key an object can hold: assigning it set the config's
  // prototype, and a required value was accepted and then not there (review R13, 2026-10-23).
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).refine((k) => k !== '__proto__', { message: 'a field cannot be keyed "__proto__"' }),
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
}).superRefine((m, ctx) => {
  // One of each: a second task of one name was scheduled too (two runs of one
  // job, #75), and a second field of one key overwrote the first's value (#104).
  const twice = (names: string[]) => [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  for (const n of twice(m.tasks.map((t) => t.name))) ctx.addIssue({ code: 'custom', path: ['tasks'], message: `two tasks are named "${n}"` });
  for (const k of twice((m.config?.fields ?? []).map((f) => f.key))) ctx.addIssue({ code: 'custom', path: ['config', 'fields'], message: `two fields have the key "${k}"` });
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

/** Where the mirror of a git address is kept. */
export const mirrorDir = (cacheDir: string, url: string): string =>
  join(cacheDir, createHash('sha256').update(url).digest('hex').slice(0, 16) + '.git');

/** The local repository to read from: the folder itself, or a mirror of the URL kept beside the database. */
export async function repoFor(git: Git, src: AppSource, cacheDir: string): Promise<string> {
  if (src.kind === 'dir') {
    if (!existsSync(src.path)) throw new AppError(`No folder at ${src.path}.`);
    const r = await git(['-C', src.path, 'rev-parse', '--git-dir']);
    if (r.code !== 0) throw new AppError(`${src.path} is not a git repository.`);
    return src.path;
  }
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const dir = mirrorDir(cacheDir, src.url);
  const r = existsSync(dir)
    ? await git(['-C', dir, 'fetch', '--prune', '--force', 'origin', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'])
    : await git(['clone', '--mirror', '--', src.url, dir]);
  if (r.code !== 0) throw new AppError(`Could not fetch ${src.url}: ${r.stderr.trim().split('\n').pop() ?? 'git failed'}`);
  // A fetch moves the branches, not the mirror's HEAD: once the repo's
  // default branch was renamed (main → trunk) HEAD named a branch the prune
  // removed, and Update said there was no commit (review, 2026-10-22).
  const head = await git(['-C', dir, 'ls-remote', '--symref', 'origin', 'HEAD']);
  const def = head.code === 0 ? /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(head.stdout.toString())?.[1] : undefined;
  if (def) await git(['-C', dir, 'symbolic-ref', 'HEAD', def]);
  return dir;
}

/** A ref to its commit and the manifest there, without the files. */
export async function manifestAt(git: Git, repo: string, ref = 'HEAD'): Promise<{ sha: string; manifest: AppManifest }> {
  if (!/^[A-Za-z0-9._\/^~-]{1,200}$/.test(ref) || ref.startsWith('-')) throw new AppError(`Not a ref: ${ref}`);
  const rev = await git(['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`]);
  if (rev.code !== 0) throw new AppError(`No commit "${ref}" in the repo.`);
  const sha = rev.stdout.toString().trim();
  const man = await git(['-C', repo, 'show', `${sha}:${MANIFEST_FILE}`]);
  if (man.code !== 0) throw new AppError(`The repo has no ${MANIFEST_FILE} at ${sha.slice(0, 12)} (see docs/apps-in-agents.md).`);
  return { sha, manifest: parseManifest(man.stdout.toString()) };
}

export interface Resolved { sha: string; manifest: AppManifest; tar: Buffer }

/** A ref to its commit, the manifest at that commit, and the commit's files as a tarball. */
export async function resolveRelease(git: Git, repo: string, ref = 'HEAD'): Promise<Resolved> {
  const { sha, manifest } = await manifestAt(git, repo, ref);
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

/** What Hatchabot has no value for, when a required field is filled from it. */
const UNFILLED: Partial<Record<(typeof FROM)[number], string>> = {
  'agent.telegramAccount': 'the agent has no Telegram bot',
  'owner.telegram': "its owner has not linked a Telegram account (Settings → You)",
  'owner.email': "its owner's account has no email address",
};

/**
 * The config file's new contents: asked values, Hatchabot's facts, existing
 * values kept, defaults for the rest. A value given as '' clears an optional
 * field ('', [] for a list, null for a number or switch); left out, it keeps
 * the one it has (#76). A value that is not of its field's type throws (#77).
 * `unfilled`: required fields Hatchabot fills, with nothing to fill them
 * with (#78; an empty owner id became the app's recipient).
 */
export function mergeConfig(m: AppManifest, facts: AgentFacts, existing: Record<string, unknown>, values: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...existing };
  const missing: string[] = [];
  /** The keys of `missing`, for a form that asks for them. */
  const missingKeys: string[] = [];
  const unfilled: string[] = [];
  const invalid: string[] = [];
  const fact: Record<(typeof FROM)[number], unknown> = {
    'agent.openclawId': facts.slug, 'agent.telegramAccount': facts.telegramAccount ?? '', 'agent.name': facts.name,
    'owner.telegram': facts.ownerTelegram ?? '', 'owner.email': facts.ownerEmail ?? '', 'host.timezone': facts.timezone,
  };
  for (const f of m.config?.fields ?? []) {
    if (f.from) {
      out[f.key] = fact[f.from];
      if (f.required && !String(fact[f.from] ?? '').trim()) unfilled.push(`${f.key} (${UNFILLED[f.from] ?? `no ${f.from}`})`);
      continue;
    }
    const given = Object.prototype.hasOwnProperty.call(values, f.key) && values[f.key] !== undefined;
    const cleared = given && typeof values[f.key] === 'string' && !(values[f.key] as string).trim();
    if (given && !cleared) {
      const v = coerce(f.type, values[f.key]);
      if (v === INVALID) invalid.push(`${f.key} must be ${TYPE_WORD[f.type ?? 'text']} (got ${JSON.stringify(values[f.key]).slice(0, 60)})`);
      // A required list given as [] is no value, as '' is for text: it was
      // written, and the app ran with no recipients (review R03, 2026-10-23).
      else if (f.required && blank(v)) { missing.push(f.label ? `${f.key} (${f.label})` : f.key); missingKeys.push(f.key); }
      else out[f.key] = v;
    } else if (cleared && !f.required) out[f.key] = f.type === 'list' ? [] : f.type === 'number' || f.type === 'bool' ? null : '';
    // Kept: an own value (a key named "constructor" read Object's and was
    // never written), unless the field is required now and it is blank
    // (an optional field made required kept its '' unasked). Review, 2026-10-22.
    else if (Object.hasOwn(out, f.key) && out[f.key] !== undefined && !(f.required && blank(out[f.key]))) {
      // Held to the field's type NOW: an update that made a text field a number
      // kept "abc" under it unasked (review R04, 2026-10-23). A value the new
      // type refuses is asked for again, not thrown: it was valid when given.
      // A secret field's value is kept as it is. An optional one's is cleared.
      const kept = f.type && !f.secret ? coerce(f.type, out[f.key]) : out[f.key];
      if (kept !== INVALID) out[f.key] = kept;
      else if (f.required) { delete out[f.key]; missing.push(f.label ? `${f.key} (${f.label})` : f.key); missingKeys.push(f.key); }
      else out[f.key] = f.type === 'list' ? [] : f.type === 'number' || f.type === 'bool' ? null : '';
      continue;
    }
    else if (f.default !== undefined) {
      // The default is held to its field's type like a value given: "abc"
      // for a number was written as it was. '' and null stay "no value".
      const d = f.default === '' || f.default === null ? f.default : coerce(f.type, f.default);
      if (d === INVALID) invalid.push(`the app's default for ${f.key} is not ${TYPE_WORD[f.type ?? 'text']} (${JSON.stringify(f.default).slice(0, 60)}; its ${MANIFEST_FILE} needs fixing)`);
      else if (f.required && blank(d)) { missing.push(f.label ? `${f.key} (${f.label})` : f.key); missingKeys.push(f.key); }
      else out[f.key] = d;
    } else if (f.required) { missing.push(f.label ? `${f.key} (${f.label})` : f.key); missingKeys.push(f.key); }
  }
  if (invalid.length) throw new AppError(`Not a valid value: ${invalid.join('; ')}.`);
  return { config: out, missing, missingKeys, unfilled };
}

/**
 * Every value the config holds under a secret field (each item of a list),
 * longest first, as written and as it appears inside JSON. A value under
 * four characters is left: masking it would garble the output, not hide a key.
 */
export function secretValues(m: AppManifest, config: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const f of m.config?.fields ?? []) {
    if (!f.secret) continue;
    const v = config[f.key];
    for (const x of Array.isArray(v) ? v : [v]) {
      if (typeof x !== 'string' && typeof x !== 'number') continue;
      for (const s of [String(x), String(x).trim(), JSON.stringify(String(x)).slice(1, -1)]) if (s.trim().length >= 4) out.add(s);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** `text` with every one of `secrets` replaced by a mask (an app's tests may print a key they were given). */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((t, s) => t.split(s).join('••••••'), text);
}

const INVALID = Symbol('invalid');
const blank = (v: unknown) => v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
const TYPE_WORD: Record<string, string> = { number: 'a number', bool: 'true or false', list: 'a list (a, b, c)', email: 'an email address', text: 'text' };

/** A value as its field's type, or INVALID ("abc" for a number became NaN, written as null). */
function coerce(type: string | undefined, v: unknown): unknown {
  const s = typeof v === 'string' ? v.trim() : undefined;
  switch (type) {
    case 'number': {
      const n = s !== undefined ? (s === '' ? NaN : Number(s)) : v;
      return typeof n === 'number' && Number.isFinite(n) ? n : INVALID;
    }
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (s !== undefined && /^(1|true|yes|on)$/i.test(s)) return true;
      if (s !== undefined && /^(0|false|no|off)$/i.test(s)) return false;
      return INVALID;
    case 'list':
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
      return s !== undefined ? s.split(',').map((x) => x.trim()).filter(Boolean) : INVALID;
    case 'email':
      return s !== undefined && /^[^\s@]+@[^\s@]+$/.test(s) ? v : INVALID;
    case 'text':
      return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? (typeof v === 'string' ? v : String(v)) : INVALID;
    default:
      return v;
  }
}

export interface Installed { app: string; sha: string; previousSha?: string; manifest: AppManifest; test?: { ok: boolean; output: string }; tasks: string[] }

export interface InstallDeps {
  provider: RuntimeProvider;
  runtimeRef: string;
  facts: AgentFacts;
  log?: (step: string, detail?: Record<string, unknown>) => void;
  /** The operation's record (operations.ts): each step as it is done (appOperations.ts). */
  step?: (key: string) => void;
  /**
   * Judges the config about to be staged: the values given merged with the
   * file already in the agent, the manifest's defaults and Hatchabot's facts,
   * so what is judged is what the app will run with (the values alone missed
   * a mailbox that came from a default or the old file). `existing` is the
   * file as it was. Throwing stops the install before anything live changes.
   */
  checkConfig?: (config: Record<string, unknown>, existing: Record<string, unknown>) => void;
  /** The app record's release (agent_apps): its manifest stands in when the live release's copy cannot be read. */
  recorded?: { app: string; sha: string; manifest: unknown };
}

async function sh(d: InstallDeps, script: string, timeoutMs = 60_000) {
  return d.provider.execShell(d.runtimeRef, script, { timeoutMs });
}

/**
 * Where `current` points now, as the link says it ('' when not installed).
 * Only a link that is not there is "not installed": one that cannot be read
 * throws. Read as none, a failed update "put back" no release by removing
 * `current` (#103).
 */
async function currentLink(d: InstallDeps, app: string): Promise<string> {
  const c = sq(appPaths(app).current);
  const r = await sh(d, `if [ -L ${c} ]; then readlink ${c}; elif [ -e ${c} ]; then echo "it is not a link" >&2; exit 1; fi`);
  if (r.code !== 0) throw new AppError(`Could not tell which release of ${app} is live (${errText(r) || 'no output'}), so nothing was changed. Try again.`);
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

/** The live release's manifest: its file on the volume, else the app record's when it is that release. */
async function liveManifest(d: InstallDeps, app: string, short: string): Promise<AppManifest | undefined> {
  const onVolume = await releaseManifest(d, `${appPaths(app).releases}/${short}`);
  if (onVolume?.app === app) return onVolume;
  const r = d.recorded;
  if (!r || r.app !== app || !r.sha.startsWith(short)) return undefined;
  const parsed = manifestSchema.safeParse(r.manifest);
  return parsed.success && parsed.data.app === app ? parsed.data : undefined;
}

const errText = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().slice(0, 300);

/**
 * How a failed install or update left the agent, on its error for the routes
 * and the page: `unchanged` (nothing live changed, or all of it was put back
 * and confirmed) or `held` (it could not be put back; the operation waits for
 * a choice). Neither: it may not be as it was, and the message says what to
 * check. The page said "the running version is unchanged" either way (#97).
 */
export type AppOutcome = { unchanged?: boolean; held?: boolean };
export function outcome<E>(e: E, o: AppOutcome): E {
  if (e && typeof e === 'object') Object.assign(e, o);
  return e;
}

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
  // The tasks the live release scheduled come off by its manifest, so it is
  // read before anything changes. Read as none (unreadable, corrupt), an update
  // that renamed or dropped a task left the old job running beside the new
  // release and said it had succeeded (audit #011). The app record's copy
  // stands in for the one on the volume; with neither, nothing is changed.
  const before = previousSha ? await liveManifest(d, m.app, previousSha) : undefined;
  if (previousSha && !before) {
    throw outcome(new AppError(`Could not read the ${MANIFEST_FILE} of the release running now (${previousSha}), so its scheduled tasks could not be told apart from the new ones. Nothing was changed. Stop the app (its tasks come off) and install it again.`), { unchanged: true });
  }
  const name = m.config?.file ?? 'config.json';
  const live = `${p.data}/${name}`;
  const staged = `${stage}/${name}`;
  const step = d.step ?? (() => {});
  let switching = false;
  let crashed = false;
  let keepStaging = false;
  /** The secret fields' values, masked in the tests' output before it is kept anywhere. */
  let secrets: string[] = [];
  try {
    // 1. the code, and an empty staging folder for its data while it is tested.
    // The same commit as the live one (a change of values only) keeps the live
    // folder: unpacking over it removed the running code, and anything its
    // tests had built in it, before the new values were even tested (#92).
    const sameRelease = previousLink === `releases/${short}`;
    log('app.unpack', { app: m.app, sha: short, ...(sameRelease ? { kept: true } : {}) });
    const folders = `mkdir -p ${sq(p.data)} && rm -rf ${sq(stage)} && mkdir -p ${sq(stage)}`;
    const un = sameRelease
      ? await sh(d, `{ test -d ${sq(dir)} || { echo "its live release folder ${dir} is missing" >&2; exit 1; }; } && ${folders}`)
      : await d.provider.writeToVolume(d.runtimeRef,
        ['sh', '-c', `rm -rf ${sq(dir)}.tmp && mkdir -p ${sq(dir)}.tmp && tar -x -C ${sq(dir)}.tmp && rm -rf ${sq(dir)} && mv ${sq(dir)}.tmp ${sq(dir)} && ${folders}`],
        rel.tar);
    if (un.code !== 0) throw new AppError(`Could not unpack the code: ${errText(un)}`);
    step('unpacked');

    // 2. the config, staged: the live file is not touched until the switch
    if (m.config) {
      // No file is an empty config; one that cannot be read stops it. Read as
      // empty, the defaults were written over the owner's settings (#105).
      const read = await sh(d, `if [ -e ${sq(live)} ]; then cat ${sq(live)}; fi`);
      if (read.code !== 0) throw new AppError(`Could not read ${live} in the agent (${errText(read) || 'no output'}), so its settings were left as they are. Check it, then try again.`);
      let existing: Record<string, unknown> = {};
      try { existing = read.stdout.trim() ? JSON.parse(read.stdout) : {}; } catch { throw new AppError(`${live} in the agent is not valid JSON; fix or remove it.`); }
      const { config, missing, missingKeys, unfilled } = mergeConfig(m, d.facts, existing, values);
      if (missing.length) {
        // The fields too, so the page can ask for them: its Update sends no
        // values, and a field made required (or a required one an older
        // version left blank) had no way in from it (final audit, 2026-10-22).
        const e = new AppError(`Needs a value for: ${missing.join(', ')} (give them as key=value).`);
        (e as AppError & { needs?: unknown }).needs = fieldsToAsk(m).filter((f) => missingKeys.includes(f.key))
          .map((f) => ({ key: f.key, ...(f.label ? { label: f.label } : {}), ...(f.type ? { type: f.type } : {}), ...(f.secret ? { secret: true } : {}) }));
        throw e;
      }
      if (unfilled.length) throw new AppError(`Hatchabot has nothing to fill ${unfilled.join(', ')} with; set that up, then try again.`);
      d.checkConfig?.(config, existing);
      secrets = secretValues(m, config);
      const w = await d.provider.writeToVolume(d.runtimeRef,
        ['sh', '-c', `umask 077 && cat > ${sq(staged)}`], Buffer.from(JSON.stringify(config, null, 2) + '\n'));
      if (w.code !== 0) throw new AppError(`Could not write ${staged}.`);
    }
    step('configured');

    // 3. its tests: the new release, with its env, {data_dir} = the staged folder (the new config, none of the live data)
    let test: Installed['test'];
    if (m.test?.length) {
      log('app.test', { app: m.app, sha: short });
      // The same commit's tests run in a copy of the live folder (what they
      // built before comes along): run in the live one, a test that wrote
      // there and then failed left the change live, "unchanged" (review,
      // 2026-10-22).
      const testDir = sameRelease ? `${stage}-code` : dir;
      if (sameRelease) {
        const cp = await sh(d, `rm -rf ${sq(testDir)} && cp -a ${sq(dir)} ${sq(testDir)}`);
        if (cp.code !== 0) throw new AppError(`Could not copy the release to test it: ${errText(cp)}`);
      }
      const tv = appVars(m, d.facts, { app_dir: testDir, data_dir: stage });
      const envStr = Object.entries(tv.envMap).map(([k, v]) => `${k}=${sq(v)}`).join(' ');
      const r = await sh(d, `cd ${sq(testDir)} && env ${envStr} ${m.test.map((a) => sq(expand(a, tv))).join(' ')} 2>&1`, 15 * 60_000);
      // Masked whole, then cut: a cut first could leave half a secret at its edge.
      test = { ok: r.code === 0, output: maskSecrets(r.stdout + r.stderr, secrets).slice(-3000) };
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
    if (!switching) throw outcome(e, { unchanged: true });
    // Put the previous release back: its config (when this one was moved in; the
    // new one goes back to staging first, so "Use the new release" still has it)
    // and `current`.
    const cfgBack = m.config
      ? `if [ ! -e ${sq(staged)} ]; then if [ -f ${sq(`${staged}.prev`)} ]; then { cp -p ${sq(live)} ${sq(staged)} && mv -f ${sq(`${staged}.prev`)} ${sq(live)}; } || rc=1;`
        + ` elif [ -f ${sq(`${staged}.none`)} ]; then { cp -p ${sq(live)} ${sq(staged)} && rm -f ${sq(live)}; } || rc=1; fi; fi; `
      : '';
    const back = await sh(d, `rc=0; ${cfgBack}{ ${pointBack(p, previousLink)}; } || rc=1; exit $rc`)
      .catch((err: unknown) => ({ code: 1, stdout: '', stderr: (err as Error)?.message ?? String(err) }));
    log(back.code === 0 ? 'app.restored' : 'app.restore_failed', { app: m.app, sha: short, previous: previousSha ?? null });
    // Not put back: the staging folder is what a recovery needs (the config it
    // replaced, and the new one), so it stays, and the operation is held for the
    // owner's choice (appOperations.ts). It was deleted all the same (#106).
    keepStaging = back.code !== 0;
    const said = back.code === 0
      ? (previousSha ? ` ${previousSha} is running as before, with its configuration.` : ' Nothing was left switched on.')
      : ` Putting ${previousSha ?? 'the agent'} back failed too (${errText(back) || 'no output'}). It waits for your choice on its page: use the new release, or go back to the previous one.`;
    if (e instanceof Error) e.message += said;
    throw outcome(e, back.code === 0 ? { unchanged: !(e as { tasksUnconfirmed?: boolean })?.tasksUnconfirmed } : { held: true });
  } finally {
    if (!crashed && !keepStaging) await clearStaging(d, m.app, short);
  }
}

/** Where an install stages a release's data while it is tested ({data_dir} for its tests, the config's way in). */
export function stagingDir(app: string, short: string): string {
  return `${appPaths(app).root}/staging/${short}`;
}

/** Remove a release's staging folder (and the staging folder when empty); never throws. */
export async function clearStaging(d: InstallDeps, app: string, short?: string): Promise<void> {
  const root = appPaths(app).root;
  const what = short ? `${sq(stagingDir(app, short))} ${sq(`${stagingDir(app, short)}-code`)}` : `${sq(`${root}/staging`)}/*`;
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

/** `enabled` as `cron list` gives it: false for a task the owner turned off. */
type Job = { id: string; name: string; enabled?: boolean };

/** The job names an app's manifests make: "<app>-<task>", exactly. */
export function appTaskNames(...ms: Array<AppManifest | undefined>): Set<string> {
  return new Set(ms.flatMap((m) => (m ? m.tasks.map((t) => `${m.app}-${t.name}`) : [])));
}

/**
 * The agent's jobs with one of `names` (appTaskNames), disabled ones too
 * (`--all`: a disabled app task was invisible to Update and Stop app and
 * stayed behind, #73); throws when the list cannot be read (a sync must know
 * what is there). Only the app's own jobs must be whole: an unnamed job of the
 * agent's own is none of its business (it blocked every app change, #74). The
 * names, not a "<app>-" prefix: the owner's own task "news-digest" was taken
 * off with app "news" (audit, 2026-10-20).
 */
export async function appJobs(d: InstallDeps, names: ReadonlySet<string>): Promise<Job[]> {
  const list = await d.provider.exec(d.runtimeRef, ['cron', 'list', '--all', '--json'], { timeoutMs: 60_000 });
  if (list.code !== 0) throw new AppError(`Could not read the agent's scheduled tasks: ${errText(list)}`);
  let jobs: unknown;
  try { jobs = JSON.parse(list.stdout).jobs; } catch { throw new AppError("The agent's scheduled tasks did not read as JSON."); }
  if (!Array.isArray(jobs) || jobs.some((j) => !j || typeof j !== 'object')) throw new AppError("The agent's scheduled task list is incomplete or malformed. Try again.");
  const mine = (jobs as Array<{ id?: unknown; name?: unknown }>).filter((x) => typeof x.name === 'string' && names.has(x.name));
  if (mine.some((j) => typeof j.id !== 'string')) throw new AppError("The agent's scheduled task list is incomplete or malformed. Try again.");
  return mine as Job[];
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
  // A call that rejects (the daemon gone mid-way) is a failed call: thrown, it
  // left the replacement jobs already made beside the old ones (review R05, 2026-10-23).
  const run = (argv: string[]): Promise<ExecResult> => d.provider.exec(d.runtimeRef, argv, { timeoutMs: 60_000 })
    .catch((err: unknown): ExecResult => ({ code: 1, stdout: '', stderr: String((err as Error)?.message ?? err) }));
  const prev = previous?.app === m.app ? previous : undefined;
  const ours = appTaskNames(m, prev);
  const old = await appJobs(d, ours);
  const oldIds = new Set(old.map((j) => j.id));
  /** Put the old set back; what is still wrong after a fresh list ([] = confirmed as it was). */
  const putBack = async (): Promise<string[]> => {
    const unread = (e: unknown) => [`the list could not be read (${(e as Error)?.message ?? e})`];
    let now: Job[];
    try { now = await appJobs(d, ours); } catch (e) { return unread(e); }
    const seen = new Set(now.map((j) => j.id));
    for (const j of now.filter((x) => !oldIds.has(x.id))) await run(['cron', 'rm', j.id]);
    // One the owner had turned off goes back off: re-added switched on, it
    // ran work they had stopped, and the count below still said "as they
    // were" (audit #016).
    for (const j of old.filter((x) => !seen.has(x.id))) {
      const t = prev?.tasks.find((x) => `${m.app}-${x.name}` === j.name);
      if (t) await run([...addArgv(d, prev!, t), ...(j.enabled === false ? ['--disabled'] : [])]);
    }
    let after: Job[];
    try { after = await appJobs(d, ours); } catch (e) { return unread(e); }
    // Listed before the put-back and not in the old set: a new job that would not come off.
    // Not listed before: added by the put-back, whatever its add answered.
    const stray = after.filter((j) => seen.has(j.id) && !oldIds.has(j.id)).map((j) => j.name);
    const off = (j: Job) => j.enabled === false;
    const count = (jobs: Job[]) => jobs.reduce((n, j) => n.set(j.name, (n.get(j.name) ?? 0) + 1), new Map<string, number>());
    const kept = after.filter((j) => oldIds.has(j.id) || !seen.has(j.id));
    const want = count(old);
    const have = count(kept);
    const missing = [...want].filter(([name, n]) => (have.get(name) ?? 0) < n).map(([name]) => name);
    const twice = [...have].filter(([name, n]) => n > (want.get(name) ?? 0)).map(([name]) => name);
    // As many of each turned off as before (those counted above aside).
    const offWant = count(old.filter(off));
    const offHave = count(kept.filter(off));
    const named = new Set([...missing, ...twice]);
    const switchedOn = [...offWant].filter(([name, n]) => !named.has(name) && (offHave.get(name) ?? 0) < n).map(([name]) => name);
    const switchedOff = [...offHave].filter(([name, n]) => !named.has(name) && n > (offWant.get(name) ?? 0)).map(([name]) => name);
    return [
      ...(stray.length ? [`still there: ${stray.join(', ')}`] : []),
      ...(missing.length ? [`not re-added: ${missing.join(', ')}`] : []),
      ...(twice.length ? [`more than once: ${twice.join(', ')}`] : []),
      ...(switchedOn.length ? [`switched on, though you had turned it off: ${switchedOn.join(', ')}`] : []),
      ...(switchedOff.length ? [`turned off, though it was on: ${switchedOff.join(', ')}`] : []),
    ];
  };
  const fail = async (what: string) => {
    const problems = await putBack();
    return Object.assign(new AppError(`${what} ${problems.length
      ? `Its scheduled tasks could not be confirmed: ${problems.join('; ')}. Check them with \`openclaw cron list --all\` in the agent's console (jobs named ${m.app}-…), then Update or Roll back again.`
      : 'Its tasks are as they were.'}`), { tasksUnconfirmed: problems.length > 0 });
  };

  const made: string[] = [];
  // A task the owner turned off stays off in the new version: re-added
  // switched on, an Update ran work they had stopped (HB-0229). Off when
  // every old job of that name was.
  const offBefore = (name: string) => old.some((j) => j.name === name) && old.filter((j) => j.name === name).every((j) => j.enabled === false);
  for (const t of m.tasks) {
    const r = await run([...addArgv(d, m, t), ...(offBefore(`${m.app}-${t.name}`) ? ['--disabled'] : [])]);
    if (r.code !== 0) throw await fail(`Could not schedule ${m.app}-${t.name}: ${errText(r)}.`);
    made.push(`${m.app}-${t.name}`);
  }
  for (const j of old) {
    const r = await run(['cron', 'rm', j.id]);
    if (r.code !== 0) throw await fail(`Could not take off the old task ${j.name}: ${errText(r)}.`);
  }
  return made;
}

/** Take its tasks off (those its manifests `ms` make); the code and data stay on the volume. */
export async function removeTasks(d: InstallDeps, app: string, ...ms: Array<AppManifest | undefined>): Promise<number> {
  const names = appTaskNames(...ms);
  const jobs = await appJobs(d, names);
  for (const j of jobs) {
    // A lost response may mean it was removed. The fresh list decides.
    await d.provider.exec(d.runtimeRef, ['cron', 'rm', j.id], { timeoutMs: 60_000 }).catch(() => undefined);
  }
  const left = await appJobs(d, names);
  if (left.length) throw new AppError(`Could not remove ${app}'s scheduled tasks: ${left.map((j) => j.name).join(', ')} remain. Try again; the app record has been kept.`);
  return jobs.length;
}
