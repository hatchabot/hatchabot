import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
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
    // Once answered, the endpoint is free again.
    expect((await add()).statusCode).toBe(201);
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
