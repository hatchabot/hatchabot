# Telegram and Discord: the same controls, and where they differ

Asked for on 2026-09-25: "make them equal as much as possible, flag where one
doesn't have the feature the other has, and align Settings → Telegram with
Settings → Discord and the two tabs on the agent". Since v2.74.0 every
control below is drawn from the same card on the agent and the same layout
under Settings; this page is the ledger of what is equal, what was made
equal, and what the platforms keep different.

## On the agent (the Telegram tab and the Discord tab)

Both tabs draw one card per app with the same rows, in the same order:

| Row | Telegram | Discord | Slack (behind `?dev`) |
|---|---|---|---|
| Name as the app shows it | display name + @handle | bot name (its username) | app name |
| ↻ Re-check | getMe: alive, name, BotFather group settings | servers, intent, name | scopes, workspace |
| 🏷 Sync name | when the display name differs | when the username differs | — (Slack has no API for it; the manifest names the app) |
| Linked to you | first message links you (a new bot's handle is yours alone) | your first DM is a request you approve with *That's me* (a bot is visible to a whole server) | as Discord |
| Warnings from the last check | groups off / privacy on at BotFather | intent off, no server yet | scopes |
| Open in the app | ✓ | ✓ | ✓ |
| Add to a server | — | ✓ | — (invite it to a channel with /invite) |
| 🔁 Change bot… (a spare from the pool) | ✓ | ✓ | ✓ (Settings → Slack) |
| Remove… (parks the bot) | ✓ (back to the pool) | ✓ (parked under Settings → Discord) | ✓ (parked with both tokens under Settings → Slack) |
| People on the app + knocks (Not now / That's me / Let them in) | ✓ | ✓ | ✓ |
| Group chats | any group (members, @mention) · off · one group (members, @mention) | every server it is in (members, @mention) · off · one server | every channel it is in (members, @mention) · off · one channel |
| Who can reach it (invite only / anyone can knock) | one setting for every app | same | same |
| Rich messages | on / off | — (always rendered) | — |

Removing an app forgets everyone it had admitted on the agent's volume;
removing a member (Sharing) takes them off every app. Members, invites and
"people you already know" live under **Sharing** for every app: a known
person is added on every app the agent has that they are known on.

## Under Settings (Telegram, Discord and Slack)

All three panes: a status line ("N spare bots ready · M in use by agents"), **Add
a bot** (paste a token, verified with the platform; the machine owner may
share it with the house), and **Bot pool** in the same four groups: *Free —
yours*, *In use — yours*, *Free — shared with you*, *In use — someone
else's* (Discord and Slack add *Kept for an archived agent*). Every free row has ↻
Re-check and 🗑 Delete; Discord rows also have *Add to a server*. Everyone
sees their own bots and the shared ones; the machine owner sees all.
Telegram keeps its **Every bot this server has a token for** inventory: it
exists because BotFather caps an account at about 20 bots; Discord has no cap.

## What happens to people on each app

| Moment | Telegram | Discord | Slack |
|---|---|---|---|
| Bot renamed | a DM from the bot | a DM from the bot | — (no rename) |
| Agent moved to another bot | "moving to @X", then the old bot stops | "moving to the bot X", then the old bot is parked | same as Discord |
| App removed from the agent | goodbye DM | goodbye DM | goodbye DM |
| Agent archived | goodbye DM; bot back to the pool | goodbye DM; bot parked, kept for the agent (restore takes it back unless another agent took it) | same as Discord |
| Agent deleted | goodbye DM; bot back to the pool | goodbye DM; bot parked | same as Discord |
| A pool bot reused by a new agent | "this bot is now X" to its previous regulars | same | same |
| Password recovery link | via a Telegram bot the person talks to | via a Discord bot they are linked on, when no Telegram can carry it | — |
| Your identity on the app | linked to your login by *That's me*; every new bot admits you | the same, from any agent you are linked on; unlink under Settings → You | as Discord (no unlink yet) |

## CLI and the management chat

| | Telegram | Discord | Slack |
|---|---|---|---|
| CLI | `telegram remove`, `token`, `bots`, `approve`/`deny` | `discord add`, `discord remove`, `discord bots`, `approve`/`deny --kind discord` | `slack add`, `slack remove`, `slack apps`, `approve`/`deny --kind slack` |
| Management chat | `add_telegram`, `remove_telegram`, `list_bots` | `add_discord` (from the pool), `remove_channel`, `list_discord_bots` | `add_slack` (from the pool), `remove_channel`, `list_slack_apps` |

## Kept different, and why

- **A Telegram @handle is fixed for life; a Discord username changes** (a
  few times an hour). So *Sync name* renames a Telegram bot's display name
  and a Discord bot's username; a queued Discord rename applies within the hour.
- **A Discord bot can only DM people who share a server with it.** Farewells,
  moving notes and recovery links reach only those people; Telegram bots
  reach anyone who ever opened the chat.
- **Telegram has no server list**, so no *Add to a server*, and its group
  picker is *Find rooms* (the groups the bot has been spoken to in).
- **Rich messages** is a Telegram setting; Discord and Slack always render
  formatting.
- **Owner token reveal** (`Show` on the Telegram tab, the inventory) exists
  for moving a hand-made Telegram bot elsewhere; a Discord bot's token is
  kept by parking it, so nothing is revealed.
- **Creating a bot, turning on Message Content Intent, adding it to a server
  (Discord) and BotFather's group settings (Telegram) have no API**: both
  stay manual, and Re-check tells you what is still missing.
- **Pending-knock pushes to your phone** go through the manager's Telegram
  bot; there is no Discord manager bot yet.

## Slack, specifically

Slack has every control the others have and is offered to everyone since
v2.75.1 (made public on the owner's call, tested against a fake Slack; a real
app has not been connected yet). Slack keeps two differences of its own: an app cannot be renamed by API (the manifest names
it, so *Sync name* is not offered), and a DM from the app needs the
`im:write` and `chat:write` scopes the manifest asks for.

