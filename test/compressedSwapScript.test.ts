import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scriptEnv, systemPathWithout } from './helpers/scriptEnv.js';

/**
 * scripts/enable-compressed-swap.sh, the whole script, on a made-up machine.
 * Every file and folder of the machine's it reads or writes is named once in
 * its path table (UNIT_FILE=/etc/…, SWAPS=/proc/swaps, ZS=/sys/…): each is
 * moved into a temp folder here, and a test below holds that nothing else in
 * the script names /etc, /proc, /sys or /swapfile. The commands that change
 * the machine's swap or services (swapon, swapoff, mkswap, modprobe, zramctl,
 * sysctl, systemctl, fallocate, …) are shims that write down what they were
 * asked and play the kernel's part in the made-up /proc/swaps; the real ones
 * are not on the PATH at all. A temp HOME, and git hooks off (scriptEnv).
 */
const SCRIPT = readFileSync('scripts/enable-compressed-swap.sh', 'utf8');
const PATHS = ['UNIT_FILE', 'HELPER', 'CONF', 'STATE', 'SYSCTL', 'MODULES_LOAD', 'FSTAB', 'SWAPFILE', 'ZS', 'BLOCK', 'SWAPS', 'MEMINFO', 'CRYPTO', 'SWAPPINESS_NOW'] as const;
/** Never the real ones: shims, or not on the PATH at all. */
const SHIMMED = ['swapon', 'swapoff', 'mkswap', 'modprobe', 'zramctl', 'sysctl', 'systemctl', 'fallocate', 'blkid', 'udevadm', 'sleep', 'hostname', 'uname', 'id'];
const UNREACHABLE = [...SHIMMED, 'sudo', 'mount', 'umount', 'losetup', 'dd', 'reboot', 'shutdown', 'poweroff', 'halt', 'insmod', 'rmmod', 'swaplabel'];
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The script with its path table pointed into `paths`. */
function sandboxed(paths: Record<(typeof PATHS)[number], string>): string {
  let s = SCRIPT;
  for (const k of PATHS) {
    const re = new RegExp(`^${k}=/.*$`, 'm');
    if (!re.test(s)) throw new Error(`the script's path table has no ${k}=/… line`);
    s = s.replace(re, `${k}=${shq(paths[k])}`);
  }
  return s;
}

interface Fixture {
  /** /proc/swaps: device names, in use now. */
  swaps?: string[];
  zswap?: Partial<Record<'enabled' | 'compressor' | 'zpool' | 'max_pool_percent' | 'shrinker_enabled', string>>;
  /** /sys/block/zram0 as the kernel has it: its disksize in bytes. */
  zram0?: { disksize: number };
  /** What blkid reads as /dev/zram0's label; none: blkid cannot say (not root, not installed). */
  label?: string;
  conf?: string;
  state?: string;
  fstab?: string;
  /** The zram module is there (modprobe -n zram). */
  zramModule?: boolean;
  /** swapoff fails as the kernel does with too little free memory. */
  swapoffFails?: boolean;
  /** swapon returns 0 but no device comes on (the kernel did not take it). */
  swaponIgnored?: boolean;
}

