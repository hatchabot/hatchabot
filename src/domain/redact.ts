/**
 * Credentials never travel in a message shown to a person or written to the
 * agent's timeline. Error text is the usual leak: a failed proxy dial carries
 * `http://ops:<key>@…`, a failed Telegram call carries the bot token.
 *
 * This is deliberately blunt — it would rather mask a harmless string than
 * let a real one through.
 */
const RULES: Array<[RegExp, string]> = [
  [/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***:***@'],          // credentials in a URL
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, '***'],          // a Telegram bot token
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/gi, '***'],          // a Slack token
  [/\bxapp-[0-9]-[A-Za-z0-9-]{10,}/gi, '***'],          // a Slack app-level token
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '***'],                  // an API key
  // Known prefixes, so one cut short of the long rule still goes (HB-0499). Hugging Face's only with a capital or a
  // digit in it: hf_transfer is a package.
  [/\bglpat-[A-Za-z0-9_-]{8,}/g, '***'],                // a GitLab token
  [/\bhf_(?=[a-z]*[A-Z0-9])[A-Za-z0-9]{8,}/g, '***'],   // a Hugging Face token
  [/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/g, '***'], // a GitHub token
  [/\b[A-Za-z0-9_-]{40,}\b/g, '***'],                   // anything else long enough to be a key
];

/**
 * A field or setting that holds a credential, by its NAME: the value goes
 * whatever its length. The rules above only catch long or known-shaped values,
 * so a short password or token in `PASSWORD=…` or `"apiKey": "…"` went through
 * (security audit, 2026-10-09). Only names that END in the credential word:
 * `max_tokens: 400` and `tokenizer` are not credentials.
 */
// A number or Rails' _BASE after the word is still the same setting: TOKEN2, API_KEY_2, SECRET_KEY_BASE (HB-0499).
const CRED_KEY = String.raw`[A-Za-z0-9_.-]*?(?:token|secret|passw(?:or)?d|passphrase|pwd|authorization|(?:api|access|private|secret|signing|client|encryption|master)[_-]?key)(?:[_-]?\d{1,4}|[_-]base)?`;
// Starts only where a name starts, so a long run of name characters is tried once (linear).
const KEY_START = String.raw`(?<![A-Za-z0-9_.-])`;
// A backslash escapes a double quote. In single quotes it does only where the plain reading does not end at a
// separator: a shell's, PowerShell's or YAML's 'a\' is a whole value, and the escaped reading took the next
// setting's name into it (DB_PASSWORD='p@ss\' -e API_TOKEN='…' left that token), while 'it\'s' is one value.
// Curly, guillemet, CJK and fullwidth quotes too (HB-0501 review); one with no end goes to the end of the line.
// A curly closer ends the value only before a separator or the line's end: ’ is also an apostrophe, and
// ‘O’Brien2024’ kept "Brien2024’" when the first one did (HB-0501, final review).
export const OTHER_QUOTED = String.raw`\u201C[^\n]{0,4000}?[\u201C\u201D](?=[\s,;&}\])\x60\"'.!?]|$)|\u2018[^\n]{0,4000}?[\u2018\u2019](?=[\s,;&}\])\x60\"'.!?]|$)|\u00AB[^\n]{0,4000}?\u00BB(?=[\s,;&}\])\x60\"'.!?]|$)|\u201E[^\n]{0,4000}?[\u201C\u201D](?=[\s,;&}\])\x60\"'.!?]|$)|\u300C[^\n]{0,4000}?\u300D(?=[\s,;&}\])\x60\"'.!?]|$)|\uFF02[^\n]{0,4000}?\uFF02(?=[\s,;&}\])\x60\"'.!?]|$)|[\u201C\u2018\u00AB\u201E\u300C\uFF02][^\n]{0,4000}`;
// First a closing quote before a separator or the line's end, in any reading, as for curly quotes: an apostrophe is a
// quote too, and password='it's-x9' left "s-x9'". Then the plain readings, for a value with no such end, with the rest
// of the word after them: password="abc"def1 is one shell word.
const SEP = String.raw`(?=[\s,;&}\])\x60.!?]|$)`;
const QUOTED_VALUE = String.raw`"(?:[^"\\\n]|\\.)*"${SEP}|'[^'\n]*'${SEP}|'(?:[^'\\\n]|\\.)*'${SEP}|"[^\n]{0,4000}?"${SEP}|'[^\n]{0,4000}?'${SEP}|(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|"[^"\n]*"|'[^'\n]*')[^\s,;&}\])]*|${OTHER_QUOTED}`;
// A setting's value, as a shell writes it: there a double quote's plain reading wins too when the next setting follows
// it, so password="a\" token="x" leaves neither (the escaped reading ended at token's opening quote and left its value).
// Only where the next setting follows (an option such as -e may come between): in logfmt, Go, Ruby or Python \" is an
// escape, and token="abc\" def" left " def"".
const SHELL_QUOTED_VALUE = String.raw`"[^"\n]*"(?=[ \t]+(?:-{1,2}[A-Za-z][\w-]*[ \t]+)?[A-Za-z_][\w.-]*=)|${QUOTED_VALUE}`;
// A whole `${{ … }}` or `${NAME}` first, so a reference is judged as one value, not cut at its space or brace.
const BARE_VALUE = String.raw`\$\{\{[^}\n]*\}\}|\$\{[A-Za-z_][A-Za-z0-9_]*\}|(?:(?:Bearer|Basic|Token)\s+)?(?![\u201C\u2018\u00AB\u201E\u300C\uFF02])[^\s,;&"'}\])]+`;
// "apiKey": "…", 'token': '…' — a JSON or object field.
const QUOTED_FIELD = new RegExp(String.raw`(["'])(${CRED_KEY})\1(\s*(?:=>|[:=])\s*)(?:${QUOTED_VALUE}|${BARE_VALUE})`, 'gi');
// TOKEN=…, password: …, ?token=…, password = … — a setting, a log line, a query. Not `==`.
// A code fence after `Enter Password:` is the end of a log, not its value. Ruby's `:password => …` and
// `password => …` are a hash's field (HB-0501); an arrow function's body after it is code (isArrowCode).
// A fullwidth colon (password：…) is a colon.
const BARE_FIELD = new RegExp(String.raw`${KEY_START}(${CRED_KEY})(?:(=(?![=>])|[:\uFF1A]\s*(?!\x60{3}))(?:${SHELL_QUOTED_VALUE}|${BARE_VALUE})|(\s+=(?![=>])\s*)(?:${SHELL_QUOTED_VALUE}|${BARE_VALUE})|([ \t]*=>[ \t]*)(?:${SHELL_QUOTED_VALUE}|${BARE_VALUE}))`, 'gi');

