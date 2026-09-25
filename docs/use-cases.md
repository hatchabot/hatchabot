# What people do with Hatchabot — the use cases, and what exercises them

*Written 2026-09-25 (v2.77.x) at Chris's request: "enumerate all the end-user
use cases, check which have been tested, look for inconsistencies, build tests."
Surfaces: **U** web UI · **C** CLI · **A** REST API · **M** management chat.
Coverage: **auto** = an automated test drives it (vitest, the e2e, the
regression or the candidate gate); **manual** = only a person has exercised it;
**none** = nothing exercises it yet. The coverage column is kept current by
`scripts/use-case-coverage.mjs` (below).*

## A. First run & setup
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| A1 | Install with the one-line installer, picking a channel | C | auto (clean-install-test.sh, LXD) |
| A2 | Upgrade to the newest release on my channel, or roll back | C `upgrade` | auto (clean-install-test.sh) |
| A3 | Check the install with `doctor`, with fixes and `--json` | C | auto (doctor.test.ts, clean-install-test.sh) |
| A4 | First visit: create the owner account, or unlock with the shared password | U | auto (accounts*.test.ts) |
| A5 | Follow the live-ticked setup guide | U | none (UI only) |
| A6 | Put Hatchabot on my tailnet over HTTPS; phone QR | U A | auto (tailnet.test.ts, publicUrlWrite.test.ts, routeGaps2.test.ts) |
| A7 | Install as a phone/desktop app (PWA) | U | none (UI only) |
| A8 | Icon home screen vs Classic; light/dark | U | none (UI only; screenshots.mjs renders it) |
| A9 | Uninstall; purge | C | none |
| A10 | Two installations on one host; TLS directly | C (.env) | none — see S0 |
| A11 | The isolated smoke test | C | auto (npm run smoke) |

## B. Accounts & login
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| B1 | Sign in with username/password, Google, or the shared password | U C | auto (accountsAuth, identity tests) |
| B2 | Turn on family accounts (one-way) | U A | auto (familyAccounts.test.ts, posture.test.ts) |
| B3 | Invite another person to an account | U A | auto (accountsAuth.test.ts, accountsCreateCli.test.ts) |
| B4 | Create accounts from the machine (`--host-owner`, CLI token) | C | auto (accountsCreateCli.test.ts) |
| B5 | Change my password | U | auto (accountsAuth.test.ts) |
| B6 | Send a member a reset link | U | auto |
| B7 | Forgot password by Telegram (or Discord) | U A | auto (passwordRecovery.test.ts) |
| B8 | Recovery code: make, replace, sign in with | U A | auto (accountsAuth.test.ts, accountsCreateCli.test.ts) |
| B9 | Break-glass reset on the machine | C | auto (accountsCreateCli.test.ts, usersRoster.test.ts) |
| B10 | Remove an account | U | auto |
| B11 | Link or unlink my Telegram / Discord identity | U A | auto (members, channelRoutes) |
| B12 | CLI tokens: mint, list, revoke, `login` | U C A | auto (accountsCreateCli.test.ts, audit2026-09-23.test.ts) |
| B13 | Operator profile ("about you"), apply to all | U A | auto (operator.test.ts) |
| B14 | Sign out | U | auto |

## C. Creating agents
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| C1 | Create an agent (name, persona, source, host, private memory, no Telegram) | U C A M | auto (userFlows, cli) |
| C2 | Paste a BotFather token when the pool is empty | U C | auto (poolFlows, botToken tests) |
| C3 | Finish a stuck agent as web-only | U C | auto (skipTelegram) |
| C4 | Ask Hatchabot what agent I'm missing | U M | auto (opsSuggest.test.ts) |
| C5 | Plan of agents to create later | U A | auto (lifecycleGuards.test.ts) |
| C6 | Start from a template I have | U | auto (template.test.ts, templateParams.test.ts, transfer.test.ts) |
| C7 | Open a `.hatchabot` file (template / backup) | U C A | auto (transfer, importRecipe) |
| C8 | Bring in existing OpenClaw agents (adopt) | U C A | auto (adoptFlows.test.ts, adopt.test.ts, openclawImport.test.ts) + manual (smoke-adopt.sh) |
| C9 | Clone an agent | U C M | auto (lifecycleGuards.test.ts, userFlows.test.ts) |
| C10 | Derive a child agent | U | auto (templateParams.test.ts) |
| C11 | Push master's definition to children | U A | auto (templateParams.test.ts, mgmtBroker.test.ts) |
| C12 | Child proposes a lesson to its master | U | auto (mgmtProposals.test.ts, templateParams.test.ts) |
| C13 | Accept or dismiss an agent sent to me | U A | auto (inbox.test.ts) |
| C14 | Retry a FAILED agent | U C A | auto (provision tests) |

