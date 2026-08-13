#!/usr/bin/env bash
# deploy-watch — Monitor Nession CI/CD deployment progress
#
# Usage:
#   ./scripts/deploy-watch.sh staging    Feature branch CI → staging rollout
#   ./scripts/deploy-watch.sh prod       Main release CI → prod rollout
#   ./scripts/deploy-watch.sh --help
#
# Prerequisites: gh, kubectl, jq

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────
REPO="BestNathan/nession"
STAGING_WORKFLOW="cicd.yml"
PROD_WORKFLOW="release.yml"
K8S_NS="nession"
# Deployment name → pod component label (component is stable across envs)
STAGING_DEPLOYS=(
  "nession-server-staging server"
  "nession-agent-staging agent"
  "nession-ui-staging ui"
)
PROD_DEPLOYS=(
  "nession-server server"
  "nession-agent agent"
  "nession-ui ui"
)
K8S_TIMEOUT=300  # seconds to wait for pods to match expected image

# CI phase → job name pattern
declare -A CI_PHASES=(
  ["Check"]="rust-check|web-check"
  ["Versions"]="versions|version-check"
  ["Build"]="build-web|build-amd64|build-arm64|build-linux-"
  ["Docker"]="docker-"
  ["Merge manifests"]="merge"
  ["Update kustomize"]="update-.*-kustomize"
  ["Release"]="create-release"
  ["Cleanup"]="cleanup-"
)

declare -A ERROR_FIXES=(
  ["cargo.*error"]="Check Rust compilation: cargo build"
  ["npm.*ERR"]="Check Node deps: cd web && npm ci && npm run build"
  ["eslint"]="Fix lint: cd web && npm run lint"
  ["vitest"]="Fix tests: cd web && npm test"
  ["clippy"]="Fix clippy: cargo clippy -- -D warnings"
  ["docker.*denied"]="GHCR auth — check PAT scopes: read:packages, write:packages"
  ["docker.*not found"]="Base image missing or tag mismatch"
  ["kustomize"]="Check manifests: kubectl kustomize k8s/overlays/<env>"
  ["CrashLoopBackOff"]="Pod crashing — kubectl logs -n $K8S_NS <pod> --tail=50"
  ["ImagePullBackOff"]="Image not in GHCR — verify tag: gh api /orgs/BestNathan/packages/container/nession-server/versions"
  ["ErrImagePull"]="Image pull error — check GHCR visibility and imagePullSecrets"
  ["OOMKilled"]="Memory limit too low — increase container limits"
)

# ── Help ────────────────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
deploy-watch — Monitor Nession CI/CD deployment from commit to rollout.

Usage:
  ./scripts/deploy-watch.sh staging     Feature branch → staging
  ./scripts/deploy-watch.sh prod        Main branch → production

Flow:
  1. Watch CI workflow (key phases only)
  2. Extract built image tag (short SHA)
  3. Poll k8s pods until they match the expected image tag
  4. On success: show running pods. On timeout: show mismatch.

Output:
  CI phases (Check/Build/Docker/Merge/Kustomize) + image tag
  K8s rollout with image version verification
  On error: failed job logs + fix suggestions
EOF
  exit 0
}

# ── Color ───────────────────────────────────────────────────────────────
# All status/diagnostic output goes to stderr so that functions returning a
# value on stdout (watch_ci's SHA) aren't polluted by progress messages.
red()    { echo -e "\033[31m$*\033[0m" >&2; }
green()  { echo -e "\033[32m$*\033[0m" >&2; }
yellow() { echo -e "\033[33m$*\033[0m" >&2; }
bold()   { echo -e "\033[1m$*\033[0m" >&2; }
dim()    { echo -e "\033[2m$*\033[0m" >&2; }

die() { red "✖ $*"; exit 1; }
info() { green "✔ $*"; }
step() { bold "▶ $*"; }
note() { dim "  $*"; }

