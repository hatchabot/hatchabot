import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { buildReport, issueUrl, knownProblems, matchKnownProblems, newerRelease, readSource, redactForPublic, searchSource, sourcePath, type ReportFacts } from '../src/orchestrator/problemReport.js';

/**
 * "Report a problem" (docs/field-reports.md): a public GitHub issue made from
 * a home machine — what it masks, what it carries, how the link is cut when it
 * is too long, and what of the install the agent may read. Made-up data only.
 */
const ctx = { home: '/home/pat', user: 'pat', host: 'kitchen-box' };

describe('redactForPublic', () => {
  it('masks what makes a home machine identifiable, and secrets', () => {
    const out = redactForPublic([
      'open /home/pat/hatchabot/data/x.sqlite failed',
      'ssh://pat@laptop.example.org refused',
      'runner laptop.example-tail.ts.net at 192.168.1.40 and 100.88.1.2, gateway 10.0.0.1',
      'user pat on kitchen-box',
      'mail sam@example.org',
      'key sk-abcdefghijklmnopqrstuvwxyz',
    ].join('\n'), ctx);
    expect(out).not.toMatch(/\/home\/pat|pat@|kitchen-box|192\.168|100\.88|10\.0\.0\.1|sam@example|sk-abc|\.ts\.net/);
    expect(out).toContain('~/hatchabot/data/x.sqlite');
    expect(out).toContain('<private-ip>');
    expect(out).toContain('<user> on <host>');
  });

  it('masks a Telegram bot username, but not Hatchabot; a timestamp is not an address', () => {
    expect(redactForPublic('[telegram] [kitchenhelperbot] starting provider (@KitchenHelperBot) for Hatchabot', ctx)).toBe('[telegram] [<bot>] starting provider (<bot>) for Hatchabot');
    expect(redactForPublic('2026-10-01T00:23:10.123+00:00 ok; peer 10.1.2.3', ctx)).toBe('2026-10-01T00:23:10.123+00:00 ok; peer <private-ip>');
  });

  it('leaves public addresses and ordinary words alone', () => {
    expect(redactForPublic('pulled ghcr.io/hatchabot/runtime:2026.9.6 from 140.82.112.3; patience', ctx)).toBe('pulled ghcr.io/hatchabot/runtime:2026.9.6 from 140.82.112.3; patience');
  });
});

const facts: ReportFacts = {
  version: 'v9.9.9', install: 'bundle linux-arm64', platform: 'linux-arm64', node: 'v22.0.0', openclaw: '2026.9.6',
  doctor: [{ level: 'ok', text: 'Docker 29' }, { level: 'fail', text: 'Backups: none', fix: 'run scripts/backup-volumes.sh' }],
  failures: [{ at: '2026-10-06T10:00:00Z', event: 'provision.failed', agent: 'Recipe Box', detail: '{"error":"disk full in /home/pat"}' }],
  agent: { name: 'Recipe Box', state: 'FAILED', reason: 'disk full', model: 'claude-sonnet-5', logs: 'line 1\nline 2' },
};

describe('buildReport', () => {
  it('starts with the marker, carries the facts, masked, and leaves agent names out', () => {
    const r = buildReport({ title: 'Rebuild fails at kitchen-box', whatHappened: 'It failed.', steps: '1. Rebuild', diagnosis: 'The disk check is wrong (src/x.ts:12).', confidence: 'medium', suggestedPatch: '--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-a\n+b', by: 'agent' }, facts, ctx);
    expect(r.body.split('\n')[0]).toBe('<!-- hatchabot-report v1 version=v9.9.9 install=bundle-linux-arm64 -->');
    expect(r.title).toBe('Rebuild fails at <host>');
    for (const h of ['### What happened', '### Steps to reproduce', '### Diagnosis (by the Hatchabot agent on this machine — confidence: medium)', '### Suggested fix (against v9.9.9)', '### Environment', '### hatchabot doctor', '### Recent failures', '### Agent log']) expect(r.body).toContain(h);
    expect(r.body).toContain('```diff\n--- a/src/x.ts');
    expect(r.body).toContain('✗ Backups: none\n    → run scripts/backup-volumes.sh');
    expect(r.body).toContain('disk full in ~');
    expect(r.body).not.toContain('Recipe Box');
  });

  it("a person's report has no agent section and no diagnosis heading", () => {
    const r = buildReport({ title: 'x', whatHappened: 'y', by: 'person' }, { version: 'v1.0.0', install: 'git checkout', platform: 'darwin-arm64', node: 'v22' }, ctx);
    expect(r.body).not.toContain('### Diagnosis');
    expect(r.body).not.toContain('### Suggested fix');
    expect(r.body).toContain('Hatchabot v1.0.0 (git checkout) · darwin-arm64 · Node v22');
  });
});

