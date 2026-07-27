import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { SecretNotFoundError, type SecretStore } from './secretStore.js';

const ALGO = 'aes-256-gcm';

/**
 * Envelope-free AES-256-GCM at rest, keyed by AGENTCLAW_SECRET_KEY.
 *
 * This is deliberately the simplest thing that keeps plaintext out of the DB
 * file and out of the workspace. It is not a substitute for a managed KMS —
 * swap in a GcpSecretStore before there is a second tenant.
 */
export class LocalSecretStore implements SecretStore {
  #key: Buffer;

  constructor(
    private readonly db: Database.Database,
    key: Buffer,
  ) {
    if (key.length !== 32) {
      throw new Error('Secret key must be 32 bytes (64 hex chars)');
    }
    this.#key = key;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        ref TEXT PRIMARY KEY,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        ciphertext BLOB NOT NULL
      )
    `);
  }

  static keyFromEnv(env = process.env): Buffer {
    const hex = env.AGENTCLAW_SECRET_KEY;
    if (!hex) {
      throw new Error(
        'AGENTCLAW_SECRET_KEY is not set. Generate one with:\n' +
          "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    return Buffer.from(hex, 'hex');
  }

  async put(ref: string, value: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.db
      .prepare(
        `INSERT INTO secrets (ref, iv, tag, ciphertext) VALUES (?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET iv = excluded.iv, tag = excluded.tag,
                                        ciphertext = excluded.ciphertext`,
      )
      .run(ref, iv, tag, ciphertext);
  }

  async get(ref: string): Promise<string> {
    const row = this.db.prepare(`SELECT iv, tag, ciphertext FROM secrets WHERE ref = ?`).get(ref) as
      | { iv: Buffer; tag: Buffer; ciphertext: Buffer }
      | undefined;
    if (!row) throw new SecretNotFoundError(ref);
    const decipher = createDecipheriv(ALGO, this.#key, row.iv);
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  }

  async delete(ref: string): Promise<void> {
    this.db.prepare(`DELETE FROM secrets WHERE ref = ?`).run(ref);
  }
}
