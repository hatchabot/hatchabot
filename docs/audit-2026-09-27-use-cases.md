# Use-case walk-through — 2026-09-27

Asked for: "continue in-depth audits, walk through all the use cases and
search for errors." Four reviewers each took a slice of `docs/use-cases.md`
(A–C setup, accounts, creating · D–F identity, AI sources, channels · G–J
memory, schedule, runtime, views · K–N backups, hosts, manager, security) and
walked every use case end to end: the button and what it sends, the route and
its checks, the CLI and the manager's tool, and the test that covers it. Every
finding was verified in the code before it was fixed. Fixed in v2.89.1,
v2.89.2 and v2.89.3.

**Verdict: three critical, twelve major, all fixed.** Two of the criticals
were in this week's own work: the Discord/Slack bot swap (v2.88.1's
reordering wrote the new token over the old one's key), and the defaults
page's `.env` writer choosing the wrong line. A third class of bug no test
could see: three pairs of same-named functions in the page silently replaced
one another, so three buttons ran someone else's code; the page check now
refuses that.

## Fixed

**Critical (v2.89.1)**
- Change bot (Discord/Slack) destroyed the old bot's token and cut the agent off the new one.
- The Telegram/Discord password-reset link was built from the request's Host header on an unauthenticated route.
- Revert overwrote a MEMORY.md too big to snapshot, after promising "undoable".

**Major**
- Discord/Slack *Add to pool*, the roster's *Copy invitation* and a master's *Proposals* ran other functions of the same name (v2.89.1).
- Moving a pinned agent cleared another operation's busy flag (v2.89.1).
- Change bot on an owner's hand-made Telegram bot deleted its token (v2.89.2).
- A shared house bot's token was readable by whoever leased it (v2.89.2).
- An archived agent's last source blocked that source's deletion (v2.89.2).
- The manager's `set_model` only recorded the model (v2.89.2).
- Rootless Docker: the first-account form said no code was needed at the machine; one throttle bucket for everyone behind a proxy; auth-off accepted with every agent a loopback peer (v2.89.2).
- `rebuild --wait` reported RUNNING before the rebuild began (v2.89.2).

**Medium, fixed**
- The `.env` writer changed a commented example instead of the line in force (v2.89.2).
- Editing a paused task switched it on; Rebuild all started stopped and sleeping agents; a duplicate element id on the Advanced tab (v2.89.2).
- A plain approve on a Discord- or Slack-only agent answered "Not found"; peer selection wiped "may ask to act" grants; a setup-token source accepted an API key (v2.89.3).
- A password change left a pending reset link alive; changing your own password was not throttled (v2.89.3).
- A day's usage point dipped when the usage view was opened (the day's point only rises now); a member saw the owner's event details on shared agents; the group arrows counted archived agents' groups (v2.89.3).
- A checkpoint was not a turn in flight (the idle sweep could stop it); the CLI reported a failed checkpoint as saved (v2.89.3).
- The manager could be cloned as a template; "Runs here again" after a rehost left a pool agent with no token; the backup restore reported "restarting" after a failed start (v2.89.3).
- A version named to `hatchabot upgrade` was undone by the channel timer within ten minutes: it is a pin now (v2.89.3).
- Stopping the memory search service asks first; the console's wake cover gives up with the reason instead of waiting 150 s (v2.89.3).
- Texts that lied: the manager's source-switch card ("then rebuild it"), its snapshot-restore card (MEMORY.md rolls back too), the send-to-a-person refusal, the card's fixed file limits and "Remove…" (Detach), the parity doc's file and group-chat rows (v2.89.3).

## Backlog (verified, not changed yet)

| # | Area | Item |
|---|---|---|
| 1 | F | ~~"Every server/channel it is in" answers where the bot was at the last rebuild; Re-check does not reconfigure it (documented now). Apply the room list live, or offer a rebuild when it changed.~~ done in v2.89.4: Re-check reports when the places changed and the app offers the rebuild that makes it answer there. |
| 2 | F | ~~The machine owner's Discord/Slack picker offers other people's private parked bots, which cannot be taken.~~ done in v2.89.4: the picker offers only your own and shared parked bots. |
| 3 | D | ~~Renaming an agent bypasses the Telegram pool's rename queue (a queued older name can come back).~~ done in v2.89.4: a rename updates the pool's queued name too. |
| 4 | D | ~~Assigning a class can put a runner agent on the machine-login source (PATCH refuses, class assignment does not).~~ done in v2.89.4: class assignment refuses a machine-login source for a runner agent. |
| 5 | E | ~~Settings counts a source "in use" by desired source only; delete also counts applied.~~ done in v2.89.4: Settings counts applied sources too. |
| 6 | C | ~~The manager's `create_agent` with an empty pool waits 150 s and misstates why.~~ done in v2.89.4: the manager says it is waiting for a bot token. |
| 7 | B | ~~Switching to family accounts gives the host owner no recovery code.~~ done in v2.89.4: the host owner gets a recovery code. |
| 8 | I | ~~Pinning a stopped agent says "when it next starts"; Start does not rebuild for a pin.~~ done in v2.89.4: the toast says "at its next rebuild". |
| 9 | G | ~~Move all back to the baked engine rebuilds engine-free agents that switch straight back.~~ done in v2.89.4: engine-free agents are skipped (and counted). |
| 10 | G | ~~Removing a git data source leaves its deploy key and clone config on the volume.~~ done in v2.89.4: the key file and the clone's ssh config are removed from the volume. |
| 11 | J | ~~Sort a group / Sort every group does nothing on the icon home screen.~~ done in v2.89.4: the no-op Order row is gone from the icon home screen. |
| 12 | J | ~~"Needs you" is counted three ways (home, Status → Health, Bulk).~~ done in v2.89.4: the Bulk chip and filter use the home screen's rule; the failed bin is labelled apart. |
| 13 | I | ~~Machine default memory changes do not refresh each agent's stated memory budget.~~ done in v2.89.4: each agent's stated budget is refreshed. |
| 14 | K | ~~A download the server refuses replaces the app with raw JSON.~~ done in v2.89.4: the download is fetched; a refusal is a toast. |
| 15 | H/I | ~~Sleepers are told to "Start"; sleep controls shown where they can never apply; bulk Put to sleep counts refusals as failures.~~ done in v2.89.4: sleepers are told to wake; sleep controls only where sleep applies; refusals count as skipped. |

Low: all fixed in v2.89.5 except two, left on purpose. The agent settings
PATCH still writes some fields before its last checks (making it one
validate-then-write pass is a larger change to a 300-line handler; no
reported case). Removing one legacy shared folder re-checks the ones that
stay (only agents from before per-source data sources have legacy folders).
Status → Health keeps its own, wider "attention" list (it also flags quiet
agents); the home screen and Bulk actions now agree with each other.

## Still only a person can test

A real Slack workspace and Discord server beyond the trials; real OpenClaw
containers end to end (the candidate gate, the regression, the clean install
and the shared-host bed are scripts, not vitest); and the UI flows the
click-through gate does not yet drive (snapshot revert, download, move and
rehost, backups, hosts, proposal cards, sort, Status tab contents).
