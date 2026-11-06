import { describe, expect, it } from 'vitest';
import { briefCause, credentialValuesFromEnv, maskKnownValues, redactSecrets } from '../src/domain/redact.js';
import { opsListenError } from '../src/ops/opsServer.js';
import { SLACK_APP_TOKEN } from './support/fixtures.js';

/** A failure message must say enough to act on and never carry a credential. */

describe('redacting a failure', () => {
  it('a credential field inside a string, however it is escaped, or written as a hash', () => {
    expect(redactSecrets(JSON.stringify({ error: 'login failed: {"username":"quincy","password":"made-up-1","apiKey":"abc"}' })))
      .toBe('{"error":"login failed: {\\"username\\":\\"quincy\\",\\"password\\":\\"***\\",\\"apiKey\\":\\"***\\"}"}');
    expect(redactSecrets(String.raw`{"body":"{\"password\":\"made-up-1\"}"}`)).toBe(String.raw`{"body":"{\"password\":\"***\"}"}`);
    expect(redactSecrets(String.raw`\\"token\\": \\"made-up-1\\", next`)).toBe(String.raw`\\"token\\": \\"***\\", next`);
    expect(redactSecrets(`'password' => 'made-up-1'`)).toBe(`'password' => '***'`);
    expect(redactSecrets(`"password"=>"made-up-1"`)).toBe(`"password"=>"***"`);
    expect(redactSecrets(String.raw`\"max_tokens\":\"400\"`)).toBe(String.raw`\"max_tokens\":\"400\"`);
  });
  it('a quoted name and its value in every quoting, cut off, unquoted, or as a Ruby hash (HB-0501)', () => {
    const cases: Array<[string, string]> = [
      // An escaped quote inside the value no longer cuts it.
      [String.raw`{"x":"{\"token\":\"a\\\"b-made-up\"}"}`, String.raw`{"x":"{\"token\":\"***\"}"}`],
      // Cut off: to the end of the line.
      [String.raw`\"password\":\"made-up`, String.raw`\"password\":\"***`],
      ['"password": "made-up\nnext line', '"password": "***\nnext line'],
      ['"password": "made-up\\\nnext "line"', '"password": "***\nnext "line"'],
      // No quotes round the value.
      [String.raw`\"token\":123456`, String.raw`\"token\":***`],
      [String.raw`\"token\":123456,\"user\":\"quincy\"`, String.raw`\"token\":***,\"user\":\"quincy\"`],
      // Quoting that JSON.stringify never makes.
      [String.raw`\\"password\":\"made-up\"`, String.raw`\\"password\":\"***\"`],
      [String.raw`"password\":\"made-up\"`, String.raw`"password\":\"***\"`],
      // Ruby.
      [':password => "made-up"', ':password => "***"'],
      [':password => made-up', ':password => ***'],
      ['password => made-up', 'password => ***'],
      [':token=>made-up', ':token=>***'],
    ];
    for (const [text, want] of cases) expect(redactSecrets(text), text).toBe(want);
    for (const text of ['token => token.trim()', 'secret => secret.value', 'password => { return check(password) }', String.raw`\"token\":\"$GARDEN_TOKEN\"`, String.raw`\"max_tokens\":400`]) {
      expect(redactSecrets(text), text).toBe(text);
    }
  });
  it('a value ending in a backslash, or with escaped quotes, ends at its own quote at every level, so the next field still goes (HB-0501 review)', () => {
    for (const obj of [{ password: 'Made-up\\', token: 'made-up-2' }, { password: 'a"b\\', token: 'q\\"z', api_key: 'made-up-3' }]) {
      let text = JSON.stringify(obj);
      for (let level = 0; level < 3; level++) {
        const out = redactSecrets(`log: ${text}`);
        for (const value of Object.values(obj)) expect(out, `level ${level}: ${text}`).not.toContain(value.replace(/[\\"]/g, '').slice(0, 6));
        for (const name of Object.keys(obj)) expect(out, `level ${level}`).toContain(name);
        text = JSON.stringify(text);
      }
    }
    // Hand-made: a run of backslashes no encoder writes, before the next name's quote.
    expect(redactSecrets(String.raw`{\\\"password\\\":\\\"abc\\\\\\\\\\\\\\\",\\\"token\\\":\\\"made-up-2\\\"}`)).not.toContain('made-up-2');
    const cases: Array<[string, string]> = [
      [String.raw`{'password': 'it\'s-made-up'}`, `{'password': '***'}`],
      [String.raw`\"password\":\"Made` + '\r' + String.raw`9x\"`, String.raw`\"password\":\"***\"`],
      ['“password”: “made-up-1”', '“password”: “***”'], ['‘token’: ‘made-up-1’', '‘token’: ‘***’'], ['password：made-up-1', 'password：***'], ['"password"：“made-up-1”', '"password"：“***”'],
      ['password => !Made2up', 'password => ***'], ['password => (made-up)', 'password => ***)'],
      ["x ? 'password': 'made-up'", "x ? 'password': '***'"],
    ];
    for (const [text, want] of cases) expect(redactSecrets(text), text).toBe(want);
    for (const text of ['tokens.filter(token => token && ok)', 'list.some(token => token === x)', '+  const ids = secrets.map(secret => secret.id);', 'const f = (password) => password.length > 8',
      "const mode = flag ? 'api-key' : cfg.mode;"]) expect(redactSecrets(text), text).toBe(text);
  });
  it("a shell's single-quoted value ending in a backslash, curly quotes after a bare name, and code that is really code (second review of HB-0501)", () => {
    const cases: Array<[string, string]> = [
      [String.raw`docker run -e DB_PASSWORD='p@ss\' -e API_TOKEN='Xy9madeupvalue' img`, `docker run -e DB_PASSWORD='***' -e API_TOKEN='***' img`],
      [String.raw`token='C:\' password='made-up'`, `token='***' password='***'`],
      [String.raw`export PASSWORD='abc\' TOKEN='made-up-2'`, `export PASSWORD='***' TOKEN='***'`],
      [String.raw`password="a\" token="made-up-2"`, `password="***" token="***"`],
      ['password: “correct horse battery”', 'password: “***”'], ['password：“made up”', 'password：“***”'], ['token: «made up»', 'token: «***»'],
      ['password => Secret.Value', 'password => ***'], ['password => made2up.x', 'password => ***'], ['{ password => q(made2up) }', '{ password => ***) }'], ['password => Made2up && x', 'password => *** && x'],
      [String.raw`password='it\'s' ok`, `password='***' ok`],
      ["x ? 'password' : Correct.Horse", "x ? 'password' : ***"], ["mode ? 'password' : s3cr3t.k3y", "mode ? 'password' : ***"],
    ];
    for (const [text, want] of cases) expect(redactSecrets(text), text).toBe(want);
    for (const text of ['token => my.secret', "x ? 'password' : getPass()", "const mode = flag ? 'api-key' : cfg.mode;"]) expect(redactSecrets(text), text).not.toMatch(/\*\*\*/);
  });
  it('a number or _BASE after the name, and known token prefixes cut short (HB-0499)', () => {
    const cases: Array<[string, string]> = [
      ['TOKEN2=made-up', 'TOKEN2=***'], ['PASSWORD1=made-up', 'PASSWORD1=***'], ['API_KEY_2=made-up', 'API_KEY_2=***'], ['SECRET_KEY_BASE=made-up', 'SECRET_KEY_BASE=***'],
      ['clone failed: glpat-made-up-12', 'clone failed: ***'], ['hub said no to hf_MadeUp1234', 'hub said no to ***'], ['push with gho_MadeUp12', 'push with ***'],
    ];
    for (const [text, want] of cases) expect(redactSecrets(text), text).toBe(want);
    for (const text of ['token_count=5', 'pip install hf_transfer', 'hf_hub_download failed', 'the password1 field']) expect(redactSecrets(text), text).toBe(text);
  });
  it("the shell's PWD holds a folder, not a password: only a value that starts like a path, and only by that exact name", () => {
    expect(redactSecrets('PWD=/srv/Smith Family/x ; USER=root')).toBe('PWD=/srv/Smith Family/x ; USER=root');
    expect(redactSecrets('OLDPWD=~/x')).toBe('OLDPWD=~/x');
    // Sudo writes neither of these: a quoted name, and a `;` right against it, are a password.
    expect(redactSecrets('"PWD": "/made-up"')).toBe('"PWD": "***"');
    expect(redactSecrets('Server=db;Uid=sa;PWD=/made-up;')).toBe('Server=db;Uid=sa;PWD=***;');
    expect(redactSecrets('PWD=~made-up')).toBe('PWD=***');
    for (const [a, b] of [['PWD=hunter2', 'PWD=***'], ['pwd=/hunter2', 'pwd=***'], ['DB_PWD=/hunter2', 'DB_PWD=***']] as const) expect(redactSecrets(a), a).toBe(b);
  });

  it('masks the credentials that turn up in error text', () => {
    const cases: Array<[string, string]> = [
      ['connect ECONNREFUSED http://ops:9fZk3pQ7sample@172.19.0.1:8091', 'ops:9fZk3pQ7sample'],
      ['telegram 401 for 1234567890:AA' + 'x'.repeat(33), '1234567890:AA'],
      ['slack refused xoxb-0000-1111-abcdefghijklmnop', 'xoxb-0000'],
      [`slack refused ${SLACK_APP_TOKEN}`, 'xapp-1-A0APP'],
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

  it('a value starting with $, and a spaced unquoted assignment, are masked; references and code are not (#209)', () => {
    const cases: Array<[string, string]> = [
      ['password=$fake-value', 'password=***'],
      ['password = fake-value', 'password = ***'],
      ['GARDEN_TOKEN = pl4nt then more', 'GARDEN_TOKEN = *** then more'],
      ['"apiKey": $seed1', '"apiKey": ***'],
      ['token: $lowercase9', 'token: ***'],
    ];
    for (const [text, want] of cases) expect(redactSecrets(text), text).toBe(want);
    for (const text of ['TOKEN=${GARDEN_TOKEN}', 'password = ${{ secrets.GARDEN_PASSWORD }}', 'token = config.apiKey;', 'const token = await getToken();',
      'apiKey = os.environ["GARDEN_KEY"]', 'secret = null', 'if (token == expected) go()', 'token => token.trim()', 'password = $GARDEN_PASSWORD']) {
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

describe('quoted values in logs, after the final review of HB-0501', () => {
  it("a curly closer ends a value only before a separator, and a logfmt \\\" stays in its value", () => {
    expect(redactSecrets('DB_PASSWORD=‘O’Brien2024’ next=1')).toBe('DB_PASSWORD=‘***’ next=1');
    expect(redactSecrets('password: ‘Bob’s-fake-dog’')).toBe('password: ‘***’');
    expect(redactSecrets('"password": ‘Bob’s-fake-dog’')).toBe('"password": ‘***’');
    expect(redactSecrets('token=“abc”def123')).toBe('token=***');
    expect(redactSecrets('level=info user=bob token="abc\\" def" next=1')).toBe('level=info user=bob token="***" next=1');
    expect(redactSecrets('password="p@ss\\" token="x"')).toBe('password="***" token="***"');
    expect(redactSecrets('error: invalid token: ‘expired’ (code 401)')).toBe('error: invalid token: ‘***’ (code 401)');
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
