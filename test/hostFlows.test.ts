/**
 * End-to-end coverage of runner-host registration (Cluster mode): adding a
 * remote Docker endpoint as a host, and removing it. The endpoint used here
 * (tcp://127.0.0.1:1) refuses fast, so a runner's knock (a connect on this
 * machine's loopback) finds it down at once.
 *
 * Nothing here runs the real docker, ssh or ssh-keygen (HB-1257): docker and
 * ssh are shims on PATH for the whole file, answering as a runner that is not
 * there (a block below puts its own in front, for one that answers), and the
 * runner key and its ssh config block are fakes.
 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeWorld, seedRunningAgent, as } from './support/world.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { formatBuildInputs } from '../src/orchestrator/machines/buildInputs.js';

const RUNNER = 'tcp://127.0.0.1:1';

// POST /v1/hosts prepares the runner's SSH key and config block first: fakes, so no ssh-keygen runs and no config is written.
vi.mock('../src/orchestrator/machines/runnerSetup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/orchestrator/machines/runnerSetup.js')>()),
  ensureRunnerKey: async () => 'ssh-ed25519 made-up-key-for-the-test',
  ensureSshConfigBlock: async () => {},
}));

/** docker and ssh for the whole file: every call is noted, and none reaches a daemon or a machine. */
const shims = mkdtempSync(join(tmpdir(), 'acl-hostflows-bin-'));
const SHIM_CALLS = join(shims, 'calls.log');
writeFileSync(join(shims, 'docker'), `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> ${JSON.stringify(SHIM_CALLS)}
echo "Cannot connect to the Docker daemon at the test's runner. Is the docker daemon running?" >&2
exit 1
`, { mode: 0o755 });
writeFileSync(join(shims, 'ssh'), `#!/usr/bin/env bash
printf 'ssh %s\\n' "$*" >> ${JSON.stringify(SHIM_CALLS)}
echo 'ssh: connect to the test runner: Connection refused' >&2
exit 255
`, { mode: 0o755 });
const shimCalls = () => (existsSync(SHIM_CALLS) ? readFileSync(SHIM_CALLS, 'utf8').split('\n').filter(Boolean) : []);
let pathBefore: string | undefined;
beforeAll(() => {
  pathBefore = process.env.PATH;
  process.env.PATH = `${shims}:${pathBefore}`;
  process.env.HATCHABOT_SSH_DIR = mkdtempSync(join(tmpdir(), 'acl-hostflows-ssh-'));
  // A tcp:// runner is TLS only (HB-0029): made-up client certificate files for it.
  const certs = mkdtempSync(join(tmpdir(), 'acl-hostflows-certs-'));
  for (const f of ['ca.pem', 'cert.pem', 'key.pem']) writeFileSync(join(certs, f), 'made-up\n');
  process.env.DOCKER_CERT_PATH = certs;
});
afterAll(() => { process.env.PATH = pathBefore; });

describe('Runner hosts — POST /v1/hosts', () => {
  it('registers a runner and lists it (host owner)', async () => {
    const w = await makeWorld();
    const res = await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'Runner 1', dockerHost: RUNNER } });
    expect(res.statusCode).toBe(201);
    const host = res.json();
    expect(host).toMatchObject({ kind: 'cloud', provider: 'remote-docker', name: 'Runner 1' });
    expect(host.settings.dockerHost).toBe(RUNNER);
    // best-effort ping ran and reported the endpoint unreachable — but it saved
    expect(host.reachable).toBe(false);

    const list = (await w.f.inject({ method: 'GET', url: '/v1/hosts', headers: as() })).json();
    expect(list.some((h: any) => h.id === host.id)).toBe(true);
  });

  it('refuses a tcp:// runner this machine has no TLS client certificate for (HB-0029)', async () => {
    const w = await makeWorld();
    const had = process.env.DOCKER_CERT_PATH;
    process.env.DOCKER_CERT_PATH = mkdtempSync(join(tmpdir(), 'acl-hostflows-nocerts-'));
    try {
      const res = await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'Plain', dockerHost: RUNNER } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/TLS only.*ca\.pem, cert\.pem, key\.pem/);
      expect(w.store.listHosts(w.owner).some((h) => h.name === 'Plain')).toBe(false);
    } finally { process.env.DOCKER_CERT_PATH = had; }
  });

  it('refuses a non-host-owner (403) and a bad endpoint scheme (400)', async () => {
    const w = await makeWorld();
    expect((await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as('intruder'), payload: { name: 'x', dockerHost: RUNNER } })).statusCode).toBe(403);
    expect((await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'x', dockerHost: 'http://nope' } })).statusCode).toBe(400);
  });
});

