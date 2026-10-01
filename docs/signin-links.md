# One-time sign-in links

A provider that runs Hatchabot for someone (Hatchabot Cloud, or anyone using
managed mode) can give its customers an **Open my Hatchabot** button: its
account page mints a short-lived link, and the customer's Hatchabot accepts
it once and signs them in. Nobody types a password to get from the
provider's page to their Hatchabot.

The feature is off unless `HATCHABOT_SIGNIN_KEY_FILE` is set. With it unset
there is no route at all (`/signin/link` is a 404).

## Setting it up

1. Make a key pair, once per Hatchabot (per tenant), where links are minted:

   ```
   node scripts/signin-link.mjs keygen /secure/place/maria
   # maria.key — the PRIVATE key: stays with the portal/provisioner, never on the Hatchabot
   # maria.pub — the public key: goes to the Hatchabot
   ```

2. Put the public key on the Hatchabot, owned by the user Hatchabot runs as,
   mode 600 (a key file anyone else may write is refused: whoever can replace
   the key can sign in as anyone), and point the setting at it. The
   Hatchabot's public address must be set too, because a link names the
   address it is for:

   ```
   HATCHABOT_SIGNIN_KEY_FILE=/home/t-maria/.config/hatchabot/signin.pub
   HATCHABOT_PUBLIC_URL=https://maria.my.hatchabot.com
   ```

   Restart once to turn the feature on. After that a replaced key file is
   picked up without a restart (the file is re-read when it changes), which
   is how a key is rotated: write the new `.pub`, then start minting with the
   new `.key`.

3. Mint a link when the customer presses the button, and send their browser
   straight to it:

   ```
   node scripts/signin-link.mjs sign --key maria.key --url https://maria.my.hatchabot.com --owner
   node scripts/signin-link.mjs sign --key maria.key --url https://maria.my.hatchabot.com --account sam@example.com --ttl 120
   ```

   Or in-process from Node: `import { signinLink } from './signin-link.mjs'`
   and `signinLink({ privateKey, url, owner: true })`.

## Why Ed25519, not a shared HMAC key

With HMAC the Hatchabot would hold the same secret the portal signs with, so
anything that can read the tenant's files — a backup, a support bundle, an
operator's shell, a neighbour on a shared host who got into the tenant's
home — could mint a link and sign in as the owner. With Ed25519 the
Hatchabot holds only the public key: it can check a link but never make one.
The private key lives in one place, the portal's secret store, one per
tenant, so a leaked key opens one Hatchabot. Ed25519 is in Node's standard
library (`crypto.sign(null, …)`), as it is in Go, Python (`cryptography`),
Rust and every other language a portal is likely to be written in.

## The token

```
https://<host>/signin/link?t=<token>
token  = base64url(claims JSON) "." base64url(signature)
signed = the ASCII bytes of "hatchabot-signin-link/v1\n" + base64url(claims JSON)
```

base64url is RFC 4648 §5 without padding. The signature is Ed25519 (64
bytes) over the context string followed by the first part exactly as it
appears in the token — the JSON is never re-serialized, so key order and
spacing do not matter. The context string keeps a signature made for this
purpose from being valid for anything else the key might ever sign.

Claims (all required; unknown extra fields are ignored):

| claim   | value |
|---------|-------|
| `v`     | `1` |
| `aud`   | The Hatchabot's address. Compared as an origin with `HATCHABOT_PUBLIC_URL` (scheme, host, port; case and a default port do not matter; any path is ignored), so a link minted for one tenant is refused by every other. |
| `sub`   | `"owner"` — the person who owns this Hatchabot — or `"user:<name>"`: an account by its username (accounts mode; the provisioner makes the owner with their email as username) or, in identity (Google) mode, by the verified email its last Google sign-in recorded. |
| `iat`   | Issued at, Unix seconds. |
| `exp`   | Expires at, Unix seconds. `exp − iat` must be 1–600 (ten minutes at most). |
| `nonce` | 16–128 characters of base64url; at least 16 random bytes (the signer uses 18). |

Example claims:

```json
{"v":1,"aud":"https://maria.my.hatchabot.com","sub":"owner","iat":1790000000,"exp":1790000300,"nonce":"q3J0Yk1xV2c4Zk5wT0VhUzJ4"}
```

