#!/usr/bin/env bash
# #1876: best-effort artifact transport, never evidence for a Gate/SC Pass.
# Call only on a trusted main push step with GH_TOKEN; never in untrusted PR code.
set -euo pipefail
root="$(cd "$1" && pwd -P)"
sha="$2"
output="$GITHUB_OUTPUT"
echo 'hit=false' >> "$output"
if [[ "$GITHUB_EVENT_NAME" != push || "$GITHUB_REF" != refs/heads/main ||
      "$GITHUB_REPOSITORY" != BestNathan/nession || "$GITHUB_SHA" != "$sha" ||
      ! "$sha" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'WEB_BUILD_REUSE_V1 {"status":"miss","reason":"not_trusted_main_push"}'
  exit 0
fi
if [[ "$(git -C "$root" rev-parse HEAD)" != "$sha" ]]; then
  echo 'WEB_BUILD_REUSE_V1 {"status":"miss","reason":"checkout_mismatch"}'
  exit 0
fi
# Never wait for the producer; a cold path must remain bounded.
api="repos/$GITHUB_REPOSITORY/actions/workflows/ci-quality.yml/runs?event=push&head_sha=$sha&status=success&per_page=30"
response="$(gh api "$api" 2>/dev/null)" || {
  echo 'WEB_BUILD_REUSE_V1 {"status":"miss","reason":"producer_lookup_failed"}'
  exit 0
}
producer="$(jq -r --arg sha "$sha" --arg repo "$GITHUB_REPOSITORY" '
  [.workflow_runs[] | select(.head_sha == $sha and .head_branch == "main" and
    .event == "push" and .status == "completed" and .conclusion == "success" and
    .name == "CI / Quality Gate" and .path == ".github/workflows/ci-quality.yml" and
    .repository.full_name == $repo)] | sort_by(.run_started_at) | reverse | .[0] |
  if . then "\(.id) \(.run_attempt)" else empty end
' <<< "$response" 2>/dev/null)" || true
if [[ ! "$producer" =~ ^[0-9]+\ [0-9]+$ ]]; then
  echo 'WEB_BUILD_REUSE_V1 {"status":"miss","reason":"no_successful_exact_sha_producer"}'
  exit 0
fi
read -r run_id attempt <<< "$producer"
if [[ "$run_id" == "$GITHUB_RUN_ID" ]]; then
  echo 'WEB_BUILD_REUSE_V1 {"status":"miss","reason":"self_producer"}'
  exit 0
fi
scratch="$(mktemp -d "$RUNNER_TEMP/nession-web-dist-XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
if ! gh run download "$run_id" --repo "$GITHUB_REPOSITORY" \
  --name "nession-web-dist-$attempt" --dir "$scratch" >/dev/null 2>&1; then
  echo 'WEB_BUILD_REUSE_V1 {"status":"miss","reason":"artifact_not_ready_or_missing"}'
  exit 0
fi
if ! node "$root/scripts/ci/web-build-artifact.mjs" restore \
  --root "$root" --source "$scratch" --sha "$sha" \
  --run-id "$run_id" --attempt "$attempt"; then
  echo 'WEB_BUILD_REUSE_V1 {"status":"miss","reason":"artifact_verification_failed"}'
  exit 0
fi
echo 'hit=true' >> "$output"