/**
 * A quoted name and its value however the quotes are written (HB-0501): plain JSON, a string inside a
 * string as a log or JSON.stringify writes it (\"password\":\"…\"), hand-made mixes that proper
 * escaping never makes (\\"password\":\"…\", \"pass":"…"), and a word processor's curly quotes
 * (“password”: “…”) or a fullwidth colon. The name's quotes need not match.
 *
 * The value is read in code, not by a pattern. At the top level a backslash escapes the next character,
 * as JSON's does, so {"pass":"a\"b"} is one value and {"pass":"a\\"} ends at its quote. Inside a string
 * of k backslashes (1 for \", 3 for \\\"), the value's own closing quote has k + 2(k + 1)·n of them
 * before it: JSON.stringify doubles each backslash and adds one for the quote, at every level. An escaped
 * quote inside it has a number that is not (k + 1 more), and once cut it, and so did a value ending in a
 * backslash, whose closing quote has more than k: the next field's name went into the value and its
 * credential stayed. A value with no end on its line was cut off, and goes to the end of the line (at
 * most 4,000 characters). A value with no quote goes to a separator, as BARE_VALUE does, and to a
 * backslash before a quote: \"token\":123456\" leaves the closing quote.
 *
 * Linear: a name starts only after something that is no backslash, so a run of them is tried once, and
 * the search goes on from each value's end, so no character is read as a value twice.
 */
