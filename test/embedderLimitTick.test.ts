import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { Store } from '../src/store/store.js';
import { EmbedderService, EMBED_MODEL_FILE, sha256File } from '../src/embedder/embedder.js';

/**
 * The health loop's start of a memory search engine off its memory limit
 * (HB-1021), the real service over the real provider, with Docker a stub that
 * remembers the engine (its key, memory label and limit) and the door. Flags
 * in its folder:
 *   refuse  - Docker will not remove the engine (the door's removal works)
 *   noimage - a runner without the runtime image: its files cannot be copied there
 *   busy    - the engine is at work (a re-index), by `docker stats`
 *   slow    - the loop's look at the engine answers late, with what it saw first
 * A runner's calls carry its connection flags, taken off before matching.
 */
class MemSecrets {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error('missing'); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'hb-limit-tick-'));
  const log = join(dir, 'argv.log');
  const stub = join(dir, 'docker');
  writeFileSync(stub, `#!/usr/bin/env bash
if [ "$1" = -H ]; then shift 2; [ "$1" = --tlsverify ] && shift; fi
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
d=${JSON.stringify(dir)}
case "$*" in
  "image inspect "*) [ -f "$d/noimage" ] && exit 1; echo sha256:made-up ;;
  "network inspect "*) exit 0 ;;
  "inspect --format {{.State.Running}}|"*" hatchabot-embedder")
    [ -f "$d/engine" ] || exit 1
    seen=$(cut -d'|' -f2- "$d/engine"); [ -f "$d/slow" ] && sleep 0.8
    printf 'true|%s\\n' "$seen" ;;
  "inspect --format {{.State.Running}} hatchabot-embedder") [ -f "$d/engine" ] && echo true || exit 1 ;;
  "inspect --format {{.State.Running}} hatchabot-embed-door") [ -f "$d/door" ] && echo true || exit 1 ;;
  "inspect hatchabot-embedder --format "*) cat "$d/engine" ;;
  "inspect hatchabot-embed-door --format "*) printf '%s|bridge,hatchabot-embed,\\n' "$(cat "$d/door")" ;;
  "rm -f hatchabot-embed-door") rm -f "$d/door" ;;
  "rm -f hatchabot-embedder") if [ -f "$d/refuse" ]; then echo 'Error response from daemon: removal timed out' >&2; exit 1; fi; rm -f "$d/engine" ;;
  "run -d --name hatchabot-embedder "*)
    key=$(echo "$*" | grep -oE 'hatchabot\\.embed-key=[0-9a-f.]+' | cut -d= -f2)
    asked=$(echo "$*" | grep -oE 'hatchabot\\.embed-memory=[^ ]+' | cut -d= -f2)
    m=$(echo "$*" | grep -oE -- '--memory [0-9]+g' | cut -d' ' -f2)
    printf '%s|%s|%s\\n' "$key" "$asked" "$(( \${m%g} * 1073741824 ))" > "$d/engine"; echo engineid ;;
  "run -d --name hatchabot-embed-door "*) echo "$*" | grep -oE 'hatchabot\\.embed-door=[0-9a-f]+' | cut -d= -f2 > "$d/door"; echo doorid ;;
  "port "*) echo "8093/tcp -> 127.0.0.1:8093" ;;
  "stats "*) [ -f "$d/engine" ] || exit 0; cpu=0.50; [ -f "$d/busy" ] && cpu=40.00
    printf '{"Name":"hatchabot-embedder","CPUPerc":"%s%%","MemUsage":"400MiB / 2GiB","PIDs":"4"}\\n' "$cpu" ;;
esac
exit 0
`, { mode: 0o755 });
  chmodSync(stub, 0o755);
  const fetchImpl = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;
  const local = new LocalDockerProvider({ docker: stub, image: 'test-image:latest', fetchImpl });
  const dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'models'), { recursive: true });
  writeFileSync(join(dataDir, 'models', EMBED_MODEL_FILE), 'made-up-model');
  const sha = await sha256File(join(dataDir, 'models', EMBED_MODEL_FILE));
  const events: string[] = [];
  let provider = local;
  const svc = new EmbedderService({
    provider: () => provider, secrets: new MemSecrets() as never, store: new Store(new Database(':memory:')), dataDir,
    runtimeImage: 'test-image:latest', doorScript: 'noop', doorBind: async () => '127.0.0.1', modelSha256: sha, log: (e) => events.push(e),
  });
  const argv = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []);
  return {
    dir, svc, events,
    /** The same Docker reached as a runner from here. */
    asRunner: () => { provider = new LocalDockerProvider({ docker: stub, image: 'test-image:latest', host: 'tcp://runner.invalid:2376', reachProbe: async () => true, fetchImpl }); },
    flag: (f: string, on = true) => (on ? writeFileSync(join(dir, f), '') : rmSync(join(dir, f), { force: true })),
    /** What serves: the engine's memory label, and whether the door is up. */
    serving: () => ({
      engine: existsSync(join(dir, 'engine')) ? readFileSync(join(dir, 'engine'), 'utf8').trim().split('|')[1] : 'absent',
      door: existsSync(join(dir, 'door')) ? 'up' : 'absent',
    }),
    engineRuns: () => argv().filter((l) => l.startsWith('run -d --name hatchabot-embedder ')).length,
  };
}

