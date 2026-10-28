import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envMap } from '../src/doctor.js';
import { activeValues, envValue } from '../src/config/envFile.js';

// HB-0084: doctor (and the CLI's HATCHABOT_DB / PUBLIC_URL / AUTH) read .env
// with a parser of their own; they must read it as the server does.
const dir = mkdtempSync(join(tmpdir(), 'hb-envmap-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (text: string) => { const f = join(dir, `e${Math.random().toString(36).slice(2)}.env`); writeFileSync(f, text); return f; };

describe('doctor envMap reads .env as the server does', () => {
  const text = [
    '# HATCHABOT_AUTH=identity',
    'export HATCHABOT_PUBLIC_URL=https://shell-only.example.org',
    'HATCHABOT_DB=/srv/hb/data/hatchabot.sqlite # moved in May',
    `HATCHABOT_PASSWORD='it'\\''s a "test"'`,
    'HATCHABOT_TLS_CERT="/srv/hb/cert \\"a\\".pem"',
    '  PORT = 8123  ',
    'HATCHABOT_AUTH=password',
    'HATCHABOT_AUTH=accounts',
    'AGENTCLAW_PREFIX=old',
    'AGENTCLAW_IMAGE=old-image',
    'HATCHABOT_IMAGE=new-image',
  ].join('\n');

  it('takes the same lines and values as activeValues', () => {
    const m = envMap(file(text));
    for (const [k, v] of activeValues(text)) expect(m[k]).toBe(envValue(v));
  });

  it('skips export lines, keeps an inline # note, unquotes once, last line wins', () => {
    const m = envMap(file(text));
    expect(m.HATCHABOT_PUBLIC_URL).toBeUndefined();
    expect(m['export HATCHABOT_PUBLIC_URL']).toBeUndefined();
    expect(m.HATCHABOT_DB).toBe('/srv/hb/data/hatchabot.sqlite # moved in May');
    expect(m.HATCHABOT_PASSWORD).toBe(`it's a "test"`);
    expect(m.HATCHABOT_TLS_CERT).toBe('/srv/hb/cert "a".pem');
    expect(m.PORT).toBe('8123');
    expect(m.HATCHABOT_AUTH).toBe('accounts');
  });

  it('aliases AGENTCLAW_* only where the HATCHABOT_* name is unset', () => {
    const m = envMap(file(text));
    expect(m.HATCHABOT_PREFIX).toBe('old');
    expect(m.HATCHABOT_IMAGE).toBe('new-image');
  });

  it('is empty for a missing file', () => {
    expect(envMap(join(dir, 'absent.env'))).toEqual({});
  });
});
