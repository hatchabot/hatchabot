import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentMemoryLimits, defaultSwapAllowance, describeCompressedSwap, dockerMemorySwap, effectiveSwapAllowance,
  formatSwapAllowance, limitsDrift, parseCgroupLimit, parseSwapAllowance, parseSwapProbe, procCgroupPath, wantedLimits,
  type CompressedSwap, type LimitsCheckSummary,
} from '../src/orchestrator/swap.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { hibernateAgent, resetHibernateState, wakeAgent, type HibernateDeps } from '../src/orchestrator/hibernate.js';
import { limitsCheckLine, swapLine } from '../src/doctor.js';
import { parseCgroupMemory } from '../src/providers/provider.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

/**
 * Compressed swap for agents (swap.ts): an allowance on top of the memory
 * cap, off by default, per agent / class / machine, applied live and at
 * every create, rebuild, move and wake — and given only where the host
 * compresses swap (zswap or zram), never plain disk swap.
 */

const GiB = 1024 ** 3, MiB = 1024 ** 2;

// ---- what the kernel says, as the probe script prints it -----------------------
const SWAPS_HEADER = 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority';
const probe = (o: { zswap?: 'Y' | 'N'; compressor?: string; swaps?: string[]; zram?: Record<string, { algo: string; mm: string }>; meminfo?: string }) => [
  `zswap.enabled=${o.zswap ?? 'N'}`, `zswap.compressor=${o.compressor ?? 'lzo'}`, 'zswap.zpool=zsmalloc', 'zswap.max_pool_percent=20',
  '--swaps', SWAPS_HEADER, ...(o.swaps ?? []),
  '--meminfo', o.meminfo ?? 'Zswap:                 0 kB\nZswapped:              0 kB',
  '--zram', ...Object.entries(o.zram ?? {}).flatMap(([d, z]) => [`zram.${d}.algo=${z.algo}`, `zram.${d}.mm=${z.mm}`]),
  '--end',
].join('\n');
const SWAPFILE = '/swap.img                               file\t\t16777212\t7344856\t\t-2';
const ZRAM0 = '/dev/zram0                              partition\t33554428\t1024\t\t100';

describe('the allowance: values, precedence, the cap', () => {
  afterEach(() => { delete process.env.HATCHABOT_AGENT_SWAP; });

  it('parses sizes and "off"; refuses nonsense, crumbs and extremes', () => {
    expect(parseSwapAllowance('2g')).toBe(2 * GiB);
    expect(parseSwapAllowance(' 512M ')).toBe(512 * MiB);
    expect(parseSwapAllowance('1.5gb')).toBe(Math.round(1.5 * GiB));
    for (const off of ['off', 'OFF', '0', 'none', 'no', 'false']) expect(parseSwapAllowance(off), off).toBe(0);
    for (const bad of ['', 'lots', '2', '2k', '100m', '-1g', '9999g', 2, null, undefined]) expect(parseSwapAllowance(bad), String(bad)).toBeUndefined();
    expect(formatSwapAllowance(2 * GiB)).toBe('2g');
    expect(formatSwapAllowance(0)).toBe('off');
  });

  it('off by default; the machine setting, then the class, then the agent', () => {
    expect(defaultSwapAllowance({})).toBe('off');
    expect(defaultSwapAllowance({ HATCHABOT_AGENT_SWAP: '2g' })).toBe('2g');
    expect(defaultSwapAllowance({ HATCHABOT_AGENT_SWAP: 'junk' })).toBe('off');
    expect(effectiveSwapAllowance({}, undefined, {})).toBe(0);
    expect(effectiveSwapAllowance({}, undefined, { HATCHABOT_AGENT_SWAP: '2g' })).toBe(2 * GiB);
    expect(effectiveSwapAllowance({}, { swapAllowance: '1g' }, { HATCHABOT_AGENT_SWAP: '2g' })).toBe(1 * GiB);
    expect(effectiveSwapAllowance({ swapAllowance: '512m' }, { swapAllowance: '1g' }, { HATCHABOT_AGENT_SWAP: '2g' })).toBe(512 * MiB);
    // "off" on an agent or a class wins over a machine that is on.
    expect(effectiveSwapAllowance({ swapAllowance: 'off' }, { swapAllowance: '1g' }, { HATCHABOT_AGENT_SWAP: '2g' })).toBe(0);
    expect(effectiveSwapAllowance({}, { swapAllowance: 'off' }, { HATCHABOT_AGENT_SWAP: '2g' })).toBe(0);
    // A bad stored value is skipped, like a bad memory cap.
    expect(effectiveSwapAllowance({ swapAllowance: 'junk' }, undefined, { HATCHABOT_AGENT_SWAP: '2g' })).toBe(2 * GiB);
  });

  it('never more than the memory cap it sits on', () => {
    expect(effectiveSwapAllowance({ swapAllowance: '8g' }, undefined, {})).toBe(3 * GiB); // the 3g fleet default
    expect(effectiveSwapAllowance({ swapAllowance: '8g', memoryCap: '2g' }, undefined, {})).toBe(2 * GiB);
    expect(effectiveSwapAllowance({}, { swapAllowance: '8g', memoryCap: '4g' }, {})).toBe(4 * GiB);
  });

  it('docker gets the TOTAL: cap + allowance where swap is compressed, the cap alone otherwise', () => {
    expect(dockerMemorySwap('3g', '2g', true)).toBe('5g');
    expect(dockerMemorySwap('3g', '512m', true)).toBe('3584m');
    expect(dockerMemorySwap('3g', '2g', false)).toBe('3g');
    expect(dockerMemorySwap('3g', undefined, true)).toBe('3g');
    expect(dockerMemorySwap('2g', '8g', true)).toBe('4g'); // clamped to the cap even if asked raw
  });

  it('agentMemoryLimits: the two numbers for an agent, from its own, its class\'s and the machine\'s', () => {
    const store = { getAgentClass: (id: string) => (id === 'c' ? { id: 'c', ownerId: 'o', name: 'C', memoryCap: '4g', swapAllowance: '1g', createdAt: 'now' } : undefined) };
    expect(agentMemoryLimits(store, { classId: 'c' } as never, {})).toEqual({ memory: '4g', swap: '1g' });
    expect(agentMemoryLimits(store, {} as never, {})).toEqual({ memory: '3g' });
    expect(agentMemoryLimits(store, {} as never, { HATCHABOT_AGENT_SWAP: '2g' })).toEqual({ memory: '3g', swap: '2g' });
  });
});

