# An Advanced area in Settings (v2.157.0)

An outside review asked that what only a multi-server or image-building
setup needs sit in one clearly marked place, so a household sees one control
plane with optional runners. Nothing is removed: every control keeps working,
from a new place.

## What lives where today (before this change)

| Control | Where | Code |
|---|---|---|
| Other Hatchabot servers: list, add (`POST /v1/peers`), forget (`DELETE /v1/peers/:id`) | Settings → **Hosts**, second section ("Other Hatchabot servers") | `paneServers`; `renderPeers`, `addPeer`, `delPeer` |
| Move to another Hatchabot (`POST /v1/agents/:id/rehost`) | agent sheet → **Advanced** → *Machine* row, beside **Move…** | `v2Pane` (`case 'advanced'`), `rehostAgent` |
| A token for moving agents here (rehost-scoped) | Settings → **Security** → Access tokens | `newCliToken('rehost')` |
| Runtime images: the table, try on an agent, promote, delete a tag, the build line of a candidate | Settings → **Images** (first section) | `paneRuntime`; `loadRuntime`, `loadRuntimeImages`, `tryOnAgent`, `promoteImage`, `pollBaseBuild` |
| Automatic rebuilds (policy, rebuild at once) | Settings → **Images** | `rbSection`; `loadRebuildPolicy`, `setRebuildPolicy`, `setRebuildAtOnce` |
| Derived images (the recipes: Dockerfile lines), rebuild, log, delete | Settings → **Images** (second section) | `paneV2Derived` / `derivedSection`; `loadDerivedImages`, `askMgmtForImage` |
| Pin one agent to an image | agent sheet → Advanced → *Runtime* (`imagePinRow`) | `saveImagePin` |
| Runners (add, check, install image, drain), machine defaults, memory search | Settings → **Hosts** | `paneHosts`; `loadHosts`, `addHost` |
| Agent-to-agent peers (same server only) | agent sheet → Sharing; Bulk actions → Connect to each other | `paneEditPeers`, `/v1/agent-peers/mesh` |
| The account menu | Inbox, Usage, Resources, Setup guide, Help, Report — none of the above | — |
| The Hatchabot agent's tools | `list_images`, `get_image_log`, `list_base_images`, `build_base_candidate`, `try_base_candidate`, `build_image`, `rebuild_image`, `remove_image`, `delete_base_image`, `pin_image`; its action cards link to Settings with `openAiDlg('images')`. Rehost and other servers are app-only (`src/mgmt/coverage.ts`). | `src/mgmt/tools.ts`, `src/mgmt/restTools.ts` |

What the code says that the brief did not: there is no cross-server
agent-to-agent link. "Peers" for agents (A2A, and Bulk actions' "Connect to
each other", whose route is `/v1/agent-peers/mesh`) are agents on the *same*
server, a household feature, and stay where they are. "Mesh" in
`docs/topologies.md` is the registered servers plus rehost. Settings has no
hash routes; its deep links are `openAiDlg(<tab or pane>)` calls (the rehost
fallback, the Hatchabot agent's action cards, the click-through).

## The change

- **Settings → Advanced**, the last tab. It opens with one line: *For running
  several Hatchabot servers, and building your own runtime images. A household
  needs none of this.* Below it, three folded sections (the Settings drawer
  pattern), each closed until opened and remembered per browser
  (`localStorage` `hb-settings-adv`):
  - **Other Hatchabot servers** — `paneServers`, unchanged.
  - **Runtime images** — `paneRuntime`: the table, try, promote, the build line.
  - **Derived images** — `paneV2Derived`.
  A folded section does not load; opening it runs the same loader its tab did.
  Settings is a row of tabs, so the "section collapsed by default" is the tab
  plus its folded parts: the tab name says Advanced, the parts stay shut.
- **The Images tab is gone; Hosts holds only runners.** Hosts reads as the
  normal way to add a machine (its intro says so, and points at Advanced for
  a separate server).
- **Automatic rebuilds** move to Settings → **Hosts**, as the last section
  (after *Add a runner*, which stays the first thing to do there): they decide when this machine rebuilds agents, which every
  household owner may want, and are not image building.
- **Old links redirect.** `openAiDlg('servers' | 'images' | 'runtime' |
  'derived')` opens Advanced with that part unfolded; `openAiDlg('hosts')` and
  `'machines'` open Hosts.
- **The agent sheet:** *Move to another Hatchabot* leaves the Machine row and
  sits lower in the Advanced tab, under a **Between servers** heading, with a
  note that it is for a second server with its own dashboard (a computer under
  this one is a runner: Move… above). Nothing else in the sheet moves.
- **A fix on the way:** adding a server with a field empty wrote its error
  into the AI tab's hidden error line, so the button seemed to do nothing. It
  now says so under the form (`peerErr`).

Code: `web/index.html` — `V2_SETTINGS`, `V2_SETTINGS_ALIAS`, `showTab`,
`loadSettingsPane`, `initSettingsAdvanced`, `settingsAdvToggled`,
`settingsAdvFolded`, `settingsAdvUnfold`, `loadRebuildSection`; the sheet's
`v2Pane` (`case 'advanced'`, `#v2BetweenServers`). Tests: `scripts/ui-clickthrough.mjs` —
`settingsAdvanced`, `advancedOldLinks`, `advancedActions`,
`sheetBetweenServers`.
