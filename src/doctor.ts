// `hatchabot doctor`: one command that says what's wrong with an installation
// and how to fix it. The probes gather facts (docker, node, service, disk…);
// `doctorReport` turns them into ✓/⚠/✗ lines — pure, so it's tested without
// a machine.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultBackupsDir, defaultDbPath } from './envCompat.js';
import { readSetStatus } from './orchestrator/backups.js';
import { funnelOff, funnelStatus, tailnetInfo, targetsPort } from './ops/tailnet.js';
import { envFilePath, publicIntentIsStale, readPublicIntent } from './ops/publicIntent.js';
import { adminAccounts, evaluateSafeguards, hostOf, publicConfig, type SafeguardCheck } from './api/safeguards.js';
import { autoUpgradeStatus } from './ops/autoUpgrade.js';
import { COMPRESSED_SWAP_FIX, type LimitsCheckSummary, describeCompressedSwap, effectiveSwapAllowance, formatSwapAllowance, parseSwapAllowance, parseSwapProbe, SWAP_PROBE_SCRIPT, type CompressedSwap } from './orchestrator/swap.js';

export interface DoctorFacts {
  nodeVersion: string;
  dockerCli: boolean;
  dockerDaemon: { ok: boolean; arch?: string; version?: string; error?: string; rootless?: boolean };
  runtimeImage?: { openclawVersion?: string; sizeGb?: number };
  envFile: { present: boolean; secretKey: boolean; password: boolean; authMode: string; publicUrl?: string };
  db: { path: string; present: boolean; sizeMb?: number };
  service: { manager: 'systemd' | 'launchd' | 'none'; active?: boolean; enabled?: boolean;
    /** Linux: the RUNNING service process is not in the docker group, though the user is. */
    dockerDenied?: boolean };
  controlPlane: { url: string; ok: boolean; version?: string; error?: string };
  diskFreeGb?: number;
  backups: { dir: string; lastSet?: string; ageDays?: number; complete?: boolean; failed?: number };
  tailscale?: { installed: boolean; up?: boolean; dns?: string; serving?: boolean; reachable?: boolean; url?: string; appOnly?: boolean };
  containers?: { running: number; total: number;
    /** RUNNING agent containers still on docker's shared bridge network (made before v1.16's isolation). */
    sharedNetwork?: number };
  /** Which release this checkout sits on, and whether a newer tag is present. */
  checkout?: { tag?: string; latestTag?: string; dirty?: string[] };
  /** Compressed swap (orchestrator/swap.ts): what the machine has, and who is set to use it. */
  swap?: {
    state: CompressedSwap;
    /** HATCHABOT_AGENT_SWAP as set ("off" when unset). */
    fleet: string;
    /** Live agents whose settings give them an allowance (own, class or fleet). */
    agentsWithAllowance?: number;
    /** Agent containers that run with swap now (docker's MemorySwap above the cap). */
    containersWithSwap?: number;
    /** The app's last limits check (limits-check.json beside the database). */
    lastCheck?: LimitsCheckSummary;
  };
  /** Public access (docs/public-access.md): the switch, and every safeguard it stands on. */
  publicAccess?: {
    on: boolean;
    /** HATCHABOT_PUBLIC_ACCESS names something that is not a provider. */
    unknownProvider?: string;
    url?: string;
    port: number;
    safeguards: SafeguardCheck[];
    /** Tailscale Funnel as it is configured now. undefined: could not be read. */
    funnel?: { toPublicPort: boolean; toPrivatePort: boolean };
    /** Chat-only guests are let in without a second factor (HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR=1). */
    guestsExempt?: boolean;
    /** HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL is set to something other than 1: ignored, not a way to weaken. */
    forAllIgnored?: string;
    /** A switch to "on" that began and has not finished (publicIntent.ts). `stale`: it died; a restart takes it back. */
    pending?: { at?: string; stale: boolean };
    /** Off, and Funnel pointed at the public port: what happened when the doctor took the entry out. */
    leftover?: { removed: boolean; error?: string; command?: string };
  };
}

