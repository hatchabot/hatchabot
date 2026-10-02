import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHIM_DNS, tailscaleShim } from './helpers/tailscaleShim.js';
import { changing, closeAfterEach, ctx, envNow, world } from './helpers/publicWorld.js';
import { publicAccessFacts, publicAccessLines } from '../src/doctor.js';
import { publicIntentPath, readPublicIntent, writePublicIntent } from '../src/ops/publicIntent.js';
import { funnelOff, parseFunnelStatus } from '../src/ops/tailnet.js';

/**
 * A crash between turning Funnel on and writing the setting must not leave a
 * Funnel entry on a closed port: "on" writes a note first, and the next start
 * (and `hatchabot reach status`, and the doctor) takes back whatever a switch
 * that died left behind (docs/public-access.md, "A crash while switching").
 */
closeAfterEach();

// ---- B4. a crash while switching -----------------------------------------------

describe('a crash while public access is being turned on is taken back at the next start', () => {
  const funnelEntry = (port: number) => ({
    TCP: { 8443: { HTTPS: true } }, Web: { [`${SHIM_DNS}:8443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } }, AllowFunnel: { [`${SHIM_DNS}:8443`]: true },
  });

  it('"on" writes its note before it changes anything, and removes it when it has finished', async () => {
    const w = await world();
    const marker = publicIntentPath(w.envFile);
    // A tailscale that says, each time Funnel is turned on, whether the note was already there.
    const saw = join(w.dir, 'saw-the-note');
    const real = join(w.shim.dir, 'tailscale');
    const wrapper = join(w.shim.dir, 'tailscale-wrapper');
    writeFileSync(wrapper, `#!/usr/bin/env node\nconst fs = require('fs');\nif (process.argv[2] === 'funnel' && process.argv.includes('--bg')) fs.writeFileSync(${JSON.stringify(saw)}, String(fs.existsSync(${JSON.stringify(marker)})));\nrequire(${JSON.stringify(real)});\n`);
    chmodSync(wrapper, 0o755);
    process.env.HATCHABOT_TAILSCALE_BIN = wrapper;
    expect(existsSync(marker)).toBe(false);
    const r = await w.call('POST', '/v1/public-access/on', { confirm: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(readFileSync(saw, 'utf8')).toBe('true');
    expect(existsSync(marker)).toBe(false);
    // A refusal before anything is changed leaves no note either.
    await w.call('POST', '/v1/public-access/off', {});
    w.shim.failFunnel('Funnel is not enabled on your tailnet.');
    expect((await w.call('POST', '/v1/public-access/on', { confirm: true })).statusCode).toBe(409);
    expect(existsSync(marker)).toBe(false);
    expect(w.shim.config().AllowFunnel ?? {}).toEqual({});
  }, 60_000);

  it('a step that throws is undone like a step that fails', async () => {
    const w = await world();
    const real = w.h.store.recordSecurity.bind(w.h.store);
    w.h.store.recordSecurity = (kind: string, ...rest: [string | undefined, Record<string, unknown>?]) => { if (kind === 'public.on') throw new Error('the disk is full'); return real(kind, ...rest); };
    const r = await w.call('POST', '/v1/public-access/on', { confirm: true });
    expect(r.statusCode).toBe(500);
    expect(w.shim.config().AllowFunnel ?? {}).toEqual({});
    expect(envNow(w.envFile).get('HATCHABOT_PUBLIC_ACCESS')).toBeUndefined();
    expect(w.h.app.publicAccess!.status()).toMatchObject({ on: false, listening: false });
    expect(existsSync(publicIntentPath(w.envFile))).toBe(false);
    // …and it can be turned on afterwards.
    w.h.store.recordSecurity = real;
    expect((await w.call('POST', '/v1/public-access/on', { confirm: true })).statusCode).toBe(200);
  }, 60_000);

  /**
   * Each point "on" can die at, as the files it leaves: the note is always
   * there (it is written first and removed last); Funnel's entry and the two
   * lines of .env are there or not. A new process then starts on those files.
   */
  const crashPoints: Array<[string, { funnel: boolean; access: boolean; url: boolean }]> = [
    ['after the note, before the listener or Funnel', { funnel: false, access: false, url: false }],
    ['after Funnel was turned on, before the setting was written', { funnel: true, access: false, url: false }],
    ['after the setting, before the address', { funnel: true, access: true, url: false }],
    ['after the address, before the last check', { funnel: true, access: true, url: true }],
  ];
  for (const [name, left] of crashPoints) {
    it(`died ${name}: the next start turns everything back off`, async () => {
      // The process that died (it is only its files that matter).
      const shim = tailscaleShim();
      const dir = mkdtempSync(join(tmpdir(), 'hb-crash-'));
      ctx.cleanups.push(() => { shim.cleanup(); rmSync(dir, { recursive: true, force: true }); });
      const envFile = join(dir, '.env');
      writeFileSync(envFile, `HATCHABOT_AUTH=accounts\nHATCHABOT_SECRET_KEY=x\n${left.access ? 'HATCHABOT_PUBLIC_ACCESS=funnel\n' : ''}${left.url ? `HATCHABOT_PUBLIC_ACCESS_URL=https://${SHIM_DNS}:8443\n` : ''}`);
      // The process that starts next reads the .env it finds (as the service does).
      const env: Record<string, string> = {};
      if (left.access) env.HATCHABOT_PUBLIC_ACCESS = 'funnel';
      if (left.url) env.HATCHABOT_PUBLIC_ACCESS_URL = `https://${SHIM_DNS}:8443`;
      const w = await world(env, { reuse: { shim, dir } });
      // (world() chose its own port; the note and Funnel's entry name the port the dead process used.)
      const deadPort = w.h.port;
      writePublicIntent({ port: deadPort, funnelPort: 8443 }, envFile);
      if (left.funnel) shim.setConfig(funnelEntry(deadPort));
      expect(w.h.app.publicAccess!.config().on).toBe(left.access);

      // index.ts, at start, before the listener is opened:
      const rec = await w.h.app.publicAccessRecover!('startup');
      expect(rec).toEqual({ rolledBack: true });
      expect(shim.config().AllowFunnel ?? {}).toEqual({});
      expect(changing(shim)).toEqual(left.funnel ? ['funnel --https=8443 off'] : []);
      expect(envNow(envFile).get('HATCHABOT_PUBLIC_ACCESS')).toBeUndefined();
      expect(envNow(envFile).get('HATCHABOT_PUBLIC_ACCESS_URL')).toBeUndefined();
      expect(w.h.app.publicAccess!.config().on).toBe(false);
      expect(w.h.app.publicAccess!.status()).toMatchObject({ on: false, serving: false, listening: false });
      expect(existsSync(publicIntentPath(envFile))).toBe(false);
      expect(w.h.store.listSecurityLog().find((e) => e.kind === 'public.recovered')).toMatchObject({ detail: { when: 'startup', funnelRemoved: true } });
      // Nothing answers on the public port.
      await expect(fetch(`http://127.0.0.1:${deadPort}/`)).rejects.toThrow();
      // A second start finds nothing to do, and it can be turned on properly.
      expect(await w.h.app.publicAccessRecover!('startup')).toEqual({});
      expect((await w.call('POST', '/v1/public-access/on', { confirm: true })).statusCode).toBe(200);
    }, 60_000);
  }

  it('if Tailscale will not let go of its entry, the note stays and the next start tries again', async () => {
    const w = await world();
    writePublicIntent({ port: w.h.port, funnelPort: 8443 }, w.envFile);
    w.shim.setConfig(funnelEntry(w.h.port));
    w.shim.failOff(true);
    const rec = await w.h.app.publicAccessRecover!('startup');
    expect(rec.rolledBack).toBe(true);
    expect(rec.funnelError).toBeTruthy();
    expect(rec.command).toBe('tailscale funnel --https=8443 off');
    expect(existsSync(publicIntentPath(w.envFile))).toBe(true);
    expect(w.h.app.publicAccess!.status()).toMatchObject({ on: false, listening: false });
    w.shim.failOff(false);
    expect(await w.h.app.publicAccessRecover!('startup')).toEqual({ rolledBack: true });
    expect(w.shim.config().AllowFunnel ?? {}).toEqual({});
    expect(existsSync(publicIntentPath(w.envFile))).toBe(false);
  }, 60_000);

  it('a Funnel entry pointing at the public port while public access is off is removed: at start, and when the owner looks', async () => {
    const w = await world();
    // An "off" that Tailscale refused, or an entry made by hand. And one of the owner's own, for something else: left alone.
    const mine = { TCP: { 10000: { HTTPS: true } }, Web: { [`${SHIM_DNS}:10000`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }, AllowFunnel: { [`${SHIM_DNS}:10000`]: true } };
    const both = (port: number) => { const e = funnelEntry(port); return { TCP: { ...e.TCP, ...mine.TCP }, Web: { ...e.Web, ...mine.Web }, AllowFunnel: { ...e.AllowFunnel, ...mine.AllowFunnel } }; };
    w.shim.setConfig(both(w.h.port));
    expect(await w.h.app.publicAccessRecover!('startup')).toEqual({ leftoverRemoved: true });
    expect(Object.keys(w.shim.config().AllowFunnel ?? {})).toEqual([`${SHIM_DNS}:10000`]);
    expect(w.h.store.listSecurityLog().find((e) => e.kind === 'public.funnel_leftover')).toMatchObject({ detail: { when: 'startup', removed: true } });
    // …and `hatchabot reach status` (GET /v1/public-access) does the same, and says so.
    w.shim.setConfig(both(w.h.port));
    const st = (await w.call('GET', '/v1/public-access')).json();
    expect(st.recovered).toEqual({ leftoverRemoved: true });
    expect(Object.keys(w.shim.config().AllowFunnel ?? {})).toEqual([`${SHIM_DNS}:10000`]);
    // Nothing to find: nothing said, nothing run.
    const before = changing(w.shim).length;
    expect((await w.call('GET', '/v1/public-access')).json().recovered).toBeUndefined();
    expect(changing(w.shim).length).toBe(before);
    // With public access ON the entry is the public address itself: never touched by this.
    expect((await w.call('POST', '/v1/public-access/on', { confirm: true })).statusCode).toBe(200);
    expect(await w.h.app.publicAccessRecover!('status')).toEqual({});
    expect(Object.keys(w.shim.config().AllowFunnel ?? {}).sort()).toEqual([`${SHIM_DNS}:10000`, `${SHIM_DNS}:8443`]);
    expect((await w.h.pub('/v1/config')).status).toBe(200);
  }, 60_000);

  it('the doctor removes a leftover entry too, but never during a switch that is under way; an unfinished switch is a failure it names', async () => {
    const shim = tailscaleShim();
    const dir = mkdtempSync(join(tmpdir(), 'hb-doctor-'));
    ctx.cleanups.push(() => { shim.cleanup(); rmSync(dir, { recursive: true, force: true }); delete process.env.HATCHABOT_TAILSCALE_BIN; });
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'HATCHABOT_AUTH=accounts\n');
    process.env.HATCHABOT_TAILSCALE_BIN = shim.bin;
    const entry = () => shim.setConfig(funnelEntry(8092));
    const facts = (env: Record<string, string> = {}) => publicAccessFacts({ HATCHABOT_AUTH: 'accounts', ...env }, '/nonexistent.sqlite', 8080,
      { autoUpgrade: async () => ({ ok: true }), funnel: async () => parseFunnelStatus(JSON.stringify(shim.config())), funnelOff, envPath });
    // Off, an entry on the public port, no switch under way: removed, and said.
    entry();
    const a = await facts();
    expect(a.leftover).toEqual({ removed: true });
    expect(shim.config().AllowFunnel ?? {}).toEqual({});
    expect(publicAccessLines(a).some((l) => l.level === 'warn' && l.text.includes('has been removed'))).toBe(true);
    // A switch began seconds ago (the app may be in the middle of it): hands off.
    entry();
    writePublicIntent({ port: 8092, funnelPort: 8443 }, envPath);
    const b = await facts();
    expect(b.leftover).toBeUndefined();
    expect(b.pending).toMatchObject({ stale: false });
    expect(Object.keys(shim.config().AllowFunnel ?? {})).toHaveLength(1);
    expect(publicAccessLines(b).some((l) => l.level === 'warn' && l.text.includes('being turned on right now'))).toBe(true);
    // The same note ten minutes old is a switch that died: a failure, with what to do; and the entry goes.
    writeFileSync(publicIntentPath(envPath), JSON.stringify({ at: new Date(Date.now() - 10 * 60_000).toISOString(), port: 8092, funnelPort: 8443, pid: 1 }));
    const c = await facts();
    expect(c.pending).toMatchObject({ stale: true });
    expect(c.leftover).toEqual({ removed: true });
    expect(publicAccessLines(c).find((l) => l.level === 'fail')!.text).toContain('never finished');
    expect(publicAccessLines(c).find((l) => l.level === 'fail')!.fix).toContain('Restart Hatchabot');
    // A note that cannot be read still counts as one (and as stale).
    writeFileSync(publicIntentPath(envPath), 'not json');
    expect(readPublicIntent(envPath)).toEqual({});
    expect((await facts()).pending).toMatchObject({ stale: true });
    // With public access ON, the entry is the public address: the doctor leaves it.
    rmSync(publicIntentPath(envPath));
    entry();
    const d = await facts({ HATCHABOT_PUBLIC_ACCESS: 'funnel' });
    expect(d.leftover).toBeUndefined();
    expect(Object.keys(shim.config().AllowFunnel ?? {})).toHaveLength(1);
    // Tailscale refuses: the doctor says so, with the command.
    shim.failOff(true);
    const e = await facts();
    expect(e.leftover).toMatchObject({ removed: false, command: 'tailscale funnel --https=8443 off' });
    expect(publicAccessLines(e).find((l) => l.text.includes('still points'))).toMatchObject({ level: 'warn', fix: 'tailscale funnel --https=8443 off' });
  }, 60_000);
});

