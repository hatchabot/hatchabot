# Recovery readiness (v2.157.0)

An outside review asked, per agent: can I get it back, from when, and has
anyone proved it? This note is how Hatchabot answers that from what it
already has: the nightly sets `scripts/backup-volumes.sh` writes and the
drill `scripts/restore-drill.sh` runs. There is no second backup engine.

## What exists, and what changed in it

- **Each set's record** (`<set>/backup-status.json`): state, `failedVolumes`,
  `missing` (an agent's volume was not there), `skipped` (its runner did not
  answer), `orphans`. It now also lists **`captured`**: the volumes whose
  archive was written whole (a local `tar` that exited 0 or 1 and was renamed
  from `.part`; a runner's archive that passed `gzip -t`). A set from before
  this field is read as before: an archive that is there and not failed.
- **The drill** used to restore only the largest volume, into a container
  with the network on, no limits, and **the whole set mounted** (the database
  copy and `secret-key.env` included). Now each volume is checked and the
  record says so (below), and each restore runs in a throwaway container
  with:
  - `--network none`, `--memory 1g`, `--cpus 1`, `--pids-limit 256`,
    `--security-opt no-new-privileges`, `--entrypoint bash` (nothing of
    OpenClaw starts, so no bot polls, no AI call);
  - only that one archive mounted, read-only: no database, no key;
  - a fresh labelled volume (`hatchabot.restore-drill=1`) per archive,
    removed after it; leftovers of a killed drill are removed by the next;
  - one drill at a time (a lock in `<backups>/drills/.lock`, the backup
    script's pattern);
  - a time limit per restore (15 min) and for all restores (60 min); what the
    hour did not reach is checked by reading only, and the record says so.

  The drill still decrypts one secret with the set's own key, in memory, to
  prove the key works (never printed, never used). That is the one credential
  it touches, and it is the backup's copy, not the live `.env`.

## The drill's record

Every run that found a backups directory writes
`<backups>/drills/<UTC time>.json` (0600, in a 0700 folder; the newest 30
kept). The nightly prune never touches it: it removes dated folders only.

```json
{ "version": 1, "set": "2026-10-08", "setState": "complete",
  "startedAt": "…", "finishedAt": "…", "durationSec": 412,
  "trigger": "scheduled", "result": "passed",
  "database": "ok", "key": "ok",
  "volumes": [ { "volume": "hatchabot-kitchen-1-vol", "readable": true,
                 "layout": true, "restored": true, "result": "passed" } ],
  "isolation": { "network": "none", "memory": "1g", "cpus": "1" } }
```

Per volume: `readable` (the whole gzip stream and tar listing read),
`layout` (the listing holds files under `agents/`, the tree OpenClaw boots
from), `restored` (true: extracted into the throwaway and the files found
there; false: that failed; null: not reached, or no docker). A volume
passes when it is readable, has the layout, and its restore did not fail.

## Readiness, per agent (`GET /v1/backups/readiness`)

`src/orchestrator/recoveryReadiness.ts` — `computeReadiness` is a pure
function of the sets, the drill records, the agents and the runners' answers.

- **Latest usable backup**: the newest finished set that holds its archive
  and whose record allows restoring it: complete, or incomplete with this
  agent's volume captured (and not failed). A set still being written never
  counts.
- **Left out**: of the last 7 finished sets made after the agent was, how
  many do not hold it usably, and why: its machine was asleep (`skipped`),
  its archive failed, its volume was missing, or the record does not say.
- **Its runner**: whether it answers now (the provider's cached probe, as
  the machine line uses).
- **Last drill covering it**: the newest record that checked its volume:
  when, which set, passed or failed, what was checked.
- **Status**, the first that applies:
  `not covered` (no usable copy) · `new` (made after the newest set: not
  backed up yet, not a problem) · `stale` (the newest usable copy is more
  than 2 days old) · `drill failed` · `never drilled` · `ready`.
  `line` says it in words for the page and the table.
- **Alert** (Alerts on its tile): stale or not covered, but only while the
  machine's newest set is itself fresh (≤ 2 days old) and left this agent
  out. When the whole machine is late the machine's own alert says so
  (`v2MachineAlerts`), and the agents' tiles stay quiet: one alert, not
  forty. The machine alert in turn stops naming an agent whose own tile
  carries the alert. A failed drill is a machine alert.

Scope: the machine's owner sees every agent; anyone else sees the agents they
own. Restoring stays the machine owner's (as `/v1/backups/restore` is).

## Automated drills (opt-in)

`HATCHABOT_DRILL_EVERY` = `off` (default) | `weekly` | `daily`, in `.env`,
also set from Settings → Backups (written to `.env`, like the rebuild policy).
A check every 15 minutes runs one when all hold:

- the setting is on, and the last drill is older than the period;
- it is between 05:00 and 07:00 local (after the 03:30 backup and the
  03–05 rebuild hours);
- today's set is finished (not running) and no backup run is under way;
- no drill is running (one at a time).

It runs the same script under `nice`, killed after 90 minutes, and is recorded
as a machine operation (`restore-drill` in `operations.ts`), so it shows in
Activity; a restart in the middle fails it with "run it again". "Run a drill
now" (Settings → Backups, `POST /v1/backups/drill`) is the same run, by hand.

## The page

- **Agent sheet → Advanced → Recovery**: "Recoverable from <date> · last drill
  <date> passed", or the problem in plain words. **Restore…** opens the guided
  path in place: the sets that hold it (newest usable chosen), what each holds,
  and what will be undone; then the existing typed-name confirm and
  `/v1/backups/restore`.
- **Settings → Backups**: a table (agent, latest usable, left out of, last
  drill, status), the drill setting and **Run a drill now**.
- **Alerts**: the per-agent alert above; the machine's alerts unchanged but
  for the fold and a failed drill.
