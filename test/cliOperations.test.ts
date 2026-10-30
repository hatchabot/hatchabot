/**
 * The CLI and long changes (operations, phase 3): `hatchabot ops`, `ops
 * recover`, `move`, `backups restore`, and the commands that now follow an
 * operation the server runs in the background. The real CLI runs in a child
 * process against a fake server: a temp HOME, PATH holding only node, an
 * environment built from scratch — nothing reaches the real machine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { opsTable, opStepLine, startedOperation } from '../src/cli.js';

type Handler = (req: IncomingMessage, body: string) => { status?: number; json: unknown } | undefined;
let handler: Handler = () => undefined;
const seen: Array<{ method: string; url: string; body: string }> = [];
let server: Server;
let base = '';
const home = mkdtempSync(join(tmpdir(), 'hb-cli-ops-'));

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body });
      const out = common(req) ?? handler(req, body);
      res.writeHead(out?.status ?? (out ? 200 : 404), { 'content-type': 'application/json' });
      res.end(JSON.stringify(out?.json ?? { error: `no fake for ${req.method} ${req.url}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server.close(); rmSync(home, { recursive: true, force: true }); });

const AGENT = { id: 'agent-0001-test', name: 'Test Agent', slug: 'test-agent', hostId: 'h1', state: 'RUNNING', runtimeRef: 'fixture-runtime-1' };
/** What GET /v1/agents lists, when a test needs another agent than AGENT. */
let listed: unknown[] | undefined;
function common(req: IncomingMessage): ReturnType<Handler> {
  if (req.url === '/v1/config') return { json: { authMode: 'accounts' } };
  if (req.method === 'GET' && (req.url === '/v1/agents' || req.url === '/v1/agents?all=1')) return { json: listed ?? [AGENT] };
  if (req.method === 'GET' && req.url === '/v1/hosts') {
    return { json: [{ id: 'h1', name: 'box', kind: 'local' }, { id: 'h2', name: 'Test Runner', kind: 'cloud' }] };
  }
  return undefined;
}

/** The real CLI, sandboxed. */
function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: join(__dirname, '..'),
      env: { HOME: home, PATH: dirname(process.execPath), HATCHABOT_URL: base, HATCHABOT_TOKEN: 'made-up-cli-credential', NO_COLOR: '1' },
      timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout), err: String(stderr) }));
  });
}

const running = (n: number, label: string) => ({ id: 'op_move1', agentId: AGENT.id, kind: 'move-host', kindLabel: 'Move to another machine', title: 'Moving to Test Runner', status: 'running', stepN: n, steps: 10, stepLabel: label, requestedAt: new Date().toISOString() });

describe('hatchabot move', () => {
  it('posts the move and follows its operation, a line per step, to the outcome', async () => {
    seen.length = 0;
    const answers = [running(4, 'made on the other machine'), { ...running(10, 'the old copy removed'), status: 'succeeded', outcome: 'Moved to Test Runner.' }];
    handler = (req) => {
      if (req.method === 'POST' && req.url === `/v1/agents/${AGENT.id}/move-host`) return { status: 202, json: { operation: running(1, 'both machines answered and are different machines') } };
      if (req.url === '/v1/operations/op_move1') return { json: answers.shift() };
      return undefined;
    };
    const r = await cli('move', 'Test Agent', 'Test Runner');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Moving to Test Runner… \(operation op_move1\)/);
    expect(r.out).toMatch(/step 1 of 10: both machines answered/);
    expect(r.out).toMatch(/step 4 of 10: made on the other machine/);
    expect(r.out).toMatch(/✓ Moved to Test Runner\./);
    expect(JSON.parse(seen.find((s) => s.method === 'POST')!.body)).toEqual({ hostId: 'h2' });
  }, 60_000);

  it('--no-wait returns at once, saying where to follow it', async () => {
    seen.length = 0;
    handler = (req) => (req.method === 'POST' ? { status: 202, json: { operation: running(1, 'both machines answered') } } : undefined);
    const r = await cli('move', 'Test Agent', 'Test Runner', '--no-wait');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/hatchabot ops "Test Agent"/);
    expect(seen.some((s) => s.url.startsWith('/v1/operations/'))).toBe(false);
  }, 60_000);

  it('a pinned image the machine lacks: names --drop-pin, and a failed move exits 1', async () => {
    handler = (req) => (req.method === 'POST' ? { status: 409, json: { error: 'It is pinned to an image Test Runner does not have.', code: 'pinned_image_missing' } } : undefined);
    const pinned = await cli('move', 'Test Agent', 'Test Runner');
    expect(pinned.code).toBe(1);
    expect(pinned.err).toMatch(/--drop-pin/);
    handler = (req) => {
      if (req.method === 'POST') return { status: 202, json: { operation: running(1, 'both machines answered') } };
      if (req.url === '/v1/operations/op_move1') return { json: { ...running(3, 'its memory copied out'), status: 'rolled_back', outcome: 'The runner stopped answering; it is back here.' } };
      return undefined;
    };
    const undone = await cli('move', 'Test Agent', 'Test Runner');
    expect(undone.code).toBe(1);
    expect(undone.err).toMatch(/undone: The runner stopped answering/);
  }, 60_000);
});

