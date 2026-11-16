import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleAccess } from '../src/orchestrator/consoleAccess.js';
import type { Agent } from '../src/domain/types.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe('read-only console state probes', () => {
  it('never overwrites an agent file through a predictable temporary-script symlink', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hb-console-state-')); homes.push(home);
    const bin = join(home, 'bin'), state = join(home, '.openclaw'), temporary = join(home, 'tmp');
    mkdirSync(bin); mkdirSync(state); mkdirSync(temporary);
    symlinkSync(process.execPath, join(bin, 'node'));
    symlinkSync('/usr/bin/base64', join(bin, 'base64')); symlinkSync('/bin/rm', join(bin, 'rm'));
    const protectedFile = join(home, 'agent-notes.md'); writeFileSync(protectedFile, 'Keep these agent notes.');
    symlinkSync(protectedFile, join(temporary, 'hb-console-state.cjs'));
    writeFileSync(join(home, 'route'), 'Iface Destination Gateway\neth0 00000000 010012AC\n');
    writeFileSync(join(state, 'openclaw.json'), JSON.stringify({ gateway: { auth: { mode: 'trusted-proxy', trustedProxy: { allowUsers: ['owner-fixture'] } }, roles: {}, trustedProxies: [] } }));
    const remap = (code: string) => code.replaceAll('/home/node/.openclaw', state).replaceAll('/proc/net/route', join(home, 'route'));
    const provider = { execShell: async (_ref: string, source: string) => {
      const script = remap(source.replace(/echo ([A-Za-z0-9+/=]+) \| base64 -d/, (_all, encoded: string) => `echo ${Buffer.from(remap(Buffer.from(encoded, 'base64').toString('utf8'))).toString('base64')} | base64 -d`))
        .replaceAll('/tmp/hb-console-state.cjs', join(temporary, 'hb-console-state.cjs'));
      const result = spawnSync('/bin/sh', ['-c', script], { cwd: home, encoding: 'utf8', timeout: 5000,
        env: { HOME: home, PATH: bin, TMPDIR: temporary, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' } });
      return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    } };
    const access = new ConsoleAccess({ store: {} as never, providerFor: () => provider as never, gatewayAddr: async () => undefined });
    expect(await access.state({ id: 'a1', hostId: 'h1', state: 'RUNNING', runtimeRef: 'mock://agent', updatedAt: 'now' } as Agent))
      .toMatchObject({ mode: 'identity', allowUsers: ['owner-fixture'], route: '172.18.0.1' });
    expect(readFileSync(protectedFile, 'utf8')).toBe('Keep these agent notes.');
  });
});
