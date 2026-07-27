# AgentClaw

Deployment & management layer for OpenClaw agents. Spec:
`~/.openclaw/workspace-tech-advisor/projects/agentclaw-spec.md`.

This repo currently contains the **control plane skeleton** (§11.5 steps 1–6)
running end to end against a mock runtime provider — no cloud account, no cost.

## Run it

```sh
npm install
export AGENTCLAW_SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

npm run e2e             # whole tap-+ → first-reply loop in-process (mock provider)
npm test                # unit tests (claim flow, state machine)
npm run dev             # HTTP control plane on :8080

# Real runtime on this machine:
./scripts/build-runtime-image.sh   # once per OpenClaw version
npm run e2e:docker                 # boots a real OpenClaw container, checks health, tears down
TELEGRAM_BOT_TOKEN=123:abc npm run e2e:docker   # full flow: live bot, pairing claim
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
For local hosts, the whole `~/.claude` directory is bind-mounted into each
agent container: every agent shares the one OAuth credential *in place* (same
file, same host), so token refresh stays coherent. The credential is never
copied into AgentClaw's store.

**First-contact claim rides OpenClaw's native pairing.** Fresh agents boot with
`dmPolicy: "pairing"`; the owner taps the deep link, messages the bot, and the
control plane auto-approves the first pairing request inside the claim window,
binding that Telegram id to the owner membership (`src/orchestrator/claim.ts`).
Later senders wait for explicit approval via `/v1/agents/:id/pairing`.

**One container per agent, one volume per agent** (`LocalDockerProvider`).
`provision()` goes all the way to `docker create` so env/mounts are baked into
the container and start/stop survive control-plane restarts. All durable state
lives on the volume — containers are cattle.

## Status

**The full loop is verified live (2026-07-27):** real OpenClaw container,
Telegram pairing auto-claimed by the control plane, real Claude reply on a Max
subscription. `TELEGRAM_BOT_TOKEN=… npm run e2e:docker` reproduces it.

## Known gaps

- Auth is a placeholder header (`x-agentclaw-owner`).
- Persistence is SQLite; production target is Postgres.
- Claim window auto-approves the *first* contact — fine for a link shown only
  to the owner; revisit if deep links ever get shared before claim.
