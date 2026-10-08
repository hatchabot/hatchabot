# Live test runs

Every run of a live test, newest at the bottom. `node scripts/live.mjs run
<name>` adds the row; commit it. `scripts/promote.sh` reads this file to
decide what is still due ([live-tests.md](live-tests.md)). Release = the
version the test ran against: the live install's, or the checkout's for
tests that run on their own.

| Date | Test | Result | Release | Minutes | Note |
|---|---|---|---|---|---|
| 2026-10-08 | runner-scenarios | pass | v2.147.1 | 11 | OpenClaw 2026.9.8; with --old-image; details in runner-test-runs.md |
