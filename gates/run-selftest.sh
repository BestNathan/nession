#!/usr/bin/env bash
set -euo pipefail

GATES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nession-gates-run-selftest.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { echo "run-selftest: $*" >&2; exit 1; }
assert_contains() { grep -F -- "$2" "$1" >/dev/null || fail "missing '$2' in: $(cat "$1")"; }
assert_not_contains() { ! grep -F -- "$2" "$1" >/dev/null || fail "unexpected '$2' in: $(cat "$1")"; }

mkdir -p "$TMP_DIR/repo/gates/lib" "$TMP_DIR/repo/gates/checks" "$TMP_DIR/repo/gates/suites"
cp "$GATES_DIR/run" "$TMP_DIR/repo/gates/run"
cp "$GATES_DIR/lib/common.sh" "$TMP_DIR/repo/gates/lib/common.sh"
chmod +x "$TMP_DIR/repo/gates/run"

make_gate() {
  local id="$1" status="$2"
  cat >"$TMP_DIR/repo/gates/checks/${id}.sh" <<EOF_GATE
#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd -P)"
source "\${GATE_DIR}/../lib/common.sh"
GATE_ID="$id"
GATE_NAME="$id fixture"
GATE_COMMAND="fixture $id"
GATE_SUCCESS="$id passed"
GATE_FAILURE="$id failed"
GATE_REPAIR="repair $id"
GATE_OWNER="run-selftest"
gate_check() {
  echo "raw output from $id"
  return $status
}
gate_main "\$@"
EOF_GATE
  chmod +x "$TMP_DIR/repo/gates/checks/${id}.sh"
}

make_gate alpha 0
make_gate beta 1
make_gate gamma 2

cat >"$TMP_DIR/repo/gates/suites/sample.gates" <<'EOF_SUITE'
# preserve order, ignore comments/blank lines, deduplicate by ID
alpha
beta
alpha
EOF_SUITE

capture() {
  local expected="$1" outfile="$2"
  shift 2
  local status=0
  set +e
  (cd / && "$@") >"$outfile" 2>&1
  status=$?
  set -e
  [ "$status" -eq "$expected" ] || fail "expected exit ${expected}, got ${status}; output: $(cat "$outfile")"
}

capture 0 "$TMP_DIR/validate.out" "$TMP_DIR/repo/gates/run" --validate
assert_contains "$TMP_DIR/validate.out" '✓ gate catalog: 3 gates, 1 suites'

cat >"$TMP_DIR/repo/gates/checks/broken.sh" <<'EOF_BROKEN'
#!/usr/bin/env bash
if then
EOF_BROKEN
chmod +x "$TMP_DIR/repo/gates/checks/broken.sh"
capture 2 "$TMP_DIR/syntax.out" "$TMP_DIR/repo/gates/run" --validate
assert_contains "$TMP_DIR/syntax.out" '[ERROR] gate shell syntax invalid: broken'
rm -f "$TMP_DIR/repo/gates/checks/broken.sh"

make_gate nonexec 0
chmod -x "$TMP_DIR/repo/gates/checks/nonexec.sh"
capture 2 "$TMP_DIR/nonexec.out" "$TMP_DIR/repo/gates/run" --validate
assert_contains "$TMP_DIR/nonexec.out" '[ERROR] gate is not executable: nonexec'
rm -f "$TMP_DIR/repo/gates/checks/nonexec.sh"

capture 0 "$TMP_DIR/suites.out" "$TMP_DIR/repo/gates/run" --list-suites
assert_contains "$TMP_DIR/suites.out" 'sample'

capture 1 "$TMP_DIR/suite.out" "$TMP_DIR/repo/gates/run" --suite sample
assert_contains "$TMP_DIR/suite.out" '✓ alpha'
assert_contains "$TMP_DIR/suite.out" '✗ beta'
assert_contains "$TMP_DIR/suite.out" '2 gates: 1 passed, 1 failed, 0 errors'
assert_contains "$TMP_DIR/suite.out" '[FAIL] beta'
assert_contains "$TMP_DIR/suite.out" 'raw output from beta'
assert_not_contains "$TMP_DIR/suite.out" 'raw output from alpha'

capture 2 "$TMP_DIR/error.out" "$TMP_DIR/repo/gates/run" alpha gamma
assert_contains "$TMP_DIR/error.out" '✓ alpha'
assert_contains "$TMP_DIR/error.out" '! gamma'
assert_contains "$TMP_DIR/error.out" '2 gates: 1 passed, 0 failed, 1 errors'
assert_contains "$TMP_DIR/error.out" '[ERROR] gamma'

capture 2 "$TMP_DIR/unknown.out" "$TMP_DIR/repo/gates/run" missing
assert_contains "$TMP_DIR/unknown.out" '[ERROR] unknown gate: missing'

capture 0 "$TMP_DIR/list.out" "$TMP_DIR/repo/gates/run" --list
assert_contains "$TMP_DIR/list.out" 'alpha'
assert_contains "$TMP_DIR/list.out" 'beta'
assert_contains "$TMP_DIR/list.out" 'gamma'

capture 0 "$TMP_DIR/describe.out" "$TMP_DIR/repo/gates/run" --describe alpha
assert_contains "$TMP_DIR/describe.out" 'id: alpha'
assert_not_contains "$TMP_DIR/describe.out" 'raw output from alpha'

printf 'run-selftest: PASS\n'
