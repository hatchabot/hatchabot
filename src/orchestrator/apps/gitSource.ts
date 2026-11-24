import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_MOUNT_NAME, RESERVED_GIT_MOUNT_NAMES } from './dataSourceLimits.js';

/**
 * Git data sources (docs/data-sources.md, Slice B). A repo is CLONED onto the
 * agent's durable volume — never a host mount — so the agent edits and commits
 * in its own sandbox and every change is a reviewable commit. Two ways in:
 *  - a private (or writable) repo: a repo-scoped SSH deploy key generated here;
 *    the private half lives in the SecretStore, the public half is shown so the
 *    owner can add it to the repo (read, or write for `rw`);
 *  - a PUBLIC repo, read-only: cloned over https with no credentials at all —
 *    nothing to add on the git host. Stored as its https URL, with no key.
 */

export interface NormalizedGit {
  /** The ssh form a deploy-key clone uses: git@host:owner/repo.git */
  sshUrl: string;
  /** The https form a public, credential-less clone uses: https://host/owner/repo.git */
  httpsUrl: string;
  host: string;
  /** Repo name without .git — the default mount/clone dir name. */
  repoName: string;
}

/**
 * Accept the shapes people paste and normalise to the ssh clone URL. Deploy
 * keys are ssh, so https is rewritten to ssh. Returns null for anything that
 * isn't a recognisable `owner/repo` on a host.
 */
export function normalizeGitUrl(input: string): NormalizedGit | null {
  const s = input.trim();
  let host: string | undefined;
  let path: string | undefined;

  // Host must START alphanumeric: a leading-dash host like `-oProxyCommand…`
  // would reach in-container ssh/ssh-keyscan as an option, not a hostname.
  let m =
    /^git@([a-z0-9][a-z0-9.-]*):([^\s]+?)(?:\.git)?\/?$/i.exec(s) ||
    // Port 22 only: another port was accepted and silently dropped, so the
    // clone went to 22 and failed as "couldn't reach" (night review).
    /^ssh:\/\/git@([a-z0-9][a-z0-9.-]*)(?::22)?\/([^\s]+?)(?:\.git)?\/?$/i.exec(s) ||
    /^https?:\/\/([a-z0-9][a-z0-9.-]*)\/([^\s]+?)(?:\.git)?\/?$/i.exec(s);
  if (m) {
    host = m[1];
    path = m[2];
  }
  if (!host || !path) return null;
  // owner/repo, both non-empty, no traversal or shell metacharacters.
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(path)) return null;
  const repoName = path.split('/')[1]!;
  return { sshUrl: `git@${host}:${path}.git`, httpsUrl: `https://${host}/${path}.git`, host, repoName };
}

/**
 * The shape a git source's mount (clone folder) name may have: what the add
 * route can produce (a repo name, no leading dot). The sync scripts paste it
 * into shell lines, so an imported bundle's name is held to it too (HB-0237).
 */
export const GIT_MOUNT_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function validGitMountName(name: string): boolean {
  return name.length <= MAX_MOUNT_NAME && GIT_MOUNT_NAME_RE.test(name) && !RESERVED_GIT_MOUNT_NAMES.has(name);
}

function assertMountName(name: string): void {
  if (!validGitMountName(name)) throw new Error('This repo source has a folder name that is not allowed. Remove it and add it again.');
}

/** A git source stored as an https URL is a public, credential-less, read-only clone. */
export function isPublicGitUrl(repoUrl: string | undefined): boolean {
  return !!repoUrl && /^https:\/\//.test(repoUrl);
}

/** What a public source can never be: writable (there is no credential to push with). */
export const PUBLIC_REPO_READ_ONLY =
  'A public repo is cloned without credentials, so it can only be read-only. For a writable checkout, add it with a deploy key instead.';

