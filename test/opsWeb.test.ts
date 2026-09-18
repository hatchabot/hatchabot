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
