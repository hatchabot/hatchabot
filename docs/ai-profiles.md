# AI Profiles: API key vs Claude Max subscription

The spec (§11.0) says a user pastes "their Claude API key (or subscription
creds)". Those are two different mechanisms with different constraints, and the
difference decides what AgentClaw can host.

## API key — fully supported

An API key is a bearer string — Anthropic (`ANTHROPIC_API_KEY`) or Google
Gemini (the profile's vendor is `anthropic` or `google`). We store it
encrypted, inject it into the runtime at boot, and it works identically on a
cloud container and a local box. Billing is metered per token against the
key's organisation. This is the only credential type that would work on a host
you don't control.

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

So: the subscription is cheaper, and it should absolutely be usable. There are two
supported shapes:

- **`kind: 'subscription'` machine login + `host.kind: 'local'`** — the agent runs
  on the machine where the login already exists and reuses `~/.claude` in place;
  AgentClaw never holds or copies it. This is the local-only shape.
- **`kind: 'subscription'` + a stored `claude setup-token`** — this rides to **any
  host, a runner included**, because the token is injected as
  `CLAUDE_CODE_OAUTH_TOKEN` rather than mounted. This is how Claude Max runs on a
  runner (e.g. a laptop driven by a control plane on another box).

### macOS hosts: the setup-token path

On Linux the login is a file (`~/.claude/.credentials.json`) that gets mounted
into each runtime. On macOS Claude Code stores the credential in the Keychain
— there is no file to mount, and Linux containers can't read a Mac's Keychain.
The supported route there is `claude setup-token`: it mints a long-lived
(~1 year) token tied to the subscription, which AgentClaw stores encrypted and
injects as `CLAUDE_CODE_OAUTH_TOKEN` at boot instead of mounting `~/.claude`.
Paste it into the token field when creating the subscription profile. When it
eventually expires, run setup-token again and recreate the profile. That covers the real
use case — your own agents, on your own machine, on your own plan — without
anyone brokering someone else's seat.

Cloud-hosted agents take an API key. The app should say so plainly at profile
creation time rather than letting a user pick a combination that will expire
under them.

## Local models — no credential at all

`vendor: 'local'` points an agent at a model server you run yourself (Ollama
today, over its OpenAI-compatible endpoint). It is the only profile kind with
**no credential anywhere**: nothing in the secret store, no env var injected,
no `~/.claude` mounted. That also makes it the only configuration where "your
family's data never leaves this machine" is literally true — and it sidesteps
the prompt-injection blast radius that the mounted subscription credential
carries.

Two things to know:

- **`baseUrl` is what the AGENT sees, not what you see.** Containers cannot
  reach the host's loopback, so `http://localhost:11434` fails. The default is
  the docker bridge, `http://172.17.0.1:11434/v1`. The server must bind
  somewhere the container can reach (`OLLAMA_HOST=0.0.0.0:11434`, or bind the
  bridge address only).
- **Keep the model resident.** Ollama unloads after 5 minutes by default, so
  every message following a gap pays a full model load (tens of seconds, and
  it feels like the machine has hung). Set `OLLAMA_KEEP_ALIVE=-1`. Pair it
  with `OLLAMA_MAX_LOADED_MODELS=1` so a `/model` switch can't hold two large
  models in memory at once.
- **Prefer 8-bit quantization for agents.** Benchmarks put 8-bit within ~2% of
  full precision while 4-bit loses 2–8%, concentrated in structured output —
  which is exactly tool calling. A smaller model at Q8 drives an agent loop
  more reliably than a bigger one at Q4.

## Sharing an AI source with other accounts

With per-user identity, every account brings its own AI sources — a second
sign-in starts with none, and it cannot lean on this machine's Claude login
(that file is the machine owner's Max subscription; billing it silently
would be wrong). Sharing is the owner's explicit call instead: flip
**Shared** on your profile (⚙ Settings → AI sources) and every account on
this installation can pick it for their agents — labelled "(shared)" in
their create dialog. Flip it off and no new agents can take it; agents
already on it keep working until switched. Only the profile's owner can
edit, share, or delete it.

**Sharing is a credential hand-off, not a metered proxy.** A borrower's agent
runs with your key as container env (or, for a subscription, your `~/.claude`
mounted in), so an account you share with can read the raw credential from inside
their own agent. Per-agent env vars can't redirect it (endpoint/proxy names are
refused — see `agent-environment.md`), but only share a profile with accounts you
trust with the underlying key. Prefer a dedicated API key over your Max login for
sharing where you can.

