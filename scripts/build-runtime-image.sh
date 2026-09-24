#!/usr/bin/env bash
# Builds the per-agent runtime image, tagged with its OpenClaw version AND
# (unless NO_LATEST=1) retagged as :latest — which is what new provisions and
# Rebuild use. The upgrade flow is:
#
#   OPENCLAW_VERSION=X NO_LATEST=1 ./scripts/build-runtime-image.sh  # candidate
#   HATCHABOT_IMAGE=hatchabot-runtime:X npm run e2e:docker           # smoke it
#   docker tag hatchabot-runtime:X hatchabot-runtime:latest          # promote
#   → app shows "update available" per agent; Rebuild upgrades it, memory kept.
set -euo pipefail
cd "$(dirname "$0")/.."

# Default = the version the fleet is proven on (candidate/promote flow above
# is how this moves forward).
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.7.1-2}"
# Where the built image lands. Follows HATCHABOT_IMAGE when that is set, so a
# server pointed at another repo builds into the repo it actually reads
# (HATCHABOT_IMAGE_REPO still wins if someone sets it explicitly).
REPO="${HATCHABOT_IMAGE_REPO:-$(printf '%s' "${HATCHABOT_IMAGE:-hatchabot-runtime:latest}" | sed 's/:[^:/]*$//')}"

# The image TAG is normally the OpenClaw version, but the image can change
# WITHOUT an OpenClaw bump — e.g. baking in the embedding provider, or new base
# packages. Those need their own tag so they don't clobber the proven
# :OPENCLAW_VERSION image and so an agent can pin one for a candidate run. Set
# IMAGE_TAG=2026.7.1-2-emb1 (etc.) for a content revision; it defaults to the
# OpenClaw version for the normal upgrade flow.
IMAGE_TAG="${IMAGE_TAG:-${OPENCLAW_VERSION}}"

# Extra system packages ("the base image, plus tcpdump"). Space-separated apt
# names. An image with extras is never the plain version tag: it gets its own
# name, so a candidate with packages can never be mistaken for the standard one.
EXTRA_ARG=()
if [ -n "${EXTRA_PACKAGES:-}" ]; then
  if ! printf '%s' "${EXTRA_PACKAGES}" | grep -qE '^[a-z0-9][a-z0-9+.-]*( [a-z0-9][a-z0-9+.-]*)*$'; then
    echo "EXTRA_PACKAGES must be space-separated apt package names." >&2; exit 1
  fi
  EXTRA_ARG=(--build-arg "EXTRA_PACKAGES=${EXTRA_PACKAGES}")
  if [ "${IMAGE_TAG}" = "${OPENCLAW_VERSION}" ]; then
    IMAGE_TAG="${OPENCLAW_VERSION}-plus-$(printf '%s' "${EXTRA_PACKAGES}" | tr ' ' '-' | cut -c1-40)"
  fi
  BUILD_LOCAL=1   # a published image never carries someone's extra packages
fi
case "$IMAGE_TAG" in latest|derived-*) echo "IMAGE_TAG=$IMAGE_TAG is reserved (:latest moves only via promote; derived-* via image derive)." >&2; exit 1;; esac
PINS="$(dirname "$0")/runtime-pins.mjs"

# The memory search engine (docs/embedder-and-openclaw-port-design.md, step 4):
# baked into the image, or none — every agent on the image uses the machine's
# shared memory search service. From OpenClaw 2026.8 the plugin has no engine
# to bake, so those versions build `none` on their own. Leaving the engine out
# of a version that could bake it gives the image its own tag (-lite), so it
# is tried on one agent like any other candidate and never mistaken for the
# standard one.
ENGINE_RULE="$(node "$PINS" embed-engine "${OPENCLAW_VERSION}" 2>/dev/null || echo baked)"
EMBED_ENGINE="${EMBED_ENGINE:-$ENGINE_RULE}"
case "$EMBED_ENGINE" in baked|none) ;; *) echo "EMBED_ENGINE must be baked or none." >&2; exit 1;; esac
if [ "$EMBED_ENGINE" = baked ] && [ "$ENGINE_RULE" = none ]; then
  echo "OpenClaw ${OPENCLAW_VERSION} has no embedding engine to bake (its plugin downloads one later)." >&2
  echo "Build it with EMBED_ENGINE=none: its agents use the shared memory search service." >&2
  exit 1
fi
if [ "$EMBED_ENGINE" = none ] && [ "$ENGINE_RULE" = baked ] && [ "$IMAGE_TAG" = "$OPENCLAW_VERSION" ]; then
  IMAGE_TAG="${OPENCLAW_VERSION}-lite"
fi
if [ "${DRYRUN:-0}" = 1 ]; then
  echo "dry run: would build ${REPO}:${IMAGE_TAG} (OpenClaw ${OPENCLAW_VERSION}, engine ${EMBED_ENGINE})"
  exit 0
fi

