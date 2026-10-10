#!/usr/bin/env bash
set -euo pipefail

SELFTEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
COMMON="${SELFTEST_DIR}/common.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nession-gate-contract.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { echo "common-selftest: $*" >&2; exit 1; }

make_gate() {
  local path="$1"
  local behavior="$2"
  cat >"$path" <<EOF_GATE
#!/usr/bin/env bash
set -euo pipefail
source "$COMMON"
GATE_ID="fixture-gate"
GATE_NAME="Fixture gate"
GATE_COMMAND="fixture-command --check"
GATE_SUCCESS="fixture invariant holds"
GATE_FAILURE="fixture invariant is false"
GATE_REPAIR="repair the fixture"
GATE_OWNER="gates/lib/common-selftest.sh"
gate_check() {
  echo "fixture raw output"
  $behavior
}
gate_main "\$@"
EOF_GATE
  chmod +x "$path"
}

run_capture() {
  local expected="$1" outfile="$2"
  shift 2
  local status=0
  set +e
  (cd / && "$@") >"$outfile" 2>&1
  status=$?
  set -e
  [ "$status" -eq "$expected" ] || fail "expected exit ${expected}, got ${status}; output: $(cat "$outfile")"
}

assert_contains() { grep -F -- "$2" "$1" >/dev/null || fail "missing '$2' in: $(cat "$1")"; }
assert_not_contains() { ! grep -F -- "$2" "$1" >/dev/null || fail "unexpected '$2' in: $(cat "$1")"; }

PASS_GATE="$TMP_DIR/pass.sh"
FAIL_GATE="$TMP_DIR/fail.sh"
ERROR_GATE="$TMP_DIR/error.sh"
make_gate "$PASS_GATE" 'return 0'
make_gate "$FAIL_GATE" 'gate_invariant_failure "fixture violation detected" "fix the fixture violation"'
make_gate "$ERROR_GATE" 'gate_runtime_error "fixture tool is unavailable" "install the fixture tool"'
make_gate "$TMP_DIR/command-fail.sh" 'gate_run_invariant bash -c "exit 1"'
make_gate "$TMP_DIR/cargo-fail.sh" 'gate_run_invariant bash -c "exit 101"'
make_gate "$TMP_DIR/command-error.sh" 'gate_run_invariant bash -c "exit 2"'
make_gate "$TMP_DIR/command-missing.sh" 'gate_run_invariant definitely-nonexistent-nession-command'

run_capture 0 "$TMP_DIR/pass.out" "$PASS_GATE"
assert_contains "$TMP_DIR/pass.out" '✓ fixture-gate'
assert_not_contains "$TMP_DIR/pass.out" 'fixture raw output'

run_capture 1 "$TMP_DIR/fail.out" "$FAIL_GATE"
assert_contains "$TMP_DIR/fail.out" '[FAIL] fixture-gate'
assert_contains "$TMP_DIR/fail.out" 'reason: fixture violation detected'
assert_contains "$TMP_DIR/fail.out" 'repair: fix the fixture violation'
assert_contains "$TMP_DIR/fail.out" 'fixture raw output'

run_capture 2 "$TMP_DIR/error.out" "$ERROR_GATE"
assert_contains "$TMP_DIR/error.out" '[ERROR] fixture-gate'
assert_contains "$TMP_DIR/error.out" 'reason: fixture tool is unavailable'
assert_contains "$TMP_DIR/error.out" 'repair: install the fixture tool'
assert_contains "$TMP_DIR/error.out" 'fixture raw output'

run_capture 1 "$TMP_DIR/command-fail.out" "$TMP_DIR/command-fail.sh"
assert_contains "$TMP_DIR/command-fail.out" '[FAIL] fixture-gate'
run_capture 1 "$TMP_DIR/cargo-fail.out" "$TMP_DIR/cargo-fail.sh"
assert_contains "$TMP_DIR/cargo-fail.out" '[FAIL] fixture-gate'
run_capture 2 "$TMP_DIR/command-error.out" "$TMP_DIR/command-error.sh"
assert_contains "$TMP_DIR/command-error.out" '[ERROR] fixture-gate'
assert_contains "$TMP_DIR/command-error.out" 'command exited with status 2'
assert_contains "$TMP_DIR/command-error.out" 'repair the command/tooling failure'
run_capture 2 "$TMP_DIR/command-missing.out" "$TMP_DIR/command-missing.sh"
assert_contains "$TMP_DIR/command-missing.out" '[ERROR] fixture-gate'
assert_contains "$TMP_DIR/command-missing.out" 'command exited with status 127'
assert_contains "$TMP_DIR/command-missing.out" 'definitely-nonexistent-nession-command'

run_capture 0 "$TMP_DIR/describe.out" "$PASS_GATE" --describe
assert_contains "$TMP_DIR/describe.out" 'id: fixture-gate'
assert_not_contains "$TMP_DIR/describe.out" 'fixture raw output'

printf 'common-selftest: PASS\n'
