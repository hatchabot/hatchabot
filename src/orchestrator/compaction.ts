import { randomBytes } from 'node:crypto';
import type { Agent } from '../domain/types.js';
import type { ExecResult, RuntimeProvider } from '../providers/provider.js';
import type { Store, TokenActionRow } from '../store/store.js';
import type { TokenHealthRaw } from './usage.js';
import { modelOption } from './modelOptions.js';
import { parseLoopLines } from './loopLines.js';
import { OPENCLAW_HANDLER_TIMEOUT_MS } from './channelTimeout.js';
import { modelRefOf, THRESHOLDS } from './tokenHealth.js';

/**
 * Compaction and the context cap: the token steward's two changes (docs/
 * features.md, "Token steward"). Both are cards the owner confirms; nothing
 * here runs on its own.
 *
 * COMPACTION. Hatchabot runs `openclaw sessions compact <key> --agent <slug>
 * --timeout 1800000 --json` itself in the agent's container — the gateway's
 * sessions.compact RPC — not a /compact in chat, which is held to the chat
 * app's handler limit (2026-10-04: Stock Advisor's 446K summary outran the
 * 5-minute limit and was retried every ~5 minutes for hours). Two modes:
 *   - summarise: the model writes a summary; minutes on a large conversation.
 *   - lines: `--max-lines N`, keep the last N transcript lines; seconds.
 * The in-flight retry problem: while a chat-app retry of a /compact is
 * looping, each retry starts the same compaction again and aborts whatever
 * compaction is running ("aborted | user_abort", 2026-10-04). So when the
 * agent's channel retry is looping: `lines` runs at once (it finishes long
 * before the next retry, and the retried /compact then has a small transcript
 * and completes); `summarise` waits for the next stall — the moment OpenClaw
 * has just aborted the retry's own attempt — and starts right after it, and
 * says plainly if the next retry aborted it anyway.
 *
 * THE CONTEXT CAP. OpenClaw compacts a conversation before a turn when it
 * reaches its context budget less a reserve (20K, at most a quarter); the
 * budget is the model's window (1M on Opus 4.8 and Sonnet 5) unless the
 * model's entry under models.providers.<provider>.models[] carries
 * `contextTokens` (the 2026-10-04 test: 150,000 on Sonnet 5 = compaction at
 * 130K). Hatchabot stores the cap per agent and writes that one entry for the
 * model the agent runs — at once if it is running (a hot reload), at every
 * rebuild, and again when its model changes — through `openclaw config set
 * … --expect-current-json`, so a hand edit made meanwhile is never overwritten.
 */

/** The RPC's own timeout: 30 minutes, the channel limit Hatchabot gives agents. */
export const COMPACT_TIMEOUT_MS = 1_800_000;
/** How long the summarise mode waits for a looping retry's next stall before it starts anyway. */
const STALL_WAIT_SLACK_MS = 4 * 60_000;
/** A compaction refused because the session is busy is tried again this many times, a minute apart. */
const BUSY_RETRIES = 3;

export type CompactMode = 'summarise' | 'lines';
export const mainSessionKey = (slug: string): string => `agent:${slug}:main`;

export function compactArgv(slug: string, key: string, mode: CompactMode, lines?: number): string[] {
  return ['sessions', 'compact', key, '--agent', slug, '--timeout', String(COMPACT_TIMEOUT_MS), '--json',
    ...(mode === 'lines' ? ['--max-lines', String(lines ?? THRESHOLDS.keepLines)] : [])];
}

export interface CompactResult {
  outcome: 'ok' | 'nothing' | 'busy' | 'aborted' | 'failed';
  tokensBefore?: number;
  tokensAfter?: number;
  kept?: number;
  reason?: string;
}

