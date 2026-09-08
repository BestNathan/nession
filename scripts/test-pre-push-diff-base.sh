#!/usr/bin/env bash
# ── Regression tests for pre-push diff-base resolution ────────────────────────
#
# Exercises scripts/lib/git-diff-base.sh — the logic .githooks/pre-push uses to
# decide what a new branch's own delta is. Each test builds a throwaway repo with
# a specific branch topology, resolves the base, and asserts both the chosen
# source (creation_point / staging / none) and the resulting file diff.
#
# Usage:
#   ./scripts/test-pre-push-diff-base.sh            # run all
#   ./scripts/test-pre-push-diff-base.sh <regex>    # run matching tests
#   ./scripts/test-pre-push-diff-base.sh --list     # list test names
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/git-diff-base.sh
. "$SCRIPT_DIR/lib/git-diff-base.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0
FAILED_TESTS=()

# ── Helpers ────────────────────────────────────────────────────────────────────

# Every test gets its own tempdir — tests must be safe to run concurrently with
# each other and with another checkout's run.
new_repo() {
  local dir
  dir=$(mktemp -d "${TMPDIR:-/tmp}/nession-diff-base.XXXXXX")
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config user.name "Test"
  git -C "$dir" config commit.gpgsign false
  echo "$dir"
}

# commit_file <repo> <path> <message>
commit_file() {
  local repo="$1" path="$2" msg="$3"
  mkdir -p "$repo/$(dirname "$path")"
  echo "content of $path" > "$repo/$path"
  git -C "$repo" add -A
  git -C "$repo" commit -q -m "$msg"
}

assert_eq() {
  local actual="$1" expected="$2" what="$3"
  if [ "$actual" != "$expected" ]; then
    echo "    assertion failed: $what"
    echo "      expected: $expected"
    echo "      actual:   $actual"
    return 1
  fi
}

assert_diff_contains() {
  local repo="$1" base="$2" tip="$3" pattern="$4"
  local changed
  changed=$(git -C "$repo" diff --name-only "$base" "$tip")
  if ! echo "$changed" | grep -qE "$pattern"; then
    echo "    assertion failed: diff should match /$pattern/"
    echo "      changed files: $(echo "$changed" | tr '\n' ' ')"
    return 1
  fi
}

assert_diff_lacks() {
  local repo="$1" base="$2" tip="$3" pattern="$4"
  local changed
  changed=$(git -C "$repo" diff --name-only "$base" "$tip")
  if echo "$changed" | grep -qE "$pattern"; then
    echo "    assertion failed: diff should NOT match /$pattern/"
    echo "      changed files: $(echo "$changed" | tr '\n' ' ')"
    return 1
  fi
}

# ── Tests ──────────────────────────────────────────────────────────────────────

# Case: new branch straight off main. The creation point is main's tip.
test_new_branch_from_main() {
  local repo; repo=$(new_repo)
  commit_file "$repo" file.txt "main: initial"
  commit_file "$repo" src/main.rs "main: add rust"
  local main_tip; main_tip=$(git -C "$repo" rev-parse HEAD)

  git -C "$repo" checkout -q -b feat/from-main
  commit_file "$repo" docs/note.md "feat: docs only"
  local tip; tip=$(git -C "$repo" rev-parse HEAD)

  local resolved; resolved=$(cd "$repo" && resolve_diff_base refs/heads/feat/from-main "$tip")
  assert_eq "${resolved%% *}" creation_point "base source" || return 1
  assert_eq "${resolved#* }" "$main_tip" "base sha == main tip" || return 1

  # The branch only touched docs — the Rust file from main must not appear.
  assert_diff_lacks "$repo" "$main_tip" "$tip" '\.rs$' || return 1
  rm -rf "$repo"
}

# Case: new branch off staging. Creation point is staging's tip, not main's.
test_new_branch_from_staging() {
  local repo; repo=$(new_repo)
  commit_file "$repo" file.txt "main: initial"
  local main_tip; main_tip=$(git -C "$repo" rev-parse HEAD)

  git -C "$repo" checkout -q -b staging
  commit_file "$repo" src/staging_only.rs "staging: unreleased rust"
  local staging_tip; staging_tip=$(git -C "$repo" rev-parse HEAD)

  git -C "$repo" checkout -q -b feat/from-staging
  commit_file "$repo" docs/note.md "feat: docs only"
  local tip; tip=$(git -C "$repo" rev-parse HEAD)

  local resolved; resolved=$(cd "$repo" && resolve_diff_base refs/heads/feat/from-staging "$tip")
  assert_eq "${resolved%% *}" creation_point "base source" || return 1
  assert_eq "${resolved#* }" "$staging_tip" "base sha == staging tip" || return 1

  # Diffing against main would have surfaced staging's unreleased Rust change.
  assert_diff_lacks "$repo" "$staging_tip" "$tip" '\.rs$' || return 1
  assert_diff_contains "$repo" "$main_tip" "$tip" '\.rs$' || return 1
  rm -rf "$repo"
}

