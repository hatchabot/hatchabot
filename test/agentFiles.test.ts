import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { catArgv, cleanRelPath, downloadName, listShell, parseListing, tarArgv } from '../src/orchestrator/agentFiles.js';

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
    const rows = parseListing("d\t4096\t1790000000.5\tout\nf\t120\t1790000100\tnotes.md\nl\t9\t1790000200\tlink\n\n");
    expect(rows.map((r) => [r.name, r.type, r.size])).toEqual([['out', 'dir', 4096], ['notes.md', 'file', 120], ['link', 'link', 9]]);
    expect(rows[0]!.mtime).toBe(new Date(1790000000500).toISOString());
    expect(downloadName('out/report v2.pdf', 'slug')).toBe('report_v2.pdf');
    expect(downloadName('', 'to-do-agent')).toBe('to-do-agent');
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
  it('lists a folder from a read-only one-shot, even while the agent is stopped', async () => {
    const { f, provider } = await world();
    provider.execResponses.set('sh-volume', { code: 0, stdout: "d\t4096\t1790000000\tout\nf\t7\t1790000001\thi.txt\n", stderr: '' });
    const r = await f.inject({ method: 'GET', url: '/v1/agents/a1/fs?path=/out/', headers: as });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ path: 'out', entries: [{ name: 'out', type: 'dir' }, { name: 'hi.txt', type: 'file', size: 7 }] });
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
  it('streams a file with its size, as an attachment', async () => {
    const { f, provider } = await world();
    provider.execResponses.set('sh-volume', { code: 0, stdout: 'regular file\t5\n', stderr: '' });
    provider.streamBytes = Buffer.from('hello');
    const r = await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/file?path=out/hi.txt', headers: as });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="hi.txt"');
    expect(r.headers['content-length']).toBe('5');
    expect(r.body).toBe('hello');
    expect(provider.execLog.at(-1)![1]).toContain('exec cat');
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
