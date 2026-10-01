import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Is this machine on a tailnet, and is Hatchabot already served over HTTPS on
 * it? The setup guide asked people to run `tailscale serve` and work out the
 * address themselves — on a machine that usually already knows both.
 *
 * Every probe is best-effort and short: a missing CLI, a stopped daemon or a
 * slow answer all mean "we cannot tell", never an error the person has to read.
 */
export interface TailnetInfo {
  installed: boolean;
  /** The app is here but no usable command was found — a macOS App Store
   *  install, typically. The path is where its CLI actually lives. */
  appOnly?: boolean;
  cliPath?: string;
  /** Connected, with an address. */
  up?: boolean;
  /** This machine's MagicDNS name, without the trailing dot. */
  dns?: string;
  /** `tailscale serve` is proxying 443 to the port we asked about. */
  serving?: boolean;
  /**
   * The address actually answered. `serving` only says the proxy is
   * configured — it says nothing about whether a certificate was ever issued,
   * which is the usual reason a correctly-served machine still fails in a
   * browser. Only an address that answers is offered as one.
   */
  reachable?: boolean;
  /** Why it did not answer, when it did not. */
  unreachableWhy?: string;
  /** The address to open on a phone, when there is one. */
  url?: string;
}

/**
 * The CLI, on PATH or in the places it hides.
 *
 * The macOS App Store build ships no command on PATH at all: it lives inside
 * the app bundle, and people reasonably report "Tailscale is installed but I
 * have no CLI". Homebrew on Apple Silicon puts it somewhere else again.
 */
const BINS = [
  'tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/tailscale',
  `${process.env.HOME ?? ''}/Applications/Tailscale.app/Contents/MacOS/Tailscale`,
  '/usr/bin/tailscale',
];

/** The Mac app, whether or not its CLI can be found. */
const APP_BUNDLES = [
  '/Applications/Tailscale.app',
  `${process.env.HOME ?? ''}/Applications/Tailscale.app`,
];

function run(bin: string, args: string[], timeoutMs = 4000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? undefined : String(stdout).trim()));
  });
}

async function firstBin(): Promise<string | undefined> {
  // A named binary is the only one used: tests point this at a shim, so no
  // test can ever reach the machine's real Tailscale (HATCHABOT_TAILSCALE_BIN).
  const named = process.env.HATCHABOT_TAILSCALE_BIN?.trim();
  if (named) return (await run(named, ['--version'], 2500)) ? named : undefined;
  for (const b of BINS) {
    if (b.startsWith('/') && !existsSync(b)) continue;
    if (await run(b, ['--version'], 2500)) return b;
  }
  return undefined;
}

/**
 * Every command that CHANGES Tailscale's configuration goes through this
 * file, and under a test runner none of them runs unless the test named its
 * own binary: a test must never touch the machine's real `serve` or `funnel`.
 */
const changesRefusedInTests = (): boolean => !!process.env.VITEST && !process.env.HATCHABOT_TAILSCALE_BIN?.trim();

/**
 * Turn on `tailscale serve` for this port, on the person's behalf.
 *
 * It needs rights the control plane may not have: on Linux the CLI wants root
 * unless the user has been made the operator, and a service running as that
 * user is refused. So this reports the refusal verbatim rather than pretending
 * — the step then shows the command to run by hand, which is where it started.
 */
export async function enableServe(port: number): Promise<{ ok: boolean; error?: string }> {
  if (changesRefusedInTests()) return { ok: false, error: 'Tests never change this machine\'s Tailscale (set HATCHABOT_TAILSCALE_BIN to a shim).' };
  const bin = await firstBin();
  if (!bin) return { ok: false, error: 'The tailscale command is not on this machine.' };
  const out = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    execFile(bin, ['serve', '--bg', `http://localhost:${port}`], { timeout: 20_000, encoding: 'utf8' },
      (err, stdout, stderr) => resolve(err
        ? { ok: false, error: (String(stderr || stdout || err.message).trim().split('\n').slice(0, 4).join(' ').slice(0, 400)) }
        : { ok: true }));
  });
  return out;
}

