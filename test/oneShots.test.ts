import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDockerProvider, ONESHOT_LABEL, ONESHOT_PROCESS_LABEL, ONESHOT_STALE_MS, THIS_PROCESS } from '../src/providers/localDockerProvider.js';

/**
 * Volume one-shots that leaked as 'created' containers (review, 2026-09-29):
 * an unnamed `run --rm` whose client was killed stays behind, and `volume rm`
 * refuses a volume it references — the agent could no longer be deleted.
 * A recording docker stub; what `ps` and `inspect` answer is set per test.
 */
let dir: string;
let LOG: string;
let provider: LocalDockerProvider;
const REF = 'docker://hatchabot-kitchen-helper-df918a55';
const VOL = 'hatchabot-kitchen-helper-df918a55-vol';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hb-oneshot-'));
  LOG = join(dir, 'argv.log');
  writeFileSync(LOG, '');
  writeFileSync(join(dir, 'ps'), '');
  writeFileSync(join(dir, 'inspect'), '');
  const stub = join(dir, 'docker');
  writeFileSync(stub, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(LOG)}
case "$1" in
  ps) case "$*" in *status=created*) if [ -f ${JSON.stringify(join(dir, 'ps-created'))} ]; then cat ${JSON.stringify(join(dir, 'ps-created'))}; else cat ${JSON.stringify(join(dir, 'ps'))}; fi ;; *) cat ${JSON.stringify(join(dir, 'ps'))} ;; esac ;;
  inspect) cat ${JSON.stringify(join(dir, 'inspect'))} ;;
  container) cat ${JSON.stringify(join(dir, 'created'))} ;;
  info) if [ -f ${JSON.stringify(join(dir, 'clock'))} ]; then cat ${JSON.stringify(join(dir, 'clock'))}; else exit 1; fi ;;
  run) if [ -f ${JSON.stringify(join(dir, 'hang'))} ]; then exec sleep 5; fi ;;