export interface DoctorLine { level: 'ok' | 'warn' | 'fail'; text: string; fix?: string }

export function doctorReport(f: DoctorFacts): DoctorLine[] {
  const out: DoctorLine[] = [];
  const major = Number(f.nodeVersion.replace(/^v/, '').split('.')[0]);
  out.push(major >= 22 ? { level: 'ok', text: `Node ${f.nodeVersion}` } : { level: 'fail', text: `Node ${f.nodeVersion} — 22+ required`, fix: 'Install Node 22 (https://nodejs.org) and re-run ./scripts/restart.sh' });
  if (!f.dockerCli) out.push({ level: 'fail', text: 'Docker is not installed', fix: 'https://docs.docker.com/engine/install/ (Linux) or Docker Desktop (macOS)' });
  else if (!f.dockerDaemon.ok) out.push({ level: 'fail', text: `Docker is installed but not reachable${f.dockerDaemon.error ? ` (${f.dockerDaemon.error})` : ''}`, fix: 'Start Docker; on Linux add yourself to the docker group: sudo usermod -aG docker $USER, then log out and in' });
  else out.push({ level: 'ok', text: `Docker ${f.dockerDaemon.version ?? ''} (${f.dockerDaemon.arch ?? '?'})${f.dockerDaemon.rootless ? ' — rootless: agents reach this machine at 10.0.2.2; the doors listen on loopback' : ''}` });
  if (f.dockerDaemon.ok) {
    if (!f.runtimeImage) out.push({ level: 'fail', text: 'Runtime image hatchabot-runtime:latest is missing — agents cannot start', fix: './scripts/build-runtime-image.sh (pulls the published image, builds only if that fails)' });
    else out.push({ level: 'ok', text: `Runtime image: OpenClaw ${f.runtimeImage.openclawVersion ?? '?'}${f.runtimeImage.sizeGb ? ` · ${f.runtimeImage.sizeGb.toFixed(1)} GB` : ''}` });
    if (f.containers) out.push({ level: 'ok', text: `Agent containers: ${f.containers.running} running of ${f.containers.total}` });
    if (f.containers?.sharedNetwork) {
      out.push({
        level: 'warn',
        text: `${f.containers.sharedNetwork} running agent${f.containers.sharedNetwork > 1 ? 's are' : ' is'} still on the shared network, where other agents can reach ${f.containers.sharedNetwork > 1 ? 'them' : 'it'} — made before the isolated network`,
        fix: 'hatchabot rebuild --outdated — or wait: unless the rebuild policy is manual, this machine does it on its own once each is idle.',
      });
    }
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
  // A set can exist and still be partial: judged by its run's own record,
  // not the directory (review, 2026-09-29).
  else if (f.backups.complete === false) out.push({ level: 'warn', text: `Last backup set ${f.backups.lastSet} is incomplete${f.backups.failed ? ` (${f.backups.failed} volume${f.backups.failed === 1 ? '' : 's'} failed)` : ' (the run did not finish)'}`, fix: 'journalctl --user -u hatchabot-backup -n 30' });
  else out.push({ level: 'ok', text: `Backups: last set ${f.backups.lastSet}` });
  if (f.tailscale) {
    const t = f.tailscale;
    out.push(!t.installed ? { level: 'warn', text: 'Tailscale not installed — the app is reachable on your LAN only', fix: 'docs/tailscale.md — private access from anywhere, nothing opened to the internet' }
      : t.appOnly ? { level: 'warn', text: 'Tailscale app found, but it is not signed in or its command did not answer', fix: 'Open the Tailscale app and sign in; the setup guide\'s Turn on HTTPS step does the rest' }
      : !t.up ? { level: 'warn', text: 'Tailscale installed but not connected', fix: 'sudo tailscale up (or open the Tailscale app)' }
      : t.serving && t.reachable ? { level: 'ok', text: `Tailscale up, serving ${t.url}` }
      : { level: 'ok', text: `Tailscale up${t.dns ? ` (${t.dns})` : ''}${t.serving ? ' — serving, but the address did not answer yet' : ' — HTTPS not turned on (setup guide → Turn on HTTPS)'}` });
  }
  if (f.swap) out.push(swapLine(f.swap));
  if (f.swap?.lastCheck) out.push(limitsCheckLine(f.swap.lastCheck));
  if (f.publicAccess) out.push(...publicAccessLines(f.publicAccess));
  return out;
}

/** One line on compressed swap: the machine's state, and a warning when agents are set to swap and cannot. */
export function swapLine(sw: NonNullable<DoctorFacts['swap']>): DoctorLine {
  const n = sw.agentsWithAllowance;
  const who = n === undefined ? '' : ` · ${n} agent${n === 1 ? ' has' : 's have'} a swap allowance${sw.containersWithSwap !== undefined ? ` (${sw.containersWithSwap} container${sw.containersWithSwap === 1 ? '' : 's'} running with swap)` : ''}${sw.fleet !== 'off' ? `; machine setting ${sw.fleet}` : ''}`;
  if (sw.state.compressed) return { level: 'ok', text: `Compressed swap: ${describeCompressedSwap(sw.state)}${who}` };
  const wanted = (n ?? 0) > 0 || sw.fleet !== 'off';
  if (wanted) return { level: 'warn', text: `Agents are set to use compressed swap${who}, but this machine has none, so they run without swap: ${sw.state.why ?? sw.state.kind}`, fix: COMPRESSED_SWAP_FIX };
  if (sw.state.kind === 'unknown') return { level: 'ok', text: 'Compressed swap: could not be read (agents run without swap)' };
  return { level: 'ok', text: `Compressed swap: none — agents run without swap (optional: ${COMPRESSED_SWAP_FIX}, then Settings → Hosts → Defaults → Compressed swap per agent)` };
}

/**
 * The app's last limits check. A systemd reload resets a container's
 * memory.swap.max to "max" behind docker's back (docker's systemd driver
 * leaves a zero swap limit out of systemd's record); the app finds and
 * restores those every ten minutes, and says here how many it found.
 */
export function limitsCheckLine(c: LimitsCheckSummary): DoctorLine {
  const when = c.at.slice(0, 16).replace('T', ' ');
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const uncovered = c.notCovered ? `; ${n(c.notCovered, 'running agent', 'running agents')} on a runner whose cgroup could not be read (docker's record only)` : '';
  if (c.failed) return { level: 'warn', text: `Limits check ${when}: ${n(c.failed, 'agent\'s', 'agents\'')} memory or swap limits had drifted and could NOT be restored${uncovered}`, fix: 'hatchabot events <agent> (runtime.swap_reassert_failed); a rebuild makes the container anew' };
  if (c.cgroupDrifted) return { level: 'warn', text: `Limits check ${when}: ${n(c.cgroupDrifted, 'agent\'s', 'agents\'')} swap limits had drifted (systemd reload) and were restored${c.reasserted > c.cgroupDrifted ? `, ${c.reasserted - c.cgroupDrifted} more brought up to date` : ''}${uncovered}`, fix: 'Nothing to do: the app checks every ten minutes. A reload (snap refresh, package upgrade) causes it; docker\'s systemd driver leaves a zero swap limit out of systemd\'s record' };
  return { level: 'ok', text: `Limits check ${when}: ${n(c.checked, 'agent', 'agents')} checked${c.reasserted ? `, ${c.reasserted} brought up to date` : ', none drifted'}${uncovered}` };
}

/** The machine's swap and who is set to use it; best-effort, never throws. */
export async function swapFacts(env: Record<string, string>, dbPath: string, prefix: string, dockerOk: boolean): Promise<DoctorFacts['swap']> {
  let out: string | undefined;
  if (process.platform === 'linux') out = sh('sh', ['-c', SWAP_PROBE_SCRIPT]);
  else if (dockerOk) out = sh('docker', ['run', '--rm', '--network', 'none', 'alpine', 'sh', '-c', SWAP_PROBE_SCRIPT], 60_000);
  const state = parseSwapProbe(out);
  const merged = { ...env, ...(process.env.HATCHABOT_AGENT_SWAP !== undefined ? { HATCHABOT_AGENT_SWAP: process.env.HATCHABOT_AGENT_SWAP } : {}) } as NodeJS.ProcessEnv;
  const fb = parseSwapAllowance(merged.HATCHABOT_AGENT_SWAP ?? '');
  const fleet = fb ? formatSwapAllowance(fb) : 'off';
  let agentsWithAllowance: number | undefined;
  if (existsSync(dbPath)) {
    try {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const classes = new Map((db.prepare('SELECT id, memory_cap, swap_allowance FROM agent_classes').all() as Array<{ id: string; memory_cap: string | null; swap_allowance: string | null }>).map((c) => [c.id, c]));
        const rows = db.prepare(`SELECT memory_cap, swap_allowance, class_id FROM agents WHERE state NOT IN ('DELETED', 'ARCHIVED')`).all() as Array<{ memory_cap: string | null; swap_allowance: string | null; class_id: string | null }>;
        agentsWithAllowance = rows.filter((r) => {
          const c = r.class_id ? classes.get(r.class_id) : undefined;
          return effectiveSwapAllowance({ memoryCap: r.memory_cap ?? undefined, swapAllowance: r.swap_allowance ?? undefined }, c ? { memoryCap: c.memory_cap ?? undefined, swapAllowance: c.swap_allowance ?? undefined } : undefined, merged) > 0;
        }).length;
      } finally { db.close(); }
    } catch { /* an older database (no swap columns yet) or unreadable: not counted */ }
  }
  let containersWithSwap: number | undefined;
  if (dockerOk) {
    const names = (sh('docker', ['ps', '-a', '--format', '{{.Names}}']) ?? '').split('\n').filter((n) => (n.startsWith(`${prefix}-`) || n.startsWith('agentclaw-')) && !/-(vx|io|fs)-[0-9a-f]{12}$/.test(n) && !/-(embedder|embed-door)$|-doorman-/.test(n));
    if (names.length) {
      const ins = sh('docker', ['inspect', '--format', '{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.State.Running}}', ...names]);
      // Running ones: a stopped container is given its limits again when it starts.
      if (ins !== undefined) containersWithSwap = ins.split('\n').filter((l) => { const [m, w, r] = l.split('|'); return r === 'true' && !!Number(m) && (Number(w) < 0 || Number(w) > Number(m)); }).length;
    } else containersWithSwap = 0;
  }
  let lastCheck: LimitsCheckSummary | undefined;
  try { lastCheck = JSON.parse(readFileSync(join(dirname(dbPath), 'limits-check.json'), 'utf8')) as LimitsCheckSummary; } catch { /* the app has not run one yet */ }
  return { state, fleet, agentsWithAllowance, containersWithSwap, ...(lastCheck && typeof lastCheck.at === 'string' ? { lastCheck } : {}) };
}

