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
REPO="${HATCHABOT_IMAGE_REPO:-hatchabot-runtime}"

# The image TAG is normally the OpenClaw version, but the image can change
# WITHOUT an OpenClaw bump — e.g. baking in the embedding provider, or new base
# packages. Those need their own tag so they don't clobber the proven
# :OPENCLAW_VERSION image and so an agent can pin one for a candidate run. Set
# IMAGE_TAG=2026.7.1-2-emb1 (etc.) for a content revision; it defaults to the
# OpenClaw version for the normal upgrade flow.
IMAGE_TAG="${IMAGE_TAG:-${OPENCLAW_VERSION}}"

# The embedding plugin declares openclaw as a peerDependency, so its pin must
# move with OPENCLAW_VERSION (Dockerfile ARG LLAMA_CPP_PROVIDER_VERSION). The
# sanctioned upgrade flow only sets OPENCLAW_VERSION — pass the plugin pin
# through when given, and warn when an OpenClaw bump leaves it implicit so the
# stale-peer case is at least loud (audit 2026-09-02).
PLUGIN_ARG=()
if [ -n "${LLAMA_CPP_PROVIDER_VERSION:-}" ]; then
  PLUGIN_ARG=(--build-arg "LLAMA_CPP_PROVIDER_VERSION=${LLAMA_CPP_PROVIDER_VERSION}")
elif [ "${OPENCLAW_VERSION}" != "$(grep -oP 'ARG OPENCLAW_VERSION=\K\S+' docker/Dockerfile.runtime)" ]; then
  echo "⚠ OPENCLAW_VERSION=${OPENCLAW_VERSION} but LLAMA_CPP_PROVIDER_VERSION not set —" >&2
  echo "  the embedding plugin keeps the Dockerfile's pinned version; verify it peers with this OpenClaw." >&2
fi

docker build \
  --build-arg "OPENCLAW_VERSION=${OPENCLAW_VERSION}" \
  "${PLUGIN_ARG[@]}" \
  -t "${REPO}:${IMAGE_TAG}" \
  -f docker/Dockerfile.runtime \
  docker/

if [ "${NO_LATEST:-0}" != "1" ]; then
  docker tag "${REPO}:${IMAGE_TAG}" "${REPO}:latest"
  echo "Built ${REPO}:${IMAGE_TAG} (promoted to :latest)"
else
  echo "Built ${REPO}:${IMAGE_TAG} (candidate — :latest untouched)"
fi
