#!/usr/bin/env bash
# Show Nession's local Rust build-cache state without modifying it.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=lib/seed-worktree.sh
. "$script_dir/lib/seed-worktree.sh"
seed_target="$script_dir/seed-worktree-target.sh"

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "build-cache-status: not inside a Git worktree" >&2
  echo "  Fix: run this command from the Nession repository" >&2
  exit 1
}
main=$(git -C "$root" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p') || true

echo "workspace: $root"
echo "private target: $root/target"
echo "main worktree: $main"

base=''
if [ -x "$seed_target" ]; then
  base=$(cd "$root" && bash "$seed_target" --print-base 2>/dev/null) || base=''
fi
base_registered=no
if [ -n "$base" ] && seed_worktree_is_registered "$root" "$base"; then
  base_registered=yes
fi
if [ -n "$base" ]; then
  if [ ! -d "$base" ]; then
    echo "dedicated seed base: unavailable (missing at $base)"
    echo "  Fix: just seed-worktree-base"
  elif [ "$base_registered" != yes ]; then
    echo "dedicated seed base: unavailable (not registered at $base)"
    echo "  Fix: remove the stale path, then run: just seed-worktree-base"
  elif [ -d "$base/target" ]; then
    echo "dedicated seed base: available ($base/target)"
  else
    echo "dedicated seed base: unavailable (no target/ at $base)"
    echo "  Fix: just seed-worktree-base"
  fi
else
  echo "dedicated seed base: unavailable (could not resolve the base path)"
fi

source_path=''
source_kind='unknown'
source_problem=''
if [ -x "$seed_target" ]; then
  source_info=$(cd "$root" && bash "$seed_target" --print-source --dest "$root" 2>/dev/null || true)
  source_path=$(printf '%s\n' "$source_info" | sed -n 's/^seed_source=//p' | tail -1)
  source_kind=$(printf '%s\n' "$source_info" | sed -n 's/^seed_source_kind=//p' | tail -1)
  source_problem=$(printf '%s\n' "$source_info" | sed -n 's/^seed_source_problem=//p' | tail -1)
fi

if [ -n "$source_problem" ]; then
  echo "resolved seed source: unavailable ($source_problem)"
  echo "  Fix: unset NSESSION_SEED_SOURCE or set it to an existing warm worktree"
elif [ -n "$source_path" ]; then
  case "$source_kind" in
    seed-base) label='dedicated seed base' ;;
    env) label='NSESSION_SEED_SOURCE' ;;
    explicit) label='explicit source' ;;
    main) label='main fallback' ;;
    *) label="$source_kind" ;;
  esac
  if [ ! -d "$source_path/target" ]; then
    echo "resolved seed source: $source_path ($label; no target/)"
    if [ "$source_kind" = main ]; then
      echo "  New worktrees will start cold; create/refresh the dedicated base: just seed-worktree-base"
    fi
  else
    echo "resolved seed source: $source_path ($label)"
    compatibility='compatible'
    for compatibility_file in Cargo.lock rust-toolchain.toml; do
      if [ -f "$source_path/$compatibility_file" ] || [ -f "$root/$compatibility_file" ]; then
        if ! cmp -s "$source_path/$compatibility_file" "$root/$compatibility_file"; then
          compatibility="$compatibility_file differs"
          break
        fi
      fi
    done
    echo "seed source compatibility: $compatibility"
    if [ "$compatibility" != "compatible" ]; then
      if [ "$source_kind" = seed-base ]; then
        echo "  Fix: refresh the dedicated base: just seed-worktree-base"
      else
        echo "  Fix: use a source whose Cargo.lock/rust-toolchain.toml match, or just seed-worktree-base"
      fi
    fi
  fi
else
  echo "resolved seed source: unavailable (scripts/seed-worktree-target.sh is missing)"
fi

if command -v sccache >/dev/null 2>&1; then
  echo "sccache: $(command -v sccache)"
  echo "note: cross-worktree sccache reuse requires sccache >= 0.20 with SCCACHE_BASEDIRS; the seed base is the default warm path (see #4469)"
  sccache --show-stats || {
    echo "build-cache-status: sccache stats unavailable" >&2
    echo "  Fix: run 'sccache --start-server' or build once with cargo" >&2
    exit 1
  }
else
  echo "sccache: not installed (Cargo transparently falls back to rustc)"
  echo "  Optional: install sccache to enable compiler-result caching"
fi