describe('Runner hosts — GET /v1/hosts for a member (HB-0059)', () => {
  it('lists the member this machine without its settings, and never the owner\'s runner', async () => {
    const w = await makeWorld();
    w.store.insertHost({ id: 'h-local', ownerId: w.owner, kind: 'local', provider: 'mock', name: 'This machine', settings: { note: 'the owner\'s' }, createdAt: 'now' } as never);
    const runner = (await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'Runner 1', dockerHost: RUNNER } })).json();
    const owner = (await w.f.inject({ method: 'GET', url: '/v1/hosts', headers: as() })).json();
    expect(owner.find((h: any) => h.id === runner.id).settings.dockerHost).toBe(RUNNER);
    const member = (await w.f.inject({ method: 'GET', url: '/v1/hosts', headers: as('member') })).json();
    expect(member.some((h: any) => h.id === runner.id)).toBe(false);
    const local = member.find((h: any) => h.id === 'h-local');
    expect(local).toBeTruthy();
    expect(local.settings).toBeUndefined();
    expect(JSON.stringify(member)).not.toContain(RUNNER);
  });
});

describe('Runner hosts: an address that can sign in, and one row a machine (HB-0435, HB-0436)', () => {
  it('refuses an ssh:// address the key block cannot be written for, and saves nothing', async () => {
    const w = await makeWorld();
    for (const dockerHost of ['ssh://someone@[fd7a:115c::1]', 'ssh://[fd7a:115c::1]:22', 'ssh://a@b@c', 'ssh://someone@box/some/path']) {
      const r = await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'R', dockerHost } });
      expect(r.statusCode, dockerHost).toBe(400);
      expect(r.json().error).toMatch(/hostname or an IPv4 address/);
    }
    expect(w.store.listHosts(w.owner).filter((h) => h.kind !== 'local')).toEqual([]);
  });

  it('refuses the same address again, naming the row, however it is written', async () => {
    const w = await makeWorld();
    expect((await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'First', dockerHost: RUNNER } })).statusCode).toBe(201);
    const again = await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'Second', dockerHost: `${RUNNER}/` } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('already added, as "First"');
    expect(w.store.listHosts(w.owner).filter((h) => h.kind !== 'local')).toHaveLength(1);
  });

  describe('another address for a machine that answers', () => {
    // docker is a shim on PATH, whose answer says whose daemon each is, and a listener here is
    // the machine that answers (the provider knocks before it asks docker anything).
    const bin = mkdtempSync(join(tmpdir(), 'acl-hostflows-docker-'));
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
args="$*"
# A runner signed in to as "slow" takes its time to answer.
case "$args" in *slow@*) sleep 0.5 ;; esac
case "$args" in
  *" version "*) echo 27.0 ;;
  *" image inspect "*) echo ok ;;
  *" info --format "*) case "$args" in *other*) echo id-other ;; *) echo id-studio ;; esac ;;
