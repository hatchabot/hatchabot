import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { LocalSecretStore } from '../src/secrets/localSecretStore.js';
import { SecretNotFoundError } from '../src/secrets/secretStore.js';

/**
 * Holds every bot token and API key in the system, and had zero tests —
 * mutation testing found that a CONSTANT IV (AES-GCM nonce reuse across all
 * secrets, a catastrophic crypto failure) passed the suite silently.
 */
const KEY = Buffer.alloc(32, 9);
const store = () => new LocalSecretStore(new Database(':memory:'), KEY);

describe('LocalSecretStore', () => {
  it('round-trips a secret', async () => {
    const s = store();
    await s.put('chan/a1', 'bot-token-123');
    expect(await s.get('chan/a1')).toBe('bot-token-123');
  });

  it('uses a fresh IV per write — never reuses a nonce', async () => {
    const db = new Database(':memory:');
    const s = new LocalSecretStore(db, KEY);
    // Same plaintext twice: with a constant IV the ciphertexts would match,
    // which for AES-GCM leaks plaintext relationships and breaks integrity.
    await s.put('a', 'identical');
    await s.put('b', 'identical');
    const rows = db.prepare('SELECT iv, ciphertext FROM secrets ORDER BY ref').all() as any[];
    expect(Buffer.from(rows[0].iv).equals(Buffer.from(rows[1].iv))).toBe(false);
    expect(Buffer.from(rows[0].ciphertext).equals(Buffer.from(rows[1].ciphertext))).toBe(false);
  });

  it('cannot decrypt with a different key', async () => {
    const db = new Database(':memory:');
    await new LocalSecretStore(db, KEY).put('k', 'v');
    const other = new LocalSecretStore(db, Buffer.alloc(32, 1));
    await expect(other.get('k')).rejects.toThrow();
  });

  it('fails closed when the ciphertext is tampered with', async () => {
    const db = new Database(':memory:');
    const s = new LocalSecretStore(db, KEY);
    await s.put('k', 'v');
    const row = db.prepare('SELECT ciphertext FROM secrets WHERE ref = ?').get('k') as any;
    const flipped = Buffer.from(row.ciphertext);
    flipped[0] = flipped[0]! ^ 0xff; // one bit is enough for GCM to notice
    db.prepare('UPDATE secrets SET ciphertext = ? WHERE ref = ?').run(flipped, 'k');
    await expect(s.get('k')).rejects.toThrow(); // GCM auth tag must reject it
  });

  it('throws SecretNotFoundError for an unknown ref', async () => {
    await expect(store().get('nope')).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it('deletes', async () => {
    const s = store();
    await s.put('k', 'v');
    await s.delete('k');
    await expect(s.get('k')).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});

describe('keyFromEnv', () => {
  it('treats 64 hex chars as the raw key and anything else as a passphrase', () => {
    const hex = 'a'.repeat(64);
    const raw = LocalSecretStore.keyFromEnv({ HATCHABOT_SECRET_KEY: hex } as any);
    expect(raw).toEqual(Buffer.from(hex, 'hex'));
    // 63 chars is not a hex key — it must be stretched, not truncated
    const pass = LocalSecretStore.keyFromEnv({ HATCHABOT_SECRET_KEY: 'a'.repeat(63) } as any);
    expect(pass).not.toEqual(Buffer.from('a'.repeat(63) + 'a', 'hex'));
    expect(pass).toHaveLength(32);
  });

  it('is deterministic — a restart must decrypt what the last run wrote', () => {
    const a = LocalSecretStore.keyFromEnv({ HATCHABOT_SECRET_KEY: 'my passphrase' } as any);
    const b = LocalSecretStore.keyFromEnv({ HATCHABOT_SECRET_KEY: 'my passphrase' } as any);
    expect(a).toEqual(b);
  });

  it('refuses to start without a key', () => {
    expect(() => LocalSecretStore.keyFromEnv({} as any)).toThrow(/HATCHABOT_SECRET_KEY/);
  });
});
