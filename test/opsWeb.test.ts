import { describe, expect, it } from 'vitest';
import { duckDuckGoResults, isPrivateAddress, makeOpsWeb, strip } from '../src/ops/opsWeb.js';

/** Web search for the jailed management agent: it may search, and open only
 *  what a search returned; never a private address, on any redirect hop. */

const page = (body: string, type = 'text/html', status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': type, ...headers } });

function web(routes: Record<string, () => Response>, ips: Record<string, string[]> = {}) {
  const seen: string[] = [];
  const opsWeb = makeOpsWeb({
    braveKey: async () => 'brave-key',
    lookup: async (h) => ips[h] ?? ['93.184.216.34'],
    fetchImpl: (async (url: string) => { seen.push(String(url)); const r = routes[String(url)] ?? routes[String(url).split('?')[0]!]; if (!r) throw new Error('unrouted ' + url); return r(); }) as any,
  });
  return { opsWeb, seen };
}
const SEARCH = 'https://api.search.brave.com/res/v1/web/search';
const results = (urls: string[]) => () => page(JSON.stringify({ web: { results: urls.map((u, i) => ({ title: `T${i}`, url: u, description: '<b>snip</b>' })) } }), 'application/json');

describe('isPrivateAddress', () => {
  it('knows private, local and link-local ranges', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.17.0.1', '192.168.1.5', '169.254.169.254', '100.100.1.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe('web_search / read_result', () => {
  it('Brave out of quota: the same search comes from DuckDuckGo, and the fleet is told to check (HB-0391)', async () => {
    let failed = 0;
    const answered = new Map<string, number>();
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      answered.set(u.split('?')[0]!, (answered.get(u.split('?')[0]!) ?? 0) + 1);
      if (u.startsWith(SEARCH)) return new Response('{}', { status: 429 });
      return new Response('<a class="result__a" href="https://docs.example.com/d">From DuckDuckGo</a>', { status: 200 });
    }) as unknown as typeof fetch;
    const w = makeOpsWeb({ braveKey: async () => 'made-up', onBraveFailed: () => { failed++; }, fetchImpl, lookup: async () => ['93.184.216.34'] } as never);
    const s = await w('o', 'web_search', { query: 'release notes' });
    expect(s.text).toContain('From DuckDuckGo');
    expect(answered.get(SEARCH)).toBe(1);
    expect(failed).toBe(1);
  });

  it('DuckDuckGo turning this machine away is said plainly, not reported as no results (HB-0455)', async () => {
    const challenge = '<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><p>Please complete the following challenge.</p></body></html>';
    const agents: string[] = [];
    const opsWeb = makeOpsWeb({
      braveKey: async () => undefined,
      lookup: async () => ['93.184.216.34'],
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (!String(url).startsWith('https://html.duckduckgo.com/html/')) throw new Error('unrouted ' + url);
        agents.push(String((init?.headers as Record<string, string>)['user-agent']));
        return page(challenge, 'text/html', 202);
      }) as any,
    });
    const err = await opsWeb('o', 'web_search', { query: 'weather forecast' }).then((r) => r.text, (e: Error) => e.message);
    expect(err).not.toBe('No results.');
    expect(err).toMatch(/turns this machine away/);
    expect(err).toMatch(/no free search/);
    expect(err).toMatch(/A Brave key is needed: add one/);
    // Its own user agent, as before: no browser disguise.
    expect(agents).toEqual(['Mozilla/5.0 (Hatchabot)']);
  });

  it('a Brave key set that failed, then DuckDuckGo turning this machine away: says what Brave answered, not "add a key" (review of HB-0455)', async () => {
    const challenge = '<html><body><p>Please complete the following challenge.</p></body></html>';
    const ask = async (brave: number | 'down') => {
      const opsWeb = makeOpsWeb({
        braveKey: async () => 'made-up',
        lookup: async () => ['93.184.216.34'],
        fetchImpl: (async (url: string) => {
          if (String(url).startsWith(SEARCH)) { if (brave === 'down') throw new TypeError('fetch failed'); return page('{}', 'application/json', brave); }
          return page(challenge, 'text/html', 202);
        }) as any,
      });
      return opsWeb('o', 'web_search', { query: 'weather forecast' }).then((r) => r.text, (e: Error) => e.message);
    };
    const out = await ask(429);
    expect(out).toMatch(/turns this machine away/);
    expect(out).toMatch(/the key has run out/);
    expect(out).toMatch(/Replace it under Settings/);
    expect(await ask(401)).toMatch(/Brave refused the key \(401\)/);
    expect(await ask(503)).toMatch(/Brave answered 503.*once Brave answers/);
    expect(await ask('down')).toMatch(/Brave could not be reached/);
    for (const b of [429, 401, 503, 'down'] as const) expect(await ask(b), String(b)).not.toMatch(/add one|key is needed/);
  });

  it('searches, numbers results, and reads one as text', async () => {
    const { opsWeb } = web({ [SEARCH]: results(['https://docs.example.com/a']), 'https://docs.example.com/a': () => page('<html><script>x()</script><p>Hello <b>world</b></p></html>') });
    const s = await opsWeb('o', 'web_search', { query: 'openclaw release notes' });
    expect(s.text).toMatch(/^1\. T0\n\s+https:\/\/docs\.example\.com\/a\n\s+snip/);
    const r = await opsWeb('o', 'read_result', { n: 1 });
    expect(r.text).toContain('Hello world');
    expect(r.text).not.toContain('x()');
  });

  it('entities are unescaped once: "&amp;lt;" reads as "&lt;", not "<" (CodeQL js/double-escaping)', async () => {
    const { opsWeb } = web({ [SEARCH]: results(['https://docs.example.com/e']), 'https://docs.example.com/e': () => page('<p>a &amp;lt;b&amp;gt; c, x &amp; y, &quot;q&quot;</p>') });
    await opsWeb('o', 'web_search', { query: 'entities' });
    const r = await opsWeb('o', 'read_result', { n: 1 });
    expect(r.text).toContain('a &lt;b&gt; c, x & y, "q"');
  });

  it('without a Brave key, DuckDuckGo: each result keeps its own snippet, and one with none gets none (audit, 2026-10-22)', async () => {
    const ddg = [
      '<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fa&amp;rut=x">First <b>page</b></a>',
      '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">What the <b>first</b> says.</a></div>',
      '<div class="result"><a rel="nofollow" class="result__a" href="https://docs.example.com/b">Second</a></div>',
      '<div class="result"><a rel="nofollow" class="result__a" href="https://docs.example.com/c">Third</a>',
      '<a class="result__snippet" href="https://docs.example.com/c">The third one.</a></div>',
    ].join('\n');
    const opsWeb = makeOpsWeb({
      braveKey: async () => undefined,
      lookup: async () => ['93.184.216.34'],
      fetchImpl: (async (url: string) => { if (!String(url).startsWith('https://html.duckduckgo.com/html/')) throw new Error('unrouted ' + url); return page(ddg); }) as any,
    });
    const s = await opsWeb('o', 'web_search', { query: 'openclaw release notes' });
    expect(s.text).toBe([
      '1. First page\n   https://docs.example.com/a\n   What the first says.',
      '2. Second\n   https://docs.example.com/b\n   ',
      '3. Third\n   https://docs.example.com/c\n   The third one.',
    ].join('\n'));
  });

  it('cannot open anything that was not a result, and results are per owner', async () => {
    const { opsWeb, seen } = web({ [SEARCH]: results(['https://docs.example.com/a']) });
    await opsWeb('o', 'web_search', { query: 'something' });
    expect((await opsWeb('o', 'read_result', { n: 2 })).isError).toBe(true);
    expect((await opsWeb('someone-else', 'read_result', { n: 1 })).isError).toBe(true);
    expect((await opsWeb('o', 'read_result', { n: 'https://evil.example/?d=secret' as any })).isError).toBe(true);
    expect(seen.filter((u) => !u.startsWith(SEARCH))).toEqual([]);
  });

  it('a result number stays bound to its page; once let go it has expired, never another page', async () => {
    let call = 0;
    const urls = (k: number) => Array.from({ length: 8 }, (_, i) => `https://docs.example.com/s${k}-${i}`);
    const routes: Record<string, () => Response> = { [SEARCH]: () => results(urls(call++))() };
    for (let k = 0; k < 8; k++) for (const u of urls(k)) routes[u] = () => page(`<p>page ${u.split('/').pop()}</p>`);
    const { opsWeb } = web(routes);
    let last = '';
    for (let k = 0; k < 8; k++) last = (await opsWeb('o', 'web_search', { query: `q${k}` })).text;
    expect(last).toMatch(/^57\. T0\n\s+https:\/\/docs\.example\.com\/s7-0/); // 64 given out; numbers keep counting
    // 64 results, 60 kept: 1–4 are gone and say so.
    const gone = await opsWeb('o', 'read_result', { n: 4 });
    expect(gone).toMatchObject({ isError: true, text: expect.stringMatching(/Result 4 has expired/) });
    expect((await opsWeb('o', 'read_result', { n: 5 })).text).toContain('page s0-4');
    expect((await opsWeb('o', 'read_result', { n: 64 })).text).toContain('page s7-7');
    expect((await opsWeb('o', 'read_result', { n: 65 })).isError).toBe(true);
  });

  it('refuses a result that resolves to a private address, and a redirect to one', async () => {
    const { opsWeb, seen } = web(
      {
        [SEARCH]: results(['https://intranet.example/', 'https://bounce.example/']),
        'https://bounce.example/': () => page('', 'text/html', 302, { location: 'http://169.254.169.254/latest/meta-data' }),
      },
      { 'intranet.example': ['10.0.0.8'] },
    );
    await opsWeb('o', 'web_search', { query: 'q1' });
    await expect(opsWeb('o', 'read_result', { n: 1 })).rejects.toThrow(/public internet/);
    await expect(opsWeb('o', 'read_result', { n: 2 })).rejects.toThrow(/public internet/);
    expect(seen).not.toContain('http://169.254.169.254/latest/meta-data');
  });

  it('rate-limits searches', async () => {
    const { opsWeb } = web({ [SEARCH]: results([]) });
    for (let i = 0; i < 30; i++) await opsWeb('o', 'web_search', { query: `q${i}` });
    await expect(opsWeb('o', 'web_search', { query: 'one more' })).rejects.toThrow(/Too many/);
  });
});