export async function tailnetInfo(port: number): Promise<TailnetInfo> {
  const bin = await firstBin();
  if (!bin) {
    const app = APP_BUNDLES.find((a) => a && existsSync(a));
    return app
      ? { installed: true, appOnly: true, cliPath: `${app}/Contents/MacOS/Tailscale` }
      : { installed: false };
  }
  const statusRaw = await run(bin, ['status', '--json']);
  let dns: string | undefined;
  let up = false;
  try {
    const st = JSON.parse(statusRaw ?? '{}') as { Self?: { DNSName?: string; TailscaleIPs?: string[] }; BackendState?: string };
    dns = st.Self?.DNSName?.replace(/\.$/, '') || undefined;
    up = st.BackendState === 'Running' && !!st.Self?.TailscaleIPs?.length;
  } catch { /* not connected, or an older CLI */ }
  if (!dns) return { installed: true, up, cliPath: bin };
  // `serve status` prints the proxy table; we only need to know whether 443
  // lands on our port. The JSON shape has changed across releases, so match
  // the port in either form rather than parsing a schema.
  const serveRaw = (await run(bin, ['serve', 'status'])) ?? (await run(bin, ['serve', 'status', '--json'])) ?? '';
  const serving = new RegExp(`(127\\.0\\.0\\.1|localhost):${port}\\b`).test(serveRaw);
  if (!serving) return { installed: true, up, dns, serving: false, cliPath: bin };
  // Ask the address itself. A proxy with no certificate is configured and
  // useless, and saying "reachable at …" about it sends people to a browser
  // error (a Mac, 2026-09-21).
  const probe = await fetch(`https://${dns}/healthz`, { signal: AbortSignal.timeout(6000) })
    .then((r) => ({ ok: r.ok, why: r.ok ? undefined : `answered ${r.status}` }))
    .catch((err: unknown) => ({ ok: false, why: String((err as Error)?.message ?? err).slice(0, 160) }));
  return {
    installed: true, up, dns, serving, cliPath: bin,
    reachable: probe.ok,
    unreachableWhy: probe.ok ? undefined : probe.why,
    url: probe.ok ? `https://${dns}` : undefined,
  };
}

/**
 * Set one line of the .env the service actually reads.
 *
 * It is the operator's file, so the rules are conservative: replace a
 * commented line or a value `replaceable` says may go, append when there is
 * none, refuse to overwrite anything else, and write through a temp file with
 * the original mode kept so a crash cannot leave half a .env.
 */
