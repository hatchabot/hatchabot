# Real per-user identity — scope

Step 1 of the GCP plan. Replaces the single shared password with accounts, on
a path that keeps local-only installs working exactly as they do today.

## Why now

Everything downstream assumes it: Cloud Run exposure (a shared password on
the public internet is a non-starter), the "full invite" tier (an invitee who
can log in), per-user AI profiles and billing, and the phone app (which wants
token auth, not a cookie minted from a shared secret).

## Provider choice

**GCP Identity Platform** (Firebase Auth's GCP face). Email/password +
Google sign-in out of the box, ~50k MAU free, and verification is just
"validate a JWT against Google's public JWKS" — no vendor SDK required
server-side, and the web app can log in through Identity Platform's REST API
(`accounts:signInWithPassword`), keeping our single-file no-build page.

## Design

### Auth modes, not a rewrite

`auth.ts` gains a mode switch (env: `AGENTCLAW_AUTH=password|identity`):

- `password` — today's behavior, unchanged. The default. A home install
  never needs a Google project.
- `identity` — `Authorization: Bearer <ID token>` verified against the
  project's JWKS (issuer + audience + expiry + signature). The session
  cookie mechanism stays for the browser; it just gets minted from a
  verified token instead of the shared password.

### Principal plumbing

`ownerIdOf()` returns the verified principal's uid (in password mode, the
single local owner). Every store query already filters by `ownerId` —
the schema needs no change, which is the payoff of having threaded ownerId
from day one.

### Migrating a dev-owner install

One-time, on first login after switching modes: if rows owned by
`dev-owner` exist and no other real owner does, re-key them to the
authenticated uid (`UPDATE ... SET owner_id = ?`  across agents, profiles,
hosts, invites, memberships). Logged loudly. This turns an existing
installation into account #1 without export/import.

### Members become accounts (full invites)

Per the invite-tiers decision: membership (agent-scoped chat access) stays
distinct from accounts (system login). The lightweight Telegram invite is
untouched. The full invite becomes: invite link → invitee signs in/up via
Identity Platform → membership binds their uid → role-scoped API access
(`user` members: see their agents, chat links, leave; no lifecycle controls).
Requires per-route role checks — today every authenticated caller is
effectively the owner.

### CLI and phone app

Both are token clients. CLI: `agentclaw login` does the REST sign-in, stores
the refresh token in `~/.config/agentclaw/env`, refreshes ID tokens as
needed; `--password` keeps working against `password`-mode installs. The
phone app follows the identical flow — that's the point.

## Phases

1. **Seam** — ✅ shipped 2026-08-01. `AGENTCLAW_AUTH=password|identity`
   (`authModeFromEnv`, password default; identity mode refuses to boot until
   phase 2 rather than silently serving an unauthenticated install).
   `src/api/principal.ts` owns the caller: auth sets `req.principal`, routes
   read `ownerIdOf(req)` instead of sniffing the legacy header, and every
   by-id route resolves through `ownedAgent(req, id)` so a foreign agent 404s
   (previously ownerId scoping existed only on list routes — the audit's
   finding 8). Sessions are now bound to a hash of the current password, so
   rotating `AGENTCLAW_PASSWORD` invalidates outstanding 30-day cookies.
   Covered by test/auth.test.ts.
2. **Identity mode** — ✅ shipped 2026-08-01. `src/api/identity.ts` verifies
   ID tokens against Google's securetoken certs (no Admin SDK, no service
   account); `auth.ts` accepts Bearer tokens per call and mints a 12h cookie
   from `POST /v1/session`. Web login does Google (GIS credential →
   `signInWithIdp`) and email/password via the Identity Toolkit REST API;
   `agentclaw login` stores a refresh token 0600. `/v1/config` (open in both
   modes) tells the login screen which mode to render.
   Configured via env: `AGENTCLAW_GCP_PROJECT`,
   `AGENTCLAW_IDENTITY_API_KEY`, `AGENTCLAW_GOOGLE_CLIENT_ID`.
3. **Migration** — ✅ shipped 2026-08-01. `Store.adoptLocalOwnerData` re-keys
   agents/profiles/hosts/memberships/invites from `dev-owner` to the first
   real account that signs in, in one transaction, and refuses if any real
   account already owns data here (so it can only happen once).
4. **Roles** — ✅ shipped 2026-08-01. `Store.listVisibleAgents` /
   `Store.accessRole` grade every caller as owner / member / no-access;
   `visibleAgent()` gates read-only surfaces while everything that changes an
   agent (lifecycle, files, snapshots, members, export, bot token, gateway,
   delete) stays on `ownedAgent()`. The agent list reports the viewer's
   `role`, and the app renders members a chat-only card. Full invites:
   `POST /v1/join` accepts an optional `idToken`, and the join page offers
   Google sign-in — signing in keys the membership to the account so the
   invitee can log in and see the agent; skipping it keeps the old
   Telegram-only membership. Covered by test/roles.test.ts.

Each phase lands green on a real installation before the next; nothing
requires Cloud Run to exist yet.

## Non-goals (for now)

- Multi-owner *hosting* (several families on one control plane) — the data
  model supports it once ownerId is real, but pricing/isolation questions
  come with the cloud step, not this one.
- SSO providers beyond Google/email.
- Token-gated agent-to-agent APIs.