esac
`, { mode: 0o755 });
    // The knock asks ssh where it connects (ssh -G, HB-1057): a shim, not the
    // real ssh reading the real ~/.ssh/config. No config here: where the address says.
    writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bash
[ "$1" = -G ] || exit 255
shift; port=22
[ "$1" = -p ] && { port=$2; shift 2; }
printf 'hostname %s\\nport %s\\n' "\${1#*@}" "$port"
`, { mode: 0o755 });
    // PATH as it is when the block starts (the file's shims on it), not as it was when the file was read.
    let path: string | undefined;
    const door = createServer((c) => c.destroy());
    const at = (who: string, host = '127.0.0.1') => `ssh://${who}@${host}:${(door.address() as AddressInfo).port}`;
    beforeAll(async () => { path = process.env.PATH; process.env.PATH = `${bin}:${path}`; await new Promise<void>((r) => door.listen(0, '127.0.0.1', r)); });
    afterAll(async () => { process.env.PATH = path; await new Promise((r) => door.close(r)); });
    const add = (w: Awaited<ReturnType<typeof makeWorld>>, name: string, dockerHost: string) => w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name, dockerHost } });

    it('the second is saved and warned about', async () => {
      const w = await makeWorld();
      const a = await add(w, 'Studio', at('sam'));
      expect(a.statusCode, a.body).toBe(201);
      expect(a.json().reachable).toBe(true);
      expect(a.json().warning).toBeUndefined();
      const b = await add(w, 'Studio tail', at('sam', 'localhost'));
      expect(b.statusCode).toBe(201);
      expect(b.json().warning).toContain('the same Docker as "Studio"');
    });
    it('the same address written two ways, added at once, is added once (HB-1119)', async () => {
      const w = await makeWorld();
      const both = await Promise.all([add(w, 'Slow', at('slow')), add(w, 'Slow again', `${at('slow')}/`)]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(both.find((r) => r.statusCode === 409)!.json().error).toBe('That machine is already being added.');
      expect(w.store.listHosts(w.owner).filter((h) => h.kind !== 'local')).toHaveLength(1);
    });
    it('a different machine is not', async () => {
      const w = await makeWorld();
      expect((await add(w, 'Studio', at('sam'))).json().warning).toBeUndefined();
      expect((await add(w, 'Other', at('other'))).json().warning).toBeUndefined();
    });
  });
});

describe('Runner hosts — DELETE /v1/hosts/:id', () => {
  it('removes an empty runner but protects the local host and non-empty runners', async () => {
    const w = await makeWorld();
    const runner = (await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'R', dockerHost: RUNNER } })).json();

    // the local host can't be deleted
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/hosts/h1', headers: as() })).statusCode).toBe(400);

    // a runner with an agent on it is refused
    w.store.insertAgent({ id: 'a1', ownerId: w.owner, name: 'A', slug: 'a', state: 'RUNNING', aiProfileId: 'p1', hostId: runner.id, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const busy = await w.f.inject({ method: 'DELETE', url: `/v1/hosts/${runner.id}`, headers: as() });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatch(/still run/);

    // once empty, it deletes
    w.store.setAgentState('a1', 'STOPPED');
    w.store.setAgentState('a1', 'DELETING');
    w.store.setAgentState('a1', 'DELETED');
    const gone = await w.f.inject({ method: 'DELETE', url: `/v1/hosts/${runner.id}`, headers: as() });
    expect(gone.statusCode).toBe(200);
    expect(w.store.getHost(runner.id)).toBeUndefined();
  });

  it('is refused to a non-host-owner (403)', async () => {
    const w = await makeWorld();
    const runner = (await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'R', dockerHost: RUNNER } })).json();
    expect((await w.f.inject({ method: 'DELETE', url: `/v1/hosts/${runner.id}`, headers: as('intruder') })).statusCode).toBe(403);
  });
});

describe('Admin listing — GET /v1/agents?all=1', () => {
  it('shows the host owner every user\'s agents with ownerId; others get 403', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a-mine', slug: 'mine', accountId: 'minebot' });
    await seedRunningAgent(w, { id: 'a-theirs', slug: 'theirs', owner: 'someone-else', accountId: 'theirbot' });

    // Plain list: ownership-scoped, as ever.
    const mine = (await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as() })).json();
    expect(mine.map((a: any) => a.id)).toEqual(['a-mine']);

    // ?all=1 for the host owner: both, each naming its owner.
    const all = (await w.f.inject({ method: 'GET', url: '/v1/agents?all=1', headers: as() })).json();
    expect(all.map((a: any) => [a.id, a.ownerId]).sort()).toEqual([
      ['a-mine', w.owner], ['a-theirs', 'someone-else'],
    ]);

    // Not the host owner: refused outright.
    expect((await w.f.inject({ method: 'GET', url: '/v1/agents?all=1', headers: as('someone-else') })).statusCode).toBe(403);
  });
});