describe('hatchabot ops', () => {
  const held = { id: 'op_held1', agentId: AGENT.id, kind: 'move-host', kindLabel: 'Move to another machine', title: 'Moving to Test Runner', status: 'held', stepN: 2, steps: 10, stepLabel: 'stopped here',
    outcome: "The move was interrupted; Test Runner isn't answering.", requestedAt: new Date(Date.now() - 3600_000).toISOString(), updatedAt: new Date().toISOString(),
    recovery: { actions: [{ action: 'retry', label: 'Try again when Test Runner is back' }, { action: 'put-back', label: 'Put it back on box' }], recommended: 'retry' } };

  it('lists operations with kind, status, step n/m, age and outcome', async () => {
    handler = (req) => (req.url?.startsWith('/v1/operations?') ? { json: { operations: [held] } } : undefined);
    const r = await cli('ops');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/OPERATION\s+AGENT\s+KIND\s+STATUS\s+STEP\s+STARTED\s+OUTCOME/);
    expect(r.out).toMatch(/op_held1\s+Test Agent\s+Move to another machine\s+held\s+2\/10\s+1h ago\s+The move was interrupted/);
    expect(r.out).toMatch(/1 waiting for your choice/);
    const j = await cli('ops', 'Test Agent', '--json');
    expect(JSON.parse(j.out)[0]).toMatchObject({ id: 'op_held1', stepN: 2 });
    expect(seen.some((s) => s.url === `/v1/operations?limit=50&agentId=${AGENT.id}`)).toBe(true);
  }, 60_000);

  it('recover: only one of its choices, then posts it', async () => {
    seen.length = 0;
    handler = (req) => {
      if (req.method === 'GET' && req.url === '/v1/operations/op_held1') return { json: held };
      if (req.method === 'POST' && req.url === '/v1/operations/op_held1/recover') return { json: { operation: { ...held, status: 'rolled_back', outcome: 'Put back on box.' } } };
      return undefined;
    };
    const wrong = await cli('ops', 'recover', 'op_held1', 'finish-anyway');
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/not one of its choices[\s\S]*retry[\s\S]*put-back/);
    expect(seen.some((s) => s.method === 'POST')).toBe(false);
    const ok = await cli('ops', 'recover', 'op_held1', 'put-back');
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toMatch(/Put back on box\./);
    expect(JSON.parse(seen.find((s) => s.method === 'POST')!.body)).toEqual({ action: 'put-back' });
  }, 60_000);
});