/** Generate a repo-scoped ed25519 deploy key on the control-plane host. */
export function generateDeployKey(comment: string): { privateKey: string; publicKey: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hatchabot-deploy-'));
  try {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', join(dir, 'key')], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return {
      privateKey: readFileSync(join(dir, 'key'), 'utf8'),
      publicKey: readFileSync(join(dir, 'key.pub'), 'utf8').trim(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface GitSyncSource {
  mountName: string;
  sshUrl: string;
  host: string;
}

/**
 * Turn raw git/ssh stderr into one line the owner can act on. Nearly every real
 * failure here is "the deploy key isn't on the repo yet", which the raw text
 * ("Permission denied (publickey)") states in git's terms, not the user's.
 */
export function gitSyncReason(stderr: string, mode: 'deploy-key' | 'public' = 'deploy-key'): string {
  const s = (stderr || '').trim();
  if (mode === 'public') {
    // A private repo over https asks for a login; with prompts disabled that
    // surfaces as one of these. GitHub also answers "not found" for private repos.
    if (/could not read (username|password)|terminal prompts disabled|authentication failed|returned error: 40[13]/i.test(s)) {
      return "That repo isn't public (it asked for a login) — remove it and add it again with a deploy key.";
    }
    if (/repository not found|not found|returned error: 404/i.test(s)) {
      return "The repo wasn't found — check the URL. If it's private, add it with a deploy key instead.";
    }
  }
  if (/permission denied \(publickey\)/i.test(s)) {
    return "The repo rejected this agent's deploy key — add it to the repository (Settings → Deploy keys), then rebuild.";
  }
  if (/repository not found/i.test(s)) {
    return "The repo wasn't found — check the URL, or add this agent's deploy key if it's private.";
  }
  if (/host key verification failed|no matching host key/i.test(s)) {
    // The key it trusted is kept (hostKeyTrustLine): a host that really
    // changed its key needs the owner to confirm it and clear the old one.
    return "Couldn't verify the git host's SSH key: it is not the key this agent trusted. If the host really changed its key, see \"git host key\" in docs/troubleshooting.md.";
  }
  if (/could not resolve hostname|network is unreachable|connection timed out/i.test(s)) {
    return "Couldn't reach the git host from this agent — network or DNS.";
  }
  // Unrecognised: keep git's own words, trimmed to something renderable.
  return s.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200) || 'Clone failed.';
}

const shq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;

/**
 * Removing a git source keeps its clone on the volume, so a source added again
 * at that mount found a clone already there and skipped cloning: a different
 * repo kept syncing the old one (#88). A clone of another repository is moved
 * aside (kept, not deleted: it may hold work), so the new one is cloned fresh.
 * The same repo by its other address (public https or deploy-key ssh) stays,
 * and the script repoints its remote.
 */
/** Every origin a clone of this repo can have: ssh or https, with or without .git. */
function sameRepoUrls(url: string): string[] {
  const n = normalizeGitUrl(url);
  return [...new Set(n ? [n.sshUrl, n.httpsUrl, n.sshUrl.replace(/\.git$/, ''), n.httpsUrl.replace(/\.git$/, '')] : [url])];
}

export function retainedCloneCheck(clone: string, url: string): string {
  const same = sameRepoUrls(url);
  return `if [ -d ${shq(clone)}/.git ]; then cur=$(git -C ${shq(clone)} config --get remote.origin.url || true); ` +
    `case "$cur" in ${same.map(shq).join('|')}) ;; *) aside=${shq(clone)}.replaced-$(date +%Y%m%d%H%M%S); ` +
    `mv ${shq(clone)} "$aside"; echo "Another repository's clone was here ($cur): kept at $aside" >&2 ;; esac; fi`;
}

/**
 * The idempotent clone script for a PUBLIC repo: https, no credentials, no ssh
 * setup. Prompts are disabled so a private repo fails fast instead of hanging
 * on a username prompt, only the https protocol is allowed, and the push URL is
 * replaced so an accidental `git push` fails with a clear message.
 */
export function buildPublicGitSyncScript(
  src: { mountName: string; httpsUrl: string },
  commit: { name: string; email: string },
): string {
  assertMountName(src.mountName);
  const clone = `/home/node/.openclaw/${src.mountName}`;
  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  return [
    'set -e',
    retainedCloneCheck(clone, src.httpsUrl),
    `if [ ! -d ${q(clone)}/.git ]; then GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https git -c credential.helper= clone --quiet ${q(src.httpsUrl)} ${q(clone)}; fi`,
    `git -C ${q(clone)} remote set-url origin ${q(src.httpsUrl)}`,
    `git -C ${q(clone)} config remote.origin.pushurl ${q('PUSH-DISABLED-read-only-public-clone')}`,
    `git -C ${q(clone)} config user.name ${q(commit.name)}`,
    `git -C ${q(clone)} config user.email ${q(commit.email)}`,
  ].join('\n');
}

/**
 * Trust the git host's key on first use only. Every sync used to merge a fresh,
 * unauthenticated ssh-keyscan into known_hosts, so a key served by whoever
 * answered for the host that day was trusted next to the real one, and
 * StrictHostKeyChecking could never notice the swap (#202). Once the host has
 * an entry it is kept as it is: a changed key makes ssh refuse ("Host key
 * verification failed") until the owner checks it and clears the old one.
 */
export function hostKeyTrustLine(host: string, kh: string): string {
  return `touch ${kh} && if ! ssh-keygen -F ${shq(host)} -f ${kh} >/dev/null 2>&1; then ` +
    `ssh-keyscan -t ed25519,rsa ${shq(host)} 2>/dev/null > ${kh}.tmp || true; cat ${kh}.tmp >> ${kh}; rm -f ${kh}.tmp; fi`;
}

/**
 * The idempotent script that clones (or refreshes) one git source inside the
 * container. Safe to re-run every provision/rebuild: it rewrites the key and
 * ssh config, clones only when absent, and never touches the working tree
 * otherwise. `privKeyB64` is base64 so the PEM's newlines can't break the shell.
 */
export function buildGitSyncScript(
  src: GitSyncSource,
  privKeyB64: string,
  commit: { name: string; email: string },
): string {
  assertMountName(src.mountName);
  const base = '/home/node/.openclaw';
  const sshDir = `${base}/.ssh`;
  const key = `${sshDir}/${src.mountName}_deploy`;
  const kh = `${sshDir}/known_hosts`;
  const clone = `${base}/${src.mountName}`;
  const sshCmd = `ssh -i ${key} -o IdentitiesOnly=yes -o UserKnownHostsFile=${kh} -o StrictHostKeyChecking=yes`;
  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  return [
    'set -e',
    `mkdir -p ${sshDir} && chmod 700 ${sshDir}`,
    `echo ${q(privKeyB64)} | base64 -d > ${key} && chmod 600 ${key}`,
    // ssh reads <key>.pub and <key>-cert.pub beside an -i key and offers
    // THAT key: one left from an earlier key made the host refuse every
    // clone, while Test (a fresh temp dir) passed (HB-0001).
    `rm -f ${key}.pub ${key}-cert.pub`,
    hostKeyTrustLine(src.host, kh),
    retainedCloneCheck(clone, src.sshUrl),
    `if [ ! -d ${q(clone)}/.git ]; then GIT_SSH_COMMAND=${q(sshCmd)} git clone ${q(src.sshUrl)} ${q(clone)}; fi`,
    // A clone kept from the public (https) source has that address and a
    // disabled push URL: both go, or the writable source cannot push (#89).
    `git -C ${q(clone)} remote set-url origin ${q(src.sshUrl)}`,
    `git -C ${q(clone)} config --unset-all remote.origin.pushurl || true`,
    `git -C ${q(clone)} config core.sshCommand ${q(sshCmd)}`,
    `git -C ${q(clone)} config user.name ${q(commit.name)}`,
    `git -C ${q(clone)} config user.email ${q(commit.email)}`,
  ].join('\n');
}

/**
 * What removing a git source takes off the agent's volume (HB-0002): its
 * deploy key with any .pub and -cert.pub beside it, and its clone, but only a
 * clone whose origin is still this repo (anything else at that path is not
 * ours). With `keepClone` (another source has that name now) or no repo
 * address (a removal recorded before v2.167.0), only the key goes, and a
 * clone's core.sshCommand that names it. Exits 0 only when all that is gone.
 * `mountName` is checked by the caller: [A-Za-z0-9_-] first, then also dots.
 * `unlessKeySha256`: a source added again under the name has a key of its
 * own (the SHA-256 of what its sync writes): a key file that is that one is
 * the new key, put there already, and is left, done (exit 0); any other is
 * the old one, and goes (HB-0963).
 */
export function buildGitRemovalScript(mountName: string, repoUrl: string | null, opts: { keepClone?: boolean; unlessKeySha256?: string } = {}): string {
  if (!GIT_MOUNT_NAME_RE.test(mountName) || mountName.length > MAX_MOUNT_NAME) assertMountName(mountName);
  const base = '/home/node/.openclaw';
  const key = `${base}/.ssh/${mountName}_deploy`;
  const clone = `${base}/${mountName}`;
  const unsetKey = `case "$(git -C ${clone} config --get core.sshCommand 2>/dev/null)" in *${key}*) git -C ${clone} config --unset-all core.sshCommand ;; esac`;
  const lines: string[] = [];
  if (opts.unlessKeySha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(opts.unlessKeySha256)) throw new Error('unlessKeySha256 is a hex SHA-256');
    lines.push(`if [ -f ${key} ] && [ "$(sha256sum < ${key} | cut -c1-64)" = ${opts.unlessKeySha256} ]; then exit 0; fi`);
  }
  lines.push(`rm -f ${key} ${key}.pub ${key}-cert.pub`);
  const keyGone = `[ ! -e ${key} ] && [ ! -e ${key}.pub ] && [ ! -e ${key}-cert.pub ]`;
  // An older import could save a reserved name. Revoke its deploy key, but
  // never treat OpenClaw's own directory as a clone eligible for deletion.
  if (RESERVED_GIT_MOUNT_NAMES.has(mountName)) return [...lines, keyGone].join('\n');
  if (repoUrl && !opts.keepClone) {
    const same = sameRepoUrls(repoUrl).map(shq).join('|');
    lines.push(`if [ -d ${clone}/.git ]; then case "$(git -C ${clone} config --get remote.origin.url 2>/dev/null)" in ${same}) rm -rf ${clone} ;; *) ${unsetKey} ;; esac; fi`);
    lines.push(`if [ -d ${clone}/.git ]; then case "$(git -C ${clone} config --get remote.origin.url 2>/dev/null)" in ${same}) exit 1 ;; esac; fi`);
  } else {
    lines.push(`if [ -d ${clone}/.git ]; then ${unsetKey}; fi`);
  }
  lines.push(`if [ -d ${clone}/.git ]; then case "$(git -C ${clone} config --get core.sshCommand 2>/dev/null)" in *${key}*) exit 1 ;; esac; fi`);
  lines.push(keyGone);
  return lines.join('\n');
}

// ---- Test: can the repo be reached with this source's credential? ----------------

export type GitProbeReason = 'no-git' | 'key-not-added' | 'not-found' | 'host-key' | 'timeout' | 'unreachable' | 'error';

export interface GitProbeResult {
  ok: boolean;
  /** Branches and tags the host listed (ok only). */
  refs?: number;
  reason?: GitProbeReason;
  /** One sentence for the person, never the raw stderr (it can carry the URL and the host's wording). */
  message: string;
}

/**
 * Runs one command; a test substitutes its own. `code` is null when the
 * command could not start or was killed. Its output is not kept: stdout is
 * handed to `onStdout` as it comes, and only the end of stderr is kept
 * (`stderr`, its last PROBE_STDERR_KEPT characters). More than `maxBytes` of
 * output in all ends it (`tooMuch`): a host with a huge list of branches and
 * tags, or an ssh that would not stop talking, had all of it held in memory
 * just to count lines, as fast as it came, for the whole time limit (HB-0971).
 */
export type GitProbeRunner = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; timeoutMs: number; maxBytes: number; onStdout: (chunk: string) => void },
) => Promise<{ code: number | null; stderr: string; error?: NodeJS.ErrnoException; tooMuch?: boolean }>;

