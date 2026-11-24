import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { browserImage } from '../src/orchestrator/console/browser.js';
import { BROWSER_CHROMIUM_ARGV, BROWSER_READY_FILE, BROWSER_START_SCRIPT } from '../src/providers/browserContainer.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An absolute fake Docker executable: no daemon, shell commands or outside files. */
function dockerFixture(options: { removeFails?: boolean; browserReadError?: boolean; changeDuringImage?: boolean; volumeLabels?: Record<string, string>; volumeReadError?: boolean; volumeAppearsOnCreate?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-browser-safety-'));
  dirs.push(dir);
  vi.stubEnv('HOME', dir);
  vi.stubEnv('PATH', dir);
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'core.hooksPath');
  vi.stubEnv('GIT_CONFIG_VALUE_0', '/dev/null');
  const log = join(dir, 'calls.jsonl');
  const docker = join(dir, 'docker');
  const changed = join(dir, 'changed');
  writeFileSync(docker, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'inspect' && args[1] === 'hatchabot-fixture') console.log('true|start-one');
else if (args[0] === 'inspect' && args[1] === 'hatchabot-fixture-browser') {
  if (${!!options.browserReadError}) { console.error('daemon connection interrupted'); process.exitCode = 125; }
  else console.log('true|start-one|old-image|1g|1073741824|none|old-fence');
}
else if (args[0] === 'rm' && ${options.removeFails !== false}) { console.error('removal refused by fixture'); process.exitCode = 125; }
else if (args[0] === 'image') { if (${!!options.changeDuringImage}) fs.writeFileSync(${JSON.stringify(changed)}, 'changed'); console.log('fixture-image'); }
else if (args[0] === 'volume' && args[1] === 'inspect') {
  if (${!!options.volumeReadError}) { console.error('daemon connection interrupted'); process.exitCode = 125; }
  else if (${!!options.volumeAppearsOnCreate} && !fs.existsSync(${JSON.stringify(changed)})) { console.error('no such volume'); process.exitCode = 1; }
  else { const labels = ${JSON.stringify(options.volumeLabels ?? {})}; console.log(args.join(' ').includes('json .Labels') ? JSON.stringify(labels) : (labels['hatchabot.browser-logins'] || '')); }
}
else if (args[0] === 'volume' && args[1] === 'create') { fs.writeFileSync(${JSON.stringify(changed)}, 'created'); console.log('fixture-volume'); }
else if (args[0] === 'run' && args.includes('--rm')) console.log(args.join(' ').includes('UNLOCKED') ? 'UNLOCKED' : 'READY');
else if (args[0] === 'run') console.log('fixture-browser');
else if (args[0] === 'exec') console.log('READY');
`, { mode: 0o700 });
  return {
    provider: new LocalDockerProvider({ docker, image: 'fixture-image' }),
    calls: () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]),
    current: () => !existsSync(changed),
  };
}

describe('browser replacement refuses an uncertain old container (HB-0723)', () => {
  it('does not interpret a failed browser inspection as absence', async () => {
    const fixture = dockerFixture({ removeFails: false, browserReadError: true });
    await expect(fixture.provider.ensureBrowser({ agentContainer: 'hatchabot-fixture', ...browserImage(), memory: '1g' })).rejects.toThrow(/browser check failed/);
    expect(fixture.calls().some((args) => args[0] === 'run' || args[0] === 'volume')).toBe(false);
  });
  it('does not change the fence or unlock/start a profile when the old browser cannot be removed', async () => {
    const fixture = dockerFixture();
    await expect(fixture.provider.ensureBrowser({ agentContainer: 'hatchabot-fixture', ...browserImage(), memory: '1g' }))
      .rejects.toThrow(/browser.*remov|remov.*browser/i);
    expect(fixture.calls().some((args) => args[0] === 'run')).toBe(false);
    expect(fixture.calls().some((args) => args[0] === 'volume')).toBe(false);
  });
});

describe('kept profiles are used only after confirmed ownership (HB-0726)', () => {
  const logins = '0a1b2c3d4e5f', volume = `hatchabot-fixture-browser-logins-${logins}`;
  const labels = { 'hatchabot.role': 'browser-logins', 'hatchabot.browser-of': 'hatchabot-fixture',
    'hatchabot.browser-prefix': 'hatchabot', 'hatchabot.browser-logins': logins, 'hatchabot.agent': 'fixture' };
  it('does not interpret an unreadable existing profile as missing or prepare/remove it', async () => {
    const fixture = dockerFixture({ removeFails: false, volumeReadError: true });
    await expect(fixture.provider.ensureBrowser({ agentContainer: 'hatchabot-fixture', agentId: 'fixture', ...browserImage(), memory: '1g', logins })).rejects.toThrow();
    expect(fixture.calls().some((a) => a[0] === 'volume' && a[1] === 'create')).toBe(false);
    expect(fixture.calls().some((a) => a[0] === 'run')).toBe(false);
    expect(fixture.calls().some((a) => a[0] === 'volume' && a[1] === 'rm')).toBe(false);
  });
  it.each(['hatchabot.role', 'hatchabot.browser-of', 'hatchabot.browser-prefix', 'hatchabot.agent'])
    ('does not mount a same-named volume with a different %s label', async (key) => {
      const fixture = dockerFixture({ removeFails: false, volumeLabels: { ...labels, [key]: 'unrelated' } });
      await expect(fixture.provider.ensureBrowser({ agentContainer: 'hatchabot-fixture', agentId: 'fixture', ...browserImage(), memory: '1g', logins })).rejects.toThrow(/not a browser profile/);
      expect(fixture.calls().some((a) => a[0] === 'run')).toBe(false);
    });
  it('does not delete a same-named volume belonging to another install', async () => {
    const fixture = dockerFixture({ removeFails: false, volumeLabels: { ...labels, 'hatchabot.browser-prefix': 'unrelated' } });
    expect(await fixture.provider.removeBrowserLogins(volume)).toBe(false);
    expect(fixture.calls().some((a) => a[0] === 'volume' && a[1] === 'rm')).toBe(false);
  });
  it('rechecks ownership when Docker create returns a volume that appeared during the check', async () => {
    const fixture = dockerFixture({ removeFails: false, volumeAppearsOnCreate: true, volumeLabels: { ...labels, 'hatchabot.role': 'unrelated' } });
    await expect(fixture.provider.ensureBrowser({ agentContainer: 'hatchabot-fixture', agentId: 'fixture', ...browserImage(), memory: '1g', logins })).rejects.toThrow(/not a browser profile/);
    expect(fixture.calls().some((a) => a[0] === 'run')).toBe(false);
    expect(fixture.calls().some((a) => a[0] === 'volume' && a[1] === 'rm')).toBe(false);
  });
  it('accepts an otherwise matching older profile without the optional agent-id label', async () => {
    const older: Record<string, string> = { ...labels }; delete older['hatchabot.agent'];
    const fixture = dockerFixture({ removeFails: false, volumeLabels: older });
    expect(await fixture.provider.ensureBrowser({ agentContainer: 'hatchabot-fixture', agentId: 'fixture', ...browserImage(), memory: '1g', logins })).toBe('started');
    expect(fixture.calls().some((a) => a[0] === 'volume' && a[1] === 'create')).toBe(false);
    expect(await fixture.provider.removeBrowserLogins(volume)).toBe(true);
  });
});

describe('a pending browser start follows current settings (HB-0725)', () => {
  it('does not launch a stale profile after settings change during an image operation', async () => {
    const fixture = dockerFixture({ removeFails: false, changeDuringImage: true });
    const spec = { agentContainer: 'hatchabot-fixture', ...browserImage(), memory: '1g', stillWanted: fixture.current };
    await expect(fixture.provider.ensureBrowser(spec)).rejects.toThrow(/changed/);
    expect(fixture.calls().some((args) => args[0] === 'run')).toBe(false);
  });
});

describe('the fence and privilege drop precede Chromium in its own namespace (HB-0724)', () => {
  function startup(overrides: Record<string, string> = {}, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'hb-browser-start-'));
    dirs.push(dir);
    const fields = {
      Uid: '1001 1001 1001 1001', Gid: '1001 1001 1001 1001', Groups: '',
      CapInh: '0000000000000000', CapPrm: '0000000000000000', CapEff: '0000000000000000',
      CapBnd: '0000000000000000', CapAmb: '0000000000000000', NoNewPrivs: '1', ...overrides,
    };
    const status = join(dir, 'status'), ready = join(dir, 'ready'), calls = join(dir, 'calls');
    writeFileSync(status, Object.entries(fields).map(([k, v]) => `${k}:\t${v}`).join('\n') + '\n');
    for (const tool of ['iptables', 'ip6tables']) writeFileSync(join(dir, tool), `#!/bin/sh
printf '%s\\n' '${tool}' >> "$HOME/calls"
case "$*" in *'-F HB_BROWSER'*) [ "\${FAIL_FENCE:-0}" != 1 ] || exit 7 ;; esac
`, { mode: 0o700 });
    writeFileSync(join(dir, 'cat'), '#!/bin/sh\necho 0\n', { mode: 0o700 });
    writeFileSync(join(dir, 'sh'), '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o700 });
    writeFileSync(join(dir, 'setpriv'), `#!/bin/sh
