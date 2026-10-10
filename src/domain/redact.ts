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
const BARE_VALUE = String.raw`(?:(?:Bearer|Basic|Token)\s+)?[^\s,;&"'}\])]+`;
// "apiKey": "…", 'token': '…' — a JSON or object field.
const QUOTED_FIELD = new RegExp(String.raw`(["'])(${CRED_KEY})\1(\s*[:=]\s*)(?:${QUOTED_VALUE}|${BARE_VALUE})`, 'gi');
// TOKEN=…, password: …, ?token=… — a setting, a log line, a query. A spaced `token = getToken()` is code: only a quoted literal there.
const BARE_FIELD = new RegExp(String.raw`${KEY_START}(${CRED_KEY})(?:(=|:\s*)(?:${QUOTED_VALUE}|${BARE_VALUE})|(\s+=\s*)(?:${QUOTED_VALUE}))`, 'gi');
const masked = (value: string) => (value.startsWith('"') ? '"***"' : value.startsWith("'") ? "'***'" : '***');

export function redactCredentialFields(text: string): string {
  return String(text ?? '')
    .replace(QUOTED_FIELD, (m, q: string, key: string, sep: string) => {
      const value = m.slice(q.length * 2 + key.length + sep.length);
      return value.startsWith('$') ? m : `${q}${key}${q}${sep}${masked(value)}`;
    })
    .replace(BARE_FIELD, (m, key: string, sep1?: string, sep2?: string) => {
      const sep = sep1 ?? sep2 ?? '';
      const value = m.slice(key.length + sep.length);
      // A reference ($TOKEN, ${{ secrets.X }}) or an already-masked value is not a credential.
      return value.startsWith('$') || value === '***' ? m : `${key}${sep}${masked(value)}`;
    });
}

export function redactSecrets(text: string): string {
  let out = redactCredentialFields(String(text ?? ''));
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
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
