#!/usr/bin/env bash
# gitops-commit.sh <env> <ref>
#
# All environments deploy GHCR images {server,agent,ui}-<ref> (#4032).
# The staging-only standalone MCP overlay follows the same exact SHA as all
# other staging roles; non-staging environments remain three-role deployments.
# Pushes a deploy commit ("deploy(<env>): <ref>") to the gitops branch.
# The ONLY writer of deployment desired state; used by staging.yml (staging
# branch auto-deploy), release.yml (production promotion) and deploy.yml
# (manual SHA deploys). ArgoCD consumes the gitops branch (issue #592).
#
# Push safety: workflow concurrency (gitops-writer) serializes writers across
# workflows; this rebase-retry loop is the second line against races.
set -euo pipefail

env=$1
ref=$2
OWNER="${GITHUB_REPOSITORY_OWNER,,}"
TOKEN="${GITHUB_TOKEN:?gitops-commit.sh needs GITHUB_TOKEN}"
SOURCE_IMAGE="ghcr.io/${OWNER}/nession"
TARGET_IMAGE="${SOURCE_IMAGE}"

# Production only ever ships released versions — the gitops-guard CI enforces
# this post-push; refuse pre-push so a bad commit never lands at all.
if [ "$env" = "production" ]; then
  echo "$ref" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || { echo "refusing to write non-semver tag to production: $ref"; exit 1; }
fi

# Staging must not move desired state to a GHCR tag until both platforms are
# remotely readable. This also guards manual staging deploys, whose workflow
# doesn't depend on the ACR mirror job.
if [[ "${env}" == "staging" ]]; then
  for img in server agent ui mcp; do
    tag="${img}-${ref}"
    # GHCR can return HTTP 401 to raw curl manifest requests while the Docker
    # Registry challenge/token flow still permits anonymous image pulls.
    # Buildx performs that negotiation, just as Kubernetes containerd does.
    if ! manifest="$(docker buildx imagetools inspect --raw "${TARGET_IMAGE}:${tag}")"; then
      echo "GHCR image ${tag} unavailable; refusing to advance staging GitOps" >&2
      exit 1
    fi
    if ! jq -e '
      [.manifests[]? | select(.platform.os == "linux") | .platform.architecture]
      | index("amd64") != null and index("arm64") != null
    ' <<< "${manifest}" >/dev/null; then
      echo "GHCR image ${tag} missing amd64 or arm64; refusing staging GitOps update" >&2
      exit 1
    fi
  done
fi

msg="deploy($env): $ref"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone --quiet --branch gitops --depth 1 \
  "https://x-access-token:${TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$tmp"
cd "$tmp/environments/$env/nession"

for img in server agent ui; do
  kustomize edit set image \
    "ghcr.io/${OWNER}/nession-${img}=${TARGET_IMAGE}:${img}-${ref}"
done

# Staging hosts a separate Argo CD Application for the standalone MCP service,
# yet both applications must advance in ONE GitOps commit to the same source SHA.
# Refuse a partial promotion if its overlay is absent, rather than silently
# deploying the Server/Agent/UI at a newer revision than MCP.
if [[ "${env}" == "staging" ]]; then
  mcp_overlay="${tmp}/environments/staging/mcp"
  if [[ ! -f "${mcp_overlay}/kustomization.yaml" ]]; then
    echo "missing staging MCP GitOps overlay: ${mcp_overlay}/kustomization.yaml" >&2
    exit 1
  fi
  cd "${mcp_overlay}"
  kustomize edit set image \
    "ghcr.io/${OWNER}/nession-mcp=${TARGET_IMAGE}:mcp-${ref}"
fi
cd "${tmp}"

if git diff --quiet; then
  echo "no tag change for $env @ $ref — nothing to commit"
  exit 0
fi

git add -A
git -c user.name="github-actions[bot]" \
    -c user.email="github-actions[bot]@users.noreply.github.com" \
    commit -m "$msg"

for i in $(seq 1 10); do
  # Auto-deploy remains bound to the current protected staging SHA even
  # if staging advances after the release verification but before pushing.
  if [[ "${env}" == "staging" && -n "${DEPLOY_SOURCE_SHA:-}" ]]; then
    [[ "${DEPLOY_SOURCE_SHA}" =~ ^[a-f0-9]{40}$ && "${DEPLOY_SOURCE_SHA:0:7}" == "${ref}" ]] ||
      { echo "invalid source-bound Staging deployment identity" >&2; exit 1; }
    current_staging="$(git ls-remote origin refs/heads/staging | cut -f1)"
    [[ "${current_staging}" == "${DEPLOY_SOURCE_SHA}" ]] ||
      { echo "staging advanced; refusing stale source-bound GHCR deployment" >&2; exit 1; }
  fi
  if git pull --rebase origin gitops && git push origin gitops; then
    echo "pushed: $msg"
    exit 0
  fi
  sleep "$((i * 3))"
done
echo "gitops push failed after retries: $msg"
exit 1
