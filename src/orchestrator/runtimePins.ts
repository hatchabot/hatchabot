/**
 * Stale runtime pins. Before setup tokens, a subscription agent ran its turns
 * through the Claude Code CLI (`agentRuntime: claude-cli` on its models), and
 * OpenClaw pins that runtime on every session it served. The pin outlives the
 * switch: a rebuild re-seeds the config (token profile, no claude-cli runtime)
 * but the sessions keep asking for the CLI, which is no longer logged in —
 * "Not logged in · Please run /login" (one agent, 2026-09-27, silent
 * since 09-11; four agents on the Spark). OpenClaw's doctor sees it ("stale
 * Anthropic session routing state") but repairs it only at a prompt, and the
 * seed runs it non-interactively.
 *
 * So, once the gateway answers: every session pinned to a runtime the config no
 * longer names is patched back to configured routing (`agentRuntime: null`).
 * Pins the config still names (a machine-login profile does ride claude-cli)
 * and locked sessions are left alone.
 */
import type { RuntimeProvider } from '../providers/provider.js';

export interface RuntimePin { key: string; runtime: string; locked: boolean }
type Log = (event: string, detail: Record<string, unknown>) => void;

interface ListedSession {
  key?: string;
  runtimeSelectionLocked?: boolean;
  agentRuntime?: string | { id?: string; source?: string } | null;
}

/** Sessions whose own entry names a runtime (OpenClaw calls an unpinned one `implicit`). */
export async function listRuntimePins(provider: RuntimeProvider, runtimeRef: string, slug: string): Promise<RuntimePin[]> {
  const res = await provider.exec(runtimeRef,
    ['gateway', 'call', 'sessions.list', '--json', '--params', JSON.stringify({ agentId: slug, limit: 500 })],
    { timeoutMs: 30_000 });
  if (res.code !== 0) throw new Error(`sessions.list failed: ${(res.stderr || res.stdout).slice(0, 200)}`);
  const body = JSON.parse(res.stdout) as { sessions?: ListedSession[] };
  const out: RuntimePin[] = [];
  for (const s of body.sessions ?? []) {
    if (!s.key) continue;
    const rt = s.agentRuntime;
    const id = typeof rt === 'string' ? rt : rt?.id;
    const source = typeof rt === 'string' ? 'session-key' : rt?.source;
    if (!id || source === 'implicit') continue;
    out.push({ key: s.key, runtime: id, locked: s.runtimeSelectionLocked === true });
  }
  return out;
}

/** The runtimes the config names on its models — plus OpenClaw's own, always fine. */
export async function configuredRuntimes(provider: RuntimeProvider, runtimeRef: string): Promise<Set<string>> {
  const ids = new Set(['openclaw']);
  const res = await provider.exec(runtimeRef, ['config', 'get', 'agents.defaults.models', '--json'], { timeoutMs: 30_000 });
  if (res.code !== 0) return ids;
  try {
    const models = JSON.parse(res.stdout) as Record<string, { agentRuntime?: { id?: string } } | null>;
    for (const m of Object.values(models ?? {})) if (m?.agentRuntime?.id) ids.add(m.agentRuntime.id);
  } catch { /* an unreadable config names nothing extra */ }
  return ids;
}

/** Patch every stale pin back to configured routing. Returns the session keys it cleared. */
export async function clearStaleRuntimePins(provider: RuntimeProvider, runtimeRef: string, slug: string, log: Log = () => {}): Promise<string[]> {
  const pins = (await listRuntimePins(provider, runtimeRef, slug)).filter((p) => !p.locked);
  if (!pins.length) return [];
  const allowed = await configuredRuntimes(provider, runtimeRef);
  const stale = pins.filter((p) => !allowed.has(p.runtime));
  const cleared: string[] = [];
  for (const p of stale) {
    const res = await provider.exec(runtimeRef,
      ['gateway', 'call', 'sessions.patch', '--json', '--params', JSON.stringify({ key: p.key, agentId: slug, agentRuntime: null })],
      { timeoutMs: 30_000 });
    let ok = false;
    try { ok = res.code === 0 && (JSON.parse(res.stdout) as { ok?: boolean }).ok === true; } catch { ok = false; }
    if (ok) cleared.push(p.key);
    else log('runtime.pin_failed', { session: p.key, runtime: p.runtime, error: (res.stderr || res.stdout).slice(0, 200) });
  }
  if (cleared.length) log('runtime.pins_cleared', { sessions: cleared, runtime: [...new Set(stale.map((p) => p.runtime))].join(', ') });
  return cleared;
}

/** The same, after a start or a wake: wait for the gateway first (up to ~2 min), then clear. Never throws. */
export async function clearStaleRuntimePinsWhenUp(provider: RuntimeProvider, runtimeRef: string, slug: string, log: Log = () => {},
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 24): Promise<string[]> {
  try {
    for (let i = 0; i < attempts; i++) {
      const st = await provider.status(runtimeRef).catch(() => undefined);
      if (st?.phase === 'running' && st.healthy) return await clearStaleRuntimePins(provider, runtimeRef, slug, log);
      if (st?.phase === 'stopped' || st?.phase === 'error') return [];
      await sleep(5000); // a fleet start is many of these at once: not one docker inspect a second each
    }
  } catch (err) {
    log('runtime.pin_failed', { error: String(err).slice(0, 200) });
  }
  return [];
}