function machine(f: Fixture = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hb-cswap-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const calls = join(root, 'calls.log'); writeFileSync(calls, '');
  const labelFile = join(root, 'zram0.label');
  const p = {
    UNIT_FILE: join(root, 'etc/systemd/system/hatchabot-compressed-swap.service'),
    HELPER: join(root, 'usr/local/sbin/hatchabot-compressed-swap'),
    CONF: join(root, 'etc/hatchabot/compressed-swap.conf'),
    STATE: join(root, 'etc/hatchabot/compressed-swap.state'),
    SYSCTL: join(root, 'etc/sysctl.d/90-hatchabot-swap.conf'),
    MODULES_LOAD: join(root, 'etc/modules-load.d/hatchabot-compressed-swap.conf'),
    FSTAB: join(root, 'etc/fstab'),
    SWAPFILE: join(root, 'swapfile'),
    ZS: join(root, 'sys/module/zswap/parameters'),
    BLOCK: join(root, 'sys/block'),
    SWAPS: join(root, 'proc/swaps'),
    MEMINFO: join(root, 'proc/meminfo'),
    CRYPTO: join(root, 'proc/crypto'),
    SWAPPINESS_NOW: join(root, 'proc/sys/vm/swappiness'),
  };
  const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  const zram = join(p.BLOCK, 'zram0');
  // The kernel's side.
  // As the kernel writes it: the name, spaces to column 40 (at least one), then tabs.
  const swapLine = (d: string, prio = -2) => `${d}${' '.repeat(Math.max(1, 40 - d.length))}partition\t1048572\t0\t${prio}`;
  put(p.SWAPS, ['Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority', ...(f.swaps ?? []).map((d) => swapLine(d))].join('\n') + '\n');
  put(p.MEMINFO, 'MemTotal:       16777216 kB\nZswap:                 0 kB\nZswapped:              0 kB\n');
  put(p.CRYPTO, 'name         : zstd\ndriver       : zstd-generic\n');
  put(p.SWAPPINESS_NOW, '60\n');
  const zs = { enabled: 'N', compressor: 'lzo', zpool: 'zbud', max_pool_percent: '20', shrinker_enabled: 'Y', ...f.zswap };
  for (const [k, v] of Object.entries(zs)) put(join(p.ZS, k), `${v}\n`);
  const zramDir = (size: number) => {
    put(join(zram, 'disksize'), `${size}\n`); put(join(zram, 'reset'), '');
    put(join(zram, 'comp_algorithm'), 'lzo lzo-rle lz4 [zstd]\n'); put(join(zram, 'mm_stat'), '0 0 0 0 0 0 0 0\n');
  };
  if (f.zram0) zramDir(f.zram0.disksize);
  if (f.label !== undefined) writeFileSync(labelFile, `${f.label}\n`);
  put(p.FSTAB, f.fstab ?? '# made-up fstab\n');
  if (f.conf !== undefined) put(p.CONF, f.conf);
  if (f.state !== undefined) put(p.STATE, f.state);
  // The commands: each writes down what it was asked, then plays its part.
  const shim = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> ${shq(calls)}\n${body}\n`, { mode: 0o755 });
  const dev = 'for a in "$@"; do last="$a"; done';
  shim('swapon', f.swaponIgnored ? 'exit 0' : `${dev}\nprio=-2; [ "$1" = -p ] && prio="$2"\nprintf '%-39s partition\\t1048572\\t0\\t%s\\n' "$last" "$prio" >> ${shq(p.SWAPS)}`);
  shim('swapoff', f.swapoffFails
    ? `${dev}\necho "swapoff: $last: swapoff failed: Cannot allocate memory" >&2; exit 255`
    : `${dev}\ngrep -v "^$last[[:space:]]" ${shq(p.SWAPS)} > ${shq(p.SWAPS)}.new; mv ${shq(p.SWAPS)}.new ${shq(p.SWAPS)}`);
  shim('mkswap', `[ "$1" = -L ] && [ "$3" = /dev/zram0 ] && echo "$2" > ${shq(labelFile)}\nexit 0`);
  shim('blkid', `[ -f ${shq(labelFile)} ] || exit 2\ncat ${shq(labelFile)}`);
  shim('modprobe', `case "$*" in
  "-n zram") ${f.zramModule === false ? 'exit 1' : 'exit 0'} ;;
  zram*) [ -d ${shq(zram)} ] || { mkdir -p ${shq(zram)}; echo 0 > ${shq(join(zram, 'disksize'))}; : > ${shq(join(zram, 'reset'))}; echo 'lzo lzo-rle lz4 [zstd]' > ${shq(join(zram, 'comp_algorithm'))}; echo '0 0 0 0 0 0 0 0' > ${shq(join(zram, 'mm_stat'))}; } ;;
