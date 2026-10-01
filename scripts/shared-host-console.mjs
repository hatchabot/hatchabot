#!/usr/bin/env node
// The OpenClaw console under rootless Docker, in a real browser — run by
// scripts/shared-host-test.sh as a TENANT inside its VM, after that tenant's
// agent (Helper) is RUNNING. Node 22, no packages: it speaks the Chrome
// DevTools Protocol over Node's own WebSocket to a headless Chrome running in
// the tenant's own rootless Docker.
//
//  1. the OWNER's console for Helper opens through Hatchabot's proxy, renders,
//     connects (hello ok, owner scopes), lists sessions and gets a reply;
//  2. a web-chat GUEST (a second account, let in with a web chat invite) opens
//     OpenClaw's chat through the proxy, gets a reply in their own session,
//     sees only their own sessions, and is refused the owner's conversation,
//     an owner-only RPC and owner-only pages;
//  3. turning the guest's web chat off closes their open console and the
//     console refuses them afterwards.
//
// Also (2026-09-30): the guest's name reaches the gateway when they are let
// in, so their first open is in on the first try and the owner's open console
// is not dropped by it; and the guest's sidebar shows no owner pages and the
// composer does not claim "Full Access".
//
// The browser reaches this tenant's Hatchabot the way its containers do, at
// 10.0.2.2:<port>, but opens it as http://localhost:<port> — a forwarder in the
// browser's own network namespace — because the Control UI needs a secure
// context (WebCrypto) and a plain http:// address off loopback is not one
// (headless Chrome ignores --unsafely-treat-insecure-origin-as-secure in its
// renderers). Each check prints `CHECK ok|fail <text>`; everything else is the
// log. Screenshots land in $HB_OUT (default: $HOME).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';

