import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { isControlUiDocument, rebaseControlUi, TALK_PROXY_SCRIPT, TALK_PROXY_SCRIPT_PATH, withTalkProxy } from '../src/api/controlUiRebase.js';

describe('rebaseControlUi', () => {
  const P = '/v1/agents/abc/ui';
  it('fills an empty base path and prefixes root-absolute links', () => {
    const out = rebaseControlUi('<html data-openclaw-control-ui-base-path="" lang="en"><a href="/x">' +
      '<script src="/assets/a.js"></script><link href="/favicon.svg?v=1">', P);
    expect(out).toContain('data-openclaw-control-ui-base-path="/v1/agents/abc/ui"');
    expect(out).toContain('href="/v1/agents/abc/ui/x"');
    expect(out).toContain('src="/v1/agents/abc/ui/assets/a.js"');
    expect(out).toContain('href="/v1/agents/abc/ui/favicon.svg?v=1"');
  });
  it('leaves a base path the gateway set, relative links and other origins alone', () => {
    const src = '<html data-openclaw-control-ui-base-path="/own"><script src="./assets/a.js"></script>' +
      '<link href="https://fonts.googleapis.com/x"><link href="//cdn/x"><a href="#top">';
    expect(rebaseControlUi(src, P)).toBe(src);
  });
  it('a 2026.7 page (relative links, no attribute) is unchanged', () => {
    const src = '<html lang="en"><script type="module" src="./assets/index.js"></script>';
    expect(rebaseControlUi(src, P)).toBe(src);
  });
  it('tolerates a trailing slash on the prefix', () => {
    expect(rebaseControlUi('<a href="/x">', `${P}/`)).toBe('<a href="/v1/agents/abc/ui/x">');
  });
});

describe('isControlUiDocument', () => {
  it('routes are documents, files are not', () => {
    for (const p of ['/', '/chat', '/sessions', '/chat?session=agent:a:main', '/agents/a.b/overview']) expect(isControlUiDocument(p), p).toBe(true);
    for (const p of ['/assets/index-abc.js', '/favicon.svg?v=1', '/manifest.webmanifest', '/control-ui-config.json', '/sw.js']) expect(isControlUiDocument(p), p).toBe(false);
  });
});

