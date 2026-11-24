import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { createAgentHome } from '../src/orchestrator/files/agentHome.js';
import { MAX_FILE_BYTES } from '../src/orchestrator/files/snapshots.js';
import { RUNTIME_STATE_FILES, catArgv, cleanFileName, cleanRelPath, downloadName, duShell, inlineType, listShell, parseListing, putArgv, tarArgv, uploadAllowed } from '../src/orchestrator/files/agentFiles.js';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Browsing and downloading an agent's files: read-only, owner-only, paths
 * cleaned before a shell sees them and resolved again inside the one-shot.
 */
describe('paths the owner may ask for', () => {
  it('cleans a relative path and refuses anything that could leave the home', () => {
    expect(cleanRelPath(undefined)).toBe('');
    expect(cleanRelPath('')).toBe('');
    expect(cleanRelPath('/out//report.pdf')).toBe('out/report.pdf');
    expect(cleanRelPath('./a/./b/')).toBe('a/b');
    expect(cleanRelPath('../etc/passwd')).toBeUndefined();
    expect(cleanRelPath('a/../../x')).toBeUndefined();
    expect(cleanRelPath('a\0b')).toBeUndefined();
    expect(cleanRelPath('x'.repeat(2000))).toBeUndefined();
    expect(cleanRelPath(42)).toBeUndefined();
  });
  it('every shell resolves the real path and checks it is under the home before doing anything', () => {
    for (const sh of [listShell('out'), catArgv("it's").join(' '), tarArgv('a b').join(' ')]) {
      expect(sh).toContain('realpath -e');
      expect(sh).toContain('/home/node|/home/node/*');
    }
    // A quote in the name cannot end the quoting.
    expect(catArgv("it's")[2]).toContain(`'/home/node/it'\\''s'`);
  });
  it('parses a listing and names a download', () => {
    const rows = parseListing("d\t4096\t1790000000.5\tout\0f\t120\t1790000100\tnotes.md\0l\t9\t1790000200\tlink\0\0");
    expect(rows.map((r) => [r.name, r.type, r.size])).toEqual([['link', 'link', 9], ['notes.md', 'file', 120], ['out', 'dir', 4096]]);
    expect(rows[2]!.mtime).toBe(new Date(1790000000500).toISOString());
    expect(downloadName('out/report v2.pdf', 'slug')).toBe('report_v2.pdf');
    expect(downloadName('', 'to-do-agent')).toBe('to-do-agent');
  });
  it('a large folder sorts by one collator made once, in the order it always had (HB-1019)', () => {
    const names = Array.from({ length: 3000 }, (_, i) => `${i % 3 ? 'Log' : 'log'}-${(i * 7919) % 3000}.txt`);
    const listing = names.map((n, i) => `f\t${i}\t1790000000\t${n}`).join('\0') + '\0';
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare');
    let rows: ReturnType<typeof parseListing>;
    try {
      rows = parseListing(listing);
      expect(localeCompare).not.toHaveBeenCalled();
    } finally { localeCompare.mockRestore(); }
    const before = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    expect(rows.map((r) => r.name)).toEqual(before);
    expect(parseListing('f\t1\t1\tb10\0f\t1\t1\tB9\0f\t1\t1\ta2\0').map((r) => r.name)).toEqual(['a2', 'B9', 'b10']);
  });
  it('a time a Date cannot hold leaves that entry without one; the folder still lists (#71)', () => {
    const rows = parseListing('f\t1\t1e300\tfar-future.txt\0f\t2\t1790000100\tnotes.md\0');
    expect(rows.map((r) => [r.name, r.mtime])).toEqual([['far-future.txt', ''], ['notes.md', new Date(1790000100000).toISOString()]]);
  });
});

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  store.setAgentRuntimeRef('a1', runtimeRef); store.setAgentState('a1', 'RUNNING'); store.setAgentState('a1', 'STOPPED');
  const f = Fastify();
  await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never, providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never } as never);
  return { store, provider, f };
}

