# Public access: "Reach it from anywhere"

By default a self-hosted Hatchabot is reachable on your network and your
tailnet, and from nowhere else. Public access makes its **sign-in page
reachable from the internet**, so the people you invite need no Tailscale app:
they open an address and sign in.

It is **off** unless the machine's owner turns it on, and it cannot be turned
on, or stay on, unless every safeguard on this page holds. The first provider
is **Tailscale Funnel**; the safeguards are the same for any later one.

Status: built on a branch, not released. Nothing here has run against a real
tailnet yet; see "Not verified yet" at the end.

## What it is, in one picture

```
 internet ──TLS──▶ Tailscale's relay (does not decrypt)
                       ▼
        tailscaled on this machine: ends TLS, proxies to
                       ▼
   127.0.0.1:8092  THE PUBLIC LISTENER  ── every request here is a stranger
                       ▼
               the same Hatchabot app
                       ▲
   0.0.0.0:8080    the private listener ── this machine, the LAN, the tailnet
                       ▲                    (`tailscale serve` on 443 lands here)
        browsers at home / on the tailnet, the CLI, agents, runners
```

Two listeners, one app. **Which listener a request arrived on decides its
trust class, and nothing else does** (`src/api/trust.ts`): every socket the
public listener accepts is recorded when it connects, and a request is
"public" if and only if its socket is one of those. Funnel is pointed at the
public listener's port and no other.

Why not read a header? Funnel traffic reaches Hatchabot from `127.0.0.1`
(tailscaled proxies it) and tailscaled marks it `Tailscale-Funnel-Request: ?1`.
A design that trusted "no Funnel header means local" would hand owner-level
trust to any request that arrives without it: a proxy change, a missing
header, a second path to the port. With a separate listener, no header a
visitor sends, and no header a proxy forgets, moves a request between classes.

## Who can reach what

| Who | Where they connect | What they are to Hatchabot |
|---|---|---|
| Anyone on the internet | the public address (`https://<machine>.<tailnet>.ts.net:8443`) | **public**: the least trusted class. Never "on this machine", never the tailnet. |
| A device on your tailnet | `https://<machine>.<tailnet>.ts.net` (`tailscale serve`) or `http://…:8080` | private, as before |
| A device on your LAN | `http://<machine>:8080` | private, as before |
| This machine itself | `http://localhost:8080` | private; "on this machine" for first-run set-up, as before |
| Agents, runners, the CLI, another Hatchabot | port 8080 or the doors (8091, 8093) | private, by their own tokens, as before |

A tailnet device that opens the **public** address is public too: the class
belongs to the listener, not to the person.

What is different for a public request, everywhere in the code:

| Place | Private (unchanged) | Public |
|---|---|---|
| "On this machine" (`onThisMachine`, the first-run set-up code) | loopback with no proxy headers | never |
| Creating the first account; the owner's first claim | allowed on the machine, or with the set-up code | refused |
| In-process calls of the management agent (`internalPrincipal`) | accepted from loopback with the process secret | refused |
| `x-hatchabot-owner` (test switch `HATCHABOT_ALLOW_OWNER_HEADER`) | read when the switch is on | never read; and the switch being on fails safeguard d |
| Command-line tokens, peer (rehost) tokens, Google bearer tokens | accepted | not looked at: a browser session is the only way in |
| HTTPS (which decides `__Host-`/`Secure` cookies) | from `X-Forwarded-Proto`, TLS, or the public URL's host | always |
| The visitor's address for limits | the socket; `X-Forwarded-For` only from loopback | the address tailscaled reports (the last `X-Forwarded-For` value) |
| Sign-in failure counts | per address and per account | separate `pub:` buckets, so the internet can lock an account out of the public address only |
| A session | the session cookie | the session cookie **and** the public pass (below) |
| A request replayed inside the process (a confirmed change of the management agent) | private | stays public: it is stamped with a secret that never leaves the process |
| Reset links, invitation links | built from the configured private address, never from `Host` | the same (unchanged: `appUrlFor`) |

## The safeguards

