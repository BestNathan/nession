#!/usr/bin/env bash
# Shared predicates for the local worktree seed tooling. Sourced, not executed.

# Print the repository's worktree list once. A git failure yields empty output;
# registration is then simply false, never a pipeline failure.
seed_worktree_list() {
  local main_root=$1
  git -C "$main_root" worktree list --porcelain 2>/dev/null || true
}

# True when <path> is a registered worktree of the repository at <main_root>.
# Do not implement this as `git ... | grep -q`: the scripts run with
# `set -o pipefail`, and an early grep exit can SIGPIPE the producer, turning a
# real match into a failed pipeline.
seed_worktree_is_registered() {
  local main_root=$1
  local path=$2
  local line
  while IFS= read -r line; do
    if [ "$line" = "worktree $path" ]; then
      return 0
    fi
  done <<< "$(seed_worktree_list "$main_root")"
  return 1
}
