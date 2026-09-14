# Hatchabot deck

`hatchabot-deck.pdf` — 13 slides (16:9): the philosophy, features, how it differs
from Claude.ai / ChatGPT / Codex and from plain OpenClaw, architecture, and the
15-minute start. `hatchabot-deck.html` is the source; the PDF is rendered from it
with WeasyPrint, which the runtime image already contains:

```sh
docker run --rm -v "$PWD/docs/deck":/work -w /work hatchabot-runtime:latest \
  weasyprint hatchabot-deck.html hatchabot-deck.pdf
```

Edit the HTML, re-run, commit both files.
