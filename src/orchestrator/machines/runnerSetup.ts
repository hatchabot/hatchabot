import { createGzip } from 'node:zlib';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerConnArgs } from '../../providers/runnerEndpoint.js';
import { APT_PACKAGE_NAME, recipeDockerfile } from './imageRecipe.js';
import { BUILD_INPUTS_LABEL, inputsDiffer, parseBuildInputs } from './buildInputs.js';

const execFileP = promisify(execFile);

/**
 * Everything that makes "add a runner" a paste-an-address experience instead
 * of an SSH treasure hunt. Validated the hard way on the first live runner
 * (a MacBook): the manual path needed a dedicated key, an ssh-config block,
 * known-hosts acceptance, a PATH fix on the runner, and the runtime image —
 * each one a silent failure when missed. This module automates the
 * control-plane half and generates the one-liner for the runner half.
 *
 * Design rules learned live:
 *  - The service must NEVER depend on an ssh-agent. A keyring agent works in
 *    an interactive shell and dies headless (locked, empty after reboot), so
 *    the dedicated key is passphrase-less and pinned with IdentitiesOnly.
 *  - `docker -H ssh://…` shells out to `ssh`, which reads ~/.ssh/config — the
 *    per-host block is how we control identity without docker's cooperation.
 */

export interface RunnerPaths {
  sshDir?: string; // default ~/.ssh — overridable for tests
  /** Where a note on the key goes (key.pub used unchecked); the journal, through stderr, when not given. */
  log?: (event: string, detail: Record<string, unknown>) => void;
}

const KEY_NAME = 'agentclaw_runner';
const CONFIG_MARK = '# agentclaw-runner:'; // + host — marks blocks we own

function sshDir(p: RunnerPaths = {}): string {
  // Env override so tests (and unusual deployments) never touch the real
  // ~/.ssh of whoever runs the process.
  return p.sshDir ?? process.env.HATCHABOT_SSH_DIR ?? join(homedir(), '.ssh');
}

/**
 * The control plane's dedicated runner key — created on first use, reused for
 * every runner. Passphrase-less on purpose (see module note). Returns the
 * public key line for the UI to hand to the runner.
 */