export async function writeEnvVar(
  envPath: string,
  key: string,
  value: string,
  replaceable: (current: string) => boolean,
  comment?: string,
): Promise<{ ok: boolean; replaced?: boolean; error?: string }> {
  const { readFile, writeFile, rename, stat } = await import('node:fs/promises');
  let body: string;
  try { body = await readFile(envPath, 'utf8'); }
  catch { return { ok: false, error: `No .env at ${envPath}` }; }
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*#?\\s*${key}\\s*=\\s*(.*)$`);
  let lines = body.split('\n');
  let replaced = false;
  // The line that is in force is the LAST uncommented one (systemd and the
  // shell both take the last): write there, and drop earlier live duplicates.
  // Writing the first match changed a commented example while a live line
  // further down kept the old value after a restart (use-case audit, 2026-09-27).
  const live = lines.map((l, i) => (re.test(l) && !/^\s*#/.test(l) ? i : -1)).filter((i) => i >= 0);
  const target = live.length ? live[live.length - 1]! : lines.findIndex((l) => re.test(l));
  if (target >= 0) {
    const current = (re.exec(lines[target] ?? '')?.[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
    const commented = /^\s*#/.test(lines[target] ?? '');
    if (!commented && current && current !== value && !replaceable(current)) {
      return { ok: false, error: `.env already sets ${key}=${current} — change it there if you meant to.` };
    }
    lines[target] = line;
    replaced = true;
    const drop = new Set(live.filter((i) => i !== target));
    lines = lines.filter((_, i) => !drop.has(i));
  }
  if (!replaced) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    if (comment) lines.push(`# ${comment}`);
    lines.push(line);
    lines.push('');
  }
  const tmp = `${envPath}.tmp`;
  const mode = await stat(envPath).then((st) => st.mode & 0o777).catch(() => 0o600);
  await writeFile(tmp, lines.join('\n'), { mode });
  await rename(tmp, envPath);
  return { ok: true, replaced };
}

/** HATCHABOT_PUBLIC_URL: replaces a placeholder or a loopback address, never
 *  an address somebody chose. */
export async function writePublicUrl(
  envPath: string,
  url: string,
): Promise<{ ok: boolean; replaced?: boolean; error?: string }> {
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) return { ok: false, error: 'That does not look like an address to write.' };
  const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;
  return writeEnvVar(envPath, 'HATCHABOT_PUBLIC_URL', url, (cur) => LOOPBACK.test(cur),
    'Written by Hatchabot: the address invite links and the install code use.');
}

// ---- Tailscale Funnel: "Reach it from anywhere" (docs/public-access.md) -----

/** Run one tailscale command and keep everything it said: Funnel's refusals carry the link that fixes them. */
function runFull(bin: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${String(stdout ?? '')}\n${String(stderr ?? '')}`.trim() }));
  });
}

export interface FunnelMissing { what: string; fix: string; link?: string }
export interface FunnelPreflight {
  ok: boolean;
  /** This machine's name on the tailnet: the public address's host. */
  dns?: string;
  missing: FunnelMissing[];
}

const FUNNEL_PORTS = [443, 8443, 10000];
const FUNNEL_DOC = 'https://tailscale.com/kb/1223/funnel';

/**
 * What Funnel needs before it can be turned on (Tailscale's own list:
 * v1.38.3+, MagicDNS, HTTPS certificates, the `funnel` node attribute), read
 * from `tailscale status --json`. Each missing piece comes with where to fix
 * it. A field an older client does not report is not counted as missing: the
 * `funnel` command itself then says what is wrong, with its own link.
 */
export async function funnelPreflight(): Promise<FunnelPreflight> {
  const bin = await firstBin();
  if (!bin) {
    const app = APP_BUNDLES.find((a) => a && existsSync(a));
    return { ok: false, missing: [app
      ? { what: 'The Tailscale app is here, but not its command.', fix: 'Funnel on a Mac needs the open-source Tailscale (brew install tailscale), not the App Store app.', link: FUNNEL_DOC }
      : { what: 'Tailscale is not installed on this machine.', fix: 'Install it and sign in.', link: 'https://tailscale.com/download' }] };
  }
  const missing: FunnelMissing[] = [];
  if (/\.app\/Contents\/MacOS\//.test(bin)) {
    missing.push({ what: 'This is the Mac App Store build of Tailscale.', fix: 'Funnel needs the open-source Tailscale on a Mac (brew install tailscale).', link: FUNNEL_DOC });
  }
  let st: {
    BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[]; Capabilities?: string[]; CapMap?: Record<string, unknown> };
    CurrentTailnet?: { MagicDNSEnabled?: boolean; MagicDNSSuffix?: string }; CertDomains?: string[] | null;
  } = {};
  try { st = JSON.parse((await run(bin, ['status', '--json'])) ?? '{}'); } catch { /* not connected */ }
  const dns = st.Self?.DNSName?.replace(/\.$/, '') || undefined;
  if (st.BackendState !== 'Running' || !st.Self?.TailscaleIPs?.length) {
    missing.push({ what: 'Tailscale is not connected.', fix: 'Run `sudo tailscale up` (or open the Tailscale app) and sign in.' });
    return { ok: false, dns, missing };
  }
  if (st.CurrentTailnet?.MagicDNSEnabled === false || !dns) {
    missing.push({ what: 'MagicDNS is off for your tailnet.', fix: 'Admin console → DNS → Enable MagicDNS.', link: 'https://login.tailscale.com/admin/dns' });
  }
  if (Array.isArray(st.CertDomains) ? st.CertDomains.length === 0 : st.CertDomains === null) {
    missing.push({ what: 'HTTPS certificates are off for your tailnet.', fix: 'Admin console → DNS → HTTPS Certificates → Enable HTTPS.', link: 'https://login.tailscale.com/admin/dns' });
  }
  const caps = [...(st.Self?.Capabilities ?? []), ...Object.keys(st.Self?.CapMap ?? {})];
  const capsKnown = !!st.Self?.Capabilities || !!st.Self?.CapMap;
  if (capsKnown && !caps.some((c) => c === 'funnel' || c === 'https://tailscale.com/cap/funnel')) {
    missing.push({ what: 'This machine is not allowed to use Funnel yet.', fix: 'Add the `funnel` node attribute for it in your tailnet policy (Access controls → nodeAttrs), or run `tailscale funnel` once and follow its link.', link: 'https://login.tailscale.com/admin/acls/file' });
  }
  return { ok: missing.length === 0, dns, missing };
}

export interface FunnelEntry { hostPort: string; port: number; targets: string[] }
export interface FunnelStatus { readable: boolean; entries: FunnelEntry[] }

/** `tailscale funnel status --json`: every host:port the internet can reach, and where each lands on this machine. */
export function parseFunnelStatus(raw: string | undefined): FunnelStatus {
  if (raw === undefined) return { readable: false, entries: [] };
  interface ServeConfig {
    AllowFunnel?: Record<string, boolean>;
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
    TCP?: Record<string, { TCPForward?: string }>;
    /**
     * Sessions started WITHOUT --bg (`tailscale funnel 8080`, the form its own
     * help shows first): each is a whole configuration of its own, kept under
     * its session id for as long as that command runs. Reading only the top
     * level missed exactly the hand-made Funnel safeguard d exists to notice
     * (second review, 2026-10-01).
     */
    Foreground?: Record<string, ServeConfig | null>;
  }
  let cfg: ServeConfig;
  try { cfg = JSON.parse(raw.trim() || '{}') ?? {}; } catch { return { readable: false, entries: [] }; }
  if (typeof cfg !== 'object' || Array.isArray(cfg)) return { readable: false, entries: [] };
  const entries: FunnelEntry[] = [];
  const read = (c: ServeConfig): void => {
    for (const [hostPort, allowed] of Object.entries(c.AllowFunnel ?? {})) {
      if (!allowed) continue;
      const port = Number(hostPort.split(':').pop());
      const targets = Object.values(c.Web?.[hostPort]?.Handlers ?? {}).map((h) => h.Proxy ?? (h.Path ? `path:${h.Path}` : 'text')).filter(Boolean);
      const fwd = c.TCP?.[String(port)]?.TCPForward;
      if (fwd) targets.push(`tcp://${fwd}`);
      entries.push({ hostPort, port, targets });
    }
  };
  read(cfg);
  for (const fg of Object.values(cfg.Foreground ?? {})) if (fg && typeof fg === 'object') read(fg);
  return { readable: true, entries };
}

