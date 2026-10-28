#!/usr/bin/env bash
# Prove scripts/check-coverage.sh tells a failed Rust test run apart from a
# missing coverage tool. Both produce no coverage JSON; only one of them is
# fixed by `cargo install`.
#
# Two injected cases, each with the signature the real command emits:
#   - a libtest failure (exit 101, `test ... FAILED`, `test result: FAILED`)
#     must be reported as a test failure and must not suggest installing;
#   - a tool absence (exit 101, `no such command: llvm-cov`) must keep the
#     install guidance.
# The detector's negative case proves the classification is not just "any
# stderr becomes a test failure".
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/nession-coverage-selftest.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

FAKEBIN="$TMP/bin"
mkdir -p "$FAKEBIN"
SOCKET="$TMP/run/tmux.sock"
mkdir -p "$TMP/run"

pass=0
fail=0

write_cargo() {
    # $1 = body after the shebang
    printf '#!/bin/sh\n%s\n' "$1" >"$FAKEBIN/cargo"
    chmod +x "$FAKEBIN/cargo"
}

run_check() {
    # An inherited socket keeps tmux-run-socket.sh from creating (and then
    # trying to clean) a run directory this selftest does not own.
    PATH="$FAKEBIN:$PATH" NESSION_TMUX_SOCKET="$SOCKET" \
        bash "$ROOT/scripts/check-coverage.sh" 2>&1
}

expect_contains() {
    local name="$1" needle="$2" output="$3"
    if grep -qF "$needle" <<<"$output"; then
        echo "  ✓ $name"
        pass=$((pass + 1))
    else
        echo "  ✗ MISSED: $name (expected to contain '$needle')"
        echo "$output" | sed 's/^/      /'
        fail=$((fail + 1))
    fi
}

expect_not_contains() {
    local name="$1" needle="$2" output="$3"
    if grep -qF "$needle" <<<"$output"; then
        echo "  ✗ WRONG: $name (must not contain '$needle')"
        echo "$output" | sed 's/^/      /'
        fail=$((fail + 1))
    else
        echo "  ✓ $name"
        pass=$((pass + 1))
    fi
}

echo "→ a failed test run is reported as a test failure"
write_cargo 'echo "test server::probe_failure ... FAILED" >&2
echo "test result: FAILED. 1 passed; 2 failed; 0 ignored" >&2
exit 101'
out="$(run_check)"
expect_contains "names the test failure" "Rust tests failed" "$out"
expect_contains "names the failing test" "server::probe_failure" "$out"
expect_not_contains "does not suggest installing" "cargo install cargo-llvm-cov" "$out"

echo "→ a missing tool keeps the install guidance"
write_cargo 'echo "error: no such command: \`llvm-cov\`" >&2
exit 101'
out="$(run_check)"
expect_contains "reports the tool boundary" "not installed or failed to run" "$out"
expect_contains "suggests the install" "cargo install cargo-llvm-cov" "$out"
expect_not_contains "does not claim a test failure" "Rust tests failed" "$out"

echo
if [ "$fail" -ne 0 ]; then
    echo "check-coverage selftest: $fail failed, $pass passed"
    exit 1
fi
echo "check-coverage selftest: $pass passed"
