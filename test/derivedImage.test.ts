import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import {
  baseProblem,
  deriveTag,
  derivedNameProblem,
  renderDockerfile,
} from '../src/orchestrator/derivedImage.js';

/**
 * Derived images: an owner builds `FROM hatchabot-runtime:<base>` + their own
 * Dockerfile lines for system packages a volume install can't provide. Building
 * runs a Dockerfile on the box, so every route is host-owner gated; the name is
 * both a tag component and a filename, so it's strictly validated.
 */

describe('derivedNameProblem', () => {
  it('accepts a plain kebab name', () => {
    expect(derivedNameProblem('media-tools')).toBeNull();
    expect(derivedNameProblem('ffmpeg2')).toBeNull();
  });
  it('rejects the dangerous and the malformed', () => {
    expect(derivedNameProblem('')).toMatch(/required/i);
    expect(derivedNameProblem('A')).toBeTruthy(); // too short + uppercase
    expect(derivedNameProblem('9lives')).toBeTruthy(); // must start with a letter
    expect(derivedNameProblem('has space')).toBeTruthy();
    expect(derivedNameProblem('slash/here')).toBeTruthy();
    expect(derivedNameProblem('..')).toBeTruthy(); // path traversal shape
    expect(derivedNameProblem('trailing-')).toBeTruthy();
    expect(derivedNameProblem('double--dash')).toBeTruthy();
  });
});

describe('baseProblem', () => {
  it('requires an hatchabot-runtime tag and refuses chaining', () => {
    expect(baseProblem('hatchabot-runtime:latest')).toBeNull();
    expect(baseProblem('hatchabot-runtime:2026.7.1-2-emb1')).toBeNull();
    expect(baseProblem('ubuntu:22.04')).toMatch(/must be a hatchabot-runtime/i);
    // A derived image built on another derived image can't be rebuilt from a
    // promoted base — refuse the tower.
    expect(baseProblem('hatchabot-runtime:derived-x')).toMatch(/cannot be based on another/i);
  });
});

describe('deriveTag', () => {
  it('namespaces under the base repo so images sort together', () => {
    expect(deriveTag('media')).toBe('hatchabot-runtime:derived-media');
  });
});

describe('renderDockerfile', () => {
  it('runs the snippet as root then restores USER node', () => {
    // The base ends as USER node, so apt fails without USER root; and the
    // runtime MUST end as node (uid 1000 volume; Claude Code refuses root).
    const out = renderDockerfile('hatchabot-runtime:latest', 'RUN apt-get install -y ffmpeg');
    expect(out).toBe(
      'FROM hatchabot-runtime:latest\nUSER root\nRUN apt-get install -y ffmpeg\nUSER node\n',
    );
    // node comes last so the owner's snippet can't leave the image as root.
    expect(out.trimEnd().endsWith('USER node')).toBe(true);
  });
});