const HOME = process.env.HOME;
const cfg = Object.fromEntries(
  (existsSync(`${HOME}/.config/hatchabot/env`) ? readFileSync(`${HOME}/.config/hatchabot/env`, 'utf8') : '')
    .split('\n').map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]),
);
const B = (process.env.HB_URL || cfg.HATCHABOT_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const PORT = Number(new URL(B).port || 80);
/** Where the browser opens Hatchabot: loopback in its own namespace, forwarded to 10.0.2.2 (HB_HOST_ALIAS). */
const BROWSER_BASE = `http://localhost:${PORT}`;
const HOST_ALIAS = process.env.HB_HOST_ALIAS || '10.0.2.2';
const AGENT = process.env.HB_AGENT || 'Helper';
const IMAGE = process.env.HB_BROWSER_IMAGE || 'chromedp/headless-shell:latest';
const CDP_PORT = Number(process.env.HB_CDP_PORT || 9222);
const OUT = process.env.HB_OUT || HOME;
const OWNER_USER = process.env.HB_OWNER || 'owner';
const GUEST_USER = process.env.HB_GUEST || 'guest';
const BROWSER = `hb-console-browser-${process.getuid?.() ?? 'x'}`;
process.env.DOCKER_HOST ||= `unix://${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`}/docker.sock`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a);
let failed = 0;
const check = (good, text) => { if (!good) failed++; console.log(`CHECK ${good ? 'ok' : 'fail'} ${text}`); return good; };
const short = (x, n = 300) => { const s = typeof x === 'string' ? x : JSON.stringify(x); return (s ?? '').replace(/\s+/g, ' ').slice(0, n); };

// ---- Hatchabot's own API ----------------------------------------------------
async function api(path, { method = 'GET', body, cookie, bearer } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${B}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  const set = res.headers.getSetCookie?.() ?? [];
  const session = set.map((c) => /^(hatchabot_session=[^;]+)/.exec(c)?.[1]).find(Boolean);
  return { status: res.status, json, text, session };
}
const secret = (file) => {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const pw = `hb-${randomBytes(12).toString('base64url')}`;
  writeFileSync(file, pw, { mode: 0o600 });
  return pw;
};

/** The owner's browser session: a password chosen through the claim link the bed saved, or (an older kept VM) a reset. */
async function ownerSession() {
  const pwFile = `${HOME}/.hb-owner-pw`;
  if (existsSync(pwFile)) {
    const r = await api('/v1/login', { method: 'POST', body: { username: OWNER_USER, password: readFileSync(pwFile, 'utf8').trim() } });
    if (r.session) return r.session;
    log(`owner login with the saved password: ${r.status} ${short(r.text, 120)}`);
  }
  const claimFile = `${HOME}/.hb-owner-claim`;
  if (existsSync(claimFile)) {
    const code = readFileSync(claimFile, 'utf8').trim();
    const pw = `hb-${randomBytes(12).toString('base64url')}`;
    const r = await api('/v1/local-accounts/claim', { method: 'POST', body: { code, password: pw } });
    if (r.status === 200 && r.session) { writeFileSync(pwFile, pw, { mode: 0o600 }); spawnSync('rm', ['-f', claimFile]); return r.session; }
    log(`owner claim: ${r.status} ${short(r.text, 120)}`);
  }
  // No password and no claim link: set one from the machine (as `hbt accounts reset-password` does) —
  // that revokes the CLI token, so mint a new one with the session and hand it to the CLI.
  const pw = `hb-${randomBytes(12).toString('base64url')}`;
  const rp = spawnSync('bash', ['-ic', `hbt accounts reset-password ${OWNER_USER} '${pw}'`], { encoding: 'utf8' });
  log(`owner password reset from the machine: ${short((rp.stdout || '') + (rp.stderr || ''), 160)}`);
  const r = await api('/v1/login', { method: 'POST', body: { username: OWNER_USER, password: pw } });
  if (!r.session) return undefined;
  writeFileSync(pwFile, pw, { mode: 0o600 });
  const t = await api('/v1/cli-tokens', { method: 'POST', cookie: r.session, body: { label: 'shared-host test' } });
  if (t.json?.token) spawnSync('bash', ['-ic', `hatchabot login --token ${t.json.token} --url ${B}`], { encoding: 'utf8' });
  return r.session;
}

// ---- the browser -----------------------------------------------------------
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 600_000 });

class CDP {
  #ws; #id = 0; #pending = new Map(); listeners = [];
  constructor(url) { this.url = url; }
  open() {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(this.url);
      this.#ws.onopen = () => resolve();
      this.#ws.onerror = () => reject(new Error(`could not reach the browser at ${this.url}`));
      this.#ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id && this.#pending.has(m.id)) {
          const p = this.#pending.get(m.id); this.#pending.delete(m.id);
          if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result);
        } else for (const l of this.listeners) l(m);
      };
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 90_000) {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      setTimeout(() => { if (this.#pending.delete(id)) reject(new Error(`${method} timed out`)); }, timeoutMs).unref();
    });
  }
  close() { try { this.#ws.close(); } catch { /* gone */ } }
}

/** A page in its own browser context (its own cookie jar), signed in with `session`. */
async function openPage(cdp, who, session) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  await cdp.send('Storage.setCookies', {
    browserContextId,
    cookies: [{ name: 'hatchabot_session', value: session.split('=').slice(1).join('='), url: `${BROWSER_BASE}/`, httpOnly: true, sameSite: 'Strict' }],
  });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p, t) => cdp.send(m, p, sessionId, t);
  const page = { who, s, targetId, sockets: [], errors: [], closed: 0, refusals: 0 };
  cdp.listeners.push((m) => {
    if (m.sessionId !== sessionId) return;
    const p = m.params ?? {};
    if (m.method === 'Runtime.exceptionThrown') page.errors.push(short(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text, 200));
    if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') page.errors.push(short((p.args ?? []).map((a) => a.value ?? a.description).join(' '), 200));
    if (m.method === 'Network.webSocketCreated') page.sockets.push({ url: p.url, id: p.requestId });
    if (m.method === 'Network.webSocketHandshakeResponseReceived') log(`[${who}] websocket handshake ${p.response?.status} ${p.response?.statusText ?? ''}`);
    if (m.method === 'Network.webSocketClosed') { page.closed++; log(`[${who}] websocket closed`); }
    if (m.method === 'Network.webSocketFrameReceived' && /AUTH_UNAUTHORIZED/.test(p.response?.payloadData ?? '')) { page.refusals++; log(`[${who}] the gateway refused the connection (AUTH_UNAUTHORIZED)`); }
    if (m.method === 'Network.responseReceived' && p.type === 'Document') { page.docStatus = p.response?.status; log(`[${who}] document ${p.response?.status} ${short(p.response?.url, 140)}`); }
  });
  await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable');
  await s('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  return page;
}

async function evaluate(page, expression, timeoutMs = 60_000) {
  const r = await page.s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs }, timeoutMs + 5000);
  if (r.exceptionDetails) throw new Error(short(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text, 300));
  return r.result?.value;
}

/** What the Control UI says about itself: its gateway connection (openclaw-app's context), and whether it drew anything. */
const STATE = `(() => {
  const a = document.querySelector('openclaw-app');
  const g = a && a.context && a.context.gateway && a.context.gateway.snapshot;
  const hello = g && g.hello;
  const root = a && (a.shadowRoot || a);
  return {
    secure: window.isSecureContext, title: document.title, app: !!a, drawn: root ? root.innerHTML.length : 0,
    phase: g ? g.phase : null,
    error: g && g.lastError ? String(g.lastError.message || g.lastError) : null, code: g ? g.lastErrorCode || null : null,
    scopes: hello && hello.auth ? hello.auth.scopes || null : null, role: hello && hello.auth ? hello.auth.role || null : null,
    methods: hello && hello.features && Array.isArray(hello.features.methods) ? hello.features.methods : null,
    sessionKey: g ? g.sessionKey || null : null,
  };
})()`;
/** One gateway call over the page's own connection (the one the UI opened through the proxy). */
const rpc = (method, params) => `(async () => {
  const g = document.querySelector('openclaw-app').context.gateway.snapshot;
  try { return { ok: true, r: await g.client.request(${JSON.stringify(method)}, ${JSON.stringify(params)}) }; }
  catch (e) { return { ok: false, code: (e && (e.code || (e.details && e.details.code) || e.name)) || null, msg: String((e && e.message) || e) }; }
})()`;
/** An HTTP request from the page (same origin, its cookie). */
const pageFetch = (path, method = 'GET') => `fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, credentials: 'same-origin' }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 200) }), (e) => ({ status: 0, body: String(e) }))`;

async function waitConnected(page, ms = 150_000) {
  const until = Date.now() + ms;
  let st, last = '';
  while (Date.now() < until) {
    try { st = await evaluate(page, STATE, 10_000); } catch (e) { st = { evalError: e.message }; }
    const sig = `${st?.phase}|${st?.code}|${st?.error}`;
    if (sig !== last) { log(`[${page.who}] phase=${st?.phase} secure=${st?.secure} drawn=${st?.drawn}${st?.error ? ` error=${short(st.error, 160)}` : ''}${st?.code ? ` code=${st.code}` : ''}`); last = sig; }
    if (st?.phase === 'connected') return st;
    await sleep(1500);
  }
  return st;
}

async function screenshot(page, name) {
  try {
    const { data } = await page.s('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
    log(`[${page.who}] screenshot ${OUT}/${name}.png`);
  } catch (e) { log(`[${page.who}] no screenshot: ${e.message}`); }
}

const textOf = (m) => {
  const c = m?.content ?? m?.text ?? m?.message;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join(' ');
  return JSON.stringify(c ?? '');
};
/** Send one message over the page's connection and wait for the assistant's answer containing `word`. */
async function chatTurn(page, sessionKey, word) {
  const before = await evaluate(page, rpc('chat.history', { sessionKey, limit: 50 }));
  const n = before?.ok ? (before.r?.messages ?? []).length : 0;
  const sent = await evaluate(page, rpc('chat.send', { sessionKey, message: `Reply with the single word ${word} and nothing else.`, deliver: false, idempotencyKey: randomUUID() }));
  if (!sent?.ok) return { ok: false, why: `chat.send refused: ${sent?.code} ${short(sent?.msg, 200)}` };
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const h = await evaluate(page, rpc('chat.history', { sessionKey, limit: 50 }));
    if (!h?.ok) return { ok: false, why: `chat.history: ${h?.code} ${short(h?.msg, 200)}` };
    const msgs = h.r?.messages ?? [];
    const fresh = msgs.slice(Math.max(0, Math.min(n, msgs.length - 2)));
    const answer = fresh.filter((m) => m?.role === 'assistant').map(textOf).find((t) => new RegExp(word, 'i').test(t));
    if (answer) return { ok: true, answer: short(answer, 80) };
  }
  return { ok: false, why: 'no answer within 4 minutes' };
}
const sessionKeys = (res) => (res?.r?.sessions ?? []).map((x) => x?.key).filter(Boolean);
/** What the page shows a person: the sidebar's page links and the composer's permission label (light and shadow DOM). */
const VIEW = `(() => {
  const all = []; const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document);
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  return {
    links: all.filter((el) => el.matches('a[href]')).map(txt).filter(Boolean),
    permission: all.filter((el) => el.matches('.chat-controls__permission-trigger')).map(txt),
  };
})()`;

// ---- the run ---------------------------------------------------------------
async function main() {
  const owner = await ownerSession();
  if (!check(!!owner, `the owner signs in with a password (session cookie for the browser)`)) return;
  const list = await api('/v1/agents', { cookie: owner });
  const agent = (Array.isArray(list.json) ? list.json : list.json?.agents ?? []).find((a) => a.name === AGENT);
  if (!check(agent?.state === 'RUNNING', `${AGENT} is RUNNING (${agent?.state ?? 'missing'})`)) return;
  const slug = agent.slug || AGENT.toLowerCase();
  const mainKey = `agent:${slug}:main`;
  const access = await api(`/v1/agents/${agent.id}/console/access`, { cookie: owner });
  log(`owner console/access: ${access.status} ${short(access.json)}`);
  check(access.json?.role === 'owner' && access.json?.console === 'identity', `the owner's console is the console with identities (console/access: ${access.json?.console}${access.json?.reason ? ` — ${access.json.reason}` : ''})`);

  // The browser, in this tenant's rootless Docker.
  docker('rm', '-f', BROWSER);
  if (docker('image', 'inspect', IMAGE).status !== 0) {
    const p = docker('pull', '-q', IMAGE);
    log(`pull ${IMAGE}: ${short(p.stdout || p.stderr, 160)}`);
  }
  // The image's own run.sh forwards DevTools (9222 → Chrome's 9223) with socat; one more socat puts
  // this tenant's Hatchabot on the browser's localhost.
  const run = docker('run', '-d', '--rm', '--name', BROWSER, '--shm-size=1g', '--memory=1500m',
    '-p', `127.0.0.1:${CDP_PORT}:9222`, '--entrypoint', 'bash', IMAGE, '-c',
    `socat TCP4-LISTEN:${PORT},bind=127.0.0.1,fork,reuseaddr TCP4:${HOST_ALIAS}:${PORT} & exec /headless-shell/run.sh --user-data-dir=/tmp/hb-chrome --window-size=1400,900 --lang=en-US`);
  if (!check(run.status === 0, `headless Chrome runs in the tenant's rootless Docker (${IMAGE})`)) { log(short(run.stderr, 300)); return; }
  let version;
  for (let i = 0; i < 40 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch { await sleep(750); }
  }
  if (!check(!!version?.webSocketDebuggerUrl, `the browser's DevTools answer (${version?.Browser ?? 'none'})`)) return;
  const cdp = new CDP(version.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${CDP_PORT}`));
  await cdp.open();
  try {
    // 1. The owner.
    const op = await openPage(cdp, 'owner', owner);
    const ownerUrl = `${BROWSER_BASE}/v1/agents/${agent.id}/ui/chat?session=${encodeURIComponent(mainKey)}`;
    await op.s('Page.navigate', { url: ownerUrl });
    const os = await waitConnected(op);
    await screenshot(op, 'console-owner');
    check(op.docStatus === 200 && os?.app && os?.drawn > 0, `owner: the Control UI loads through the proxy and renders (document ${op.docStatus}, ${os?.drawn ?? 0} chars drawn, title "${os?.title ?? ''}")`);
    check(os?.secure === true, `owner: the page is a secure context in the browser (WebCrypto available)`);
    check(os?.phase === 'connected', `owner: the console connects over the proxied WebSocket (hello ok)${os?.phase === 'connected' ? '' : ` — phase ${os?.phase}, ${short(os?.error, 160)} ${os?.code ?? ''}`}`);
    if (os?.phase !== 'connected') { log(`owner page errors: ${short(op.errors, 800)}`); return; }
    check((os.scopes ?? []).includes('operator.admin'), `owner: the gateway knows the owner (scopes ${short(os.scopes, 80)})`);
    const ot = await chatTurn(op, mainKey, 'kumquat');
    check(ot.ok, `owner: a message from the console gets a reply in ${mainKey}${ot.ok ? ` ("${ot.answer}")` : ` — ${ot.why}`}`);
    const ol = await evaluate(op, rpc('sessions.list', { limit: 100, includeGlobal: true }));
    const okeys = sessionKeys(ol);
    check(ol?.ok && okeys.includes(mainKey), `owner: sessions are listed, the main one among them (${okeys.length} session${okeys.length === 1 ? '' : 's'})${ol?.ok ? '' : ` — ${ol?.code} ${short(ol?.msg, 160)}`}`);

    // 2. A web-chat guest: a second account, let in by a web chat invite.
    const gpw = secret(`${HOME}/.hb-guest-pw`);
    let gl = await api('/v1/login', { method: 'POST', body: { username: GUEST_USER, password: gpw } });
    if (!gl.session) {
      const made = await api('/v1/local-accounts', { method: 'POST', cookie: owner, body: { username: GUEST_USER, password: gpw, displayName: 'Guest' } });
      if (made.status === 409) {
        // A kept VM whose guest password file went missing: the host owner resets it.
        const accts = await api('/v1/local-accounts', { cookie: owner });
        const g = (accts.json ?? []).find((a) => a.username === GUEST_USER);
        if (g) await api(`/v1/local-accounts/${g.id}/password`, { method: 'POST', cookie: owner, body: { password: gpw } });
      } else log(`guest account: ${made.status} ${short(made.text, 160)}`);
      gl = await api('/v1/login', { method: 'POST', body: { username: GUEST_USER, password: gpw } });
    }
    if (!check(!!gl.session, `a second account (${GUEST_USER}) signs in on this tenant`)) return;
    const guest = gl.session;
    const guestId = gl.json?.id;
    const inv = await api(`/v1/agents/${agent.id}/invites`, { method: 'POST', cookie: owner, body: { webChat: true } });
    const join = inv.json?.code ? await api('/v1/join', { method: 'POST', cookie: guest, body: { code: inv.json.code, name: 'Guest' } }) : inv;
    log(`web chat invite ${inv.status}; join ${join.status} ${short(join.json ?? join.text, 160)}`);
    let joined = join.status === 201 && join.json?.webChat === true;
    let how = 'redeemed a web chat invite';
    if (!joined) {
      // Already a member (a kept VM): the members list's web chat switch.
      const on = await api(`/v1/agents/${agent.id}/members/${guestId}/web-chat`, { method: 'PUT', cookie: owner, body: { on: true } });
      joined = on.status === 200 && on.json?.webChat === true; how = `already a member; web chat switched on (${on.status})`;
    }
    if (!check(joined, `guest: given web chat on ${AGENT} (${how})`)) return;
    const gacc = await api(`/v1/agents/${agent.id}/console/access`, { cookie: guest });
    // Letting them in may have dropped the owner's console once (a new list of names reloads the
    // gateway's auth); that is over before they open theirs, which must drop nobody.
    await waitConnected(op); await sleep(1500);
    const ownerSockets = op.sockets.length, ownerClosed = op.closed;
    log(`guest console/access: ${gacc.status} ${short(gacc.json)}`);
    const guestKey = gacc.json?.session;
    if (!check(gacc.json?.role === 'guest' && gacc.json?.console === 'identity' && /^agent:[^:]+:guest:/.test(guestKey ?? ''), `guest: offered OpenClaw's own chat (console/access: ${gacc.json?.console}${gacc.json?.reason ? ` — ${gacc.json.reason}` : ''})`)) return;

    const gp = await openPage(cdp, 'guest', guest);
    await gp.s('Page.navigate', { url: `${BROWSER_BASE}/v1/agents/${agent.id}/ui/chat?session=${encodeURIComponent(guestKey)}` });
    const gs = await waitConnected(gp);
    await sleep(10_000); // a reload, if their open caused one, lands within this
    await screenshot(gp, 'console-guest');
    check(gp.refusals === 0 && gp.closed === 0 && gp.sockets.length === 1, `guest: in on the first try, never dropped (${gp.sockets.length} socket${gp.sockets.length === 1 ? '' : 's'}, ${gp.refusals} refused, ${gp.closed} closed)`);
    check(op.closed === ownerClosed && op.sockets.length === ownerSockets, `owner: their open console is not dropped when the guest first opens (${op.closed - ownerClosed} closed, ${op.sockets.length - ownerSockets} reopened)`);
    const gview = await evaluate(gp, VIEW);
    const ownerPages = ['Agents', 'Dashboards', 'Systems', 'Automations', 'Plugins'].filter((x) => gview.links.includes(x));
    check(ownerPages.length === 0, `guest: the sidebar shows no owner pages${ownerPages.length ? ` — shows ${ownerPages.join(', ')}` : ''}`);
    check(gview.permission.length > 0 && !gview.permission.some((x) => /full access/i.test(x)), `guest: the composer does not claim Full Access (${short(gview.permission, 80)})`);
    check(gp.docStatus === 200 && gs?.app && gs?.drawn > 0, `guest: OpenClaw's chat loads through the proxy and renders (document ${gp.docStatus}, ${gs?.drawn ?? 0} chars drawn)`);
    check(gs?.phase === 'connected', `guest: the chat connects through the guest filter (hello ok)${gs?.phase === 'connected' ? '' : ` — phase ${gs?.phase}, ${short(gs?.error, 160)} ${gs?.code ?? ''}`}`);
    if (gs?.phase !== 'connected') { log(`guest page errors: ${short(gp.errors, 800)}`); return; }
    const gscopes = gs.scopes ?? [];
    check(!gscopes.includes('operator.admin') && !(gs.methods ?? []).some((m) => /^(config|logs|users\.list|cron|automations)/.test(m)),
      `guest: no admin scope, owner methods not advertised (scopes ${short(gscopes, 60)}; ${gs.methods?.length ?? '?'} methods)`);
    const gt = await chatTurn(gp, guestKey, 'pelican');
    check(gt.ok, `guest: a message in their own conversation gets a reply${gt.ok ? ` ("${gt.answer}")` : ` — ${gt.why}`}`);
    const glist = await evaluate(gp, rpc('sessions.list', { limit: 100, includeGlobal: true }));
    const gkeys = sessionKeys(glist);
    log(`guest sessions.list: ${short(gkeys, 400)}`);
    check(glist?.ok && gkeys.length > 0 && gkeys.every((k) => k === guestKey) && !gkeys.includes(mainKey),
      `guest: sees only their own session (${gkeys.length} listed, owner's ${mainKey} not among them)${glist?.ok ? '' : ` — ${glist?.code} ${short(glist?.msg, 160)}`}`);
    const gh = await evaluate(gp, rpc('chat.history', { sessionKey: mainKey, limit: 5 }));
    check(!gh?.ok, `guest: the owner's conversation is refused (chat.history on ${mainKey}: ${gh?.ok ? `ANSWERED with ${(gh.r?.messages ?? []).length} messages` : short(`${gh?.code} ${gh?.msg}`, 120)})`);
    const gc = await evaluate(gp, rpc('config.get', {}));
    check(!gc?.ok && /not available to guests/i.test(gc?.msg ?? ''), `guest: an owner-only RPC is refused by the proxy (config.get: ${gc?.ok ? 'ANSWERED' : short(`${gc?.code} ${gc?.msg}`, 120)})`);
    const gpage = await evaluate(gp, pageFetch(`/v1/agents/${agent.id}/ui/config`));
    const ginvoke = await evaluate(gp, pageFetch(`/v1/agents/${agent.id}/ui/tools/invoke`, 'POST'));
    check(gpage?.status === 403 && ginvoke?.status === 403, `guest: owner-only pages are refused (GET /config ${gpage?.status}, POST /tools/invoke ${ginvoke?.status})`);
    const ol2 = await evaluate(op, rpc('sessions.list', { limit: 100, includeGlobal: true }));
    check(sessionKeys(ol2).includes(guestKey), `owner: sees the guest's conversation in their own console`);

    // 3. Web chat off: the open console closes, and the console refuses them from then on.
    const off = await api(`/v1/agents/${agent.id}/members/${guestId}/web-chat`, { method: 'PUT', cookie: owner, body: { on: false } });
    let after;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      try { after = await evaluate(gp, STATE, 10_000); } catch (e) { after = { phase: `eval error ${e.message}` }; }
      if (after?.phase !== 'connected') break;
    }
    const acc2 = await api(`/v1/agents/${agent.id}/console/access`, { cookie: guest });
    const ui2 = await api(`/v1/agents/${agent.id}/ui/`, { cookie: guest });
    const rpc2 = after?.phase === 'connected' ? await evaluate(gp, rpc('sessions.list', {})) : undefined;
    check(off.status === 200 && after?.phase !== 'connected' && acc2.status === 404 && ui2.status === 404,
      `guest: web chat turned off — their open console disconnects (phase ${after?.phase}${rpc2 ? `, sessions.list ${rpc2.ok ? 'still answered' : 'refused'}` : ''}) and the console answers ${ui2.status}`);
    if (gp.errors.length) log(`guest page errors: ${short(gp.errors, 600)}`);
    if (op.errors.length) log(`owner page errors: ${short(op.errors, 600)}`);
  } finally {
    cdp.close();
    docker('rm', '-f', BROWSER);
  }
}

main().catch((e) => { check(false, `console check crashed: ${short(e?.stack ?? e, 400)}`); })
  .finally(() => { docker('rm', '-f', BROWSER); console.log(`CONSOLE ${failed ? 'failed' : 'passed'}`); process.exit(0); });