describe('Runtime capabilities — GET /v1/runtime/capabilities', () => {
  it('is host-owner only (the probe spins a container)', async () => {
    const w = await makeWorld();
    expect((await w.f.inject({ method: 'GET', url: '/v1/runtime/capabilities', headers: as('intruder') })).statusCode).toBe(403);
  });
});

describe('Ping — GET /v1/hosts/:id/ping', () => {
  it('returns the UI shape {reachable, serverVersion, error}, not pingRunner raw {ok, version}', async () => {
    const w = await makeWorld();
    const runner = (await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'R', dockerHost: RUNNER } })).json();

    const pinged = shimCalls().length;
    const res = await w.f.inject({ method: 'GET', url: `/v1/hosts/${runner.id}/ping`, headers: as() });
    expect(res.statusCode).toBe(200);
    // The probe ran, against the shim: docker version, at the runner's address.
    expect(shimCalls().slice(pinged)).toEqual([`docker -H ${RUNNER} --tlsverify version --format {{.Server.Version}}`]);
    const body = res.json();
    // The UI reads `reachable`; the raw pingRunner `ok` field would render every
    // probe — success included — as "unreachable — no response". Regression guard.
    expect(body).toHaveProperty('reachable');
    expect(body.ok).toBeUndefined();
    expect(body.reachable).toBe(false); // tcp://127.0.0.1:1 refuses fast

    // The local host answers with the sentinel the UI expects.
    const local = (await w.f.inject({ method: 'GET', url: '/v1/hosts/h1/ping', headers: as() })).json();
    expect(local).toMatchObject({ reachable: true, serverVersion: 'local' });
  });
});

describe('Create — Claude Max on a runner', () => {
  it('refuses a machine-login subscription but allows a setup-token one', async () => {
    const w = await makeWorld();
    const runner = (await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'R', dockerHost: RUNNER } })).json();

    // Machine-login subscription (no secretRef) mounts THIS box's ~/.claude,
    // which a remote runner can't see — refused up front, not at provision.
    w.store.insertAIProfile({ id: 'sub-ml', ownerId: w.owner, name: 'Max (login)', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: undefined, createdAt: 'now' });
    const ml = await w.f.inject({ method: 'POST', url: '/v1/agents', headers: as(), payload: { name: 'ml', aiProfileId: 'sub-ml', hostId: runner.id } });
    expect(ml.statusCode).toBe(400);
    expect(ml.json().error).toMatch(/setup-token/);

    // Setup-token subscription (secretRef present) is injected as data — it
    // rides to any host, so Claude Max is allowed on the runner.
    w.store.insertAIProfile({ id: 'sub-tok', ownerId: w.owner, name: 'Max (token)', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: 'ai/tok', createdAt: 'now' });
    const tok = await w.f.inject({ method: 'POST', url: '/v1/agents', headers: as(), payload: { name: 'tok', aiProfileId: 'sub-tok', hostId: runner.id } });
    expect(tok.statusCode).toBe(202);
  });
});

