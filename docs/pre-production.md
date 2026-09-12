# Before this serves anyone you don't fully trust

Hatchabot currently runs as a **single-household installation**: every account
on it belongs to someone the operator trusts personally. Several decisions lean
on that. This file lists what must change before the software is exposed to
users the operator does *not* vouch for — a paying customer, a colleague, a
stranger with a link.

Each item says what is deliberately permitted today, why it is acceptable here,
and what "fixed" looks like. Items marked **ACCEPTED RISK** have matching `⚠`
comments in the code at the exact place the check belongs.

---

## 1. ACCEPTED RISK — a shared machine-login Claude Max source mounts the owner's `~/.claude`

*Found in the 2026-08-27 audit. Deliberately left open on 2026-08-27.*

A Claude Max AI source comes in two flavours:

| Flavour | What it is | What sharing it grants |
|---|---|---|
| **Machine login** (no stored credential) | the profile owner's `~/.claude` **directory**, bind-mounted into the agent container | OAuth refresh token, every Claude Code transcript under `~/.claude/projects/`, and **write** access to `settings.json` — whose hooks execute as that owner |
| **Setup token** (`claude setup-token`) | a token in the SecretStore, injected as `CLAUDE_CODE_OAUTH_TOKEN` | the OAuth token only — no filesystem, no transcripts, no code execution |

Marking a **machine-login** profile `shared` lets any other account create an
agent on it, which mounts the owner's `~/.claude` **read-write** into that
account's container. Agents run with permission prompts disabled, so the other
account can read the directory simply by asking their own agent.

**Why it is accepted here:** the operator trusts every account on this
installation and asked to keep household sharing working.

**What "fixed" looks like** (all three, together):

1. `src/orchestrator/provision.ts` — restore `profile.ownerId === agent.ownerId`
   on the `claudeAuthDir()` mount. This is the backstop; without it the other
   two are bypassable.
2. `src/api/routes.ts` — `POST /v1/agents`: refuse a `subscription` profile with
   no `secretRef` whose `ownerId` differs from the caller's.
3. `src/api/routes.ts` — the profile-switch branch of `PATCH /v1/agents/:id`:
   the same check.

Better still, refuse at the **Shared toggle** (`PATCH /v1/ai-profiles/:id`) so a
machine-login profile cannot be marked shared at all, and point the operator at
`claude setup-token` instead. Note a setup token is still a long-lived
credential to the owner's Claude account — sharing it is *acceptable*, not
*safe*; the genuinely safe design is for Hatchabot to broker the calls and never
hand the credential over.

## 2. Un-sharing an AI profile does not revoke it

`buildRuntimeSpec` re-reads the profile on every provision/rebuild with no
shared/ownership re-check, so once another account's agent is on your source,
flipping **Shared** off changes nothing — it keeps using your credential
forever. The profile also cannot be deleted while their agent references it.
Sharing is therefore a **one-way door**. Fix: re-validate access at provision
time and fail the agent with a clear reason when it has been revoked.

## 3. The fleet media key reaches every account

`MEDIA_KEY_REF` (`GEMINI_API_KEY`) is injected into **every** agent container
regardless of owner, while the routes that manage it are host-owner-only. Any
account can read it out of its own container. Fix: scope it per owner, or treat
it as an explicitly shared house credential.

## 4. First sign-in claims the whole installation

`store.adoptLocalOwnerData` re-keys every `dev-owner` row — agents, profiles,
**hosts**, memberships, peers, tokens — to whichever principal authenticates
first, with no email allowlist. On a box switched to identity mode, the first
account to sign in inherits the installation *and* host ownership (drain/delete
host, media key, pool, backups, `agents?all=1`). Fix: an explicit operator
allowlist, or a one-time claim token.

## 5. Containers run without capability restrictions

Agent containers get `--memory` and `--pids-limit` but no `--cap-drop=ALL` and
no `--security-opt=no-new-privileges`, while executing model-generated shell and
Python. The image runs as non-root, which is the main protection. Fix: drop
capabilities by default.

## 6. Members can read more than they should

- `GET /v1/agents/:id` returns the full `publicAgent` to a role-`user` member,
  including host filesystem paths (`dataSources[].hostPath`) and env-var names.
- `GET /v1/usage` is member-visible while `GET /v1/agents/:id/usage` is
  owner-only — the same data behind two different gates, and the fleet route
  runs a `docker exec` in the owner's container on a member's request.

## 7. Operational gaps that bite at scale

- `kickRebuild` checks `inflight` but not the `busy` flag, so a batch rebuild
  reports success for agents that were silently dropped mid-move/mid-restore.
- No reconcile rule for `DELETING`, and the web UI hides Delete in that state —
  a crash mid-delete strands the agent with its secrets un-scrubbed.
- Reconcile and `scripts/backup-volumes.sh` both skip runner-host agents
  entirely: agents on a runner are never health-mended and never backed up.
- Backup restore proceeds after its own safety snapshot fails (`exportState`
  rejects past ~1 GB on `maxBuffer`), then runs a destructive replace.