export async function ensureRunnerKey(p: RunnerPaths = {}): Promise<string> {
  const dir = sshDir(p);
  const key = join(dir, KEY_NAME);
  let lost = false;
  if (!existsSync(key)) {
    // One first setup at a time: two runners added at once both found no key
    // and ran ssh-keygen on the same path, and the second sat at its
    // "Overwrite (y/n)?" prompt (HB-0577). The later one waits for the first's.
    let made = keyMaking.get(key);
    if (!made) {
      made = makeRunnerKey(dir, key).finally(() => keyMaking.delete(key));
      keyMaking.set(key, made);
    }
    lost = (await made) === 'lost';
  }
  // key.pub as it is, once this process made the key or found it there. Read
  // out of the private key only when it is missing (a process stopped
  // between the two halves), or right after another process's key won the
  // race: its key.pub may not be in place yet, or be the losing pair's
  // (HB-0577, sixth review).
  const onDisk = await readPublic(key);
  if (onDisk !== undefined && !lost) return onDisk.trim();
  return (await publicHalf(key, onDisk, p.log ?? noteOnStderr)).trim();
}
const keyMaking = new Map<string, Promise<'made' | 'lost'>>();
const noteOnStderr = (event: string, detail: Record<string, unknown>) => console.warn(`[runner-key] ${event} ${JSON.stringify(detail)}`);
async function readPublic(key: string): Promise<string | undefined> {
  return readFile(`${key}.pub`, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
}
/**
 * The public half read out of the private key (ssh-keygen -y), and key.pub
 * written again, whole, when it does not match (HB-0577, fifth review). An
 * ssh-keygen that fails with key.pub there leaves key.pub as the answer,
 * noted (sixth review).
 */
async function publicHalf(key: string, onDisk: string | undefined, log: NonNullable<RunnerPaths['log']>): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileP('ssh-keygen', ['-y', '-f', key], { timeout: KEYGEN_TIMEOUT_MS, killSignal: 'SIGKILL' }));
  } catch (err) {
    if (onDisk === undefined) throw keygenRefusal(key, err);
    log('runner_key.public_unchecked', { key: `${key}.pub`, error: String((err as Error)?.message ?? err).slice(0, 200) });
    return onDisk;
  }
  const keyPart = (line: string) => line.trim().split(/\s+/).slice(0, 2).join(' ');
  if (onDisk !== undefined && keyPart(onDisk) === keyPart(stdout)) return onDisk;
  const line = `${stdout.trim()}\n`;
  const tmp = `${key}.pub.new-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, line, { mode: 0o644, flag: 'wx' });
    await rename(tmp, `${key}.pub`);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
  return line;
}
/** How long ssh-keygen may take: it never asks anything here, but a hung one must not hold a setup for ever. */
const KEYGEN_TIMEOUT_MS = 60_000;
/** Signals a program gets from its own fault, not from elsewhere: ssh-keygen crashed. */
const CRASH_SIGNALS = new Set(['SIGSEGV', 'SIGBUS', 'SIGABRT', 'SIGILL', 'SIGFPE']);

/**
 * What an ssh-keygen -y that failed says of a key with no public half beside
 * it. Only a key ssh-keygen read and could not make out (OpenSSL's "error in
 * libcrypto", "invalid format", or OpenSSH's own "incomplete message" and
 * "string is too large", which no whole key gives) is called damaged, with
 * what to remove: it is never put right by trying again (seventh review).
 * Anything else it says may be a damaged key too (one character changed
 * inside the armour can read as an unknown key type, or a passphrase), so
 * that is said as not known either way, and that ssh cannot use it either
 * (review of HB-0657). A key it would not
 * open (mode open to others, owned by another account) is said as that,
 * with the fix: removing a good key breaks every runner set up with it. So
 * is one it never read to the end: stopped by its time limit or by a signal
 * from elsewhere (the OOM killer, a SIGTERM: try again), or crashed itself
 * (HB-0657 and its review). ssh-keygen missing is its own error, as it was.
 */
function keygenRefusal(key: string, err: unknown): Error {
  const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null; stderr?: unknown };
  const said = String(e.stderr ?? '').trim();
  const keep = 'it is not known to be damaged, so keep it: runners set up with it go on working';
  if (e.killed) return new Error(`ssh-keygen did not finish within ${KEYGEN_TIMEOUT_MS / 1000} seconds before it had read the runner key ${key}, so the key could not be checked (it is not known to be damaged): try again`, { cause: err });
  if (e.signal && CRASH_SIGNALS.has(e.signal)) return new Error(`ssh-keygen crashed (${e.signal}) reading the runner key ${key}, so the key could not be checked; ${keep}. What is wrong is ssh-keygen: see what ssh-keygen -y -f ${key} says`, { cause: err });
  if (e.signal) return new Error(`ssh-keygen was stopped (${e.signal}) before it had read the runner key ${key}, so the key could not be checked (it is not known to be damaged): try again`, { cause: err });
  if (e.code === 'ENOENT') return err as Error;
  if (/bad permissions|UNPROTECTED PRIVATE KEY/i.test(said)) {
    return new Error(`ssh-keygen will not use the runner key ${key}: other accounts can read it. Run chmod 600 ${key}, then add the runner again; ${keep}`, { cause: err });
  }
  if (/permission denied/i.test(said)) {
    return new Error(`this account cannot read the runner key ${key} (Permission denied): it belongs to another account, or its mode keeps this one out. Make it the key of the account Hatchabot runs as (sudo chown), with chmod 600 ${key}, then add the runner again; ${keep}`, { cause: err });
  }
  if (/invalid format|error in libcrypto|incomplete message|string is too large/i.test(said)) {
    return new Error(`the runner key ${key} cannot be read (it may have been cut short) and has no ${key}.pub beside it; remove ${key} and add the runner again, and a new key is made (runners set up with the old one need the new public key)`, { cause: err });
  }
  const line = said.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? (err instanceof Error ? err.message : String(err));
  return new Error(`ssh-keygen could not read the runner key ${key} (${line.slice(0, 200)}), and there is no ${key}.pub beside it. It may be damaged, or in a form this ssh-keygen does not take, and ssh cannot use it either: see what ssh-keygen -y -f ${key} says. Only once you know it is damaged, remove ${key} and add the runner again, and a new key is made (runners set up with the old one need the new public key)`, { cause: err });
}

/**
 * Made under a name of its own, so ssh-keygen never meets a file it would ask
 * to overwrite. The private half's arrival is the commit: link() puts it in
 * place only if no key is there. Two processes making it at once (the map
 * above is one process's) each moved both halves in, and could leave one's
 * private key with the other's public one (HB-0577 review). The one that
 * finds a key there drops its own pair ('lost'); publicHalf then reads that
 * key's. Written to the disk before it is put in place, so the key there is
 * never one cut short. A filesystem with no hard links (some network or FAT
 * mounts) gets it renamed into place under a lock file instead: rename
 * replaces where link() refuses (sixth and seventh reviews).
 */
async function makeRunnerKey(dir: string, key: string): Promise<'made' | 'lost'> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (existsSync(key)) return 'lost';
  const tmp = `${key}.new-${randomBytes(6).toString('hex')}`;
  try {
    await execFileP('ssh-keygen', [
      '-t', 'ed25519', '-N', '', '-f', tmp, '-C', 'agentclaw control-plane -> runner',
    ], { timeout: KEYGEN_TIMEOUT_MS, killSignal: 'SIGKILL' });
    await chmod(tmp, 0o600);
    const h = await open(tmp, 'r+');
    try { await h.sync(); } finally { await h.close(); }
    try {
      await link(tmp, key);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return 'lost';
      if (!['EPERM', 'ENOTSUP', 'EXDEV'].includes(String(code))) throw err;
      if ((await renameIfAbsent(tmp, key)) === 'lost') return 'lost';
    }
    await rename(`${tmp}.pub`, `${key}.pub`);
    return 'made';
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
    await rm(`${tmp}.pub`, { force: true }).catch(() => {});
  }
}

/**
 * `from` renamed to `to` only if nothing is there, for a filesystem with no
 * link(): the look and the rename under `<to>.lock`, made exclusively ('wx')
 * and holding a token of this call's own. A lock older than KEY_LOCK_STALE_MS
 * was left by a process that stopped while it held it (it holds it for a
 * moment), and is taken over by renaming it to a name of its own: of two
 * waiters that found it stale, one rename wins and the other finds nothing
 * (eighth review). One that renamed a lock made since (fresh) puts it back
 * only where none is ('wx', with its token): never over one a third has made
 * meanwhile. Its holder looks for its token in the lock just before its
 * rename, and starts over when it is not there, so that third and it do not
 * both rename (ninth review). A token, not the inode: the lock put back on a
 * filesystem with no link() is a new file.
 */
async function renameIfAbsent(from: string, to: string): Promise<'made' | 'lost'> {
  const lock = `${to}.lock`;
  const token = randomBytes(12).toString('hex');
  const holding = async () => (await readFile(lock, 'utf8').catch(() => undefined)) === token;
  for (let i = 0; ; i++) {
    try {
      await writeFile(lock, token, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const held = await stat(lock).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > KEY_LOCK_STALE_MS) {
        const away = `${lock}.stale-${randomBytes(6).toString('hex')}`;
        if (await rename(lock, away).then(() => true, () => false)) {
          const got = await stat(away).catch(() => undefined);
          if (got && (got.ino !== held.ino || Date.now() - got.mtimeMs <= KEY_LOCK_STALE_MS)) {
            const theirs = await readFile(away, 'utf8').catch(() => undefined);
            if (theirs !== undefined) await writeFile(lock, theirs, { flag: 'wx', mode: 0o600 }).catch(() => {});
          }
          await rm(away, { force: true }).catch(() => {});
        }
      } else if (i >= 300) throw new Error(`${lock} stays in place; remove it if no Hatchabot is making the runner key`, { cause: err });
      else await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    try {
      if (existsSync(to)) return 'lost';
      if (!(await holding())) continue; // taken meanwhile: start over
      await rename(from, to);
      return 'made';
    } finally {
      if (await holding()) await rm(lock, { force: true }).catch(() => {});
    }
  }
}
const KEY_LOCK_STALE_MS = 10_000;

/** `ssh://user@host[:port]` → its parts, or undefined for non-ssh endpoints. */
export function parseSshEndpoint(
  endpoint: string,
): { user?: string; host: string; port?: string } | undefined {
  // Exclude whitespace from user/host so the parser is safe standalone — a
  // caller that skips the route's zod validation still can't smuggle a newline
  // + ssh_config directive into ~/.ssh/config. What the console tunnel takes
  // (sshTarget), no more: a user or host starting with "-", which ssh reads as
  // an option and refuses, or a port of six digits, was added, and no console
  // on it ever opened (HB-1258).
  const m = /^ssh:\/\/(?:([A-Za-z0-9._][A-Za-z0-9._-]*)@)?([A-Za-z0-9._][A-Za-z0-9._-]*)(?::(\d{1,5}))?\/?$/.exec(endpoint.trim()); // hostname/IPv4 chars only — no ssh_config globs
  if (!m || !m[2]) return undefined;
  return { user: m[1], host: m[2], port: m[3] };
}

