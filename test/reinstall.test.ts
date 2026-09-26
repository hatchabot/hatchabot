import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';

/**
 * A reinstall on a machine whose previous install's containers survived (the
 * uninstall knew only the agents): a doorman still holding a console port, an
 * embedder still wearing the old key. Both failed a MacBook on 2026-09-25;
 * the provider heals both without a script having to know about them.
 */

/** A docker stub with a memory: the state file counts doorman runs. */
function stubDocker() {
  const dir = mkdtempSync(join(tmpdir(), 'hb-reinstall-'));
  const log = join(dir, 'argv.log');
  const state = join(dir, 'runs');
  const stub = join(dir, 'docker');
  writeFileSync(stub, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$*" in
  "info --format "*) echo 'Ubuntu 24.04|[name=seccomp]' ;;
  "network inspect bridge"*) echo '172.17.0.1' ;;
  "network inspect "*) exit 0 ;;
  "run -d --name hatchabot-doorman-"*)
    n=$(cat ${JSON.stringify(state)} 2>/dev/null || echo 0); echo $((n+1)) > ${JSON.stringify(state)}
    if [ "$n" = 0 ]; then echo 'docker: Error response from daemon: driver failed programming external connectivity on endpoint hatchabot-doorman-new: Bind for 127.0.0.1:19101 failed: port is already allocated' >&2; exit 125; fi
    echo newdoorman ;;
  "ps -q --filter publish=19101 --filter label=hatchabot.role=doorman") echo 'abc123' ;;
  "inspect abc123 --format "*) echo '/hatchabot-doorman-e082d39db388 e082d39d-old' ;;
  "rm -f hatchabot-embedder") touch ${JSON.stringify(state)}.removed ;;
  "inspect --format {{.State.Running}} hatchabot-embedder") [ -f ${JSON.stringify(state)}.removed ] && exit 1; echo true ;;
  "inspect hatchabot-embedder --format "*) echo 'oldkeyhash0000' ;;
  "inspect --format {{.State.Running}} "*) exit 1 ;;
  "run -d --name hatchabot-embedder"*) echo embedderid ;;
  "run -d --name hatchabot-embed-door"*) echo doorid ;;
  "logs "*) echo '{"listening":8093}' ;;
esac
exit 0
`, { mode: 0o755 });
  chmodSync(stub, 0o755);
  const provider = new LocalDockerProvider({ docker: stub, image: 'test-image:latest', fetchImpl: (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch });
  return { provider, dir, argv: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []) };
}

describe('a reinstall beside a previous install\'s leftovers', () => {
  it('an orphan doorman holding the console port is removed and the run retried; a doorman of another prefix or of this agent is left alone', async () => {
    const { provider, argv } = stubDocker();
    const r = await provider.ensureOpsJail({ agentId: 'f0733b70-e646-47b7-8b57-0bc71ee43aec', slug: 'hatchabot', opsPort: 8091, consolePort: 19101 });
    expect(r.doorHost).toBe('doorman');
    const lines = argv();
    expect(lines.filter((l) => l.startsWith('run -d --name hatchabot-doorman-')).length).toBe(2);
    expect(lines).toContain('rm -f abc123');
    // and the failed first attempt's own container name was cleared before the retry
    expect(lines.filter((l) => /^rm -f hatchabot-doorman-f0733b70e646$/.test(l)).length).toBeGreaterThanOrEqual(2);
  });

  it('an embedder wearing another key is replaced, and the new one wears the key\'s hash', async () => {
    const { provider, dir, argv } = stubDocker();
    const keyFile = join(dir, 'server-key');
    writeFileSync(keyFile, 'the-new-key\n');
    // Not awaited: after these calls the provider waits on the door's health, which this stub never answers.
    void provider.ensureEmbedder({
      image: 'test-image:latest', modelPath: join(dir, 'model.gguf'), modelAlias: 'embeddinggemma', key: 'the-new-key',
      doorImage: 'test-image:latest', doorScript: 'noop', doorPort: 8093, doorBind: '127.0.0.1',
      keysFile: join(dir, 'keys.json'), serverKeyFile: keyFile, uid: process.getuid!(), gid: process.getgid!(), perMin: 600,
    } as never).catch(() => {});
    for (let i = 0; i < 100 && !argv().some((l) => l.startsWith('run -d --name hatchabot-embedder')); i++) await new Promise((r) => setTimeout(r, 30));
    const lines = argv();
    expect(lines).toContain('rm -f hatchabot-embedder');
    const run = lines.find((l) => l.startsWith('run -d --name hatchabot-embedder'));
    expect(run).toMatch(/--label hatchabot\.embed-key=[0-9a-f]{16}\b/);
    expect(run).not.toContain('oldkeyhash0000');
  });
});
