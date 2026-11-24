/**
 * Security posture check — a read-only snapshot of the install's configuration
 * risk, meant to be run repeatedly (a UI button + a daily job) as agents and
 * accounts are added. Distinct from the deep CODE audit: this finds risky
 * CONFIGURATION and drift, not bugs.
 *
 * The centrepiece is the per-agent EXPOSURE score — audience (how many people
 * can reach an agent, on a chat app or in its web chat) crossed with capability
 * (what it can do) — because those are the surfaces exposed to other people,
 * and a hostile message to a high-capability, wide-audience agent is where real
 * damage happens.
 *
 * Pure DB reads (no Docker), so it's cheap enough to run on demand. The one
 * Docker-backed input — each agent's storage — is measured by the daily sweep
 * (measureAgentDisks) and read back from the DB here.
 */
import type { Store } from '../../store/store.js';
import type { RuntimeProvider } from '../../providers/provider.js';

export type Level = 'ok' | 'info' | 'warn' | 'critical';

export interface InstallCheck {
  key: string; // stable id, for change diffing
  level: Level;
  title: string;
  detail: string;
}
export interface AgentExposure {
  id: string;
  name: string;
  audienceCount: number;
  group: 'off' | 'members' | 'room';
  capabilities: string[]; // e.g. ['send email as chris@…', 'read-write host folder', 'shared memory']
  exposure: 'low' | 'medium' | 'high';
  /** WHO, not just how many: a security review asks "which people can reach
   *  this agent", and a count never answered it. */
  audience?: Array<{ name: string; role: string; channels: string[]; pending?: boolean }>;
  reasons: string[];
  /** Its storage at the last daily measurement, when it passed the disk warning. */
  diskOverBytes?: number;
}
export interface PostureReport {
  install: InstallCheck[];
  agents: AgentExposure[];
  limits: {
    agentCap: number;
    liveAgents: number;
    diskWarnGB: number;
    /** Agents whose last measured storage passed diskWarnGB (2026-09-30). */
    overDisk?: Array<{ id: string; name: string; bytes: number; measuredAt: string }>;
  };
}

export interface PostureInput {
  ownerId: string;
  /** True when the caller owns the local host — install-level checks are the
   *  operator's view and are omitted otherwise. */
  isHostOwner: boolean;
  authMode: 'password' | 'accounts' | 'identity';
}

