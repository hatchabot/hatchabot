# Design: durable operations, and one interface

Status: **proposal, for review** (2026-10-09). Two changes from an outside
review of Hatchabot, chosen to come first:

- **Part A — durable operations.** Every long-running change (a move, an
  import, a restore, a rebuild…) is recorded on disk as it goes: what was
  asked, the last step known to be done, the outcome, and a safe next action.
  A restart in the middle is then recovered on purpose instead of guessed at.
- **Part B — one interface.** Retire the classic card look, after the icon
  home screen has everything worth keeping from it.

Part A fixes correctness; Part B removes about 1,400 lines (9%) of
`web/index.html` that no test exercises. They are independent and can ship in
either order.

---

## Part A — durable operations

### What happens today

Each long change runs inside one HTTP request (move, move to another
Hatchabot, file import, backup restore, snapshot restore, app install) or as a
background task (provision, rebuild, image copy). Its progress lives **in
memory**: the per-agent busy flag (`busy.ts`), `inflight`, `rebuildQueued`,
`archiving`, `imageCopies`, the backup run's `runState`, the move's exported
state and the restore's safety copy. A restart — an automatic upgrade, a crash,
a reboot — loses all of it. Boot then runs `reconcileAgents`, which only
compares each agent's recorded state with what Docker reports; it never starts,
stops or removes anything, and it cannot know an operation was under way.

What a restart in the middle does now:

