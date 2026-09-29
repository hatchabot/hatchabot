# Review prompt: find what's broken and what's slow

The prompt used for the 2026-09-29 full review (six area reviewers, each
followed by a skeptic that tries to refute every finding). Paste it with a
focus line at the top ("focus: messaging and wake/sleep") or run it across
the whole codebase with parallel reviewers.

````markdown
# Hatchabot: find what's broken and what's slow

You are reviewing Hatchabot, a TypeScript/Fastify control plane that runs OpenClaw
agents in Docker. Dev tree ~/hatchabot, prod ~/hatchabot-prod, data
~/hatchabot-data/hatchabot.sqlite, live agents on this machine (the Spark).

Your job is NOT a style review. It is to find:
  (A) things that look like they work but don't: wrong numbers, dead paths,
      features no one can reach, promises the app makes that nothing
      enforces, and failures that are swallowed silently;
  (B) places where real time or tokens are wasted, measured on this machine.

## What has fooled us before (look for more of the same)
- Usage showed OpenClaw's `totalTokens`. It turned out to be the last call's
  context size, not cumulative use. Tests passed, because they tested the code
  against its own wrong idea.
- The "Keep memory private" switch only changed an instruction in AGENTS.md.
  OpenClaw gives an agent one memory and, by default, one conversation for
  every direct message, so "Private to each person" was never true. Every
  audit checked that the switch saved and the section was written; none asked
  whether the promise held once a second person talked to the agent.
- A container read that caught an agent while it was stopping saved a 0. The
  next reading then counted the agent's whole lifetime as new use.
- The per-agent Usage page had no tab on the agent sheet. A picker shipped
  hidden. Browser upload was dead while the API worked.
- Rebuilds took 85 s because each `openclaw` command on 2026.9 costs 4–8 s and
  the seed ran ~10 of them every time (now 37 s).
- OpenClaw only logs model calls slower than 1 s, so request counts from the
  log were 10–28% low; deleted cron sessions move to an archive table hours
  later and vanished from usage.
- Behaviour differs between OpenClaw 2026.7 and 2026.9.
- Fixes made quickly caused their own regressions. Review recent changes too.

## Method
1. **Check every displayed number against reality.** Trace it to its source,
   say what the source actually measures (read upstream code or data), recompute
   it independently on the live system and compare.
2. **Check every promise against what enforces it.** For each thing the app,
   the invite pages, the docs or the website TELLS people — "private", "only
   people you invite", "removed people can't…", "asleep: a message wakes it",
   "this source is used only by…", "everyone is told…" — find the mechanism
   that makes it true at runtime, in Hatchabot AND in OpenClaw. An instruction
   to the model is not a mechanism. Then test it the way a second person
   would experience it (a separate session, a member's message, a stranger).
   A promise with no enforcing mechanism is a finding, however well the
   setting saves.
3. **Walk every user path** in the real page, not just the API: reachable from
   the home screen? buttons do what they say? stopped, asleep, archived, on
   another host, shared, on 2026.7?
4. **Time the real operations** from existing evidence (logs, traces). Say
   where the seconds go and what a fix would save, measured.
5. **Follow the tokens.** Scheduled tasks, heartbeats, retries, unbounded
   conversations, injected notes, polling. Transcripts are ground truth.
6. **Hunt silent failures.** `catch {}`, `.catch(() => …)`, `|| true`, ignored
   results, timeouts returning empty values stored as real data.
7. **Check the recent changes** (last ~15 releases) for regressions and for
   assumptions that fail on Mac, rootless Docker or a remote runner.

## Evidence bar
- Every finding needs proof: a command and its output, a DB query, a measured
  timing, or a failing test. "Might be" findings go in a short separate list.
- For each: the problem in one sentence, `file:line`, the proof, who it hurts
  and how often, the fix, how to check the fix.
- Rank: wrong data, broken promises or security first, then broken features,
  then waste, then the rest.

## Rules
- Read-only until fixes are approved. No restarts, rebuilds or messages from
  live agents; copy the DB for experiments. Test agents you create yourself
  are fine; delete them afterwards.
- Don't upgrade OpenClaw. Never print secrets. Made-up ids, example.com.
- Tests that run real scripts use a confined PATH, a temp HOME and
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null`.
- Release gates stay chained with `&&` and `set -o pipefail`. No sudo.

## Output
1. A ranked findings table. 2. Details per finding. 3. A "measured waste"
table. 4. A "verified OK" list. 5. A proposed order of fixes, by release.
````
