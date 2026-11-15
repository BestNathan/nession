#!/usr/bin/env bash
# #3669: read-only OCI benchmark observation via the trusted staging VPN.
set -euo pipefail
test -n "$KUBECONFIG"
command -v kubectl >/dev/null
command -v jq >/dev/null
ns=nession
selector='env=staging-ocicdn,app=nession-pull-bench'
if ! kubectl --request-timeout=20s auth can-i list pods -n "$ns" --quiet; then
  echo "::error::read-only credential cannot list staging pods"; exit 1
fi
for action in "get secrets" "create pods" "delete pods" "create pods/exec" "get nodes" "list namespaces"; do
  if kubectl --request-timeout=20s auth can-i $action -n "$ns" --quiet; then
    echo "::error::unexpected privilege $action"; exit 1
  fi
done
for attempt in $(seq 1 136); do
  pods="$(kubectl --request-timeout=20s -n "$ns" get pods -l "$selector" -o json)"
  pod="$(jq -c '[.items[] | select(.metadata.deletionTimestamp == null)] | sort_by(.metadata.creationTimestamp) | last // empty' <<<"$pods")"
  if [[ -n "$pod" ]]; then
    name="$(jq -r '.metadata.name' <<<"$pod")"
    node="$(jq -r '.spec.nodeName // "unscheduled"' <<<"$pod")"
    phase="$(jq -r '.status.phase // "Unknown"' <<<"$pod")"
    code="$(jq -r '.status.containerStatuses[0].state.terminated.exitCode // empty' <<<"$pod")"
    if [[ -n "$code" ]]; then
      msg="$(jq -r '.status.containerStatuses[0].state.terminated.message // empty' <<<"$pod")"
      echo "STAGING_OCICDN_POD pod=$name node=$node phase=$phase exit=$code"
      if ! jq -e '.schema == "nession-oci-pull-benchmark-v1"' <<<"$msg" >/dev/null 2>&1; then
        echo "::error::no valid benchmark JSON in Pod terminationMessage"; exit 1
      fi
      echo "NESSION_OCI_PULL_BENCHMARK_V1 $msg"
      if [[ -n "$GITHUB_STEP_SUMMARY" ]]; then
        {
          echo "### GHCR versus ocicdn — mainland Kubernetes"
          echo "- Pod: $name; node: $node; exit: $code"
          echo '| Role | Origin | Pass | MiB/s | MiB | Result |'
          echo '|---|---|---|---:|---:|---|'
          jq -r '.transfers[] |
            "| \(.role) | \(.via) | \(.pass) | \(.mib_s // "-") | \((.bytes // 0)/1048576 * 100 | round / 100) | \(if .ok then "OK" else (.error // "ERROR") end) |"' <<<"$msg"
        } >>"$GITHUB_STEP_SUMMARY"
      fi
      if [[ "$code" != 0 ]] || ! jq -e '
        .ok == true and (.comparisons | length) == 3 and
        all(.comparisons[]; .same_platform_digest == true)
      ' <<<"$msg" >/dev/null; then
        echo "::error::benchmark failed or digest mismatch; preserve failure evidence"; exit 1
      fi
      echo "Verified two origins, three image roles, identical amd64 manifests and all blobs."
      exit 0
    fi
    if (( attempt % 8 == 0 )); then
      waiting="$(jq -r '.status.containerStatuses[0].state.waiting.reason // empty' <<<"$pod")"
      echo "STAGING_OCICDN_WAIT pod=$name node=$node phase=$phase waiting=$waiting attempt=$attempt"
    fi
  elif (( attempt % 8 == 0 )); then
    echo "STAGING_OCICDN_WAIT no Pod created attempt=$attempt"
  fi
  sleep 15
done
echo "::error::no completed benchmark Job result within 34 minutes"
exit 1
