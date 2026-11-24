import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pbkdf2 } from 'node:crypto';
import { chmodSync, closeSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import { IMAGE_FACTS_FORMAT } from '../src/providers/provider.js';
import { baseProblem, buildDerivedImage, checkTag, removeDerivedImage, deriveTag, dockerfileProblem, openBuildLog, readLogTail, recipeStamp, renderDockerfile, runFlags } from '../src/orchestrator/machines/derivedImage.js';
import { derivedNameProblem } from '../src/domain/derivedImageName.js';
import { createRuntimeImages } from '../src/orchestrator/machines/runtimeImages.js';
import { buildRecipeOn } from '../src/orchestrator/machines/imageRecipe.js';

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

  it("lays an imported image's base packages on before the owner's lines, which stay as they are (HB-0986)", () => {
    expect(renderDockerfile('hatchabot-runtime:latest', 'RUN true', ['jq', 'g++'])).toBe(
      'FROM hatchabot-runtime:latest\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends jq g++ && rm -rf /var/lib/apt/lists/*\nRUN true\nUSER node\n',
    );
    expect(renderDockerfile('hatchabot-runtime:latest', 'RUN true', [])).toBe('FROM hatchabot-runtime:latest\nUSER root\nRUN true\nUSER node\n');
  });

  it("refuses lines that plainly set Hatchabot's own labels, which say what an image was built from (HB-0986)", () => {
    for (const s of [
      'LABEL org.hatchabot.build-inputs="v1;openclaw=2026.9.8"', 'label org.hatchabot.derived=', 'ONBUILD LABEL org.agentclaw.openclaw-version=2026.9.8',
      'LABEL a=b \\\n  org.hatchabot.extra-packages=jq', 'LABEL "org.hatchabot.derived"=x', 'LABEL o"rg".hatchabot.derived=x', 'LABEL org\\.hatchabot.derived=x',
      // The ones its agents' containers carry, which a container takes from its image (HB-0986 review).
      'LABEL hatchabot.console-port=18789', 'LABEL a=b "hatchabot.agent"=x', 'ONBUILD LABEL hatchabot.role browser-logins', 'label HATCHABOT.agent=x',
    ]) expect(dockerfileProblem(s), s).toBe("A derived image cannot set Hatchabot's own labels (org.hatchabot.…, hatchabot.…): they say what its base was built from, and what its agents' containers are.");
    expect(dockerfileProblem('LABEL org.example.maintainer="the household"')).toBeNull();
    for (const s of ['LABEL description="made for hatchabot.com"', 'LABEL org.example.hatchabot.kind=media', 'LABEL source=hatchabot.example']) expect(dockerfileProblem(s), s).toBeNull();
    // A variable in a label is the owner's own: the image built is looked at for Hatchabot's instead (HB-0986 review).
    for (const s of ['ARG VER=1\nLABEL v=${VER}', 'LABEL d="costs $5"', 'ARG K=org.hatchabot.derived\nLABEL ${K}=x']) expect(dockerfileProblem(s), s).toBeNull();
  });

  it('refuses lines that would swallow the trailing USER node (B002)', () => {
    // Docker joins a `\`-continued last line with the USER node after it
    // (comment and blank lines between are dropped), so the image stayed root.
    expect(dockerfileProblem('RUN echo installed \\')).toMatch(/continues it into nothing/);
    expect(dockerfileProblem('RUN echo installed \\  \n\n# a note\n')).toMatch(/continues it into nothing/);
    expect(dockerfileProblem('RUN apt-get install -y \\\n  ffmpeg')).toBeNull();
    // An unterminated heredoc takes the rest of the file, USER node included, as text.
    expect(dockerfileProblem('RUN <<EOF\necho hi')).toMatch(/heredoc <<EOF is never closed/);
    expect(dockerfileProblem('RUN <<EOF\necho hi\nEOF')).toBeNull();
    expect(dockerfileProblem('RUN <<-EOT\n\techo hi\n\tEOT')).toBeNull();
    expect(dockerfileProblem('RUN cat <<< "hi"')).toBeNull();
  });

  it('a << inside quotes is text, as BuildKit reads it (review, 2026-10-22)', () => {
    expect(dockerfileProblem('RUN echo "example <<EOF"')).toBeNull();
    expect(dockerfileProblem("RUN echo 'a <<EOF' && echo \"b \\\" <<EOT\"")).toBeNull();
    // Quoted delimiters and a << after the quotes are still heredocs.
    expect(dockerfileProblem('RUN cat <<"EOF"\nhi')).toMatch(/heredoc <<EOF is never closed/);
    expect(dockerfileProblem('RUN echo "a" <<EOF\nhi')).toMatch(/heredoc <<EOF is never closed/);
    // A continued line may begin inside a quote: every << on it counts.
    expect(dockerfileProblem('RUN echo "a \\\nb" <<EOF\nhi')).toMatch(/heredoc <<EOF is never closed/);
    expect(dockerfileProblem('RUN echo a \\\n\n"x <<EOF"')).toMatch(/heredoc <<EOF is never closed/);
  });

  it('a build of a saved record with such lines is refused before docker runs (B002)', async () => {
    const res = await buildDerivedImage({ name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN echo installed \\', docker: '/nonexistent/docker', dataDir: mkdtempSync(join(tmpdir(), 'hb-derive-')) });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/continues it into nothing/) });
  });
});

describe("RUN's --mount and --network, by the flag's whole name", () => {
  it.each([
    'RUN --network=host curl http://127.0.0.1:11434/',
    'RUN --network host curl http://127.0.0.1:11434/',
    'RUN --NETWORK=host true',
    'RUN --network\\\n=host true',
    'RUN --net\\\nwork=host true',
    'RUN --network',
    'RUN --network${X}=host true',
    'RUN --mount=type=bind,source=/,target=/h cat /h/x',
    'RUN --mount type=bind,source=/,target=/h cat /h/x',
    'RUN --mount \\\n=type=bind,source=/,target=/h cat /h/x',
    'RUN --mo\\\nunt=type=secret,id=x cat /run/secrets/x',
    // RUN's own flag, its quotes and escapes out, as BuildKit reads it (HB-1291 review).
    'RUN --net"work"=host true',
    "RUN --mo'unt'=type=bind,source=/,target=/h cat /h/x",
    'RUN --netw\\ork=host true',
  ])('refused: %j', (lines) => {
    expect(dockerfileProblem(lines)).toMatch(/RUN --(mount|network) is not allowed/);
  });
  it.each([
    'RUN yarn install --network-timeout 600000',
    'RUN npm install --network-concurrency=4',
    'RUN tool --mount-point /x',
    'RUN tool --mount-options=ro --mount_x',
    'RUN yarn install --network-timeout\\\n 600000',
  ])("a command's own flag of a longer name is not RUN's: %j", (lines) => {
    expect(dockerfileProblem(lines)).toBeNull();
  });
});

describe('derived image lines are plain text (HB-1291 review)', () => {
  const said = (n: number) => `Line ${n} has a character that is not plain text. Derived image lines may hold only ordinary letters, digits, punctuation, spaces and tabs, except in a # comment line.`;
  it.each([
    ['\u0085FROM evil.example/x', 1],
    ['RUN\u00a0--network=host true', 1],
    ['RUN --network=none\u3000--device=x true', 1],
    ['RUN true\n\ufeffUSER root', 2],
    ['RUN echo a\u2028FROM x', 1],
    ['RUN true\vFROM x', 1],
    ['RUN true\r\nRUN echo "caf\u00e9"', 2],
    ['# a comment\x1b[2J\nRUN true', 1],
    ['\u00a0# not a comment to both\nRUN true', 1],
    // A lone CR is no line break to BuildKit (bufio.ScanLines splits at LF only): it is a space there (round-2 review).
    ['RUN \r--device=vendor.example/gpu=all true', 1],
    ['RUN\r--security=insecure true', 1],
    ['ONBUILD RUN\r--device=x true', 1],
    ['# note\rRUN echo \\\nRUN --device=x true', 1],
    ['RUN true\n# note\rFROM x', 2],
    // Nor in a comment: C1 controls, Unicode's line breaks and its marks that reorder what is shown (round-2 review).
    ['# a\u0085 note\nRUN true', 1],
    ['# a\u009b2J note\nRUN true', 1],
    ['RUN true\n# a\u2028FROM x', 2],
    ['RUN true\n# a\u2029FROM x', 2],
    ['# a\u202enote\nRUN true', 1],
    ['# a\u202a\u202b\u202c\u202dnote\nRUN true', 1],
    ['# a\u2066note\u2069\nRUN true', 1],
    ['# a\u2068note\nRUN true', 1],
  ])('refused: %j', (lines, n) => {
    expect(dockerfileProblem(lines)).toBe(said(n));
  });
  it.each([
    '# install ffmpeg \u2014 for the caf\u00e9 videos\nRUN true',
    '\t  # na\u00efve\nRUN true',
    'RUN apt-get update \\\r\n\t&& apt-get install -y jq\r\n',
  ])('a comment line may say anything printable, and tabs and CRLF are plain text: %j', (lines) => {
    expect(dockerfileProblem(lines)).toBeNull();
  });
});

describe("RUN's --security and --device, which would weaken the build (HB-1291)", () => {
  it.each([
    ['RUN --security=insecure mount -t proc none /mnt', 'security'],
    ['RUN --security=sandbox true', 'security'],
    ['RUN --SECURITY=insecure true', 'security'],
    ['RUN --secu\\\nrity=insecure true', 'security'],
    // BuildKit takes the quotes and escapes out of a flag's word: these are the flag.
    ['RUN --sec"urity"=insecure true', 'security'],
    ["RUN --'security'=insecure true", 'security'],
    ['RUN --se\\curity=insecure true', 'security'],
    ['RUN --device=vendor.example/gpu=all nvidia-smi', 'device'],
    ['RUN --device vendor.example/gpu=all true', 'device'],
    ['RUN --dev"ice"=vendor.example/gpu=all true', 'device'],
    ['RUN --mount=type=cache,target=/x --device=vendor.example/gpu true', 'mount'],
    ['ONBUILD RUN --device=vendor.example/gpu true', 'device'],
    ['RUN --device', 'device'],
  ])('refused: %j', (lines, flag) => {
    expect(dockerfileProblem(lines)).toBe(`RUN --${flag} is not allowed in a derived image.`);
  });
  it.each([
    'RUN tool --security-opt x',
    'RUN tool --device-id 3 --devices=all',
    'RUN apt-get install -y libsecurity-dev device-tree-compiler',
    // The command's own, after RUN's flags end (HB-1291 review).
    'RUN python3 warm.py --device cpu',
    'RUN dnf -y upgrade --security',
    'RUN echo "--device"',
    'RUN echo --security=insecure',
    'RUN --mount_x \\--device=x',
    'RUN -- --device=x',
    'RUN <<EOF\n--device=x\nEOF',
    'RUN ["tool", "--device=x"]',
  ])("a command's own flag or word of a longer name is not RUN's: %j", (lines) => {
    expect(dockerfileProblem(lines)).toBeNull();
  });
  it('reads the flags as BuildKit does: up to the command, a bare --, quotes and escapes out', () => {
    expect(runFlags('RUN --a=1 "--b" --c\\=x"y z" tool --d')).toEqual(['--a=1']);
    expect(runFlags('RUN --a=1 --c\\=x"y z" tool --d')).toEqual(['--a=1', '--c=xy z']);
    expect(runFlags('run --a -- --b')).toEqual(['--a']);
    expect(runFlags('ONBUILD RUN --device=x true')).toEqual(['--device=x']);
    expect(runFlags('RUN\t--network=none\u00a0--device=x true')).toEqual(['--network=none', '--device=x']);
    expect(runFlags('COPY --from=x a b')).toEqual([]);
    expect(runFlags('RUNNER --device=x')).toEqual([]);
  });
  it('a record saved before the rule is refused where it is built on another machine, before anything is pulled or built', async () => {
    const m = new MockProvider();
    m.publishedBases.add('hatchabot-runtime:2026.9.8');
    const r = { tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:2026.9.8', packages: [], channels: [], lines: 'RUN --security=insecure true' };
    expect(await buildRecipeOn(m, r)).toEqual({ ok: false, problem: 'RUN --security is not allowed in a derived image.', refused: true });
    expect(m.built).toEqual([]);
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

  it("keeps an image's base packages apart from its lines, through a re-derive (HB-0986)", () => {
    const s = store();
    s.upsertDerivedImage({ name: 'x', tag: deriveTag('x'), base: 'hatchabot-runtime:latest', dockerfile: 'RUN a', createdBy: 'u1' });
    expect(s.getDerivedImage('x')!.basePackages).toEqual([]);
    s.setDerivedImageBase('x', 'hatchabot-runtime:2026.9.8', ['jq', 'g++']);
    expect(s.getDerivedImage('x')).toMatchObject({ base: 'hatchabot-runtime:2026.9.8', basePackages: ['jq', 'g++'], dockerfile: 'RUN a' });
    // A re-derive or Rebuild that does not name them keeps them.
    s.upsertDerivedImage({ name: 'x', tag: deriveTag('x'), base: 'hatchabot-runtime:latest', dockerfile: 'RUN b', createdBy: 'u1' });
    expect(s.getDerivedImage('x')).toMatchObject({ base: 'hatchabot-runtime:latest', basePackages: ['jq', 'g++'], dockerfile: 'RUN b' });
    s.upsertDerivedImage({ name: 'x', tag: deriveTag('x'), base: 'hatchabot-runtime:latest', basePackages: [], dockerfile: 'RUN b', createdBy: 'u1' });
    expect(s.getDerivedImage('x')!.basePackages).toEqual([]);
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
  const asked: Array<{ name: string; basePackages?: readonly string[]; dockerfile: string }> = [];
  const f = Fastify();
  await registerRoutes(f, {
    store,
    secrets: new MemSecrets(),
    providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
    buildImage: async (opts: any) => { builds.push(opts.name); asked.push(opts); return { ok: true }; },
    removeImage: async () => ({ ok: true }), // no docker rmi here: CI runners may have no docker
  });
  return { store, f, builds, asked };
}

const H = (owner: string) => ({ 'x-hatchabot-owner': owner });

describe('POST /v1/images', () => {
  it('refuses replacing or rebuilding a derived image held by an import build', async () => {
    const { store, f, builds } = await world();
    try {
      // Imports build through their provider, outside the routes' local Set.
      store.upsertDerivedImage({ name: 'imported-tools', tag: deriveTag('imported-tools'), base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', createdBy: OWNER });
      const before = store.getDerivedImage('imported-tools');
      for (const request of [
        { method: 'POST' as const, url: '/v1/images', payload: { name: 'imported-tools', dockerfile: 'RUN false', replace: true } },
        { method: 'POST' as const, url: '/v1/images/imported-tools/rebuild', payload: {} },
      ]) {
        const response = await f.inject({ ...request, headers: H(OWNER) });
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toMatch(/already building/);
        expect(store.getDerivedImage('imported-tools')).toEqual(before);
      }
      expect(builds).toEqual([]);
    } finally { await f.close(); }
  });

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

  it("a Rebuild lays the image's base packages on again, apart from its lines (HB-0986)", async () => {
    const { store, f, asked } = await world();
    try {
      store.upsertDerivedImage({ name: 'media', tag: deriveTag('media'), base: 'hatchabot-runtime:latest', basePackages: ['jq'], dockerfile: 'RUN true', createdBy: OWNER });
      store.setDerivedImageStatus('media', 'READY');
      expect((await f.inject({ method: 'POST', url: '/v1/images/media/rebuild', headers: H(OWNER), payload: {} })).statusCode).toBe(202);
      await new Promise((r) => setTimeout(r, 0));
      expect(asked).toMatchObject([{ name: 'media', basePackages: ['jq'], dockerfile: 'RUN true' }]);
      expect(store.getDerivedImage('media')).toMatchObject({ status: 'READY', basePackages: ['jq'] });
    } finally { await f.close(); }
  });

  it('rejects a non-host-owner with 403', async () => {
    const { store, f } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/images', headers: H(OTHER), payload: { name: 'media', dockerfile: 'RUN true' } });
    expect(res.statusCode).toBe(403);
    expect(store.getDerivedImage('media')).toBeUndefined();
  });

  it('a fleet on another runtime repository derives from its own default, and names the image there (HB-0882)', async () => {
    const was = process.env.HATCHABOT_IMAGE;
    process.env.HATCHABOT_IMAGE = 'example-runtime:latest';
    try {
      const { store, f, builds } = await world();
      const made = await f.inject({ method: 'POST', url: '/v1/images', headers: H(OWNER), payload: { name: 'media', dockerfile: 'RUN true' } });
      expect(made.statusCode, made.body).toBe(202);
      expect(made.json().tag).toBe('example-runtime:derived-media');
      expect(store.getDerivedImage('media')).toMatchObject({ base: 'example-runtime:latest', tag: 'example-runtime:derived-media' });
      await new Promise((r) => setTimeout(r, 0));
      expect((await f.inject({ method: 'POST', url: '/v1/images/media/rebuild', headers: H(OWNER), payload: { base: 'example-runtime:2026.9.8' } })).statusCode).toBe(202);
      await new Promise((r) => setTimeout(r, 0));
      // One saved before the repository changed still rebuilds, and keeps the tag its agents pin.
      store.upsertDerivedImage({ name: 'older', tag: 'hatchabot-runtime:derived-older', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', createdBy: OWNER });
      store.setDerivedImageStatus('older', 'READY');
      expect((await f.inject({ method: 'POST', url: '/v1/images/older/rebuild', headers: H(OWNER), payload: {} })).statusCode).toBe(202);
      await new Promise((r) => setTimeout(r, 0));
      const replaced = await f.inject({ method: 'POST', url: '/v1/images', headers: H(OWNER), payload: { name: 'older', dockerfile: 'RUN false', replace: true } });
      expect(replaced.statusCode, replaced.body).toBe(202);
      expect(replaced.json().tag).toBe('hatchabot-runtime:derived-older');
      // Still a runtime image only.
      expect((await f.inject({ method: 'POST', url: '/v1/images', headers: H(OWNER), payload: { name: 'other', dockerfile: 'RUN true', base: 'ubuntu:22.04' } })).json().error).toMatch(/example-runtime:\*/);
      expect(builds).toEqual(['media', 'media', 'older', 'older']);
      await f.close();
    } finally {
      if (was === undefined) delete process.env.HATCHABOT_IMAGE; else process.env.HATCHABOT_IMAGE = was;
    }
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

describe("removing a derived image's image", () => {
  let dir: string;
  let was: { PATH?: string; HOME?: string };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hb-derive-rmi-'));
    was = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = join(dir, 'bin');
    process.env.HOME = dir;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  });
  /** A made-up docker whose `rmi` of each name answers as `answers` says (default: removed). No real docker runs. */
  const fake = (answers: Record<string, string> = {}) => {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const p = join(dir, 'bin', 'docker');
    const cases = Object.entries(answers).map(([ref, sh]) => `  ${ref}) ${sh};;`).join('\n');
    writeFileSync(p, `#!/bin/sh\necho "$*" >> "${join(dir, 'calls')}"\ncase "$2" in\n${cases}\n  *) exit 0;;\nesac\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const calls = () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');

  it("takes the name a build of it left too, and a missing one is no matter (HB-1032)", async () => {
    expect(await removeDerivedImage('hatchabot-runtime:derived-media', { docker: fake() })).toEqual({ ok: true });
    expect(calls()).toEqual(['rmi hatchabot-runtime-check:derived-media', 'rmi hatchabot-runtime:derived-media']);
    rmSync(join(dir, 'calls'));
    const gone = 'echo "Error response from daemon: No such image: hatchabot-runtime-check:derived-media" >&2; exit 1';
    expect(await removeDerivedImage('hatchabot-runtime:derived-media', { docker: fake({ 'hatchabot-runtime-check:derived-media': gone }) })).toEqual({ ok: true });
    expect(calls()).toEqual(['rmi hatchabot-runtime-check:derived-media', 'rmi hatchabot-runtime:derived-media']);
  });

  it("a build's name that cannot be removed leaves the image, and says why", async () => {
    const held = 'echo "Error response from daemon: conflict: unable to remove repository reference (must force) - container 9f2 is using it" >&2; exit 1';
    expect(await removeDerivedImage('hatchabot-runtime:derived-media', { docker: fake({ 'hatchabot-runtime-check:derived-media': held }) }))
      .toEqual({ ok: false, error: 'Error response from daemon: conflict: unable to remove repository reference (must force) - container 9f2 is using it' });
    expect(calls()).toEqual(['rmi hatchabot-runtime-check:derived-media']);
  });
});

describe('a fleet whose default is pinned by digest (review of HB-1182)', () => {
  it('names its derived images, and manages its images, in its repository, never "<name>@sha256"', async () => {
    const was = process.env.HATCHABOT_IMAGE;
    process.env.HATCHABOT_IMAGE = `hatchabot-runtime@sha256:${'ab'.repeat(32)}`;
    try {
      const { f } = await world();
      const made = await f.inject({ method: 'POST', url: '/v1/images', headers: H(OWNER), payload: { name: 'media', dockerfile: 'RUN true', base: 'hatchabot-runtime:2026.9.8' } });
      expect(made.statusCode, made.body).toBe(202);
      expect(made.json().tag).toBe('hatchabot-runtime:derived-media');
      // Promote and Delete take the repository's own tags.
      const del = await f.inject({ method: 'DELETE', url: `/v1/runtime/images/${encodeURIComponent('hatchabot-runtime:2026.7.1-2')}`, headers: H(OWNER) });
      expect(del.json().error ?? '').not.toMatch(/tags are managed here/);
      await f.close();
    } finally {
      if (was === undefined) delete process.env.HATCHABOT_IMAGE; else process.env.HATCHABOT_IMAGE = was;
    }
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

/** A program's full path: the docker shim runs on a PATH that has only itself. */
const tool = (name: string) => ['/usr/bin', '/bin'].map((d) => join(d, name)).find((p) => existsSync(p)) ?? name;
/** What a made-up docker answers after the build: the image runs as node, and is named and its build's name removed. */
const LAYER = (c: string) => `sha256:${c.repeat(64)}`;
/** What a made-up docker says of an image: the base is one layer, what a build makes (its check name) runs as node on it. */
const CHECKS = `case "$1" in image) case "$5" in *-check:*) echo '["${LAYER('c')}","node",["${LAYER('a')}","${LAYER('c')}"],null]';; *) echo '["${LAYER('a')}","node",["${LAYER('a')}"],null]';; esac; exit 0;; tag|rmi) exit 0;; esac`;

describe("a derived build's log (HB-1026)", () => {
  let dir: string;
  let was: { PATH?: string; HOME?: string };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hb-derive-log-'));
    was = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = join(dir, 'bin');
    process.env.HOME = dir;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  });
  /** A made-up docker: `docker build -t <tag> <dir>` runs this, so `$3` is the tag (the one it builds to). No real docker runs. */
  const docker = (body: string) => {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const p = join(dir, 'bin', 'docker');
    writeFileSync(p, `#!/bin/sh\n${CHECKS}\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const sleep = tool('sleep');
  const head = (tag: string) => `# building ${tag}\n# FROM hatchabot-runtime:latest\n\n`;
  /** Keep every thread that writes files busy for a while, as a slow disk does. */
  const busyFileThreads = () => Array.from({ length: 2 * (Number(process.env.UV_THREADPOOL_SIZE) || 4) },
    () => new Promise((r) => pbkdf2('made-up', 'salt', 2_000_000, 32, 'sha256', r)));

  it.runIf(existsSync(sleep))('the build has ended only once its log holds all its output, in order', async () => {
    // As docker's last line comes, the file writes are kept waiting. Each
    // chunk's append was started and not waited for, so the build was done
    // while its last output was still to be written.
    const bin = docker(`i=1; while [ $i -le 300 ]; do echo "step $i"; i=$((i+1)); done; ${sleep} 0.2; echo "the last line"`);
    const busy: Promise<unknown>[] = [];
    const res = await buildDerivedImage({
      name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', tag: 'hatchabot-runtime:derived-media', docker: bin, dataDir: join(dir, 'data'),
      onLog: (s) => { if (s.includes('the last line')) busy.push(...busyFileThreads()); },
    });
    const log = readFileSync(join(dir, 'data', 'derived-builds', 'media.log'), 'utf8');
    await Promise.all(busy);
    expect(busy.length).toBeGreaterThan(0);
    expect(res).toEqual({ ok: true });
    const steps = Array.from({ length: 300 }, (_, i) => `step ${i + 1}\n`).join('');
    expect(log).toBe(`${head('hatchabot-runtime:derived-media')}${steps}the last line\n`);
  });

  it.runIf(existsSync(sleep))("a build that ran out of time has its log closed, and what it left running prints nothing into the next build's log", async () => {
    // The first build leaves a part running (as docker leaves its build
    // plugin) that prints after the time limit, while the second is building.
    const bin = docker(`case "$3" in
  *first) ( ${sleep} 1; echo "late output" ) & echo "first build"; exec ${sleep} 5;;
  *) echo "second build"; ${sleep} 1.5; echo "second done";;
esac`);
    const opts = { name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', docker: bin, dataDir: join(dir, 'data') };
    const logPath = join(dir, 'data', 'derived-builds', 'media.log');
    expect(await buildDerivedImage({ ...opts, tag: 'example:first', timeoutMs: 500 })).toEqual({ ok: false, error: 'Build timed out.' });
    expect(readFileSync(logPath, 'utf8')).toBe(`${head('example:first')}first build\n\n[timed out]\n`);
    expect(await buildDerivedImage({ ...opts, tag: 'example:second' })).toEqual({ ok: true });
    expect(readFileSync(logPath, 'utf8')).toBe(`${head('example:second')}second build\nsecond done\n`);
  });

  it.runIf(existsSync('/dev/full'))('a log that fails part-way does not fail the build, nor hold docker up', async () => {
    // Every write to the log is ENOSPC. docker prints more than a pipe holds:
    // were its output left unread, it would wait for ever.
    const bin = docker('i=1; while [ $i -le 5000 ]; do echo "a line of build output that is long enough to fill a pipe $i"; i=$((i+1)); done');
    mkdirSync(join(dir, 'data', 'derived-builds'), { recursive: true });
    symlinkSync('/dev/full', join(dir, 'data', 'derived-builds', 'media.log'));
    const seen: string[] = [];
    const res = await buildDerivedImage({ name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', docker: bin, dataDir: join(dir, 'data'), onLog: (s) => seen.push(s) });
    expect(res).toEqual({ ok: true });
    expect(seen.join('')).toMatch(/pipe 5000\n$/);
  });

  it.runIf(existsSync('/dev/full') && existsSync(sleep))('a log that fails before docker starts does not hold docker up either', async () => {
    // The base is read first: the log's first write has failed by the time
    // docker's output comes, and nothing was there yet to let it go.
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const bin = join(dir, 'bin', 'docker');
    writeFileSync(bin, `#!/bin/sh\ncase "$1" in image) case "$5" in *-check:*) ;; *) ${sleep} 0.3;; esac;; esac\n${CHECKS}\ni=1; while [ $i -le 5000 ]; do echo "a line of build output that is long enough to fill a pipe $i"; i=$((i+1)); done\n`);
    chmodSync(bin, 0o755);
    mkdirSync(join(dir, 'data', 'derived-builds'), { recursive: true });
    symlinkSync('/dev/full', join(dir, 'data', 'derived-builds', 'media.log'));
    const t0 = Date.now();
    const res = await buildDerivedImage({ name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', docker: bin, dataDir: join(dir, 'data'), timeoutMs: 5000 });
    expect(res).toEqual({ ok: true });
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 10_000);

  /** The build contexts a build left in the temp directory. */
  const contexts = (tmp: string) => (existsSync(tmp) ? readdirSync(tmp).filter((n) => n.startsWith('hatchabot-derive-media-')) : []);
  /** Until `ok`, or `ms` have gone by: a build context is removed after the build's outcome, not before. */
  const until = async (ok: () => boolean, ms = 2000) => { for (const t0 = Date.now(); !ok() && Date.now() - t0 < ms;) await new Promise((r) => setTimeout(r, 20)); };
  const withTmp = async (fn: (tmp: string) => Promise<void>) => {
    const tmp = join(dir, 'tmp');
    mkdirSync(tmp);
    const old = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try { await fn(tmp); } finally { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old; }
  };

  it.runIf(existsSync(sleep) && existsSync(tool('mkfifo')))('a build whose log is not being written ends at its time limit all the same (review of HB-1026)', async () => {
    // The log is a pipe that is open and never read: once it is full, no
    // write to it finishes. The build waited for its log to close, for ever.
    const bin = docker(`i=1; while [ $i -le 3000 ]; do echo "a line of build output for a pipe nobody reads $i"; i=$((i+1)); done; exec ${sleep} 5`);
    const logPath = join(dir, 'data', 'derived-builds', 'media.log');
    mkdirSync(join(dir, 'data', 'derived-builds'), { recursive: true });
    execFileSync(tool('mkfifo'), [logPath]);
    const reader = openSync(logPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      const t0 = Date.now();
      const res = await buildDerivedImage({ name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', docker: bin, dataDir: join(dir, 'data'), timeoutMs: 500, logGraceMs: 300 });
      expect(res).toEqual({ ok: false, error: 'Build timed out.' });
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      closeSync(reader); // the write still waiting on the pipe ends with it
    }
  }, 10_000);

  it.runIf(existsSync(sleep) && existsSync(tool('mkfifo')) && existsSync('/proc/self/fd'))("a log let go keeps its file open until the write in flight on it ends (review of HB-1026)", async () => {
    // Closed under that write, its number was free for another file, where
    // the rest of a partial write could land; and a close behind the stuck
    // write held the build up again.
    const openOn = (path: string) => readdirSync('/proc/self/fd').map(Number).filter((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`) === path; } catch { return false; } });
    const bin = docker(`i=1; while [ $i -le 3000 ]; do echo "a line of build output for a pipe nobody reads $i"; i=$((i+1)); done; exec ${sleep} 5`);
    const logPath = join(dir, 'data', 'derived-builds', 'media.log');
    mkdirSync(join(dir, 'data', 'derived-builds'), { recursive: true });
    execFileSync(tool('mkfifo'), [logPath]);
    const reader = openSync(logPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    let open = true;
    try {
      const t0 = Date.now();
      const res = await buildDerivedImage({ name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', docker: bin, dataDir: join(dir, 'data'), timeoutMs: 500, logGraceMs: 300 });
      expect(res).toEqual({ ok: false, error: 'Build timed out.' });
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(openOn(logPath).filter((fd) => fd !== reader)).toHaveLength(1);
      // The write ends (the pipe's reader is gone), and only then the file closes.
      closeSync(reader);
      open = false;
      await until(() => !openOn(logPath).length);
      expect(openOn(logPath)).toEqual([]);
    } finally {
      if (open) closeSync(reader);
    }
  }, 10_000);

  it.runIf(existsSync(tool('cat')))('a derived build is labelled as one, and lays its base packages on before its lines (HB-0986)', async () => {
    const bin = docker(`printf '%s\\n' "$@" > "${join(dir, 'args')}"; ${tool('cat')} "$8/Dockerfile" > "${join(dir, 'Dockerfile')}"`);
    const opts = { name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', docker: bin, dataDir: join(dir, 'data') };
    expect(await buildDerivedImage({ ...opts, basePackages: ['jq'] })).toEqual({ ok: true });
    // And stamped with what it is built from, its base and its lines (HB-1325 review).
    expect(readFileSync(join(dir, 'args'), 'utf8').split('\n').slice(0, 7)).toEqual(['build', '-t', 'hatchabot-runtime-check:derived-media', '--label', 'org.hatchabot.derived=media', '--label', `org.hatchabot.recipe=${recipeStamp('hatchabot-runtime:latest', 'RUN true', ['jq'])}`]);
    // The packages under the lines are in the stamp, whatever their order (HB-1325 review: Change base changes them).
    expect(recipeStamp('hatchabot-runtime:latest', 'RUN true', ['jq'])).not.toBe(recipeStamp('hatchabot-runtime:latest', 'RUN true'));
    expect(recipeStamp('hatchabot-runtime:latest', 'RUN true', ['jq', 'curl'])).toBe(recipeStamp('hatchabot-runtime:latest', 'RUN true', ['curl', 'jq', 'jq']));
    expect(readFileSync(join(dir, 'Dockerfile'), 'utf8')).toBe(renderDockerfile('hatchabot-runtime:latest', 'RUN true', ['jq']));
    // A record's base packages are package names, or nothing is built.
    rmSync(join(dir, 'args'));
    expect(await buildDerivedImage({ ...opts, basePackages: ['jq; curl example.invalid'] })).toEqual({ ok: false, error: 'Its base packages are not all package names.' });
    expect(existsSync(join(dir, 'args'))).toBe(false);
  });

  it('a build that cannot start leaves no build context behind (review of HB-1026)', async () => {
    await withTmp(async (tmp) => {
      // Its logs' folder cannot be made: a file is in the way.
      mkdirSync(join(dir, 'data'));
      writeFileSync(join(dir, 'data', 'derived-builds'), 'not a folder\n');
      await expect(buildDerivedImage({ name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', docker: docker('echo never'), dataDir: join(dir, 'data') })).rejects.toThrow();
      await until(() => !contexts(tmp).length);
      expect(contexts(tmp)).toEqual([]);
      // docker cannot be run at all: spawn throws rather than emitting an error.
      rmSync(join(dir, 'data', 'derived-builds'));
      const res = await buildDerivedImage({ name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', docker: `${join(dir, 'bin', 'docker')}\0`, dataDir: join(dir, 'data') });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^Could not run docker: /);
      await until(() => !contexts(tmp).length);
      expect(contexts(tmp)).toEqual([]);
      expect(readFileSync(join(dir, 'data', 'derived-builds', 'media.log'), 'utf8')).toMatch(/^# building hatchabot-runtime:derived-media\n# FROM hatchabot-runtime:latest\n\n\n\[spawn error\] /);
    });
  });

  it.runIf(existsSync(sleep))("the service stopping ends a derived build under way, with all it started (review of HB-1026)", async () => {
    // docker leads a process group of its own: a stop of the service (launchd,
    // a Ctrl-C) no longer reached it, and a Rebuild after the restart ran
    // beside the build left over.
    const mark = join(dir, 'still-running'), pidFile = join(dir, 'pid');
    docker(`echo $$ > "${pidFile}"; ( ${sleep} 1; echo "built on" > "${mark}" ) & exec ${sleep} 5`);
    const store = new Store(new Database(':memory:'));
    const told: string[] = [];
    const images = createRuntimeImages({
      store, providerFor: () => { throw new Error('no machine in this test'); }, defaultBase: 'hatchabot-runtime:latest', dataDir: join(dir, 'data'),
      notify: async (_owner, body) => { told.push(body); }, log: { info: () => {}, error: () => {} },
    });
    store.upsertDerivedImage({ name: 'media', tag: deriveTag('media'), base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', createdBy: 'owner-a' });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    images.kickImageBuild('media');
    await until(() => existsSync(pidFile) && /^\d+\n$/.test(readFileSync(pidFile, 'utf8')));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    images.stop();
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
    await until(() => !images.isBuilding('media'));
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(mark)).toBe(false);
    // Nobody is told it failed, and the database is left alone: the start after marks it failed.
    expect(told).toEqual([]);
    expect(store.getDerivedImage('media')?.status).toBe('BUILDING');
  }, 10_000);

  it('a stop that comes while the build is being set up ends it before docker starts (review of HB-1026)', async () => {
    // The stop's listener was added only after the build context and the log
    // were made: a stop in that while was never heard, and docker ran on to
    // its time limit.
    const mark = join(dir, 'docker-ran');
    const bin = docker(`echo ran > "${mark}"`);
    const halt = new AbortController();
    const building = buildDerivedImage({ name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', docker: bin, dataDir: join(dir, 'data'), signal: halt.signal });
    halt.abort(); // the build is making its context now
    expect(await building).toEqual({ ok: false, error: 'The build was stopped: the service stopped.' });
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(mark)).toBe(false);
    expect(readFileSync(join(dir, 'data', 'derived-builds', 'media.log'), 'utf8')).toBe(`${head('hatchabot-runtime:derived-media')}\n[stopped: the service stopped]\n`);
  });

  it.runIf(existsSync(sleep))('a build that ran out of time is stopped with all it started (review of HB-1026)', async () => {
    // A part of the build carries on after docker itself is killed (as
    // docker's build plugin did), and would have built on unseen.
    const mark = join(dir, 'still-running');
    const bin = docker(`( ${sleep} 1; echo "built on" > "${mark}" ) & echo "started"; exec ${sleep} 5`);
    const res = await buildDerivedImage({ name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', docker: bin, dataDir: join(dir, 'data'), timeoutMs: 300 });
    expect(res).toEqual({ ok: false, error: 'Build timed out.' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(mark)).toBe(false);
  }, 10_000);
});

describe("a derived build's image is used only if it runs as node, on its base (HB-1032)", () => {
  // Reading the lines as docker would took four rounds and still missed
  // shapes (`${X:-<<}"USER node"` expands to a heredoc that our own last
  // line closes; a FROM hidden in an escape): what the build made is looked
  // at instead.
  let dir: string;
  let was: { PATH?: string; HOME?: string };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hb-derive-user-'));
    was = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = join(dir, 'bin');
    process.env.HOME = dir;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  });
  const TAG = 'hatchabot-runtime:derived-media', BUILT = 'hatchabot-runtime-check:derived-media', BASE = 'hatchabot-runtime:latest';
  const ID = LAYER('c'), LA = LAYER('a');
  const FMT = IMAGE_FACTS_FORMAT;
  /** A made-up docker that notes each command; what it says of the base, of what it built, and of the tag are the test's. No real docker runs. */
  const fake = (o: { build?: string; user?: string; layers?: string; labels?: string; baseLabels?: string; inspect?: string; base?: string; tag?: string; rmi?: string } = {}) => {
    const calls = join(dir, 'calls');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const p = join(dir, 'bin', 'docker');
    writeFileSync(p, `#!/bin/sh
echo "$*" >> "${calls}"
case "$1" in
  build) ${o.build ?? 'echo "built"'};;
  image) case "$5" in
      *-check:*) ${o.inspect ?? `echo '["${ID}",${o.user ?? '"node"'},${o.layers ?? `["${LA}","${ID}"]`},${o.labels ?? 'null'}]'`};;
      *) ${o.base ?? `echo '["${LA}","node",["${LA}"],${o.baseLabels ?? 'null'}]'`};;
    esac;;
  tag) ${o.tag ?? 'exit 0'};;
  rmi) ${o.rmi ?? 'exit 0'};;
esac
`);
    chmodSync(p, 0o755);
    const read = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((l) => l.replace(/ \S*hatchabot-derive-media-\S*$/, ' <context>')) : []);
    return {
      bin: p,
      /** Every command, once the last (`rmi` of the build's name, run after the answer as best it can be) has come. */
      calls: async () => { for (const t0 = Date.now(); !read().some((c) => c.startsWith('rmi ')) && Date.now() - t0 < 2000;) await new Promise((r) => setTimeout(r, 20)); return read(); },
    };
  };
  const build = (bin: string, more: { timeoutMs?: number; signal?: AbortSignal; nameGraceMs?: number } = {}) =>
    buildDerivedImage({ name: 'media', base: BASE, dockerfile: 'RUN true', tag: TAG, docker: bin, dataDir: join(dir, 'data'), ...more });
  const log = () => readFileSync(join(dir, 'data', 'derived-builds', 'media.log'), 'utf8');
  const READ_BASE = `image inspect --format ${FMT} ${BASE}`, BUILD = `build -t ${BUILT} --label org.hatchabot.derived=media --label org.hatchabot.recipe=${recipeStamp(BASE, 'RUN true')} <context>`, CHECK = `image inspect --format ${FMT} ${BUILT}`;

  it("builds to a name of its own, never listed or pinned, one per record's tag", () => {
    expect(checkTag(TAG)).toBe(BUILT);
    expect(checkTag('registry.example:5000/runtime:derived-x')).toBe('registry.example:5000/runtime-check:derived-x');
    expect(checkTag('registry.example:5000/runtime')).toBe('registry.example:5000/runtime-check');
  });

  it("an image that runs as node on its base takes the record's tag, by the id that was looked at, and the name it was built to goes", async () => {
    const d = fake();
    expect(await build(d.bin)).toEqual({ ok: true });
    expect(await d.calls()).toEqual([READ_BASE, BUILD, CHECK, `tag ${ID} ${TAG}`, `rmi ${BUILT}`]);
    expect(log()).toBe(`# building ${TAG}\n# FROM ${BASE}\n\nbuilt\n`);
  });

  it.each([['""', 'root'], ['"root"', 'root'], ['"0:0"', 'root'], ['"app"', '"app"']])("an image that runs as %s is not used, and the record's tag is left on the image it had", async (user, who) => {
    const d = fake({ user });
    const error = `The built image would run as ${who}, not node: a line in it hides the USER node Hatchabot adds at the end (a heredoc that runs to the end, for example). Change the lines and Rebuild.`;
    expect(await build(d.bin)).toEqual({ ok: false, error });
    expect(await d.calls()).toEqual([READ_BASE, BUILD, CHECK, `rmi ${BUILT}`]);
    expect((await d.calls()).some((c) => c.includes(TAG))).toBe(false);
    expect(log()).toBe(`# building ${TAG}\n# FROM ${BASE}\n\nbuilt\n\n[${error}]\n`);
  });

  it.each([
    ['another image under it', `["${LAYER('9')}","${ID}"]`],
    ['only some of it', `["${ID}"]`],
    ['its base\'s layers after others', `["${LAYER('9')}","${LA}","${ID}"]`],
  ])("an image not built on its base (%s) is not used: a FROM hidden in the lines", async (_what, layers) => {
    const d = fake({ layers });
    const error = `The built image is not built on ${BASE}: a line in it starts another image (a FROM hidden in a heredoc or an escape). Change the lines and Rebuild.`;
    expect(await build(d.bin)).toEqual({ ok: false, error });
    expect(await d.calls()).toEqual([READ_BASE, BUILD, CHECK, `rmi ${BUILT}`]);
  });

  const BASE_LABELS = '{"org.hatchabot.build-inputs":"v1;openclaw=2026.9.8","org.agentclaw.openclaw-version":"2026.9.8","maintainer":"x"}';
  it.each([
    ['one of its base\'s, changed', '{"org.hatchabot.build-inputs":"v1;openclaw=2026.10.1","org.agentclaw.openclaw-version":"2026.9.8","org.hatchabot.derived":"media"}', 'org.hatchabot.build-inputs'],
    ['one its base does not have', '{"org.hatchabot.build-inputs":"v1;openclaw=2026.9.8","org.agentclaw.openclaw-version":"2026.9.8","org.hatchabot.extra-packages":"jq"}', 'org.hatchabot.extra-packages'],
    ['one of the old name, changed', '{"org.hatchabot.build-inputs":"v1;openclaw=2026.9.8","org.agentclaw.openclaw-version":"2026.10.1"}', 'org.agentclaw.openclaw-version'],
    ['one in capitals', '{"org.hatchabot.build-inputs":"v1;openclaw=2026.9.8","org.agentclaw.openclaw-version":"2026.9.8","ORG.HATCHABOT.BUILD-INPUTS":"x"}', 'ORG.HATCHABOT.BUILD-INPUTS'],
    ["one its agents' containers carry", '{"org.hatchabot.build-inputs":"v1;openclaw=2026.9.8","org.agentclaw.openclaw-version":"2026.9.8","hatchabot.console-port":"18789"}', 'hatchabot.console-port'],
    ["one its agents' containers carry, under a key not shown as it is", '{"org.hatchabot.build-inputs":"v1;openclaw=2026.9.8","org.agentclaw.openclaw-version":"2026.9.8","hatchabot.console port":"18789"}', 'hatchabot.…'],
    ['one of the old name, under a key not shown as it is', '{"org.hatchabot.build-inputs":"v1;openclaw=2026.9.8","org.agentclaw.openclaw-version":"2026.9.8","org.agentclaw.a b":"1"}', 'org.agentclaw.…'],
  ])("an image a line set one of Hatchabot's own labels in (%s) is not used (HB-0986 review)", async (_what, labels, key) => {
    const d = fake({ labels, baseLabels: BASE_LABELS });
    const error = `The built image sets Hatchabot's own label ${key}: a line in it hides a LABEL (in a heredoc or an escape). Change the lines and Rebuild.`;
    expect(await build(d.bin)).toEqual({ ok: false, error });
    expect(await d.calls()).toEqual([READ_BASE, BUILD, CHECK, `rmi ${BUILT}`]);
  });

  it("the owner's own labels, the base's, and the one Hatchabot sets on the build leave it used (HB-0986 review)", async () => {
    const d = fake({ labels: '{"org.hatchabot.build-inputs":"v1;openclaw=2026.9.8","org.agentclaw.openclaw-version":"2026.9.8","maintainer":"y","org.example.version":"5","org.example.hatchabot.kind":"media","org.hatchabot.derived":"media"}', baseLabels: BASE_LABELS });
    expect(await build(d.bin)).toEqual({ ok: true });
  });

  it('the base as it was read before the build is the one it must be built on: a base moved meanwhile is refused, never taken', async () => {
    // :latest promoted while the build ran: the image is built on the new one.
    const d = fake({ layers: `["${LAYER('d')}","${ID}"]` });
    expect((await build(d.bin)).error).toMatch(/^The built image is not built on hatchabot-runtime:latest: /);
  });

  it.each([
    ['docker cannot say', 'echo "Error: No such image" >&2; exit 1', /could not be checked, so it is not used: Error: No such image\. Rebuild to try again\.$/],
    ['its answer is not what was asked', "echo 'node'", /could not be checked, so it is not used: docker image inspect answered "node"\. Rebuild/],
    ['its answer is no user at all', `echo '["${ID}",null,["${LA}"],null]'`, /could not be checked/],
  ])('an image not seen to run as node is not used: %s', async (_what, inspect, error) => {
    const d = fake({ inspect });
    const res = await build(d.bin);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(error);
    const calls = await d.calls();
    expect(calls.filter((c) => c.startsWith('tag '))).toEqual([]);
    expect(calls.at(-1)).toBe(`rmi ${BUILT}`);
  });

  it('a base that cannot be read builds nothing', async () => {
    const d = fake({ base: 'echo "Cannot connect to the Docker daemon" >&2; exit 1' });
    expect(await build(d.bin)).toEqual({ ok: false, error: `The base ${BASE} could not be read, so nothing was built: Cannot connect to the Docker daemon. Rebuild to try again.` });
    const calls = await d.calls();
    expect(calls).toEqual([READ_BASE]);
  });

  it("a tag that fails leaves the record's tag as it was, and the build's name goes", async () => {
    const d = fake({ tag: 'echo "Error: no space left on device" >&2; exit 1' });
    expect(await build(d.bin)).toEqual({ ok: false, error: `The built image could not be named ${TAG}: Error: no space left on device.` });
    expect((await d.calls()).at(-1)).toBe(`rmi ${BUILT}`);
  });

  it.runIf(existsSync(tool('sleep')))("the check is under the build's time limit, and stopped with all it started", async () => {
    const d = fake({ inspect: `exec ${tool('sleep')} 5` });
    const t0 = Date.now();
    expect(await build(d.bin, { timeoutMs: 500 })).toEqual({ ok: false, error: 'Build timed out.' });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(readFileSync(join(dir, 'calls'), 'utf8')).not.toMatch(/^tag /m);
  }, 10_000);

  it('a Rebuild whose image runs as root fails, and its owner is told why', async () => {
    const d = fake({ user: '""' });
    const store = new Store(new Database(':memory:'));
    const told: string[] = [];
    const images = createRuntimeImages({
      store, providerFor: () => { throw new Error('no machine in this test'); }, defaultBase: BASE, dataDir: join(dir, 'data'),
      notify: async (_owner, body) => { told.push(body); }, log: { info: () => {}, error: () => {} },
    });
    store.upsertDerivedImage({ name: 'media', tag: TAG, base: BASE, dockerfile: 'RUN true', createdBy: 'owner-a' });
    store.setDerivedImageStatus('media', 'READY');
    images.kickImageBuild('media');
    for (const t0 = Date.now(); images.isBuilding('media') && Date.now() - t0 < 3000;) await new Promise((r) => setTimeout(r, 20));
    expect(store.getDerivedImage('media')).toMatchObject({ status: 'FAILED' });
    expect(JSON.stringify(store.getDerivedImage('media'))).toContain('would run as root, not node');
    // Said as the reason, not quoted as docker's output: docker built it without a word of complaint.
    expect(told).toEqual(['The derived image "media" FAILED to build: The built image would run as root, not node: a line in it hides the USER node Hatchabot adds at the end (a heredoc that runs to the end, for example). Change the lines and Rebuild.']);
    expect((await d.calls()).some((c) => c.includes(TAG))).toBe(false);
  });

  /** Until the made-up docker has been asked to `what` (a command's first word). */
  const asked = async (what: string) => { for (const t0 = Date.now(); !(existsSync(join(dir, 'calls')) && readFileSync(join(dir, 'calls'), 'utf8').split('\n').some((c) => c.startsWith(`${what} `))) && Date.now() - t0 < 5000;) await new Promise((r) => setTimeout(r, 10)); };
  const sleep = tool('sleep');

  it.runIf(existsSync(sleep))('a stop while a checked image is being named lets that end, and the build is told as it is (review of e6a219f4)', async () => {
    // Killed while naming it, the tag might have moved or not, and the build
    // was told stopped with the checked image under the tag.
    const d = fake({ tag: `${sleep} 0.5` });
    const stop = new AbortController();
    const building = build(d.bin, { signal: stop.signal });
    await asked('tag');
    stop.abort();
    expect(await building).toEqual({ ok: true });
    expect((await d.calls()).slice(-2)).toEqual([`tag ${ID} ${TAG}`, `rmi ${BUILT}`]);
  }, 10_000);

  it.runIf(existsSync(sleep))('a time limit that comes while a checked image is being named lets that end too', async () => {
    const d = fake({ tag: `${sleep} 2` });
    expect(await build(d.bin, { timeoutMs: 1000 })).toEqual({ ok: true });
    expect(await d.calls()).toContain(`tag ${ID} ${TAG}`);
  }, 10_000);

  it.runIf(existsSync(sleep))('a naming that does not end is ended after its grace, with all it started', async () => {
    const d = fake({ tag: `exec ${sleep} 5` });
    const stop = new AbortController();
    const t0 = Date.now();
    const building = build(d.bin, { signal: stop.signal, nameGraceMs: 300 });
    await asked('tag');
    stop.abort();
    expect(await building).toEqual({ ok: false, error: 'The build was stopped: the service stopped.' });
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 10_000);

  it.runIf(existsSync(sleep))("once named, the build is told done: its own name's removal is as best it can be", async () => {
    for (const rmi of [`exec ${sleep} 3`, 'echo "Error: conflict" >&2; exit 1']) {
      rmSync(join(dir, 'calls'), { force: true });
      const d = fake({ rmi });
      const t0 = Date.now();
      expect(await build(d.bin, { timeoutMs: 1000 })).toEqual({ ok: true });
      expect(Date.now() - t0).toBeLessThan(2000);
      expect((await d.calls()).at(-1)).toBe(`rmi ${BUILT}`);
    }
  }, 15_000);

  it.runIf(existsSync(sleep))('the service stopping after the image took its tag leaves its record READY, not failed at the next start', async () => {
    const d = fake({ tag: `${sleep} 0.5` });
    const store = new Store(new Database(':memory:'));
    const images = createRuntimeImages({
      store, providerFor: () => { throw new Error('no machine in this test'); }, defaultBase: BASE, dataDir: join(dir, 'data'),
      notify: async () => {}, log: { info: () => {}, error: () => {} },
    });
    store.upsertDerivedImage({ name: 'media', tag: TAG, base: BASE, dockerfile: 'RUN true', createdBy: 'owner-a' });
    images.kickImageBuild('media');
    await asked('tag');
    images.stop();
    for (const t0 = Date.now(); images.isBuilding('media') && Date.now() - t0 < 5000;) await new Promise((r) => setTimeout(r, 20));
    expect(store.getDerivedImage('media')?.status).toBe('READY');
    expect(await d.calls()).toContain(`tag ${ID} ${TAG}`);
  }, 10_000);

  it("a build docker fails is told with docker's last output, quoted as that", async () => {
    fake({ build: 'echo "E: Unable to locate package ffmpeg-full"; exit 100' });
    const store = new Store(new Database(':memory:'));
    const told: string[] = [];
    const images = createRuntimeImages({
      store, providerFor: () => { throw new Error('no machine in this test'); }, defaultBase: BASE, dataDir: join(dir, 'data'),
      notify: async (_owner, body) => { told.push(body); }, log: { info: () => {}, error: () => {} },
    });
    store.upsertDerivedImage({ name: 'media', tag: TAG, base: BASE, dockerfile: 'RUN true', createdBy: 'owner-a' });
    images.kickImageBuild('media');
    for (const t0 = Date.now(); images.isBuilding('media') && Date.now() - t0 < 3000;) await new Promise((r) => setTimeout(r, 20));
    expect(told).toEqual(['The derived image "media" FAILED to build. Its last output: "E: Unable to locate package ffmpeg-full"']);
    expect(await build(join(dir, 'bin', 'docker'))).toEqual({ ok: false, error: 'E: Unable to locate package ffmpeg-full', fromDocker: true });
  });
});

describe('build logs are capped, and a few kept (HB-1190)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hb-build-logs-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const small = { cap: 2000, head: 200, keep: 600, kept: 3 };
  const write = async (path: string, chunks: string[], limits = small) => {
    const log = openBuildLog(path, limits);
    const closed = new Promise((r) => log.once('close', r));
    for (const c of chunks) if (!log.write(c)) await new Promise((r) => log.once('drain', r));
    log.end();
    await closed;
  };

  it('a log past its cap keeps its first lines, its last ones, and says how much is left out between', async () => {
    const p = join(dir, 'x.log');
    for (const count of [100, 2000]) {
      const lines = Array.from({ length: count }, (_, i) => `line ${i + 1} of the build\n`);
      await write(p, lines);
      const all = lines.join('');
      const log = readFileSync(p, 'utf8');
      expect(log.length, `${count}`).toBeLessThanOrEqual(small.cap);
      const m = /^([^]*?)\n\[\.\.\. (\d+) bytes of output left out here: [^\n]*\]\n\n([^]*)$/.exec(log)!;
      expect(m, log).toBeTruthy();
      const [, first, left, last] = m;
      // Whole lines: the first ones, up to `head` bytes, and the last ones, `keep` bytes or so.
      expect(first).toMatch(/\n$/);
      expect(all.startsWith(first!)).toBe(true);
      expect(first!.length).toBeLessThanOrEqual(small.head);
      expect(first!.length).toBeGreaterThan(small.head - 30);
      expect(all.endsWith(`\n${last}`)).toBe(true);
      expect(last!.length).toBeGreaterThan(small.keep - 30);
      expect(Number(left)).toBe(all.length - first!.length - last!.length);
    }
    // Output in many small pieces (a progress line at a time) ends the same way.
    const text = Array.from({ length: 1500 }, (_, i) => `step ${i + 1}\n`).join('');
    await write(p, text.match(/[^]{1,3}/g)!, { cap: 6000, head: 100, keep: 2500, kept: 3 });
    const log = readFileSync(p, 'utf8');
    expect(log.length).toBeLessThanOrEqual(6000);
    expect(log).toMatch(/^step 1\n[^]*\n\[\.\.\. \d+ bytes of output left out here[^]*\nstep 1500\n$/);
    expect(text.endsWith(log.slice(log.lastIndexOf(']\n\n') + 3))).toBe(true);
    // A log that stays under its cap is as it came.
    await write(p, ['a short build\n', 'done\n']);
    expect(readFileSync(p, 'utf8')).toBe('a short build\ndone\n');
  });

  it('a log whose first lines have no line end is cut on a whole character (review of HB-1190)', async () => {
    // Its first `head` bytes end inside a three-byte character: the log kept
    // two bytes of it, and showed a broken character where they stop.
    const p = join(dir, 'x.log');
    const lines = ['€'.repeat(400) + '\n', ...Array.from({ length: 200 }, (_, i) => `line ${i + 1} of the build\n`)];
    await write(p, lines);
    const bytes = readFileSync(p);
    const log = bytes.toString('utf8');
    expect(Buffer.from(log, 'utf8').equals(bytes)).toBe(true); // nothing in it is a broken character
    const m = /^(€*)\n\[\.\.\. (\d+) bytes of output left out here: [^\n]*\]\n\n([^]*)$/.exec(log)!;
    expect(m, log).toBeTruthy();
    expect(m[1]).toBe('€'.repeat(66)); // 198 of the first 200 bytes
    const all = Buffer.from(lines.join(''));
    expect(Number(m[2])).toBe(all.length - 198 - Buffer.byteLength(m[3]!));
    expect(lines.join('').endsWith(m[3]!)).toBe(true);
  });

  it('a build printing a few bytes at a time holds a bounded number of pieces of its output (review of HB-1190)', async () => {
    const p = join(dir, 'x.log');
    const log = openBuildLog(p, { cap: 20_000, head: 100, keep: 8192, kept: 3 });
    const held = () => (log as unknown as { heldPieces: number }).heldPieces;
    const closed = new Promise((r) => log.once('close', r));
    const chunks = Array.from({ length: 12_000 }, (_, i) => `${i % 10}${i % 7}\n`);
    // Counted as each chunk is written.
    let most = 0;
    for (const c of chunks) log.write(c, () => { most = Math.max(most, held()); });
    log.end();
    await closed;
    // A piece per chunk was about 2,700 of them (8192 / 3); joined, never more than 1,000 and a few.
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThan(1100);
    // And the log's end is as it came, the chunks not yet joined with it.
    const text = chunks.join('');
    const out = readFileSync(p, 'utf8');
    expect(out.length).toBeLessThanOrEqual(20_000);
    const tail = out.slice(out.lastIndexOf(']\n\n') + 3);
    expect(tail.length).toBeGreaterThan(8192 - 30);
    expect(text.endsWith(tail)).toBe(true);
  });

  it("each build moves the one before aside, and an image's oldest log goes", async () => {
    const p = join(dir, 'media.log');
    for (const n of [1, 2, 3, 4]) await write(p, [`build ${n}\n`]);
    expect(readFileSync(p, 'utf8')).toBe('build 4\n');
    expect(readFileSync(`${p}.1`, 'utf8')).toBe('build 3\n');
    expect(readFileSync(`${p}.2`, 'utf8')).toBe('build 2\n');
    expect(existsSync(`${p}.3`)).toBe(false);
  });

  it.runIf(existsSync(tool('yes')) && existsSync(tool('head')))('a derived build that prints more than its cap leaves a log under it, with its last lines', async () => {
    const was = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = join(dir, 'bin');
    process.env.HOME = dir;
    try {
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin', 'docker'), `#!/bin/sh\n${CHECKS}\n${tool('yes')} "#7 3.21 Unpacking a package of the build" | ${tool('head')} -n 150000\necho "Successfully tagged"\n`);
      chmodSync(join(dir, 'bin', 'docker'), 0o755);
      const res = await buildDerivedImage({ name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', docker: join(dir, 'bin', 'docker'), dataDir: join(dir, 'data') });
      expect(res).toEqual({ ok: true });
      const p = join(dir, 'data', 'derived-builds', 'media.log');
      expect(statSync(p).size).toBeLessThanOrEqual(4 * 2 ** 20); // BUILD_LOG.cap
      const log = readFileSync(p, 'utf8');
      expect(log).toMatch(/^# building hatchabot-runtime:derived-media\n# FROM hatchabot-runtime:latest\n\n#7 3\.21 Unpacking/);
      expect(log).toMatch(/Unpacking a package of the build\nSuccessfully tagged\n$/);
    } finally {
      for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }, 20_000);

  it("deleting a derived image deletes its build logs", async () => {
    const was = process.env.HATCHABOT_DB;
    process.env.HATCHABOT_DB = join(dir, 'hatchabot.sqlite');
    try {
      const { store, f } = await world();
      store.upsertDerivedImage({ name: 'media', tag: deriveTag('media'), base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', createdBy: OWNER });
      store.setDerivedImageStatus('media', 'READY');
      mkdirSync(join(dir, 'derived-builds'));
      const logs = ['media.log', 'media.log.1', 'media.log.2'].map((n) => join(dir, 'derived-builds', n));
      for (const p of [...logs, join(dir, 'derived-builds', 'other.log')]) writeFileSync(p, 'made-up build output\n');
      expect((await f.inject({ method: 'DELETE', url: '/v1/images/media', headers: H(OWNER) })).statusCode).toBe(200);
      expect(logs.filter((p) => existsSync(p))).toEqual([]);
      expect(existsSync(join(dir, 'derived-builds', 'other.log'))).toBe(true);
      await f.close();
    } finally {
      if (was === undefined) delete process.env.HATCHABOT_DB; else process.env.HATCHABOT_DB = was;
    }
  });
});

describe('a build log is read from its end (HB-0884)', () => {
  it('readLogTail gives what the whole read gave, for any mix of characters and any window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-log-tail-'));
    try {
      const p = join(dir, 'x.log');
      for (const text of ['', 'ab', 'é'.repeat(100), `step 1\n${'a😀é\n'.repeat(5000)}done ✓`, 'x'.repeat(70_000)]) {
        writeFileSync(p, text);
        for (const chars of [1, 5, 6, 7, 16_000]) expect(await readLogTail(p, chars), `${text.length}/${chars}`).toBe(text.slice(-chars));
      }
      await expect(readLogTail(join(dir, 'none.log'), 10)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a log larger than a whole read can take still shows its end, for the base build and a derived image', async (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-log-big-'));
    const was = process.env.HATCHABOT_DB;
    process.env.HATCHABOT_DB = join(dir, 'hatchabot.sqlite');
    try {
      mkdirSync(join(dir, 'derived-builds'));
      // 3 GiB of nothing (sparse: no disk is used), then the build's last lines.
      // Read whole, it is past what one read may hold, and every poll paid for all of it.
      const big = (name: string, last: string) => {
        const fd = openSync(join(dir, 'derived-builds', `${name}.log`), 'w');
        try { writeSync(fd, last, 3 * 2 ** 30); } finally { closeSync(fd); }
        return statSync(join(dir, 'derived-builds', `${name}.log`));
      };
      if (big('_base', '#12 DONE 4.2s\nBuilt the image\n').blocks * 512 > 64 * 2 ** 20) ctx.skip(); // a filesystem with no sparse files
      big('media', 'Step 3/3 : USER node\nSuccessfully tagged\n');
      const { store, f } = await world();
      store.upsertDerivedImage({ name: 'media', tag: deriveTag('media'), base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', createdBy: OWNER });
      store.setDerivedImageStatus('media', 'READY');
      const base = await f.inject({ method: 'GET', url: '/v1/runtime/build', headers: H(OWNER) });
      expect(base.statusCode).toBe(200);
      expect(base.json().log).toMatch(/Built the image\n$/);
      expect(base.json().log.length).toBe(16_000);
      const derived = await f.inject({ method: 'GET', url: '/v1/images/media/log', headers: H(OWNER) });
      expect(derived.statusCode, derived.body).toBe(200);
      expect(derived.json().log).toMatch(/Successfully tagged\n$/);
      expect(derived.json().log.length).toBe(20_000);
      await f.close();
    } finally {
      if (was === undefined) delete process.env.HATCHABOT_DB; else process.env.HATCHABOT_DB = was;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
