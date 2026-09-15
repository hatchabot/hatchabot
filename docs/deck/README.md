# Hatchabot deck

`hatchabot-deck.pdf` — 14 slides (16:9): the problem, the idea, principles, the two
deliberate choices (Claude Max, Telegram), features, operating a fleet, how it compares
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
