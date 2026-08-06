#!/usr/bin/env bash
# Build the two patched Novu images (api, dashboard) for the Narella EKS
# cluster and mirror the two unpatched upstream images (worker, ws) into ECR.
#
#   ./scripts/narella-build-and-push.sh [tag]     # default: v3.18.0-narella.1
#
# Requirements: `pnpm install --ignore-scripts` at the repo root first (the
# api build streams its context through scripts/pnpm-context.mjs, upstream's
# own mechanism — see apps/api package.json docker:build). EKS nodes are
# amd64; on Apple Silicon these build under emulation (the api build is slow).
# ECR CREATE_ON_PUSH templates auto-create the repositories on first push.
set -euo pipefail

# Preflight. The api/worker builds stream their context through a PIPE, so a missing
# pnpm does not surface as "pnpm: command not found" — it hands buildx an EMPTY context,
# and buildx reports `failed to read dockerfile: no local sources enabled`, which reads
# like a buildx driver fault and sends you diagnosing builders instead. pnpm lives under
# nvm and is absent from non-interactive shells, so this is the ordinary way to hit it.
for cmd in pnpm docker aws; do
  command -v "$cmd" >/dev/null || {
    echo "ERROR: '$cmd' is not on PATH." >&2
    [[ "$cmd" == "pnpm" ]] && \
      echo "  nvm is not loaded in non-interactive shells. Try:" >&2 && \
      echo "  export PATH=\"\$HOME/.nvm/versions/node/v22.21.1/bin:\$PATH\"" >&2
    exit 1
  }
done

TAG="${1:-v3.18.0-narella.1}"
UPSTREAM_TAG="3.18.0"
REGION="us-east-2"
REGISTRY="804837308083.dkr.ecr.${REGION}.amazonaws.com"
PREFIX="${REGISTRY}/narella/novu"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

# Empty BullMQ-Pro token file => community build (the Dockerfile branches on it).
EMPTY_SECRET="$(mktemp)"
trap 'rm -f "$EMPTY_SECRET"' EXIT

# Upstream CI does this copy before building (see .github/workflows/deploy.yml):
cp scripts/dotenvcreate.mjs apps/api/src/dotenvcreate.mjs
cp scripts/dotenvcreate.mjs apps/worker/src/dotenvcreate.mjs

echo "=== building ${PREFIX}-api:${TAG} (fork: de-brand + Google OAuth + telemetry) ==="
pnpm --silent --workspace-root pnpm-context -- apps/api/Dockerfile | docker buildx build \
  --platform linux/amd64 \
  --secret "id=BULL_MQ_PRO_NPM_TOKEN,src=${EMPTY_SECRET}" \
  --build-arg PACKAGE_PATH=apps/api \
  -t "${PREFIX}-api:${TAG}" \
  --push \
  -

echo "=== building ${PREFIX}-dashboard:${TAG} (fork: Google-only sign-in) ==="
docker buildx build \
  --platform linux/amd64 \
  --build-arg VITE_SELF_HOSTED=true \
  --build-arg VITE_NOVU_ENTERPRISE=false \
  -f "${ROOT}/apps/dashboard/dockerfile" \
  -t "${PREFIX}-dashboard:${TAG}" \
  --push \
  "$ROOT"

echo "=== building ${PREFIX}-worker:${TAG} (fork: SES IRSA provider) ==="
pnpm --silent --workspace-root pnpm-context -- apps/worker/Dockerfile | docker buildx build \
  --platform linux/amd64 \
  --secret "id=BULL_MQ_PRO_NPM_TOKEN,src=${EMPTY_SECRET}" \
  --build-arg PACKAGE_PATH=apps/worker \
  -t "${PREFIX}-worker:${TAG}" \
  --push \
  -

echo "=== mirroring upstream ws ${UPSTREAM_TAG} (no narella patches touch it) ==="
for svc in ws; do
  docker pull --platform linux/amd64 "ghcr.io/novuhq/novu/${svc}:${UPSTREAM_TAG}"
  docker tag "ghcr.io/novuhq/novu/${svc}:${UPSTREAM_TAG}" "${PREFIX}-${svc}:${TAG}"
  docker push "${PREFIX}-${svc}:${TAG}"
done

echo "DONE: ${PREFIX}-{api,dashboard,worker,ws}:${TAG}"
