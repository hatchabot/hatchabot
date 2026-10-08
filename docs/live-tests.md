# Live tests

The unit suite, the click-through and CI fake Docker, OpenClaw, Telegram
and the machines. The live tests do not: they run against a real install,
real containers and real machines, so they find what fakes cannot (a runner
that had lost its image, a copy too slow for its time limit, 2026-10-08).

They run **before a release reaches anyone else**:

1. Release as usual. The main machine deploys every tag (it follows
   `latest`), so the live install now runs the new release.
2. `node scripts/live.mjs due` lists the live tests due for what the install
   runs, and why.
3. Run each: `node scripts/live.mjs run <name> [-- its own arguments]`. The
   result is added to [live-test-runs.md](live-test-runs.md); commit it.
4. Promote. `scripts/promote.sh` refuses while any test is due for the tag
   (`HATCHABOT_PROMOTE_IGNORE_LIVE=1` overrides it, as
   `HATCHABOT_PROMOTE_IGNORE_CI=1` does for CI; a rollback is not held to it).

A test is **due** for a release when it has never passed on that release or
an earlier one, or when a file in its area changed since the release it last
passed on. A run that skipped (nothing to test with) or failed does not count.
`node scripts/live.mjs list` shows each test's last result.

| Test | Proves | Needs | Time | AI turns |
|---|---|---|---|---|
| `runner-scenarios` | Moves and rebuilds between this machine and a runner, across OpenClaw versions; each machine's memory search; Install image ([runner-test-runs.md](runner-test-runs.md)) | A runner: `-- --runner "<name>"`, plus `--old-image <a pre-2026.8 image on it>` once it is current | 20–40 min | none |
| `candidate-gate` | An agent on an image builds, answers, and keeps its memory search and tools | The image (default: this machine's default) | 5–10 min | one |
| `regress-autonomous` | An agent made from the CLI answers, remembers, runs a task on demand and on its schedule, pauses, and keeps both across a restart | The live install | 10–15 min | about eight |
| `restore-drill` | The newest nightly backup restores, every part of it, without touching the live system | A backup set | 5–15 min | none |
| `upgrade-check` | Databases made by older releases open with this one | Nothing (temporary databases) | 2–5 min | none |
| `smoke-adopt` | Switching to Hatchabot: an OpenClaw agent is found and adopted web-only on a throwaway control plane; its workspace and tasks arrive, its console answers, its data folder mounts | Nothing (its own ports); `-- --with-telegram` takes over a bot from `.env.smoke` instead | 2–5 min | none |
| `clean-install` | A stranger's install on a brand-new Linux machine, and a new owner's first steps | LXD here; `-- --ai-source "<name>"`; stop the VM after | 20–40 min | one |
| `shared-host` | Two tenants on one machine cannot reach each other | Test VMs. On hold with Hatchabot Cloud: never due | 30+ min | none |

Each test's area (the files that make it due) is in `scripts/live.mjs`
(`LIVE_TESTS`), with its command. The tests that make agents use names that
say so and delete them at the end, pass or fail; the ones that make VMs say
how to stop them.

## Adding a live test

Add it to `LIVE_TESTS` in `scripts/live.mjs` (name, command, what the
release under test is, area, needs, time, AI turns) and a row to the table
above; `test/liveTests.test.ts` fails until both name it. A test that can
have nothing to test (no token, no runner) prints `SKIP` and exits 0, which
is recorded as a skip, not a pass.
