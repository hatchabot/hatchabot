# Live test runs

Every run of a live test, newest at the bottom. `node scripts/live.mjs run
<name>` adds the row; commit it. `scripts/promote.sh` reads this file to
decide what is still due ([live-tests.md](live-tests.md)). Release = the
version the test ran against: the live install's, or the checkout's for
tests that run on their own.

| Date | Test | Result | Release | Minutes | Note |
|---|---|---|---|---|---|
| 2026-10-08 | runner-scenarios | pass | v2.147.1 | 11 | OpenClaw 2026.9.8; with --old-image; details in runner-test-runs.md |
| 2026-10-08 | upgrade-check | pass | v2.148.0 | 1 |  |
| 2026-10-08 | restore-drill | pass | v2.148.0 | 1 | OpenClaw 2026.9.8 |
| 2026-10-08 | candidate-gate | fail | v2.148.0 | 2 | OpenClaw 2026.9.8 |
| 2026-10-08 | candidate-gate | pass | v2.148.0 | 2 | OpenClaw 2026.9.8; after fixing the gate for the image agents already run |
| 2026-10-08 | regress-autonomous | pass | v2.148.0 | 6 | OpenClaw 2026.9.8 |
| 2026-10-08 | smoke-adopt | skip | v2.148.0 | 1 | recorded as pass at first (colour code hid SKIP); its .env.smoke used the pre-rename name |
| 2026-10-08 | smoke-adopt | fail | v2.148.0 | 1 | Telegram rejected the throwaway bot token (from 2026-08-23; likely revoked): needs a new one |
| 2026-10-08 | clean-install | fail | v2.148.0 | 2 | install, accounts, recovery and upgrade passed; its agent check called a system node a bundle install does not have (fixed in v2.148.1) |
| 2026-10-08 | runner-scenarios | pass | v2.148.0 | 11 | OpenClaw 2026.9.8 |