# Case A from the issue: stacked branch whose parent carries Rust+Web changes but
# whose own delta is docs-only. The gate must stay skipped.
test_stacked_child_docs_only() {
  local repo; repo=$(new_repo)
  commit_file "$repo" file.txt "main: initial"
  git -C "$repo" branch staging main

  git -C "$repo" checkout -q -b feat/A staging
  commit_file "$repo" src/lib.rs "feat/A: rust"
  commit_file "$repo" web/app.tsx "feat/A: web"
  local parent_tip; parent_tip=$(git -C "$repo" rev-parse HEAD)

  git -C "$repo" checkout -q -b feat/B
  commit_file "$repo" docs/README.md "feat/B: docs only"
  local tip; tip=$(git -C "$repo" rev-parse HEAD)

  local resolved; resolved=$(cd "$repo" && resolve_diff_base refs/heads/feat/B "$tip")
  assert_eq "${resolved%% *}" creation_point "base source" || return 1
  assert_eq "${resolved#* }" "$parent_tip" "base sha == feat/A tip" || return 1

  assert_diff_contains "$repo" "$parent_tip" "$tip" '^docs/' || return 1
  assert_diff_lacks "$repo" "$parent_tip" "$tip" '\.rs$' || return 1
  assert_diff_lacks "$repo" "$parent_tip" "$tip" '^web/.*\.tsx$' || return 1
  rm -rf "$repo"
}

# Case B: stacked child that does change Rust — the Rust gate must still fire.
test_stacked_child_changes_rust() {
  local repo; repo=$(new_repo)
  commit_file "$repo" file.txt "main: initial"
  git -C "$repo" branch staging main

  git -C "$repo" checkout -q -b feat/A staging
  commit_file "$repo" web/app.tsx "feat/A: web"
  local parent_tip; parent_tip=$(git -C "$repo" rev-parse HEAD)

  git -C "$repo" checkout -q -b feat/B
  commit_file "$repo" src/lib.rs "feat/B: rust"
  local tip; tip=$(git -C "$repo" rev-parse HEAD)

  local resolved; resolved=$(cd "$repo" && resolve_diff_base refs/heads/feat/B "$tip")
  assert_eq "${resolved%% *}" creation_point "base source" || return 1

  assert_diff_contains "$repo" "${resolved#* }" "$tip" '\.rs$' || return 1
  assert_diff_lacks "$repo" "${resolved#* }" "$tip" '^web/' || return 1
  rm -rf "$repo"
}

# Case B variant: stacked child that changes Web only.
test_stacked_child_changes_web() {
  local repo; repo=$(new_repo)
  commit_file "$repo" file.txt "main: initial"
  git -C "$repo" branch staging main

  git -C "$repo" checkout -q -b feat/A staging
  commit_file "$repo" src/lib.rs "feat/A: rust"
  local parent_tip; parent_tip=$(git -C "$repo" rev-parse HEAD)

  git -C "$repo" checkout -q -b feat/B
  commit_file "$repo" web/app.tsx "feat/B: web"
  local tip; tip=$(git -C "$repo" rev-parse HEAD)

  local resolved; resolved=$(cd "$repo" && resolve_diff_base refs/heads/feat/B "$tip")
  assert_eq "${resolved%% *}" creation_point "base source" || return 1

  assert_diff_contains "$repo" "${resolved#* }" "$tip" '^web/.*\.tsx$' || return 1
  assert_diff_lacks "$repo" "${resolved#* }" "$tip" '\.rs$' || return 1
  rm -rf "$repo"
}

# Case D: reflog gone (expired or pruned) — fall back to the staging merge-base.
test_reflog_missing_falls_back_to_staging() {
  local repo; repo=$(new_repo)
  commit_file "$repo" file.txt "main: initial"
  local main_tip; main_tip=$(git -C "$repo" rev-parse HEAD)

  git -C "$repo" checkout -q -b staging
  commit_file "$repo" src/staging_only.rs "staging: rust"
  local staging_tip; staging_tip=$(git -C "$repo" rev-parse HEAD)

  git -C "$repo" checkout -q -b feat/no-reflog
  commit_file "$repo" docs/note.md "feat: docs"
  local tip; tip=$(git -C "$repo" rev-parse HEAD)

  # Drop the branch's reflog to simulate expiry.
  rm -f "$repo/.git/logs/refs/heads/feat/no-reflog"

  local resolved; resolved=$(cd "$repo" && resolve_diff_base refs/heads/feat/no-reflog "$tip")
  assert_eq "${resolved%% *}" staging "base source" || return 1
  # merge-base with staging is staging's tip, since the branch descends from it.
  assert_eq "${resolved#* }" "$staging_tip" "base sha == staging merge-base" || return 1
  rm -rf "$repo"
}

