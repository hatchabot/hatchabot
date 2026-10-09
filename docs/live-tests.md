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
passed on. A run that skipped (nothing to test with, or a part it could not
run) or failed does not count, and a run that tested nothing fails. The gate
counts only runs that are committed: `due` says when some are not yet.
`node scripts/live.mjs list` shows each test's last result.

A big file most releases touch (`src/api/routes.ts`, `src/cli.ts`,
`src/store/store.ts`) is in an area as `{ path, near }`: a change there makes
the test due only when a changed line, or the route or command it sits in,
matches `near` (the test's own routes and commands). A test this machine
cannot run (an `arch` it is not) is listed by `due` and `gate` as one to run
on a machine that can; it does not hold the gate here.

| Test | Proves | Needs | Time | AI turns |
|---|---|---|---|---|
| `privacy` | Nothing GitHub serves names this household's private values (agents, people, bots, machines, `.env` secrets): main's files, every commit and tag since the 2026-10-09 scrub, release notes, issues; and no tag is from before 1.0 or off `main` ([privacy check](releasing.md#the-privacy-check)). Due on every release | This machine's install and `gh` signed in | 1–3 min | none |
| `runner-scenarios` | Moves and rebuilds between this machine and a runner, across OpenClaw versions; each machine's memory search; Install image ([runner-test-runs.md](runner-test-runs.md)) | A runner: `-- --runner "<name>"`, plus `--old-image <a pre-2026.8 image on it>` once it is current (without it phase A is a SKIP). `--old-image` points the runner's default image at the old one until A1 is done (back on Ctrl-C too): run it when nobody is creating or rebuilding agents there | 20–40 min | none |
| `transfer` | Clone, a template shared with its memory and imported, and download → delete → restore: each copy runs web-only and still finds its notes by meaning | Room for 3 agents under the account's limit; Hatchabot 2.150.0+ | 10–15 min | none |
| `apps` | An app installs into an agent (its tests run there), its scheduled command runs by itself, an update keeps its config, a release with failing tests is refused, rollback and stop work | Room for 1 agent | 10–15 min | none |
| `console` | A real browser opens an agent's console at the public HTTPS address: a secure context and its app starts; with a sign-in key, also that its live connection opens and carries messages | `HATCHABOT_PUBLIC_URL`; room for 1 agent; a sign-in key for the live connection (it admits a signed-in browser only): `-- --signin-key <file>.key`, or `~/.config/hatchabot/signin-live-test.key` with its `.pub` as `HATCHABOT_SIGNIN_KEY_FILE` (docs/signin-links.md); without one the run is a SKIP | 2–5 min | none |
| `browser` | An agent's own browser: off by default; switched on it opens and reads a real page; none of the agent's files in it; it follows an agent restart; switched off it is gone | Room for 1 agent | 8–12 min | none |
| `candidate-gate` | An agent on an image builds, answers, and keeps its memory search and tools | The image (default: this machine's default) | 5–10 min | one |
| `regress-autonomous` | An agent made from the CLI answers, remembers, runs a task on demand and on its schedule, pauses, and keeps both across a restart | The live install | 10–15 min | about eight |
| `restore-drill` | The newest complete nightly backup restores, every part of it, without touching the live system | A backup set | 5–15 min | none |
| `upgrade-check` | Databases made by older releases open with this one | Nothing (temporary databases) | 2–5 min | none |
| `smoke-adopt` | Switching to Hatchabot: an OpenClaw agent is found and adopted web-only on a throwaway control plane; its workspace and tasks arrive, its console answers, its data folder mounts | Nothing (its own ports); `-- --with-telegram` takes over a bot from `.env.smoke` instead | 2–5 min | none |
| `clean-install` | A stranger's install on a brand-new Linux machine, and a new owner's first steps | LXD here; `-- --ai-source "<name>"`; stop the VM after | 20–40 min | one |
| `clean-install-ubuntu-2204` | The clean install on Ubuntu 22.04, the oldest glibc the bundle supports (a glibc bug broke stable there once) | As `clean-install` | 20–40 min | one |
| `clean-install-debian-12` | The clean install on Debian 12 | As `clean-install`, plus the local LXD image `hb-debian-12`, made once with `scripts/make-debian-test-image.sh` from Debian's own cloud image (LXD's image server has no arm64 Debian VM image). It runs on either CPU | 5–40 min | one |
| `shared-host` | Two tenants on one machine cannot reach each other | Test VMs. On hold with Hatchabot Cloud: never due | 30+ min | none |

**No live test uses a Telegram bot.** Bots are scarce (about 20 per Telegram
account), so every test agent is web-only. One found with a bot is deleted at
once, which hands the bot back to the pool, and its test fails. Run the tests
one at a time: several make agents at once, and an account near its agent
limit (`HATCHABOT_MAX_AGENTS_PER_ACCOUNT`) has room for few.

Not automated (check by hand before a release that touches them): Telegram
end to end (only a person can message a bot), Google connections
(`node scripts/connection-health.mjs` reads yours), a runner going to sleep
mid-move, an install on a Mac.

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
