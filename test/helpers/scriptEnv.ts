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

/**
 * A step that leaves half a node_modules and then hangs, as `npm ci` cut off
 * would; `started` appears once it is hanging. The hanging process writes
 * `started` itself, with Node's default action for every signal in place.
 *
 * Not `touch started; exec sleep 30` (HB-0505): a SIGINT sent once `started`
 * appeared could reach that bash before its exec, where bash only notes it
 * (a non-interactive bash catches SIGINT to wait for its child), and the
 * exec then dropped it. sleep never heard it and ran its 30 s: a test past
 * its timeout on CI, and 38 of 200 tries in a loop that sent SIGINT the
 * moment `started` appeared (0 of 200 this way). SIGTERM, which that bash
 * does not catch, always ended it.
 */
export function hangingStep(started: string): string {
  const js = `require("fs").writeFileSync(${JSON.stringify(started)}, ""); setTimeout(() => {}, 30000)`;
  return `#!/usr/bin/env bash\nmkdir -p node_modules/half-installed\nexec ${JSON.stringify(process.execPath)} -e '${js}'\n`;
}