const had = process.env.HATCHABOT_EMBEDDER_MEMORY;
afterEach(() => { if (had === undefined) delete process.env.HATCHABOT_EMBEDDER_MEMORY; else process.env.HATCHABOT_EMBEDDER_MEMORY = had; });

describe('an empty memory setting (HB-1401)', () => {
  it('starts the engine on the default 2g, as Settings shows it, and the next tick leaves it there', async () => {
    const r = await rig();
    process.env.HATCHABOT_EMBEDDER_MEMORY = '';
    await r.svc.start();
    expect(r.serving()).toEqual({ engine: '2g', door: 'up' });
    expect(readFileSync(join(r.dir, 'argv.log'), 'utf8')).toMatch(/^run -d --name hatchabot-embedder .*--memory 2g /m);
    expect(await r.svc.healthTick()).toBe('ok');
    expect(r.engineRuns()).toBe(1);
  });
});

describe('the health loop and an engine off its memory limit (HB-1021 review)', () => {
  it('a limit restart Docker refuses leaves memory search serving on its old limit, and the next tick takes it', async () => {
    const r = await rig();
    process.env.HATCHABOT_EMBEDDER_MEMORY = '2g';
    await r.svc.start();
    process.env.HATCHABOT_EMBEDDER_MEMORY = '4g';
    r.flag('refuse');
    await expect(r.svc.healthTick()).rejects.toThrow(/embedder removal failed/);
    expect(r.serving()).toEqual({ engine: '2g', door: 'up' });
    await expect(r.svc.healthTick()).rejects.toThrow(/embedder removal failed/);
    expect(r.serving()).toEqual({ engine: '2g', door: 'up' });
    expect(r.events).not.toContain('embedder.limit_restart');
    r.flag('refuse', false);
    expect(await r.svc.healthTick()).toBe('restarted');
    expect(r.serving()).toEqual({ engine: '4g', door: 'up' });
    expect(r.events.filter((e) => e === 'embedder.limit_restart')).toHaveLength(1);
    expect(await r.svc.healthTick()).toBe('ok');
  });

  it('says what happened: a Restart or a Stop that lands between the look and the start leaves it nothing to replace', async () => {
    for (const [lands, says] of [['Restart', 'ok'], ['Stop', 'off']] as const) {
      const r = await rig();
      process.env.HATCHABOT_EMBEDDER_MEMORY = '2g';
      await r.svc.start();
      process.env.HATCHABOT_EMBEDDER_MEMORY = '4g';
      r.flag('slow');
      const tick = r.svc.healthTick();
      await new Promise((res) => setTimeout(res, 300));
      r.flag('slow', false);
      const owner = lands === 'Restart' ? r.svc.restart() : r.svc.stop();
      const [said] = await Promise.all([tick, owner]);
      expect([lands, said]).toEqual([lands, says]);
      expect(r.events).not.toContain('embedder.limit_restart');
      expect(r.engineRuns()).toBe(lands === 'Restart' ? 2 : 1);
    }
  });

  it('an engine at work (a re-index) is left to finish, and takes its new limit at the first tick it is idle', async () => {
    const r = await rig();
    process.env.HATCHABOT_EMBEDDER_MEMORY = '2g';
    await r.svc.start();
    process.env.HATCHABOT_EMBEDDER_MEMORY = '4g';
    r.flag('busy');
    expect(await r.svc.healthTick()).toBe('ok');
    expect(await r.svc.healthTick()).toBe('ok');
    expect(r.serving()).toEqual({ engine: '2g', door: 'up' });
    r.flag('busy', false);
    expect(await r.svc.healthTick()).toBe('restarted');
    expect(r.serving()).toEqual({ engine: '4g', door: 'up' });
  });

  it('on a runner, files that cannot be copied there leave it serving as it was', async () => {
    const r = await rig();
    process.env.HATCHABOT_EMBEDDER_MEMORY = '2g';
    await r.svc.start();
    r.asRunner();
    process.env.HATCHABOT_EMBEDDER_MEMORY = '4g';
    r.flag('noimage');
    await expect(r.svc.healthTick()).rejects.toThrow(/is not on the runner/);
    expect(r.serving()).toEqual({ engine: '2g', door: 'up' });
  });

  it('a failure after the old engine is gone still takes the service down, as any start that fails half way', async () => {
    const r = await rig();
    process.env.HATCHABOT_EMBEDDER_MEMORY = '2g';
    await r.svc.start();
    // Removed, then the new one's run fails: what is left is not managed, so it goes.
    process.env.HATCHABOT_EMBEDDER_MEMORY = '4g';
    writeFileSync(join(r.dir, 'docker-run-fails'), '');
    const stub = readFileSync(join(r.dir, 'docker'), 'utf8');
    writeFileSync(join(r.dir, 'docker'), stub.replace('  "run -d --name hatchabot-embedder "*)', '  "run -d --name hatchabot-embedder "*) [ -f "$d/docker-run-fails" ] && { echo made-up failure >&2; exit 1; }'));
    await expect(r.svc.healthTick()).rejects.toThrow(/embedder failed/);
    expect(r.serving()).toEqual({ engine: 'absent', door: 'absent' });
  });
});
