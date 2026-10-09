#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='release-version-consistency'
GATE_NAME='Release version consistency'
GATE_COMMAND='bash gates/checks/release-version-consistency.sh'
GATE_SUCCESS='Cargo.toml and web/package.json expose the same release version'
GATE_FAILURE='Rust and Web release versions differ'
GATE_REPAIR='bump Cargo.toml, Cargo.lock, web/package.json, and web/package-lock.json together before release'
GATE_OWNER='.github/workflows/release.yml version-check + repository version files'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  local rust_ver web_ver
  rust_ver="$(awk 'BEGIN{in_ws=0} /^\[workspace.package\]/{in_ws=1; next} /^\[/{if(in_ws) exit} in_ws && /^version[[:space:]]*=/{gsub(/"/,"",$3); print $3; exit}' Cargo.toml)"
  web_ver="$(node -p "require('./web/package.json').version")"
  if [ -z "$rust_ver" ] || [ -z "$web_ver" ]; then
    gate_runtime_error "could not read one or both repository release versions" "restore valid Cargo.toml and web/package.json version fields"
    return 2
  fi
  if [ "$rust_ver" != "$web_ver" ]; then
    gate_invariant_failure "version mismatch: Cargo.toml=$rust_ver, web/package.json=$web_ver" "$GATE_REPAIR"
    return 1
  fi
  return 0
}

gate_main "$@"
