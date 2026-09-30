/**
 * What a shared copy of an agent says about real people. A template carries
 * the agent's instructions and its scheduled tasks' messages, and agents
 * write personal notes into their own AGENTS.md: the Condo Adviser's would
 * have carried 13 email addresses, its owner's among them (review,
 * 2026-09-30). Nothing can tell a note that must stay from one that must
 * not, so this only finds and counts them, and the owner reads before sending.
 *
 * Blunt on purpose, like redact.ts: a false "1 phone number" costs a glance;
 * a missed address travels.
 */
export type PersonalKind = 'email' | 'phone' | 'token';

export interface PersonalHit {
  /** Which part of the copy: "AGENTS.md", "Scheduled task “Digest”"… */
  where: string;
  /** 1-based line within that part. */
  line: number;
  kind: PersonalKind;
  /** The value as found, except a token, which shows only its first characters. */
  sample: string;
}

export interface PersonalScan {
  /** Distinct values of each kind in the whole copy. */
  emails: number;
  phones: number;
  tokens: number;
  /** The first place each distinct value appears, capped (see `more`). */
  hits: PersonalHit[];
  /** Distinct values found but not listed in `hits`. */
  more: number;
}

// An SSH remote (git@github.com:owner/repo) is an address in form only.
const EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;
// North American (555-123-4567, (555) 123-4567, +1 555 123 4567) and any
// number written with a leading +country code. Separators are required: a
// bare run of digits is more often an id or a timestamp than a phone.
const NANP_RE = /(?<![\w+])(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\w-])/g;
const INTL_RE = /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?![\w-])/g;
// Credential shapes — the same families redact.ts masks, minus its catch-all
// (a 40-character commit hash is not a secret worth a warning).
const TOKEN_RES: RegExp[] = [
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g,          // a Telegram bot token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/gi,          // a Slack token
  /\bxapp-\d-[A-Za-z0-9-]{10,}/gi,             // a Slack app-level token
  /\bsk-[A-Za-z0-9_-]{16,}/g,                  // an API key (Anthropic, OpenAI…)
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, // a GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,                     // an AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}/g,                  // a Google API key
  /\/\/[^/\s:@]+:[^/\s@]{6,}@/g,               // credentials in a URL
];

function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function scanPersonalData(sources: Array<{ where: string; text: string | undefined }>, maxHits = 40): PersonalScan {
  const seen: Record<PersonalKind, Set<string>> = { email: new Set(), phone: new Set(), token: new Set() };
  const hits: PersonalHit[] = [];
  let more = 0;
  const add = (kind: PersonalKind, key: string, where: string, text: string, index: number, sample: string) => {
    if (seen[kind].has(key)) return;
    seen[kind].add(key);
    if (hits.length < maxHits) hits.push({ where, line: lineAt(text, index), kind, sample });
    else more++;
  };
  for (const { where, text } of sources) {
    if (!text) continue;
    for (const m of text.matchAll(EMAIL_RE)) {
      if (/^git@/i.test(m[0])) continue;
      // user:password@host in a URL is a credential (counted below), not an address.
      if (/\/\/[^/\s:@]+:$/.test(text.slice(Math.max(0, m.index! - 200), m.index))) continue;
      add('email', m[0].toLowerCase(), where, text, m.index!, m[0]);
    }
    const phoneSpans: Array<[number, number]> = [];
    for (const re of [INTL_RE, NANP_RE]) {
      for (const m of text.matchAll(re)) {
        const start = m.index!, end = start + m[0].length;
        if (phoneSpans.some(([s, e]) => start < e && end > s)) continue; // one number, two shapes
        const digits = m[0].replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15) continue;
        phoneSpans.push([start, end]);
        add('phone', digits.replace(/^1(?=\d{10}$)/, ''), where, text, start, m[0].trim());
      }
    }
    for (const re of TOKEN_RES) {
      for (const m of text.matchAll(re)) add('token', m[0], where, text, m.index!, `${m[0].slice(0, 4)}…`);
    }
  }
  return { emails: seen.email.size, phones: seen.phone.size, tokens: seen.token.size, hits, more };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "13 email addresses and 2 phone numbers", or '' when the copy mentions none. */
export function personalSummary(s: Pick<PersonalScan, 'emails' | 'phones' | 'tokens'>): string {
  const parts = [
    s.emails ? plural(s.emails, 'email address', 'email addresses') : '',
    s.phones ? plural(s.phones, 'phone number', 'phone numbers') : '',
    s.tokens ? plural(s.tokens, 'thing that looks like a password or key', 'things that look like passwords or keys') : '',
  ].filter(Boolean);
  if (!parts.length) return '';
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
