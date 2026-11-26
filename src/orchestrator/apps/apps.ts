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
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import type { ExecResult, RuntimeProvider } from '../../providers/provider.js';
import { SimulatedCrash } from '../lifecycle/operations.js';
import { keyedLock } from '../../util/queues.js';

export const MANIFEST_FILE = 'hatchabot.json';
export const APPS_ROOT = '/home/node/.openclaw/apps';
const KEEP_RELEASES = 3;
/** A release folder's name as the shell matches it: its commit's first 12 hex digits. */
const RELEASE_GLOB = '[0-9a-f]'.repeat(12);
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

/**
 * A git call's answer. `noExit` is set when git gave no exit status of its
 * own (it could not start, was killed, or wrote more than the buffer holds),
 * saying which; `code` is then 1. Only a status git gave says what git found.
 */
export type GitResult = { code: number; stdout: Buffer; stderr: string; noExit?: string };
export type Git = (args: string[], cwd?: string) => Promise<GitResult>;

/**
 * git on this machine. Its messages in English whatever the host's language
 * (`LC_ALL=C` wins over LANG and LANGUAGE): a half-made mirror is told by
 * git's "not a git repository", which a German, French or Spanish host had
 * translated, so it was never cloned again (HB-0946). The machine's own
 * attributes file (/etc/gitattributes) is not read: it could change what a
 * release is packed as (HB-1017).
 *
 * A run is stopped after `timeoutMs`; its `noExit` then says it timed out
 * (it read as the signal that stopped it: "git archive failed: SIGTERM").
 */
export function gitOnHost(timeoutMs = 120_000): Git {
  return (args, cwd) => new Promise((done) => {
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: MAX_TAR_BYTES + 1024 * 1024, timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_ATTR_NOSYSTEM: '1' } }, (err, stdout, stderr) => {
      const e = err as { code?: number | string | null; signal?: string | null; killed?: boolean } | null;
      const exited = !e || (typeof e.code === 'number' && !e.signal);
      // Stopped by this call, with no code of its own: the timeout (output over the buffer has one).
      const why = !e || exited ? undefined
        : typeof e.code === 'string' ? e.code
        : e.killed && e.signal ? `timed out after ${timeoutMs / 1000} s`
        : e.signal || 'git did not finish';
      done({ code: e ? (exited ? (e.code as number) : 1) : 0,
        stdout: stdout as Buffer, stderr: String(stderr ?? ''),
        ...(why ? { noExit: why } : {}) });
    });
  });
}
export const hostGit: Git = gitOnHost();

/** Where the mirror of a git address is kept. */
export const mirrorDir = (cacheDir: string, url: string): string =>
  join(cacheDir, createHash('sha256').update(url).digest('hex').slice(0, 16) + '.git');

/**
 * One read of a mirror at a time, by its folder (docs/architecture.md,
 * "In-memory state, sorted"): two inspections of a new address both found no
 * mirror and both cloned into it, and the later one failed; one could also
 * fetch from a mirror whose clone had not finished (HB-0946). Each read waits
 * for the one before it, however that one ended.
 */
const mirrorTurns = keyedLock();
function inMirrorTurn<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return mirrorTurns.run(dir, fn);
}

/**
 * The git folder of a repository, as every read of it names it. Named, not
 * run in (`-C`): git takes a folder that is not a repository for the one
 * around it, so a half-made mirror folder inside a checkout had its fetch move
 * that checkout's branches and HEAD, and its reads give that checkout's
 * manifest (HB-0946). Here it is refused, "not a git repository".
 */
const gitDir = (repo: string): string[] => ['--git-dir', repo];

/**
 * The repository to read from, as its git folder: the folder's own (found
 * from it, as git does for a folder the owner names), or a mirror of the URL
 * kept beside the database.
 */
export async function repoFor(git: Git, src: AppSource, cacheDir: string): Promise<string> {
  if (src.kind === 'dir') {
    if (!existsSync(src.path)) throw new AppError(`No folder at ${src.path}.`);
    const r = await git(['-C', src.path, 'rev-parse', '--git-dir']);
    if (r.code !== 0) throw new AppError(`${src.path} is not a git repository.`);
    return resolvePath(src.path, r.stdout.toString().trim());
  }
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const dir = mirrorDir(cacheDir, src.url);
  return inMirrorTurn(dir, () => refreshMirror(git, src.url, dir));
}

/**
 * Cloned beside the mirror's folder and moved into place whole: a mirror
 * folder is only ever a finished clone, and one cut off leaves only its own
 * folder.
 */
async function cloneMirror(git: Git, url: string, dir: string): Promise<GitResult> {
  const cloning = `${dir}.cloning`;
  rmSync(cloning, { recursive: true, force: true });
  const r = await git(['clone', '--mirror', '--', url, cloning]);
  if (r.code === 0) renameSync(cloning, dir);
  else rmSync(cloning, { recursive: true, force: true });
  return r;
}

/**
 * Whether git says a mirror's folder is half made: not a repository, or one
 * with nowhere to fetch from. One the earlier code left half cloned in place
 * (cut off before the clone made it a repository, or gave it its origin) is,
 * so every fetch on it failed, and so did every read of the address
 * (HB-0946). Only git's own answer counts: a check that could not run (a
 * spawn failure under load, a kill) or failed some other way keeps a whole
 * mirror, which was removed for it.
 */
async function isHalfMadeMirror(git: Git, dir: string): Promise<boolean> {
  const at = await git([...gitDir(dir), 'rev-parse', '--git-dir']);
  if (at.code !== 0) return at.code === 128 && !at.noExit && /^fatal: not a git repository\b/m.test(at.stderr);
  // `config --get` exits 1, and only 1, for a key that is not set.
  const origin = await git([...gitDir(dir), 'config', '--local', '--get', 'remote.origin.url']);
  if (origin.code !== 0) return origin.code === 1 && !origin.noExit;
  return origin.stdout.toString().trim() === '';
}

