# Audit, 2026-09-19 (the 20th) — the doorman

A focused pass over **v1.32.0 → v1.33.0**: the redacted failure messages, the
setup pre-flight, and the doorman that lets the management agent run on any
host. It was prompted by that change shipping the same day it was designed.

Method: read the whole diff; then test the claims against **real Docker** with
the real provider code, rather than only in a mock.

## Critical (shipped in v1.33.0, fixed here)

**1. On Linux the door could land where no doorman could reach it.**
- **Where:** `src/index.ts` (start-up) vs `src/orchestrator/provision.ts`.
- **What:** the door binds the address Docker's host alias points at — the
  bridge gateway on Linux, loopback on Docker Desktop. Provisioning passed
  those candidates; **start-up did not**, so a control plane that came up with
  an existing management agent bound loopback. On Linux the doorman then had
  nowhere to send the agent's tool calls.
- **Seen live:** this machine deployed v1.33.0 and its door came up on
  `127.0.0.1:8091` instead of `172.17.0.1:8091`.
- **Why it hadn't bitten yet:** on Docker Desktop loopback is the right answer,
  which is why the laptop worked. On this machine the management agent had not
  been rebuilt onto the doorman yet.
- **Fixed:** start-up passes the same candidates. The doorman now always
  forwards to the host alias, so there is one rule instead of two.

## Medium

**2. The door accepted connections from anything on the machine.**
- **Where:** `src/ops/opsServer.ts`.
- **What:** the design says the door is "accepted only from the ops agent's
  container address". That was never enforced — the bind address was the only
  gate, and **any container can reach any address on the host**. Proved both
  ways live: a plain container on the default bridge reached a listener on the
  old jail gateway (`172.19.0.1`, the pre-1.33 door) and on the bridge gateway
  (the 1.33 door). Only the 32-byte key stood in front of the tool door and
  the AI proxy.
- **Not a regression** — the same was true before the doorman; it is simply
  now fixable, because every legitimate connection arrives from one known
  container.
- **Fixed:** the door refuses any peer that is not a current doorman, on both
  the tool door and the CONNECT proxy, **before** the key is looked at.
  Addresses are re-read when a doorman is replaced. Verified live: the agent
  gets `200`, an ordinary container on the bridge gets `403`.

**3. The tests fought with the running Hatchabot for port 8091.**
- **What:** the ops port is fixed, so `npm test` on a machine running
  Hatchabot failed in `POST /v1/ops-agent` — the pre-flight could not bind. It
  looked like a code failure; it was a port clash. (This is how finding 1 was
  noticed.)
- **Fixed:** `HATCHABOT_OPS_PORT=0` means "any free port", and the test config
  sets it. A second install on one machine gets the same escape hatch.

## Checked and sound

- **The jail still holds.** From the agent: no internet, no route to this
  machine, no way to the door except through its doorman. Re-verified after
  the changes.
- **The doorman is a forwarder and nothing else:** two fixed routes, a socket
  cap, no state, no `child_process` or `fs`, and the agent cannot exec into it.
  It runs the runtime image already on the machine.
- **Teardown** removes the doorman and the network with the agent.
- **Redaction** of failure text masks URL credentials, Telegram/Slack/API
  tokens, and anything else long enough to be a key, before it reaches a card
  or the timeline.
- **The pre-flight** creates nothing when the door cannot open.
- 1,199 tests pass, `npm audit` is clean, and no new dependency was added.

## Still open

- The management agent has never held a real conversation. The laptop's setup
  now completes; that is the next thing to try.
- 42 of 45 agents on this machine are still on the pre-1.16 shared network
  (**Rebuild all**), unchanged from the 19th audit.
- Ollama still listens on every interface with no authentication, and
  something unidentified still listens on `0.0.0.0:4000`.
