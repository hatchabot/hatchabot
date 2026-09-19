# Security sweep — 2026-09-19 (exposure & Telegram access)

21st audit. Asked for after a day of rapid UI releases (v1.36.0 → v1.41.1):
*"check especially that no risks have been introduced, like to Telegram access
methods — I'm worried about some random person on the internet getting access."*

Two questions, answered separately:

1. **Did today's changes open anything?** No. The detail is below.
2. **What can actually reach this installation from outside?** Three things,
   all pre-existing, one of which deserves action.

## 1. What changed today, reviewed line by line

Server-side diff since v1.35.3 is small: `src/api/routes.ts` (+65),
`src/api/mgmtChat.ts` (+16), `src/ops/notify.ts` (new), `src/ops/opsAgent.ts`,
`src/store/store.ts` (+12), plus the management-tool ledger. Everything else was
`web/index.html`.

| Change | Authorisation | Verdict |
|---|---|---|
| `DELETE /v1/mgmt/status` (retire the legacy bot) | authenticated; `ownerIdOf(req)`; deletes only that owner's heartbeat and their own `mgmt-bot`-labelled tokens; refuses while the bot is still beating | sound; in the tool-coverage ledger as fleet-wide/irreversible |
| Token list + **Revoke** in Settings → Security | the pre-existing `GET`/`DELETE /v1/cli-tokens`, both owner-scoped (`agent_id IS NULL`, so A2A call tokens can't be revoked through it) | sound — and it closes a real gap: the app could mint tokens and never withdraw one |
| Management-agent notes (`src/ops/notify.ts`) | not a route; runs `openclaw agent -m` in the owner's own management agent | see "prompt surface" below |
| Multi-select image trial | `PATCH /v1/agents/:id {image}` already refuses a non-machine-owner (`ownsLocalHost`), per agent | sound |
| Image-pin dropdown | reads `GET /v1/runtime/images` (machine-owner only) | sound |
| Channel buttons (Telegram/Slack/Discord) | opens a stored deep link | hardened, below |
| Telegram link moved to **You**; legacy bot section hidden unless one exists | display only | no policy change |

**No route lost an authorisation check, and no Telegram policy was touched.**

### Two hardening fixes made during the sweep (v1.42.0)

- **Deep links are opened only if they are `https:`.** Every deep link
  Hatchabot stores is built server-side (`https://t.me/<bot>`,
  `https://slack.com/app_redirect?...`, `https://discord.com/users/<id>`), so
  this is belt-and-braces — but the new buttons *open* those values, and a
  `javascript:` string in that column would otherwise run on click.
- **Build output quoted to the management agent is marked as data.** A failed
  build's last line is now stripped of control characters and square brackets,
  bounded to 300 characters, and the note says program output is never
  instructions. Docker build logs contain text from packages Hatchabot did not
  write; this keeps a log line from closing the note's brackets and addressing
  the agent directly. It could only ever have produced a *proposal*, which
  still needs the owner's Confirm — but the note is free to make safe.

## 2. Telegram: what stops a stranger

Telegram is the one surface that is, by design, reachable by anyone on the
internet: bot handles are public and anyone can message one. The controls, all
verified in code today:

- **Every agent is provisioned `dmPolicy: 'pairing'`** (`provision.ts:572`,
  one place, no per-agent override). A stranger's first message creates a
  *pending request*; the agent does not answer it.
- **Approving is owner-only**: `POST /v1/agents/:id/pairing/approve` is gated by
  `ownedAgent(req, id)` and needs a real pending code — the code exists only
  because that person actually messaged the bot.
- **`allowFrom` is not a wish list**: it is seeded from
  `listAllowedChannelUserIds`, which reads *active memberships for that agent*.
  No cross-agent or cross-owner leakage is possible through it.
- **Group chats** are `groupPolicy: allowlist` (admitted members only) or, when
  the owner binds one room, exactly that room id with `requireMention`. Written
  unconditionally on every build, so clearing the setting cannot leave a stale
  open room on the volume.
- **Invite links**: 10 characters from a 31-symbol alphabet (~49 bits, rejection
  sampled), single use, 48-hour expiry, burned atomically with the membership,
  and dead if the agent is gone.
- **Account link** ("That's me — link"): binds *your* Telegram id to your login
  from an authenticated session, against a pending pairing code. It only makes
  future agents admit you without pairing.
- **Bot tokens** live encrypted (`secretRef`), are never in the agents list, and
  are revealed only by an explicit owner-authenticated call.

**Conclusion: to reach an agent on Telegram, a stranger needs the owner to press
Admit, or a live invite link.** Nothing today changed any of that.

### If you attach Telegram to the management agent

Supported (the jail opens `api.telegram.org` only for a management agent that
has a channel), and the same pairing gate applies. Two things to hold in mind:
that bot's handle is discoverable like any other, and the agent behind it knows
the whole fleet. Link your own Telegram to your account first so you are
admitted automatically, and admit nobody else on that bot.

## 3. What is actually exposed on this machine

Probed live: `ss -ltnp`, `tailscale serve/funnel status`, docker port bindings,
`journalctl`.

| Listener | Reach | Assessment |
|---|---|---|
| Tailscale serve → `localhost:8080` | **tailnet only** — Funnel is off | correct; the app is not published to the internet |
| `0.0.0.0:8080` (Hatchabot) | loopback + LAN (`192.168.2.53`) + tailnet + docker bridges | **worth changing.** Access is meant to be via Tailscale; binding to every interface puts the login page (and the auth-exempt `/join/*`, `/v1/invites/*` paths) on the home LAN for no benefit |
| `*:11434` (Ollama, unauthenticated) | LAN **and tailnet** | **the real finding.** Anyone on either can use the GPU, read prompts and pull/delete models. Agents reach it at `172.17.0.1:11434`, so binding Ollama to `127.0.0.1` **and** the docker bridge keeps them working while taking it off the LAN |
| `0.0.0.0:4000` | LAN + tailnet | **unidentified**, owned by another user (invisible from this account); accepts TCP, answers neither HTTP nor TLS. Identify with `sudo ss -ltnp sport = :4000` |
| `0.0.0.0:22` (sshd) | LAN + tailnet | expected; confirm `PasswordAuthentication no` |
| `172.17.0.1:8091` (the agent door) | docker bridge only — not routable from the LAN | plus the peer check: only a current doorman may knock. Today's journal shows the check working (`ops.peer_refused` count: 0 in 6h; the only refusals are `ops.proxy_refused` for `openrouter.ai` and `raw.githubusercontent.com`, i.e. the allowlist turning away OpenClaw's own startup probes) |
| agent containers | every gateway port published on `127.0.0.1` only (verified: no container publishes on `0.0.0.0`) | sound |

Also confirmed: `HATCHABOT_ALLOW_OWNER_HEADER` is **not** set in the production
`.env`, so the `x-hatchabot-owner` test header is inert; the internal principal
requires a per-process random secret *and* a loopback peer; session cookies are
`httpOnly`, `sameSite: strict`, `secure` on HTTPS; the console proxy and its
WebSocket upgrade both check agent ownership against the real signed-in caller,
and the session cookie is stripped before anything reaches a gateway.

## Recommended, in order

1. **Bind Ollama off the LAN/tailnet** — `OLLAMA_HOST` to loopback plus
   `172.17.0.1` (a systemd drop-in), then check an agent on a local model still
   answers. Open since the 19th audit.
2. **Bind Hatchabot to loopback** and let Tailscale serve reach it
   (`tailscale serve` already proxies `localhost:8080`). Requires knowing
   whether anything on the LAN uses `192.168.2.53:8080` directly.
3. **Identify port 4000** with sudo, and close it if it is not wanted.
4. Confirm sshd has password authentication off.

Nothing here blocks a release; items 1–3 are a hardening pass on the machine,
not on Hatchabot.