async function refreshMirror(git: Git, url: string, dir: string): Promise<string> {
  let r: GitResult;
  if (existsSync(dir)) {
    r = await git([...gitDir(dir), 'fetch', '--prune', '--force', 'origin', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*']);
    // A fetch that failed on a folder that is no mirror is a clone cut off:
    // it is cloned again, in this turn. A whole mirror is kept whatever the
    // fetch said (the address may only be out of reach for now).
    if (r.code !== 0 && (await isHalfMadeMirror(git, dir))) {
      rmSync(dir, { recursive: true, force: true });
      r = await cloneMirror(git, url, dir);
    }
  } else {
    r = await cloneMirror(git, url, dir);
  }
  if (r.code !== 0) throw new AppError(`Could not fetch ${url}: ${r.stderr.trim().split('\n').pop() ?? 'git failed'}`);
  // A fetch moves the branches, not the mirror's HEAD: once the repo's
  // default branch was renamed (main → trunk) HEAD named a branch the prune
  // removed, and Update said there was no commit (review, 2026-10-22).
  const head = await git([...gitDir(dir), 'ls-remote', '--symref', 'origin', 'HEAD']);
  const def = head.code === 0 ? /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(head.stdout.toString())?.[1] : undefined;
  if (def) await git([...gitDir(dir), 'symbolic-ref', 'HEAD', def]);
  return dir;
}

/** A ref to its commit and the manifest there, without the files (`repo` is its git folder, from repoFor). */
export async function manifestAt(git: Git, repo: string, ref = 'HEAD'): Promise<{ sha: string; manifest: AppManifest }> {
  if (!/^[A-Za-z0-9._\/^~-]{1,200}$/.test(ref) || ref.startsWith('-')) throw new AppError(`Not a ref: ${ref}`);
  const rev = await git([...gitDir(repo), 'rev-parse', '--verify', `${ref}^{commit}`]);
  if (rev.code !== 0) throw new AppError(`No commit "${ref}" in the repo.`);
  const sha = rev.stdout.toString().trim();
  const man = await git([...gitDir(repo), 'show', `${sha}:${MANIFEST_FILE}`]);
  if (man.code !== 0) throw new AppError(`The repo has no ${MANIFEST_FILE} at ${sha.slice(0, 12)} (see docs/apps-in-agents.md).`);
  return { sha, manifest: parseManifest(man.stdout.toString()) };
}

export interface Resolved { sha: string; manifest: AppManifest; tar: Buffer }

/**
 * A commit's files as a tarball, held to the size limit. Made only for an
 * install that goes ahead: an inspection, or an Update with nothing new,
 * packed the whole repository to read its manifest (HB-1017).
 *
 * The size is judged first: git's output stops at the buffer (the limit and
 * 1 MB), so code over that ended as a failure with nothing from git, refused
 * as "git archive failed: ". Its size is not said: it is not known past the
 * buffer, and rounded it read "100 MB" for code just over the limit.
 *
 * Packed as the commit holds it, whatever this machine's git is set to: line
 * endings turned to CRLF by a global `core.autocrlf` or `core.eol`, or by the
 * user's attributes file, made the release other bytes than the commit's,
 * and bigger than codeSizeBound counts (HB-1017).
 */
const AS_COMMITTED = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.attributesFile=/dev/null'];
export async function releaseTar(git: Git, repo: string, sha: string): Promise<Buffer> {
  const tar = await git([...AS_COMMITTED, ...gitDir(repo), 'archive', '--format=tar', sha]);
  const mb = MAX_TAR_BYTES / 1048576;
  if (tar.stdout.length > MAX_TAR_BYTES) throw new AppError(`The code is over ${mb} MB; apps are limited to ${mb} MB.`);
  if (tar.code !== 0) throw new AppError(`git archive failed: ${tar.stderr.trim() || tar.noExit || `exit ${tar.code}`}`);
  return tar.stdout;
}

/**
 * The most the tarball of a commit can be, from its file list, as `git
 * archive` writes it: a global header with the commit id (1024 bytes); for
 * each file, folder, link and submodule a 512-byte header, a pax header
 * before it for a name (a folder's with its "/") or link target over 100
 * bytes, and a file's bytes in 512-byte blocks; then two zero blocks, padded
 * to a 10240-byte record. Never under the real length: a count that left out
 * the headers and the padding let code just under the limit through an
 * inspection, refused at the install (HB-1017).
 *
 * None when the list cannot be read, or when attributes can change what is
 * packed (a `.gitattributes` anywhere in the commit, or the repository's own
 * `info/attributes`): line endings, `ident` and `export-subst` make files
 * bigger than they are stored, by any amount. This machine's git settings and
 * attributes files do not count: releaseTar packs without them.
 */
export async function codeSizeBound(git: Git, repo: string, sha: string): Promise<number | undefined> {
  // Where git keeps it: a linked worktree's is in the folder it shares with
  // the main one, not its own, so looking in its folder missed it.
  const own = await git([...gitDir(repo), 'rev-parse', '--git-path', 'info/attributes']);
  const ownFile = own.stdout.toString().trim();
  if (own.code !== 0 || !ownFile || existsSync(resolvePath(ownFile))) return undefined;
  const r = await git([...gitDir(repo), 'ls-tree', '-r', '-t', '-l', '-z', sha]);
  if (r.code !== 0) return undefined;
  let bytes = 1024;
  for (const entry of r.stdout.toString().split('\0')) {
    const m = /^(\d+) (\w+) [0-9a-f]+ +(\d+|-)\t([\s\S]+)$/.exec(entry);
    if (!m) continue;
    const [, mode, type, size, path] = m as unknown as [string, string, string, string, string];
    if (/(^|\/)\.gitattributes$/.test(path)) return undefined;
    const file = type === 'blob' && mode !== '120000';
    const name = Buffer.byteLength(type === 'blob' ? path : `${path}/`);
    const link = mode === '120000' ? Number(size) : 0;
    const pax = (name > 100 ? name + 20 : 0) + (link > 100 ? link + 24 : 0);
    bytes += 512 + (pax ? 512 + Math.ceil(pax / 512) * 512 : 0) + (file ? Math.ceil(Number(size) / 512) * 512 : 0);
  }
  return Math.ceil((bytes + 1024) / 10240) * 10240;
}

/**
 * The size limit, held at an inspection without making the tarball
 * (HB-1017): left to the install, a repo over it was refused only after the
 * page had made the new agent and attached its account. Within the limit by
 * codeSizeBound it is not packed; otherwise it is, to be sure, and refused
 * only as releaseTar refuses, in its words.
 */
export async function checkCodeSize(git: Git, repo: string, sha: string): Promise<void> {
  const most = await codeSizeBound(git, repo, sha);
  if (most === undefined || most > MAX_TAR_BYTES) await releaseTar(git, repo, sha);
}

/** A ref to its commit, the manifest at that commit, and the commit's files as a tarball. */
export async function resolveRelease(git: Git, repo: string, ref = 'HEAD'): Promise<Resolved> {
  const { sha, manifest } = await manifestAt(git, repo, ref);
  return { sha, manifest, tar: await releaseTar(git, repo, sha) };
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
export function appVars(m: AppManifest, facts: Pick<AgentFacts, 'slug'>, at: { app_dir?: string; data_dir?: string } = {}) {
  const p = appPaths(m.app);
  const base = { app_dir: at.app_dir ?? p.current, data_dir: at.data_dir ?? p.data, agent: facts.slug, name: m.name, env: '' };
  const env = Object.fromEntries(Object.entries(m.env ?? {}).map(([k, v]) => [k, expand(v, base)]));
  return { ...base, env: Object.entries(env).map(([k, v]) => `${k}=${sq(v)}`).join(' '), envMap: env };
}

/**
 * Its `chat` for the persona of a new agent with this slug, the placeholders
 * filled as its tasks' are: it went into SOUL.md as written, "{app_dir}"
 * and all (HB-0259).
 */
export function appChat(m: AppManifest, slug: string): string | undefined {
  return m.chat === undefined ? undefined : expand(m.chat, appVars(m, { slug }));
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
      // Held to its field's type like a value given: a list filled from
      // owner.email was written as a string, with nothing said (HB-0303).
      // A number filled from owner.telegram (a numeric id) is one; a fact
      // that does not fit is said here, not refused when the manifest is
      // read: an installed release with it could no longer be updated.
      const empty = !String(fact[f.from] ?? '').trim();
      const v = empty ? (f.type === 'list' ? [] : f.type === 'number' || f.type === 'bool' ? null : '') : coerce(f.type, fact[f.from]);
      if (v === INVALID) invalid.push(`${f.key} is filled from ${f.from}, which is not ${TYPE_WORD[f.type ?? 'text']} (its ${MANIFEST_FILE} needs fixing)`);
      else out[f.key] = v;
      if (f.required && empty) unfilled.push(`${f.key} (${UNFILLED[f.from] ?? `no ${f.from}`})`);
      continue;
    }
    const given = Object.prototype.hasOwnProperty.call(values, f.key) && values[f.key] !== undefined;
    const cleared = given && typeof values[f.key] === 'string' && !(values[f.key] as string).trim();
    if (given && !cleared) {
      const v = coerce(f.type, values[f.key]);
      // A secret's value is never said back: the error is answered, and kept
      // with the operation and its event (HB-0260).
      if (v === INVALID) invalid.push(`${f.key} must be ${TYPE_WORD[f.type ?? 'text']}${f.secret ? '' : ` (got ${JSON.stringify(values[f.key]).slice(0, 60)})`}`);
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
      // Required is judged after the coercion: ", ," kept for a required list
      // became [] and was accepted (HB-0263).
      const kept = f.type && !f.secret ? coerce(f.type, out[f.key]) : out[f.key];
      if (kept !== INVALID && !(f.required && blank(kept))) out[f.key] = kept;
      else if (f.required) { delete out[f.key]; missing.push(f.label ? `${f.key} (${f.label})` : f.key); missingKeys.push(f.key); }
      else out[f.key] = f.type === 'list' ? [] : f.type === 'number' || f.type === 'bool' ? null : '';
      continue;
    }
    else if (f.default !== undefined) {
      // The default is held to its field's type like a value given: "abc"
      // for a number was written as it was. '' and null stay "no value".
      const d = f.default === '' || f.default === null ? f.default : coerce(f.type, f.default);
      if (d === INVALID) invalid.push(`the app's default for ${f.key} is not ${TYPE_WORD[f.type ?? 'text']} (${f.secret ? '' : `${JSON.stringify(f.default).slice(0, 60)}; `}its ${MANIFEST_FILE} needs fixing)`);
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
  return valuesUnder((m.config?.fields ?? []).filter((f) => f.secret).map((f) => f.key), config);
}

/**
 * What an install masks in its tests' output and its errors: the values under
 * the secret fields of the release going in and of the releases it replaces
 * (`earlier`), and every value the config keeps under a key the new release
 * does not declare at all. The config keeps an old field's value when the
 * next release drops the field, and the field's `secret` went with it: an
 * update printed an older release's key unmasked (HB-1081). A key no release
 * declares now may have been secret in any earlier one, so it is masked too.
 */
export function maskedValues(m: AppManifest, earlier: Array<AppManifest | undefined>, ...configs: Array<Record<string, unknown>>): string[] {
  const declared = new Set((m.config?.fields ?? []).map((f) => f.key));
  const keys = new Set([m, ...earlier].flatMap((x) => (x?.app === m.app ? x.config?.fields ?? [] : []).filter((f) => f.secret).map((f) => f.key)));
  for (const c of configs) for (const k of Object.keys(c)) if (!declared.has(k)) keys.add(k);
  return [...new Set(configs.flatMap((c) => valuesUnder([...keys], c)))].sort((a, b) => b.length - a.length);
}

function valuesUnder(keys: readonly string[], config: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const key of keys) {
    if (!Object.hasOwn(config, key)) continue;
    const v = config[key];
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
      // Items trimmed and blanks dropped, as for "a, b": ['', ' '] passed a
      // required list that ' , ' did not (HB-0364).
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.map((x) => x.trim()).filter(Boolean);
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
  /** The operation's record (operations.ts): each step as it is done (appOperations.ts), with what it records. */
  step?: (key: string, detail?: Record<string, unknown>) => void;
  /**
   * Judges the config about to be staged: the values given merged with the
   * file already in the agent, the manifest's defaults and Hatchabot's facts,
   * so what is judged is what the app will run with (the values alone missed
   * a mailbox that came from a default or the old file). `existing` is the
   * file as it was. Throwing stops the install before anything live changes.
   */
  checkConfig?: (config: Record<string, unknown>, existing: Record<string, unknown>) => void | Promise<void>;
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
/**
 * An app's config file as it was read from the agent (`text`; none is an
 * empty config): its settings, or a refusal saying the file must be fixed.
 * One that is JSON but not an object of settings is refused too: `[]` was
 * taken as no settings, and `null` made the install fail with a TypeError
 * (HB-1016). The install and Update's check read it the same way.
 */
function configFileValues(live: string, text: string): Record<string, unknown> {
  let v: unknown;
  try { v = text.trim() ? JSON.parse(text) : {}; } catch { throw new AppError(`${live} in the agent is not valid JSON; fix or remove it.`); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AppError(`${live} in the agent is not a JSON object of settings; fix or remove it.`);
  return v as Record<string, unknown>;
}

/**
 * The config fields Hatchabot fills whose value in the agent no longer matches
 * the fact: its bot was swapped or removed, the owner linked Telegram later.
 * They are written only at an install, so Update on the same commit said there
 * was nothing to do while the app held the old bot's name (HB-0426). A config
 * that cannot be read or judged throws, in the install's words: read as [],
 * Update said nothing needed writing when it could not tell (HB-1016).
 */
export async function staleFilledFields(d: InstallDeps, m: AppManifest): Promise<string[]> {
  const filled = (m.config?.fields ?? []).filter((f) => f.from);
  if (!filled.length) return [];
  const live = `${appPaths(m.app).data}/${m.config?.file ?? 'config.json'}`;
  const unread = (why: string) => new AppError(`Could not read ${live} in the agent (${why}), so whether the settings Hatchabot fills in it are up to date could not be told. Nothing was changed; check it, then try again.`);
  const read = await sh(d, `if [ -e ${sq(live)} ]; then cat ${sq(live)}; fi`)
    .catch((e: unknown) => { if (e instanceof SimulatedCrash) throw e; throw unread((e as Error)?.message ?? String(e)); });
  if (read.code !== 0) throw unread(errText(read) || 'no output');
  const had = configFileValues(live, read.stdout);
  // A value Hatchabot fills that is not of its field's type throws here, as at the install.
  const { config } = mergeConfig(m, d.facts, had, {});
  // No value and an empty one are the same: a fact that was never there is no change.
  const seen = (v: unknown) => (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) ? '' : JSON.stringify(v));
  return filled.filter((f) => seen(had[f.key]) !== seen(config[f.key])).map((f) => f.key);
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
 * byte) and its tasks, so the agent, its jobs and the record agree. A
 * failure once its tasks are on puts nothing back and is thrown `held`
 * (and `tasksOn`): the release, config and tasks are all the new ones.
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
  /** Its scheduled tasks, once they are on. */
  let tasksOn: string[] | undefined;
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
      // Unpacked beside it and moved in whole; one that fails (a full disk)
      // takes its half-unpacked folder with it (HB-1301).
      : await d.provider.writeToVolume(d.runtimeRef,
        ['sh', '-c', `rm -rf ${sq(dir)}.tmp && { mkdir -p ${sq(dir)}.tmp && tar -x -C ${sq(dir)}.tmp && rm -rf ${sq(dir)} && mv ${sq(dir)}.tmp ${sq(dir)} || { s=$?; rm -rf ${sq(dir)}.tmp; exit $s; }; } && ${folders}`],
        rel.tar);
    if (un.code !== 0) throw new AppError(`Could not unpack the code: ${errText(un)}`);
    step('unpacked');

    // 2. the config, staged: the live file is not touched until the switch
    if (m.config) {
      // No file is an empty config; one that cannot be read stops it. Read as
      // empty, the defaults were written over the owner's settings (#105).
      const read = await sh(d, `if [ -e ${sq(live)} ]; then cat ${sq(live)}; fi`);
      if (read.code !== 0) throw new AppError(`Could not read ${live} in the agent (${errText(read) || 'no output'}), so its settings were left as they are. Check it, then try again.`);
      const existing = configFileValues(live, read.stdout);
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
      await d.checkConfig?.(config, existing);
      // The record's manifest too: the live release's file may be gone.
      const recorded = d.recorded?.app === m.app ? manifestSchema.safeParse(d.recorded.manifest) : undefined;
      secrets = maskedValues(m, [before, recorded?.success ? recorded.data : undefined], config, existing);
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

    // 4. switch: the config (the old one kept aside, or a note there was none), then `current`, atomically.
    // Where `current` stood: a replaced app's own link stays on the volume, so
    // it alone could not tell whether this switch moved it (appOperations.ts, tasksBackAgain).
    step('switching', { toWas: previousSha ?? null });
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
    tasksOn = tasks;
    step('tasks');

    // 6. keep the newest releases (never the live one or the one before it).
    // Housekeeping once the release is live: one that fails, or whose call is
    // rejected (the runner dropping mid-call), is said in the log and the
    // install stands. Rejected, it held an install that had finished (HB-1192).
    // Only folders named in a release's form (its commit's first 12 hex
    // digits, which no newline can be part of) are listed, counted and
    // removed: from a listing of every name, a file the app left in releases/
    // with a blank line in its name gave an empty one, and `rm -rf
    // "releases/"` took the live release and the one before it with the rest
    // (HB-1301). A link or a file in that form is neither (a dangling link
    // sorted first stopped the whole clear-out). Unpacks left half done
    // (`<release>.tmp`) go too, as they did from the listing of every name.
    const keep = `-e releases/${short} -e ${sq(`releases/${previousSha ?? short}`)}`;
    const prune = await sh(d, `cd ${sq(p.root)} && { f=0; `
      + `for t in releases/${RELEASE_GLOB}.tmp; do if [ "$t" != releases/${short}.tmp ] && { [ -e "$t" ] || [ -L "$t" ]; }; then rm -rf -- "$t" || f=1; fi; done; `
      + `set --; for r in releases/${RELEASE_GLOB}; do if [ -d "$r" ] && [ ! -L "$r" ]; then set -- "$@" "$r"; fi; done; `
      + `if [ "$#" -gt 0 ]; then ls -1td -- "$@" | tail -n +${KEEP_RELEASES + 1} | grep -v -x ${keep} | { g=0; while IFS= read -r r; do if [ -n "$r" ]; then rm -rf -- "$r" || g=1; fi; done; [ "$g" = 0 ]; } || f=1; fi; `
      + `[ "$f" = 0 ]; }`)
      .catch((err: unknown) => {
        if (err instanceof SimulatedCrash) throw err;
        return { code: 1, stdout: '', stderr: (err as Error)?.message ?? String(err) };
      });
    if (prune.code !== 0) log('app.prune_failed', { app: m.app, error: errText(prune) });
    return { app: m.app, sha: rel.sha, previousSha, manifest: m, test, tasks };
  } catch (e) {
    // A (simulated) dead process puts nothing back and clears nothing: the
    // restart finds it as it is (appOperations.ts, resumeAppOperation).
    if (e instanceof SimulatedCrash) { crashed = true; throw e; }
    // No secret value given reaches the error (kept with the operation and its event): HB-0260.
    if (e instanceof Error) e.message = maskSecrets(e.message, [...secretValues(m, values), ...secrets].sort((a, b) => b.length - a.length));
    if (!switching) throw outcome(e, { unchanged: true });
    // Its tasks are on: putting back only the release and its config left the
    // new tasks running the old code, and said "unchanged" over them
    // (HB-1192). Nothing is put back: it all stays as it went on, and the
    // operation waits for the owner's choice (going back puts back the old
    // tasks too), its staging folder kept for that.
    if (tasksOn) {
      keepStaging = true;
      const what = tasksOn.length ? `its scheduled tasks went on (${tasksOn.join(', ')})` : 'its scheduled tasks were changed over (it has none)';
      if (e instanceof Error) {
        e.message = `${m.app} ${short} was switched on and ${what}, then recording that its tasks are on failed: ${e.message}. Nothing was switched back, so it waits for your choice on its page: use the new release, or go back to the previous one.`;
      }
      if (e && typeof e === 'object') Object.assign(e, { tasksOn: true });
      throw outcome(e, { held: true });
    }
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
 *
 * A switch that answers an error may have landed all the same (its reply
 * lost): the link, read again, decides. One that cannot be put back, or
 * whose place cannot be read, is thrown `held`: the code, the tasks and the
 * record may disagree, and the operation waits for the owner's choice. It
 * ended failed with no choice to make (HB-0254).
 */
export async function switchTo(d: InstallDeps, m: AppManifest, sha: string, from?: AppManifest): Promise<void> {
  const p = appPaths(m.app);
  const short = sha.slice(0, 12);
  const before = await currentLink(d, m.app);
  /** Where `current` points now; undefined when it cannot be read. */
  const linkNow = () => currentLink(d, m.app).catch(() => undefined);
  d.step?.('switching');
  const r = await sh(d, `cd ${sq(p.root)} && test -d releases/${short} && ln -sfn releases/${short} current.new && mv -T current.new current`)
    .catch((err: unknown) => ({ code: 1, stdout: '', stderr: (err as Error)?.message ?? String(err) }));
  if (r.code !== 0) {
    const now = await linkNow();
    if (now === before) throw outcome(new AppError(`Release ${short} is no longer in the agent, or could not be switched on (${errText(r) || 'no output'}). Nothing was changed.`), { unchanged: true });
    if (now !== `releases/${short}`) {
      throw outcome(new AppError(`Switching to ${short} answered an error (${errText(r) || 'no output'}), and the agent's live release could not be confirmed after it. It waits for your choice on its page.`), { held: true });
    }
    // It landed: go on as if it had answered.
  }
  try {
    await syncTasks(d, m, from);
    d.step?.('tasks');
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e;
    const back = await sh(d, pointBack(p, before)).catch(() => ({ code: 1, stdout: '', stderr: '' }));
    // The link decides, as above: a put-back whose reply was lost is back.
    const isBack = back.code === 0 || (await linkNow()) === before;
    if (e instanceof Error) {
      e.message += isBack
        ? ` Still on ${shaOf(before) ?? 'the release it had'}.`
        : ` Pointing back at the release it had failed too, so the agent runs ${short} while Hatchabot's record says ${shaOf(before) ?? 'the release it had'}. It waits for your choice on its page.`;
    }
    throw outcome(e, isBack ? { unchanged: !(e as { tasksUnconfirmed?: boolean })?.tasksUnconfirmed } : { held: true });
  }
}

/** `enabled` as `cron list` gives it: false for a task the owner turned off. */
type Job = { id: string; name: string; enabled?: boolean };
type TaskOrigin = { id: string; name: string; manifest: AppManifest };
type RecordedJob = Job & { manifest?: AppManifest };

/** Saved before any scheduler mutation: disabled staging jobs are not owner intent. */
interface TaskTransition { version: 1; old: RecordedJob[]; previous?: AppManifest; next: AppManifest }
const taskTransitionFile = (app: string) => `${appPaths(app).root}/.tasks-transition.json`;
const taskOriginsFile = (app: string) => `${appPaths(app).root}/.tasks-settled.json`;

async function readTaskTransition(d: InstallDeps, app: string): Promise<TaskTransition | undefined> {
  const file = sq(taskTransitionFile(app));
  const r = await sh(d, `if [ -e ${file} ]; then printf 'present\\n'; cat ${file}; fi`);
  if (r.code !== 0) throw new AppError(`Could not read ${app}'s scheduled-task transition: ${errText(r)}. No scheduled tasks were changed.`);
  if (!r.stdout) return undefined;
  try {
    if (!r.stdout.startsWith('present\n')) throw new Error('missing marker');
    const raw = JSON.parse(r.stdout.slice('present\n'.length));
    const next = manifestSchema.parse(raw.next);
    const previous = raw.previous === undefined ? undefined : manifestSchema.parse(raw.previous);
    const names = appTaskNames(next, previous);
    if (raw.version !== 1 || next.app !== app || (previous && previous.app !== app) || !Array.isArray(raw.old)
      || raw.old.some((j: RecordedJob) => !j || typeof j.id !== 'string' || !j.id || typeof j.name !== 'string' || (!names.has(j.name) && j.manifest === undefined) || typeof j.enabled !== 'boolean')
      || new Set(raw.old.map((j: Job) => j.id)).size !== raw.old.length) throw new Error('invalid transition');
    const old: RecordedJob[] = raw.old.map((j: RecordedJob) => {
      const manifest = j.manifest === undefined ? undefined : manifestSchema.parse(j.manifest);
      if (manifest && (manifest.app !== app || !appTaskNames(manifest).has(j.name))) throw new Error('invalid task origin');
      return { id: j.id, name: j.name, enabled: j.enabled, manifest };
    });
    return { version: 1, old, previous, next };
  } catch { throw new AppError(`${app}'s scheduled-task transition is unreadable. Its tasks were left alone; restore that file before trying again.`); }
}

/** An interrupted task switch is never proof that the app operation finished. */
export async function taskTransitionPending(d: InstallDeps, app: string): Promise<boolean> {
  return !!(await readTaskTransition(d, app));
}

/** Task ids bind the actual scheduler generation even while the app DB is older. */
async function readTaskOrigins(d: InstallDeps, app: string): Promise<TaskOrigin[]> {
  const file = sq(taskOriginsFile(app));
  const r = await sh(d, `if [ -e ${file} ]; then printf 'present\\n'; cat ${file}; fi`);
  if (r.code !== 0) throw new AppError(`Could not read ${app}'s scheduled-task provenance: ${errText(r)}. Its tasks were left alone.`);
  if (!r.stdout) return [];
  try {
    if (!r.stdout.startsWith('present\n')) throw new Error('missing marker');
    const raw = JSON.parse(r.stdout.slice('present\n'.length));
    if (raw.version !== 1 || !Array.isArray(raw.jobs)) throw new Error('invalid task origins');
    const jobs: TaskOrigin[] = raw.jobs.map((j: TaskOrigin) => {
      const manifest = manifestSchema.parse(j.manifest);
      if (typeof j.id !== 'string' || !j.id || typeof j.name !== 'string' || manifest.app !== app || !appTaskNames(manifest).has(j.name)) throw new Error('invalid task origin');
      return { id: j.id, name: j.name, manifest };
    });
    if (new Set(jobs.map((j) => j.id)).size !== jobs.length) throw new Error('duplicate task ids');
    return jobs;
  } catch { throw new AppError(`${app}'s scheduled-task provenance is unreadable. Its tasks were left alone; restore that file before trying again.`); }
}

async function writeTaskRecord(d: InstallDeps, app: string, file: string, rec: unknown): Promise<void> {
  if (!d.provider.writeToVolume) throw new AppError('This machine cannot record scheduled-task transitions (no writeToVolume). No scheduled tasks were changed.');
  const r = await d.provider.writeToVolume(d.runtimeRef,
    ['sh', '-c', `umask 077 && mkdir -p ${sq(appPaths(app).root)} && cat > ${sq(`${file}.tmp`)} && mv -f ${sq(`${file}.tmp`)} ${sq(file)}`],
    Buffer.from(JSON.stringify(rec) + '\n'));
  if (r.code !== 0) throw new AppError(`Could not record ${app}'s scheduled-task recovery information: ${errText(r)}.`);
}

const writeTaskTransition = (d: InstallDeps, rec: TaskTransition) => writeTaskRecord(d, rec.next.app, taskTransitionFile(rec.next.app), rec);
const writeTaskOrigins = (d: InstallDeps, app: string, jobs: TaskOrigin[]) => writeTaskRecord(d, app, taskOriginsFile(app), { version: 1, jobs });

async function clearTaskRecord(d: InstallDeps, app: string, file: string, remains: () => Promise<boolean>): Promise<void> {
  let why: string;
  try {
    const r = await sh(d, `rm -f ${sq(file)}`);
    if (r.code === 0) return;
    why = errText(r);
  } catch (e) { if (e instanceof SimulatedCrash) throw e; why = (e as Error).message; }
  // The removal may have succeeded before its reply was lost. Absence is
  // success; an unreadable answer remains uncertain, never assumed absent.
  if (!(await remains())) return;
  throw new AppError(`Could not clear ${app}'s scheduled-task transition: ${why}.`);
}

const clearTaskTransition = (d: InstallDeps, app: string) => clearTaskRecord(d, app, taskTransitionFile(app), async () => !!(await readTaskTransition(d, app)));
const clearTaskOrigins = (d: InstallDeps, app: string) => clearTaskRecord(d, app, taskOriginsFile(app), async () => (await readTaskOrigins(d, app)).length > 0);

const taskCommand = (d: InstallDeps, argv: string[]): Promise<ExecResult> => d.provider.exec(d.runtimeRef, argv, { timeoutMs: 60_000 })
  .catch((err: unknown): ExecResult => {
    if (err instanceof SimulatedCrash) throw err;
    return { code: 1, stdout: '', stderr: String((err as Error)?.message ?? err) };
  });

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
 * off with app "news" (audit, 2026-10-20). And only command jobs, as an app's
 * are: the owner's own reminder that happened to be named "<app>-<task>" was
 * taken off by an install (HB-0304). A job whose payload is not listed is
 * still taken for the app's, as before.
 */
export async function appJobs(d: InstallDeps, names: ReadonlySet<string>): Promise<Job[]> {
  const list = await d.provider.exec(d.runtimeRef, ['cron', 'list', '--all', '--json'], { timeoutMs: 60_000 });
  if (list.code !== 0) throw new AppError(`Could not read the agent's scheduled tasks: ${errText(list)}`);
  let jobs: unknown;
  try { jobs = JSON.parse(list.stdout).jobs; } catch { throw new AppError("The agent's scheduled tasks did not read as JSON."); }
  if (!Array.isArray(jobs) || jobs.some((j) => !j || typeof j !== 'object')) throw new AppError("The agent's scheduled task list is incomplete or malformed. Try again.");
  const isCommand = (x: { payload?: unknown }) => {
    const kind = x.payload && typeof x.payload === 'object' ? (x.payload as { kind?: unknown }).kind : undefined;
    return kind === undefined || kind === 'command';
  };
  const mine = (jobs as Array<{ id?: unknown; name?: unknown; payload?: unknown }>).filter((x) => typeof x.name === 'string' && names.has(x.name) && isCommand(x));
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

/** Restore the journal's original set, never enabling it beside a replacement. */
async function restoreTaskTransition(d: InstallDeps, rec: TaskTransition): Promise<string[]> {
  const { old, previous: prev, next: m } = rec;
  const ours = appTaskNames(m, prev);
  for (const j of old) ours.add(j.name);
  const oldIds = new Set(old.map((j) => j.id));
  const run = (argv: string[]) => taskCommand(d, argv);
  const unread = (e: unknown) => {
    if (e instanceof SimulatedCrash) throw e;
    return [`the list could not be read (${(e as Error)?.message ?? e})`];
  };
  let now: Job[];
  try { now = await appJobs(d, ours); } catch (e) { return unread(e); }
  // A replacement can already be active when its enable reply was lost.
  // Before any original is restored, prove every replacement is stopped.
  for (const j of now.filter((x) => !oldIds.has(x.id) && x.enabled !== false)) await run(['cron', 'disable', j.id]);
  try { now = await appJobs(d, ours); } catch (e) { return unread(e); }
  const active = now.filter((j) => !oldIds.has(j.id) && j.enabled !== false);
  if (active.length) return [`replacement tasks could not be turned off: ${active.map((j) => j.name).join(', ')}`];
  const seen = new Set(now.map((j) => j.id));
  for (const j of now.filter((x) => !oldIds.has(x.id))) await run(['cron', 'rm', j.id]);
  const knownIds = new Set(seen);
  const origins: TaskOrigin[] = [];
  const uncertain: string[] = [];
  for (const j of old) {
    const manifest = j.manifest ?? prev;
    if (seen.has(j.id)) {
      const current = now.find((x) => x.id === j.id)!;
      if ((current.enabled !== false) !== (j.enabled !== false)) await run(['cron', j.enabled === false ? 'disable' : 'enable', j.id]);
      if (manifest && appTaskNames(manifest).has(j.name)) origins.push({ id: j.id, name: j.name, manifest });
    } else {
      const t = manifest?.tasks.find((x) => `${m.app}-${x.name}` === j.name);
      if (t) {
        await run([...addArgv(d, manifest!, t), ...(j.enabled === false ? ['--disabled'] : [])]);
        // Bind a recreated id to this original definition, including an add
        // whose response was lost. Never guess by task name alone: duplicate
        // names may have different definitions in an interrupted generation.
        let listed: Job[];
        try { listed = await appJobs(d, ours); } catch (e) { return unread(e); }
        const added = listed.filter((x) => !knownIds.has(x.id));
        for (const x of listed) knownIds.add(x.id);
        if (added.length === 1 && added[0]!.name === j.name) origins.push({ id: added[0]!.id, name: j.name, manifest: manifest! });
        else if (added.length) uncertain.push(`the restored task definition could not be confirmed: ${j.name}`);
      }
    }
  }
  let after: Job[];
  try { after = await appJobs(d, ours); } catch (e) { return unread(e); }
  const stray = after.filter((j) => seen.has(j.id) && !oldIds.has(j.id)).map((j) => j.name);
  const off = (j: Job) => j.enabled === false;
  const count = (jobs: Job[]) => jobs.reduce((n, j) => n.set(j.name, (n.get(j.name) ?? 0) + 1), new Map<string, number>());
  const kept = after.filter((j) => oldIds.has(j.id) || !seen.has(j.id));
  const want = count(old), have = count(kept);
  const missing = [...want].filter(([name, n]) => (have.get(name) ?? 0) < n).map(([name]) => name);
  const twice = [...have].filter(([name, n]) => n > (want.get(name) ?? 0)).map(([name]) => name);
  const offWant = count(old.filter(off)), offHave = count(kept.filter(off));
  const named = new Set([...missing, ...twice]);
  const switchedOn = [...offWant].filter(([name, n]) => !named.has(name) && (offHave.get(name) ?? 0) < n).map(([name]) => name);
  const switchedOff = [...offHave].filter(([name, n]) => !named.has(name) && n > (offWant.get(name) ?? 0)).map(([name]) => name);
  const problems = [
    ...uncertain,
    ...(stray.length ? [`still there: ${stray.join(', ')}`] : []),
    ...(missing.length ? [`not re-added: ${missing.join(', ')}`] : []),
    ...(twice.length ? [`more than once: ${twice.join(', ')}`] : []),
    ...(switchedOn.length ? [`switched on, though you had turned it off: ${switchedOn.join(', ')}`] : []),
    ...(switchedOff.length ? [`turned off, though it was on: ${switchedOff.join(', ')}`] : []),
  ];
  if (!problems.length) {
    try { await writeTaskOrigins(d, m.app, origins); }
    catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      problems.push(`restored task definitions could not be recorded (${(e as Error).message})`);
    }
  }
  return problems;
}

async function rollbackTasks(d: InstallDeps, rec: TaskTransition): Promise<string[]> {
  const problems = await restoreTaskTransition(d, rec);
  if (!problems.length) {
    try { await clearTaskTransition(d, rec.next.app); }
    catch (e) { if (e instanceof SimulatedCrash) throw e; problems.push((e as Error).message); }
  }
  return problems;
}

/** An old transaction is resolved before another sync infers owner intent. */
async function recoverTaskTransition(d: InstallDeps, app: string): Promise<void> {
  const rec = await readTaskTransition(d, app);
  if (!rec) return;
  const problems = await rollbackTasks(d, rec);
  if (problems.length) throw Object.assign(new AppError(`Its interrupted scheduled-task change could not be put back: ${problems.join('; ')}. Try again once the agent answers.`), { tasksUnconfirmed: true });
}

/**
 * Stage replacements disabled while the original jobs remain intact. Only
 * after staging succeeds are originals disabled and checked, replacements
 * enabled, and originals removed. The volume journal preserves original
 * enabled states across crashes: a disabled staging job is never read as an
 * owner's choice. A failed call is reconciled from fresh lists, including
 * calls whose changes landed before their replies were lost.
 */
export async function syncTasks(d: InstallDeps, m: AppManifest, previous?: AppManifest, off: readonly string[] = []): Promise<string[]> {
  await recoverTaskTransition(d, m.app);
  const run = (argv: string[]) => taskCommand(d, argv);
  const prev = previous?.app === m.app ? previous : undefined;
  const origins = await readTaskOrigins(d, m.app);
  const ours = appTaskNames(m, prev);
  const originOf = (j: Job) => origins.find((x) => x.id === j.id && x.name === j.name);
  const listed = await appJobs(d, new Set([...ours, ...origins.map((j) => j.name)]));
  const old = listed.filter((j) => ours.has(j.name) || originOf(j)).map((j) => ({ id: j.id, name: j.name, enabled: j.enabled !== false,
    manifest: originOf(j)?.manifest ?? (prev && appTaskNames(prev).has(j.name) ? prev : undefined) }));
  for (const j of old) ours.add(j.name);
  const oldIds = new Set(old.map((j) => j.id));
  const rec: TaskTransition = { version: 1, old, previous: prev, next: m };
  await writeTaskTransition(d, rec);
  const fail = async (what: string) => {
    // A failed journal removal may actually have removed it. Before a
    // rollback changes any scheduler state, its original intent is durable
    // again; otherwise leave the jobs alone and report the uncertainty.
    let problems: string[];
    try { await writeTaskTransition(d, rec); problems = await rollbackTasks(d, rec); }
    catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      problems = [`rollback could not be recorded or completed (${(e as Error).message})`];
    }
    return Object.assign(new AppError(`${what} ${problems.length
      ? `Its scheduled tasks could not be confirmed: ${problems.join('; ')}. Check them with \`openclaw cron list --all\` in the agent's console (jobs named ${m.app}-…), then Update or Roll back again.`
      : 'Its tasks are as they were.'}`), { tasksUnconfirmed: problems.length > 0 });
  };
  const made = m.tasks.map((t) => `${m.app}-${t.name}`);
  const offBefore = (name: string) => old.some((j) => j.name === name)
    ? old.filter((j) => j.name === name).every((j) => !j.enabled)
    : off.includes(name);
  try {
    for (const t of m.tasks) {
      const r = await run([...addArgv(d, m, t), '--disabled']);
      if (r.code !== 0) throw new AppError(`Could not schedule ${m.app}-${t.name}: ${errText(r)}.`);
    }
    const staged = (await appJobs(d, ours)).filter((j) => !oldIds.has(j.id));
    if (staged.length !== made.length || staged.some((j) => j.enabled !== false)
      || made.some((name) => staged.filter((j) => j.name === name).length !== 1)) {
      throw new AppError('The replacement scheduled tasks were not confirmed staged and turned off.');
    }
    for (const j of old.filter((j) => j.enabled)) {
      const r = await run(['cron', 'disable', j.id]);
      if (r.code !== 0) throw new AppError(`Could not turn off the old task ${j.name}: ${errText(r)}.`);
    }
    const quiet = await appJobs(d, ours);
    if (quiet.some((j) => j.enabled !== false) || old.some((j) => !quiet.some((x) => x.id === j.id))) {
      throw new AppError('The old scheduled tasks could not be confirmed turned off.');
    }
    for (const j of staged.filter((j) => !offBefore(j.name))) {
      const r = await run(['cron', 'enable', j.id]);
      if (r.code !== 0) throw new AppError(`Could not enable ${j.name}: ${errText(r)}.`);
    }
    for (const j of old) {
      const r = await run(['cron', 'rm', j.id]);
      if (r.code !== 0) throw new AppError(`Could not take off the old task ${j.name}: ${errText(r)}.`);
    }
    const final = await appJobs(d, ours);
    if (final.length !== made.length || made.some((name) => final.filter((j) => j.name === name).length !== 1)
      || final.some((j) => (j.enabled === false) !== offBefore(j.name))) {
      throw new AppError('The replacement scheduled tasks could not be confirmed in their intended state.');
    }
    await writeTaskOrigins(d, m.app, final.map((j) => ({ id: j.id, name: j.name, manifest: m })));
    await clearTaskTransition(d, m.app);
    return made;
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e;
    throw await fail((e as Error)?.message ?? String(e));
  }
}

/** Take its tasks off (those its manifests `ms` make); the code and data stay on the volume. */
export async function removeTasks(d: InstallDeps, app: string, ...ms: Array<AppManifest | undefined>): Promise<number> {
  // Stop app removes both generations, including renamed staged jobs. It
  // must never restore/enable the old generation just to remove it next.
  const transition = await readTaskTransition(d, app);
  const origins = await readTaskOrigins(d, app);
  const names = appTaskNames(...ms, transition?.previous, transition?.next);
  for (const j of transition?.old ?? []) names.add(j.name);
  const jobs = (await appJobs(d, new Set([...names, ...origins.map((j) => j.name)])))
    .filter((j) => names.has(j.name) || origins.some((x) => x.id === j.id && x.name === j.name));
  for (const j of jobs) names.add(j.name);
  for (const j of jobs) {
    // A lost response may mean it was removed. The fresh list decides.
    await taskCommand(d, ['cron', 'rm', j.id]);
  }
  const left = await appJobs(d, names);
  if (left.length) throw new AppError(`Could not remove ${app}'s scheduled tasks: ${left.map((j) => j.name).join(', ')} remain. Try again; the app record has been kept.`);
  await clearTaskOrigins(d, app);
  if (transition) await clearTaskTransition(d, app);
  return jobs.length;
}
