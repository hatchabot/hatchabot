# Local memory embeddings & the runtime image

## The problem this closes

OpenClaw's `memory_search` does two things: keyword (FTS) and **semantic
(vector) recall** over an agent's `MEMORY.md` and dated `memory/` files. The
vector half needs an *embedding provider*. Hatchabot sets
`agents.defaults.memorySearch.provider = local`, but the `local` provider is an
**external plugin** (`@openclaw/llama-cpp-provider`) that was not in the image —
so fleet-wide, semantic recall silently degraded to FTS. An agent asked "how
should the portfolio be managed" would miss a memory that said "value-investing
philosophy" because no keyword overlapped.

## Why baking is non-trivial (the volume/image split)

Each agent is one container with its **whole `$HOME` (`/home/node`) mounted as a
durable volume**. The image's `/home/node` only seeds a *fresh* volume; existing
volumes are already seeded and ignore later image changes. So:

- `openclaw plugins install <pkg>` writes the 71 MB plugin (with
  node-llama-cpp's native `llama-addon.node`) to the **volume**, and first index
  downloads the 314 MB GGUF model to the volume too — **×N agents** (~13 GB
  across 34), and invisible to the image.
- Anything baked under `/home/node` reaches only new agents.

**The fix: put the shared bytes OUTSIDE `/home/node`, in the image.** Only image
paths that are not under the volume mount are truly shared by every agent.

## What we bake (docker/Dockerfile.runtime)

| Artifact | Baked path (image, shared) | Size |
|---|---|---|
| Plugin (self-contained, incl. native addon) | `/opt/agentclaw/llama-cpp/llama-cpp-provider` | ~71 MB |
| GGUF model (`embeddinggemma-300m-qat-Q8_0`) | `/opt/agentclaw/models/embeddinggemma-300m-qat-Q8_0.gguf` | ~314 MB |

- The plugin package **bundles its own `node-llama-cpp` and the arch's
  `llama-addon.node`**, so relocating just the package dir yields a working
  plugin. We install it into a throwaway `$HOME` with OpenClaw's own installer
  (which resolves the exact pinned dep tree), then `cp -a` the package dir to
  `/opt`. Its `openclaw` peerDependency symlink targets the global install,
  which stays put — so the link keeps resolving after the move.
- The model is fetched from Hugging Face and **verified against a pinned
  sha256** before it can ship (same guard as the `gog` binary). Query time needs
  no key and no network.
- Both paths are exposed as `HATCHABOT_EMBED_PLUGIN` / `HATCHABOT_EMBED_MODEL`
  env for discovery.

## How an agent picks it up (src/openclaw/configWriter.ts)

Provisioning (fresh **and** every Rebuild) emits, per agent:

```
plugins install --link /opt/agentclaw/llama-cpp/llama-cpp-provider   # registry pointer, no copy
plugins enable  llama-cpp
config set agents.defaults.memorySearch.provider              local
config set agents.defaults.memorySearch.local.modelPath       /opt/agentclaw/models/embeddinggemma-300m-qat-Q8_0.gguf
```

`--link` records a pointer to the image path — **the volume never copies the
71 MB**. `modelPath` points at the shared image file — the volume never copies
the 314 MB. Both verbs are idempotent, so re-running on rebuild is a no-op.
Constants live in `configWriter.ts` (`EMBED_PLUGIN_DIR`, `EMBED_MODEL_PATH`) and
**must match the Dockerfile**.

### Measured footprint

A throwaway agent, plugin linked and one memory file fully indexed with working
semantic search, kept `~/.openclaw` at **~4 MB** — registry pointer + tiny
sqlite index, no model, no plugin copy. Semantic retrieval confirmed: a query
with no keyword overlap matched the right memory line.

## Rollout

- Existing agents get embeddings on their **next Rebuild** against a
  `:latest` that carries the bake — memory preserved (volume untouched).
- The per-agent **image pin** (Settings → Environment) is how a candidate is
  proven on one agent before promotion.
- Build a content revision without an OpenClaw bump:
  ```
  IMAGE_TAG=2026.7.1-2-emb1 NO_LATEST=1 ./scripts/build-runtime-image.sh   # candidate
  # pin one agent to hatchabot-runtime:2026.7.1-2-emb1, verify memory search
  docker tag hatchabot-runtime:2026.7.1-2-emb1 hatchabot-runtime:latest    # promote
  ```

### Multi-arch note

The plugin's native addon is arch-specific; `openclaw plugins install` during
`docker build` resolves the **build host's** arch (arm64 on the Spark). Building
the image on the same arch it runs on is required — cross-arch builds would need
the matching `@node-llama-cpp/<arch>` prebuilt.

## Derived images

This bake is the first "shared base layer" problem solved, and the pattern
generalizes. A **derived image** is `FROM hatchabot-runtime:<base>` plus
agent-specific system packages (a market agent's pandas/numpy stack, a media
agent's ffmpeg) — heavy things that shouldn't sit in every agent's volume *or*
in the base image everyone shares. Same discipline: shared, immutable bytes in
an image layer; only per-agent state on the volume.

Built as a first-class feature (⚙ Settings → Images, or `hatchabot image`; see
`docs/features.md` → Derived images):

- **Build** (`POST /v1/images`, `hatchabot image derive`): the owner supplies a
  name + Dockerfile lines; `src/orchestrator/derivedImage.ts` renders
  `FROM <base>` + `USER root` + the lines + `USER node` (the root wrap is why
  apt works; the trailing `USER node` is enforced, not optional — an image that
  ended as root would break every agent, since the volume is uid 1000 and Claude
  Code refuses root). No `--pull`: the base is a local image, never a registry
  one. Tag: `hatchabot-runtime:derived-<name>`.
- **Track** (`derived_images` store table): name, base, Dockerfile, status,
  built-at. The Dockerfile is kept so **Rebuild** reruns it against a promoted
  base after a fleet upgrade.
- **Use**: the existing per-agent pin attaches an agent to the derived tag; the
  provider already runs `spec.image ?? :latest`, so a rebuild lands the agent on
  it. Delete is refused while an agent still pins it.
- **Gate**: building runs a Dockerfile on the box — a privilege the local-host
  owner already has (they can run docker directly) and a co-tenant must never
  get. Every route is `ownsLocalHost`-gated.

### Multi-arch note (applies to derived images too)

A derived image inherits the base's arch; `docker build` on the host produces
the host's arch. As with the base, build on the arch you deploy.
