import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';
import type { Agent } from '../domain/types.js';

/**
 * A live health probe of an agent's own OpenClaw gateway, via `health --json`.
 * Unlike Hatchabot's tracked state (RUNNING/STOPPED, updated by reconcile) this
 * asks the running gateway right now: is its event loop healthy, is the Telegram
 * channel actually connected, are any plugins erroring. If the gateway doesn't
 * answer at all, that itself is the signal — `reachable: false`.
 */
/**
 * Config lint via `openclaw doctor --lint --json`: read-only checks that catch
 * the silent degradations a gateway "healthy" can't — a search provider
 * disabled, a memory-search key missing, an auth profile gone stale. This is
 * the "so it doesn't go unnoticed" surface: the fleet dashboard sweeps it.
 *
 * Muted checks: warnings that are true of EVERY Hatchabot agent by
 * construction get counted but not listed — a warning on all agents forever
 * is noise that buries the finding that matters on one.
 */
// Mute only the ONE known-by-design warning, matched on checkId AND a message
// pattern — muting the whole checkId would hide any NEW finding doctor's
// security check ever reports (a world-readable creds file, an exposed port),
// on every agent, forever: exactly the silent-degradation class this exists
// to catch.
//
// Each pattern is the WHOLE text of one line of that warning (doctor makes a
// finding of each line), anchored at both ends: a keyword anywhere hid a new
// finding that merely named the token, such as a world-readable
// gateway.auth.token (A072). And nothing above a warning is ever muted.
const MUTED = [
  {
    // Hatchabot seeds gateway/bot tokens into openclaw.json on the private
    // volume by design. OpenClaw's collectPlaintextConfigSecretWarnings, line by line.
    checkId: 'core/doctor/security',
    patterns: [
      /^(?:WARNING: )?openclaw\.json contains plaintext secret-bearing config(?: fields)?\.?$/,
      /^Paths: [\w.*[\]-]+(?:, [\w.*[\]-]+)*(?: \(\+\d+ more\))?$/,
      /^Agents or workspace tools that can read config files may see these API keys\/tokens\.$/,
      /^Migrate them to SecretRefs with [^\n]*openclaw secrets configure[^\n]*, then verify with [^\n]*openclaw secrets audit --check[^\n]*\.$/,
      // An agent with a console binds "auto" inside its container, behind its
      // password or the doorman's proxy auth; the host publishes the port on
      // loopback only (configWriter.buildConfigCommands). The no-auth variant
      // is critical and never muted; any other bind still shows.
      /^(?:WARNING: )?Gateway bound to "auto" \(0\.0\.0\.0\) \(network-accessible\)\.$/,
    ],
  },
  {
    // Pairing devices straight to the gateway (OpenClaw's node hosting /
    // device-pair), which Hatchabot does not use. It says "loopback" even for
    // bind "auto". Wordings of 2026.9.6 and 2026.9.8.
    checkId: 'core/doctor/node-hosting-preconditions',
    patterns: [
      /^Gateway is only bound to loopback\. Set gateway\.bind=lan, enable tailscale serve, or configure plugins\.entries\.device-pair\.config\.publicUrl\.$/,
      /^Gateway is only bound to loopback\. Set gateway\.publicOrigin to your public HTTPS origin, configure plugins\.entries\.device-pair\.config\.publicUrl, enable tailscale serve, or set gateway\.bind=lan\.$/,
    ],
  },
];
const MUTABLE_SEVERITY = /^(?:warning|info)$/i;
function isMuted(f: { checkId?: unknown; severity?: unknown; message?: unknown }): boolean {
  const id = String(f.checkId ?? '');
  const msg = String(f.message ?? '').trim();
  if (!MUTABLE_SEVERITY.test(String(f.severity ?? ''))) return false;
  return MUTED.some((m) => m.checkId === id && m.patterns.some((p) => p.test(msg)));
}

export interface DoctorFinding {
  checkId: string;
  severity: string;
  message: string;
}

