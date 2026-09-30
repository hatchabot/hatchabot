# What's new — 2026-09-28 (v2.89 → v2.98)

For people who use Hatchabot, not the change log (that is CHANGELOG.md).

- **Google sign-in keeps you signed in for 14 days**, not about an hour.
- **Safer by design, after the largest review yet** (eighteen reviewers, every
  area, then a pass over the fixes; docs/audit-2026-09-28-night.md): AI
  keys and setup tokens reach an agent through a private file; reset
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
- **Usage counts real tokens**, call by call from each agent's transcripts;
  it used to show the size of each conversation, not what was spent, so a
  busy agent looked cheap. The last 8 days fill in at once. Status → Usage
  also shows the last 3, 6, 9 or 12 hours.
- **Web chat guests use OpenClaw's real chat** (v2.111.0): someone you give
  web chat to sees only their own conversation, with a member's rights. The
  agent's memory is still shared, and a guest's turn can run commands in the
  agent's container, so web chat stays for people you trust.
- **Scheduled tasks on a web-only agent** (v2.110.0) post their result into
  the conversation its console opens on.
- **You are OpenClaw's command owner** on every agent (v2.109.1), never an
  invited member.
- **Scheduled tasks reach you again** (v2.109.0): since OpenClaw 2026.9 they ran
  and reached no one; they now name your chat, and old ones are repointed.
- **Web chat guests get a member's rights** (v2.109.0), not yours: they can't
  schedule tasks or change the agent's settings, just like a Telegram member.
- **Chat on the web for people you trust** (v2.108.0): invite someone to
  talk to an agent from Hatchabot's own page, no chat app needed. For now
  they have your rights on that agent, so it's for people you trust.
- **Memory is shared, said truthfully** (v2.107.0): the "private memory"
  switch never made memory private (an agent has one memory in OpenClaw), so
  it is gone, and everyone who joins an agent is told its memory is shared.
- **Every setting in .env** (v2.106.0): the file lists all of them with
  their defaults, kept in order at each start; your values never change.
- **Usage counts everything** (v2.104.0): every call (the old count missed
  those under a second) and the scheduled-task sessions OpenClaw archives.
  History resets once and refills 8 days.
- **Sign out on every device**, in the account menu; removing a person ends
  their sessions too.
- **A faster page**: compressed, and cached until an update.
- **Nightly backups about a third smaller**: caches the agent rebuilds are left out.
- **A full review, 38 fixes** (v2.103.0): rebuilds no longer re-index memory
  every time, no stray containers left on agent storage, Google accounts stop
  failing on every wake, partial backups and uncovered agents are flagged,
  duplicate snapshots skipped, sleeping agents stay asleep after a failed move,
  the page asks the server far less and stops while hidden, failing scheduled
  tasks show as failing, and several sign-in and privacy gaps are closed.
- **A Telegram warning when an agent's use jumps** to 3× its usual day, and
  each agent's Usage now shows its last 24 hours, how big its conversation
  is (every call re-sends it) and where the tokens went.
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