describe('detecting compressed swap', () => {
  it('zswap on in front of a swap file: compressed, with its settings and the pool from /proc/meminfo', () => {
    const s = parseSwapProbe(probe({ zswap: 'Y', compressor: 'zstd', swaps: [SWAPFILE], meminfo: 'Zswap:            409600 kB\nZswapped:        1228800 kB' }));
    expect(s).toMatchObject({ kind: 'zswap', compressed: true, zswap: { enabled: true, compressor: 'zstd', zpool: 'zsmalloc', maxPoolPercent: 20, poolBytes: 400 * MiB, storedBytes: 1200 * MiB } });
    expect(s.swapDevices).toEqual([{ name: '/swap.img', type: 'file', sizeBytes: 16777212 * 1024, usedBytes: 7344856 * 1024, priority: -2 }]);
    expect(describeCompressedSwap(s)).toBe('zswap (zstd, zsmalloc, pool ≤ 20%) in front of /swap.img · 1.2 GB stored in 400 MB (3.0:1)');
  });

  it('this machine as it is today (zswap built in but off, a disk swap file): not compressed, and says why', () => {
    const s = parseSwapProbe(probe({ zswap: 'N', swaps: [SWAPFILE] }));
    expect(s.kind).toBe('none');
    expect(s.compressed).toBe(false);
    expect(s.why).toMatch(/disk only/);
  });

  it('zswap on with no swap device behind it is not compressed swap', () => {
    const s = parseSwapProbe(probe({ zswap: 'Y' }));
    expect(s).toMatchObject({ kind: 'none', compressed: false });
    expect(s.why).toMatch(/no swap device behind it/);
  });

  it('zram-only swap qualifies; the bracketed algorithm is the one in use', () => {
    const s = parseSwapProbe(probe({ zswap: 'N', swaps: [ZRAM0], zram: { zram0: { algo: 'lzo [zstd] lz4', mm: `${2759 * MiB} ${700 * MiB} ${760 * MiB} 0 ${800 * MiB} 0 0 0 0` } } }));
    expect(s.kind).toBe('zram');
    expect(s.compressed).toBe(true);
    expect(s.zram).toEqual([{ device: 'zram0', algorithm: 'zstd', origBytes: 2759 * MiB, comprBytes: 700 * MiB, memUsedBytes: 760 * MiB }]);
    expect(describeCompressedSwap(s)).toBe('zram (zstd) · 2.7 GB stored in 760 MB (3.6:1)');
  });

  it('a zram device that is not a swap device (a ramdisk) does not count', () => {
    const s = parseSwapProbe(probe({ zswap: 'N', swaps: [SWAPFILE], zram: { zram1: { algo: '[lz4]', mm: '0 0 0 0 0 0 0 0 0' } } }));
    expect(s.kind).toBe('none');
  });

  it('no swap at all; and nothing readable is unknown — unknown means no swap', () => {
    expect(parseSwapProbe(probe({ zswap: 'N' }))).toMatchObject({ kind: 'none', compressed: false });
    expect(parseSwapProbe(probe({ zswap: 'N' })).why).toMatch(/no swap/);
    expect(parseSwapProbe(undefined)).toMatchObject({ kind: 'unknown', compressed: false });
    expect(parseSwapProbe('sh: cat: not found')).toMatchObject({ kind: 'unknown', compressed: false });
  });
});

describe('how much of an agent is in swap (cgroup memory.swap.current)', () => {
  it('read beside the peak and the cap hits; absent when the file is not there', () => {
    expect(parseCgroupMemory('max 2\noom_kill 0\n', '1048576\n', '629145600\n')).toEqual({ memCapHits: 2, memOomKills: 0, memPeakBytes: 1048576, swapBytes: 629145600 });
    expect(parseCgroupMemory('max 2\n', undefined, undefined)).toEqual({ memCapHits: 2 });
    expect(parseCgroupMemory(undefined, undefined, 'garbage')).toEqual({});
  });
});

