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

# narella-deps/v1: attach a deps.json to each pushed image DIGEST as an OCI 1.1 referrer
# (artifactType application/vnd.narella.deps.v1+json), the same artifact Narella's CI
# attaches to its own images. The security inventory reads it to say whether a vulnerable
# package is a direct dependency of the app and through which chain it arrives. Format
# and fetch instructions: docs/narella-deps.md in narella-io/narella.
#
# The exporter is VENDORED at scripts/narella_deps_export.py (stdlib-only Python >= 3.11,
# no network), copied verbatim from narella-io/narella scripts/deps-export/; refresh it
# by copying, never by editing here. For the pnpm workspace it is scoped with --importer
# to the app the image runs, so "direct" means direct for THAT app (plus the workspace
# libs it links to), not for the whole monorepo.
#
# BEST-EFFORT, LOUD: a failure prints DEPS-ATTACH FAILED and the script carries on. The
# images are already pushed by then, and an image without the artifact only means its
# provenance is unknown, which the inventory never reads as "direct".
DEPS_EXPORTER="${ROOT}/scripts/narella_deps_export.py"
DEPS_TYPE="application/vnd.narella.deps.v1+json"
attach_deps() {
  local ref="$1" ctx="$2"; shift 2   # remaining args go to the exporter (e.g. --importer)
  local out commit digest rc
  if ! command -v oras >/dev/null; then
    echo "DEPS-ATTACH FAILED: oras not on PATH (brew install oras); ${ref} has no deps.json" >&2
    return 0
  fi
  if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
    echo "DEPS-ATTACH FAILED: python3 >= 3.11 needed for the exporter; ${ref} has no deps.json" >&2
    return 0
  fi
  out="$(mktemp -d)"
  commit="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  # The digest, never the tag: tags here are re-pushed (ONLY=... rebuilds), digests are
  # what got scanned.
  if ! digest="$(oras resolve "$ref")"; then
    echo "DEPS-ATTACH FAILED: cannot resolve ${ref}" >&2
    rm -rf "$out"; return 0
  fi
  # PREFER THE IMAGE'S OWN LOCK. `pnpm deploy` re-resolves the deployment and leaves the
  # result at node_modules/.pnpm/lock.yaml, and that lock is exact: against
  # v3.18.0-narella.14 it gave 0 shipped packages labelled dev and 0 shipped packages
  # missing for api, ws and worker. The source pnpm-lock.yaml names the right packages
  # but, for a few dozen, the wrong VERSION (vite's optional peer jiti is 2.6.1 there and
  # 1.21.0 in the image). The source lock is only the fallback, e.g. for the dashboard,
  # whose nginx image has no node_modules.
  local src_ctx="${ROOT}/${ctx}" cid
  if [[ "$ctx" == "." ]] && cid="$(docker create --platform linux/amd64 "${ref%:*}@${digest}" 2>/dev/null)"; then
    mkdir -p "${out}/deployed"
    if docker cp "${cid}:/usr/src/app/node_modules/.pnpm/lock.yaml" "${out}/deployed/pnpm-lock.yaml" >/dev/null 2>&1; then
      src_ctx="${out}/deployed"
    else
      echo "DEPS-ATTACH WARNING: no node_modules/.pnpm/lock.yaml in ${ref}; using the source pnpm-lock.yaml (versions may differ from the image)" >&2
    fi
    docker rm "$cid" >/dev/null 2>&1 || true
  fi
  rc=0
  python3 "$DEPS_EXPORTER" --context "$src_ctx" --context-name "$ctx" \
    --repo narella-io/novu --commit "$commit" --output "${out}/deps.json" "$@" || rc=$?
  if [[ $rc -eq 3 ]]; then
    echo "DEPS-ATTACH SKIPPED: no supported lockfile in ${ctx}; ${ref} provenance stays UNKNOWN"
    rm -rf "$out"; return 0
  elif [[ $rc -ne 0 ]]; then
    echo "DEPS-ATTACH FAILED: exporter exited ${rc} for ${ctx}; ${ref} has no deps.json" >&2
    rm -rf "$out"; return 0
  fi
  if (cd "$out" && oras attach --artifact-type "$DEPS_TYPE" "${ref%:*}@${digest}" "deps.json:${DEPS_TYPE}"); then
    echo "DEPS-ATTACH OK: ${ref%:*}@${digest}"
  else
    echo "DEPS-ATTACH FAILED: oras attach refused for ${ref%:*}@${digest}" >&2
  fi
  rm -rf "$out"
  return 0
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
attach_deps "${PREFIX}-api:${TAG}" . --importer apps/api
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
attach_deps "${PREFIX}-dashboard:${TAG}" . --importer apps/dashboard
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
attach_deps "${PREFIX}-worker:${TAG}" . --importer apps/worker
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
attach_deps "${PREFIX}-ws:${TAG}" . --importer apps/ws
fi

if want mcp; then
echo "=== building ${PREFIX}-mcp:${TAG} (narella-mcp/) ==="
docker buildx build \
  --platform linux/amd64 \
  --pull --no-cache \
  -t "${PREFIX}-mcp:${TAG}" \
  --push \
  "${ROOT}/narella-mcp"
attach_deps "${PREFIX}-mcp:${TAG}" narella-mcp
fi

echo "DONE: ${PREFIX}-{api,dashboard,worker,ws,mcp}:${TAG} (ONLY=${ONLY:-all})"