## D. Identity & personality
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| D1 | Rename (the bot's name follows) | U C A M | auto (rename, channelRoutes) |
| D2 | Icon and colour; auto-pick icons | U A | auto (agentIcons.test.ts) |
| D3 | Group; drag between groups; new group by drop; rename a group | U A M | auto (agentGrouping, groupsMove) |
| D4 | Class; define classes | U A M | auto (agentClasses.test.ts) |
| D5 | Edit SOUL/AGENTS/MEMORY | U M | auto (agentFiles.test.ts, workspace.test.ts) |
| D6 | Description / introduction | U | auto |
| D7 | Setup fields and values | U | auto (templateParams.test.ts) |
| D8 | Shared vs private memory | U | auto |
| D9 | Peers (A2A), mesh, remove | U A M | auto (peerMesh.test.ts, a2a.test.ts, doormanPeers.test.ts, routeGaps2.test.ts) |
| D10 | Per-agent environment variables | U C A | auto (agentEnv.test.ts) |

## E. AI sources
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| E1 | API-key source | U A | auto (agentModel.test.ts, aiSourceOrder.test.ts, operatorProfile.test.ts) |
| E2 | Claude subscription (setup token) | U A | manual: regress-autonomous.sh with the real setup token |
| E3 | Local model server | U A | auto (runtimeModels.test.ts, applyDefaultModel.test.ts, configWriter.test.ts) |
| E4 | Reorder; ⭐ default | U A | auto |
| E5 | Share a source | U | auto (sourceUsage.test.ts, mgmtLlmSource.test.ts, roles.test.ts) |
| E6 | Delete; reveal | U A | auto |
| E7 | Sync the model list | U A | auto (runtimeModels) |
| E8 | Change a source's default model; who adopts | U | auto |
| E9 | Point an agent at a source (+ checkpoint) | U C A M | auto (agentModel.test.ts, cliArgs.test.ts) |
| E10 | Pin an agent's model | U M | auto |
| E11 | Move many agents; migrate off a dead source | U C | auto (cli tests) |
| E12 | Spend per source; refresh a sample | U C A M | auto (sourceUsage, usagePeriods) |
| E13 | View by AI source / Model | U C | none (UI view) |
| E14 | Brave search key (fleet / per agent) | U A | auto |
| E15 | Gemini key for voice notes | U A | auto (fleetKeysReveal.test.ts, poolFlows.test.ts) |
| E16 | Google OAuth client | U A | auto (googleConnections) |

## F. Messaging channels
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| F1 | Add a Telegram bot (pool or token) | U C A M | auto (poolFlows, channelRoutes) |
| F2 | Remove Telegram (parks the bot) | U C A M | auto |
| F3 | Change bot (swap to a spare; members told) | U A | auto (swap tests) |
| F4 | Re-check the bot; Sync name | U A | auto (channelRoutes.test.ts) |
| F5 | Show the agent's bot token | U C A | auto |
| F6 | Telegram pool: stock, share, re-check, remove, reveal | U A | auto (poolFlows) |
| F7 | BotFather census | U C A | auto (bots.test.ts) |
| F8 | Telegram group policy (members / nobody / one room) | U A | auto (configWriter) |
| F9 | Who can reach it (knocks) | U A | auto (inviteOnlyDoor) |
| F10 | Rich messages | U | auto (configWriter) |
| F11 | Set up Discord; Add to a server | U C A M | auto (channelRoutes, channelConnectors) — **manual: real app tried once** |
| F12 | Set up Slack | U C A M | auto (fake Slack) — **manual: never tried against a real app** |
| F13 | Remove / re-check / change bot; parked bots and apps | U C A M | auto |
| F14 | Discord/Slack group chats | U A | auto (configWriter) |
| F15 | Invite link (48 h, named handle, app choice) | U C A M | auto (invite.test.ts, roles.test.ts) |
| F16 | Share link / QR | U A | auto (routeGaps2.test.ts, appQr.test.ts) |
| F17 | Answer a knock (Let them in / That's me / Not now) | U C A M | auto (members, pairingStore2026_9) |
| F18 | Let them in again | U | auto (inviteOnlyDoor.test.ts) |
| F19 | Add a known person | U A | auto (inviteOnlyDoor) |
| F20 | List / remove members | U C A M | auto |
| F21 | Every Telegram user across my agents | C A | auto (users.test.ts) |
| F22 | Join via a link | U | auto (appQr.test.ts, channelPairing.test.ts, routeGaps.test.ts) |
| F23 | Chat from Telegram / Discord / Slack; `/new` | external | manual: regress-autonomous.sh drives Telegram; Discord and Slack by hand |

## G. Memory, data & knowledge
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| G1 | Share a host folder (ro / rw) | U C A | auto (dataSources) |
| G2 | Add a git repo | U C | auto (gitSource) |
| G3 | Stop sharing | U C | auto |
| G4 | Google connections | U A | auto (googleConnections) |
| G5 | Files: browse, download, upload | U C A | auto (agentFiles.test.ts) |
| G6 | Snapshots | U C A M | auto (snapshots) |
| G7 | Chat → Memory checkpoint | U C A M | auto (lifecycleGuards.test.ts) |
| G8 | Recover context after a reset | U A | auto (contextReset.test.ts) |
| G9 | Download chat history | U A | auto (transcript) |
| G10 | Inspect an archived agent | U A | auto (inspect.test.ts, routeGaps2.test.ts) |
| G11 | Memory search engine per agent | U C | auto (embedSwitch) |
| G12 | Fleet memory search default; move all | U C A | auto (embedFleet) |
| G13 | Shared service start/stop/restart | U C A | auto (embedder tests) |
| G14 | Read an agent's file from chat | M | auto (mgmt tools) |

## H. Scheduling
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| H1–H5 | Tasks: list, add, edit, pause, run now, delete | U C M | auto (crons, cronsInterval, cronImport) |
| H6 | Built-in OpenClaw tasks shown as such | U | auto (crons.test.ts) |
| H7 | The manager's morning check | U | auto (opsAgent) |

## I. Runtime
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| I1 | Start / Stop / Rebuild (`--wait`) | U C A M | auto |
| I2 | Rebuild all; rebuild outdated | U C | auto (rebuildPolicy) |
| I3 | Rebuild policy; rebuilds at once | U C A | auto |
| I4–I6 | Pin, try a candidate, promote, end trial, delete a tag | U C M | auto (runtimeImages) |
| I7–I8 | Base candidate with packages; derived images | M C U | auto (derivedImage, imageRecipe) |
| I9 | Runtime version vs latest; rebuild the image | U C A M | auto |
| I10 | Memory cap live; "Give it 1 GB more" | U C A | auto (memoryCap) |
| I11 | Resources: live CPU/memory, sort, clear peaks | U C A | auto (resources) |
| I12 | Logs | U C A M | auto |
| I13 | Health check; fleet checks | U C A M | auto (health.test.ts, posture.test.ts, doctor.test.ts) |
| I14 | Console in the page; approve browser; `--check` | U C A | auto (controlUiRebase, gatewayProxy, candidate gate) |
| I15 | Ask an agent from a terminal | C A | auto (crons.test.ts, mgmtBroker.test.ts) + manual (regress-autonomous.sh) |
| I16 | Setup log | U C A M | auto (setupLog) |
| I17 | Needs-attention reasons; clear | U A | auto (agentIcons attention) |
| I18 | "Working on:" while rebuilding | U | none (UI only) |

## J. Fleet views & dashboard
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| J1 | Status panel: health, usage by period, resources, activity, tools | U A M | auto (usagePeriods, resources) |
| J2 | Dashboard tiles | U | none (UI only; screenshots.mjs renders it) |
| J3 | View by group / machine / source / model / image / class / status / activity / rebuilt / needs you | U | none (UI only) |
| J4 | Sort | U | none (UI only) |
| J5 | Drag: reorder, regroup, archive, new group, bin | U A | auto (agentGrouping for the API; UI none) |
| J6 | Rename a group in place; move a group | U A | auto (groupsMove) |
| J7 | Bulk actions; copy names | U | auto (agentModel.test.ts) for the per-agent routes; the selection UI itself is untested |
| J8 | Audit log | U A | auto (events) |
| J9 | Unread dot | U A | auto (unread) |
| J10 | Badges and marks | U | none (UI only) |
| J11 | List agents | C M | auto |
| J12 | Per-agent usage by model | U C A | auto |

## K. Backups, copying & moving
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| K1–K3 | Download a copy; restore; share a template | U C A | auto (transfer) |
| K4 | Send an agent to another person | U A | auto (inbox) |
| K5 | Move to another runner | U A | auto (hostFlows, moveHost) |
| K6 | Move to another server (rehost) | U C A | auto (rehostIntegration, real HTTP) |
| K7 | Register other servers | U C A | auto (hostsRoute.test.ts, hostFlows.test.ts, runnerSetup.test.ts) |
| K8 | "Runs here again" | U | auto (moveHost) |
| K9 | Archive; restore | U C A M | auto (archive tests) |
| K10 | Delete | U C A | auto |
| K11 | Backups: run, list, delete, restore one volume | U A M | auto (backups.test.ts) |
| K12 | Full-machine restore; restore drill | C | manual: restore-drill.sh |

## L. Hosts & runners
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| L1–L4 | Add a runner; check; drain; remove; install image | U A | auto (hostFlows.test.ts, runnerSetup.test.ts, routeGaps2.test.ts) + manual: MacBook runner, 2026-08-24 |
| L5 | Choose where an agent runs | U C | auto |

## M. Management agent
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| M1 | Set up the Hatchabot agent | U A | auto (opsAgent) |
| M2 | Talk to it (console or its bot) | U | manual: hbt ask Hatchabot |
| M3 | Confirm / cancel proposals | U A M | auto (mgmtBroker.test.ts, mgmtProposals.test.ts) |
| M4 | Pushes to my phone | U | auto (opsPush) |
| M5 | Morning check; split suggestions | U M | auto (opsSuggest) |
| M6 | Rebuild after tampering | U | auto (opsDrift) |
| M7 | Its tools | M | auto (mgmtCoverage.test.ts) |
| M8 | The older Claude chat box | U | none (UI only) |

## N. Security & operator settings
| id | Use case | Surfaces | Coverage |
|---|---|---|---|
| N1 | Posture check | U A | auto (posture) |
| N2 | Exposure per agent | U | auto (audit exposure tests) |
| N3 | Token for moving agents | U A | auto (rehost) |
| N4 | Token reveal, logged | U A | auto |
| N5 | Sharing with other users | U | auto (familyAccounts.test.ts, roles.test.ts, gatewayProxy.test.ts) |
| N6 | Members see only chat | U | auto (identity phase tests) |
| N7 | Strangers get silence | external | auto (inviteOnlyDoor.test.ts, reconcile.test.ts) |
| N8 | Ops door only through the doorman | config | auto (doorman tests) + gate |
| N9 | Caps per member/account/total | config | auto (lifecycleGuards.test.ts, runtimeCaps.test.ts, memoryCap.test.ts) |

## What only a person can test today
- A real Slack app (F12), and Discord beyond the one trial (F11, F23).
- Real OpenClaw containers end to end: the candidate gate and
  `scripts/regress-autonomous.sh` do this on a throwaway agent with a real AI
  source; the LXD clean install (A1–A3) starts from nothing.
- The web UI's behaviour beyond syntax (`npm run check:web`) and rendered
  screenshots: every "UI only" row above.

## Coverage script
`node scripts/use-case-coverage.mjs` reads this file and the test titles, and
prints the rows whose coverage says **none** or **manual**, so the list above
cannot quietly drift as tests are added or removed. `--check` fails on a
coverage cell that names a test file that no longer exists.

## What the review found (2026-09-25) and what changed

**Routes with no test at all** (26): the tailnet screen, the runner key, image
copy to a runner, the embedding service's stop/restart, derived-image rebuild
and log, the Telegram pool re-check, the connector catalogue, parked Slack apps
(re-check, delete), group readiness, the three inspect routes, forgetting a
peer, both account unlinks, in-app Send, inbox dismiss, the agent QR and
"anyone can knock". All exercised now in `test/routeGaps2.test.ts` (25 tests):
each route's authorisation edge and its happy path. Two things surfaced while
writing them, both left as they are: the volume inspector returns an empty
file rather than 404 for a file that is not on the volume (the UI treats both
the same), and the machine owner can re-check any private pool bot (by design,
the review confirms).

**Inconsistencies fixed in this release**
- `docs/features.md`: the agent sheet's tabs (Files, Discord and Slack are
  separate tabs; "Slack & Discord under construction" was two releases stale),
  eleven machine-settings tabs, fleet search and media keys live under AI not
  Connections, members and invites live under Sharing, memory cap is under
  Advanced, distillation is built (💡 Propose to master), Health is a Status
  tab, "every agent needs a Telegram bot" contradicted "Telegram is optional",
  the adopt usage line (`--profile`, not `--bot-token`), a 2026.7 candidate
  tag, and "two at a time" (rebuilds follow the Rebuild-at-once setting).
- `README.md`: organising the fleet described the classic card UI only; the
  management bot and `HATCHABOT_MGMT_*` variables were removed in v2.0.0.
- `docs/channel-parity.md`: Slack is public, not behind `?dev`.
- Web: "Messaging tab" → Telegram tab; "3 at a time" / "two at a time" in the
  source-migration and move-all prompts; the revoke-token prompt named the
  legacy management bot; the Discord removal prompt now says the goodbye is
  sent and the agent restarts, like Slack's.
- CLI: `approve`/`deny` usage shows `--kind discord|slack` (the flag worked;
  the help did not say so); the migrate summary dropped "(3 at a time)".
- Management chat: `archive_agent` says Discord/Slack apps are parked too;
  `remove_channel` says the people get a goodbye and the app is parked;
  the coverage ledger's `bot-name/sync` note covers Discord.
- Setup log: 115 of the 163 events the code records had no plain-words
  label and showed as raw names (`migrate.pool_retire_failed`). All labelled
  now; `test/driftGuards.test.ts` fails when a new event is recorded without one.
- Runtime image CI: the Dockerfile pinned Slack/Discord plugins at 2026.7.1
  while building OpenClaw 2026.9.6, so no 2026.9.6 image was published for
  v2.76.0–v2.77.2 (installs built locally instead). The pin follows OpenClaw's
  line now and the workflow resolves it from npm; a drift guard ties the two.

**Inconsistencies left for Chris (behaviour, not wording)**
- The CLI does not confirm `kick`, `deny`, `unarchive`, `revert`, `env rm`,
  `folders rm` or `image rm`; the UI confirms each. `delete`, `archive` and
  `tasks rm` do confirm. Scripts rely on silent CLIs, so this is a choice.
- An AI-source switch applies three ways: chat rebuilds now, the CLI waits for
  the next rebuild, the UI asks. Pick one default.
- UI-only features with no CLI (groups/classes, peers, connections,
  allow-knocks, rooms, Change bot, Sync name, Re-check, drain/hosts,
  backups, proposals) and CLI-only (`users`, `tasks runs`). Undocumented as
  deliberate anywhere.
- "Needs you" (view) / "Needs attention" (bin) / "Waiting for you"
  (dashboard) are three names for one idea; "Remove…" / "Take … off" /
  "detached" three for another; "Move to another cluster" / `rehost` / "Rehost"
  for the cross-server move.
- Whether group rooms need a rebuild is stated only in the toast after saving.
