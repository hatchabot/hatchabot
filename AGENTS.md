# Hatchabot: notes for AI assistants

Hatchabot runs a household's AI agents (OpenClaw in Docker) from one web app
on a machine you own. It is Node 22 and TypeScript (`src/`), with one
single-file web app (`web/index.html`) and shell scripts for install,
upgrade and backups (`install.sh`, `scripts/`).

Codex, Claude Code, Gemini CLI, Cursor and Copilot read this file.

## Helping someone with an install

Use this when someone's Hatchabot misbehaves, or they ask how something
works. The knowledge pack in `docs/` was written for exactly this, so start
there before reading code:

1. **`docs/troubleshooting.md`: known problems.** Search it for the symptom,
   using the exact error text when there is one. Each entry gives:
   - how to **check** that it is this problem;
   - the **cause** and the **fix**;
   - the release it was **fixed in**. A "Fixed in" newer than their version
     means the fix starts with upgrading.

   Confirm with the entry's Check before you rely on it.
2. **`docs/architecture-map.md`: where each feature's code is.**
   `src/api/routes.ts` and `web/index.html` are each over 10,000 lines, so
   search them for the route strings and function names the map gives.
3. **Settings** are explained in `README.md`, `docs/features.md` (the tour),
   the other files in `docs/`, and `.env.example`.
4. **Their version** is in `package.json`. On their machine,
   `hatchabot doctor` checks the install and prints a fix for each problem.
5. **Reporting a bug in Hatchabot:** in the app, **Report a problem** (the
   link at the foot of the home screen) files a GitHub issue with the
   details masked. See `docs/field-reports.md`.

Most problems are a setting or the machine (a runner asleep, a full disk, a
key that expired), not a bug. Say which it is.

## Changing the code

- **Changes reach `main` only through a pull request** whose required checks
  pass, privacy included: `scripts/land.sh` opens it and waits for the merge.
  A direct push to `main` is refused.
- **The gates, chained so one failure stops the rest:**

  ```sh
  set -o pipefail && npm run -s typecheck && npm run -s check:web && npm run -s test:ui && npm test
  ```

  `test:ui` clicks through the real web page with a stubbed API. A UI change
  gets a scenario in `scripts/ui-clickthrough.mjs`.
- **Live tests, before promoting:** the gates and CI fake Docker, OpenClaw
  and the machines. After a release deploys to the main machine, run
  `node scripts/live.mjs due` and then `node scripts/live.mjs run <name>` for
  each test it lists; commit `docs/live-test-runs.md`. `scripts/promote.sh`
  refuses while any is due. What each proves and needs: `docs/live-tests.md`.
- **Releasing:** `docs/releasing.md`.
  - The CHANGELOG headings are `## [x.y.z] — YYYY-MM-DD`.
  - Moving a channel forward (`scripts/promote.sh`) checks CI first.
- **Lists a test enforces:**
  - a new API route is classified in `src/api/publicRoutes.ts` (and the table
    in `docs/public-access.md`);
  - a new route that changes something gets an entry in the manager's
    coverage ledger (`src/mgmt/coverage.ts`);
  - a new `HATCHABOT_*` setting goes in `src/config/envCatalog.ts` and
    `.env.example`.
- **Tests that run real scripts stay in a sandbox:** a temp HOME, a PATH of
  shims, and git hooks off. A script under test must never reach the real
  machine.
- **Test data is made up.** No real tokens, or anything shaped like one; no
  real names, addresses or ids.
- **Public files** (docs, CHANGELOG, this file) carry no personal data,
  including the names of anyone's agents. Examples and fixtures come from
  the invented household in `docs/deck/shot-data.mjs`. The privacy check
  (`scripts/privacy-check.mjs`, docs/releasing.md) enforces it on push, on
  release notes and before promoting; never `git push --tags`. CI requires
  it too: its `privacy` job fails a pull request or push that names one.
- **Keep the knowledge pack true.** A fix for a problem users can hit gets a
  `docs/troubleshooting.md` entry, and moved code updates
  `docs/architecture-map.md`. `test/knowledgePack.test.ts` fails when either
  names a file or function that is gone.
