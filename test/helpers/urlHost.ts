/**
 * A fetch double's routing: the request's host, parsed, not a substring of the
 * URL ("brave.com" is also in "evil-brave.com.example"). CodeQL's
 * js/incomplete-url-substring-sanitization flags the substring form, and the
 * public repo's scan counts test/ like the product (HB-0531).
 */
export function urlHost(u: string | URL | Request): string {
  const s = typeof u === 'string' ? u : u instanceof URL ? u.href : u.url;
  try { return new URL(s).hostname; } catch { return ''; }
}

/** The request's host and path, for a double that answers one endpoint. */
export function urlIs(u: string | URL | Request, host: string, path?: string): boolean {
  const s = typeof u === 'string' ? u : u instanceof URL ? u.href : u.url;
  try { const p = new URL(s); return p.hostname === host && (path === undefined || p.pathname === path); } catch { return false; }
}
