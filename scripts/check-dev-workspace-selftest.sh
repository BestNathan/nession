#!/usr/bin/env bash
# Exercise the real workspace policy against isolated Git repositories/worktrees.
# No mutation or Git configuration is made to the invoking repository.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(mktemp -d /tmp/nession-workspace-selftest.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/root"
LINKED="$TMP/linked"
mkdir -p "$REPO" "$TMP/outside"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.name "Nession Workspace Selftest"
git -C "$REPO" config user.email "workspace-test@nession.local"
git -C "$REPO" config commit.gpgsign false
printf 'baseline\n' > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -q -m baseline
git -C "$REPO" worktree add -q -b fix/workspace-fixture "$LINKED" HEAD

CASES=0
expect() {
  local status_wanted="$1" substring="$2" directory="$3" mode="$4" result=0
  (cd "$directory" && bash "$ROOT/scripts/check-dev-workspace.sh" "$mode") >"$TMP/out" 2>&1 || result=$?
  if [ "$result" -ne "$status_wanted" ] || ! grep -Fq "$substring" "$TMP/out"; then
    echo "workspace selftest failed: expected status=$status_wanted /$substring/ at $directory mode=$mode; got status=$result" >&2
    cat "$TMP/out" >&2
    exit 1
  fi
  CASES=$((CASES+1))
}
expect 1 'cannot commit from project root' "$REPO" commit
expect 1 'cannot push from project root' "$REPO" push
expect 0 'project root on main' "$REPO" session
expect 0 'developing in linked worktree' "$LINKED" session
expect 0 '' "$LINKED" commit
expect 0 '' "$LINKED" push

git -C "$LINKED" checkout -q --detach
expect 1 'detached HEAD' "$LINKED" commit
expect 1 'detached HEAD' "$LINKED" push
git -C "$LINKED" checkout -q fix/workspace-fixture

# A dirty root is only a warning in normal session mode; strict mode blocks it.
printf 'dirty\n' >> "$REPO/README.md"
expect 0 'project root has uncommitted changes' "$REPO" session
(cd "$REPO" && bash "$ROOT/scripts/check-dev-workspace.sh" session --strict) >"$TMP/out" 2>&1 && {
  echo "workspace selftest: strict dirty-root session incorrectly passed" >&2
  exit 1
}
grep -Fq 'project root has uncommitted changes' "$TMP/out"
CASES=$((CASES+1))
expect 1 'not inside a git repository' "$TMP/outside" commit
expect 2 'Usage:' "$LINKED" invalid-mode
echo "dev-workspace-selftest: $CASES isolated positive/negative cases passed"
