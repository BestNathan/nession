#!/usr/bin/env bash
set -euo pipefail

# check-dev-workspace.sh — enforce Nession workspace rules:
#   • Project root = read-only mirror of origin/main (no commits)
#   • All development in linked worktrees under .claude/worktrees/
#
# Usage:
#   ./scripts/check-dev-workspace.sh commit   # pre-commit (blocking)
#   ./scripts/check-dev-workspace.sh push     # pre-push (blocking)
#   ./scripts/check-dev-workspace.sh session  # manual / agent session start
#   ./scripts/check-dev-workspace.sh session --fetch   # also check root is up to date
#   ./scripts/check-dev-workspace.sh session --strict  # exit 1 on any violation

MODE=${1:-session}
shift || true

STRICT=0
FETCH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --strict) STRICT=1 ;;
    --fetch)  FETCH=1 ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 {commit|push|session} [--strict] [--fetch]" >&2
      exit 2
      ;;
  esac
  shift
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

fail() {
  local msg=$1
  local fix=$2
  echo -e "${RED}✗${NC} $msg" >&2
  echo -e "  Fix: $fix" >&2
  exit 1
}

warn() {
  echo -e "${YELLOW}!${NC} $1" >&2
}

ok() {
  echo -e "${GREEN}✓${NC} $1"
}

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  fail "not inside a git repository" "cd into the nession repo or a worktree under .claude/worktrees/"
fi

# Submodule checkout is not a linked worktree — skip worktree rules there.
superproject=$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)
if [ -n "$superproject" ]; then
  ok "submodule checkout — worktree rules skipped"
  exit 0
fi

git_dir=$(cd "$(git rev-parse --git-dir)" && pwd -P)
common_dir=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
branch=$(git branch --show-current 2>/dev/null || true)
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)

is_root_worktree=0
if [ "$git_dir" = "$common_dir" ]; then
  is_root_worktree=1
fi

worktree_kind="linked worktree"
if [ "$is_root_worktree" -eq 1 ]; then
  worktree_kind="project root"
fi

# ── Shared blocking rules (commit + push) ────────────────────────────────────

check_blocking() {
  local action=$1

  if [ "$is_root_worktree" -eq 1 ]; then
    fail "cannot $action from project root ($root)" \
      "refresh root (git fetch && git checkout main && git pull --ff-only origin main), then EnterWorktree name: \"feat/<slug>\" or git worktree add -b feat/<slug> .claude/worktrees/feat-<slug> origin/main"
  fi

  if [ -z "$branch" ]; then
    fail "detached HEAD — cannot $action" \
      "git checkout feat/<slug> (or create a worktree: EnterWorktree name: \"feat/<slug>\")"
  fi

  if [ "$branch" = "main" ]; then
    fail "cannot $action on branch main" \
      "create a worktree off origin/main: EnterWorktree name: \"feat/<slug>\""
  fi
}

# ── Session checks (informational; --strict → blocking) ──────────────────────

check_session_root() {
  if [ "$branch" != "main" ]; then
    local msg="project root is on '$branch', should be main only"
    local fix="git fetch origin && git checkout main && git pull --ff-only origin main"
    if [ "$STRICT" -eq 1 ]; then
      fail "$msg" "$fix"
    fi
    warn "$msg"
    echo "  Fix: $fix" >&2
    return
  fi
  ok "project root on main"

  if ! git diff --quiet || ! git diff --cached --quiet; then
    local msg="project root has uncommitted changes"
    local fix="move work to a worktree (EnterWorktree) or git stash, then git checkout main && git pull --ff-only origin main"
    if [ "$STRICT" -eq 1 ]; then
      fail "$msg" "$fix"
    fi
    warn "$msg"
    echo "  Fix: $fix" >&2
    return
  fi
  ok "project root working tree clean"

  if [ "$FETCH" -eq 1 ]; then
    if git remote get-url origin >/dev/null 2>&1; then
      git fetch origin main --quiet 2>/dev/null || warn "git fetch origin main failed — check network"
      behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
      if [ "$behind" != "0" ] && [ "$behind" != "?" ]; then
        local msg="project root main is $behind commit(s) behind origin/main"
        local fix="git pull --ff-only origin main"
        if [ "$STRICT" -eq 1 ]; then
          fail "$msg" "$fix"
        fi
        warn "$msg"
        echo "  Fix: $fix" >&2
        return
      fi
      ok "project root main matches origin/main"
    else
      warn "no origin remote — skipped origin/main freshness check"
    fi
  fi
}

check_session_linked() {
  if [ "$branch" = "main" ]; then
    local msg="linked worktree is on main — commits belong on feat/fix/chore/docs branches"
    local fix="git checkout feat/<slug> or create a new worktree off origin/main"
    if [ "$STRICT" -eq 1 ]; then
      fail "$msg" "$fix"
    fi
    warn "$msg"
    echo "  Fix: $fix" >&2
    return
  fi

  ok "developing in linked worktree on branch $branch"
  case "$branch" in
    feat/*|fix/*|chore/*|docs/*) ok "branch prefix triggers CI / routing correctly" ;;
    *)
      warn "branch '$branch' lacks feat/fix/chore/docs prefix — CI may not trigger"
      echo "  Fix: git branch -m feat/<slug> (or fix/<slug>)" >&2
      ;;
  esac
}

case "$MODE" in
  commit)
    check_blocking "commit"
    exit 0
    ;;
  push)
    check_blocking "push"
    exit 0
    ;;
  session)
    echo "Workspace: $worktree_kind — $root"
    if [ "$is_root_worktree" -eq 1 ]; then
      check_session_root
      echo ""
      echo "Ready to spawn a worktree:"
      echo "  EnterWorktree name: \"feat/<slug>\""
      echo "  git worktree add -b feat/<slug> .claude/worktrees/feat-<slug> origin/main"
    else
      check_session_linked
    fi
    exit 0
    ;;
  *)
    echo "Usage: $0 {commit|push|session} [--strict] [--fetch]" >&2
    exit 2
    ;;
esac
