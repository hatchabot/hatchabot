/**
 * `hatchabot rebuild --outdated` says what the server did: a rebuild it
 * refused is not counted as queued, and the command exits non-zero so a script
 * can retry (audit #051). The real CLI runs in a child process against a fake
 * server: a temp HOME, PATH holding only node — nothing reaches the machine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const AGENTS = [
  { id: 'agent-hw', name: 'Homework Helper', slug: 'homework-helper', state: 'RUNNING', rebuild: { level: 'required', reasons: ['a newer image'] } },
  { id: 'agent-ss', name: 'Soccer Schedule', slug: 'soccer-schedule', state: 'RUNNING', rebuild: { level: 'required', reasons: ['a newer image'] } },
  { id: 'agent-tf', name: 'Tax Filing', slug: 'tax-filing', state: 'STOPPED', rebuild: { level: 'required', reasons: ['a newer image'] } },
];
/** Which rebuilds the fake server refuses (409, as a busy agent's is). */
let refuse = new Set<string>();
const posted: string[] = [];
let server: Server;
let base = '';
const home = mkdtempSync(join(tmpdir(), 'hb-cli-outdated-'));

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/v1/config') return send(200, { authMode: 'accounts' });
      if (req.method === 'GET' && req.url === '/v1/agents') return send(200, AGENTS);
      const m = /^\/v1\/agents\/([^/]+)\/rebuild$/.exec(req.url ?? '');
      if (req.method === 'POST' && m) {
        posted.push(m[1]!);
        return refuse.has(m[1]!) ? send(409, { error: 'It is busy with another change; try again when it is done.' }) : send(202, { ok: true });
      }
      send(404, { error: `no fake for ${req.method} ${req.url}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server.close(); rmSync(home, { recursive: true, force: true }); });

function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: join(__dirname, '..'),
      env: { HOME: home, PATH: dirname(process.execPath), HATCHABOT_URL: base, HATCHABOT_TOKEN: 'made-up-cli-credential', NO_COLOR: '1' },
      timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout), err: String(stderr) }));
  });
}

describe('hatchabot rebuild --outdated', () => {
  it('every one refused: none queued, each named, exit 1', async () => {
    refuse = new Set(['agent-hw', 'agent-ss']); posted.length = 0;
    const r = await cli('rebuild', '--outdated');
    expect(posted).toEqual(['agent-hw', 'agent-ss']); // the stopped one is left alone
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.out.match(/not started: It is busy/g)).toHaveLength(2);
    expect(r.out).toMatch(/^0 rebuild\(s\) queued\. 2 not started/m);
    expect(r.out).not.toMatch(/2 rebuild\(s\) queued/);
  }, 60_000);

  it('one refused: one queued, one not, exit 1', async () => {
    refuse = new Set(['agent-ss']); posted.length = 0;
    const r = await cli('rebuild', '--outdated');
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.out).toMatch(/^1 rebuild\(s\) queued; they run a few at a time\. 1 not started/m);
  }, 60_000);

  it('all accepted: all queued, exit 0', async () => {
    refuse = new Set(); posted.length = 0;
    const r = await cli('rebuild', '--outdated');
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toMatch(/^2 rebuild\(s\) queued; they run a few at a time\.$/m);
  }, 60_000);

  it('--dry-run asks for nothing', async () => {
    refuse = new Set(['agent-hw']); posted.length = 0;
    const r = await cli('rebuild', '--outdated', '--dry-run');
    expect(r.code, r.out + r.err).toBe(0);
    expect(posted).toEqual([]);
    expect(r.out).toMatch(/2 would be rebuilt\./);
  }, 60_000);
});