# The embedding plugin declares openclaw as a peerDependency, so its pin must
# move with OPENCLAW_VERSION (Dockerfile ARG LLAMA_CPP_PROVIDER_VERSION). The
# sanctioned upgrade flow only sets OPENCLAW_VERSION — pass the plugin pin
# through when given, and warn when an OpenClaw bump leaves it implicit so the
# stale-peer case is at least loud (audit 2026-09-02).
# Prefer the published multi-arch image (built by .github/workflows/runtime-image.yml)
# over a 20-minute local build: same Dockerfile, same pins. A version that isn't
# published yet (a fresh candidate) — or BUILD_LOCAL=1 — falls through to the
# local build below.
PUBLISHED="${HATCHABOT_IMAGE_REGISTRY:-ghcr.io/hatchabot/runtime}"
if [ "${BUILD_LOCAL:-0}" != "1" ] && [ "${IMAGE_TAG}" = "${OPENCLAW_VERSION}" ] && [ -z "${LLAMA_CPP_PROVIDER_VERSION:-}" ] && [ "${EMBED_ENGINE}" = "${ENGINE_RULE}" ]; then
  # The per-release tag (vX.Y.Z) is never rewritten; the version tag moves with every release.
  RELEASE_TAG="$(git describe --tags --exact-match 2>/dev/null || true)"
  # The per-release image bakes the Dockerfile's DEFAULT OpenClaw. It is only
  # the right image when that is the version asked for: a candidate for a
  # newer OpenClaw once pulled it, got the old version, and was tagged as the
  # new one (2026-09-18). So: release tag only on a version match, and every
  # pulled image must prove its version by its label before it is accepted.
  DEFAULT_VERSION="$(sed -n 's/^ARG OPENCLAW_VERSION=//p' docker/Dockerfile.runtime | head -1)"
  [ "${OPENCLAW_VERSION}" = "${DEFAULT_VERSION}" ] || RELEASE_TAG=""
  PULLED=""
  for cand in ${RELEASE_TAG:+"${PUBLISHED}:${RELEASE_TAG}"} "${PUBLISHED}:${OPENCLAW_VERSION}"; do
    # Ask before pulling. Not every release publishes its own image, and a
    # plain `docker pull` on a missing tag prints a red "Error response from
    # daemon: … not found" — which, on a first install, is the first thing a
    # new user ever sees from Hatchabot, right before it works perfectly.
    if ! docker manifest inspect "$cand" >/dev/null 2>&1; then
      echo "No image published as ${cand} — trying the next one."
      continue
    fi
    echo "Trying the published image ${cand}…"
    if docker pull "$cand"; then
      HAS="$(docker inspect "$cand" --format '{{ index .Config.Labels "org.agentclaw.openclaw-version" }}' 2>/dev/null || true)"
      if [ "$HAS" = "${OPENCLAW_VERSION}" ]; then PULLED="$cand"; break; fi
      echo "  …that image carries OpenClaw ${HAS:-unknown}, not ${OPENCLAW_VERSION}; not using it."
    fi
  done
  if [ -n "$PULLED" ]; then
    docker tag "$PULLED" "${REPO}:${IMAGE_TAG}"
    if [ "${NO_LATEST:-0}" != "1" ]; then docker tag "${REPO}:${IMAGE_TAG}" "${REPO}:latest"; echo "Pulled ${REPO}:${IMAGE_TAG} (promoted to :latest)"; else echo "Pulled ${REPO}:${IMAGE_TAG} (candidate — :latest untouched)"; fi
    exit 0
  fi
  echo "Not published (or offline) — building locally instead."
fi
DEFAULT_OPENCLAW="$(sed -n 's/^ARG OPENCLAW_VERSION=//p' docker/Dockerfile.runtime | head -1)"

# The embedding plugin is published in step with OpenClaw and declares it as a
# peer, so a newer OpenClaw needs a newer plugin. Given explicitly, use that;
# for the proven default, keep the Dockerfile's pin; otherwise take the newest
# plugin release that is not newer than this OpenClaw.
PLUGIN_ARG=()
if [ "${EMBED_ENGINE}" = none ]; then
  : # nothing to pin: the plugin is not baked
elif [ -n "${LLAMA_CPP_PROVIDER_VERSION:-}" ]; then
  PLUGIN_ARG=(--build-arg "LLAMA_CPP_PROVIDER_VERSION=${LLAMA_CPP_PROVIDER_VERSION}")
elif [ "${OPENCLAW_VERSION}" != "${DEFAULT_OPENCLAW}" ]; then
  LIST="$(npm view @openclaw/llama-cpp-provider versions --json 2>/dev/null || true)"
  PICK="$(node "$PINS" plugin "${OPENCLAW_VERSION}" "${LIST:-[]}" 2>/dev/null || true)"
  if [ -n "$PICK" ]; then
    echo "Embedding plugin for OpenClaw ${OPENCLAW_VERSION}: ${PICK}"
    PLUGIN_ARG=(--build-arg "LLAMA_CPP_PROVIDER_VERSION=${PICK}")
  else
    echo "⚠ Couldn't work out the embedding plugin for OpenClaw ${OPENCLAW_VERSION};" >&2
    echo "  keeping the Dockerfile's pin. Set LLAMA_CPP_PROVIDER_VERSION if the build fails on it." >&2
  fi