describe('hatchabot backups restore', () => {
  it("wants the agent's own name and --yes before it posts; then follows the restore", async () => {
    seen.length = 0;
    const op = { id: 'op_rb1', agentId: AGENT.id, kind: 'restore-backup', title: 'Restoring from the 2026-10-01 backup', status: 'running', stepN: 1, steps: 4, stepLabel: 'stopped for the restore', requestedAt: new Date().toISOString() };
    handler = (req) => {
      if (req.method === 'POST' && req.url === '/v1/backups/restore') return { status: 202, json: { operation: op } };
      if (req.url === '/v1/operations/op_rb1') return { json: { ...op, status: 'succeeded', stepN: 4, stepLabel: 'its current settings put back over it', outcome: 'Restored from the 2026-10-01 backup.' } };
      return undefined;
    };
    const noYes = await cli('backups', 'restore', 'Test Agent', '2026-10-01');
    expect(noYes.code).toBe(1);
    expect(noYes.err).toMatch(/replaces everything "Test Agent" remembers[\s\S]*--yes/);
    const bySlug = await cli('backups', 'restore', 'test-agent', '2026-10-01', '--yes');
    expect(bySlug.code).toBe(1);
    expect(bySlug.err).toMatch(/type the agent's name to confirm: "Test Agent"/);
    expect(seen.some((s) => s.method === 'POST')).toBe(false);
    const r = await cli('backups', 'restore', 'test agent', '2026-10-01', '--yes');
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(seen.find((s) => s.method === 'POST')!.body)).toEqual({ agentId: AGENT.id, date: '2026-10-01' });
    expect(r.out).toMatch(/step 4 of 4: its current settings put back over it/);
    expect(r.out).toMatch(/"Test Agent" is back as it was on 2026-10-01\./);
  }, 60_000);

  it('a restore held for a choice exits 1 and prints the commands for each choice', async () => {
    const op = { id: 'op_rb2', agentId: AGENT.id, kind: 'restore-backup', title: 'Restoring from the 2026-10-01 backup', status: 'running', steps: 4, requestedAt: new Date().toISOString() };
    handler = (req) => {
      if (req.method === 'POST') return { status: 202, json: { operation: op } };
      if (req.url === '/v1/operations/op_rb2') return { json: { ...op, status: 'held', outcome: 'The restore was interrupted.', recovery: { actions: [{ action: 'finish', label: 'Finish the restore' }, { action: 'undo', label: 'Put back the copy from before' }] } } };
      return undefined;
    };
    const r = await cli('backups', 'restore', 'Test Agent', '2026-10-01', '--yes');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/⏸ The restore was interrupted\./);
    expect(r.out).toMatch(/hatchabot ops recover op_rb2 finish/);
    expect(r.out).toMatch(/hatchabot ops recover op_rb2 undo/);
  }, 60_000);
});

describe('hatchabot rebuild --wait (HB-0356)', () => {
  const rebuildOp = (status: string, outcome?: string) => ({ id: 'op_rebuild1', agentId: AGENT.id, kind: 'rebuild', kindLabel: 'Rebuild', title: 'Rebuilding', status, steps: 4, requestedAt: new Date().toISOString(), ...(outcome ? { outcome } : {}) });
  it('follows the operation: a rebuild done before the first look still answers RUNNING', async () => {
    seen.length = 0;
    handler = (req) => {
      if (req.method === 'POST' && req.url === `/v1/agents/${AGENT.id}/rebuild`) return { status: 202, json: { rebuilding: true, operation: rebuildOp('running') } };
      if (req.url === '/v1/operations/op_rebuild1') return { json: rebuildOp('succeeded', 'Rebuilt.') };
      // Never seen leaving RUNNING: the rebuild was over before anyone looked.
      if (req.method === 'GET' && req.url === `/v1/agents/${AGENT.id}`) return { json: { ...AGENT, busy: false } };
      return undefined;
    };
    const r = await cli('rebuild', 'Test Agent', '--wait', '--timeout', '0.05');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/✓ Rebuilt\./);
    expect(r.out).toMatch(/"Test Agent" is RUNNING\./);
    expect(seen.some((s) => s.url === '/v1/operations/op_rebuild1')).toBe(true);
  }, 60_000);
  it('a failed rebuild operation exits 1 with its outcome', async () => {
    handler = (req) => {
      if (req.method === 'POST' && req.url === `/v1/agents/${AGENT.id}/rebuild`) return { status: 202, json: { rebuilding: true, operation: rebuildOp('running') } };
      if (req.url === '/v1/operations/op_rebuild1') return { json: rebuildOp('failed', 'The new container did not start.') };
      if (req.method === 'GET' && req.url === `/v1/agents/${AGENT.id}`) return { json: { ...AGENT, busy: false } };
      return undefined;
    };
    const r = await cli('rebuild', 'Test Agent', '--wait');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/failed: The new container did not start\./);
    expect(r.out).not.toMatch(/is RUNNING/);
  }, 60_000);
  it('--timeout is one budget: the state check after a slow operation does not start a second one', async () => {
    seen.length = 0;
    let looks = 0;
    handler = (req) => {
      if (req.method === 'POST' && req.url === `/v1/agents/${AGENT.id}/rebuild`) return { status: 202, json: { rebuilding: true, operation: rebuildOp('running') } };
      // Five looks a second apart: the operation ends 5 s into a 6 s budget.
      if (req.url === '/v1/operations/op_rebuild1') return { json: ++looks >= 5 ? rebuildOp('succeeded', 'Rebuilt.') : rebuildOp('running') };
      if (req.method === 'GET' && req.url === `/v1/agents/${AGENT.id}`) return { json: { ...AGENT, busy: true } };
      return undefined;
    };
    const r = await cli('rebuild', 'Test Agent', '--wait', '--timeout', '0.1');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/is still RUNNING after 0\.1 min/);
    // Checks 3 s apart from 5 s on: two fit in the 6 s budget; a fresh 6 s
    // window after the operation took three or more.
    expect(seen.filter((s) => s.method === 'GET' && s.url === `/v1/agents/${AGENT.id}`).length).toBeLessThanOrEqual(2);
  }, 60_000);
});