printf '%s\\n' "setpriv $*" >> "$HOME/calls"
[ "\${FAIL_DROP:-0}" != 1 ] || exit 8
while [ "\${1#--}" != "$1" ]; do shift; done
exec "$@"
`, { mode: 0o700 });
    writeFileSync(join(dir, 'chromium'), '#!/bin/sh\nprintf "%s\\n" "chromium $*" >> "$HOME/calls"\n', { mode: 0o700 });
    const source = BROWSER_START_SCRIPT.replace('/proc/self/status', status).replace(BROWSER_READY_FILE, ready);
    const result = spawnSync('/bin/sh', ['-c', source, 'sh', ...BROWSER_CHROMIUM_ARGV], {
      encoding: 'utf8', env: { HOME: dir, PATH: dir, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', ...env },
    });
    return { result, calls: readFileSync(calls, 'utf8'), ready };
  }

  it('uses the image command after fencing and clearing every capability set', () => {
    const { result, calls } = startup();
    expect(result.status, result.stderr).toBe(0);
    expect(calls.indexOf('iptables')).toBeLessThan(calls.indexOf('setpriv'));
    expect(calls.indexOf('setpriv')).toBeLessThan(calls.indexOf('\nchromium '));
    expect(calls).toContain('--reuid=1001 --regid=1001 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs');
    const dockerfile = browserImage().dockerfile.replace(/\\\n/g, '');
    const entry = JSON.parse(/^ENTRYPOINT (\[.*\])$/m.exec(dockerfile)![1]!);
    const command = JSON.parse(/^CMD (\[.*\])$/m.exec(dockerfile)![1]!);
    expect(BROWSER_CHROMIUM_ARGV).toEqual([...entry, ...command]);
    expect(dockerfile).toContain('iptables util-linux');
    expect(dockerfile).toContain('HEALTHCHECK NONE');
  });

  it.each(['FAIL_FENCE', 'FAIL_DROP'])('does not execute Chromium when %s fails', (fault) => {
    const { result, calls } = startup({}, { [fault]: '1' });
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain('\nchromium ');
  });

  it.each(['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'Uid', 'Gid', 'Groups', 'NoNewPrivs'])
    ('does not execute Chromium when the kernel reports unsafe %s after the drop', (field) => {
      const { result, calls } = startup({ [field]: field === 'NoNewPrivs' ? '0' : '1001' });
      expect(result.status).not.toBe(0);
      expect(calls).not.toContain('\nchromium ');
    });
});
