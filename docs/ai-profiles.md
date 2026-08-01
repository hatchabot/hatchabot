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
on the machine where you logged in (`~/.claude/.credentials.json` on Linux;
the Keychain on macOS). Two consequences:

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
in place; AgentClaw never holds or copies the token.

### macOS hosts: the setup-token path

On Linux the login is a file (`~/.claude/.credentials.json`) that gets mounted
into each runtime. On macOS Claude Code stores the credential in the Keychain
— there is no file to mount, and Linux containers can't read a Mac's Keychain.
The supported route there is `claude setup-token`: it mints a long-lived
(~1 year) token tied to the subscription, which AgentClaw stores encrypted and
injects as `CLAUDE_CODE_OAUTH_TOKEN` at boot instead of mounting `~/.claude`.
Paste it into the token field when creating the subscription profile. When it
eventually expires, run setup-token again and recreate the profile. That covers the actual
use case (Chris's own agents on the DGX Spark on his Max plan) without us
brokering someone else's seat.

Cloud-hosted agents take an API key. The app should say so plainly at profile
creation time rather than letting a user pick a combination that will expire
under them.

## Current state in code

- `AIProfile.kind` carries the distinction (`src/domain/types.ts`).
- The local-host subscription path is built: the owner's `~/.claude` is
  mounted into each runtime (`hostMounts` in `buildRuntimeSpec`), and the
  OpenClaw config routes the model through the Claude Code CLI
  (`authMode: 'oauth-claude-cli'` in `src/openclaw/configWriter.ts`).
  Profile creation checks the login exists on this host; the local-host-only
  rule is enforced where an agent binds a profile to a host — belt and
  suspenders in `POST /v1/agents` and `buildRuntimeSpec`.
- Profiles are managed from the app (⚙ AI): default model, the switchable
  `/model` list, additional API-key profiles.