// ---- the docker provider: the flags docker is given ----------------------------
const dir = mkdtempSync(join(tmpdir(), 'hb-swap-docker-'));
const LOG = join(dir, 'argv.log');
const STUB = join(dir, 'docker');
beforeAll(() => {
  // Records argv; `run … sh -c <probe>` answers with the probe output in PROBE_OUT, as a runner would.
  writeFileSync(STUB, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(LOG)}
case "$*" in *zswap.%s*) [ -f ${JSON.stringify(join(dir, 'probe.out'))} ] && cat ${JSON.stringify(join(dir, 'probe.out'))} ;; esac
exit 0
`, { mode: 0o755 });
  chmodSync(STUB, 0o755);
});
const argv = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '');
const createLine = () => argv().split('\n').find((l) => l.startsWith('create ') || / create --name /.test(l)) ?? '';
const updateLine = () => argv().split('\n').find((l) => / ?update /.test(l)) ?? '';
const spec = (over: Record<string, unknown> = {}) => ({
  agentId: 'df918a55-88cd-4d00-a17c-b8415a26ceb6', slug: 'kitchen-helper',
  workspace: { files: {}, configPatch: { agentId: 'kitchen-helper', authMode: 'api-key' as const } }, env: {}, ...over,
});
const withProbe = (out: string | undefined) => {
  let calls = 0;
  const p = new LocalDockerProvider({ docker: STUB, image: 'test-image:latest', swapProbe: async () => { calls++; return out; } });
  return { p, calls: () => calls };
};

describe('docker flags at create (provision: create, rebuild, move, restore all come through here)', () => {
  it('no allowance: swap forbidden, as before (--memory-swap equal to --memory); the host is not even probed', async () => {
    writeFileSync(LOG, '');
    const { p, calls } = withProbe(probe({ zswap: 'Y', swaps: [SWAPFILE] }));
    await p.provision(spec({ memory: '3g' }) as never);
    expect(createLine()).toContain('--memory 3g --memory-swap 3g');
    expect(calls()).toBe(0);
  });

  it('an allowance on a host with compressed swap: --memory-swap is the cap plus the allowance', async () => {
    writeFileSync(LOG, '');
    const { p } = withProbe(probe({ zswap: 'Y', compressor: 'zstd', swaps: [SWAPFILE] }));
    await p.provision(spec({ memory: '3g', memorySwap: '2g' }) as never);
    expect(createLine()).toContain('--memory 3g --memory-swap 5g');
  });

  it('an allowance on zram: given too', async () => {
    writeFileSync(LOG, '');
    const { p } = withProbe(probe({ swaps: [ZRAM0] }));
    await p.provision(spec({ memory: '4g', memorySwap: '1g' }) as never);
    expect(createLine()).toContain('--memory 4g --memory-swap 5g');
  });

  it('an allowance on a host with only disk swap, none, or an unreadable one: withheld', async () => {
    for (const out of [probe({ zswap: 'N', swaps: [SWAPFILE] }), probe({ zswap: 'Y' }), undefined]) {
      writeFileSync(LOG, '');
      const { p } = withProbe(out);
      await p.provision(spec({ memory: '3g', memorySwap: '2g' }) as never);
      expect(createLine(), String(out).slice(0, 40)).toContain('--memory 3g --memory-swap 3g');
    }
  });

  it('a probe that throws is unknown: withheld, and the create still goes through', async () => {
    writeFileSync(LOG, '');
    const p = new LocalDockerProvider({ docker: STUB, image: 'test-image:latest', swapProbe: async () => { throw new Error('boom'); } });
    await p.provision(spec({ memory: '3g', memorySwap: '2g' }) as never);
    expect(createLine()).toContain('--memory 3g --memory-swap 3g');
    expect((await p.compressedSwap()).kind).toBe('unknown');
  });

  it('the probe is cached for a minute; fresh asks again', async () => {
    const { p, calls } = withProbe(probe({ zswap: 'Y', swaps: [SWAPFILE] }));
    await p.compressedSwap(); await p.compressedSwap();
    expect(calls()).toBe(1);
    await p.compressedSwap({ fresh: true });
    expect(calls()).toBe(2);
  });
});

describe('docker update (a cap or allowance change, a wake, a host gaining or losing compressed swap)', () => {
  const REF = 'docker://hatchabot-kitchen-helper-df918a55';
  it('keeps the allowance when the cap changes, and takes it away only when asked to', async () => {
    const { p } = withProbe(probe({ zswap: 'Y', swaps: [SWAPFILE] }));
    writeFileSync(LOG, '');
    await p.updateMemory(REF, '4g', '2g');
    expect(updateLine()).toBe('update --memory 4g --memory-swap 6g hatchabot-kitchen-helper-df918a55');
    writeFileSync(LOG, '');
    await p.updateMemory(REF, '4g', undefined);
    expect(updateLine()).toBe('update --memory 4g --memory-swap 4g hatchabot-kitchen-helper-df918a55');
  });

  it('withheld without compressed swap; a bad allowance is refused before docker', async () => {
    const { p } = withProbe(probe({ zswap: 'N', swaps: [SWAPFILE] }));
    writeFileSync(LOG, '');
    await p.updateMemory(REF, '3g', '2g');
    expect(updateLine()).toBe('update --memory 3g --memory-swap 3g hatchabot-kitchen-helper-df918a55');
    await expect(p.updateMemory(REF, '3g', '2g; rm -rf /')).rejects.toThrow(/bad swap allowance/);
  });
});

describe('a runner (remote daemon) is probed through its own daemon', () => {
  it('a one-shot container reads the runner\'s sysfs and /proc/swaps; its answer decides', async () => {
    writeFileSync(join(dir, 'probe.out'), probe({ zswap: 'Y', compressor: 'zstd', swaps: [SWAPFILE] }));
    try {
      writeFileSync(LOG, '');
      const remote = new LocalDockerProvider({ docker: STUB, image: 'test-image:latest', host: 'ssh://runner@10.0.0.9', reachProbe: async () => true });
      const s = await remote.compressedSwap();
      expect(s.kind).toBe('zswap');
      const run = argv().split('\n').find((l) => l.includes('zswap.%s'))!;
      expect(run).toMatch(/^-H ssh:\/\/runner@10\.0\.0\.9 run --rm --name hatchabot-vx-[0-9a-f]+ --label hatchabot\.oneshot=hatchabot --network none alpine sh -c /);
      writeFileSync(LOG, '');
      await remote.provision(spec({ memory: '3g', memorySwap: '1g' }) as never);
      expect(createLine()).toContain('--memory 3g --memory-swap 4g');
    } finally { writeFileSync(join(dir, 'probe.out'), ''); }
  });

  it('a runner whose probe answers nothing gets no swap', async () => {
    writeFileSync(LOG, '');
    const remote = new LocalDockerProvider({ docker: STUB, image: 'test-image:latest', host: 'ssh://runner@10.0.0.10', reachProbe: async () => true });
    await remote.provision(spec({ memory: '3g', memorySwap: '1g' }) as never);
    expect(createLine()).toContain('--memory 3g --memory-swap 3g');
  });
});

// ---- the app: settings, live application, every path ---------------------------
const ZSWAP_ON: CompressedSwap = { kind: 'zswap', compressed: true, swapDevices: [{ name: '/swapfile', type: 'file', sizeBytes: 8 * GiB, usedBytes: 0, priority: -2 }], zswap: { enabled: true, compressor: 'zstd', zpool: 'zsmalloc', maxPoolPercent: 20 } };
const refOf = (w: World, id: string) => w.store.getAgent(id)!.runtimeRef!;
const patch = (w: World, id: string, payload: Record<string, unknown>, who?: string) => w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(who), payload });
const listed = async (w: World, id: string) => (await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as() })).json().find((a: any) => a.id === id);

describe('PATCH /v1/agents/:id { swapAllowance }', () => {
  afterEach(() => { delete process.env.HATCHABOT_AGENT_SWAP; });

  it('sets it, applies it live with the cap, stores it, and the list shows it in effect', async () => {
    const w = await makeWorld();
    w.provider.swapState = ZSWAP_ON;
    const id = await seedRunningAgent(w);
    const r = await patch(w, id, { swapAllowance: '2g' });
    expect(r.statusCode).toBe(200);
    expect(w.provider.memoryUpdates).toEqual([{ runtimeRef: refOf(w, id), cap: '3g', swap: '2g' }]);
    expect(w.store.getAgent(id)!.swapAllowance).toBe('2g');
    expect(w.store.listEvents([id]).find((e) => e.event === 'memory.swap_set')?.detail).toMatchObject({ swap: '2g', effective: '2g', live: true });
    w.provider.infoOverride.set(refOf(w, id), { memoryLimitBytes: 3 * GiB, memorySwapLimitBytes: 5 * GiB, swapBytes: 600 * MiB });
    expect(await listed(w, id)).toMatchObject({ swapAllowance: '2g', swapAllowanceEffective: '2g', swapInEffect: '2g', swapBytes: 600 * MiB });
    expect((await listed(w, id)).swapWithheld).toBeUndefined();
  });

  it('without compressed swap on the host: stored, but withheld from docker, and the list says why and the fix', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    expect((await patch(w, id, { swapAllowance: '1g' })).statusCode).toBe(200);
    expect(w.provider.memoryUpdates).toEqual([{ runtimeRef: refOf(w, id), cap: '3g' }]);
    expect(w.store.listEvents([id]).find((e) => e.event === 'memory.swap_set')?.detail).toMatchObject({ withheld: 'none' });
    const a = await listed(w, id);
    expect(a.swapAllowanceEffective).toBe('1g');
    expect(a.swapWithheld).toMatch(/no swap/);
    expect(a.swapFix).toMatch(/enable-compressed-swap\.sh/);
  });

  it('a later cap change keeps the allowance (updateMemory always carries both)', async () => {
    const w = await makeWorld();
    w.provider.swapState = ZSWAP_ON;
    const id = await seedRunningAgent(w);
    await patch(w, id, { swapAllowance: '2g' });
    await patch(w, id, { memoryCap: '4g' });
    expect(w.provider.memoryUpdates.at(-1)).toEqual({ runtimeRef: refOf(w, id), cap: '4g', swap: '2g' });
    // A lower cap shrinks it with it.
    await patch(w, id, { memoryCap: '1g' });
    expect(w.provider.memoryUpdates.at(-1)).toEqual({ runtimeRef: refOf(w, id), cap: '1g', swap: '1g' });
  });

  it('refuses nonsense and more than the cap; "off" and null are accepted', async () => {
    const w = await makeWorld();
    w.provider.swapState = ZSWAP_ON;
    const id = await seedRunningAgent(w);
    expect((await patch(w, id, { swapAllowance: 'lots' })).statusCode).toBe(400);
    expect((await patch(w, id, { swapAllowance: '100m' })).statusCode).toBe(400);
    const tooMuch = await patch(w, id, { swapAllowance: '4g' });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().error).toMatch(/At most the memory cap .*3g/);
    // …but fine with a cap raised in the same request.
    expect((await patch(w, id, { memoryCap: '6g', swapAllowance: '4g' })).statusCode).toBe(200);
    expect(w.provider.memoryUpdates.at(-1)).toEqual({ runtimeRef: refOf(w, id), cap: '6g', swap: '4g' });
    expect((await patch(w, id, { swapAllowance: 'off' })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.swapAllowance).toBe('off');
    expect(w.provider.memoryUpdates.at(-1)).toEqual({ runtimeRef: refOf(w, id), cap: '6g' });
    expect((await patch(w, id, { swapAllowance: null })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.swapAllowance).toBeUndefined();
  });

  it('the agent\'s own setting wins over its class, the class over the machine', async () => {
    const w = await makeWorld();
    w.provider.swapState = ZSWAP_ON;
    process.env.HATCHABOT_AGENT_SWAP = '2g';
    const id = await seedRunningAgent(w);
    expect((await listed(w, id)).swapAllowanceEffective).toBe('2g');
    const cls = (await w.f.inject({ method: 'POST', url: '/v1/agent-classes', headers: as(), payload: { name: 'Small', swapAllowance: '1g' } })).json().class;
    expect(cls.swapAllowance).toBe('1g');
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/class`, headers: as(), payload: { classId: cls.id } })).statusCode).toBe(200);
    expect(w.provider.memoryUpdates.at(-1)).toEqual({ runtimeRef: refOf(w, id), cap: '3g', swap: '1g' });
    await patch(w, id, { swapAllowance: '512m' });
    expect(w.provider.memoryUpdates.at(-1)).toEqual({ runtimeRef: refOf(w, id), cap: '3g', swap: '512m' });
    await patch(w, id, { swapAllowance: 'off' });
    expect((await listed(w, id)).swapAllowanceEffective).toBe('off');
    // A class edit reaches members without their own setting, live.
    await patch(w, id, { swapAllowance: null });
    const put = await w.f.inject({ method: 'PUT', url: `/v1/agent-classes/${cls.id}`, headers: as(), payload: { swapAllowance: '3g' } });
    expect(put.statusCode).toBe(200);
    expect(w.provider.memoryUpdates.at(-1)).toEqual({ runtimeRef: refOf(w, id), cap: '3g', swap: '3g' });
    expect((await w.f.inject({ method: 'PUT', url: `/v1/agent-classes/${cls.id}`, headers: as(), payload: { swapAllowance: '8g' } })).statusCode).toBe(400);
  });
});

