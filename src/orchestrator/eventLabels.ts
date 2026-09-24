/**
 * The agent's event trail (store.recordEvent, the `trace` in routes) in plain
 * words: what a step means to the person watching a card say REBUILDING.
 * Unknown events fall back to their name, so nothing is ever hidden.
 */
const LABELS: Record<string, string | ((d: Record<string, unknown>) => string)> = {
  'runtime.seeding': (d) => d.migrating
    ? 'writing its settings and running OpenClaw\'s upgrade migrations (minutes on an agent with a long history)'
    : 'writing its settings into the volume',
  'runtime.provisioned': 'container created',
  'runtime.started': 'container started, waiting for the gateway',
  'runtime.healthy': 'gateway answered',
  'runtime.syncing': 'syncing data folders, connections and skills',
  'datasource.git_synced': (d) => `data folder synced: ${String(d.mountName ?? '')}`.trim(),
  'installdocs.synced': 'install notes synced',
  'agentsmd.synced': 'AGENTS.md synced',
  'connection.sync_failed': (d) => `a connection did not sync: ${String(d.error ?? '')}`.trim(),
  'runtime.settling': 'waiting for its skills to settle',
  'runtime.ready': (d) => d.settled === false ? 'skills did not settle in time — carrying on' : 'skills settled',
  'memory.reindex': (d) => d.why === 'index incomplete'
    ? 'rebuilding the memory index — it came up partial (minutes on a big memory)'
    : `re-indexing memory on ${d.engine === 'shared' ? 'the shared engine' : 'its own engine'} (minutes on a big memory)`,
  'memory.reindex_retry': 'memory index failed once — trying again in 15 s',
  'memory.reindexed': 'memory index ready',
  'memory.reindex_failed': (d) => `memory index failed: ${String(d.error ?? '')}`.trim(),
  'memory.reindex_not_ready': 'memory search not answering after the index',
  'runtime.rebuilt': 'rebuild finished — running',
  'rebuild.failed': (d) => `rebuild failed: ${String(d.reason ?? d.error ?? '')}`.trim(),
  'rebuild.abandoned': 'rebuild abandoned (the agent is being deleted)',
  'rebuild.auto': 'rebuilt by the machine on its own',
  'provision.failed': (d) => `setup failed: ${String(d.reason ?? d.error ?? '')}`.trim(),
  'embed.baked_instead': (d) => `built on its own memory engine — ${String(d.why ?? '')}`,
  'embed.forced_shared': 'its image has no memory engine: using the shared service',
  'embed.engineless_refused': 'its image has no memory engine and the shared service is unavailable',
  'embed.mode': 'memory search engine switched',
  'snapshot.captured': 'memory files snapshotted',
  'memory.checkpointed': 'conversation written to memory',
  'channel.dm_policy': 'chat access policy applied',
  'channel.skipped': 'a messaging channel was skipped (not on this image)',
  'channel.setup_required': 'waiting for a bot token',
  'telegram.skipped': 'continuing without Telegram',
  'console.device_approved': 'console device approved',
  'owner.ask': 'a message from its owner',
  'agent.exported': 'exported',
  'agent.archived': 'archived',
  'ops.created': 'the manager was created',
};

export function eventLabel(event: string, detail?: Record<string, unknown>): string {
  const l = LABELS[event];
  if (!l) return event;
  return typeof l === 'function' ? l(detail ?? {}) : l;
}

/** Steps that mean "still working" when they are the newest event of a busy agent. */
export const IN_PROGRESS = new Set(['runtime.seeding', 'runtime.provisioned', 'runtime.started', 'runtime.healthy', 'runtime.syncing', 'runtime.settling', 'memory.reindex', 'memory.reindex_retry', 'datasource.git_synced', 'installdocs.synced', 'agentsmd.synced', 'runtime.ready']);