fi

# Slack and Discord plugins are published in step with OpenClaw, like the
# embedding plugin. The Dockerfile's pin fits the proven default; other
# versions get the newest release not newer than that OpenClaw.
CHANNEL_ARG=()
if [ -n "${CHANNEL_PLUGIN_VERSION:-}" ]; then
  CHANNEL_ARG=(--build-arg "CHANNEL_PLUGIN_VERSION=${CHANNEL_PLUGIN_VERSION}")
elif [ "${OPENCLAW_VERSION}" != "${DEFAULT_OPENCLAW}" ]; then
  LIST="$(npm view @openclaw/slack versions --json 2>/dev/null || true)"
  PICK="$(node "$PINS" plugin "${OPENCLAW_VERSION}" "${LIST:-[]}" 2>/dev/null || true)"
  if [ -n "$PICK" ]; then
    echo "Slack/Discord plugins for OpenClaw ${OPENCLAW_VERSION}: ${PICK}"
    CHANNEL_ARG=(--build-arg "CHANNEL_PLUGIN_VERSION=${PICK}")
  fi
fi

# From OpenClaw 2026.8 the web-search plugin (duckduckgo) is not bundled any
# more; bake it, published in step with OpenClaw like the channel plugins.
BAKED_ARG=()
if [ -n "${BAKED_PLUGINS:-}" ]; then
  BAKED_ARG=(--build-arg "BAKED_PLUGINS=${BAKED_PLUGINS}")
elif [ "$(node "$PINS" embed-engine "${OPENCLAW_VERSION}" 2>/dev/null || echo baked)" = none ]; then
  BAKED_ARG=(--build-arg "BAKED_PLUGINS=duckduckgo=@openclaw/duckduckgo-plugin")
fi

# Node.js: OpenClaw raises its floor over time (2026.9 needs 24.16+). Read what
# this version asks for and take the lowest Node line that fits, so the proven
# default stays on the line it was proven on.
NODE_ARG=()
if [ -n "${NODE_IMAGE:-}" ]; then
  NODE_ARG=(--build-arg "NODE_IMAGE=${NODE_IMAGE}")
elif [ "${OPENCLAW_VERSION}" != "${DEFAULT_OPENCLAW}" ]; then
  NEEDS="$(npm view "openclaw@${OPENCLAW_VERSION}" engines.node 2>/dev/null || true)"
  if [ -n "$NEEDS" ]; then
    echo "OpenClaw ${OPENCLAW_VERSION} needs Node.js ${NEEDS}"
    for major in 22 24 26; do
      img="node:${major}-slim"
      docker pull -q "$img" >/dev/null 2>&1 || true   # the line's newest patch; offline keeps the local copy
      has="$(docker run --rm --network none "$img" node --version 2>/dev/null || true)"
      if [ -n "$has" ] && node "$PINS" node-ok "$NEEDS" "$has"; then
        echo "Building on ${img} (Node.js ${has})"
        NODE_ARG=(--build-arg "NODE_IMAGE=${img}")
        break
      fi
    done
    if [ "${#NODE_ARG[@]}" -eq 0 ]; then
      echo "✗ No Node.js line here (22, 24, 26) fits '${NEEDS}'. Set NODE_IMAGE to one that does." >&2
      exit 1
    fi
  fi
fi

docker build \
  --build-arg "OPENCLAW_VERSION=${OPENCLAW_VERSION}" \
  --build-arg "EMBED_ENGINE=${EMBED_ENGINE}" \
  "${PLUGIN_ARG[@]}" \
  "${NODE_ARG[@]}" \
  "${CHANNEL_ARG[@]}" \
  "${BAKED_ARG[@]}" \
  "${EXTRA_ARG[@]}" \
  -t "${REPO}:${IMAGE_TAG}" \
  -f docker/Dockerfile.runtime \
  docker/

# Trust, but verify: the image must actually run the version it is named for.
RUNS="$(docker run --rm --network none --entrypoint openclaw "${REPO}:${IMAGE_TAG}" --version 2>/dev/null | head -1 || true)"
case "$RUNS" in
  *"${OPENCLAW_VERSION}"*) ;;
  *) echo "✗ ${REPO}:${IMAGE_TAG} runs '${RUNS:-nothing}', not OpenClaw ${OPENCLAW_VERSION}. Removing it." >&2
     docker rmi "${REPO}:${IMAGE_TAG}" >/dev/null 2>&1 || true
     exit 1 ;;
esac

if [ "${NO_LATEST:-0}" != "1" ]; then
  docker tag "${REPO}:${IMAGE_TAG}" "${REPO}:latest"
  echo "Built ${REPO}:${IMAGE_TAG} (promoted to :latest)"
else
  echo "Built ${REPO}:${IMAGE_TAG} (candidate — :latest untouched)"
fi
