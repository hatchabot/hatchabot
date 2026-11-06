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
  [/\b[A-Za-z0-9_-]{40,}\b/g, '***'],                   // anything else long enough to be a key
];

/**
 * A field or setting that holds a credential, by its NAME: the value goes
 * whatever its length. The rules above only catch long or known-shaped values,
 * so a short password or token in `PASSWORD=…` or `"apiKey": "…"` went through
 * (security audit, 2026-10-09). Only names that END in the credential word:
 * `max_tokens: 400` and `tokenizer` are not credentials.
 */
const CRED_KEY = String.raw`[A-Za-z0-9_.-]*?(?:token|secret|passw(?:or)?d|passphrase|pwd|authorization|(?:api|access|private|secret|signing|client|encryption|master)[_-]?key)`;
// Starts only where a name starts, so a long run of name characters is tried once (linear).
const KEY_START = String.raw`(?<![A-Za-z0-9_.-])`;
const QUOTED_VALUE = String.raw`"(?:[^"\\\n]|\\.)*"|'[^'\n]*'`;
// A whole `${{ … }}` or `${NAME}` first, so a reference is judged as one value, not cut at its space or brace.
const BARE_VALUE = String.raw`\$\{\{[^}\n]*\}\}|\$\{[A-Za-z_][A-Za-z0-9_]*\}|(?:(?:Bearer|Basic|Token)\s+)?[^\s,;&"'}\])]+`;
// "apiKey": "…", 'token': '…' — a JSON or object field.
const QUOTED_FIELD = new RegExp(String.raw`(["'])(${CRED_KEY})\1(\s*(?:=>|[:=])\s*)(?:${QUOTED_VALUE}|${BARE_VALUE})`, 'gi');
// The same inside a string, as a log or JSON.stringify writes it: \"password\":\"…\". The first form sees only `password\`, so the whole of it went through.
const ESCAPED_FIELD = new RegExp(String.raw`(?<!\\)(\\+")(${CRED_KEY})\1(\s*[:=]\s*)(\\+")([^\n]{0,4000}?)\4`, 'gi');
// TOKEN=…, password: …, ?token=…, password = … — a setting, a log line, a query. Not `==` or `=>`.
// A code fence after `Enter Password:` is the end of a log, not its value.
const BARE_FIELD = new RegExp(String.raw`${KEY_START}(${CRED_KEY})(?:(=(?![=>])|:\s*(?!\x60{3}))(?:${QUOTED_VALUE}|${BARE_VALUE})|(\s+=(?![=>])\s*)(?:${QUOTED_VALUE}|${BARE_VALUE}))`, 'gi');
/**
 * The shell's PWD and OLDPWD are folders, and a sudo journal line carries one. Masked as a
 * password it stopped at a space, and the rest of the folder stayed with no path left to
 * find it. Only by those exact names and only a value that starts like a path (or is one
 * a report has masked already): a report's own path masks take it from there. A `;` right
 * against it is a connection string's password (Uid=sa;PWD=/x;), where sudo spaces its own.
 */
const isShellFolder = (key: string, value: string) => /^(?:OLD)?PWD$/.test(key) && /^["']?(?:\/|~(?:\/|["']?$)|\{path)/.test(value);
const masked = (value: string) => (value.startsWith('"') ? '"***"' : value.startsWith("'") ? "'***'" : '***');
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

export function redactCredentialFields(text: string): string {
  return String(text ?? '')
    .replace(QUOTED_FIELD, (m, q: string, key: string, sep: string) => {
      const value = m.slice(q.length * 2 + key.length + sep.length);
      return isReference(value) ? m : `${q}${key}${q}${sep}${masked(value)}`;
    })
    .replace(ESCAPED_FIELD, (m, q: string, key: string, sep: string, q2: string, value: string) => (isReference(value) ? m : `${q}${key}${q}${sep}${q2}***${q2}`))
    .replace(BARE_FIELD, (m, key: string, sep1: string | undefined, sep2: string | undefined, at: number, whole: string) => {
      const sep = sep1 ?? sep2 ?? '';
      const value = m.slice(key.length + sep.length);
      // A reference ($TOKEN, ${{ secrets.X }}), code after a spaced `=`, or an already-masked value is not a credential.
      return isReference(value) || (sep2 && isCode(value)) || value === '***' || (isShellFolder(key, value) && whole[at - 1] !== ';' && whole[at + m.length] !== ';') ? m : `${key}${sep}${masked(value)}`;
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
 * For a public report (redactForPublic), not for every log line: a whole PEM block
 * of any kind as {key}, to the last line with its own label, or for one cut off to the
 * end of its base64; and long base64 with + or /, which the rules above never see whole.
 * One pass, however the text is made.
 */
export function maskKeyMaterial(text: string): string {
  let out = text;
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
