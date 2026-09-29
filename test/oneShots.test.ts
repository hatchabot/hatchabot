import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDockerProvider, ONESHOT_LABEL } from '../src/providers/localDockerProvider.js';

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
  ps) cat ${JSON.stringify(join(dir, 'ps'))} ;;
  inspect) cat ${JSON.stringify(join(dir, 'inspect'))} ;;
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