/** What `openclaw sessions compact --json` answered (2026.9.6: {ok, compacted, reason, result: {tokensBefore, tokensAfter}, kept}). */
export function parseCompactResult(res: ExecResult): CompactResult {
  const text = `${res.stdout}\n${res.stderr}`;
  let j: { ok?: boolean; compacted?: boolean; reason?: string; kept?: number; error?: string; result?: { tokensBefore?: number; tokensAfter?: number } } | undefined;
  for (const line of res.stdout.split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { j = JSON.parse(t); break; } catch { /* next */ }
  }
  if (!j) { try { j = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))); } catch { /* none */ } }
  const reason = String(j?.reason ?? j?.error ?? (res.stderr.trim().split('\n').pop() ?? '')).slice(0, 200) || undefined;
  if (/active run|queued work/i.test(text)) return { outcome: 'busy', ...(reason ? { reason } : {}) };
  if (/abort/i.test(text) && !(j?.ok && j.compacted)) return { outcome: 'aborted', ...(reason ? { reason } : {}) };
  if (res.code === 0 && j?.ok) {
    if (j.compacted === false) return { outcome: 'nothing', ...(reason ? { reason } : {}), ...(typeof j.kept === 'number' ? { kept: j.kept } : {}) };
    return {
      outcome: 'ok',
      ...(typeof j.result?.tokensBefore === 'number' ? { tokensBefore: j.result.tokensBefore } : {}),
      ...(typeof j.result?.tokensAfter === 'number' ? { tokensAfter: j.result.tokensAfter } : {}),
      ...(typeof j.kept === 'number' ? { kept: j.kept } : {}),
    };
  }
  return { outcome: 'failed', reason: res.timedOut ? 'it took longer than 30 minutes' : reason ?? `exit ${res.code}` };
}

export interface CompactDeps {
  store: Store;
  provider: RuntimeProvider;
  log?(event: string, detail: Record<string, unknown>): void;
  /** Tell the owner how a background compaction ended (the manager's chat). */
  tell?(ownerId: string, agent: Agent, text: string): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/** Whether the agent's chat-app retry is looping right now, from a fresh read of its log (and the watcher's incident). */
export async function retryLoopNow(deps: CompactDeps, agent: Agent, now = Date.now()): Promise<{ looping: boolean; lastStallAt?: number; limitMs: number; count: number }> {
  let marks: ReturnType<typeof parseLoopLines> = [];
  try { marks = parseLoopLines(await deps.provider.modelCallLog(agent.runtimeRef!, new Date(now - 30 * 60_000).toISOString())); } catch { /* the incident still says */ }
  const stalls = marks.filter((m) => m.kind === 'stall');
  const last = stalls[stalls.length - 1];
  const incident = deps.store.listTokenIncidents({ agentIds: [agent.id], open: true }).find((i) => i.kind === 'channel-retry');
  const lastStallAt = last ? Date.parse(last.at) : incident?.lastAt ? Date.parse(incident.lastAt) : undefined;
  const limitMs = last?.ms ?? OPENCLAW_HANDLER_TIMEOUT_MS;
  const fresh = lastStallAt !== undefined && now - lastStallAt <= THRESHOLDS.channelActiveMs;
  return { looping: fresh && (!!incident || stalls.length >= 2), ...(lastStallAt !== undefined ? { lastStallAt } : {}), limitMs, count: incident?.count ?? stalls.length };
}

/** Poll the log for the next stall after `afterMs`; its time, or undefined when none came in time. */
async function nextStall(deps: CompactDeps, agent: Agent, afterMs: number, waitMs: number): Promise<number | undefined> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const end = now() + waitMs;
  while (now() < end) {
    try {
      const stall = parseLoopLines(await deps.provider.modelCallLog(agent.runtimeRef!, new Date(afterMs).toISOString()))
        .find((m) => m.kind === 'stall' && Date.parse(m.at) > afterMs);
      if (stall) return Date.parse(stall.at);
    } catch { /* keep waiting */ }
    await sleep(5_000);
  }
  return undefined;
}

const inFlight = new Set<string>();
export const compactionRunning = (agentId: string): boolean => inFlight.has(agentId);

export interface CompactRequest {
  mode: CompactMode;
  lines?: number;
  session?: string;
  meta: Pick<TokenActionRow, 'by' | 'via'> & { why?: string; proposalId?: string };
}

const K = (n?: number) => (typeof n === 'number' ? `${Math.round(n / 1000)}K` : '?');

/**
 * Compact an agent's conversation (its main one unless `session` names
 * another of its own). Lines mode runs now and answers with the result; the
 * summarise mode runs in the background (minutes) and its result lands in the
 * token ledger, the agent's timeline and the owner's chat.
 */