describe('GET /v1/agents/:id/fs', () => {
  it('says the volume is gone when it is, for a listing, a download and an upload (HB-0373)', async () => {
    const { f, provider, store } = await world();
    provider.goneVolumes.add(store.getAgent('a1')!.runtimeRef!);
    for (const r of [
      await f.inject({ method: 'GET', url: '/v1/agents/a1/fs', headers: as }),
      await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=out/hi.txt', headers: as }),
      await f.inject({ method: 'PUT', url: '/v1/agents/a1/fs/file?path=out&name=hi.txt', headers: { ...as, 'content-type': 'application/octet-stream' }, payload: Buffer.from('hi') }),
    ]) {
      expect(r.statusCode).toBe(404);
      expect(r.json().error).toMatch(/volume is gone/);
    }
    expect(provider.written).toEqual([]);
    await f.close();
  });

  it('lists a folder from a read-only one-shot, even while the agent is stopped', async () => {
    const { f, provider } = await world();
    provider.execResponses.set('sh-volume', { code: 0, stdout: "d\t4096\t1790000000\tout\0f\t7\t1790000001\thi.txt\0", stderr: '' });
    const r = await f.inject({ method: 'GET', url: '/v1/agents/a1/fs?path=/out/', headers: as });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ path: 'out', entries: [{ name: 'hi.txt', type: 'file', size: 7 }, { name: 'out', type: 'dir' }] });
    expect(provider.execLog.at(-1)![1]).toContain("realpath -e '/home/node/out'");
  });
  it('refuses an escaping path, says so when the one-shot finds nothing, and hides other people\'s agents', async () => {
    const { f, provider } = await world();
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/fs?path=../../etc', headers: as })).statusCode).toBe(400);
    provider.execResponses.set('sh-volume', { code: 2, stdout: '', stderr: '' });
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/fs?path=nope', headers: as })).statusCode).toBe(404);
    provider.execResponses.set('sh-volume', { code: 3, stdout: '', stderr: '' });
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/fs?path=link-out', headers: as })).statusCode).toBe(400);
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/fs', headers: { 'x-hatchabot-owner': 'someone-else' } })).statusCode).toBe(404);
  });
});