const QUOTE = String.raw`["'\u201C\u201D\u2018\u2019\u00AB\u00BB\u201E\u300C\u300D\uFF02]`;
const VALUE_QUOTE = new RegExp(String.raw`\\*${QUOTE}`, 'y');
const ESCAPED_BARE = /\$\{\{[^}\n]*\}\}|\$\{[A-Za-z_][A-Za-z0-9_]*\}|(?:(?:Bearer|Basic|Token)[ \t]+)?(?:[^\s,;&"'}\])\\\u201C\u201D\u2018\u2019\u00AB\u00BB\u201E\u300C\u300D\uFF02]|\\+(?!["']))+/iy;
// The quotes that close a value: a curly one by either of its pair, as an editor may turn both the same way.
const CLOSERS: Record<string, string> = { '\u201C': '\u201C\u201D', '\u201D': '\u201C\u201D', '\u201E': '\u201C\u201D', '\u2018': '\u2018\u2019', '\u2019': '\u2018\u2019', '\u00AB': '\u00BB', '\u00BB': '\u00AB\u00BB', '\u300C': '\u300D', '\u300D': '\u300D' };
const closers = (q: string) => CLOSERS[q] ?? q;
export function quotedFieldMasker(key: string, flags: string, keep: (value: string, key: string, quoted: boolean) => boolean): (text: string) => string {
  const field = new RegExp(String.raw`(?<!\\)(\\*${QUOTE})(${key})(\\*${QUOTE})(\s*(?:=>|[:=\uFF1A])\s*)`, flags.includes('g') ? flags : `${flags}g`);
  return (text: string) => {
    let out = '', last = 0, m: RegExpExecArray | null;
    field.lastIndex = 0;
    while ((m = field.exec(text))) {
      const at = m.index + m[0].length;
      VALUE_QUOTE.lastIndex = at;
      const open = VALUE_QUOTE.exec(text)?.[0];
      let from = at, to: number, end: number;
      if (open) {
        const q = closers(open.at(-1)!), k = open.length - 1, limit = Math.min(text.length, at + open.length + 4000);
        from = to = end = at + open.length;
        for (let i = from; ; i++) {
          if (i >= limit || text[i] === '\n') { to = end = Math.min(i, limit); if (text[to - 1] === '\r') to--; break; }
          // A backslash at a line's end escapes nothing here: the line ends the value.
          if (text[i] === '\\' && k === 0 && text[i + 1] !== '\n') { i++; continue; }
          if (!q.includes(text[i]!)) continue;
          // At the top level the escapes are skipped above, so any quote met is the end.
          // A curly or other closer only before a separator or the line's end, as OTHER_QUOTED: ’ is an apostrophe too.
          if (k === 0) {
            if (text[i] !== '"' && text[i] !== "'" && i + 1 < text.length && !/[\s,;&}\])`"'.!?]/.test(text[i + 1]!)) continue;
            to = i; end = i + 1; break;
          }
          let j = i;
          while (j > from && text[j - 1] === '\\') j--;
          const run = i - j;
          if (run >= k && (run - k) % (2 * (k + 1)) === 0) { to = i - k; end = i + 1; break; }
        }
      } else {
        ESCAPED_BARE.lastIndex = at;
        const bare = ESCAPED_BARE.exec(text)?.[0];
        if (!bare) continue;
        to = end = at + bare.length;
      }
      const value = text.slice(from, to);
      // On from the closing quote, not past it: where the end was unclear (quoting no encoder makes), the quote
      // taken as this value's end can be the next name's opening one, and that name's value must still go.
      field.lastIndex = Math.max(to, field.lastIndex);
      if (keep(value, m[2]!, !!open) || (!open && looksLikeCode(value) && inTernary(text, m.index))) continue;
      out += `${text.slice(last, from)}***`;
      last = to;
    }
    return out + text.slice(last);
  };
}
/**
 * Code, not a value: a call (`getPass(`) or a member (`rt?.source`, `cfg.mode`) whose root is a lowercase name
 * and whose parts are names, none with a digit. `Correct.Horse`, `hunter2.x` and `s3cr3t.k3y` are values.
 */
export const looksLikeCode = (v: string) => /^[a-z_$][A-Za-z_$]*(?:\??\.[A-Za-z_$][A-Za-z_$]*)*(?:\(|(?:\??\.[A-Za-z_$][A-Za-z_$]*)$)/.test(v);
/**
 * `flag ? 'api-key' : cfg.mode`: a ternary's branches, not a field, when a `?` and a space come right before the
 * name (no JSON or hash has one) and the value is code with no quotes. A quoted one still goes: `? 'password': 'x'`.
 */
function inTernary(text: string, at: number): boolean {
  let j = at - 1;
  while (j >= 0 && at - j <= 20 && (text[j] === ' ' || text[j] === '\t')) j--;
  return j < at - 1 && text[j] === '?';
}
// A value already masked, or a reference to a setting, is no credential.
const maskQuotedCredentials = quotedFieldMasker(CRED_KEY, 'gi', (value) => /^\*+$/.test(value) || isReference(value));
/**
 * The shell's PWD and OLDPWD are folders, and a sudo journal line carries one. Masked as a
 * password it stopped at a space, and the rest of the folder stayed with no path left to
 * find it. Only by those exact names and only a value that starts like a path (or is one
 * a report has masked already): a report's own path masks take it from there. A `;` right
 * against it is a connection string's password (Uid=sa;PWD=/x;), where sudo spaces its own.
 */
const isShellFolder = (key: string, value: string) => /^(?:OLD)?PWD$/.test(key) && /^["']?(?:\/|~(?:\/|["']?$)|\{path)/.test(value);
const masked = (value: string) => (value.startsWith('"') ? '"***"' : value.startsWith("'") ? "'***'"
  : value.length > 1 && /^[\u201C\u2018\u00AB\u201E\u300C\uFF02]/.test(value) && /[\u201C\u201D\u2019\u00BB\u300D\uFF02]$/.test(value) ? `${value[0]}***${value.at(-1)}` : '***');
/**
 * A reference, not a value: $NAME (capitals, as settings are named),
 * ${name}, ${{ secrets.X }}. Anything else starting with $ is a value: every
 * `$…` was kept, so `password=$fake-value` went through (#209).
 */
const isReference = (value: string) => /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$\{\{[^}\n]*\}\})$/.test(value);
/**
 * After a spaced `=`, code: a call (`getToken(req`), an index, a member
 * (`config.apiKey`) or a keyword. Any other bare word there is a value: only a
 * quoted literal was masked, so `password = fake-value` went through (#209).
 */
const isCode = (value: string) =>
  /[([]/.test(value) || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)
  || /^(?:null|undefined|None|nil|true|false|await|new|this|self)$/.test(value);

/**
 * After `=>`, an arrow function's body, not a hash's value, only when it reads as code: a block, a call or
 * a member (`token.trim(`, `my.secret`), the parameter itself (`token`, `!token`, `(token`), or a lowercase name
 * with no digit and an operator after it (`token && ok`, `token === x`). Anything else is a value: `password => !Qaz2wsx`
 * went through when any `!` or `(` at the start was taken for code.
 */
const ARROW_TEMPLATE = /`[^`\n]{0,400}?\$\{/y;
const ARROW_OPERATOR = /[ \t]*(?:&&|\|\||[=!]==?|[<>]=?|\?\??|\)|[+*/%-][ \t])/y;
function isArrowCode(key: string, value: string, whole: string, after: number): boolean {
  // A block opens with `{` alone; `{abc}` and Perl's q{…} are values. Calls and members as looksLikeCode reads them.
  if (value === '{' || (looksLikeCode(value) && !/^q[qwr]?[({[<]/.test(value))) return true; // Perl's q(…) quotes a value
  // An object literal `({`, a built-in's or a constant's call (JSON.parse(, PASSWORD_RE.test(), and a template with
  // ${…} in it are code too.
  if (value.startsWith('({') || /^[A-Z][A-Za-z0-9_$]*\.[a-z_$][\w$]*\(/.test(value)) return true;
  if (value.startsWith('`')) { ARROW_TEMPLATE.lastIndex = after - value.length; return ARROW_TEMPLATE.test(whole); }
  const name = /^[!([]*([A-Za-z_$][\w$]*)/.exec(value)?.[1];
  if (name === key) return true;
  if (!/^[a-z_$][A-Za-z_$]*$/.test(value)) return false;
  ARROW_OPERATOR.lastIndex = after;
  return ARROW_OPERATOR.test(whole);
}

export function redactCredentialFields(text: string): string {
  return maskQuotedCredentials(String(text ?? '')
    .replace(QUOTED_FIELD, (m, q: string, key: string, sep: string, at: number, whole: string) => {
      const value = m.slice(q.length * 2 + key.length + sep.length);
      return isReference(value) || (!/^["']/.test(value) && looksLikeCode(value) && inTernary(whole, at)) ? m : `${q}${key}${q}${sep}${masked(value)}`;
    }))
    .replace(BARE_FIELD, (m, key: string, sep1: string | undefined, sep2: string | undefined, arrow: string | undefined, at: number, whole: string) => {
      const sep = sep1 ?? sep2 ?? arrow ?? '';
      const value = m.slice(key.length + sep.length);
      // A reference ($TOKEN, ${{ secrets.X }}), code after a spaced `=` or an arrow, or an already-masked value is not a credential.
      return isReference(value) || (sep2 && isCode(value)) || (arrow && isArrowCode(key, value, whole, at + m.length)) || value === '***'
        || (isShellFolder(key, value) && whole[at - 1] !== ';' && whole[at + m.length] !== ';') ? m : `${key}${sep}${masked(value)}`;
    });
}

export function redactSecrets(text: string): string {
  let out = redactCredentialFields(String(text ?? ''));
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

// A key's block: its first line, then the last, or for one cut off the base64 that follows. A label is in capitals, so
// a sentence that only says "BEGIN" is no block; a start that lost dashes in a paste still is.
const KEY_BEGIN = /(?<!-)-{2,}BEGIN ([A-Z0-9][A-Z0-9 _.-]{0,79}?)(?:-{2,}|$)/gm;
const KEY_BEGIN_AHEAD = new RegExp(KEY_BEGIN.source, 'gm');
const KEY_END = /(?<!-)-{2,}END ([A-Z0-9][A-Z0-9 _.-]{0,79}?)(?:-{2,}|$)/gm;
const KEY_LINE_BREAK = /(?:[ \t]*(?:\r?\n|\\r\\n|\\n)){1,2}(?:["'`]?[ \t]*\+?[ \t]*\r?\n[ \t]*["'`]?)?/y;
const KEY_SAME_LINE = /(?:[ \t]*[A-Za-z0-9+/=]{20,})+/y;
// The headers a PEM block really has: `Status: 500` or `Error: x` after its first line is a log going on.
const KEY_HEADER = /^(?:Proc-Type|DEK-Info|Comment|Version|Hash|Charset|MessageID|Subject|Originator-[\w-]+|Recipient-[\w-]+|Key-Info|MIC-Info|MIC-Only|Content-Domain|x-[\w-]+): /i;
const KEY_CUT_MARK = /[ \t]*(?:\[[^\]\n]{0,20}\]|\([^)\n]{0,20}\)|<[^>\n]{0,20}>|…|\.{3})$/;
function matchAt(re: RegExp, text: string, at: number): number {
  re.lastIndex = at;
  return re.exec(text)?.[0].length ?? 0;
}
/**
 * A word that can be a line of a key's body, by character mix or length: long; `=` at
 * its end; letters with digits or with capitals inside. base64url's - and _ count only
 * with all three kinds, as a name with a dash in it has them less often. A word of a
 * log (Done, Retrying, 200, /usr/bin/x) is none, and ends the body.
 */
function isKeyLine(word: string): boolean {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(word)) return false;
  if (/[-_]/.test(word)) return /[A-Z]/.test(word) && /[a-z]/.test(word) && /\d/.test(word);
  if (readsAsPath(word)) return false;
  if (word.length >= 20 || word.endsWith('=')) return true;
  return (/[A-Za-z]/.test(word) && /\d/.test(word)) || /[a-z][A-Z]|[A-Z]{2}[a-z]/.test(word);
}
/**
 * The line at `at`, ended by a real or a written line break: where it ends and its words.
 * It may carry the prefix the first line did (a journal's `Nov 05 x app[1]:`, a quote's
 * `>`, `web_1 |`), known by the last word of that prefix, and a mark that it was cut
 * (`abc [truncated]`). Neither counts as words of the line.
 */
function keyLineWords(text: string, at: number, tag: string): { end: number; words: string[] } | undefined {
  const chunk = text.slice(at, at + 8193);
  const brk = /\\[rn]|\r?\n/.exec(chunk);
  if (!brk && chunk.length > 8192) return undefined;
  let line = brk ? chunk.slice(0, brk.index) : chunk;
  const end = at + line.length;
  if (tag) {
    const i = line.indexOf(`${tag} `);
    if (i >= 0 && (i === 0 || /\s/.test(line[i - 1]!))) line = line.slice(i + tag.length);
  }
  return { end, words: line.replace(KEY_CUT_MARK, '').trim().split(/[ \t]+/).filter(Boolean) };
}
/** Where the body of a key cut off before its last line ends: its lines of base64, with any `Proc-Type:` lines at the top. */
function keyRunEnd(text: string, from: number, tag: string): number {
  let stop = from + matchAt(KEY_SAME_LINE, text, from), inHeaders = true, width = 0;
  for (;;) {
    const gap = matchAt(KEY_LINE_BREAK, text, stop);
    if (!gap) return stop;
    const line = keyLineWords(text, stop + gap, tag);
    if (!line?.words.length) return stop;
    if (inHeaders && KEY_HEADER.test(line.words.join(' '))) { stop = line.end; continue; }
    inHeaders = false;
    const [first, ...others] = line.words as [string, ...string[]];
    // A last line can be short, and then its letters say nothing: only after a line surely of the key.
    const tail = width > 0 && !others.length && /^[a-z]{1,4}$/.test(first);
    if (!tail && !(isKeyLine(first) && others.every((w) => w.length >= 20 && /^[A-Za-z0-9+/=]+$/.test(w)))) return stop;
    stop = line.end;
    // Every line of a body is as wide as the first but the last.
    if (first.length < width) return stop;
    width ||= first.length;
  }
}
/** Folders of words, CamelCase or not, where each name uses up all its letters as words: base64 leaves a stray one. */
const readsAsPath = (run: string) => !run.includes('+') && !run.endsWith('=') && run.includes('/')
  && run.split('/').every((name) => !name.replace(/[A-Z]?[a-z]{2,}\d*|[A-Z]{2,}\d*|\d+/g, ''));
const BASE64_RUN = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}/g;
/**
 * A long run with + or / in it, which breaks the plain rule's run, is base64 when
 * it has all three kinds of character and they change all the time, and is not a path
 * of words: a CamelCase one changes about one character in three, base64 two in three.
 */
function looksLikeBase64(run: string): boolean {
  if (!/[+/]/.test(run) || !/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/\d/.test(run) || readsAsPath(run)) return false;
  const kind = (c: string) => (c >= 'a' && c <= 'z' ? 1 : c >= 'A' && c <= 'Z' ? 2 : c >= '0' && c <= '9' ? 3 : 0);
  let changes = 0;
  for (let i = 1; i < run.length; i++) if (kind(run[i]!) !== kind(run[i - 1]!)) changes++;
  return changes >= run.length * 0.4;
}
const sameKeyLabel = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
/**
 * A PuTTY key file (.ppk) has no BEGIN line (HB-0497): its first line, then its own headers and the lines of
 * base64 each `Public-Lines:` and `Private-Lines:` count, to `Private-MAC:` (`Private-Hash:` in version 1) or,
 * cut off, to the first line that is none of these. A paste that starts at `Private-Lines: N` holds the
 * private half, and goes from there. Only with a line of base64: the header named in a sentence is no key.
 *
 * Each line may carry what the first one had before the key (an indent, a quote's `>`, a journal's
 * `Nov 06 box app[12]:` known by its last word, `cat -n`'s numbers) and spaces at its end: the private
 * lines went public when they did. A line is read once, and a header-only run is not read again.
 */
const PPK_START = /(?:PuTTY-User-Key-File-\d{1,2}:[ \t]*[\w@.-]+|(?<![\w-])Private-Lines:[ \t]*(\d{1,4}))[ \t]*(?=\r?\n|\\r\\n|\\n)/g;
const PPK_BREAK_AT = /\r?\n|\\r\\n|\\n/y;
const PPK_NEXT_BREAK = /\r?\n|\\r\\n|\\n/g;
const PPK_HEADER = /^(?:Encryption|Comment|Public-Lines|Private-Lines|Key-Derivation|Argon2-[A-Za-z]{1,20}):/;
const PPK_COUNT = /^(?:Public|Private)-Lines:[ \t]*(\d{1,4})$/;
const PPK_END = /^Private-(?:MAC|Hash):[ \t]*[0-9A-Fa-f]*/;
const PPK_BODY = /^[A-Za-z0-9+/]{1,128}={0,2}(?=["'\x60]|$)/;
/**
 * Where a line's own text starts: after a prefix shaped like the first line's, its numbers and its spaces free
 * (`cat -n`'s counts, a journal's or `docker logs --timestamps`' times, `grep -n`'s `12:` or `12-`), or after the
 * journal's tag (its last word); otherwise at the line's start.
 */
function ppkContentAt(line: string, shape: RegExp | undefined, tag: string): number {
  const m = shape?.exec(line);
  if (m) return m[0].length;
  if (tag) {
    const i = line.indexOf(`${tag} `);
    if (i >= 0 && (i === 0 || /\s/.test(line[i - 1]!))) return i + tag.length;
  }
  return 0;
}
const prefixShape = (prefix: string) => {
  const exact = prefix.trimEnd();
  // Spaces as [ \t]+ between pieces (only the indent may be none): `[ \t]*` between two \d+ let a line of digits be split
  // every way, exponential in the numbers of a prefix like `1 1 1 1 …` (HB-0501, final review). One replace, so the
  // space inside an inserted class is not rewritten.
  return exact ? new RegExp(`^${exact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+/g, '\\d+').replace(/[ \t]+/g, (_m: string, i: number) => (i === 0 ? '[ \\t]*' : '[ \\t]+')).replace(/\\d\+[:-]/g, '\\d+[:-]')}`) : undefined;
};
interface PpkLine { content: string; at: number; end: number }
function ppkBlock(text: string, start: number, firstEnd: number, count: number): { end?: number; read: number } {
  const prefix = text.slice(Math.max(0, start - 200), start).split(/\\[rn]|\n/).at(-1) ?? '';
  const shape = prefixShape(prefix);
  const tag = prefix.trim().split(/\s+/).at(-1) ?? '';
  // The line after the break at `pos`, its own text trimmed; undefined at the end or for a line too long to be one.
  const lineAfter = (pos: number): PpkLine | undefined => {
    PPK_BREAK_AT.lastIndex = pos;
    const br = PPK_BREAK_AT.exec(text);
    if (!br) return undefined;
    const lineAt = pos + br[0].length;
    PPK_NEXT_BREAK.lastIndex = lineAt;
    const end = PPK_NEXT_BREAK.exec(text)?.index ?? text.length;
    if (end - lineAt > 8192) return undefined;
    const line = text.slice(lineAt, end), off = ppkContentAt(line, shape, tag), raw = line.slice(off);
    return { content: raw.trim(), at: lineAt + off + (raw.length - raw.trimStart().length), end };
  };
  let pos = firstEnd, end = firstEnd, body = 0, blanks = 0;
  for (;;) {
    const line = lineAfter(pos);
    if (!line) break;
    const { content, at } = line;
    if (!content) { if (++blanks > 2) break; pos = line.end; continue; }
    blanks = 0;
    let m: RegExpExecArray | null;
    if ((m = PPK_END.exec(content))) { end = at + m[0].length; pos = line.end; break; }
    if ((m = PPK_BODY.exec(content))) {
      // Past what the header counted, a key that was wrapped again: a line that reads as key material, or a run of
      // base64 up to the next header or the MAC (at most 64 lines on). A word after a cut-off key (`ok`) is neither.
      let take = count > 0 || isKeyLine(content);
      if (!take) {
        let ahead = line;
        for (let n = 0; n < 64 && ahead && PPK_BODY.test(ahead.content); n++) ahead = lineAfter(ahead.end)!;
        take = !!ahead && (PPK_END.test(ahead.content) || PPK_HEADER.test(ahead.content));
      }
      if (take) {
        if (count > 0) count--;
        body++; end = at + m[0].length; pos = line.end;
        if (m[0].length < content.length) break; // a quote after it: the string holding the key ends here
        continue;
      }
      break;
    }
    if (!PPK_HEADER.test(content)) break;
    count = +(PPK_COUNT.exec(content)?.[1] ?? 0);
    end = at + content.length; pos = line.end;
  }
  return { end: body ? end : undefined, read: pos };
}
function maskPuttyKeys(text: string): string {
  if (!/PuTTY-User-Key-File-|Private-Lines:/.test(text)) return text;
  let out = '', last = 0, m: RegExpExecArray | null;
  PPK_START.lastIndex = 0;
  while ((m = PPK_START.exec(text))) {
    const block = ppkBlock(text, m.index, m.index + m[0].length, m[1] ? +m[1] : 0);
    if (block.end !== undefined) { out += `${text.slice(last, m.index)}{key}`; last = block.end; }
    PPK_START.lastIndex = Math.max(PPK_START.lastIndex, block.end ?? block.read);
  }
  return out + text.slice(last);
}
/**
 * For a public report (redactForPublic), not for every log line: a whole PEM block
 * of any kind as {key}, to the last line with its own label, or for one cut off to the
 * end of its base64; a PuTTY key file the same way; and long base64 with + or /, which the rules above never see whole.
 * One pass, however the text is made.
 */
export function maskKeyMaterial(text: string): string {
  let out = maskPuttyKeys(text);
  if (/(?<!-)-{2,}BEGIN /.test(out)) {
    let done = '', last = 0, end: RegExpExecArray | null | undefined, next: RegExpExecArray | null | undefined, m: RegExpExecArray | null;
    KEY_BEGIN.lastIndex = 0;
    while ((m = KEY_BEGIN.exec(out))) {
      if (!m[0].startsWith('-----') && !/KEY|CERTIFICATE|PGP|ENCRYPTED/.test(m[1]!)) continue; // ---BEGIN STACK--- is a log's banner: only a key's start can have lost dashes
      const bodyAt = m.index + m[0].length;
      if (end === undefined || (end && end.index < bodyAt)) { KEY_END.lastIndex = bodyAt; end = KEY_END.exec(out); }
      if (next === undefined || (next && next.index < bodyAt)) { KEY_BEGIN_AHEAD.lastIndex = bodyAt; next = KEY_BEGIN_AHEAD.exec(out); }
      // An end after the next beginning is that one's, and one of another kind is no end of this: this one was cut off.
      const closed = end && (!next || end.index < next.index) && sameKeyLabel(m[1]!, end[1]!);
      const before = out.slice(Math.max(0, m.index - 200), m.index).split(/\\[rn]|\n/).at(-1) ?? '';
      const stop = closed ? end!.index + end![0].length : keyRunEnd(out, bodyAt, before.trim().split(/\s+/).at(-1) ?? '');
      done += `${out.slice(last, m.index)}{key}`;
      last = stop;
      KEY_BEGIN.lastIndex = stop;
    }
    out = done + out.slice(last);
  }
  return out.replace(BASE64_RUN, (run) => (looksLikeBase64(run) ? '***' : run));
}

/**
 * Known credential values, masked exactly wherever they appear (a short one
 * the shape rules cannot recognise). Plain string search, no pattern built
 * from them; the list is the caller's, used for one call and never kept or
 * logged. Under 6 characters a value would mask ordinary words, so it is left
 * to the field rules.
 */
export function maskKnownValues(text: string, values: Iterable<string> | undefined): string {
  let out = String(text ?? '');
  if (!values) return out;
  const list = [...new Set([...values].filter((v) => typeof v === 'string' && v.trim().length >= 6))].sort((a, b) => b.length - a.length);
  for (const v of list) if (out.includes(v)) out = out.split(v).join('***');
  return out;
}

/** The credential-looking settings in an environment (by name), for maskKnownValues. */
export function credentialValuesFromEnv(env: Record<string, string | undefined>): string[] {
  const name = new RegExp(`^${CRED_KEY}$`, 'i');
  // PWD/OLDPWD are the shell's folders, not passwords.
  return Object.entries(env).filter(([k, v]) => !!v && name.test(k) && !/^(OLD)?PWD$/i.test(k)).map(([, v]) => v!);
}

/**
 * A short technical cause to show beside a plain-words failure: enough for the
 * owner to search or send on, never enough to leak a credential.
 */
export function briefCause(err: unknown, max = 160): string {
  const e = err as { code?: unknown; message?: unknown } | undefined;
  const code = typeof e?.code === 'string' ? e.code : '';
  const msg = redactSecrets(String(e?.message ?? err ?? '')).replace(/\s+/g, ' ').trim();
  const text = code && !msg.includes(code) ? `${code}: ${msg}` : msg;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
