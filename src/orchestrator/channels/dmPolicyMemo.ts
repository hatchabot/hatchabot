/**
 * What setDmPolicy last asserted on each agent's volume, so the pairing
 * sweep does not start a throwaway container per channel every five minutes
 * only to hear "unchanged" (about 39 per sweep, 572 of 574 runs changing
 * nothing — review, 2026-09-29).
 *
 * In memory on purpose: a restart simply asserts everything once more. An
 * entry is dropped whenever something else may have rewritten the config —
 * a provision, rebuild, restore, move or import (the seed writes the policy),
 * a start or wake, a member added or removed, a pairing window closing — and
 * it ages out after a few hours regardless, so a hand edit of openclaw.json
 * is still put right the same day.
 */
const MEMO_TTL_MS = 6 * 60 * 60_000;
const memo = new Map<string, { value: string; at: number }>();
const assertions = new Map<string, { pending: number; changed: boolean }>();

const keyOf = (t: { agentId: string; runtimeRef: string; kind: string; accountId: string }): string =>
  [t.agentId, t.runtimeRef, t.kind, t.accountId].join('\u0000');
const valueOf = (policy: string, admit: string[]): string => `${policy}|${[...admit].sort().join(',')}`;

/** Only an uninterrupted write may populate the memo. Concurrent writes can
 * finish on the volume in either order; after an overlap or invalidation the
 * next sweep must inspect the actual policy again. */
export function beginDmPolicyAssertion(t: { agentId: string; runtimeRef: string; kind: string; accountId: string }): () => boolean {
  const key = keyOf(t);
  let state = assertions.get(key);
  if (state) state.changed = true;
  else { state = { pending: 0, changed: false }; assertions.set(key, state); }
  state.pending++;
  memo.delete(key);
  let finished = false;
  return () => {
    if (finished) return false;
    finished = true;
    state.pending--;
    if (!state.pending) assertions.delete(key);
    return !state.changed;
  };
}

export function dmPolicyAsserted(
  t: { agentId: string; runtimeRef: string; kind: string; accountId: string },
  policy: string, admit: string[], now = Date.now(),
): boolean {
  const m = memo.get(keyOf(t));
  return !!m && m.value === valueOf(policy, admit) && now - m.at < MEMO_TTL_MS;
}

export function rememberDmPolicy(
  t: { agentId: string; runtimeRef: string; kind: string; accountId: string },
  policy: string, admit: string[], now = Date.now(),
): void {
  memo.set(keyOf(t), { value: valueOf(policy, admit), at: now });
}

export function forgetDmPolicyEntry(t: { agentId: string; runtimeRef: string; kind: string; accountId: string }): void {
  const key = keyOf(t);
  memo.delete(key);
  const state = assertions.get(key);
  if (state) state.changed = true;
}

/** Something may have rewritten this agent's channel config: assert it afresh next time. */
export function forgetDmPolicy(agentId: string): void {
  const prefix = `${agentId}\u0000`;
  for (const k of memo.keys()) if (k.startsWith(prefix)) memo.delete(k);
  for (const [k, state] of assertions) if (k.startsWith(prefix)) state.changed = true;
}