Public access can be turned on only when every one of these holds
(`src/api/safeguards.ts`). The API refuses otherwise and names what is
missing; `hatchabot doctor` fails when public access is on with any of them
off; and the running process re-judges them every minute: with one off, **the
public listener answers 503 to everyone** until it is fixed (fail closed), and
the log says which.

| | Safeguard | What enforces it | What it stops |
|---|---|---|---|
| a | A sign-in per person: `accounts` or `identity` mode. The shared-password mode is refused. | `evaluateSafeguards`; the gate refuses everything public in password mode | One guessable secret guarding everything |
| b | A second factor for everyone with owner rights: a passkey or an authenticator app, with one-time backup codes. Members may add one; with `HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL=1` they must. | Enrolment is checked before the switch; at the public address the gate asks for it at sign-in and again before sensitive actions (`src/api/publicAccess.ts`, `secondFactor.ts`) | A stolen, guessed or phished password; a Google session on a borrowed laptop |
| c | Only invited people. At the public address only existing accounts and pending invitations can sign in; nobody registers there; the machine cannot be claimed there. | The `HATCHABOT_PUBLIC_INVITED_ONLY` switch must be on; the route table refuses first-run routes; `/v1/session` refuses a Google account this install has never met; the owner's first claim is refused | Strangers becoming accounts; a fresh machine being taken from the internet |
| d | Public traffic on its own listener, never trusted as local. | `trust.ts`; the listener binds `127.0.0.1` only; safeguard fails if Funnel points at the private port, if the ports clash, or if `HATCHABOT_ALLOW_OWNER_HEADER` is on | A forged or missing header upgrading a stranger to "this machine" |
| e | Only what outsiders need is served there. Every route has a class; an unclassified route is refused. | `src/api/publicRoutes.ts`, enforced in one hook before the handler; `test/publicRoutes.test.ts` sweeps every registered route | Machine-level routes, and any route added later, being reachable by accident |
| f | Limits and lockouts keyed for public traffic. | `auth.ts` (`throttleKeys`): per address, per account with a lockout that doubles each time (one window, two, four, up to a day), a ceiling on all public failures together; request ceilings per address and overall | Password and code guessing; one visitor locking the owner out of the private address |
| g | A notice on a sign-in from a new device, to the person and to the owner. | The gate, on the first use of a public sign-in from a browser it has not seen: in the app (home screen) and on Telegram when linked, with the browser, the approximate source, and "sign out everywhere" | A break-in going unnoticed |
| h | Stricter sessions there. | `__Host-` cookies always; the public pass ends after `HATCHABOT_PUBLIC_IDLE_MINUTES` without use (12 hours; the session cookie alone lasts 30 days); step-up for sensitive actions; HSTS, a content security policy, `frame-ancestors`, `nosniff`, `Referrer-Policy: no-referrer` | A session left open; framing; a cookie handed out without `Secure` |
| i | Automatic upgrades on the `stable` channel. | `src/ops/autoUpgrade.ts`: the `hatchabot-follow-channel` timer is enabled, running, follows `stable`, and the machine is not pinned to a version | A public machine that never takes a security fix |
| j | A record of every public sign-in, failure burst, and the switch going on or off. | `security_log` in the database; Settings → You → Reach it from anywhere → Record | Not knowing what happened afterwards |

### The second factor

- **Passkeys** (WebAuthn), implemented with `node:crypto` and a small CBOR
  reader (`src/api/webauthn.ts`), no dependency. Attestation is `none`: no
  statement is asked for or verified. The RP ID is the public host; the
  origin, the challenge (single use, five minutes), user presence, the
  signature and the signature counter are all checked; a counter that does not
  move forward is refused as a copied key. ES256, RS256 and Ed25519 keys.
  Discoverable credentials are `preferred`, not required.
- **A passkey belongs to the address it was made at.** It must be added while
  Hatchabot is open at `https://<machine>.<tailnet>.ts.net` (the same host
  the public address uses). A passkey made anywhere else does not count for
  safeguard b. The page says where to go.
