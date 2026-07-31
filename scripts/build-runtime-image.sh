#!/usr/bin/env bash
# Builds the per-agent runtime image, tagged with its OpenClaw version AND
# (unless NO_LATEST=1) retagged as :latest — which is what new provisions and
# Rebuild use. The upgrade flow is:
#
#   OPENCLAW_VERSION=X NO_LATEST=1 ./scripts/build-runtime-image.sh  # candidate
#   AGENTCLAW_IMAGE=agentclaw-runtime:X npm run e2e:docker           # smoke it
#   docker tag agentclaw-runtime:X agentclaw-runtime:latest          # promote
#   → app shows "update available" per agent; Rebuild upgrades it, memory kept.
set -euo pipefail
cd "$(dirname "$0")/.."

# Default = the version the fleet is proven on (candidate/promote flow above
# is how this moves forward).
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.7.1-2}"
REPO="${AGENTCLAW_IMAGE_REPO:-agentclaw-runtime}"

docker build \
  --build-arg "OPENCLAW_VERSION=${OPENCLAW_VERSION}" \
  -t "${REPO}:${OPENCLAW_VERSION}" \
  -f docker/Dockerfile.runtime \
  docker/

if [ "${NO_LATEST:-0}" != "1" ]; then
  docker tag "${REPO}:${OPENCLAW_VERSION}" "${REPO}:latest"
  echo "Built ${REPO}:${OPENCLAW_VERSION} (promoted to :latest)"
else
  echo "Built ${REPO}:${OPENCLAW_VERSION} (candidate — :latest untouched)"
fi