/**
 * A path as an ssh_config value. Unquoted, a space ends the value (a home
 * folder with a space in it pointed IdentityFile at a file that does not
 * exist, and the runner could not sign in, #153), and `%` starts one of
 * ssh's tokens. A double quote or a line break cannot be written safely, so
 * such a folder is refused rather than written wrong.
 */
export function sshConfigPath(path: string): string {
  if (/["\r\n]/.test(path)) throw new Error(`The ssh folder ${JSON.stringify(path)} has a quote or line break in its name, which ~/.ssh/config cannot hold: set HATCHABOT_SSH_DIR to another folder.`);
  return `"${path.replace(/%/g, '%%')}"`;
}

/**
 * Pin the dedicated key for this runner's hostname in ~/.ssh/config, so the
 * headless service authenticates deterministically: IdentitiesOnly beats any
 * ssh-agent (a passphrase-protected default key exhausts the server's auth
 * attempts), and accept-new means the first connect doesn't stall on a
 * host-key prompt. Idempotent: one marked block per hostname, never edited
 * if present — and never touching config the user wrote themselves.
 *
 * The block goes at the TOP of the file: ssh keeps the first value it reads
 * for an option, so appended below a `Host *` that says `IdentitiesOnly no`
 * it changed nothing (HB-0316). A `Host *` after it puts what was there
 * before back in force for every host, as it was. No User or Port: the
 * block is per hostname, and docker and the console tunnel pass both from
 * the address on every call; a port written here was used by a later runner
 * on the same machine at the default port (HB-0300).
 */
export async function ensureSshConfigBlock(endpoint: string, p: RunnerPaths = {}): Promise<void> {
  const parsed = parseSshEndpoint(endpoint);
  if (!parsed) return; // tcp:// endpoints have no ssh side
  // One rewrite at a time: two runners added at once each wrote the file from the same read.
  const run = configWrites.then(() => writeSshConfigBlock(parsed.host, sshDir(p)));
  configWrites = run.catch(() => {});
  return run;
}
let configWrites: Promise<void> = Promise.resolve();

async function writeSshConfigBlock(host: string, dir: string): Promise<void> {
  const cfg = join(dir, 'config');
  const mark = `${CONFIG_MARK} ${host}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const existing = existsSync(cfg) ? await readFile(cfg, 'utf8') : '';
  // Whole-line match: `.includes(mark)` treats `# agentclaw-runner: vm` as
  // present inside `# agentclaw-runner: vm2`, so registering `vm` after `vm2`
  // would silently skip writing its block (and the runner then authenticates
  // with the wrong key).
  if (existing.split('\n').some((l) => l.trim() === mark)) return;
  const lines = [
    mark,
    `Host ${host}`,
    `    IdentityFile ${sshConfigPath(join(dir, KEY_NAME))}`,
    '    IdentitiesOnly yes',
    '    StrictHostKeyChecking accept-new',
    '# (end of that block: what follows applies to every host)',
    'Host *',
    '',
  ];
  // Written beside the real file (a symlinked config stays a symlink) and renamed over it: never half a file.
  const target = existsSync(cfg) ? await realpath(cfg) : cfg;
  const tmp = `${target}.hatchabot-${process.pid}`;
  try {
    await writeFile(tmp, lines.join('\n') + existing, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * The whole runner-side setup as one paste-able snippet: authorize the
 * control plane's key, and (harmlessly, everywhere) make sure docker's usual
 * homes are on PATH for non-interactive ssh — the macOS gotcha where
 * `docker -H ssh://` fails with "command not found" against a default PATH
 * of /usr/bin:/bin. Idempotent by construction.
 */
export function runnerSetupSnippet(pubKey: string): string {
  return [
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh`,
    // The key on a line of its own, whatever the file ended with: added after a
    // last line with no newline it became part of that line's comment, sshd never
    // read it, and pasting this again found the text and did nothing (HB-0434).
    // The key's own two words are what is looked for, so a line that has it any
    // other way is the owner's and stays to the byte, and nothing is added beside
    // it: `from="10.0.0.1" <key>` and `restrict,command="…" <key>` limit it, `# <key>`
    // disabled it, a longer comment or CRLF only dress it. The one repair is a true
    // glue, a complete earlier key line running straight into the whole key (what
    // the old snippet's append left), split into both keys, and only when no line
    // has the key any other way. Written through, so a symlink stays one. Awk in the
    // C locale: a Mac's stops on a comment that is not valid UTF-8.
    `k='${pubKey}'; b='${pubKey.trim().split(/\s+/).slice(0, 2).join(' ')}'; a=~/.ssh/authorized_keys; n="$a.agentclaw-new"`,
    `[ -e "$a" ] || : >| "$a"`,
    // A copy left by a write-back that failed may be the only whole text: never overwritten.
    `if [ -e "$n" ]; then echo "WARNING: $n is left from an earlier try: compare it with $a, then delete it and paste this again"`,
    `elif ! grep -qxF "$k" "$a"; then`,
    `  p='`,
    String.raw`  function kt(s) { return s ~ /^(ssh|ecdsa|sk)-[A-Za-z0-9@.-]+[ \t]+[A-Za-z0-9+\/]+=*([ \t]|$)/ }`,
    String.raw`  function kl(s, i, c, q) { sub(/^[ \t]+/, "", s); if (kt(s)) return 1; if (substr(s, 1, 1) == "#") return 0`,
    String.raw`    for (i = 1; i <= length(s); i++) { c = substr(s, i, 1); if (c == "\"") q = !q; else if (c == "\\" && q) i++; else if (!q && (c == " " || c == "\t")) break }`,
    String.raw`    s = substr(s, i); sub(/^[ \t]+/, "", s); return kt(s) }`,
    String.raw`  function has(s, i) { while ((i = index(s, b))) { if (substr(s, i + length(b), 1) !~ /[A-Za-z0-9+\/=]/) return 1; s = substr(s, i + 1) } return 0 }`,
    String.raw`  { h = ""; g = 0; e = length($0) - length(k); if (e > 0 && substr($0, e + 1) == k) { h = substr($0, 1, e); if (h !~ /[ \t]$/ && kl(h)) g = 1 }`,
    `    if (m == "fix") { if (g) { print h; print k } else print; next }`,
    `    if (has($0)) { if (g) y = 1; else o = 1 } }`,
    `  END { if (m != "fix") { if (o) print "other"; else if (y) print "glued"; else print "none" } }'`,
    // grep says 2 when it cannot read the file: s is then not `none`, or the key would
    // go on blind, straight onto a last line this could not see the end of.
    `  s=none; grep -qF "$b" "$a"; case $? in 0) s="$(LC_ALL=C awk -v k="$k" -v b="$b" -v m=scan "$p" "$a")" ;; 1) ;; *) s= ;; esac`,
    `  case "$s" in`,
    `    none) [ -z "$(tail -c1 "$a")" ] || echo >> "$a"; printf '%s\\n' "$k" >> "$a" ;;`,
    `    other) echo "NOTE: this key is already in $a, on a line with more on it (options, a comment, or commented out). That line was left as it is: if this machine refuses the key, look there." ;;`,
    `    glued) if [ ! -w "$a" ]; then echo "WARNING: could not put the key on its own line in $a: it is read-only"`,
    `      elif ! LC_ALL=C awk -v k="$k" -v b="$b" -v m=fix "$p" "$a" >| "$n"; then rm -f "$n"; echo "WARNING: could not write $n, so $a was left as it was"`,
    `      elif cat "$n" >| "$a"; then rm -f "$n"`,
    `      else echo "WARNING: could not write $a; if it is now cut short, its whole text is in $n"; fi ;;`,
    `    *) echo "WARNING: could not read $a, so the key was not added and the file was left as it was. Make it readable with chmod 600, then paste this again" ;;`,
    `  esac`,
    `fi`,
    // Not one it cannot read: that is said above, and the owner's to change.
    `[ ! -r "$a" ] || chmod 600 "$a"`,
    // zsh reads ~/.zshenv for every invocation, including non-interactive ssh
    // (macOS default shell); bash reads ~/.bashrc via sshd's shell (Linux
    // distros commonly source it non-interactively; harmless where not).
    // At the TOP: a distro's ~/.bashrc starts by returning from any
    // non-interactive shell, so a line appended below never ran (HB-0315).
    // The new text goes in a file beside it first (a copy, so it keeps the
    // mode), then over it with mv: a failed write never leaves it cut short.
    // A symlink (dotfiles) is written through instead, so it stays one; if
    // that fails, the whole text is kept and said. Works under noclobber.
    `for f in ~/.zshenv ~/.bashrc; do`,
    `  grep -qs 'agentclaw: docker on PATH' "$f" && continue; t="$f.agentclaw-new"`,
    `  if [ -e "$t" ]; then echo "WARNING: $t is left from an earlier try: compare it with $f, then delete it and paste this again"; continue; fi`,
    `  if { [ -L "$f" ] || [ ! -f "$f" ] || cp -p "$f" "$t"; } && { printf '# agentclaw: docker on PATH for non-interactive ssh\\nexport PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"\\n\\n'; [ ! -e "$f" ] || cat "$f"; } >| "$t"; then`,
    `    if [ ! -L "$f" ]; then mv -f "$t" "$f" || { rm -f "$t"; echo "WARNING: could not add docker's PATH line to $f"; }`,
    `    elif [ ! -w "$f" ]; then rm -f "$t"; echo "WARNING: could not add docker's PATH line to $f: it is read-only"`,
    `    elif cat "$t" >| "$f"; then rm -f "$t"`,
    `    else echo "WARNING: could not add docker's PATH line to $f; if it is now cut short, its whole text is in $t"; fi`,
    `  else rm -f "$t"; echo "WARNING: could not add docker's PATH line to $f"; fi`,
    `done`,
    `command -v docker >/dev/null && docker version --format 'docker OK — server {{.Server.Version}}' || echo 'WARNING: docker not found — install Docker first'`,
  ].join('\n');
}

/** How far a copy has come: bytes of the image read so far, of about `total`. */
export interface ImageCopyProgress { bytes: number; total?: number }

/**
 * The longest a runner on another CPU may take to pull the published image
 * (HB-1254). A pull says nothing while it runs (`--quiet`), so no stall can be
 * told from a slow link; it had the save/load copy's 3 hours, and only a
 * restart ended one that hung. A ceiling: `timeoutMs` is the whole copy's
 * (the save and load, a build of the extra packages), and a longer one is
 * no reason to wait longer on a pull that may be stuck; a shorter one
 * shortens the pull too. A link too slow for it pulls by hand on the runner,
 * which the message says, and the next Install image finds the layers there.
 */
export const PULL_CEILING_MS = 3600_000;

/**
 * Copy the control plane's runtime image to a runner:
 * `docker save … | gzip | docker -H <endpoint> load` (load reads gzip as
 * is). Big (2 GB or more before compression) and slow: over a tailnet that
 * relays instead of connecting directly it took longer than the old fixed
 * 15-minute ceiling (a laptop runner, 2026-10-08), and the copy was killed
 * while still moving. Now a copy is stopped only when nothing has moved for
 * `stallMs` (default 3 minutes), or after `timeoutMs` (default 3 hours) at
 * worst; `onProgress` follows it. Requires the ssh-config block in place.
 * `signal` stops it whatever it is doing (Remove anyway, HB-1254): its docker
 * is killed, and it ends `stopped`, its error "Stopped: <the signal's reason>".
 */
export async function installRuntimeImage(
  endpoint: string,
  opts: {
    image?: string; docker?: string; timeoutMs?: number; stallMs?: number; total?: number; onProgress?: (p: ImageCopyProgress) => void;
    /**
     * The published multi-arch image of the same OpenClaw, pulled there when
     * the runner's CPU differs: by the digest the release's manifest names
     * (releaseManifest.ts publishedRuntimeImage), or by tag for a release made
     * before manifests. Its label must say that OpenClaw either way.
     */
    published?: { ref: string; openclawVersion: string };
    /** Why there is no published image to pull (no manifest could be read, or it names another OpenClaw). */
    unpublished?: string;
    /**
     * The extra apt packages this machine's image was built with (its
     * `org.hatchabot.extra-packages` label). A runner on another CPU gets
     * them built onto the published image there, under the image's name; the
     * stock image tagged as this one lacked them, and the copy still said it
     * had installed this machine's image (HB-1062).
     */
    extraPackages?: string[];
    /**
     * Why this machine's extra packages are not known (its image listing
     * failed). Not "none": a runner on another CPU would get the stock image
     * under this one's name and the install report success, so it pulls
     * nothing then. The same CPU's copy carries everything, and goes ahead.
     */
    extrasUnread?: string;
    /**
     * What this machine's image was built from (its `org.hatchabot.build-inputs`
     * label). On another CPU only its extra packages can be built again onto
     * the published image; any other way that image is not built as this one
     * is (its engine, Node, messaging plugins, settings by hand) is said in
     * `differs`, the install going ahead (HB-1189).
     */
    buildInputs?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{ ok: boolean; error?: string; pulled?: string; differs?: string; stopped?: true }> {
  const docker = opts.docker ?? 'docker';
  const image = opts.image ?? 'hatchabot-runtime:latest';
  const { signal } = opts;
  // Asked after each step: a stop ends the install there, whatever came back.
  const stopped = () => ({ ok: false, stopped: true as const, error: `Stopped: ${String(signal?.reason ?? 'the install was stopped.')}` });
  if (signal?.aborted) return stopped();
  // This machine's image runs on the CPU it was built for only: copied to a
  // runner of another kind (an arm64 box to an Intel laptop) it loads, and
  // every agent built there dies with "exec format error" (2026-10-09). The
  // image says what it was built for, the runner's daemon what it runs on;
  // when they differ the runner pulls the published image of the same
  // OpenClaw (multi-arch) instead. This machine's daemon was asked, and an
  // image built for another CPU here (under emulation) was copied to a
  // runner of this machine's kind as matching (HB-1188).
  const [built, there] = await Promise.all([imageArch(docker, image, signal), dockerArch(docker, dockerConnArgs(endpoint), signal)]);
  if (signal?.aborted) return stopped();
  // No such image here is no passing glitch: said by its name, as the copy
  // (docker save) said it before (review of HB-1188).
  if (built === 'missing') return { ok: false, error: `There is no image ${image} on this machine, so nothing was copied: build or pull it here first.` };
  // An image that does not say what it was built for is judged by this
  // machine's CPU, as before: docker records it for every image it builds or
  // pulls, so one built here for another CPU says so.
  const byMachine = built === 'unsaid';
  const here = typeof built === 'object' ? built.cpu : byMachine ? await dockerArch(docker, [], signal) : undefined;
  if (signal?.aborted) return stopped();
  // Both must be known. One that could not be read (a `docker info` that
  // failed just then, or said nothing usable) fell through to the copy, and a
  // runner of another kind got an image none of its agents could run (HB-0976).
  if (!here || !there) {
    const what = [!here && (byMachine ? 'this machine runs on' : "this machine's image is built for"), !there && 'that runner runs on'].filter(Boolean).join(' or ');
    const said = !here && !there ? 'docker did not say' : !here && !byMachine ? 'docker image inspect did not say' : 'docker info did not say';
    return { ok: false, error: `Could not tell which CPU ${what} (${said}), so nothing was copied: an image for another kind of CPU would not run there. Try again in a moment.` };
  }
  if (here !== there) {
    if (!opts.published) {
      return { ok: false, error: `This machine's image is built for ${here}, and that runner is ${there}: a copy would not run there, and there is no published image of this version to pull instead${opts.unpublished ? ` (${opts.unpublished.replace(/\.$/, '')})` : ''}.` };
    }
    const { ref, openclawVersion } = opts.published;
    if (opts.extrasUnread) {
      return { ok: false, error: `That runner is ${there} and this machine's image ${here}, so it gets the published image with this machine's extra packages built onto it, and which extra packages this machine's image has could not be read just now (${opts.extrasUnread}). Nothing was installed: try again in a moment.` };
    }
    const extras = opts.extraPackages ?? [];
    // Names only (they go into a RUN line), checked as a recipe checks them.
    const bad = extras.find((p) => p.length > 64 || !APT_PACKAGE_NAME.test(p));
    if (bad) return { ok: false, error: `This machine's image records an extra package "${bad.slice(0, 40)}" that is not a package name, so it cannot be made again on that runner (${there}; this machine's image is ${here}).` };
    const pullMs = Math.min(opts.timeoutMs ?? PULL_CEILING_MS, PULL_CEILING_MS);
    const pulled = await dockerRun(docker, [...dockerConnArgs(endpoint), 'pull', '--quiet', ref], pullMs, signal);
    if (signal?.aborted) return stopped();
    if (pulled.timedOut) {
      const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
      const within = pullMs === PULL_CEILING_MS ? 'an hour' : pullMs >= 60_000 ? count(Math.round(pullMs / 60_000), 'minute') : count(Math.ceil(pullMs / 1000), 'second');
      return { ok: false, error: `That runner is ${there} and this machine's image ${here}, so it needs the published image ${ref}, and pulling it there did not finish within ${within}, so it was stopped: is that runner's link slow, or the pull stuck? Try Install image again, or pull it on that runner by hand (docker pull ${ref}), then Install image again.` };
    }
    if (pulled.code !== 0) {
      return { ok: false, error: `That runner is ${there} and this machine's image ${here}, so it needs the published image ${ref}, and pulling it there failed: ${pulled.stderr.slice(-300) || `exit ${pulled.code}`}` };
    }
    // The tag must hold the OpenClaw asked for (build-runtime-image.sh's rule: a pulled image proves its version by its label).
    const [has = '', theirs = ''] = (await dockerRun(docker, [...dockerConnArgs(endpoint), 'image', 'inspect', '--format', `{{ index .Config.Labels "org.agentclaw.openclaw-version" }}|{{ index .Config.Labels "${BUILD_INPUTS_LABEL}" }}`, ref], 60_000, signal)).stdout.trim().split('|');
    if (signal?.aborted) return stopped();
    if (has !== openclawVersion) return { ok: false, error: `The published image ${ref} carries OpenClaw ${has || 'unknown'}, not ${openclawVersion}; not using it.` };
    // Built from what this machine's was, but for its packages, which are laid
    // on below: compared when both say (an image from before the label does not).
    const mine = opts.buildInputs ? parseBuildInputs(opts.buildInputs) : undefined;
    const published = theirs && theirs !== '<no value>' ? parseBuildInputs(theirs) : undefined;
    const differs = mine?.ok && published?.ok ? inputsDiffer('the published image', { ...published.inputs, packages: [] }, mine.inputs, "this machine's image") : undefined;
    const said = differs ? { differs } : {};
    if (extras.length) {
      // Built straight under the image's name: until it has built, the runner keeps the image it had.
      const built = await buildOn(docker, dockerConnArgs(endpoint), image, recipeDockerfile({ tag: image, base: ref, packages: extras, channels: [] }), {
        'org.hatchabot.extra-packages': extras.join(' '),
        'org.hatchabot.rebuilt-from-recipe': '1',
      }, opts.timeoutMs ?? 3 * 3600_000, signal);
      if (signal?.aborted) return stopped();
      if (built.code !== 0) return { ok: false, error: `That runner is ${there} and this machine's image ${here}, so it pulled the published image ${ref}; adding this machine's extra packages (${extras.join(', ')}) to it there failed, and the runner keeps the image it had: ${(built.stderr || built.stdout).slice(-300) || `exit ${built.code}`}` };
      return { ok: true, pulled: ref, ...said };
    }
    const tagged = await dockerRun(docker, [...dockerConnArgs(endpoint), 'tag', ref, image], 60_000, signal);
    if (signal?.aborted) return stopped();
    if (tagged.code !== 0) return { ok: false, error: `Tagging ${ref} as ${image} on the runner failed: ${tagged.stderr.slice(-300)}` };
    return { ok: true, pulled: ref, ...said };
  }
  return new Promise((resolve) => {
    const save = spawn(docker, ['save', image]);
    const load = spawn(docker, [...dockerConnArgs(endpoint), 'load']);
    // Fast compression: the layers are plain tars, so even level 1 roughly
    // halves what crosses the link, at little CPU here.
    const gzip = createGzip({ level: 1 });
    save.stdout.pipe(gzip).pipe(load.stdin);
    // A dead receiver EPIPEs the sender; without handlers that's an uncaught
    // stream error that kills the whole control plane.
    save.stdout.on('error', () => {});
    gzip.on('error', () => {});
    load.stdin.on('error', () => {});
    let stderr = '';
    save.stderr.on('data', (d) => (stderr += d));
    load.stderr.on('data', (d) => (stderr += d));
    let settled = false;
    const onStop = () => { save.kill('SIGKILL'); load.kill('SIGKILL'); finish(stopped()); };
    const finish = (r: { ok: boolean; error?: string; stopped?: true }) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      clearTimeout(stall);
      signal?.removeEventListener('abort', onStop);
      resolve(r);
    };
    const kill = (error: string) => { save.kill('SIGKILL'); load.kill('SIGKILL'); finish({ ok: false, error }); };
    signal?.addEventListener('abort', onStop, { once: true });
    const stallMs = opts.stallMs ?? 3 * 60_000;
    let stall = setTimeout(() => kill('The copy stopped moving (nothing for 3 minutes): is the runner still reachable?'), stallMs);
    const overall = setTimeout(() => kill('Timed out copying the image to the runner.'), opts.timeoutMs ?? 3 * 3600_000);
    stall.unref();
    overall.unref();
    let bytes = 0;
    let told = 0;
    save.stdout.on('data', (c: Buffer) => {
      bytes += c.length;
      clearTimeout(stall);
      stall = setTimeout(() => kill('The copy stopped moving (nothing for 3 minutes): is the runner still reachable?'), stallMs);
      stall.unref();
      if (opts.onProgress && Date.now() - told > 1000) { told = Date.now(); opts.onProgress({ bytes, total: opts.total }); }
    });
    let saveCode: number | null = null;
    let loadCode: number | null | undefined; // undefined until the receiver has closed
    const judge = () => {
      if (loadCode === 0 && saveCode === 0) return finish({ ok: true });
      // The receiver is gone: a sender left running blocks on its full pipe
      // for good, holding a daemon export (audit, 2026-10-22).
      if (saveCode === null) save.kill('SIGKILL');
      finish({ ok: false, error: stderr.slice(-400) || `exit ${saveCode ?? '?'}/${loadCode}` });
    };
    save.on('close', (code) => {
      saveCode = code;
      if (code !== 0) load.kill('SIGKILL');
      // Everything is sent: the runner unpacks the last layers now, and on a
      // slow disk that can take minutes with nothing moving here — it was
      // killed as "stalled" just before it finished (2026-10-09). The overall
      // limit still stands.
      else clearTimeout(stall);
      if (loadCode !== undefined) judge();
    });
    load.on('close', (code) => {
      loadCode = code;
      opts.onProgress?.({ bytes, total: opts.total });
      // Loaded, and the sender has sent everything but not yet closed: its
      // exit decides, not a kill that reported a good copy as failed (HB-0319).
      if (code === 0 && saveCode === null) return;
      judge();
    });
    save.on('error', (err) => { load.kill('SIGKILL'); finish({ ok: false, error: String(err.message).slice(0, 200) }); });
    load.on('error', (err) => { save.kill('SIGKILL'); finish({ ok: false, error: String(err.message).slice(0, 200) }); });
  });
}

/** What CPU a Docker daemon runs on (`docker info`'s Architecture: x86_64, aarch64), in an image platform's words (cpuName), or undefined when it does not say. */
async function dockerArch(docker: string, conn: string[], signal?: AbortSignal): Promise<string | undefined> {
  const r = await dockerRun(docker, [...conn, 'info', '--format', '{{.Architecture}}'], 30_000, signal);
  const a = r.stdout.trim();
  return r.code === 0 && /^[A-Za-z0-9_-]{1,32}$/.test(a) ? cpuName(a) : undefined;
}

/**
 * What CPU an image here was built for (its platform's Architecture: amd64,
 * arm64) (HB-1188); 'missing' when there is no such image here, 'unsaid' when
 * it is here and says none, undefined when docker could not be asked.
 */
async function imageArch(docker: string, image: string, signal?: AbortSignal): Promise<{ cpu: string } | 'missing' | 'unsaid' | undefined> {
  const r = await dockerRun(docker, ['image', 'inspect', '--format', '{{.Architecture}}', image], 30_000, signal);
  const a = r.stdout.trim();
  if (r.code !== 0) return /No such (image|object)|image not known/i.test(r.stderr) ? 'missing' : undefined;
  if (a === '' || a === '<no value>') return 'unsaid';
  return /^[A-Za-z0-9_-]{1,32}$/.test(a) ? { cpu: cpuName(a) } : undefined;
}

/**
 * A CPU in the words of Docker's platforms (amd64, arm64, arm, 386): `docker
 * info` gives the kernel's (x86_64, aarch64), an image its platform's, and the
 * two are compared.
 */
function cpuName(arch: string): string {
  const a = arch.toLowerCase();
  if (a === 'x86_64' || a === 'x86-64' || a === 'x64') return 'amd64';
  if (a === 'aarch64' || a === 'armv8' || a === 'armv8l') return 'arm64';
  if (/^armv[5-7]/.test(a) || a === 'armhf' || a === 'armel') return 'arm';
  if (/^i[3-6]86$/.test(a) || a === 'x86') return '386';
  return a;
}

/** `docker build` of one Dockerfile (the whole context, so it streams to a remote daemon as easily), tagged and labelled. */
async function buildOn(docker: string, conn: string[], tag: string, dockerfile: string, labels: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<DockerRan> {
  const dir = await mkdtemp(join(tmpdir(), 'hatchabot-install-'));
  try {
    await writeFile(join(dir, 'Dockerfile'), dockerfile, 'utf8');
    return await dockerRun(docker, [...conn, 'build', '-t', tag, ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]), dir], timeoutMs, signal);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** What one docker call said; `timedOut` when its time limit killed it, `stopped` when its signal did. */
type DockerRan = { code: number; stdout: string; stderr: string; timedOut?: true; stopped?: true };

/** One docker call with no input, its output, and a time limit; `signal` kills it (HB-1254), and an aborted one never starts. */
function dockerRun(docker: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<DockerRan> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: 1, stdout: '', stderr: 'stopped', stopped: true });
    const child = spawn(docker, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let why: 'timedOut' | 'stopped' | undefined;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { why ??= 'timedOut'; child.kill('SIGKILL'); }, timeoutMs);
    timer.unref();
    const onStop = () => { why ??= 'stopped'; child.kill('SIGKILL'); };
    signal?.addEventListener('abort', onStop, { once: true });
    const done = (r: DockerRan) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onStop);
      resolve(why ? { ...r, [why]: true } : r);
    };
    child.on('error', (err) => done({ code: 1, stdout, stderr: String(err.message) }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}
