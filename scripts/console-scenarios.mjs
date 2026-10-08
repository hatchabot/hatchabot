#!/usr/bin/env node
/**
 * The console from another device, on a live install (scripts/live.mjs runs
 * it). A real headless Chrome opens a web-only test agent's OpenClaw console
 * at the install's PUBLIC address (HATCHABOT_PUBLIC_URL: HTTPS over the
 * tailnet, as a phone or laptop does), signed in with the owner's CLI token,
 * and checks what broke three times in September and that no request from
 * the machine itself sees: the page is a secure context, the Control UI's app
 * starts, and its live connection to the agent's gateway opens and carries
 * messages. No AI turns.
 *
 *   node scripts/console-scenarios.mjs [--keep] [--signin-key <file>.key]
 *
 * The console's live connection admits a signed-in BROWSER only (its session
 * cookie, checked when the socket opens: consoleSockets.ts); a CLI token on
 * the page's requests cannot carry it. So C2 — the live connection opens and
 * carries messages — runs only with --signin-key: the private key of the
 * install's one-time sign-in links (docs/signin-links.md), from which it mints
 * a five-minute owner link and signs the browser in. Without one it says so
 * and checks C1 only.
 *
 * Chrome runs from the zenika/alpine-chrome image on the host network (it
 * must reach the tailnet address) with its debugging port on loopback; it and
 * the agent ("zz console test") are removed at the end unless --keep.
 */
import { spawnSync } from 'node:child_process';
import { api, cleanupAgents, createAgent, log, scenario, sleep, summary } from './live-lib.mjs';

const PREFIX = 'zz console test';
const keep = process.argv.includes('--keep');
const PUBLIC = (process.env.HATCHABOT_PUBLIC_URL || '').replace(/\/$/, '');
const TOKEN = process.env.HATCHABOT_TOKEN || '';
const PORT = Number(process.env.HATCHABOT_CONSOLE_TEST_PORT || 9333);
const CHROME = `hb-console-test-${process.pid}`;

/** A minimal CDP client over Node's WebSocket: send() and the events seen. */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not reach Chrome')); });
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && waiting.has(msg.id)) { const { res, rej } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; waiting.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
  return { send, events, close: () => ws.close() };
}

const keyArg = (() => { const i = process.argv.indexOf('--signin-key'); return i >= 0 ? process.argv[i + 1] : undefined; })();

async function main() {
  if (!PUBLIC.startsWith('https://')) throw new Error(`HATCHABOT_PUBLIC_URL must be the HTTPS address other devices use (got "${PUBLIC || 'nothing'}").`);
  const existing = (await api('/v1/agents')).json.filter((a) => a.name?.startsWith(PREFIX));
  if (existing.length) throw new Error(`Test agents from an earlier run are still there: ${existing.map((a) => a.name).join(', ')} — delete them first.`);
  const agent = await createAgent(`${PREFIX} agent`);
  const run = spawnSync('docker', ['run', '-d', '--rm', '--name', CHROME, '--network', 'host', '--shm-size=1g', 'zenika/alpine-chrome',
    '--no-sandbox', '--headless', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${PORT}`, 'about:blank'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`could not start Chrome: ${run.stderr}`);
  let target;
  for (let i = 0; i < 30 && !target; i++) {
    await sleep(1000);
    target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => undefined);
  }
  if (!target) throw new Error('Chrome did not open its debugging port');
  const c = await cdp(target.webSocketDebuggerUrl);
  try {
    await c.send('Network.enable');
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    // Signed in as the owner: with a one-time link when a key is given (a real
    // browser session, as on a phone), else the CLI token on its requests.
    if (keyArg) {
      const { signinLink } = await import('./signin-link.mjs');
      const { readFileSync } = await import('node:fs');
      const link = signinLink({ privateKey: readFileSync(keyArg, 'utf8'), url: PUBLIC, owner: true, ttl: 300 });
      await c.send('Page.navigate', { url: link });
      await sleep(5000);
    } else {
      await c.send('Network.setExtraHTTPHeaders', { headers: { authorization: `Bearer ${TOKEN}` } });
    }
    const url = `${PUBLIC}/v1/agents/${agent.id}/ui/chat?session=${encodeURIComponent(`agent:${agent.slug}:main`)}`;
    await c.send('Page.navigate', { url });
    await sleep(25_000);
    const ev = await c.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => { const t = document.body ? document.body.innerText : ''; return { secure: window.isSecureContext, href: location.href, didNotStart: /did not start/i.test(t), approve: /approve this browser/i.test(t), text: t.slice(0, 300), scripts: document.scripts.length }; })()`,
    });
    const page = ev.result.value;
    const sockets = c.events.filter((e) => e.method === 'Network.webSocketCreated').map((e) => e.params);
    const opened = c.events.filter((e) => e.method === 'Network.webSocketHandshakeResponseReceived' && e.params.response.status === 101);
    const frames = c.events.filter((e) => e.method === 'Network.webSocketFrameReceived').length;
    const failed = c.events.filter((e) => e.method === 'Network.loadingFailed' && !e.params.canceled).map((e) => e.params.errorText);
    const errors = c.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.exception?.description?.split('\n')[0] ?? e.params.exceptionDetails?.text);

    await scenario('C1 the console page at the public address: a secure context, and its app starts', async () => [
      [`loaded ${page.href.replace(/^(https:\/\/)[^.]+/, '$1…').slice(0, 90)}`, page.href.startsWith(PUBLIC)],
      ['a secure context (the console refuses to run on plain http)', page.secure === true],
      ['its app started (no "Control UI did not start")', !page.didNotStart && page.scripts > 0, page.text],
      ['no script errors, no failed loads', !errors.length && !failed.length, [...errors, ...failed].join(' | ')],
    ]);
    if (!keyArg) {
      log('(C2 not run — the live connection admits a signed-in browser only; give --signin-key <file>.key to check it. docs/live-tests.md)');
      return;
    }
    await scenario('C2 it connects to the agent: its live connection opens and carries messages', async () => [
      [`a live connection to the agent's gateway (${sockets.length} opened)`, sockets.some((s) => s.url.includes(`/v1/agents/${agent.id}/ui`))],
      ['the connection was accepted (101)', opened.length > 0],
      [`messages flow (${frames} received)`, frames > 0],
      ['no "Approve this browser" wall for the owner', !page.approve, page.text],
    ]);
  } finally {
    c.close();
  }
}

main()
  .catch((err) => log(`✗ ${err.message || err}`))
  .finally(async () => {
    if (!keep) {
      spawnSync('docker', ['rm', '-f', CHROME]);
      await cleanupAgents(PREFIX);
    }
    process.exitCode = summary() ? 0 : 1;
  });
