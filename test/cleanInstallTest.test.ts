import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error — a plain .mjs script, no types
import { endedOn, resultOf } from '../scripts/live.mjs';
import { doctorReport, type DoctorFacts } from '../src/doctor.js';

/**
 * scripts/clean-install-test.sh with no VM: a temp HOME and a PATH holding only
 * shims and the plain tools it needs, so the real lxc, sudo and ping cannot be
 * reached. `lxc` here answers as a VM would at each step (HB-0381). It does not
 * prove how a real VM or a real firewall behaves; the `clean-install` live tests do.
 */
const TOOLS = ['bash', 'sh', 'date', 'mkdir', 'chmod', 'grep', 'sed', 'tail', 'seq', 'uname', 'tr', 'cat', 'dirname', 'cut', 'nproc', 'timeout', 'rm', 'awk', 'getconf', 'touch'];

type World = {
  /** Bash, run for each "is cloud-init done?": prints what the VM would. `$c` is the count of asks. */
  probe?: string;
  /** Bash for the VM's ping to the internet: its exit is the ping's. */
  ping?: string;
  route?: string; gatewayPing?: number; hostPing?: number;
  /** Asked about the route, or to ping its gateway, LXD gives nothing, as a busy one does. */
  routeSilent?: boolean; gatewaySilent?: boolean;
  /** What `sudo -n iptables -S <chain>` gives; a null refuses the sudo. */
  firewall?: { forward: string; dockerUser: string | null } | null;
  /** The step during which the VM stops. */
  stopAt?: 'install' | 'firstrun';
  /** The version doctor reports before and after the upgrade. */
  before?: string; after?: string;
  /** What doctor's release line says after the upgrade, when not `Release <after>`. */
  afterDoctor?: string;
  installOk?: boolean;
  /** `lxc info` gets no answer, as from a busy LXD. */
  infoFails?: boolean;
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(w: World, args: string[] = [], script = 'scripts/clean-install-test.sh') {
  const root = mkdtempSync(join(tmpdir(), 'hb-clean-')); dirs.push(root);
  const bin = join(root, 'bin'), home = join(root, 'home');
  mkdirSync(bin); mkdirSync(home);
  for (const t of TOOLS) {
    const p = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
    expect(p, t).not.toBe('');
    symlinkSync(p, join(bin, t));
  }
  const shim = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  shim('id', 'echo "ubuntu lxd"');
  shim('sg', `echo "sg $*" >>'${root}/sg.log'; exit 1`);
  shim('sleep', `echo "$*" >>'${root}/sleep.log'; exit 0`);
  shim('ping', `exit ${w.hostPing ?? 0}`);
  shim('journalctl', `echo "$*" >>'${root}/journal.log'; echo "lxd: Instance stopped instance=$(cat '${root}/vmname')"; echo "lxd: another line"`);
  const fw = w.firewall === undefined ? null : w.firewall;
  shim('sudo', `echo "$*" >>'${root}/sudo.log'
${fw === null ? 'exit 1' : `case "$*" in
  *"-S FORWARD"*) printf '%s\\n' ${JSON.stringify(fw.forward)} ;;
  *"-S DOCKER-USER"*) ${fw.dockerUser === null ? 'exit 1' : `printf '%s\\n' ${JSON.stringify(fw.dockerUser)}`} ;;
  *) exit 1 ;;
