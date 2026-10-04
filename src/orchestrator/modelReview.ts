import { createHash } from 'node:crypto';
import type { Agent } from '../domain/types.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';
import { addCron, cronTargetFor, deleteCron, listCrons } from './crons.js';
import { OPS_MODEL_REVIEW_MESSAGE } from '../ops/opsAgent.js';

/**
 * The management agent's weekly review (docs/features.md, "Right-size" and
 * "Token steward"; its task keeps the name "Weekly model review"):
 * an ordinary scheduled task on the agent, made by Hatchabot when the agent is
 * built, delivered the way the agent already reaches its owner (its Telegram
 * chat if it has one, else its console conversation). HATCHABOT_MODEL_REVIEW=off
 * takes it away again on the next build.
 *
 * Made ONCE: the managed_crons row remembers it, so a build costs no CLI call
 * once it exists, and an owner who deletes the task by hand is not argued with
 * on every rebuild (the setting is the way to turn it off for good).
 */
export const MODEL_REVIEW_NAME = 'Weekly model review';
/** Mondays at 09:00, the machine's time zone. */
export const MODEL_REVIEW_CRON = '0 9 * * 1';

export type ModelReviewSetting = 'weekly' | 'off';
/** Which wording a task was made with: a new release's wording reaches an existing task at the agent's next build. */
export const reviewMessageHash = (message = OPS_MODEL_REVIEW_MESSAGE): string => createHash('sha256').update(message).digest('hex').slice(0, 16);
export function modelReviewSetting(raw = process.env.HATCHABOT_MODEL_REVIEW): ModelReviewSetting {
  const v = (raw ?? '').trim().toLowerCase();
  return ['off', '0', 'false', 'no', 'never'].includes(v) ? 'off' : 'weekly';
}

export async function syncModelReviewCron(
  deps: { store: Store; provider: RuntimeProvider; log?: (event: string, detail: Record<string, unknown>) => void },
  agent: Pick<Agent, 'id' | 'ownerId' | 'slug' | 'ops'>,
  runtimeRef: string,
  setting: ModelReviewSetting = modelReviewSetting(),
): Promise<'created' | 'present' | 'kept' | 'updated' | 'removed' | 'off' | 'failed' | 'skipped'> {
  if (!agent.ops) return 'skipped';
  const { store, provider } = deps;
  const mine = store.managedCron(agent.id, MODEL_REVIEW_NAME);
  const now = new Date().toISOString();
  if (setting === 'off') {
    if (!mine) return 'off';
    const jobs = await listCrons(provider, runtimeRef, agent.slug).catch(() => undefined);
    if (!jobs) return 'failed';
    const job = jobs.find((j) => (mine.jobId && j.id === mine.jobId) || j.name === MODEL_REVIEW_NAME);
    if (job && !(await deleteCron(provider, runtimeRef, job.id).catch(() => false))) return 'failed';
    store.deleteManagedCron(agent.id, MODEL_REVIEW_NAME);
    deps.log?.('schedule.model_review_removed', { agentId: agent.id });
    return 'removed';
  }
  const hash = reviewMessageHash();
  // The wording of a task made by an earlier release (the model review became
  // the token review in v2.120): edited in place, once. A task the owner
  // deleted by hand stays deleted, and is not argued with about its wording.
  const reword = async (jobId: string): Promise<boolean | 'gone'> => {
    const res = await provider.exec(runtimeRef, ['cron', 'edit', jobId, '--message', OPS_MODEL_REVIEW_MESSAGE]).catch(() => undefined);
    if (!res) return false;
    if (res.code === 0) return true;
    return /not found|unknown|no such|does not exist/i.test(`${res.stderr}${res.stdout}`) ? 'gone' : false;
  };
  if (mine) {
    if (mine.messageHash === hash || !mine.jobId) return 'kept';
    const r = await reword(mine.jobId);
    if (r === false) return 'failed';
    store.setManagedCron(agent.id, MODEL_REVIEW_NAME, mine.jobId, mine.at, hash);
    if (r === true) deps.log?.('schedule.model_review_updated', { agentId: agent.id });
    return r === true ? 'updated' : 'kept';
  }
  const jobs = await listCrons(provider, runtimeRef, agent.slug).catch(() => undefined);
  if (!jobs) return 'failed';
  const there = jobs.find((j) => j.name === MODEL_REVIEW_NAME);
  if (there) {
    const r = await reword(there.id);
    store.setManagedCron(agent.id, MODEL_REVIEW_NAME, there.id, now, r === false ? undefined : hash);
    return 'present';
  }
  const out = await addCron(provider, runtimeRef, agent.slug, {
    name: MODEL_REVIEW_NAME,
    message: OPS_MODEL_REVIEW_MESSAGE,
    cron: MODEL_REVIEW_CRON,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
    deliverTo: cronTargetFor(store, agent),
  }).catch(() => ({ ok: false as const, error: 'exec failed' }));
  if (!out.ok) { deps.log?.('schedule.model_review_failed', { agentId: agent.id, error: out.error }); return 'failed'; }
  store.setManagedCron(agent.id, MODEL_REVIEW_NAME, out.id, now, hash);
  deps.log?.('schedule.model_review_created', { agentId: agent.id });
  return 'created';
}
