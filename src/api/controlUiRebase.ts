import { controlUiHtmlAttributes, controlUiHtmlTags, controlUiScriptInsertionPoint } from './controlUiHtml.js';

/**
 * The Control UI page, moved under the console proxy's prefix.
 *
 * OpenClaw 2026.9 serves its Control UI for the root of the gateway: the page
 * carries `data-openclaw-control-ui-base-path=""` and every asset link is
 * absolute (`/assets/index-….js`, `/favicon.svg?v=…`). Reached through
 * `/v1/agents/<id>/ui/`, those links resolve against Hatchabot's own root,
 * the app bundle never loads, and the page's watchdog reports "Control UI
 * did not start" (one agent, 2026-09-24). 2026.7 wrote relative links
 * (`./assets/…`) and worked untouched.
 *
 * The gateway has a `gateway.controlUi.basePath` setting that would make it
 * write the prefix itself, but that is a per-agent config value the proxy
 * would then have to match version by version. Doing the same rewrite here
 * works for every image without a rebuild: the base-path attribute becomes
 * the proxy prefix (the app builds its config URL, its WebSocket URL and its
 * routes from it, all of which the proxy already forwards), and root-absolute
 * `src`/`href` values get the prefix in front. Inline scripts are untouched,
 * so the page's CSP hashes still match.
 */
export function rebaseControlUi(html: string, prefix: string): string {
  const p = prefix.replace(/\/+$/, '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const edits: Array<{ at: number; text: string }> = [];
  for (const tag of controlUiHtmlTags(html)) {
    if (tag.closing || tag.name === '!doctype') continue;
    for (const attr of controlUiHtmlAttributes(html, tag)) {
      if ((tag.name === 'html' && attr.name === 'data-openclaw-control-ui-base-path' && attr.value === '') ||
          ((attr.name === 'src' || attr.name === 'href') && attr.value?.startsWith('/') && !attr.value.startsWith('//'))) {
        edits.push({ at: attr.start, text: p });
      }
    }
  }
  // Build once; no global replacement can enter JavaScript strings, data-src
  // attributes, comments or another attribute's quoted value.
  let cursor = 0, out = '';
  for (const edit of edits) { out += html.slice(cursor, edit.at) + edit.text; cursor = edit.at; }
  return out + html.slice(cursor);
}

/**
 * Whether a proxied path is the app's document (a route such as `/`, `/chat`
 * or `/sessions`) rather than a file with an extension: only documents are
 * rewritten, so only they are requested uncompressed.
 */
export function isControlUiDocument(path: string): boolean {
  const last = path.split('?')[0]!.split('/').pop() ?? '';
  return !/\.[a-z0-9]{1,12}$/i.test(last);
}

export const TALK_PROXY_SCRIPT_PATH = '/__hatchabot/talk-offer.js';

/** OpenClaw 2026.9.8 resolves its brokered OpenAI SDP offer at the origin's
 * root, ignoring the console base path. Keep that one POST on this agent's
 * authenticated proxy. External providers and every other fetch are left
 * alone. This external script runs only in owner consoles, before their app;
 * it needs no inline CSP exception, credentials, microphone or audio API. */
export const TALK_PROXY_SCRIPT = String.raw`(() => {
  const suffix = '/__hatchabot/talk-offer.js';
  const source = document.currentScript && document.currentScript.src;
  if (!source || typeof window.fetch !== 'function') return;
  const script = new URL(source, window.location.href);
  if (script.origin !== window.location.origin || !script.pathname.endsWith(suffix)) return;
  const prefix = script.pathname.slice(0, -suffix.length);
  if (!/^\/v1\/agents\/[^/]+\/ui$/.test(prefix)) return;
  // OpenClaw 2026.9.8 exposes its retained chat panes in light DOM. Its toggle
  // retires session ownership and local media synchronously before awaiting
  // provider cleanup. Never invoke it on an idle pane: that would start a call.
  window.__hatchabotStopTalk = function() {
    let active = false, stopped = true;
    const pending = [];
    for (const pane of document.querySelectorAll('openclaw-chat-pane')) {
      const state = pane.state;
      if (!state || !(state.realtimeTalkSession || state.realtimeTalkActive)) continue;
      active = true;
      try {
        if (typeof state.toggleRealtimeTalk !== 'function') { stopped = false; continue; }
        pending.push(Promise.resolve(state.toggleRealtimeTalk()));
        if (state.realtimeTalkSession || state.realtimeTalkActive) stopped = false;
      } catch { stopped = false; }
    }
    return { active, stopped, done: Promise.all(pending).then(() => true, () => false) };
  };
  const fetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const request = typeof Request !== 'undefined' && input instanceof Request;
    const method = String(init && init.method !== undefined ? init.method : request ? input.method : 'GET').toUpperCase();
    let url;
    try { url = new URL(request ? input.url : String(input), window.location.href); }
    catch { return fetch(input, init); }
    if (method !== 'POST' || url.origin !== window.location.origin || url.pathname !== '/plugins/openai/realtime/calls') {
      return fetch(input, init);
    }
    url.pathname = prefix + url.pathname;
    return fetch(request ? new Request(url, input) : url.href, init);
  };
})();`;

/** Like the guest view, load before the gateway's app without changing its
 * existing inline scripts (whose hashes appear in its CSP). */
export function withTalkProxy(html: string, prefix: string): string {
  const src = `${prefix.replace(/\/+$/, '')}${TALK_PROXY_SCRIPT_PATH}`
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const tag = `<script src="${src}"></script>`;
  const { at } = controlUiScriptInsertionPoint(html);
  return html.slice(0, at) + tag + (html[at] === '<' && !/^<body\b/i.test(html.slice(at)) ? '\n' : '') + html.slice(at);
}
