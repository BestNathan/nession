#!/usr/bin/env bash
# deploy-watch — Monitor Nession CI/CD deployment progress
#
# Usage:
#   ./scripts/deploy-watch.sh staging    Watch feature-branch CI → staging k8s rollout
#   ./scripts/deploy-watch.sh prod       Watch main release CI → prod k8s rollout
#   ./scripts/deploy-watch.sh --help
#
# Prerequisites: gh, kubectl, jq

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────
REPO="BestNathan/nession"
STAGING_WORKFLOW="cicd.yml"
STAGING_NS="nession-staging"
PROD_WORKFLOW="release.yml"
PROD_NS="nession"
K8S_OVERLAY_BASE="k8s/overlays"

# CI job groups for concise display
# Phase label → job name pattern (grep -E compatible)
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

# Common error patterns and fix suggestions
declare -A ERROR_FIXES=(
  ["cargo.*error"]="Check Rust compilation errors locally: cargo build"
  ["npm.*ERR"]="Check Node deps: cd web && npm ci && npm run build"
  ["eslint"]="Fix lint errors: cd web && npm run lint"
  ["vitest"]="Fix failing tests: cd web && npm test"
  ["clippy"]="Fix clippy warnings: cargo clippy -- -D warnings"
  ["docker.*denied"]="GHCR auth issue — check PAT scopes: read:packages, write:packages"
  ["docker.*not found"]="Base image missing or tag mismatch"
  ["kustomize"]="Kustomize build error — check k8s manifests: kubectl kustomize k8s/overlays/<env>"
  ["CrashLoopBackOff"]="Pod crashing — check logs: kubectl logs -n NS POD -c CONTAINER --tail=50"
  ["ImagePullBackOff"]="Image not found in GHCR — verify image tag exists: gh api /orgs/BestNathan/packages/container/nession-server/versions"
  ["ErrImagePull"]="Image pull error — check GHCR visibility and imagePullSecrets"
  ["OOMKilled"]="Memory limit too low — increase container limits in k8s deployment"
)

# ── Help ────────────────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
deploy-watch — Monitor Nession CI/CD deployment from commit to rollout.

Usage:
  ./scripts/deploy-watch.sh staging     Feature branch → staging
  ./scripts/deploy-watch.sh prod        Main branch → production

What it does:
  Staging: watches feat/fix branch CI workflow, then k8s staging rollout
  Prod:    watches main release workflow, then k8s prod rollout

Output:
  Shows only key CI phases (Check/Build/Docker/Merge/Kustomize)
  Shows k8s rollout status with pod health
  On error: shows failed job logs and suggests fixes
EOF
  exit 0
}

# ── Color helpers ───────────────────────────────────────────────────────
red()    { echo -e "\033[31m$*\033[0m"; }
green()  { echo -e "\033[32m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }
bold()   { echo -e "\033[1m$*\033[0m"; }
dim()    { echo -e "\033[2m$*\033[0m"; }

# ── Helpers ─────────────────────────────────────────────────────────────
die() { red "✖ $*"; exit 1; }
info() { green "✔ $*"; }
step() { bold "▶ $*"; }
note() { dim "  $*"; }

# ── CI Monitoring ───────────────────────────────────────────────────────
watch_ci() {
  local branch="$1" workflow="$2" label="$3"

  step "CI ($label) — waiting for workflow run on '$branch'..."

  # Wait for a workflow run to start (poll up to 60s)
  local run_id=""
  for _ in $(seq 1 12); do
    run_id=$(gh run list \
      --repo "$REPO" \
      --workflow "$workflow" \
      --branch "$branch" \
      --limit 1 \
      --json databaseId,status \
      --jq '.[0].databaseId // empty' 2>/dev/null)
    [[ -n "$run_id" ]] && break
    sleep 5
  done

  [[ -z "$run_id" ]] && die "No workflow run found for branch '$branch'. Did you push?"

  local url="https://github.com/$REPO/actions/runs/$run_id"
  note "Workflow: $url"

  # Track job states
  local -A job_status
  local -a failed_jobs
  local all_done=false
  local prev_phase=""

  while ! $all_done; do
    local -a active_phases=()
    local current_phase=""

    # Fetch current job states
    while IFS=$'\t' read -r name conclusion status; do
      job_status["$name"]="${conclusion:-$status}"

      case "${conclusion:-$status}" in
        failure|cancelled|timed_out)
          failed_jobs+=("$name")
          ;;
        in_progress|queued|waiting|pending)
          # Determine which phase this job belongs to
          for phase in "${!CI_PHASES[@]}"; do
            if echo "$name" | grep -qE "${CI_PHASES[$phase]}"; then
              active_phases+=("$phase")
              break
            fi
          done
          ;;
      esac
    done < <(gh run view "$run_id" --repo "$REPO" --json jobs \
      --jq '.jobs[] | "\(.name)\t\(.conclusion // "")\t\(.status)"' 2>/dev/null)

    # Deduplicate phases
    local phase_str
    phase_str=$(printf '%s\n' "${active_phases[@]}" | sort -u | tr '\n' ' ')

    # Print phase only when it changes
    if [[ -n "$phase_str" && "$phase_str" != "$prev_phase" ]]; then
      yellow "  ⏳ $phase_str"
      prev_phase="$phase_str"
    fi

    # Check if terminal
    local total
    total=$(gh run view "$run_id" --repo "$REPO" --json jobs \
      --jq '[.jobs[] | select(.status == "completed")] | length' 2>/dev/null)
    local all
    all=$(gh run view "$run_id" --repo "$REPO" --json jobs \
      --jq '.jobs | length' 2>/dev/null)

    if [[ "$total" -eq "$all" ]]; then
      all_done=true
    else
      sleep 5
    fi
  done

  # Report results
  local -i failed=0
  local -a failed_names=()
  for name in "${!job_status[@]}"; do
    local status="${job_status[$name]}"
    case "$status" in
      success|skipped) ;;
      *)
        failed=$((failed + 1))
        failed_names+=("$name")
        red "  ✖ $name: $status"
        ;;
    esac
  done

  if [[ $failed -gt 0 ]]; then
    echo ""
    red "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    red "  CI FAILED — $failed job(s) failed"
    red "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # Show failed job logs and suggest fixes
    for job_name in "${failed_names[@]}"; do
      echo ""
      red "  Failed: $job_name"
      dim "  ─────────────────────────────────────────────"

      # Get log excerpt
      local log
      log=$(gh run view "$run_id" \
        --repo "$REPO" \
        --job "$(gh run view "$run_id" --repo "$REPO" --json jobs \
          --jq ".jobs[] | select(.name == \"$job_name\") | .databaseId")" \
        --log 2>/dev/null | tail -30)

      echo "$log" | head -15
      dim "  ... (see full log: gh run view $run_id --job '$job_name' --log)"

      # Suggest fixes
      for pattern in "${!ERROR_FIXES[@]}"; do
        if echo "$log" | grep -qiE "$pattern"; then
          yellow "  → ${ERROR_FIXES[$pattern]}"
        fi
      done
    done
    exit 1
  fi

  info "CI passed — all jobs complete"
  echo ""
}

