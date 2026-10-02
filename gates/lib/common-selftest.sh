#!/usr/bin/env bash
set -euo pipefail

SELFTEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
COMMON="${SELFTEST_DIR}/common.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nession-gate-contract.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "common-selftest: $*" >&2
  exit 1
}

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
  $behavior
}
gate_main "\$@"
EOF_GATE
  chmod +x "$path"
}

run_capture() {
  local expected="$1"
  local outfile="$2"
  shift 2
  local status=0
  set +e
  (cd / && "$@") >"$outfile" 2>&1
  status=$?
  set -e
  [ "$status" -eq "$expected" ] || fail "expected exit ${expected}, got ${status}; output: $(cat "$outfile")"
}

assert_contains() {
  local file="$1"
  local text="$2"
  grep -F -- "$text" "$file" >/dev/null || fail "missing '${text}' in: $(cat "$file")"
}

PASS_GATE="$TMP_DIR/pass.sh"
FAIL_GATE="$TMP_DIR/fail.sh"
ERROR_GATE="$TMP_DIR/error.sh"
INVALID_GATE="$TMP_DIR/invalid.sh"

make_gate "$PASS_GATE" 'return 0'
make_gate "$FAIL_GATE" 'gate_invariant_failure "fixture violation detected" "fix the fixture violation"'
make_gate "$ERROR_GATE" 'gate_runtime_error "fixture tool is unavailable" "install the fixture tool"'

cat >"$INVALID_GATE" <<EOF_INVALID
#!/usr/bin/env bash
set -euo pipefail
source "$COMMON"
GATE_ID="fixture-gate"
GATE_NAME="Fixture gate"
GATE_COMMAND="fixture-command --check"
GATE_SUCCESS="fixture invariant holds"
GATE_FAILURE="fixture invariant is false"
GATE_REPAIR="repair the fixture"
gate_check() { return 0; }
gate_main "\$@"
EOF_INVALID
chmod +x "$INVALID_GATE"

run_capture 0 "$TMP_DIR/pass.out" "$PASS_GATE"
assert_contains "$TMP_DIR/pass.out" '[GATE] fixture-gate'
assert_contains "$TMP_DIR/pass.out" '[PASS] fixture-gate'
assert_contains "$TMP_DIR/pass.out" 'success: fixture invariant holds'

run_capture 1 "$TMP_DIR/fail.out" "$FAIL_GATE"
assert_contains "$TMP_DIR/fail.out" '[FAIL] fixture-gate'
assert_contains "$TMP_DIR/fail.out" 'reason: fixture violation detected'
assert_contains "$TMP_DIR/fail.out" 'repair: fix the fixture violation'

run_capture 2 "$TMP_DIR/error.out" "$ERROR_GATE"
assert_contains "$TMP_DIR/error.out" '[ERROR] fixture-gate'
assert_contains "$TMP_DIR/error.out" 'reason: fixture tool is unavailable'
assert_contains "$TMP_DIR/error.out" 'repair: install the fixture tool'

run_capture 0 "$TMP_DIR/describe.out" "$PASS_GATE" --describe
assert_contains "$TMP_DIR/describe.out" 'id: fixture-gate'
assert_contains "$TMP_DIR/describe.out" 'command: fixture-command --check'
if grep -F '[GATE]' "$TMP_DIR/describe.out" >/dev/null; then
  fail '--describe must not execute the gate'
fi

run_capture 2 "$TMP_DIR/invalid.out" "$INVALID_GATE"
assert_contains "$TMP_DIR/invalid.out" '[ERROR] fixture-gate'
assert_contains "$TMP_DIR/invalid.out" 'missing required gate metadata: GATE_OWNER'

printf 'common-selftest: PASS\n'
