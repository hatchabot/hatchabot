# Night review, 2026-09-27/28

Six read-only reviewers, one area each, against a shared brief: report only new, verified defects in a strict format, nothing already in the 2026-09-27 audit or walk-through. Every finding was checked in the code before it was fixed. Fixes shipped in v2.90.0 and v2.91.0; a second wave of six more areas followed, fixed in v2.92.0 (and hatchabot-cloud 72ba4ac).

## Areas and results

| Area | Critical | Major | Medium | Low |
|---|---|---|---|---|
| Provisioning, rebuild, reconcile | 0 | 2 | 4 | 4 |
| Moves, transfer, archive, backups | 1 | 2 | 7 | 3 |
| Store and migrations | 0 | 1 | 6 | 3 |
| Chat apps, pools, pairing | 1 | 5 | 6 | 2 |
| Manager chat and its tools | 0 | 3 | 5 | 7 |
| Web page logic | 0 | 3 | 2 | 8 |

## Second wave

| Area | Critical | Major | Medium | Low |
|---|---|---|---|---|
| Sign-in and accounts | 1 | 1 | 5 | 3 |
| Memory service and Docker provider | 1 | 2 | 4 | 1 |
| CLI and scripts | 0 | 1 | 7 | 10 |
| Cloud provisioner (hatchabot-cloud) | 1 | 2 | 10 | 3 |
| Connections and files | 1 | 1 | 7 | 3 |
| Usage, schedules, notifications | 0 | 1 | 6 | 4 |

Criticals: agent secrets on the docker command line (readable by every local user); a reset link delivered through another member's bot; the Google consent callback not bound to the starting browser; tenant output closing a heredoc in hc and running as root.

## Third wave

Agent families and consults, the config writer, Discord and Slack, runtime images, creation and bulk actions: fixed in v2.94.0. One critical (a removed member stayed in Slack/Discord room lists).

Fixed later in v2.95.0: the stale setup token, the claim-window door, the sweep loop, the cap race, and the downgrade checks for move and import. v2.96.0 closed the concurrent setup/un-archive, peer grants, class memory cap, candidate retag, recipe status, lines cap and build ceiling. v2.97.0 closed the stopped-agent CLI image and the set_class card. Still open: a `-lite` or revision tag's recipe is rebuilt from the plain version; push-definition replaces a child's own Peers section until its next rebuild.

## The first wave's two criticals

1. **Change bot on a pool bot gave the agent its own bot back.** Pool leasing is idempotent per agent, so the "fresh" bot was the old one, which the swap then released: the next new agent took it too. Fixed in v2.90.0: the swap excludes the current bot, refuses if nothing else is free, and releases quietly.
2. **Importing a Download could wire a bot that is a spare in this machine's pool.** The import checked only live channel rows. Fixed in v2.90.0: import and the move-here preflight refuse a pool bot, and the one-agent-per-bot index now ignores case.

## Left open, on purpose

- **Second wave, still open:** password mode still honours X-Forwarded-For from loopback (fixed per-account buckets now cap guessing; dropping it would bring back the shared-bucket bug behind a proxy). Everything else in the second wave was fixed in v2.92.0 and v2.93.0.

- **Doorman listens on every interface.** It also answers on Docker's default bridge. Only an agent still on that bridge could reach it, and on the Spark nothing but Hatchabot's own doorman and memory door is there (checked 2026-09-28). Binding only the jail address would break the published console port, so this needs a live test before it changes.
- **Checkpointing rebuilds hold a rebuild slot while they wait for the checkpoint gate.** A throughput issue during a source switch of many agents, not a correctness one.
- **The schema-upgrade test does not seed the old pairing-window shape.** The move itself runs on every live box already; the test gap stays noted here.
- **A restore of an agent whose volume is over about 1 GB compressed is now refused** (its safety copy cannot be buffered). Before, it went ahead with no way back.

## Lessons

- A per-agent idempotent lease plus a release is a swap to itself. Any "take a new one" path needs an explicit exclusion.
- A negative getUpdates offset is not a peek: Telegram forgets everything before it.
- Anything passed as one shell argument has a 128 KiB ceiling; use stdin for content.
