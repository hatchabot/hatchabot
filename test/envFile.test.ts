import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

describe('putting a .env saved with Windows line endings in order (HB-1530)', () => {
  const key = ['k', 'e', 'y'].join('') + '-5678';   // a made-up value, never a real one
  it('its lines are kept as written, under Other settings, and every value systemd reads stays the same', () => {
    const before = `HATCHABOT_SECRET_KEY=${key}\r\nPORT=9137\r\nHATCHABOT_AUTH=accounts\r\n`;
    const r = syncEnvText(before);
    expect(r.ok && r.changed).toBe(true);
    const text = (r as { text: string }).text;
    expect([...activeValues(text)]).toEqual([['HATCHABOT_SECRET_KEY', key], ['PORT', '9137'], ['HATCHABOT_AUTH', 'accounts']]);
    // Not written again in its group: a shell (the Mac's service) reads the \r as part of the value.
    expect(text).toContain('\n# PORT=8080\n');
    expect(text.split('\n').filter((l) => l.endsWith('\r'))).toEqual([`HATCHABOT_SECRET_KEY=${key}\r`, 'PORT=9137\r', 'HATCHABOT_AUTH=accounts\r']);
  });
  it('a setting on such a line before one on a plain line is left as it was: the tidy would move it after, and systemd would read it in force', () => {
    // systemd takes PORT=1, the last; moved under Other settings, PORT=2 came last, and the service changed port.
    expect(syncEnvText('PORT=2\r\nPORT=1\n')).toEqual({ ok: false, error: 'would change PORT — left as it was' });
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

  // Audit, 2026-10-22 (A20, A21).
  it('leaves a file alone when moving its lines would change what a shell that sources it reads', () => {
    const dollar = 'MY_PORT=8123\nPORT=$MY_PORT\n';
    const r = syncEnvText(dollar);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('PORT uses a $');
    // In single quotes a $ is only a character: tidied as before.
    expect(syncEnvText("HATCHABOT_PASSWORD='pa$$word'\nDOCKER_HOST=unix:///run/user/1000/docker.sock\n").ok).toBe(true);
    // A $ that names no setting of the file reads the same in any order: tidied too.
    const loose = syncEnvText('DOCKER_HOST=unix:///run/user/1000/docker.sock\nHATCHABOT_PASSWORD="pa$$w0rd"\nDATA=$HOME/hb\nPORT=8123\n');
    expect(loose.ok, JSON.stringify(loose)).toBe(true);
    expect((loose as { changed: boolean }).changed).toBe(true);
  });

  // Audit, 2026-10-29 (HB-0292, HB-0293): what a shell sourcing the file ends with, before and after.
  const sourced = (text: string, name: string) => {
    const home = mkdtempSync(join(tmpdir(), 'hb-env-sh-'));
    try {
      return execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', `${text}\nprintf %s "$${name}"`], { env: { HOME: home, PATH: home }, encoding: 'utf8' });
    } finally { rmSync(home, { recursive: true, force: true }); }
  };

  /**
   * The same for many texts in one bash, each sourced in a subshell of its own: undefined where bash refused
   * one, or it ended the subshell (`${NAME:?}`, an `exit`). Each writes its value to a file named for it, so
   * one that ends before it writes moves no other.
   */
  const sourcedEach = (texts: string[], name: string): Array<string | undefined> => {
    const home = mkdtempSync(join(tmpdir(), 'hb-env-sh-'));
    try {
      texts.forEach((t, i) => writeFileSync(join(home, `${i}.env`), t));
      const script = 'cd "$HOME"; for f in ' + texts.map((_, i) => i).join(' ') + '; do ( unset ' + name + '; . "./$f.env" >/dev/null 2>&1 </dev/null && printf "%s" "${' + name + '-}" > "./$f.out" ); done';
      execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', script], { env: { HOME: home, PATH: home }, encoding: 'utf8' });
      return texts.map((_, i) => (existsSync(join(home, `${i}.out`)) ? readFileSync(join(home, `${i}.out`), 'utf8') : undefined));
    } finally { rmSync(home, { recursive: true, force: true }); }
  };

  // Review of HB-1241: a file whose sourcing ends its subshell (`${NAME:?}` unset, an `exit`) printed no record, and
  // every record after it moved up one, so each later value was read against the text before it. Nor were its folders removed.
  it('the helpers read each text as its own, one bash refuses or ends among them, and leave no folder behind', () => {
    const folders = () => readdirSync(tmpdir()).filter((n) => n.startsWith('hb-env-sh-')).length;
    const had = folders();
    expect(sourcedEach(['HATCHABOT_PASSWORD=first\n', 'HATCHABOT_PASSWORD=${UNSET_FOR_THE_TEST:?}\n', 'HATCHABOT_PASSWORD=third\n', 'exit 3\n',
      'HATCHABOT_PASSWORD=${BAD\n', 'false\n', 'HATCHABOT_PASSWORD="seventh\n"\n'], 'HATCHABOT_PASSWORD'))
      .toEqual(['first', undefined, 'third', undefined, undefined, undefined, 'seventh\n']);
    expect(sourced('HATCHABOT_PASSWORD=made-up\n', 'HATCHABOT_PASSWORD')).toBe('made-up');
    expect(folders()).toBe(had);
  });

  it('reads a setting named just before a single-quoted part as ending there (HB-1054)', () => {
    // Taken out with nothing in its place, the quoted part joined what came after it to the name:
    // `$CUSTOM_SUFFIX''x` read as `$CUSTOM_SUFFIXx`, and the tidy moved the password above CUSTOM_SUFFIX.
    const forms = [`$CUSTOM_SUFFIX''x`, `$CUSTOM_SUFFIX'$'x`, `$CUSTOM_SUFFIX'"'x`, `$CUSTOM_SUFFIX'\\'x`, `$CUSTOM_SUFFIX'$CUSTOM_SUFFIX'x`, `$CUSTOM_SUFFIX' 'x`, `x$CUSTOM_SUFFIX'$'x`, `}$CUSTOM_SUFFIX''x`];
    const read = sourcedEach(forms.map((v) => `CUSTOM_SUFFIX=fixture\nHATCHABOT_PASSWORD=${v}\n`), 'HATCHABOT_PASSWORD');
    forms.forEach((v, i) => {
      expect(read[i], v).toMatch(/fixture/);
      expect(syncEnvText(`CUSTOM_SUFFIX=fixture\nHATCHABOT_PASSWORD=${v}\n`).ok, v).toBe(false);
    });
  });

  it('a tidy it takes reads the same to a shell: every value of up to four shell pieces that names a setting (HB-1054)', () => {
    const PIECES = ['"', "'", "$'", '\\', '$CUSTOM_SUFFIX', 'x', '}', ' #', ' '];
    const values: string[] = [];
    const walk = (v: string, n: number) => { if (v.includes('$CUSTOM_SUFFIX')) values.push(v); if (n < 4) for (const p of PIECES) walk(v + p, n + 1); };
    walk('', 0);
    const taken = values.flatMap((v) => {
      const text = `CUSTOM_SUFFIX=fixture\nHATCHABOT_PASSWORD=${v}\n`;
      const r = syncEnvText(text);
      return r.ok && r.changed ? [{ v, text, tidied: r.text }] : [];
    });
    expect(taken.length).toBeGreaterThan(50); // it still tidies the files it can
    const read = sourcedEach(taken.flatMap((t) => [t.text, t.tidied]), 'HATCHABOT_PASSWORD');
    expect(taken.filter((t, i) => read[2 * i] !== undefined && read[2 * i] !== read[2 * i + 1]).map((t) => t.v)).toEqual([]);
  });

  it('leaves a file alone when a value names a lowercase setting or one inside $((…)) that the tidy would move', () => {
    for (const text of ['custom_port=8123\nPORT=$custom_port\n', 'CUSTOM_PORT=8123\nPORT=$((CUSTOM_PORT+1))\n', 'CUSTOM_PORT=8123\nPORT=${#CUSTOM_PORT}\n']) {
      const r = syncEnvText(text);
      expect(r.ok, text).toBe(false);
      expect((r as { error: string }).error, text).toBe('PORT uses a $ that would be read in another order — left as it was');
    }
    // Arithmetic on numbers only, or naming nothing the file sets: tidied, and reads the same.
    for (const text of ['PORT=$((8000+123))\nDOCKER_HOST=unix:///run/user/1000/docker.sock\n', 'lower=1\nPORT=$((OTHER+8123))\n']) {
      const r = syncEnvText(text);
      expect(r.ok && r.changed, text).toBe(true);
      expect(sourced((r as { text: string }).text, 'PORT'), text).toBe(sourced(text, 'PORT'));
    }
  });

  it('leaves a file alone when a value names a setting between single quotes that sit inside double quotes, where a shell expands it (HB-1054)', () => {
    const text = `CUSTOM_SUFFIX=fixture\nHATCHABOT_PASSWORD="prefix'$CUSTOM_SUFFIX'"\n`;
    expect(sourced(text, 'HATCHABOT_PASSWORD')).toBe("prefix'fixture'");
    const r = syncEnvText(text);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('HATCHABOT_PASSWORD uses a $ that would be read in another order — left as it was');
    // Single quotes of their own, or a double quote inside them, still keep a $ a character: tidied, and reads the same.
    for (const t of [`CUSTOM_SUFFIX=fixture\nHATCHABOT_PASSWORD='prefix"$CUSTOM_SUFFIX"'\n`, `CUSTOM_SUFFIX=fixture\nHATCHABOT_PASSWORD="pre"'$CUSTOM_SUFFIX'\n`]) {
      const ok = syncEnvText(t);
      expect(ok.ok && ok.changed, t).toBe(true);
      expect(sourced((ok as { text: string }).text, 'HATCHABOT_PASSWORD'), t).toBe(sourced(t, 'HATCHABOT_PASSWORD'));
    }
    // An escaped quote opens nothing: the $ after it is still seen.
    expect(syncEnvText(`CUSTOM_SUFFIX=fixture\nHATCHABOT_PASSWORD=pre\\'$CUSTOM_SUFFIX\n`).ok).toBe(false);
  });

  // HB-1241: inside double quotes, `${…}`, `$(…)` and backticks open quotes of their own, which
  // the walk does not follow: it took the inner `"…"` for the outer's end, and the `'…'` in it for
  // single quotes, so the setting named there was not seen and the tidy moved the value above it.
  it('leaves a file alone when a value names a setting in quotes nested inside ${…}, $(…) or backticks within double quotes (HB-1241)', () => {
    const forms = [`"\${U:-"'$CUSTOM_SUFFIX'"}"`, `"$(echo "'$CUSTOM_SUFFIX'")"`, `"\`echo "'$CUSTOM_SUFFIX'"\`"`, `"\${U:-"$CUSTOM_SUFFIX"}"`, `"pre\${U:+x}'$CUSTOM_SUFFIX'"`];
    const texts = forms.map((v) => `CUSTOM_SUFFIX=fixture\nHATCHABOT_PASSWORD=${v}\n`);
    const read = sourcedEach(texts, 'HATCHABOT_PASSWORD');
    forms.forEach((v, i) => {
      expect(read[i], v).toMatch(/fixture/);
      const r = syncEnvText(texts[i]!);
      expect(r, v).toEqual({ ok: false, error: 'HATCHABOT_PASSWORD uses a $ that would be read in another order — left as it was' });
    });
    // One that names no setting of the file reads the same in any order: tidied, and reads the same.
    for (const value of [`"\${U:-made-up}/x"`, `"$(printf made-up)"`, `"\${U:-"'made-up'"}"`]) {
      const t = `CUSTOM_SUFFIX=fixture\nHATCHABOT_PASSWORD=${value}\n`;
      const r = syncEnvText(t);
      expect(r.ok && r.changed, value).toBe(true);
      expect(sourced((r as { text: string }).text, 'HATCHABOT_PASSWORD'), value).toBe(sourced(t, 'HATCHABOT_PASSWORD'));
    }
  });

  it("leaves a file alone when a value uses bash's $'…' quoting, where \\' does not end the quote (HB-1054)", () => {
    const text = `CUSTOM_SUFFIX=fixture\nHATCHABOT_PASSWORD=$'\\'\\''$CUSTOM_SUFFIX\\'\n`;
    expect(sourced(text, 'HATCHABOT_PASSWORD')).toBe("''fixture'");
    const r = syncEnvText(text);
    expect(r).toEqual({ ok: false, error: "HATCHABOT_PASSWORD uses $'…' quoting, which this tidy does not read — left as it was" });
    // One that names no setting is refused as well: what it names is not read.
    expect(syncEnvText(`CUSTOM_SUFFIX=fixture\nHATCHABOT_PASSWORD=$'it\\'s'\n`).ok).toBe(false);
    // A file that is tidy already is no change, and no warning at every start.
    const tidy = renderEnv(text);
    expect(renderEnv(tidy)).toBe(tidy);
    expect(syncEnvText(tidy)).toEqual({ ok: true, changed: false });
    // A $ before a ' that is not that quoting (in quotes, or escaped): tidied as any value, and read the same.
    for (const value of [`'made-up-secret$'`, `"made-up$'secret"`, `made-up\\$'secret'`]) {
      const t = `CUSTOM_SUFFIX=fixture\nHATCHABOT_PASSWORD=${value}\n`;
      const r2 = syncEnvText(t);
      expect(r2.ok && r2.changed, value).toBe(true);
      expect(sourced((r2 as { text: string }).text, 'HATCHABOT_PASSWORD'), value).toBe(sourced(t, 'HATCHABOT_PASSWORD'));
    }
  });

  it('leaves a file alone when a quote opened after a prefix runs the value over several lines', () => {
    for (const text of ['HATCHABOT_PASSWORD=prefix"first\nsecond"\nPORT=8123\n', "HATCHABOT_PASSWORD=pre'first\nsecond'\nPORT=8123\n", 'note="a"b"c\nd"\nPORT=8123\n', "HATCHABOT_PASSWORD=#it's\nmine'\nPORT=8123\n"]) {
      const r = syncEnvText(text);
      expect(r.ok, text).toBe(false);
      expect((r as { error: string }).error, text).toMatch(/has a quote part-way through its value that is not closed on its line/);
    }
    // Closed after a prefix, an escaped quote, a quote in a comment: tidied, and reads the same.
    for (const text of ['HATCHABOT_PASSWORD=prefix"first"last\nPORT=8123\n', 'HATCHABOT_PASSWORD=pre\\"x\nPORT=8123\n', "PORT=8123 # the owner's port\nDOCKER_HOST=unix:///run/user/1000/docker.sock\n"]) {
      const r = syncEnvText(text);
      expect(r.ok && r.changed, text).toBe(true);
      for (const name of ['HATCHABOT_PASSWORD', 'PORT']) expect(sourced((r as { text: string }).text, name), text).toBe(sourced(text, name));
    }
  });

  it('a quote opened part-way and never closed is refused for what it is: one line to systemd, more to a shell (audit, 2026-10-29)', () => {
    expect(syncEnvText("HATCHABOT_NAME=the family's house\nPORT=8123\n")).toEqual({ ok: false, error: "HATCHABOT_NAME has a quote part-way through its value that is not closed on its line: a shell reading .env (the macOS service) reads on into the next lines, which this tidy cannot keep in order — left as it was" });
    const r = syncEnvText("HATCHABOT_PUBLIC_URL=https://hb.example.org/#it's\nPORT=1\n");
    expect((r as { error: string }).error).toMatch(/^HATCHABOT_PUBLIC_URL has a quote part-way through its value/);
    // Opened at the start of the value, it runs on for systemd too.
    expect((syncEnvText('GREETING= "first\nsecond"\nPORT=1\n') as { error: string }).error).toMatch(/^GREETING has a value on more than one line/);
  });

  it('leaves an exported value that runs over several lines alone, as it does a plain one', () => {
    const r = syncEnvText('export NOTE="first line\nHATCHABOT_REBUILD_POLICY=manual\nlast line"\n');
    expect(r).toEqual({ ok: false, error: 'NOTE has a value on more than one line, which this tidy cannot keep together — left as it was' });
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
