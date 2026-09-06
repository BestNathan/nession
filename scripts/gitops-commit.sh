#!/usr/bin/env bash
# gitops-commit.sh <env> <ref>
#
# Points gitops/environments/<env>/nession at ghcr images {server,agent,ui}-<ref>
# and pushes a deploy commit ("deploy(<env>): <ref>") to the gitops branch.
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

# Production only ever ships released versions — the gitops-guard CI enforces
# this post-push; refuse pre-push so a bad commit never lands at all.
if [ "$env" = "production" ]; then
  echo "$ref" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || { echo "refusing to write non-semver tag to production: $ref"; exit 1; }
fi

msg="deploy($env): $ref"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone --quiet --branch gitops --depth 1 \
  "https://x-access-token:${TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$tmp"
cd "$tmp/environments/$env/nession"

for img in server agent ui; do
  kustomize edit set image \
    "ghcr.io/${OWNER}/nession-${img}=ghcr.io/${OWNER}/nession:${img}-${ref}"
done

if git diff --quiet; then
  echo "no tag change for $env @ $ref — nothing to commit"
  exit 0
fi

git add -A
git -c user.name="github-actions[bot]" \
    -c user.email="github-actions[bot]@users.noreply.github.com" \
    commit -m "$msg"

for i in $(seq 1 10); do
  if git pull --rebase origin gitops && git push origin gitops; then
    echo "pushed: $msg"
    exit 0
  fi
  sleep "$((i * 3))"
done
echo "gitops push failed after retries: $msg"
exit 1
