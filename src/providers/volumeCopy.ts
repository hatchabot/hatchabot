/**
 * What every agent rebuilds by itself, left out of a copy of its volume as the
 * nightly backup leaves it out (scripts/backup-volumes.sh TAR_EXCLUDES, where
 * each is explained): a Download, a move and a restore's safety copy are held
 * in memory whole, so a third less is a third further from their limits
 * (HB-0066). `./`-rooted, so a project's own .npm in the workspace stays.
 */
export const STATE_CACHE_EXCLUDES = ['--exclude=./.openclaw/cache/control-ui-assets', '--exclude=./.openclaw/tmp', '--exclude=./.npm', '--exclude=./.cache/pip'];
