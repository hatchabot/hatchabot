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
  for (const b of BINS) {
    if (b.startsWith('/') && !existsSync(b)) continue;
    if (await run(b, ['--version'], 2500)) return b;
  }
  return undefined;
}

/**
 * Turn on `tailscale serve` for this port, on the person's behalf.
 *
 * It needs rights the control plane may not have: on Linux the CLI wants root
 * unless the user has been made the operator, and a service running as that
 * user is refused. So this reports the refusal verbatim rather than pretending
 * — the step then shows the command to run by hand, which is where it started.
 */
export async function enableServe(port: number): Promise<{ ok: boolean; error?: string }> {
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
 * Write `HATCHABOT_PUBLIC_URL` into the .env the service actually reads.
 *
 * Detection is fine for showing a link, but it depends on a probe succeeding
 * every few minutes; the setting is fixed, survives Tailscale being down when
 * somebody opens an invite, and is what every doc tells people to set. So the
 * app offers to write the line rather than asking them to.
 *
 * Conservative on purpose: it replaces a commented or loopback value, appends
 * when there is none, refuses to overwrite a real address somebody chose, and
 * writes through a temp file so a crash cannot leave a half-written .env.
 */
export async function writePublicUrl(
  envPath: string,
  url: string,
): Promise<{ ok: boolean; replaced?: boolean; error?: string }> {
  const { readFile, writeFile, rename, stat } = await import('node:fs/promises');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) return { ok: false, error: 'That does not look like an address to write.' };
  let body: string;
  try { body = await readFile(envPath, 'utf8'); }
  catch { return { ok: false, error: `No .env at ${envPath}` }; }
  const line = `HATCHABOT_PUBLIC_URL=${url}`;
  const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;
  const lines = body.split('\n');
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*#?\s*HATCHABOT_PUBLIC_URL\s*=\s*(.*)$/.exec(lines[i] ?? '');
    if (!m) continue;
    const current = (m[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
    const commented = /^\s*#/.test(lines[i] ?? '');
    // Somebody's own, working address is not ours to overwrite.
    if (!commented && current && !LOOPBACK.test(current) && current !== url) {
      return { ok: false, error: `.env already sets HATCHABOT_PUBLIC_URL=${current} — change it there if you meant to.` };
    }
    lines[i] = line;
    replaced = true;
    break;
  }
  if (!replaced) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push('# Written by Hatchabot: the address invite links and the install code use.');
    lines.push(line);
    lines.push('');
  }
  const tmp = `${envPath}.tmp`;
  const mode = await stat(envPath).then((st) => st.mode & 0o777).catch(() => 0o600);
  await writeFile(tmp, lines.join('\n'), { mode });
  await rename(tmp, envPath);
  return { ok: true, replaced };
}
