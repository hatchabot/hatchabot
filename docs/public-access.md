# Public access: "Reach it from anywhere"

By default a self-hosted Hatchabot is reachable on your network and your
tailnet, and from nowhere else. Public access makes its **sign-in page
reachable from the internet**, so the people you invite need no Tailscale app:
they open an address and sign in.

It is **off** unless the machine's owner turns it on, and it cannot be turned
on, or stay on, unless every safeguard on this page holds. The first provider
is **Tailscale Funnel**; the safeguards are the same for any later one.

Status: built on a branch, not released. Nothing here has run against a real
tailnet yet; see "Not verified yet" at the end, and "Open" for what is known
and not fixed.

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
| Reset links, invitation links | built from a configured address, never from `Host` | the same rule. While public access is on and serving they are made for the public address (the person opening one may not be on the tailnet); otherwise for the private one |

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
| b | A second factor for everyone who signs in with a password, and for everyone with owner rights: a passkey or an authenticator app, with one-time backup codes. The owners must have theirs before public access can be on; anyone else without one is stopped at the public address until they add one. A Google account without owner rights is exempt (Google is its factor). Chat-only guests are exempt only if the owner says so (see "Who needs a second factor"). | The owners' enrolment is checked before the switch; at the public address the gate asks everyone for it at sign-in and again before sensitive actions (`src/api/publicAccess.ts`, `secondFactor.ts`) | A stolen, guessed or phished password; a Google session on a borrowed laptop |
| c | Only invited people. At the public address only existing accounts and pending invitations can sign in; nobody registers there; the machine cannot be claimed there. | The `HATCHABOT_PUBLIC_INVITED_ONLY` switch must be on; the route table refuses first-run routes; `/v1/session` refuses a Google account this install has never met; the owner's first claim is refused | Strangers becoming accounts; a fresh machine being taken from the internet |
| d | Public traffic on its own listener, never trusted as local. | `trust.ts`; the listener binds `127.0.0.1` only; safeguard fails if Funnel points at the private port, if the ports clash, if `HATCHABOT_ALLOW_OWNER_HEADER` is on, or (while public access is on) if Funnel's configuration cannot be read | A forged or missing header upgrading a stranger to "this machine" |
| e | Only what outsiders need is served there. Every route has a class; an unclassified route is refused. | `src/api/publicRoutes.ts`, enforced in one hook before the handler; `test/publicRoutes.test.ts` sweeps every registered route | Machine-level routes, and any route added later, being reachable by accident |
| f | Limits and lockouts keyed for public traffic. | `auth.ts` (`throttleKeys`): per address, per account with a lockout that doubles each time (one window, two, four, up to a day), a ceiling on all public failures together; a guess still being checked counts as a miss until it is answered (`reserve`), so a burst cannot outrun the limit; request ceilings per address and overall | Password and code guessing; one visitor locking the owner out of the private address |
| g | A notice on a sign-in from a new device, to the person and to the owner. | The gate, on the first use of a public sign-in from a browser it has not seen: in the app (home screen) and on Telegram when linked, with the browser, the approximate source, and "sign out everywhere". Limited, so a valid password cannot be used to spam: see "New-device notices" | A break-in going unnoticed |
| h | Stricter sessions there. | `__Host-` cookies always; the public pass ends after `HATCHABOT_PUBLIC_IDLE_MINUTES` without use (12 hours; the session cookie alone lasts 30 days); step-up for sensitive actions; HSTS, a content security policy, `frame-ancestors`, `nosniff`, `Referrer-Policy: no-referrer` | A session left open; framing; a cookie handed out without `Secure` |
| i | Automatic upgrades on the `stable` channel. | `src/ops/autoUpgrade.ts`: the `hatchabot-follow-channel` timer is enabled, running, follows `stable`, and the machine is not pinned to a version | A public machine that never takes a security fix |
| j | A record of every public sign-in, failure burst, second factor added, removed or reset, and the switch going on or off. | `security_log` in the database; Settings → You → Reach it from anywhere → Record | Not knowing what happened afterwards |

### Who needs a second factor

At the public address, by default and with no setting to turn it off:

