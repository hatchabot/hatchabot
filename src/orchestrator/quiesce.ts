import type { RuntimeProvider } from '../providers/provider.js';
import { rethrowIfCrash } from './operations.js';

/** A stored lifecycle label is not proof that the runtime has stopped. */
export async function stopAndConfirm(provider: RuntimeProvider, runtimeRef: string): Promise<void> {
  try { await provider.stop(runtimeRef); } catch (err) { rethrowIfCrash(err); }
  const status = await provider.status(runtimeRef).catch((err: unknown) => {
    rethrowIfCrash(err);
    return { phase: 'unknown' as const };
  });
  if (status.phase !== 'stopped' && status.phase !== 'absent') {
    throw new Error(`Could not confirm the runtime stopped (${status.phase}); try again when its machine answers.`);
  }
}
