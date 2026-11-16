import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeProvider } from '../src/providers/provider.js';
import { ARGV_SAFE_B64, writeFileInAgent } from '../src/orchestrator/snapshots.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

/** The real write commands, confined to a temp HOME and an explicit tool PATH. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'hb-core-write-')); homes.push(home);
  const bin = join(home, 'bin'); mkdirSync(bin);
  for (const tool of ['sh', 'base64', 'mv', 'cat', 'sha256sum', 'cut', 'rm']) symlinkSync('/usr/bin/' + tool, join(bin, tool));
  const env = { HOME: home, PATH: bin, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const run = (argv: string[], input?: Buffer) => {
    const res = spawnSync(argv[0]!, argv.slice(1), { env, input, encoding: 'utf8' });
    if (res.error) throw res.error;
    return { code: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
  };
  const provider = {
    execShell: async (_ref: string, script: string) => run(['sh', '-c', script]),
    execShellOnVolume: async (_ref: string, script: string) => run(['sh', '-c', script]),
    // A one-shot shell is PID 1 each time. Model its repeated PID rather than
    // the test host's unrelated PID; a crash can leave its .part-1 behind.
    writeToVolume: async (_ref: string, argv: string[], input: Buffer) => run(argv.map(arg => arg.replaceAll('$$', '1')), input),
  } as unknown as RuntimeProvider;
  return { home, provider };
}

describe('atomic core-file replacement', () => {
  for (const large of [false, true]) {
    const content = large ? 'memory\n'.repeat(ARGV_SAFE_B64 / 4) : 'new memory\n';
    it((large ? 'large' : 'small') + ' writes refuse a directory instead of placing the staging file inside it', async () => {
      const { home, provider } = fixture();
      const destination = join(home, 'MEMORY.md'); mkdirSync(destination);
      const result = await writeFileInAgent(provider, 'fixture', destination, Buffer.from(content).toString('base64'));
      expect(result.code).not.toBe(0);
      expect(readdirSync(destination)).toEqual([]);
    });

    it((large ? 'large' : 'small') + ' writes replace a symlink without following its directory target', async () => {
      const { home, provider } = fixture();
      const directory = join(home, 'notes'); mkdirSync(directory);
      const destination = join(home, 'MEMORY.md'); symlinkSync(directory, destination);
      const result = await writeFileInAgent(provider, 'fixture', destination, Buffer.from(content).toString('base64'));
      expect(result.code).toBe(0);
      expect(readdirSync(directory)).toEqual([]);
      expect(readFileSync(destination, 'utf8')).toBe(content);
    });

    for (const hardlink of [false, true]) {
      it((large ? 'large' : 'small') + ' writes do not overwrite another core file through a stale ' + (hardlink ? 'hardlink' : 'symlink') + ' staging name', async () => {
        const { home, provider } = fixture();
        const destination = join(home, 'MEMORY.md'), other = join(home, 'AGENTS.md');
        writeFileSync(other, 'Keep these instructions');
        writeFileSync(destination, 'Old memory');
        const stale = destination + (large ? '.part-1' : '.tmp');
        if (hardlink) linkSync(other, stale); else symlinkSync(other, stale);
        const result = await writeFileInAgent(provider, 'fixture', destination, Buffer.from(content).toString('base64'));
        expect(result.code).toBe(0);
        expect(readFileSync(other, 'utf8')).toBe('Keep these instructions');
        expect(readFileSync(destination, 'utf8')).toBe(content);
      });
    }

    it((large ? 'large' : 'small') + ' failed writes preserve the destination and remove only their own staging file', async () => {
      const { home, provider } = fixture();
      const destination = join(home, 'MEMORY.md');
      writeFileSync(destination, 'Old memory');
      const tool = join(home, 'bin', large ? 'cat' : 'base64');
      rmSync(tool);
      writeFileSync(tool, '#!/bin/sh\nprintf partial\n/usr/bin/cat > /dev/null\nexit 1\n', { mode: 0o755 });
      const result = await writeFileInAgent(provider, 'fixture', destination, Buffer.from(content).toString('base64'));
      expect(result.code).not.toBe(0);
      expect(readFileSync(destination, 'utf8')).toBe('Old memory');
      expect(readdirSync(home).sort()).toEqual(['MEMORY.md', 'bin']);
    });
  }
});
