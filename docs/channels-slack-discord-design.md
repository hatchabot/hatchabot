# Design: Slack and Discord for agents

> **Status, 2026-09-20: built, hidden, and being worked on.** Shipped in
> v1.31.0 and never exercised against real apps, so v2.3.0 put the UI behind a
> per-browser preview switch (`?preview=channels`) while the routes, the
> connectors and the tests stay live. It comes out of preview when a real Slack
> app and a real Discord bot have run for a while.

Status, 2026-09-18: **built in v1.31.0** (steps 1–6 and 8). Step 7, Slack and
Discord for the management agent, is not done: adding a channel is refused for
it. Not yet tried with a real Slack app or Discord bot. It does not depend on the OpenClaw 2026.9 port; it works on
today's 2026.7.1-2.

## What we are adding

An agent can be reached on Slack and on Discord, next to (or instead of)
Telegram and the web console. Each is set up from the agent's **Messaging**
tab by pasting credentials from an app the owner creates, the same way a
pasted BotFather token works today.

Why these two: the machine has no inbound internet path, so a channel must
connect **outbound**. Slack (Socket Mode) and Discord (gateway websocket)
both do. Webhook channels (Teams, Google Chat, SMS) need a public address and
are out of scope. WhatsApp and Signal need a dedicated phone number.

## What OpenClaw gives us (checked in the 2026.7.1-2 image's own docs)

| | Slack | Discord |
|---|---|---|
| Plugin | `@openclaw/slack` (not bundled) | `@openclaw/discord` (not bundled) |
| Published per OpenClaw version | yes, `2026.7.1` exists | yes, `2026.7.1` exists |
| Credentials | bot token `xoxb-…` **and** app-level token `xapp-…` with `connections:write` | one bot token |
| One-time setup by the owner | create app from a manifest, install to workspace, create the app-level token | create app + bot, turn on **Message Content Intent**, add the bot to a server |
| Config | `channels.slack.*`, `accounts.<id>` | `channels.discord.*`, `accounts.<id>`, `applicationId` |
| Who may DM | `dmPolicy: pairing` + `allowFrom` (same model as Telegram) | same |
| Rooms | `groupPolicy` + `channels.<C…id>` (IDs only, names are silently ignored) | `groupPolicy` + `guilds.<id>` |
| Pairing CLI | `pairing list slack`, `pairing approve slack <code> --account <id>` | same with `discord` |
| Proxy (matters for the management agent) | none documented | explicit `channels.discord.proxy`; its websocket ignores `HTTPS_PROXY` |

Known limit worth showing in the UI: a free Slack workspace allows 10 apps,
and this design uses one Slack app per agent (see "Later").

## Decisions

