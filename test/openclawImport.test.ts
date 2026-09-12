import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import {
  discoverOpenclawAgents,
  disableOpenclawBot,
  quiesceOpenclawBots,
} from '../src/orchestrator/openclawImport.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

class MemSecrets implements SecretStore {
  private m = new Map<string, string>();
  async put(ref: string, val: string) { this.m.set(ref, val); }
  async get(ref: string) { const v = this.m.get(ref); if (v === undefined) throw new Error(`no secret ${ref}`); return v; }
  async delete(ref: string) { this.m.delete(ref); }
}

const root = mkdtempSync(join(tmpdir(), 'acl-oc-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Two real workspace dirs, one deliberately absent.
const wsA1 = join(root, 'workspace-tech-advisor');
const wsAdopted = join(root, 'workspace-stock-advisor');
mkdirSync(wsA1, { recursive: true });
mkdirSync(wsAdopted, { recursive: true });

function writeConfig(path: string) {
  writeFileSync(
    path,
    JSON.stringify({
      agents: {
        list: [
          { id: 'tech-advisor', workspace: wsA1 },
          { id: 'ghost', workspace: join(root, 'workspace-gone') }, // missing dir, no binding
          { id: 'stock-advisor', workspace: wsAdopted },
        ],
      },
      bindings: [
        { agentId: 'tech-advisor', match: { channel: 'telegram', accountId: 'a1bot' } },
        { agentId: 'stock-advisor', match: { accountId: 'adoptedbot' } },
      ],
      channels: {
        telegram: {
          accounts: {
            a1bot: { botToken: '111:aaa', enabled: true, allowFrom: ['123', 'not-a-number'] },
            adoptedbot: { botToken: '222:bbb', enabled: true },
          },
        },
      },
    }),
  );
}

async function storeWithAdopted() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'x1', ownerId: 'o', name: 'Already Here', slug: 'already-here', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'x', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
  // The channel's account_id is the REAL @username, deliberately different from
  // OpenClaw's config key "adoptedbot" — but the token has the same bot-id (222),
  // which is what discovery must match on.
  store.insertChannel({ id: 'c1', agentId: 'x1', kind: 'telegram', accountId: 'RealAdoptedName', secretRef: 'chan/x1', deepLink: 'https://t.me/RealAdoptedName', createdAt: 'now' });
  await secrets.put('chan/x1', '222:zzz');
  return { store, secrets };
}

describe('discoverOpenclawAgents', () => {
  it('lists agents, and matches an already-imported one by bot-id even when relabelled', async () => {
    const cfg = join(root, 'discover.json');
    writeConfig(cfg);
    const { store, secrets } = await storeWithAdopted();
    const agents = await discoverOpenclawAgents({ store, secrets }, cfg);
    const by = Object.fromEntries(agents.map((a) => [a.id, a]));

    expect(by['tech-advisor']).toMatchObject({
      name: 'Tech Advisor', // derived from workspace-tech-advisor
      bot: { accountId: 'a1bot', enabledInSource: true, allowFrom: ['123'] }, // junk id filtered
    });
    expect(by['tech-advisor']!.alreadyAdoptedAs).toBeUndefined();
    expect(by['tech-advisor']!.problem).toBeUndefined();

    // no binding → no bot; missing folder → flagged
    expect(by['ghost']!.bot).toBeUndefined();
    expect(by['ghost']!.problem).toMatch(/missing/);

    // config key "adoptedbot" ≠ stored @username "RealAdoptedName", but the
    // bot-id (222) matches → still recognised as already imported
    expect(by['stock-advisor']!.alreadyAdoptedAs).toBe('Already Here');
  });

  it('returns [] when the config is unreadable', async () => {
    const { store, secrets } = await storeWithAdopted();
    expect(await discoverOpenclawAgents({ store, secrets }, join(root, 'nope.json'))).toEqual([]);
  });
});

describe('disableOpenclawBot', () => {
  it('flips enabled to false, backs the file up, and is idempotent', () => {
    const cfg = join(root, 'disable.json');
    writeConfig(cfg);

    expect(disableOpenclawBot('a1bot', cfg)).toEqual({ changed: true });
    const after = JSON.parse(readFileSync(cfg, 'utf8'));
    expect(after.channels.telegram.accounts.a1bot.enabled).toBe(false);
    expect(existsSync(`${cfg}.agentclaw-bak`)).toBe(true);
    // backup still has the pre-edit value
    expect(JSON.parse(readFileSync(`${cfg}.agentclaw-bak`, 'utf8')).channels.telegram.accounts.a1bot.enabled).toBe(true);
    // second call is a no-op
    expect(disableOpenclawBot('a1bot', cfg)).toEqual({ changed: false });
  });

  it('throws for an unknown account', () => {
    const cfg = join(root, 'disable2.json');
    writeConfig(cfg);
    expect(() => disableOpenclawBot('nope', cfg)).toThrow(/No Telegram account/);
  });
});

describe('quiesceOpenclawBots', () => {
  it('disables each bot, restarts once, and reports which went quiet', async () => {
    const cfg = join(root, 'quiesce.json');
    writeConfig(cfg);
    // getUpdates stub: a1's token (111) is quiet, adopted's (222) stays busy.
    const fetchImpl = (async (url: string | URL) => {
      const busy = String(url).includes('bot222:');
      return busy
        ? { status: 409, json: async () => ({ error_code: 409 }) }
        : { status: 200, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;

    let restarts = 0;
    const res = await quiesceOpenclawBots(['a1bot', 'adoptedbot'], {
      configPath: cfg,
      fetchImpl,
      settleMs: 0,
      restart: async () => {
        restarts++;
      },
    });

    expect(restarts).toBe(1); // ONE restart for the batch
    expect(res.quiet).toEqual(['a1bot']);
    expect(res.stillBusy).toEqual(['adoptedbot']);
    // both were disabled in the file
    const after = JSON.parse(readFileSync(cfg, 'utf8'));
    expect(after.channels.telegram.accounts.a1bot.enabled).toBe(false);
    expect(after.channels.telegram.accounts.adoptedbot.enabled).toBe(false);
  });

  it('validates ALL ids before writing — a bad id leaves the config untouched and never restarts', async () => {
    const cfg = join(root, 'quiesce-atomic.json');
    writeConfig(cfg);
    let restarts = 0;
    await expect(
      quiesceOpenclawBots(['a1bot', 'does-not-exist'], { configPath: cfg, settleMs: 0, restart: async () => { restarts++; } }),
    ).rejects.toThrow(/No Telegram account/);
    // a1bot must NOT have been disabled (no partial write), and no restart ran —
    // otherwise a bot would be disabled-in-config yet still polled.
    const after = JSON.parse(readFileSync(cfg, 'utf8'));
    expect(after.channels.telegram.accounts.a1bot.enabled).toBe(true);
    expect(restarts).toBe(0);
  });
});