- **An authenticator app** (TOTP, RFC 6238, SHA-1, six digits, thirty
  seconds). The secret is kept encrypted with the install's key. A code is
  accepted for its own step and one either side, and never twice.
- **Backup codes**: ten, shown once when the first factor is added, each good
  once, kept as keyed hashes.
- **Google sign-in (identity mode).** Google is the first factor. The owner
  still needs a passkey or an authenticator app, and is asked for it at the
  public address like anyone else. Decided this way because a Google session
  already open on a borrowed laptop, or a phished Google password, would
  otherwise be all it takes to reach the machine's settings from the internet.
- **Changing your factors** needs proof beyond the session: your current
  password at the private address; at the public address, the second factor
  given in the last few minutes (or your password, when adding your first).
- **A lost phone.** Backup codes get you in. Without them: sign in at the
  private address, where no second factor is asked; the owner can also clear
  anyone's factors (`hatchabot second-factor reset <user>`). Clearing the
  factors of someone with owner rights pauses public access at once, until
  they add one again.
- **A password reset does not get around it.** A reset link or recovery code
  used at the public address gives a session that is still asked for the
  second factor.

### The public pass

A sign-in made at the public address is given a second cookie,
`__Host-hatchabot_pub`: signed, bound to that session, carrying when it was
last used and when the second factor was last given. Without a valid one the
public address answers "sign in". So:

- a session from the private address does not carry over to the public one
  (cookies are shared between ports of one host, so the cookie itself would);
- a public session ends after the idle time, long before the session cookie;
- the second factor given by one person is never inherited by a sign-in as
  another.

## Route classes at the public address

Every route has exactly one class. This table is generated from
`src/api/publicRoutes.ts` (a test fails if it drifts), and a second test
sweeps every route the app registers, in every sign-in mode, and fails if one
has no rule.

- **open**: no sign-in. The route checks its own credential.
- **second-step**: signed in, second factor not given yet.
- **signed-in**: signed in, second factor given if the person has (or must have) one.
- **step-up**: as signed-in, and the second factor given again within `HATCHABOT_PUBLIC_STEPUP_MINUTES` (10).
- **never**: refused there, whoever asks. Also the class of any route no rule names.

| Class | What |
|---|---|
| open | The app page and its static files |
| open | What the sign-in screen needs |
| open | Sign-in and sign-out |
| open | One-time sign-in links (hosted installs) |
| open | Invitations to an agent (the code is the credential) |
| open | Account invitations and password reset links (the code is the credential; never the machine owner's first claim) |
| open | Forgotten password (Telegram link, recovery code) |
| second-step | The second-factor screen |
| signed-in | Your own account (who am I, sign out everywhere, security notices) |
| signed-in | Command-line tokens: list and revoke |
| signed-in | An agent's OpenClaw console (the owner, or a web-chat guest in their own conversation) |
| signed-in | Web chat |
| signed-in | Your agents: list, create, settings, files, schedules, members, start and stop |
| signed-in | Reading lists and settings (no credential is shown) |
| signed-in | Removing a Google connection |
| step-up | Adding or replacing a second factor |
| step-up | Removing a second factor |
| step-up | Managing accounts (add, remove, reset links, passwords, recovery codes) |
| step-up | Signing someone else out everywhere |
| step-up | Public access: status, its address, and turning it off |
| step-up | The security record |
| step-up | Minting a command-line token |
| step-up | Revealing a stored credential (AI source, bot token, search and media keys) |
| step-up | Changing AI sources (they hold credentials) |
| step-up | Changing the search and media keys |
| step-up | Changing the Google OAuth client |
| step-up | Hosts and runners (add, remove, drain, install an image) |
| step-up | Runner set-up script |
| step-up | Images (build, rebuild, delete, promote) |
| step-up | Machine settings (defaults, rebuild policy, memory search) |
| step-up | Backups (run, restore, delete) and downloads of an agent |
| step-up | An agent's environment variables |
| step-up | Folders of this machine given to an agent, and bringing in workspaces |
| step-up | Moving an agent to another machine |
| step-up | Creating the management agent |
| step-up | Bot pools (they hold bot tokens) |
| step-up | Confirming a change the management agent proposed |
| never | First run: creating the first account |
| never | Agent-to-agent calls (agents reach Hatchabot inside the machine) |
| never | Connecting a Google account (the consent comes back to the private address) |
| never | The private address as a QR code |
| never | Tailscale set-up (private address, HTTPS, links) |
| never | Turning public access on |
| never | Another Hatchabot moving an agent here (token calls; tokens are refused at the public address) |
| never | Linking another Hatchabot |
| never | Resetting someone's second factor |

Reads of lists that show no credential are **signed-in**, so the app's home
screen works without asking for the second factor every few minutes; every
write under a machine-level group, and every read that reveals a credential,
is **step-up**. Rights are unchanged by any of this: a member is still refused
the machine's routes by the routes themselves.

The console's WebSocket is held to the same rules as a signed-in request (the
pass, its idle limit, the second factor).

