import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { buildConfigCommands } from '../src/openclaw/configWriter.js';
import { BROWSER_CDP_URL, browserImage, browserSweep } from '../src/orchestrator/browser.js';
import { makeWorld, seedRunningAgent, as } from './support/world.js';

/**
 * Each agent's own browser (src/orchestrator/browser.ts, docs/browser.md):
 * off by default, its own container in the agent's network namespace, and
 * OpenClaw attached to it. The 2026-10-08 trial: one browsing question was
 * 315K tokens, so it is opt-in per agent.
 */

describe('what OpenClaw is told', () => {
  const flat = (browser?: boolean) => buildConfigCommands({ agentId: 'a', authMode: 'api-key', browser } as never).map((c) => c.argv.join(' '));
  it('on: an attach-only profile at its own Chromium, and that profile is the default', () => {
    const f = flat(true);
    expect(f).toContain('config set browser.enabled true');
    expect(f).toContain(`config set browser.profiles.hatchabot ${JSON.stringify({ cdpUrl: BROWSER_CDP_URL, attachOnly: true })}`);
    expect(f).toContain('config set browser.defaultProfile hatchabot');
  });
  it('off (every other agent): the tool is off — no browser in the image, and a tool that cannot work only costs tokens', () => {
    expect(flat(undefined)).toContain('config set browser.enabled false');
    expect(flat(false)).toContain('config set browser.enabled false');
    expect(flat(false).some((l) => l.includes('browser.profiles'))).toBe(false);
  });
  it('the image is named by its Dockerfile, so a change builds a new one', () => {
    expect(browserImage().image).toMatch(/^hatchabot-browser:[0-9a-f]{12}$/);
    expect(browserImage().dockerfile).toContain('chromium');
  });
});

describe('the sweep keeps each machine\'s browsers in step with its agents', () => {
  function world() {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: '1' } as never);
    for (const [id, state] of [['on', 'RUNNING'], ['off', 'RUNNING'], ['asleep', 'STOPPED']] as const) {
      store.insertAgent({ id, ownerId: 'o', name: id, slug: id, state, aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
      store.setAgentRuntimeRef(id, `docker://hatchabot-${id}`);
    }
    store.setAgentBrowser('on', true);
    store.setAgentBrowser('asleep', true);
    const p = new MockProvider();
    const deps = { store, hostIds: () => ['h1'], providerFor: () => p };
    return { store, p, deps };
  }
  it('a running agent with it on gets one; one with it off, or stopped, has none', async () => {
    const w = world();
    w.p.browsers.set('hatchabot-off', true);    // left from before it was switched off
    w.p.browsers.set('hatchabot-asleep', true); // its agent stopped since
    const r = await browserSweep(w.deps);
    expect(r.started).toEqual(['hatchabot-on']);
    expect([...w.p.browsers.keys()]).toEqual(['hatchabot-on']);
    expect(w.p.browserSpecs[0]).toMatchObject({ agentContainer: 'hatchabot-on', memory: '1g', image: browserImage().image });
    // Again: kept, nothing started.
    expect((await browserSweep(w.deps)).started).toEqual([]);
  });
  it('a machine that is asleep is left alone', async () => {
    const w = world();
    w.p.awake = false;
    w.p.browsers.set('hatchabot-off', true);
    const r = await browserSweep(w.deps);
    expect(r).toEqual({ started: [], removed: [], failed: [] });
    expect(w.p.browsers.has('hatchabot-off')).toBe(true);
  });
});

describe('sweeps do not pile up (2026-10-09)', () => {
  function world() {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: '1' } as never);
    for (const id of ['one', 'two']) {
      store.insertAgent({ id, ownerId: 'o', name: id, slug: id, state: 'RUNNING', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
      store.setAgentRuntimeRef(id, `docker://hatchabot-${id}`);
      store.setAgentBrowser(id, true);
    }
    const p = new MockProvider();
    const state = { sweeping: new Map(), buildFailed: new Map() };
    let t = 1_000_000;
    const logs: string[] = [];
    const deps = { store, hostIds: () => ['h1'], providerFor: () => p, state, now: () => t, log: (_a: string | undefined, e: string) => { logs.push(e); } };
    return { store, p, deps, logs, advance: (ms: number) => { t += ms; } };
  }
  it('a sweep that finds the last one still going on that machine leaves it be (no second build beside a slow one)', async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    w.p.ensureBrowser = async () => { calls++; await gate; return 'started' as const; };
    const first = browserSweep(w.deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(await browserSweep(w.deps)).toEqual({ started: [], removed: [], failed: [] });
    expect(calls).toBe(1);
    release();
    await first;
    expect(calls).toBe(2);
  });
  it('an agent just started waits its turn instead of racing the sweep under way', async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    w.p.ensureBrowser = async (spec) => { order.push(spec.agentContainer); if (order.length === 1) await gate; return 'started' as const; };
    const first = browserSweep(w.deps);
    await new Promise((r) => setTimeout(r, 10));
    const second = browserSweep(w.deps, 'two');
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['hatchabot-one']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['hatchabot-one', 'hatchabot-two', 'hatchabot-two']);
  });
  it('a failed image build backs off on that machine: one try and one line, not one per agent per minute', async () => {
    const w = world();
    let calls = 0;
    w.p.ensureBrowser = async () => { calls++; throw new Error('browser image build failed: no space left on device'); };
    await browserSweep(w.deps);
    expect(calls).toBe(1);
    expect(w.logs.filter((e) => e === 'browser.start_failed')).toHaveLength(1);
    w.advance(30_000);
    await browserSweep(w.deps);
    expect(calls).toBe(1);
    w.advance(31_000); // a minute after the failure
    await browserSweep(w.deps);
    expect(calls).toBe(2);
    w.advance(61_000); // the second failure waits two minutes
    await browserSweep(w.deps);
    expect(calls).toBe(2);
    w.p.ensureBrowser = async () => { calls++; return 'started' as const; };
    w.advance(60_000);
    const r = await browserSweep(w.deps);
    expect(r.started).toEqual(['hatchabot-one', 'hatchabot-two']);
  });
});

