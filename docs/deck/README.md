# Hatchabot deck

`hatchabot-deck.pdf` — 20 slides (16:9). It leads with the objection ("can't ChatGPT or
Claude already do this?"), then the idea, the side-by-side comparison, what you actually buy from a frontier lab (inference — the rest is open source), the one-subscription
household, the platform case, two agents built on it, the control panel, the Hatchabot supervisor (the right model per agent, loops, conversation size), the cost story (an email
meeting-and-voting agent rewritten as a program inside an agent: about $1,700 a month at API prices, plus $990 for its QA agent, down to cents), what is new since v2.112, features, operating a fleet, who gets in, ownership (every part of an agent is yours, and it fits in a file), principles, what Hatchabot adds
to OpenClaw, how it works, and the 15-minute start.

Comparison claims describe the CONSUMER chat apps as of September 2026 and were checked
then: both have persistent memory and unattended scheduled tasks, ChatGPT shared projects
admit collaborators on free accounts, and Claude Cowork reads and writes connected local
folders. Don't reintroduce "it forgets you tomorrow", "only you can use it" or "it does
nothing while you're away" — all three are false now. What still holds: memory you can
read, edit, back up and move; no account or seat for the people you invite; agent-to-agent
consultation; per-agent scoped access; choosing the model per agent; and a supervisor
that keeps each agent on the right model with the savings shown. Checked October 2026:
ChatGPT's Auto routes each message to a model inside OpenAI's app; Claude's apps have
you pick. Say "per agent, under your control, with the savings shown", never "they
don't have it". Supervisor features not yet shipped are labelled "coming next".

Checked 2026-10-07 (support.claude.com, help.openai.com): sharing a ChatGPT project needs
each person to have a ChatGPT account (free is enough; up to five collaborators on Free);
Claude shares projects on Team and Enterprise plans, and on other plans a chat can be
shared with specific people, view-only; Claude Cowork's scheduled tasks run on Anthropic's
side unless they need files on your computer. The comparison table now says "a plan per
person, or per seat" and that their scheduled tasks are the assistant doing the task each
run. The cost story's "before" figures are at API list prices on a Claude plan (room in
its limits, not a bill), and app deployment from a repository is "being built now" until
it is in a release.

`hatchabot-deck.html` is the source; the PDF is rendered from it with WeasyPrint, which
the runtime image already contains. Headings use Bricolage Grotesque (SIL OFL 1.1,
`fonts/`), the same font as hatchabot.com.

```sh
docker run --rm -v "$PWD/docs/deck":/work -w /work hatchabot-runtime:latest \
  weasyprint hatchabot-deck.html hatchabot-deck.pdf
```

Edit the HTML, re-run, look at every page, commit both files.

`screenshot.png` (the fleet), `screenshot-usage.png` (one AI source's usage),
`screenshot-agent.png` (one agent's settings) and `screenshot-cost.png` (View by → Cost) are rendered from the real `web/index.html`
driven by a stubbed `window.fetch` — invented household agents, no real names, tokens or
usage. Regenerate them all with `node scripts/screenshots.mjs` (needs docker); the fleet,
the data and the viewports live in `shot-data.mjs`. hatchabot.com carries the same files.
