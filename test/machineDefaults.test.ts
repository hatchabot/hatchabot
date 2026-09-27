import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfigCommands } from '../src/openclaw/configWriter.js';
import { filesMb } from '../src/orchestrator/machineDefaults.js';
import { hibernateAfterMs } from '../src/orchestrator/hibernate.js';
import { as, makeWorld, seedRunningAgent } from './support/world.js';

/**
 * Defaults for this machine (Settings → Hosts): written to .env by the app,
 * applied at once — the file ceilings on every agent's apps without a
 * rebuild, the sleep timer at the next sweep — and read by the seed. An agent
 * may set its own file ceiling and its own sleep policy.
 */
const KEYS = ['HATCHABOT_ENV_FILE', 'HATCHABOT_FILES_MB_TELEGRAM', 'HATCHABOT_FILES_MB_DISCORD', 'HATCHABOT_FILES_MB_SLACK', 'HATCHABOT_HIBERNATE_AFTER', 'HATCHABOT_AGENT_MEMORY', 'HATCHABOT_EMBEDDER_MEMORY'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });
const envFile = () => {
  const f = join(mkdtempSync(join(tmpdir(), 'hb-md-')), '.env');
  writeFileSync(f, 'HATCHABOT_SECRET_KEY=x\n');
  process.env.HATCHABOT_ENV_FILE = f;
  return f;
};

describe('machine defaults', () => {
  it('the owner sets a file ceiling: it lands in .env and on every running agent on that app at once', async () => {
    const w = await makeWorld();
    const f = envFile();
    const id = await seedRunningAgent(w);
    const list = await w.f.inject({ method: 'GET', url: '/v1/machine-defaults', headers: as() });
    expect(list.statusCode).toBe(200);
    expect(list.json().defaults.find((d: any) => d.key === 'filesTelegram')).toMatchObject({ value: '50', set: false });
    const put = await w.f.inject({ method: 'PUT', url: '/v1/machine-defaults', headers: as(), payload: { key: 'filesTelegram', value: '20' } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ default: { value: '20', set: true }, applied: 1 });
    expect(readFileSync(f, 'utf8')).toMatch(/^HATCHABOT_FILES_MB_TELEGRAM=20$/m);
    expect(w.provider.execLog).toContainEqual(['config', 'set', 'channels.telegram.mediaMaxMb', '20']);
    expect(filesMb('telegram')).toBe(20);
    // Past the app's own limit, or not a number: refused, nothing written.
    for (const value of ['51', '0', 'lots']) {
      const bad = await w.f.inject({ method: 'PUT', url: '/v1/machine-defaults', headers: as(), payload: { key: 'filesTelegram', value } });
      expect(bad.statusCode).toBe(400);
    }
    expect(readFileSync(f, 'utf8')).toMatch(/^HATCHABOT_FILES_MB_TELEGRAM=20$/m);
    expect(w.store.listEvents([id]).length >= 0).toBe(true);
  });

  it('sleep after: a duration or off, at least 30 minutes, read by the next sweep; nobody but the machine owner may set it', async () => {
    const w = await makeWorld();
    envFile();
    expect((await w.f.inject({ method: 'PUT', url: '/v1/machine-defaults', headers: as(), payload: { key: 'sleepAfter', value: '12h' } })).statusCode).toBe(200);
    expect(hibernateAfterMs()).toBe(12 * 3_600_000);
    expect((await w.f.inject({ method: 'PUT', url: '/v1/machine-defaults', headers: as(), payload: { key: 'sleepAfter', value: '10m' } })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'PUT', url: '/v1/machine-defaults', headers: as(), payload: { key: 'sleepAfter', value: 'off' } })).statusCode).toBe(200);
    expect(hibernateAfterMs()).toBe(0);
    expect((await w.f.inject({ method: 'GET', url: '/v1/machine-defaults', headers: as('user-other') })).statusCode).toBe(403);
    expect((await w.f.inject({ method: 'PUT', url: '/v1/machine-defaults', headers: as('user-other'), payload: { key: 'sleepAfter', value: '1h' } })).statusCode).toBe(403);
    expect((await w.f.inject({ method: 'PUT', url: '/v1/machine-defaults', headers: as(), payload: { key: 'HATCHABOT_PORT', value: '1' } })).statusCode).toBe(400);
  });

  it('an agent\'s own file ceiling applies at once, capped by each app; the seed reads machine and agent values', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const res = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { filesMaxMb: 200 } });
    expect(res.statusCode, res.body).toBe(200);
    expect(w.store.getAgent(id)!.filesMaxMb).toBe(200);
    expect(w.provider.execLog).toContainEqual(['config', 'set', 'channels.telegram.mediaMaxMb', '50']); // Telegram's own limit
    const base = { agentId: 'x', authMode: 'api-key' as const, model: 'm', openclawVersion: '2026.9.6' };
    const arg = (cmds: ReturnType<typeof buildConfigCommands>, path: string) => cmds.find((c) => c.argv[0] === 'config' && c.argv[2] === path)?.argv[3];
    process.env.HATCHABOT_FILES_MB_DISCORD = '30';
    const seeded = buildConfigCommands({ ...base, channelPlugins: ['discord'], pluginInstall: 'npm', discord: { token: 't', applicationId: 'a', allowFrom: [], rooms: { mode: 'off' } } } as never);
    expect(arg(seeded, 'channels.discord.mediaMaxMb')).toBe('30');
    const own = buildConfigCommands({ ...base, filesMaxMb: 5, channelPlugins: ['discord'], pluginInstall: 'npm', discord: { token: 't', applicationId: 'a', allowFrom: [], rooms: { mode: 'off' } } } as never);
    expect(arg(own, 'channels.discord.mediaMaxMb')).toBe('5');
    // Back to the machine's value.
    expect((await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { filesMaxMb: null } })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.filesMaxMb).toBeUndefined();
  });
});
