import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only this checkout's tests. Claude Code's agent worktrees live under
    // .claude/worktrees inside the repo, each a full copy with its own test/:
    // a run from here found four of them and ran 17,836 tests, theirs mid-edit
    // (2026-10-23). review-artifacts holds audit probes, not tests.
    exclude: [...configDefaults.exclude, '.claude/**', 'review-artifacts/**'],
    // Route tests assert authorization by asserting *as* a given owner. The
    // header that allows that is off in production (see src/api/principal.ts).
    env: {
      HATCHABOT_ALLOW_OWNER_HEADER: '1',
      // Any free port: the tests must never collide with a Hatchabot running
      // on the same machine (it holds the real one).
      HATCHABOT_OPS_PORT: '0',
    },
  },
});
