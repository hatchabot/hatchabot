# Cloud hosting milestone — two modes, one login

This is the engineering plan for the hosted AgentClaw service: a user signs in,
creates agents, and runs them on **our** cloud infrastructure — while keeping
their **Claude Max** running on their own desktop. It builds on the single-VM
guide (`deploy-gce.md`), the shipped per-user identity (`identity.md`), and the
GCP plan agreed 2026-07-30.

## The core idea: Max on the desktop, API in the cloud — coexisting

An agent's AI comes from its **AI profile**, and a profile is one of three kinds:

| Profile kind | Auth | Runs on |
|---|---|---|
| `subscription` (Claude Max) | `~/.claude` login or `claude setup-token` | **local/desktop hosts only** |
| `api_key` (Anthropic/Google) | a stored API key | any host, incl. **cloud** |
| `local` (Ollama) | none | any host with a model server |

The runtime already **enforces** this: provisioning a `subscription` profile on a
non-local host fails and rolls back (`provision.ts:260`, `test/provision.test.ts`).
Max auth is interactive OAuth bound to the user's machine — it cannot be hosted
on a headless VM (Anthropic guidance) — so this guard is correct, not a gap.

So "two modes" is not a fork we have to build; it's the **host + profile pairing
that already exists**. The cloud milestone doesn't replace Max — it adds
**cloud hosts** as a second placement option next to the user's desktop hosts.

### The hybrid a user actually gets

One login (`AGENTCLAW_AUTH=identity`, Google). Under it, a fleet of hosts:

- **Their desktop/laptop** — registered as a `local` host in the control plane
  (via a setup token, the mechanism already used to add servers). Agents here use
  their **Max** subscription. Free with the subscription, best models, but only up
  while the machine is.
- **Our cloud VMs** — `gce` hosts. Agents here use **their Anthropic API key**
  (in Secret Manager, injected at boot, metered to their org). Always-on, no
  laptop required.

The user chooses per agent where it lives, and **Rehost** (already shipped) moves
an agent between desktop and cloud. Typical shape: the always-on "family
concierge" runs in the cloud on the API key; a heavy personal research agent runs
on the laptop on Max.

## Architecture

```
                 Google sign-in (Identity Platform — SHIPPED)
                              │
                    ┌─────────▼──────────┐
                    │  Control plane     │  Cloud Run (scale-to-zero)
                    │  Fastify + routes  │  ── swap sqlite → Cloud SQL Postgres
                    └───┬────────────┬───┘
          RemoteDocker  │            │  Secret Manager (AI keys, bot tokens)
          (new provider)│            │
        ┌───────────────▼──┐   ┌─────▼───────────────┐
        │ VM fleet (gce)   │   │ User desktop (local)│  registered as a host
        │ bin-packed Docker│   │ Docker + Max login  │  (setup token — SHIPPED)
        │ API-key agents   │   │ Max agents          │
        └──────────────────┘   └─────────────────────┘
```

**What exists today:** the routes, the host abstraction, per-user identity, AI
profiles (all three kinds), the setup-token host-registration flow, Rehost,
backups, adopt. `LocalDockerProvider` runs Docker on the same box the control
plane runs on.

**What the cloud step adds:**

1. **`RemoteDockerProvider`** — `LocalDockerProvider` talking to a remote Docker
   socket (TLS/SSH) instead of the local one, plus **least-loaded placement**
   across the VM fleet. This is the single biggest new component. Bin-packing
   ~20–30 idle agents per `e2-standard-4` is what makes the unit economics work
   (per-agent Cloud Run/GKE was rejected at ~$10–15/agent idle, because OpenClaw
   long-polls Telegram and never scales to zero).
2. **Cloud SQL Postgres** — the store is sqlite today; multi-tenant hosting needs
   a shared, backed-up, concurrent DB. `Store` is the single seam (it wraps one
   `better-sqlite3` handle); porting to `pg` is bounded but real work.
3. **A `HIBERNATING` state** — stop a long-idle container (volume kept) to reclaim
   fleet capacity; wake on the next Telegram message or a scheduled cron. The
   state machine already anticipates this transition.
4. **Fleet ops** — provision/retire VMs, health-check them, drain before delete,
   surface fleet load (the health dashboard is the natural home for this).
5. **Onboarding** — "create your first host" (a cloud host is auto-assigned; a
   desktop host is added by running one installer + pasting a setup token),
   "connect your AI" (paste an Anthropic key for cloud, or log into Max on the
   desktop), then QR-add phones/laptops and share with family (both partly built:
   app-QR pairing + the full-invite Google flow are shipped).

## Cost model (per the July analysis)

- ~20–30 agents per `e2-standard-4` (~$100/mo) → **$3–5 / agent / month** of
  infra, on top of the user's own Anthropic API usage (metered to them).
- Cloud SQL + Cloud Run + Secret Manager are small fixed costs at this scale.
- Hibernation lowers the effective per-agent cost further for the many agents
  that sit idle between bursts — which fits the "create → solve → recycle"
  lifecycle: most agents are short-lived.

## Milestones (in dependency order)

- **M0 — foundation (DONE):** per-user identity (Google), host abstraction, AI
  profile kinds + the Max-on-local guard, Rehost, setup-token host registration,
  backups, the health dashboard.
- **M1 — Postgres:** port `Store` from `better-sqlite3` to `pg` behind the same
  interface; run the existing suite against both. *Unblocks multi-tenant.*
- **M2 — RemoteDockerProvider + placement:** run agents on a remote Docker host;
  least-loaded placement across a static 1–2 VM fleet. *Unblocks cloud agents.*
- **M3 — control plane on Cloud Run:** deploy the Fastify app to Cloud Run against
  Cloud SQL + Secret Manager; the desktop-host hybrid (home box registers into the
  cloud control plane) works end to end.
- **M4 — hibernation + fleet ops:** `HIBERNATING` state + wake; VM provision/drain;
  fleet-load view. *Makes the economics real.*
- **M5 — onboarding polish:** first-host wizard, QR device-add, family sharing on
  top of the shipped full-invite flow.

Critical path: **M1 → M2 → M3**. M4/M5 are optimization + UX and can trail.

## Open decisions (not engineering — product)

- **Isolation between tenants on a shared VM.** Docker's default isolation vs
  gVisor/Kata/per-tenant VMs. Bin-packing several families on one box is the
  economics; the isolation bar is a trust/liability call.
- **Pricing/packaging.** Flat per-agent, tiered agent count, or usage-based;
  whether the infra fee is separate from the user's Anthropic spend.
- **API-key custody.** The user pastes their Anthropic key into Secret Manager;
  confirm the trust story (we can decrypt it at boot to inject it) is acceptable,
  and whether to support per-org keys / spend caps.
- **"Max in the cloud"** stays blocked on Anthropic delegated auth, not on us —
  revisit only if that ships. Until then the hybrid *is* the answer.

## Non-goals for this milestone

- Multi-region, autoscaling the VM fleet, or GKE — a static small fleet is enough
  to validate the product.
- SSO beyond Google/email.
- Replacing the desktop/Max path — it stays first-class forever.