esac
exit 0`);
  shim('fallocate', `${dev}\n: > "$last"`);
  shim('systemctl', '[ "$1" = is-enabled ] && echo enabled\nexit 0');
  shim('sysctl', 'exit 0');
  shim('zramctl', 'exit 0');
  shim('udevadm', 'exit 0');
  shim('sleep', 'exit 0');
  shim('hostname', 'echo fixture-host');
  shim('uname', 'case "$1" in -r) echo 6.8.0-fixture ;; *) echo Linux ;; esac');
  shim('id', 'echo 0');
  const sys = systemPathWithout(join(root, 'sysbin'), UNREACHABLE);
  const script = join(root, 'enable-compressed-swap.sh');
  writeFileSync(script, sandboxed(p), { mode: 0o755 });
  const run = (...args: string[]) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env: scriptEnv(home, `${bin}:${sys}`), input: '' });
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);
  const log = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  const swaps = () => readFileSync(p.SWAPS, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => l.split(/\s+/)[0]);
  return { root, p, zram, run, read, log, swaps, shim };
}

describe('enable-compressed-swap.sh runs on a made-up machine only', () => {
  it('every path of the machine it touches is in its path table, and nothing outside the table names one', () => {
    const fake = Object.fromEntries(PATHS.map((k) => [k, `/fake/${k}`])) as Record<(typeof PATHS)[number], string>;
    const code = sandboxed(fake).split('\n').filter((l) => !/^\s*#/.test(l));
    expect(code.filter((l) => /\/(etc|proc|sys|usr\/local)\/|(^|[\s'"=(])\/swapfile\b/.test(l))).toEqual([]);
  });

  it('a whole run asks only the shims, and changes only the made-up machine', () => {
    const m = machine({ swaps: ['/dev/vdb2'] });
    const r = m.run('--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(m.read(m.p.CONF)).toMatch(/^MODE=zswap$/m);
    expect(m.read(join(m.p.ZS, 'enabled'))?.trim()).toBe('Y');
    expect(m.read(join(m.p.ZS, 'shrinker_enabled'))?.trim()).toBe('N');
    expect(m.log()).toContain('systemctl enable hatchabot-compressed-swap.service');
    expect(r.stdout).toContain('Compressed swap is on (zswap)');
    expect(r.stdout).toContain('Next, in Hatchabot');
  });
});

describe('enable-compressed-swap.sh --undo leaves a zram device Hatchabot did not make (HB-0281)', () => {
  const zram = ['/dev/zram0', '/dev/vdb2'];
  const swappedOff = (m: ReturnType<typeof machine>) => m.log().filter((c) => c === 'swapoff /dev/zram0');

  it('a zram0 that was there before Hatchabot (zswap set up in front of it) stays on', () => {
    const m = machine({ swaps: zram, zram0: { disksize: 1 << 30 }, conf: 'MODE=zswap\n', state: 'PREV_ZSWAP_ENABLED=N\nPREV_ZRAM0=1\nMADE_SWAPFILE=0\n' });
    const r = m.run('--undo', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(swappedOff(m)).toEqual([]);
    expect(m.read(join(m.zram, 'reset'))).toBe('');
    expect(r.stdout).toContain('/dev/zram0 stays on');
  });

  it('nothing recorded, and a distribution\'s own zram0 whose label says so: it stays on', () => {
    const m = machine({ swaps: zram, zram0: { disksize: 1 << 30 }, label: 'zram0', state: 'PREV_ZSWAP_ENABLED=N\nMADE_SWAPFILE=0\n' });
    const r = m.run('--undo', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(swappedOff(m)).toEqual([]);
  });

  it('a zram0 that was in use before a --zram setup (the helper used it as it was) stays on', () => {
    const m = machine({ swaps: zram, zram0: { disksize: 1 << 30 }, conf: 'MODE=zram\n', state: 'PREV_ZSWAP_ENABLED=Y\nPREV_ZRAM0=1\nMADE_SWAPFILE=0\n' });
    const r = m.run('--undo', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(swappedOff(m)).toEqual([]);
    expect(m.read(join(m.p.ZS, 'enabled'))?.trim()).toBe('Y'); // zswap still goes back as it was
  });

  it('the zram0 its helper made is switched off and reset: by its label, or by what was recorded', () => {
    for (const f of [
      { label: 'hatchabot-zram', conf: 'MODE=zswap\n', state: 'PREV_ZRAM0=0\n' }, // made under --zram, then set back to zswap
      { conf: 'MODE=zram\n', state: 'PREV_ZSWAP_ENABLED=N\nPREV_ZRAM0=0\n' },
      { conf: 'MODE=zram\n', state: 'PREV_ZSWAP_ENABLED=N\nMADE_SWAPFILE=0\n' }, // a state written before PREV_ZRAM0
    ]) {
      const m = machine({ swaps: zram, zram0: { disksize: 1 << 30 }, ...f });
      const r = m.run('--undo', '--yes');
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(swappedOff(m)).toEqual(['swapoff /dev/zram0']);
      expect(m.read(join(m.zram, 'reset'))?.trim()).toBe('1');
    }
  });

  it('enable records whether a zram0 was in use before it', () => {
    for (const [swaps, want] of [[['/dev/zram0'], '1'], [[], '0']] as const) {
      const m = machine({ swaps: [...swaps], ...(swaps.length ? { zram0: { disksize: 1 << 30 } } : {}) });
      const r = m.run('--zram', '--yes');
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(m.read(m.p.STATE)).toMatch(new RegExp(`^PREV_ZRAM0=${want}$`, 'm'));
    }
  });
});

describe('--zram with a disk swap on, and a run that ends with no compressed swap (HB-1070)', () => {
  it('--zram while a disk swap is on is refused before anything changes, and says what to do instead', () => {
    for (const args of [['--zram', '--yes'], ['--zram', '--dry-run']]) {
      const m = machine({ swaps: ['/dev/vdb2'], zswap: { enabled: 'Y' } });
      const r = m.run(...args);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toContain('Nothing changed: --zram needs every disk swap off, and /dev/vdb2 is on.');
      expect(r.stdout).toContain('use zswap instead, which compresses in front of that swap: run this again without --zram');
      expect(r.stdout).toContain(`turn the disk swap off first (sudo swapoff /dev/vdb2, and take its line out of ${m.p.FSTAB}), then run this again with --zram.`);
      // zswap is as it was, and nothing was written or switched.
      expect(m.read(join(m.p.ZS, 'enabled'))?.trim()).toBe('Y');
      for (const f of [m.p.CONF, m.p.STATE, m.p.HELPER, m.p.UNIT_FILE]) expect(existsSync(f), f).toBe(false);
      expect(m.log().filter((c) => /^(swapon|swapoff|mkswap|systemctl|sysctl) /.test(c))).toEqual([]);
      expect(r.stdout).not.toContain('Next, in Hatchabot');
    }
  });

  it('--zram with only zram on (or no swap at all) goes ahead, and agents get their allowance', () => {
    const m = machine({ swaps: [] });
    const r = m.run('--zram', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(m.swaps()).toEqual(['/dev/zram0']);
    expect(r.stdout).toContain('Compressed swap is on (zram)');
    expect(r.stdout).toContain('Next, in Hatchabot');
  });

  it('a run whose check finds no compressed swap afterwards exits 1, says so, and gives no next steps: zram the kernel did not take', () => {
    const m = machine({ swaps: [], swaponIgnored: true });
    const r = m.run('--zram', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('→ No compressed swap: Hatchabot gives agents no swap here.');
    expect(r.stdout).toContain('Compressed swap is not on (the line above says why), so there is nothing to set in Hatchabot yet: agents get no swap here.');
    expect(r.stdout).toContain('or put it all back: sudo ');
    expect(r.stdout).not.toContain('Next, in Hatchabot');
  });

  it('…and zswap with the swap file it made not taken, so nothing behind it', () => {
    const m = machine({ swaps: [], swaponIgnored: true });
    const r = m.run('--yes');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(m.read(join(m.p.ZS, 'enabled'))?.trim()).toBe('Y');
    expect(r.stdout).toContain('→ No compressed swap');
    expect(r.stdout).toContain('Compressed swap is not on (the line above says why)');
    expect(r.stdout).not.toContain('Next, in Hatchabot');
  });

  it('a shrinker kept on with --keep-shrinker is what was asked for: the run ends as before', () => {
    const m = machine({ swaps: ['/dev/vdb2'] });
    const r = m.run('--keep-shrinker', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('zswap is on, but its shrinker is too');
    expect(r.stdout).not.toContain('Compressed swap is not on');
  });
});

describe('--zram-size again on the zram0 this script made (HB-1112)', () => {
  const GiB = 1024 ** 3;
  const ours = (f: Partial<Fixture> = {}) => machine({
    swaps: ['/dev/zram0'], zram0: { disksize: GiB }, label: 'hatchabot-zram',
    conf: 'MODE=zram\nCOMPRESSOR=zstd\nPOOL=20\nSHRINKER=N\nZRAM_SIZE=1G\n', state: 'PREV_ZSWAP_ENABLED=Y\nPREV_ZRAM0=0\nMADE_SWAPFILE=0\n', ...f,
  });

  it('another size makes it again at that size now: off, reset, made and on again, as the script promises', () => {
    const m = ours();
    const r = m.run('--zram', '--zram-size', '8G', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('/dev/zram0, which this script made, holds up to 1.0 GB now: it is switched off');
    expect(r.stdout).toContain('made again holding up to 8G before compression');
    expect(m.log().filter((c) => /^(swapoff|mkswap|swapon) /.test(c))).toEqual(['swapoff /dev/zram0', 'mkswap -L hatchabot-zram /dev/zram0', 'swapon -p 100 /dev/zram0']);
    // In bytes, as the kernel keeps it (review of HB-1112).
    expect(m.read(join(m.zram, 'disksize'))?.trim()).toBe(String(8 * GiB));
    expect(m.read(m.p.CONF)).toMatch(new RegExp(`^ZRAM_SIZE=${8 * GiB}$`, 'm'));
    expect(m.swaps()).toEqual(['/dev/zram0']);
    expect(r.stdout).toContain('Compressed swap is on (zram)');
  });

  it('known by what was recorded where its label cannot be read', () => {
    const m = ours({ label: undefined });
    const r = m.run('--zram', '--zram-size', '2G', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(m.log()).toContain('swapoff /dev/zram0');
    expect(m.read(join(m.zram, 'disksize'))?.trim()).toBe(String(2 * GiB));
  });

  it('the size it has already (as the kernel keeps it, in bytes) is left as it is', () => {
    for (const size of ['1G', '1024M', '1073741824']) {
      const m = ours();
      const r = m.run('--zram', '--zram-size', size, '--yes');
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(m.log().filter((c) => /^(swapoff|mkswap|swapon) /.test(c)), size).toEqual([]);
      expect(m.read(join(m.zram, 'disksize'))?.trim()).toBe(String(GiB));
    }
  });

  it('one that will not go off (too little free memory) changes nothing, and says so', () => {
    const m = ours({ swapoffFails: true });
    const r = m.run('--zram', '--zram-size', '8G', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('/dev/zram0 could not be switched off to make it again at 8G (above: it needs as much free memory as it holds), so nothing was changed.');
    expect(m.read(m.p.CONF)).toMatch(/^ZRAM_SIZE=1G$/m);
    expect(m.read(join(m.zram, 'reset'))).toBe('');
    expect(m.log().filter((c) => /^(mkswap|swapon|systemctl) /.test(c))).toEqual([]);
  });

  it('a zram0 this script did not make is never switched off, and the plan says its size stays', () => {
    const m = ours({ label: 'zram0', conf: undefined, state: undefined });
    const r = m.run('--zram', '--zram-size', '8G', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('/dev/zram0 is on already, and this script did not make it: it is used as it is (1.0 GB), so --zram-size does not change it');
    expect(m.log().filter((c) => /^(swapoff|mkswap|swapon) /.test(c))).toEqual([]);
    expect(m.read(join(m.zram, 'disksize'))?.trim()).toBe(String(GiB));
  });
});

describe('--zram-size in a form the kernel cannot read (review of HB-1112)', () => {
  const GiB = 1024 ** 3;
  it('a fraction or KiB/GiB is written to the kernel in bytes, so the device holds what was asked, and a rerun at the same size leaves it alone', () => {
    for (const [size, bytes] of [['1.5G', 1.5 * GiB], ['8GiB', 8 * GiB], ['512mb', 512 * 1024 * 1024], ['1.3K', 4096]] as const) {
      const m = machine({ swaps: [] });
      const r = m.run('--zram', '--zram-size', size, '--yes');
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout, size).toContain(`a zram swap device (/dev/zram0) holding up to ${size} before compression`);
      expect(m.read(join(m.zram, 'disksize'))?.trim(), size).toBe(String(bytes));
      expect(m.read(m.p.CONF), size).toMatch(new RegExp(`^ZRAM_SIZE=${bytes}$`, 'm'));
      const again = m.run('--zram', '--zram-size', size, '--yes');
      expect(again.status, again.stdout + again.stderr).toBe(0);
      expect(m.log().filter((c) => c.startsWith('swapoff ')), size).toEqual([]);
    }
  });

  it('what is not a size is refused before anything changes, saying how to write one', () => {
    for (const size of ['lots', '8X', '-1G', '1,5G', '0', '8 G']) {
      const m = machine({ swaps: [] });
      const r = m.run('--zram', '--zram-size', size, '--yes');
      expect(r.status, size).toBe(1);
      expect(r.stderr, size).toContain(`--zram-size takes a size such as 8G, 512M or 1.5G (K, M, G or T, counted in 1024s), or a number of bytes: "${size}" is not one, so nothing was changed.`);
      expect(m.log().filter((c) => /^(modprobe zram|mkswap|swapon|swapoff|systemctl) /.test(c)), size).toEqual([]);
      expect(m.read(m.p.CONF), size).toBeUndefined();
    }
  });
});

describe('a resize that stops once zram0 is off says so, and how to get it back (review of HB-1112)', () => {
  const GiB = 1024 ** 3;
  const ours = () => machine({
    swaps: ['/dev/zram0'], zram0: { disksize: GiB }, label: 'hatchabot-zram',
    conf: 'MODE=zram\nCOMPRESSOR=zstd\nPOOL=20\nSHRINKER=N\nZRAM_SIZE=1073741824\n', state: 'PREV_ZSWAP_ENABLED=Y\nPREV_ZRAM0=0\nMADE_SWAPFILE=0\n',
  });
  /** The reset refused while something holds zram0, as the kernel refuses it (EBUSY): a folder in its place takes no write. */
  const held = (m: ReturnType<typeof machine>) => { rmSync(join(m.zram, 'reset')); mkdirSync(join(m.zram, 'reset')); };

  it('a reset refused while udev still holds the device is tried again once its queue settles, and the resize goes on', () => {
    const m = ours(); held(m);
    // The second time udev's queue settles, nothing holds it any more.
    const count = join(m.root, 'settles');
    m.shim('udevadm', `n="$(cat ${shq(count)} 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" > ${shq(count)}\n[ "$n" -lt 2 ] || { rmdir ${shq(join(m.zram, 'reset'))} 2>/dev/null && : > ${shq(join(m.zram, 'reset'))}; }\nexit 0`);
    const r = m.run('--zram', '--zram-size', '8G', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(m.log().filter((c) => /^(udevadm|sleep) /.test(c))).toEqual(['udevadm settle --timeout=5', 'sleep 1', 'udevadm settle --timeout=5', 'sleep 1']);
    expect(m.log().filter((c) => /^(swapoff|mkswap|swapon) /.test(c))).toEqual(['swapoff /dev/zram0', 'mkswap -L hatchabot-zram /dev/zram0', 'swapon -p 100 /dev/zram0']);
    expect(m.swaps()).toEqual(['/dev/zram0']);
    expect(r.stdout).toContain('Compressed swap is on (zram)');
  });

  it('one that stays refused: zram0 is off at its old size, nothing else was changed, and how to put it back is said, not the shell\'s own words', () => {
    const m = ours(); held(m);
    const r = m.run('--zram', '--zram-size', '8G', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('Error: /dev/zram0 is off: it was switched off to be made again at 8G, but it could not be reset (above: something still holds it). Nothing else was changed.');
    expect(r.stderr).toContain('Agents have no compressed swap until it is on again. To put it back as it was, at 1.0 GB: sudo swapon -p 100 /dev/zram0');
    expect(m.log().filter((c) => c.startsWith('udevadm '))).toHaveLength(4);
    expect(m.log().filter((c) => /^(mkswap|swapon|systemctl) /.test(c))).toEqual([]);
    expect(m.read(m.p.CONF)).toMatch(/^ZRAM_SIZE=1073741824$/m);
    expect(m.swaps()).toEqual([]);
    // The plan never said nothing would change.
    expect(r.stdout).not.toContain('Nothing changed');
  });

  it('a step after the reset that fails (the unit, the helper) says zram0 is off and how to make it, never only the shell\'s words', () => {
    for (const fails of ['systemctl', 'swapon']) {
      const m = ours();
      m.shim(fails, 'echo "made-up failure" >&2\nexit 1');
      const r = m.run('--zram', '--zram-size', '8G', '--yes');
      expect(r.status, fails).toBe(1);
      expect(r.stderr, fails).toContain('Error: /dev/zram0 is off: it was switched off and reset to be made again at 8G, and that stopped part-way (above).');
      expect(r.stderr, fails).toContain(`To make it, run this again (sudo ${join(m.root, 'enable-compressed-swap.sh')} --zram --zram-size 8G), or at the size it had: sudo ${join(m.root, 'enable-compressed-swap.sh')} --zram --zram-size ${GiB}`);
    }
  });

  it('a dry run of a resize changes nothing and says nothing of zram0 being off', () => {
    const m = ours();
    const r = m.run('--zram', '--zram-size', '8G', '--dry-run', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`would run: sh -c echo 1 > ${join(m.zram, 'reset')}`);
    expect(r.stderr).not.toContain('/dev/zram0 is off');
    expect(m.swaps()).toEqual(['/dev/zram0']);
  });
});

describe('an --undo that stops at zram0 says what it left, and --undo again finishes it (review of HB-1112)', () => {
  const GiB = 1024 ** 3;
  const ours = (f: Partial<Parameters<typeof machine>[0]> = {}) => {
    const m = machine({
      swaps: ['/dev/zram0'], zram0: { disksize: GiB }, label: 'hatchabot-zram',
      conf: 'MODE=zram\nCOMPRESSOR=zstd\nPOOL=20\nSHRINKER=N\nZRAM_SIZE=1073741824\n', state: 'PREV_ZSWAP_ENABLED=Y\nPREV_ZRAM0=0\nMADE_SWAPFILE=0\n', ...f,
    });
    for (const file of [m.p.UNIT_FILE, m.p.HELPER]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '# made-up\n'); }
    return m;
  };
  const held = (m: ReturnType<typeof machine>) => { rmSync(join(m.zram, 'reset')); mkdirSync(join(m.zram, 'reset')); };

  it('a reset still refused once udev has settled: what is left is said, and how to finish, not the shell\'s own words', () => {
    const m = ours(); held(m);
    const r = m.run('--undo', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('Error: --undo stopped part-way: the boot unit hatchabot-compressed-swap.service is gone and /dev/zram0 is off, but it could not be reset (above: something still holds it). zswap and swappiness are not put back yet, and the helper and the settings are still there.');
    expect(r.stderr).toContain(`Agents have no compressed swap now. Run this again in a minute, once nothing holds it: sudo ${join(m.root, 'enable-compressed-swap.sh')} --undo`);
    expect(m.log().filter((c) => c.startsWith('udevadm '))).toHaveLength(4);
    expect(m.read(m.p.UNIT_FILE)).toBeUndefined();
    expect(m.read(join(m.p.ZS, 'enabled'))?.trim()).toBe('N');
    expect(m.read(m.p.CONF)).toBeDefined();
    expect(m.swaps()).toEqual([]);
    // Once nothing holds it: --undo again resets the zram0 it made, off already, and finishes.
    rmSync(join(m.zram, 'reset'), { recursive: true }); writeFileSync(join(m.zram, 'reset'), '');
    const again = m.run('--undo', '--yes');
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain('/dev/zram0, which this script made, is off already but was never reset: it is reset');
    expect(m.read(join(m.zram, 'reset'))?.trim()).toBe('1');
    expect(m.read(join(m.p.ZS, 'enabled'))?.trim()).toBe('Y');
    for (const file of [m.p.CONF, m.p.STATE, m.p.HELPER]) expect(m.read(file), file).toBeUndefined();
  });

  it('a reset refused while udev still holds it is tried again, and the undo goes on', () => {
    const m = ours(); held(m);
    const count = join(m.root, 'settles');
    m.shim('udevadm', `n="$(cat ${shq(count)} 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" > ${shq(count)}\n[ "$n" -lt 1 ] || { rmdir ${shq(join(m.zram, 'reset'))} 2>/dev/null && : > ${shq(join(m.zram, 'reset'))}; }\nexit 0`);
    const r = m.run('--undo', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(m.read(join(m.zram, 'reset'))?.trim()).toBe('1');
    expect(m.read(join(m.p.ZS, 'enabled'))?.trim()).toBe('Y');
  });

  it('a zram0 that will not go off: it is still on, the rest as it was, and how to finish', () => {
    const m = ours({ swapoffFails: true });
    const r = m.run('--undo', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('Error: --undo stopped part-way: the boot unit hatchabot-compressed-swap.service is gone, but /dev/zram0 could not be switched off (above: that needs as much free memory as it holds). It is still on, and zswap, swappiness, the helper and the settings are as they were.');
    expect(r.stderr).toContain(`Free some memory (stop an agent or two), then run this again: sudo ${join(m.root, 'enable-compressed-swap.sh')} --undo`);
    expect(m.swaps()).toEqual(['/dev/zram0']);
  });

  it('a zram0 off with a size that this script did not make is left alone', () => {
    const m = machine({ swaps: [], zram0: { disksize: GiB }, label: 'zram0', conf: 'MODE=zswap\n', state: 'PREV_ZSWAP_ENABLED=N\nPREV_ZRAM0=1\nMADE_SWAPFILE=0\n' });
    const r = m.run('--undo', '--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(m.read(join(m.zram, 'reset'))).toBe('');
    expect(m.log().filter((c) => c.startsWith('udevadm '))).toEqual([]);
  });
});

describe('a swap file a later run makes is undone with the rest (HB-1113)', () => {
  it('zram first on a machine with no swap, then zswap (which makes the swap file), then --undo: the swap file and its fstab line go', () => {
    const m = machine({ swaps: [], zswap: { enabled: 'N', compressor: 'lzo' } });
    expect(m.run('--zram', '--yes').status).toBe(0);
    const first = m.read(m.p.STATE)!;
    expect(first).toMatch(/^MADE_SWAPFILE=0$/m);

    const r = m.run('--yes');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(m.p.SWAPFILE)).toBe(true);
    expect(m.read(m.p.FSTAB)).toContain(`${m.p.SWAPFILE} none swap sw 0 0`);
    const state = m.read(m.p.STATE)!;
    expect(state).toMatch(/^MADE_SWAPFILE=1$/m);
    // What was here before the first run is kept as that run found it.
    expect(state.split('\n').filter((l) => !l.startsWith('MADE_SWAPFILE=')).join('\n')).toBe(first.split('\n').filter((l) => !l.startsWith('MADE_SWAPFILE=')).join('\n'));
    expect(state).toMatch(/^PREV_ZSWAP_ENABLED=N$/m);

    const u = m.run('--undo', '--yes');
    expect(u.status, u.stdout + u.stderr).toBe(0);
    expect(u.stdout).toContain(`the ${m.p.SWAPFILE} this script made: you are asked separately`);
    expect(m.log()).toContain(`swapoff ${m.p.SWAPFILE}`);
    expect(existsSync(m.p.SWAPFILE)).toBe(false);
    expect(m.read(m.p.FSTAB)).not.toContain(m.p.SWAPFILE);
    expect(m.read(join(m.p.ZS, 'enabled'))?.trim()).toBe('N');
    expect(existsSync(m.p.STATE)).toBe(false);
  });

  it('a later run in front of a swap that was there already writes down no swap file of its own', () => {
    const m = machine({ swaps: ['/dev/vdb2'], state: 'PREV_ZSWAP_ENABLED=N\nPREV_ZRAM0=0\nMADE_SWAPFILE=0\n' });
    expect(m.run('--yes').status).toBe(0);
    expect(m.read(m.p.STATE)).toBe('PREV_ZSWAP_ENABLED=N\nPREV_ZRAM0=0\nMADE_SWAPFILE=0\n');
  });
});
