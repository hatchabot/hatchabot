import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * scripts/ui-clickthrough.mjs removes its work folder however it ends (HB-1310):
 * 141 /tmp/hb-ui-* folders were left on the dev machine by runs stopped in the
 * middle. The harness runs for real, with its container CLI a stand-in
 * (CONTAINER_CLI) that answers as Chrome's DOM dump would, fails, or hangs until
 * it is stopped; its temp folder is the test's own (TMPDIR), its HOME and PATH
 * the sandbox's, where docker and podman are shims that fail. No container,
 * browser or network is reached.
 */
vi.setConfig({ testTimeout: 60_000 });
const SCRIPT = resolve('scripts/ui-clickthrough.mjs');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world(mode: 'report' | 'fail' | 'hang') {
  const root = mkdtempSync(join(tmpdir(), 'hb-ui-cleanup-')); dirs.push(root);
  const home = join(root, 'home'), bin = join(root, 'bin'), tmp = join(root, 'tmp'), mark = join(root, 'mark');
  for (const d of [home, bin, tmp, mark]) mkdirSync(d);
  // The real container CLIs are on this machine's PATH: only CONTAINER_CLI keeps the harness off them, and these.
  for (const real of ['docker', 'podman']) writeFileSync(join(bin, real), `#!/bin/sh\necho "${real} is a shim in this test" >&2\nexit 97\n`, { mode: 0o755 });
  const cli = join(bin, 'fake-container');
  // The trap is set before it says it has started, and stops its sleep, which would hold the harness's
  // stderr (its own, inherited) open, and so the test's wait for it, the 30 s through.
  writeFileSync(cli, `#!/usr/bin/env bash
trap 'kill $! 2>/dev/null; : > ${JSON.stringify(join(mark, 'stopped'))}; exit 143' TERM INT
: > ${JSON.stringify(join(mark, 'started'))}
case ${JSON.stringify(mode)} in
  report) printf '%s' '<html data-ui-results="[]" data-ui-done="1"><body></body></html>' ;;
  fail) exit 1 ;;
  hang) sleep 30 >/dev/null 2>&1 & wait ;;
esac
`, { mode: 0o755 });
  const child = spawn(process.execPath, [SCRIPT], { cwd: resolve('.'), env: scriptEnv(home, `${bin}:/usr/bin:/bin`, { TMPDIR: tmp, CONTAINER_CLI: cli }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on('close', (code, signal) => r({ code, signal })));
  const left = () => readdirSync(tmp).filter((f) => f.startsWith('hb-ui-'));
  return { child, ended, left, out: () => out, started: () => existsSync(join(mark, 'started')), stopped: () => existsSync(join(mark, 'stopped')) };
}

const until = async (f: () => boolean, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (f()) return;
  throw new Error(`timed out waiting for ${String(f)}`);
};

describe('the click-through harness removes its work folder however it ends (HB-1310)', () => {
  it('when every run reports, and when a run never does', async () => {
    const ran = world('report');
    expect((await ran.ended).code, ran.out()).toBe(0);
    expect(ran.out()).toContain('0/0 passed');
    expect(ran.left()).toEqual([]);
    const failed = world('fail');
    expect((await failed.ended).code, failed.out()).toBe(1);
    expect(failed.out()).toContain('the page never reported');
    expect(failed.left()).toEqual([]);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('when it is stopped (%s) while Chrome runs: the Chrome run is stopped too', async (signal) => {
    const w = world('hang');
    await until(w.started);
    expect(w.left()).toHaveLength(1);
    const t0 = Date.now();
    w.child.kill(signal);
    const { code } = await w.ended;
    expect(code, w.out()).toBe(signal === 'SIGTERM' ? 143 : 130);
    // At once, not when the stand-in's 30 s sleep would have ended.
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(w.left()).toEqual([]);
    await until(w.stopped);
  });
});
