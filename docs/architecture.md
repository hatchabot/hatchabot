# Architecture

How the code is put together: the process, the layers and the rules the
tests hold it to, and every piece of state kept in memory. For where each
feature's code is, use `docs/architecture-map.md`. The counts are of
2026-11-23 and will drift.

## System shape

One Node 22 process (Fastify, run under `tsx`, no build step) serves the web
app and the `/v1` API, owns one SQLite database, and drives Docker. Agents
are OpenClaw containers, one per agent, each with its own volume. Other
machines ("runners") are reached through the same provider interface as the
local Docker.

## Boot order

`src/index.ts`:

1. open the database;
2. build the runtime providers;
3. reconcile every agent's state with what Docker reports;
4. register sign-in (`registerAuth`);
5. register routes (`registerRoutes`, which builds each feature's service
   once, puts the ones other features call on the route context, and
   registers each feature's route file in turn);
6. start timers (the services' timers start as each is built, and end in
   its `stop()`);
7. listen.

## Modules

99k lines of TypeScript in `src/`, 328 files (at v2.190.0: 88k lines in
183 files; the split added the services' interfaces and moved code out of
one file into many).

| Module | Size | Role |
|---|---|---|
| `src/orchestrator/` | 50k lines, 185 files in 28 folders | Use cases, a service per feature: lifecycle (provision, rebuild, create, edits), sources, usage and budgets, schedules, backups, transfer, apps, members, channels, console, machines, memory, Google and the rest |
| `src/api/` | 21k lines, 69 files in 8 folders | HTTP: a route file per feature, in the folder of its area (sign-in, console, agents, chat, data, usage, machine, ops), with auth and the console proxy; at the top `routes.ts`, which builds the services and registers the route files, its context, and what every folder shares: public access, trust, the request log |
| `src/store/` | 7k lines, 2 files | One `Store` class: 89 tables and about 500 methods; the schema's numbered steps (`schemaVersion.ts`) |
| `src/providers/` | 5.1k lines | The `RuntimeProvider` interface; local Docker, mock, runner resolution |
| `src/mgmt/` | 3.2k lines | Management chat broker, its tools, and the coverage ledger |
| `src/openclaw/` | 2.4k lines | OpenClaw config commands, workspace files, skills |
| `src/ops/`, `src/channels/`, `src/domain/`, `src/config/`, `src/embedder/`, `src/secrets/` | 6k lines | Tailnet and upgrades, Telegram pool, types and state machine, settings catalog, embedding service, encrypted secrets |
| `src/cli.ts`, `src/doctor.ts` | 4.2k lines | The CLI (a client of the API) and install checks |

## Other parts

- **Web client:** `web/index.html`, 3k lines of markup and styles, and
  since HB-0811 its code in 24 classic scripts in `web/app/` (about
  850 global functions and about 320 `innerHTML` writes). No framework, no
  modules, no build. Elements name their event actions in data attributes
  (`data-on-click`, through `onAction()`); there are no inline handlers
  since HB-0810.
- **Lifecycle scripts:** about 80 files in `scripts/` for install, upgrade
  with rollback, deploy, backup, release and the privacy checks.
- **Tests:** 428 test files in `test/`, plus a browser click-through
  (`scripts/ui-clickthrough.mjs`).

## Intended dependency direction

```
api  ->  orchestrator  ->  providers, openclaw, channels, embedder, ops, mgmt  ->  store  ->  domain, config, secrets, util
```

`src/cli.ts` talks to the API over HTTP. `src/domain/` imports nothing
outward. Routes contain no SQL: all data access goes through `Store`.

## Design rules enforced by tests

- Agent state changes go through `src/domain/stateMachine.ts`.
- One operation per agent at a time: its reservation, with what it is for
  (`src/orchestrator/lifecycle/reservations.ts`; the busy flag,
  `src/orchestrator/lifecycle/busy.ts`, is its facade), plus
  per-agent and per-class queues (each a `keyedLock`, `src/util/queues.ts`).
- Every route is classified public or private
  (`src/api/publicRoutes.ts`).
- Every route that changes something has an entry in the manager's coverage
  ledger (`src/mgmt/coverage.ts`).
- Every `HATCHABOT_*` setting is in `src/config/envCatalog.ts`.
- The knowledge pack names only files and functions that exist
  (`test/knowledgePack.test.ts`).
- Secrets are encrypted at rest and never pass through a model.
- Since 2.191.0:
  - imports point only down the direction above (`test/layers.test.ts`);
  - `src/api/routes.ts` registers no route and `src/api/` casts no request
    body, both held at zero (`test/sizeRatchets.test.ts`);
  - every Map or Set that outlives a request, and every keyed lock
    (`keyedLock`), is listed below ("In-memory state, sorted") as a lock or
    a cache (`test/inMemoryState.test.ts`),
    and what a restart may not lose is in the store, with tests that
    restart in the middle
    (`test/holdsAcrossRestart.test.ts`);
  - each schema change is a numbered step that is never edited
    (`test/schemaVersion.test.ts`);
  - a path a file finds from its own place names a file that exists
    (`test/locationPaths.test.ts`).

## In-memory state, sorted (HB-0809)

Every Map and Set that outlives a request, in the routes' closure, the
services and the modules (a fixed list of words, such as `RESERVED_ENV_EXACT`,
is not state and is not here), and every keyed lock (`keyedLock`, a Map of
turns of its own: each is a row under the name it is kept as). Each is one
of three kinds:

- **Lock**: it orders, guards or carries work inside this process (a queue,
  a flag, a count of what is under way, a live connection, a value one step
  hands the next), and that work ends with the process.
- **Cache**: lost, it is worked out again: a reading is read again, a count
  starts again from zero, a line said once is said once more.
- **Hold**: lost at a restart, something stays wrong until another step puts
  it right.

**No hold is in memory.** The six that were are in the store or made up for
at the start:

| Was in memory | What a restart lost | Where it is now |
| --- | --- | --- |
| `modelWaitsImage` (`lifecycle/classChanges.ts`) | The list counted the agent as still on an old model until its rebuild, though its model only waited for an image. | Stored with the class's write: `agent_holds`, `model-waits-image` (`modelWaitingForImage`). Cleared by the next class written to it and by the rebuild that makes its new container. |
| The detach waiting behind `classEditsUnderWay` (`lifecycle/classChanges.ts`, HB-0820) | The agent stayed in a class it had drifted from, and the class's next edit wrote over its owner's choice. | Stored with the write that drifted it: `agent_holds`, `class-detach`. Decided by the same process once the edit is done, or by the next process as it builds the service, before any request. |
| The write a `modelApplies` queue still owed (`lifecycle/modelRuntime.ts`) | A model stored and not yet on its runtime waited for a rebuild, shown as pending. | Asked for in the store: `agent_holds`, `model-apply`, with the model where the caller passes `apply` to `Store.setAgentModel` (the model route, a class change, the budget), and when it is queued otherwise. The next process serves the asks it finds (`applyOwed`). |
| The run `budgetSyncs` still owed (`lifecycle/memoryLimits.ts`) | An agent busy or being rebuilt when its cap moved kept the old budget in its AGENTS.md until its next start, wake, rebuild or change of cap. | Not stored: nothing has to say which agents were owed. The next process tells every running agent its budget once (`tellRunning`), and a section that says the cap is left as it is. |
| `embedToIndex` (`src/orchestrator/lifecycle/provision.ts`) | A build that changed the memory search engine and was resumed after a restart skipped its re-index: memory search stayed paused. | Stored when the build's container is accepted: `agent_holds`, `embed-reindex`, until the re-index step has ended. |
| `skipPoolOnce` (`src/orchestrator/lifecycle/provision.ts`) | A new agent whose owner declined a pool bot, cut off before its setup had parked it for a token: its Retry leased a pool bot. | Stored with the agent's row: `agent_holds`, `skip-pool`, until the step is parked or has its bot. |

A hold that would change an agent is taken up by the process after the one
that kept it, or not at all. A release from before `agent_holds` (v2.190.0 and older) neither
serves nor clears the table, nor does a release a kind of hold is newer
than, so a rollback leaves its time beside the database
(`<database>.rolled-back`, written by `scripts/upgrade.sh`,
`scripts/deploy-release.sh` and `scripts/restart.sh`, and only when the
release being left really started: `left_ran`) and the next start of
a release that reads the note lets go of the holds kept before it that would
change an agent if served (a model to put on, a class to leave, a budget's
pause), before anything reads one; facts, refusals, watches with their own
clocks and harmless work stay, and so does every hold kept after it
(`HOLDS_AFTER_ROLLBACK` in `src/store/rollbackMark.ts` places each kind,
HB-0840). Each release lets go only of the kinds it knows, so the note
stays while a hold of a kind it does not know, kept before the note, is
there: the later release that knows it lets go of it. The release being left runs on until the restart back stops it,
so a note written while a process ran gets the time that process stops
(`restampRollbackMark`). A new kind of hold is placed there, drop or keep;
one is retired only by deleting its rows, at each start, or it stays placed:
its rows left unknown keep the note for good (test/rollbackMark.test.ts
holds every released kind, HB-1455).

The sign-in lockout (failed sign-ins, and the lockouts that double) is in
the store as well, by the owner's choice (HB-0836): `failures` and
`strikes` (`src/api/signIn/auth.ts`) are this process's copy of counts kept in
`rate_hits`, the consult limit's table, and read back at the start, so a
restart no longer gives a locked-out guesser ten more tries. A count is
kept once it refuses, written once as its limit's misses, so a flood of
made-up names, each missed once, writes nothing, and each bucket kept costs
a window's misses; a forwarded-for address, which a peer that reaches the
listener for `tailscale serve` can make up, is never kept (the account's count and the public address's carry the
rule). A name typed at sign-in that is nobody's account is kept like an
account's while the store holds fewer than 500 name counts, and past that in
memory only (HB-1240): an account's count is always kept, so no flood of
made-up names makes a restart forget a real lockout, and below the bound a
restart does not tell which names are accounts. The table is pruned by time
once a minute, by an index (step 114).
Recovering an account clears its password and second-factor counts and
their strikes. The other
limits counted in memory (recovery messages, new-device notices, the public
address's per-minute ceiling, pushes to the owner's phone, the manager's
searches) stay there: a restart gives at most one more of each, which opens
no door.

Three things that are not Maps were found with them and fixed in the same
change. A class edit's records (the class's row and every member's) are one
transaction, where each was its own and a kill between two left the class
and its members disagreeing (`writeClassEdit`). What follows an edit's
records, each member's container, is covered by the asks above, the limits
check and `tellRunning`. And a container stopped so its bot can be handed
on owes its rebuild on its record from that moment (`owedAfterHandover`,
HB-0830), where a restart before the rebuild was queued left a stopped agent
whose Start ran the old container on a bot it had given back. A new agent's
row, its "no Telegram" and its "no pool bot" are one transaction too.

How the next process takes these up: what needs only the store is done as
the agent settings service is built (`createAgentSettings`: a detach left to
be decided), so before any request; what needs a machine is done by
`AgentSettings.resume()`, which the boot runs once the operations the last
process left are settled (`resumeOperations` in `src/api/routes.ts`). It
waits a little for a container the record says is running: after a restart
of the whole machine Docker may not have started it yet, and a write asked
then would read as refused (`containerUp`). A resumed rebuild reads its own
(`reindexMemoryIfSwitched`).
`test/holdsAcrossRestart.test.ts` restarts in the middle of each, and
`test/inMemoryState.test.ts` holds the tables below to the code: a Map or
Set that outlives a request and has no row fails it, as does a row whose
state is gone or whose kind is not a lock or a cache.

What a Start owes after it (HB-0833), a saved operator profile's push
(HB-0834), a budget's pause (HB-0835) and the watch for a first message
(HB-0838) are now made up for at the next start, and the start's pass waits
for each agent's own operations only (HB-0839). An AI source's new default
is asked for in the store for each ticked agent, with the writes, and a bulk
switch's "recover after" is kept on its rebuild's operation (HB-0832); a
budget's cheaper model refused at the start is put back as the pass puts
one back (a source switched since leaves it; a follower is held on the
default it followed; a model written for it since is not undone), and the
switch dropped (HB-1404). What is left open is in the backlog: a hold kept by a
release that was rolled back is taken up when it is installed again
(HB-0840).

**The agent settings service** (`src/orchestrator/lifecycle/`)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `modelApplies` | `modelRuntime.ts` | lock | Nothing: a write it still owed is asked for in the store (above). |
| `limitApplies` | `memoryLimits.ts` | lock | Nothing: the limits are in the store, and the limits check puts them back on a container at the start and every ten minutes. |
| `budgetSyncs` | `memoryLimits.ts` | lock | Nothing: a run it still owed is made up for by `tellRunning` (above). |
| `budgetWaits` | `memoryLimits.ts` | lock | Nothing: the timers of the waits for a busy agent, which `stop()` ends. |
| `classQueues` | `classChanges.ts` | lock | Nothing. An edit's records are written whole or not at all. |
| `classEditsUnderWay` | `classChanges.ts` | lock | Nothing: the detach it holds back is in the store (above). |
| `detachWaits` | `classChanges.ts` | lock | Nothing: how many such decisions an agent still waits for; its stored mark goes with the last. |
| `classWrote` | `classChanges.ts` | cache | Nothing: read only by a join retrying inside one request. |
| `sourceHolds` | `sourceHolds.ts` | lock | Nothing: the switch that held the source ends with the process. |

The AI sources service (`src/orchestrator/sources/aiSources.ts`, HB-0808)
has no Map or Set of its own: it reads `sourceHolds` through
`withSourceHold`, and a recovery it chains after a switch's rebuild takes
its place in `recovering`, the memory service's (below), through
`recoverAfterRebuild`.

**The channels service** (`src/orchestrator/channels/`)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `botNameCache` | `chatBots.ts` | cache | Nothing: a Telegram bot's display name is asked of Telegram again. |
| `channelRechecks` | `chatBots.ts` | lock | Nothing: the re-check it held ends with the process. |
| `knockCache` | `knocks.ts` | cache | Nothing: the knocks are read from the container again. |
| `knockReads` | `knocks.ts` | lock | Nothing: the read of an agent's knocks under way, shared by the callers that miss `knockCache` meanwhile; it ends with the process. |
| `announcedPairings` | `knocks.ts` | cache | A knock still waiting is pushed to the owner's phone once more by the next sweep. |
| `pairingSweeping` | `knocks.ts` | lock | Nothing: one sweep at a time; the next starts a minute after the start. |

A Slack or Discord bot name still owed is kept in its channel's settings
(`pendingName`) and a Telegram pool bot's in the pool's table, so the name
retry's timer loses nothing. An agent stopped for a bot handover owes its
rebuild on its record (`owedAfterHandover`, HB-0830, above). Not a Map: the
watcher that claims a person's first message (`claimFirstContact`, started
by a setup that finishes, an import, the Telegram attach, a join and a
reopened door) runs in memory for its window, and is kept in the store
while it runs (`agent_holds`, `first-contact`; a join as its
`pending-joins`), with what its window needs that the window's row does
not say: the ids it never claims, when it first opened, and the up-time it
had left, which does not run while the agent is down. The next start
watches each one again for that time (`resumeFirstContacts`, and
`resumePendingJoins` for a join, HB-0838), not a fresh half hour; only a
join kept by an older release, before it kept its time, has its whole
half hour again. One whose time ran out meanwhile has its window closed and
is not opened again, so someone who wrote then is not let in; a join's
owner is told so, once: that its time ran out while Hatchabot was
restarting, and how to let them in (under Alerts, where their message
waits only if the agent shows it there, or with Let them in again), or,
when its window had ended while Hatchabot ran and the restart cut off the
watch's own word, that it was never messaged. The next sweep puts the door
back to rest (`restDoor`).

