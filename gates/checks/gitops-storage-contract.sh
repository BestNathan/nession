#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='gitops-storage-contract'
GATE_NAME='GitOps durable EROFS storage contract'
GATE_COMMAND='node scripts/gitops-storage-contract.mjs --root <gitops checkout>'
GATE_SUCCESS='every managed environment renders Server registry/blobs and the Agent cache under its own persisted NFS PV/PVC/subPath'
GATE_FAILURE='a managed environment lost its durable data mount, rendered an ephemeral volume, or reused/replaced another environment storage identity'
GATE_REPAIR='restore NESSION_HOME and AGENT_EROFS_STORAGE_DIR under /data, mount that volume from the environment NFS PVC/PV, and keep each environment root distinct'
GATE_OWNER='gitops branch base/nession + environments/*/nession, checked by scripts/gitops-storage-contract.mjs'

gate_check() {
  gate_require_command node "Install Node.js to run the GitOps storage contract." || return $?
  gate_require_command git "Install Git to read the gitops deployment branch." || return $?
  gate_require_command tar "Install tar to extract the gitops deployment branch." || return $?
  local root
  root="$(mktemp -d "${TMPDIR:-/tmp}/gitops-storage.XXXXXX")" || {
    gate_runtime_error "cannot create a temporary directory for the gitops tree" \
      "ensure TMPDIR is writable, then rerun"
    return 2
  }
  local status=0
  if ! git rev-parse --verify --quiet origin/gitops >/dev/null 2>&1; then
    if ! git fetch --no-tags --depth=1 origin gitops >/dev/null 2>&1; then
      rm -rf "$root"
      gate_runtime_error \
        "cannot read the gitops deployment branch" \
        "fetch origin gitops (the deployment-state owner) and rerun the gate"
      return 2
    fi
  fi
  git archive --format=tar origin/gitops | tar -xf - -C "$root" || status=$?
  if [ "$status" -eq 0 ]; then
    node scripts/gitops-storage-contract.mjs --root "$root" || status=$?
  fi
  rm -rf "$root"
  case "$status" in
    0) return 0 ;;
    1)
      gate_invariant_failure "$GATE_FAILURE" "$GATE_REPAIR"
      return 1
      ;;
    *)
      gate_runtime_error \
        "the GitOps storage contract command exited with status ${status}; the invariant could not be proven" \
        "repair the command/tooling failure shown in output, then rerun the exact gate"
      return 2
      ;;
  esac
}

gate_main "$@"