/** Does a Funnel target land on this local port? */
export function targetsPort(entry: FunnelEntry, localPort: number): boolean {
  // Whatever name this machine is called by (loopback, a LAN or tailnet address, its hostname): the port is what matters.
  return entry.targets.some((t) => new RegExp(`:${localPort}(/|$)`).test(t) || t === String(localPort));
}

export async function funnelStatus(): Promise<FunnelStatus> {
  const bin = await firstBin();
  if (!bin) return { readable: false, entries: [] };
  return parseFunnelStatus(await run(bin, ['funnel', 'status', '--json']));
}

export interface FunnelResult { ok: boolean; error?: string; link?: string; url?: string; command?: string }

/**
 * Point Funnel at the PUBLIC listener: `tailscale funnel --bg --https=<funnelPort>
 * http://127.0.0.1:<localPort>`, then read the configuration back and accept
 * it only if that port, and no other, is what the internet reaches, and it
 * lands on the public listener. `tailscale serve` on 443 (the private tailnet
 * address) is a separate entry and is left alone.
 */
export async function funnelOn(localPort: number, funnelPort: number, privatePort: number): Promise<FunnelResult> {
  if (!FUNNEL_PORTS.includes(funnelPort)) return { ok: false, error: `Funnel listens on ${FUNNEL_PORTS.join(', ')} only.` };
  const command = `tailscale funnel --bg --https=${funnelPort} http://127.0.0.1:${localPort}`;
  if (changesRefusedInTests()) return { ok: false, error: 'Tests never change this machine\'s Tailscale (set HATCHABOT_TAILSCALE_BIN to a shim).', command };
  const bin = await firstBin();
  if (!bin) return { ok: false, error: 'The tailscale command is not on this machine.', command };
  const before = parseFunnelStatus(await run(bin, ['funnel', 'status', '--json']));
  const stray = before.entries.find((e) => targetsPort(e, privatePort));
  if (stray) {
    return { ok: false, command, error: `Funnel already publishes ${stray.hostPort} to the private port ${privatePort}. Turn that off first (tailscale funnel --https=${stray.port} off): internet traffic there is treated as this machine.` };
  }
  const run1 = await runFull(bin, ['funnel', '--bg', `--https=${funnelPort}`, `http://127.0.0.1:${localPort}`]);
  if (!run1.ok) {
    return { ok: false, command, error: run1.out.split('\n').slice(0, 6).join(' ').slice(0, 500) || 'tailscale funnel failed.', link: /https:\/\/\S+/.exec(run1.out)?.[0] };
  }
  const after = parseFunnelStatus(await run(bin, ['funnel', 'status', '--json']));
  const mine = after.entries.find((e) => e.port === funnelPort);
  const wrong = after.entries.find((e) => targetsPort(e, privatePort));
  if (!after.readable || !mine || !targetsPort(mine, localPort) || wrong) {
    // Not what was asked for: take it back rather than leave something half-published.
    await runFull(bin, ['funnel', `--https=${funnelPort}`, 'off']);
    return { ok: false, command, error: !after.readable ? 'Funnel was turned on but its configuration could not be read back, so it was turned off again.' : 'Funnel did not end up pointing at the public listener, so it was turned off again.' };
  }
  const host = mine.hostPort.replace(/:\d+$/, '');
  return { ok: true, command, url: `https://${host}${funnelPort === 443 ? '' : `:${funnelPort}`}` };
}

