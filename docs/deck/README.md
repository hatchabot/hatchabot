# Hatchabot deck

`hatchabot-deck.pdf` — 16 slides (16:9). It leads with the objection ("can't ChatGPT or
Claude already do this?"), then the idea, the side-by-side comparison, what you actually buy from a frontier lab (inference — the rest is open source), the one-subscription
household, the platform case, two agents built on it, the control panel, features, operating a fleet, principles, what Hatchabot adds
to OpenClaw, how it works, and the 15-minute start.

Comparison claims describe the CONSUMER chat apps as of September 2026 and were checked
then: both have persistent memory and unattended scheduled tasks, ChatGPT shared projects
admit collaborators on free accounts, and Claude Cowork reads and writes connected local
folders. Don't reintroduce "it forgets you tomorrow", "only you can use it" or "it does
nothing while you're away" — all three are false now. What still holds: memory you can
read, edit, back up and move; no account or seat for the people you invite; agent-to-agent
consultation; per-agent scoped access; and choosing the model per agent.

`hatchabot-deck.html` is the source; the PDF is rendered from it with WeasyPrint, which
the runtime image already contains. Headings use Bricolage Grotesque (SIL OFL 1.1,
`fonts/`), the same font as hatchabot.com.

```sh
docker run --rm -v "$PWD/docs/deck":/work -w /work hatchabot-runtime:latest \
  weasyprint hatchabot-deck.html hatchabot-deck.pdf
```

Edit the HTML, re-run, look at every page, commit both files.

`screenshot.png` (the fleet), `screenshot-usage.png` (one AI source's usage) and
`screenshot-agent.png` (one agent's settings) are rendered from the real `web/index.html`
driven by a stubbed `window.fetch` — invented household agents, no real names, tokens or
usage. Regenerate them all with `node scripts/screenshots.mjs` (needs docker); the fleet,
the data and the viewports live in `shot-data.mjs`. hatchabot.com carries the same files.
