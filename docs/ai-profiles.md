# AI Profiles: API key vs Claude Max subscription

The spec (§11.0) says a user pastes "their Claude API key (or subscription
creds)". Those are two different mechanisms with different constraints, and the
difference decides what AgentClaw can host.

## API key — fully supported

An `ANTHROPIC_API_KEY` is a bearer string. We store it encrypted, inject it into
the runtime at boot, and it works identically on a cloud container and a local
box. Billing is metered per token against the key's organisation. This is the
only credential type `POST /v1/ai-profiles` currently accepts for cloud hosting.

## Claude Max subscription — owner-hosted only

A Pro/Max subscription is not a key. It is an interactive OAuth login that
mints a short-lived token plus a refresh token, stored as a credential profile
on the machine where you logged in (`~/.config/anthropic/` for the `ant` CLI,
`~/.openclaw/credentials/` for OpenClaw). Two consequences:

1. **There is no documented server-side credential for it.** Anthropic's own
   guidance is explicit that interactive login is for development on your own
   machine, and that non-interactive workloads (CI, servers, containers) should
   use API keys or Workload Identity Federation instead. Copying a subscription
   token into a fleet of managed cloud containers is outside what that auth path
   is built for, and refresh tokens hard-expire — a silent, staggered outage
   across every agent using that profile.

2. **A subscription is a single person's seat, with per-account rate limits.**
   Five always-on agents sharing one Max subscription contend for the same quota.
   For one person's own agents on their own machine that's a capacity question
   they can judge. For AgentClaw hosting agents on their behalf it becomes our
   reliability problem, with no per-agent attribution.

So: the subscription is cheaper, and it should absolutely be usable — but the
supported shape is **`kind: 'subscription'` + `host.kind: 'local'`**. The agent
runs on the machine where the login already exists and reuses the credential
in place; AgentClaw never holds or copies the token. That covers the actual
use case (Chris's own agents on the DGX Spark on his Max plan) without us
brokering someone else's seat.

Cloud-hosted agents take an API key. The app should say so plainly at profile
creation time rather than letting a user pick a combination that will expire
under them.

## Current state in code

- `AIProfile.kind` carries the distinction (`src/domain/types.ts`).
- `POST /v1/ai-profiles` rejects `kind: 'subscription'` with a pointer here.
- **Not yet built:** the local-host path that reuses an existing on-box
  credential instead of injecting one. Needs the Host Agent (§5.4) first, since
  that is the component that runs on a machine where the login already lives.