esac
exit 0
`, { mode: 0o755 });
  provider = new LocalDockerProvider({ docker: stub, image: 'test-image:latest' });
});
afterEach(() => {
  delete process.env.HATCHABOT_DOCKER_TIMEOUT_MS;
  rmSync(dir, { recursive: true, force: true });
});
const calls = () => readFileSync(LOG, 'utf8').split('\n').filter(Boolean);

describe('volume one-shots are named, labelled and cleaned up', () => {
  it('execShellOnVolume names and labels its one-shot, with no network', async () => {
    await provider.execShellOnVolume(REF, 'true');
    const run = calls().find((c) => c.startsWith('run '))!;
    expect(run).toMatch(/--name hatchabot-vx-[0-9a-f]{12} /);
    expect(run).toContain(`--label ${ONESHOT_LABEL}=hatchabot`);
    expect(run).toContain('--network none');
    expect(run).toContain(`-v ${VOL}:/home/node`);
  });

  it('a timed-out one-shot is removed by name, not left to pin the volume', async () => {
    writeFileSync(join(dir, 'hang'), '');
    process.env.HATCHABOT_DOCKER_TIMEOUT_MS = '300';
    const res = await provider.execShellOnVolume(REF, 'true');
    expect(res.timedOut).toBe(true);
    const name = /--name (hatchabot-vx-[0-9a-f]{12})/.exec(calls().find((c) => c.startsWith('run '))!)![1];
    expect(calls()).toContain(`rm -f ${name}`);
  });

  it('the boot sweep removes only this install\'s created or exited one-shots', async () => {
    writeFileSync(join(dir, 'ps'), 'aaa111\nbbb222\n');
    expect(await provider.sweepOneShots()).toBe(2);
    const ps = calls().find((c) => c.startsWith('ps '))!;
    expect(ps).toContain(`label=${ONESHOT_LABEL}=hatchabot`);
    expect(ps).toContain('status=created');
    expect(ps).toContain('status=exited');
    expect(ps).not.toContain('status=running');
    expect(calls()).toContain('rm -f aaa111 bbb222');
    // Nothing leaked: no rm at all.
    writeFileSync(LOG, ''); writeFileSync(join(dir, 'ps'), '');
    expect(await provider.sweepOneShots()).toBe(0);
    expect(calls().some((c) => c.startsWith('rm '))).toBe(false);
  });

  it('after boot the sweep leaves a created one-shot (a call may be making it) and takes dead ones too', async () => {
    writeFileSync(join(dir, 'ps'), 'ccc333\n');
    expect(await provider.sweepOneShots({ created: false })).toBe(1);
    const ps = calls().find((c) => c.startsWith('ps '))!;
    expect(ps).not.toContain('status=created');
    expect(ps).toContain('status=exited');
    expect(ps).toContain('status=dead');
  });

  it('a runner being removed hears when docker could not list or remove its one-shots; the timer\'s sweep does not', async () => {
    const stub = join(dir, 'docker');
    writeFileSync(stub, readFileSync(stub, 'utf8').replace('case "$1" in', `[ -f ${JSON.stringify(join(dir, 'fail'))} ] && [ "$1" = "$(cat ${JSON.stringify(join(dir, 'fail'))})" ] && { echo "cannot connect" >&2; exit 1; }\ncase "$1" in`));
    writeFileSync(join(dir, 'fail'), 'ps');
    await expect(provider.sweepOneShots({ created: false, orThrow: true })).rejects.toThrow(/docker ps failed: cannot connect/);
    expect(await provider.sweepOneShots({ created: false })).toBe(0);
    writeFileSync(join(dir, 'fail'), 'rm');
    writeFileSync(join(dir, 'ps'), 'ddd444\n');
    await expect(provider.sweepOneShots({ created: false, orThrow: true })).rejects.toThrow(/docker rm failed: cannot connect/);
    expect(await provider.sweepOneShots({ created: false })).toBe(1);
    // One removed by its own client between the list and the rm is gone, not left.
    // (the same stub, told to say a container is gone)
    writeFileSync(join(dir, 'fail'), 'none');
    writeFileSync(stub, readFileSync(stub, 'utf8').replace('case "$1" in', `[ "$1" = rm ] && { echo "Error response from daemon: No such container: ddd444" >&2; exit 1; }\ncase "$1" in`));
    expect(await provider.sweepOneShots({ created: false, orThrow: true })).toBe(1);
  });

  it('each one-shot is labelled with the process that made it', async () => {
    await provider.execShellOnVolume(REF, 'true');
    expect(calls().find((c) => c.startsWith('run '))).toContain(`--label ${ONESHOT_PROCESS_LABEL}=${THIS_PROCESS}`);
  });

  it('at boot a created one-shot goes only if another process made it over 5 minutes ago, by the daemon\'s clock (HB-0511)', async () => {
    writeFileSync(join(dir, 'ps'), '');
    writeFileSync(join(dir, 'ps-created'), [
      'aaa111aaa111|0123456789abcdef|hatchabot-vx-0123456789ab|created', // the last process's, long ago
      `bbb222bbb222|${THIS_PROCESS}|hatchabot-vx-0a1b2c3d4e5f|created`, // this process's, just now
      'ccc333ccc333||hatchabot-io-0123456789ab|created', // from before the label, long ago
      `ddd444ddd444||hatchabot-bk-${process.pid}-12345|created`, // a backup run still going
      'eee555eee555||hatchabot-bk-999999999-12345|created', // a backup run that is gone, long ago
      'fff666fff666|fedcba9876543210|hatchabot-vx-fedcba987654|created', // another process making it now
    ].join('\n') + '\n');
    // The daemon's clock is a year off this machine's: only its own times count.
    const daemonNow = Date.parse('2025-03-01T12:00:00Z');
    const at = (msAgo: number) => new Date(daemonNow - msAgo).toISOString();
    writeFileSync(join(dir, 'clock'), `${new Date(daemonNow).toISOString()}\n`);
    writeFileSync(join(dir, 'created'), [
      `aaa111aaa111${'0'.repeat(52)}|${at(ONESHOT_STALE_MS + 1000)}`,
      `ccc333ccc333${'0'.repeat(52)}|${at(60 * 60_000)}`,
      `eee555eee555${'0'.repeat(52)}|${at(ONESHOT_STALE_MS)}`,
      `fff666fff666${'0'.repeat(52)}|${at(60_000)}`,
      `bbb222bbb222${'0'.repeat(52)}|${at(30_000)}`,
    ].join('\n') + '\n');
    expect(await provider.sweepOneShots({ created: true, notThisProcess: true })).toBe(3);
    expect(calls()).toContain('rm -f aaa111aaa111 ccc333ccc333 eee555eee555');
    expect(calls().find((c) => c.startsWith('container inspect'))).not.toMatch(/ddd444/);
  });

  // Ninth review: an exited one-shot of this process may still be read (an
  // import's files, a command's output); only one forgotten long ago goes.
  it('at boot and every 10 minutes this process\'s own one-shots stay, in any state, until made 5 minutes ago', async () => {
    writeFileSync(join(dir, 'ps'), '');
    writeFileSync(join(dir, 'ps-created'), [
      `aaa111aaa111|${THIS_PROCESS}|hatchabot-io-0a1b2c3d4e5f|exited`, // this process's, just finished
      `bbb222bbb222|${THIS_PROCESS}|hatchabot-vx-0a1b2c3d4e5f|dead`, // this process's, long ago
      `ccc333ccc333|${THIS_PROCESS}|hatchabot-vx-1a1b2c3d4e5f|created`, // this process's, being made
      'ddd444ddd444|0123456789abcdef|hatchabot-io-0123456789ab|exited', // another process's, finished
    ].join('\n') + '\n');
    const daemonNow = Date.parse('2025-03-01T12:00:00Z');
    const at = (msAgo: number) => new Date(daemonNow - msAgo).toISOString();
    writeFileSync(join(dir, 'clock'), `${new Date(daemonNow).toISOString()}\n`);
    writeFileSync(join(dir, 'created'), [
      `aaa111aaa111${'0'.repeat(52)}|${at(20_000)}`,
      `bbb222bbb222${'0'.repeat(52)}|${at(ONESHOT_STALE_MS + 1000)}`,
      `ccc333ccc333${'0'.repeat(52)}|${at(1_000)}`,
      `ddd444ddd444${'0'.repeat(52)}|${at(20 * 60_000)}|exited|${at(ONESHOT_STALE_MS + 1000)}`,
    ].join('\n') + '\n');
    expect(await provider.sweepOneShots({ created: true, notThisProcess: true })).toBe(2);
    expect(calls()).toContain('rm -f bbb222bbb222 ddd444ddd444');
  });

  // Eleventh review: an import runs as long as it takes; what it left is read
  // after it exits, so its five minutes start then, not when it was made.
  it('this process\'s finished one-shots are timed from when they finished: an 8-minute import that just exited stays', async () => {
    writeFileSync(join(dir, 'ps'), '');
    writeFileSync(join(dir, 'ps-created'), [
      `aaa111aaa111|${THIS_PROCESS}|hatchabot-io-0a1b2c3d4e5f|exited`, // ran 8 minutes, exited 20 s ago
      `bbb222bbb222|${THIS_PROCESS}|hatchabot-io-1a1b2c3d4e5f|exited`, // ran 8 minutes, exited 6 minutes ago
      `ccc333ccc333|${THIS_PROCESS}|hatchabot-vx-2a1b2c3d4e5f|created`, // never ran, made 6 minutes ago
      `ddd444ddd444|${THIS_PROCESS}|hatchabot-vx-3a1b2c3d4e5f|created`, // listed as made, running by now
    ].join('\n') + '\n');
    const daemonNow = Date.parse('2025-03-01T12:00:00Z');
    const at = (msAgo: number) => new Date(daemonNow - msAgo).toISOString();
    const never = '0001-01-01T00:00:00Z';
    writeFileSync(join(dir, 'clock'), `${new Date(daemonNow).toISOString()}\n`);
    writeFileSync(join(dir, 'created'), [
      `aaa111aaa111${'0'.repeat(52)}|${at(8 * 60_000 + 20_000)}|exited|${at(20_000)}`,
      `bbb222bbb222${'0'.repeat(52)}|${at(14 * 60_000)}|exited|${at(6 * 60_000)}`,
      `ccc333ccc333${'0'.repeat(52)}|${at(6 * 60_000)}|created|${never}`,
      `ddd444ddd444${'0'.repeat(52)}|${at(9 * 60_000)}|running|${never}`,
    ].join('\n') + '\n');
    expect(await provider.sweepOneShots({ created: true, notThisProcess: true })).toBe(2);
    expect(calls()).toContain('rm -f bbb222bbb222 ccc333ccc333');
  });

  // Fourteenth review: another process (a CLI command, another instance on
  // a shared runner) may still be reading what its one-shot left.
  it('another process\'s finished one-shots also stay until 5 minutes after they finished', async () => {
    writeFileSync(join(dir, 'ps'), '');
    writeFileSync(join(dir, 'ps-created'), [
      'aaa111aaa111|0123456789abcdef|hatchabot-io-0123456789ab|exited', // another process's, exited 20 s ago
      'bbb222bbb222|0123456789abcdef|hatchabot-io-1123456789ab|dead', // another process's, exited 6 minutes ago
      'ccc333ccc333||hatchabot-vx-2123456789ab|exited', // from before the label, exited 20 s ago
    ].join('\n') + '\n');
    const daemonNow = Date.parse('2025-03-01T12:00:00Z');
    const at = (msAgo: number) => new Date(daemonNow - msAgo).toISOString();
    writeFileSync(join(dir, 'clock'), `${new Date(daemonNow).toISOString()}\n`);
    writeFileSync(join(dir, 'created'), [
      `aaa111aaa111${'0'.repeat(52)}|${at(10 * 60_000)}|exited|${at(20_000)}`,
      `bbb222bbb222${'0'.repeat(52)}|${at(10 * 60_000)}|dead|${at(6 * 60_000)}`,
      `ccc333ccc333${'0'.repeat(52)}|${at(10 * 60_000)}|exited|${at(20_000)}`,
    ].join('\n') + '\n');
    expect(await provider.sweepOneShots({ created: true, notThisProcess: true })).toBe(1);
    expect(calls()).toContain('rm -f bbb222bbb222');
  });

  it('the sweep every 10 minutes takes a crashed process\'s old created one-shots too, not only the boot sweep', () => {
    const index = readFileSync('src/index.ts', 'utf8');
    expect(index).toMatch(/p\.sweepOneShots\?\.\(\{ created: true, notThisProcess: true \}\)/);
    expect(index).toMatch(/setInterval\(sweepOneShots, 10 \* 60_000\)/);
    expect(index).not.toMatch(/sweepOneShots\?\.\(\{ created: false|sweepOneShots\(false\)/);
  });

  it('with no clock from the daemon, no other process\'s created one-shot goes', async () => {
    writeFileSync(join(dir, 'ps'), '');
    writeFileSync(join(dir, 'ps-created'), 'aaa111aaa111|0123456789abcdef|hatchabot-vx-0123456789ab|created\n');
    writeFileSync(join(dir, 'created'), `aaa111aaa111${'0'.repeat(52)}|2020-01-01T00:00:00Z\n`);
    expect(await provider.sweepOneShots({ created: true, notThisProcess: true })).toBe(0);
    expect(calls().some((c) => c.startsWith('rm '))).toBe(false);
  });

  it('a purge removes the one-shots holding the volume first — never the agent\'s own or another container', async () => {
    writeFileSync(join(dir, 'ps'), 'c1\nc2\nc3\nc4\nc5\n');
    writeFileSync(join(dir, 'inspect'), [
      'c1|/sweet_gould|<no value>|true|created', // an old unnamed leak
      'c2|/hatchabot-vx-0123456789ab|hatchabot|true|running', // ours, still going
      'c3|/hatchabot-kitchen-helper-df918a55|<no value>|false|exited', // the agent itself
      'c4|/someone-elses|<no value>|false|running', // not a one-shot
      'c5|/other-vx-0123456789ab|other|true|created', // another install's
    ].join('\n'));
    await provider.destroy(REF, { purge: true });
    const log = calls();
    expect(log).toContain(`ps -aq --filter volume=${VOL}`);
    expect(log).toContain('rm -f c1 c2');
    const rmAt = log.indexOf('rm -f c1 c2');
    const volAt = log.indexOf(`volume rm -f ${VOL}`);
    expect(rmAt).toBeGreaterThan(-1);
    expect(volAt).toBeGreaterThan(rmAt);
  });

  it('a plain destroy (no purge) touches no volume users', async () => {
    writeFileSync(join(dir, 'ps'), 'c1\n');
    await provider.destroy(REF);
    expect(calls().some((c) => c.startsWith('ps '))).toBe(false);
  });
});