esac`}`);
  shim('lxc', `R='${root}'
echo "$*" >>"$R/lxc.log"
n() { local f="$R/count.$1" c; c=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); echo "$c" >"$f"; echo "$c"; }
stopped() { [ -e "$R/stopped" ]; }
case "$1" in
  launch) echo "$3" >"$R/vmname"; exit 0 ;;
  info)
    ${w.infoFails ? 'exit 1' : ''}
    case "$*" in *--show-log*) echo "the instance log" ;;
      *) stopped && echo "Status: STOPPED" || echo "Status: RUNNING" ;; esac
    exit 0 ;;
  exec) ;;
  *) exit 0 ;;
esac
stopped && exit 1
case "$*" in
  *"command -v cloud-init"*)
    c=$(n probe); ${w.probe ?? 'echo "cloud-init status: done"'}; exit $? ;;
  *"ping -c1 -W5 1.1.1.1"*) ${w.ping ?? 'exit 0'}; exit $? ;;
  *"ip route show"*) ${w.routeSilent ? 'exit 124;' : ''} echo asked; printf '%s\\n' ${JSON.stringify(w.route ?? 'default via 198.51.100.1 dev enp5s0')}; exit 0 ;;
  *"ping -c1"*) ${w.gatewaySilent ? 'exit 124;' : ''} echo asked; [ ${w.gatewayPing ?? 0} = 0 ] || echo no-reply; exit 0 ;;
  *"uname -m"*) echo aarch64; exit 0 ;;
  *"GNU_LIBC_VERSION"*) echo "glibc 2.39"; exit 0 ;;
  *"expect ~/install.exp"*)
    ${w.stopAt === 'install' ? 'touch "$R/stopped"; exit 1' : ''}
    echo "Install this? [y/N] y"; echo "Open Hatchabot: http://localhost:8080/#setup=made-up"
    exit 0 ;;
  *"is-active hatchabot"*) ${w.installOk === false ? 'echo inactive' : 'echo active'}; exit 0 ;;
  *BUNDLE.json*) exit 1 ;;
  *doctor*) echo "All good"; [ -e "$R/upgraded" ] && echo "${w.afterDoctor ?? `Release ${w.after ?? 'v9.1.0'}`}" || echo "Release ${w.before ?? 'v9.0.0'}"; exit 0 ;;
  *help*) echo "hbt is the same command as hatchabot"; exit 0 ;;
  *upgrade*) touch "$R/upgraded"; echo "Now on ${w.after ?? 'v9.1.0'}"; exit 0 ;;
  *firstrun.sh*)
    ${w.stopAt === 'firstrun' ? 'touch "$R/stopped"; exit 1' : ''}
    echo "PASS the first account is the host owner"; exit 0 ;;
esac
exit 0`);
  const r = spawnSync(join(bin, 'bash'), [resolve(script), ...args], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { HOME: home, PATH: bin },
  });
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '');
  const lxc = read('lxc.log').split('\n').filter(Boolean);
  const runDir = join(home, 'hatchabot-clean-install');
  const runs = existsSync(runDir) ? readdirSync(runDir) : [];
  return {
    code: r.status, out: r.stdout + r.stderr, lxc, read,
    pings: lxc.filter((l) => l.includes('ping -c1 -W5 1.1.1.1')).length,
    installs: lxc.filter((l) => l.includes('install.exp') && l.includes('exec')).length,
    vmLog: () => { const f = join(runDir, runs[0] ?? 'none', 'vm-stopped.log'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; },
  };
}
const T = 30_000;
const DOCKER_BLAMED = /Docker's firewall is dropping|sudo iptables -I DOCKER-USER/;

