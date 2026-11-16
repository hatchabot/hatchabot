import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it('secret-script transport preserves UTF-8 characters split between stdout and stderr chunks', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hb-stdin-utf8-')); homes.push(home);
  const bin = join(home, 'bin'); mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  vi.stubEnv('HOME', home); vi.stubEnv('PATH', bin);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1'); vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  const stdout = 'café 🍳 中\n', stderr = 'échec 🔒\n';
  const docker = join(bin, 'docker');
  writeFileSync(docker, '#!' + process.execPath + '\n' +
    'const output = Buffer.from(' + JSON.stringify(stdout) + '), errors = Buffer.from(' + JSON.stringify(stderr) + ');\n' +
    'process.stdin.resume();\n' +
    'process.stdin.on("end", () => { let i = 0; const next = () => {\n' +
    '  if (i < output.length) process.stdout.write(output.subarray(i, i + 1));\n' +
    '  if (i < errors.length) process.stderr.write(errors.subarray(i, i + 1));\n' +
    '  if (++i < Math.max(output.length, errors.length)) setTimeout(next, 15);\n' +
    '}; next(); });\n', { mode: 0o755 });
  const provider = new LocalDockerProvider({ docker, image: 'fixture:latest' });
  const result = await provider.execShell('docker://fixture', 'printf fixture', { secret: true, timeoutMs: 5000 });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(stdout);
  expect(result.stderr).toBe(stderr);
});