## Turning it on and off

Before: `accounts` or Google sign-in; Tailscale installed and signed in on the
machine; MagicDNS, HTTPS certificates and the `funnel` node attribute on for
your tailnet (Hatchabot reports exactly which is missing, with the link);
`scripts/follow-channel.sh --install stable`.

1. **Add your second factor**: ⚙ Settings → You → Second factor. For a
   passkey, do this with Hatchabot open at `https://<machine>.<tailnet>.ts.net`.
2. **Only invited people**: tick it under Settings → You → Reach it from anywhere.
3. **Turn on public access…** in the same place, or `hatchabot reach on`. It
   asks: *"This makes your sign-in page reachable from the internet."* Then it
   checks every safeguard, opens the public listener, runs
   `tailscale funnel --bg --https=8443 http://127.0.0.1:8092`, reads Funnel's
   configuration back to confirm that port and no other is public and that it
   lands on the public listener, writes `HATCHABOT_PUBLIC_ACCESS=funnel` and
   the address to `.env`, and shows the address with a QR code. If any step
   fails, the earlier ones are undone.

`hatchabot reach status` shows the switch, the address and every safeguard.
`hatchabot doctor` (and `--json`) does too, and exits 1 when public access is
on with a safeguard off, when `HATCHABOT_PUBLIC_ACCESS` names an unknown
provider, or when Funnel publishes the private port.

**Off** (`hatchabot reach off`, or the button): removes Funnel's entry (and
confirms from Funnel's own configuration that nothing reaches the public
listener), closes the listener, and takes the setting and the address out of
`.env`. `tailscale serve` for the private address is not touched in either
direction. If Tailscale refuses to remove its entry, Hatchabot still stops
serving and says which command to run.

**Port 8443.** The public address is `https://<machine>.<tailnet>.ts.net:8443`.
Funnel allows 443, 8443 and 10000; 443 is left to `tailscale serve`, your
private tailnet address. `HATCHABOT_PUBLIC_FUNNEL_PORT=443` gives a shorter
address at the cost of the private HTTPS address on that port.

Settings: the "Public access" group of `.env` (`src/config/envCatalog.ts`).

## What Funnel sees, and what it does to your address

