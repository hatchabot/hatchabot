import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  "run -d --name hatchabot-doorman-"*) echo newdoorman ;;
  "network connect bridge hatchabot-doorman-"*)
    # The jail network is internal: the console port binds only here, so the clash shows up here (Docker Desktop, 2026-09-25).
    n=$(cat ${JSON.stringify(state)} 2>/dev/null || echo 0); echo $((n+1)) > ${JSON.stringify(state)}
    if [ "$n" = 0 ]; then echo 'Error response from daemon: driver failed programming external connectivity on endpoint hatchabot-doorman-f0733b70e646 (0d2f): Bind for 127.0.0.1:19101 failed: port is already allocated' >&2; exit 1; fi ;;
  "ps -q --filter publish=19101 --filter label=hatchabot.role=doorman") echo 'abc123' ;;
  "inspect abc123 --format "*) echo '/hatchabot-doorman-e082d39db388 e082d39d-old' ;;
  "rm -f hatchabot-embedder") touch ${JSON.stringify(state)}.removed ;;
  "inspect --format {{.State.Running}}"*" hatchabot-embedder") [ -f ${JSON.stringify(state)}.removed ] && exit 1; echo true ;;
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
    expect(lines.filter((l) => l.startsWith('network connect bridge hatchabot-doorman-')).length).toBe(2);
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

describe('the 30th audit: the memory door survives a start that changes nothing', () => {
  function statefulStub() {
    const dir = mkdtempSync(join(tmpdir(), 'hb-door-'));
    const log = join(dir, 'argv.log');
    const stub = join(dir, 'docker');
    // Remembers what it ran: a later inspect answers with the labels the run wore.
    writeFileSync(stub, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
d=${JSON.stringify(dir)}
case "$*" in
  "network inspect "*) exit 0 ;;
  "inspect --format {{.State.Running}}"*" hatchabot-embedder") [ -f "$d/embedder" ] && echo true || exit 1 ;;
  "inspect --format {{.State.Running}} hatchabot-embed-door") [ -f "$d/door" ] && echo true || exit 1 ;;
  "inspect hatchabot-embedder --format "*) cat "$d/embedder" ;;
  "inspect hatchabot-embed-door --format "*) printf '%s|%s\\n' "$(cat "$d/door")" "$(cat "$d/door-nets" 2>/dev/null)" ;;
  "run -d --name hatchabot-embedder "*) echo "$*" | grep -oE 'hatchabot\\.embed-key=[0-9a-f]+' | cut -d= -f2 > "$d/embedder"; echo embedderid ;;
  "run -d --name hatchabot-embed-door "*) echo "$*" | grep -oE 'hatchabot\\.embed-door=[0-9a-f]+' | cut -d= -f2 > "$d/door"; echo 'bridge,' > "$d/door-nets"; echo doorid ;;
  "network connect hatchabot-embed hatchabot-embed-door") echo 'bridge,hatchabot-embed,' > "$d/door-nets" ;;
  "rm -f hatchabot-embed-door") rm -f "$d/door" "$d/door-nets" ;;
  "port "*) echo "8093/tcp -> 127.0.0.1:8093" ;;