| Operation | Interrupted after… | Result today |
|---|---|---|
| Move to another machine | the export, before the host flips | Source STOPPED (was running: stays stopped); the half-made target container and volume left on the target; the memory-search key not restored |
| | the host flips, before the start | Agent recorded on the target, STOPPED; the source's volume never purged (an orphan) |
| | the target starts | Marked RUNNING by reconcile, but the rebuild hook, skills and re-index skipped; source orphaned |
| Move to another Hatchabot | the export (agent stopped) | Source STOPPED with no tombstone and no busy flag: **Start is allowed while the other server may already be running it — two pollers on one bot** (issues #1, #15 were the same uncertainty in-process) |
| Import a file / restore a download | the agent row, before the state is copied in | PROVISIONING → reconcile sets FAILED "Setup was interrupted — tap Retry", and Retry starts **a seed-only volume with the imported bot and members** (the code's own words: "an empty-headed impostor") |
| Restore from a backup | the volume is replaced, before settings are re-applied | The safety copy was only in memory: gone. The volume holds that night's config and allowlist, with no re-scrub of removed members |
| Archive | the bot is released, before ARCHIVED | Agent STOPPED or RUNNING with no channel row; its volume still holds the released bot's token until a rebuild |
| Rebuild queue | anything queued, not started | Dropped silently; the record still says RUNNING |
| App install / update | the switch | The volume's `current` release, config and scheduled tasks can differ from the `agent_apps` record; nothing compares them |
| Install image on a runner | anything | The job is gone; the page says idle; the copy's processes are not tracked |

Two smaller gaps found on the way: reconcile's own events go to the journal
only (`index.ts` passes `app.log.info`), and so do a runner's image-copy events
(`trace()` with no agent id), although `eventLabels.ts` has labels for both.
The `agent.moved` label reads `toHost` but the event carries `to`, so it always
says "moved to another host".

### Goals

1. Every long change leaves a record that survives a restart: what was asked,
   by whom, the steps done, the outcome, and what to do next.
2. After a restart, an interrupted operation is **finished or undone on
   purpose** when the right direction is certain, and otherwise **held** —
   the agent refuses Start and Rebuild — with one clear choice for the owner.
3. The owner sees operations where they already look: the Activity list, the
   agent's Setup log and "Working on" line, and Alerts.
4. Long requests stop depending on the browser staying connected.

Not goals: a general workflow engine; resuming every step automatically;
coordinating with another Hatchabot beyond what `destinationHasAgent` already
asks.

### The record

One table, `operations`, beside `agent_events` (which stays the narrative):

| Column | Meaning |
|---|---|
| `id` | `op_…` |
| `agent_id` | the agent (null for a machine-level operation: image copy, backup run) |
| `host_id` | the machine it acts on, when that is not the agent's |
| `kind` | `move-host`, `migrate`, `import`, `restore-backup`, `restore-snapshot`, `provision`, `rebuild`, `archive`, `unarchive`, `app-install`, `app-update`, `app-rollback`, `install-image` |
| `requested_by`, `requested_at` | owner id and how (web, CLI, the Hatchabot agent, a sweep) |
| `params` | JSON, never a secret: target host, date, peer, app ref, wasRunning… |
| `step`, `step_at` | the last step **confirmed done** (a key from the kind's step list) |
| `status` | `queued`, `running`, `succeeded`, `failed`, `rolled_back`, `interrupted`, `held` |
| `outcome` | one plain sentence for the owner |
| `recovery` | JSON: the actions offered, e.g. `[{action:'finish',label:'Finish the move'},{action:'undo',label:'Put it back on This machine'}]`, and the recommended one |
| `boot_id` | the process that ran it (a random id per start: a `running` row from another boot was interrupted) |
| `updated_at`, `finished_at` | |

Kept 90 days, and at least the last 50 per agent.

### The code

A small module, `src/orchestrator/operations.ts`:

```ts
const op = ops.begin('move-host', agent.id, { to: target.id, wasRunning });
await source.stop(ref);                 op.step('stopped');
const state = await source.exportState(ref);  op.step('exported');
…
op.done('Moved to Laptop runner.');     // or op.fail(err, recovery) / op.rolledBack(why)
```

- Each kind declares its steps once: key, label, whether it is destructive,
  and **what to do if interrupted after it** (the table below). The step list
  is also what the page shows ("step 4 of 7: copying its memory in").
- `op.step()` writes the row and an `agent_events` row (`detail.op` = the id),
  so the Activity list and Setup log keep working unchanged.
- An agent with a `running`, `interrupted` or `held` operation is busy **on
  disk**: Start, Rebuild, Archive, Move, Delete and Wake refuse with the
  operation's outcome line. This replaces the in-memory busy flag for long
  operations (the flag stays for short ones).
- Long operations return `202 { operation }` at once and run in the
  background, like rebuilds already do. `GET /v1/operations?agentId=…` and
  `GET /v1/operations/:id` report them; the CLI's `--wait` follows the id.
- The rebuild queue becomes `queued` rows, so a restart keeps its place.

### After a restart

Boot runs `resumeOperations()` after the first reconcile. For each `running`
row from an earlier boot it applies the kind's rule for the last step done:

| Kind | Last step done | Recovery | Why that direction |
|---|---|---|---|
| move-host | before the host flip | **Undo, automatically**: remove the target's leftovers (if the target answers), restore the memory-search key, start the source if it was running | Nothing on the target is in use yet |
| | host flipped, not started | **Finish, automatically**: second seed and start on the target, the rebuild hook and re-index, then remove the source's volume | The record already says target; the source volume is the stale copy |
| | either, and the other machine does not answer | **Hold**: "Move interrupted; Laptop runner isn't answering. [Try again when it's back] [Put it back here]" | Never guess with a machine we cannot see |
| migrate | before the export | Nothing to do: `failed` | Nothing left this machine |
| | exported, no answer recorded | **Ask the other server** (`destinationHasAgent`) when it answers: yes → tombstone and retire the bot; no → start the source; unknown → **hold**, refusing Start | This is the two-pollers case |
| import | anything before RUNNING | **Undo, automatically**: delete the half-made agent, its secrets and bot lease; outcome "Import interrupted — import the file again" | A half-imported volume must never start (today's Retry starts one) |
| restore-backup | the safety copy taken | The safety copy is now **written to `restore-safety/` before** the volume is replaced (today it is in memory); **hold**: "[Finish the restore] [Put back the copy from before]" | Either is correct; only the owner knows which they wanted |
| restore-snapshot | some files written | **Hold**: "[Finish] [Revert to the copy taken before]" (that snapshot is already saved) | |
| provision / rebuild | as today's reconcile rules | Reconcile's rules stay; the row records the outcome; a `queued` rebuild is **re-queued** | |
| archive | the bot released | **Finish, automatically**: mark ARCHIVED, rebuild-free (the container stays stopped) | The bot is already gone; going back would need a new one |
| app-install / update / rollback | the switch | Compare the volume's `current` with the record; differ → **hold**: "[Use the new release] [Go back to the previous one]"; clear `staging` | |
| install-image | anything | `failed`, "[Install again]" | Copying is repeatable |

"Hold" puts the operation under **Alerts** on the agent's tile and in its
sheet, with its buttons (`POST /v1/operations/:id/recover {action}`), the
steps done, and the time. The Hatchabot agent gets the same through its tools.

### On the page

- **Working on** (the sheet's line and the tile's ring) reads the operation:
  "Moving to Laptop runner — step 4 of 7, copying its memory in · 2 min".
- **Activity** shows an operation as one row ("Moved to Laptop runner · 3 min")
  that opens to its steps; the per-step events stay in the Setup log.
- **Alerts** shows held operations first, with their choices.
- A runner's image copy and the backup run appear in Activity as
  machine-level operations (they are journal-only today).

### Order of work

1. The table, `operations.ts`, `resumeOperations()`, and the three operations
   where a restart does real harm: **migrate, import, move-host**. Fix the
   `agent.moved` label; store reconcile's and the image copy's events.
2. Restore (safety copy on disk first), archive, the rebuild queue, apps,
   install-image.
3. The page: Working on, Activity rows, Alerts with recovery buttons; the
   CLI's `hatchabot ops [agent]`.

### Tests

- A **kill-at-every-step** test per kind: run the operation against the mock
  provider, throw at step *n*, start a fresh "process" (new `boot_id`), run
  `resumeOperations()`, and check the invariant: never two running copies,
  never a half-made agent started, the source either running or held.
- Click-through scenarios for the Alerts card and its buttons.
- A live test, `interrupted-move`: a web-only test agent moves to the runner,
  the service is restarted at the export, and the move is finished or undone
  by itself.

---

## Part B — one interface

### What exists today

- The look is chosen per browser: `localStorage['hb-ui']`, set by
  `?ui=classic` / `?ui=v2`, the account menu's "Classic look" and the classic
  header's "✨ New look". Nothing on the server knows; every role gets the same.
- About **1,350–1,400 lines** are used only by classic (HTML ~165, CSS ~170,
  JavaScript ~1,050), plus 21 `UI_V2` branches.
- **No test runs it.** The click-through always uses the icon home screen; two
  scenarios call classic builders (`agentCard`) directly.
- Classic is already behind: the Hatchabot agent's Confirm/Cancel cards and the
  people-knocking list never appear there, a guest cannot web-chat, and
  `#console=` addresses and ⌘K do nothing.

### What only classic has

| Capability | Proposal |
|---|---|
| **Planned agents** ("Plan an agent…": a to-do list of agents to make, `/v1/agent-todos`) | **Decided (2026-10-09): bring it to the home screen** as a "Planned" group of ghost tiles, each made with one click (New agent, its name filled in), removable by keyboard. |
| **Manual order within a group** (▲/▼, ±5, a position select, drag) and **sort a group once and keep it** (`/v1/groups/sort`) | **Decided (2026-10-09): keep it.** Add **"My order"** to the home screen's sort (beside Age · Name · Activity), using the order already stored: drag within a group, and in the sheet "Move earlier / later" buttons for the keyboard. |
| **Run health checks on every agent** (`runFleetHealthChecks`, with the config check) | Add "Check all" to the machine line's menu, results under Alerts. |
| **"Template not configured — fill its Setup values"** | Show the same notice in the sheet's Overview (it comes from `agentNotices`). |
| **Telegram Web link for the owner** | Add it beside "Open Telegram" in the Telegram tab. |

Everything else on the classic card has an equivalent in the agent's sheet
or the home screen (Appendix).

### Accessibility, before classic goes

The icon home screen must not be worse by keyboard. To fix first, each with a
click-through scenario:

- The sheet's selects (Group, Class, Sleep…) take their label from a `div`:
  give each a real `<label>`.
- The sheet bar's icon is a `span role=button`: make it a button (Space works).
- View-by bar and sheet tabs: arrow keys between tabs, `aria-controls` and
  `role=tabpanel`.
- Account menu: `role=menu` items and arrow keys.
- Ordering within a group by keyboard ("My order", above).
- The drop strips (new group, bin, Archived) are pointer-only; their keyboard
  equivalents in the sheet stay, and the strips get a hint saying so.

### Moving people over

**Decided (2026-10-09): one step**, no notice release. On the removal
release, `hb-ui=classic` is cleared on first load and a short map is shown
once: "The classic look is gone — everything is in the agent's page now"
(card button → sheet tab, from the Appendix).
- Nothing server-side changes for the switch itself. `/v1/groups/sort` and
  `/v1/agent-todos` stay if "My order" and Planned keep them; otherwise they go
  with the coverage ledger's entries.

### Removal

The removal release deletes the classic-only HTML, CSS and JavaScript (listed
by function: `agentCard`, `cardMenu`, `memberCard`,
`renderToc`, the classic ordering and drag code, `fleetDlg`, `groupDlg`,
`fleetSourcesDlg`, the classic header and Activity card…), keeps what the sheet
borrows (`agentNotices`, `editDlg`/`cronDlg`/`healthDlg` panes, `prepareEdit`,
`editGroupName`, `moveGroup`, the `fabBtn` handler, `#importFile`), and
updates:

- tests: `test/driftGuards.test.ts` (the `fillPositionPickers` guard), the
  `keyboardLinks` and `untrustedText` scenarios (ported to `agentNotices` and
  the sheet);
- docs: `docs/features.md`, `README.md`, `docs/architecture-map.md`,
  `docs/tailscale.md`, `docs/use-cases.md`.

`scripts/check-web.mjs` already fails if an `onclick` names a function that is
gone, and the knowledge-pack test if the map does.

### Order of work

1. The parity items (decided above) and the accessibility fixes, each with a
   click-through scenario.
2. The removal release, with the one-time map.

---

## Questions for review

1. ~~Planned agents~~ — bring them to the home screen (decided 2026-10-09).
2. ~~Manual order~~ — keep it as "My order" (decided 2026-10-09).
3. **Automatic recovery**: the table above finishes or undoes a move, an
   import and an archive by itself when the direction is certain, and holds
   the rest for you. Is that the right line, or should every interrupted
   operation wait for you?
4. ~~Notice release~~ — no: one step (decided 2026-10-09).

---

## Appendix — where each classic control lives on the home screen

| Classic | Home screen |
|---|---|
| Invite… | Sharing → Invite… |
| ⚙ Settings | the agent's sheet (12 tabs) |
| ⏰ Tasks | Schedule |
| 🏷 Sync name | Telegram (shown when the names differ) |
| 📝 Chat → Memory, 📥 Recover context | Personality → Memory |
| 💬 History | Data → History |
| ⧉ Clone, 📤 Share, 📨 Send, 👪 New child, Proposals, Push, Propose | Sharing → Copy or share |
| Move (to a runner), Move to another Hatchabot, Download copy | Advanced |
| Wake, Start, Retry, Sleep, Stop | the sheet's bar; Stop in Overview → Checks |
| Rebuild / Update | Overview → Rebuild; notices |
| 📥 Archive, 📤 Restore, 🔍 Inspect, Delete | Advanced → Careful; the sheet's bar; drag to Archived or the bin |
| 🏷 Group | Overview → Group; drag between groups |
| 📊 Usage, ❤️ Health, Logs (per agent) | Overview → Checks, Usage |
| OpenClaw (debug) | the agent's icon, 💬 Chat |
| Members list with remove × | Sharing → Remove |
| Bulk actions, Rebuild all | ⚡ Bulk actions (Rebuild all at its foot) |
| Inbox | the Inbox button (when not empty), the account menu |
| Import, 📋 Templates | New agent → open a .hatchabot file / start from a template |
| 📊 Usage, 📊 Sources (all agents) | Usage; View by → Source / Model |
| Setup guide, Help, Install app, theme, sign out | the header and the account menu |
| Rate-limit banner, bot pool count | the tile's status and Alerts; Settings → Telegram |
| Recent activity | Activity |
| 📑 Jump legend | not needed with icons; View by → Alerts |
| Planned agents; manual order; Run health checks (all); Setup-values notice; Telegram Web | **missing** — see "What only classic has" |