describe('night review, 2026-09-27', () => {
  it('reads every IPv6 spelling of a private IPv4 address as private', () => {
    // What WHATWG URL makes of [::ffff:127.0.0.1] and [::ffff:169.254.169.254].
    const host = (u: string) => new URL(u).hostname.replace(/^\[|\]$/g, '');
    expect(host('http://[::ffff:127.0.0.1]/')).toBe('::ffff:7f00:1');
    for (const ip of [host('http://[::ffff:127.0.0.1]/'), host('http://[::ffff:169.254.169.254]/'), '::ffff:a00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::127.0.0.1', '2002:7f00:1::1', '2002:c0a8:101::', '::127.0.0.1', '2001:0:4136:e378::1', 'ff02::1', 'fec0::1', '0:0:0:0:0:0:0:1', 'not-an-ip:zz'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['::ffff:5db8:d822', '64:ff9b::5db8:d822', '2002:5db8:d822::1', '2606:4700::1111'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('a redirect to [::ffff:a9fe:a9fe] is refused', async () => {
    const { opsWeb, seen } = web({
      [SEARCH]: results(['https://bounce.example/']),
      'https://bounce.example/': () => page('', 'text/html', 302, { location: 'http://[::ffff:169.254.169.254]/latest/meta-data/' }),
    });
    await opsWeb('o', 'web_search', { query: 'night q' });
    await expect(opsWeb('o', 'read_result', { n: 1 })).rejects.toThrow(/public internet/);
    expect(seen.some((u) => u.includes('a9fe'))).toBe(false);
  });

  it('stops reading an endless page at the cap', async () => {
    let pulled = 0;
    const endless = () => new Response(new ReadableStream({
      pull(c) { pulled += 1; c.enqueue(new Uint8Array(64 * 1024).fill(97)); },
    }), { headers: { 'content-type': 'text/plain' } });
    const { opsWeb } = web({ [SEARCH]: results(['https://big.example/']), 'https://big.example/': endless });
    await opsWeb('o', 'web_search', { query: 'night q' });
    const r = await opsWeb('o', 'read_result', { n: 1 });
    expect(r.isError).toBeUndefined();
    expect(pulled).toBeLessThan(40); // about 1 MB, not for ever
  });

  it('a page of "<" with no ">", or of "<script" never closed, is read in time that grows with its size, not its square (HB-1056)', async () => {
    for (const body of ['<'.repeat(100_000), '<script'.repeat(15_000), `<p>${'<a'.repeat(50_000)}`]) {
      const { opsWeb } = web({ [SEARCH]: results(['https://slow.example/']), 'https://slow.example/': () => page(body) });
      await opsWeb('o', 'web_search', { query: 'slow page' });
      const t = performance.now();
      const r = await opsWeb('o', 'read_result', { n: 1 });
      expect(performance.now() - t).toBeLessThan(2000);
      expect(r.isError).toBeUndefined();
    }
  });
});

describe("DuckDuckGo's results page (HB-1238)", () => {
  /** A search with no Brave key, DuckDuckGo answering `body`. */
  const ddg = (body: string) => makeOpsWeb({
    braveKey: async () => undefined,
    lookup: async () => ['93.184.216.34'],
    fetchImpl: (async (url: string) => {
      if (!String(url).startsWith('https://html.duckduckgo.com/html/')) throw new Error('unrouted ' + url);
      return page(body);
    }) as any,
  });

  it('a page of "<a" with no ">", of links never closed, or of class marks with no ">" is read in time that grows with its size', async () => {
    // Before, each took seconds (the last, cubic: 7 s for its 21 KB), on the server's one thread.
    for (const body of ['<a '.repeat(40_000), '<a class="result__a" href="https://x.example/">t'.repeat(30_000), '<a class="result__a" '.repeat(1_000)]) {
      const t = performance.now();
      const r = await ddg(body)('o', 'web_search', { query: 'slow results' });
      expect(performance.now() - t, body.slice(0, 40)).toBeLessThan(2000);
      expect(r.text).toBe('No results.');
    }
  });

  it('finds what the two expressions it replaced found, titles, addresses and snippets', async () => {
    const before = (html: string) => {
      const out: Array<{ title: string; url: string; snippet: string }> = [];
      const links = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
      for (let i = 0; i < links.length && out.length < 8; i++) {
        const m = links[i]!;
        const rest = html.slice(m.index! + m[0].length, links[i + 1]?.index ?? html.length);
        const snippet = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(rest)?.[1] ?? '';
        let url = m[1]!.replace(/&amp;/g, '&');
        const uddg = /[?&]uddg=([^&]+)/.exec(url);
        if (uddg) url = decodeURIComponent(uddg[1]!);
        if (url.startsWith('//')) url = `https:${url}`;
        if (/^https?:\/\//.test(url)) out.push({ title: strip(m[2] ?? ''), url, snippet: strip(snippet).slice(0, 300) });
      }
      return out;
    };
    const parts = ['<a', ' ', '>', '</a>', '<a class="result__a" href="https://a.example/one">', '<a rel="nofollow" class="result__a" href="//b.example/two">',
      '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fc.example%2Fthree&amp;rut=x">', '<a href="https://d.example/" class="result__a">', '<a class="result__a">',
      '<abbr class="result__a" href="https://e.example/">', '<a class="result__snippet" href="#">', '<a class="result__snippet">', ' class="result__a"', ' href="https://f.example/"',
      ' href=""', 'class="result__a"', 'Made-up <b>title</b>', 'a snippet &amp; more', '\n', '<div class="result">', '</div>', '<a href="https://g.example/">', 'İ'];
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    let found = 0;
    for (let round = 0; round < 3000; round++) {
      const html = Array.from({ length: 1 + rand(14) }, () => parts[rand(parts.length)]!).join('');
      const want = before(html);
      found += want.length;
      expect(duckDuckGoResults(html), html).toEqual(want);
    }
    expect(found).toBeGreaterThan(300); // the pages held results to find
    // A real page's shape, through the search itself.
    const real = '<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide&amp;rut=made-up">The <b>Guide</b></a></h2>'
      + '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">How to read the <b>guide</b>.</a></div>';
    expect((await ddg(real)('o', 'web_search', { query: 'the guide' })).text).toBe('1. The Guide\n   https://docs.example.com/guide\n   How to read the guide .');
  });
});

describe('a page\'s text (HB-1056)', () => {
  it('takes out what the two expressions it replaced took out, and nothing else', () => {
    const before = (html: string): string => html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
    const parts = ['<', '>', '<>', '<p>', '</p>', '<script', '</script>', '<SCRIPT>', '</Script>', '<style x>', '</style>', '<svg', '</svg>', '<noscript>', '</noscript>', 'text', ' ', '\n', '&amp;lt;', '&nbsp;', 'İ', 'ſcript', '<scripts>', '</script >'];
    let seed = 11;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    for (let round = 0; round < 2000; round++) {
      const html = Array.from({ length: 1 + rand(12) }, () => parts[rand(parts.length)]!).join('');
      expect(strip(html), html).toBe(before(html));
    }
  });
});

describe('read_result connects only to an address it checked (DNS rebinding)', () => {
  it('a name that passed the check but dials loopback is refused, and the local server never sees a request', async () => {
    const http = await import('node:http');
    let hits = 0;
    const srv = http.createServer((_q, s) => { hits++; s.end('secret'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const realFetch = globalThis.fetch;
    // The search provider only (the page itself goes through the pinned GET).
    globalThis.fetch = (async () => new Response(JSON.stringify({ web: { results: [{ title: 't', url: `http://localhost:${port}/` }] } }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      const w = makeOpsWeb({ braveKey: async () => 'k', lookup: async () => ['93.184.216.34'] });
      await w('o', 'web_search', { query: 'rebind me' });
      await expect(w('o', 'read_result', { n: 1 })).rejects.toThrow(/public internet/);
      expect(hits).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      srv.close();
    }
  });
});
