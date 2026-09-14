// `hatchabot doctor`: one command that says what's wrong with an installation
// and how to fix it. The probes gather facts (docker, node, service, disk…);
// `doctorReport` turns them into ✓/⚠/✗ lines — pure, so it's tested without
// a machine.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultBackupsDir, defaultDbPath } from './envCompat.js';

export interface DoctorFacts {
  nodeVersion: string;
  dockerCli: boolean;
  dockerDaemon: { ok: boolean; arch?: string; version?: string; error?: string };
  runtimeImage?: { openclawVersion?: string; sizeGb?: number };
  envFile: { present: boolean; secretKey: boolean; password: boolean; authMode: string; publicUrl?: string };
  db: { path: string; present: boolean; sizeMb?: number };
  service: { manager: 'systemd' | 'launchd' | 'none'; active?: boolean; enabled?: boolean };
  controlPlane: { url: string; ok: boolean; version?: string; error?: string };
  diskFreeGb?: number;
  backups: { dir: string; lastSet?: string; ageDays?: number };
  tailscale?: { installed: boolean; up?: boolean; dns?: string };
  containers?: { running: number; total: number };
}

export interface DoctorLine { level: 'ok' | 'warn' | 'fail'; text: string; fix?: string }

export function doctorReport(f: DoctorFacts): DoctorLine[] {
  const out: DoctorLine[] = [];
  const major = Number(f.nodeVersion.replace(/^v/, '').split('.')[0]);
  out.push(major >= 22 ? { level: 'ok', text: `Node ${f.nodeVersion}` } : { level: 'fail', text: `Node ${f.nodeVersion} — 22+ required`, fix: 'Install Node 22 (https://nodejs.org) and re-run ./scripts/restart.sh' });
  if (!f.dockerCli) out.push({ level: 'fail', text: 'Docker is not installed', fix: 'https://docs.docker.com/engine/install/ (Linux) or Docker Desktop (macOS)' });
  else if (!f.dockerDaemon.ok) out.push({ level: 'fail', text: `Docker is installed but not reachable${f.dockerDaemon.error ? ` (${f.dockerDaemon.error})` : ''}`, fix: 'Start Docker; on Linux add yourself to the docker group: sudo usermod -aG docker $USER, then log out and in' });
  else out.push({ level: 'ok', text: `Docker ${f.dockerDaemon.version ?? ''} (${f.dockerDaemon.arch ?? '?'})` });
  if (f.dockerDaemon.ok) {
    if (!f.runtimeImage) out.push({ level: 'fail', text: 'Runtime image hatchabot-runtime:latest is missing — agents cannot start', fix: './scripts/build-runtime-image.sh (pulls the published image, builds only if that fails)' });
    else out.push({ level: 'ok', text: `Runtime image: OpenClaw ${f.runtimeImage.openclawVersion ?? '?'}${f.runtimeImage.sizeGb ? ` · ${f.runtimeImage.sizeGb.toFixed(1)} GB` : ''}` });
    if (f.containers) out.push({ level: 'ok', text: `Agent containers: ${f.containers.running} running of ${f.containers.total}` });
  }
  if (!f.envFile.present) out.push({ level: 'fail', text: '.env is missing', fix: './scripts/setup-host.sh writes it (secret key, password, port)' });
  else {
    if (!f.envFile.secretKey) out.push({ level: 'fail', text: '.env has no HATCHABOT_SECRET_KEY — credentials cannot be stored', fix: 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" → HATCHABOT_SECRET_KEY=… in .env' });
    if (f.envFile.authMode !== 'identity' && !f.envFile.password) out.push({ level: 'warn', text: 'No app password set — the web app is open to anyone who can reach the port', fix: 'HATCHABOT_PASSWORD=… in .env (setup-host.sh asks for one)' });
    if (!f.envFile.publicUrl) out.push({ level: 'warn', text: 'HATCHABOT_PUBLIC_URL not set — invite links and OAuth redirects use localhost', fix: 'Set it to the address others use (with Tailscale: https://<machine>.<tailnet>.ts.net)' });
    else out.push({ level: 'ok', text: `Public URL ${f.envFile.publicUrl}` });
  }
  out.push(f.db.present ? { level: 'ok', text: `Database ${f.db.path}${f.db.sizeMb !== undefined ? ` (${f.db.sizeMb.toFixed(1)} MB)` : ''}` } : { level: 'warn', text: `Database not created yet at ${f.db.path}`, fix: 'It appears on first start' });
  if (f.service.manager === 'none') out.push({ level: 'warn', text: 'No background service installed — Hatchabot will not start with the machine', fix: './scripts/install-service.sh' });
  else if (!f.service.active) out.push({ level: 'fail', text: `Service is installed (${f.service.manager}) but not running`, fix: f.service.manager === 'systemd' ? 'systemctl --user start hatchabot; journalctl --user -u hatchabot -n 50' : './scripts/restart.sh' });
  else out.push({ level: f.service.enabled === false ? 'warn' : 'ok', text: `Service running (${f.service.manager})${f.service.enabled === false ? ' — but not enabled at boot' : ''}`, ...(f.service.enabled === false ? { fix: 'systemctl --user enable hatchabot' } : {}) });
  out.push(f.controlPlane.ok ? { level: 'ok', text: `Control plane answering at ${f.controlPlane.url}${f.controlPlane.version ? ` (v${f.controlPlane.version})` : ''}` } : { level: 'fail', text: `Control plane not answering at ${f.controlPlane.url}${f.controlPlane.error ? ` (${f.controlPlane.error})` : ''}`, fix: 'journalctl --user -u hatchabot -n 50 (Linux) · ./scripts/restart.sh' });
  if (f.diskFreeGb !== undefined) out.push(f.diskFreeGb < 10 ? { level: f.diskFreeGb < 3 ? 'fail' : 'warn', text: `Only ${f.diskFreeGb.toFixed(1)} GB free — each agent volume grows; the image is ~2 GB`, fix: 'docker system prune; remove old backup sets; move backups to a NAS (HATCHABOT_BACKUP_DIR)' } : { level: 'ok', text: `${f.diskFreeGb.toFixed(0)} GB free` });
  if (!f.backups.lastSet) out.push({ level: 'warn', text: `No backup set in ${f.backups.dir} yet`, fix: 'systemctl --user start hatchabot-backup (or wait for 03:30); scripts/restore-drill.sh proves a set restores' });
  else if ((f.backups.ageDays ?? 0) > 2) out.push({ level: 'warn', text: `Last backup set is ${f.backups.ageDays} days old (${f.backups.lastSet})`, fix: 'journalctl --user -u hatchabot-backup -n 30' });
  else out.push({ level: 'ok', text: `Backups: last set ${f.backups.lastSet}` });
  if (f.tailscale) out.push(!f.tailscale.installed ? { level: 'warn', text: 'Tailscale not installed — the app is reachable on your LAN only', fix: 'docs/tailscale.md — private access from anywhere, nothing opened to the internet' } : f.tailscale.up ? { level: 'ok', text: `Tailscale up${f.tailscale.dns ? ` (${f.tailscale.dns})` : ''}` } : { level: 'warn', text: 'Tailscale installed but not connected', fix: 'sudo tailscale up' });
  return out;
}

function sh(cmd: string, args: string[], timeout = 8000): string | undefined {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
}
function envMap(file: string): Record<string, string> {
  const m: Record<string, string> = {};
  try { for (const l of readFileSync(file, 'utf8').split('\n')) { const t = l.trim(); if (!t || t.startsWith('#') || !t.includes('=')) continue; m[t.slice(0, t.indexOf('=')).replace(/^AGENTCLAW_/, 'HATCHABOT_')] = t.slice(t.indexOf('=') + 1).replace(/^['"]|['"]$/g, ''); } } catch { /* absent */ }
  return m;
}

/** Probe this machine. `url` is where the control plane should answer. */
export async function gatherFacts(urlIn: string): Promise<DoctorFacts> {
  let url = urlIn;
  const env = envMap('.env');
  // A TLS install answers on https; the caller's default URL is plain http.
  if (env.HATCHABOT_TLS_CERT && /^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) url = url.replace(/^http:/, 'https:');
  const dockerCli = !!sh('docker', ['--version']);
  const info = dockerCli ? sh('docker', ['version', '--format', '{{.Server.Version}}|{{.Server.Arch}}']) : undefined;
  const dockerDaemon = info ? { ok: true, version: info.split('|')[0], arch: info.split('|')[1] } : { ok: false, error: dockerCli ? 'daemon not reachable' : undefined };
  let runtimeImage: DoctorFacts['runtimeImage'];
  if (dockerDaemon.ok) {
    const img = sh('docker', ['image', 'inspect', '--format', '{{ index .Config.Labels "org.agentclaw.openclaw-version" }}|{{.Size}}', process.env.HATCHABOT_IMAGE ?? env.HATCHABOT_IMAGE ?? 'hatchabot-runtime:latest']);
    if (img) runtimeImage = { openclawVersion: img.split('|')[0] || undefined, sizeGb: Number(img.split('|')[1]) / 1e9 };
  }
  const prefix = process.env.HATCHABOT_PREFIX ?? env.HATCHABOT_PREFIX ?? 'hatchabot';
  const ps = dockerDaemon.ok ? sh('docker', ['ps', '-a', '--format', '{{.Names}}|{{.State}}']) : undefined;
  const rows = (ps ?? '').split('\n').filter((l) => l.startsWith(`${prefix}-`) || l.startsWith('agentclaw-'));
  const dbPath = process.env.HATCHABOT_DB ?? env.HATCHABOT_DB ?? defaultDbPath();
  const service: DoctorFacts['service'] = process.platform === 'darwin'
    ? { manager: existsSync(join(homedir(), 'Library/LaunchAgents/com.hatchabot.control-plane.plist')) || existsSync(join(homedir(), 'Library/LaunchAgents/com.agentclaw.control-plane.plist')) ? 'launchd' : 'none', active: !!sh('launchctl', ['list', 'com.hatchabot.control-plane']) || !!sh('launchctl', ['list', 'com.agentclaw.control-plane']) }
    : sh('systemctl', ['--user', 'cat', 'hatchabot.service']) ? { manager: 'systemd', active: sh('systemctl', ['--user', 'is-active', 'hatchabot']) === 'active', enabled: sh('systemctl', ['--user', 'is-enabled', 'hatchabot']) === 'enabled' } : { manager: 'none' };
  let controlPlane: DoctorFacts['controlPlane'] = { url, ok: false };
  try {
    // Self-signed TLS is normal on a LAN install: verify the version marker, not the chain.
    if (url.startsWith('https:')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const res = await fetch(`${url.replace(/\/$/, '')}/`, { signal: AbortSignal.timeout(5000) });
    const html = await res.text();
    controlPlane = { url, ok: res.ok, version: /HATCHABOT_VERSION="([^"]+)"/.exec(html)?.[1] };
  } catch (err) { controlPlane = { url, ok: false, error: String((err as Error).cause ?? (err as Error).message).slice(0, 80) }; }
  const df = sh('df', ['-Pk', '.']); // -P: one line per filesystem on macOS too
  const diskFreeGb = df ? Number(df.split('\n').pop()!.split(/\s+/)[3]) / 1e6 : undefined;
  const bdir = process.env.HATCHABOT_BACKUP_DIR ?? env.HATCHABOT_BACKUP_DIR ?? defaultBackupsDir();
  let backups: DoctorFacts['backups'] = { dir: bdir };
  try {
    const sets = readdirSync(bdir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && readdirSync(join(bdir, d)).some((f) => f.endsWith('.sqlite'))).sort();
    const last = sets.pop();
    if (last) backups = { dir: bdir, lastSet: last, ageDays: Math.floor((Date.now() - new Date(last).getTime()) / 86_400_000) };
  } catch { /* no dir */ }
  const tsBin = sh('tailscale', ['--version']);
  const tailscale: DoctorFacts['tailscale'] = tsBin ? { installed: true, up: /^100\./.test(sh('tailscale', ['ip', '-4']) ?? ''), dns: (sh('tailscale', ['status', '--json']) ?? '').match(/"DNSName":\s*"([^"]+)\."/)?.[1] } : { installed: false };
  return {
    nodeVersion: process.version, dockerCli, dockerDaemon, runtimeImage,
    envFile: { present: existsSync('.env'), secretKey: !!env.HATCHABOT_SECRET_KEY, password: !!env.HATCHABOT_PASSWORD, authMode: env.HATCHABOT_AUTH ?? 'password', publicUrl: env.HATCHABOT_PUBLIC_URL || undefined },
    db: { path: dbPath, present: existsSync(dbPath), sizeMb: existsSync(dbPath) ? statSync(dbPath).size / 1e6 : undefined },
    service, controlPlane, diskFreeGb, backups, tailscale,
    containers: { running: rows.filter((l) => l.endsWith('|running')).length, total: rows.length },
  };
}
