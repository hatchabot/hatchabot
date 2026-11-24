import { CURATED_SKILL_IDS } from '../../openclaw/skills.js';
import type { ExecResult, RuntimeProvider } from '../../providers/provider.js';

export type SkillInstructionStatus = 'available' | 'disabled' | 'blocked' | 'missing_requirements' | 'not_installed' | 'unavailable';
export type SkillDependencyKind = 'google_accounts' | 'browser' | 'web_tools' | 'jira_access' | 'image_generation';
export interface SkillDependencyStatus {
  kind: SkillDependencyKind;
  /** Configuration/presence only: never a successful account, browser or tool test. */
  status: 'present' | 'missing' | 'unchecked';
}
export interface SkillMissingRequirements {
  tools?: number;
  environment?: number;
  configuration?: number;
  platform?: number;
}
export interface CuratedSkillRuntimeStatus {
  id: string;
  /** available means the instructions are visible to this agent, not tested. */
  status: SkillInstructionStatus;
  missing?: SkillMissingRequirements;
  dependencies: SkillDependencyStatus[];
}
export interface SkillsStatus {
  status: 'checked' | 'unavailable' | 'unsupported';
  skills: CuratedSkillRuntimeStatus[];
}

type Reader = Pick<RuntimeProvider, 'exec' | 'execShell'>;
const TIMEOUT_MS = 30_000;
const DEPENDENCY_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ROWS = 2000;
const REQUIREMENT_KEYS = ['bins', 'anyBins', 'env', 'config', 'os'] as const;
const FLAGS = ['disabled', 'blockedByAllowlist', 'blockedByAgentFilter', 'eligible', 'modelVisible', 'platformIncompatible'] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function dependencies(id: string): SkillDependencyStatus[] {
  const kind = id === 'gog' ? 'google_accounts' : id === 'hatchabot-browser' ? 'browser' : id === 'hatchabot-research' ? 'web_tools'
    : id === 'hatchabot-jira' ? 'jira_access' : id === 'hatchabot-images' ? 'image_generation' : undefined;
  return kind ? [{ kind, status: 'unchecked' }] : [];
}
function unknown(status: SkillsStatus['status'] = 'unavailable'): SkillsStatus {
  return { status, skills: CURATED_SKILL_IDS.map((id) => ({ id, status: 'unavailable', dependencies: dependencies(id) })) };
}

/** Bound the helper even when a provider ignores its execution timeout. The
 * late read has no mutation to finish, and its rejection is still observed. */
async function bounded<T>(work: () => Promise<T>, timeoutMs: number): Promise<T | undefined> {
  if (timeoutMs <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } catch { return undefined; }
  finally { if (timer) clearTimeout(timer); }
}

function complete(result: ExecResult | undefined): result is ExecResult {
  return !!result && !result.timedOut && !result.unreachable && !result.signalled && !result.volumeMissing;
}
function payload(result: ExecResult | undefined): unknown {
  if (!complete(result) || result.code !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) return undefined;
  try { return JSON.parse(result.stdout); } catch { return undefined; }
}

function classify(entry: Record<string, unknown>): Pick<CuratedSkillRuntimeStatus, 'status' | 'missing'> {
  if (FLAGS.some((key) => typeof entry[key] !== 'boolean') || !record(entry.missing)) return { status: 'unavailable' };
  const missing = entry.missing;
  for (const key of REQUIREMENT_KEYS) {
    const values = missing[key];
    if (!Array.isArray(values) || values.length > 256 || !values.every((value) => nonempty(value) && value.length <= 512)) return { status: 'unavailable' };
  }
  const counts: SkillMissingRequirements = {};
  // anyBins is one requirement satisfied by any of its alternatives.
  const tools = (missing.bins as string[]).length + ((missing.anyBins as string[]).length ? 1 : 0);
  if (tools) counts.tools = tools;
  if ((missing.env as string[]).length) counts.environment = (missing.env as string[]).length;
  if ((missing.config as string[]).length) counts.configuration = (missing.config as string[]).length;
  if ((missing.os as string[]).length) counts.platform = (missing.os as string[]).length;
  const unmet = Object.keys(counts).length > 0;
  // Contradictory fields cannot establish visibility. These relationships
  // follow buildSkillStatus in the pinned 2026.9.8 gateway.
  if (entry.platformIncompatible !== !!counts.platform ||
      (entry.eligible && (entry.disabled || entry.blockedByAllowlist || unmet)) ||
      (entry.modelVisible && (!entry.eligible || entry.blockedByAgentFilter))) return { status: 'unavailable' };
  if (entry.disabled) return { status: 'disabled' };
  if (entry.blockedByAllowlist || entry.blockedByAgentFilter) return { status: 'blocked' };
  if (unmet) return { status: 'missing_requirements', missing: counts };
  if (entry.eligible && entry.modelVisible) return { status: 'available' };
  return { status: 'blocked' };
}

