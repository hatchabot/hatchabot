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
  /** Connected, with an address. */
  up?: boolean;
  /** This machine's MagicDNS name, without the trailing dot. */
  dns?: string;
  /** `tailscale serve` is proxying 443 to the port we asked about. */
  serving?: boolean;
  /** The address to open on a phone, when there is one. */
  url?: string;
}

/** The CLI, on PATH or where the Mac app keeps it. */
const BINS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale'];

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

export async function tailnetInfo(port: number): Promise<TailnetInfo> {
  const bin = await firstBin();
  if (!bin) return { installed: false };
  const statusRaw = await run(bin, ['status', '--json']);
  let dns: string | undefined;
  let up = false;
  try {
    const st = JSON.parse(statusRaw ?? '{}') as { Self?: { DNSName?: string; TailscaleIPs?: string[] }; BackendState?: string };
    dns = st.Self?.DNSName?.replace(/\.$/, '') || undefined;
    up = st.BackendState === 'Running' && !!st.Self?.TailscaleIPs?.length;
  } catch { /* not connected, or an older CLI */ }
  if (!dns) return { installed: true, up };
  // `serve status` prints the proxy table; we only need to know whether 443
  // lands on our port. The JSON shape has changed across releases, so match
  // the port in either form rather than parsing a schema.
  const serveRaw = (await run(bin, ['serve', 'status'])) ?? (await run(bin, ['serve', 'status', '--json'])) ?? '';
  const serving = new RegExp(`(127\\.0\\.0\\.1|localhost):${port}\\b`).test(serveRaw);
  return { installed: true, up, dns, serving, url: serving ? `https://${dns}` : undefined };
}
