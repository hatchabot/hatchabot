import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The kit's code scan (opengrep, `python3 -I scripts/kit_checks.py`) reads a
 * shell script with a bash parser that stops at a few forms bash itself
 * takes. Stopped at line 1, it read none of upgrade.sh, deploy-release.sh or
 * upgrade-helpers.sh, the scripts that run every upgrade and deploy, and said
 * only "parsed in part" (HB-1482). These forms, found by cutting the scripts
 * down to what it stops at with opengrep 1.30.2:
 *  - a case with its first pattern on the `in` line: one item a line, and
 *    `esac` on its own;
 *  - `!` before a `{ … }` group: `{ … } || { … }` says the same;
 *  - a `#` in an arithmetic `$(( ))` (`10#$n`, a base);
 *  - a parenthesis in the word of `${NAME:-…}`, `:+`, `:=`, `:?` (a
 *    `$( … )` there is read): the words set beforehand instead.
 * Held here for those three and the scripts that keep copies of their
 * helpers, word for word (restart.sh, setup-host.sh, first-run-link.sh,
 * ensure-deps.sh).
 */
const SCANNED_WHOLE = ['upgrade.sh', 'deploy-release.sh', 'upgrade-helpers.sh', 'restart.sh', 'setup-host.sh', 'first-run-link.sh', 'ensure-deps.sh'];

const FORMS: Array<[string, RegExp]> = [
  ['a case pattern on the `in` line', /(?:^|[;&|({)]|\b(?:do|then|else)\b)\s*case\s.*?\sin[ \t]+[^\s#]/],
  ['! before a { … } group', /(?:^|\s)!\s+\{\s/],
  ['a # in $(( ))', /\$\(\([^)]*#/],
  ['a ( in the word of ${NAME:-…}', /\$\{\w+:?[-=+?][^}]*?(?<!\$)\(/],
];

/** Each line (1-based) that uses a form the scan's parser stops at, and which. Comment lines are passed over. */
function stopsTheScan(src: string): string[] {
  const out: string[] = [];
  src.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const [what, re] of FORMS) if (re.test(line)) out.push(`${i + 1}: ${what}: ${line.trim().slice(0, 100)}`);
  });
  return out;
}

describe('the scripts every upgrade and deploy runs are read whole by the kit\'s code scan (HB-1482)', () => {
  it('none of them uses a form its parser stops at', () => {
    const bad: string[] = [];
    for (const f of SCANNED_WHOLE) for (const l of stopsTheScan(readFileSync(join('scripts', f), 'utf8'))) bad.push(`scripts/${f}:${l}`);
    expect(bad).toEqual([]);
  });

  it('the check finds each form, and passes the way each is written instead', () => {
    for (const stops of [
      'case "$x" in a) echo ;; esac\n',
      '  case "$LEFT_PIN" in v[0-9]*)\n',
      'not_ours() { case "$1" in .env) return 0 ;; esac; return 1; }\n',
      'for k in "$@"; do names+=("$k"); case "$k" in H_*) x ;; esac; done\n',
      '      n*) case "${line#n}/" in "$here/"*) echo ;; esac ;;\n',
      'case "$(said_kind "$kept")" in disk) return 20 ;; esac\n',
      'if ! { printf x > "$f.tmp" && mv -f "$f.tmp" "$f"; } 2>/dev/null; then\n',
      'echo "$((10#$1))"\n',
      'echo "full${free:+ ($free MB free)}"\n',
      'W="${WANT:-the version (which could not be read)}"\n',
    ]) expect(stopsTheScan(stops), stops).toHaveLength(1);
    for (const reads of [
      'case "$x" in\n  a) echo ;;\nesac\n',
      'case "$(said_kind "$kept")" in\n  disk) return 20 ;;\nesac\n',
      '# case "$x" in a) a comment ;; esac\n',
      '{ printf x > "$f.tmp" && mv -f "$f.tmp" "$f"; } 2>/dev/null || {\n  rm -f "$f.tmp"\n}\n',
      'if ! mv a b; then echo; fi\n',
      'kind="${STEP_SAID:-$(said_kind "$said")}"\nPORT="${1:-$(service_port "$ENV_PORT")}"\n',
      'echo "in case it is in use"\n',
      'n="${1#"${1%%[!0]*}"}"\n',
    ]) expect(stopsTheScan(reads), reads).toEqual([]);
  });
});