/**
 * Public access. Off: one line (and a failure only if Funnel is publishing
 * something anyway). On: a line per safeguard, and every one that is off is
 * a FAILURE: the public address answers 503 until it is fixed.
 */
export function publicAccessLines(p: NonNullable<DoctorFacts['publicAccess']>): DoctorLine[] {
  const out: DoctorLine[] = [];
  const off = p.safeguards.filter((c) => !c.ok);
  if (p.funnel?.toPrivatePort) {
    out.push({ level: 'fail', text: 'Tailscale Funnel publishes the PRIVATE port to the internet: visitors there are treated as this machine, with none of the public safeguards', fix: 'tailscale funnel reset   (then, if you want a public address: hatchabot reach on)' });
  }
  const settings: DoctorLine[] = [];
  if (p.forAllIgnored !== undefined) {
    settings.push({ level: 'warn', text: `HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL=${p.forAllIgnored} is ignored: at the public address a second factor is required of everyone who signs in with a password, and this setting cannot switch that off`, fix: 'Remove the line from .env. To let chat-only guests in without one (and nobody else): Settings → You → Reach it from anywhere' });
  }
  if (p.guestsExempt) {
    settings.push({ level: 'warn', text: 'Chat-only guests use the public address without a second factor (HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR=1): a guest\'s password alone opens their chats from the internet', fix: 'Your choice; to undo it: Settings → You → Reach it from anywhere' });
  }
  if (p.pending) {
    settings.push(p.pending.stale
      ? { level: 'fail', text: `Turning public access on began${p.pending.at ? ` at ${p.pending.at}` : ''} and never finished (the process stopped part-way)`, fix: 'Restart Hatchabot: at start it takes the unfinished switch back (Funnel\'s entry, the setting, the address). Then: hatchabot reach on' }
      : { level: 'warn', text: 'Public access is being turned on right now (or the switch stopped moments ago): run the doctor again in a few minutes' });
  }
  if (!p.on) {
    out.push({ level: 'ok', text: `Public access: off (private only)${off.length ? ` — not ready to turn on: ${off.map((c) => c.title).join('; ')}` : ' — every safeguard is in place'}` });
    if (p.leftover?.removed) out.push({ level: 'warn', text: `Tailscale Funnel pointed at the public listener's port ${p.port} while public access is off (a switch that did not finish): the entry has been removed` });
    else if (p.funnel?.toPublicPort) out.push({ level: 'warn', text: `Tailscale Funnel still points at the public listener's port ${p.port}, which is closed${p.leftover?.error ? ` (removing it failed: ${p.leftover.error})` : ''}`, fix: p.leftover?.command ?? 'hatchabot reach off' });
    out.push(...settings);
    return out;
  }
  if (p.unknownProvider) {
    out.push({ level: 'fail', text: `HATCHABOT_PUBLIC_ACCESS=${p.unknownProvider} is not a known provider: nothing is served publicly`, fix: 'Set it to funnel, or remove it (hatchabot reach off)' });
  }
  out.push(off.length
    ? { level: 'fail', text: `Public access is ON${p.url ? ` at ${p.url}` : ''}, but ${off.length} safeguard${off.length === 1 ? ' is' : 's are'} off: the public address answers 503`, fix: 'Fix each line below, or: hatchabot reach off' }
    : { level: 'ok', text: `Public access is ON${p.url ? ` at ${p.url}` : ''}: the sign-in page is reachable from the internet` });
  for (const c of p.safeguards) {
    out.push({ level: c.ok ? 'ok' : 'fail', text: `  ${c.letter}. ${c.title}${c.builtIn ? ' (built in)' : ''}: ${c.detail}`, ...(c.ok || !c.fix ? {} : { fix: c.fix }) });
  }
  if (p.funnel && !p.funnel.toPublicPort) {
    out.push({ level: 'warn', text: `Public access is on, but Tailscale Funnel is not pointed at the public listener (port ${p.port}): nobody can reach it`, fix: 'hatchabot reach on' });
  }
  out.push(...settings);
  return out;
}

