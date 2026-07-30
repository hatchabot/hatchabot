# Moving an agent between machines

An agent is portable as a single `.agentclaw` file: its memory and workspace
files, its members (including revoked ones), its Telegram bot identity, and
hints about the AI it ran on. Import re-provisions it against the *target*
machine's own AI source and host — so an agent can move from a subscription
laptop to an API-key server and keep its mind.

## The move

On the target machine (once):

```sh
git clone https://github.com/cksci/agentclaw-ai.git agentclaw
cd agentclaw && ./scripts/setup-host.sh
# then open http://localhost:8080 and connect an AI source (⚙ AI)
```

Then, from anywhere:

```sh
# on the source (or remotely, with --url):
agentclaw export kitchen-helper -o kitchen.agentclaw

# copy the file over (scp, tailscale file cp, USB stick — it's just a file)

# on the target:
agentclaw import kitchen.agentclaw
```

The web app can do the same: **Export** on the agent card, **Import** in the
header.

## Rules of the road

- **The file is a credential.** It contains the agent's Telegram bot token.
  Treat it like a password; delete it after a successful import.
- **One poller per bot.** Export leaves the source agent STOPPED. Keep it
  that way (or delete it) once the import is live — two copies polling the
  same bot flip-flop messages between them. Telegram needs no changes:
  bots connect outbound from wherever they run.
- **AI doesn't travel.** The import binds the agent to an AI profile on the
  target (vendor-matched by default, `--profile <id>` to choose). Model
  config is re-applied from the target's profile; memory is untouched.
- **The owner seat transfers.** Whoever imports owns the copy. Other
  members ride along with their Telegram bindings intact.
- Importing where a same-slug agent already *lives* is refused; a previously
  deleted agent's tombstone doesn't block a re-import.
