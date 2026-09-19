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

export function redactSecrets(text: string): string {
  let out = String(text ?? '');
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
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
