# Security policy

Hatchabot runs AI agents with real credentials (Telegram bot tokens, AI
subscriptions, Google accounts) on hardware you own, and lets several people
talk to them. Security reports are welcome and taken seriously.

## Reporting a vulnerability

- **Do not open a public issue** for anything exploitable.
- Email **security@hatchabot.com**, or use GitHub's
  **Report a vulnerability** (Security → Advisories) on this repository.
- Include: what you found, how to reproduce it, and what an attacker gains.
  A proof of concept against your *own* installation is ideal.

You'll get an acknowledgement within a few days. Fixes ship as a normal tagged
release; the CHANGELOG credits reporters who want credit.

## Scope that matters most

- Cross-owner access on a shared installation (one household account reaching
  another's agents, credentials or memory).
- Anything that lets a chat participant (a Telegram member of an agent) escalate
  to the operator's machine, other agents, or connected accounts.
- Secret handling: bot tokens, setup tokens, API keys, Google refresh tokens.
- The agent-to-agent path (`/v1/agents/:id/message`) and its token scoping.

## What is deliberately out of scope

- Prompt injection *within* an agent's own sandbox (the agent doing something
  unwise with the data it was explicitly given). Each agent runs in its own
  container with its own credentials precisely so that this stays contained.
- Denial of service against your own installation.

See `docs/family-member-risk-assessment.md` for the threat model this project
is designed against, and `the CHANGELOG (audit findings ship as fixes with a note)` for the review history.
