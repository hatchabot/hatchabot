# Before this serves anyone you don't fully trust

AgentClaw currently runs as a **single-household installation**: every account
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
*safe*; the genuinely safe design is for AgentClaw to broker the calls and never
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

---

*Sources: the 2026-08-25 and 2026-08-27 audits. The full finding list, including
what was fixed, is in `CHANGELOG.md` under v0.39.0, v0.40.0 and v0.59.0.*
