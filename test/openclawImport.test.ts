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
            a1bot: { botToken: 'tok-a1', enabled: true, allowFrom: ['123', 'not-a-number'] },
            adoptedbot: { botToken: 'tok-adopted', enabled: true },
          },
        },
      },
    }),
  );
}

function storeWithAdopted() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'x1', ownerId: 'o', name: 'Already Here', slug: 'already-here', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'x', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
  store.insertChannel({ id: 'c1', agentId: 'x1', kind: 'telegram', accountId: 'adoptedbot', secretRef: 'chan/x1', deepLink: 'https://t.me/adoptedbot', createdAt: 'now' });
  return store;
}

describe('discoverOpenclawAgents', () => {
  it('lists agents with bot, adoption status, and a missing-folder flag', () => {
    const cfg = join(root, 'discover.json');
    writeConfig(cfg);
    const agents = discoverOpenclawAgents({ store: storeWithAdopted() }, cfg);
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

    // already brought into AgentClaw on that bot
    expect(by['stock-advisor']!.alreadyAdoptedAs).toBe('Already Here');
  });

  it('returns [] when the config is unreadable', () => {
    expect(discoverOpenclawAgents({ store: storeWithAdopted() }, join(root, 'nope.json'))).toEqual([]);
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
    // getUpdates stub: a1's token is quiet, adopted's token stays busy (409).
    const fetchImpl = (async (url: string | URL) => {
      const busy = String(url).includes('tok-adopted');
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
});
