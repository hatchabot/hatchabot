import type { RuntimeProvider } from '../providers/provider.js';

/**
 * A live health probe of an agent's own OpenClaw gateway, via `health --json`.
 * Unlike AgentClaw's tracked state (RUNNING/STOPPED, updated by reconcile) this
 * asks the running gateway right now: is its event loop healthy, is the Telegram
 * channel actually connected, are any plugins erroring. If the gateway doesn't
 * answer at all, that itself is the signal — `reachable: false`.
 */
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
    ok: !!h.ok,
    eventLoop,
    telegram,
    pluginErrors,
    checkedAt: typeof h.ts === 'number' ? h.ts : undefined,
  };
}
