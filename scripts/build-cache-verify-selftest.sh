#!/usr/bin/env bash
# Regression tests for scripts/build-cache-verify.sh.
#
# The target-isolation check is the only part of that script that can FAIL, so
# it is the part that must not silently stop working — a diagnostic that always
# reports "no structural violations" is worse than none. These cases feed it
# known violations through its test seam (NSESSION_VERIFY_WORKTREE_LIST) instead
# of creating one in the real repository.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
verify="$root/scripts/build-cache-verify.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

list="$tmp/worktrees.txt"
outfile="$tmp/out"

fail() {
  echo "build-cache-verify selftest failed: $1" >&2
  echo "  Fix: keep the target-isolation check in scripts/build-cache-verify.sh strict" >&2
  exit 1
}

# Deliberately NOT called in a command substitution: `out=$(run)` would run it
# in a subshell and the exit code would never reach this shell.
rc=0
run() { # extra env assignments in "$@" are applied to the invocation
  set +e
  env NSESSION_VERIFY_WORKTREE_LIST="$list" "$@" "$verify" --isolation-only >"$outfile" 2>&1
  rc=$?
  set -e
}

expect() { # $1 = expected exit, $2 = label
  [ "$rc" -eq "$1" ] || { cat "$outfile" >&2; fail "$2: expected exit $1, got $rc"; }
}

contains() { # $1 = needle, $2 = label
  case "$(cat "$outfile")" in
    *"$1"*) ;;
    *) cat "$outfile" >&2; fail "$2 (missing \"$1\")" ;;
  esac
}

# --- 1. two worktrees, each with its own target -> clean ---------------------
mkdir -p "$tmp/a/target" "$tmp/b/target"
printf '%s\n%s\n' "$tmp/a" "$tmp/b" >"$list"
run
expect 0 "distinct targets"
contains "no structural violations" "distinct targets were not reported clean"

# --- 2. a target that is a symlink -> violation ------------------------------
# This is the failure #986 forbids: two worktrees sharing one target's Cargo
# lock and mutable state.
rm -rf "$tmp/b/target"
ln -s "$tmp/a/target" "$tmp/b/target"
printf '%s\n%s\n' "$tmp/a" "$tmp/b" >"$list"
run
expect 1 "symlinked target"
contains "SYMLINK" "a symlinked target was not reported as a violation"

# --- 3. a whole worktree aliased onto another -> same resolved path ----------
# The symlink is on the parent, so the target path itself is not a symlink and
# only the resolved-path comparison can catch it.
rm -rf "$tmp/b"
ln -s "$tmp/a" "$tmp/b"
printf '%s\n%s\n' "$tmp/a" "$tmp/b" >"$list"
run
expect 1 "aliased worktree"
contains "same path" "two worktrees resolving to one target were not reported"

# --- 4. CARGO_TARGET_DIR collapses every worktree onto one target ------------
rm -f "$tmp/b"
mkdir -p "$tmp/a/target" "$tmp/b/target"
printf '%s\n%s\n' "$tmp/a" "$tmp/b" >"$list"
run CARGO_TARGET_DIR="$tmp/shared"
expect 1 "CARGO_TARGET_DIR"
contains "CARGO_TARGET_DIR is set" "CARGO_TARGET_DIR violation message missing"

# --- 5. a worktree with no target yet is skipped, not a violation ------------
mkdir -p "$tmp/c"
printf '%s\n%s\n%s\n' "$tmp/a" "$tmp/b" "$tmp/c" >"$list"
run
expect 0 "worktree without a target"
contains "no target yet" "a worktree without a target should be skipped, not failed"

echo "build-cache-verify selftest OK ✓ distinct, symlink, alias, CARGO_TARGET_DIR, no-target"
