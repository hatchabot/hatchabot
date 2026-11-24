import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every test here runs real shell scripts (git, bash, a fake gh) in a sandbox. On the
// self-hosted runner CI shares the machine with other work, and vitest's 5 s was not
// enough under load (land, promote, release, first-run-link; 2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

/**
 * macOS runs these with its bash 3.2, which in a Mac's locale reads the bytes
 * of a non-ASCII character right after `$name` as part of the NAME: "$name…"
 * looked up a variable called `name\xe2…` and `set -u` stopped the installer
 * ("name�: unbound variable", 2026-10-06, the first bundle install on a Mac).
 * Write ${name}… instead.
 */
describe('shell scripts run on a Mac (bash 3.2)', () => {
  const files = ['install.sh', ...readdirSync('scripts').filter((f) => f.endsWith('.sh')).map((f) => join('scripts', f))];
  it('no $variable is followed directly by a non-ASCII character', () => {
    const bad: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('no case runs inside a $( … ), <( … ) or >( … ) (HB-1052)', () => {
    const bad: string[] = [];
    for (const f of files) for (const line of caseInSubstitution(readFileSync(f, 'utf8'))) bad.push(`${f}:${line}`);
    expect(bad).toEqual([]);
  });

  it('the check finds a case run inside one, however it is written, and nothing else', () => {
    const cut = 'x="$(printf a | while read -r f; do\n  case "$f" in *-wal|*-shm) continue ;; esac\n  echo "$f"\ndone)"\necho "$x"\n';
    for (const [sample, line] of [
      [cut, 2],                                                          // the shape bash 3.2 cut short (uninstall.sh, d9158cd8)
      [`set -u\n${cut}`, 3],
      [cut.replace('*-wal|', '(*-wal|'), 2],                              // a leading ( too: the rule is no case at all
      ['n="$(case "$1" in a) echo one ;; esac)"\n', 1],
      ['x=$( ( case "$a" in b) echo c ;; esac ) )\n', 1],                // in a subshell inside one
      ['diff <(case "$a" in b) echo c ;; esac) /dev/null\n', 1],          // <( … )
      ['echo x > >(case "$a" in b) cat ;; esac)\n', 1],                   // >( … )
      ['y=$(if true; then case "$a" in b) echo c ;; esac; fi)\n', 1],     // after then
      ['a=$(true && case "$a" in b) echo c ;; esac)\n', 1],               // after &&
      ['a=$(true\ncase "$a" in b) echo c ;; esac)\n', 2],                 // after a newline
      ['y=${x:-$(case "$a" in b) echo c ;; esac)}\n', 1],                 // in a ${ … }
      ['cat <<EOF\nv=$(case "$a" in b) echo c ;; esac)\nEOF\n', 2],       // an unquoted heredoc's body is expanded
      ['cat <<-EOF\n\tv=$(case "$a" in b) echo c ;; esac)\n\tEOF\nw=1\n', 2],
      ["cat << EOF\nit's here\nEOF\ny=$(case \"$a\" in b) echo c ;; esac)\n", 4], // a space after <<, an apostrophe in the body
      ['(( n = 1 << 2 ))\nz=$(case "$a" in b) echo c ;; esac)\n', 2],     // arithmetic, not a heredoc
      ['m=$(( 1 << s ))\nz=$(case "$a" in b) echo c ;; esac)\n', 2],
    ] as const) expect(caseInSubstitution(sample), sample).toEqual([line]);
    for (const ok of [
      'pick() { case "$1" in *-wal) return ;; esac; echo "$1"; }\nx="$(pick a)"\n', // a function
      'case "$(ls -A "$d" | tr \'\\n\' \' \')" in ".lock ") rm -rf "$d/.lock" ;; esac\n', // a $( … ) as the subject
      'n=$(( 10 * (1 << s) - 5 ))\ny="$(echo \')\' "(" \\) )"\n# a comment with a ) and $(case in it\n',
      "cat <<'EOF'\nv=$(case \"$a\" in b) echo c ;; esac)\nEOF\n",          // a quoted heredoc's body is text
      'cat <<"EOF"\nv=$(case x in b) echo ;; esac)\nEOF\n',
      'cat <<\\EOF\nv=$(case x in b) echo ;; esac)\nEOF\n',
      'n="$(grep -c case "$f")"\nm=$(printf %s esac)\nx="$(echo "case" \'case\' then case)"\n', // case as a word, not a command
      'y=${x:-$(echo case)}\nz="${x:-it\'s}"\n',
    ]) expect(caseInSubstitution(ok), ok).toEqual([]);
  });
});

/**
 * bash before 4.0 finds where a $( … ) ends by counting parentheses (bash's
 * CHANGES, bash-4.0-alpha, item uuu), so a case pattern's ) can end one early.
 * On a Mac the rest is then a syntax error at run time: the purge in
 * uninstall.sh stopped half-way, leaving the install's database and .env
 * behind, whenever another database shared its folder (HB-1052 review,
 * 2026-11-23). So no case runs inside $( … ), <( … ) or >( … ) at all, however
 * its patterns are written: put it in a function, which is read where it is
 * defined.
 *
 * Returns the line of each case in command position inside one: just after
 * its (, or after ; & | && || ;; a newline ( { then do else elif if while
 * until !. Quotes, escapes, comments and arithmetic are passed over; a quoted
 * heredoc's body is text, and an unquoted one, which bash expands, is read
 * for the $( … ) in it. `body` reads the text as such a body; `base` is the
 * line before its first.
 */
function caseInSubstitution(src: string, body = false, base = 0): number[] {
  const bad: number[] = [];
  const at = (j: number) => src.charAt(j);
  const lineOf = (j: number) => base + src.slice(0, j).split('\n').length;
  const pending: Array<{ word: string; strip: boolean; expand: boolean }> = [];
  const STARTS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time']);
  let i = 0;

  /** Just past a newline: the bodies of the heredocs begun on its line. */
  function bodies(): void {
    for (const d of pending.splice(0)) {
      const start = i;
      let end = src.length;
      while (i < src.length) {
        const nl = src.indexOf('\n', i);
        const line = src.slice(i, nl < 0 ? src.length : nl);
        const last = (d.strip ? line.replace(/^\t+/, '') : line) === d.word;
        if (last) end = i;
        i = nl < 0 ? src.length : nl + 1;
        if (last) break;
      }
      if (d.expand) bad.push(...caseInSubstitution(src.slice(start, end), true, lineOf(start) - 1));
    }
  }
  /** At <<: the word that ends the heredoc, and whether its body is expanded (no quote in the word). */
  function heredoc(): void {
    i += 2;
    const strip = at(i) === '-';
    if (strip) i++;
    while (at(i) === ' ' || at(i) === '\t') i++;
    let word = '', quoted = false;
    while (i < src.length && !/[\s;&|()<>]/.test(at(i))) {
      const c = at(i);
      if (c === "'" || c === '"') {
        const k = src.indexOf(c, i + 1), e = k < 0 ? src.length : k;
        word += src.slice(i + 1, e); i = e + 1; quoted = true;
      } else if (c === '\\') { word += at(i + 1); i += 2; quoted = true; }
      else { word += c; i++; }
    }
    if (word) pending.push({ word, strip, expand: !quoted });
  }
  function single(): void { const k = src.indexOf("'", i + 1); i = k < 0 ? src.length : k + 1; }
  function double(): void {
    i++;
    while (i < src.length && at(i) !== '"') {
      if (at(i) === '\\') i += 2;
      else if (at(i) === '$') dollar(true);
      else if (at(i) === '`') backtick();
      else i++;
    }
    i++;
  }
  function backtick(): void { i++; while (i < src.length && at(i) !== '`') i += at(i) === '\\' ? 2 : 1; i++; }
  /** At a $: $(( … )), $( … ), ${ … } or a plain $. In "…" (`quoted`) a ' is a character. */
  function dollar(quoted = false): void {
    if (src.startsWith('$((', i)) { i += 3; arith(2); }
    else if (src.startsWith('$(', i)) { i += 2; commands(true); }
    else if (src.startsWith('${', i)) { i += 2; braces(quoted); }
    else i++;
  }
  /** Arithmetic, to the ) that closes it (`depth` open): nothing in it runs but a $( … ). */
  function arith(depth: number): void {
    while (i < src.length && depth > 0) {
      const c = at(i);
      if (c === '$') { dollar(); continue; }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
  }
  function braces(quoted: boolean): void {
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = at(i);
      if (c === '\\') { i += 2; continue; }
      if (c === "'" && !quoted) { single(); continue; }
      if (c === '"') { double(); continue; }
      if (c === '$') { dollar(quoted); continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
  }
  /** A word, to the first character outside quotes that ends one. */
  function word(): void {
    while (i < src.length) {
      const c = at(i);
      if (/[\s;&|()<>]/.test(c)) return;
      if (c === '\\') i += 2;
      else if (c === "'") single();
      else if (c === '"') double();
      else if (c === '`') backtick();
      else if (c === '$') dollar();
      else i++;
    }
  }
  /** Commands: the whole text, or (`sub`) a $( … ), <( … ) or >( … ) from just past its ( to just past its ). */
  function commands(sub: boolean): void {
    let depth = 0, cmd = true, target = false;
    while (i < src.length) {
      const c = at(i);
      if (c === '\n') { i++; cmd = true; target = false; if (pending.length) bodies(); continue; }
      if (src.startsWith('\\\n', i)) { i += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '#') { const k = src.indexOf('\n', i); i = k < 0 ? src.length : k; continue; }
      if (c === ')') { i++; if (sub && depth === 0) return; depth--; cmd = false; continue; }
      if (c === '(') {
        if (cmd && at(i + 1) === '(') { i += 2; arith(2); cmd = false; continue; } // (( … ))
        i++; depth++; cmd = true; continue;
      }
      if (/[;&|]/.test(c)) { while (/[;&|]/.test(at(i))) i++; cmd = true; continue; }
      if (c === '<' || c === '>') {
        if (at(i + 1) === '(') { i += 2; commands(true); cmd = false; continue; }
        if (src.startsWith('<<', i) && at(i + 2) !== '<') { heredoc(); continue; }
        while (/[<>&|]/.test(at(i))) i++;
        target = true; continue;
      }
      const start = i;
      word();
      if (i === start) { i++; continue; } // a character that ends a word, and starts nothing (a form feed)
      const w = src.slice(start, i);
      if (target) { target = false; continue; }
      if (sub && cmd && w === 'case') bad.push(lineOf(start));
      cmd = cmd && STARTS.has(w);
    }
  }

  if (!body) commands(false);
  else while (i < src.length) {
    const c = at(i);
    if (c === '\\') i += 2;
    else if (c === '$') dollar(true);
    else if (c === '`') backtick();
    else i++;
  }
  return bad;
}