/** Take the public address down, and confirm from Tailscale's own configuration that nothing reaches the public listener any more. */
export async function funnelOff(localPort: number, funnelPort: number): Promise<FunnelResult> {
  const command = `tailscale funnel --https=${funnelPort} off`;
  if (changesRefusedInTests()) return { ok: false, error: 'Tests never change this machine\'s Tailscale (set HATCHABOT_TAILSCALE_BIN to a shim).', command };
  const bin = await firstBin();
  if (!bin) return { ok: false, error: 'The tailscale command is not on this machine.', command };
  const before = parseFunnelStatus(await run(bin, ['funnel', 'status', '--json']));
  // Every published port that lands on the public listener, whichever port it was made on.
  const ports = new Set<number>([funnelPort, ...before.entries.filter((e) => targetsPort(e, localPort)).map((e) => e.port)]);
  let lastErr = '';
  for (const p of ports) {
    if (before.readable && !before.entries.some((e) => e.port === p)) continue; // nothing there to turn off
    const r = await runFull(bin, ['funnel', `--https=${p}`, 'off']);
    if (!r.ok) lastErr = r.out.split('\n').slice(0, 4).join(' ').slice(0, 400);
  }
  const after = parseFunnelStatus(await run(bin, ['funnel', 'status', '--json']));
  const left = after.entries.find((e) => e.port === funnelPort || targetsPort(e, localPort));
  if (!after.readable) return { ok: false, command, error: lastErr || 'Funnel\'s configuration could not be read back.' };
  if (left) return { ok: false, command, error: lastErr || `Funnel still publishes ${left.hostPort}.` };
  return { ok: true, command };
}

/** Take a setting out of force in .env: its live lines become comments (the file's next tidy lists it with its default). */
export async function unsetEnvVar(envPath: string, key: string): Promise<{ ok: boolean; error?: string }> {
  const { readFile, writeFile, rename, stat } = await import('node:fs/promises');
  let body: string;
  try { body = await readFile(envPath, 'utf8'); }
  catch { return { ok: false, error: `No .env at ${envPath}` }; }
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const lines = body.split('\n').map((l) => (re.test(l) ? `# ${l.trim()}` : l));
  const tmp = `${envPath}.tmp`;
  const mode = await stat(envPath).then((st) => st.mode & 0o777).catch(() => 0o600);
  await writeFile(tmp, lines.join('\n'), { mode });
  await rename(tmp, envPath);
  return { ok: true };
}
