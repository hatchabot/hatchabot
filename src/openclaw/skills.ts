/**
 * Skills seeded into every agent workspace. A skill is just files the agent
 * reads (SKILL.md), so they ride the existing seed/adopt/rebuild plumbing —
 * the seed script never overwrites, so an agent that edits its skills keeps
 * its edits.
 *
 * gog: the "connections" tool (docs/connections-design.md). The binary ships
 * in the runtime image; credentials live on the AGENT'S VOLUME (GOG_HOME is
 * set there by provision), so they refresh in place and travel with Move,
 * backup, and export — and Share templates never include them.
 */
export const GOG_SKILL_MD = `---
name: gog
description: Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.
homepage: https://gogcli.sh
metadata: {"clawdbot":{"emoji":"🎮","requires":{"bins":["gog"]}}}
---

# gog — Google connections

Use \`gog\` for Gmail/Calendar/Drive/Contacts/Sheets/Docs. Your credentials
live in \$GOG_HOME on your own volume — they survive rebuilds and move with
you between machines. Until an account is connected, Google commands fail:
offer the owner the connect flow below instead of guessing.

## Connecting an account (chat-based, no browser on this machine)

Only do this when the OWNER asks. Recommend a purpose-bound Google account
(one scoped to this agent's job), never someone's personal account: everyone
who can message this agent can act as the connected account.

1. \`gog auth keyring file\` (once — no desktop keyring in a container)
2. The owner supplies an OAuth client JSON (Google Cloud Console → OAuth
   client ID, Desktop type). Save what they send to a file, then:
   \`gog auth credentials /path/to/client_secret.json\`
3. \`gog auth add THEIR_ACCOUNT --services gmail --remote --step 1\`
   — request ONLY the services the job needs; add more later if asked.
   Send the owner the printed URL; they approve on their phone and paste
   back the redirect URL/code.
4. \`gog auth add THEIR_ACCOUNT --services gmail --remote --step 2 --auth-url 'PASTED'\`
5. Verify with \`gog auth list\`, then suggest \`gog auth add ... --gmail-no-send\`
   was considered: if the job is read-only, re-add with send blocked.

## Common commands

- Gmail search: \`gog gmail search 'newer_than:7d' --max 10\`
- Gmail send: \`gog gmail send --to someone@example.com --subject "Hi" --body "Hello"\`
- Calendar: \`gog calendar events <calendarId> --from <iso> --to <iso>\`
- Drive search: \`gog drive search "query" --max 10\`
- Sheets get: \`gog sheets get <sheetId> "Tab!A1:D10" --json\`
- Docs export: \`gog docs export <docId> --format txt --out /tmp/doc.txt\`

## Rules

- Set \`GOG_ACCOUNT=you@example.com\` to avoid repeating \`--account\`.
- For scripting, prefer \`--json\` plus \`--no-input\`.
- ALWAYS confirm with the person before sending mail, creating events, or
  modifying documents — reading is routine, acting is not.
- Never print tokens, client secrets, or the contents of \$GOG_HOME.
`;
