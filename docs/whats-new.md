# What's new — 2026-09-27 (v2.60 → v2.88)

For people who use Hatchabot, not the change log (that is CHANGELOG.md).

- **Agents sleep when idle** (`HATCHABOT_HIBERNATE_AFTER`, e.g. `36h`): a
  quiet Telegram or web agent is stopped with its memory kept, and a message,
  its console, an ask or a consult from another agent wakes it in about a
  minute. The Status pill says "Asleep"; **Wake** and **Sleep** are on the
  agent's sheet and under Bulk actions. Discord/Slack agents, agents with
  scheduled tasks, the manager, and agents set to stay awake never sleep.
- **One memory search service per machine**, with keys per agent and guest
  keys for a neighbour; a deploy no longer pauses it.
- **Rootless Docker** for shared machines (one Linux user per tenant), and a
  managed mode (`HATCHABOT_MANAGED_BY`) for a Hatchabot someone runs for you.
- **The home screen**: no dashboard box. Your Hatchabot agent is the first
  tile of Default; Status, Bulk actions, Settings and New are symbols in the
  header. Drag an icon to another group (the page scrolls with you; a strip
  at the bottom makes a new group), move groups with the arrows, hit the
  bolt on a group for its bulk actions.
- **One name each**: what wants you is **Needs you**; taking a bot or app off
  an agent is **Detach**; sending an agent to another Hatchabot server is
  **Move to another Hatchabot**.
- **The CLI asks y/N before it destroys** (`--yes` skips); an AI-source
  switch applies at the next rebuild everywhere, `--now` rebuilds at once.
- **Sharing** lists a person once, whichever agents they came from.
- **Quieter, safer**: the 30th audit fixed twelve majors (see
  docs/audit-2026-09-27.md), and the app has click-through tests of its own
  screen now (`npm run test:ui`).