**The backups service** (`src/orchestrator/backups/`, HB-0808) has no Map
or Set of its own. Its one timer, the drill schedule's fifteen-minute check
(`restoreDrills.ts`), ends with `stop()`; a schedule missed by a restart is
checked again a quarter of an hour after the start. A snapshot taken or
restored waits in the agent's core-files turn, which is `agentsMdTurns`
(the agent files service's, below). Whether a backup or
a drill is running is a plain variable in `backupFiles.ts` and `drills.ts`
(`runState`), not a Map: a Back up now or a drill cut off by a restart is
failed at the start (its `backup-run` or `restore-drill` operation), and
the set's lock and `backup-status.json` say the rest. A restore, from a set
or a snapshot, holds the busy flag only while it runs; it is an operation on
disk, finished, undone or held at the start (`resumeBackupRestore`,
`resumeSnapshotRestore`).

**The apps and data sources service** (`src/orchestrator/apps/`, HB-0808)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `appAccountLocks` | `agentApps.ts` | lock | Nothing: installs and updates of one app on one account, one at a time. Each is an operation on disk (`app-install`, `app-update`), settled or held at the start (`appOperations.ts`). |
| `pendingRuns` | `agentApps.ts` | lock | Nothing: one run of a waiting install per agent, and one more wanted. The request waits in the store (`agent_app_pending`), and the start runs it (`resumeOperations`). |
| `mirrorTurns` | `apps.ts` | lock | Nothing: one clone or fetch of a git address's mirror at a time. A clone goes to a folder of its own and is moved into place whole, so one cut off leaves no mirror, and the next read clones again; a folder an earlier release left half cloned fails its fetch and is cloned again in the same turn. |
| `addingSources` | `dataSources.ts` | lock | Nothing: a name held from the clash check to its row. A private repo's key saved with no row after it is a secret no source names. |
| `dataSourceChecks` | `dataSources.ts` | lock | Nothing: one Test of a repo at a time; a check changes nothing. |

It has no timer, so no `stop()`. A public repo cloned at once, and the
AGENTS.md sync after a removal, run under the busy flag in the background, as
before; a clone cut off is made at the next rebuild, and a removal's scrub is
recorded before its row goes (`data_source_removals`), retried at the next
start, wake or rebuild.

**The console and browser panel service** (`src/orchestrator/console/`, HB-0808)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `pendingConsoleSessions` | `consoleGate.ts` | lock | Nothing: the console requests and handshakes under way, each with the browser session a sign-out ends; they end with the process. |
| `open` | `consoleSockets.ts` | lock | The open console sockets, which close with the process; a browser opens its console again. |
| `panelAccess`, `pendingPanelOpens` | `signInPanels.ts` | lock | The open sign-in panels and the opens under way, with what let each in; they close with the process. |
| `#pending`, `#byId`, `#byAgent` | `browserPanel.ts` | lock | The open panels. |

Its three timers end with `stop()`: the open sockets' sweep and the panels'
sweep (every 30 seconds, also under the tests, as before) and the browsers'
sweep (every minute, `HATCHABOT_BROWSER_SWEEP_MS`; off under the tests, as
before). The first two also end when the app closes, as they did; the
browsers' was never cleared before. What a guest's console visits leave in
the timeline (`#last`, `#names`, `api/console/guestConsoleLog.ts`, below) is kept by
the console's routes (`src/api/console/consoleRoutes.ts`). `ConsoleAccess`
(`consoleAccess.ts`, below) is built by the gate, one per process; its own
sweep of guests' consoles ends by itself once none is open.

**The machines service** (`src/orchestrator/machines/`, HB-0808)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `imageCopies` | `imageInstalls.ts` | cache | The bytes copied so far. The copy is an operation on disk: "interrupted: Install again". |
| `statsCache` | `resources.ts` | cache | Nothing: read again. |
| `buildingImages` | `runtimeImages.ts` | lock | Nothing: one build of a derived image at a time. A build cut off is marked failed as the service is built (`failInterruptedImageBuilds`, the same boot step as before, now in `createRuntimeImages`). |
| `derivedHalts` | `runtimeImages.ts` | lock | Nothing: each derived build under way, for `stop()` to end with its process group; a restart has none running, and marks one cut off failed (`failInterruptedImageBuilds`). |

Not Maps: the base build's state (`baseBuild`), the npm dist-tags read
within the hour (`distTagsCache`) and the read under way that everyone
asking meanwhile shares (`distTagsRead`, HB-0905) are plain variables in
`runtimeImages.ts`;
a base build cut off by a restart is not resumed, as before, and its log
stays on disk. The base build's ceiling (`HATCHABOT_BASE_BUILD_TIMEOUT_MS`,
90 minutes, `unref()`'d, started with each build as before) ends with the
build or with `stop()`. A runner's removal holds `removingHosts` (the
registry's, below) through `beginRemoval` and `endRemoval`, and forgets the
registry's `remoteProviderCache` entries and the memory search service's
`runnerEmbedders` entry for it (`forget`).

**The members, invites and web chat service** (`src/orchestrator/members/`,
HB-0808) has no Map or Set of its own and no timer, so no `stop()`. Who is
a member, who may chat on the web, an invite and whether it is spent, the
app a member joined with and the windows for a first message are all in the
store (`memberships`, `member_identities`, `invites`, `pairing_windows`). A
chat-app join holds the agent's busy flag only while it runs (the route
takes it after the sign-in's wait and lets go when it answers). The watch
for a first message that a join or a reopened door starts, and the half
hour a Telegram invite holds the door for a knock, are `claim.ts`'s timers
(`claimFirstContact`, `holdDoorForKnocks`), started as before; the first is
kept in the store while it runs and watched again at the next start
(HB-0838, above).

**The usage and budgets service** (`src/orchestrator/usage/`, HB-0808)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `capRetryAt` | `usageSampler.ts` | cache | A context cap whose write was refused (a hand edit, a busy gateway) is tried once more, sooner than its six hours. The cap is in the store. |
| `costCache` | `usageReadings.ts` | cache | Nothing: the cost badges are worked out again from the stored profiles. |

Not Maps: the usage pass under way and when the last ended
(`usageSampling`, `usageSampledAt`), the budget pass under way
(`budgetPassing`) and the paused replies' sweep under way (`replySweeping`)
are plain variables, one of each at a time; after a restart the Usage page
shows no last pass until the first, as before. What a budget pass decided is
in the store (`budget_pauses`); the cheaper model it switches to, and the
agent's own model it puts back, are asked for with the write (`apply`,
above), and at the start `AgentSettings.resume()` tells every running agent
its memory budget. A pause cut off between the stop and its record is
HB-0835. Its three timers, each `unref()`'d and off under VITEST as before,
end with `stop()`: the usage pass's first run (90 seconds after the start)
and its interval (`HATCHABOT_USAGE_SAMPLE_MS`, ten minutes; 0 turns it off),
and the paused replies' sweep (every minute). None was cleared at shutdown
before.

