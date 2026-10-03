#!/usr/bin/env bash
# Build every Novu image the Narella EKS cluster runs (api, dashboard, worker,
# ws, mcp) from this fork and push them to ECR.
#
#   ./scripts/narella-build-and-push.sh [tag]     # default: v3.18.0-narella.1
#   ONLY="ws mcp" ./scripts/narella-build-and-push.sh v3.18.0-narella.N   # a subset
#
# ws used to be a mirror of upstream ghcr.io/novuhq/novu/ws, which made it the one
# image a dependency fix in this fork could never reach (2026-10 CVE round: it carried
# the same next/tar/axios rows as api). It now builds from the fork like api/worker.
#
# --no-cache-filter prod: the prod stage's `apk upgrade` line never changes, so a
# cached layer would silently ship last month's openssl/curl. Only the final stage is
# rebuilt; the expensive dev/deploy stages still use the cache.
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
REGION="us-east-2"
REGISTRY="804837308083.dkr.ecr.${REGION}.amazonaws.com"
PREFIX="${REGISTRY}/narella/novu"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

want() { [[ -z "${ONLY:-}" || " ${ONLY} " == *" $1 "* ]]; }

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

# Empty BullMQ-Pro token file => community build (the Dockerfile branches on it).
EMPTY_SECRET="$(mktemp)"
trap 'rm -f "$EMPTY_SECRET"' EXIT

# Upstream CI does this copy before building (see .github/workflows/deploy.yml):
cp scripts/dotenvcreate.mjs apps/api/src/dotenvcreate.mjs
cp scripts/dotenvcreate.mjs apps/worker/src/dotenvcreate.mjs
cp scripts/dotenvcreate.mjs apps/ws/src/dotenvcreate.mjs

# Stream a build context into buildx, judging success by DOCKER's exit code.
#
# `pipefail` is wrong for these two pipelines. buildx stops reading once it has the
# context, pnpm-context then writes into a closed pipe and dies of SIGPIPE, and pipefail
# promotes that into a failed pipeline — which `set -e` turns into an abort AFTER the
# image has already built and pushed. Observed exactly that on v3.18.0-narella.13: the
# api image reached ECR and the script still exited 13, taking the dashboard, worker and
# ws builds with it. It is timing-dependent, so it looks like flakiness rather than a bug.
#
# Docker's status is the one that answers "did the image build", and a genuinely short
# context makes docker fail, so nothing is masked by ignoring the producer's death.
stream_build() {
  local dockerfile="$1"; shift
  set +o pipefail
  pnpm --silent --workspace-root pnpm-context -- "$dockerfile" | docker buildx build "$@" -
  local docker_rc=${PIPESTATUS[1]}
  set -o pipefail
  return "$docker_rc"
}

if want api; then
echo "=== building ${PREFIX}-api:${TAG} (fork: de-brand + Google OAuth + telemetry) ==="
stream_build apps/api/Dockerfile \
  --platform linux/amd64 \
  --no-cache-filter prod \
  --secret "id=BULL_MQ_PRO_NPM_TOKEN,src=${EMPTY_SECRET}" \
  --build-arg PACKAGE_PATH=apps/api \
  -t "${PREFIX}-api:${TAG}" \
  --push
fi

if want dashboard; then
echo "=== building ${PREFIX}-dashboard:${TAG} (fork: Google-only sign-in) ==="
docker buildx build \
  --platform linux/amd64 \
  --no-cache-filter prod \
  --build-arg VITE_SELF_HOSTED=true \
  --build-arg VITE_NOVU_ENTERPRISE=false \
  -f "${ROOT}/apps/dashboard/dockerfile" \
  -t "${PREFIX}-dashboard:${TAG}" \
  --push \
  "$ROOT"
fi

if want worker; then
echo "=== building ${PREFIX}-worker:${TAG} (fork: SES IRSA provider + outbound webhooks) ==="
stream_build apps/worker/Dockerfile \
  --platform linux/amd64 \
  --no-cache-filter prod \
  --secret "id=BULL_MQ_PRO_NPM_TOKEN,src=${EMPTY_SECRET}" \
  --build-arg PACKAGE_PATH=apps/worker \
  -t "${PREFIX}-worker:${TAG}" \
  --push
fi

if want ws; then
echo "=== building ${PREFIX}-ws:${TAG} (fork: carries the fork's dependency fixes) ==="
stream_build apps/ws/Dockerfile \
  --platform linux/amd64 \
  --no-cache-filter prod \
  --secret "id=BULL_MQ_PRO_NPM_TOKEN,src=${EMPTY_SECRET}" \
  --build-arg PACKAGE_PATH=apps/ws \
  -t "${PREFIX}-ws:${TAG}" \
  --push
fi

if want mcp; then
echo "=== building ${PREFIX}-mcp:${TAG} (narella-mcp/) ==="
docker buildx build \
  --platform linux/amd64 \
  --pull --no-cache \
  -t "${PREFIX}-mcp:${TAG}" \
  --push \
  "${ROOT}/narella-mcp"
fi

echo "DONE: ${PREFIX}-{api,dashboard,worker,ws,mcp}:${TAG} (ONLY=${ONLY:-all})"