function envNum(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** HATCHABOT_AGENT_DISK_WARN_GB in bytes (decimal GB, as the page prints it). */
export function diskWarnBytes(): number {
  return envNum('HATCHABOT_AGENT_DISK_WARN_GB', 10) * 1e9;
}

/** "12.3 GB" — the unit the warning is set in. */
export const gbLabel = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/** What an agent can do that raises its exposure: send mail, write a host folder, act on sites as its owner. */
const isPowerful = (c: string): boolean =>
  c.startsWith('send email') || c === 'read-write host folder' || c === 'its own browser, keeps logins';

export function computePosture(store: Store, input: PostureInput): PostureReport {
  const { ownerId, isHostOwner, authMode } = input;
  const install: InstallCheck[] = [];

  if (isHostOwner) {
    install.push(
      authMode === 'identity'
        ? { key: 'auth-mode', level: 'ok', title: 'Identity mode', detail: 'Each account has its own owner scope.' }
        : authMode === 'accounts'
          ? { key: 'auth-mode', level: 'ok', title: 'Accounts mode', detail: 'Each account signs in with its own password and has its own owner scope.' }
          : {
              key: 'auth-mode',
              level: 'warn',
              title: 'Password mode — no per-account isolation',
              detail: 'Every login is the same owner. Switch to accounts mode (local logins) or identity mode before giving anyone their own account.',
            },
    );
    // Identity mode admits ANY Google account that can reach the machine
    // unless an allowlist is set — each one a tenant that can run agents on
    // the shared (default) Claude sources (review, 2026-09-29).
    if (authMode === 'identity') {
      const allowed = (process.env.HATCHABOT_ALLOWED_EMAILS ?? '').split(/[\s,]+/).filter(Boolean);
      install.push(
        allowed.length
          ? { key: 'allowed-emails', level: 'ok', title: `Google sign-in limited to ${allowed.length} address${allowed.length > 1 ? 'es' : ''}`, detail: 'HATCHABOT_ALLOWED_EMAILS decides who may sign in.' }
          : {
              key: 'allowed-emails',
              level: 'critical',
              title: 'Any Google account can sign in',
              detail: 'HATCHABOT_ALLOWED_EMAILS is unset, so anyone who can reach this machine can sign in with Google, become an account and run agents on your shared Claude sources. Set it to your household’s addresses (comma-separated) and restart.',
            },
      );
    }
    install.push(
      process.env.HATCHABOT_ALLOW_OWNER_HEADER === '1'
        ? {
            key: 'owner-header',
            level: 'critical',
            title: 'HATCHABOT_ALLOW_OWNER_HEADER is ON',
            detail: 'The x-hatchabot-owner header forges ownership. Never set this in production — unset it.',
          }
        : { key: 'owner-header', level: 'ok', title: 'Owner-header spoof disabled', detail: 'x-hatchabot-owner is not honored.' },
    );

    // A shared machine-login source would mount the operator's ~/.claude into
    // another account's container — the headline family-member risk. (Now
    // guarded at the share toggle, so this should always be clean.)
    const sharedMachineLogin = store
      .listAIProfiles(ownerId)
      .filter((p) => p.shared && p.kind === 'subscription' && !p.secretRef);
    install.push(
      sharedMachineLogin.length
        ? {
            key: 'shared-machine-login',
            level: 'critical',
            title: `${sharedMachineLogin.length} machine-login source(s) marked Shared`,
            detail:
              `Sharing "${sharedMachineLogin.map((p) => p.name).join(', ')}" mounts your ~/.claude into other ` +
              'accounts’ containers. Un-share it and rotate the credential; share a setup-token source instead.',
          }
        : { key: 'shared-machine-login', level: 'ok', title: 'No machine-login source is shared', detail: 'Shared Claude access is setup-token/API-key only.' },
    );

    const cap = envNum('HATCHABOT_MAX_AGENTS_PER_ACCOUNT', 0);
    install.push(
      cap > 0
        ? { key: 'agent-cap', level: 'ok', title: `Per-account agent cap: ${cap}`, detail: 'Bounds how many live agents one account can run.' }
        : {
            key: 'agent-cap',
            level: 'warn',
            title: 'No per-account agent cap',
            detail: 'HATCHABOT_MAX_AGENTS_PER_ACCOUNT is unset — one account can spawn unlimited agents. Set it before adding members.',
          },
    );

    // A machine-login Claude source mounts the owner's real ~/.claude
    // read-write into their agents: an agent talked into writing a hook there
    // runs it as the owner next time they use Claude Code on the machine.
    // New ones are no longer offered (26th audit); an old one is a finding.
    const machineLogin = store.listAllAIProfiles().filter((p) => p.kind === 'subscription' && !p.secretRef);
    if (machineLogin.length) {
      install.push({
        key: 'machine-login-source',
        level: 'warn',
        title: `Claude source${machineLogin.length > 1 ? 's' : ''} using this machine's login: ${machineLogin.map((p) => p.name).join(', ')}`,
        detail: 'Its agents mount your ~/.claude read-write, so one could change files that run as you. Make a setup-token source (`claude setup-token`), move the agents to it, then delete this one.',
      });
    }

    // Fleet media/search keys are readable by every agent's owner from inside
    // their own container — informational, a deliberate shared-house credential.
    const refs = new Set(store.listSecretRefs('media/%')); // presence only, never the value
    const fleetKeys: string[] = [];
    if (refs.has('media/gemini-api-key')) fleetKeys.push('Gemini');
    if (refs.has('media/brave-api-key')) fleetKeys.push('Brave');
    if (fleetKeys.length) {
      install.push({
        key: 'fleet-keys',
        level: 'info',
        title: `Shared fleet key(s): ${fleetKeys.join(', ')}`,
        detail: 'Injected into every agent — any member can read these from their own container. Unset if that’s not acceptable.',
      });
    }
  }

  // Per-agent exposure (the caller's own agents).
  const agents: AgentExposure[] = [];
  const disks = store.agentDiskBytes();
  const warnBytes = diskWarnBytes();
  const overDisk: NonNullable<PostureReport['limits']['overDisk']> = [];
  for (const a of store.listAgents(ownerId)) {
    if (a.state === 'ARCHIVED') continue;
    // Who can reach it, on any chat app or in its web chat (HB-0575): counting
    // Telegram alone left four Discord guests out, so a powerful agent shared
    // there read "medium". The list below names them by the same rule.
    const reach = store.listMemberships(a.id)
      .filter((m) => m.status === 'active')
      .map((m) => {
        const ids = store.memberIdentities(a.id, m.userId);
        const channels = [
          ...(m.channelUserId ? ['telegram'] : []),
          ...Object.keys(ids).filter((k) => k !== 'telegram'),
          ...(m.webChat ? ['web chat'] : []),
        ];
        return { m, channels };
      });
    const audienceCount = reach.filter((r) => r.channels.length).length;
    // No setting is the default the build writes (configWriter.ts): any group,
    // the people it admits, once its Telegram bot admits someone. Read as
    // `off`, the page said such an agent was in no group (HB-1093).
    const group = a.groupAccess?.mode
      ?? (store.getChannelForAgent(a.id, 'telegram') && store.listAllowedChannelUserIds(a.id).length ? 'members' : 'off');
    const wideAudience = audienceCount >= 3 || group === 'room' || group === 'members';

    const capabilities: string[] = [];
    // Send-email capability: a connection attached with sending NOT blocked,
    // that holds Gmail (HB-0600). A calendar-only one sends nothing. One with no
    // services recorded is taken as able to: this page must not understate.
    for (const c of store.listAgentConnections(a.id)) {
      if (c.gmailNoSend) continue;
      const conn = store.getConnection(c.connectionId);
      if (!conn?.email) continue;
      if (conn.services.length && !conn.services.includes('gmail')) continue;
      capabilities.push(`send email as ${conn.email}`);
    }
    const rwMount = store.listDataSources(a.id).some((d) => d.kind === 'folder' && d.access === 'rw');
    if (rwMount) capabilities.push('read-write host folder');
    if (a.sharedMemory) capabilities.push('shared memory');
    // Its own browser (docs/browser.md): it reads and acts on pages anyone
    // wrote. No private addresses, and without saved logins not a powerful
    // capability on its own; listed so the page does not leave it out (HB-0675).
    // Keeping its logins it can act as its owner on those sites (HB-0680): powerful.
    const keeps = a.browser === true && !!a.browserLogins;
    if (a.browser === true) capabilities.push(keeps ? 'its own browser, keeps logins' : 'its own browser');

    const powerful = capabilities.some(isPowerful);
    let exposure: AgentExposure['exposure'] = 'low';
    const reasons: string[] = [];
    if (wideAudience) reasons.push(group !== 'off' ? `group chat (${group})` : `${audienceCount} people can message it`);
    if (powerful) reasons.push('has a powerful capability');
    if (wideAudience && powerful) exposure = 'high';
    else if (wideAudience || powerful) exposure = 'medium';

    // Name them. An active membership with no chat app bound yet and no web
    // chat is someone invited who has not messaged the bot — worth showing as
    // pending rather than counting as access they do not have.
    const audience = reach
      .map(({ m, channels }) => ({
        name: m.displayName || (m.role === 'owner' ? 'You' : m.userId),
        role: m.role,
        channels,
        ...(channels.length ? {} : { pending: true }),
      }))
      .sort((x, y) => (x.role === 'owner' ? -1 : y.role === 'owner' ? 1 : x.name.localeCompare(y.name)));

    // The storage warning the Limits line has always promised, backed by the
    // daily measurement (2026-09-30). Not an exposure level: a full disk hurts
    // the machine, not who can reach the agent.
    const disk = disks.get(a.id);
    const over = disk && disk.bytes > warnBytes ? disk : undefined;
    if (over) {
      reasons.push(`uses ${gbLabel(over.bytes)} of storage (warning at ${gbLabel(warnBytes)})`);
      overDisk.push({ id: a.id, name: a.name, bytes: over.bytes, measuredAt: over.measuredAt });
    }

    agents.push({ id: a.id, name: a.name, audienceCount, group, capabilities, exposure, reasons, audience, ...(over ? { diskOverBytes: over.bytes } : {}) });
  }
  agents.sort((x, y) => ({ high: 0, medium: 1, low: 2 })[x.exposure] - ({ high: 0, medium: 1, low: 2 })[y.exposure]);

  const liveAgents = store.listAgents(ownerId).filter((a) => a.state !== 'ARCHIVED').length;
  return {
    install,
    agents,
    limits: {
      agentCap: envNum('HATCHABOT_MAX_AGENTS_PER_ACCOUNT', 0),
      liveAgents,
      diskWarnGB: envNum('HATCHABOT_AGENT_DISK_WARN_GB', 10),
      overDisk: overDisk.sort((x, y) => y.bytes - x.bytes),
    },
  };
}

/**
 * The measurement: du's own exit status, not cut's. A directory du could not
 * read made `du … 2>/dev/null | cut -f1` print a short total and exit 0, so
 * an incomplete count replaced a real one and was taken as fresh for 20
 * hours, which could clear a disk warning (HB-0943). bash runs it
 * (execShellOnVolume), so pipefail is there. In the C locale, so du's
 * complaints are in the English onlyVanished reads, whatever language the
 * image or its environment sets.
 */
export const DISK_MEASURE_SCRIPT = 'export LC_ALL=C; set -o pipefail; du -sb /home/node | cut -f1';

/**
 * du's complaint that a file it had listed was gone by the time it counted
 * it. On a busy volume (temp files, a kept browser profile) that happens on
 * many runs, and du then exits 1: the count is still whole, as of then, and
 * failing it left such a volume never measured, its disk warning stale. A
 * file it could not read (permission, an I/O error) still fails it.
 */
const VANISHED = /^du: (?:cannot access|cannot read directory|can't stat|can't open) .*: No such file or directory$/;
export function onlyVanished(stderr: string): boolean {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => VANISHED.test(l));
}