# ── K8s Monitoring ──────────────────────────────────────────────────────
watch_k8s() {
  local env="$1" namespace="$2"

  # Verify kubectl connectivity
  if ! kubectl get ns "$namespace" >/dev/null 2>&1; then
    yellow "  ⚠ kubectl cannot reach namespace '$namespace' — skipping k8s check"
    note "  Verify: kubectl config use-context <cluster> && kubectl get ns $namespace"
    note "  CI already updated the kustomize manifests — ArgoCD will sync automatically."
    return 0
  fi

  step "K8s ($env) — waiting for rollout in namespace '$namespace'..."

  sleep 5  # Give ArgoCD a moment to pick up the kustomize change

  local deployments=("nession-server" "nession-agent" "nession-ui")
  local -i ok=0 failed=0

  for deploy in "${deployments[@]}"; do
    note "Rolling out $deploy..."

    if kubectl rollout status "deployment/$deploy" \
      -n "$namespace" \
      --timeout=300s >/dev/null 2>&1; then
      info "  $deploy → ready"
      ok=$((ok + 1))
    else
      red "  $deploy → FAILED"

      # Show pod status for the failed deployment
      note "  Pod status:"
      kubectl get pods -n "$namespace" -l "app=$deploy" -o wide 2>/dev/null || true

      # Show events for debugging
      note "  Recent events:"
      kubectl get events -n "$namespace" \
        --field-selector "involvedObject.name~=$deploy" \
        --sort-by='.lastTimestamp' 2>/dev/null | tail -5 || true

      # Check for common error patterns
      local pod_status
      pod_status=$(kubectl get pods -n "$namespace" -l "app=$deploy" \
        -o jsonpath='{.items[*].status.containerStatuses[*].state}' 2>/dev/null || true)

      for pattern in "${!ERROR_FIXES[@]}"; do
        if echo "$pod_status" | grep -qi "$pattern"; then
          yellow "  → ${ERROR_FIXES[$pattern]}"
        fi
      done

      failed=$((failed + 1))
    fi
  done

  if [[ $failed -gt 0 ]]; then
    echo ""
    red "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    red "  K8s rollout FAILED — $failed deployment(s)"
    red "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    exit 1
  fi

  echo ""
  info "All $env deployments healthy"
  kubectl get pods -n "$namespace" -o wide
}

# ── Main ────────────────────────────────────────────────────────────────
[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && usage
[[ $# -lt 1 ]] && die "Expected: staging or prod\nUsage: ./scripts/deploy-watch.sh <staging|prod> [--skip-k8s]"

ENV="$1"
SKIP_K8S=false
[[ "${2:-}" == "--skip-k8s" ]] && SKIP_K8S=true

case "$ENV" in
  staging)
    BRANCH=$(git branch --show-current)
    [[ "$BRANCH" =~ ^(feat|fix)/ ]] || die "Expected feat/* or fix/* branch for staging. Current: $BRANCH"

    watch_ci "$BRANCH" "$STAGING_WORKFLOW" "staging"
    $SKIP_K8S || watch_k8s "staging" "$STAGING_NS"
    ;;

  prod)
    BRANCH="main"

    watch_ci "$BRANCH" "$PROD_WORKFLOW" "production"
    $SKIP_K8S || watch_k8s "production" "$PROD_NS"
    ;;

  *)
    die "Unknown environment: $ENV. Expected: staging | prod"
    ;;
esac

echo ""
green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
green "  Deploy complete — $ENV is up to date"
green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
