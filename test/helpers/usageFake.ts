/** What the in-container usage reader would print for these calls (orchestrator/usage.ts). */
export interface FakeCall { model?: string; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; session?: string; at?: number }
export function fakeUsage(calls: FakeCall[]): { models: Record<string, { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; sessions: number }>; sessions: number; first: number; last: number } {
  const models: Record<string, { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; s: Set<string> }> = {};
  const sessions = new Set<string>(); let first = Infinity, last = 0;
  for (const c of calls) {
    const m = models[c.model ?? 'claude-opus-4-8'] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, s: new Set() };
    m.calls++; m.input += c.input ?? 0; m.output += c.output ?? 0; m.cacheRead += c.cacheRead ?? 0; m.cacheWrite += c.cacheWrite ?? 0;
    const sid = c.session ?? 's1'; m.s.add(sid); sessions.add(sid);
    if (c.at !== undefined) { first = Math.min(first, c.at); last = Math.max(last, c.at); }
  }
  const out: Record<string, { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; sessions: number }> = {};
  for (const [k, m] of Object.entries(models)) out[k] = { calls: m.calls, input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, sessions: m.s.size };
  return { models: out, sessions: sessions.size, first: first === Infinity ? 0 : first, last };
}
/** A total of `n` tokens as one call's input (for counter-style tests). */
export const totalOf = (n: number, at = 0) => fakeUsage([{ input: n, at }]);
