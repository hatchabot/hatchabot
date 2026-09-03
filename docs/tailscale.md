# Off-LAN access via Tailscale

> **Inviting someone who isn't on the tailnet?** They don't need Tailscale at
> all: send them the agent's Telegram link (shown in the Invite dialog). When
> they message the bot, a "wants to talk" card appears in the app; **Let them
> in** makes them a member and the bot sends the shared-memory disclosure as
> its first message. Tailscale is only needed for someone to open AgentClaw's
> web pages, including the classic invite-link join flow below.

With a password set, AgentClaw's control plane binds `0.0.0.0:8080` on the
host (without `AGENTCLAW_PASSWORD` it deliberately binds `127.0.0.1` only,
since every request would be treated as the owner). Tailscale turns
that into "reachable from anywhere, by exactly the people you choose" without
opening a single port to the internet. This is the family-scale access story:
the invite flow works from a phone on cellular, not just your wifi.

## What you get

- Once Tailscale is up, the machine has a stable MagicDNS name like
  `<your-machine>.<your-tailnet>.ts.net`.
- The app is then reachable tailnet-wide at
  **http://<your-machine>.<your-tailnet>.ts.net:8080** — no ports opened.
- `AGENTCLAW_PUBLIC_URL` in `.env` makes invite links use that address, so a
  link minted while you browse localhost still works from an invitee's phone.

## Getting another person on (e.g. the invitee)

Tailscale's free Personal plan covers 3 users / 100 devices — enough for the
family case.

1. They install the Tailscale app (iOS/Android) and create an account.
2. You invite them to your tailnet: https://login.tailscale.com/admin/users →
   **Invite users**. (Alternatively, share only this machine:
   admin console → Machines → `<your-machine>` → **Share**.)
3. They accept, toggle Tailscale on. Done — your invite links now open on
   their phone, and Telegram chat with the agents works regardless (Telegram
   is public infrastructure; Tailscale is only needed for the AgentClaw pages).

## Optional upgrade: HTTPS via `tailscale serve`

Plain HTTP on the tailnet is private (WireGuard-encrypted end to end), but
browsers still treat the origin as insecure — e.g. one-tap clipboard copy is
disabled. `tailscale serve` puts a real HTTPS cert in front:

```sh
# one-time, needs your password / admin rights:
sudo tailscale set --operator=$USER     # let your user manage serve
tailscale serve --bg http://localhost:8080
```

If the second command mentions enabling HTTPS certificates: admin console →
**DNS** → *Enable HTTPS*, then rerun it. Afterwards the app lives at
`https://<your-machine>.<your-tailnet>.ts.net` (no port), and `.env` should switch to:

```
AGENTCLAW_PUBLIC_URL=https://<your-machine>.<your-tailnet>.ts.net
```

`serve` proxies 443 → localhost:8080, so everything that talks to
`http://localhost:8080` directly (the management bot, the CLI, cron scripts)
keeps working unchanged, and cert renewal is Tailscale's problem. If you're
using Google sign-in, add the new `https://…ts.net` origin to the OAuth
client's authorized JavaScript origins in the GCP console — the old
`http://…:8080` origin stops matching.

**No tailnet?** The server also speaks TLS natively: point
`AGENTCLAW_TLS_CERT` / `AGENTCLAW_TLS_KEY` at PEM files in `.env` and it
serves HTTPS itself (both or neither — half-configured refuses to boot).
You own the cert lifecycle on that path.

then `systemctl --user restart agentclaw`.

## Deliberately NOT enabled: Funnel

`tailscale funnel` would publish the app to the open internet (no Tailscale
app needed for invitees). In **password mode** that's a bad trade: one shared
password guards everything. With `AGENTCLAW_AUTH=identity` (per-user accounts,
see docs/identity.md) the calculus changes — but note the join pages are still
reachable by invite code alone, by design.