describe('the wait for cloud-init (HB-0381)', () => {
  it('a VM agent not up yet does not end the wait: no ping until cloud-init is done', () => {
    // The agent misses the first ask, the next answers. The network is up only
    // once cloud-init is done; the old loop went on at the second ask.
    const r = run({
      probe: `[ "$c" = 1 ] && exit 1; [ "$c" -ge 5 ] && { touch "$R/done"; echo "cloud-init status: done"; } || echo "cloud-init status: running"`,
      ping: '[ -e "$R/done" ]',
    }, ['--no-upgrade']);
    expect(r.out).not.toMatch(/no internet/);
    expect(r.read('count.probe').trim()).toBe('5');
    expect(r.lxc.findIndex((l) => l.includes('ping -c1 -W5 1.1.1.1'))).toBeGreaterThan(r.lxc.findLastIndex((l) => l.includes('command -v cloud-init')));
    expect(r.code, r.out).toBe(0);
  }, T);

  it('an image with no cloud-init is ready as soon as it answers', () => {
    const r = run({ probe: `[ "$c" -le 2 ] && exit 1; echo "no cloud-init"` }, ['--no-upgrade']);
    expect(r.read('count.probe').trim()).toBe('3');
    expect(r.code, r.out).toBe(0);
  }, T);

  it('cloud-init disabled, or finished in error, is not waited out', () => {
    const off = run({ probe: 'echo "cloud-init status: disabled"' }, ['--no-upgrade']);
    expect(off.read('count.probe').trim()).toBe('1');
    expect(off.code, off.out).toBe(0);
    const err = run({ probe: 'echo "cloud-init status: error"' }, ['--no-upgrade']);
    expect(err.read('count.probe').trim()).toBe('1');
    expect(err.out).toMatch(/status: error: going on/);
  }, T);

  it('60 tries with cloud-init still running: says so, blames the VM or the machine, and goes no further', () => {
    const r = run({ probe: 'echo "cloud-init status: running"' });
    expect(r.read('count.probe').trim()).toBe('60');
    expect(r.out).toMatch(/✗ the VM was not ready after 60 tries, \d+ seconds \(cloud-init status: running\) — a failure of the VM or this machine, not of the install/);
    expect(r.out).toMatch(/load average now: [\d.]+ [\d.]+ [\d.]+/);
    expect(r.out).toMatch(/journalctl -u snap\.lxd\.daemon/);
    expect(r.pings).toBe(0);
    expect(r.installs).toBe(0);
    expect(r.code).toBe(1);
  }, T);

  it('60 tries with no answer at all: says that', () => {
    const r = run({ probe: 'exit 1' });
    expect(r.read('count.probe').trim()).toBe('60');
    expect(r.out).toMatch(/not ready after 60 tries, \d+ seconds \(its agent never answered\)/);
    expect(r.code).toBe(1);
  }, T);

  it('an agent that answered and then stopped: says that instead', () => {
    const r = run({ probe: '[ "$c" = 1 ] && { echo "cloud-init status: running"; exit 0; }; exit 1' });
    expect(r.out).toMatch(/not ready after 60 tries, \d+ seconds \(its agent stopped answering\)/);
    expect(r.code).toBe(1);
  }, T);

  it('says how long the wait really was, not what 60 quiet tries would take', () => {
    // The real clock barely moves with a shim for sleep: `waited` is read from the script and run with SECONDS set.
    const src = readFileSync('scripts/clean-install-test.sh', 'utf8');
    const waited = /^waited\(\) .*$/m.exec(src)![0];
    const at = (secs: number) => spawnSync('bash', ['-c', `${waited}\nWAIT_FROM=0; SECONDS=${secs}; waited`], { encoding: 'utf8' }).stdout.trim();
    expect(at(0)).toBe('0 seconds');
    expect(at(119)).toBe('119 seconds');
    expect(at(3900)).toBe('65 minutes');
  });
});

