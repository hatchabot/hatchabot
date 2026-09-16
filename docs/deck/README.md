# Hatchabot deck

`hatchabot-deck.pdf` — 15 slides (16:9): the problem, the idea, principles, the two
deliberate choices (Claude Max, Telegram), features, the control panel, operating a fleet, how it compares
with Claude.ai / ChatGPT / Codex and with plain OpenClaw, how it works, why it's easy to
run, and the 15-minute start.

`hatchabot-deck.html` is the source; the PDF is rendered from it with WeasyPrint, which
the runtime image already contains. Headings use Bricolage Grotesque (SIL OFL 1.1,
`fonts/`), the same font as hatchabot.com.

```sh
docker run --rm -v "$PWD/docs/deck":/work -w /work hatchabot-runtime:latest \
  weasyprint hatchabot-deck.html hatchabot-deck.pdf
```

Edit the HTML, re-run, look at every page, commit both files.

`screenshot.png` (the fleet) and `screenshot-usage.png` (one AI source's usage) are
rendered from the real `web/index.html` driven by a stubbed `window.fetch` — invented
household agents, no real names, tokens or usage. hatchabot.com carries the same two files.
