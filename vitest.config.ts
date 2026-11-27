import { configDefaults, defineConfig } from 'vitest/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  test: {
    // Only this checkout's tests. Claude Code's agent worktrees live under
    // .claude/worktrees inside the repo, each a full copy with its own test/:
    // a run from here found four of them and ran 17,836 tests, theirs mid-edit
    // (2026-10-23). review-artifacts holds audit probes, not tests.
    exclude: [...configDefaults.exclude, '.claude/**', 'review-artifacts/**'],
    // No test reaches the real Telegram (test/support/noTelegram.ts, HB-1437),
    // and each starts with no agent held (test/support/freshReservations.ts, HB-0873).
    setupFiles: ['test/support/ownDataFolder.ts', 'test/support/noTelegram.ts', 'test/support/freshReservations.ts'],
    // Thirty seconds for every test, not Vitest's five. CI's runners share this
    // machine with other projects' jobs (load average 40 to 80), and a test
    // that loads src/api/routes.ts or runs real scripts then takes 6 to 9 s.
    // Given file by file (HB-0800, HB-0801, then 31 files), the next file timed
    // out instead (HB-0816). A test that measures speed asserts its own budget;
    // a longer allowance on one test still applies.
    testTimeout: 30_000,
    // Route tests assert authorization by asserting *as* a given owner. The
    // header that allows that is off in production (see src/api/principal.ts).
    env: {
      HATCHABOT_ALLOW_OWNER_HEADER: '1',
      // Any free port: the tests must never collide with a Hatchabot running
      // on the same machine (it holds the real one).
      HATCHABOT_OPS_PORT: '0',
      // Never this machine's real backups: a move and a restore keep their copy
      // of a volume in folders beside them. A test of a real set sets its own.
      HATCHABOT_BACKUP_DIR: join(tmpdir(), `hatchabot-test-backups-${process.pid}`),
    },
  },
});