/** The public-access facts, from .env, the database (read-only) and the machine. */
export async function publicAccessFacts(env: Record<string, string>, dbPath: string, mainPort: number, probe: {
  autoUpgrade?: typeof autoUpgradeStatus; funnel?: typeof funnelStatus; funnelOff?: typeof funnelOff;
  /** The .env the service reads (the note of an unfinished switch sits beside it). */
  envPath?: string;
} = {}): Promise<NonNullable<DoctorFacts['publicAccess']>> {
  const merged = { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith('HATCHABOT_PUBLIC_') && v !== undefined)) } as NodeJS.ProcessEnv;
  const cfg = publicConfig(merged);
  const authMode = (env.HATCHABOT_AUTH ?? 'password').toLowerCase();
  let admins: ReturnType<typeof adminAccounts> = [];
  if (existsSync(dbPath)) {
    try {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try { admins = adminAccounts(db, authMode); } finally { db.close(); }
    } catch { /* unreadable: nobody is known to have a second factor, which fails the safeguard */ }
  }
  const fs = await (probe.funnel ?? funnelStatus)().catch(() => ({ readable: false, entries: [] }));
  let funnel = fs.readable ? { toPublicPort: fs.entries.some((e) => targetsPort(e, cfg.port)), toPrivatePort: fs.entries.some((e) => targetsPort(e, mainPort)) } : undefined;
  // A switch to "on" that has not finished. While it is fresh it may be in
  // progress in the running app: nothing is touched. Stale, or absent: a
  // Funnel entry on the public port with public access off is a leftover,
  // and is taken out here (the port is closed; the entry must not wait for
  // whatever opens that port next).
  const intent = readPublicIntent(probe.envPath ?? envFilePath());
  const pending = intent ? { at: typeof intent.at === 'string' ? intent.at : undefined, stale: publicIntentIsStale(intent) } : undefined;
  let leftover: { removed: boolean; error?: string; command?: string } | undefined;
  if (!cfg.on && funnel?.toPublicPort && (!pending || pending.stale)) {
    const r = await (probe.funnelOff ?? funnelOff)(cfg.port, cfg.funnelPort).catch((err: unknown) => ({ ok: false, error: String((err as Error)?.message ?? err), command: undefined }));
    leftover = r.ok ? { removed: true } : { removed: false, error: r.error, command: r.command };
    if (r.ok) funnel = { ...funnel, toPublicPort: false };
  }
  const publicHost = hostOf(cfg.url) ?? hostOf(env.HATCHABOT_PUBLIC_URL);
  const safeguards = evaluateSafeguards({
    authMode,
    managed: !!env.HATCHABOT_MANAGED_BY?.trim(),
    admins,
    invitedOnly: cfg.invitedOnly,
    ownerHeader: env.HATCHABOT_ALLOW_OWNER_HEADER === '1',
    ports: { main: mainPort, public: cfg.port, ops: Number(env.HATCHABOT_OPS_PORT ?? 8091), embed: Number(env.HATCHABOT_EMBED_PORT ?? 8093) },
    autoUpgrade: await (probe.autoUpgrade ?? autoUpgradeStatus)().catch(() => ({ ok: false, why: 'Automatic upgrades could not be checked.' })),
    funnelOnPrivatePort: funnel?.toPrivatePort,
    publicOn: cfg.on,
    loginFailLimit: Number(env.HATCHABOT_LOGIN_FAILS_PER_WINDOW ?? 10),
    publicHost,
    guestsExempt: cfg.guestsWithoutSecondFactor,
  });
  return {
    on: cfg.on, unknownProvider: cfg.unknownProvider, url: cfg.url, port: cfg.port, safeguards, funnel,
    ...(cfg.guestsWithoutSecondFactor ? { guestsExempt: true } : {}),
    ...(cfg.forAllIgnored !== undefined ? { forAllIgnored: cfg.forAllIgnored } : {}),
    ...(pending ? { pending } : {}), ...(leftover ? { leftover } : {}),
  };
}