# ── CI Monitoring ───────────────────────────────────────────────────────
# Returns: the short SHA (7-char git hash) via stdout
watch_ci() {
  local branch="$1" workflow="$2" label="$3"

  step "CI ($label) — waiting for workflow run on '$branch'..."

  local run_id=""
  for _ in $(seq 1 12); do
    run_id=$(gh run list \
      --repo "$REPO" --workflow "$workflow" --branch "$branch" \
      --limit 1 --json databaseId,status \
      --jq '.[0].databaseId // empty' 2>/dev/null)
    [[ -n "$run_id" ]] && break
    sleep 5
  done
  [[ -z "$run_id" ]] && die "No workflow run found for branch '$branch'. Did you push?"

  local url="https://github.com/$REPO/actions/runs/$run_id"
  note "Workflow: $url"

  local -A job_status
  local -a failed_jobs
  local all_done=false
  local prev_phase=""

  while ! $all_done; do
    local -a active_phases=()
    while IFS=$'\t' read -r name conclusion status; do
      job_status["$name"]="${conclusion:-$status}"
      case "${conclusion:-$status}" in
        failure|cancelled|timed_out) failed_jobs+=("$name") ;;
        in_progress|queued|waiting|pending)
          for phase in "${!CI_PHASES[@]}"; do
            if echo "$name" | grep -qE "${CI_PHASES[$phase]}"; then
              active_phases+=("$phase"); break
            fi
          done
          ;;
      esac
    done < <(gh run view "$run_id" --repo "$REPO" --json jobs \
      --jq '.jobs[] | "\(.name)\t\(.conclusion // "")\t\(.status)"' 2>/dev/null)

    local phase_str
    phase_str=$(printf '%s\n' "${active_phases[@]}" | sort -u | tr '\n' ' ')
    if [[ -n "$phase_str" && "$phase_str" != "$prev_phase" ]]; then
      yellow "  ⏳ $phase_str"
      prev_phase="$phase_str"
    fi

    local total completed all
    total=$(gh run view "$run_id" --repo "$REPO" --json jobs \
      --jq '[.jobs[] | select(.status == "completed")] | length' 2>/dev/null)
    all=$(gh run view "$run_id" --repo "$REPO" --json jobs \
      --jq '.jobs | length' 2>/dev/null)
    [[ "$total" -eq "$all" ]] && all_done=true || sleep 5
  done

  # ── Report results ──
  local -i failed=0
  local -a failed_names=()
  for name in "${!job_status[@]}"; do
    case "${job_status[$name]}" in success|skipped) ;; *)
      failed=$((failed+1)); failed_names+=("$name")
      red "  ✖ $name: ${job_status[$name]}" ;;
    esac
  done

  if [[ $failed -gt 0 ]]; then
    echo ""
    red "━━━ CI FAILED — $failed job(s) ━━━"
    for job_name in "${failed_names[@]}"; do
      echo ""; red "  Failed: $job_name"
      local log
      log=$(gh run view "$run_id" --repo "$REPO" \
        --job "$(gh run view "$run_id" --repo "$REPO" --json jobs \
          --jq ".jobs[] | select(.name == \"$job_name\") | .databaseId")" \
        --log 2>/dev/null | tail -30)
      echo "$log" | head -15
      for pattern in "${!ERROR_FIXES[@]}"; do
        echo "$log" | grep -qiE "$pattern" && yellow "  → ${ERROR_FIXES[$pattern]}"
      done
    done
    exit 1
  fi

  # ── Extract built image tag (short SHA) from versions job ──
  local versions_job="versions"
  [[ "$label" == "production" ]] && versions_job="version-check"

  # `gh run view --job` takes a numeric job ID, not a name — resolve it first.
  local versions_job_id
  versions_job_id=$(gh run view "$run_id" --repo "$REPO" --json jobs \
    --jq ".jobs[] | select(.name == \"$versions_job\") | .databaseId" 2>/dev/null)

  local sha=""
  if [[ -n "$versions_job_id" ]]; then
    sha=$(gh run view "$run_id" --repo "$REPO" --log --job "$versions_job_id" 2>/dev/null \
      | grep -oE 'SHA: [a-f0-9]{7}' | head -1 | awk '{print $2}')
  fi

  # Validate — must be exactly 7 hex chars
  if [[ ! "$sha" =~ ^[a-f0-9]{7}$ ]]; then
    sha=$(git rev-parse --short=7 HEAD)
    yellow "  ⚠ Could not extract SHA from CI log — using local HEAD: $sha"
  fi

  info "CI passed — built image tag: $sha"
  echo "$sha"
}