/**
 * Measure each agent's storage (its volume, `du -sb /home/node` on a read-only
 * one-shot mount — the same measurement the export estimate uses) and store it
 * for computePosture. Nothing did this until 2026-09-30, so "Disk warning at
 * 10 GB per agent" never warned. Sequential and skipped for an agent measured
 * within `maxAgeMs`, so the boot-time sweep after every deploy costs nothing
 * and the daily one is one short container per agent. A failed measurement
 * (runner offline, agent mid-rebuild, a directory du could not read) keeps
 * the previous one, and the next sweep tries again.
 */
export async function measureAgentDisks(deps: {
  store: Store;
  providerFor: (hostId: string) => RuntimeProvider;
  isBusy?: (agentId: string) => boolean;
  maxAgeMs?: number;
  now?: () => number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}): Promise<{ measured: number; failed: number }> {
  const now = deps.now ?? Date.now;
  const maxAge = deps.maxAgeMs ?? 20 * 3_600_000;
  const known = deps.store.agentDiskBytes();
  let measured = 0;
  let failed = 0;
  for (const a of deps.store.listAllActiveAgents()) {
    if ((a.state !== 'RUNNING' && a.state !== 'STOPPED') || !a.runtimeRef) continue;
    if (deps.isBusy?.(a.id)) continue;
    const last = known.get(a.id);
    if (last && now() - Date.parse(last.measuredAt) < maxAge) continue;
    try {
      const res = await deps.providerFor(a.hostId).execShellOnVolume(a.runtimeRef, DISK_MEASURE_SCRIPT, { readOnly: true });
      const out = res.stdout.trim();
      // Only a whole count replaces the last one: du stopped early, or could
      // not read part of the volume, is a failed measurement (HB-0943). Files
      // that went away while it counted leave it whole.
      if (res.timedOut || !/^\d+$/.test(out) || (res.code !== 0 && !onlyVanished(res.stderr))) {
        failed++;
        deps.log?.('security.disk_measure_failed', { agentId: a.id, code: res.code, ...(res.timedOut ? { timedOut: true } : {}), err: res.stderr.trim().slice(0, 200) });
        continue;
      }
      deps.store.setAgentDiskBytes(a.id, Number(out), new Date(now()).toISOString());
      measured++;
    } catch (err) {
      failed++;
      deps.log?.('security.disk_measure_failed', { agentId: a.id, err: String(err).slice(0, 200) });
    }
  }
  return { measured, failed };
}

