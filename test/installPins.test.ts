import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * install.sh offers to install Docker (and, for a native install, Node 22) as
 * root. It used to pipe get.docker.com and NodeSource's setup_22.x straight
 * into a shell, the second under `sudo -E` (HB-0035): whatever those served
 * that day ran as root, with the caller's whole environment. Now Docker's
 * script is pinned to a commit and run only when its sha256 matches, and
 * NodeSource is set up as an apt repo with a pinned key and no script at all.
 * In a sandbox: a temp HOME, shims for curl, sudo, sh and dpkg that only
 * record; nothing is downloaded or installed.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const shim = (dir: string, name: string, body: string) => writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const INSTALL = readFileSync('install.sh', 'utf8');
// Away from any terminal, so the installer's questions cannot reach one.
const hasSetsid = spawnSync('sh', ['-c', 'command -v setsid']).status === 0;

/** A sandbox whose curl serves BODY for any URL (to the -o file) and logs the URL; sudo and sh only log. */
function sandbox(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'hb-pins-')); dirs.push(root);
  const bin = join(root, 'bin'), home = join(root, 'home'), log = join(root, 'calls.log');
  for (const d of [bin, home]) mkdirSync(d);
  writeFileSync(join(root, 'body'), body);
  shim(bin, 'curl', `out=; url=; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
echo "curl $url" >> '${log}'; cat '${join(root, 'body')}' > "$out"`);
  shim(bin, 'sudo', `echo "sudo $*" >> '${log}'; case "$1" in tee) cat >> '${log}' ;; esac; exit 0`);
  shim(bin, 'sh', `echo "sh $*" >> '${log}'; exit 0`);
  shim(bin, 'dpkg', 'echo arm64');
  shim(bin, 'id', 'case "$1" in -u) echo 1000 ;; -un) echo someone ;; *) echo 1000 ;; esac');
  // The machine's tools, but no Docker (this machine's would be found) and nothing that reaches its services.
  const tools = join(root, 'tools'); mkdirSync(tools);
  for (const dir of ['/usr/bin', '/bin']) {
    for (const t of existsSync(dir) ? readdirSync(dir) : []) {
      if (/^(docker.*|podman.*|sudo|sg|systemctl|launchctl|lxc|apt|apt-get|dpkg|curl|sh|id|git)$/.test(t) || existsSync(join(tools, t))) continue;
      symlinkSync(join(dir, t), join(tools, t));
    }
  }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { root, bin, home, calls, env: (extra: Record<string, string> = {}) => scriptEnv(home, `${bin}:${tools}`, extra) };
}

describe('install.sh runs no unchecked remote code as root (HB-0035)', () => {
  it('pipes nothing it downloads into a shell, and never uses sudo -E', () => {
    const code = INSTALL.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/curl[^\n]*\|\s*(sudo\s+)?(-E\s+)?(ba)?sh\b/);
    expect(code).not.toMatch(/sudo\s+-E\b/);
    expect(code).not.toMatch(/get\.docker\.com|setup_22\.x/);
    expect(INSTALL).toMatch(/^DOCKER_INSTALL_COMMIT=[0-9a-f]{40}$/m);
    expect(INSTALL).toMatch(/^DOCKER_INSTALL_SHA256=[0-9a-f]{64}$/m);
    expect(INSTALL).toMatch(/^NODESOURCE_GPG_SHA256=[0-9a-f]{64}$/m);
  });

  it('a Docker install script that is not the pinned one is refused, not run', () => {
    const s = sandbox('echo "a script that changed since the pin"\n');
    const cmd = [resolve('install.sh'), 'v9.9.9'];
    const r = spawnSync(hasSetsid ? 'setsid' : 'bash', hasSetsid ? ['bash', ...cmd] : cmd, {
      encoding: 'utf8', timeout: 30_000, input: '', env: s.env({ HATCHABOT_YES: '1', HATCHABOT_DIR: join(s.root, 'hatchabot'), TMPDIR: s.root }),
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('is not the file this installer was checked with');
    expect(r.stderr).toContain("Docker's install script could not be checked");
    expect(s.calls()).toMatch(/^curl https:\/\/raw\.githubusercontent\.com\/docker\/docker-install\/[0-9a-f]{40}\/install\.sh$/m);
    expect(s.calls()).not.toMatch(/^sh /m);
    expect(s.calls()).not.toMatch(/^sudo /m);
  });

  /** install.sh's own helper functions, run alone with the given pins. */
  const helpers = (pins: string, call: string) => {
    const fns = ['have', 'sha256', 'fetch_pinned', 'nodesource_repo'].map((f) => {
      // A one-line function, or one that ends at the first line that is just "}".
      const m = new RegExp(`^${f}\\(\\) \\{.*\\}$`, 'm').exec(INSTALL) ?? new RegExp(`^${f}\\(\\) \\{$[\\s\\S]*?^\\}$`, 'm').exec(INSTALL);
      expect(m, f).not.toBeNull();
      return m![0];
    }).join('\n');
    return `set -euo pipefail\n${pins}\n${fns}\n${call}`;
  };

  it('a Docker script that matches its pin is run, with the commit it came from', () => {
    const body = 'echo "made-up docker installer"\n';
    const s = sandbox(body);
    const f = join(s.root, 'get-docker.sh');
    const r = spawnSync('bash', ['-c', helpers(`DOCKER_INSTALL_SHA256=${sha(body)}`, `fetch_pinned https://raw.githubusercontent.com/docker/docker-install/abc/install.sh "$DOCKER_INSTALL_SHA256" '${f}' && echo checked`)], {
      encoding: 'utf8', env: s.env(),
    });
    expect(r.stdout + r.stderr).toContain('checked');
    expect(readFileSync(f, 'utf8')).toBe(body);
    expect(INSTALL).toContain('LOAD_SCRIPT_COMMIT_SHA="$DOCKER_INSTALL_COMMIT" sh "$get_docker"');
  });

  it('NodeSource: its repo with the pinned key, no script, no sudo -E; a different key is refused', () => {
    const key = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nmade-up\n-----END PGP PUBLIC KEY BLOCK-----\n';
    const good = sandbox(key);
    const r = spawnSync('bash', ['-c', helpers(`NODESOURCE_GPG_SHA256=${sha(key)}`, 'nodesource_repo')], { encoding: 'utf8', env: good.env() });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const calls = good.calls();
    expect(calls).toContain('curl https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key');
    expect(calls).toMatch(/^sudo install -D -m 644 \S+ \/etc\/apt\/keyrings\/nodesource\.asc$/m);
    expect(calls).toContain('URIs: https://deb.nodesource.com/node_22.x');
    expect(calls).toContain('Architectures: arm64');
    expect(calls).toContain('Signed-By: /etc/apt/keyrings/nodesource.asc');
    expect(calls).toContain('sudo apt-get update');
    expect(calls).not.toMatch(/sudo -E|^sh |bash/m);

    const bad = sandbox('-----BEGIN PGP PUBLIC KEY BLOCK-----\nanother key\n-----END PGP PUBLIC KEY BLOCK-----\n');
    const rb = spawnSync('bash', ['-c', helpers(`NODESOURCE_GPG_SHA256=${sha(key)}`, 'nodesource_repo')], { encoding: 'utf8', env: bad.env() });
    expect(rb.status).not.toBe(0);
    expect(rb.stderr).toContain('is not the file this installer was checked with');
    expect(bad.calls()).not.toMatch(/^sudo /m);
  });
});
