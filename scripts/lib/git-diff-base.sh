#!/usr/bin/env bash
# ── Diff-base resolution for pre-push change detection ────────────────────────
#
# Answers: "what code was introduced by this branch / this push?"
# rather than: "what differs between this branch and main?"
#
# Sourced by .githooks/pre-push. Also tested directly by
# scripts/test-pre-push-diff-base.sh.
#
# Precedence for a NEW branch (no remote ref yet):
#   1. creation_point — branch creation SHA recovered from the local reflog.
#      Gives the true branch-local delta, so a stacked branch does not
#      re-inspect its parent's changes.
#   2. staging        — merge-base with the integration branch (staging is the
#      primary base in this repo's flow), then main as a legacy fallback.
#   3. none          — no usable base; caller must run the full gate.
#
# An EXISTING branch is not this script's concern: the caller uses
# remote_sha..local_sha directly.

# resolve_diff_base <local_ref> <local_sha>
#
# Prints "<source> <sha>" on success, where <source> is creation_point|staging.
# Prints "none" and returns 1 when no usable base exists.
resolve_diff_base() {
  local local_ref="$1" local_sha="$2"
  local creation_sha base

  # ── 1. Branch creation point from reflog ────────────────────────────────────
  # The oldest reflog entry for a branch ref is the commit it was created at.
  creation_sha=$(git reflog show --format='%H' "$local_ref" 2>/dev/null | tail -1)

  if [ -n "$creation_sha" ] &&
     [ "$creation_sha" != "$local_sha" ] &&
     git merge-base --is-ancestor "$creation_sha" "$local_sha" 2>/dev/null; then
    echo "creation_point $creation_sha"
    return 0
  fi

  # ── 2. Integration-branch merge-base (staging first, then main) ─────────────
  base=$(
    git merge-base origin/staging "$local_sha" 2>/dev/null ||
    git merge-base staging "$local_sha" 2>/dev/null ||
    git merge-base origin/main "$local_sha" 2>/dev/null ||
    git merge-base main "$local_sha" 2>/dev/null ||
    echo ""
  )

  if [ -n "$base" ]; then
    echo "staging $base"
    return 0
  fi

  # ── 3. Fail safe — caller runs the full gate ────────────────────────────────
  echo "none"
  return 1
}
