import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in for the `tailscale` command, for tests: a script in a temp
 * directory that keeps its "configuration" in files beside it and logs every
 * call. Tests name it with HATCHABOT_TAILSCALE_BIN, which makes it the ONLY
 * binary src/ops/tailnet.ts will run, so no test can reach this machine's
 * real Tailscale.
 */
export interface Shim {
  dir: string;
  bin: string;
  /** Every invocation, as its argument list. */
  calls(): string[][];
  /** Tailscale's serve/funnel configuration as the shim holds it. */
  config(): { AllowFunnel?: Record<string, boolean>; Web?: Record<string, { Handlers: Record<string, { Proxy: string }> }>; TCP?: Record<string, unknown> };
  setConfig(cfg: unknown): void;
  setStatus(patch: Record<string, unknown>): void;
  /** Make `funnel --bg …` fail with this output (Tailscale's own refusal, with its link). */
  failFunnel(message: string | null): void;
  /** Make `funnel … off` fail. */
  failOff(on: boolean): void;
  cleanup(): void;
}

export const SHIM_DNS = 'box.example.com';

const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const dir = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\n');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
const write = (f, v) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v));
if (args[0] === '--version') { console.log('1.80.0'); process.exit(0); }
if (args[0] === 'status') { console.log(JSON.stringify(read('status.json', {}))); process.exit(0); }
if (args[0] === 'serve' && args[1] === 'status') { console.log('No serve config'); process.exit(0); }
if (args[0] === 'funnel' && args[1] === 'status') { console.log(JSON.stringify(read('serve.json', {}))); process.exit(0); }
if (args[0] === 'funnel') {
  const https = (args.find((a) => a.startsWith('--https=')) || '--https=443').split('=')[1];
  const dns = (read('status.json', {}).Self || {}).DNSName.replace(/\.$/, '');
  const hp = dns + ':' + https;
  const cfg = read('serve.json', {});
  if (args.includes('off')) {
    if (fs.existsSync(path.join(dir, 'fail-off'))) { console.error('error: access denied: serve config denied'); process.exit(1); }
    if (cfg.AllowFunnel) delete cfg.AllowFunnel[hp];
    if (cfg.Web) delete cfg.Web[hp];
    if (cfg.TCP) delete cfg.TCP[https];
    write('serve.json', cfg); process.exit(0);
  }
  if (fs.existsSync(path.join(dir, 'fail-funnel'))) { console.error(fs.readFileSync(path.join(dir, 'fail-funnel'), 'utf8')); process.exit(1); }
  const target = args[args.length - 1];
  cfg.TCP = { ...(cfg.TCP || {}), [https]: { HTTPS: true } };
  cfg.Web = { ...(cfg.Web || {}), [hp]: { Handlers: { '/': { Proxy: target } } } };
  cfg.AllowFunnel = { ...(cfg.AllowFunnel || {}), [hp]: true };
  write('serve.json', cfg);
  console.log('Available on the internet:\nhttps://' + hp + '/');
  process.exit(0);
}
console.error('shim: unexpected ' + args.join(' ')); process.exit(2);
`;

export function tailscaleShim(): Shim {
  const dir = mkdtempSync(join(tmpdir(), 'hb-tailscale-shim-'));
  const bin = join(dir, 'tailscale');
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  const status = {
    BackendState: 'Running',
    Self: { DNSName: `${SHIM_DNS}.`, TailscaleIPs: ['100.64.0.1'], CapMap: { funnel: null, 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': null } },
    CurrentTailnet: { MagicDNSEnabled: true, MagicDNSSuffix: 'example.com' },
    CertDomains: [SHIM_DNS],
  };
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
  writeFileSync(join(dir, 'serve.json'), '{}');
  const read = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as T; } catch { return d; } };
  return {
    dir, bin,
    calls: () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []),
    config: () => read('serve.json', {}),
    setConfig: (cfg) => writeFileSync(join(dir, 'serve.json'), JSON.stringify(cfg)),
    setStatus: (patch) => writeFileSync(join(dir, 'status.json'), JSON.stringify({ ...read('status.json', {}), ...patch })),
    failFunnel: (message) => { if (message === null) rmSync(join(dir, 'fail-funnel'), { force: true }); else writeFileSync(join(dir, 'fail-funnel'), message); },
    failOff: (on) => { if (on) writeFileSync(join(dir, 'fail-off'), '1'); else rmSync(join(dir, 'fail-off'), { force: true }); },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
