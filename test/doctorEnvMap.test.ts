import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carriageReturnLines, doctorReport, envMap, type DoctorFacts } from '../src/doctor.js';
import { activeValues, envValue, inlineComments } from '../src/config/envFile.js';

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

// HB-0634: systemd (the Linux service) keeps a "# note" after a value in the
// value; a shell (the Mac's service, restart.sh) drops it. doctor names each
// setting read two ways, and the file says comments go on their own line.
describe('a # comment after a value', () => {
  it('is found on each setting in force that has one, and only there', () => {
    const text = [
      'PORT=9137 # moved off 8080',
      'HATCHABOT_BIND= # left empty',
      'HATCHABOT_DB=/srv/hb/data/hb.sqlite\t# tab before it',
      'HATCHABOT_PASSWORD=made#up',
      "HATCHABOT_PUBLIC_URL='https://box.example.org/#home' ",
      'HATCHABOT_TLS_CERT="/srv/hb/a #1.pem"',
      '# HATCHABOT_IMAGE=hatchabot-runtime:latest # a commented line',
      '# a comment on its own line',
      'HATCHABOT_AUTH=accounts',
    ].join('\n');
    expect(inlineComments(text)).toEqual(['PORT', 'HATCHABOT_BIND', 'HATCHABOT_DB']);
    // Quoted words with a comment between, which a shell and systemd read
    // apart; an escaped space before the #, which both read as "a #b"; a # in
    // quotes after a quoted word (review of HB-0634).
    expect(inlineComments([
      "HATCHABOT_A='a' #x 'b'",
      'HATCHABOT_B="a" # "b"',
      'HATCHABOT_C=a\\ #b',
      'HATCHABOT_D="a"\' #1\'',
      "HATCHABOT_E='it'\\''s #1'",
      'HATCHABOT_F="say \\"hi\\" #1"',
    ].join('\n'))).toEqual(['HATCHABOT_A', 'HATCHABOT_B']);
    // The last line in force decides, as both readers take the last one.
    expect(inlineComments('PORT=9137 # old\nPORT=9138\n')).toEqual([]);
    expect(inlineComments('PORT=9137\nPORT=9138 # new\n')).toEqual(['PORT']);
  });

  it('doctor warns and names the settings, with the fix', () => {
    const facts: DoctorFacts = {
      nodeVersion: 'v22.22.2', dockerCli: true, dockerDaemon: { ok: true, version: '27.1' },
      envFile: { present: true, secretKey: true, password: true, authMode: 'accounts', publicUrl: 'https://box.example.org', inlineComments: ['PORT', 'HATCHABOT_BIND'] },
      db: { path: '/x/hatchabot.sqlite', present: true }, service: { manager: 'systemd', active: true, enabled: true },
      controlPlane: { url: 'http://localhost:8080', ok: true, version: '2.190.0' }, backups: { dir: '/b', lastSet: '2026-09-13', ageDays: 0 },
    };
    const line = doctorReport(facts).find((l) => /# comment after the value/.test(l.text));
    expect(line).toMatchObject({ level: 'warn', text: expect.stringContaining('PORT, HATCHABOT_BIND'), fix: 'Put each comment on a line of its own above its setting in .env (or quote the value whole if the # belongs to it), then ./scripts/restart.sh' });
    for (const inline of [[], undefined]) {
      expect(doctorReport({ ...facts, envFile: { ...facts.envFile, inlineComments: inline } }).some((l) => /# comment after the value/.test(l.text))).toBe(false);
    }
  });

  it('doctor warns about a .env saved with Windows line endings, which systemd, a shell and the app each read their own way, with the fix (HB-1379)', () => {
    expect(carriageReturnLines('HATCHABOT_SECRET_KEY=made-up\r\nPORT=9137\r\n# a note\nHATCHABOT_AUTH=accounts\n')).toBe(2);
    expect(carriageReturnLines('PORT=9137\n')).toBe(0);
    const facts: DoctorFacts = {
      nodeVersion: 'v22.22.2', dockerCli: true, dockerDaemon: { ok: true, version: '27.1' },
      envFile: { present: true, secretKey: true, password: true, authMode: 'accounts', publicUrl: 'https://box.example.org', carriageReturns: 2 },
      db: { path: '/x/hatchabot.sqlite', present: true }, service: { manager: 'systemd', active: true, enabled: true },
      controlPlane: { url: 'http://localhost:8080', ok: true, version: '2.190.0' }, backups: { dir: '/b', lastSet: '2026-09-13', ageDays: 0 },
    };
    expect(doctorReport(facts).find((l) => /carriage return/.test(l.text))).toEqual({
      level: 'warn',
      text: ".env has a carriage return on 2 lines (saved with Windows line endings): systemd (the service on Linux) and these checks end the value there, but the Mac's service keeps it as part of the value",
      fix: "perl -pi -e 's/\\r//g' .env (it takes every carriage return out), then ./scripts/restart.sh",
    });
    for (const cr of [0, undefined]) expect(doctorReport({ ...facts, envFile: { ...facts.envFile, carriageReturns: cr } }).some((l) => /carriage return/.test(l.text))).toBe(false);
  });

  it('a .env saved with Windows line endings is read as systemd reads it: a carriage return ends the line (HB-1530)', () => {
    const crlf = 'HATCHABOT_SECRET_KEY=made-up-key\r\nPORT=9137 \r\nHATCHABOT_AUTH=accounts\r\nAGENTCLAW_BIND=192.0.2.10\r\nHATCHABOT_TLS_CERT=/made-up/cert.pem # note\r\n';
    expect([...activeValues(crlf)]).toEqual([
      ['HATCHABOT_SECRET_KEY', 'made-up-key'], ['PORT', '9137 '], ['HATCHABOT_AUTH', 'accounts'], ['AGENTCLAW_BIND', '192.0.2.10'], ['HATCHABOT_TLS_CERT', '/made-up/cert.pem # note'],
    ]);
    const m = envMap(file(crlf));
    expect(m).toMatchObject({ HATCHABOT_SECRET_KEY: 'made-up-key', PORT: '9137', HATCHABOT_AUTH: 'accounts', HATCHABOT_BIND: '192.0.2.10', HATCHABOT_TLS_CERT: '/made-up/cert.pem # note' });
    // A note after a value on such a line is still named, as on any other.
    expect(inlineComments(crlf)).toEqual(['HATCHABOT_TLS_CERT']);
    // A carriage return alone, as an old Mac wrote lines, ends one too.
    expect([...activeValues('PORT=9137\rHATCHABOT_AUTH=accounts')]).toEqual([['PORT', '9137'], ['HATCHABOT_AUTH', 'accounts']]);
  });

  it('the .env header says comments go on their own line', () => {
    expect(readFileSync('.env.example', 'utf8')).toMatch(/Comments go on their own line/);
  });
});