describe('switching it on or off', () => {
  it('stores it and rebuilds the agent; the manager may not have one', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    const on = await w.f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as(), payload: { browser: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json().browserPending).toBeUndefined(); // a rebuild started: nothing to tell
    expect(w.store.getAgent('a1')!.browser).toBe(true);
    const st = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/browser', headers: as() });
    expect(st.json()).toMatchObject({ on: true });
    (w.store as unknown as { db: Database.Database }).db.prepare(`UPDATE agents SET ops = 1 WHERE id = 'a1'`).run();
    (w.store as unknown as { db: Database.Database }).db.prepare(`UPDATE agents SET browser = 0 WHERE id = 'a1'`).run();
    const ops = await w.f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as(), payload: { browser: true } });
    expect(ops.statusCode).toBe(400);
  });
  it('a switch while a rebuild is under way is saved, and the caller is told it may not be applied (2026-10-09)', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    // Mid-rebuild: before, stored with no rebuild and nobody told.
    (w.store as unknown as { db: Database.Database }).db.prepare(`UPDATE agents SET state = 'REBUILDING' WHERE id = 'a1'`).run();
    const on = await w.f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as(), payload: { browser: true } });
    expect(on.statusCode).toBe(200);
    expect(w.store.getAgent('a1')!.browser).toBe(true);
    expect(on.json().browserPending).toMatch(/rebuild/);
  });
});

describe('the container (docker argv)', () => {
  function stub(agentStarted: string, browserLabel?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'hb-browser-'));
    const log = join(dir, 'argv.log');
    const bin = join(dir, 'docker');
    writeFileSync(bin, `#!/usr/bin/env bash
cat > /dev/null &
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$*" in
  "inspect hatchabot-a1 --format "*) echo "true|${agentStarted}" ;;
  "inspect hatchabot-a1-browser --format "*) ${browserLabel ? `echo "true|${browserLabel}|${browserImage().image}"` : 'exit 1'} ;;
  "image inspect "*) exit 1 ;;
  "build "*) exit 0 ;;
  "run -d "*) echo newid ;;
esac
exit 0
`, { mode: 0o755 });
    chmodSync(bin, 0o755);
    const p = new LocalDockerProvider({ docker: bin, image: 'test-image:latest' });
    return { p, argv: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []) };
  }
  const spec = { agentContainer: 'hatchabot-a1', ...browserImage(), memory: '1g' };
  it('builds its image when missing, and runs in the agent\'s network with none of its files', async () => {
    const { p, argv } = stub('2026-10-08T10:00:00Z');
    expect(await p.ensureBrowser(spec)).toBe('started');
    const lines = argv();
    expect(lines.some((l) => l.startsWith(`build -t ${browserImage().image} -`))).toBe(true);
    const run = lines.find((l) => l.startsWith('run -d --name hatchabot-a1-browser'))!;
    expect(run).toContain('--network container:hatchabot-a1');
    expect(run).toContain('--read-only');
    expect(run).toContain('--cap-drop ALL');
    expect(run).toContain('--memory 1g');
    expect(run).toContain('hatchabot.browser-with=2026-10-08T10:00:00Z');
    expect(run).toContain('hatchabot.browser-prefix=hatchabot');
    expect(run).not.toMatch(/-v |--volume|\/home\/node/); // nothing of the agent's
  });
  it('lists only this install\'s browsers: another install on the same Docker keeps its own (2026-10-09)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-browser-ps-'));
    const bin = join(dir, 'docker');
    writeFileSync(bin, `#!/usr/bin/env bash
case "$*" in
  "ps -a --filter label=hatchabot.role=browser "*)
    echo "hatchabot-a1-browser|hatchabot-a1|running|hatchabot"
    echo "aclawsmoke-b1-browser|aclawsmoke-b1|running|aclawsmoke"
    echo "hatchabot-old-browser|hatchabot-old|running|"
    echo "aclawsmoke-old-browser|aclawsmoke-old|exited|"
    echo "agentclaw-legacy-browser|agentclaw-legacy|running|" ;;
esac
exit 0
`, { mode: 0o755 });
    chmodSync(bin, 0o755);
    const mine = new LocalDockerProvider({ docker: bin, image: 'test-image:latest' });
    expect((await mine.listBrowsers()).map((b) => b.agentContainer)).toEqual(['hatchabot-a1', 'hatchabot-old', 'agentclaw-legacy']);
    const smoke = new LocalDockerProvider({ docker: bin, image: 'test-image:latest', prefix: 'aclawsmoke' });
    expect((await smoke.listBrowsers()).map((b) => b.agentContainer)).toEqual(['aclawsmoke-b1', 'aclawsmoke-old']);
  });
  it('kept while it shares the agent\'s current network; replaced once the agent restarted', async () => {
    const same = stub('2026-10-08T10:00:00Z', '2026-10-08T10:00:00Z');
    expect(await same.p.ensureBrowser(spec)).toBe('running');
    expect(same.argv().some((l) => l.startsWith('run -d'))).toBe(false);
    const restarted = stub('2026-10-08T11:00:00Z', '2026-10-08T10:00:00Z');
    expect(await restarted.p.ensureBrowser(spec)).toBe('started');
    expect(restarted.argv()).toContain('rm -f hatchabot-a1-browser');
  });
});
