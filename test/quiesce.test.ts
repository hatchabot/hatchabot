import { expect, it } from 'vitest';
import { stopAndConfirm } from '../src/orchestrator/quiesce.js';
import { MockProvider } from '../src/providers/mockProvider.js';

it.each(['running', 'unknown'] as const)('refuses an unconfirmed stop (%s), even after a successful command', async phase => {
  const provider = new MockProvider();
  provider.stop = async () => {};
  provider.status = async () => ({ phase, healthy: true });
  await expect(stopAndConfirm(provider, 'fixture')).rejects.toThrow(/Could not confirm/);
});
it.each(['stopped', 'absent'] as const)('accepts an observed %s runtime despite a lost stop response', async phase => {
  const provider = new MockProvider();
  provider.stop = async () => { throw new Error('fixture lost response'); };
  provider.status = async () => ({ phase, healthy: true });
  await expect(stopAndConfirm(provider, 'fixture')).resolves.toBeUndefined();
});
