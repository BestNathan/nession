#!/usr/bin/env bash
# Maintain the dedicated warm Cargo target seed base for this repository.
#
# The base is a detached worktree at <main-worktree>/.claude/worktrees/_seed-base.
# It is the default source for scripts/seed-worktree-target.sh when it has a
# target/. This command creates it, updates it to origin/main (falling back to
# main/HEAD when there is no origin), and warms it with a locked dev build.
#
#   just seed-worktree-base            create/update and warm the base
#   just seed-worktree-base --check    read-only state report
#   just seed-worktree-base --no-fetch refresh from local refs only
#   just seed-worktree-base --release  also warm the release profile
#
# The base is machine-local state: it is never committed, never used as a
# feature branch, and this command never discards uncommitted base changes.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=lib/seed-worktree.sh
. "$script_dir/lib/seed-worktree.sh"

log() { echo "$*" >&2; }

status_line() {
  printf 'seed_base_status=%s\n' "$1"
  printf 'seed_base_reason=%s\n' "$2"
}

fail() {
  status_line failed "$1"
  log "seed base failed: $1"
  if [ -n "${2:-}" ]; then
    log "  $2"
  fi
  exit 1
}

mode='ensure'
no_fetch=0
release=0
for arg in "$@"; do
  case "$arg" in
    --check) mode='check' ;;
    --no-fetch) no_fetch=1 ;;
    --release) release=1 ;;
    -*) fail "unknown option: $arg" "Usage: seed-worktree-base.sh [--check] [--no-fetch] [--release]" ;;
    *) fail "unexpected argument: $arg" "Usage: seed-worktree-base.sh [--check] [--no-fetch] [--release]" ;;
  esac
done

root=$(git rev-parse --show-toplevel 2>/dev/null) || fail "not inside a Git worktree" "Run this from the Nession repository: just seed-worktree-base"
main_root=$(git -C "$root" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p') || true
[ -n "$main_root" ] || fail "could not resolve the main worktree" "Run this from a registered Git worktree"

base=$(cd "$root" && bash "$script_dir/seed-worktree-target.sh" --print-base) \
  || fail "could not resolve the dedicated seed base path" "Restore scripts/seed-worktree-target.sh, then retry: just seed-worktree-base"
[ -n "$base" ] || fail "could not resolve the dedicated seed base path" "Restore scripts/seed-worktree-target.sh, then retry: just seed-worktree-base"

registered=no
if seed_worktree_is_registered "$main_root" "$base"; then
  registered=yes
fi
exists=no
[ -d "$base" ] && exists=yes
has_target=no
[ -d "$base/target" ] && has_target=yes
dirty=no
ref=''
if [ "$registered" = yes ]; then
  if [ -n "$(git -C "$base" status --porcelain 2>/dev/null)" ]; then
    dirty=yes
  fi
  ref=$(git -C "$base" rev-parse --short HEAD 2>/dev/null || true)
fi

if [ "$mode" = 'check' ]; then
  printf 'seed_base_path=%s\n' "$base"
  printf 'seed_base_registered=%s\n' "$registered"
  printf 'seed_base_exists=%s\n' "$exists"
  printf 'seed_base_target=%s\n' "$has_target"
  printf 'seed_base_dirty=%s\n' "$dirty"
  printf 'seed_base_ref=%s\n' "$ref"
  exit 0
fi

if [ "$exists" = yes ] && [ "$registered" != yes ]; then
  fail "seed base path exists but is not a registered worktree ($base)" "Move or remove that directory manually, then retry: just seed-worktree-base"
fi

target_ref=''
if git -C "$main_root" rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  target_ref='origin/main'
elif git -C "$main_root" rev-parse --verify --quiet main >/dev/null 2>&1; then
  target_ref='main'
else
  target_ref='HEAD'
fi

created=0
if [ "$registered" != yes ]; then
  mkdir -p "$(dirname "$base")"
  log "seed base: creating $base at $target_ref"
  git -C "$main_root" worktree add --detach "$base" "$target_ref" >&2 \
    || fail "could not create the seed base worktree" "Check $main_root permissions and retry: just seed-worktree-base"
  created=1
fi

if [ -n "$(git -C "$base" status --porcelain 2>/dev/null)" ]; then
  fail "seed base has uncommitted changes ($base)" "Commit/stash them or remove that worktree; this command never discards base state"
fi

if [ "$no_fetch" -ne 1 ] && git -C "$base" remote get-url origin >/dev/null 2>&1; then
  log "seed base: fetching origin/main"
  git -C "$base" fetch origin main --quiet \
    || fail "could not fetch origin/main for the seed base" "Retry when the network is available, or use: just seed-worktree-base --no-fetch"
  if git -C "$base" rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
    target_ref='origin/main'
  fi
fi

if ! git -C "$base" checkout --detach --quiet "$target_ref" >&2; then
  fail "could not update the seed base to $target_ref" "Inspect $base, or remove that worktree and retry: just seed-worktree-base"
fi

cargo_args=(build --workspace --all-targets --locked)
if [ "$release" -eq 1 ]; then
  cargo_args+=(--release)
fi

log "seed base: warming $base (cargo ${cargo_args[*]})"
if ! ( cd "$base" && cargo "${cargo_args[@]}" ); then
  fail "warm build failed in the seed base" "Fix the build error above; the base worktree is kept for diagnosis at: $base"
fi

if [ "$created" -eq 1 ]; then
  state='created'
else
  state='refreshed'
fi
printf 'seed_base_status=ready\n'
printf 'seed_base_state=%s\n' "$state"
printf 'seed_base_path=%s\n' "$base"
printf 'seed_base_ref=%s\n' "$(git -C "$base" rev-parse HEAD)"
printf 'seed_base_build=ran\n'
log "seed base ready ✓ $base"
log "  ref: $(git -C "$base" rev-parse --short HEAD)"
log "  New worktrees will seed from this target when Cargo.lock and rust-toolchain.toml match."
