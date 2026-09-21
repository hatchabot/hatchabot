/**
 * Security posture check — a read-only snapshot of the install's configuration
 * risk, meant to be run repeatedly (a UI button + a daily job) as agents and
 * accounts are added. Distinct from the deep CODE audit: this finds risky
 * CONFIGURATION and drift, not bugs.
 *
 * The centrepiece is the per-agent Telegram EXPOSURE score — audience (how many
 * people can reach an agent) crossed with capability (what it can do) — because
 * Telegram is the one surface exposed to other people, and a hostile message to
 * a high-capability, wide-audience agent is where real damage happens.
 *
 * Pure DB reads (no Docker), so it's cheap enough to run on demand.
 */
import type { Store } from '../store/store.js';

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
}
export interface PostureReport {
  install: InstallCheck[];
  agents: AgentExposure[];
  limits: { agentCap: number; liveAgents: number; diskWarnGB: number };
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

  // Per-agent Telegram exposure (the caller's own agents).
  const agents: AgentExposure[] = [];
  for (const a of store.listAgents(ownerId)) {
    if (a.state === 'ARCHIVED') continue;
    const audienceCount = store.listAllowedChannelUserIds(a.id).length;
    const group = a.groupAccess?.mode ?? 'off';
    const wideAudience = audienceCount >= 3 || group === 'room' || group === 'members';

    const capabilities: string[] = [];
    // Send-email capability: a connection attached with sending NOT blocked.
    for (const c of store.listAgentConnections(a.id)) {
      if (!c.gmailNoSend) {
        const email = store.getConnection(c.connectionId)?.email;
        if (email) capabilities.push(`send email as ${email}`);
      }
    }
    const rwMount = store.listDataSources(a.id).some((d) => d.kind === 'folder' && d.access === 'rw');
    if (rwMount) capabilities.push('read-write host folder');
    if (a.sharedMemory) capabilities.push('shared memory');

    const powerful = capabilities.some((c) => c.startsWith('send email') || c === 'read-write host folder');
    let exposure: AgentExposure['exposure'] = 'low';
    const reasons: string[] = [];
    if (wideAudience) reasons.push(group !== 'off' ? `group chat (${group})` : `${audienceCount} people can message it`);
    if (powerful) reasons.push('has a powerful capability');
    if (wideAudience && powerful) exposure = 'high';
    else if (wideAudience || powerful) exposure = 'medium';

    // Name them. An active membership with no channel id bound yet is someone
    // invited who has not messaged the bot — worth showing as pending rather
    // than counting as access they do not have.
    const audience = store.listMemberships(a.id)
      .filter((m) => m.status === 'active')
      .map((m) => {
        const ids = store.memberIdentities(a.id, m.userId);
        const channels = [
          ...(m.channelUserId ? ['telegram'] : []),
          ...Object.keys(ids).filter((k) => k !== 'telegram'),
        ];
        return {
          name: m.displayName || (m.role === 'owner' ? 'You' : m.userId),
          role: m.role,
          channels,
          ...(channels.length ? {} : { pending: true }),
        };
      })
      .sort((x, y) => (x.role === 'owner' ? -1 : y.role === 'owner' ? 1 : x.name.localeCompare(y.name)));

    agents.push({ id: a.id, name: a.name, audienceCount, group, capabilities, exposure, reasons, audience });
  }
  agents.sort((x, y) => ({ high: 0, medium: 1, low: 2 })[x.exposure] - ({ high: 0, medium: 1, low: 2 })[y.exposure]);

  const liveAgents = store.listAgents(ownerId).filter((a) => a.state !== 'ARCHIVED').length;
  return {
    install,
    agents,
    limits: { agentCap: envNum('HATCHABOT_MAX_AGENTS_PER_ACCOUNT', 0), liveAgents, diskWarnGB: envNum('HATCHABOT_AGENT_DISK_WARN_GB', 10) },
  };
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
  }
  return keys.sort();
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
 * owner's most recent prior snapshot, then records today's.
 */
export function runPostureSweep(
  store: Store,
  opts: { authMode: 'password' | 'accounts' | 'identity'; log?: (event: string, detail: Record<string, unknown>) => void },
): void {
  const today = new Date().toISOString().slice(0, 10);
  const hostOwner = store.localHostOwnerId();
  for (const ownerId of store.ownersWithAgents()) {
    const report = computePosture(store, { ownerId, isHostOwner: ownerId === hostOwner, authMode: opts.authMode });
    const keys = riskKeys(report);
    const prev = store.latestPostureSnapshotBefore(ownerId, today);
    const changes = prev ? diffRisks(keys, prev) : { added: keys, removed: [] as string[] };
    store.upsertPostureSnapshot(ownerId, today, keys);
    if (changes.added.length || changes.removed.length) {
      opts.log?.('security.posture_changed', { ownerId, added: changes.added, removed: changes.removed });
    }
  }
}