export interface DoctorLint {
  /** undefined when doctor's output couldn't be trusted (no boolean `ok`). */
  ok: boolean | undefined;
  checksRun: number;
  findings: DoctorFinding[];
  /** Known-by-design warnings hidden from the list (see MUTED_CHECKS). */
  mutedCount: number;
  /** Findings past the first 20 (the worst come first), not listed. */
  omittedCount: number;
}

/** Errors first, then warnings, then the rest: 20 notes no longer push an error off the list. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, fatal: 0, error: 0, warning: 1, warn: 1 };
const severityRank = (s: unknown) => (typeof s === 'string' && Object.hasOwn(SEVERITY_RANK, s.toLowerCase()) ? SEVERITY_RANK[s.toLowerCase()]! : 2);
export const LINT_SHOWN = 20;

export async function doctorLint(
  provider: RuntimeProvider,
  runtimeRef: string,
): Promise<DoctorLint | undefined> {
  try {
    const res = await provider.exec(runtimeRef, [
      'doctor', '--lint', '--json', '--non-interactive',
    ]);
    if (res.code !== 0 && !res.stdout.trim()) return undefined;
    const d = JSON.parse(res.stdout) as {
      ok?: boolean;
      checksRun?: number;
      findings?: Array<{ checkId?: string; severity?: string; message?: string }>;
    };
    const all = Array.isArray(d.findings) ? d.findings : [];
    // Stable sort: within a severity, doctor's own order (audit, 2026-10-22).
    const kept = all.filter((f) => !isMuted(f)).map((f, i) => ({ f, i }))
      .sort((a, b) => severityRank(a.f.severity ?? 'warning') - severityRank(b.f.severity ?? 'warning') || a.i - b.i).map((x) => x.f);
    return {
      // A parseable-but-empty/garbage response (e.g. `{}` or a future format
      // change) must not paint a confident green — mirror agentHealth: only a
      // real boolean counts, and require the run to have actually run checks.
      ok: typeof d.ok === 'boolean' ? d.ok : undefined,
      checksRun: typeof d.checksRun === 'number' ? d.checksRun : 0,
      findings: kept.slice(0, LINT_SHOWN).map((f) => ({
        checkId: String(f.checkId ?? ''),
        severity: String(f.severity ?? 'warning'),
        message: String(f.message ?? '').slice(0, 300),
      })),
      mutedCount: all.length - kept.length,
      omittedCount: Math.max(0, kept.length - LINT_SHOWN),
    };
  } catch {
    return undefined; // lint is a bonus — never fail the health probe over it
  }
}

export interface AgentHealth {
  reachable: boolean;
  status: 'healthy' | 'degraded' | 'unreachable';
  ok?: boolean;
  eventLoop?: { degraded: boolean; reasons: string[] };
  telegram?: {
    connected: boolean;
    running: boolean;
    lastError: string | null;
    reconnectAttempts: number;
    lastEventAt?: number;
    lastInboundAt?: number;
    lastOutboundAt?: number;
  };
  pluginErrors?: string[];
  /** Discord or Slack reporting itself not connected (Telegram has its own block above). */
  disconnected?: Array<'discord' | 'slack'>;
  checkedAt?: number;
}

/**
 * When the agent's AI source last answered it, and whether it has refused
 * since. The gateway probe never runs a model turn, so an expired or
 * rate-limited source still read "Responding" (2026-09-30). This reads what
 * the usage sampler already records from the agent's own calls: the newest
 * success, its refusals (429) and failed calls after it. No model turn, no
 * exec; as fresh as the last usage reading.
 */
export interface AiSourceHealth {
  name?: string;
  /** Its newest successful model call. */
  lastAnsweredAt?: string;
  /** The first refusal or failed call after that, when nothing has answered since. */
  refusingSince?: string;
  /** refused = rate-limited (429); failed = any other error (expired, out of credits, unreachable). */
  refusal?: 'refused' | 'failed';
}

