import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TelegramPoolProvisioner, PoolExhaustedError } from '../src/channels/telegramPool.js';
import { CompositeTelegramProvisioner } from '../src/channels/composite.js';
import { ChannelSetupRequired } from '../src/channels/channel.js';
import type { TelegramManualProvisioner } from '../src/channels/telegramManual.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) {
    const v = this.map.get(ref);
    if (v === undefined) throw new Error(`no secret ${ref}`);
    return v;
  }
  async delete(ref: string) { this.map.delete(ref); }
}

const REQ = { agentId: 'a1', agentName: 'Kitchen', slug: 'kitchen' };

describe('TelegramPoolProvisioner', () => {
  it('leases idempotently per agent and counts availability', async () => {
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets());
    await pool.addToPool('bot1', 'tok1');
    expect(pool.availableCount()).toBe(1);
    const first = await pool.provision(REQ);
    const again = await pool.provision(REQ); // retry finds the same lease
    expect(first.accountId).toBe('bot1');
    expect(again.accountId).toBe('bot1');
    expect(pool.availableCount()).toBe(0);
  });

  it('release returns the bot with its token intact for the next agent', async () => {
    const secrets = new MemSecrets();
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), secrets);
    await pool.addToPool('bot1', 'tok1');
    const leased = await pool.provision(REQ);
    await pool.release(leased.accountId);
    expect(pool.availableCount()).toBe(1);
    expect(await secrets.get(leased.secretRef)).toBe('tok1'); // token kept
    const next = await pool.provision({ ...REQ, agentId: 'a2' });
    expect(next.accountId).toBe('bot1');
  });

  it('throws PoolExhaustedError when empty', async () => {
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets());
    await expect(pool.provision(REQ)).rejects.toBeInstanceOf(PoolExhaustedError);
  });
});

describe('CompositeTelegramProvisioner', () => {
  const manualStub = (released: string[]) =>
    ({
      kind: 'telegram',
      key: 'manual',
      async provision(req: any) {
        throw new ChannelSetupRequired('paste a token', req.agentId);
      },
      async release(accountId: string) { released.push(accountId); },
      async submitToken() { return { username: 'userbot' }; },
    }) as unknown as TelegramManualProvisioner;

  it('falls back to manual (ChannelSetupRequired) when the pool is dry', async () => {
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets());
    const composite = new CompositeTelegramProvisioner(pool, manualStub([]));
    await expect(composite.provision(REQ)).rejects.toBeInstanceOf(ChannelSetupRequired);
  });

  it('routes release by ownership: pool bots repooled, user bots to manual', async () => {
    const secrets = new MemSecrets();
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), secrets);
    await pool.addToPool('poolbot', 'tok');
    const manualReleased: string[] = [];
    const composite = new CompositeTelegramProvisioner(pool, manualStub(manualReleased));

    await composite.provision(REQ); // leases poolbot
    await composite.release('poolbot');
    expect(pool.availableCount()).toBe(1); // back in the pool
    expect(manualReleased).toEqual([]);

    await composite.release('someusersbot');
    expect(manualReleased).toEqual(['someusersbot']);
  });
});