describe('the ping (HB-0381)', () => {
  it('a network that comes up late is not "no internet"', () => {
    const r = run({ ping: 'c=$(n ping); [ "$c" -ge 4 ]' }, ['--no-upgrade']);
    expect(r.pings).toBe(4);
    expect(r.out).not.toMatch(/no internet/);
    expect(r.code, r.out).toBe(0);
  }, T);

  it('is bounded: 24 tries, then "no internet"', () => {
    const r = run({ ping: 'exit 1', route: '' });
    expect(r.pings).toBe(24);
    expect(r.out).toMatch(/✗ the VM has no internet/);
    expect(r.installs).toBe(0);
    expect(r.code).toBe(1);
  }, T);

  it('no default route: the VM or machine, with no word of Docker', () => {
    const r = run({ ping: 'exit 1', route: '', firewall: { forward: '-P FORWARD DROP', dockerUser: '-N DOCKER-USER' } });
    expect(r.out).toMatch(/no default route/);
    expect(r.out).toMatch(/load average now/);
    expect(r.out).not.toMatch(/Docker/);
  }, T);

  it('cannot reach the bridge: not Docker, whose rules are for what passes through', () => {
    const r = run({ ping: 'exit 1', gatewayPing: 1, firewall: { forward: '-P FORWARD DROP', dockerUser: '-N DOCKER-USER' } });
    expect(r.out).toMatch(/cannot reach LXD's bridge \(198\.51\.100\.1\)/);
    expect(r.out).not.toMatch(/Docker/);
  }, T);

  it('an LXD that does not answer is not a finding: no route or bridge is blamed', () => {
    for (const w of [{ routeSilent: true }, { gatewaySilent: true }]) {
      const r = run({ ping: 'exit 1', ...w, firewall: { forward: '-P FORWARD DROP', dockerUser: '-N DOCKER-USER' } });
      const said = JSON.stringify(w) + r.out;
      expect(r.out, said).toMatch(/LXD did not answer when asked about the VM's network, so nothing was found out/);
      expect(r.out, said).toMatch(/load average now/);
      expect(r.out, said).not.toMatch(/no default route|cannot reach LXD's bridge|Docker/);
    }
  }, T);

  it('this machine offline too: says that, not Docker', () => {
    const r = run({ ping: 'exit 1', hostPing: 1, firewall: { forward: '-P FORWARD DROP', dockerUser: '-N DOCKER-USER' } });
    expect(r.out).toMatch(/This machine cannot reach the internet either/);
    expect(r.out).not.toMatch(/Docker/);
  }, T);

  it('Docker\'s firewall is named, with the fix, only when that is what was found', () => {
    const found = run({ ping: 'exit 1', firewall: { forward: '-P FORWARD DROP\n-A FORWARD -j DOCKER-USER', dockerUser: '-N DOCKER-USER\n-A DOCKER-USER -j RETURN' } });
    expect(found.out).toMatch(DOCKER_BLAMED);
    expect(found.out).toMatch(/sudo iptables -I DOCKER-USER -i lxdbr0 -j ACCEPT/);
    // Already let through; FORWARD open; no Docker chain.
    for (const firewall of [
      { forward: '-P FORWARD DROP', dockerUser: '-N DOCKER-USER\n-A DOCKER-USER -i lxdbr0 -j ACCEPT' },
      { forward: '-P FORWARD ACCEPT', dockerUser: '-N DOCKER-USER' },
      { forward: '-P FORWARD DROP', dockerUser: null },
    ]) {
      const r = run({ ping: 'exit 1', firewall });
      expect(r.out, JSON.stringify(firewall)).not.toMatch(DOCKER_BLAMED);
      expect(r.out).toMatch(/Docker's firewall is not what drops it/);
    }
  }, T);

  it('a firewall it cannot read: says how to look, and blames nothing', () => {
    const r = run({ ping: 'exit 1', firewall: null });
    expect(r.out).not.toMatch(DOCKER_BLAMED);
    expect(r.out).toMatch(/could not be read without a password/);
    expect(r.out).toMatch(/sudo iptables -S DOCKER-USER/);
  }, T);
});

describe('a VM that stops by itself (HB-0381)', () => {
  const blamed = (r: ReturnType<typeof run>) => {
    expect(r.out).toMatch(/✗ the VM stopped by itself — a failure of the VM or this machine, not of the install/);
    expect(r.out).toMatch(/load average now: [\d.]+ [\d.]+ [\d.]+, on \d+ CPUs/);
    expect(r.out).toMatch(/LXD's log: journalctl -u snap\.lxd\.daemon \| grep 'Instance stopped'/);
    expect(r.vmLog()).toMatch(/the instance log/);
    expect(r.code).toBe(1);
  };

  it('during the wait: reported at once', () => {
    const r = run({ probe: '[ "$c" = 2 ] && touch "$R/stopped"; [ "$c" -ge 2 ] && exit 1; echo "cloud-init status: running"' });
    blamed(r);
    expect(r.read('count.probe').trim()).toBe('2');
    expect(r.pings).toBe(0);
  }, T);

  it('during the pings: not "no internet"', () => {
    const r = run({ ping: 'touch "$R/stopped"; exit 1' });
    blamed(r);
    expect(r.pings).toBe(1);
    expect(r.out).not.toMatch(/no internet/);
  }, T);

  it('during the install: not the install\'s failure, and LXD\'s lines are kept', () => {
    const r = run({ stopAt: 'install' });
    blamed(r);
    expect(r.out).not.toMatch(/✗ install from/);
    expect(r.read('journal.log')).toMatch(/-u snap\.lxd\.daemon --since/);
    expect(r.vmLog()).toMatch(/Instance stopped instance=hb-clean-/);
    expect(r.vmLog()).not.toMatch(/another line/); // only the lines naming this VM
  }, T);

  it('in a step that prints nothing without it: the run does not end as a pass', () => {
    const r = run({ stopAt: 'firstrun' }, ['--no-upgrade']);
    blamed(r);
    expect(r.out).not.toMatch(/── \d+ passed/);
  }, T);

  it('names no cause: the reason VMs stop is still not known', () => {
    const r = run({ stopAt: 'install' });
    expect(r.out).not.toMatch(/out of memory|OOM|because of (the )?load|caused by/i);
  }, T);

  it('a failed install on a running VM stays the install\'s failure', () => {
    const r = run({ installOk: false });
    expect(r.out).toMatch(/✗ install from/);
    expect(r.out).not.toMatch(/stopped by itself|not of the install/);
    expect(r.code).toBe(1);
  }, T);

  it('an LXD too busy to answer is not a stopped VM', () => {
    const r = run({ installOk: false, infoFails: true });
    expect(r.out).toMatch(/✗ install from/);
    expect(r.out).not.toMatch(/stopped by itself/);
  }, T);
});

describe('the whole run with no VM (HB-0378)', () => {
  /** The run as it would read had step 4 run: its SKIP line is tested on its own below. */
  const withStep4 = (out: string) => out.replace(/^SKIP: step 4 .*$/m, '');
  it('with no AI source it says step 4 did not run, so live.mjs does not record a pass', () => {
    const r = run({ before: 'v9.0.0', after: 'v9.1.0' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/SKIP: step 4 did not run \(no --ai-source\)/);
    expect(resultOf(r.code, r.out, 'v9.1.0')).toBe('skip');
  }, T);
  it('logs the load on a run that goes well, so a rerun can be compared with a failure', () => {
    const r = run({ before: 'v9.0.0', after: 'v9.1.0' });
    expect(r.out).toMatch(/load average now: [\d.]+ [\d.]+ [\d.]+/);
  }, T);
  it('its last line says the version it ended on, in the form live.mjs reads', () => {
    const r = run({ before: 'v9.0.0', after: 'v9.1.0' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/✓ hbt upgrade latest: v9\.0\.0 → v9\.1\.0/);
    expect(endedOn(r.out)).toBe('v9.1.0');
    expect(resultOf(r.code, withStep4(r.out), 'v9.1.0')).toBe('pass');
    expect(resultOf(r.code, withStep4(r.out), 'v9.2.0')).toBe('skip');
    expect(r.out).toMatch(/deleted hb-clean-/);
    expect(r.read('sg.log')).toBe(''); // the shim for lxc was the only way in
  }, T);
  it('a pre-release or test bundle keeps its whole tag, so it can pass only as itself', () => {
    for (const [tag, plain] of [['v2.132.0-test', 'v2.132.0'], ['v2.172.0-rc.1', 'v2.172.0']] as const) {
      const r = run({ before: tag }, ['--no-upgrade']);
      expect(endedOn(r.out), r.out).toBe(tag);
      expect(resultOf(r.code, withStep4(r.out), tag)).toBe('pass');
      expect(resultOf(r.code, withStep4(r.out), plain)).toBe('skip'); // the false pass: a branch's bundle clearing the plain release
    }
  }, T);

  it('--no-upgrade ends on what the channel installed', () => {
    const r = run({ before: 'v9.0.0' }, ['--no-upgrade']);
    expect(endedOn(r.out)).toBe('v9.0.0');
  }, T);
});

describe('the version it reads from doctor (HB-0404)', () => {
  /** The real doctor lines for a checkout, printed as `hatchabot doctor` prints them. */
  const doctorSays = (checkout: DoctorFacts['checkout']) => {
    const facts: DoctorFacts = {
      nodeVersion: 'v22.22.2', dockerCli: true, dockerDaemon: { ok: true, arch: 'arm64', version: '27.1' },
      envFile: { present: true, secretKey: true, password: true, authMode: 'accounts' },
      db: { path: '/x/hatchabot.sqlite', present: true, sizeMb: 10 },
      service: { manager: 'systemd', active: true, enabled: true },
      controlPlane: { url: 'http://localhost:8080', ok: true, version: '9.0.0' },
      diskFreeGb: 120, backups: { dir: '/b', lastSet: '2026-09-13', ageDays: 0 },
      tailscale: { installed: true, up: true, dns: 'box.example.net' }, containers: { running: 1, total: 1 }, checkout,
    };
    return doctorReport(facts).map((l) => `${l.level === 'ok' ? '✓' : l.level === 'warn' ? '⚠' : '✗'} ${l.text}${l.fix ? `\n    → ${l.fix}` : ''}`).join('\n') + '\n';
  };
  /** The script's own `ver`, on that text. */
  const ver = (text: string) => {
    const def = /^ver\(\) \{\n[\s\S]*?\n\}$/m.exec(readFileSync('scripts/clean-install-test.sh', 'utf8'))![0];
    return spawnSync('bash', ['-c', `${def}\nver`], { input: text, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout.trim();
  };
  /** As the run ends: its summary line, then live.mjs's verdict on it. */
  const verdict = (v: string, release: string) => resultOf(0, `── 9 passed, 0 failed · ${v || 'release unknown'} · logs: /x ──\n`, release);

  it('after `hbt upgrade vY` on vY, the pin is the release, and that run passes', () => {
    const text = doctorSays({ tag: 'v9.1.0', pinned: 'v9.1.0', dirty: [] });
    expect(text).toContain('Pinned to v9.1.0:');
    expect(ver(text)).toBe('v9.1.0');
    expect(verdict(ver(text), 'v9.1.0')).toBe('pass');
  });
  it('pinned to vY and running vX, it reads vX: no pass on vY', () => {
    const text = doctorSays({ tag: 'v9.0.0', pinned: 'v9.1.0', dirty: [] });
    expect(text).toContain('Pinned to v9.1.0 (running v9.0.0):');
    expect(ver(text)).toBe('v9.0.0');
    expect(verdict(ver(text), 'v9.1.0')).toBe('skip');
    expect(verdict(ver(text), 'v9.0.0')).toBe('pass');
  });
  it('pinned, on a commit that is no release: nothing to read, and no pass', () => {
    const text = doctorSays({ pinned: 'v9.1.0', dirty: [] });
    expect(ver(text)).toBe('');
    expect(verdict(ver(text), 'v9.1.0')).toBe('skip');
  });
  it('on a channel: the release, or the one running when the channel names another; a prerelease tag whole', () => {
    expect(ver(doctorSays({ tag: 'v9.0.0', channel: 'stable', dirty: [] }))).toBe('v9.0.0');
    expect(ver(doctorSays({ tag: 'v9.0.0', channel: 'stable', channelTarget: 'v9.1.0', dirty: [] }))).toBe('v9.0.0');
    expect(ver(doctorSays({ tag: 'v9.1.0-test.2', pinned: 'v9.1.0-test.2', dirty: [] }))).toBe('v9.1.0-test.2');
  });
  it('the whole run: `--upgrade-to vY` ends on vY with doctor saying the pin, and the live test passes it', () => {
    const r = run({ before: 'v9.0.0', after: 'v9.1.0', afterDoctor: 'Pinned to v9.1.0: a version named by hand, so automatic upgrades are paused' }, ['--upgrade-to', 'v9.1.0']);
    expect(r.out).toContain('hbt upgrade v9.1.0: v9.0.0 → v9.1.0');
    expect(endedOn(r.out)).toBe('v9.1.0');
    expect(resultOf(r.code, r.out.replace(/^SKIP: step 4 .*$/m, ''), 'v9.1.0')).toBe('pass'); // as withStep4 above
  }, T);
});
