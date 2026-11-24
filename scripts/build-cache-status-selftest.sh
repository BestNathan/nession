#!/usr/bin/env bash
# Regression tests for scripts/build-cache-status.sh (#4469).
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
status="$root/scripts/build-cache-status.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

bin="$tmp/bin"
mkdir -p "$bin"
cat >"$bin/git" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "rev-parse" ] && [ "${2:-}" = "--show-toplevel" ]; then
  printf '%s\n' "$NSESSION_TEST_STATUS_ROOT"
  exit 0
fi
if [ "${1:-}" = "-C" ] && [ "${3:-}" = "worktree" ] && [ "${4:-}" = "list" ]; then
  printf 'worktree %s\n' "$NSESSION_TEST_STATUS_MAIN"
  if [ -n "${NSESSION_TEST_STATUS_BASE:-}" ]; then
    printf 'worktree %s\n' "$NSESSION_TEST_STATUS_BASE"
  fi
  printf 'worktree %s\n' "$NSESSION_TEST_STATUS_ROOT"
  exit 0
fi
echo "unexpected fake git call: $*" >&2
exit 1
EOF
cat >"$bin/sccache" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--show-stats" ]; then
  printf 'Cache hits                           0\n'
  printf 'Cache misses                         0\n'
  exit 0
fi
exit 0
EOF
chmod +x "$bin"/*

suite_index=0
pass_test() {
  suite_index=$((suite_index + 1))
  printf 'ok %d - %s\n' "$suite_index" "$1"
}
fail_test() {
  echo "not ok - $1" >&2
  echo "  $2" >&2
  exit 1
}
assert_eq() { [ "$1" = "$2" ] || fail_test "$3" "expected [$2], got [$1]"; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail_test "$3" "missing [$2] in: $1" ;; esac; }

rootdir="$tmp/root"
maindir="$tmp/main"
base="$maindir/.claude/worktrees/_seed-base"
mkdir -p "$rootdir" "$base/target/deps"
printf 'lock\n' >"$rootdir/Cargo.lock"
printf 'toolchain\n' >"$rootdir/rust-toolchain.toml"
printf 'lock\n' >"$maindir/Cargo.lock"
printf 'toolchain\n' >"$maindir/rust-toolchain.toml"
printf 'lock\n' >"$base/Cargo.lock"
printf 'toolchain\n' >"$base/rust-toolchain.toml"
printf 'dependency\n' >"$base/target/deps/artifact"

status_base="$base"
run_status() {
  set +e
  out=$(env PATH="$bin:/usr/bin:/bin" \
    NSESSION_TEST_STATUS_ROOT="$rootdir" \
    NSESSION_TEST_STATUS_MAIN="$maindir" \
    NSESSION_TEST_STATUS_BASE="$status_base" \
    bash "$status" 2>"$tmp/stderr")
  rc=$?
  set -e
}

unset NSESSION_SEED_SOURCE
run_status
assert_eq "$rc" 0 'status exits 0 with a warm base'
assert_contains "$out" "dedicated seed base: available ($base/target)" 'status reports the warm base'
assert_contains "$out" "resolved seed source: $base (dedicated seed base)" 'status resolves the base'
assert_contains "$out" 'seed source compatibility: compatible' 'status reports compatible inputs'
pass_test 'status reports a warm compatible dedicated base'

rm -rf "$base/target"
run_status
assert_eq "$rc" 0 'status exits 0 without a base target'
assert_contains "$out" "dedicated seed base: unavailable (no target/ at $base)" 'status reports the missing base target'
assert_contains "$out" "resolved seed source: $maindir (main fallback; no target/)" 'status shows the main fallback'
assert_contains "$out" 'New worktrees will start cold' 'status explains the cold start'
assert_contains "$out" 'just seed-worktree-base' 'status offers the base refresh'
pass_test 'status distinguishes a missing base from a usable main fallback'

mkdir -p "$base/target/deps"
printf 'different-lock\n' >"$base/Cargo.lock"
run_status
assert_eq "$rc" 0 'status exits 0 with an incompatible base'
assert_contains "$out" 'seed source compatibility: Cargo.lock differs' 'status reports the incompatible lock'
assert_contains "$out" 'refresh the dedicated base: just seed-worktree-base' 'status offers the base refresh for staleness'
pass_test 'status reports an incompatible dedicated base'

status_base=''
run_status
assert_eq "$rc" 0 'status exits 0 with an unregistered base'
assert_contains "$out" "dedicated seed base: unavailable (not registered at $base)" 'status rejects an unregistered base path'
assert_contains "$out" 'remove the stale path' 'status names the unregistered-base fix'
assert_contains "$out" "resolved seed source: $maindir (main fallback; no target/)" 'status does not use an unregistered base'
status_base="$base"
pass_test 'status rejects an unregistered base path'

rm -rf "$base"
status_base=''
run_status
assert_eq "$rc" 0 'status exits 0 with a missing base'
assert_contains "$out" "dedicated seed base: unavailable (missing at $base)" 'status distinguishes a missing base'
assert_contains "$out" 'Fix: just seed-worktree-base' 'status offers the missing-base fix'
assert_contains "$out" "resolved seed source: $maindir (main fallback; no target/)" 'status falls back to main when the base is missing'
status_base="$base"
pass_test 'status distinguishes a missing base'

unset NSESSION_SEED_SOURCE
NSESSION_SEED_SOURCE='relative/path' run_status
assert_eq "$rc" 0 'status exits 0 with an invalid explicit source'
assert_contains "$out" 'resolved seed source: unavailable (NSESSION_SEED_SOURCE must be an absolute path' 'status reports the invalid explicit source'
assert_contains "$out" 'unset NSESSION_SEED_SOURCE' 'status names the fix for the invalid source'
pass_test 'status reports an invalid explicit source'

echo "build-cache-status selftest OK ✓ warm base, missing base, incompatible base, invalid explicit source"
