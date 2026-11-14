import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import {
  BROWSER_CLOSE_SOURCE, BROWSER_LOGINS_RE, BROWSER_PROFILE_PREP, BROWSER_PROFILE_UNLOCK, BROWSER_PROFILE_WARN_BYTES, BROWSER_UID,
  browserImage, browserLoginsVolume, browserSweep, newBrowserLogins,
} from '../src/orchestrator/browser.js';
import { browserSteerers, siteOf } from '../src/orchestrator/browserLogins.js';
import { makeWorld, seedRunningAgent, as, type World } from './support/world.js';

/**
 * Keep its logins (HB-0680 part 2, docs/browser-logins-design.md): an agent's
 * browser profile on a volume of its own, so a sign-in survives a restart,
 * until its owner forgets it. Never in a backup or a download (the backup and
 * uninstall scripts' own tests: backupCompleteness, scriptsUninstall).
 */

const ID = '0a1b2c3d4e5f';
const ID2 = 'f5e4d3c2b1a0';

describe('the profile, the volume and the close', () => {
  it('ids, names and scripts', () => {
    expect(newBrowserLogins()).toMatch(BROWSER_LOGINS_RE);
    expect(newBrowserLogins()).not.toBe(newBrowserLogins());
    expect(browserLoginsVolume('hatchabot-kitchen-1', ID)).toBe(`hatchabot-kitchen-1-browser-logins-${ID}`);
    // Prepared once as root (owner and "continue where you left off"), unlocked before each start.
    expect(BROWSER_PROFILE_PREP).toContain('"restore_on_startup":1');
    expect(BROWSER_PROFILE_PREP).toContain(`chown -R ${BROWSER_UID}:${BROWSER_UID} /profile`);
    expect(BROWSER_PROFILE_PREP.trim().split('\n').at(-1)).toBe('echo READY');
    expect(BROWSER_PROFILE_UNLOCK).toMatch(/^rm -f \/profile\/SingletonLock .* && echo UNLOCKED$/);
    for (const sh of [BROWSER_PROFILE_PREP, BROWSER_PROFILE_UNLOCK]) execFileSync('sh', ['-n', '-c', sh]);
    // The close is Browser.close, from the agent's side, and nothing else.
    expect(BROWSER_CLOSE_SOURCE).toContain("method: 'Browser.close'");
    expect(BROWSER_CLOSE_SOURCE.match(/method: '[A-Za-z.]+'/g)).toEqual(["method: 'Browser.close'"]);
    execFileSync(process.execPath, ['--check', '--input-type=module'], { input: BROWSER_CLOSE_SOURCE });
    expect(BROWSER_PROFILE_WARN_BYTES).toBe(500 * 1024 * 1024);
  });

  it('a site is the host of a web page, nothing else', () => {
    expect(siteOf('https://Accounts.Example.org/sign-in?next=/x')).toBe('accounts.example.org');
    expect(siteOf('http://example.net:8080/')).toBe('example.net');
    for (const u of ['about:blank', 'chrome://settings', 'data:text/html,hi', 'not a url']) expect(siteOf(u)).toBeUndefined();
  });
});

