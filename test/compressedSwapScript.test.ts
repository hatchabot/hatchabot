import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * scripts/enable-compressed-swap.sh's enable and --undo, in a sandbox: only
 * its functions run, with `run` and `write` printing what they would do, a
 * made-up /proc/swaps, and shims for blkid, modprobe and hostname. Nothing
 * reaches the machine's swap, sysfs or systemd.
 */
const SCRIPT = readFileSync('scripts/enable-compressed-swap.sh', 'utf8');
const FUNCS = SCRIPT.slice(SCRIPT.indexOf('# A compressor the kernel has'), SCRIPT.indexOf('\ncase "$ACTION" in'));
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function sandbox(o: { swaps: string[]; label?: string; conf?: string; state?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'hb-cswap-')); dirs.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const swaps = join(root, 'swaps'); mkdirSync(join(root, 'zswap'));
  writeFileSync(swaps, ['Filename Type Size Used Priority', ...o.swaps.map((s) => `${s} partition 1024 0 100`)].join('\n') + '\n');
  // blkid with no label to give fails, as it does unread (not root, or not installed).
  writeFileSync(join(bin, 'blkid'), o.label === undefined ? '#!/bin/sh\nexit 2\n' : `#!/bin/sh\necho ${o.label}\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'modprobe'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'hostname'), '#!/bin/sh\necho fixture-host\n', { mode: 0o755 });
  const conf = join(root, 'conf'), state = join(root, 'state');
  if (o.conf !== undefined) writeFileSync(conf, o.conf);
  if (o.state !== undefined) writeFileSync(state, o.state);
  const prefix = [
    'set -euo pipefail',
    `CONF=${JSON.stringify(conf)} STATE=${JSON.stringify(state)} UNIT_FILE=${JSON.stringify(join(root, 'unit'))} SYSCTL=${JSON.stringify(join(root, 'sysctl'))}`,
    `ZS=${JSON.stringify(join(root, 'zswap'))} HELPER=${JSON.stringify(join(root, 'helper'))} UNIT=fixture.service`,
    'YES=1 DRY=1 POOL=20 SHRINKER=N SWAPPINESS= ZRAM_SIZE= SWAP_SIZE=8G HELPER_BODY=helper UNIT_BODY=unit',
    'say() { echo "$*"; }; note() { echo "  $*"; }; die() { echo "die: $*"; exit 1; }; ask() { return 0; }',
    'run() { printf "RUN %s\\n" "$*"; }; write() { printf "WRITE %s\\n%s\\n" "$1" "$2"; }; human() { echo "$1"; }',
    `grep() { local a=() x; for x in "$@"; do [ "$x" = /proc/swaps ] && x=${JSON.stringify(swaps)}; a+=("$x"); done; command grep "\${a[@]}"; }`,
  ].join('\n');
  const call = (fn: string, mode = 'zswap') => spawnSync('bash', ['-c', `${prefix}\nMODE=${mode}\n${FUNCS}\n${fn}`], { encoding: 'utf8', env: scriptEnv(root, `${bin}:/usr/bin:/bin`) });
  return { call };
}

describe('enable-compressed-swap.sh --undo leaves a zram device Hatchabot did not make (HB-0281)', () => {
  const zram = ['/dev/zram0', '/swapfile'];

  it('a zram0 that was there before Hatchabot (zswap set up in front of it) stays on', () => {
    const w = sandbox({ swaps: zram, conf: 'MODE=zswap\n', state: 'PREV_ZSWAP_ENABLED=N\nPREV_ZRAM0=1\nMADE_SWAPFILE=0\n' });
    const r = w.call('undo');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('RUN swapoff /dev/zram0');
    expect(r.stdout).not.toContain('zram0/reset');
    expect(r.stdout).toContain('/dev/zram0 stays on');
  });

  it('nothing recorded, and a distribution\'s own zram0 whose label says so: it stays on', () => {
    const w = sandbox({ swaps: zram, label: 'zram0', state: 'PREV_ZSWAP_ENABLED=N\nMADE_SWAPFILE=0\n' });
    const r = w.call('undo');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('RUN swapoff /dev/zram0');
  });

  it('a zram0 that was in use before a --zram setup (the helper used it as it was) stays on', () => {
    const w = sandbox({ swaps: zram, conf: 'MODE=zram\n', state: 'PREV_ZSWAP_ENABLED=Y\nPREV_ZRAM0=1\nMADE_SWAPFILE=0\n' });
    const r = w.call('undo');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('RUN swapoff /dev/zram0');
    expect(r.stdout).toContain('RUN sh -c echo Y > '); // zswap still goes back as it was
  });

  it('the zram0 its helper made is switched off and reset: by its label, or by what was recorded', () => {
    for (const w of [
      sandbox({ swaps: zram, label: 'hatchabot-zram', conf: 'MODE=zswap\n', state: 'PREV_ZRAM0=0\n' }), // made under --zram, then set back to zswap
      sandbox({ swaps: zram, conf: 'MODE=zram\n', state: 'PREV_ZSWAP_ENABLED=N\nPREV_ZRAM0=0\n' }),
      sandbox({ swaps: zram, conf: 'MODE=zram\n', state: 'PREV_ZSWAP_ENABLED=N\nMADE_SWAPFILE=0\n' }), // a state written before PREV_ZRAM0
    ]) {
      const r = w.call('undo');
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('RUN swapoff /dev/zram0');
      expect(r.stdout).toContain('RUN sh -c echo 1 > /sys/block/zram0/reset');
    }
  });

  it('enable records whether a zram0 was in use before it', () => {
    for (const [swaps, want] of [[zram, '1'], [['/swapfile'], '0']] as const) {
      const r = sandbox({ swaps: [...swaps] }).call('enable', 'zram');
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`WRITE .*/state\\n[^]*\\nPREV_ZRAM0=${want}\\n`));
    }
  });
});
