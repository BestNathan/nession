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

capture 2 "$TMP_DIR/invalid-suite.out" "$TMP_DIR/repo/gates/run" --suite '../bad'
assert_contains "$TMP_DIR/invalid-suite.out" '[ERROR] invalid suite name: ../bad'

capture 2 "$TMP_DIR/unknown.out" "$TMP_DIR/repo/gates/run" missing
assert_contains "$TMP_DIR/unknown.out" '[ERROR] unknown gate: missing'

capture 0 "$TMP_DIR/list.out" "$TMP_DIR/repo/gates/run" --list
assert_contains "$TMP_DIR/list.out" 'alpha'
assert_contains "$TMP_DIR/list.out" 'beta'
assert_contains "$TMP_DIR/list.out" 'gamma'

capture 0 "$TMP_DIR/describe.out" "$TMP_DIR/repo/gates/run" --describe alpha
assert_contains "$TMP_DIR/describe.out" 'id: alpha'
assert_not_contains "$TMP_DIR/describe.out" 'raw output from alpha'


# #2530: Exercise the REAL e2e-playwright adapter, not just the generic Gate
# status vocabulary. This regression originally passed despite an exit=1 from
# the full Playwright subprocess, because gate_main intentionally runs
# gate_check with errexit disabled and the adapter kept executing.
E2E_FIXTURE="$TMP_DIR/e2e-playwright/repo"
E2E_BIN="$TMP_DIR/e2e-playwright/bin"
mkdir -p "$E2E_FIXTURE/gates/lib" "$E2E_FIXTURE/gates/checks" \
  "$E2E_FIXTURE/e2e/node_modules" "$E2E_FIXTURE/e2e/runner" \
  "$E2E_FIXTURE/web/dist" "$E2E_BIN"
cp "$GATES_DIR/lib/common.sh" "$E2E_FIXTURE/gates/lib/common.sh"
cp "$GATES_DIR/checks/e2e-playwright.sh" "$E2E_FIXTURE/gates/checks/e2e-playwright.sh"
chmod +x "$E2E_FIXTURE/gates/checks/e2e-playwright.sh"
for cmd in cargo tmux node; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$E2E_BIN/$cmd"
  chmod +x "$E2E_BIN/$cmd"
done
cat > "$E2E_BIN/npx" <<'EOF_E2E_NPX'
#!/usr/bin/env bash
printf 'fixture Playwright catalog\n'
EOF_E2E_NPX
chmod +x "$E2E_BIN/npx"
cat > "$E2E_FIXTURE/e2e/run" <<'EOF_E2E_RUN'
#!/usr/bin/env bash
set -euo pipefail
# Deliberately leave convincing-looking evidence behind even on a failed
# Playwright invocation: only the child status can prove the suite passed.
printf '{"stats":{"expected":2,"unexpected":0},"suites":[]}\n' > "$PLAYWRIGHT_JSON_OUTPUT_FILE"
printf '{"tests":[]}\n' > "$NESSION_E2E_ASSERTIONS_OUTPUT_FILE"
printf '{"provisioned":true}\n' >> "$E2E_RUNTIME_PROVISION_LOG"
exit "${E2E_PLAYWRIGHT_FIXTURE_EXIT:-0}"
EOF_E2E_RUN
chmod +x "$E2E_FIXTURE/e2e/run"
# Do not accidentally activate real GitHub receipt generation with the fake
# node helper, and never pass the CI job's own env into an untrusted fixture.
e2e_adapter() {
  env -u GITHUB_REPOSITORY -u GITHUB_STEP_SUMMARY \
    -u E2E_PROVISION_RECEIPT_FILE -u GITHUB_RUN_ID \
    PATH="$E2E_BIN:$PATH" E2E_PLAYWRIGHT_FIXTURE_EXIT="$1" \
    "$E2E_FIXTURE/gates/checks/e2e-playwright.sh"
}
capture 1 "$TMP_DIR/e2e-playwright-fail.out" e2e_adapter 1
assert_contains "$TMP_DIR/e2e-playwright-fail.out" '[FAIL] e2e-playwright'
assert_not_contains "$TMP_DIR/e2e-playwright-fail.out" '✓ e2e-playwright'
capture 2 "$TMP_DIR/e2e-playwright-error.out" e2e_adapter 2
assert_contains "$TMP_DIR/e2e-playwright-error.out" '[ERROR] e2e-playwright'
assert_not_contains "$TMP_DIR/e2e-playwright-error.out" '✓ e2e-playwright'
capture 0 "$TMP_DIR/e2e-playwright-pass.out" e2e_adapter 0
assert_contains "$TMP_DIR/e2e-playwright-pass.out" '✓ e2e-playwright'

printf 'run-selftest: PASS\n'