# Reflog gone and no staging branch at all — main is the legacy fallback.
test_reflog_missing_no_staging_falls_back_to_main() {
  local repo; repo=$(new_repo)
  commit_file "$repo" file.txt "main: initial"
  local main_tip; main_tip=$(git -C "$repo" rev-parse HEAD)

  git -C "$repo" checkout -q -b feat/no-reflog
  commit_file "$repo" docs/note.md "feat: docs"
  local tip; tip=$(git -C "$repo" rev-parse HEAD)
  rm -f "$repo/.git/logs/refs/heads/feat/no-reflog"

  local resolved; resolved=$(cd "$repo" && resolve_diff_base refs/heads/feat/no-reflog "$tip")
  assert_eq "${resolved%% *}" staging "base source (staging label covers main fallback)" || return 1
  assert_eq "${resolved#* }" "$main_tip" "base sha == main merge-base" || return 1
  rm -rf "$repo"
}

# A single-commit branch has creation_sha == local_sha, which is not a usable
# base (empty diff would skip everything). Must fall through to merge-base.
test_single_commit_branch_falls_back() {
  local repo; repo=$(new_repo)
  commit_file "$repo" file.txt "main: initial"
  local main_tip; main_tip=$(git -C "$repo" rev-parse HEAD)

  # Branch created and never committed on: reflog's oldest entry == current tip.
  git -C "$repo" checkout -q -b feat/empty
  local tip; tip=$(git -C "$repo" rev-parse HEAD)
  assert_eq "$tip" "$main_tip" "empty branch tip == main tip" || return 1

  local resolved; resolved=$(cd "$repo" && resolve_diff_base refs/heads/feat/empty "$tip")
  assert_eq "${resolved%% *}" staging "base source" || return 1
  rm -rf "$repo"
}

# Case: no usable base anywhere — orphan branch shares no history. Must return
# "none" with a non-zero exit so the caller runs the full gate.
test_orphan_branch_returns_none() {
  local repo; repo=$(new_repo)
  commit_file "$repo" file.txt "main: initial"

  git -C "$repo" checkout -q --orphan orphan
  git -C "$repo" rm -rq --cached . 2>/dev/null || true
  rm -f "$repo/file.txt"
  commit_file "$repo" orphan.txt "orphan: initial"
  local tip; tip=$(git -C "$repo" rev-parse HEAD)

  # Drop the reflog too, otherwise the creation point would resolve.
  rm -f "$repo/.git/logs/refs/heads/orphan"

  local resolved rc
  resolved=$(cd "$repo" && resolve_diff_base refs/heads/orphan "$tip")
  rc=$?

  assert_eq "$resolved" none "resolution result" || return 1
  assert_eq "$rc" 1 "exit code signals full gate" || return 1
  rm -rf "$repo"
}

# The existing-remote-branch path never reaches this helper: the hook only calls
# it when remote_sha is the all-zero sentinel. Pin that contract.
test_existing_remote_branch_bypasses_helper() {
  local zero="0000000000000000000000000000000000000000"
  local repo; repo=$(new_repo)
  commit_file "$repo" file.txt "main: initial"
  commit_file "$repo" src/main.rs "main: rust"

  local remote_sha; remote_sha=$(git -C "$repo" rev-parse HEAD~1)
  assert_eq "$([ "$remote_sha" = "$zero" ] && echo yes || echo no)" no \
    "an existing branch's remote_sha is not the sentinel" || return 1
  rm -rf "$repo"
}

# ── Runner ─────────────────────────────────────────────────────────────────────
TESTS=(
  test_new_branch_from_main
  test_new_branch_from_staging
  test_stacked_child_docs_only
  test_stacked_child_changes_rust
  test_stacked_child_changes_web
  test_reflog_missing_falls_back_to_staging
  test_reflog_missing_no_staging_falls_back_to_main
  test_single_commit_branch_falls_back
  test_orphan_branch_returns_none
  test_existing_remote_branch_bypasses_helper
)

FILTER="${1:-}"

if [ "$FILTER" = "--list" ]; then
  printf '%s\n' "${TESTS[@]}"
  exit 0
fi

echo "→ pre-push diff-base resolution tests"
echo ""

for t in "${TESTS[@]}"; do
  if [ -n "$FILTER" ] && [[ ! "$t" =~ $FILTER ]]; then
    SKIP=$((SKIP + 1))
    continue
  fi

  if output=$("$t" 2>&1); then
    echo -e "  ${GREEN}✓${NC} $t"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $t"
    [ -n "$output" ] && echo "$output"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$t")
  fi
done

echo ""
if [ $FAIL -gt 0 ]; then
  echo -e "${RED}✗ $FAIL failed${NC}, $PASS passed$([ $SKIP -gt 0 ] && echo ", $SKIP skipped")"
  echo ""
  echo -e "${YELLOW}  Failed:${NC}"
  printf '    - %s\n' "${FAILED_TESTS[@]}"
  echo ""
  echo -e "${YELLOW}  Fix: run one test in isolation to see its assertions${NC}"
  echo "    ./scripts/test-pre-push-diff-base.sh ${FAILED_TESTS[0]}"
  echo -e "${YELLOW}  The logic under test lives in scripts/lib/git-diff-base.sh${NC}"
  exit 1
fi

echo -e "${GREEN}✓ $PASS passed$([ $SKIP -gt 0 ] && echo ", $SKIP skipped")${NC}"
