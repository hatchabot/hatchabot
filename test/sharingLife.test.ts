/**
 * Promises about sharing and an agent's life, held to what enforces them
 * (review, 2026-09-30): a shared copy says what it mentions about people; a
 * clone carries the daily notes and USER.md; "Saved to memory" means its
 * memory files changed; health says when the AI source last answered; a
 * sleeper wakes on a message whose update id sits below its bedtime mark.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { personalSummary, scanPersonalData } from '../src/domain/personalData.js';
import { readCloneMemory, scanTemplate, stripManagedSections, type TemplateManifest } from '../src/orchestrator/template.js';
import { aiSourceHealth } from '../src/orchestrator/health.js';
import { workspacePath } from '../src/orchestrator/snapshots.js';
import type { RuntimeProvider } from '../src/providers/provider.js';
import { makeWorld, seedRunningAgent, as } from './support/world.js';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { createAgentRecord, memoryFingerprint, runProvisionSteps } from '../src/orchestrator/provision.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';

afterEach(() => vi.restoreAllMocks());

// Key-shaped values are assembled here, never written out whole: the commit
// hooks scan for real-looking tokens.
const fakeKey = () => ['sk', 'ant', 'x'.repeat(20)].join('-');

describe('what a shared copy mentions', () => {
  it('counts distinct email addresses, phone numbers and keys, and says where each first appears', () => {
    const s = scanPersonalData([
      { where: 'AGENTS.md', text: '# Notes\nBoard: ann@example.com, bob@example.com\nAnn again: ANN@example.com\nCall 416-555-0123 or (416) 555-0199\n' },
      { where: 'Scheduled task “Digest”', text: `Mail the digest to carol@example.org using ${fakeKey()}` },
    ]);
    expect(s).toMatchObject({ emails: 3, phones: 2, tokens: 1, more: 0 });
    expect(s.hits[0]).toEqual({ where: 'AGENTS.md', line: 2, kind: 'email', sample: 'ann@example.com' });
    expect(s.hits.find((h) => h.kind === 'phone')).toMatchObject({ line: 4, sample: '416-555-0123' });
    const key = s.hits.find((h) => h.kind === 'token')!;
    expect(key.where).toBe('Scheduled task “Digest”');
    expect(key.sample).toBe('sk-a…'); // never the key itself
    expect(personalSummary(s)).toBe('3 email addresses, 2 phone numbers and 1 thing that looks like a password or key');
  });

  it('leaves out what only looks like one: SSH remotes, dates, bare ids, versions', () => {
    const s = scanPersonalData([{ where: 'AGENTS.md', text: 'repo git@github.com:owner/repo.git\non 2026-09-30 12:00\nuser 1234567890\nOpenClaw 2026.9.6\ncron 0 8 * * 1-5' }]);
    expect(s).toMatchObject({ emails: 0, phones: 0, tokens: 0 });
    expect(personalSummary(s)).toBe('');
  });

  it('counts an international number once, however it is written', () => {
    const s = scanPersonalData([{ where: 'MEMORY.md', text: '+44 20 7946 0958\n+1 416 555 0123\n416.555.0123' }]);
    expect(s.phones).toBe(2);
  });

  it('caps the list and counts the rest', () => {
    const text = Array.from({ length: 45 }, (_, i) => `p${i}@example.com`).join('\n');
    const s = scanPersonalData([{ where: 'AGENTS.md', text }]);
    expect(s.emails).toBe(45);
    expect(s.hits).toHaveLength(40);
    expect(s.more).toBe(5);
  });

  it('scans every part of a template that can name someone', () => {
    const m: TemplateManifest = {
      format: 'hatchabot-template', version: 1, exportedAt: 'now',
      agent: { name: 'Condo', persona: 'Helps dave@example.com', sharedMemory: false },
      files: { 'AGENTS.md': 'x\neve@example.com', 'SOUL.md': '' },
      ai: { vendor: 'anthropic' },
      dataNeeds: [{ kind: 'git', access: 'ro', mountName: 'docs', repoUrl: 'https://someone:hunter2hunter2@example.com/r.git' }],
      envNeeds: [],
      parameters: [{ key: 'contact', label: 'Contact', required: false, type: 'text', target: 'agents', default: 'frank@example.com' }],
      schedules: [{ name: 'Digest', message: 'Send to gina@example.com', cron: '0 8 * * *' }],
    };
    const s = scanTemplate(m);
    expect(s.emails).toBe(4);
    expect(s.tokens).toBe(1); // the credentials in the repo address
    expect(s.hits.map((h) => h.where)).toEqual(expect.arrayContaining(['AGENTS.md', 'Description', 'Scheduled task “Digest”', 'Setup field “Contact”', 'Data source “docs”']));
  });

  it('strips the pre-rename install notes heading too', () => {
    const md = '# A\n\nmine\n\n## Installing tools (managed by AgentClaw)\nhost notes\n\n## Mine too\nkeep\n';
    const out = stripManagedSections(md);
    expect(out).not.toContain('managed by AgentClaw');
    expect(out).not.toContain('host notes');
    expect(out).toContain('## Mine too');
  });

  it('the download carries the scan, and the scan route answers without making a file', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    // Every file the export reads says the same thing here.
    w.provider.execResponses.set('sh', { code: 0, stdout: 'Owner: owner@example.com\nCall 416-555-0123\n', stderr: '' });
    const res = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/export?excludeMemory=1', headers: as() });
    expect(res.statusCode).toBe(200);
    const p = JSON.parse(decodeURIComponent(String(res.headers['x-hatchabot-personal'])));
    expect(p).toMatchObject({ emails: 1, phones: 1, tokens: 0 });
    expect(p.hits[0]).toMatchObject({ kind: 'email', sample: 'owner@example.com' });
    expect(JSON.parse(gunzipSync(res.rawPayload).toString('utf8')).format).toBe('hatchabot-template');

    const scan = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/export/scan?excludeMemory=1', headers: as() });
    expect(scan.statusCode).toBe(200);
    expect(scan.json()).toMatchObject({ emails: 1, phones: 1 });
    expect((await w.f.inject({ method: 'GET', url: '/v1/agents/a1/export/scan', headers: as('someone-else') })).statusCode).toBe(404);
  });
});

/** A provider whose shell runs the real script against a local folder standing in for the workspace. */
function localShell(ws: string, slug: string): RuntimeProvider {
  return {
    execShell: async (_ref: string, script: string) => {
      const local = script.replaceAll(workspacePath(slug, '.'), ws);
      try { return { code: 0, stdout: execFileSync('bash', ['-c', local], { encoding: 'utf8' }), stderr: '' }; }
      catch (err: any) { return { code: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }; }
    },
  } as unknown as RuntimeProvider;
}

