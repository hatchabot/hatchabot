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
same one a password or Google sign-in gives, ended the same ways) and a
`303` to `/`, so no token stays in the address bar. Every answer carries
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

## Not covered

- Minting is the portal's job; the Hatchabot cannot make links (it has no
  private key), and there is no `hatchabot` command for it.
- A link signs in; it does not change who is allowed in. Accounts are still
  made on the Hatchabot (by the provisioner, or by the owner inviting
  people).