/** The end of a Test's stderr that is kept: its reason is in its last lines. */
export const PROBE_STDERR_KEPT = 64 * 1024;
/** A Test's output, stdout and stderr together, past which it stops reading: about a million branches and tags. */
export const PROBE_MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * The command on this machine, in a process group of its own. Its time limit
 * ends the whole group, so the ssh git started goes with it, and answers at
 * once: killing git alone left an ssh that held its output open, and the
 * answer (with the per-source lock and a private source's key file) waited
 * for that ssh to exit, however long (HB-0930).
 */
const defaultRunner: GitProbeRunner = (cmd, args, opts) =>
  new Promise((done) => {
    let stderr = '', bytes = 0, settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (r: Awaited<ReturnType<GitProbeRunner>>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    try {
      const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      const stop = (tooMuch: boolean) => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        // Not waiting for the pipes to close: a process that left the group could still hold them.
        child.stdout.destroy();
        child.stderr.destroy();
        settle({ code: null, stderr, ...(tooMuch ? { tooMuch } : {}) });
      };
      timer = setTimeout(() => stop(false), opts.timeoutMs);
      const counted = (d: string) => {
        bytes += Buffer.byteLength(d);
        if (bytes > opts.maxBytes) stop(true);
        return !settled;
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => { if (counted(d)) opts.onStdout(d); });
      child.stderr.on('data', (d: string) => { if (counted(d)) stderr = (stderr + d).slice(-PROBE_STDERR_KEPT); });
      child.on('error', (error) => { settle({ code: null, stderr, error: error as NodeJS.ErrnoException }); });
      child.on('close', (code) => { settle({ code, stderr }); });
    } catch (error) {
      settle({ code: null, stderr, error: error as NodeJS.ErrnoException });
    }
  });

/**
 * Counts the lines of `git ls-remote` that name a ref, as they come: only the
 * start of the line being read is kept (enough to tell a ref line), never
 * the listing (HB-0971).
 */
function refLines(): { push: (chunk: string) => void; end: () => number } {
  const REF = /^[0-9a-f]{40,64}\s/;
  const HEAD = 72;
  let n = 0, head = '';
  return {
    push: (chunk) => {
      for (let i = 0; i < chunk.length;) {
        const nl = chunk.indexOf('\n', i);
        const end = nl < 0 ? chunk.length : nl;
        if (head.length < HEAD) head += chunk.slice(i, Math.min(end, i + HEAD - head.length));
        if (nl < 0) break;
        if (REF.test(head)) n++;
        head = '';
        i = nl + 1;
      }
    },
    end: () => {
      if (REF.test(head)) n++;
      head = '';
      return n;
    },
  };
}

/**
 * The Test button on a repo (Settings → Data): `git ls-remote` from THIS
 * machine with the source's own deploy key (or none, for a public clone), so
 * the owner learns whether the key is on the repo before a Rebuild tries to
 * clone it. Read access is what can be proven; a push is the only proof of
 * write access, and this never pushes. The key is written to a private temp
 * dir for the one command and removed after it, whatever happens.
 */
export async function probeGitSource(
  src: { repoUrl: string; privateKey?: string; access?: string },
  opts: { run?: GitProbeRunner; timeoutMs?: number } = {},
): Promise<GitProbeResult> {
  const run = opts.run ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  let dir: string | undefined;
  try {
    if (!isPublicGitUrl(src.repoUrl)) {
      if (!src.privateKey) return { ok: false, reason: 'error', message: 'This repo has no deploy key stored. Remove it and add it again.' };
      dir = mkdtempSync(join(tmpdir(), 'hb-git-probe-'));
      const key = join(dir, 'key');
      writeFileSync(key, src.privateKey.endsWith('\n') ? src.privateKey : `${src.privateKey}\n`, { mode: 0o600 });
      // accept-new: the first contact learns the host's key (into the temp file, not the person's known_hosts);
      // the agent's own clone still checks it strictly against the key it learnt first.
      env.GIT_SSH_COMMAND = `ssh -i '${key}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='${join(dir, 'known_hosts')}' -o ConnectTimeout=10`;
    } else {
      env.GIT_ALLOW_PROTOCOL = 'https';
    }
    const counter = refLines();
    const r = await run('git', ['-c', 'credential.helper=', 'ls-remote', '--heads', '--tags', '--', src.repoUrl],
      { env, timeoutMs, maxBytes: PROBE_MAX_OUTPUT, onStdout: counter.push });
    const write = src.access === 'rw' && !isPublicGitUrl(src.repoUrl)
      ? ' Write access cannot be tested without pushing: check that the key was added with “Allow write access”.'
      : '';
    if (r.tooMuch) {
      const listed = counter.end();
      return listed
        ? { ok: true, refs: listed, message: `Reachable: more than ${listed} branches and tags listed (the test stopped reading after ${PROBE_MAX_OUTPUT / 1048576} MB). Read access works.${write}` }
        : { ok: false, reason: 'error', message: `git said more than ${PROBE_MAX_OUTPUT / 1048576} MB without listing the repo, so the test stopped reading it.` };
    }
    if (r.error?.code === 'ENOENT') return { ok: false, reason: 'no-git', message: 'This machine has no `git` command, so the repo cannot be checked from here. The agent clones with its own git.' };
    if (r.code === null && !r.error) return { ok: false, reason: 'timeout', message: `The git host did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
    if (r.code === 0) {
      const refs = counter.end();
      return { ok: true, refs, message: `Reachable: ${refs} branch${refs === 1 ? '' : 'es'} and tag${refs === 1 ? '' : 's'} listed. Read access works.${write}` };
    }
    const err = `${r.stderr}\n${r.error?.message ?? ''}`;
    if (/Permission denied \(publickey/i.test(err) || /authentication failed/i.test(err)) {
      return { ok: false, reason: 'key-not-added', message: 'The git host refused the deploy key. Add it to the repo (🔑 Deploy key), then test again.' };
    }
    if (/Host key verification failed/i.test(err)) return { ok: false, reason: 'host-key', message: 'The git host\'s SSH key did not match the one on record. Check the host before trusting it.' };
    if (/Could not resolve hostname|Connection timed out|Network is unreachable|Connection refused|Could not connect|Operation timed out|Temporary failure in name resolution/i.test(err)) {
      return { ok: false, reason: 'unreachable', message: 'The git host could not be reached from this machine (no network, or the host name is wrong).' };
    }
    if (/Repository not found|not found|does not appear to be a git repository|Could not read from remote|403|404/i.test(err)) {
      return { ok: false, reason: 'not-found', message: isPublicGitUrl(src.repoUrl)
        ? 'The host says there is no public repo at that address. A private repo needs a deploy key: remove this source and add it again without “Public repo”.'
        : 'The host says there is no such repo, or this key cannot see it. Check the address, and that the deploy key is on this repo.' };
    }
    return { ok: false, reason: 'error', message: `git could not list the repo (exit ${r.code}).` };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
