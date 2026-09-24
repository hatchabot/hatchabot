/**
 * The Control UI page, moved under the console proxy's prefix.
 *
 * OpenClaw 2026.9 serves its Control UI for the root of the gateway: the page
 * carries `data-openclaw-control-ui-base-path=""` and every asset link is
 * absolute (`/assets/index-….js`, `/favicon.svg?v=…`). Reached through
 * `/v1/agents/<id>/ui/`, those links resolve against Hatchabot's own root,
 * the app bundle never loads, and the page's watchdog reports "Control UI
 * did not start" (Cooking Teacher, 2026-09-24). 2026.7 wrote relative links
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
  const p = prefix.replace(/\/+$/, '');
  return html
    .replace(/(<html\b[^>]*?\sdata-openclaw-control-ui-base-path=)""/i, `$1"${p}"`)
    // `="/x"` but not `="//host"` (protocol-relative) — those are not ours.
    .replace(/\b(src|href)="\/(?!\/)/g, `$1="${p}/`);
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
