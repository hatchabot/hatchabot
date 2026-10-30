/**
 * `hatchabot backup` and `hatchabot get`: where the file goes is made ready
 * before the server is asked (a backup stops the agent), the home folder is a
 * folder, and an interrupted download leaves an earlier copy whole. The real
 * CLI runs in a child process against a fake server: a temp HOME, PATH holding
 * only node, an environment built from scratch — nothing reaches the real machine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { renameRefused } from '../src/cli.js';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Handler = (req: IncomingMessage, res: ServerResponse) => boolean;
let handler: Handler = () => false;
const seen: string[] = [];
let server: Server;
let base = '';
const home = mkdtempSync(join(tmpdir(), 'hb-cli-dl-'));
/** The CLI's temp folder (TMPDIR), to see that nothing is left in it. */
const temp = join(home, 'tmp');
mkdirSync(temp);
let work = '';

const AGENT = { id: 'agent-0001-test', name: 'Test Agent', slug: 'test-agent', hostId: 'h1', state: 'RUNNING' };
const json = (res: ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url === '/v1/config') return json(res, { authMode: 'accounts' });
      if (req.method === 'GET' && req.url === '/v1/agents') return json(res, [AGENT]);
      if (!handler(req, res)) json(res, { error: `no fake for ${req.method} ${req.url}` }, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  // A test may leave a folder read-only: made writable again so it can go.
  for (const d of readdirSync(home)) try { chmodSync(join(home, d), 0o755); for (const e of readdirSync(join(home, d))) chmodSync(join(home, d, e), 0o755); } catch { /* a file */ }
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => { seen.length = 0; handler = () => false; work = mkdtempSync(join(home, 'work-')); });

/** The real CLI, sandboxed; relative paths are the person's (HATCHABOT_CWD). */
function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: join(__dirname, '..'),
      env: { HOME: home, PATH: dirname(process.execPath), HATCHABOT_URL: base, HATCHABOT_TOKEN: 'made-up-cli-credential', HATCHABOT_CWD: work, TMPDIR: temp, NO_COLOR: '1' },
      timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout), err: String(stderr) }));
  });
}
const leftovers = () => readdirSync(work).filter((f) => f.endsWith('.part'));

describe('hatchabot backup: the destination is checked before the agent is stopped (HB-0358)', () => {
  it('an existing folder as --out is refused, and the backup is never asked for', async () => {
    mkdirSync(join(work, 'saved'));
    const r = await cli('backup', 'Test Agent', '--out', 'saved');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/is a folder .*nothing was stopped/);
    expect(seen.some((s) => s.endsWith('/backup'))).toBe(false);
  }, 60_000);
  it('a folder that does not exist is refused the same way', async () => {
    const r = await cli('backup', 'Test Agent', '--out', 'missing/test-agent.hatchabot');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/cannot write into .*nothing was stopped/);
    expect(seen.some((s) => s.endsWith('/backup'))).toBe(false);
  }, 60_000);
  it('saves over an earlier copy, 0600, with nothing left beside it', async () => {
    writeFileSync(join(work, 'test-agent.hatchabot'), 'an earlier backup', { mode: 0o644 });
    handler = (req, res) => {
      if (req.url !== `/v1/agents/${AGENT.id}/backup`) return false;
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('made-up backup archive'); return true;
    };
    const r = await cli('backup', 'Test Agent');
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(work, 'test-agent.hatchabot'), 'utf8')).toBe('made-up backup archive');
    expect(statSync(join(work, 'test-agent.hatchabot')).mode & 0o777).toBe(0o600);
    expect(leftovers()).toEqual([]);
  }, 60_000);
  it('a refused backup leaves the earlier copy and no half-made file', async () => {
    writeFileSync(join(work, 'test-agent.hatchabot'), 'an earlier backup');
    handler = (req, res) => { if (req.url !== `/v1/agents/${AGENT.id}/backup`) return false; json(res, { error: 'Another operation is already running on this agent.' }, 409); return true; };
    const r = await cli('backup', 'Test Agent');
    expect(r.code).toBe(1);
    expect(readFileSync(join(work, 'test-agent.hatchabot'), 'utf8')).toBe('an earlier backup');
    expect(leftovers()).toEqual([]);
  }, 60_000);
});

