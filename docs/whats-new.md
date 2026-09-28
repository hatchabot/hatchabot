# What's new — 2026-09-28 (v2.89 → v2.98)

For people who use Hatchabot, not the change log (that is CHANGELOG.md).

- **Google sign-in keeps you signed in for 14 days**, not about an hour.
- **Safer by design, after the largest review yet** (eighteen reviewers, every
  area, then a pass over the fixes; docs/audit-2026-09-28-night.md): an
  agent's keys reach it through a private file, never a command line; reset
  links go only through bots your own side holds; Google connections come back
  only to the browser that asked; removing someone takes them out of every
  Slack channel and Discord server too; templates carry no one's private
  notes; derived-image lines are judged the way Docker reads them.
- **Change bot** always gives an agent a different bot, and the old one is
  handed on only once the agent has let go of it. Discord and Slack lists of
  servers and channels follow every page, and a failed listing keeps the old
  one instead of closing the rooms.
- **Moves and copies**: a Download says which OpenClaw wrote it, and a machine
  too old to read it refuses; the Hatchabot agent stays on its machine;
  clones bring their environment variables; a sleeping agent that was
  downloaded stays down.
- **Usage figures** no longer count an agent's whole history as new use after
  a failed read, or when it comes back from a long stop.
- **Machine defaults** (⚙ Settings → Hosts): sleep after, memory per agent,
  the memory service's memory, and the file sizes each chat app may carry.
- **Slack** set-up in four steps, with the same controls as Telegram and
  Discord; files send on every app.

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