describe('a clone carries the daily notes and USER.md', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('reads USER.md and the text files under memory/, skipping hidden, binary and oversized ones', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hb-clone-mem-'));
    mkdirSync(join(dir, 'memory', '.dreams'), { recursive: true });
    mkdirSync(join(dir, 'memory', 'archive'), { recursive: true });
    writeFileSync(join(dir, 'USER.md'), '# About them\n');
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n'); // travels with the template, not here
    writeFileSync(join(dir, 'memory', '2026-09-29.md'), 'did things\n');
    writeFileSync(join(dir, 'memory', '2026-05-02.md#append'), 'more\n');
    writeFileSync(join(dir, 'memory', 'archive', '2026-01-01.md'), 'old\n');
    writeFileSync(join(dir, 'memory', '.dreams', 'state.json'), '{}');
    writeFileSync(join(dir, 'memory', 'photo.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x81]));
    writeFileSync(join(dir, 'memory', 'huge.md'), 'x'.repeat(1024 * 1024 + 1));
    const out = await readCloneMemory(localShell(dir, 'kitchen'), 'ref', 'kitchen');
    expect(out.failed).toBeUndefined();
    expect(Object.keys(out.files).sort()).toEqual(['USER.md', 'memory/2026-05-02.md#append', 'memory/2026-09-29.md', 'memory/archive/2026-01-01.md']);
    expect(out.files['memory/2026-09-29.md']).toBe('did things\n');
    expect(out.skipped.sort()).toEqual(['memory/huge.md', 'memory/photo.bin']);
  });

  it('never seeds a name that climbs out of memory/', async () => {
    const provider = {
      execShell: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({
        files: { 'USER.md': 'u', 'memory/ok.md': 'ok', 'memory/../SOUL.md': 'x', 'memory/.hidden': 'x', 'AGENTS.md': 'x', '../etc': 'x' },
        skipped: [],
      }) }),
    } as unknown as RuntimeProvider;
    const out = await readCloneMemory(provider, 'ref', 'kitchen');
    expect(Object.keys(out.files).sort()).toEqual(['USER.md', 'memory/ok.md']);
  });

  it('a failed read copies nothing and says so', async () => {
    const provider = { execShell: async () => ({ code: 1, stdout: '', stderr: 'no node' }) } as unknown as RuntimeProvider;
    expect(await readCloneMemory(provider, 'ref', 'kitchen')).toEqual({ files: {}, skipped: [], failed: true });
  });

  it('the clone route seeds them before its first build and names what stayed behind', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    const real = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, opts) =>
      script.includes('base64 -d') && script.startsWith('cd ')
        ? { code: 0, stderr: '', stdout: JSON.stringify({ files: { 'USER.md': '# Them\n', 'memory/2026-09-29.md': 'notes\n' }, skipped: ['memory/big.pdf'] }) }
        : real(ref, script, opts);
    const res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/clone', headers: as(), payload: { name: 'Kitchen Copy' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().memoryNotCopied).toEqual(['memory/big.pdf']);
    expect(res.json().memoryCopyFailed).toBeUndefined();
    const seed = w.store.getAgentSeed(res.json().id);
    expect(seed['memory/2026-09-29.md']).toBe('notes\n');
    expect(seed['USER.md']).toBe('# Them\n');
    expect(Object.keys(seed)).toContain('MEMORY.md');
  });

  it('its first build replaces the scaffold with them, and they are dropped once on the volume', async () => {
    const store = new Store(new Database(':memory:'));
    const secrets = { m: new Map<string, string>(), async put(r: string, v: string) { this.m.set(r, v); }, async get(r: string) { const v = this.m.get(r); if (v === undefined) throw new Error(r); return v; }, async delete(r: string) { this.m.delete(r); } };
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
    await secrets.put('ai/p1', 'test-key');
    const provider = new MockProvider();
    const agent = createAgentRecord(store, { ownerId: 'o', name: 'Copy', aiProfileId: 'p1', hostId: 'h1' });
    store.setAgentWebOnly(agent.id, true);
    store.setAgentSeed(agent.id, { 'SOUL.md': '# Trained', 'MEMORY.md': '# M', 'USER.md': '# Them', 'memory/2026-09-29.md': 'notes' });
    const out = await runProvisionSteps({ store, secrets, provider, channel: {} as ChannelProvisioner, sleep: async () => {} } as never, agent.id);
    expect(out.agent.state).toBe('RUNNING');
    const ws = provider.lastSpec!.workspace;
    expect(ws.files['memory/2026-09-29.md']).toBe('notes');
    expect(ws.files['SOUL.md']).toBe('# Trained');
    expect([...ws.replaceScaffold!].sort()).toEqual(['MEMORY.md', 'SOUL.md', 'USER.md', 'memory/2026-09-29.md']);
    expect(Object.keys(store.getAgentSeed(agent.id)).sort()).toEqual(['MEMORY.md', 'SOUL.md']);
  });
});