describe('hatchabot get', () => {
  const archive = (path: string) => (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== `/v1/agents/${AGENT.id}/fs/archive?path=${encodeURIComponent(path)}`) return false;
    res.writeHead(200, { 'content-type': 'application/gzip' }); res.end('made-up archive'); return true;
  };
  it('`.` and `/` are the home folder: its archive, not a file named "." (HB-0359)', async () => {
    for (const ref of ['.', '/', './']) {
      seen.length = 0;
      handler = archive('');
      const r = await cli('get', 'Test Agent', ref);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(/\(folder as \.tar\.gz\)/);
      expect(readFileSync(join(work, 'test-agent.tar.gz'), 'utf8')).toBe('made-up archive');
      expect(seen.some((s) => s.includes('/fs/file'))).toBe(false);
    }
  }, 60_000);
  it('`./notes/` is the folder notes, asked for as notes', async () => {
    handler = (req, res) => {
      if (req.url === `/v1/agents/${AGENT.id}/fs?path=`) { json(res, { path: '', entries: [{ name: 'notes', type: 'dir' }] }); return true; }
      return archive('notes')(req, res);
    };
    const r = await cli('get', 'Test Agent', './notes/');
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(work, 'notes.tar.gz'), 'utf8')).toBe('made-up archive');
  }, 60_000);
  it('an interrupted download leaves the earlier copy whole (HB-0360)', async () => {
    writeFileSync(join(work, 'notes.txt'), 'the earlier complete notes');
    handler = (req, res) => {
      if (req.url === `/v1/agents/${AGENT.id}/fs?path=`) { json(res, { path: '', entries: [{ name: 'notes.txt', type: 'file' }] }); return true; }
      if (req.url !== `/v1/agents/${AGENT.id}/fs/file?path=notes.txt`) return false;
      // Announces more than it sends, then the connection drops mid-body.
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '1000' });
      res.write('partial', () => setTimeout(() => res.socket?.destroy(), 50));
      return true;
    };
    const r = await cli('get', 'Test Agent', 'notes.txt');
    expect(r.code).toBe(1);
    expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('the earlier complete notes');
    expect(leftovers()).toEqual([]);
  }, 60_000);
  it('a complete download replaces the earlier copy, 0600', async () => {
    writeFileSync(join(work, 'notes.txt'), 'the earlier notes', { mode: 0o644 });
    handler = (req, res) => {
      if (req.url === `/v1/agents/${AGENT.id}/fs?path=`) { json(res, { path: '', entries: [{ name: 'notes.txt', type: 'file' }] }); return true; }
      if (req.url !== `/v1/agents/${AGENT.id}/fs/file?path=notes.txt`) return false;
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('the new notes'); return true;
    };
    const r = await cli('get', 'Test Agent', 'notes.txt');
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('the new notes');
    expect(statSync(join(work, 'notes.txt')).mode & 0o777).toBe(0o600);
    expect(leftovers()).toEqual([]);
  }, 60_000);
  it('an --out that is a symlink is written through, as before', async () => {
    mkdirSync(join(work, 'real'));
    writeFileSync(join(work, 'real', 'notes.txt'), 'the earlier notes');
    symlinkSync(join(work, 'real', 'notes.txt'), join(work, 'link.txt'));
    handler = (req, res) => {
      if (req.url === `/v1/agents/${AGENT.id}/fs?path=`) { json(res, { path: '', entries: [{ name: 'notes.txt', type: 'file' }] }); return true; }
      if (req.url !== `/v1/agents/${AGENT.id}/fs/file?path=notes.txt`) return false;
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('the new notes'); return true;
    };
    const r = await cli('get', 'Test Agent', 'notes.txt', '--out', 'link.txt');
    expect(r.code, r.err).toBe(0);
    expect(lstatSync(join(work, 'link.txt')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(work, 'real', 'notes.txt'), 'utf8')).toBe('the new notes');
  }, 60_000);
  const notes = (body: string) => (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === `/v1/agents/${AGENT.id}/fs?path=`) { json(res, { path: '', entries: [{ name: 'notes.txt', type: 'file' }] }); return true; }
    if (req.url !== `/v1/agents/${AGENT.id}/fs/file?path=notes.txt`) return false;
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(body); return true;
  };
  it('an --out that is a link to a file not made yet makes that file, and stays a link', async () => {
    mkdirSync(join(work, 'real'));
    symlinkSync('real/notes.txt', join(work, 'link.txt')); // relative, to nothing yet
    handler = notes('the new notes');
    const r = await cli('get', 'Test Agent', 'notes.txt', '--out', 'link.txt');
    expect(r.code, r.err).toBe(0);
    expect(lstatSync(join(work, 'link.txt')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(work, 'real', 'notes.txt'), 'utf8')).toBe('the new notes');
    expect(statSync(join(work, 'real', 'notes.txt')).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(work, 'real')).filter((f) => f.endsWith('.part'))).toEqual([]);
  }, 60_000);
  it.skipIf(process.getuid?.() === 0)('a writable file in a folder this account cannot add files to is still saved over', async () => {
    mkdirSync(join(work, 'ro'));
    writeFileSync(join(work, 'ro', 'notes.txt'), 'the earlier notes', { mode: 0o644 });
    chmodSync(join(work, 'ro'), 0o555);
    try {
      handler = notes('the new notes');
      const r = await cli('get', 'Test Agent', 'notes.txt', '--out', 'ro/notes.txt');
      expect(r.code, r.err).toBe(0);
      expect(readFileSync(join(work, 'ro', 'notes.txt'), 'utf8')).toBe('the new notes');
      expect(statSync(join(work, 'ro', 'notes.txt')).mode & 0o777).toBe(0o600);
      expect(readdirSync(temp).filter((f) => f.endsWith('.part'))).toEqual([]);
      // A download that fails there leaves the earlier copy too.
      handler = (req, res) => {
        if (req.url === `/v1/agents/${AGENT.id}/fs?path=`) { json(res, { path: '', entries: [{ name: 'notes.txt', type: 'file' }] }); return true; }
        if (req.url !== `/v1/agents/${AGENT.id}/fs/file?path=notes.txt`) return false;
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '1000' });
        res.write('partial', () => setTimeout(() => res.socket?.destroy(), 50));
        return true;
      };
      const cut = await cli('get', 'Test Agent', 'notes.txt', '--out', 'ro/notes.txt');
      expect(cut.code).toBe(1);
      expect(readFileSync(join(work, 'ro', 'notes.txt'), 'utf8')).toBe('the new notes');
      expect(readdirSync(temp).filter((f) => f.endsWith('.part'))).toEqual([]);
    } finally { chmodSync(join(work, 'ro'), 0o755); }
  }, 60_000);
  it('a link to a file not made yet, reached through a linked folder, makes the file the system would', async () => {
    // alias -> real/sub, and real/sub/link -> ../target.txt: the system reads
    // `..` from real/sub, so the file is real/target.txt — never ./target.txt.
    mkdirSync(join(work, 'real', 'sub'), { recursive: true });
    symlinkSync('real/sub', join(work, 'alias'));
    symlinkSync('../target.txt', join(work, 'real', 'sub', 'link'));
    writeFileSync(join(work, 'target.txt'), 'an unrelated file');
    handler = notes('the new notes');
    const r = await cli('get', 'Test Agent', 'notes.txt', '--out', 'alias/link');
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(work, 'real', 'target.txt'), 'utf8')).toBe('the new notes');
    expect(readFileSync(join(work, 'target.txt'), 'utf8')).toBe('an unrelated file');
    expect(lstatSync(join(work, 'real', 'sub', 'link')).isSymbolicLink()).toBe(true);
  }, 60_000);
  it('a link whose own text goes through a linked folder and then `..` makes the file the system would', async () => {
    // d/sym -> a/b, and d/link -> sym/../t.txt: the system reads it as a/t.txt; by text it was d/t.txt.
    mkdirSync(join(work, 'a', 'b'), { recursive: true });
    mkdirSync(join(work, 'd'));
    symlinkSync(join(work, 'a', 'b'), join(work, 'd', 'sym'));
    symlinkSync('sym/../t.txt', join(work, 'd', 'link'));
    writeFileSync(join(work, 'd', 't.txt'), 'an unrelated file');
    handler = notes('the new notes');
    const r = await cli('get', 'Test Agent', 'notes.txt', '--out', 'd/link');
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(work, 'a', 't.txt'), 'utf8')).toBe('the new notes');
    expect(readFileSync(join(work, 'd', 't.txt'), 'utf8')).toBe('an unrelated file');
  }, 60_000);
  it('a link whose folder is not there for the system is refused, even when by text it names one that is', async () => {
    // d/link -> sym/../x/t.txt: the system reads a/x/t.txt (no a/x); by text it was d/x/t.txt, which exists.
    mkdirSync(join(work, 'a', 'b'), { recursive: true });
    mkdirSync(join(work, 'd', 'x'), { recursive: true });
    symlinkSync(join(work, 'a', 'b'), join(work, 'd', 'sym'));
    symlinkSync('sym/../x/t.txt', join(work, 'd', 'link'));
    writeFileSync(join(work, 'd', 'x', 't.txt'), 'an unrelated file');
    handler = notes('the new notes');
    const r = await cli('get', 'Test Agent', 'notes.txt', '--out', 'd/link');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('is not there');
    expect(readFileSync(join(work, 'd', 'x', 't.txt'), 'utf8')).toBe('an unrelated file');
  }, 60_000);
  it('an --out that is a pipe or a device is written to directly, as before', async () => {
    const fifo = join(work, 'pipe');
    execFileSync('mkfifo', [fifo]);
    handler = notes('the new notes');
    const read = new Promise<string>((done, failed) => {
      const chunks: Buffer[] = [];
      createReadStream(fifo).on('data', (c) => chunks.push(c as Buffer)).on('end', () => done(Buffer.concat(chunks).toString())).on('error', failed);
    });
    const r = await cli('get', 'Test Agent', 'notes.txt', '--out', 'pipe');
    if (r.code !== 0) writeFileSync(fifo, ''); // the reader would wait for ever
    expect(r.code, r.err).toBe(0);
    expect(await read).toBe('the new notes');
    expect(lstatSync(fifo).isFIFO()).toBe(true);
    expect(leftovers()).toEqual([]);
    const nul = await cli('get', 'Test Agent', 'notes.txt', '--out', '/dev/null');
    expect(nul.code, nul.err).toBe(0);
  }, 60_000);
  it('a file name near the length limit still gets a part file of its own', async () => {
    const long = `${'n'.repeat(250)}.txt`;
    handler = notes('the new notes');
    const r = await cli('get', 'Test Agent', 'notes.txt', '--out', long);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(work, long), 'utf8')).toBe('the new notes');
    expect(leftovers()).toEqual([]);
  }, 60_000);
});

describe('renameRefused: a file that cannot be replaced is known before the backup stops the agent (HB-0358)', () => {
  const dir = (uid: number, sticky: boolean) => ({ uid, mode: 0o40777 | (sticky ? 0o1000 : 0) });
  const file = (uid: number) => ({ uid });
  it('another account\'s file in a shared folder with the sticky bit (like /tmp) cannot be replaced', () => {
    expect(renameRefused(dir(0, true), file(2001), 1001)).toBe(true);
  });
  it('one\'s own file, one\'s own folder, a folder without the sticky bit, or root: it can', () => {
    expect(renameRefused(dir(0, true), file(1001), 1001)).toBe(false);
    expect(renameRefused(dir(1001, true), file(2001), 1001)).toBe(false);
    expect(renameRefused(dir(0, false), file(2001), 1001)).toBe(false);
    expect(renameRefused(dir(0, true), file(2001), 0)).toBe(false);
  });
});
