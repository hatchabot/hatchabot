import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
