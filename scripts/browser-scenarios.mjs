#!/usr/bin/env node
/**
 * An agent's own browser, end to end on a live install (scripts/live.mjs runs
 * it; docs/browser.md). A web-only test agent gets its browser switched on;
 * OpenClaw's browser tool then opens and reads a real page through it. Its
 * isolation is checked (none of the agent's files, its memory limit,
 * listening on the agent's loopback only, out of a neighbour's reach), its
 * settings hold it to the least (no scripts, no private addresses), a
 * page that sends itself to a private address later does not reach it (the
 * fence, HB-0679; the page's script is sent over the DevTools port), it
 * follows an agent restart, and switching it off removes it. The sign-in
 * panel (HB-0680) signs it in to a public demo login page through the app's
 * own routes, and the agent's own tool then sees the signed-in page. No AI turns:
 * the browser is driven with `openclaw browser`.
 *
 *   node scripts/browser-scenarios.mjs [--keep]
 *
 * The agent is "zz browser test …" and is deleted at the end unless --keep.
 * (example.org does not resolve on every network; a real page is used.)
 */
import { spawnSync } from 'node:child_process';
import { api, BASE, cleanupAgents, createAgent, hbt, inAgent, log, requireRoom, scenario, settle, sleep, summary } from './live-lib.mjs';

const PREFIX = 'zz browser test';
const keep = process.argv.includes('--keep');
const PAGE = 'https://www.iana.org/help/example-domains';
const docker = (...a) => { const r = spawnSync('docker', a, { encoding: 'utf8', timeout: 120_000 }); return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }; };
const containerOf = (a) => String(a.runtimeRef || '').replace(/^docker:\/\//, '');

/** Wait until its browser runs (the sweep starts it within a minute of the agent). */
async function browserUp(agent, secs = 150) {
  for (let i = 0; i < secs / 5; i++) {
    const b = (await api(`/v1/agents/${agent.id}/browser`)).json;
    if (b.running) return true;
    await sleep(5000);
  }
  return false;
}
/** OpenClaw's browser tool, through the agent: open the page and read it back. */
async function reads(agent) {
  // Right after a start its OpenClaw may still be coming up: a few tries.
  let last = '';
  for (let i = 0; i < 4; i++) {
    await inAgent(agent, ['openclaw', 'browser', 'open', PAGE], 120_000);
    await sleep(3000);
    const snap = await inAgent(agent, ['openclaw', 'browser', 'snapshot'], 120_000);
    if (/Example Domains/i.test(snap.out)) return { ok: true, out: '' };
    last = snap.out.slice(-300);
    await sleep(10_000);
  }
  return { ok: false, out: last };
}
/** OpenClaw's browser tool is off: its status says so, or refuses with "browser.enabled=false". */
const toolOff = (out) => /"enabled":\s*false|browser\.enabled=false/.test(out);
/** Switch it, and wait for the rebuild that applies it. */
async function setBrowser(agent, on) {
  const r = await api(`/v1/agents/${agent.id}`, { method: 'PATCH', body: { browser: on } });
  if (r.status >= 300) throw new Error(`switch: ${r.status} ${JSON.stringify(r.json)}`);
  await sleep(8000);
  return settle(agent.id, 'RUNNING', 15);
}

/**
 * The person's eyes on the panel's tab: where a field is, what the page says.
 * Read off the DevTools port in the agent's network, outside the panel (the
 * panel has no command that reads a page), as a person reads the screen.
 */
async function eyes(agent, match, expr) {
  const js = `const t = (await (await fetch('http://127.0.0.1:9222/json')).json()).find((x) => x.type === 'page' && x.url.includes(${JSON.stringify(match)}));
if (!t) { console.log('NO TAB'); process.exit(0); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: ${JSON.stringify(expr)}, returnByValue: true } }));
ws.onmessage = (m) => { const r = JSON.parse(m.data); if (r.id !== 1) return; console.log(JSON.stringify(r.result?.result?.value ?? null)); process.exit(0); };`;
  const r = await inAgent(agent, ['node', '--input-type=module', '-e', js], 60_000);
  try { return JSON.parse(r.out.trim().split('\n').at(-1)); } catch { return r.out.trim(); }
}
const pageTabs = async (agent) => (await inAgent(agent, ['node', '-e', "fetch('http://127.0.0.1:9222/json').then((r) => r.json()).then((j) => console.log(j.filter((x) => x.type === 'page').length))"], 60_000)).out.trim();
/** The panel's stream, as the app's page reads it: its events, as they come. */
function panelStream(agent, panel) {
  const seen = { frames: 0, urls: [], notes: [], closed: [] };
  const ctl = new AbortController();
  const done = (async () => {
    const res = await fetch(`${BASE}/v1/agents/${agent.id}/browser/panel/${panel}/stream`, { headers: { authorization: `Bearer ${process.env.HATCHABOT_TOKEN || ''}` }, signal: ctl.signal });
    seen.status = res.status;
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!line.startsWith('data: ')) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.t === 'frame') seen.frames++;
        else if (ev.t === 'url') seen.urls.push(ev.url);
        else if (ev.t === 'note') seen.notes.push(ev.text);
        else if (ev.t === 'closed') seen.closed.push(ev.why);
      }
    }
  })().catch((e) => { seen.error = String(e?.message || e); });
  return { seen, done, stop: () => ctl.abort() };
}

