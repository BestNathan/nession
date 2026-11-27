#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='gitops-tls-contract'
GATE_NAME='GitOps certificate ownership and retirement readiness contract'
GATE_COMMAND='node scripts/gitops-tls-contract.mjs --root <gitops checkout>'
GATE_SUCCESS='Nession declares no competing issuer/Certificate/cert-manager or duplicate Secret writer, and legacy TLS retirement/consumption switch stays blocked until a cutover readback receipt is recorded'
GATE_FAILURE='Nession grew a competing certificate writer, or legacy TLS was retired/switched without a recorded cutover readback receipt'
GATE_REPAIR='remove the competing issuer/Certificate/Secret writer (nitops owns issuance), and record a valid sanitized cutover readback receipt before retiring or switching legacy TLS; rollback to legacy needs no receipt'
GATE_OWNER='gitops branch TLS desired state + docs/engineering/receipts, checked by scripts/gitops-tls-contract.mjs (#4588)'

gate_check() {
  gate_require_command node "Install Node.js to run the GitOps TLS contract." || return $?
  gate_require_command git "Install Git to read the gitops deployment branch." || return $?
  gate_require_command tar "Install tar to extract the gitops deployment branch." || return $?
  local root
  root="$(mktemp -d "${TMPDIR:-/tmp}/gitops-tls.XXXXXX")" || {
    gate_runtime_error "cannot create a temporary directory for the gitops tree" \
      "ensure TMPDIR is writable, then rerun"
    return 2
  }
  local status=0
  if ! git rev-parse --verify --quiet origin/gitops >/dev/null 2>&1; then
    if ! git fetch --no-tags --depth=1 origin \
      gitops:refs/remotes/origin/gitops >/dev/null 2>&1; then
      rm -rf "$root"
      gate_runtime_error \
        "cannot read the gitops deployment branch" \
        "fetch origin gitops (the deployment-state owner) and rerun the gate"
      return 2
    fi
  fi
  git archive --format=tar origin/gitops | tar -xf - -C "$root" || status=$?
  if [ "$status" -eq 0 ]; then
    node scripts/gitops-tls-contract.mjs --root "$root" || status=$?
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
        "the GitOps TLS contract command exited with status ${status}; the invariant could not be proven" \
        "repair the command/tooling failure shown in output, then rerun the exact gate"
      return 2
      ;;
  esac
}

gate_main "$@"