describe('"Saved to memory" means its memory files changed', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('the fingerprint moves when MEMORY.md or a daily note changes, and only then', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hb-mem-fp-'));
    mkdirSync(join(dir, 'memory'));
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n');
    const p = localShell(dir, 'kitchen');
    const a = await memoryFingerprint(p, 'ref', 'kitchen');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await memoryFingerprint(p, 'ref', 'kitchen')).toBe(a);
    writeFileSync(join(dir, 'memory', '2026-09-30.md'), 'the plan\n');
    const b = await memoryFingerprint(p, 'ref', 'kitchen');
    expect(b).not.toBe(a);
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n- Ann likes tea\n');
    expect(await memoryFingerprint(p, 'ref', 'kitchen')).not.toBe(b);
  });

  it('is unknown, not "unchanged", when the shell says nothing', async () => {
    const provider = { execShell: async () => ({ code: 0, stdout: '', stderr: '' }) } as unknown as RuntimeProvider;
    expect(await memoryFingerprint(provider, 'ref', 'kitchen')).toBeUndefined();
  });
});

describe('health says when its AI source last answered', () => {
  it('reports the last answer, then a refusal since, then the recovery', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    const a = w.store.getAgent('a1')!;
    expect(aiSourceHealth(w.store, a)).toMatchObject({ lastAnsweredAt: undefined });
    expect(aiSourceHealth(w.store, a).refusingSince).toBeUndefined();
    w.store.setUsageCursor('a1', '2026-09-30T10:00:00.000Z', '2026-09-30T10:00:00.000Z');
    expect(aiSourceHealth(w.store, a)).toMatchObject({ lastAnsweredAt: '2026-09-30T10:00:00.000Z' });
    expect(aiSourceHealth(w.store, a).refusingSince).toBeUndefined();
    // Refused (429) after that answer: refusing since then.
    w.store.addLimitHit('a1', a.aiProfileId, '2026-09-30T11:00:00.000Z', 'm');
    w.store.addLimitHit('a1', a.aiProfileId, '2026-09-30T12:00:00.000Z', 'm');
    expect(aiSourceHealth(w.store, a)).toMatchObject({ refusingSince: '2026-09-30T11:00:00.000Z', refusal: 'refused' });
    // It answered again: no longer refusing.
    w.store.noteUsageOk('a1', '2026-09-30T13:00:00.000Z');
    expect(aiSourceHealth(w.store, a).refusingSince).toBeUndefined();
    // A failed call (an expired login, say) in a later slot.
    w.store.addModelCallSlots('a1', a.aiProfileId, new Map([['2026-09-30T14:05', { ok: 0, limited: 0, failed: 2 }]]));
    expect(aiSourceHealth(w.store, a)).toMatchObject({ refusingSince: '2026-09-30T14:05:00.000Z', refusal: 'failed' });
  });

  it('rides on the health route', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    w.store.setUsageCursor('a1', '2026-09-30T10:00:00.000Z', '2026-09-30T10:00:00.000Z');
    const res = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/health', headers: as() });
    expect(res.json().aiSource).toMatchObject({ lastAnsweredAt: '2026-09-30T10:00:00.000Z' });
  });
});
