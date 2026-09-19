import { describe, expect, it } from 'vitest';
import { briefCause, redactSecrets } from '../src/domain/redact.js';
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
