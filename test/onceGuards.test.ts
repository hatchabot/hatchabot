import { mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeWorld, as } from './support/world.js';

/**
 * Add, clicked twice before the first answer (or a request retried while
 * the first still runs), made two rows: two runners, two AI sources, two
 * guest keys of which the one shown might already be dead (HB-0062).
 */

// POST /v1/hosts prepares the runner SSH key/config: keep it off the real ~/.ssh.
// The memory service keeps its guests beside the database: a temp one, not the checkout's data/.
beforeAll(() => {
  process.env.HATCHABOT_SSH_DIR = mkdtempSync(join(tmpdir(), 'hb-once-ssh-'));
  process.env.HATCHABOT_DB = join(mkdtempSync(join(tmpdir(), 'hb-once-data-')), 'hatchabot.sqlite');
  // A tcp:// runner needs this machine's client certificate (HB-0029): made-up files.
  const certs = mkdtempSync(join(tmpdir(), 'hb-once-certs-'));
  for (const f of ['ca.pem', 'cert.pem', 'key.pem']) writeFileSync(join(certs, f), 'made-up\n');
  process.env.DOCKER_CERT_PATH = certs;
});

/** Not a key of any kind: the route stores whatever it is given. */
const MADE_UP = 'kitchen-' + 'drawer';

/** A gate a stubbed step waits at, and a promise for when the first request reached it. */
function gate() {
  let open!: () => void, reached!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const entered = new Promise<void>((r) => { reached = r; });
  return { open, entered, wait: async () => { reached(); await opened; } };
}

describe('Add, clicked twice, adds one (HB-0062)', () => {
  it('a runner', async () => {
    const w = await makeWorld();
    const add = () => w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'Garage box', dockerHost: 'tcp://127.0.0.1:1' } });
    const [a, b] = await Promise.all([add(), add()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect((a.statusCode === 409 ? a : b).json().error).toMatch(/already being added/);
    expect(w.store.listHosts(w.owner).filter((h) => h.name === 'Garage box')).toHaveLength(1);
    // Once answered, the endpoint is free again, for a runner not already added (HB-0435).
    const another = await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'Shed box', dockerHost: 'tcp://127.0.0.1:2' } });
    expect(another.statusCode).toBe(201);
  });

  it('an AI source', async () => {
    const w = await makeWorld();
    const g = gate();
    const put = w.secrets.put.bind(w.secrets);
    w.secrets.put = async (r: string, v: string) => { if (r.startsWith('ai-profile/')) await g.wait(); return put(r, v); };
    const add = () => w.f.inject({ method: 'POST', url: '/v1/ai-profiles', headers: as(), payload: { name: 'Kitchen key', vendor: 'anthropic', kind: 'api_key', model: 'claude-haiku-4-5', apiKey: MADE_UP } });
    const first = add();
    await g.entered;
    const second = await add();
    expect(second.statusCode).toBe(409);
    g.open();
    expect((await first).statusCode).toBe(201);
    expect(w.store.listAIProfiles(w.owner).filter((p) => p.name === 'Kitchen key')).toHaveLength(1);
  });

  it('held while its request still works, however long that takes (HB-0630)', async () => {
    const w = await makeWorld();
    const g = gate();
    const put = w.secrets.put.bind(w.secrets);
    let puts = 0;
    w.secrets.put = async (r: string, v: string) => { if (r.startsWith('ai-profile/') && puts++ === 0) await g.wait(); return put(r, v); };
    const add = () => w.f.inject({ method: 'POST', url: '/v1/ai-profiles', headers: as(), payload: { name: 'Kitchen key', vendor: 'anthropic', kind: 'api_key', model: 'claude-haiku-4-5', apiKey: MADE_UP } });
    const first = add();
    await g.entered;
    // Eleven minutes on, the first still at work: its hold was let go at ten.
    const later = Date.now() + 11 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => later);
    try {
      const second = await add();
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe('Kitchen key is already being added.');
    } finally { clock.mockRestore(); }
    g.open();
    expect((await first).statusCode).toBe(201);
    expect(w.store.listAIProfiles(w.owner).filter((p) => p.name === 'Kitchen key')).toHaveLength(1);
  });

  it('a caller that hung up: its hold goes when its request has answered, not ten minutes later (HB-0630)', async () => {
    const w = await makeWorld();
    const g = gate();
    const put = w.secrets.put.bind(w.secrets);
    let puts = 0;
    w.secrets.put = async (r: string, v: string) => { if (r.startsWith('ai-profile/') && puts++ === 0) await g.wait(); return put(r, v); };
    await w.f.listen({ port: 0, host: '127.0.0.1' });
    try {
      const { port } = w.f.server.address() as AddressInfo;
      const body = JSON.stringify({ name: 'Kitchen key', vendor: 'anthropic', kind: 'api_key', model: 'claude-haiku-4-5', apiKey: MADE_UP });
      const call = request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/ai-profiles', headers: { ...as(), 'content-type': 'application/json' } });
      const hungUp = new Promise<void>((r) => { call.on('error', () => r()); call.on('close', () => r()); });
      call.end(body);
      await g.entered;
      // The caller goes away while its request still works (a tab closed, a fetch timed out).
      call.destroy();
      await hungUp;
      // Still at work: still held.
      const meanwhile = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles', headers: as(), payload: JSON.parse(body) });
      expect(meanwhile.json().error).toBe('Kitchen key is already being added.');
      g.open();
      await vi.waitFor(() => expect(w.store.listAIProfiles(w.owner).filter((p) => p.name === 'Kitchen key')).toHaveLength(1));
      // Its request has answered, to nobody: the name is free again, at once.
      await vi.waitFor(async () => {
        const again = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles', headers: as(), payload: { ...JSON.parse(body), name: 'Kitchen key' } });
        expect(again.json().error).not.toBe('Kitchen key is already being added.');
      }, { timeout: 2000, interval: 20 });
    } finally { await w.f.close(); }
  });

  it('a memory-service guest key', async () => {
    const w = await makeWorld();
    const g = gate();
    (w.provider as unknown as { hostAddressForAgents: () => Promise<string> }).hostAddressForAgents = async () => { await g.wait(); return '10.0.2.2'; };
    const add = () => w.f.inject({ method: 'POST', url: '/v1/embedder/guests', headers: as(), payload: { name: 'garage' } });
    const first = add();
    await g.entered;
    const second = await add();
    expect(second.statusCode).toBe(409);
    g.open();
    expect((await first).statusCode).toBe(201);
  });
});
