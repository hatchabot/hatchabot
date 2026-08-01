import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Route tests assert authorization by asserting *as* a given owner. The
    // header that allows that is off in production (see src/api/principal.ts).
    env: { AGENTCLAW_ALLOW_OWNER_HEADER: '1' },
  },
});