/**
 * The set of ACTIVE risks in a report, as stable keys — for diffing one run
 * against the previous so a daily job can flag what newly appeared.
 */
export function riskKeys(report: PostureReport): string[] {
  const keys: string[] = [];
  for (const c of report.install) {
    if (c.level === 'warn' || c.level === 'critical') keys.push(`install:${c.key}:${c.level}`);
  }
  for (const a of report.agents) {
    if (a.exposure !== 'low') keys.push(`agent:${a.id}:${a.exposure}`);
    // Each powerful capability too: an agent already at high that gained
    // another (mail sending beside a browser that keeps its logins) stayed
    // `agent:<id>:high`, so the daily sweep saw no change (HB-1103).
    for (const c of a.capabilities) if (isPowerful(c)) keys.push(`agent:${a.id}:can:${c}`);
    if (a.diskOverBytes) keys.push(`disk:${a.id}`);
  }
  return keys.sort();
}

/**
 * The format of riskKeys, kept in each snapshot as a key of its own: 2 since
 * each powerful capability has a key (HB-1103). A snapshot of an older
 * format is no baseline: diffed against one, every capability "appeared"
 * on the upgrade day though nothing had changed. The first run in this
 * format is the baseline. (An older release that reads one of these shows
 * this key once, as resolved.)
 */
