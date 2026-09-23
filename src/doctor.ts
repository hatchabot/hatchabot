// `hatchabot doctor`: one command that says what's wrong with an installation
// and how to fix it. The probes gather facts (docker, node, service, disk…);
// `doctorReport` turns them into ✓/⚠/✗ lines — pure, so it's tested without
// a machine.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultBackupsDir, defaultDbPath } from './envCompat.js';
import { tailnetInfo } from './ops/tailnet.js';

export interface DoctorFacts {
  nodeVersion: string;
  dockerCli: boolean;
  dockerDaemon: { ok: boolean; arch?: string; version?: string; error?: string };
  runtimeImage?: { openclawVersion?: string; sizeGb?: number };
  envFile: { present: boolean; secretKey: boolean; password: boolean; authMode: string; publicUrl?: string };
  db: { path: string; present: boolean; sizeMb?: number };
  service: { manager: 'systemd' | 'launchd' | 'none'; active?: boolean; enabled?: boolean;
    /** Linux: the RUNNING service process is not in the docker group, though the user is. */
    dockerDenied?: boolean };
  controlPlane: { url: string; ok: boolean; version?: string; error?: string };
  diskFreeGb?: number;
  backups: { dir: string; lastSet?: string; ageDays?: number };
  tailscale?: { installed: boolean; up?: boolean; dns?: string; serving?: boolean; reachable?: boolean; url?: string; appOnly?: boolean };
  containers?: { running: number; total: number };
  /** Which release this checkout sits on, and whether a newer tag is present. */
  checkout?: { tag?: string; latestTag?: string; dirty?: string[] };
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
  // A checkout behind the latest tag, or one the installer will refuse to
  // move because it is dirty, is the quiet cause of "I upgraded but nothing
  // changed" — including a crash-on-boot that was already fixed upstream.
  if (f.checkout?.dirty?.length) {
    out.push({
      level: 'warn',
      text: `Checkout has local changes (${f.checkout.dirty.slice(0, 3).join(', ')}${f.checkout.dirty.length > 3 ? `, +${f.checkout.dirty.length - 3} more` : ''}) — the installer refuses to upgrade over them`,
      fix: 'git -C . stash   (or commit them), then re-run the installer',
    });
  }
  if (f.checkout?.tag && f.checkout.latestTag && f.checkout.tag !== f.checkout.latestTag) {
    out.push({
      level: 'warn',
      text: `Running ${f.checkout.tag}, but ${f.checkout.latestTag} is available locally`,
      fix: `git fetch --tags origin && git checkout ${f.checkout.latestTag} && ./scripts/restart.sh`,
    });
  } else if (f.checkout?.tag) {
    out.push({ level: 'ok', text: `Release ${f.checkout.tag}` });
  }
  if (!f.envFile.present) out.push({ level: 'fail', text: '.env is missing', fix: './scripts/setup-host.sh writes it (secret key, password, port)' });
  else {
    if (!f.envFile.secretKey) out.push({ level: 'fail', text: '.env has no HATCHABOT_SECRET_KEY — credentials cannot be stored', fix: 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" → HATCHABOT_SECRET_KEY=… in .env' });
    // Only the shared-password mode needs HATCHABOT_PASSWORD: accounts mode
    // holds a password per person, identity mode uses Google. Warning about it
    // in either would call a locked install an open one.
    if (f.envFile.authMode === 'password' && !f.envFile.password) out.push({ level: 'warn', text: 'No app password set — the web app is open to anyone who can reach the port', fix: 'HATCHABOT_PASSWORD=… in .env, or turn on family accounts in Settings → You' });
    // A tailnet address that answers is what the app uses for links and QR
    // codes when nothing is set (appUrlFor), so it is not a warning.
    if (f.envFile.publicUrl) out.push({ level: 'ok', text: `Public URL ${f.envFile.publicUrl}` });
    else if (f.tailscale?.reachable && f.tailscale.url) out.push({ level: 'ok', text: `Public URL not set; links use the tailnet address ${f.tailscale.url} (the setup guide's Turn on HTTPS step makes it explicit)` });
    else out.push({ level: 'warn', text: 'HATCHABOT_PUBLIC_URL not set — invite links and OAuth redirects use localhost', fix: 'Set it to the address others use (with Tailscale: https://<machine>.<tailnet>.ts.net)' });
  }
  out.push(f.db.present ? { level: 'ok', text: `Database ${f.db.path}${f.db.sizeMb !== undefined ? ` (${f.db.sizeMb.toFixed(1)} MB)` : ''}` } : { level: 'warn', text: `Database not created yet at ${f.db.path}`, fix: 'It appears on first start' });
  if (f.service.manager === 'none') out.push({ level: 'warn', text: 'No background service installed — Hatchabot will not start with the machine', fix: './scripts/install-service.sh' });
  else if (!f.service.active) out.push({ level: 'fail', text: `Service is installed (${f.service.manager}) but not running`, fix: f.service.manager === 'systemd' ? 'systemctl --user start hatchabot; journalctl --user -u hatchabot -n 50' : './scripts/restart.sh' });
  else if (f.service.dockerDenied) out.push({ level: 'fail', text: 'Service running, but it cannot use Docker — it started before your user joined the docker group, so agents fail to start (your terminal has the group, which is why the rest looks fine)', fix: 'sudo systemctl restart user@$(id -u)   (or reboot)' });
  else out.push({ level: f.service.enabled === false ? 'warn' : 'ok', text: `Service running (${f.service.manager})${f.service.enabled === false ? ' — but not enabled at boot' : ''}`, ...(f.service.enabled === false ? { fix: 'systemctl --user enable hatchabot' } : {}) });
  out.push(f.controlPlane.ok ? { level: 'ok', text: `Control plane answering at ${f.controlPlane.url}${f.controlPlane.version ? ` (v${f.controlPlane.version})` : ''}` } : { level: 'fail', text: `Control plane not answering at ${f.controlPlane.url}${f.controlPlane.error ? ` (${f.controlPlane.error})` : ''}`, fix: 'journalctl --user -u hatchabot -n 50 (Linux) · ./scripts/restart.sh' });
  if (f.diskFreeGb !== undefined) out.push(f.diskFreeGb < 10 ? { level: f.diskFreeGb < 3 ? 'fail' : 'warn', text: `Only ${f.diskFreeGb.toFixed(1)} GB free — each agent volume grows; the image is ~2 GB`, fix: 'docker system prune; remove old backup sets; move backups to a NAS (HATCHABOT_BACKUP_DIR)' } : { level: 'ok', text: `${f.diskFreeGb.toFixed(0)} GB free` });
  if (!f.backups.lastSet) out.push({ level: 'warn', text: `No backup set in ${f.backups.dir} yet`, fix: 'systemctl --user start hatchabot-backup (or wait for 03:30); scripts/restore-drill.sh proves a set restores' });
  else if ((f.backups.ageDays ?? 0) > 2) out.push({ level: 'warn', text: `Last backup set is ${f.backups.ageDays} days old (${f.backups.lastSet})`, fix: 'journalctl --user -u hatchabot-backup -n 30' });
  else out.push({ level: 'ok', text: `Backups: last set ${f.backups.lastSet}` });
  if (f.tailscale) {
    const t = f.tailscale;
    out.push(!t.installed ? { level: 'warn', text: 'Tailscale not installed — the app is reachable on your LAN only', fix: 'docs/tailscale.md — private access from anywhere, nothing opened to the internet' }
      : t.appOnly ? { level: 'warn', text: 'Tailscale app found, but it is not signed in or its command did not answer', fix: 'Open the Tailscale app and sign in; the setup guide\'s Turn on HTTPS step does the rest' }
      : !t.up ? { level: 'warn', text: 'Tailscale installed but not connected', fix: 'sudo tailscale up (or open the Tailscale app)' }
      : t.serving && t.reachable ? { level: 'ok', text: `Tailscale up, serving ${t.url}` }
      : { level: 'ok', text: `Tailscale up${t.dns ? ` (${t.dns})` : ''}${t.serving ? ' — serving, but the address did not answer yet' : ' — HTTPS not turned on (setup guide → Turn on HTTPS)'}` });
  }
  return out;
}

/** Git facts about this checkout. Offline: it reads the tags already fetched,
 *  so "behind" means "behind what this machine has seen". */
export function checkoutFacts(dir = process.cwd()): DoctorFacts['checkout'] {
  const git = (...args: string[]) => sh('git', ['-C', dir, ...args]);
  if (!git('rev-parse', '--git-dir')) return undefined;
  const tag = git('describe', '--tags', '--exact-match')?.trim() || undefined;
  const latestTag = git('tag', '-l', 'v[0-9]*', '--sort=-v:refname')?.split('\n')[0]?.trim() || undefined;
  // Porcelain lines are "XY path", but the captured output is trimmed, so the
  // first line may have lost its leading space — strip the status flags by
  // shape, not by a fixed width (that ate a character off the filename).
  const dirty = (git('status', '--porcelain') ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*[A-Z?!ADMRCU ]{1,2}\s+/, '').trim())
    .filter(Boolean);
  return { tag, latestTag, dirty };
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
    : sh('systemctl', ['--user', 'cat', 'hatchabot.service']) ? { manager: 'systemd', active: sh('systemctl', ['--user', 'is-active', 'hatchabot']) === 'active', enabled: sh('systemctl', ['--user', 'is-enabled', 'hatchabot']) === 'enabled', dockerDenied: serviceDockerDenied() } : { manager: 'none' };
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
  // The same lookup the app's HTTPS step uses: it knows the Mac app bundle,
  // Homebrew's path and `serve`. A plain `tailscale` on PATH missed the Mac
  // app entirely and told a working install it had no Tailscale (2026-09-22).
  const port = Number(process.env.PORT ?? env.PORT ?? 8080) || 8080;
  const ti = await tailnetInfo(port).catch(() => ({ installed: false }) as Awaited<ReturnType<typeof tailnetInfo>>);
  const tailscale: DoctorFacts['tailscale'] = { installed: ti.installed, appOnly: ti.appOnly, up: ti.up, dns: ti.dns, serving: ti.serving, reachable: ti.reachable, url: ti.url };
  return {
    nodeVersion: process.version, dockerCli, dockerDaemon, runtimeImage,
    envFile: { present: existsSync('.env'), secretKey: !!env.HATCHABOT_SECRET_KEY, password: !!env.HATCHABOT_PASSWORD, authMode: env.HATCHABOT_AUTH ?? 'password', publicUrl: env.HATCHABOT_PUBLIC_URL || undefined },
    db: { path: dbPath, present: existsSync(dbPath), sizeMb: existsSync(dbPath) ? statSync(dbPath).size / 1e6 : undefined },
    service, controlPlane, diskFreeGb, backups, tailscale,
    containers: { running: rows.filter((l) => l.endsWith('|running')).length, total: rows.length },
    checkout: checkoutFacts(),
  };
}


/**
 * Linux: is the running service's process missing the docker group that the
 * user has? The groups a process holds are fixed when its systemd manager
 * started; a login shell checking `docker info` can't see this (2026-09-23).
 */
function serviceDockerDenied(): boolean | undefined {
  try {
    const pid = sh('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', 'hatchabot']);
    const gid = (sh('getent', ['group', 'docker']) ?? '').split(':')[2];
    if (!pid || pid === '0' || !gid) return undefined;
    const user = (sh('id', ['-nG']) ?? '').split(/\s+/);
    if (!user.includes('docker')) return undefined; // not in the group at all: the docker check reports that
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const groups = (/^Groups:\s*(.*)$/m.exec(status)?.[1] ?? '').trim().split(/\s+/);
    return !groups.includes(gid);
  } catch {
    return undefined;
  }
}
