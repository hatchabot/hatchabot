# Adding semi-trusted family members — security risk assessment (2026-09-08)

Consolidated from a five-reviewer threat-model audit of Hatchabot v0.119.0.
**Threat model:** member **B** has their own identity-mode account and controls
their own agents (which run AI-authored bash). Target **A** = you (the owner).
Everything runs on one shared host.

## Verdict

**The system's isolation is fundamentally sound, and one setting change is the
difference between safe and not.** No reviewer found an exploitable cross-owner
breach in the API, and container escape to your host/DB/secrets is blocked by
default. The real exposure is concentrated in a few **deliberate sharing
features** and **missing resource limits** — all manageable with settings you
control plus a little code hardening.

Concretely: adding a family member is **reasonably safe IF** you (1) run identity
mode, (2) never share a *machine-login* AI source, (3) give the member their own
AI credential (or accept they can read the shared one), (4) cap their agents, and
(5) keep them a management *viewer*, not operator. Details below.

## What holds — you are NOT exposed here (verified by multiple reviewers)

- **API resource isolation is complete.** All ~110 routes were traced: every
  by-id mutation is `ownedAgent`-gated (owner only); members get read-only
  metadata with tokens/params stripped. B cannot read or mutate A's agents,
  connections, files, env, snapshots, peers, or CLI tokens. The routes are the
  sole boundary and they hold.
- **No container escape to your machine by default.** The Docker socket is never
  mounted; no `--privileged`, host network, or `--device`. The SQLite DB **and**
  the encrypted secret store live on the host FS and are **not** mounted into any
  container. Containers run non-root (uid 1000).
- **B cannot mount your files.** Host-folder mounts are gated by `ownsLocalHost`,
  which is false for B — only you can name host paths, and a blocklist refuses
  `~/.claude`, `~/.ssh`, `~/.config/hatchabot`, `/etc`, `/root`, `/`, etc.
- **Google refresh tokens are owner-isolated.** B cannot attach or read your
  Google connection tokens (cross-owner attach is blocked; reconcile is
  vault-scoped).
- **Bot pool, invites, mgmt authority, confirmations** are all owner-scoped:
  B can't lease your bots or read their tokens; invite codes are 49-bit CSPRNG,
  single-use, 48h; B's mgmt bot sees only B's fleet.
- **The new operator/viewer mgmt split (v0.119.0) has no bypass** — viewers are
  blocked at the broker regardless of global mode, and the group-chat guard is on
  both message and callback paths.

## The real risks, ranked

### 1. Sharing a *machine-login* Claude Max source — full credential + code-exec as you (HEADLINE)
If a machine-login subscription profile (no stored token) is marked **Shared**,
selecting it mounts **your entire `~/.claude` read-write** into the member's
container: your OAuth refresh token, every Claude transcript, and
`settings.json` whose hooks execute **as you** on the host. This is the one true
cross-owner data breach, and it's a local privilege-escalation from B to you.
- **Your status today: SAFE but unguarded.** Your machine-login profile
  ("Household Claude") is `shared=0`, so it only touches your own agents. But
  nothing *stops* it being shared later — the "refuse to share machine-login"
  guard and the owner-match checks are deliberately commented out
  (`provision.ts:478-489`, `routes.ts:1749-1760`, `:2147`, `:1320`).
- **Fix:** never share it; better, restore the code guards (safe now — nothing
  relies on a shared machine-login).

### 2. Shared AI credentials are extractable plaintext (by design)
- **Setup-token Max** (your shared default): the token is injected as
  `CLAUDE_CODE_OAUTH_TOKEN` env + written to the agent volume. A member who uses
  your shared source can `env`-read your Max token and reuse your subscription
  off-platform for ~1 year. No host access, no transcripts — strictly smaller
  than #1, but still a credential hand-off.
- **Fleet GEMINI + BRAVE keys** are injected into *every* agent; any member can
  read them from their own container and burn your quota.
- **Fix:** give the member their **own** AI credential (own setup-token, or best,
  a dedicated metered/revocable API-key profile). Decide the fleet keys
  consciously — unset them if you don't want members reading them.