export async function compactAgent(deps: CompactDeps, agent: Agent, req: CompactRequest): Promise<{ action: TokenActionRow; background: boolean; message: string }> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  if (!agent.runtimeRef || agent.state !== 'RUNNING') throw new CompactError(409, `"${agent.name}" is not running. Wake it first: compaction needs its gateway.`);
  if (inFlight.has(agent.id)) throw new CompactError(409, `A compaction of "${agent.name}" is already running.`);
  const key = req.session ?? mainSessionKey(agent.slug);
  if (!key.startsWith(`agent:${agent.slug}:`) || /:(cron|recovered|subagent):/.test(key) || key.length > 300) throw new CompactError(400, 'Only one of this agent\'s own conversations can be compacted.');
  const lines = req.mode === 'lines' ? Math.min(Math.max(Math.round(req.lines ?? THRESHOLDS.keepLines), 20), 5000) : undefined;
  const health = store.tokenHealths([agent.id]).get(agent.id)?.health as TokenHealthRaw | undefined;
  const beforeCtx = key === mainSessionKey(agent.slug) ? health?.main?.[agent.slug]?.ctx : undefined;
  // Claimed before the first await: added after the log read, two requests
  // that both passed the check above ran two compactions of one conversation
  // at once (concurrency review, 2026-10-09). Let go on every way out.
  inFlight.add(agent.id);
  let loop: Awaited<ReturnType<typeof retryLoopNow>>;
  try { loop = await retryLoopNow(deps, agent, now()); } catch (err) { inFlight.delete(agent.id); throw err; }
  const action: TokenActionRow = {
    id: `ta_${randomBytes(8).toString('hex')}`, agentId: agent.id, ownerId: agent.ownerId, kind: 'compaction', at: new Date(now()).toISOString(),
    by: req.meta.by, via: req.meta.via, ...(req.meta.why ? { why: req.meta.why.slice(0, 400) } : {}), ...(req.meta.proposalId ? { proposalId: req.meta.proposalId } : {}),
    detail: { mode: req.mode, ...(lines ? { lines } : {}), session: key === mainSessionKey(agent.slug) ? 'main' : 'other', ...(beforeCtx ? { beforeK: Math.round(beforeCtx / 1000) } : {}),
      ...(loop.looping ? { retryLoop: { count: loop.count, limitMs: loop.limitMs } } : {}) },
    outcome: 'running',
  };
  try { store.addTokenAction(action); } catch (err) { inFlight.delete(agent.id); throw err; }
  deps.log?.('token.compaction_started', { agentId: agent.id, mode: req.mode, retryLoop: loop.looping });

  const run = async (): Promise<CompactResult> => {
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let r: CompactResult = { outcome: 'failed' };
    for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
      const res = await deps.provider.exec(agent.runtimeRef!, compactArgv(agent.slug, key, req.mode, lines), { timeoutMs: COMPACT_TIMEOUT_MS + 60_000 });
      r = parseCompactResult(res);
      if (r.outcome !== 'busy' || attempt === BUSY_RETRIES) break;
      await sleep(60_000);
    }
    return r;
  };
  const finish = (r: CompactResult, extra: Record<string, unknown> = {}): TokenActionRow => {
    const detail = { ...action.detail, ...extra,
      ...(r.tokensBefore !== undefined ? { beforeK: Math.round(r.tokensBefore / 1000) } : {}),
      ...(r.tokensAfter !== undefined ? { afterK: Math.round(r.tokensAfter / 1000) } : {}),
      ...(r.kept !== undefined ? { keptLines: r.kept } : {}), ...(r.reason ? { reason: r.reason } : {}) };
    const outcome = r.outcome === 'nothing' ? 'ok' : r.outcome;
    store.updateTokenAction(action.id, { detail, outcome });
    inFlight.delete(agent.id);
    deps.log?.('token.compaction_done', { agentId: agent.id, mode: req.mode, outcome, ...(r.tokensAfter !== undefined ? { afterK: Math.round(r.tokensAfter / 1000) } : {}) });
    return { ...action, detail, outcome };
  };

  if (req.mode === 'lines') {
    try {
      const r = await run();
      const done = finish(r);
      return { action: done, background: false, message: resultLine(agent.name, done) };
    } catch (err) { inFlight.delete(agent.id); throw err; }
  }

  // Summarise: minutes. In the background; when a retry is looping, right after its next stall.
  void (async () => {
    let waited: Record<string, unknown> = {};
    try {
      if (loop.looping) {
        const stall = await nextStall(deps, agent, Math.max(loop.lastStallAt ?? 0, now() - 1000), loop.limitMs + STALL_WAIT_SLACK_MS);
        waited = { startedAfterStall: !!stall };
      }
      const r = await run();
      const done = finish(r, waited);
      if (deps.tell) await deps.tell(agent.ownerId, agent, `🗜 Hatchabot: ${resultLine(agent.name, done)}`).catch(() => false);
    } catch (err) {
      finish({ outcome: 'failed', reason: String((err as Error)?.message ?? err).slice(0, 200) }, waited);
    }
  })();
  return {
    action, background: true,
    message: loop.looping
      ? `Compaction of "${agent.name}" will start right after its stuck message's next retry is cut off (within about ${Math.round(loop.limitMs / 60_000) + 4} minutes) and may take several minutes; if that retry aborts it again, keeping the last ${THRESHOLDS.keepLines} lines is the way through. The result goes to the owner's chat and the token ledger.`
      : `Compaction of "${agent.name}" started; summarising${beforeCtx ? ` a ${K(beforeCtx)} conversation` : ''} can take several minutes. The result goes to the owner's chat and the token ledger.`,
  };
}

