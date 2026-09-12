# Contributing

Thanks for looking. Hatchabot is young and opinionated; the fastest way to a
merged change is to match the conventions already in the code.

## Getting set up

```sh
npm install
npm test          # unit tests + a syntax check of the single-file web app
npm run typecheck
```

You don't need Docker to run the tests — `MockProvider` stands in for the real
runtime. You do need it to run the product (`./scripts/setup-host.sh`).

## What to know before changing things

- **Four interfaces are load-bearing**: `RuntimeProvider`, `ChannelProvisioner`,
  `SecretStore`, and the auth-mode seam. They exist so new hosts, messengers,
  secret backends, and identity providers slot in without touching the
  orchestrator. If a change makes provider-specific details leak upward,
  that's the thing to reconsider.
- **Comments explain *why*.** The codebase leans on comments that record a
  decision or a hazard ("OpenClaw refuses a set that would drop entries", "one
  poller per bot token"). Restating what the code does is noise; recording what
  bit us is not.
- **Never overwrite an agent's memory.** The seed script's idempotency guards
  and the snapshot system both exist because `MEMORY.md` is irreplaceable.
  Anything touching workspace files needs to be sure it can't clobber them.
- **Secrets go through `SecretStore`**, are resolved as late as possible, and
  never land in argv, logs, or an API response. `describeConfigCommands`
  redacts; keep it that way.

## Pull requests

- Include a test. `test/roles.test.ts` and `test/transfer.test.ts` are the
  reference patterns: in-memory SQLite `Store`, `MockProvider`, and real
  Fastify `app.inject` for route behaviour.
- Run `npm test` and `npm run typecheck`; CI runs both.
- Describe the *why* in the commit message. The git log is used as a design
  record here.

## Security

Found something exploitable? Please open a private security advisory on GitHub
rather than a public issue. The project holds live bot tokens and AI
credentials, so a quiet fix first is appreciated.
