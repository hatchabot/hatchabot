import { describe, expect, it } from 'vitest';
import { isPrivateAddress, makeOpsWeb } from '../src/ops/opsWeb.js';

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
  it('searches, numbers results, and reads one as text', async () => {
    const { opsWeb } = web({ [SEARCH]: results(['https://docs.example.com/a']), 'https://docs.example.com/a': () => page('<html><script>x()</script><p>Hello <b>world</b></p></html>') });
    const s = await opsWeb('o', 'web_search', { query: 'openclaw release notes' });
    expect(s.text).toMatch(/^1\. T0\n\s+https:\/\/docs\.example\.com\/a\n\s+snip/);
    const r = await opsWeb('o', 'read_result', { n: 1 });
    expect(r.text).toContain('Hello world');
    expect(r.text).not.toContain('x()');
  });

  it('cannot open anything that was not a result, and results are per owner', async () => {
    const { opsWeb, seen } = web({ [SEARCH]: results(['https://docs.example.com/a']) });
    await opsWeb('o', 'web_search', { query: 'something' });
    expect((await opsWeb('o', 'read_result', { n: 2 })).isError).toBe(true);
    expect((await opsWeb('someone-else', 'read_result', { n: 1 })).isError).toBe(true);
    expect((await opsWeb('o', 'read_result', { n: 'https://evil.example/?d=secret' as any })).isError).toBe(true);
    expect(seen.filter((u) => !u.startsWith(SEARCH))).toEqual([]);
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