describe('Store derived_images', () => {
  const store = () => new Store(new Database(':memory:'));

  it('upserts BUILDING, then flips to READY with a built_at stamp', () => {
    const s = store();
    s.upsertDerivedImage({ name: 'media', tag: deriveTag('media'), base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', createdBy: 'u1' });
    let rec = s.getDerivedImage('media')!;
    expect(rec.status).toBe('BUILDING');
    expect(rec.builtAt).toBeNull();

    s.setDerivedImageStatus('media', 'READY');
    rec = s.getDerivedImage('media')!;
    expect(rec.status).toBe('READY');
    expect(rec.builtAt).not.toBeNull();
    expect(rec.error).toBeNull();
  });

  it('a re-derive under the same name resets to BUILDING and replaces the dockerfile', () => {
    const s = store();
    s.upsertDerivedImage({ name: 'x', tag: deriveTag('x'), base: 'hatchabot-runtime:latest', dockerfile: 'RUN a', createdBy: 'u1' });
    s.setDerivedImageStatus('x', 'FAILED', 'boom');
    s.upsertDerivedImage({ name: 'x', tag: deriveTag('x'), base: 'hatchabot-runtime:latest', dockerfile: 'RUN b', createdBy: 'u1' });
    const rec = s.getDerivedImage('x')!;
    expect(rec.status).toBe('BUILDING');
    expect(rec.error).toBeNull(); // cleared on re-derive
    expect(rec.dockerfile).toBe('RUN b');
  });

  it('lists sorted and deletes', () => {
    const s = store();
    for (const n of ['zeta', 'alpha']) {
      s.upsertDerivedImage({ name: n, tag: deriveTag(n), base: 'hatchabot-runtime:latest', dockerfile: 'RUN x', createdBy: 'u1' });
    }
    expect(s.listDerivedImages().map((i) => i.name)).toEqual(['alpha', 'zeta']);
    expect(s.deleteDerivedImage('alpha')).toBe(true);
    expect(s.listDerivedImages().map((i) => i.name)).toEqual(['zeta']);
  });
});

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error('missing'); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}

const OWNER = 'user-owner';
const OTHER = 'user-other';

async function world() {
  const store = new Store(new Database(':memory:'));
  // The local host, owned by OWNER — what ownsLocalHost checks.
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', models: ['claude-opus-4-8'], secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });

  // Deterministic stub builder — no docker. Records calls and reports success.
  const builds: string[] = [];
  const f = Fastify();
  await registerRoutes(f, {
    store,
    secrets: new MemSecrets(),
    providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
    buildImage: async (opts: any) => { builds.push(opts.name); return { ok: true }; },
  });
  return { store, f, builds };
}

const H = (owner: string) => ({ 'x-hatchabot-owner': owner });

describe('POST /v1/images', () => {
  it('host owner: creates a BUILDING row and kicks the build', async () => {
    const { store, f, builds } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/images', headers: H(OWNER), payload: { name: 'media', dockerfile: 'RUN apt-get install -y ffmpeg' } });
    expect(res.statusCode).toBe(202);
    expect(res.json().tag).toBe('hatchabot-runtime:derived-media');
    const rec = store.getDerivedImage('media')!;
    expect(rec.base).toBe('hatchabot-runtime:latest'); // default base
    // the build was kicked (stub ran synchronously-ish; allow a tick)
    await new Promise((r) => setTimeout(r, 0));
    expect(builds).toContain('media');
    expect(store.getDerivedImage('media')!.status).toBe('READY');
  });

  it('rejects a non-host-owner with 403', async () => {
    const { store, f } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/images', headers: H(OTHER), payload: { name: 'media', dockerfile: 'RUN true' } });
    expect(res.statusCode).toBe(403);
    expect(store.getDerivedImage('media')).toBeUndefined();
  });

  it('rejects a bad name and a non-runtime base before any build', async () => {
    const { f, builds } = await world();
    expect((await f.inject({ method: 'POST', url: '/v1/images', headers: H(OWNER), payload: { name: 'bad name', dockerfile: 'RUN true' } })).statusCode).toBe(400);
    expect((await f.inject({ method: 'POST', url: '/v1/images', headers: H(OWNER), payload: { name: 'ok', dockerfile: 'RUN true', base: 'ubuntu:22.04' } })).statusCode).toBe(400);
    expect(builds).toEqual([]);
  });
});

describe('DELETE /v1/images/:name', () => {
  it('refuses while an agent pins the tag, allows once unpinned', async () => {
    const { store, f } = await world();
    await f.inject({ method: 'POST', url: '/v1/images', headers: H(OWNER), payload: { name: 'media', dockerfile: 'RUN true' } });
    store.setDerivedImageStatus('media', 'READY');
    store.setAgentImage('a1', 'hatchabot-runtime:derived-media');

    const busy = await f.inject({ method: 'DELETE', url: '/v1/images/media', headers: H(OWNER) });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatch(/Kitchen/);

    store.setAgentImage('a1', null);
    const ok = await f.inject({ method: 'DELETE', url: '/v1/images/media', headers: H(OWNER) });
    expect(ok.statusCode).toBe(200);
    expect(store.getDerivedImage('media')).toBeUndefined();
  });
});

describe('GET /v1/images', () => {
  it('lists with pin counts and the fleet base, host-owner only', async () => {
    const { store, f } = await world();
    await f.inject({ method: 'POST', url: '/v1/images', headers: H(OWNER), payload: { name: 'media', dockerfile: 'RUN true' } });
    store.setDerivedImageStatus('media', 'READY');
    store.setAgentImage('a1', 'hatchabot-runtime:derived-media');

    const res = await f.inject({ method: 'GET', url: '/v1/images', headers: H(OWNER) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.base).toBe('hatchabot-runtime:latest');
    expect(body.images[0]).toMatchObject({ name: 'media', pinnedBy: 1 });

    expect((await f.inject({ method: 'GET', url: '/v1/images', headers: H(OTHER) })).statusCode).toBe(403);
  });
});

describe('deleting a derived image', () => {
  it('keeps the row when docker refuses, and says why', async () => {
    const store = new Store(new Database(':memory:'));
    const f = Fastify();
    let refuse = true;
    await registerRoutes(f, {
      store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never,
      removeImage: async () => (refuse
        ? { ok: false, error: 'conflict: unable to remove repository reference (must force) - container 9f2 is using it' }
        : { ok: true }),
    });
    const OWNER2 = 'dev-owner';
    store.insertHost({ id: 'h1', ownerId: OWNER2, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.upsertDerivedImage({ name: 'pdf', tag: 'hatchabot-runtime:derived-pdf', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', createdBy: OWNER2 });
    store.setDerivedImageStatus('pdf', 'READY');

    // Docker says no: the row MUST survive, or the image has nothing left to
    // delete it from (the 2026-09-19 orphan).
    const stuck = await f.inject({ method: 'DELETE', url: '/v1/images/pdf' });
    expect(stuck.statusCode).toBe(409);
    expect(stuck.json().error).toMatch(/container 9f2 is using it/);
    expect(store.getDerivedImage('pdf')).toBeTruthy();

    refuse = false;
    const gone = await f.inject({ method: 'DELETE', url: '/v1/images/pdf' });
    expect(gone.statusCode).toBe(200);
    expect(store.getDerivedImage('pdf')).toBeUndefined();
  });
});
