#!/usr/bin/env bash
# Builds the per-agent runtime image. Run once per OpenClaw version bump.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${AGENTCLAW_IMAGE:-agentclaw-runtime:latest}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.6.11}"

docker build \
  --build-arg "OPENCLAW_VERSION=${OPENCLAW_VERSION}" \
  -t "${IMAGE}" \
  -f docker/Dockerfile.runtime \
  docker/

echo "Built ${IMAGE} (openclaw@${OPENCLAW_VERSION})"
