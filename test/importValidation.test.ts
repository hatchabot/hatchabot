import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';

/**
 * importState's in-container script, run for real in a sandbox (#213): a
 * docker stub hands back the `sh -c` script, which runs here with /vol and
 * /tmp pointed at temp folders. A file that is valid gzip but not a tar must
 * fail before the volume is emptied.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function importScript(): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), 'hb-import-script-'));
  dirs.push(d);
  const stub = join(d, 'docker');
  // The script is run's last argument; stdin is drained so the write does not race.
  writeFileSync(stub, `#!/usr/bin/env bash\n[ "$1" = run ] && { printf '%s' "\${@: -1}" > ${JSON.stringify(join(d, 'script'))}; cat > /dev/null; }\nexit 0\n`, { mode: 0o755 });
  await new LocalDockerProvider({ docker: stub, image: 'test-image:latest' }).importState('docker://hatchabot-kitchen-helper-df918a55', Buffer.from('x'));
  return readFileSync(join(d, 'script'), 'utf8');
}

/** Runs the script against a volume holding a sentinel; returns its exit code and what is left. */
async function runImport(archive: Buffer) {
  const script = await importScript();
  const root = mkdtempSync(join(tmpdir(), 'hb-import-vol-'));
  dirs.push(root);
  const vol = join(root, 'vol'), tmp = join(root, 'tmp');
  mkdirSync(join(vol, '.openclaw'), { recursive: true });
  mkdirSync(tmp);
  writeFileSync(join(vol, '.openclaw', 'MEMORY.md'), '# the agent\'s memory');
  const local = script.split('/tmp/').join(`${tmp}/`).split('/vol').join(vol)
    // Not root here: ownership is the container's business.
    .replace(/chown -R 1000:1000 \S+/, 'true');
  const r = spawnSync('bash', ['-c', local], { input: archive, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root } });
  return { code: r.status, stderr: r.stderr, sentinel: existsSync(join(vol, '.openclaw', 'MEMORY.md')), vol };
}

describe('an import checks the whole archive before emptying the volume (#213)', () => {
  it('valid gzip around something that is not a tar: refused (exit 4), the volume untouched', async () => {
    const r = await runImport(gzipSync(Buffer.from('this is not a tar archive, just text\n'.repeat(40))));
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/not a tar archive/);
    expect(r.sentinel).toBe(true);
  });

  it('a real old-layout archive still replaces the volume', async () => {
    const src = mkdtempSync(join(tmpdir(), 'hb-import-src-'));
    dirs.push(src);
    writeFileSync(join(src, 'openclaw.json'), '{}');
    const tgz = execFileSync('tar', ['cz', '-C', src, '.']);
    const r = await runImport(tgz);
    expect(r.code).toBe(0);
    expect(r.sentinel).toBe(false); // a true replace
    expect(existsSync(join(r.vol, '.openclaw', 'openclaw.json'))).toBe(true);
  });

  it('the refusal reads as what it is', async () => {
    const d = mkdtempSync(join(tmpdir(), 'hb-import-4-'));
    dirs.push(d);
    const stub = join(d, 'docker');
    writeFileSync(stub, '#!/usr/bin/env bash\n[ "$1" = run ] && { cat > /dev/null; exit 4; }\nexit 0\n', { mode: 0o755 });
    await expect(new LocalDockerProvider({ docker: stub, image: 'test-image:latest' }).importState('docker://hatchabot-kitchen-helper-df918a55', Buffer.from('x')))
      .rejects.toMatchObject({ userMessage: expect.stringMatching(/not a valid agent archive.*left as it was/) });
  });
});