describe('the container (docker argv)', () => {
  /**
   * A docker on PATH that answers as the scenario says and logs every call.
   * `browser`: the running browser's labels, or none. `volume`: the label an
   * existing profile volume carries, or none (made new).
   */
  function stub(o: { browser?: { with: string; logins: string; memory?: number }; volume?: string; prep?: string; closes?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'hb-logins-'));
    const log = join(dir, 'argv.log');
    const bin = join(dir, 'docker');
    const b = o.browser;
    writeFileSync(bin, `#!/usr/bin/env bash
cat > /dev/null &
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$*" in
  "inspect hatchabot-a1 --format "*) echo "true|2026-11-13T10:00:00Z" ;;
  "inspect hatchabot-a1-browser --format "*browser-with*) ${b ? `echo "true|${b.with}|${browserImage().image}||${b.memory ?? 1024 ** 3}|${b.logins}"` : 'exit 1'} ;;
  "inspect hatchabot-a1-browser --format "*) ${b ? `echo "true|${b.logins}"` : 'exit 1'} ;;
  "image inspect "*) echo sha256:x ;;
  "volume inspect "*) ${o.volume !== undefined ? `echo "${o.volume}"` : 'echo "Error: no such volume" >&2; exit 1'} ;;
  "volume create "*) echo made ;;
  "volume ls "*) printf '%s\\n' 'hatchabot-a1-browser-logins-${ID}|hatchabot-a1|a1|${ID}' 'hatchabot-a1-browser-logins-${ID2}|hatchabot-a1|a1|${ID2}' 'hatchabot-zz-browser-logins-${ID}|hatchabot-zz|<no value>|${ID}' ;;
  "run --rm --network none "*UNLOCKED*) echo UNLOCKED ;;
  "run --rm --network none "*) ${o.prep ?? 'echo READY'} ;;
  "run --rm "*) echo FENCED ;;
  "exec hatchabot-a1 node "*) ${o.closes === false ? 'exit 1' : 'echo CLOSING'} ;;
  "wait "*) echo 0 ;;
  "run -d "*) echo newid ;;
esac
exit 0
`, { mode: 0o755 });
    chmodSync(bin, 0o755);
    const p = new LocalDockerProvider({ docker: bin, image: 'test-image:latest' });
    const argv = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []);
    return { p, argv, at: (prefix: string) => argv().findIndex((l) => l.startsWith(prefix)) };
  }
  const spec = { agentContainer: 'hatchabot-a1', agentId: 'a1', ...browserImage(), memory: '1g' };
  const VOL = `hatchabot-a1-browser-logins-${ID}`;

  it('keeping logins: a volume of its own, made and prepared once, unlocked, mounted where the profile was', async () => {
    const { p, argv, at } = stub();
    expect(await p.ensureBrowser({ ...spec, logins: ID })).toBe('started');
    const lines = argv();
    const create = lines.find((l) => l.startsWith('volume create '))!;
    for (const l of ['hatchabot.role=browser-logins', 'hatchabot.browser-of=hatchabot-a1', 'hatchabot.browser-prefix=hatchabot', `hatchabot.browser-logins=${ID}`, 'hatchabot.agent=a1']) expect(create).toContain(`--label ${l}`);
    expect(create.endsWith(` ${VOL}`)).toBe(true);
    // As root with only the right to change owners, in no network; then as the browser's user, with nothing.
    const prep = lines.find((l) => l.startsWith('run --rm --network none') && l.includes('--cap-add CHOWN'))!;
    expect(prep).toContain('--user 0:0 --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges');
    expect(prep).toContain(`-v ${VOL}:/profile`);
    const unlock = lines.find((l) => l.includes('UNLOCKED'))!;
    expect(unlock).toContain(`--user ${BROWSER_UID}:${BROWSER_UID} --cap-drop ALL --security-opt`);
    expect(at('volume create ')).toBeLessThan(at('run --rm --network none'));
    const run = lines.find((l) => l.startsWith('run -d --name hatchabot-a1-browser'))!;
    expect(run).toContain(`-v ${VOL}:/profile`);
    expect(run).toContain(`--label hatchabot.browser-logins=${ID}`);
    expect(run).not.toContain('--tmpfs /profile');
    expect(run).toContain('--read-only');
    expect(at('run -d ')).toBeGreaterThan(argv().findIndex((l) => l.includes('UNLOCKED')));
  });

  it('a volume there already is not prepared again; one labelled as another profile is never mounted', async () => {
    const again = stub({ volume: ID });
    expect(await again.p.ensureBrowser({ ...spec, logins: ID })).toBe('started');
    expect(again.argv().some((l) => l.startsWith('volume create'))).toBe(false);
    expect(again.argv().some((l) => l.includes('--cap-add CHOWN'))).toBe(false);
    expect(again.argv().some((l) => l.includes('UNLOCKED'))).toBe(true);
    const other = stub({ volume: 'something-else' });
    await expect(other.p.ensureBrowser({ ...spec, logins: ID })).rejects.toThrow(/not a browser profile of this install/);
    expect(other.argv().some((l) => l.startsWith('run -d'))).toBe(false);
  });

  it('a prep that fails removes the volume it made, and starts no browser', async () => {
    const { p, argv } = stub({ prep: 'echo "chown: Operation not permitted" >&2; exit 1' });
    await expect(p.ensureBrowser({ ...spec, logins: ID })).rejects.toThrow(/browser logins prep failed/);
    expect(argv()).toContain(`volume rm ${VOL}`);
    expect(argv().some((l) => l.startsWith('run -d'))).toBe(false);
    await expect(stub().p.ensureBrowser({ ...spec, logins: 'not-an-id' })).rejects.toThrow(/bad browser logins id/);
  });

  it('a browser kept on its profile but replaced (a new memory limit) is closed first, so it writes it', async () => {
    const { p, argv, at } = stub({ browser: { with: '2026-11-13T10:00:00Z', logins: ID }, volume: ID });
    expect(await p.ensureBrowser({ ...spec, logins: ID })).toBe('running');
    expect(argv().some((l) => l.startsWith('exec '))).toBe(false);
    expect(await p.ensureBrowser({ ...spec, logins: ID, memory: '2g' })).toBe('started');
    expect(at('exec hatchabot-a1 node --input-type=module -e')).toBeGreaterThan(-1);
    expect(at('exec hatchabot-a1 node')).toBeLessThan(at('wait hatchabot-a1-browser'));
    expect(at('wait hatchabot-a1-browser')).toBeLessThan(at('rm -f hatchabot-a1-browser'));
  });

  it('one on a profile forgotten, or switched off, is removed at once: nothing of it is wanted', async () => {
    const forgot = stub({ browser: { with: '2026-11-13T10:00:00Z', logins: ID } });
    expect(await forgot.p.ensureBrowser({ ...spec, logins: ID2 })).toBe('started');
    expect(forgot.argv().some((l) => l.startsWith('exec '))).toBe(false);
    expect(forgot.argv()).toContain('rm -f hatchabot-a1-browser');
    expect(forgot.argv().find((l) => l.startsWith('run -d'))).toContain(`hatchabot-a1-browser-logins-${ID2}:/profile`);
    const off = stub({ browser: { with: '2026-11-13T10:00:00Z', logins: ID } });
    expect(await off.p.ensureBrowser(spec)).toBe('started');
    expect(off.argv().find((l) => l.startsWith('run -d'))).toContain('--tmpfs /profile:size=512m');
    expect(off.argv().find((l) => l.startsWith('run -d'))).toContain('--label hatchabot.browser-logins=none');
  });

  it('an agent stopped or rebuilt: its browser is closed first, in the network they share', async () => {
    const s = stub({ browser: { with: '2026-11-13T10:00:00Z', logins: ID } });
    await s.p.stop('docker://hatchabot-a1');
    expect(s.at('exec hatchabot-a1 node')).toBeGreaterThan(-1);
    expect(s.at('wait hatchabot-a1-browser')).toBeLessThan(s.at('stop -t 10 hatchabot-a1'));
    // One that keeps nothing is not asked; one that will not close is stopped as before.
    const plain = stub({ browser: { with: '2026-11-13T10:00:00Z', logins: 'none' } });
    await plain.p.stop('docker://hatchabot-a1');
    expect(plain.argv().some((l) => l.startsWith('exec '))).toBe(false);
    const stuck = stub({ browser: { with: '2026-11-13T10:00:00Z', logins: ID }, closes: false });
    await stuck.p.stop('docker://hatchabot-a1');
    expect(stuck.argv().some((l) => l.startsWith('wait '))).toBe(false);
    expect(stuck.at('stop -t 10 hatchabot-a1')).toBeGreaterThan(-1);
    // Removed by the sweep: closed too.
    const swept = stub({ browser: { with: '2026-11-13T10:00:00Z', logins: ID } });
    await swept.p.stopBrowser('hatchabot-a1');
    expect(swept.at('wait hatchabot-a1-browser')).toBeLessThan(swept.at('rm -f hatchabot-a1-browser'));
  });

  it('deleted or moved away (destroy with purge): its browser and every profile it kept go too', async () => {
    const s = stub();
    await s.p.destroy('docker://hatchabot-a1', { purge: true });
    const lines = s.argv();
    expect(lines).toContain('rm -f hatchabot-a1-browser');
    expect(lines).toContain(`volume rm hatchabot-a1-browser-logins-${ID}`);
    expect(lines).toContain(`volume rm hatchabot-a1-browser-logins-${ID2}`);
    expect(lines).not.toContain(`volume rm hatchabot-zz-browser-logins-${ID}`);
  });

  it('lists this install\'s profiles by their labels; removes only what is one', async () => {
    const { p, argv } = stub();
    const list = await p.listBrowserLogins();
    expect(argv().find((l) => l.startsWith('volume ls'))).toContain('--filter label=hatchabot.role=browser-logins --filter label=hatchabot.browser-prefix=hatchabot');
    expect(list).toEqual([
      { name: `hatchabot-a1-browser-logins-${ID}`, agentContainer: 'hatchabot-a1', agentId: 'a1', logins: ID },
      { name: `hatchabot-a1-browser-logins-${ID2}`, agentContainer: 'hatchabot-a1', agentId: 'a1', logins: ID2 },
      { name: `hatchabot-zz-browser-logins-${ID}`, agentContainer: 'hatchabot-zz', logins: ID },
    ]);
    expect(await p.removeBrowserLogins('hatchabot-a1-vol')).toBe(false);
    expect(argv()).not.toContain('volume rm hatchabot-a1-vol');
  });
});

