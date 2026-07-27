# AgentClaw

Deployment & management layer for OpenClaw agents. Spec:
`~/.openclaw/workspace-tech-advisor/projects/agentclaw-spec.md`.

This repo currently contains the **control plane skeleton** (§11.5 steps 1–6)
running end to end against a mock runtime provider — no cloud account, no cost.

## Run it

```sh
npm install
export AGENTCLAW_SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

npm run e2e      # drives the whole tap-+ → first-reply loop in-process
npm run dev      # HTTP control plane on :8080
npm run typecheck
```

## Shape

```
src/
  domain/       Agent, AIProfile, Membership + the §11.4 state machine
  store/        SQLite persistence (one file to swap for Postgres)
  secrets/      SecretStore interface; local AES-256-GCM impl
  providers/    RuntimeProvider interface + MockProvider
  channels/     ChannelProvisioner interface + two Telegram strategies
  openclaw/     Surgical openclaw.json patching + workspace seeding
  orchestrator/ The §11.1 provisioning flow: idempotent steps + rollback
  api/          Fastify routes
```

Three interfaces are load-bearing and were built before anything used them,
per §7: `RuntimeProvider` (so GCE/AWS slot in without touching the control
plane), `ChannelProvisioner` (so WhatsApp/Signal slot in without touching the
provisioning flow), and `SecretStore` (so GCP Secret Manager replaces the local
impl in one line).

## Decisions worth knowing

**Telegram bots are leased, not minted.** Telegram has no API for creating
bots — BotFather is a bot you talk to as a human. `TelegramPoolProvisioner`
leases from a pool of hand-minted bots so the user never sees BotFather;
`TelegramManualProvisioner` is the unbounded fallback where the user pastes
their own token. Both sit behind `ChannelProvisioner`, so switching strategy
is config.

**We do not template `openclaw.json`.** Its schema is volatile. The provisioner
emits a handful of `openclaw config set` commands touching only the four paths
AgentClaw owns (`agents.list`, `channels.telegram.accounts.*`, `bindings`,
`agents.defaults.model`). Everything else stays as OpenClaw's defaults and the
user's edits left it. See `src/openclaw/configWriter.ts`.

**Subscription credentials are owner-hosted only.** See `docs/ai-profiles.md`.

## Known gaps

- **Owner lockout on first provision.** The Telegram allowlist (§12.4) is keyed
  on Telegram user ids, which we don't know until someone DMs the bot. A fresh
  agent therefore boots with an empty allowlist and refuses its own owner. Needs
  a first-contact claim: the deep link carries a one-time code
  (`https://t.me/<bot>?start=<code>`), the agent binds the first sender who
  presents it to the owner membership, then enforces the allowlist normally.
- No real runtime provider yet — `MockProvider` only. Next up is a Docker
  provider that runs against the local machine.
- Auth is a placeholder header (`x-agentclaw-owner`).
- Persistence is SQLite; production target is Postgres.