1. **Plugins are baked into the runtime image and linked per agent**, the way
   the embedding plugin is today. Not installed per agent at "Add" time.
   - Per-agent install needs npm from inside the container (impossible in the
     management agent's jail), costs 60 to 100 MB on every agent volume, and
     makes "Add Slack" depend on the npm registry being up.
   - Baking is an image change with **no OpenClaw bump**, which the upgrade
     rule allows: it gets its own tag (`2026.7.1-2-ch1`), goes candidate
     first, then Promote, then agents Rebuild.
2. **One app per agent** for both. Each agent is its own bot identity, like
   Telegram. (A single shared Slack app is possible later; see the end.)
3. **No pool.** Neither platform lets us mint apps by API end to end (Slack
   app-level tokens and Discord bot tokens are created by hand), so there is
   nothing to pre-stock. Setup is always "paste".
4. **Credentials never pass through a model.** Adding a channel is app-only,
   like every other secret. The management agent can remove one.
5. **Access stays pairing-based and Hatchabot-owned.** Members are Hatchabot
   memberships; their platform identities seed `allowFrom` on every rebuild,
   exactly as Telegram ids do now.

## Data model

Today: `channels` already has a `kind` column, but the code assumes one row
per agent (`getChannelForAgent`, about 30 call sites), and a member has one
`channel_user_id`.

| Change | Detail |
|---|---|
| `channels` | Add `UNIQUE (agent_id, kind)` and a `settings TEXT` JSON column (room access for that channel; display name; team or server name). |
| Store API | `getChannelForAgent(agentId, kind = 'telegram')` so all existing callers keep their meaning. Add `listChannelsForAgent(agentId)` and `deleteChannelForAgent(agentId, kind)`. |
| `Channel.kind` | `'telegram' \| 'slack' \| 'discord'`. |
| Secrets | One secret per channel row, as now. Slack's holds JSON: `{ "botToken": "...", "appToken": "..." }`. Discord's holds the token string. |
| Member identities | New table `member_identities (agent_id, user_id, kind, channel_user_id, bound_at, PRIMARY KEY (agent_id, user_id, kind))` for **Slack and Discord only**. Telegram identities stay on `memberships.channel_user_id` exactly as today, so no Telegram path changes. `listAllowedChannelUserIds(agentId, kind = 'telegram')` reads the right place per kind. Built in step 2. |
| `agents.web_only` | Meaning becomes "has no channel rows". Keep the column as the owner's stated intent at creation (skip Telegram); compute `channels: [...]` on the public agent for the UI. |

Templates, sends and clones never carry channel credentials (same as
Telegram). Backups carry them the way they carry bot tokens today.

## Code structure

### `src/channels/connector.ts` (new)

Slack and Discord do not fit `ChannelProvisioner` (that interface is shaped
around leasing from a pool). They get a leaner one; Telegram keeps its own.

```ts
export interface ChannelConnector {
  readonly kind: 'slack' | 'discord';
  readonly label: string;
  /** What the form asks for; drives the UI and first-line validation. */
  readonly fields: Array<{ key: string; label: string; pattern: RegExp; help: string }>;
  /** Talk to the platform with the pasted credentials. Throws a plain-words error. */
  verify(creds: Record<string, string>): Promise<{
    accountId: string;        // Slack: bot user id. Discord: application id.
    displayName: string;      // "@Tax Advisor in Krueger Family"
    deepLink: string;         // opens a DM with the bot
    addToServerUrl?: string;  // Discord only
    warnings: string[];       // e.g. "Message Content Intent is off"
  }>;
  /** Hosts the management agent's proxy must allow for this channel. */
  readonly hosts: string[];
}
```

- `src/channels/slack.ts`
  - `verify`: `auth.test` with the bot token (team, team id, bot user id),
    then `apps.connections.open` with the app token (proves it is an
    app-level token with `connections:write`). The app id is the second
    segment of the `xapp-` token.
  - `deepLink`: `https://slack.com/app_redirect?app=<appId>&team=<teamId>`.
  - `manifest(agentName)`: OpenClaw's "Minimal" Socket Mode manifest with the
    agent's name filled in, returned by `GET /v1/channels/slack/manifest?name=`.
  - `hosts`: `slack.com`, `*.slack.com`, `files.slack.com`.
- `src/channels/discord.ts`
  - `verify`: `GET /users/@me` and `GET /applications/@me` with
    `Authorization: Bot …`. Warn when neither Message Content flag
    (bits 18 and 19 of `flags`) is set: the bot would see empty messages.
  - `deepLink`: `https://discord.com/users/<botUserId>`.
    `addToServerUrl`: the OAuth2 authorize link with scopes `bot` and
    `applications.commands` and a fixed minimal permission integer.
  - `hosts`: `discord.com`, `gateway.discord.gg`, `cdn.discordapp.com`.
- Both: 10-second timeouts, never echo a token in an error, and no redirects
  followed.

`deps.connectors: Record<'slack' | 'discord', ChannelConnector>` is added to
the route and provision deps; tests inject fakes.

### Routes (`src/api/routes.ts`)

| Route | Behaviour |
|---|---|
| `GET /v1/agents/:id/channels` | Every channel the agent has, with state (`connected`, `needs a rebuild`, `image lacks it`) and warnings. Owner only. |
| `POST /v1/agents/:id/channels/:kind` | Body: the connector's fields. Validates shape, calls `verify`, stores the secret, inserts the row, opens the owner's claim window for that kind, and queues a rebuild. 409 if the agent's image does not list the plugin (see "The image"). 409 if that kind already exists. |
| `DELETE /v1/agents/:id/channels/:kind` | Removes the row and secret, rebuilds. Refuses to remove the last way to reach an agent only if the agent is not web-capable (never true today; keep the guard). |
| `PATCH /v1/agents/:id/channels/:kind` | `settings` only: room access. Rebuild. |
| `GET /v1/channels/slack/manifest` | The manifest text for step 1 of the Slack form. |

The Telegram routes stay as they are. Ledger entries in `coverage.ts`:
POST is `app: secret`, DELETE maps to a new broker tool `remove_channel`
(risk: disruptive), PATCH is `app: later`.

### Provisioning (`src/orchestrator/provision.ts`)

`buildRuntimeSpec` builds one slice per channel row and puts them on
`configPatch.slack` and `configPatch.discord` next to `telegram`:

```ts
slack?:   { botToken; appToken; dmPolicy: 'pairing'; allowFrom: string[]; rooms: RoomAccess };
discord?: { token; applicationId; dmPolicy: 'pairing'; allowFrom: string[]; rooms: RoomAccess; proxy?: string };
```

`rooms` is `{ mode: 'off' }` or `{ mode: 'room', roomId }`. In a room the
agent answers members only (`users: allowFrom`) and only when @mentioned.

A web-only agent with a Slack row is no longer "channel-less": the "no
channel" refusal in `buildRuntimeSpec` becomes "no channel **and** not
web-only".

### Config (`src/openclaw/configWriter.ts`)

Both use a fixed account key, `hatchabot`. For each present slice, in order:

1. `plugins install --link /opt/hatchabot/plugins/<kind>/node_modules/@openclaw/<kind>`
   then `plugins enable <kind>`. Idempotent, like the embedding plugin.
2. Slack:
   - `channels.slack.enabled true`, `channels.slack.mode socket`
   - `channels.slack.accounts.hatchabot` = `{ enabled, botToken, appToken, dmPolicy, allowFrom }` (sensitive)
   - `channels.slack.groupPolicy` = `disabled` or `allowlist`, always written
   - `channels.slack.channels` = `{}` or `{ "<C…>": { enabled: true, requireMention: true, users: allowFrom } }`, always written (the 2026.7.1 schema rejects the `allow` key the docs show)
3. Discord:
   - `channels.discord.enabled true`
   - `channels.discord.accounts.hatchabot` = `{ enabled, token, applicationId, dmPolicy, allowFrom }` (sensitive)
   - `channels.discord.groupPolicy`, always written
   - `channels.discord.guilds` = `{}` or `{ "<guildId>": { requireMention: true } }`, with `--replace`, always written
   - `channels.discord.proxy` when the slice has one (sensitive)
4. Bind on **every** build with `agents bind --agent <slug> --bind <kind>:hatchabot`
   (and `agents unbind` when the channel is gone). Not `agents add --bind`:
   the provider runs `agents add` only on a fresh volume, so a channel added
   later would never be routed. Both verbs are idempotent.
5. Only for plugins the image carries (`channelPlugins`, from the image label).
   An agent on an image without them gets byte-for-byte the old commands.

Verified end to end against real OpenClaw 2026.7.1-2 (throwaway container,
fake tokens): the rendered seed runs clean, config validates, both channels
bind and start, a second run is clean, and the "removed" seed leaves config
valid, no bindings, and no token in `openclaw.json`. OpenClaw refuses any
write that halves the config's size, which is why removal is two small writes
(`enabled false`, `accounts {}`), not one replace.

**Removal must converge too.** When a kind is absent from the patch, write
`channels.<kind>.enabled false` and drop its account, so a removed channel
does not survive on the durable volume (the same rule the audit set for
Telegram group access).

### People: claim, invites, members

- `src/orchestrator/claim.ts`: `listPairingRequests`, `approvePairing` and
  `claimFirstContact` take a `kind` and pass `--account hatchabot` for the
  new kinds. The bound identity goes to `member_identities`.
- Owner: adding a channel opens the claim window for that kind; the setup
  sheet's last step is "Open a DM and say hi", then shows "Linked as …".
- Invites stay per agent. The join page lists a button per channel the agent
  has. `POST /v1/join` gains `channel`, and the claim window opens for that
  kind. Copy per kind:
  - Slack: "You need to be in the **<team>** workspace."
  - Discord: "You need to share a server with the bot. Join **<server>**
    first," with the server invite if the owner saved one in `settings`.
- Approve, deny and remove member act on every kind the member has an
  identity for; removing a member rewrites `allowFrom` on the next rebuild
  and calls `pairing` revoke where the CLI offers it (verify).
- Approvals for the management agent's proposals stay on Hatchabot's own
  Telegram bot. Not part of this work.

### The image

- `docker/Dockerfile.runtime`: `ARG CHANNEL_PLUGINS="slack discord"` and
  `ARG CHANNEL_PLUGIN_VERSION`. For each, install with OpenClaw's installer
  into a throwaway HOME (the same trick and the same option detection as the
  embedding plugin), then move the **whole project directory** to
  `/opt/hatchabot/plugins/<kind>/`. These plugins have sibling dependencies
  (`@slack/bolt`, `discord-api-types`), so moving only the package directory
  would break resolution.
- `LABEL org.hatchabot.channels="slack,discord"`.
- `scripts/build-runtime-image.sh`: pick the plugin version with the existing
  `pickPlugin` rule (newest release not newer than the OpenClaw being built).
- `listImageTags` returns `channels`; the capabilities table under each image
  shows it; the POST route and the UI use it to say "This agent's image can't
  do Slack yet. Promote a newer base image, then Rebuild."
- Expected cost: about 150 MB of image. No per-agent cost until linked.

### The management agent

- Discord: add the connector's hosts to `opsAllowedHosts` and set
  `channels.discord.proxy` to the ops proxy address.
- Slack: no proxy setting is documented. Step 1 of the build order tests
  whether Socket Mode honours `HTTPS_PROXY` with `NODE_USE_ENV_PROXY=1`. If it
  does not, Slack is simply not offered for the management agent.
- The lockdown is unaffected: channel plugins add message actions, which the
  allowlist already excludes. Add their tool names to the drift check's
  expectations after step 1 shows what they are.

## UI (`web/index.html`)

- **Messaging tab**: one card per channel, same layout: mark, name, state
  line, one button.
  - Not set up → **Set up**. Connected → "Connected as **@Tax Advisor** in
    **Krueger Family**", **Open**, **Remove**. Problems → the warning and
    **Fix**.
  - Each card has the same "Group chats" control Telegram has (Off, Members
    only, One room + its id). Help text says where to find the id.
- **Set-up sheet**, three steps, one screen each:
  - Slack: 1. "Create the app": **Copy manifest** and **Open Slack**, with the
    four clicks listed. 2. Paste the two tokens (masked, shape-checked as you
    type). 3. "Say hi": deep link, live "waiting for your first message…".
  - Discord: 1. Create the app and bot; turn on Message Content Intent.
    2. Paste the token. 3. **Add to your server**, then DM it.
  - Errors are the connector's plain words ("That is a bot token; the second
    box needs the app-level token that starts with xapp-").
- **Icon marks**: bottom-right shows the first channel's mark as today
  (Telegram plane, Slack hash, Discord controller). With two or more, show the
  first and a small "+1".
- **New agent**: the Telegram choice stays as is. Slack and Discord are added
  afterwards from the Messaging tab, because they need a running agent to
  pair with.
- **Unread dot**: already correct. Exchanges that went to Slack or Discord are
  not "console" activity (`consoleActivity` counts only web channels).

## Security

| Concern | Answer |
|---|---|
| Two more long-lived secrets per agent | Same store and handling as bot tokens: write-only in the API, marked `sensitive` in config commands, never in logs, templates or the management agent's view. |
| A pasted token for the wrong thing (user token, another app) | `verify` checks the token kind and identity before anything is saved. |
| Strangers in a big Slack workspace or Discord server DMing the bot | `dmPolicy: pairing`: unknown senders get a code and nothing else. Rooms are off unless the owner names one id, and are mention-gated. |
| Name spoofing | Only ids are ever written. `dangerouslyAllowNameMatching` is never set. |
| Bot-to-bot loops | OpenClaw's loop protection is on by default; `allowBots` is never set. |
| Server-side request forgery in `verify` | Fixed hostnames only, no redirects, no caller-supplied addresses. |
| The management agent gaining an exfiltration path | Its proxy allows only the named hosts. Slack and Discord are chat platforms the owner chose, the same trust as Telegram today. |

## Spike findings (2026-09-18, OpenClaw 2026.7.1-2, throwaway containers)

- **Install and move work.** `openclaw plugins install @openclaw/<kind>@2026.7.1`
  puts each plugin in its own project directory with its dependencies
  **nested inside the package** (`node_modules/@openclaw/<kind>/node_modules`).
  The peer link to OpenClaw is an absolute symlink, so copying the project
  directory to `/opt/hatchabot/plugins/<kind>` keeps it resolving.
  Size: Slack 40 MB, Discord 53 MB.
- **Linking works.** As the `node` user on a fresh HOME:
  `plugins install --link /opt/hatchabot/plugins/<kind>/node_modules/@openclaw/<kind>`
  then `plugins enable <kind>`. `plugins list` shows both enabled from the
  image path; `channels list --all` shows them installed. The agent's volume
  grows by about 1.3 MB.
- **Config keys validate** (`openclaw config validate`), with one correction:
  Slack's per-room object takes `enabled`, not `allow`. Its keys are
  `enabled requireMention ignoreOtherMentions replyToMode tools toolsBySender
  allowBots botLoopProtection users skills systemPrompt`. `agents add --bind
  slack:hatchabot --bind discord:hatchabot` works. Removal as designed
  (`enabled false` plus `config unset …accounts.hatchabot`) leaves the channel
  "not configured, disabled".
- **Pairing CLI:** `pairing list slack --json` returns
  `{"channel":"slack","requests":[]}`; `pairing approve` takes `--account`
  and `--notify`.
- **The gateway starts both** from the image path
  (`[slack] [hatchabot] starting provider`, same for Discord), and a failed
  channel auto-restarts with backoff (Discord: 10 attempts).
- **Proxy, through a logging proxy:**
  - Discord honours `channels.discord.proxy` for REST and for its gateway
    websocket (`CONNECT discord.com`, `CONNECT gateway.discord.gg`).
  - Slack's REST calls honour `HTTPS_PROXY` with `NODE_USE_ENV_PROXY=1`
    (`CONNECT slack.com`). Its Socket Mode websocket
    (`wss-primary.slack.com`) was not reached with fake tokens, so whether it
    honours the proxy is **still open**; check it with the first real app
    before offering Slack to the management agent.
  - Something at start-up also tried `registry.npmjs.org`. The management
    agent's proxy refuses it; harmless.
- **Side effect to handle:** with Discord on, OpenClaw registers every skill
  as a Discord slash command (it logged truncating descriptions over 100
  characters). Consider `commands.native: false` for Discord if the command
  list is noisy in practice.
- Tool names: the plugins add actions to OpenClaw's message tool rather than
  new top-level tools, so the management agent's allowlist needs no change.

## Build order

1. **Image spike, no app code** (done, findings above): bake both plugins into a candidate
   (`IMAGE_TAG=2026.7.1-2-ch1`), link them in a throwaway container, confirm
   they load, confirm the project-directory move resolves dependencies, note
   the tool names they add, and test Slack through the ops proxy. Record the
   findings in this file.
2. **Data model and store API** with the migration, no behaviour change.
   All existing tests pass untouched.
3. **Connectors and the four routes**, with fakes in tests.
4. **Config writer and provisioning slices**, including convergent removal.
5. **Claim, join and members by kind.**
6. **Messaging tab, set-up sheets, marks.**
7. **Discord for the management agent** (and Slack if step 1 allows).
8. Broker tool `remove_channel`, ledger entries, docs (`features.md`,
   README env rows), CHANGELOG.

Ship Slack end to end first (steps 2 to 6 with only the Slack connector
registered), then register Discord: by then it is one connector file and one
writer block.

## Tests

- `channelConnectors.test.ts`: Slack and Discord `verify` happy paths;
  swapped Slack tokens; user token refused; Discord intent warning; timeouts;
  tokens never appear in thrown messages.
- `channelsStore.test.ts`: migration copies Telegram identities; unique
  (agent, kind); default-kind getter unchanged for old callers.
- `channelRoutes.test.ts`: add, duplicate 409, image-lacks-plugin 409, remove,
  settings patch, owner-only, secrets never returned.
- `configWriter.test.ts`: exact command lists for each slice; removal writes
  `enabled false`; rooms always written; sensitive flags; binds.
- `claim.test.ts`: pairing by kind with `--account hatchabot`; identity lands
  in `member_identities`; rebuild seeds `allowFrom` per kind.
- `webOnlyAgents.test.ts`: a web-only agent with Slack builds; with nothing,
  still builds; a non-web-only agent with no channel still refuses.
- `mgmtCoverage.test.ts` passes with the new ledger lines.
- UI sweep: Messaging tab with 0, 1 and 3 channels; both set-up sheets; marks.

## Later

- **One Slack app for the whole install.** OpenClaw's Slack plugin has a
  relay mode: a trusted router holds the single Socket Mode connection and
  forwards events to gateways. Hatchabot could be that router, which removes
  the per-agent app chore and the 10-app limit. Costs: every agent shares one
  bot identity unless `chat:write.customize` is used, and Hatchabot joins the
  message path. Worth a separate design after per-agent apps are in use.
- Slack and Discord as approval channels for proposals.
- Matrix and Mattermost: both outbound, both fit the same connector shape.