- Tailscale's relay passes the TLS stream to this machine without decrypting
  it (Tailscale's documentation: "Funnel relay servers do not decrypt the
  traffic"). The certificate's key is on this machine. Tailscale sees the
  visitor's address, the time and the volume; it does not see pages or
  passwords.
- The address is Tailscale's: `<machine>.<tailnet>.ts.net`, not choosable.
  Certificates for it are public (Certificate Transparency), so the name is
  discoverable by anyone who looks: expect scanners at the sign-in page.
- Funnel has bandwidth limits Tailscale does not publish or let you change.
- On a Mac, Funnel needs the open-source Tailscale, not the App Store app;
  and a Mac has no channel timer, so safeguard i keeps public access off there.
- **HSTS.** The public address sends `Strict-Transport-Security` for a week.
  That applies to the whole host name on every port, so a browser that has
  visited the public address will insist on HTTPS for
  `http://<machine>.<tailnet>.ts.net:8080` too and fail there. Use the
  private HTTPS address (`tailscale serve`) or the machine's LAN name or IP
  on that browser.

## What is NOT protected

- **A vulnerability in OpenClaw's gateway behind a signed-in guest.** A
  web-chat guest reaches an agent's gateway through Hatchabot's proxy, cut
  down to what a chat needs. A flaw in the gateway that a guest's allowed
  messages can trigger is reachable by every invited guest, and now from the
  internet. Invite people you trust; keep agents with machine access for
  yourself.
- **A flaw in Hatchabot's own sign-in or session code.** Everything before
  the sign-in (the page, the sign-in forms, the join pages) is reachable by
  anyone. This is the reason for safeguard i.
- **Denial of service.** The ceilings bound what one address and all visitors
  together can ask for; they do not stop a flood from many addresses, and
  Funnel's own limits are Tailscale's. Per-account lockouts mean someone who
  knows a username can keep that account locked out **of the public address**
  (never of the private one).
- **A stolen signed-in device.** A browser already signed in, within its idle
  time, is that person. The step-up limits what it can do to the machine
  (credentials, hosts, images, backups, accounts) without the second factor;
  it does not protect their agents and chats. "Sign out on every device"
  ends it.
- **Members without a second factor.** By default only accounts with owner
  rights must have one. A member's password alone opens their own agents.
  `HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL=1` asks everyone.
- **Invitation codes.** `/join/<code>` pages and account invitations work by
  code alone, by design, and are now reachable from the internet. The codes
  are random and expire; they are still bearer links: whoever holds one can
  use it.
- **The OpenClaw console's own pages** are served without Hatchabot's content
  security policy (it is another program's page).
- **Malware on the machine itself**, or anything else that can connect to
  `127.0.0.1:8092` directly: it is treated as public (the least trust), and it
  can pick its own address for the per-address limits. The per-account
  lockout and the ceilings do not depend on the address.
- **This machine's other services.** Funnel publishes one port. Anything else
  you publish with `tailscale funnel` yourself is yours; `hatchabot doctor`
  fails if that is Hatchabot's private port.

## Not verified yet (needs a real tailnet, with the owner present)

Everything above was built and tested against a stand-in for the `tailscale`
command and a real second listener on loopback. These have **not** been run
against Tailscale itself:

1. That `tailscale funnel --bg --https=8443 http://127.0.0.1:8092` and
   `tailscale funnel --https=8443 off` are accepted as written by the
   installed client, and leave `tailscale serve` on 443 untouched.
2. The shape of `tailscale funnel status --json` (the `AllowFunnel`, `Web`,
   `TCP` fields this reads to confirm what is public and where it lands).
3. The fields of `tailscale status --json` used to report what is missing
   (`CurrentTailnet.MagicDNSEnabled`, `CertDomains`, `Self.CapMap` /
   `Self.Capabilities` naming `funnel`), and the wording of Funnel's own
   refusal and its link.
4. What tailscaled sends to the backend for a Funnel request:
   `X-Forwarded-For` as the visitor's address (read from Tailscale's source,
   `ipn/ipnlocal/serve.go`, not from its documentation, which does not
   mention it), `X-Forwarded-Host`, and that no `Tailscale-User-*` header is
   present. The limits and the notices use the address; the host check uses
   `X-Forwarded-Host`; neither affects the trust class.
5. A real browser at the public address: sign-in, the second-factor prompt, a
   passkey made at the private HTTPS address used at `:8443` (same host,
   different port: the RP ID allows it, the origin list includes it),
   the page under the content security policy, the console and web chat
   through Funnel (WebSockets), HSTS's effect on the plain-HTTP tailnet address.
6. A real authenticator app scanning the QR code, and a real passkey
   (platform and security-key) through enrolment and sign-in.
7. The new-device notice arriving on Telegram through a real bot.
8. Automatic-upgrade detection against a real installed channel timer.
9. Behaviour across a restart with public access on (the listener reopening,
   Funnel's entry persisting), and across a Tailscale restart.
