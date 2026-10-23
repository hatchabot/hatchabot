import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A volume import that times out (or whose client dies) is reported only once
 * its one-shot container is removed (#205). The kill used to close the client
 * at once and the caller heard "failed" while the container was still
 * extracting, so its rollback wrote into the same volume.
 *
 * A docker stub: `run` does what the test says (hang, exit 3, die by a
 * signal); `rm` takes a moment and then leaves a mark. Each test asks whether
 * the mark was there when the caller heard.
 */
const REF = 'docker://hatchabot-kitchen-helper-df918a55';
let dir: string;
let LocalDockerProvider: typeof import('../src/providers/localDockerProvider.js').LocalDockerProvider;

beforeAll(async () => {
  // Read when the module loads: a short deadline for this file only. A second,
  // not less: on a loaded runner bash alone can take over 300 ms to print.
  vi.stubEnv('HATCHABOT_DOCKER_IO_TIMEOUT_MS', '1000');
  vi.resetModules();
  ({ LocalDockerProvider } = await import('../src/providers/localDockerProvider.js'));
});
afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hb-import-timeout-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

const provider = (run: string) => {
  const stub = join(dir, 'docker');
  writeFileSync(stub, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(join(dir, 'argv.log'))}
case "$1" in
  run) ${run} ;;
  rm) sleep 0.5; touch ${JSON.stringify(join(dir, 'removed'))} ;;
esac
exit 0
`, { mode: 0o755 });
  return new LocalDockerProvider({ docker: stub, image: 'test-image:latest' });
};
/** Whether the one-shot had been removed when the call settled. */
const removedWhenSettled = (p: Promise<unknown>) =>
  p.then(() => ({ ok: true, removed: existsSync(join(dir, 'removed')) }), (err: Error) => ({ ok: false, err, removed: existsSync(join(dir, 'removed')) }));
const ioName = () => /--name (\S+)/.exec(readFileSync(join(dir, 'argv.log'), 'utf8'))![1];

describe('an import that does not finish is heard only once its one-shot is gone (#205)', () => {
  it('importState: a timeout waits for the removal', async () => {
    const r = await removedWhenSettled(provider('exec sleep 10').importState(REF, Buffer.from('fixture archive')));
    expect(r).toMatchObject({ ok: false, removed: true });
    expect(String((r as { err: Error }).err)).toMatch(/timed out/);
    expect(readFileSync(join(dir, 'argv.log'), 'utf8')).toContain(`rm -f ${ioName()}`);
  });

  it('importWorkspace: a timeout waits for the removal', async () => {
    const r = await removedWhenSettled(provider('exec sleep 10').importWorkspace(REF, 'kitchen-helper', Buffer.from('fixture archive')));
    expect(r).toMatchObject({ ok: false, removed: true });
  });

  it('a client killed by a signal it did not get from us: removed first, then the failure', async () => {
    const r = await removedWhenSettled(provider('kill -KILL $$').importState(REF, Buffer.from('fixture archive')));
    expect(r).toMatchObject({ ok: false, removed: true });
    expect(String((r as { err: Error }).err)).toMatch(/volume import failed/);
  });

  it('an error exit keeps its own message, after the removal', async () => {
    const r = await removedWhenSettled(provider('exit 3').importState(REF, Buffer.from('fixture archive')));
    expect(r).toMatchObject({ ok: false, removed: true });
    expect((r as unknown as { err: { userMessage: string } }).err.userMessage).toMatch(/would expand to more than/);
  });

  it('a clean import removes nothing and is not held', async () => {
    const r = await removedWhenSettled(provider('cat > /dev/null').importState(REF, Buffer.from('fixture archive')));
    expect(r).toMatchObject({ ok: true, removed: false });
  });

  it('writeToVolume (stdin to a one-shot): a timeout waits for the removal too', async () => {
    const r = await removedWhenSettled(provider('exec sleep 10').writeToVolume(REF, ['sh', '-c', 'cat > /home/node/x'], Buffer.from('fixture')));
    expect(r).toMatchObject({ ok: false, removed: true });
  });
});

describe('a download from a volume that stalls fails instead of hanging (#217)', () => {
  /** Reads the whole stream; `pauseMs` first, as a slow reader would. */
  const drain = async (s: import('node:stream').Readable, pauseMs = 0) => {
    if (pauseMs) { s.pause(); await new Promise((r) => setTimeout(r, pauseMs)); }
    let bytes = 0;
    try { for await (const c of s) bytes += (c as Buffer).length; return { bytes }; } catch (err) { return { bytes, err: err as Error }; }
  };

  it('docker sends nothing and never exits: the download fails and its one-shot is removed', async () => {
    const p = provider('exec sleep 10');
    const t0 = Date.now();
    const r = await drain(p.streamFromVolume(REF, ['cat', '/home/node/notes.md']));
    expect(String(r.err)).toMatch(/stalled/);
    expect(Date.now() - t0).toBeLessThan(3000);
    for (let i = 0; i < 40 && !existsSync(join(dir, 'removed')); i++) await new Promise((res) => setTimeout(res, 50));
    expect(readFileSync(join(dir, 'argv.log'), 'utf8')).toContain(`rm -f ${/--name (\S+)/.exec(readFileSync(join(dir, 'argv.log'), 'utf8'))![1]}`);
  });

  it('a slow transfer that keeps moving is not cut off', async () => {
    // A chunk every 300 ms for 2.4 seconds: longer than the deadline in all, never silent that long.
    const r = await drain(provider('for i in 1 2 3 4 5 6 7 8; do printf "chunk-%s " $i; sleep 0.3; done').streamFromVolume(REF, ['cat', 'x']));
    expect(r.err).toBeUndefined();
    expect(r.bytes).toBe(8 * 'chunk-1 '.length);
  });

  it('a reader that is slow is waiting on itself: not a stall', async () => {
    // Far more than the buffers hold, sent at once; the reader starts late.
    const r = await drain(provider('head -c 4000000 /dev/zero').streamFromVolume(REF, ['cat', 'x']), 900);
    expect(r.err).toBeUndefined();
    expect(r.bytes).toBe(4_000_000);
  });
});