export function aiSourceHealth(store: Store, agent: Agent): AiSourceHealth {
  // The source the container runs: a switch saved but not rebuilt yet still
  // calls the old one, and its refusals are why the agent cannot answer
  // (audit #052). The usage sampler files its calls there too.
  const source = agent.appliedProfileId ?? agent.aiProfileId;
  const profile = store.getAIProfile(source);
  const lastAnsweredAt = store.lastOkOn(agent.id, source);
  const since = lastAnsweredAt ?? '';
  const refused = store.limitHitsForAgent(agent.id, source, since)[0];
  // A slot is a five-minute bucket ("2026-09-25T01:25"): a failure in the
  // success's own slot cannot be ordered against it, so it is not counted.
  const failed = store.failedSlotsForAgent(agent.id, source, since.slice(0, 16))[0];
  const first = [refused, failed].filter((x): x is string => !!x).sort()[0];
  return {
    name: profile?.name,
    lastAnsweredAt,
    ...(first ? { refusingSince: first.length === 16 ? `${first}:00.000Z` : first, refusal: first === refused ? 'refused' as const : 'failed' as const } : {}),
  };
}

export async function agentHealth(
  provider: RuntimeProvider,
  runtimeRef: string,
): Promise<AgentHealth> {
  // Bound the wait: a hung gateway would otherwise block on the CLI's 10s
  // default. A non-zero exit (or unparseable output) means it isn't answering.
  const res = await provider.exec(runtimeRef, ['health', '--json', '--timeout', '8000']);
  if (res.code !== 0) return { reachable: false, status: 'unreachable' };
  let h: Record<string, any>;
  try {
    h = JSON.parse(res.stdout);
  } catch {
    return { reachable: false, status: 'unreachable' };
  }
  // A report is an object; anything else is not a gateway answering.
  if (!h || typeof h !== 'object' || Array.isArray(h)) return { reachable: false, status: 'unreachable' };

  const tg = h.channels?.telegram;
  const telegram = tg
    ? {
        connected: !!tg.connected,
        running: !!tg.running,
        lastError: typeof tg.lastError === 'string' ? tg.lastError : null,
        reconnectAttempts: typeof tg.reconnectAttempts === 'number' ? tg.reconnectAttempts : 0,
        lastEventAt: typeof tg.lastEventAt === 'number' ? tg.lastEventAt : undefined,
        lastInboundAt: typeof tg.lastInboundAt === 'number' ? tg.lastInboundAt : undefined,
        lastOutboundAt: typeof tg.lastOutboundAt === 'number' ? tg.lastOutboundAt : undefined,
      }
    : undefined;
  const eventLoop = h.eventLoop
    ? { degraded: !!h.eventLoop.degraded, reasons: Array.isArray(h.eventLoop.reasons) ? h.eventLoop.reasons.map(String) : [] }
    : undefined;
  const pluginErrors = Array.isArray(h.plugins?.errors) ? h.plugins.errors.map(String) : [];
  // Discord and Slack count too: a bot that lost its connection read healthy (review,
  // 2026-10-22). Only a stated `connected: false`; a report without it says nothing.
  const disconnected = (['discord', 'slack'] as const).filter((k) => h.channels?.[k] && typeof h.channels[k] === 'object' && h.channels[k].connected === false);

  // Healthy needs evidence: its own verdict, or the event loop or channels
  // it reports on. An empty answer ({}) said nothing, and read as healthy (#113).
  const evidence = typeof h.ok === 'boolean' || !!eventLoop || (!!h.channels && typeof h.channels === 'object');
  const degraded =
    !evidence ||
    h.ok === false ||
    !!eventLoop?.degraded ||
    (telegram ? !telegram.connected : false) ||
    disconnected.length > 0 ||
    pluginErrors.length > 0;

  return {
    reachable: true,
    status: degraded ? 'degraded' : 'healthy',
    // Only echo the gateway's self-report when it actually made one — coercing a
    // missing value to false produced a contradictory {status:'healthy', ok:false}.
    ok: typeof h.ok === 'boolean' ? h.ok : undefined,
    eventLoop,
    telegram,
    pluginErrors,
    ...(disconnected.length ? { disconnected } : {}),
    checkedAt: typeof h.ts === 'number' ? h.ts : undefined,
  };
}