describe('Move — POST /v1/agents/:id/move-host', () => {
  // A second mock-backed host on a DISTINCT provider instance, so it reads as
  // a genuinely different daemon (the move's daemon-id guard refuses a move
  // between two rows that resolve to the same daemon).
  const addMockHost = (w: Awaited<ReturnType<typeof makeWorld>>) => {
    w.providers.set('mock2', new MockProvider());
    w.store.insertHost({
      id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Runner Two',
      settings: {}, createdAt: 'now',
    });
  };

  it('moves an agent to another host and back', async () => {
    const w = await makeWorld();
    addMockHost(w);
    const id = await seedRunningAgent(w);

    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hostId: 'h2', state: 'RUNNING' });

    const back = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h1' } });
    expect(back.statusCode).toBe(200);
    expect(w.store.getAgent(id)!.hostId).toBe('h1');
  });

  it('refuses the current host, an unknown host, and a non-owner', async () => {
    const w = await makeWorld();
    addMockHost(w);
    const id = await seedRunningAgent(w);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h1' } })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'nope' } })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as('intruder'), payload: { hostId: 'h2' } })).statusCode).toBe(404);
  });

  it('refuses a machine-login Max agent onto a non-local host; allows setup-token', async () => {
    const w = await makeWorld();
    addMockHost(w);
    const id = await seedRunningAgent(w);

    w.store.insertAIProfile({ id: 'sub-ml', ownerId: w.owner, name: 'Max login', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: undefined, createdAt: 'now' });
    (w.store as any).db.prepare(`UPDATE agents SET ai_profile_id = 'sub-ml' WHERE id = ?`).run(id);
    const ml = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2' } });
    expect(ml.statusCode).toBe(400);
    expect(ml.json().error).toMatch(/setup-token/);

    w.store.insertAIProfile({ id: 'sub-tok', ownerId: w.owner, name: 'Max token', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: 'ai/tok', createdAt: 'now' });
    await w.secrets.put('ai/tok', 'sk-tok');
    (w.store as any).db.prepare(`UPDATE agents SET ai_profile_id = 'sub-tok' WHERE id = ?`).run(id);
    const tok = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2' } });
    expect(tok.statusCode).toBe(200);
    expect(tok.json().hostId).toBe('h2');
  });
});

describe('Drain — POST /v1/hosts/:id/drain', () => {
  it('stops every running agent on a host', async () => {
    const w = await makeWorld(); // h1 uses the mock provider
    await seedRunningAgent(w, { id: 'a1', slug: 'one', accountId: 'onebot' });
    await seedRunningAgent(w, { id: 'a2', slug: 'two', accountId: 'twobot' });
    const res = await w.f.inject({ method: 'POST', url: '/v1/hosts/h1/drain', headers: as(), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stopped: 2, skipped: [] });
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
    expect(w.store.getAgent('a2')!.state).toBe('STOPPED');
  });

  it('is refused to a non-host-owner (403)', async () => {
    const w = await makeWorld();
    expect((await w.f.inject({ method: 'POST', url: '/v1/hosts/h1/drain', headers: as('intruder'), payload: {} })).statusCode).toBe(403);
  });
});