describe('downloads', () => {
  it('preserves newlines in selected paths across file reads, uploads and folder archives', () => {
    const home = mkdtempSync(join(tmpdir(), 'hb-path-newline-'));
    const bin = join(home, 'bin'); mkdirSync(bin);
    try {
      for (const tool of ['sh', 'realpath', 'cat', 'du', 'cut', 'dirname', 'basename', 'tar', 'gzip', 'od', 'tr', 'mv', 'rm']) symlinkSync('/usr/bin/' + tool, join(bin, tool));
      const env = { HOME: home, PATH: bin, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
      const run = (argv: string[], input?: string) => spawnSync(join(bin, argv[0]!), argv.slice(1).map(arg => arg.replaceAll('/home/node', home)), { env, input });
      writeFileSync(join(home, 'notes.txt'), 'other file');
      writeFileSync(join(home, 'notes.txt\n'), 'selected file');
      const read = run(catArgv('notes.txt\n'));
      expect(read.status).toBe(0);
      expect(read.stdout.toString()).toBe('selected file');
      mkdirSync(join(home, 'out'));
      mkdirSync(join(home, 'out\n'));
      writeFileSync(join(home, 'out', 'notes.txt'), 'other folder');
      writeFileSync(join(home, 'out\n', 'notes.txt'), 'selected folder');
      const upload = run(putArgv('out\n', 'uploaded.txt', true, 'kitchen'), 'new upload');
      expect(upload.status).toBe(0);
      expect(readdirSync(join(home, 'out'))).toEqual(['notes.txt']);
      expect(readFileSync(join(home, 'out\n', 'uploaded.txt'), 'utf8')).toBe('new upload');
      const size = run(['sh', '-c', duShell('out\n')]);
      expect(size.status).toBe(0);
      expect(size.stdout.toString()).toMatch(/^\d+\n$/);
      const archive = run(tarArgv('out\n'));
      expect(archive.status).toBe(0);
      const extracted = spawnSync(join(bin, 'tar'), ['xzOf', '-', 'out\n/notes.txt'], { env, input: archive.stdout });
      expect(extracted.status).toBe(0);
      expect(extracted.stdout.toString()).toBe('selected folder');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('folder preflight rejects files and failed size measurements before offering a download', () => {
    const home = mkdtempSync(join(tmpdir(), 'hb-folder-check-'));
    const bin = join(home, 'bin'); mkdirSync(bin);
    try {
      for (const tool of ['sh', 'realpath', 'cut', 'du']) symlinkSync('/usr/bin/' + tool, join(bin, tool));
      mkdirSync(join(home, 'out'));
      writeFileSync(join(home, 'notes.md'), 'a file, not a folder');
      const run = (rel: string) => spawnSync(join(bin, 'sh'), ['-c', duShell(rel).replaceAll('/home/node', home)],
        { encoding: 'utf8', env: { HOME: home, PATH: bin, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
      expect(run('out').status).toBe(0);
      expect(run('notes.md').status).toBe(4);
      // du can emit a partial total and fail when one child cannot be read.
      rmSync(join(bin, 'du'));
      writeFileSync(join(bin, 'du'), '#!/bin/sh\nprintf "12\\tpartial-folder\\n"\nexit 1\n', { mode: 0o755 });
      const partial = run('out');
      expect(partial.status).not.toBe(0);
      expect(partial.stdout).toBe('');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('streams a file with its size, as an attachment', async () => {
    const { f, provider } = await world();
    provider.execResponses.set('sh-volume', { code: 0, stdout: 'regular file\t5\n', stderr: '' });
    provider.streamBytes = Buffer.from('hello');
    const r = await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=out/hi.txt', headers: as });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="hi.txt"');
    expect(r.headers['content-length']).toBe('5');
    expect(r.body).toBe('hello');
    expect(provider.execLog.at(-1)![1]).toContain('exec head -c 5');
  });
  it('check=1 says whether it may be read, by what the download checks first: 204, and none of its bytes', async () => {
    const { f, provider } = await world();
    provider.execResponses.set('sh-volume', { code: 0, stdout: 'regular file\t5\n', stderr: '' });
    provider.streamBytes = Buffer.from('hello');
    const before = provider.execLog.length;
    const r = await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=out/report.pdf&inline=1&check=1', headers: as });
    expect([r.statusCode, r.body]).toEqual([204, '']);
    // Its size and kind asked, as a download's are; nothing streamed.
    expect(provider.execLog.slice(before).map(([kind]) => kind)).toEqual(['sh-volume']);
    // Gone: the download's 404. Over HATCHABOT_FILE_MAX_MB: the download's own refusal, which the page says.
    provider.execResponses.set('sh-volume', { code: 2, stdout: '', stderr: '' });
    const gone = await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=out/gone.pdf&check=1', headers: as });
    expect([gone.statusCode, gone.json().error]).toEqual([404, 'No such file or folder.']);
    provider.execResponses.set('sh-volume', { code: 0, stdout: `regular file\t${600 * 1024 * 1024}\n`, stderr: '' });
    const big = await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=out/huge.pdf&inline=1&check=1', headers: as });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toMatch(/^Too big to download here \(600 MB; the limit is 512 MB — HATCHABOT_FILE_MAX_MB\)\.$/);
    expect(provider.execLog.filter(([kind]) => kind === 'stream')).toEqual([]);
    provider.execResponses.set('sh-volume', { code: 0, stdout: 'regular file\t5\n', stderr: '' });
    // Still the owner's alone, and still a path inside the agent.
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=out/report.pdf&check=1', headers: { 'x-hatchabot-owner': 'someone-else' } })).statusCode).toBe(404);
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=../x&check=1', headers: as })).statusCode).toBe(400);
    // Without it, the same path reads the file.
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=out/report.pdf&inline=1', headers: as })).body).toBe('hello');
  });
  it('a file that shrank between its size and its bytes does not end a short body as if complete (review R23)', async () => {
    const { f, provider } = await world();
    provider.execResponses.set('sh-volume', { code: 0, stdout: 'regular file\t100\n', stderr: '' });
    provider.streamBytes = Buffer.from('short'); // 5 of the 100 bytes announced
    // The response is destroyed, not ended: a client sees a broken download, never a complete one.
    await expect(f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=out/log.txt', headers: as })).rejects.toThrow(/destroyed before completion/);
    expect(provider.execLog.at(-1)![1]).toContain('exec head -c 100');
  });
  it('a folder comes as .tar.gz; a file asked for as a folder (or the reverse) is refused; too big is refused before a byte', async () => {
    const { f, provider } = await world();
    provider.execResponses.set('sh-volume', { code: 0, stdout: '12345\n', stderr: '' });
    provider.streamBytes = Buffer.from('gz');
    const r = await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/archive?path=out', headers: as });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="out.tar.gz"');
    expect(provider.execLog.at(-1)![1]).toContain('exec tar cz');
    provider.execResponses.set('sh-volume', { code: 0, stdout: 'directory\t4096\n', stderr: '' });
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=out', headers: as })).statusCode).toBe(400);
    provider.execResponses.set('sh-volume', { code: 4, stdout: '', stderr: '' });
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/archive?path=hi.txt', headers: as })).statusCode).toBe(400);
    provider.execResponses.set('sh-volume', { code: 0, stdout: `regular file\t${600 * 1024 * 1024}\n`, stderr: '' });
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=big.bin', headers: as })).statusCode).toBe(413);
  });
});

describe('uploads and opening in the browser', () => {
  it('a file name is one plain segment; uploads stay out of OpenClaw\'s state except the workspace', () => {
    expect(cleanFileName('report.pdf')).toBe('report.pdf');
    // Spaces are part of the name: trimmed, ' notes.md ' replaced notes.md (#111).
    expect(cleanFileName(' notes.md ')).toBe(' notes.md ');
    for (const bad of ['', '   ', '.', '..', 'a/b', 'a\0b', 'x'.repeat(300), 7]) expect(cleanFileName(bad)).toBeUndefined();
    expect(uploadAllowed('', 'kitchen')).toBe(true);
    expect(uploadAllowed('projects/x', 'kitchen')).toBe(true);
    expect(uploadAllowed('.openclaw', 'kitchen')).toBe(false);
    expect(uploadAllowed('.openclaw/state', 'kitchen')).toBe(false);
    expect(uploadAllowed('.openclaw/agents/kitchen/agent', 'kitchen')).toBe(true);
    expect(uploadAllowed('.openclaw/agents/kitchen/agent/inbox', 'kitchen')).toBe(true);
    expect(uploadAllowed('.openclaw/agents/other/agent', 'kitchen')).toBe(false);
    const sh = putArgv('inbox', "it's.txt", false, 'kitchen')[2]!;
    expect(sh).toContain('realpath -e');
    expect(sh).toContain(`'it'\\''s.txt'`);
    expect(sh).toContain('exit 5');
    expect(sh).toContain('ln -T'); // no overwrite asked: never replaces a name
    expect(sh).toContain('/home/node/.openclaw/agents/kitchen/agent|'); // the state rule, on the resolved directory
    expect(sh).toContain('if [ -d "$T" ]; then exit 4; fi'); // never into a directory under that name
  });
  it('an upload never replaces OpenClaw\'s live database or logins, even in the workspace (2026-10-10)', async () => {
    const ws = '.openclaw/agents/kitchen/agent';
    for (const name of RUNTIME_STATE_FILES) expect(uploadAllowed(ws, 'kitchen', name)).toBe(false);
    expect(uploadAllowed(ws, 'kitchen', 'notes.md')).toBe(true);
    expect(uploadAllowed('inbox', 'kitchen', 'openclaw-agent.sqlite')).toBe(true); // outside .openclaw it is just a file
    const { f, provider } = await world();
    const hdr = { ...as, 'content-type': 'application/octet-stream' };
    const db = await f.inject({ method: 'PUT', url: `/v1/agents/a1/fs/file?path=${encodeURIComponent(ws)}&name=openclaw-agent.sqlite&overwrite=1`, headers: hdr, payload: Buffer.from('x') });
    expect(db.statusCode).toBe(400);
    expect(db.json().error).toMatch(/live state/);
    expect(provider.written).toHaveLength(0);
    // The resolved folder decides: a link from the home into the agent's folder is caught by the one-shot itself.
    const home = mkdtempSync(join(tmpdir(), 'hb-home-'));
    try {
      mkdirSync(join(home, ws), { recursive: true });
      writeFileSync(join(home, ws, 'openclaw-agent.sqlite'), 'live');
      symlinkSync(join(home, ws), join(home, 'inbox'));
      const run = (name: string) => spawnSync('sh', ['-c', putArgv('inbox', name, true, 'kitchen')[2]!.split('/home/node').join(home)], { input: 'uploaded' });
      expect(run('openclaw-agent.sqlite-wal').status).toBe(6);
      expect(run('openclaw-agent.sqlite').status).toBe(6);
      expect(readFileSync(join(home, ws, 'openclaw-agent.sqlite'), 'utf8')).toBe('live');
      expect(run('notes.md').status).toBe(0);
      expect(readFileSync(join(home, ws, 'notes.md'), 'utf8')).toBe('uploaded');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  // Review 2026-10-22, A05/A06/A19: the one-shot run for real, under sh, in a temp home.
  it('a 255-byte name uploads; a failed write leaves no staging file; a name made meanwhile is not replaced', () => {
    const home = mkdtempSync(join(tmpdir(), 'hb-home-'));
    const bin = join(home, 'bin'); mkdirSync(bin); mkdirSync(join(home, 'inbox'));
    try {
      // HB_CAT: "fail" writes some bytes and fails; "race" makes the target first, as another writer would.
      writeFileSync(join(bin, 'cat'), '#!/bin/sh\ncase "$HB_CAT" in fail) printf half; exit 1 ;; race) printf theirs > "$HB_RACE" ;; esac\nexec /bin/cat "$@"\n', { mode: 0o755 });
      const run = (name: string, overwrite: boolean, env: Record<string, string> = {}) =>
        spawnSync('sh', ['-c', putArgv('inbox', name, overwrite, 'kitchen')[2]!.split('/home/node').join(home)],
          { input: 'uploaded', env: { PATH: `${bin}:/usr/bin:/bin`, ...env } });
      const long = 'n'.repeat(252) + '.md';
      expect(run(long, false).status).toBe(0);
      expect(readFileSync(join(home, 'inbox', long), 'utf8')).toBe('uploaded');
      expect(run('broken.md', true, { HB_CAT: 'fail' }).status).not.toBe(0);
      expect(run('broken.md', false, { HB_CAT: 'fail' }).status).not.toBe(0);
      const race = join(home, 'inbox', 'race.md');
      expect(run('race.md', false, { HB_CAT: 'race', HB_RACE: race }).status).toBe(5);
      expect(readFileSync(race, 'utf8')).toBe('theirs');
      expect(run('race.md', true).status).toBe(0);   // asked to overwrite: it does
      expect(readFileSync(race, 'utf8')).toBe('uploaded');
      expect(readdirSync(join(home, 'inbox')).sort()).toEqual([long, 'race.md'].sort());   // no staging file left behind
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('core uploads report their resolved destination and enforce the editable text limits there (HB-0631)', () => {
    const home = mkdtempSync(join(tmpdir(), 'hb-core-upload-'));
    const ws = '.openclaw/agents/kitchen/agent';
    try {
      mkdirSync(join(home, ws), { recursive: true });
      mkdirSync(join(home, 'ordinary'));
      symlinkSync(join(home, ws), join(home, 'alias'));
      writeFileSync(join(home, ws, 'SOUL.md'), 'Original');
      const run = (dir: string, opts = { tooLarge: false, invalidText: false }, overwrite = true) =>
        spawnSync('sh', ['-c', putArgv(dir, 'SOUL.md', overwrite, 'kitchen', opts)[2]!.split('/home/node').join(home)], { input: 'Uploaded', encoding: 'utf8' });
      expect(run('alias', { tooLarge: true, invalidText: false }).status).toBe(7);
      expect(run('alias', { tooLarge: false, invalidText: true }).status).toBe(8);
      expect(run('alias', undefined, false).status).toBe(5);
      expect(readFileSync(join(home, ws, 'SOUL.md'), 'utf8')).toBe('Original');
      const copied = run('alias');
      expect(copied.status).toBe(0);
      expect(copied.stdout).toBe('hatchabot:core\n');
      expect(readFileSync(join(home, ws, 'SOUL.md'), 'utf8')).toBe('Uploaded');
      const ordinary = run('ordinary', { tooLarge: true, invalidText: true });
      expect(ordinary.status).toBe(0);
      expect(ordinary.stdout).toBe('');
      const bin = join(home, 'bin'); mkdirSync(bin);
      writeFileSync(join(bin, 'mv'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const failed = spawnSync('sh', ['-c', putArgv('alias', 'SOUL.md', true, 'kitchen')[2]!.split('/home/node').join(home)],
        { input: 'Failed upload', encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe('');
      expect(readFileSync(join(home, ws, 'SOUL.md'), 'utf8')).toBe('Uploaded');
      expect(readdirSync(join(home, ws))).toEqual(['SOUL.md']);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('knows what a browser shows: text as text, pages and images as themselves, unknown binaries download', () => {
    expect(inlineType('notes.md')).toBe('text/plain');
    expect(inlineType('Makefile')).toBe('text/plain');
    expect(inlineType('report.pdf')).toBe('application/pdf');
    expect(inlineType('page.html')).toBe('text/html');
    expect(inlineType('photo.JPG')).toBe('image/jpeg');
    expect(inlineType('model.gguf')).toBeUndefined();
    expect(inlineType('data.bin')).toBeUndefined();
    // Own keys only: Object's own names are not types (audit, 2026-10-22).
    for (const odd of ['report.constructor', 'x.tostring', 'x.hasownproperty', 'x.valueof']) expect(inlineType(odd), odd).toBeUndefined();
  });
  it('opened in the browser: inline, the right type, sandboxed and unsniffable; a binary still downloads', async () => {
    const { f, provider } = await world();
    provider.execResponses.set('sh-volume', { code: 0, stdout: 'regular file\t5\n', stderr: '' });
    provider.streamBytes = Buffer.from('hello');
    const r = await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=page.html&inline=1', headers: as });
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['content-disposition']).toBe('inline; filename="page.html"');
    expect(r.headers['content-security-policy']).toBe('sandbox');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    const b = await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=x.gguf&inline=1', headers: as });
    expect(b.headers['content-disposition']).toBe('attachment; filename="x.gguf"');
  });
  it('a long name keeps its extension, so an image opens as an image (HB-0299)', async () => {
    expect(downloadName(`photos/${'a'.repeat(120)}.png`, 'slug')).toBe(`${'a'.repeat(116)}.png`);
    expect(downloadName('n'.repeat(130), 'slug')).toBe('n'.repeat(120));
    expect(downloadName(`${'b'.repeat(60)}.tar.gz`, 'slug')).toBe(`${'b'.repeat(60)}.tar.gz`);
    const { f, provider } = await world();
    provider.execResponses.set('sh-volume', { code: 0, stdout: 'regular file\t5\n', stderr: '' });
    provider.streamBytes = Buffer.from('hello');
    const r = await f.inject({ method: 'GET', url: `/v1/agents/a1/fs/file?inline=1&path=${'a'.repeat(120)}.png`, headers: as });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['content-disposition']).toBe(`inline; filename="${'a'.repeat(116)}.png"`);
  });
  it('an upload is written as its bytes, not decoded as text first; a core file\'s name is checked as text only within its cap (HB-1125)', async () => {
    const { store, provider } = await world();
    const home = createAgentHome({
      store, providerFor: () => provider, trace: () => () => {}, isArchiving: () => false,
      turns: { withCoreFilesTurn: (_id: string, fn: () => Promise<unknown>) => fn() } as never, fileMaxBytes: 512 * 1048576,
    });
    const agent = store.getAgent('a1')!;
    /** Bytes that are not UTF-8, which say so if anything decodes them. */
    const undecodable = (n: number) => {
      const b = Buffer.alloc(n, 0xff);
      b.toString = () => { throw new Error('the upload was decoded as text'); };
      return b;
    };
    const put = (dir: string, name: string, body: Buffer) => home.upload(agent, dir, name, body, { overwrite: true, owned: () => store.getAgent('a1') });
    const picture = undecodable(4 * 1048576);
    expect(await put('inbox', 'photo.png', picture)).toMatchObject({ ok: true, body: { size: 4 * 1048576 } });
    expect(provider.written.at(-1)!.bytes).toBe(picture);
    // A core file's name over its cap: the cap stops it first in the workspace, so its text is never read.
    const ws = '.openclaw/agents/kitchen/agent';
    expect((await put(ws, 'SOUL.md', undecodable(MAX_FILE_BYTES + 1))).ok).toBe(true);
    expect(provider.written.at(-1)!.argv[2]).toContain('exit 7;');
    expect(provider.written.at(-1)!.argv[2]).not.toContain('exit 8;');
    // Within its cap: still held to UTF-8 text, and good text passes both.
    expect((await put(ws, 'SOUL.md', Buffer.from([0x41, 0xc0, 0x80]))).ok).toBe(true);
    expect(provider.written.at(-1)!.argv[2]).toContain('exit 8;');
    expect(provider.written.at(-1)!.argv[2]).not.toContain('exit 7;');
    expect((await put(ws, 'SOUL.md', Buffer.from('# Soul\nKind.\n'))).ok).toBe(true);
    expect(provider.written.at(-1)!.argv[2]).not.toMatch(/exit [78];/);
  });
  it('an upload lands through a writable one-shot; an existing name is refused until overwrite is asked; never into OpenClaw\'s state', async () => {
    const { f, provider } = await world();
    const hdr = { ...as, 'content-type': 'application/octet-stream' };
    const r = await f.inject({ method: 'PUT', url: '/v1/agents/a1/fs/file?path=inbox&name=report.pdf', headers: hdr, payload: Buffer.from('%PDF') });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, path: 'inbox', name: 'report.pdf', size: 4 });
    expect(provider.written[0]!.bytes.toString()).toBe('%PDF');
    expect(provider.written[0]!.argv[2]).toContain("realpath -e '/home/node/inbox'");
    provider.writeFails = 5;
    expect((await f.inject({ method: 'PUT', url: '/v1/agents/a1/fs/file?path=inbox&name=report.pdf', headers: hdr, payload: Buffer.from('x') })).statusCode).toBe(409);
    provider.writeFails = 0;
    expect((await f.inject({ method: 'PUT', url: '/v1/agents/a1/fs/file?path=inbox&name=report.pdf&overwrite=1', headers: hdr, payload: Buffer.from('x') })).statusCode).toBe(200);
    expect(provider.written.at(-1)!.argv[2]).toContain('[ "1" != 1 ]');
    expect((await f.inject({ method: 'PUT', url: '/v1/agents/a1/fs/file?path=.openclaw&name=openclaw.json', headers: hdr, payload: Buffer.from('{}') })).statusCode).toBe(400);
    expect((await f.inject({ method: 'PUT', url: '/v1/agents/a1/fs/file?path=inbox&name=a/b', headers: hdr, payload: Buffer.from('x') })).statusCode).toBe(400);
    expect((await f.inject({ method: 'PUT', url: '/v1/agents/a1/fs/file?path=inbox&name=x', headers: { 'x-hatchabot-owner': 'someone-else', 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') })).statusCode).toBe(404);
  });
});