describe('Settings → Hosts → Defaults: compressed swap per agent', () => {
  afterEach(() => { delete process.env.HATCHABOT_AGENT_SWAP; delete process.env.HATCHABOT_ENV_FILE; });

  it('is off by default, says whether the machine compresses swap, and a change applies live to agents that follow it', async () => {
    const w = await makeWorld();
    process.env.HATCHABOT_ENV_FILE = join(mkdtempSync(join(tmpdir(), 'hb-swap-env-')), '.env');
    writeFileSync(process.env.HATCHABOT_ENV_FILE, 'HATCHABOT_SECRET_KEY=x\n');
    const follower = await seedRunningAgent(w);
    const own = await seedRunningAgent(w, { id: 'a2', name: 'Own', slug: 'own', accountId: 'ownbot' });
    await patch(w, own, { swapAllowance: 'off' });
    w.provider.memoryUpdates.length = 0;
    let d = (await w.f.inject({ method: 'GET', url: '/v1/machine-defaults', headers: as() })).json().defaults.find((x: any) => x.key === 'agentSwap');
    expect(d).toMatchObject({ value: 'off', set: false });
    expect(d.note).toMatch(/enable-compressed-swap\.sh/);
    w.provider.swapState = ZSWAP_ON;
    d = (await w.f.inject({ method: 'GET', url: '/v1/machine-defaults', headers: as() })).json().defaults.find((x: any) => x.key === 'agentSwap');
    expect(d.note).toMatch(/^This machine compresses swap: zswap \(zstd/);
    expect((await w.f.inject({ method: 'PUT', url: '/v1/machine-defaults', headers: as(), payload: { key: 'agentSwap', value: 'nonsense' } })).statusCode).toBe(400);
    const put = await w.f.inject({ method: 'PUT', url: '/v1/machine-defaults', headers: as(), payload: { key: 'agentSwap', value: '2G' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ applied: 1, default: { value: '2g' } });
    expect(readFileSync(process.env.HATCHABOT_ENV_FILE!, 'utf8')).toMatch(/^HATCHABOT_AGENT_SWAP=2g$/m);
    expect(w.provider.memoryUpdates).toEqual([{ runtimeRef: refOf(w, follower), cap: '3g', swap: '2g' }]);
    // off again
    const off = await w.f.inject({ method: 'PUT', url: '/v1/machine-defaults', headers: as(), payload: { key: 'agentSwap', value: 'off' } });
    expect(off.json().default.value).toBe('off');
    expect(w.provider.memoryUpdates.at(-1)).toEqual({ runtimeRef: refOf(w, follower), cap: '3g' });
  });

  it('only the machine\'s owner', async () => {
    const w = await makeWorld();
    expect((await w.f.inject({ method: 'PUT', url: '/v1/machine-defaults', headers: as('someone-else'), payload: { key: 'agentSwap', value: '2g' } })).statusCode).toBe(403);
  });
});

describe('every path that makes or starts a container carries the allowance', () => {
  afterEach(() => { delete process.env.HATCHABOT_AGENT_SWAP; resetHibernateState(); });

  it('rebuild: the spec docker is given has the allowance (the provider gates it)', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    await patch(w, id, { swapAllowance: '1g' });
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: as() });
    expect(r.statusCode).toBeLessThan(300);
    for (let i = 0; i < 50 && w.store.getAgent(id)!.state !== 'RUNNING'; i++) await new Promise((res) => setTimeout(res, 20));
    expect(w.provider.lastSpec).toMatchObject({ memory: '3g', memorySwap: '1g' });
  });

  it('move to another host: the target\'s create gets it too', async () => {
    const w = await makeWorld();
    const target = new MockProvider();
    w.providers.set('mock2', target);
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Runner Two', settings: {}, createdAt: 'now' });
    const id = await seedRunningAgent(w);
    process.env.HATCHABOT_AGENT_SWAP = '2g';
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2' } })).statusCode).toBe(200);
    expect(target.lastSpec).toMatchObject({ memory: '3g', memorySwap: '2g' });
  });

  it('wake and Start: the container is given its limits as they are now before it starts', async () => {
    const w = await makeWorld();
    w.provider.swapState = ZSWAP_ON;
    const id = await seedRunningAgent(w);
    const deps: HibernateDeps = { store: w.store, secrets: w.secrets, providerFor: () => w.provider, lastActiveFor: async () => undefined, ownCrons: async () => [], isBusy: () => false, log: () => () => {} };
    await hibernateAgent(deps, w.store.getAgent(id)!, 'test');
    process.env.HATCHABOT_AGENT_SWAP = '1g'; // changed while it slept
    w.provider.memoryUpdates.length = 0;
    await wakeAgent(deps, w.store.getAgent(id)!, 'test');
    expect(w.provider.memoryUpdates).toEqual([{ runtimeRef: refOf(w, id), cap: '3g', swap: '1g' }]);
    // Start (a stopped agent) does the same.
    await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/stop`, headers: as() });
    w.provider.swapState = { kind: 'none', compressed: false, swapDevices: [] }; // the owner ran --undo
    w.provider.memoryUpdates.length = 0;
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() })).statusCode).toBe(200);
    expect(w.provider.memoryUpdates).toEqual([{ runtimeRef: refOf(w, id), cap: '3g' }]);
  });

  it('the check: a host that gains or loses compressed swap brings the allowance with it; docker\'s record with swap it should not have is corrected', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const plain = await seedRunningAgent(w, { id: 'a2', name: 'Plain', slug: 'plain', accountId: 'plainbot' });
    await patch(w, id, { swapAllowance: '2g' });
    const check = (w.f as unknown as { limitsCheck: (o?: { agentIds?: string[] }) => Promise<LimitsCheckSummary> }).limitsCheck;
    w.provider.memoryUpdates.length = 0;
    expect(await check()).toMatchObject({ checked: 2, reasserted: 0 }); // withheld already, nothing to do
    w.provider.swapState = ZSWAP_ON; // the owner ran the script
    expect((await check()).reasserted).toBe(1);
    expect(w.provider.memoryUpdates).toEqual([{ runtimeRef: refOf(w, id), cap: '3g', swap: '2g' }]);
    expect(w.store.listEvents([id]).some((e) => e.event === 'memory.swap_host')).toBe(true);
    expect((await check()).reasserted).toBe(0); // in place now
    // docker's record says 2x swap (an old container): taken away.
    w.provider.dockerLimits.set(refOf(w, plain), { memory: 3 * GiB, memorySwap: 6 * GiB });
    w.provider.memoryUpdates.length = 0;
    expect(await check()).toMatchObject({ reasserted: 1, cgroupDrifted: 0 });
    expect(w.provider.memoryUpdates).toEqual([{ runtimeRef: refOf(w, plain), cap: '3g' }]);
  });
});

describe('a systemd reload resets memory.swap.max under docker (the Spark, 2026-10-02)', () => {
  it('the decision: the cgroup says "max" while docker says no swap → apply again; the cgroup matches → nothing', () => {
    const want = wantedLimits({ memory: '3g' }, false);
    expect(want).toEqual({ memoryMax: 3 * GiB, swapMax: 0 });
    const docker = { running: true, dockerMemory: 3 * GiB, dockerMemorySwap: 3 * GiB };
    const drifted = limitsDrift(want, { ...docker, cgroup: { memoryMax: 3 * GiB, swapMax: null } });
    expect(drifted).toMatchObject({ reassert: true, reasons: ['cgroup memory.swap.max'], have: { dockerSwap: 0, cgroupSwapMax: null } });
    expect(limitsDrift(want, { ...docker, cgroup: { memoryMax: 3 * GiB, swapMax: 0 } }).reassert).toBe(false);
    // A stopped container has no cgroup: docker's record alone.
    expect(limitsDrift(want, { ...docker, running: false, cgroup: { memoryMax: 3 * GiB, swapMax: null } }).reassert).toBe(false);
    // A stale allowance left in the cgroup after it was taken away (systemd keeps the last non-zero one).
    expect(limitsDrift(want, { ...docker, cgroup: { memoryMax: 3 * GiB, swapMax: 2 * GiB } }).reasons).toEqual(['cgroup memory.swap.max']);
    // An allowance given: the cgroup must hold it too.
    const withSwap = wantedLimits({ memory: '3g', swap: '2g' }, true);
    expect(limitsDrift(withSwap, { running: true, dockerMemory: 3 * GiB, dockerMemorySwap: 5 * GiB, cgroup: { memoryMax: 3 * GiB, swapMax: 2 * GiB } }).reassert).toBe(false);
    expect(limitsDrift(withSwap, { running: true, dockerMemory: 3 * GiB, dockerMemorySwap: 5 * GiB, cgroup: { memoryMax: 3 * GiB, swapMax: null } }).reassert).toBe(true);
    // Withheld (no compressed swap): zero, whatever the setting.
    expect(wantedLimits({ memory: '3g', swap: '2g' }, false).swapMax).toBe(0);
    // docker's MemorySwap: -1 is unlimited, 0 is unset (as much swap as memory); a cap moved in the cgroup.
    expect(limitsDrift(want, { running: false, dockerMemory: 3 * GiB, dockerMemorySwap: -1 }).reasons).toEqual(['docker swap']);
    expect(limitsDrift(want, { running: false, dockerMemory: 3 * GiB, dockerMemorySwap: 0 }).reasons).toEqual(['docker swap']);
    expect(limitsDrift(want, { ...docker, cgroup: { memoryMax: null, swapMax: 0 } }).reasons).toEqual(['cgroup memory.max']);
    // Page rounding is not drift.
    expect(limitsDrift(want, { ...docker, dockerMemory: 3 * GiB - 4096, cgroup: { memoryMax: 3 * GiB - 4096, swapMax: 0 } }).reassert).toBe(false);
  });

  it('parses cgroup limit files and /proc/<pid>/cgroup', () => {
    expect(parseCgroupLimit('max\n')).toBeNull();
    expect(parseCgroupLimit('3221225472\n')).toBe(3 * GiB);
    expect(parseCgroupLimit('0')).toBe(0);
    expect(parseCgroupLimit(undefined)).toBeUndefined();
    expect(parseCgroupLimit('garbage')).toBeUndefined();
    expect(procCgroupPath('0::/system.slice/docker-abc.scope\n')).toBe('/system.slice/docker-abc.scope');
    expect(procCgroupPath('0::/\n')).toBeUndefined(); // a private cgroup namespace: not a path to use
    expect(procCgroupPath('12:memory:/docker/abc\n')).toBeUndefined(); // cgroup v1
  });

  it('the provider reads the cgroup by the container\'s process (this machine) and by docker exec (a runner)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'hb-cg-'));
    const ID = 'f'.repeat(64);
    // A fake /proc and /sys: the systemd driver's scope, reset to "max" by a reload.
    mkdirSync(join(d, 'proc/4242'), { recursive: true });
    writeFileSync(join(d, 'proc/4242/cgroup'), `0::/system.slice/docker-${ID}.scope\n`);
    const cg = join(d, `sys/fs/cgroup/system.slice/docker-${ID}.scope`);
    mkdirSync(cg, { recursive: true });
    writeFileSync(join(cg, 'memory.max'), `${3 * GiB}\n`); writeFileSync(join(cg, 'memory.swap.max'), 'max\n');
    // cgroupfs driver for a second container, found without a pid.
    const ID2 = 'e'.repeat(64);
    mkdirSync(join(d, `sys/fs/cgroup/docker/${ID2}`), { recursive: true });
    writeFileSync(join(d, `sys/fs/cgroup/docker/${ID2}/memory.max`), `${2 * GiB}\n`); writeFileSync(join(d, `sys/fs/cgroup/docker/${ID2}/memory.swap.max`), '0\n');
    const st = join(d, 'docker');
    writeFileSync(st, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(join(d, 'argv'))}
args="$*"; case "$args" in -H*) set -- "\${@:3}" ;; esac
case "$1" in
  inspect) echo "/hatchabot-kitchen-helper-df918a55|${ID}|true|4242|${3 * GiB}|${3 * GiB}"; echo "/hatchabot-other-11111111|${ID2}|true|0|${2 * GiB}|${2 * GiB}"; echo "/hatchabot-sleepy-22222222|${'d'.repeat(64)}|false|0|${GiB}|${GiB}"; exit 1 ;;
  exec) printf '${3 * GiB}\\nmax\\n' ;;
  info) echo "Ubuntu|[name=seccomp]" ;;
esac
exit 0
`, { mode: 0o755 });
    const refs: [string, string, string, string] = ['docker://hatchabot-kitchen-helper-df918a55', 'docker://hatchabot-other-11111111', 'docker://hatchabot-sleepy-22222222', 'docker://hatchabot-gone-33333333'];
    const local = new LocalDockerProvider({ docker: st, image: 'test-image:latest', hostRoot: d });
    const live = await local.memoryLimitsLive(refs);
    expect(live.get(refs[0])).toEqual({ running: true, dockerMemory: 3 * GiB, dockerMemorySwap: 3 * GiB, cgroup: { memoryMax: 3 * GiB, swapMax: null } });
    expect(live.get(refs[1])?.cgroup).toEqual({ memoryMax: 2 * GiB, swapMax: 0 });
    expect(live.get(refs[2])).toEqual({ running: false, dockerMemory: GiB, dockerMemorySwap: GiB }); // stopped: no cgroup to read
    expect(live.has(refs[3])).toBe(false);
    expect(readFileSync(join(d, 'argv'), 'utf8')).not.toContain('exec'); // this machine: files, no process in the agent
    const remote = new LocalDockerProvider({ docker: st, image: 'test-image:latest', host: 'ssh://runner@10.0.0.9', reachProbe: async () => true });
    const r = await remote.memoryLimitsLive(refs.slice(0, 1));
    expect(r.get(refs[0])?.cgroup).toEqual({ memoryMax: 3 * GiB, swapMax: null });
    expect(readFileSync(join(d, 'argv'), 'utf8')).toContain('-H ssh://runner@10.0.0.9 exec hatchabot-kitchen-helper-df918a55 cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max');
  });

  it('the app finds it, applies the limits again, says so once, counts it for the doctor; after a start it checks that agent', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const ok2 = await seedRunningAgent(w, { id: 'a2', name: 'Fine', slug: 'fine', accountId: 'finebot' });
    const check = (w.f as unknown as { limitsCheck: (o?: { agentIds?: string[] }) => Promise<LimitsCheckSummary> }).limitsCheck;
    const ref = refOf(w, id);
    w.provider.cgroupLimits.set(refOf(w, ok2), { memoryMax: 3 * GiB, swapMax: 0 });
    w.provider.cgroupLimits.set(ref, { memoryMax: 3 * GiB, swapMax: null }); // a daemon-reload happened
    w.provider.memoryUpdates.length = 0;
    expect(await check()).toEqual({ at: expect.any(String), checked: 2, cgroupDrifted: 1, reasserted: 1, failed: 0, notCovered: 0 });
    expect(w.provider.memoryUpdates).toEqual([{ runtimeRef: ref, cap: '3g' }]);
    expect(w.provider.cgroupLimits.get(ref)).toEqual({ memoryMax: 3 * GiB, swapMax: 0 });
    const ev = w.store.listEvents([id]).filter((e) => e.event === 'runtime.swap_reasserted');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.detail).toMatchObject({ reasons: ['cgroup memory.swap.max'], before: { cgroupSwapMax: null, dockerSwap: 0 }, after: { cgroupSwapMax: 0 }, cause: expect.stringMatching(/systemd reload/) });
    expect((w.f as unknown as { lastLimitsCheck: () => LimitsCheckSummary }).lastLimitsCheck()).toMatchObject({ cgroupDrifted: 1 });
    expect(await check()).toMatchObject({ cgroupDrifted: 0, reasserted: 0 }); // fixed: quiet
    // One that cannot be fixed is counted every time, but on its trail once.
    w.provider.cgroupLimits.set(ref, { memoryMax: 3 * GiB, swapMax: null });
    w.provider.cgroupStuck.add(ref);
    expect(await check()).toMatchObject({ reasserted: 1, failed: 1 });
    expect(await check()).toMatchObject({ reasserted: 1, failed: 1 });
    expect(w.store.listEvents([id]).filter((e) => e.event === 'runtime.swap_reassert_failed')).toHaveLength(1);
    w.provider.cgroupStuck.delete(ref);
    // Start: that agent alone is checked once it is up.
    await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/stop`, headers: as() });
    w.provider.liveReads.length = 0;
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() })).statusCode).toBe(200);
    for (let i = 0; i < 50 && !w.provider.liveReads.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(w.provider.liveReads[0]).toEqual([ref]);
  });

  it('the doctor says what the last check found', () => {
    const base = { at: '2026-10-02T23:40:00.000Z', checked: 44, cgroupDrifted: 0, reasserted: 0, failed: 0, notCovered: 0 };
    expect(limitsCheckLine(base)).toEqual({ level: 'ok', text: 'Limits check 2026-10-02 23:40: 44 agents checked, none drifted' });
    const l = limitsCheckLine({ ...base, cgroupDrifted: 16, reasserted: 16 });
    expect(l.level).toBe('warn');
    expect(l.text).toBe('Limits check 2026-10-02 23:40: 16 agents\' swap limits had drifted (systemd reload) and were restored');
    expect(limitsCheckLine({ ...base, reasserted: 2, failed: 1, notCovered: 3 })).toMatchObject({ level: 'warn', text: expect.stringMatching(/1 agent's memory or swap limits had drifted and could NOT be restored; 3 running agents on a runner/) });
  });
});

describe('the doctor', () => {
  const none = parseSwapProbe(probe({ zswap: 'N', swaps: [SWAPFILE] }));
  const on = parseSwapProbe(probe({ zswap: 'Y', compressor: 'zstd', swaps: [SWAPFILE] }));
  it('compressed swap present: ok, with its settings and how many agents use it', () => {
    expect(swapLine({ state: on, fleet: 'off', agentsWithAllowance: 3, containersWithSwap: 2 })).toEqual({ level: 'ok', text: 'Compressed swap: zswap (zstd, zsmalloc, pool ≤ 20%) in front of /swap.img · nothing stored yet · 3 agents have a swap allowance (2 containers running with swap)' });
  });
  it('agents set to swap on a machine without compressed swap: a warning with the fix', () => {
    const l = swapLine({ state: none, fleet: '2g', agentsWithAllowance: 5 });
    expect(l.level).toBe('warn');
    expect(l.text).toMatch(/5 agents have a swap allowance; machine setting 2g/);
    expect(l.fix).toMatch(/enable-compressed-swap\.sh/);
  });
  it('nobody asked for it: just says it is not there, and how to turn it on', () => {
    expect(swapLine({ state: none, fleet: 'off', agentsWithAllowance: 0 })).toMatchObject({ level: 'ok', text: expect.stringMatching(/^Compressed swap: none/) });
  });
});
