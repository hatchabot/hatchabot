import type { RuntimeProvider } from '../providers/provider.js';

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
const MUTED = [
  {
    // Hatchabot seeds gateway/bot tokens into openclaw.json on the private
    // volume by design.
    checkId: 'core/doctor/security',
    pattern: /plaintext|secret-bearing|SecretRef|API keys\/tokens|gateway\.auth\.token|botToken/i,
  },
];
function isMuted(f: { checkId?: unknown; message?: unknown }): boolean {
  const id = String(f.checkId ?? '');
  const msg = String(f.message ?? '');
  return MUTED.some((m) => m.checkId === id && m.pattern.test(msg));
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
}

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
    const kept = all.filter((f) => !isMuted(f));
    return {
      // A parseable-but-empty/garbage response (e.g. `{}` or a future format
      // change) must not paint a confident green — mirror agentHealth: only a
      // real boolean counts, and require the run to have actually run checks.
      ok: typeof d.ok === 'boolean' ? d.ok : undefined,
      checksRun: typeof d.checksRun === 'number' ? d.checksRun : 0,
      findings: kept.slice(0, 20).map((f) => ({
        checkId: String(f.checkId ?? ''),
        severity: String(f.severity ?? 'warning'),
        message: String(f.message ?? '').slice(0, 300),
      })),
      mutedCount: all.length - kept.length,
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
  checkedAt?: number;
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

  const degraded =
    h.ok === false ||
    !!eventLoop?.degraded ||
    (telegram ? !telegram.connected : false) ||
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
    checkedAt: typeof h.ts === 'number' ? h.ts : undefined,
  };
}