describe('Move — a pinned image the runner does not have (2026-09-22)', () => {
  it('refuses up front with a code, then moves on the default image when asked', async () => {
    const w = await makeWorld();
    const mock2 = new MockProvider();
    w.providers.set('mock2', mock2);
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Laptop', settings: {}, createdAt: 'now' });
    const created = { id: await seedRunningAgent(w) };
    w.store.setAgentImage(created.id, 'hatchabot-runtime:2026.7.1-2-plus-traceroute');
    mock2.tags = [{ tag: 'hatchabot-runtime:latest', imageId: 'x' }] as any;

    const refused = await w.f.inject({ method: 'POST', url: `/v1/agents/${created.id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'pinned_image_missing', image: 'hatchabot-runtime:2026.7.1-2-plus-traceroute' });
    expect(refused.json().error).toMatch(/Laptop does not have/);
    // Nothing stopped: the refusal came before the move began.
    expect(w.store.getAgent(created.id)!.hostId).toBe('h1');

    const moved = await w.f.inject({ method: 'POST', url: `/v1/agents/${created.id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2', dropPin: true } });
    expect(moved.statusCode).toBe(200);
    expect(w.store.getAgent(created.id)!.image ?? null).toBeNull();
    expect(w.store.getAgent(created.id)!.hostId).toBe('h2');
  });
});


describe('Move — the pinned image travels as its recipe (item 5, 2026-09-23)', () => {
  const setup = async (sourceTag: Record<string, unknown>) => {
    const w = await makeWorld();
    const mock2 = new MockProvider();
    w.providers.set('mock2', mock2);
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Laptop', settings: {}, createdAt: 'now' });
    const id = await seedRunningAgent(w);
    const tag = String(sourceTag.tag);
    w.store.setAgentImage(id, tag);
    (w.providers.get('mock') as MockProvider).tags.push(sourceTag as any);
    mock2.tags = [{ tag: 'hatchabot-runtime:latest', imageId: 'x' }] as any;
    const move = (body: Record<string, unknown> = {}) =>
      w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2', ...body } });
    return { w, mock2, id, tag, move };
  };

  it('a base with extra packages is rebuilt there: base pulled, packages layered, same name, pin kept', async () => {
    const { w, mock2, id, tag, move } = await setup({ tag: 'hatchabot-runtime:2026.7.1-2-plus-traceroute', imageId: 'src', openclawVersion: '2026.7.1-2', extraPackages: ['traceroute'] });
    mock2.publishedBases.add('hatchabot-runtime:2026.7.1-2');
    const res = await move();
    expect(res.statusCode).toBe(200);
    expect(mock2.pulled).toEqual(['hatchabot-runtime:2026.7.1-2']);
    expect(mock2.built).toHaveLength(1);
    // Built to a name of its own, then named as the pin once it is seen to run as node on its base (HB-1032).
    expect(mock2.built[0]!.tag).toBe('hatchabot-runtime-check:2026.7.1-2-plus-traceroute');
    expect(mock2.tagged).toEqual([['built-hatchabot-runtime-check:2026.7.1-2-plus-traceroute', tag]]);
    expect(mock2.tags.map((t) => t.tag)).toContain(tag);
    expect(mock2.tags.map((t) => t.tag)).not.toContain('hatchabot-runtime-check:2026.7.1-2-plus-traceroute');
    expect(mock2.built[0]!.dockerfile).toMatch(/^FROM hatchabot-runtime:2026\.7\.1-2\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends traceroute/);
    expect(mock2.built[0]!.dockerfile.trim().endsWith('USER node')).toBe(true);
    expect(w.store.getAgent(id)!.image).toBe(tag); // it keeps its pin — and its packages
    expect(w.store.getAgent(id)!.hostId).toBe('h2');
  });

  it('an image that is already there is used as is', async () => {
    const { mock2, move } = await setup({ tag: 'hatchabot-runtime:2026.7.1-2-plus-jq', imageId: 'src', openclawVersion: '2026.7.1-2', extraPackages: ['jq'] });
    mock2.tags.push({ tag: 'hatchabot-runtime:2026.7.1-2-plus-jq', imageId: 'there' } as any);
    expect((await move()).statusCode).toBe(200);
    expect(mock2.built).toHaveLength(0);
  });

  it('messaging plugins come from the base: rebuilt when the runner\'s base has them', async () => {
    const { mock2, move } = await setup({ tag: 'hatchabot-runtime:2026.7.1-2-plus-traceroute', imageId: 'src', openclawVersion: '2026.7.1-2', channels: ['slack', 'discord'], extraPackages: ['traceroute'] });
    mock2.tags.push({ tag: 'hatchabot-runtime:2026.7.1-2', imageId: 'b', channels: ['slack', 'discord'] } as any);
    expect((await move()).statusCode).toBe(200);
    expect(mock2.built).toHaveLength(1);
  });

  it('what cannot be rebuilt says why, and still offers the default image', async () => {
    const { w, mock2, id, move } = await setup({ tag: 'hatchabot-runtime:2026.7.1-2-ch1', imageId: 'src', openclawVersion: '2026.7.1-2', channels: ['slack', 'discord'] });
    mock2.tags.push({ tag: 'hatchabot-runtime:2026.7.1-2', imageId: 'b', channels: [] } as any); // a base built without them
    const refused = await move();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'pinned_image_missing' });
    expect(refused.json().error).toMatch(/slack and discord built in, and that machine's hatchabot-runtime:2026\.7\.1-2 does not/);
    expect(w.store.getAgent(id)!.hostId).toBe('h1'); // nothing moved
    expect((await move({ dropPin: true })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.image ?? null).toBeNull();
  });

  it('no published base to pull, or a failed build, is a clear refusal', async () => {
    const a = await setup({ tag: 'hatchabot-runtime:2026.7.1-2-plus-jq', imageId: 'src', openclawVersion: '2026.7.1-2', extraPackages: ['jq'] });
    const r1 = await a.move();
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error).toMatch(/no published copy to pull/);
    const b = await setup({ tag: 'hatchabot-runtime:2026.7.1-2-plus-jq', imageId: 'src', openclawVersion: '2026.7.1-2', extraPackages: ['jq'] });
    b.mock2.publishedBases.add('hatchabot-runtime:2026.7.1-2');
    b.mock2.buildFails = true;
    const r2 = await b.move();
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toMatch(/the rebuild failed: E: Unable to locate package/);
  });

  it('another image of the pin\'s name there is refused with why, left as it is, and the agent stays (HB-1325)', async () => {
    const inputs = (openclaw: string) => formatBuildInputs({
      openclaw, engine: 'none', packages: ['jq'], node: 'node:24-slim', channels: [], channelPlugins: openclaw, plugins: [], pluginInstall: 'npm',
      embedPlugin: '2026.7.1', claudeCode: '2.1.224', byHand: [], release: '2.190.0',
    });
    // Layers as every real listing has them, and never the same on two machines' own builds.
    const layer = (c: string) => `sha256:${c.repeat(64)}`;
    const { w, mock2, id, move } = await setup({ tag: 'hatchabot-runtime:2026.9.8-plus-jq', imageId: 'src', openclawVersion: '2026.9.8', extraPackages: ['jq'], buildInputs: inputs('2026.9.8'), layers: [layer('1'), layer('2')] });
    mock2.tags.push({ tag: 'hatchabot-runtime:2026.9.8-plus-jq', imageId: 'theirs', openclawVersion: '2026.9.6', extraPackages: ['jq'], buildInputs: inputs('2026.9.6'), layers: [layer('8')] } as any);
    const res = await move();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'pinned_image_missing', image: 'hatchabot-runtime:2026.9.8-plus-jq' });
    expect(res.json().error).toBe(`"${w.store.getAgent(id)!.name}" is pinned to the image hatchabot-runtime:2026.9.8-plus-jq, and Laptop has a different image of that name (the one there runs OpenClaw 2026.9.6, not 2026.9.8), which is left as it is. Move it on that runner's default image instead — its extra packages will be missing there.`);
    expect([mock2.built, mock2.tagged, mock2.pulled]).toEqual([[], [], []]);
    expect(w.store.getAgent(id)!.hostId).toBe('h1');
  });

  it('an image of the pin\'s name there from before the build-inputs label is taken by name, its layers its own: the move goes ahead (HB-1325 review)', async () => {
    const layer = (c: string) => `sha256:${c.repeat(64)}`;
    const { w, mock2, id, move } = await setup({ tag: 'hatchabot-runtime:2026.9.8-plus-jq', imageId: 'src', openclawVersion: '2026.9.8', extraPackages: ['jq'], layers: [layer('1'), layer('2')] });
    mock2.tags.push({ tag: 'hatchabot-runtime:2026.9.8-plus-jq', imageId: 'theirs', openclawVersion: '2026.9.8', extraPackages: ['jq'], layers: [layer('8'), layer('9')] } as any);
    const res = await move();
    expect(res.statusCode, res.body).toBe(200);
    expect(mock2.built).toEqual([]);
    expect(w.store.getAgent(id)!.hostId).toBe('h2');
    expect(w.store.getAgent(id)!.image).toBe('hatchabot-runtime:2026.9.8-plus-jq');
  });

  it('a rebuild there whose image would run as root is refused, and the agent stays where it was (HB-1032)', async () => {
    const { w, mock2, id, move } = await setup({ tag: 'hatchabot-runtime:2026.7.1-2-plus-jq', imageId: 'src', openclawVersion: '2026.7.1-2', extraPackages: ['jq'] });
    mock2.publishedBases.add('hatchabot-runtime:2026.7.1-2');
    mock2.buildRunsAs = 'root';
    const res = await move();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/the rebuild failed: The built image would run as root, not node/);
    expect(mock2.tags.map((t) => t.tag)).toEqual(['hatchabot-runtime:latest', 'hatchabot-runtime:2026.7.1-2']);
    expect(w.store.getAgent(id)!.hostId).toBe('h1'); // nothing moved
  });
});
