import type { RuntimeProvider } from '../../providers/provider.js';

/**
 * What the agent settings service does after a restart needs the agent's
 * container (HB-0809): a model to write, a budget to tell. After a restart of
 * Hatchabot alone the containers ran on. After one of the whole machine (a
 * reboot, a power cut: the kill these steps are there for) Hatchabot may be
 * up before Docker has started them again, with the record still saying
 * RUNNING. Asked then, the write fails and reads as a runtime that refused
 * it. So a container the record says is running is waited for, half a
 * minute at most, before it is asked: UP_TRIES looks, as far apart as every
 * other wait for a container (HATCHABOT_READY_POLL_MS).
 */
export interface UpWait {
  /** How many looks, and how long between two (ms). */
  tries: number;
  everyMs: number;
  sleep: (ms: number) => Promise<void>;
  /** The service is stopping: no more looks. */
  stopped: () => boolean;
}

export const UP_TRIES = 10;
export const upEveryMs = (): number => Number(process.env.HATCHABOT_READY_POLL_MS ?? 3000);
/** A wait that does not hold the process open. */
export const sleepUnref = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref?.(); });

/**
 * True once the container is running. False when it is not after the wait,
 * its machine does not say (Docker not answering), or the service is
 * stopping: nothing is asked of it then, and what was owed stays owed.
 */
export async function containerUp(provider: RuntimeProvider, runtimeRef: string, wait: UpWait): Promise<boolean> {
  for (let i = 0; i < wait.tries; i++) {
    if (wait.stopped()) return false;
    const phase = await provider.status(runtimeRef).then((s) => s.phase, () => 'unknown' as const);
    if (phase === 'running') return true;
    // Gone, or failed: waiting brings nothing. Not answering: asked again at the next start.
    if (phase === 'absent' || phase === 'error' || phase === 'unknown') return false;
    if (i < wait.tries - 1) await wait.sleep(wait.everyMs);
  }
  return false;
}
