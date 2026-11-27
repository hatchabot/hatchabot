import { createHash } from 'node:crypto';
import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { addCron, cronTargetFor, deleteCron, listCrons } from '../schedules/crons.js';
import { OPS_MODEL_REVIEW_MESSAGE } from '../../ops/opsAgent.js';
import { agentTimeZone } from '../schedules/timezone.js';

/**
 * The management agent's weekly token review (docs/features.md, "Right-size"
 * and "Token steward"; called "Weekly model review" until v2.120):
 * an ordinary scheduled task on the agent, made by Hatchabot when the agent is
 * built, delivered the way the agent already reaches its owner (its Telegram
 * chat if it has one, else its console conversation). HATCHABOT_MODEL_REVIEW=off
 * takes it away again on the next build.
 *
 * Made ONCE: the managed_crons row remembers it, so a build costs no CLI call
 * once it exists, and an owner who deletes the task by hand is not argued with
 * on every rebuild (the setting is the way to turn it off for good). With the
 * setting off, each build reads the task list and removes one by its name.
 */
export const MODEL_REVIEW_NAME = 'Weekly token review';
/** Its name before v2.120: an existing task is found by it and renamed in place. */
export const LEGACY_REVIEW_NAME = 'Weekly model review';
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
  // The record under its current name, else under the name before v2.120.
  const current = store.managedCron(agent.id, MODEL_REVIEW_NAME);
  const legacy = current ? undefined : store.managedCron(agent.id, LEGACY_REVIEW_NAME);
  const mine = current ?? legacy;
  const remember = (jobId: string | undefined, at: string, hash?: string) => {
    store.setManagedCron(agent.id, MODEL_REVIEW_NAME, jobId, at, hash);
    if (legacy || store.managedCron(agent.id, LEGACY_REVIEW_NAME)) store.deleteManagedCron(agent.id, LEGACY_REVIEW_NAME);
  };
  const now = new Date().toISOString();
  const isOurs = (name?: string) => name === MODEL_REVIEW_NAME || name === LEGACY_REVIEW_NAME;
  if (setting === 'off') {
    // No record is not "no task": a volume imported or restored from an
    // install where it was on still holds it, and it would keep running (#126).
    // So the task list is read even then (a build with the review off only).
    const jobs = await listCrons(provider, runtimeRef, agent.slug).catch(() => undefined);
    if (!jobs) return mine ? 'failed' : 'off';
    // Every one: a volume imported or restored can hold the task under both
    // names, and removing one left the other running (B28, 2026-10-22).
    const ours = jobs.filter((j) => (mine?.jobId && j.id === mine.jobId) || isOurs(j.name));
    if (!mine && !ours.length) return 'off';
    for (const job of ours) {
      if (!(await deleteCron(provider, runtimeRef, job.id).catch(() => false))) return 'failed';
    }
    store.deleteManagedCron(agent.id, MODEL_REVIEW_NAME);
    store.deleteManagedCron(agent.id, LEGACY_REVIEW_NAME);
    deps.log?.('schedule.model_review_removed', { agentId: agent.id });
    return 'removed';
  }
  const hash = reviewMessageHash();
  // A task made by an earlier release: reworded IN PLACE (a patch — its
  // schedule, delivery and on/off stay as they are; never a second task), and
  // renamed only from the name before v2.120: a name the owner gave it by
  // hand is theirs, and stays (review of HB-1317). One the owner deleted by
  // hand stays deleted, and is not argued with.
  const update = async (jobId: string, fromLegacyName: boolean): Promise<boolean | 'gone'> => {
    const res = await provider.exec(runtimeRef, ['cron', 'edit', jobId, ...(fromLegacyName ? ['--name', MODEL_REVIEW_NAME] : []), '--message', OPS_MODEL_REVIEW_MESSAGE]).catch(() => undefined);
    if (!res) return false;
    if (res.code === 0) return true;
    return /not found|unknown|no such|does not exist/i.test(`${res.stderr}${res.stdout}`) ? 'gone' : false;
  };
  // A record that a restore marked (recorded after the copy the volume is
  // now) is not taken at its word: the task is looked for below (HB-1317).
  if (mine && !mine.afterCopy) {
    if (current && current.messageHash === hash) return 'kept';
    if (mine.jobId) {
      // Recorded under the old name: renamed only while the task still has
      // it, as the list says; one renamed by hand keeps the name it was
      // given (review of HB-1317). One more call, once: the record then
      // moves to the new name.
      let rename = false;
      if (legacy) {
        const jobs = await listCrons(provider, runtimeRef, agent.slug).catch(() => undefined);
        if (!jobs) return 'failed';
        rename = jobs.find((j) => j.id === mine.jobId)?.name === LEGACY_REVIEW_NAME;
      }
      const r = await update(mine.jobId, rename);
      if (r === false) return 'failed';
      remember(mine.jobId, mine.at, hash);
      if (r === true) deps.log?.('schedule.model_review_updated', { agentId: agent.id });
      return r === true ? 'updated' : 'kept';
    }
    // No id to edit it by. Outside a restore it is not looked for: a task the
    // owner made under the same name is not reworded as Hatchabot's (review
    // of HB-1317). One a restore marked (its wording mark taken off: the
    // copy's may be older) is found by its name below, and written again.
    if (mine.messageHash) { remember(undefined, mine.at, hash); return 'kept'; }
  }
  const jobs = await listCrons(provider, runtimeRef, agent.slug).catch(() => undefined);
  if (!jobs) return 'failed';
  // By its id first: one a restored copy holds under a name given by hand
  // got a second one when it was looked for by its name alone (HB-1317).
  const there = (mine?.jobId ? jobs.find((j) => j.id === mine.jobId) : undefined)
    ?? jobs.find((j) => j.name === MODEL_REVIEW_NAME) ?? jobs.find((j) => j.name === LEGACY_REVIEW_NAME);
  if (there) {
    const r = await update(there.id, there.name === LEGACY_REVIEW_NAME);
    remember(there.id, mine?.at ?? now, r === false ? undefined : hash);
    return 'present';
  }
  // Recorded before the copy, with no id, and not there by its name: the
  // owner deleted it, or renamed it, by hand, and is not argued with.
  if (mine && !mine.afterCopy) { remember(undefined, mine.at, hash); return 'kept'; }
  const out = await addCron(provider, runtimeRef, agent.slug, {
    name: MODEL_REVIEW_NAME,
    message: OPS_MODEL_REVIEW_MESSAGE,
    cron: MODEL_REVIEW_CRON,
    // The agents' zone (HATCHABOT_TIMEZONE), not the machine's (B03, 2026-10-22).
    tz: agentTimeZone(),
    deliverTo: cronTargetFor(store, agent),
  }).catch(() => ({ ok: false as const, error: 'exec failed' }));
  if (!out.ok) { deps.log?.('schedule.model_review_failed', { agentId: agent.id, error: out.error }); return 'failed'; }
  if (out.quieted && out.id) store.addQuietedCron(agent.id, out.id, now);
  remember(out.id, now, hash);
  deps.log?.('schedule.model_review_created', { agentId: agent.id });
  return 'created';
}