describe('the sweep keeps each machine\'s profiles in step with its agents', () => {
  function world() {
    const store = new Store(new Database(':memory:'));
    for (const h of ['h1', 'h2']) store.insertHost({ id: h, ownerId: 'o', kind: h === 'h1' ? 'local' : 'runner', provider: 'mock', name: h, settings: {}, createdAt: '1' } as never);
    for (const [id, state] of [['kitchen', 'RUNNING'], ['garden', 'STOPPED'], ['attic', 'RUNNING']] as const) {
      store.insertAgent({ id, ownerId: 'o', name: id, slug: id, state, aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
      store.setAgentRuntimeRef(id, `mock://${id}`);
      store.setAgentBrowser(id, true);
    }
    const p = new MockProvider();
    const logs: Array<[string | undefined, string, Record<string, unknown>]> = [];
    const deps = { store, hostIds: () => ['h1'], providerFor: () => p, log: (a: string | undefined, e: string, d: Record<string, unknown>) => { logs.push([a, e, d]); }, state: { sweeping: new Map(), buildFailed: new Map(), sizes: new Map() } };
    return { store, p, deps, logs };
  }

  it('one that keeps logins runs on its profile; a stopped one keeps its profile, its browser closed', async () => {
    const w = world();
    w.store.setAgentBrowserLogins('kitchen', ID);
    w.store.setAgentBrowserLogins('garden', ID2);
    await browserSweep(w.deps);
    expect(w.p.browserSpecs.find((s) => s.agentContainer === 'kitchen')).toMatchObject({ agentId: 'kitchen', logins: ID });
    expect(w.p.browserSpecs.find((s) => s.agentContainer === 'attic')!.logins).toBeUndefined();
    expect([...w.p.loginVolumes.keys()]).toEqual([browserLoginsVolume('kitchen', ID)]);
    // Stopped: browser gone, closed first; the profile stays for its next start.
    w.store.setAgentState('kitchen', 'STOPPED');
    await browserSweep(w.deps);
    expect(w.p.browserCloses).toEqual(['kitchen']);
    expect(w.p.browsers.has('kitchen')).toBe(false);
    expect([...w.p.loginVolumes.keys()]).toEqual([browserLoginsVolume('kitchen', ID)]);
    // Running again: the same profile.
    w.store.setAgentState('kitchen', 'RUNNING');
    await browserSweep(w.deps);
    expect(w.p.browserLoginsOf.get('kitchen')).toBe(ID);
  });

  it('forgotten: a new, empty profile at once, and the old one deleted', async () => {
    const w = world();
    w.store.setAgentBrowserLogins('kitchen', ID);
    await browserSweep(w.deps);
    w.store.setAgentBrowserLogins('kitchen', ID2);
    const r = await browserSweep(w.deps, 'kitchen');
    expect(w.p.browserLoginsOf.get('kitchen')).toBe(ID2);
    expect([...w.p.loginVolumes.keys()]).toEqual([browserLoginsVolume('kitchen', ID2)]);
    expect(r.removed).toContain(browserLoginsVolume('kitchen', ID));
    expect(w.logs).toContainEqual(['kitchen', 'browser.logins_removed', { why: 'forgotten' }]);
  });

  it('switched off, the browser switched off, archived, deleted or moved: deleted; one still in use is tried again', async () => {
    const w = world();
    for (const id of ['kitchen', 'garden', 'attic']) w.store.setAgentBrowserLogins(id, ID);
    // garden is stopped: its profile from when it last ran. And one whose agent is gone.
    w.p.loginVolumes.set(browserLoginsVolume('garden', ID), { agentContainer: 'garden', agentId: 'garden', logins: ID });
    w.p.loginVolumes.set(browserLoginsVolume('gone', ID), { agentContainer: 'gone', agentId: 'gone', logins: ID });
    await browserSweep(w.deps);
    expect(w.p.loginVolumes.size).toBe(3); // kitchen, garden, attic; the deleted agent's is gone
    w.store.setAgentBrowserLogins('kitchen', null);
    w.store.setAgentState('garden', 'ARCHIVED');
    w.store.setAgentBrowser('attic', false);
    await browserSweep(w.deps);
    expect(w.p.loginVolumes.size).toBe(0);
    const why = w.logs.filter(([, e]) => e === 'browser.logins_removed').map(([a, , d]) => `${a ?? '-'}:${d.why}`).sort();
    expect(why).toEqual(['-:agent gone', 'attic:browser off', 'garden:archived', 'kitchen:switched off']);
    // Moved to another machine: this one's copy goes.
    w.store.setAgentBrowserLogins('kitchen', ID2);
    await browserSweep(w.deps);
    w.store.setAgentHost('kitchen', 'h2');
    await browserSweep(w.deps);
    expect(w.p.loginVolumes.size).toBe(0);
    // A browser still on it (Docker refuses): kept, and removed once it is free.
    const v = world();
    v.store.setAgentBrowserLogins('kitchen', ID);
    await browserSweep(v.deps);
    expect(await v.p.removeBrowserLogins(browserLoginsVolume('kitchen', ID))).toBe(false);
  });

  it('a profile past 500 MB is said in its timeline, once a day, measured hourly', async () => {
    const w = world();
    let now = 1_000_000;
    const deps = { ...w.deps, now: () => now };
    w.store.setAgentBrowserLogins('kitchen', ID);
    w.p.profileBytes.set('kitchen', 600 * 1024 * 1024);
    await browserSweep(deps);
    await browserSweep(deps);
    now += 3600_000;
    await browserSweep(deps);
    expect(w.logs.filter(([, e]) => e === 'browser.profile_large')).toEqual([['kitchen', 'browser.profile_large', { mb: 600 }]]);
    now += 24 * 3600_000;
    await browserSweep(deps);
    expect(w.logs.filter(([, e]) => e === 'browser.profile_large')).toHaveLength(2);
  });

  it('the browser switched off forgets its logins in the store too: on again, it keeps none', () => {
    const w = world();
    w.store.setAgentBrowserLogins('kitchen', ID);
    w.store.noteAgentBrowserSite('kitchen', ID, 'example.org');
    expect(w.store.getAgent('kitchen')).toMatchObject({ browserLogins: ID, browserSites: [{ site: 'example.org' }] });
    w.store.setAgentBrowser('kitchen', false);
    w.store.setAgentBrowser('kitchen', true);
    expect(w.store.getAgent('kitchen')!.browserLogins).toBeUndefined();
    expect(w.store.getAgent('kitchen')!.browserSites).toBeUndefined();
  });

  it('sites: newest first, one line each, at most 30; never into a profile that is not its own now', () => {
    const w = world();
    w.store.setAgentBrowserLogins('kitchen', ID);
    for (let i = 0; i < 35; i++) w.store.noteAgentBrowserSite('kitchen', ID, `site${i}.example.org`);
    w.store.noteAgentBrowserSite('kitchen', ID, 'site3.example.org');
    const sites = w.store.getAgent('kitchen')!.browserSites!;
    expect(sites).toHaveLength(30);
    expect(sites[0]!.site).toBe('site3.example.org');
    expect(sites.filter((s) => s.site === 'site3.example.org')).toHaveLength(1);
    w.store.noteAgentBrowserSite('kitchen', ID2, 'elsewhere.example.org');
    expect(w.store.getAgent('kitchen')!.browserSites![0]!.site).toBe('site3.example.org');
    // A new profile starts with none.
    w.store.setAgentBrowserLogins('kitchen', ID2);
    expect(w.store.getAgent('kitchen')!.browserSites).toBeUndefined();
  });
});

describe('who can steer it, named before its logins are kept', () => {
  it('people by how they reach it, its open group, the agents that may consult it, people let in inside OpenClaw', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { members: [{ userId: 'u-sam', displayName: 'Sam', channelUserId: '222' }, { userId: 'u-robin', displayName: 'Robin' }] });
    await seedRunningAgent(w, { id: 'a2', name: 'Garden', slug: 'garden', accountId: 'gardenbot' });
    await seedRunningAgent(w, { id: 'a3', name: 'Attic', slug: 'attic', accountId: 'atticbot' });
    w.store.setAgentPeers('a2', ['a1'], ['a1']);
    w.store.setAgentPeers('a3', ['a1']);
    w.store.setAgentGroupAccess('a1', { mode: 'room', roomId: '-100123' });
    expect(browserSteerers(w.store, w.store.getAgent('a1')!)).toEqual([
      'Robin (invited, not linked yet)',
      'Sam (Telegram)',
      'everyone in its Telegram group',
      'the agent Garden (may ask it to act)',
      'the agent Attic (may ask it questions)',
    ]);
    expect(browserSteerers(w.store, w.store.getAgent('a2')!)).toEqual([]);
  });
});

