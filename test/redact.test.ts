import { describe, expect, it } from 'vitest';
import { briefCause, credentialValuesFromEnv, maskKnownValues, redactSecrets } from '../src/domain/redact.js';
import { opsListenError } from '../src/ops/opsServer.js';

/** A failure message must say enough to act on and never carry a credential. */

describe('redacting a failure', () => {
  it('masks the credentials that turn up in error text', () => {
    const cases: Array<[string, string]> = [
      ['connect ECONNREFUSED http://ops:9fZk3pQ7sample@172.19.0.1:8091', 'ops:9fZk3pQ7sample'],
      ['telegram 401 for 1234567890:AA' + 'x'.repeat(33), '1234567890:AA'],
      ['slack refused xoxb-0000-1111-abcdefghijklmnop', 'xoxb-0000'],
      ['slack refused xapp-1-A0APP-1111-abcdefghijklmnop', 'xapp-1-A0APP'],
      ['anthropic 401 sk-ant-0123456789abcdefghij', 'sk-ant-0123'],
      ['bad key ' + 'A'.repeat(48), 'A'.repeat(48)],
    ];
    for (const [text, secret] of cases) {
      const out = redactSecrets(text);
      expect(out, text).not.toContain(secret);
      expect(out).toContain('***');
    }
  });

  it('masks a credential field by its name, however short the value (2026-10-09)', () => {
    const cases: Array<[string, string]> = [
      ['GARDEN_API_TOKEN=pl4nt', 'GARDEN_API_TOKEN=***'],
      ['export DB_PASSWORD="tulip"', 'export DB_PASSWORD="***"'],
      ['{"apiKey": "seed1", "name": "Test Agent"}', '{"apiKey": "***", "name": "Test Agent"}'],
      ["config password: rose9 loaded", 'config password: *** loaded'],
      ['GET /hook?token=abc12&page=2', 'GET /hook?token=***&page=2'],
      ['Authorization: Bearer abc12', 'Authorization: ***'],
      ['const clientSecret = "fern"', 'const clientSecret = "***"'],
    ];
    for (const [text, want] of cases) expect(redactSecrets(text), text).toBe(want);
  });

  it('leaves counts, code and references alone', () => {
    for (const text of ['max_tokens: 400, tokens: 1200', 'const token = getToken(req);', 'TOKEN=$GARDEN_TOKEN', 'token: ${{ secrets.GARDEN }}', 'the tokenizer: fast', 'password reset link sent']) {
      expect(redactSecrets(text), text).toBe(text);
    }
  });

  it('masks known values exactly, and only real-looking ones', () => {
    expect(maskKnownValues('login failed for pl4nt-bed-7 at 10:00', ['pl4nt-bed-7', 'abc', ''])).toBe('login failed for *** at 10:00');
    expect(credentialValuesFromEnv({ GARDEN_API_KEY: 'k-1', HOME: '/home/pat', PWD: '/home/pat/x', SMTP_PASSWORD: 'p' })).toEqual(['k-1', 'p']);
  });

  it('keeps the part that helps: the code and a short message', () => {
    const err = Object.assign(new Error('listen EADDRNOTAVAIL: address not available 172.19.0.1:8091'), { code: 'EADDRNOTAVAIL' });
    const cause = briefCause(err);
    expect(cause).toContain('EADDRNOTAVAIL');
    expect(cause).toContain('172.19.0.1:8091');
    expect(cause.length).toBeLessThanOrEqual(160);
  });

  it('trims a long message and survives a non-Error', () => {
    expect(briefCause(new Error('something failed '.repeat(40)))).toHaveLength(160);
    // An unbroken blob that long is treated as a key, not a message.
    expect(briefCause(new Error('x'.repeat(400)))).toBe('***');
    expect(briefCause('plain string')).toBe('plain string');
    expect(briefCause(undefined)).toBe('');
  });
});

describe("the management agent's door", () => {
  it('explains Docker Desktop when the jail address cannot be bound', () => {
    const e = opsListenError(Object.assign(new Error('listen EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' }), '172.19.0.1', 8091);
    expect(e.userMessage).toMatch(/Docker Desktop/);
    expect(e.userMessage).toMatch(/other agents are unaffected/i);
  });

  it('names the clash when the port is taken', () => {
    const e = opsListenError(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }), '172.19.0.1', 8091);
    expect(e.userMessage).toMatch(/HATCHABOT_OPS_PORT/);
  });
});