| Who | At the public address |
|---|---|
| An account with owner rights (a password or Google) | Must have one, or public access cannot be on. Asked for it at sign-in and before sensitive actions. With none: refused, and told to add one at the private address. |
| Anyone else who signs in with a **password** | Must have one. With none they are **stopped**: nothing works there but the second-factor screen. If they arrived, in the last half hour, by an invitation, a reset link or a recovery code, they are sent to add one (their password is asked for as well). Otherwise they are told plainly: ask the owner for a reset link and add one right after using it, or add one at the private address. |
| A **Google** account without owner rights (identity mode) | Exempt: Google is their second step. If they add a factor, it is asked for. Step-up routes still need one. |
| A **chat-only guest**, if the owner has turned on "Let chat-only guests in without a second factor" | Let in with their password, for the chat and nothing else (below). Off by default. |

`HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL` was the opt-in before this was the
rule. `=1` now changes nothing. Any other value (`0`, `off`, …) is **ignored**:
it is not a way to weaken the rule, and `hatchabot doctor` warns that the line
does nothing.

**A chat-only guest**, exactly (`store.isChatOnlyGuest`, read from the database
on every request), is an account for which all of this is true:

1. it signs in with a password and has no owner rights over the machine
   (not a host-owner account, not the owner of this machine's row);
2. it is an **active member with web chat on** of at least one agent that is
   not deleted, is not the management agent, and **belongs to someone else**;
3. it **owns no agent** (in any state but deleted: running, stopped, archived
   or draft), so it has no console of its own (an owner's console is a shell
   in the agent's container);
4. it owns **no AI source** and **no host or runner**;
5. it has no second factor that works at the public address (with one, it is
   simply asked for it).

The exemption is the owner's deliberate choice: the switch beside "Only
invited people" (Settings → You → Reach it from anywhere), `hatchabot reach
guests on`, or `HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR=1`. It asks
first, in plain words (*"Anyone who learns, guesses or phishes a guest's
password can then read and send in that guest's chats from the internet"*),
can be turned **on** only at the private address, and is on the security
record. What it gives a guest, enforced by the gate for every request
(`guestMay` in `src/api/publicRoutes.ts`): the reads of the signed-in class
(each route still shows only what is theirs), the chat itself (the console
proxy and `POST /v1/agents/:id/chat`), signing out, and dismissing a notice.
Everything else is refused with "Without a second factor you can chat here and
nothing else": creating or changing an agent, linking a Telegram account
(where a reset link would then be sent), every step-up route. The moment any
line of the definition stops being true (they are given an agent, their web
chat is switched off) the next request is judged as a member's. With the
switch on, an account that owns nothing may also **accept a web-chat
invitation** at the public address without a factor: that is how someone
becomes a guest.

Status (`hatchabot reach status`, and the settings page) names everyone who
has no second factor yet, so the owner can send each a reset link.

### The second factor

- **Passkeys** (WebAuthn), implemented with `node:crypto` and a small CBOR
  reader (`src/api/webauthn.ts`), no dependency. Attestation is `none`: no
  statement is asked for or verified. The RP ID is the public host; the
  origin, the challenge (single use, five minutes), user presence, the
  signature and the signature counter are all checked; a counter that does not
  move forward is refused as a copied key. ES256, RS256 and Ed25519 keys.
  Discoverable credentials are `preferred`, not required. **User
  verification** (a PIN, a fingerprint, a face) is `required` for an account
  with owner rights, asked of the browser and checked in every answer's
  flags; for everyone else it is `preferred`. (An owner's key that cannot
  verify its user, such as a bare security key with no PIN, cannot be added
  and is not accepted: use an authenticator app, or set a PIN on the key.)
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
  given in the last few minutes. Clearing your own factors
  (`POST /v1/second-factor/reset/me`, `hatchabot second-factor reset <you>`)
  is changing them, and asks for your password too.
- **Before the factor is given**, the second-factor screen at the public
  address learns which kinds to offer (a code, a passkey, a backup code) and
  nothing else: no factor ids, names, dates or "last used", no count of
  backup codes. Whoever holds only the password reads no more than that.
- **Adding your first factor at the public address** needs more than your
  password, because the password is exactly what a thief would have: whoever
  held it would enrol their own phone, and the account would be theirs. The
  sign-in must also have come, in the last half hour, from something sent to
  you out of band: an invitation or reset link from the owner, the Telegram
  recovery link, your recovery code, or (with Google sign-in) a Google
  sign-in just made. Then your password is asked for as well. Otherwise add
  it at the private address. So a member who has no factor yet and cannot
  reach the private address asks the owner for a reset link, and adds one
  right after using it. The page says so, once, where it cannot be missed.
- **A lost phone.** Backup codes get you in. Without them: sign in at the
  private address, where no second factor is asked; the owner can also clear
  anyone's factors (`hatchabot second-factor reset <user>`). Clearing the
  factors of someone with owner rights pauses public access at once, until
  they add one again.
- **A factor reset or removed takes its proofs with it.** Every second factor
  that person gave at the public address before the reset (or the removal, or
  an authenticator app replaced by a new one) stops counting, on every copy of
  every cookie: adding a new factor afterwards does not make an old sign-in
  verified again, it is asked for the new one. Someone who removes a factor at
  the public address keeps the proof they gave moments before (the step-up).
- **A password reset does not get around it.** A reset link or recovery code
  used at the public address gives a session that is still asked for the
  second factor.

### Recovery at the public address

- **An account with owner rights is recovered at the private address only.**
  At the public address its reset link (the Telegram one, or one another
  owner sent) and its recovery code are refused, with a plain message saying
  where to go; neither is spent by the refusal, and both work at the private
  address. The refusal is given only to someone holding the link or the right
  code, so it tells a stranger nothing about whose account it is. Asked for
  from the public address, "Forgot password?" makes **no link** for an owner:
  their Telegram gets a message saying an owner is recovered at the private
  address, with that address. Asked for at the private address, an owner's
  link is made for the private address. Members' recovery works at both.
- **"Forgot password?" asked from the internet is held tight**
  (`POST /v1/local-accounts/recover`). A username: once an hour, three times
  a day. An address (an IPv6 /64): five asks an hour. All visitors together:
  thirty an hour. **A link that is still good is never replaced**: a stranger
  asking again cannot kill the link the person was just sent, nor an owner's
  two-day reset link. The answer is identical, in about the same time,
  whatever happened: sent, limited, no such account, no Telegram, an owner.
  These counts are apart from the private address's (one ask per username in
  five minutes, as before), so nothing done from the internet keeps anyone
  from recovering at the private address. What a stranger *can* do is use up
  a username's three public asks for the day (each of the first sends that
  person one real link on Telegram); see "What is NOT protected".
- **Guesses at an invitation code are counted** (`GET /v1/invites/:code`):
  ten misses from an address, then refused for the window, at both
  addresses, in the count sign-in links use (never the password form's).
  Coming back to a used or expired link is not a guess.

### New-device notices

A sign-in is "from a new device" as soon as the password is right (the second
factor comes after), so whoever holds one valid password could otherwise send
the person and the owner a Telegram message per attempt. Per recipient and
account: **one notice in ten minutes**, the next one saying how many were
left out. Per recipient: twenty a day. For everyone together: a hundred a
day. The notice in the app follows the same limits. **The security record is
never limited**: every public sign-in is there, with its address and whether
the device was new.

### The public pass

A sign-in made at the public address is given a second cookie,
`__Host-hatchabot_pub`: signed, bound to that session, carrying when it was
last used and when the second factor was last given, under which generation
of the person's factors (`second_factor_generations`: a reset, a removed
factor or a replaced authenticator app moves it on, and a second factor given
under an older one no longer counts). Without a valid one the public address
answers "sign in". So:

- a session from the private address does not carry over to the public one
  (cookies are shared between ports of one host, so the cookie itself would);
- a public session ends after the idle time, long before the session cookie;
- the second factor given by one person is never inherited by a sign-in as
  another;
- **"Sign out" at the public address ends that sign-in for every copy of its
  cookies**, not only in the browser where it was pressed. The pass is a
  signed cookie, so a copy taken from a shared computer would otherwise keep
  working (step-up included) for as long as it was kept refreshed. A signed-out
  pass is remembered in the database (`public_pass_revocations`) until no
  session cookie could still carry it, so a restart does not bring it back.
  The session cookie itself is unchanged at the private address, where plain
  "Sign out" has always only forgotten this browser's copy; "Sign out on
  every device" ends it everywhere.

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
| signed-in | Report a problem: your drafts, the diagnostics, the installed source and docs |
| signed-in | Your agents: list, create, settings, files, schedules, members, start and stop |
| signed-in | Reading lists and settings (no credential is shown) |
| signed-in | Removing a Google connection |
| step-up | Adding or replacing a second factor |
| step-up | Removing a second factor |
| step-up | Managing accounts (add, remove, reset links) |
| step-up | Changing a password, making a recovery code (your own needs your current password as well) |
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
| step-up | Backups (run, restore, delete, restore drills) and downloads of an agent |
| step-up | An agent's environment variables |
| step-up | An agent's Files tab (its home holds its config and tokens) |
| step-up | Folders of this machine given to an agent, and bringing in workspaces |
| signed-in | Apps in agents: which app an agent runs |
| step-up | Apps in agents: install, update, roll back or remove (reads this machine's folders and git login) |
| step-up | Moving an agent to another machine |
| step-up | Choosing how an interrupted move or import ends (put it back, try again, it arrived) |
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

Before sign-in (open and second-step routes) a body over 256 KB is refused
by its declared length and never read, a body with no declared length is
refused on every route, and a body that has not arrived within 15 seconds
closes the connection (the listener otherwise allows a request ten minutes,
for a signed-in upload). The public listener holds at most 512 connections
at once; more are refused at the door, so a flood there cannot take the
process's memory or file descriptors, and with them the private address. `/v1/config` leaves out the private address and the
provider's notice there.

Reads of lists that show no credential are **signed-in**, so the app's home
screen works without asking for the second factor every few minutes; every
write under a machine-level group, and every read that reveals a credential,
is **step-up**. Rights are unchanged by any of this: a member is still refused
the machine's routes by the routes themselves.

One signed-in route has a machine-level part: an agent's settings
(`PATCH /v1/agents/:id`) can name folders of this machine for it to read. That
part alone asks for the second factor again at the public address, like the
Folders routes; taking folders away, and the rest of the settings, do not.

The console's WebSocket is held to the same rules as a signed-in request (the
pass, its idle limit, the second factor), counts against the request
ceilings, and so is the session `/v1/join` reads for a web-chat invitation.
Every open socket is closed when a safeguard goes off and when public access
is turned off.

**An open console does not outlive what let it in** (`src/api/consoleSockets.ts`).
A WebSocket is checked when it opens and is then two sockets spliced together,
so every open one is remembered with the cookies it was opened with and judged
again by the same rules: after every request that changed something, and
every thirty seconds. It is closed when its session is over ("Sign out on
every device", the owner signing that person out, a password change or
reset, the account disabled or removed, the session's own end); at the public
address also when its sign-in was signed out, when nothing has been sent on
it for the idle time, when the person's second factor is reset or one is
removed, and when they no longer have the standing on that agent that opened
it (the agent changed hands, a guest's web chat was switched off). This holds
at the private address too, for the session and the standing. A socket that
cannot be judged (the database does not answer) is closed.

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

Beside "Only invited people" there is one more switch, **Let chat-only guests
in without a second factor**, off unless you turn it on ("Who needs a second
factor").

`hatchabot reach status` shows the switch, the address, every safeguard, the
guest switch, and who has no second factor yet. `hatchabot doctor` (and
`--json`) shows the safeguards too, and exits 1 when public access is on with
a safeguard off, when `HATCHABOT_PUBLIC_ACCESS` names an unknown provider,
when Funnel publishes the private port, or when a switch to "on" began and
never finished. It warns when chat-only guests are exempt, and when
`HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL` is set to something it ignores.

### A crash while switching

Turning public access on is several steps in two places that cannot change
together: Tailscale's Funnel entry, and the setting in `.env`. A process that
died between them used to leave Funnel pointing at a port nothing listens on:
harmless until the next thing opens that port, which would then be on the
internet.

- **"On" writes a note first** (`<.env>.public-access-pending`,
  `src/ops/publicIntent.ts`): before the listener, before Funnel, before the
  setting. It is removed after the last step. A step that fails, or throws,
  takes the earlier ones back and removes the note.
- **At start**, before the public listener is opened, a note that is still
  there means "on" never finished, at whichever step it died: everything "on"
  touches is taken back (Funnel's entry, read from Tailscale and removed;
  both lines of `.env`; the listener), the log says so, and it is on the
  record (`public.recovered`). Public access ends up **off**, never half on;
  turn it on again. If Tailscale will not let go of its entry, the note stays
  and the next start tries again; the log names the command.
- **With no note and public access off**, a Funnel entry that points at the
  public listener's port is a leftover (an "off" Tailscale refused, an entry
  made by hand): it is removed at start, whenever the owner looks
  (`hatchabot reach status`, the settings page), and by `hatchabot doctor`,
  which says so (`public.funnel_leftover` on the record). The doctor leaves it
  alone while a switch is under way (a note less than five minutes old), and
  never touches Funnel while public access is on. Other Funnel entries of
  yours are not touched.

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
  Funnel's own limits are Tailscale's. The public listener's connection limit
  and the 15-second limit on a sign-in form keep such a flood from reaching
  the private address; they do not keep the public one usable under it. Locking people out of the **public**
  address is cheap: someone who knows a username can keep that account
  locked there, and about a hundred failed sign-ins per fifteen minutes from
  a handful of addresses trip the ceiling that refuses every public sign-in
  for the rest of the window. Neither touches the private address or
  sessions already signed in. (The ceiling is what bounds password guessing
  spread across accounts; `HATCHABOT_PUBLIC_FAILS_CEILING` sets it.)
- **A stolen signed-in device.** A browser already signed in, within its idle
  time, is that person. The step-up limits what it can do without the second
  factor: credentials (also the agent's Files tab, whose home holds its
  tokens), hosts, images, backups, accounts. It does not protect their
  agents' settings, core files and chats, and an owner's OpenClaw console is
  a shell in that agent's container. "Sign out on every device"
  ends it.
- **Chat-only guests, if you exempt them.** With "Let chat-only guests in
  without a second factor" on, a guest's password alone opens their chats
  with your agents from the internet: what they said, what the agent
  answered, and the right to say more as them. It opens nothing else (no
  agent of their own, no console shell, no settings). Off, nobody with a
  password gets in without a second factor.
- **Google accounts without owner rights have no second factor here.**
  Google is their sign-in and their second step; this Hatchabot does not ask
  for more unless they add a factor themselves. A member whose Google session
  is open on a borrowed laptop is that member here.
- **"Forgot password?" can be used up from the internet.** Someone who knows
  a username can spend its three public asks a day. The person gets up to
  three real reset links on Telegram and is not locked out of anything: the
  private address, their recovery code and a reset link from the owner all
  still work.
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
against Tailscale itself.

### Before the trial: the owner's account, and safeguard i

**The trial starts with the owner's own account**, at the private address,
before Funnel is touched:

0. The owner signs in at the private address and adds a second factor
   (Settings → You → Second factor): an authenticator app, and if a passkey
   is wanted, one made at `https://<machine>.<tailnet>.ts.net` **with user
   verification** (a PIN or biometric: required for owner rights). Save the
   backup codes. Then check `hatchabot reach status`: safeguard b names the
   owner's factors, and the list of people with no second factor is what the
   owner expects. Every other password account will be stopped at the public
   address until it has one, so decide now who gets a reset link, and whether
   chat-only guests are to be let in without one (the default is no).

**Safeguard i refuses on this machine as it is set up.** It requires the
channel timer to follow `stable`. This machine (the Spark) follows **every
tag**: it is where each release is deployed before it is promoted. So
`hatchabot reach on` answers "The channel timer follows …, not stable" here,
by design, and nothing in the code lets a trial around it. The options, none
chosen here:

- **Run the trial on a machine that follows `stable`**: a clean install or a
  VM joined to the tailnet, with `scripts/follow-channel.sh --install stable`.
  The Spark is not changed. The branch must then be what `stable` points at
  on that machine, or be deployed there by hand with the timer left on
  `stable` (the safeguard reads the timer, not the version running).
- **Put this machine on `stable` for the trial**
  (`scripts/follow-channel.sh --install stable`) and back afterwards. It
  stops taking every tag meanwhile, and the timer may move it to the
  promoted release, away from the branch under trial, unless that is also
  arranged.
- **Move this machine to `stable` for good**, and try unpromoted tags
  somewhere else. Then it could keep public access on after the trial.
- **Add a deliberate, named exception** for a trial (a setting, off by
  default, recorded and failed by the doctor). Not built: it would be a way
  to run a public machine that does not take promoted fixes on its own,
  which is what safeguard i exists to prevent.

### The checklist

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
5. A real browser at the public address, **as the owner first**: sign-in, the
   second-factor prompt, a passkey made at the private HTTPS address used at
   `:8443` (same host, different port: the RP ID allows it, the origin list
   includes it) and that the browser really asks for the PIN or biometric,
   the page under the content security policy, the console and web chat
   through Funnel (WebSockets), HSTS's effect on the plain-HTTP tailnet
   address. Then that the owner's reset link and recovery code are refused
   there with the plain message, and work at the private address.
6. Then a member: one with no second factor is stopped and told what to do;
   a reset link from the owner lets them add one within half an hour; a real
   authenticator app scans the QR code; a real passkey (platform and
   security-key) goes through enrolment and sign-in.
7. If guests are to be exempt: the switch at the private address, a guest's
   chat with a password alone, and that nothing else works for them.
8. The new-device notice arriving on Telegram through a real bot, once, and
   not again for a second new browser inside ten minutes; "Forgot password?"
   from the public address sending one link and no second one within the
   hour.
9. Automatic-upgrade detection against a real installed channel timer (see
   "safeguard i" above for this machine).
10. Behaviour across a restart with public access on (the listener reopening,
    Funnel's entry persisting), across a Tailscale restart, and across a
    `kill -9` in the middle of `hatchabot reach on` (the next start turns it
    back off and removes Funnel's entry: "A crash while switching").
11. That a Funnel started by hand without `--bg` (`tailscale funnel 8080`)
    appears in `tailscale funnel status --json` under `Foreground`, as
    Tailscale's source (`ipn.ServeConfig`) says: safeguard d and the doctor
    read it there since the second review.
12. That tailscaled opens one connection to the public listener per request in
    flight (the 512-connection limit assumes it), and that a console's
    WebSocket through Funnel stays up while idle (Funnel's own timeouts).

## Open

Fixed from the second review's low list on 2026-10-01 (its numbers): (1)
clearing your own second factor at the private address asks for the
password; (5) misses on `GET /v1/invites/:code` are counted; (7)
`GET /v1/second-factor` shows no factor ids or last-used times before the
second factor is given; (8) the new pages put addresses in data attributes,
not in script strings; (11) passkey user verification is required for
accounts with owner rights. **The other items of that list are still open**;
they are in the review's report and are not restated here.

Known, and left as they are:

- **The limits added on 2026-10-01 live in memory.** The public
  "Forgot password?" counts and the new-device notice counts start again when
  the process restarts. "A link that is still good is never replaced" does
  not: it reads the database.
- **`known_devices` grows by a row for each sign-in from a browser without
  its device cookie.** The notices are limited; the table is not pruned
  (reads take the newest fifty).
- **The passkey challenge names the account's credential ids before the
  second factor is given** (`POST /v1/second-factor/challenge`): a
  non-discoverable passkey cannot be asked for otherwise. Someone holding
  only the password learns those ids, and nothing else about the factors.
- **An owner's passkey made before user verification was required** and
  unable to verify its user is no longer accepted at the public address. The
  owner uses their authenticator app or a backup code, and replaces the key.
- **A chat-only guest reads through the signed-in class's GET routes.** Each
  route shows only what is the caller's, which for a guest is the agents they
  chat with; the allow-list is by class and method, not route by route.
- **`hatchabot doctor` changes something**: it removes a leftover Funnel
  entry on the closed public port. Everything else it does is read-only.
- **The start-up call that takes back an unfinished switch** is one line of
  `src/index.ts`, which no unit test loads. The function it calls is tested
  at every crash point, and the line itself was checked by hand on
  2026-10-01: a throwaway instance (its own ports, data directory and `.env`,
  a stand-in for `tailscale`) started on the files a dead "on" leaves, and on
  a leftover Funnel entry, took both back and logged it.
- **The public trial has not happened**: everything under "Not verified yet".