describe('issueUrl', () => {
  it('a short report goes whole into the link, with the label', () => {
    const { url, trimmed } = issueUrl('T', 'short body');
    expect(trimmed).toBe(false);
    expect(url).toBe('https://github.com/hatchabot/hatchabot/issues/new?labels=field-report&title=T&body=short%20body');
  });

  it('a long one is cut to fit, bulky sections first, and asks for the file', () => {
    const r = buildReport({ title: 'x', whatHappened: 'what', diagnosis: 'why', by: 'agent' }, { ...facts, agent: { ...facts.agent!, logs: 'log line\n'.repeat(2000) } }, ctx);
    const { url, trimmed } = issueUrl(r.title, r.body, { file: 'hatchabot-report-a.md', max: 7500 });
    expect(trimmed).toBe(true);
    expect(url.length).toBeLessThanOrEqual(7500);
    const body = decodeURIComponent(url.split('&body=')[1]!);
    expect(body).toContain('### Agent log (last lines) — in the attached file');
    expect(body).toContain('### Diagnosis');
    expect(body).toContain('hatchabot-report-a.md');
  });
});

describe('the installed source, read-only', () => {
  it('refuses the install\'s own state and anything outside', () => {
    for (const p of ['.env', 'data/hatchabot.sqlite', 'node_modules/x/index.js', '.git/config', '../etc/passwd', '/etc/passwd', 'src/../.env', '']) {
      expect(() => sourcePath(process.cwd(), p), p).toThrow();
    }
    expect(sourcePath(process.cwd(), 'src/api/routes.ts')).toMatch(/src\/api\/routes\.ts$/);
  });

  it('reads with line numbers, at most 400 lines; a folder lists its files', () => {
    const r = readSource(process.cwd(), 'src/orchestrator/problemReport.ts', 1, 5000);
    expect(r.to - r.from).toBe(399 < r.lines ? 399 : r.lines - 1);
    expect(r.text.split('\n')[0]).toMatch(/^1\t/);
    expect(readSource(process.cwd(), 'docs').text).toContain('field-reports.md');
    expect(() => readSource(process.cwd(), 'docs/no-such-file.md')).toThrow(/No file/);
  });

  it('the knowledge pack comes first and is never crowded out by code (a broad "400" missed the playbook, 2026-10-07)', () => {
    const hit = searchSource(process.cwd(), '400');
    expect(hit.matches[0]!.path).toBe('docs/troubleshooting.md');
    const entry = hit.matches.find((m) => m.path === 'docs/troubleshooting.md' && /request format rejected/.test(m.text));
    expect(entry?.entry).toMatch(/^Every message fails with "LLM request failed/);
    expect(hit.matches.filter((m) => !m.path.startsWith('docs/troubleshooting.md') && !m.path.startsWith('docs/architecture-map.md')).length).toBeLessThanOrEqual(40);
  });

  it('a draft that quotes a known error names the playbook entry (the real draft, 2026-10-07)', () => {
    const real = "HTTP 400 'request format rejected' on every request when model = claude-opus-5-5\n### What happened\nWhen the chat was switched to claude-opus-5-5, every message failed with 'LLM request failed (request format rejected, HTTP 400).'";
    expect(knownProblems(process.cwd(), real).map((k) => k.title)[0]).toMatch(/request format rejected, HTTP 400/);
    expect(knownProblems(process.cwd(), 'The garden agent planted tomatoes in "the wrong raised bed again" today.')).toEqual([]);
  });

  it('searches the code and docs, capped', () => {
    const hit = searchSource(process.cwd(), 'export function redactForPublic');
    expect(hit.matches.some((m) => m.path === 'src/orchestrator/problemReport.ts')).toBe(true);
    const many = searchSource(process.cwd(), 'import', 'src', 5);
    expect(many.matches).toHaveLength(5);
    expect(many.more).toBe(true);
    expect(searchSource(process.cwd(), 'HATCHABOT_SECRET_KEY', 'docs').matches.every((m) => m.path.startsWith('docs/'))).toBe(true);
  });
});

describe('check_known_problem (matchKnownProblems)', () => {
  const titles = readFileSync('docs/troubleshooting.md', 'utf8').split(/^### /m).slice(1).map((b) => b.split('\n')[0]!.trim());
  it('every playbook entry is found first from its own symptom line', () => {
    const missed = titles.filter((t) => matchKnownProblems(process.cwd(), t, 'v2.138.0').matches[0]?.title !== t);
    expect(missed).toEqual([]);
  });
  it('the incident the Hatchabot agent got wrong is found from how it was described (2026-10-07), with the whole entry', () => {
    const r = matchKnownProblems(process.cwd(), "taxjson QA: every message failed with 'LLM request failed (request format rejected, HTTP 400)' when the chat was switched to Claude Opus 5.5", 'v2.138.0');
    expect(r.matches[0]!.title).toMatch(/request format rejected, HTTP 400/);
    expect(r.matches[0]!.text).toMatch(/\*\*Check:\*\*[\s\S]*\*\*Cause:\*\*[\s\S]*\*\*Fix:\*\*/);
  });
  it('says nothing rather than something wrong', () => {
    for (const q of ['how do I invite my partner to an agent', 'the agent is slow to answer', 'can I rename an agent', 'my agent gives wrong answers about recipes']) {
      expect(matchKnownProblems(process.cwd(), q, 'v2.138.0').matches, q).toEqual([]);
    }
  });
  it('a fix in a newer release than the one installed says so', () => {
    const stale = matchKnownProblems(process.cwd(), 'A runner agent shows as running although its container stopped or is gone', 'v2.133.0').matches[0]!;
    expect(stale).toMatchObject({ fixedIn: 'v2.134.0', fixedInNewerRelease: true });
    expect(matchKnownProblems(process.cwd(), 'A runner agent shows as running although its container stopped or is gone', 'v2.138.0').matches[0]!.fixedInNewerRelease).toBe(false);
    expect(newerRelease('v2.10.0', 'v2.9.9')).toBe(true);
  });
});

describe('the routes', () => {
  const as = (who: string) => ({ 'x-hatchabot-owner': who });
  async function app() {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'owner-1', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', new MockProvider()]]),
      channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } }, reportDoctor: async () => [{ level: 'ok', text: 'Docker 29 (made up)' }],
    } as never);
    return { f, store };
  }

  it('a draft is private to who made it, carries the facts, and only changes when edited', async () => {
    const { f } = await app();
    const r = await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: as('owner-1'), payload: { title: 'Backups stop', whatHappened: 'Nothing since Monday.', by: 'agent', diagnosis: 'x' } });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json() as { id: string; body: string; issueUrl: string; reviewPath: string; by: string };
    expect(d.by).toBe('agent');
    expect(d.body).toContain('✓ Docker 29 (made up)');
    expect(d.issueUrl).toMatch(/^https:\/\/github\.com\/hatchabot\/hatchabot\/issues\/new\?/);
    expect(d.reviewPath).toBe(`/#report=${d.id}`);
    expect((await f.inject({ method: 'GET', url: `/v1/problem-reports/${d.id}`, headers: as('someone-else') })).statusCode).toBe(404);
    expect((await f.inject({ method: 'GET', url: '/v1/problem-reports', headers: as('someone-else') })).json()).toEqual([]);
    const e = await f.inject({ method: 'PATCH', url: `/v1/problem-reports/${d.id}`, headers: as('owner-1'), payload: { body: 'my own words' } });
    expect((e.json() as { body: string }).body).toBe('my own words');
    expect((await f.inject({ method: 'POST', url: `/v1/problem-reports/${d.id}/sent`, headers: as('owner-1') })).statusCode).toBe(200);
    expect(((await f.inject({ method: 'GET', url: '/v1/problem-reports', headers: as('owner-1') })).json() as Array<{ sentAt?: string; body?: string }>)[0]).toMatchObject({ sentAt: expect.any(String) });
    expect((await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: as('owner-1'), payload: { title: 'x' } })).statusCode).toBe(400);
  });

  it('someone who is not the machine owner gets no doctor', async () => {
    const { f } = await app();
    const d = (await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: as('member-2'), payload: { title: 't', whatHappened: 'w' } })).json() as { body: string };
    expect(d.body).not.toContain('### hatchabot doctor');
  });

  it('GET /v1/known-problems answers with the installed version and the matches', async () => {
    const { f } = await app();
    expect((await f.inject({ method: 'GET', url: '/v1/known-problems?symptom=x', headers: as('owner-1') })).statusCode).toBe(400);
    const r = await f.inject({ method: 'GET', url: '/v1/known-problems?symptom=' + encodeURIComponent('every message fails: "LLM request failed (request format rejected, HTTP 400)"'), headers: as('owner-1') });
    expect(r.statusCode).toBe(200);
    expect(r.json().installed).toMatch(/^v\d+\.\d+\.\d+/);
    expect(r.json().matches[0].title).toMatch(/request format rejected/);
  });

  it('the source routes read the code and refuse .env', async () => {
    const { f } = await app();
    expect((await f.inject({ method: 'GET', url: '/v1/source?path=.env', headers: as('owner-1') })).statusCode).toBe(400);
    const ok = await f.inject({ method: 'GET', url: '/v1/source?path=package.json&from=1&to=3', headers: as('owner-1') });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { text: string }).text).toContain('"name"');
    const s = await f.inject({ method: 'GET', url: '/v1/source/search?q=field-report&under=docs', headers: as('owner-1') });
    expect((s.json() as { matches: unknown[] }).matches.length).toBeGreaterThan(0);
  });
});
