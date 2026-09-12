import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Git data sources (docs/data-sources.md, Slice B). A repo is CLONED onto the
 * agent's durable volume — never a host mount — so the agent edits and commits
 * in its own sandbox and every change is a reviewable commit. Auth is a
 * repo-scoped SSH deploy key generated here; the private half lives in the
 * SecretStore, the public half is shown so the owner can add it to the repo
 * (read, or write for `rw`).
 */

export interface NormalizedGit {
  /** Always the ssh form we clone with: git@host:owner/repo.git */
  sshUrl: string;
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
    /^ssh:\/\/git@([a-z0-9][a-z0-9.-]*)(?::\d+)?\/([^\s]+?)(?:\.git)?\/?$/i.exec(s) ||
    /^https?:\/\/([a-z0-9][a-z0-9.-]*)\/([^\s]+?)(?:\.git)?\/?$/i.exec(s);
  if (m) {
    host = m[1];
    path = m[2];
  }
  if (!host || !path) return null;
  // owner/repo, both non-empty, no traversal or shell metacharacters.
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(path)) return null;
  const repoName = path.split('/')[1]!;
  return { sshUrl: `git@${host}:${path}.git`, host, repoName };
}

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
export function gitSyncReason(stderr: string): string {
  const s = (stderr || '').trim();
  if (/permission denied \(publickey\)/i.test(s)) {
    return "The repo rejected this agent's deploy key — add it to the repository (Settings → Deploy keys), then rebuild.";
  }
  if (/repository not found/i.test(s)) {
    return "The repo wasn't found — check the URL, or add this agent's deploy key if it's private.";
  }
  if (/host key verification failed|no matching host key/i.test(s)) {
    return "Couldn't verify the git host's SSH key.";
  }
  if (/could not resolve hostname|network is unreachable|connection timed out/i.test(s)) {
    return "Couldn't reach the git host from this agent — network or DNS.";
  }
  // Unrecognised: keep git's own words, trimmed to something renderable.
  return s.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200) || 'Clone failed.';
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
    `ssh-keyscan -t ed25519,rsa ${q(src.host)} 2>/dev/null | sort -u - ${kh} 2>/dev/null > ${kh}.tmp || ssh-keyscan -t ed25519,rsa ${q(src.host)} > ${kh}.tmp 2>/dev/null; mv ${kh}.tmp ${kh}`,
    `if [ ! -d ${q(clone)}/.git ]; then GIT_SSH_COMMAND=${q(sshCmd)} git clone ${q(src.sshUrl)} ${q(clone)}; fi`,
    `git -C ${q(clone)} config core.sshCommand ${q(sshCmd)}`,
    `git -C ${q(clone)} config user.name ${q(commit.name)}`,
    `git -C ${q(clone)} config user.email ${q(commit.email)}`,
  ].join('\n');
}