The Hatchabot accepts a link when, in this order: it is at most 2048
characters of the right shape; the signature verifies; the claims are well
formed; `aud` is this Hatchabot; `exp − iat ≤ 600`; `iat` is no more than 60
seconds in the future and `exp` no more than 60 seconds in the past (clock
difference allowed each way); and its nonce has never been spent here. The
nonce is spent (one SQLite INSERT, so the same link opened twice at once
signs in once) before the account is looked up.

## What a link does

| Sign-in mode | `"owner"` | `"user:<name>"` |
|---|---|---|
| accounts | the host-owner account | the account with that username (case-insensitive) |
| identity (Google) | the Google account that owns this machine | the Google account whose recorded email that is; if there is none and `HATCHABOT_LOCAL_ACCOUNTS=1`, a local account by username |
| password | the one shared-password session | refused: there are no named accounts |

On success the browser gets the normal session cookie for that account (the
same one a password or Google sign-in gives, ended the same ways;
`__Host-hatchabot_session` over HTTPS, see below) and a `303` to `/`, so no
token stays in the address bar. The cookie is `SameSite=Strict`. When the
provider's page is on another site (a home install, or once
`my.hatchabot.com` is on the Public Suffix List) the browser stores it but
does not send it with that first `GET /`; the page is the app's shell, which
needs no session, and every request the app then makes is same-origin and
carries it (checked in Chrome 124 and 151, 2026-10-01). When the provider's
page is the same site (portal on `hatchabot.com`, tenant on
`<name>.my.hatchabot.com`) the cookie rides the first `GET /` too. Every answer carries
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Only `GET`
spends a link: `HEAD` is not answered, so a link checker's or chat app's
preview request does not use it up (a preview that does a full `GET` will,
which is why links are minted when the button is pressed, never emailed).

A link is refused, with no session and a plain page, when it is expired,
for another Hatchabot, tampered with, malformed or already used: *"This
sign-in link has expired or was already used"*, with where to get a new one
(`HATCHABOT_MANAGED_BY`'s account page and the `HATCHABOT_SUPPORT_URL` help
link when set). An account that is missing, disabled, or — in identity mode
— no longer on `HATCHABOT_ALLOWED_EMAILS` gets *"This sign-in link is for an
account that isn't here"* (403). A key file that cannot be used (missing,
writable by others, a private key, not Ed25519) or a missing
`HATCHABOT_PUBLIC_URL` gives a 503 and a line in the log; nobody is signed in.

Failed links count against the same per-client throttle as wrong passwords
(`HATCHABOT_LOGIN_FAILS_PER_WINDOW` per `HATCHABOT_LOGIN_WINDOW_MS`); a
throttled client gets a 429 page even with a good link, and the link is not
spent.

## The first visit to a new Hatchabot (claiming it)

The provisioner makes the owner with `hatchabot accounts create <email>
--host-owner --cli-token`: an account with no password and a claim link,
good for 48 hours, which `hc` prints. With sign-in links, the customer never
needs that printed link:

1. The welcome email links to the **provider's account page**, not to the
   Hatchabot (a ten-minute link cannot wait in an inbox).
2. *Open my Hatchabot* mints an `"owner"` link.
3. The Hatchabot sees an account that has never chosen a password, so the
   link **claims** it instead of signing in: the pending claim code (the
   printed one) is replaced by a fresh one good for 15 minutes, and the
   browser is sent to `/?claim=<code>` — the existing "This Hatchabot is
   yours. Choose a password and you're in" screen. No session is set until
   they choose one.
4. Choosing the password signs them in and, as for every new owner, shows
   their recovery code once.

So the printed claim link stops working the moment a signed link is used,
and the owner leaves with a password and a recovery code that work without
the provider — a hosted Hatchabot can be taken home. If they close the tab
before choosing, the next link opens the chooser again. The same holds for
any account without a password yet (a member invited but not yet joined).
After that, every link signs straight in.

## A record of each sign-in

Each use goes to the log: `account.signed_in_by_link` (or
`account.claim_by_link`) with the account id and the link's `sub`;
refusals as `signin_link.refused` with the reason (`signature`, `audience`,
`expired`, `replayed`, `no-account`, …). Neither the token nor any key is
ever logged: the request log drops query strings, and the code logs only
the reason. Spent nonces are kept in the `signin_links` table with the
`sub` and the time for 30 days.

## Neighbours on the same site

