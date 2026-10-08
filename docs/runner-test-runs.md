# Runner test runs

Live runs of `scripts/runner-scenarios.mjs`: real moves and rebuilds between
the main machine and a runner, on a real install. How to run it is in
[runner-setup.md](runner-setup.md); `AGENTS.md` says when.

Each scenario passes only if the agent runs, on the OpenClaw it should, and
still finds a note written before the step by meaning: the query shares no
words with the note, so only working embeddings find it.

The scenarios:

| | What happens | Passes when |
|---|---|---|
| A0 | Two agents on the runner's pre-2026.8 image, one on the main machine | each finds its note |
| A1 | A current agent is moved onto the runner's old image | refused (409), agent untouched |
| A2 | An old agent moves from the runner to the main machine | migrated to the current OpenClaw, on the main machine's memory search, note found |
| I | The runner gets the main machine's image (Install image) | runner on the same OpenClaw |
| B1 | An old agent is rebuilt in place on the runner | current OpenClaw, on the runner's own memory search, note found; only the runner's service holds its key |
| B2 | A current agent moves to the runner | on the runner's service, re-indexed, note found; the main machine's service forgot its key |
| B3 | And back | note found; the runner's service forgot its key |
| B4 | A plain rebuild on the runner | no re-index, note still found |

Add a run at the top: the date, the versions, the runner's kind and link,
the results, and what the run found. No machine or agent names.

## 2026-10-08

- **Hatchabot:** v2.147.1. **OpenClaw:** 2026.9.8 on both machines after
  step I; the runner's old image was 2026.7.1-2.
- **Main machine:** Linux, root Docker. **Runner:** a Mac with Docker
  Desktop (8 CPUs, 8 GB for Docker), over Tailscale relayed through DERP
  (about 430 ms, no direct connection).
- **Result:** all seven scenarios passed (A0–A2, B1–B4) in the final run,
  with `--old-image`. Step I ran in an earlier run the same morning: the
  2.2 GB copy took about 15 minutes over the relayed link.
- **What the runs found:**
  - The image copy was one web request with a fixed 15-minute limit, sent
    uncompressed. It finished just inside the limit, and a browser could
    give up first. Fixed in v2.147.1 (background, gzip, progress, stopped
    only on a stall).
  - The runner had lost its `hatchabot-runtime:latest` tag, likely to a
    test install and uninstall of Hatchabot on the runner's Docker; its
    agent's next rebuild would have failed. The tag was put back. Open: the
    installer could warn when the machine is already a runner.
  - The memory search engine on the runner reached its 2 GB limit after
    indexing; the health loop restarted it about a minute later
    (2 GB → 400 MB), as designed.
  - A first attempt failed while the runner was waking from sleep (its
    Docker did not answer within the 8-second check).
- **Not covered yet:** a runner going to sleep during a move; a Linux
  runner; a runner with a direct Tailscale connection; a rootless runner.