/** Git facts about this checkout. Offline: it reads the tags already fetched,
 *  so "behind" means "behind what this machine has seen". */
export function checkoutFacts(dir = process.cwd()): DoctorFacts['checkout'] {
  const git = (...args: string[]) => sh('git', ['-C', dir, ...args]);
  if (!git('rev-parse', '--git-dir')) {
    // A bundle install (install.sh) has no clone: its release is in BUNDLE.json, and it cannot be "dirty".
    try {
      const b = JSON.parse(readFileSync(join(dir, 'BUNDLE.json'), 'utf8')) as { tag?: unknown };
      if (typeof b.tag === 'string' && /^v\d/.test(b.tag)) return { tag: b.tag, dirty: [] };
    } catch { /* not a bundle either */ }
    return undefined;
  }
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
export function envMap(file: string): Record<string, string> {
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
  const secopts = info ? sh('docker', ['info', '--format', '{{.SecurityOptions}}']) : undefined;
  const dockerDaemon = info
    ? { ok: true, version: info.split('|')[0], arch: info.split('|')[1], rootless: /\bname=rootless\b/.test(secopts ?? '') }
    : { ok: false, error: dockerCli ? 'daemon not reachable' : undefined };
  let runtimeImage: DoctorFacts['runtimeImage'];
  if (dockerDaemon.ok) {
    const img = sh('docker', ['image', 'inspect', '--format', '{{ index .Config.Labels "org.agentclaw.openclaw-version" }}|{{.Size}}', process.env.HATCHABOT_IMAGE ?? env.HATCHABOT_IMAGE ?? 'hatchabot-runtime:latest']);
    if (img) runtimeImage = { openclawVersion: img.split('|')[0] || undefined, sizeGb: Number(img.split('|')[1]) / 1e9 };
  }
  const prefix = process.env.HATCHABOT_PREFIX ?? env.HATCHABOT_PREFIX ?? 'hatchabot';
  const ps = dockerDaemon.ok ? sh('docker', ['ps', '-a', '--format', '{{.Names}}|{{.Networks}}|{{.State}}']) : undefined;
  const rows = (ps ?? '').split('\n').filter((l) => l.startsWith(`${prefix}-`) || l.startsWith('agentclaw-'));
  const agentNet = (process.env.HATCHABOT_AGENT_NETWORK ?? env.HATCHABOT_AGENT_NETWORK ?? 'hatchabot-agents').trim();
  const sharedNetwork = agentNet && agentNet !== 'bridge' && agentNet !== 'default'
    // Running ones only: a stopped container is either rebuilt when started, or
    // an archived agent's, which is made anew when restored.
    ? rows.filter((l) => l.split('|')[1] === 'bridge' && l.endsWith('|running')).length
    : 0;
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
    if (last) {
      const st = readSetStatus(join(bdir, last));
      backups = {
        dir: bdir, lastSet: last, ageDays: Math.floor((Date.now() - new Date(last).getTime()) / 86_400_000),
        ...(st.complete !== undefined ? { complete: st.complete } : {}),
        ...(st.failedVolumes?.length ? { failed: st.failedVolumes.length } : {}),
      };
    }
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
    containers: { running: rows.filter((l) => l.endsWith('|running')).length, total: rows.length, sharedNetwork },
    checkout: checkoutFacts(),
    swap: await swapFacts(env, dbPath, prefix, dockerDaemon.ok).catch(() => undefined),
    publicAccess: await publicAccessFacts(env, dbPath, port).catch(() => undefined),
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
    const hasDocker = (p: string): boolean => {
      const status = readFileSync(`/proc/${p}/status`, 'utf8');
      const groups = (/^Groups:\s*(.*)$/m.exec(status)?.[1] ?? '').trim().split(/\s+/);
      // Started through scripts/with-docker.sh (`sg docker`), the group is the
      // process's own group id rather than an extra one: that reaches Docker too.
      const gids = (/^Gid:\s*(.*)$/m.exec(status)?.[1] ?? '').trim().split(/\s+/);
      return groups.includes(gid) || gids.includes(gid);
    };
    // `sg` starts the command as its child (it stays the service's main
    // process), so Hatchabot itself is one level down (clean-VM install, 2026-10-06).
    const kids = (sh('pgrep', ['-P', pid]) ?? '').split(/\s+/).filter(Boolean);
    return !hasDocker(pid) && !kids.some((k) => { try { return hasDocker(k); } catch { return false; } });
  } catch {
    return undefined;
  }
}
