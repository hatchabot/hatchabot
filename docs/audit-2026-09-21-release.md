# Audit — 2026-09-21, release check (25th audit)

Asked for: an antagonistic pass over the whole codebase to confirm v2.31.0 is
a good release. The stance was an attacker's — on the LAN, on the tailnet,
holding an invite link, or a member of someone else's agent — plus a
release-engineering pass over what a stranger's install actually runs.

**Verdict: a good release.** No critical or major findings. Two low security
findings and one process finding, all fixed in v2.31.1.

## Gates

| Gate | Result |
|---|---|
| `npm test` | 1229 pass (1232 with this audit's tests) |
| `npx tsc --noEmit`, `npm run check:web` | clean |
| `npm run e2e` | pass |
| `./scripts/upgrade-check.sh` | no drift from v1.0.0, v2.0.0, v2.30.3 |
| `schema-drift.ts` on the live database | no drift |
| `npm audit --omit=dev` | 0 vulnerabilities |

## What was attacked, and held

- **Sign-in bypass.** All three sign-in modes exempt a fixed list of paths; every
  route under an exempt prefix was read — each authenticates in its handler
  (invite code, claim code, single-use OAuth state, an agent's call token) or
  serves nothing private. The internal header needs a per-process random
  secret *and* a loopback peer; `trustProxy` is off, so a forged
  `X-Forwarded-For` cannot fake loopback.
- **Every route (203 in routes.ts, plus accounts, management chat, ops).** A
  script listed each route's guard. Those with none serve static or public
  data (`/v1/config`, connector field lists, the Slack manifest template).
  Machine-level routes use `ownsLocalHost`; agent routes `ownedAgent` /
  `visibleAgent` / `runningAgent`. Management-chat proposals are scoped to
  their owner and to the chat that proposed them.
- **Shell injection.** Every `sh -c` / `bash -c` into a container was traced:
  slugs are `[a-z0-9-]`, pairing codes are checked alphanumeric before use,
  file content goes through base64, paths through `JSON.stringify`, emails are
  shape-checked before both materialize and dematerialize.
- **Path traversal.** File reads and writes are allowlisted by name
  (`EDITABLE_FILES`, `INSPECTABLE_FILES`); archive imports extract in a
  throwaway container with `--no-same-owner` and setuid bits stripped.
- **XSS.** Every interpolation into HTML in `web/index.html` that could carry a
  user-typed value was traced: all go through `esc()`, or `jsq()` (JS-escape
  then HTML-escape, correct for `onclick="…'…'"`). Agent transcripts render
  escaped.
- **Guessing.** Invite codes: 10 characters from a 32-letter alphabet, expiring.
  Reset/claim codes: 128 bits. Proposal ids: 48 bits and owner-scoped.
- **Live install.** Signed out, every data endpoint answers 401; a bogus
  invite code answers `unknown`. Agent gateways listen on 127.0.0.1 only.
  **43 of 45 running agents are in `allowlist`**; the other two have no
  Telegram. Nightly backups ran at 03:32 today and include the database and
  secret key.

## Findings (fixed in v2.31.1)

1. **Low — first account over the tailnet without the setup code.** Creating
   account #1 skips the setup code from "the machine itself", judged by a
   127.0.0.1 peer. `tailscale serve` connects from 127.0.0.1 for every device
   on the tailnet, so on a fresh accounts-mode install already served over
   Tailscale, any tailnet device could create the owner account. Now a
   loopback request carrying forwarding headers is remote. Only mattered
   before account #1 existed.
2. **Low — setup code guesses were unlimited.** 32 bits, open only until
   account #1 exists; now throttled like passwords.
3. **Low — no browser hardening headers.** No framing rule outside the console
   proxy (SameSite=Strict already signed a framed copy out), no `nosniff`, no
   referrer policy (a `/join/<code>` page following an outside link would send
   its code as a Referer). All three now on every response.
4. **Process — the installer script skipped the channels.** hatchabot.com
   fetched `install.sh` from `main`, so any edit to it reached every new user
   at once. It now fetches it from the release `stable` names.

## Still open (unchanged, low)

- `recover` is not exempted in identity mode's sign-in hook (fails closed).
- The login throttle is keyed by peer address; behind `tailscale serve` every
  tailnet device shares 127.0.0.1, so someone guessing passwords over the
  tailnet also slows the owner's own sign-ins there for 15 minutes.
- Ollama on `*:11434` and the unidentified `:4000` listener on this machine.

The three beta blockers in `audit-2026-09-21.md` are unchanged: a clean install
of the final tag on Mac and Linux, a week's freeze, and the owner recovery code.