- `openclawImport` rewrites the user's live `openclaw.json` non-atomically.
- `tcp://` runner endpoints are accepted with no TLS enforcement.

## 8. Every DM member shares one conversation thread

*Found 2026-08-30 while investigating a "lost memory" report. Not yet decided.*

OpenClaw keys a direct-chat session per AGENT, not per person: `agent:<slug>:main`.
Every member who DMs the bot writes into that one transcript, and the session's
`route`/`origin`/`lastTo` fields simply track whoever spoke most recently. Group
chats get their own key (`agent:<slug>:telegram:group:<id>`), so the shape is one
shared DM thread plus one per group.

Verified on this installation: **a test agent** has three active members, one
session file, and 223 user messages in it — 3 flagged `senderIsOwner: true`, 220
`false`. Two people's conversations, one thread.

**What this means.** Anything a member says is context for the agent's replies to
every other member. Nobody is quoted verbatim to anyone else, but the agent
answers each person carrying what the others told it, and a member can simply ask
it what was discussed. For a family agent that is arguably the point;
for a health, legal, or money agent shared between two people it is not what
either would assume.

The per-agent **Shared memory** toggle does NOT govern this — it only selects a
section of `AGENTS.md` describing whether `MEMORY.md` entries are contributed by
everyone. Session sharing happens underneath, either way.

**What "fixed" looks like:** decide whether an agent's threads are shared or
per-member, make it a visible per-agent setting, and — if per-member — route each
sender to their own session key. Until then the sharing should at minimum be
stated where members are invited, since today nothing tells them.

## 9. PARTIALLY CLOSED — session resets: the race is fixed and checkpoints exist, but chat-initiated resets still lose the thread

*Opened 2026-08-30 with a wrong explanation; corrected 2026-08-31; partially
closed since — see "Shipped" and "Still open" below.*

**Retracted:** an earlier version of this entry claimed OpenClaw resets every
conversation at 4am UTC. That is false. The default policy resolves to
`mode: "daily", atHour: 4`, but it is plainly not enforced: 19 of 35 live
sessions on this box have kept talking across 4am boundaries, 14 of them hold a
gap longer than 24 hours between consecutive messages, and one holds a gap of
**570 hours**. No idle threshold is enforced either, for the same reason. The
"9/9 resets fit the daily rule" test that produced the wrong claim was nearly
vacuous — any reset of a day-old session satisfies it.

**What is actually established:**

- Resets are *command-driven*, not time-driven. The trigger is
  `RESET_COMMAND_RE = /^\/(new|reset)(?:\s+([\s\S]*))?$/i` on an inbound
  message, or the `sessions.reset` gateway RPC. There is no timer.
- Only 9 resets exist across this installation's whole history.
- 7 of the 9 had no Hatchabot operation on that agent within 8–29 hours.
- The 2 on Art Advisor landed 11s and 15s after a container replacement — but
  there have been 298 `runtime.rebuilt` events in total, so replacement plainly
  does not reset a session as a rule.
- Archiving never deletes a transcript. The previous one is kept beside the new
  one as `<session>.jsonl.reset.<iso>`.

**Still unknown:** what issued the reset in those 9 cases. The open candidates
are a `/new` or `/reset` typed in the chat, and something specific to the
container-replacement path that fires only sometimes.

**The decisive test, run 2026-08-31:** Art Advisor was archived mid-conversation
(about Van Gogh), restored, left alone for five minutes, then messaged in the
existing chat with no command. The thread survived intact — same session id,
no new `.reset.` file, the Van Gogh exchange still in context. Messaged 11s,
15s and 35s after earlier restores, the same agent reset every time. So the
trigger is TIMING, not archiving: an agent messaged seconds after its container
comes back starts a new session.

**Shipped:**

- v0.72.0 — `waitForSkillsSettled` holds an agent in PROVISIONING / REBUILDING
  until its skill inventory stops changing, which is a proxy for "done moving"
  rather than a claim about the mechanism — `runRebuildHook` can install
  skills seconds before the agent goes live, on this very path. The probe is
  bounded and never fails a provision, and it logs `runtime.ready` with the
  settling time so the proxy can be judged from production data.
- A manual checkpoint: **📝 Save chat to memory** on the card
  (`POST /v1/agents/:id/checkpoint`) has the agent summarise the live
  conversation into `MEMORY.md` (~20s, measured on a short conversation).
- The same checkpoint offered automatically before the resets Hatchabot itself
  causes: a pre-ticked checkbox on the AI-source switch and the bulk
  switch-and-rebuild.

**Still open:** nothing hooks OpenClaw's **`before_reset`** — the hook fires
with the outgoing transcript's messages, the natural place to hang a
checkpoint — so a `/new` or `/reset` typed in the chat still loses the thread
with no checkpoint. `MEMORY.md` is written only if the agent chooses to write
it (on Art Advisor it was still the 166-byte stub), so a chat-initiated reset
takes the only copy of that context.

---

*Sources: the 2026-08-25 and 2026-08-27 audits. The full finding list, including
what was fixed, is in `CHANGELOG.md` under v0.39.0, v0.40.0 and v0.59.0.*
