import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ENV_INTERNAL, ENV_SETTINGS } from '../src/config/envCatalog.js';
import { activeValues, renderEnv, syncEnvFile, syncEnvText } from '../src/config/envFile.js';
import { writeEnvVar } from '../src/ops/tailnet.js';

// .env lists every setting, kept in order at each start (Chris, 2026-09-29).

describe('the settings catalog', () => {
  it('names every HATCHABOT_* setting the code reads, or says why it is not a .env setting', () => {
    const out = execFileSync('grep', ['-rhoE', 'HATCHABOT_[A-Z0-9_]+[A-Z0-9]', 'src', 'scripts', 'install.sh', 'bin'], { encoding: 'utf8' });
    const found = new Set(out.split('\n').filter(Boolean));
    const known = new Set([...ENV_SETTINGS.map((s) => s.name), ...ENV_INTERNAL]);
    // A name built in a template (`HATCHABOT_FILES_MB_${kind}`) shows up as its prefix.
    const prefixOnly = (n: string) => [...known].some((k) => k.startsWith(`${n}_`));
    expect([...found].filter((n) => !known.has(n) && !prefixOnly(n)).sort()).toEqual([]);
  });
  it('lists each name once, never as both a setting and internal', () => {
    const names = ENV_SETTINGS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => ENV_INTERNAL.includes(n))).toEqual([]);
  });
  it('.env.example is the catalog rendered for an empty install (npm run env:sync -- --example)', () => {
    expect(readFileSync('.env.example', 'utf8')).toBe(renderEnv('', { example: true }));
  });
});

describe('putting a .env in order', () => {
  const key = ['k', 'e', 'y'].join('') + '-1234';   // a made-up value, never a real one
  const before = [
    '# my note about the key',
    `HATCHABOT_SECRET_KEY=${key}`,
    "HATCHABOT_PASSWORD='two words'",
    '# HATCHABOT_PUBLIC_URL=https://box.example.com',
    '# docker on a socket',
    'DOCKER_HOST=unix:///run/user/1000/docker.sock',
    'export WEIRD=1',
    'HATCHABOT_REBUILD_POLICY=manual',
    'HATCHABOT_REBUILD_POLICY=auto',
  ].join('\n') + '\n';

  it('keeps every value in force byte for byte, and lists every other setting with its default', () => {
    const r = syncEnvText(before);
    expect(r.ok && r.changed).toBe(true);
    const text = (r as { text: string }).text;
    expect(activeValues(text)).toEqual(activeValues(before));
    expect(text).toContain("HATCHABOT_PASSWORD='two words'");
    expect(text).toContain('HATCHABOT_REBUILD_POLICY=auto');        // the last line is the one in force
    expect(text).toContain('# HATCHABOT_SESSION_DAYS=14');
    expect(text).toContain('# HATCHABOT_HIBERNATE_AFTER=\n');
    for (const s of ENV_SETTINGS) expect(text).toMatch(new RegExp(`^#? ?${s.name}=`, 'm'));
  });

  it('keeps what the owner wrote: a commented example, their notes, lines it does not know', () => {
    const text = (syncEnvText(before) as { text: string }).text;
    expect(text).toContain('# HATCHABOT_PUBLIC_URL=https://box.example.com');
    expect(text).toMatch(/secret-key\.env\.\n# my note about the key\nHATCHABOT_SECRET_KEY=/);
    expect(text).toMatch(/Other settings[^\n]*\n\n# docker on a socket\nDOCKER_HOST=unix:\/\/\/run\/user\/1000\/docker\.sock/);
    expect(text).toContain('\nexport WEIRD=1\n');
  });

  it('is settled after one pass: a second changes nothing', () => {
    const once = (syncEnvText(before) as { text: string }).text;
    expect(syncEnvText(once)).toEqual({ ok: true, changed: false });
  });

  it('the app still changes a setting in its own line, not at the bottom', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-env-'));
    const p = join(dir, '.env');
    writeFileSync(p, (syncEnvText(before) as { text: string }).text, { mode: 0o600 });
    await writeEnvVar(p, 'HATCHABOT_HIBERNATE_AFTER', '36h', () => true);
    const text = readFileSync(p, 'utf8');
    expect(text).toMatch(/they never sleep\.\nHATCHABOT_HIBERNATE_AFTER=36h\n/);
    expect(syncEnvText(text)).toEqual({ ok: true, changed: false });
  });

  it('rewrites the file in place with its mode, keeps a private copy of the old one (three at most)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-env-'));
    const p = join(dir, '.env');
    for (let i = 0; i < 5; i++) {
      writeFileSync(p, `${before}# round ${i}\n`, { mode: 0o600 });
      const r = await syncEnvFile(p, new Date(Date.UTC(2026, 8, 29, 12, 0, i)));
      expect(r.changed).toBe(true);
    }
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const copies = readdirSync(dir).filter((f) => f.startsWith('.env.bak-'));
    expect(copies).toHaveLength(3);
    for (const c of copies) expect(statSync(join(dir, c)).mode & 0o777).toBe(0o600);
    expect(activeValues(readFileSync(p, 'utf8'))).toEqual(activeValues(before));
  });

  it('leaves a file alone when a value spans lines, instead of moving its continuation away (#79)', async () => {
    for (const spread of [
      ['HATCHABOT_REBUILD_POLICY=auto', 'GREETING="first line', 'second line"', 'HATCHABOT_SESSION_DAYS=7'],
      ["MOTTO='one", "two'", 'HATCHABOT_SESSION_DAYS=7'],
      ['PATH_LIST=/opt/a:\\', '/opt/b', 'HATCHABOT_SESSION_DAYS=7'],
    ]) {
      const text = spread.join('\n') + '\n';
      const r = syncEnvText(text);
      expect(r.ok, spread[0]).toBe(false);
      expect((r as { error: string }).error).toMatch(/more than one line/);
      const p = join(mkdtempSync(join(tmpdir(), 'hb-env-')), '.env');
      writeFileSync(p, text, { mode: 0o600 });
      expect((await syncEnvFile(p)).changed).toBe(false);
      expect(readFileSync(p, 'utf8')).toBe(text);
    }
    // Quotes closed on their own line, an escaped quote, a commented-out half: still tidied.
    expect(syncEnvText('A="x \\" y"\nB=\'two words\'\n# C="open\n').ok).toBe(true);
  });

  it('leaves a file alone when moving an export line would change the value a shell ends with (#221)', async () => {
    const { parseEnv } = await import('node:util');
    const mixed = 'export HATCHABOT_PORT=8181\nHATCHABOT_PORT=8282\n';
    const r = syncEnvText(mixed);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/would change HATCHABOT_PORT/);
    expect(parseEnv(mixed).HATCHABOT_PORT).toBe('8282');
    // The other order already ends on the export, and stays so; an export of its own is just kept.
    for (const fine of ['HATCHABOT_PORT=8282\nexport HATCHABOT_PORT=8181\n', 'export EXTRA_FLAG=1\nHATCHABOT_PORT=8282\n']) {
      const t = syncEnvText(fine);
      expect(t.ok, fine).toBe(true);
      expect(parseEnv((t as { text: string }).text), fine).toEqual(parseEnv(fine));
    }
  });

  it('a missing file is left alone, with the reason', async () => {
    const r = await syncEnvFile(join(mkdtempSync(join(tmpdir(), 'hb-env-')), 'nope.env'));
    expect(r.changed).toBe(false);
    expect(r.error).toMatch(/can't read/);
  });
});
