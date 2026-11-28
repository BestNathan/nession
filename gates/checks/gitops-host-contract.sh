#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='gitops-host-contract'
GATE_NAME='GitOps canonical hostname contract'
GATE_COMMAND='node scripts/gitops-host-contract.mjs --root <gitops checkout>'
GATE_SUCCESS='every managed environment renders canonical single-label bestnathan.top hosts, correct env backends, preserved nhome.local routes, canonical HTTPS/WSS config, and dormant MCP inactive'
GATE_FAILURE='a managed environment lost its canonical host, rendered a wrong backend or foreign zone, changed nhome.local, downgraded secure transport, or activated a dormant MCP service'
GATE_REPAIR='restore the canonical single-label host and correct environment backend in base/env ingress, keep nhome.local verbatim, name canonical HTTPS origins and WSS advertise endpoints, and leave dormant MCP unenrolled'
GATE_OWNER='gitops branch base/nession + environments/*/nession, checked by scripts/gitops-host-contract.mjs (#4588)'

gate_check() {
  gate_require_command node "Install Node.js to run the GitOps hostname contract." || return $?
  gate_require_command git "Install Git to read the gitops deployment branch." || return $?
  gate_require_command tar "Install tar to extract the gitops deployment branch." || return $?
  local root
  root="$(mktemp -d "${TMPDIR:-/tmp}/gitops-hosts.XXXXXX")" || {
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
    node scripts/gitops-host-contract.mjs --root "$root" || status=$?
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
        "the GitOps hostname contract command exited with status ${status}; the invariant could not be proven" \
        "repair the command/tooling failure shown in output, then rerun the exact gate"
      return 2
      ;;
  esac
}

gate_main "$@"