# ── K8s Monitoring ──────────────────────────────────────────────────────
# Args: label, sha, "deploy1 component1" "deploy2 component2" ...
watch_k8s() {
  local label="$1" sha="$2"; shift 2
  local -a pairs=("$@")

  # Verify kubectl connectivity
  if ! kubectl get ns "$K8S_NS" >/dev/null 2>&1; then
    red "  ✖ kubectl cannot reach namespace '$K8S_NS'"
    note "  Available contexts:"; kubectl config get-contexts -o name 2>/dev/null | sed 's/^/    /' || true
    note "  Fix: kubectl config use-context <name> && kubectl get ns $K8S_NS"
    die "kubectl not connected to the Nession cluster"
  fi

  local normalized_sha="${sha:0:7}"
  step "K8s ($label) — waiting for pods to run image tag '$normalized_sha'..."

  local -i elapsed=0
  local -A deploy_done

  while [[ $elapsed -lt $K8S_TIMEOUT ]]; do
    for pair in "${pairs[@]}"; do
      read -r deploy component <<<"$pair"
      [[ -n "${deploy_done[$deploy]:-}" ]] && continue

      # Get the image tag from pods matching this component label
      local current_tag
      current_tag=$(kubectl get pods -n "$K8S_NS" \
        -l "component=$component,env=$label" \
        -o jsonpath='{.items[0].spec.containers[0].image}' 2>/dev/null \
        | rev | cut -d: -f1 | rev)

      [[ -z "$current_tag" ]] && continue  # No pods yet

      local current_hash="${current_tag##*-}"  # "server-fb7d3e3" → "fb7d3e3"

      if [[ "$current_hash" == "$normalized_sha" ]]; then
        deploy_done["$deploy"]=1
        note "  $deploy → ${current_tag} ✓"
      fi
    done

    # All matched?
    local -i done_count=0
    for pair in "${pairs[@]}"; do
      read -r deploy _ <<<"$pair"
      [[ -n "${deploy_done[$deploy]:-}" ]] && done_count=$((done_count + 1))
    done

    if [[ $done_count -eq ${#pairs[@]} ]]; then
      echo ""
      info "All $label pods running expected image '$normalized_sha'"
      kubectl get pods -n "$K8S_NS" -o wide
      return 0
    fi

    if [[ $((elapsed % 10)) -eq 0 && $elapsed -gt 0 ]]; then
      note "  ... ${elapsed}s elapsed, ${done_count}/${#pairs[@]} matched (timeout ${K8S_TIMEOUT}s)"
    fi

    sleep 5
    elapsed=$((elapsed + 5))
  done

  # ── Timeout — show mismatch ──
  echo ""
  red "━━━ K8s TIMEOUT — pods not running expected image after ${K8S_TIMEOUT}s ━━━"
  echo ""
  bold "Expected image tag: $normalized_sha"
  bold "Currently deployed:"
  echo ""
  for pair in "${pairs[@]}"; do
    read -r deploy component <<<"$pair"
    local deployed_tag status
    deployed_tag=$(kubectl get pods -n "$K8S_NS" \
      -l "component=$component,env=$label" \
      -o jsonpath='{.items[0].spec.containers[0].image}' 2>/dev/null || echo "N/A")
    status=$(kubectl get pods -n "$K8S_NS" \
      -l "component=$component,env=$label" \
      -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "N/A")
    local deployed_hash="${deployed_tag##*-}"
    if [[ "$deployed_hash" == "$normalized_sha" ]]; then
      info "  $deploy: $deployed_tag ($status)"
    else
      red "  $deploy: $deployed_tag ($status) — expected *-${normalized_sha}"
    fi
  done
  echo ""
  note "  ArgoCD may not have synced yet — re-run: ./scripts/deploy-watch.sh $label"
  note "  Or check manually: kubectl get pods -n $K8S_NS -o wide"
  exit 1
}

# ── Main ────────────────────────────────────────────────────────────────
[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && usage
[[ $# -lt 1 ]] && die "Usage: ./scripts/deploy-watch.sh <staging|prod>"

ENV="$1"

case "$ENV" in
  staging)
    BRANCH=$(git branch --show-current)
    [[ "$BRANCH" =~ ^(feat|fix)/ ]] || die "Expected feat/* or fix/* branch. Current: $BRANCH"
    SHA=$(watch_ci "$BRANCH" "$STAGING_WORKFLOW" "staging")
    watch_k8s "staging" "$SHA" "${STAGING_DEPLOYS[@]}"
    ;;

  prod)
    SHA=$(watch_ci "main" "$PROD_WORKFLOW" "production")
    watch_k8s "production" "$SHA" "${PROD_DEPLOYS[@]}"
    ;;

  *) die "Unknown environment: $ENV. Expected: staging | prod" ;;
esac

echo ""
green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
green "  Deploy complete — $ENV running image $SHA"
green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