function project(value: unknown, slug: string): SkillsStatus {
  if (!record(value) || (value.ok !== undefined && value.ok !== true) || value.error !== undefined || value.agentId !== slug ||
      !Array.isArray(value.skills) || value.skills.length > MAX_ROWS) return unknown();
  // A malformed identity must not be silently interpreted as "not installed".
  if (value.skills.some((entry) => !record(entry) || !nonempty(entry.name) || !nonempty(entry.skillKey))) return unknown();
  const entries = value.skills as Record<string, unknown>[];
  return {
    status: 'checked',
    skills: CURATED_SKILL_IDS.map((id) => {
      const matches = entries.filter((entry) => entry.name === id || entry.skillKey === id);
      const entry = matches[0];
      // Custom names/skillKey overrides and duplicate identities are ambiguous;
      // never report another card's visibility as the curated skill's status.
      const state = !matches.length ? { status: 'not_installed' as const }
        : matches.length !== 1 || entry!.name !== id || entry!.skillKey !== id ? { status: 'unavailable' as const }
        : classify(entry!);
      return { id, ...state, dependencies: dependencies(id) };
    }),
  };
}

/** Read-only inventory for the named agent. This is neither a skill execution
 * nor a network/login test. Only fixed curated IDs, enums and counts escape;
 * runtime paths, custom descriptions, account identities and raw errors do not.
 * tools.effective requires a sessionKey, so web-tool dependencies remain
 * unchecked rather than guessing which conversation's policy applies. */
export async function readSkillsStatus(provider: Reader, runtimeRef: string, slug: string): Promise<SkillsStatus> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return unknown();
  const deadline = Date.now() + TIMEOUT_MS;
  const result = await bounded(() => provider.exec(runtimeRef,
    ['gateway', 'call', 'skills.status', '--params', JSON.stringify({ agentId: slug }), '--json'],
    { timeoutMs: TIMEOUT_MS }), TIMEOUT_MS);
  if (!complete(result)) return unknown();
  if (result.code !== 0) {
    const absent = /\b(?:unknown method|method not found):\s*['"]?skills\.status(?:['"]|(?=\s|$))/i;
    return unknown(absent.test(`${result.stderr}\n${result.stdout}`) ? 'unsupported' : 'unavailable');
  }
  const status = project(payload(result), slug);
  if (status.status !== 'checked') return status;
  const tasks: Promise<void>[] = [];
  for (const skill of status.skills) {
    if (skill.status !== 'available') continue;
    const timeoutMs = Math.min(DEPENDENCY_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
    if (!timeoutMs) continue;
    if (skill.id === 'gog') tasks.push((async () => {
      // Same read-only account-list command as googleConnections.gogAccounts;
      // stricter projection here returns presence only, never account names.
      const result = await bounded(() => provider.execShell(runtimeRef,
        '~/.local/bin/gog auth list --json 2>/dev/null || gog auth list --json 2>/dev/null',
        { timeoutMs }), timeoutMs);
      const value = payload(result);
      if (!record(value) || (value.ok !== undefined && value.ok !== true) || value.error !== undefined || !Array.isArray(value.accounts) || value.accounts.length > 256 ||
          !value.accounts.every((account) => record(account) && nonempty(account.email))) return;
      skill.dependencies[0]!.status = value.accounts.length ? 'present' : 'missing';
    })());
    if (skill.id === 'hatchabot-browser') tasks.push((async () => {
      const result = await bounded(() => provider.exec(runtimeRef,
        ['config', 'get', 'browser.enabled', '--json'], { timeoutMs }), timeoutMs);
      const value = payload(result);
      if (typeof value === 'boolean') skill.dependencies[0]!.status = value ? 'present' : 'missing';
    })());
  }
  await Promise.all(tasks);
  return status;
}