async function main() {
  const existing = (await api('/v1/agents')).json.filter((a) => a.name?.startsWith(PREFIX));
  if (existing.length) throw new Error(`Test agents from an earlier run are still there: ${existing.map((a) => a.name).join(', ')} — delete them first.`);
  await requireRoom(1); // it makes 1 agent at once — say so before making any
  let agent = await createAgent(`${PREFIX} agent`);
  await scenario('B0 off by default: no browser, and the tool is off', async () => {
    const st = await inAgent(agent, ['openclaw', 'browser', 'status', '--json'], 120_000);
    const b = (await api(`/v1/agents/${agent.id}/browser`)).json;
    return [['the agent has no browser', !b.on && !b.running], ['OpenClaw\'s browser tool is off', toolOff(st.out), st.out.slice(0, 200)]];
  });
  await scenario('B1 switched on: its browser starts, and the agent opens and reads a real page with it', async () => {
    agent = await setBrowser(agent, true);
    const up = await browserUp(agent);
    const r = up ? await reads(agent) : { ok: false, out: '' };
    return [['its browser is running', up], ['it opened and read the page', r.ok, r.out]];
  });
  await scenario('B2 isolated: none of the agent\'s files, its own memory limit, listening on the agent\'s loopback only, unreachable from a neighbour', async () => {
    const name = `${containerOf(agent)}-browser`;
    const files = docker('exec', name, 'ls', '/home/node/.openclaw');
    const mem = docker('inspect', name, '--format', '{{.HostConfig.Memory}}').out.trim();
    const net = docker('inspect', name, '--format', '{{.HostConfig.NetworkMode}}').out.trim();
    const agentId = docker('inspect', containerOf(agent), '--format', '{{.Id}}').out.trim();
    // The machine's own 127.0.0.1:9222 is not the agent's (it lives in the
    // agent's network namespace), so curling it proved nothing (review,
    // 2026-10-09). Two real checks instead: what the namespace listens on
    // for 9222 (0x2406) — loopback only — and a neighbour on the agent's
    // docker network, as another agent is, trying the agent's address.
    const listen = docker('exec', name, 'cat', '/proc/net/tcp', '/proc/net/tcp6').out.split('\n')
      .map((l) => l.trim().split(/\s+/)).filter((f) => /:2406$/.test(f[1] ?? '') && f[3] === '0A').map((f) => f[1].split(':')[0]);
    const loopbackOnly = listen.length > 0 && listen.every((a) => a === '0100007F' || a === '00000000000000000000000001000000');
    const [agentNet, agentIp] = docker('inspect', containerOf(agent), '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{"\\n"}}{{end}}').out.trim().split('\n')[0]?.split(' ') ?? [];
    const image = docker('inspect', containerOf(agent), '--format', '{{.Config.Image}}').out.trim();
    const probe = agentNet && agentIp
      ? docker('run', '--rm', '--network', agentNet, '--entrypoint', 'node', image, '-e',
        `fetch('http://${agentIp}:9222/json/version', { signal: AbortSignal.timeout(4000) }).then((r) => r.text()).then((t) => console.log('ANSWERED ' + t.slice(0, 200)), (e) => console.log('NO ANSWER ' + (e.cause?.code || e.name)))`)
      : { code: -1, out: 'the agent has no network address' };
    return [
      ['the agent\'s files are not in it', files.code !== 0],
      [`its memory limit (${mem} bytes)`, Number(mem) === 1024 ** 3],
      ['it lives in the agent\'s network', net === `container:${containerOf(agent)}` || net === `container:${agentId}`, net],
      [`it listens on the agent's loopback only (${listen.join(', ') || 'nothing on 9222'})`, loopbackOnly],
      [`a neighbour on ${agentNet || '?'} cannot reach it at ${agentIp || '?'}:9222`, probe.code === 0 && /NO ANSWER/.test(probe.out) && !/webSocketDebuggerUrl/.test(probe.out), probe.out.slice(-300)],
    ];
  });
  await scenario('B2b held to the least: no script evaluation, no private addresses, idle tabs closed', async () => {
    // What configWriter writes with the browser on (HB-0674), as OpenClaw holds and enforces it;
    // private addresses are OpenClaw's own rule with browser.ssrfPolicy unset.
    const cfg = await inAgent(agent, ['openclaw', 'config', 'get', 'browser'], 120_000);
    const evalTry = await inAgent(agent, ['openclaw', 'browser', 'evaluate', '--fn', '() => 1 + 1'], 120_000);
    // Twice at most: a gateway that is reloading its settings answers with a banner, not a refusal.
    const refused = async (url) => {
      let r = await inAgent(agent, ['openclaw', 'browser', 'open', url], 120_000);
      if (!/blocked by policy/i.test(r.out)) { await sleep(15_000); r = await inAgent(agent, ['openclaw', 'browser', 'open', url], 120_000); }
      return r;
    };
    const lan = await refused('http://192.168.0.1/');
    const own = await refused('http://127.0.0.1:9222/json/version');
    return [
      ['script evaluation is off in its settings', /"evaluateEnabled":\s*false/.test(cfg.out), cfg.out.slice(0, 300)],
      ['a script is refused', /evaluate is disabled|"ok":\s*false/.test(evalTry.out) && !/^\s*2\s*$/m.test(evalTry.out), evalTry.out.slice(-200)],
      ['idle tabs are closed (its setting)', /"tabCleanup":\s*\{\s*"enabled":\s*true/.test(cfg.out)],
      ['browser.ssrfPolicy is left unset (written, no site with a name opens)', !/"ssrfPolicy"/.test(cfg.out)],
      ['a LAN address is refused', /blocked by policy/i.test(lan.out), lan.out.slice(-200)],
      ['its own control port is refused as a page', /blocked by policy/i.test(own.out), own.out.slice(-200)],
    ];
  });
  await scenario('B2c fenced: a page that sends itself to a private address later does not reach it; the agent itself still does (HB-0679)', async () => {
    // OpenClaw guards page loads only while an action runs: a page's timer
    // sent the tab to a LAN address afterwards, and the request went out
    // (2026-11-12). The fence holds the browser's own user off private
    // addresses. A listener in the agent's namespace, as the agent's user
    // (the agents' network lets no neighbour in), stands in for a device: on
    // loopback (the agent's own ports) and on the agent's private address.
    const c = containerOf(agent);
    const uid = docker('exec', `${c}-browser`, 'id', '-u').out.trim();
    const [, ip] = docker('inspect', c, '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{"\\n"}}{{end}}').out.trim().split('\n')[0]?.split(' ') ?? [];
    const port = 39000 + Math.floor(Math.random() * 900);
    docker('exec', '-d', c, 'node', '-e', `const h = []; require('node:http').createServer((q, s) => {
      if (q.url === '/hits') return s.end(JSON.stringify(h));
      h.push(q.url); s.setHeader('content-type', 'text/html'); s.end('<h1>a private device</h1>');
    }).listen(${port}, '0.0.0.0');`);
    await sleep(2000);
    const targets = { loopback: `http://127.0.0.1:${port}`, 'own address': `http://${ip}:${port}` };
    const fetchAll = (paths) => inAgent(agent, ['node', '--input-type=module', '-e',
      `for (const u of ${JSON.stringify(paths)}) console.log(u, await fetch(u).then((r) => r.status, (e) => 'failed ' + (e.cause?.code || e.name)));`], 60_000);
    const agentItself = await fetchAll(Object.values(targets).map((t) => `${t}/agent-itself`));
    // What the page's own script does (it is not the agent's: evaluate is off), sent over the DevTools port.
    const inject = (id, url) => inAgent(agent, ['node', '--input-type=module', '-e', `
      const t = (await (await fetch('http://127.0.0.1:9222/json')).json()).find((x) => x.type === 'page' && x.id === ${JSON.stringify(id)});
      if (!t) { console.log('no tab'); process.exit(1); }
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: ${JSON.stringify(`setTimeout(() => { location.href = ${JSON.stringify(url)}; }, 2000); 'set'`)} } }));
      ws.onmessage = (m) => { if (JSON.parse(m.data).id === 1) { console.log('set'); ws.close(); } };`], 60_000);
    const injected = [];
    for (const t of Object.values(targets)) {
      // The tab it opens: `open` prints its DevTools id.
      const opened = await inAgent(agent, ['openclaw', 'browser', 'open', PAGE], 120_000);
      const id = /^id:\s*([0-9A-F]{16,})\s*$/m.exec(opened.out)?.[1] ?? '';
      await sleep(3000);
      injected.push((await inject(id, `${t}/late-navigation`)).out.trim());
      await sleep(6000);
    }
    const hits = (await inAgent(agent, ['node', '-e', `fetch('${targets.loopback}/hits').then((r) => r.text()).then(console.log)`], 60_000)).out;
    return [
      [`Chromium runs as its own user (${uid || '?'}), not the agent's`, uid === '1001'],
      ['the agent itself reaches both (so the listener was there to reach)', /agent-itself 200[\s\S]*agent-itself 200/.test(agentItself.out) && (hits.match(/agent-itself/g) ?? []).length === 2, `${agentItself.out} ${hits}`.slice(-300)],
      ['the page\'s late navigations were sent', injected.every((o) => /^set$/m.test(o)), injected.join(' | ').slice(-300)],
      ['neither reached it: loopback, nor the agent\'s private address', /agent-itself/.test(hits) && !/late-navigation/.test(hits), hits.slice(-300)],
    ];
  });
  await scenario('B2d sign in to a site yourself: the panel signs it in on a demo login page, and the agent carries on signed in (HB-0680)', async () => {
    // A public demo site with published test credentials (the-internet.herokuapp.com):
    // nobody's account. Clicks, text and Enter through the app's own routes, as the app's page sends them.
    const SITE = 'https://the-internet.herokuapp.com';
    const before = await pageTabs(agent);
    const open = await api(`/v1/agents/${agent.id}/browser/panel`, { method: 'POST', body: { w: 1000, h: 700, url: `${SITE}/login` } });
    const panel = open.json.panel;
    const stream = panel ? panelStream(agent, panel) : undefined;
    const input = (ops) => api(`/v1/agents/${agent.id}/browser/panel/${panel}/input`, { method: 'POST', body: { ops } });
    const until = async (f, secs = 30) => { for (let i = 0; i < secs * 2; i++) { if (f()) return true; await sleep(500); } return false; };
    const loaded = stream ? await until(() => stream.seen.frames > 0 && stream.seen.urls.some((u) => u.endsWith('/login'))) : false;
    const click = async (sel) => {
      const p = await eyes(agent, 'the-internet', `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      return input([{ k: 'mouse', type: 'move', ...p }, { k: 'mouse', type: 'down', ...p }, { k: 'mouse', type: 'up', ...p }]);
    };
    if (loaded) {
      await click('#username'); await input([{ k: 'text', text: 'tomsmith' }]);
      await click('#password'); await input([{ k: 'text', text: 'SuperSecretPassword!' }, { k: 'key', key: 'Enter' }]);
    }
    const signedIn = loaded && await until(() => stream.seen.urls.at(-1)?.endsWith('/secure'));
    const says = signedIn ? String(await eyes(agent, 'the-internet', 'document.querySelector("#flash")?.innerText || ""')) : '';
    const refused = panel ? await input([{ k: 'go', url: 'javascript:alert(1)' }]) : { status: 0 };
    // The agent's own tool, in a tab of its own, on the members-only page.
    let agentSees = '';
    if (signedIn) {
      await inAgent(agent, ['openclaw', 'browser', 'open', `${SITE}/secure`], 120_000);
      await sleep(3000);
      agentSees = (await inAgent(agent, ['openclaw', 'browser', 'snapshot'], 120_000)).out;
    }
    const closed = panel ? await api(`/v1/agents/${agent.id}/browser/panel/${panel}`, { method: 'DELETE' }) : { status: 0 };
    if (stream) { await Promise.race([stream.done, sleep(10_000)]); stream.stop(); }
    await sleep(2000);
    const after = await pageTabs(agent);
    return [
      ['opened through the app (owner, on this machine)', open.status === 201 && !!panel, JSON.stringify(open.json).slice(0, 200)],
      ['its stream shows the page: frames and the address', loaded, JSON.stringify(stream?.seen ?? {}).slice(0, 300)],
      ['signed in with clicks, text and Enter alone', signedIn && /secure area/i.test(says), `${stream?.seen.urls.at(-1)} ${says}`.slice(0, 200)],
      ['an address that is not http(s) is refused', refused.status === 400, String(refused.status)],
      ['the agent\'s own browser tool then sees the members-only page', /Secure Area/.test(agentSees) && !/You must login/.test(agentSees), agentSees.slice(-300)],
      ['closed: its stream says so, and its tab is gone', closed.status === 204 && stream?.seen.closed.at(-1) === 'Closed.' && Number(after) <= Number(before) + 1, `closed ${JSON.stringify(stream?.seen.closed)}; page tabs ${before} → ${after} (the agent's own tab may stay)`],
    ];
  });
  await scenario('B3 the agent restarts: its browser follows, and still works', async () => {
    const before = docker('inspect', `${containerOf(agent)}-browser`, '--format', '{{.Id}}').out.trim();
    const s = hbt(['stop', agent.name, '--wait']), t = hbt(['start', agent.name, '--wait']);
    agent = await settle(agent.id, 'RUNNING', 10);
    const up = await browserUp(agent);
    const after = docker('inspect', `${containerOf(agent)}-browser`, '--format', '{{.Id}}').out.trim();
    const r = up ? await reads(agent) : { ok: false, out: '' };
    return [
      ['stopped and started', s.code === 0 && t.code === 0, `${s.out} ${t.out}`.slice(-200)],
      ['a new browser, in its new network', up && !!after && after !== before],
      ['it still opens and reads the page', r.ok, r.out],
    ];
  });
  await scenario('B4 switched off: its browser is gone and the tool is off', async () => {
    agent = await setBrowser(agent, false);
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) { gone = docker('inspect', `${containerOf(agent)}-browser`).code !== 0; if (!gone) await sleep(5000); }
    const st = await inAgent(agent, ['openclaw', 'browser', 'status', '--json'], 120_000);
    return [['its browser container is gone', gone], ['OpenClaw\'s browser tool is off', toolOff(st.out), st.out.slice(0, 200)]];
  });
}

main()
  .catch((err) => log(`✗ ${err.message || err}`))
  .finally(async () => {
    if (!keep) await cleanupAgents(PREFIX);
    process.exitCode = summary() ? 0 : 1;
  });