export const RISK_KEYS_FORMAT = 'format:2';
/** What a snapshot stores: the keys, marked with their format. */
export const snapshotOf = (keys: string[]): string[] => [RISK_KEYS_FORMAT, ...keys];
/** A stored snapshot as a baseline: its keys; 'older' for one of an older format, which is none; undefined when there is no snapshot. */
export function baselineOf(stored: string[] | undefined): { keys: string[] } | 'older' | undefined {
  if (!stored) return undefined;
  if (!stored.includes(RISK_KEYS_FORMAT)) return 'older';
  return { keys: stored.filter((k) => k !== RISK_KEYS_FORMAT) };
}

/** added = risks present now but not before; removed = the reverse. */
export function diffRisks(current: string[], previous: string[]): { added: string[]; removed: string[] } {
  const prev = new Set(previous);
  const cur = new Set(current);
  return {
    added: current.filter((k) => !prev.has(k)),
    removed: previous.filter((k) => !cur.has(k)),
  };
}

/**
 * Snapshot every owner's posture and log any NEWLY-appeared risk. Run daily
 * (and once at boot) so the operator sees "an agent gained send-email while
 * reachable by a group" without having to open the UI. Diffs against each
 * owner's most recent snapshot (today's, once there is one), then records today's.
 */
export function runPostureSweep(
  store: Store,
  opts: { authMode: 'password' | 'accounts' | 'identity'; log?: (event: string, detail: Record<string, unknown>) => void },
): void {
  const today = new Date().toISOString().slice(0, 10);
  // Against the newest snapshot INCLUDING today's: diffing against the day
  // before logged the same change again after every restart that day (the
  // Spark restarts at every deploy; night review, 2026-09-27).
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const hostOwner = store.localHostOwnerId();
  // The machine's owner always: the install-wide checks are theirs, agents
  // or not. Only owners with agents were swept, so a fresh or emptied
  // install never logged that any Google account could sign in (HB-1104).
  const owners = new Set(store.ownersWithAgents());
  if (hostOwner) owners.add(hostOwner);
  for (const ownerId of owners) {
    const report = computePosture(store, { ownerId, isHostOwner: ownerId === hostOwner, authMode: opts.authMode });
    const keys = riskKeys(report);
    const prev = baselineOf(store.latestPostureSnapshotBefore(ownerId, tomorrow));
    // None: everything found is new. One of an older key format: this run is the baseline.
    const changes = prev === 'older' ? { added: [] as string[], removed: [] as string[] } : prev ? diffRisks(keys, prev.keys) : { added: keys, removed: [] as string[] };
    store.upsertPostureSnapshot(ownerId, today, snapshotOf(keys));
    if (changes.added.length || changes.removed.length) {
      opts.log?.('security.posture_changed', { ownerId, added: changes.added, removed: changes.removed });
    }
  }
}
