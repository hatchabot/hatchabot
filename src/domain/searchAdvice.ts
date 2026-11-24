/**
 * What the owner is told about web search (orchestrator/settings/webSearch.ts): how a
 * provider's answer reads, and what to do about the Brave key. Shared with
 * the manager's own search (ops/opsWeb.ts), so both say the same words.
 */
export type ProbeStatus = 'ok' | 'low' | 'exhausted' | 'rejected' | 'busy' | 'unreachable' | 'blocked' | 'turned-away';
export interface Probe {
  status: ProbeStatus;
  /** Plain words for the owner; never the key or a raw response. */
  detail: string;
  remaining?: number;
  limit?: number;
  /** When the quota comes back, if the provider said. */
  resetsAt?: string;
}
/** `auto`: Brave while it has quota, then DuckDuckGo, and back. `duckduckgo`: always DuckDuckGo. */
export type SearchMode = 'auto' | 'duckduckgo';

/** What the owner is told when DuckDuckGo turns this machine away (HB-0455). */
export const DDG_TURNED_AWAY = 'DuckDuckGo turns this machine away: it answered with a challenge page, not results. So this machine gets no free search from DuckDuckGo, and agents can search only with a working Brave key.';

const KEY_PLACE = 'Settings → AI → Fleet search key';

/**
 * What a Brave failure seen outside a probe says about the key (the manager's
 * own search): the same words probeBrave uses. `status` undefined: no answer.
 */
export function braveFailure(status?: number): Probe {
  if (status === undefined) return { status: 'unreachable', detail: 'Brave could not be reached from this machine.' };
  if (status >= 200 && status < 300) return { status: 'busy', detail: 'Brave answered, but not with results that could be read.' };
  if (status === 429 || status === 402) return { status: 'exhausted', detail: `Brave refused for its quota (${status}): the key has run out, or is limiting requests for now.` };
  if (status === 401 || status === 403 || status === 422) return { status: 'rejected', detail: `Brave refused the key (${status}). It may be wrong, or its plan ended.` };
  return { status: 'busy', detail: `Brave answered ${status}. That is usually its own trouble and passes.` };
}

/**
 * With DuckDuckGo turning this machine away, what to do about Brave, in the
 * owner's words: add a key only when none is set; else what its probe said
 * (run out, refused, works but "DuckDuckGo only" was chosen). The page's
 * renderSearchHealth says the same (HB-0455).
 */
export function braveAdvice(o: { keySet: boolean; brave?: Pick<Probe, 'status' | 'detail' | 'resetsAt'>; mode?: SearchMode }): string {
  if (!o.keySet) return `A Brave key is needed: add one under ${KEY_PLACE}.`;
  const b = o.brave;
  if (!b) return 'The Brave key set has not been checked yet.';
  switch (b.status) {
    case 'ok':
      return o.mode === 'duckduckgo'
        ? `The Brave key works: under ${KEY_PLACE}, choose "Brave, and DuckDuckGo when it runs out" instead of "DuckDuckGo only".`
        : 'The Brave key works.';
    case 'low':
    case 'exhausted':
      return `${b.detail} Replace it under ${KEY_PLACE}${b.resetsAt ? `, or wait for its quota to return (about ${b.resetsAt.slice(0, 10)})` : ', or wait for its quota to return'}.`;
    case 'rejected':
      return `${b.detail} Replace it under ${KEY_PLACE}.`;
    default:
      return `${b.detail} Agents can search again once Brave answers.`;
  }
}

/**
 * Whether a DuckDuckGo answer is it turning this machine away: a challenge
 * page (seen as a 202, "Please complete the following challenge") with no
 * result in it. We say so rather than dress up as a browser to get past it:
 * the block is DuckDuckGo's to make (HB-0455).
 */
export function duckDuckGoTurnedAway(status: number, html: string): boolean {
  if (html.includes('result__a')) return false;
  return status === 202 || /complete the following challenge|anomaly-modal|bots use DuckDuckGo too|captcha/i.test(html);
}
