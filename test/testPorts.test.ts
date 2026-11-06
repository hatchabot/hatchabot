import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';

/**
 * The ports the test helpers choose before a listener opens them (HB-0505):
 * on a busy machine a port handed out by listen(0) and closed again was
 * taken before the app's public listener opened it (EADDRINUSE on CI).
 */
const taken: { port?: number } = {};
vi.mock('./helpers/ports.js', async (orig) => {
  const real = await orig<typeof import('./helpers/ports.js')>();
  // The first port asked for is the one this file is holding open; later ones are real.
  return { ...real, freePort: vi.fn(async () => { const p = taken.port; taken.port = undefined; return p ?? real.freePort(); }) };
});

const { ephemeralRange, freePort: realFreePort, listenOnFreePort, onFreePort, TAKEN } = await vi.importActual<typeof import('./helpers/ports.js')>('./helpers/ports.js');
const { publicApp } = await import('./helpers/publicApp.js');
const { closeAfterEach, ctx, world } = await import('./helpers/publicWorld.js');

const held: Server[] = [];
async function hold(): Promise<number> {
  const s = createServer();
  const port = await realFreePort();
  await new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));
  held.push(s);
  return port;
}
afterEach(async () => { for (const s of held.splice(0)) await new Promise((r) => s.close(r)); taken.port = undefined; });
closeAfterEach();

describe('ports the test helpers choose', () => {
  it('come from outside the kernel\'s ephemeral range, which listen(0) and outgoing connections draw from', async () => {
    const [lo, hi] = ephemeralRange();
    for (let i = 0; i < 20; i++) {
      const p = await realFreePort();
      expect(p < lo || p > hi, `port ${p} is inside ${lo}-${hi}`).toBe(true);
    }
  });

  it('listenOnFreePort chooses again when its port was taken, and closes nothing it did not open', async () => {
    const busy = await hold();
    const chosen = [busy];
    const choose = async () => chosen.shift() ?? realFreePort();
    const srv = createServer((c) => c.end('mine'));
    try {
      const port = await listenOnFreePort(srv, { choose });
      expect(port).not.toBe(busy);
      expect((srv.address() as { port: number }).port).toBe(port);
    } finally { await new Promise((r) => srv.close(r)); }
    // Not a taken port: the error is the caller's.
    const other = createServer();
    await expect(listenOnFreePort(other, { host: '192.0.2.1', choose: async () => 20_500 })).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' });
  });

  it('onFreePort gives up after its tries, naming the ports', async () => {
    let n = 0;
    await expect(onFreePort(async () => TAKEN, { tries: 3, choose: async () => 21_000 + n++ })).rejects.toThrow('21000, 21001, 21002 were each taken first');
  });

  it('the band is clear of the fixed ports of the live tests that share the machine', async () => {
    const { readFileSync } = await import('node:fs');
    const smoke = readFileSync('scripts/smoke-adopt-full.ts', 'utf8');
    const fixed = [...smoke.matchAll(/'(\d{4,5})'/g)].map((m) => Number(m[1])).filter((p) => p >= 1024);
    expect(fixed.length).toBeGreaterThan(0);
    // Below every one of them (the gateways count up from theirs), and above the agents' own gateways (19100 up).
    for (let i = 0; i < 50; i++) { const p = await realFreePort(); expect(p).toBeLessThan(Math.min(...fixed)); expect(p).toBeGreaterThanOrEqual(20_000); }
  });

  it('publicApp chooses again when its port was taken before the listener opened', async () => {
    const busy = await hold();
    taken.port = busy;
    const h = ctx.h = await publicApp();
    expect(h.port).not.toBe(busy);
    expect(h.app.publicAccess!.status().listening).toBe(true);
    expect((await h.pub('/v1/config')).status).toBe(503); // the gate answers on the new port (not serving: no owner yet)
  });

  it('world({ on: true }) chooses again when the switch found its port taken', async () => {
    const busy = await hold();
    taken.port = busy; // world() starts with public access off and turns it on through the route
    const w = await world({}, { on: true });
    expect(w.h.port).not.toBe(busy);
    expect(w.h.app.publicAccess!.status()).toMatchObject({ on: true, listening: true });
    expect((await w.h.pub('/v1/config')).status).toBe(200);
  }, 30_000);
});
