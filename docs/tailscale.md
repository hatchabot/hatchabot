# Off-LAN access via Tailscale

> **Inviting someone who isn't on the tailnet?** They don't need Tailscale at
> all: send them the agent's Telegram link (shown in the Invite dialog). When
> they message the bot, a "wants to talk" card appears in the app; **Let them
> in** makes them a member and the bot sends the shared-memory disclosure as
> its first message. Tailscale is only needed for someone to open Hatchabot's
> web pages, including the classic invite-link join flow below.

With a password set, Hatchabot's control plane binds `0.0.0.0:8080` on the
host (without `HATCHABOT_PASSWORD` it deliberately binds `127.0.0.1` only,
since every request would be treated as the owner). Tailscale turns
that into "reachable from anywhere, by exactly the people you choose" without
opening a single port to the internet. This is the family-scale access story:
the invite flow works from a phone on cellular, not just your wifi.

## What you get

- Once Tailscale is up, the machine has a stable MagicDNS name like
  `<your-machine>.<your-tailnet>.ts.net`.
- The app is then reachable tailnet-wide at
  **http://<your-machine>.<your-tailnet>.ts.net:8080** — no ports opened.
- `HATCHABOT_PUBLIC_URL` in `.env` makes invite links use that address, so a
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
   is public infrastructure; Tailscale is only needed for the Hatchabot pages).

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
HATCHABOT_PUBLIC_URL=https://<your-machine>.<your-tailnet>.ts.net
```

`serve` proxies 443 → localhost:8080, so everything that talks to
`http://localhost:8080` directly (the management bot, the CLI, cron scripts)
keeps working unchanged, and cert renewal is Tailscale's problem. If you're
using Google sign-in, add the new `https://…ts.net` origin to the OAuth
client's authorized JavaScript origins in the GCP console — the old
`http://…:8080` origin stops matching.

**No tailnet?** The server also speaks TLS natively: point
`HATCHABOT_TLS_CERT` / `HATCHABOT_TLS_KEY` at PEM files in `.env` and it
serves HTTPS itself (both or neither — half-configured refuses to boot),
then `systemctl --user restart hatchabot`. You own the cert lifecycle on
that path.

## Deliberately NOT enabled: Funnel

`tailscale funnel` would publish the app to the open internet (no Tailscale
app needed for invitees). In **password mode** that's a bad trade: one shared
password guards everything. With `HATCHABOT_AUTH=identity` (per-user accounts,
see docs/identity.md) the calculus changes — but note the join pages are still
reachable by invite code alone, by design.


## The OpenClaw console needs HTTPS

Each agent's OpenClaw console (⋯ → **OpenClaw (debug)**) creates a device
identity with WebCrypto, which browsers only allow in a *secure context*: an
`https://` page, or `http://localhost`. Tailscale encrypting the wire doesn't
count — the browser judges by the URL scheme alone.

So from another machine, open Hatchabot at its **https** address
(`https://<machine>.<tailnet>.ts.net`, set up with `tailscale serve` above), not
`http://<machine>:8080`. Over plain http the app says so instead of opening a
console that can never connect. It works on the host itself because
`localhost` counts as secure even without TLS — which is why it can look like
"only works on localhost".

The console opens inside Hatchabot rather than in a new tab (an *Open in new
tab* link is there if you want one). It is served through Hatchabot on its own
origin — that is what lets it work off-machine while the agent's gateway port
stays bound to loopback — so it is an owner tool: whoever opens it has a shell
in the agent's container.

### "Device pairing required"

On HTTPS, the next thing OpenClaw asks is that each **new browser** be approved
once. Its own message says to run `openclaw devices approve <id>` "on the
Gateway host" — but the gateway runs inside the agent's container, so that is
not something you can do from a laptop.

Hatchabot does it for you, automatically: while the console panel is open it
watches for the request and approves it, then reconnects — you don't click
anything. It approves only requests made in the last ten minutes (the one you
just caused), only for the agent's owner, and only while that panel is open. If
it can't, an **Approve this browser** button appears instead. This is safe because the only way to
reach the gateway from another machine is through Hatchabot's proxy, which
already requires your session — the gateway itself listens on loopback, and
loopback clients never need pairing.

Approval is stored on the agent's volume, so that browser stays approved
through rebuilds. By hand, if you ever need it:
`docker exec <agent-container> openclaw devices approve <request-id>`.
