#!/usr/bin/env bash
# Seed a worktree-local Cargo target from the main worktree using filesystem
# copy-on-write. The destination remains a distinct directory with distinct
# Cargo locks. Workspace-member artifacts are removed after cloning so only
# dependency artifacts are carried forward.
set -euo pipefail

log() { echo "$*" >&2; }
fail() {
  log "target seed failed: $1"
  log "  Fix: remove any partial target and retry: just seed-worktree-target"
  exit 1
}

current_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail "not inside a Git worktree"
dest_root=${2:-$current_root}

if [ "$#" -ge 1 ] && [ -n "${1:-}" ]; then
  source_root=$1
else
  source_root=$(git -C "$dest_root" worktree list --porcelain | sed -n '1s/^worktree //p')
fi

[ -n "${source_root:-}" ] || fail "could not resolve the main worktree"
source_root=$(cd "$source_root" && pwd)
dest_root=$(cd "$dest_root" && pwd)

if [ "$source_root" = "$dest_root" ]; then
  log "target seed skipped: source and destination are the same worktree"
  log "  Nothing to fix: each worktree must keep its own target/"
  exit 0
fi

source_target="$source_root/target"
dest_target="$dest_root/target"

if [ ! -d "$source_target" ]; then
  log "target seed skipped: source has no target/ ($source_target)"
  log "  Nothing to fix: Cargo will build a fresh private target in this worktree"
  exit 0
fi

if [ -e "$dest_target" ]; then
  log "target seed skipped: destination target already exists ($dest_target)"
  log "  Nothing to fix: existing worktree build state is never overwritten"
  exit 0
fi

for compatibility_file in Cargo.lock rust-toolchain.toml; do
  if [ -f "$source_root/$compatibility_file" ] || [ -f "$dest_root/$compatibility_file" ]; then
    if ! cmp -s "$source_root/$compatibility_file" "$dest_root/$compatibility_file"; then
      log "target seed skipped: $compatibility_file differs between source and destination"
      log "  Nothing to fix: incompatible build inputs must start with a private cold target"
      exit 0
    fi
  fi
done

tmp_target="$dest_root/.target-seed.$$"
cleanup() { rm -rf "$tmp_target"; }
trap cleanup EXIT INT TERM
rm -rf "$tmp_target"

case "$(uname -s)" in
  Darwin)
    if ! cp -cRp "$source_target" "$tmp_target" 2>/dev/null; then
      log "target seed skipped: APFS clone copy is unavailable on this filesystem"
      log "  Fix: build normally, or move the repository to an APFS volume for CoW seeding"
      exit 0
    fi
    strategy="APFS clonefile"
    ;;
  Linux)
    if ! cp -a --reflink=always "$source_target" "$tmp_target" 2>/dev/null; then
      log "target seed skipped: reflink copy is unavailable on this filesystem"
      log "  Fix: build normally, or use a reflink-capable filesystem (for example btrfs/XFS)"
      exit 0
    fi
    strategy="reflink"
    ;;
  *)
    log "target seed skipped: copy-on-write target seeding is not supported on $(uname -s)"
    log "  Nothing to fix: Cargo will build a fresh private target in this worktree"
    exit 0
    ;;
esac

# A copied target may contain fresh-looking workspace artifacts from another
# checkout. Cargo clean --workspace removes exactly workspace-member outputs
# while preserving dependency artifacts, which are the safe part we want to seed.
if ! (
  cd "$dest_root"
  RUSTC_WRAPPER="" cargo clean --workspace --locked --target-dir "$tmp_target" >/dev/null
); then
  fail "could not remove workspace-member artifacts from the cloned target"
fi

mv "$tmp_target" "$dest_target"
trap - EXIT INT TERM

log "target seed OK ✓ $strategy"
log "  source: $source_target"
log "  target: $dest_target"
log "  workspace artifacts removed; dependency artifacts retained"