### 3. Missing resource / isolation containment on the shared box
Members run model-generated code as containers on your machine, and today there
is: **no** `--cap-drop=ALL` / `--security-opt=no-new-privileges`; a **shared
Docker bridge** (B's container can reach A's containers by IP); **no disk quota**
(a member can fill the disk and take down everything, including the control
plane); **no CPU limit**; and `HATCHABOT_MAX_AGENTS_PER_ACCOUNT` **defaults to 0
= unlimited**. RAM (`--memory 2g`) and pids are capped; GPU is not exposed.
- **Fix:** set the agent cap (setting); add `no-new-privileges`, `--cpus`, and
  ideally cap-drop + a per-owner network (code).

### 4. Setup-time traps
- **Identity mode is required.** In password mode every caller is the same
  `dev-owner` — there is no A/B boundary at all. Family members MUST be identity
  mode.
- **First sign-in claims the whole installation.** On an identity-mode switch,
  the first account to authenticate inherits all agents, hosts, keys, and
  backups. **You must have signed in first.**
- **No account allowlist.** Anyone who can authenticate to your Google Identity
  project becomes a valid (empty-fleet) tenant. "Semi-trusted family member" =
  "anyone who can sign up to the project" — know who that is.
- **Keep `HATCHABOT_ALLOW_OWNER_HEADER` unset** in production (it's a full
  owner-spoof; correctly test-only and off by default).

### 5. Narrower issues
- **First-contact claim race:** if B messages your *newly-leased* pool bot before
  you've ever linked your Telegram id, B can bind as owner-in-chat on that one
  fresh agent. Skipped once your identity is known; blast radius is chat-level on
  that agent, not control-plane. Consider requiring explicit approval once the
  box has more than one owner.
- **Shared DM session thread (privacy):** OpenClaw keys a DM session per *agent*,
  not per *person* — two members DMing one shared agent share a transcript and
  can ask what the other said. The Shared-memory toggle doesn't govern this.
  Don't share an agent for genuinely private one-to-one topics.
- **`asSelf` "That's me" footgun:** tapping it on a pending request that's
  actually the member's writes *their* id into *your* account seat everywhere.
  Owner-only (B can't invoke it), but a costly misclick.
- **Recycled house-bot reassignment** DMs a member's new agent name to your
  former chatters (metadata leak via the shared pool).

## "Before you add family members" checklist

**P0 — do these or the member is not safe:**
1. **Run identity mode** (`HATCHABOT_AUTH=identity`) and **confirm you own the
   local host** (Settings → hosts shows it as yours) — i.e. you signed in first.
2. **Never mark a machine-login AI source Shared.** Share only setup-token — or
   better, give the member their own API-key profile.
3. **Set `HATCHABOT_MAX_AGENTS_PER_ACCOUNT`** to a sane number (e.g. 3–5).
4. **Add the member as a management VIEWER** (`HATCHABOT_MGMT_VIEWERS`), never to
   `HATCHABOT_MGMT_ALLOWLIST`. (The viewer tier shipped in v0.119.0.)

**P1 — strongly recommended:**
5. Decide the **fleet GEMINI/BRAVE keys** consciously — leave unset if members
   shouldn't read them.
6. **Don't mount sensitive or RW host folders** on any agent a member can
   message; prefer the **git data-source** kind. (Only you can add mounts, so
   this is your discipline.)
7. Treat **shared memory / shared DM thread** as non-private; don't put
   health/legal/money on an agent two members share.

**P2 — code hardening (defense-in-depth):**
8. Restore the machine-login owner guard + refuse sharing a machine-login profile
   (makes #1 a guarantee, not a discipline). Safe to apply now.
9. Add `--security-opt=no-new-privileges`, `--cpus`, and (with a compatibility
   check) `--cap-drop=ALL` and a per-owner Docker network to the runtime.
10. Remember **sharing is a one-way door**: un-sharing a profile does NOT revoke
    agents already on it — rotate the underlying credential if you ever shared the
    wrong source.

## Bottom line

Your instinct to check first was right, and the answer is encouraging: the
scary paths (steal the vault, escape to the host, read another owner's agents via
the API) are closed. What remains is a set of **deliberate sharing choices** and
**resource limits** that you control. Do the four P0 items and a semi-trusted
family member is a bounded, reasonable risk — the main residual being that any
shared AI credential is a credential you're genuinely handing over, so give them
their own.