describe('the routes', () => {
  async function ready(): Promise<World> {
    const w = await makeWorld();
    await seedRunningAgent(w, { members: [{ userId: 'u-sam', displayName: 'Sam', channelUserId: '222' }] });
    w.store.setAgentBrowser('a1', true);
    w.provider.browsers.set('a1', true);
    return w;
  }
  const put = (w: World, keep: unknown, who?: string) => w.f.inject({ method: 'PUT', url: '/v1/agents/a1/browser/logins', headers: as(who), payload: { keep } });
  const forget = (w: World, who?: string) => w.f.inject({ method: 'DELETE', url: '/v1/agents/a1/browser/logins', headers: as(who) });
  const get = async (w: World) => (await w.f.inject({ method: 'GET', url: '/v1/agents/a1/browser', headers: as() })).json() as Record<string, any>;

  it('switched on: a new profile, its browser started on it; the page is told who can steer it', async () => {
    const w = await ready();
    expect((await get(w))).toMatchObject({ on: true, keepsLogins: false, sites: [], steeredBy: ['Sam (Telegram)'] });
    const r = await put(w, true);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ keepsLogins: true, done: true });
    expect(r.json().message).toMatch(/starts again, empty/);
    const id = w.store.getAgent('a1')!.browserLogins!;
    expect(id).toMatch(BROWSER_LOGINS_RE);
    expect(w.provider.browserLoginsOf.get('a1')).toBe(id);
    expect(await get(w)).toMatchObject({ keepsLogins: true, profileMB: 31 });
    expect(w.store.listEvents(['a1'], 50).map((e) => e.event)).toContain('browser.logins_kept');
    // Again: nothing changes.
    expect((await put(w, true)).json()).toMatchObject({ keepsLogins: true, message: 'It already keeps its logins.' });
    expect(w.store.getAgent('a1')!.browserLogins).toBe(id);
    // The agent list says whether, never its profile or the sites.
    const list = (await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as() })).json() as Array<Record<string, unknown>>;
    const a1 = list.find((a) => a.id === 'a1')!;
    expect(a1.keepsLogins).toBe(true);
    expect(a1.browserLogins).toBeUndefined();
    expect(a1.browserSites).toBeUndefined();
  });

  it('forget: a new, empty profile, the old one deleted, its sites gone; switched off: none at all', async () => {
    const w = await ready();
    expect((await forget(w)).statusCode).toBe(409);
    await put(w, true);
    const first = w.store.getAgent('a1')!.browserLogins!;
    w.store.noteAgentBrowserSite('a1', first, 'example.org');
    const f = await forget(w);
    expect(f.statusCode, f.body).toBe(200);
    expect(f.json().message).toMatch(/^Forgotten\. /);
    const second = w.store.getAgent('a1')!.browserLogins!;
    expect(second).not.toBe(first);
    expect(w.provider.browserLoginsOf.get('a1')).toBe(second);
    expect([...w.provider.loginVolumes.keys()]).toEqual([browserLoginsVolume('a1', second)]);
    expect((await get(w)).sites).toEqual([]);
    const off = await put(w, false);
    expect(off.json()).toMatchObject({ keepsLogins: false, done: true });
    expect(w.store.getAgent('a1')!.browserLogins).toBeUndefined();
    expect(w.provider.browserLoginsOf.has('a1')).toBe(false);
    expect(w.provider.loginVolumes.size).toBe(0);
    const events = w.store.listEvents(['a1'], 50).filter((e) => e.event === 'browser.logins_forgotten').map((e) => (e.detail as { why?: string })?.why);
    expect(events.sort()).toEqual(['forget', 'switched off']);
  });

  it('a machine that does not answer: forgotten all the same, and said so', async () => {
    const w = await ready();
    await put(w, true);
    w.provider.awake = false;
    const f = await forget(w);
    expect(f.statusCode).toBe(200);
    expect(f.json()).toMatchObject({ done: false });
    expect(f.json().message).toMatch(/^Forgotten: its browser will not use them again\. Its machine has not deleted them yet/);
    // Once it answers, the sweep deletes the old one and starts it on the new.
    w.provider.awake = true;
    await (w.f as unknown as { browsersNow: (only?: string) => Promise<unknown> }).browsersNow?.('a1');
    expect([...w.provider.loginVolumes.keys()]).toEqual([browserLoginsVolume('a1', w.store.getAgent('a1')!.browserLogins!)]);
  });

  it('the owner only; never with the browser off or on the manager; a bad body is refused', async () => {
    const w = await ready();
    expect((await put(w, true, 'someone-else')).statusCode).toBe(404);
    expect((await forget(w, 'someone-else')).statusCode).toBe(404);
    expect((await put(w, 'yes')).statusCode).toBe(400);
    w.store.setAgentBrowser('a1', false);
    expect((await put(w, true)).statusCode).toBe(409);
    expect(w.store.getAgent('a1')!.browserLogins).toBeUndefined();
  });

  it('a sign-in panel open while it keeps logins lists the sites its page reaches; a change of profile closes it', async () => {
    const w = await ready();
    await put(w, true);
    const open = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/browser/panel', headers: as(), payload: { w: 1000, h: 700 } });
    expect(open.statusCode, open.body).toBe(201);
    const relay = w.provider.panelRelays.at(-1)!;
    relay.emit({ method: 'Page.frameNavigated', params: { frame: { id: 'F1', url: 'https://accounts.example.org/sign-in?next=%2Fhome' } } });
    relay.emit({ method: 'Page.frameNavigated', params: { frame: { id: 'F2', parentId: 'F1', url: 'https://ads.example.net/' } } });
    relay.emit({ method: 'Page.navigatedWithinDocument', params: { frameId: 'F1', url: 'https://accounts.example.org/done' } });
    relay.emit({ method: 'Page.frameNavigated', params: { frame: { id: 'F1', url: 'about:blank' } } });
    expect((await get(w)).sites.map((x: { site: string }) => x.site)).toEqual(['accounts.example.org']);
    await forget(w);
    expect(relay.closed).toBe(true);
    expect(w.store.listEvents(['a1'], 50).find((e) => e.event === 'browser.panel_closed')?.detail).toMatchObject({ why: 'restarted' });
  });
});
