# Design: the access overview ("What can my agent reach?")

*Status: built in v2.157.0.*

An outside review asked for one place that answers, per agent: what can it
reach, by connected account and service — what Hatchabot **intends** it to
have, what was **last verified** inside the running agent, which **removals
are still pending**, and **when** it was last checked. Attachment records
alone cannot answer whether a credential is really gone: issues #11 and #16
were both cases where the record said "detached" and the account was still on
the agent's volume.

## Two kinds of access, said plainly

- **Managed** — Hatchabot put it there and can look for it: Google accounts
  it imported with `gog`, the bot tokens in the agent's OpenClaw settings,
  folders it mounts, repos it clones, the environment variables it injects,
  the people it admits, the agents it lets this one consult.
- **Not managed** — what the agent or a person set up *inside* the agent's
  container: a key pasted into a chat and saved in its workspace, an account
  the agent logged into with its own browser, a password an app keeps in its
  own settings, an account added to `gog` in a chat. Hatchabot does not know
  these exist. The overview lists what it can see of them (a `gog` account no
  connection of yours put there; people OpenClaw admits with no member in
  Hatchabot) as **not managed**, and says in words what it does not check.

## Records

`access_checks(agent_id, kind, subject, present, detail, checked_at)` — one
row per agent and thing, the newest result. `present` is 1 / 0, or NULL when
the check could not run. Written by:

| When | What is recorded | Code |
|---|---|---|
| A connection's import succeeds (attach, start, wake, rebuild) | that account present | `googleConnections.ts` `materializeConnection` |
| A removal succeeds or its `gog auth list` check runs | that account absent / what the list says | `dematerializeConnection` |
| End of every sync (start, wake, rebuild) | every account `gog auth list` names, and every one Hatchabot cares about that it doesn't | `syncConnectionsNow` → `recordGoogleSeen` |
| **Verify now**, after a start or wake, at the end of a build | everything below | `accessOverview.ts` `verifyAgentAccess` |

`connection_removals` gains `created_at`, so a removal still pending after a
day can be told from one that is minutes old.

## Verify now (no side effects)

One `gog auth list --json` and one read-only `node -e` probe in the agent's
container. The probe receives only paths and variable names and prints:

- for each chat app account in `openclaw.json` (Telegram, Slack, Discord):
  whether it is there and enabled, and the first 16 hex characters of the
  SHA-256 of its token — the token itself never leaves the container, and the
  hash never leaves Hatchabot (it is compared, then dropped);
- whether each folder / repo path exists;
- whether each environment variable *name* is set (values are never read out);
- the chat ids OpenClaw admits (its settings, its approval files, its
  approval database) — compared with Hatchabot's members, on the chat apps
  the agent is on now (an id kept from a bot it no longer has is not looked
  for, so a web-only agent shows no false "not found").

Each check ends present, absent, or **not checkable**: the agent is stopped,
asleep or archived, or its machine (a runner) does not answer. A not-checkable
run keeps the previous result and its time.

## Reading it

`GET /v1/agents/:id/access` (the agent's owner, or the machine's owner) and
`GET /v1/access` (your agents; the machine's owner sees all). Per agent,
groups of rows — Google accounts, chat bots, folders & repos, environment
variables, AI source, agents it may consult, people who can talk to it — each
with `intended`, `verified {status, at}`, `pendingRemoval {since}`,
`managed`, and a `mismatch`:

| mismatch | meaning | Alerts? |
|---|---|---|
| `extra` | Hatchabot does not intend it, the last check found it | yes |
| `differs` | the bot token in the running agent is not the one Hatchabot holds | yes |
| `stale-removal` | a removal pending for more than a day | yes |
| `missing` | intended, last check did not find it (often: applies at the next rebuild) | no — ⚠ in the section |

No secret value is ever returned; the routes return names, addresses and
times only.

The AI source and the agents it may consult are not read back from the
agent: the source is written at every build (the row says when it switches),
and a consult is checked against the grant on every call, so the grant list
is the truth (`enforced`).

## On the page

- **The agent's Sharing tab** gets an **Access** section (not a new tab: the
  sheet already has twelve, and Sharing is where "who and what reaches this
  agent" already lives — people, and other agents it can ask). One line per
  thing with ✓ verified / ⚠ mismatch / ? not checked and the time, pending
  removals, the "not checked" limits, and **Verify now**.
- **Settings → Security → What your agents can reach**: agents × things,
  mismatches first, beside Agent exposure.
- **Alerts**: an `extra`, `differs` or `stale-removal` mismatch is an Alerts
  line on the agent (`agentAttention`, key `access:…`).
