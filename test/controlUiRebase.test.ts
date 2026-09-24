import { describe, expect, it } from 'vitest';
import { isControlUiDocument, rebaseControlUi } from '../src/api/controlUiRebase.js';

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
