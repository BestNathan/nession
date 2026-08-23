#!/usr/bin/env bash
# WorktreeCreate hook — creates an isolated git worktree and prints its path on stdout.
#
# Claude Code passes JSON on stdin:
#   { "hook_event_name": "WorktreeCreate", "cwd": "/path/to/repo", "name": "feat/my-feature" }
#
# Stdout: absolute path to the created worktree (last non-empty line).
# Stderr: all logging / git output.

set -euo pipefail

log() { echo "$*" >&2; }

# Read hook payload from stdin.
raw=''
if [ ! -t 0 ]; then
  raw=$(cat)
fi

name=''
cwd=''
if [ -n "$raw" ]; then
  if command -v jq >/dev/null 2>&1; then
    name=$(printf '%s' "$raw" | jq -r '.name // .worktree_name // empty')
    cwd=$(printf '%s' "$raw" | jq -r '.cwd // empty')
  else
  # Fallback when jq is unavailable.
    name=$(printf '%s' "$raw" | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
    cwd=$(printf '%s' "$raw" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  fi
fi

if [ -z "$name" ]; then
  log "WorktreeCreate hook: missing 'name' in stdin payload"
  exit 1
fi

# Resolve repository root.
start_dir=${cwd:-$(pwd)}
repo_root=$(cd "$start_dir" && git rev-parse --show-toplevel 2>/dev/null) || {
  log "WorktreeCreate hook: not inside a git repository (cwd=$start_dir)"
  exit 1
}

# Ensure project hooks are active in this repo.
git -C "$repo_root" config core.hooksPath .githooks 2>/dev/null || true

# Nession convention: branch name is the hook name (e.g. feat/my-slug),
# worktree directory replaces '/' with '-' under .claude/worktrees/.
dir_name=${name//\//-}
worktree_dir="$repo_root/.claude/worktrees/$dir_name"
branch_name="$name"
base_ref="origin/main"

mkdir -p "$repo_root/.claude/worktrees"

# Reuse an existing worktree directory when present.
if [ -d "$worktree_dir" ]; then
  log "WorktreeCreate hook: reusing existing worktree at $worktree_dir"
  printf '%s\n' "$worktree_dir"
  exit 0
fi

cd "$repo_root"

# Prefer a fresh origin/main when the remote exists.
if git remote get-url origin >/dev/null 2>&1; then
  git fetch origin main --quiet 2>/dev/null || log "WorktreeCreate hook: git fetch origin main failed, using local refs"
  if ! git rev-parse --verify "$base_ref" >/dev/null 2>&1; then
    log "WorktreeCreate hook: $base_ref not found, falling back to HEAD"
    base_ref="HEAD"
  fi
else
  log "WorktreeCreate hook: no origin remote, using HEAD as base"
  base_ref="HEAD"
fi

log "WorktreeCreate hook: creating worktree"
log "  path=$worktree_dir"
log "  branch=$branch_name"
log "  base=$base_ref"

if git show-ref --verify --quiet "refs/heads/$branch_name" 2>/dev/null; then
  git worktree add "$worktree_dir" "$branch_name" >&2
else
  git worktree add -b "$branch_name" "$worktree_dir" "$base_ref" >&2
fi

# Activate hooks inside the new worktree too.
git -C "$worktree_dir" config core.hooksPath .githooks 2>/dev/null || true

log "WorktreeCreate hook: created worktree at $worktree_dir"
printf '%s\n' "$worktree_dir"
