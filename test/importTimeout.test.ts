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
  // Read when the module loads: a short deadline for this file only.
  vi.stubEnv('HATCHABOT_DOCKER_IO_TIMEOUT_MS', '300');
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