export function resultLine(name: string, a: Pick<TokenActionRow, 'outcome' | 'detail'>): string {
  const d = a.detail as { mode?: string; beforeK?: number; afterK?: number; keptLines?: number; lines?: number; reason?: string };
  switch (a.outcome) {
    case 'ok':
      if (d.afterK !== undefined) return `Compacted "${name}": ${d.beforeK ?? '?'}K → ${d.afterK}K tokens.`;
      if (d.keptLines !== undefined || d.mode === 'lines') return `Compacted "${name}": kept the last ${d.keptLines ?? d.lines} lines${d.beforeK ? ` of a ${d.beforeK}K conversation` : ''}; its new size shows after its next turn.`;
      return `"${name}": nothing to compact${d.reason ? ` (${d.reason})` : ''}.`;
    case 'aborted': return `Compaction of "${name}" was aborted${d.reason ? ` (${d.reason})` : ''} — usually its stuck chat message's retry starting the same compaction again. Keeping the last ${THRESHOLDS.keepLines} lines takes seconds and gets through.`;
    case 'busy': return `"${name}" was busy answering, three times; nothing was compacted. Try again when it is quiet.`;
    default: return `Compaction of "${name}" failed${d.reason ? `: ${d.reason}` : ''}.`;
  }
}

export class CompactError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// ---------------------------------------------------------------------------
// The context cap
// ---------------------------------------------------------------------------

/** Reads one authored path of the agent's openclaw.json (not the catalog-completed view `config get` prints). */
const RAW_GET = `node -e 'const fs=require("fs");const d=process.env.OPENCLAW_STATE_DIR||(process.env.HOME+"/.openclaw");let v;try{v=JSON.parse(fs.readFileSync(d+"/openclaw.json","utf8"))}catch(e){process.stdout.write("ERR");process.exit(0)}for(const k of process.argv[1].split("."))v=v==null?undefined:v[k];process.stdout.write(v===undefined?"":JSON.stringify(v))'`;

type ProviderEntry = { models?: Array<Record<string, unknown>>; [k: string]: unknown };

/** The provider entry with the cap row for `model` set to `tokens` (or taken out when null), and `previous` (a model Hatchabot capped before) taken out. */
export function nextProviderEntry(current: ProviderEntry | undefined, model: string, tokens: number | null, previous?: string): ProviderEntry | undefined {
  const entry: ProviderEntry = { ...(current ?? {}) };
  let rows = Array.isArray(entry.models) ? entry.models.map((m) => ({ ...m })) : [];
  const strip = (id: string) => {
    rows = rows.flatMap((m) => {
      if (m.id !== id) return [m];
      const { contextTokens: _c, ...rest } = m;
      // A row Hatchabot made (id, name, the cap) goes; a richer hand-made one keeps everything but the cap.
      return Object.keys(rest).every((k) => k === 'id' || k === 'name') ? [] : [rest];
    });
  };
  if (previous && previous !== model) strip(previous);
  if (tokens === null) strip(model);
  else {
    const i = rows.findIndex((m) => m.id === model);
    const row = { ...(i >= 0 ? rows[i] : { id: model, name: modelOption(model)?.label ?? model }), contextTokens: tokens };
    if (i >= 0) rows[i] = row; else rows.push(row);
  }
  if (rows.length) entry.models = rows; else delete entry.models;
  return Object.keys(entry).length ? entry : undefined;
}