## Per-agent model — pick without switching sources

One AI source can drive many agents on different models. A source has a
**default model** plus a switchable `/model` list; each agent may pin any model
from that list, or follow the default. Set it in **⚙ Settings → Model** (the row
appears only for cloud sources) — it applies on the agent's next Rebuild.

Why this shape:

- **Cloud only.** A local source runs one model at a time (only one fits in the
  GPU), so every local agent follows the source's single model and the picker
  is hidden. The pin is refused server-side for local sources.
- **Stored on the agent, not the volume.** The override lives in AgentClaw's DB
  (`agents.model`) and is written into OpenClaw config at provision time via
  `effectiveModel(agent, profile)` — never persisted into the frozen volume
  copy, which would survive a later change and silently override it.
- **`effectiveModel` = the agent's override if set *and still on the menu*,
  else the source default.** It is the single point that resolves what a runtime
  actually runs, used by both `buildRuntimeSpec` and the applied-model
  bookkeeping — so the guarantee below holds no matter how a pin went stale.
- **Validated against the menu — when set, and again at run time.** A pin must
  be the source's default or one of its switchable models, so a typo fails at
  the API rather than green-lighting a container that dies on first use. Because
  a pin can *later* fall off the menu (the owner edits the source and drops that
  model), two things defend the guarantee: editing a source's model list sweeps
  and clears any agent pin no longer offered (so stored state stays honest), and
  `effectiveModel` falls back to the default for a stale pin (so even an
  un-swept one never reaches the runtime).
- **Travels with a move only if it still fits.** Export carries the pin;
  import keeps it only when the destination source (cloud) offers that model,
  otherwise it drops back to that source's default.

## Sharing your files with an agent

An agent normally sees only its own workspace. **⚙ Settings → "Data this agent
can read"** mounts a host folder into its container at `/data/<folder>`,
**read-only**, for that agent alone.

Two properties make this safe enough to offer:

- **Read-only, enforced by the kernel** — not by asking the agent nicely. An
  agent runs with permission prompts disabled, so a writable mount would make
  one bad instruction destructive.
- **Refused paths** — credential directories (`~/.claude`, `~/.ssh`,
  `~/.config/agentclaw`), system paths (`/etc`, `/root`, `/proc`, `/sys`), the
  docker volume root, and `/` itself. Traversal is normalised before the check.

What it does *not* protect against: **anyone who can message the agent can ask
about those files.** Share per agent accordingly — and remember a shared-memory
agent may write what it reads into a memory every member can see. The safest
combination is a local model plus a shared folder: no credential in the
container and nothing sent off the machine.

## Current state in code

- `AIProfile.kind` carries the distinction (`src/domain/types.ts`).
- The local-host subscription path is built: the owner's `~/.claude` is
  mounted into each runtime (`hostMounts` in `buildRuntimeSpec`), and the
  OpenClaw config routes the model through the Claude Code CLI
  (`authMode: 'oauth-claude-cli'` in `src/openclaw/configWriter.ts`).
  Profile creation checks the login exists on this host; the local-host-only
  rule is enforced where an agent binds a profile to a host — belt and
  suspenders in `POST /v1/agents` and `buildRuntimeSpec`.
- Profiles are managed from the app (⚙ Settings → AI sources): default model, the switchable
  `/model` list, additional API-key profiles.