**The schedules service** (`src/orchestrator/schedules/`, HB-0808)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `quickTried` | `sweeps.ts` | cache | A task the quick pass could not re-point is tried once more at its first pass after the start. |
| `triggerApplies` | `triggers.ts` | lock | Nothing: one write of the permission at a time. A permission not written leaves a rebuild owed on the record, made before the write. |

The tasks themselves are in each agent's gateway, on its volume; which are
told on the owner's phone, and the run last told, are in the store
(`cron_notes`), and the tasks made quiet until the owner can be reached are
too (`cron_quieted`). Not a Map: whether a quick pass is under way
(`quickRunning`, a plain variable). Its three timers end with `stop()`, and
start as they did, off under the tests: the full pass three minutes after the
start and then every 24 hours, the quick one every `CRON_QUICK_CHECK_MS`
(five minutes), each `unref()`'d. A full pass a restart cut off is run again
three minutes after the start, as before. The quick pass gives the adopts
still waiting for their agent (`finishDeferredAdopts`, the moves, import
and export service's, with `adoptRan` and `adoptLastTry`) their turn first. A template's tasks parked at
import are the store's (`getPendingSchedules`), added by provision.ts.

**The Google connections and access service** (`src/orchestrator/google/`, HB-0808)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `connectionsDeleting` | `connectionVault.ts` | lock | Nothing: the connections whose delete is under way, which an attach refuses. The removal is recorded on every agent that holds it before anything is deleted, and a start, wake or rebuild finishes it. |
| `accessVerifies` | `accessChecks.ts` | lock | Nothing: one Verify now per agent at a time. |
| `secretRetries` | `clientSecretDelivery.ts` | cache | The back-off of an agent whose import of a new client secret keeps failing: tried once more, sooner. What is owed is in the store (`connectionsOwedClientSecret`). |
| `grantChain` | `googleConnections.ts` | lock | Nothing: the installation's Google grant turn (`withGoogleGrantTurn`), a `keyedLock` with one key: a link's code exchange and save, and a revoke with the judging before it, one at a time across every account, so a revoke never ends another account's consent made while it was on its way. A link cut off is begun again with Connect, and a revoke cut off is the vault's pass's to try again. |

Not Maps: the client-secret pass under way (`secretPassRunning`) and the
vault's pass under way (`cleanupPassRunning`, `connectionVault.ts`) are
plain flags, one pass at a time. The consent round-trip's states are one
`OAuthStateJar` (`#jar`, `googleConnections.ts`, below), made as the
service is built: a consent under way when the process ends is begun again
with Connect. The pass's timer (every ten minutes, `unref()`'d, off under
VITEST or NODE_ENV=test as before) starts as the service is built and ends
with `stop()`; it was never cleared at shutdown before. The vault's pass
(`retryCleanups`) has a timer of its own on the same terms, and runs once
as the service is built too: a deleted connection's token still to end is
a row in the store (`connection_cleanups`, put in the connection's place
in one transaction, `retireConnection`), so what a failure or a restart
left is tried again from there (HB-0901). A revoke Google has not
confirmed seven days after the delete (`REVOKE_TRIED_FOR_DAYS`, read from
the row's `created_at`), and over at least a day of tries at the pass's pace
(`REVOKE_TRIES_AT_LEAST`, the row's `tries`), is given up: the token is deleted, the row goes,
and the owner is told on their chat app to remove the access by hand
(`connection.revoke_given_up`, HB-1203).

**The agent lifecycle service** (`src/orchestrator/lifecycle/`, HB-0808 step 11)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `inflight` | `rebuildQueue.ts` | lock | Nothing: the setup or rebuild task of each agent. The work is an operation on disk, settled at the start (`operationsResume.ts`). A rebuild chained behind another in memory (`rebuildAfterHandover`) is owed on the agent's record first. |
| `rebuildQueued` | `rebuildQueue.ts` | cache | Nothing: which rebuilds wait for a slot, for the page. The queue is the operations table (`queued`), put back at the start. |
| `rebuildCancelled` | `rebuildQueue.ts` | lock | Nothing: queued rebuilds a Delete or an Archive called off. Either had written nothing yet (both wait for the rebuild's turn first), so it ends with the process and the rebuild runs as asked. |
| `setupWaits` | `rebuildQueue.ts` | lock | Nothing: the two-second waits of a setup for an answered bot-token step while another holder has the agent, which `stop()` ends. The step stays answered on the record (`pendingAction.received`), and the start takes it up (`resumeOperations`). |
| `imageInfoCache` | `autoRebuilds.ts` | cache | Nothing: each machine's default image is read again (ten seconds at most). |
| `archiving` | `agentRecords.ts` | lock | Nothing: archives from the click to the state flip. Before its operation began nothing was changed; after, the operation is on disk (archive.ts), and the start finishes or undoes it (`resumeArchive`). |
| `deletesRunning` | `agentRecords.ts` | lock | Nothing of its own: a second Delete while one tears down is turned away. A delete cut off leaves the agent DELETING in the store (written before anything is torn down), and its page offers Delete again, which finishes it (HB-0265); nothing at the start needs to make up for it. |
| `capHeld`, `capHolds` | `capacity.ts` | lock | Nothing: the places requests hold while they make an agent, let go when each answers, however long its work takes (HB-0630). The requests end with the process, and a row that was made counts itself, so the start needs nothing. |
| `slowHostUntil` | `agentList.ts` | cache | A minute's skip of a machine that did not answer: it is asked once more, sooner. |

Beside these: the two rebuild gates (`rebuildGate`, `checkpointGate`, `semaphore` in `src/util/queues.ts`: who waits for a slot; the operations table), locks. The sweep of the machine's own rebuilds (every `HATCHABOT_REBUILD_SWEEP_MS`, five minutes; `unref()`'d, off under VITEST or NODE_ENV=test as before) starts as the service is built and ends with `stop()`; it was never cleared at shutdown before. A sweep a restart cut off runs again five minutes after the start. The queue reads the deletes under way, and Start the archive marker, through the records part, as functions.

**The Hatchabot agent service** (`src/orchestrator/ops/`, HB-0808)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `operatorFanout` | `hatchabotAgent.ts` | lock | The order of an owner's pushes. A push not yet made is not made (HB-0834). |
| `doormen` | `hatchabotAgent.ts` | cache | Nothing: the doormen's addresses are read again on the first miss. |

Not Maps: the doormen's read under way and its last look (`doormenRefreshing`,
`doormenLastLook`) are plain variables. The notes posted into the manager's
conversation queue in `src/ops/notify.ts` (`chains`, `queued`, built once by
the service, as before). Its one timer, the lockdown check every ten minutes
(`HATCHABOT_OPS_DRIFT_MS`, `unref()`'d, off under NODE_ENV=test only, as
before), starts as the service is built and ends with `stop()`; it was never
cleared at shutdown before.

**The Report a problem service** (`src/orchestrator/diagnostics/`, HB-0808)
has no Map or Set of its own and no timer, so no `stop()`. A draft is the
store's (`problem_reports`); what a report is masked with is built for that
report and dropped. The source search's slots (`runningFor`, above) are
`problemReport.ts`'s, moved in beside it, and so is the copy of the playbook
that the known-problem check and a draft's known problems both read
(`playbookCache`, its indexes `middles` and `tokens`, sorted arrays of
numbers): a cache, read and indexed again whenever docs/troubleshooting.md's
time or size changes, and after a restart on the first check (HB-1099).

**The health, logs and events service** (`src/orchestrator/health/`, HB-0808)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `swapSeen`, `driftSeen` | `healthChecks.ts` | cache | What was said once is said once more: a host without compressed swap, a limit put back. |

Not a Map: the last check of all agents (`lastLimitsCheck`), read again from
`limits-check.json` by the doctor and made again by the next check. The limits
check's two timers (the first check 45 seconds after the start,
`HATCHABOT_SWAP_BOOT_MS`, and every ten minutes after, `HATCHABOT_SWAP_PROBE_MS`,
each `unref()`'d, off under VITEST or NODE_ENV=test as before) start as the
service is built and end with `stop()`; neither was cleared at shutdown
before. The daily storage measurement (`diskSweep`) runs on src/index.ts's
timer, as before.

**The moves, import and export service** (`src/orchestrator/transfer/`, HB-0808)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `adoptRan`, `adoptLastTry` | `adopts.ts` | cache | A deferred adopt gets one early look and its day again. The adopts themselves are in the store (`adopt_pending`). |
| `adoptWaitSaid`, `adoptRefused` | `adopts.ts` | cache | What was said once is said once more: a waiting adopt, a run of refused re-points; and the first pass after a refusal looks at its gateway again before the re-point. (`adoptWaitSaid` was a module-level Set of routes.ts; now one per service, and the service is built once.) |

No timer, so no `stop()`. A move, a move to another Hatchabot and a full
copy's import are operations on disk (`operations.ts`), settled at the start
by `resumeOperations` as before; a move another server sent here is the
store's (`move_receipts`); a share is the store's (`shares`), claimed before
anything is made and put back when its import fails.

**The agent files service** (`src/orchestrator/files/`, HB-0808 step 13)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `agentsMdTurns` | `coreFileTurns.ts` | lock | Nothing: one write of an agent's files at a time (its core-files turn, `withCoreFilesTurn`, and its AGENTS.md turn, `withAgentsMdTurn`, are this one queue, a `keyedLock`). What waits in it ends with the process; a change cut off part-way is an operation on disk, or a snapshot taken first. It holds the two-minute deadlines of the changes waiting for their core-files turn too, which `stop()` brings forward (each is refused, as its deadline would refuse it, and never runs). |

It has no other timer: each deadline is a change's own, started when it asks
for its turn and cleared when the turn comes (`CORE_FILES_WAIT_MS`, not
`unref()`'d, as before). The core files and the Files pane keep nothing of
their own.

**The skills service** (`src/orchestrator/skills/`, HB-0808 step 13)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `skillStatusReads` | `skills.ts` | lock | Nothing: the status reads under way, one per agent and context. |
| `skillTrialNext` | `skills.ts` | cache | The practice cooldown: after a restart an agent may practise once more, sooner. `stop()` clears it. |

The voice service (`src/orchestrator/voice/agentVoice.ts`, HB-0808 step 13)
has no Map, Set or timer of its own, so no `stop()`. The manager's voice
grants are the store's (`voiceNetwork.ts`).

**The machine settings service** (`src/orchestrator/settings/`, HB-0808
step 15 part A) has no Map or Set of its own. The one search watch it builds
(`createSearchWatch`, webSearch.ts) keeps `settled` (below, with the
modules) and plain variables for the check and the pass under way; a
check or a pass cut off by a restart is made again by the tick. A key is
the secret store's, and reaches an agent at its provision (provision.ts),
as before; which provider an agent searches with is put right by the
watch's next pass. The watch's tick (every ten minutes, `unref()`'d, off
under VITEST only, as before) starts as the service is built and ends with
`stop()`; it was never cleared at shutdown before. A default for this
machine is .env's, written before it is applied; an agent it did not reach
gets it at its next rebuild, as before.

**The definition service and the agent secrets service**
(`src/orchestrator/definition/`, `src/orchestrator/agentSecrets/`, HB-0808
step 15 part C) have no Map, Set or timer of their own, so no `stop()`. A
push's four slots (`semaphore(4)`) and its deadline are per request, as
before. Setup values and a push take each agent's core-files turn (the
files service's) and its busy flag; a change cut off by a restart left its
`pre-params` snapshot, as before. An environment value is the secret
store's, written before its row; a value whose row a restart kept from
being written is a secret no row names, as before. A bot token is held by
the Telegram channel, in memory and on disk (telegramManual.ts), and the
step is marked answered in the store before setup takes it (HB-0542), as
before.

**The home screen service** (`src/orchestrator/homeScreen/`, HB-0808 step 15 part C)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `iconRuns`, `iconIdeaRuns` | `homeIcons.ts` | lock | Nothing: one of each at a time per owner (picking icons, ideas for one). |

They were in the route registry's closure, one of each per `registerRoutes`;
they are one of each per service now, built once per `registerRoutes`, so
nothing changes. The order, the groups and the planned agents are the
store's. No timer, so no `stop()`. The model changes service
(`src/orchestrator/usage/modelChanges.ts`) has no state and no timer; the
ledger's start-up runs where it ran, once, as `registerRoutes` reaches it.

**The memory search service** (`src/orchestrator/memorySearch/`, HB-0808 step 13)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `runnerEmbedders` | `memorySearch.ts` | cache | Nothing: each runner's service is made again on first use. Its state is on disk (`embed-hosts/<host id>`: enabled, its keys and guests), and the agents' key hashes are the store's. |

Its timers are `scheduleEmbedderBoot`'s (src/embedder/embedder.ts), started
by `startTimers()` where routes.ts started them, outside tests only (not
under VITEST or NODE_ENV=test), as before: the boot start
(`HATCHABOT_EMBED_BOOT_MS` or 15 s), the first health pass 30 s after it, and
the health loop every `HATCHABOT_EMBED_HEALTH_MS` or five minutes, all
`unref()`'d. Their stop was not kept before; `stop()` ends them now. The
per-model turns (`modelTurns`) stay a module-level lock of
src/embedder/embedder.ts.

**The conversations service** (`src/orchestrator/conversation/`, HB-0808 step 13, HB-0826)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `sessionsCache` | `conversations.ts` | cache | Nothing: each agent's sessions file is read again at the next list (the first read waits up to three seconds, then fills the cache behind the answer). "Last active" and the unread mark come back with it; the seen marks are the store's (`agent_seen`). A delete drops the agent's entry (`forgetAgent`, HB-0914). |
| `quietTasksCache` | `conversations.ts` | cache | Nothing: an agent's quiet tasks are read again at its next read that finds scheduled runs. A delete drops the agent's entry (`forgetAgent`, HB-0914). |

The Recent capture (`RecentTracker`, src/orchestrator/conversation/recent.ts) keeps each
agent's last line in the store (`setAgentRecent`); its reads in flight
(`#inFlight`) are a lock that ends with the process. The only timer is the
first read's three-second wait (`SESSIONS_FIRST_WAIT_MS`, `unref()`'d, per
read, as before), so no `stop()`.

**The consult service** (`src/orchestrator/consult/`, HB-0808 step 13)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `a2aInFlight` | `consults.ts` | lock | Nothing: the one turn per agent (`turns`: a consult answered, an ask, a checkpoint, a distillation; a consult waited on is `a2aCallerHolds`'s, each role letting go of its own hold only; a Recover context turn running counts too, read from `recovering`). A turn cut off by a restart ends with the process: its caller had no answer, and asks again. |
| `a2aCallerHolds`, `a2aOwnerLive` | `consults.ts` | lock | Nothing: how many consults each caller waits on, and each owner's consults in flight. A consult cut off is gone with them. The hourly count per caller is in the store (`rate_hits`). |
| `callTokenMints` | `peers.ts` | lock | Nothing: a call token is minted again when its two halves disagree. |

It was the route registry's closure (one copy per `registerRoutes`, as
now). No timer: a consult's time limit (`HATCHABOT_A2A_TIMEOUT_MS`) is its
exec's, per request, as is an ask's and a distillation's
(`HATCHABOT_ASK_TIMEOUT_MS`); routes.ts reads the four settings and hands
them in, as before.

**The memory service** (`src/orchestrator/memory/`, HB-0808 step 13)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `recovering` | `contextRecovery.ts` | lock | One recovery turn per agent (Recover context's slots, a click's or one the AI sources service chains behind a bulk switch's rebuild, `afterRebuild`; each held by its own attempt, and the idle sweep counts an agent with one as busy). The turn itself runs on in the agent's container (`nohup`) and confirms in its chat; its slot is held while its process runs (the PID and start time its launch prints, looked at every half minute and before a sleep by hand; a zombie is ended), and from the check that lets it in (its history staged, then launched) until it ends, the agent's one turn is taken; one after a switch's rebuild is not run when a turn is answering then (HB-0887); one chained behind a switch's rebuild is kept on that rebuild's operation too (`recoverOn`), so the rebuild a restart puts back in the queue is followed by it (`requeueRebuild` in `routes.ts`); one whose rebuild the next start finished instead (it had begun on the container) is not run, and the page offers Recover context (HB-0832). |
| `recoveryExpiries` | `contextRecovery.ts` | lock | Nothing: each slot's timers (`unref()`'d), which `stop()` ends: the next look at its turn's process, and fifteen minutes as the ceiling (all a turn whose process is not known has). |

`recovering` was a module-level Set of src/api/routes.ts, shared by every
`registerRoutes` in a process; it is one per service now, and the service
is built once per `registerRoutes`. The server calls that once
(src/index.ts), so nothing changes there; tests that build several apps no
longer share it, and none relied on it. Its timers were never ended
before; `stop()` ends them now (being `unref()`'d, they never held the
process). The checkpoint, ask and distillation keep nothing of their own:
each takes the consult service's `turns`. The merge takes the master's
core-files turn and its busy flag, and the proposal is claimed in the
store before anything is written (reopened when the write fails).

**The accounts service** (`src/orchestrator/accounts/`, HB-0808 step 15 part B)

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `recoverySentAt`, `publicRecovery` | `telegramRecovery.ts` | cache | The counts of recovery asks: they start again, so one more message per name can be asked for in the window after a restart. A link that is still good is never replaced, from the store (HB-0836). |
| `threadCache` | `people.ts` | cache | Nothing: each agent's sessions are read again for the roster. A reading is reused for a minute, and each roster drops those older than that, so one for an agent deleted or stopped since is kept only until the first roster after its minute (HB-1132). |

The switch to accounts keeps one at a time with a plain flag
(`familySwitchRunning`, a lock): a switch cut off by a restart left its
account with nothing to finish it, and the next try replaces it (HB-0423),
as before; the .env is written after the account and before the adoption,
which the first sign-in makes up for (index.ts). Its restart timer (1.2 s
after the answer, `unref()`'d, only under a supervisor and not under VITEST)
ends with `stop()`, which the process's own shutdown follows with an exit
anyway, so nothing changes at exit. The roughly constant answer time of
"Forgot password?" (at most 0.9 s per request) is the route's, and ends
with its request.

**The reach service** (`src/orchestrator/reach/`, HB-0808 step 15 part B)
has no Map or Set of its own. The address the tailnet probe found is a plain
variable (`detectedUrl`, a cache: the probe finds it again 4 s after the
start, and until then the app shows HATCHABOT_PUBLIC_URL as set, as before;
an address written for links is .env's). That written address is also a
plain variable of the module (`publicUrlWritten`, HB-1314), for the origin
check and the session cookie's https fallback, which judge a request with
no service to hand: a restart reads it from .env. The probe's two timers (4 s after
the start, then every ten minutes, each `unref()`'d, off under VITEST or
NODE_ENV=test, as before) start as the service is built, earlier in the same
synchronous part of `registerRoutes` than before, and end with `stop()`;
they were never cleared at shutdown before.

**The route registry's closure** (`src/api/routes.ts`)

| State | Kind | What a restart loses |
| --- | --- | --- |
| `onceHeld` | lock | Nothing: one request at a time for a key. |
| `removingHosts` | lock | Nothing of its own. A removal cut off leaves the host's row, and Remove is pressed again. |
| `webChatInFlight` | lock | Nothing: web chat turns in flight. |
| `remoteProviderCache` | cache | Nothing: made again on first use. |
| `aliasCache` | cache | Nothing: read again. |
| `restartsSeen` | cache | A container's restart while Hatchabot was down is not noticed. |

Beside these: the flags that keep one pass of a sweep at a time. All locks.

**Modules of `src/orchestrator/`**

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `reservations`, `freed` | `lifecycle/reservations.ts` (its facade `lifecycle/busy.ts`: the busy flag) | lock | Each agent's one reservation, with its holder (only that holder's release lets it go, HB-1385) and what it was taken for (its purpose, named at every take, HB-1465), and who waits for one to be let go. The work it guarded ends with the process, and what that work left is made up for at the start by what its purpose is: a long change is an operation on disk, settled by `resumeOperations` and left alone by reconcile meanwhile; a start, stop, sleep, wake, pause, download or a manager agent's restart for its tools (`src/index.ts`) leaves the record for reconcile to judge by the container; what is owed after one is in the store (an AGENTS.md sync and a budget's pause in `agent_holds`, a bot handover's rebuild on the agent's record, template tasks still to add, an adopt's re-point); a write to its files, tasks, apps, settings or people is one change that ends where it stood, with its own snapshot or record. Cut off, some leave an agent that ran stopped until its owner starts it (see the backlog): a bot handover (Telegram's detach or swap, a Discord or Slack bot's swap or detach, `stopForBotHandover`), with only its rebuild owed at that Start (HB-0830), a download, and a manager agent's restart for its tools. None is kept in the database: `test/reservations.test.ts` restarts in the middle of one of each (a Stop, an Archive, an AGENTS.md sync, a file save before its rename). |
| `filesReplacing`, `watchers` | `lifecycle/operations.ts` | lock | Nothing: a snapshot compares the count before and after one read; a wait for an operation's row. |
| `embedDecision`, `renderedFrom` | `lifecycle/provision.ts` | lock | Nothing: what one build hands its own next step, until its container is accepted. A build cut off before that is run again and decides again. |
| `gitAccessTurns` | `lifecycle/provision.ts` | lock | Nothing: a key not scrubbed is a removal in the store. |
| `renderRefused` | `lifecycle/provision.ts` | cache | A rebuild refused at render is tried once more by the sweep, sooner. |
| `sessionsGapAfterForce` | `lifecycle/provision.ts` | cache | One forced index more at the next rebuild, at most. |
| `unsureSaid`, `budgetUnsureSaid` | `lifecycle/provision.ts` | cache | A section its code fences leave unsure is said once more, at the next sync and at each start's `tellRunning`. |
| `markPending`, `waking` | `lifecycle/hibernate.ts` | lock | Nothing: a bedtime is on the record before the container stops. |
| `wakeFailures`, `refusedTokens` | `lifecycle/hibernate.ts` | cache | Three more tries at a wake that fails; a refused token is said once more. |
| `compactingNow`, `capSyncs` | `memory/compactionState.ts`, `memory/compaction.ts` | lock | Nothing: a cap not written is found by the next pass. A compaction cut off is finished in the ledger as interrupted at the next start (`finishInterruptedCompactions`), saying whether it had been sent to the agent; it is not run again. |
| `sampling`, `lastStarted` | `usage/sourceUsage.ts` | lock, cache | Nothing: list order once. |
| `refusals`, `retried` | `usage/budgets.ts`, `usage/usageAlerts.ts` | cache | A refusal's daily line, or a warning that did not arrive, once more. |
| `setOwners`, `copiesUnderWay` | `backups/backupFiles.ts` | cache, lock | Nothing: a move's leftover copies are swept at the start. |
| `memo`, `assertions` | `channels/dmPolicyMemo.ts` | cache | Every door policy is asserted once more. |
| `cache`, `hits` | `machines/runtimeCaps.ts`, `usage/agentCosts.ts` | cache | Nothing. |
| `probing` | `machines/runtimeCaps.ts` | lock | Nothing: the probe under way per image, which everyone asking meanwhile waits for (HB-1020). |
| `settled` | `settings/webSearch.ts` | cache | Nothing: each agent's search setting is looked at once more. |
| `warmCache` | `sources/warmModels.ts` | cache | Nothing: each model server is asked again (one question at a time per server, HB-1102). |
| `sweeping`, `buildFailed`, `sizes` | `console/browser.ts` | lock, cache, cache | A failed browser image build is tried once more, sooner. |
| `#state`, `#ready`, `#named`, `#roomMade` | `console/consoleAccess.ts` | cache | Nothing: each gateway is asked again. |
| `#inflight`, `#sockets`, `#held` | `console/consoleAccess.ts` | lock | The open guest consoles. |
| `#inFlight` | `conversation/recent.ts` | lock | Nothing. |
| `#jar`, `connectionChains` | `google/googleConnections.ts` | lock | A consent under way: Connect is pressed again. |
| `vaultChains` | `google/googleConnections.ts` | lock | Nothing: one link or delete of an owner's Google connections at a time, and the vault's pass's try at each of their deleted tokens. A delete cut off has its removal recorded on every agent, and is pressed again; one cut off once its row has gone left a `connection_cleanups` row, which the pass takes up. |
| `keyMaking`, `rowLocks`, `runningFor` | `machines/runnerSetup.ts`, `apps/appPending.ts`, `diagnostics/problemReport.ts` | lock | Nothing. |
| `playbookCache` (`middles`, `tokens`) | `diagnostics/problemReport.ts` | cache | Nothing: the playbook is read and indexed again on the first known-problem check, as it is whenever the file's time or size changes (HB-1099). |

**The rest of `src/`**

| State | Where | Kind | What a restart loses |
| --- | --- | --- | --- |
| `keyedLock` | `util/queues.ts` | lock | Nothing of its own: each lock it makes is a row in these tables under the name it is kept as (`agentsMdTurns`, `rowLocks`, `envLocks` and the rest), holding each key's turns (forgotten once idle) and the deadlines of the waiters with a wait limit (brought forward by its `stop()`). What waits in one ends with the process. |
| `#modelGens` | `store/store.ts` | lock | Nothing: write counts that two steps of one request compare. |
| `#pending`, `#changedAt` | `channels/telegramManual.ts` | cache | Nothing: a pasted token is held on disk and read back at the start. |
| `#nameTurns` | `channels/telegramPool.ts` | lock | Nothing: one name write per pool bot at a time; a name still owed is in the pool's table (`desired_name`) and the sweep writes it. |
| `#sayingGoodbye` | `channels/telegramPool.ts` | lock | Nothing: a freed pool bot is not leased while its farewell goes out; a farewell a restart cut off is over, and the bot is free as its release left it. |
| `IN_FLIGHT`, `VOLUME_LOCKS` | `providers/localDockerProvider.ts` | lock | Nothing: one-shots a process left are swept, and each volume is looked at once after a start. |
| `COPYING` | `providers/localDockerProvider.ts` | lock | Nothing: a model copy ends with its process, and the next process's sweep takes the container it read from. |
| `GIVEN_UP`, `LOOKED`, `UNLISTED`, `#infoCache` | `providers/localDockerProvider.ts` | cache | Nothing: one look per volume. |
| `#tunnels`, `#tunnelOpening` | `providers/localDockerProvider.ts` | lock | The open tunnels to runners, opened again on use. |
| `providers`, `remoteProviders` | `index.ts` | cache | Nothing. |
| `modelTurns`, `envLocks` | `embedder/embedder.ts`, `config/envFile.ts` | lock | Nothing: a half-made model copy is cleared at the next fetch. |
| `buckets`, `byteBuckets`, `inflightBy` | `embedder/door.ts` (the embedding door's own process, in its container) | cache, cache, lock | Nothing at a restart of Hatchabot: the door runs on. Its own restart gives each key a full minute's calls and bytes again, and ends the calls in flight. A key's buckets are dropped once they are full again, looked at once a minute, and its count of calls in flight at zero, so a deleted agent or guest leaves nothing behind (HB-1022). |
| `failures`, `strikes` | `api/signIn/auth.ts` | cache | A count below its limit starts again (the rest of one window's tries). A count that refuses (a lockout) and its strikes are in the store as well (`rate_hits`) and read back at the start, under the same bound (HB-0836). The bound is 10,000 counts: past it, this machine's own side's address counts below their limit and names typed there that are nobody's account go first, then that side's address lockouts (a peer on the machine can forge forwarded-for addresses); every count at the public address (all held to the public ceiling), the ceiling itself, accounts' counts and the shared ones go last. So no flood from the machine's side lets an account's lockout, a public address's lockout or the public ceiling go (HB-1389). Only a count at the public address gets a strike (a forwarded-for address that reads like one is an address on this side), and the strikes are held to the same bound (HB-1389 review). |
| `pending` | `api/signIn/auth.ts` | lock | Nothing: guesses being checked. |
| `revoked`, `unsaved` | `api/publicAccess.ts` | cache, lock | Nothing: the signed-out passes are in the store and read back at the start. A sign-out whose record could not be written was refused (503) and is written again until saved (HB-0957); one still not saved at a restart is lost, and its copies work again. |
| `noticePairs`, `noticeDay`, `announced`, `perAddress` | `api/publicAccess.ts` | cache | The limits on new-device notices and the per-minute ceiling start again; a sign-in is announced once more (HB-0836). |
| `sockets`, `upgraded`, `publicSockets`, `proxySockets`, `decided`, `#waiting`, `unanswered`, `running` | `api/publicAccess.ts`, `api/trust.ts`, `api/proxyListener.ts`, `api/console/consoleProxy.ts` | lock | The open connections, and what each console socket still waits for; for each connection to the listener for a proxy, whether its peer's user is believed, and whether a "cannot tell" is being asked again (HB-1239). |
| `challenges` | `api/signIn/secondFactor.ts` | lock | A passkey ceremony under way is begun again. |
| `#certs`, `cache`, `files` | `api/signIn/identity.ts`, `api/console/controlUiMath.ts`, `api/machine/pageRoutes.ts` | cache | Nothing. |
| `confirmers`, `opsBrokers`, `confirming` | `api/ops/mgmtChat.ts` | cache, cache, lock | Nothing: a card is in the store. |
| `#map` | `mgmt/pendingStore.ts` | cache | Nothing where it is backed by the store (the web's cards); a chat confirmation of two minutes is asked again. |
| `refused`, `allowed` | `api/signIn/firstAccount.ts` | cache | Nothing: asked of the store again. |
| `#last`, `#names` | `api/console/guestConsoleLog.ts` | cache | A guest's console visit is written to the timeline once more. |
| `drifted` | `ops/opsDrift.ts` | cache | Why the manager's key is suspended, found again at the next check within ten minutes. The suspension is in the store. |
| `tunnelsBy` | `ops/opsServer.ts` | lock | The manager's open tunnels. |
| `results`, `hits`, `#sent` | `ops/opsWeb.ts`, `ops/push.ts` | cache | Search results kept for a follow-up, and the hourly counts of searches and pushes, which start again. |
| `chains`, `queued` | `ops/notify.ts` | lock | A note still waiting for the manager's turn is not given. The outcome it was about is on the home screen. |

Two turns stay plain promise chains, not keyed locks: the rewrite of the
ssh config (`configWrites`, `machines/runnerSetup.ts`) and the memory search
service's start, stop, restart, removal and health tick (`#busy`, through
`#serial`, `embedder/embedder.ts`). Each has one key, no Map and nothing to forget, and
its tail is caught where it is kept. `grantChain` has one key too, but it is
a `keyedLock` beside the two Google turns keyed by agent and by owner
(`connectionChains`, `vaultChains`), so the three are one kind.