/**
 * Make the agent's openclaw.json say what Hatchabot stored: the cap on the
 * model it runs now, and no Hatchabot cap on any other. Runs on a RUNNING
 * container (never wakes one): at the change, at every rebuild, after a model
 * change. A local model's agent gets none (local calls are free).
 */
export async function syncContextCap(deps: { store: Store; provider: RuntimeProvider; log?(e: string, d: Record<string, unknown>): void }, agent: Agent, runtimeRef: string, now = Date.now()):
  Promise<'applied' | 'removed' | 'unchanged' | 'skipped' | 'changed-by-hand' | 'failed'> {
  const { store, provider } = deps;
  const cap = store.getContextCap(agent.id);
  if (!cap) return 'skipped';
  const profile = store.getAIProfile(agent.aiProfileId);
  if (!profile) return 'skipped';
  const { provider: p, id } = modelRefOf(agent, profile);
  const tokens = profile.vendor === 'local' ? null : cap.tokens ?? null;
  if (tokens === null && !cap.appliedModel) { store.markContextCapApplied(agent.id, null, new Date(now).toISOString()); return 'skipped'; }
  const path = `models.providers.${p}`;
  const read = await provider.execShell(runtimeRef, `${RAW_GET} ${path}`);
  if (read.code !== 0 || read.stdout.startsWith('ERR')) return 'failed';
  let current: ProviderEntry | undefined;
  try { current = read.stdout.trim() ? JSON.parse(read.stdout) as ProviderEntry : undefined; } catch { return 'failed'; }
  const previousProvider = cap.appliedModel?.includes('/') ? cap.appliedModel.split('/')[0] : undefined;
  const previous = cap.appliedModel ? cap.appliedModel.split('/').pop() : undefined;
  // A cap written for another provider's model (a source switch) comes off there first.
  if (previousProvider && previousProvider !== p && previous) {
    const other = await provider.execShell(runtimeRef, `${RAW_GET} models.providers.${previousProvider}`);
    try {
      const cur = other.stdout.trim() && !other.stdout.startsWith('ERR') ? JSON.parse(other.stdout) as ProviderEntry : undefined;
      const next = cur ? nextProviderEntry(cur, previous, null) : undefined;
      if (cur) await provider.exec(runtimeRef, next ? ['config', 'set', `models.providers.${previousProvider}`, JSON.stringify(next), '--strict-json', '--replace', '--expect-current-json', JSON.stringify(cur)] : ['config', 'unset', `models.providers.${previousProvider}`]);
    } catch { /* best effort */ }
  }
  const next = nextProviderEntry(current, id, tokens, previousProvider && previousProvider !== p ? undefined : previous);
  const at = new Date(now).toISOString();
  const applied = tokens === null ? null : `${p}/${id}`;
  if (JSON.stringify(next ?? null) === JSON.stringify(current ?? null)) { store.markContextCapApplied(agent.id, applied, at); return 'unchanged'; }
  const argv = next
    ? ['config', 'set', path, JSON.stringify(next), '--strict-json', '--replace', ...(current === undefined ? ['--expect-current-absent'] : ['--expect-current-json', JSON.stringify(current)])]
    : ['config', 'unset', path];
  const res = await provider.exec(runtimeRef, argv);
  if (res.code !== 0) {
    const byHand = /expect|current|mismatch|changed/i.test(`${res.stdout}${res.stderr}`);
    deps.log?.('token.context_cap_failed', { agentId: agent.id, byHand, error: `${res.stderr}${res.stdout}`.slice(0, 200) });
    return byHand ? 'changed-by-hand' : 'failed';
  }
  store.markContextCapApplied(agent.id, applied, at);
  deps.log?.('token.context_cap_applied', { agentId: agent.id, model: applied, tokens });
  return tokens === null ? 'removed' : 'applied';
}
