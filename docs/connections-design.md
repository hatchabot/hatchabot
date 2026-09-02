# Design: Connections & skills for advanced agents

*Status: designed 2026-08-24. Phase 1 has SHIPPED since — the `gog` Google
Workspace CLI is baked into the runtime image, `GOG_HOME` puts each agent's
tokens on its own volume, and auth happens in the chat. Later phases (OAuth
brokering, per-agent search-provider plumbing) remain design.*

Most agents need no outside data — they organize conversations and carry
training. But the advanced ones (the condo adviser reading board emails from
Gmail and files from Drive) depend on three things AgentClaw doesn't manage
yet: **tool binaries** in the runtime, **skills** teaching the agent to use
them, and **credentials** (OAuth, not paste-a-key). This doc is the plan for
those, grounded in the real condo-adviser setup.

## What the condo adviser actually depends on

| Dependency | Shape | Hard? |
|---|---|---|
| `gog` binary (Google Workspace CLI) | one static Go executable | easy — add to the image |
| `gog` skill | `skills/gog/SKILL.md` + metadata — plain files | easy — files already travel |
| Google OAuth credential | file-based token store (`gog auth`), needs periodic refresh, granted per service (gmail, drive, …) | **the hard part** |
| Mail-fetch crons, workspace files | already handled by adopt | done |

A load-bearing observation from a live setup: the adviser authenticates as a
**purpose-bound Google account** (e.g. `building-adviser@example.com`), not a
personal one. That instinct should become the documented recommendation: an
agent's connection should be to an account scoped to the agent's job, because
**every member of the agent can act as that account**.

## Why OAuth credentials are the hard part

1. **Interactive consent.** Google's flow wants a browser; containers are
   headless. Setup must either happen on a desktop and move, or use a
   paste-the-code flow the agent can relay.
2. **Refresh.** Tokens rewrite themselves. A copied snapshot goes stale; the
   store must be writable wherever the agent runs.
3. **Blast radius.** A Gmail token isn't a folder mount — it's the power to
   read and send as a person. Shared-memory family agents plus a personal
   Gmail credential is a leak by design.
4. **Mobility.** A host-dir mount (the Max machine-login pattern) pins the
   agent to the local host — it can't Move to a runner.

## The design: credentials live ON THE AGENT'S VOLUME

The decisive choice. Put connection credentials (e.g. the gog token store)
on the agent's own volume — `GOG_HOME=/home/node/.openclaw/connections/gog`
style — instead of mounting a host directory. Everything else falls out:

- **Refresh works** — the volume is writable, tokens rewrite in place.
- **Move/backup/export just work** — the volume already travels (validated
  live DGX ⇄ laptop); nightly backups are already encrypted; the Download
  file is already documented as a credential.
- **Templates stay safe** — Share exports SOUL/AGENTS/MEMORY, never the
  connections dir, so a shared template can't leak a Google account.
- **Per-agent isolation** — two agents never share one token store; revoking
  one agent's access is deleting one directory (or the Google-side revoke).

## Setup UX: the agent bootstraps its own connection

Because `gog auth` supports a paste-back flow, setup can happen **in the
Telegram chat itself**:

1. Owner (in chat): "connect Gmail" → agent runs `gog auth add …` in its
   container, which prints a consent URL.
2. Owner opens the URL on their phone, approves, pastes the code back.
3. Tokens land in the agent's connections dir. Done — no desktop, no file
   copying, no AgentClaw UI at all.

AgentClaw's role is to make that possible and visible, not to broker OAuth:

- **Phase 1 (enable):** add `gog` (and similar static CLIs) to the runtime
  image; seed the `gog` skill; set the config-dir env so tokens land on the
  volume. The chat flow above then works with zero new UI.
- **Phase 2 (surface):** a **Connections** tab in agent Settings showing
  what's connected (`gog auth list` via exec), with per-service scopes, a
  "disconnect" (delete the store), and the member-access warning. Possibly
  a guided "connect" that relays the URL/code without Telegram.
- **Phase 3 (skills management):** show the agent's `skills/` in the Files
  UI; include skills in Share templates so "a trained agent" means its
  skills too; a curated skill library to enable per agent at creation.

## Guardrails (phase 1 already needs these)

- **Recommend purpose-bound accounts** in every connection surface — the
  condo-adviser pattern. A personal Google account on a shared-memory agent
  gets a loud warning.
- **Scopes minimal by default** — `gog auth add --services gmail` when only
  mail is needed, not the full six.
- **Owner-only setup** — connection commands should require the owner seat
  (members can use the agent's powers, not mint new ones). OpenClaw-side
  enforcement is weak here; the near-term mitigation is documentation plus
  the existing allowFrom membership gate.
- **Send vs read** — the skill card already says "confirm before sending
  mail"; keep that instruction in seeded skills.

## Non-goals

- No OAuth broker in the control plane (AgentClaw never holds Google client
  secrets or refresh tokens outside the agent volume).
- No attempt to make host-dir credential mounts work on runners — volume
  residency replaces that pattern entirely.
- No per-message permission prompts — membership stays the security
  boundary, scoped accounts the blast-radius control.

## Follow-up: search-provider plumbing (recorded 2026-08-25)

v0.35.1 hard-enables the keyless DuckDuckGo provider for every agent; that
was the fix for "web search is not available", not the end state. Likely
next: **per-agent search-provider control** —

- a picker (probably on the agent's AI or a future Connections tab):
  DuckDuckGo (free default) / Brave (needs `BRAVE_API_KEY`) / Gemini
  (needs a Gemini key) — OpenClaw auto-detection already prefers a keyed
  provider, so the plumbing is: enable the right plugin per agent + land the
  key (Environment tab today; per-provider fields later);
- surface WHICH provider is active in the ❤️ Health / doctor panel, so
  "search works" and "search works via X" are both visible;
- possibly a fleet default in Settings (e.g. "all agents: Brave") with
  per-agent override.

Keep the cost model honest in the UI: Brave free tier ~2k queries/mo,
Gemini metered — a chatty fleet can burn a shared key quickly, which argues
for per-agent keys over one fleet key.

## Follow-up: runtime image variants / marketplace (recorded 2026-08-25)

The framing: no single image suits all agents, and a kitchen-sink image
bloats every agent to serve a few. The natural evolution is **multiple
runtime images, selected per agent** — a small curated set first, a
marketplace shape later:

- `agentclaw-runtime:base` — today's image (openclaw + claude-code + python
  + gog);
- `…:media` — + ffmpeg / local whisper (offline voice transcription — the
  alternative to the Gemini media key for the privacy-first path);
- `…:data` — + pandas/numpy-class libraries pre-baked (vs today's
  per-volume `pip install --target pylibs`);
- `…:browser` — + playwright/chromium for browsing agents.

Plumbing notes for when this happens: `agent.image` (nullable → fleet
default) chosen at create/Settings; provision passes it through
(RuntimeSpec already flows an image via provider opts — needs to become
per-spec); Docker layer sharing keeps variants cheap if they share the base;
**Move must ensure the target runner has the agent's image** (generalize the
Install-image button/flow to arbitrary tags); update-available detection
becomes per-image. Keep the default experience single-image — variants are
an advanced pick, like everything else in this doc.

## Adopt implications (the condo adviser's path in)

Adopting an agent that uses host-side gog today means its tokens live in the
host's `~/.config/gogcli`, not the workspace. The adopt flow should detect
known connection dirs referenced by the agent's skills/crons and offer:
"copy this credential store onto the agent's volume (recommended — it will
then move with the agent), or re-connect fresh in chat afterwards."