esac
exit 0
`, { mode: 0o755 });
    chmodSync(stub, 0o755);
    const provider = new LocalDockerProvider({ docker: stub, image: 'test-image:latest', fetchImpl: (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch });
    return { provider, dir, argv: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []) };
  }
  it('a second start keeps a running door with the same configuration; a changed limit replaces it', async () => {
    const { provider, dir, argv } = statefulStub();
    const keyFile = join(dir, 'server-key');
    writeFileSync(keyFile, 'the-key\n');
    const spec = {
      image: 'test-image:latest', modelPath: join(dir, 'model.gguf'), modelAlias: 'embeddinggemma', key: 'the-key',
      doorImage: 'test-image:latest', doorScript: 'noop', doorPort: 8093, doorBind: '127.0.0.1',
      keysFile: join(dir, 'keys.json'), serverKeyFile: keyFile, uid: process.getuid!(), gid: process.getgid!(), perMin: 600, mbPerMin: 8,
    };
    await provider.ensureEmbedder(spec as never);
    const doorRuns = () => argv().filter((l) => l.startsWith('run -d --name hatchabot-embed-door')).length;
    const doorRms = () => argv().filter((l) => l === 'rm -f hatchabot-embed-door').length;
    expect(doorRuns()).toBe(1);
    expect(argv().find((l) => l.startsWith('run -d --name hatchabot-embed-door'))).toMatch(/--label hatchabot\.embed-door=[0-9a-f]{16}\b/);
    // The same again (a control-plane restart): the door is left alone.
    await provider.ensureEmbedder(spec as never);
    expect(doorRuns()).toBe(1);
    expect(doorRms()).toBe(0);
    // A changed per-minute limit is a new door.
    await provider.ensureEmbedder({ ...spec, perMin: 900 } as never);
    expect(doorRuns()).toBe(2);
    expect(doorRms()).toBe(1);
    // So is a changed byte budget, and the door is told it (HB-0026).
    expect(argv().find((l) => l.startsWith('run -d --name hatchabot-embed-door'))).toContain('-e EMBED_MB_PER_MIN=8 ');
    await provider.ensureEmbedder({ ...spec, perMin: 900, mbPerMin: 2 } as never);
    expect(doorRuns()).toBe(3);
    expect(argv().filter((l) => l.startsWith('run -d --name hatchabot-embed-door')).at(-1)).toContain('-e EMBED_MB_PER_MIN=2 ');
  });
  it('a kept door that never joined the server\'s network (a start cut off before its connect) is connected (HB-0330)', async () => {
    const { provider, dir, argv } = statefulStub();
    const keyFile = join(dir, 'server-key');
    writeFileSync(keyFile, 'the-key\n');
    const spec = {
      image: 'test-image:latest', modelPath: join(dir, 'model.gguf'), modelAlias: 'embeddinggemma', key: 'the-key',
      doorImage: 'test-image:latest', doorScript: 'noop', doorPort: 8093, doorBind: '127.0.0.1',
      keysFile: join(dir, 'keys.json'), serverKeyFile: keyFile, uid: process.getuid!(), gid: process.getgid!(), perMin: 600, mbPerMin: 8,
    };
    const connects = () => argv().filter((l) => l === 'network connect hatchabot-embed hatchabot-embed-door').length;
    await provider.ensureEmbedder(spec as never);
    expect(connects()).toBe(1);
    // Joined: kept as it is, no second connect.
    await provider.ensureEmbedder(spec as never);
    expect(connects()).toBe(1);
    // Cut off between the door's run and its connect: same configuration, bridge only.
    writeFileSync(join(dir, 'door-nets'), 'bridge,\n');
    await provider.ensureEmbedder(spec as never);
    expect(connects()).toBe(2);
    expect(argv().filter((l) => l.startsWith('run -d --name hatchabot-embed-door'))).toHaveLength(1);
  });
});

describe('HB-1021: the memory search engine follows its memory limit', () => {
  /**
   * Remembers the engine it ran: its key label, its memory label, and the
   * limit Docker holds (what --memory asked, in bytes; 0 where `nolimits`
   * says the kernel has none). `old` stands for an engine made before the
   * memory label: its key and the limit Docker holds only. `refuse`: Docker
   * refuses to remove the engine.
   */
  function engineStub() {
    const dir = mkdtempSync(join(tmpdir(), 'hb-engine-mem-'));
    const log = join(dir, 'argv.log');
    const stub = join(dir, 'docker');
    writeFileSync(stub, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
d=${JSON.stringify(dir)}
case "$*" in
  "network inspect "*) exit 0 ;;
  # The health loop's look: its state, memory label and limit.
  "inspect --format {{.State.Running}}|"*" hatchabot-embedder") [ -f "$d/engine" ] && printf 'true|%s\\n' "$(cut -d'|' -f2- "$d/engine")" || exit 1 ;;
  "inspect --format {{.State.Running}} hatchabot-embedder") [ -f "$d/engine" ] && echo true || exit 1 ;;
  "inspect --format {{.State.Running}} hatchabot-embed-door") [ -f "$d/door" ] && echo true || exit 1 ;;
  # What the format asks for: the key label alone, or the key, memory label and limit.
  "inspect hatchabot-embedder --format "*embed-memory*) cat "$d/engine" ;;
  "inspect hatchabot-embedder --format "*) cut -d'|' -f1 "$d/engine" ;;
  "inspect hatchabot-embed-door --format "*) printf '%s|bridge,hatchabot-embed,\\n' "$(cat "$d/door")" ;;
  "rm -f hatchabot-embedder") if [ -f "$d/refuse" ]; then echo 'Error response from daemon: removal timed out' >&2; exit 1; fi; rm -f "$d/engine" ;;
  "run -d --name hatchabot-embedder "*)
    key=$(echo "$*" | grep -oE 'hatchabot\\.embed-key=[0-9a-f.]+' | cut -d= -f2)
    asked=$(echo "$*" | grep -oE 'hatchabot\\.embed-memory=[^ ]+' | cut -d= -f2)
    m=$(echo "$*" | grep -oE -- '--memory [0-9]+[mg]' | head -1 | cut -d' ' -f2)
    case "$m" in *g) b=$(( \${m%g} * 1073741824 )) ;; *m) b=$(( \${m%m} * 1048576 )) ;; *) b=0 ;; esac
    [ -f "$d/nolimits" ] && b=0
    if [ -f "$d/old" ]; then printf '%s|<no value>|%s\\n' "$key" "$b" > "$d/engine"; else printf '%s|%s|%s\\n' "$key" "$asked" "$b" > "$d/engine"; fi
    echo engineid ;;
  "run -d --name hatchabot-embed-door "*) echo "$*" | grep -oE 'hatchabot\\.embed-door=[0-9a-f]+' | cut -d= -f2 > "$d/door"; echo doorid ;;
  "port "*) echo "8093/tcp -> 127.0.0.1:8093" ;;
esac
exit 0
`, { mode: 0o755 });
    chmodSync(stub, 0o755);
    const provider = new LocalDockerProvider({ docker: stub, image: 'test-image:latest', fetchImpl: (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch });
    const keyFile = join(dir, 'server-key');
    writeFileSync(keyFile, 'the-key\n');
    const spec = {
      image: 'test-image:latest', modelPath: join(dir, 'model.gguf'), modelAlias: 'embeddinggemma', key: 'the-key',
      doorImage: 'test-image:latest', doorScript: 'noop', doorPort: 8093, doorBind: '127.0.0.1',
      keysFile: join(dir, 'keys.json'), serverKeyFile: keyFile, uid: process.getuid!(), gid: process.getgid!(), perMin: 600, mbPerMin: 8,
    };
    const argv = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []);
    const runs = () => argv().filter((l) => l.startsWith('run -d --name hatchabot-embedder '));
    return { provider, dir, spec, runs, removals: () => argv().filter((l) => l === 'rm -f hatchabot-embedder').length };
  }
  const withMemory = async (value: string | undefined, fn: () => Promise<void>) => {
    const had = process.env.HATCHABOT_EMBEDDER_MEMORY;
    if (value === undefined) delete process.env.HATCHABOT_EMBEDDER_MEMORY; else process.env.HATCHABOT_EMBEDDER_MEMORY = value;
    try { await fn(); } finally { if (had === undefined) delete process.env.HATCHABOT_EMBEDDER_MEMORY; else process.env.HATCHABOT_EMBEDDER_MEMORY = had; }
  };

  it('a changed limit replaces the engine at the next start, and only then; the same limit written another way keeps it', async () => {
    const { provider, spec, runs, removals } = engineStub();
    await withMemory('2g', () => provider.ensureEmbedder(spec as never).then(() => {}));
    expect(runs()).toHaveLength(1);
    // A restart that changes nothing keeps it, as before.
    await withMemory('2g', () => provider.ensureEmbedder(spec as never).then(() => {}));
    await withMemory('2048m', () => provider.ensureEmbedder(spec as never).then(() => {}));
    expect(runs()).toHaveLength(1);
    expect(removals()).toBe(0);
    // Raised in .env, then a restart: a new engine at the new limit.
    await withMemory('4g', () => provider.ensureEmbedder(spec as never).then(() => {}));
    expect(removals()).toBe(1);
    expect(runs()).toHaveLength(2);
    expect(runs()[1]).toContain('--memory 4g ');
    expect(runs()[1]).toContain('--label hatchabot.embed-memory=4g ');
    await withMemory('4g', () => provider.ensureEmbedder(spec as never).then(() => {}));
    expect(runs()).toHaveLength(2);
  });

  it('an engine from before the label is judged by the limit Docker holds, and kept where Docker holds none', async () => {
    const { provider, dir, spec, runs, removals } = engineStub();
    writeFileSync(join(dir, 'old'), '');
    await withMemory(undefined, () => provider.ensureEmbedder(spec as never).then(() => {}));
    // Upgraded with the limit unchanged: kept.
    rmSync(join(dir, 'old'));
    await withMemory(undefined, () => provider.ensureEmbedder(spec as never).then(() => {}));
    expect(removals()).toBe(0);
    // Changed: replaced.
    await withMemory('3g', () => provider.ensureEmbedder(spec as never).then(() => {}));
    expect(removals()).toBe(1);
    expect(runs().at(-1)).toContain('--memory 3g ');
    // A kernel with no memory limits: an engine from before the label holds 0, and is not replaced for it.
    const other = engineStub();
    writeFileSync(join(other.dir, 'old'), '');
    writeFileSync(join(other.dir, 'nolimits'), '');
    await withMemory(undefined, () => other.provider.ensureEmbedder(other.spec as never).then(() => {}));
    rmSync(join(other.dir, 'old'));
    await withMemory(undefined, () => other.provider.ensureEmbedder(other.spec as never).then(() => {}));
    expect(other.removals()).toBe(0);
    expect(other.runs()).toHaveLength(1);
  });

  it('the health loop\'s look says an engine is on another limit than the one asked for now, from the same look', async () => {
    const { provider, spec } = engineStub();
    await withMemory('2g', () => provider.ensureEmbedder(spec as never).then(() => {}));
    await withMemory('2g', async () => expect(await provider.embedderStatus()).toEqual({ embedder: 'running', door: 'running', doorAddress: '127.0.0.1:8093' }));
    await withMemory('2048m', async () => expect((await provider.embedderStatus()).engineMemoryOff).toBeUndefined());
    await withMemory('4g', async () => expect(await provider.embedderStatus()).toMatchObject({ embedder: 'running', engineMemoryOff: true }));
    // Where Docker holds no limit, an engine from before the label is not called off it.
    const other = engineStub();
    writeFileSync(join(other.dir, 'old'), '');
    writeFileSync(join(other.dir, 'nolimits'), '');
    await withMemory(undefined, () => other.provider.ensureEmbedder(other.spec as never).then(() => {}));
    await withMemory('4g', async () => expect((await other.provider.embedderStatus()).engineMemoryOff).toBeUndefined());
  });

  it('a start whose old engine Docker would not remove fails, for a new limit or a new key, instead of saying the old one is up', async () => {
    const { provider, dir, spec, runs, removals } = engineStub();
    await withMemory('2g', () => provider.ensureEmbedder(spec as never).then(() => {}));
    writeFileSync(join(dir, 'refuse'), '');
    await withMemory('4g', async () => {
      await expect(provider.ensureEmbedder(spec as never)).rejects.toMatchObject({ userMessage: "Couldn't replace the memory search engine to start it on its new settings. Try again in a moment." });
    });
    await withMemory('2g', async () => {
      await expect(provider.ensureEmbedder({ ...spec, modelAlias: 'another-alias' } as never)).rejects.toThrow(/embedder removal failed: .*removal timed out/);
    });
    expect(removals()).toBe(2);
    expect(runs()).toHaveLength(1);
    // Taken once Docker lets it go.
    rmSync(join(dir, 'refuse'));
    await withMemory('4g', () => provider.ensureEmbedder(spec as never).then(() => {}));
    expect(runs()).toHaveLength(2);
    expect(runs()[1]).toContain('--memory 4g ');
  });
});
