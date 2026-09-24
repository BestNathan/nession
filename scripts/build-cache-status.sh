#!/usr/bin/env bash
# Show Nession's local Rust build-cache state without modifying it.
set -euo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "build-cache-status: not inside a Git worktree" >&2
  echo "  Fix: run this command from the Nession repository" >&2
  exit 1
}
main=$(git -C "$root" worktree list --porcelain | sed -n '1s/^worktree //p')

echo "workspace: $root"
echo "private target: $root/target"
echo "main worktree: $main"
if [ -d "$main/target" ]; then
  echo "CoW seed source: available ($main/target)"
else
  echo "CoW seed source: unavailable (main target does not exist)"
fi

if command -v sccache >/dev/null 2>&1; then
  echo "sccache: $(command -v sccache)"
  echo "note: Rust SCCACHE_BASEDIRS worktree normalization is not assumed; see issue #986"
  sccache --show-stats || {
    echo "build-cache-status: sccache stats unavailable" >&2
    echo "  Fix: run 'sccache --start-server' or build once with cargo" >&2
    exit 1
  }
else
  echo "sccache: not installed (Cargo transparently falls back to rustc)"
  echo "  Optional: install sccache to enable compiler-result caching"
fi
