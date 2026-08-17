#!/usr/bin/env bash
# deploy-watch — Monitor Nession CI/CD deployment progress
#
# Usage:
#   ./scripts/deploy-watch.sh staging    After merging PR to staging — watch staging rollout
#   ./scripts/deploy-watch.sh prod       After merging to main — watch release + prod rollout
#   ./scripts/deploy-watch.sh --help
#
# Prerequisites: gh, kubectl, jq

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────
REPO="BestNathan/nession"
STAGING_WORKFLOW="staging.yml"
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
  ./scripts/deploy-watch.sh staging     After merging PR to staging
  ./scripts/deploy-watch.sh prod        After merging to main

Flow:
  1. Watch CI workflow (key phases only)
  2. Extract built image tag (SHA for staging, version for prod)
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
# value on stdout (watch_ci's tag) aren't polluted by progress messages.
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
# Returns the expected image tag (7-char SHA for staging, X.Y.Z version for
# production) via stdout.
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
  # Re-query job status to ensure we have the latest conclusions
  local -A job_status
  while IFS=$'\t' read -r name conclusion status; do
    job_status["$name"]="${conclusion:-$status}"
  done < <(gh run view "$run_id" --repo "$REPO" --json jobs \
    --jq '.jobs[] | "\(.name)\t\(.conclusion // "")\t\(.status)"' 2>/dev/null)

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

  # ── Extract the expected image tag from the version job ──
  # Staging deploys SHA tags (ui-71b5afa); prod deploys VERSION tags (ui-0.25.6).
  local version_job="versions"
  [[ "$label" == "production" ]] && version_job="version-check"

  # `gh run view --job` takes a numeric job ID, not a name — resolve it first.
  local version_job_id
  version_job_id=$(gh run view "$run_id" --repo "$REPO" --json jobs \
    --jq ".jobs[] | select(.name == \"$version_job\") | .databaseId" 2>/dev/null)

  local tag=""
  if [[ -n "$version_job_id" ]]; then
    local job_log
    job_log=$(gh run view "$run_id" --repo "$REPO" --log --job "$version_job_id" 2>/dev/null || true)

    if [[ "$label" == "production" ]]; then
      # version-check logs the new version as "Release tag vX.Y.Z" (first run)
      # or "Version changed (... -> X.Y.Z)" (retry). Anchor on the surrounding
      # text — the checkout's `git fetch` step lists every historical tag
      # (v0.3.8 … v0.25.5), so a bare `vX.Y.Z` match would pick an old tag.
      tag=$(echo "$job_log" | grep -oE 'Release tag v[0-9]+\.[0-9]+\.[0-9]+' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
      if [[ ! "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        tag=$(echo "$job_log" | grep -oE '-> [0-9]+\.[0-9]+\.[0-9]+' | head -1 | awk '{print $2}')
      fi
    else
      # versions job logs "SHA: <7-char hash>".
      tag=$(echo "$job_log" | grep -oE 'SHA: [a-f0-9]{7}' | head -1 | awk '{print $2}')
    fi
  fi

  # Validate, falling back to the local checkout when extraction fails.
  if [[ "$label" == "production" ]]; then
    if [[ ! "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      tag=$(grep -m1 '^version' Cargo.toml | sed 's/.*"\(.*\)".*/\1/')
      yellow "  ⚠ Could not extract version from CI log — using local Cargo.toml: $tag"
    fi
  else
    if [[ ! "$tag" =~ ^[a-f0-9]{7}$ ]]; then
      tag=$(git rev-parse --short=7 HEAD)
      yellow "  ⚠ Could not extract SHA from CI log — using local HEAD: $tag"
    fi
  fi

  info "CI passed — built image tag: $tag"
  echo "$tag"
}

# ── K8s Monitoring ──────────────────────────────────────────────────────
# Args: label, tag, "deploy1 component1" "deploy2 component2" ...
watch_k8s() {
  local label="$1" tag="$2"; shift 2
  local -a pairs=("$@")

  # Verify kubectl connectivity
  if ! kubectl get ns "$K8S_NS" >/dev/null 2>&1; then
    red "  ✖ kubectl cannot reach namespace '$K8S_NS'"
    note "  Available contexts:"; kubectl config get-contexts -o name 2>/dev/null | sed 's/^/    /' || true
    note "  Fix: kubectl config use-context <name> && kubectl get ns $K8S_NS"
    die "kubectl not connected to the Nession cluster"
  fi

  local normalized_tag="${tag:0:7}"
  step "K8s ($label) — waiting for pods to run image tag '$normalized_tag'..."

  local -i elapsed=0
  local -A deploy_done

  while [[ $elapsed -lt $K8S_TIMEOUT ]]; do
    for pair in "${pairs[@]}"; do
      read -r deploy component <<<"$pair"
      [[ -n "${deploy_done[$deploy]:-}" ]] && continue

      # Get the image tag from pods matching this component label
      # Check ALL pods, not just the first one - during rolling update there may be both old and new pods
      local current_tag
      current_tag=$(kubectl get pods -n "$K8S_NS" \
        -l "component=$component,env=$label" \
        -o jsonpath='{range .items[*]}{.spec.containers[0].image}{"\n"}{end}' 2>/dev/null \
        | rev | cut -d: -f1 | rev | sort -u)

      [[ -z "$current_tag" ]] && continue  # No pods yet

      # Check if ANY pod has the expected image (during rolling update)
      local found_match=false
      while IFS= read -r tag_line; do
        [[ -z "$tag_line" ]] && continue
        local current_hash="${tag_line##*-}"  # "server-fb7d3e3"→"fb7d3e3" / "server-0.25.6"→"0.25.6"
        if [[ "$current_hash" == "$normalized_tag" ]]; then
          found_match=true
          break
        fi
      done <<< "$current_tag"

      if $found_match; then
        # Verify the deployment has fully rolled out (all replicas updated)
        local deploy_status
        deploy_status=$(kubectl get deploy "$deploy" -n "$K8S_NS" \
          -o jsonpath='{.status.updatedReplicas}/{.status.replicas}' 2>/dev/null)

        if [[ -n "$deploy_status" && "$deploy_status" != "0/0" ]]; then
          local updated="${deploy_status%%/*}"
          local total="${deploy_status##*/}"
          if [[ "$updated" == "$total" ]]; then
            deploy_done["$deploy"]=1
            note "  $deploy → $normalized_tag ✓ ($updated/$total replicas)"
          else
            note "  $deploy rolling update: $updated/$total replicas updated"
          fi
        fi
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
      info "All $label pods running expected image '$normalized_tag'"
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
  bold "Expected image tag: $normalized_tag"
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
    if [[ "$deployed_hash" == "$normalized_tag" ]]; then
      info "  $deploy: $deployed_tag ($status)"
    else
      red "  $deploy: $deployed_tag ($status) — expected *-${normalized_tag}"
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
    BRANCH="staging"
    TAG=$(watch_ci "$BRANCH" "$STAGING_WORKFLOW" "staging")
    watch_k8s "staging" "$TAG" "${STAGING_DEPLOYS[@]}"
    ;;

  prod)
    TAG=$(watch_ci "main" "$PROD_WORKFLOW" "production")
    watch_k8s "production" "$TAG" "${PROD_DEPLOYS[@]}"
    ;;

  *) die "Unknown environment: $ENV. Expected: staging | prod" ;;
esac

echo ""
green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
green "  Deploy complete — $ENV running image $TAG"
green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
