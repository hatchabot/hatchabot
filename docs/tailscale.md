# Off-LAN access via Tailscale

AgentClaw's control plane binds `0.0.0.0:8080` on the host. Tailscale turns
that into "reachable from anywhere, by exactly the people you choose" without
opening a single port to the internet. This is the family-scale access story:
the invite flow works from a phone on cellular, not just your wifi.

## Current state on this host

- Tailscale is installed and up; this machine is `my-host`
  (`100.64.0.1`, MagicDNS `my-host.example.ts.net`).
- The app is reachable tailnet-wide **today** at
  **http://my-host.example.ts.net:8080**.
- `AGENTCLAW_PUBLIC_URL` in `.env` makes invite links use that address, so a
  link minted while you browse localhost still works from an invitee's phone.

## Getting another person on (e.g. the invitee)

Tailscale's free Personal plan covers 3 users / 100 devices — enough for the
family case.

1. They install the Tailscale app (iOS/Android) and create an account.
2. You invite them to your tailnet: https://login.tailscale.com/admin/users →
   **Invite users**. (Alternatively, share only this machine:
   admin console → Machines → `my-host` → **Share**.)
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
`https://my-host.example.ts.net` (no port), and `.env` should switch to:

```
AGENTCLAW_PUBLIC_URL=https://my-host.example.ts.net
```

then `systemctl --user restart agentclaw`.

## Deliberately NOT enabled: Funnel

`tailscale funnel` would publish the app to the open internet (no Tailscale
app needed for invitees). We don't: the app's auth is one shared LAN-grade
password, and join pages are reachable by code alone. That's the right
tradeoff for a tailnet, not for the public internet. Revisit only alongside
real per-user identity.
