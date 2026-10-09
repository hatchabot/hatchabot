/**
 * The environment for a test that runs one of the real shell scripts, built
 * from scratch. Never spread process.env into it: a HATCHABOT_DB or
 * HATCHABOT_BACKUP_DIR exported in the shell that ran `npm test` reached the
 * script under test, and uninstall.sh --purge would then have deleted the real
 * data directory (review, 2026-10-09). Only what is named here gets through:
 * a temp HOME, the PATH the test gives (its shims first), git with no hooks
 * and no user or system config, and a made-up author.
 */
export function scriptEnv(home: string, path: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    PATH: path,
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    ...extra,
  };
}
