/**
 * The docker names a runtime ref stands for: one rule for the provider
 * (localDockerProvider.ts), the archive a backup set holds for an agent
 * (backups.ts agentArchiveName), and the nightly backup, which carries a copy
 * of it in scripts/backup-volumes.sh (test/dockerNames.test.ts holds the two
 * together). Each had its own, and a legacy ref's volume was an "orphan" to
 * the backup, missed every night, under a name no restore could find
 * (audit #021).
 */

/** Docker object prefix for new agents; `agentclaw` is what installs from before the rename used. */
export const DEFAULT_PREFIX = 'hatchabot';
export const LEGACY_PREFIXES = ['agentclaw'] as const;

/**
 * The container and volume for `docker://<name>`: `<name>` and `<name>-vol`.
 * Legacy refs (pre-slug, a bare uuid fragment) map to the old naming scheme,
 * so existing agents keep working without a migration.
 */
export function dockerNames(runtimeRef: string, prefix: string = DEFAULT_PREFIX): { container: string; volume: string } {
  const name = runtimeRef.replace(/^docker:\/\//, '');
  if (name.startsWith(`${prefix}-`) || LEGACY_PREFIXES.some((p) => name.startsWith(`${p}-`))) {
    return { container: name, volume: `${name}-vol` };
  }
  // legacy: docker://<uuid-fragment> — these predate the rename, so under the
  // default prefix they live under the old one.
  const short = name.slice(0, 12);
  const p = prefix === DEFAULT_PREFIX ? LEGACY_PREFIXES[0] : prefix;
  return { container: `${p}-${short}`, volume: `${p}-vol-${short}` };
}