Every tenant is `<name>.my.hatchabot.com`, and until that suffix is on the
Public Suffix List (which wants thousands of users first) every tenant, and
the portal, are the **same site**. `SameSite=Strict` then protects nothing
between them: a neighbour's page can make the browser send this tenant's
cookie with a form post, a `fetch` or a WebSocket, and it can set cookies on
`.my.hatchabot.com` or `.hatchabot.com` that the browser sends here. Before
2026-10-01 a neighbour's page could, in a real browser, mint a CLI token,
sign the owner out everywhere, open an agent's console socket, sign a
visitor in as an account of the neighbour's choosing by planting its
cookie, and sign the owner out by planting a junk one with a longer path.
These close that, on every install and in every sign-in mode:

- **Requests from elsewhere change nothing** (`src/api/requestOrigin.ts`).
  Every `POST`, `PUT`, `PATCH` and `DELETE`, and every WebSocket upgrade to
  the console, is refused (403; the socket is dropped) when the browser says
  `Sec-Fetch-Site: same-site` or `cross-site`. A browser too old to send
  that header is held to its `Origin`, which must be this machine: the host
  it addressed (`Host`, or a proxy's `X-Forwarded-Host`) or
  `HATCHABOT_PUBLIC_URL`'s; `Origin: null` is refused. A request with
  neither header is not from a browser (the CLI, a runner, another
  Hatchabot, an agent) and passes on its own credentials. Nothing is exempt:
  everything that legitimately arrives from another site is a `GET` (this
  link, Google's OAuth callback), and no chat service posts to Hatchabot
  (Telegram is polled, Slack is Socket Mode, Discord is its gateway).
- **Reads from elsewhere are refused too**, because not every `GET` only
  reads: a Download (`/v1/agents/:id/backup`) stops the agent, a `GET`
  through the console proxy wakes a sleeping agent and reaches its gateway as
  the owner, a junk sign-in link counts as a failed sign-in, and many reads
  run commands in every agent or call Telegram per bot. A `GET` or `HEAD` the
  browser marks `Sec-Fetch-Site: same-site` or `cross-site` is refused (403)
  on every path except the pages people are sent to by links, and only as a
  page visit (`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`): `/`
  (a reset link's `/?claim=…` too), `/join/<code>`, this link,
  Google's callback, `/privacy` and `/terms`; and static public files
  (`/healthz`, the PWA shell). Every other method is judged like a write.
  Reads have no `Origin`, so a browser too old for Fetch Metadata is not
  covered for them.
- **Sign-in links have their own failure count.** A junk link needs no cookie
  to send; when it counted against the password form's per-address limit,
  ten of them locked the owner out of signing in. Now links and passwords
  are counted apart.
- **Google's consent is bound with a `__Host-hb_oauth` cookie over HTTPS.**
  The plain-named one could be planted from the parent domain, so someone
  with an account here and a page on the same site could walk another person
  through Google's consent into their own vault.
- **The console proxy relays no CORS headers.** OpenClaw has handlers that
  echo any `Origin` back as allowed; relayed, a page elsewhere could have
  read the console's answers. Hatchabot itself allows no other origin.
- **The session cookie is `__Host-hatchabot_session` over HTTPS**
  (`src/api/sessionCookie.ts`). The browser accepts a `__Host-` cookie only
  from this exact host, `Secure`, `Path=/`, with no `Domain`, so a neighbour
  cannot plant one; when a request carries it, it is the only session cookie
  read. Over plain HTTP (a home LAN) the prefix is impossible and the name
  stays `hatchabot_session`. On a hosted install (`HATCHABOT_MANAGED_BY`) a
  plain-named cookie over HTTPS is ignored, because it is exactly what a
  neighbour can plant. On a home install over HTTPS (Tailscale, a TLS
  proxy) a session from before the change keeps working and is moved to the
  new name on its next request, so nobody is signed out by the upgrade.
  HTTPS means `X-Forwarded-Proto: https`, a TLS connection, or a request for
  the https `HATCHABOT_PUBLIC_URL`'s own host.

## Not covered

- Minting is the portal's job; the Hatchabot cannot make links (it has no
  private key), and there is no `hatchabot` command for it.
- A link signs in; it does not change who is allowed in. Accounts are still
  made on the Hatchabot (by the provisioner, or by the owner inviting
  people).