describe('hatchabot browser <agent> on|off (HB-0357)', () => {
  it('a rebuild already under way: prints what the server says to do, not "rebuilding now"', async () => {
    const pending = 'Saved. A rebuild was already under way and may have begun before this change: if its browser is not as you set it once that rebuild ends, rebuild the agent.';
    handler = (req) => req.method === 'PATCH' && req.url === `/v1/agents/${AGENT.id}` ? { json: { ...AGENT, browser: true, browserPending: pending } } : undefined;
    const r = await cli('browser', 'Test Agent', 'on');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(pending);
    expect(r.out).not.toMatch(/rebuilding now/);
  }, 60_000);
  it('a rebuild it started: says rebuilding', async () => {
    handler = (req) => req.method === 'PATCH' && req.url === `/v1/agents/${AGENT.id}` ? { json: { ...AGENT, browser: true } } : undefined;
    const r = await cli('browser', 'Test Agent', 'on');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/gets its own browser: rebuilding now/);
  }, 60_000);
  it('an agent the server does not rebuild (archived, failed, not built yet): saved, no rebuild claimed', async () => {
    for (const [state, runtimeRef] of [['ARCHIVED', 'fixture-runtime-1'], ['FAILED', 'fixture-runtime-1'], ['PROVISIONING', undefined], ['STOPPED', undefined]] as const) {
      listed = [{ ...AGENT, state, runtimeRef, browser: false }];
      handler = (req) => req.method === 'PATCH' && req.url === `/v1/agents/${AGENT.id}` ? { json: { ...AGENT, state, runtimeRef, browser: true } } : undefined;
      try {
        const r = await cli('browser', 'Test Agent', 'on');
        expect(r.code, r.err).toBe(0);
        expect(r.out, state).toMatch(/saved\. No rebuild was started/);
        expect(r.out, state).not.toMatch(/rebuilding now/);
      } finally { listed = undefined; }
    }
  }, 120_000);
  it('already so: changes nothing and claims no rebuild', async () => {
    seen.length = 0;
    handler = () => undefined;
    const r = await cli('browser', 'Test Agent', 'off');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/has no browser: nothing to change/);
    expect(seen.some((s) => s.method === 'PATCH')).toBe(false);
  }, 60_000);
});

describe('commands an older server answers the old way', () => {
  it('rehost prints the old answer when no operation comes back', async () => {
    handler = (req) => {
      if (req.url === '/v1/peers') return { json: [{ id: 'peer1', name: 'Test Peer', url: 'http://peer.example.org' }] };
      if (req.method === 'POST' && req.url === `/v1/agents/${AGENT.id}/rehost`) return { json: { movedTo: 'Test Peer', remoteAgentId: 'remote-1', sourceState: 'STOPPED' } };
      return undefined;
    };
    const r = await cli('rehost', 'Test Agent', 'Test Peer');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/done — now running on Test Peer as remote-1/);
  }, 60_000);
  it('rebuild --wait without an operation waits to see it leave RUNNING, then come back', async () => {
    const states = [{ ...AGENT, busy: true }, { ...AGENT, busy: false }];
    handler = (req) => {
      if (req.method === 'POST' && req.url === `/v1/agents/${AGENT.id}/rebuild`) return { status: 202, json: { rebuilding: true } };
      if (req.method === 'GET' && req.url === `/v1/agents/${AGENT.id}`) return { json: states.length > 1 ? states.shift() : states[0] };
      return undefined;
    };
    const r = await cli('rebuild', 'Test Agent', '--wait');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/"Test Agent" is RUNNING\./);
  }, 60_000);
});

describe('the pieces', () => {
  it('startedOperation, opStepLine and opsTable', () => {
    expect(startedOperation({ operation: { id: 'op_x', status: 'running' } })).toMatchObject({ id: 'op_x' });
    expect(startedOperation({ id: 'a1', state: 'RUNNING', operation: 'op_x' })).toBeUndefined();
    expect(opStepLine({ stepN: 3, steps: 10, stepLabel: 'its memory copied out' })).toBe('step 3 of 10: its memory copied out');
    expect(opStepLine({ steps: 10 })).toBe('');
    expect(opsTable([], () => '')).toEqual(['no operations']);
  });
});
