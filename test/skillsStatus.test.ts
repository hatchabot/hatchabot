import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURATED_SKILL_IDS } from '../src/openclaw/skills.js';
import { readSkillsStatus } from '../src/orchestrator/skills/skillsStatus.js';
import type { ExecResult } from '../src/providers/provider.js';

const SLUG = 'test-agent';
const REF = 'mock://test-agent';
const success = (value: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const entry = (name: string, extra: Record<string, unknown> = {}) => ({
  name, skillKey: name, disabled: false, blockedByAllowlist: false, blockedByAgentFilter: false,
  eligible: true, modelVisible: true, platformIncompatible: false,
  missing: { bins: [], anyBins: [], env: [], config: [], os: [] }, ...extra,
});
const report = (skills: unknown[] = CURATED_SKILL_IDS.map((id) => entry(id))) => ({ agentId: SLUG, skills });
function reader(value: unknown = report()) {
  return {
    exec: vi.fn(async (_ref: string, args: string[]): Promise<ExecResult> => args[0] === 'config' ? success(true) : success(value)),
    execShell: vi.fn(async (): Promise<ExecResult> => success({ accounts: [{ email: 'fixture@example.com' }] })),
  };
}
afterEach(() => vi.useRealTimers());

describe('readSkillsStatus', () => {
  it('scopes the read to the agent and returns only fixed curated statuses and dependency facts', async () => {
    const p = reader(report([...CURATED_SKILL_IDS.map((id) => entry(id, {
      description: 'private account text', filePath: '/private/path', primaryEnv: 'PRIVATE_ENV',
      arbitrary: { secret: 'private-secret-example' },
    })), entry('custom-private-skill')]));
    const status = await readSkillsStatus(p, REF, SLUG);
    expect(p.exec).toHaveBeenCalledWith(REF, ['gateway', 'call', 'skills.status', '--params', JSON.stringify({ agentId: SLUG }), '--json'], { timeoutMs: 30_000 });
    expect(p.exec).toHaveBeenCalledWith(REF, ['config', 'get', 'browser.enabled', '--json'], { timeoutMs: 15_000 });
    expect(p.execShell).toHaveBeenCalledWith(REF, '~/.local/bin/gog auth list --json 2>/dev/null || gog auth list --json 2>/dev/null', { timeoutMs: 15_000 });
    expect(status.status).toBe('checked');
    expect(status.skills.map((skill) => skill.id)).toEqual(CURATED_SKILL_IDS);
    expect(status.skills.every((skill) => skill.status === 'available')).toBe(true);
    expect(status.skills.find((skill) => skill.id === 'gog')?.dependencies).toEqual([{ kind: 'google_accounts', status: 'present' }]);
    expect(status.skills.find((skill) => skill.id === 'hatchabot-browser')?.dependencies).toEqual([{ kind: 'browser', status: 'present' }]);
    expect(status.skills.find((skill) => skill.id === 'hatchabot-research')?.dependencies).toEqual([{ kind: 'web_tools', status: 'unchecked' }]);
    expect(JSON.stringify(status)).not.toMatch(/private|fixture@example|custom-private|PRIVATE_ENV/);
    expect(p.exec.mock.calls.some(([, args]) => args.includes('tools.effective') || args.includes('tools.invoke'))).toBe(false);
  });

  it('distinguishes disabled, blocked, missing requirements, absent and visible instructions', async () => {
    const p = reader(report([
      entry('gog', { disabled: true, eligible: false, modelVisible: false }),
      entry('hatchabot-browser', { blockedByAgentFilter: true, modelVisible: false }),
      entry('hatchabot-research', { eligible: false, modelVisible: false, platformIncompatible: true,
        missing: { bins: ['private-bin'], anyBins: ['alternative-one', 'alternative-two'], env: ['SECRET_ENV'], config: ['private.config'], os: ['darwin'] } }),
      entry('hatchabot-writing'),
    ]));
    const status = await readSkillsStatus(p, REF, SLUG);
    expect(status.skills.map((skill) => skill.status)).toEqual(['disabled', 'missing_requirements', 'blocked', 'available', 'not_installed', 'not_installed', 'not_installed']);
    expect(status.skills.find((skill) => skill.id === 'hatchabot-jira')?.dependencies).toEqual([{ kind: 'jira_access', status: 'unchecked' }]);
    expect(status.skills.find((skill) => skill.id === 'hatchabot-images')?.dependencies).toEqual([{ kind: 'image_generation', status: 'unchecked' }]);
    expect(status.skills.find((skill) => skill.id === 'hatchabot-research')?.missing).toEqual({ tools: 2, environment: 1, configuration: 1, platform: 1 });
    expect(JSON.stringify(status)).not.toMatch(/private|alternative|SECRET_ENV|darwin/);
    expect(p.exec).toHaveBeenCalledTimes(1);
    expect(p.execShell).not.toHaveBeenCalled();
  });

  it.each([
    { blockedByAllowlist: true, eligible: false, modelVisible: false },
    { modelVisible: false },
    { eligible: false, modelVisible: false },
  ])('reports nonvisible instructions as blocked without claiming execution failure: %j', async (flags) => {
    const status = await readSkillsStatus(reader(report([entry('gog', flags)])), REF, SLUG);
    expect(status.skills[0]?.status).toBe('blocked');
  });

  it.each([
    null, [], {}, { skills: [] }, { agentId: 'another-agent', skills: [] },
    { agentId: SLUG, skills: null }, { agentId: SLUG, skills: [null] },
    { agentId: SLUG, skills: [{ name: 'gog' }] },
    { agentId: SLUG, skills: [entry('gog')], ok: false },
    { agentId: SLUG, skills: [entry('gog')], ok: 'false' },
    { agentId: SLUG, skills: [entry('gog')], error: 'private-error' },
  ])('rejects a malformed or wrongly scoped inventory: %j', async (value) => {
    const p = reader(value);
    const status = await readSkillsStatus(p, REF, SLUG);
    expect(status.status).toBe('unavailable');
    expect(status.skills).toHaveLength(CURATED_SKILL_IDS.length);
    expect(status.skills.every((skill) => skill.status === 'unavailable')).toBe(true);
    expect(p.execShell).not.toHaveBeenCalled();
  });

  it('bounds inventory and requirement-list sizes', async () => {
    expect((await readSkillsStatus(reader(report(Array.from({ length: 2001 }, () => entry('unrelated')))), REF, SLUG)).status).toBe('unavailable');
    const status = await readSkillsStatus(reader(report([entry('gog', {
      eligible: false, modelVisible: false, missing: { bins: Array.from({ length: 257 }, () => 'tool'), anyBins: [], env: [], config: [], os: [] },
    })])), REF, SLUG);
    expect(status.skills[0]?.status).toBe('unavailable');
  });

  it('refuses an absent or invalid agent scope before any provider read', async () => {
    const p = reader();
    for (const slug of ['', '../other', 'agent;command', 'a'.repeat(65)]) {
      expect((await readSkillsStatus(p, REF, slug)).status).toBe('unavailable');
    }
    expect(p.exec).not.toHaveBeenCalled();
    expect(p.execShell).not.toHaveBeenCalled();
  });

  it.each([
    [entry('gog'), entry('gog')],
    [entry('gog', { skillKey: 'custom-key' })],
    [entry('custom-name', { skillKey: 'gog' })],
    [entry('gog', { disabled: 'false' })],
    [entry('gog', { modelVisible: undefined })],
    [entry('gog', { missing: {} })],
    [entry('gog', { missing: { bins: 'gog', anyBins: [], env: [], config: [], os: [] } })],
    [entry('gog', { missing: { bins: [null], anyBins: [], env: [], config: [], os: [] } })],
    [entry('gog', { disabled: true })],
    [entry('gog', { eligible: false })],
    [entry('gog', { platformIncompatible: true })],
    [entry('gog', { missing: { bins: ['gog'], anyBins: [], env: [], config: [], os: [] } })],
  ].map((rows) => ({ rows })))('keeps an ambiguous or contradictory curated row unavailable', async ({ rows }) => {
    const p = reader(report(rows));
    const status = await readSkillsStatus(p, REF, SLUG);
    expect(status.status).toBe('checked');
    expect(status.skills[0]?.status).toBe('unavailable');
    expect(p.execShell).not.toHaveBeenCalled();
  });

  it.each(['unknown method: skills.status', 'Method not found: "skills.status"'])('recognizes the exact missing RPC as unsupported: %s', async (stderr) => {
    const p = reader();
    p.exec.mockResolvedValue({ code: 1, stdout: '', stderr });
    expect((await readSkillsStatus(p, REF, SLUG)).status).toBe('unsupported');
  });

  it.each(['permission denied', 'unknown method: tools.catalog', 'unknown method: skills.statusSomething', 'private account failed'])('does not mistake another failure for an unsupported runtime: %s', async (stderr) => {
    const p = reader();
    p.exec.mockResolvedValue({ code: 1, stdout: '', stderr });
    const status = await readSkillsStatus(p, REF, SLUG);
    expect(status.status).toBe('unavailable');
    expect(JSON.stringify(status)).not.toContain(stderr);
  });

  it.each(['timedOut', 'unreachable', 'signalled', 'volumeMissing'])('refuses a partial response marked %s', async (flag) => {
    const p = reader();
    p.exec.mockResolvedValue({ ...success(report()), [flag]: true });
    expect((await readSkillsStatus(p, REF, SLUG)).status).toBe('unavailable');
  });

  it.each(['not json', 'x'.repeat(1024 * 1024 + 1)])('refuses invalid or oversized output', async (stdout) => {
    const p = reader();
    p.exec.mockResolvedValue({ code: 0, stdout, stderr: '' });
    expect((await readSkillsStatus(p, REF, SLUG)).status).toBe('unavailable');
  });

  it('bounds a provider that never settles and handles a late rejected read', async () => {
    vi.useFakeTimers();
    const p = reader();
    let reject!: (reason: Error) => void;
    p.exec.mockImplementation(() => new Promise((_resolve, r) => { reject = r; }));
    const pending = readSkillsStatus(p, REF, SLUG);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).status).toBe('unavailable');
    reject(new Error('private late error'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs independent dependency reads together and bounds both by the remaining overall deadline', async () => {
    vi.useFakeTimers();
    const p = reader();
    p.exec.mockImplementation(async (_ref, args) => {
      if (args[0] === 'config') return new Promise(() => {});
      await new Promise((resolve) => setTimeout(resolve, 25_000));
      return success(report());
    });
    p.execShell.mockImplementation(() => new Promise(() => {}));
    const pending = readSkillsStatus(p, REF, SLUG);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(p.execShell).toHaveBeenCalledTimes(1);
    expect(p.exec).toHaveBeenCalledWith(REF, ['config', 'get', 'browser.enabled', '--json'], { timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    const status = await pending;
    expect(status.status).toBe('checked');
    expect(status.skills.flatMap((skill) => skill.dependencies).every((check) => check.status === 'unchecked')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, {}, { accounts: null }, { accounts: [null] }, { accounts: [{ email: '' }] }, { accounts: [{ email: 4 }] }, { accounts: [], ok: false }, { accounts: [], error: 'private error' }])('does not report malformed account information as a missing account: %j', async (accounts) => {
    const p = reader();
    p.execShell.mockResolvedValue(success(accounts));
    const status = await readSkillsStatus(p, REF, SLUG);
    expect(status.skills[0]?.dependencies).toEqual([{ kind: 'google_accounts', status: 'unchecked' }]);
  });

  it('reports explicit empty account lists and disabled browser config as missing, without changing instruction visibility', async () => {
    const p = reader();
    p.execShell.mockResolvedValue(success({ accounts: [] }));
    p.exec.mockImplementation(async (_ref, args) => success(args[0] === 'config' ? false : report()));
    const status = await readSkillsStatus(p, REF, SLUG);
    expect(status.skills[0]).toMatchObject({ status: 'available', dependencies: [{ kind: 'google_accounts', status: 'missing' }] });
    expect(status.skills.find((skill) => skill.id === 'hatchabot-browser')).toMatchObject({ status: 'available', dependencies: [{ kind: 'browser', status: 'missing' }] });
  });

  it.each([null, {}, 'true', 1, { enabled: true }])('requires the browser config probe to return an explicit boolean: %j', async (browser) => {
    const p = reader();
    p.exec.mockImplementation(async (_ref, args) => success(args[0] === 'config' ? browser : report()));
    const status = await readSkillsStatus(p, REF, SLUG);
    expect(status.skills.find((skill) => skill.id === 'hatchabot-browser')?.dependencies).toEqual([{ kind: 'browser', status: 'unchecked' }]);
  });

  it('handles rejected dependency reads without discarding the checked inventory', async () => {
    const p = reader();
    p.execShell.mockRejectedValue(new Error('private account path'));
    p.exec.mockImplementation(async (_ref, args) => {
      if (args[0] === 'config') throw new Error('private config path');
      return success(report());
    });
    const status = await readSkillsStatus(p, REF, SLUG);
    expect(status.status).toBe('checked');
    expect(status.skills.flatMap((skill) => skill.dependencies).every((check) => check.status === 'unchecked')).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/private/);
  });
});