describe('owner Talk offer proxy', () => {
  const origin = 'https://box.example.test';
  const prefix = '/v1/agents/agent-one/ui';
  const target = '/plugins/openai/realtime/calls';
  type TalkState = { realtimeTalkSession?: object | null; realtimeTalkActive?: boolean; toggleRealtimeTalk?: () => unknown };
  function browser(source = origin + prefix + TALK_PROXY_SCRIPT_PATH, states: TalkState[] = []) {
    const calls: Array<{ input: Request | string | URL; init?: RequestInit }> = [];
    const result = Promise.resolve(new Response('synthetic SDP answer'));
    const nativeFetch = (input: Request | string | URL, init?: RequestInit) => { calls.push({ input, init }); return result; };
    const window = { fetch: nativeFetch, location: new URL(origin + prefix + '/chat'), __hatchabotStopTalk: undefined as undefined | (() => { active: boolean; stopped: boolean; done: Promise<boolean> }) };
    runInNewContext(TALK_PROXY_SCRIPT, { window, document: { currentScript: { src: source }, querySelectorAll: (selector: string) => { expect(selector).toBe('openclaw-chat-pane'); return states.map(state => ({ state })); } }, URL, Request });
    return { window, calls, result, nativeFetch };
  }

  it('loads externally before the app without altering CSP-hashed inline scripts', () => {
    const page = '<html><head><script>window.boot = true;</script><script type="module" src="/bundle.js"></script></head></html>';
    const tag = `<script src="${prefix}${TALK_PROXY_SCRIPT_PATH}"></script>`;
    expect(withTalkProxy(page, prefix + '/')).toBe(page.replace('<script>', tag + '\n<script>'));
    expect(withTalkProxy('<head></head><body></body>', prefix)).toContain(tag + '\n</head>');
    expect(withTalkProxy('<body></body>', prefix)).toBe(tag + '<body></body>');
  });

  it('escapes the script source as an HTML attribute', () => {
    expect(withTalkProxy('<head></head>', '/x"<&')).toContain('src="/x&quot;&lt;&amp;/__hatchabot/talk-offer.js"');
  });

  it('retires active and starting Talk synchronously using the pinned controller, without starting idle panes', async () => {
    let starts = 0, stops = 0;
    const idle = { realtimeTalkActive: false, toggleRealtimeTalk: () => { starts++; } };
    const active: TalkState = { realtimeTalkSession: {} };
    const starting: TalkState = { realtimeTalkActive: true };
    for (const state of [active, starting]) state.toggleRealtimeTalk = () => { stops++; state.realtimeTalkSession = null; state.realtimeTalkActive = false; return Promise.resolve(); };
    const result = browser(undefined, [idle, active, starting]).window.__hatchabotStopTalk!();
    expect(stops).toBe(2); expect(starts).toBe(0);
    expect(result.active).toBe(true); expect(result.stopped).toBe(true); expect(await result.done).toBe(true);
    expect(await browser(undefined, [idle]).window.__hatchabotStopTalk!().done).toBe(true);
    expect(starts).toBe(0);
  });

  it.each(['missing', 'throws', 'does-not-retire', 'rejects'])('reports %s retirement so the parent can unload just that frame', async (failure) => {
    const state: TalkState = { realtimeTalkActive: true };
    if (failure !== 'missing') state.toggleRealtimeTalk = () => {
      if (failure === 'throws') throw new Error('synthetic stop failure');
      if (failure === 'rejects') { state.realtimeTalkActive = false; return Promise.reject(new Error('synthetic async failure')); }
    };
    const result = browser(undefined, [state]).window.__hatchabotStopTalk!();
    expect(result.active).toBe(true);
    expect(result.stopped).toBe(failure === 'rejects');
    expect(await result.done).toBe(failure !== 'rejects');
  });

  it.each(['relative', 'absolute', 'URL'])('routes a %s offer to its own agent preserving all request options', async (kind) => {
    const b = browser();
    const controller = new AbortController();
    const init = { method: 'POST', body: 'v=0\r\nsynthetic offer\r\n', headers: { Authorization: 'Bearer synthetic-reservation', 'Content-Type': 'application/sdp' }, signal: controller.signal };
    const input = kind === 'relative' ? target + '?trial=1' : kind === 'absolute' ? origin + target + '?trial=1' : new URL(origin + target + '?trial=1');
    expect(b.window.fetch(input, init)).toBe(b.result);
    expect(b.calls).toEqual([{ input: origin + prefix + target + '?trial=1', init }]);
    expect(b.calls[0]!.init).toBe(init);
    expect(b.calls[0]!.init!.signal).toBe(controller.signal);
  });

  it('keeps Request bodies, headers and abort behavior when changing the URL', async () => {
    const b = browser(), controller = new AbortController();
    const request = new Request(origin + target, { method: 'POST', body: 'synthetic SDP', headers: { 'Content-Type': 'application/sdp', Authorization: 'Bearer synthetic-reservation' }, signal: controller.signal });
    const init = { credentials: 'same-origin' as const };
    await b.window.fetch(request, init);
    const sent = b.calls[0]!.input as Request;
    expect(sent.url).toBe(origin + prefix + target);
    expect(sent.method).toBe('POST');
    expect([...sent.headers]).toEqual([...request.headers]);
    expect(await sent.text()).toBe('synthetic SDP');
    expect(b.calls[0]!.init).toBe(init);
    controller.abort();
    expect(sent.signal.aborted).toBe(true);
  });

  it.each([
    ['GET', target], ['DELETE', target], ['POST', target + '/elsewhere'],
    ['POST', '/plugins/another/calls'], ['POST', prefix + target],
    ['POST', 'https://provider.example.test' + target], ['POST', '//provider.example.test' + target],
    ['POST', 'http://box.example.test' + target], ['POST', 'https://box.example.test:8443' + target],
  ])('leaves %s %s unchanged', async (method, url) => {
    const b = browser(), init = { method };
    await b.window.fetch(url, init);
    expect(b.calls).toEqual([{ input: url, init }]);
  });

  it('honors an init method overriding a Request method', async () => {
    const b = browser();
    const request = new Request(origin + target, { method: 'GET' });
    await b.window.fetch(request, { method: 'POST', body: 'offer' });
    expect((b.calls[0]!.input as Request).url).toBe(origin + prefix + target);
    await b.window.fetch(new Request(origin + target, { method: 'POST' }), { method: 'GET' });
    expect((b.calls[1]!.input as Request).url).toBe(origin + target);
  });

  it.each(['', 'https://other.example.test' + prefix + TALK_PROXY_SCRIPT_PATH, origin + '/other' + TALK_PROXY_SCRIPT_PATH])('does not install for an unrelated script URL %s', (src) => {
    const b = browser(src);
    expect(b.window.fetch).toBe(b.nativeFetch);
  });
});
