#!/usr/bin/env bash
# Seed a worktree-local Cargo target from the main worktree using filesystem
# copy-on-write. The destination remains a distinct directory with distinct
# Cargo locks. Workspace-member artifacts are removed after cloning so only
# dependency artifacts are carried forward.
#
# Outcomes are machine-readable on stdout and human diagnostics are on stderr:
#
#   seed_status=seeded   exit 0  a private CoW-backed dependency target was published
#   seed_status=skipped  exit 0  an expected, safe condition prevented seeding
#   seed_status=failed   exit 1  an unexpected validation/clone/cleanup failure
#
# `skipped` and `failed` never leave a partially published target. Worktree
# creation treats every outcome as non-fatal and reports the actual one.
set -euo pipefail

log() { echo "$*" >&2; }

status_line() {
  printf 'seed_status=%s\n' "$1"
  printf 'seed_reason=%s\n' "$2"
}

# Mutable cleanup state. `published` distinguishes "the existing target was
# moved aside and replaced" from an interrupted attempt that must restore it.
tmp_target=''
stamp_file=''
backup_target=''
dest_target=''
replace_existing=0
published=0

cleanup() {
  local code=$?
  if [ -n "$stamp_file" ]; then
    rm -f "$stamp_file" 2>/dev/null || true
  fi
  if [ -n "$tmp_target" ] && [ -e "$tmp_target" ]; then
    rm -rf "$tmp_target" 2>/dev/null || true
  fi
  if [ "$published" -ne 1 ] && [ -n "$backup_target" ] && [ -d "$backup_target" ] \
      && [ ! -e "$dest_target" ]; then
    # Interrupted after moving the old target aside: put the worktree's own
    # build state back exactly where it was.
    mv "$backup_target" "$dest_target" 2>/dev/null || true
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

skip() {
  status_line skipped "$1"
  log "target seed skipped: $1"
  if [ -n "${2:-}" ]; then
    log "  $2"
  fi
  exit 0
}

fail() {
  status_line failed "$1"
  log "target seed failed: $1"
  if [ -n "${2:-}" ]; then
    log "  $2"
  fi
  exit 1
}

replace_existing=0
positional=()
for arg in "$@"; do
  case "$arg" in
    --replace) replace_existing=1 ;;
    -*) fail "unknown option: $arg" "Usage: seed-worktree-target.sh [--replace] [SOURCE_ROOT [DEST_ROOT]]" ;;
    *) positional+=("$arg") ;;
  esac
done
set -- "${positional[@]}"

current_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail "not inside a Git worktree" "Run this from a worktree: just seed-worktree-target"
dest_root=${2:-$current_root}

if [ "$#" -ge 1 ] && [ -n "${1:-}" ]; then
  source_root=$1
else
  source_root=$(git -C "$dest_root" worktree list --porcelain | sed -n '1s/^worktree //p')
fi

[ -n "${source_root:-}" ] || fail "could not resolve the main worktree" "Pass the main worktree path explicitly: seed-worktree-target.sh <main-worktree> <worktree>"
source_root=$(cd "$source_root" && pwd)
dest_root=$(cd "$dest_root" && pwd)
dest_target="$dest_root/target"

if [ "$source_root" = "$dest_root" ]; then
  skip "source and destination are the same worktree" "Nothing to fix: each worktree must keep its own target"
fi

source_target="$source_root/target"

if [ ! -d "$source_target" ]; then
  skip "source has no target/ ($source_target)" "Nothing to fix: Cargo will build a fresh private target in this worktree"
fi

if [ -e "$dest_target" ] && [ "$replace_existing" -ne 1 ]; then
  skip "destination target already exists ($dest_target)" "Existing worktree build state is never overwritten automatically. To reseed explicitly while keeping the old target as a backup: just seed-worktree-target-replace"
fi

for compatibility_file in Cargo.lock rust-toolchain.toml; do
  if [ -f "$source_root/$compatibility_file" ] || [ -f "$dest_root/$compatibility_file" ]; then
    if ! cmp -s "$source_root/$compatibility_file" "$dest_root/$compatibility_file"; then
      skip "$compatibility_file differs between source and destination" "Nothing to fix: incompatible build inputs must start with a private cold target"
    fi
  fi
done

# A Cargo build holds its per-profile `.cargo-lock` open for the whole build.
# Never clone a target while one is active: the clone could capture a mix of
# old and new dependency artifacts. `fuser` is the portable observer (macOS and
# Linux); if it is unavailable we cannot prove quiescence, so seed nothing.
lock_files=$(find "$source_target" -maxdepth 3 -name '.cargo-lock' -type f 2>/dev/null || true)
if [ -n "$lock_files" ]; then
  if ! command -v fuser >/dev/null 2>&1; then
    skip "cannot verify source quiescence (fuser unavailable)" "Install psmisc or wait until the source target is known idle; Cargo will build a fresh private target"
  fi
  while IFS= read -r lock_file; do
    [ -n "$lock_file" ] || continue
    # macOS fuser exits 0 even when no process has the file open; the PID list
    # (after the final ":") is the only reliable signal there. Linux prints
    # PIDs on stdout as well. Exit codes above 1 mean the observer failed.
    fuser_output=''
    fuser_rc=0
    fuser_output=$(fuser "$lock_file" 2>/dev/null) || fuser_rc=$?
    if [ "$fuser_rc" -gt 1 ]; then
      skip "cannot verify source quiescence (fuser exit $fuser_rc on $lock_file)" "Check the file-lock tooling, or wait until the source target is known idle; Cargo will build a fresh private target"
    fi
    fuser_pids=$fuser_output
    case "$fuser_output" in
      *:*) fuser_pids=${fuser_output##*:} ;;
    esac
    if printf '%s' "$fuser_pids" | grep -q '[0-9]'; then
      skip "source target is in use by a Cargo build ($lock_file)" "Wait for the build to finish, then retry: just seed-worktree-target"
    fi
  done <<< "$lock_files"
fi

# Created before the clone; any source file or directory written after this
# instant means the source was not quiescent for the whole copy.
stamp_file=$(mktemp "${TMPDIR:-/tmp}/nession-target-seed-stamp.XXXXXX")
tmp_target="$dest_root/.target-seed.$$"
rm -rf "$tmp_target"

copy_strategy=''
source_logical_kb=''
allocated_kb=''

case "$(uname -s)" in
  Darwin)
    for tool in diskutil plutil stat; do
      if ! command -v "$tool" >/dev/null 2>&1; then
        fail "cannot verify APFS clone support ($tool unavailable)" "Repair the macOS developer tooling, then retry: just seed-worktree-target"
      fi
    done
    # `diskutil info` does not resolve arbitrary subdirectory paths on current
    # macOS (it returns an error plist with no FilesystemType). Resolve the
    # backing BSD device first; the device name is what diskutil accepts.
    source_bsd=$(stat -f '%Sd' "$source_target" 2>/dev/null || true)
    dest_bsd=$(stat -f '%Sd' "$dest_root" 2>/dev/null || true)
    source_dev=$(stat -f '%d' "$source_target" 2>/dev/null || true)
    dest_dev=$(stat -f '%d' "$dest_root" 2>/dev/null || true)
    if [ -z "$source_bsd" ] || [ -z "$dest_bsd" ] || [ -z "$source_dev" ] || [ -z "$dest_dev" ]; then
      fail "cannot classify the source/destination device" "stat returned no device; inspect with: stat -f '%Sd' \"$source_target\" and stat -f '%Sd' \"$dest_root\""
    fi
    if [ "$source_dev" != "$dest_dev" ] || [ "$source_bsd" != "$dest_bsd" ]; then
      skip "source/destination are on different devices ($source_bsd vs $dest_bsd)" "Nothing to fix: refusing a potentially full target copy; Cargo will build a fresh private target"
    fi
    source_fs=$(diskutil info -plist "$source_bsd" 2>/dev/null | plutil -extract FilesystemType raw -o - - 2>/dev/null || true)
    dest_fs=$(diskutil info -plist "$dest_bsd" 2>/dev/null | plutil -extract FilesystemType raw -o - - 2>/dev/null || true)
    if [ -z "$source_fs" ] || [ -z "$dest_fs" ]; then
      fail "cannot classify the filesystem for $source_bsd/$dest_bsd" "diskutil/plutil did not report FilesystemType; inspect with: diskutil info -plist $source_bsd | plutil -extract FilesystemType raw -o - -"
    fi
    if [ "$source_fs" != "apfs" ] || [ "$dest_fs" != "apfs" ]; then
      skip "source/destination are not on APFS ($source_fs/$dest_fs)" "Nothing to fix: copy-on-write cloning needs APFS; Cargo will build a fresh private target"
    fi

    # APFS support is necessary but not proof that every file was cloned.
    # Measure the volume allocation around the copy and refuse a fallback that
    # consumed a meaningful fraction of the source's logical size.
    avail_before=$(df -k "$dest_root" 2>/dev/null | awk 'NR==2 {print $4}' || true)
    source_logical_kb=$(du -sk "$source_target" 2>/dev/null | awk '{print $1}' || true)
    if ! [[ "${avail_before:-}" =~ ^[0-9]+$ ]] || ! [[ "${source_logical_kb:-}" =~ ^[0-9]+$ ]]; then
      fail "cannot measure the clone allocation" "df/du did not return numeric sizes; inspect: df -k \"$dest_root\" and du -sk \"$source_target\""
    fi
    if ! cp -cRp "$source_target" "$tmp_target" 2>/dev/null; then
      fail "APFS clone copy failed" "Check free space and permissions, then retry: just seed-worktree-target"
    fi
    avail_after=$(df -k "$dest_root" 2>/dev/null | awk 'NR==2 {print $4}' || true)
    if ! [[ "${avail_after:-}" =~ ^[0-9]+$ ]]; then
      fail "cannot verify the clone allocation" "df did not return a numeric size after copying; inspect: df -k \"$dest_root\""
    fi
    allocated_kb=$((avail_before - avail_after))
    if [ "$allocated_kb" -lt 0 ]; then
      allocated_kb=0
    fi
    limit_kb=$((source_logical_kb / 10))
    if [ "$limit_kb" -lt 65536 ]; then
      limit_kb=65536
    fi
    if [ "$allocated_kb" -gt "$limit_kb" ]; then
      fail "clone allocated ${allocated_kb} KiB for a ${source_logical_kb} KiB source (limit ${limit_kb} KiB); refusing a full-copy fallback" "Nothing was published. Verify the volume supports clonefile and retry: just seed-worktree-target"
    fi
    copy_strategy='APFS clonefile'
    ;;
  Linux)
    if ! cp -a --reflink=always "$source_target" "$tmp_target" 2>/dev/null; then
      skip "reflink copy is unavailable on this filesystem" "Nothing to fix: Cargo will build a fresh private target, or use a reflink-capable filesystem (for example btrfs/XFS)"
    fi
    copy_strategy='reflink'
    ;;
  *)
    skip "copy-on-write target seeding is not supported on $(uname -s)" "Nothing to fix: Cargo will build a fresh private target"
    ;;
esac

# The clone is only a valid snapshot if nothing wrote to the source while it
# ran. Directory mtimes cover deletions as well as file writes.
changed_path=$(find "$source_target" -newer "$stamp_file" -print -quit 2>/dev/null || true)
if [ -n "$changed_path" ]; then
  skip "source target changed while seeding ($changed_path)" "Wait for the build to finish, then retry: just seed-worktree-target"
fi

# A copied target may contain fresh-looking workspace artifacts from another
# checkout. Cargo clean --workspace removes exactly workspace-member outputs
# while preserving dependency artifacts, which are the safe part we want to
# seed. Cargo cleans one profile per invocation, so clean every profile and
# custom target directory present in the clone; otherwise release or coverage
# workspace outputs would cross the checkout boundary.
clean_workspace_artifacts() {
  local target_dir=$1
  shift
  (
    cd "$dest_root"
    RUSTC_WRAPPER="" cargo clean --workspace --locked --target-dir "$target_dir" "$@" >/dev/null
  )
}

if ! clean_workspace_artifacts "$tmp_target"; then
  fail "could not remove workspace-member artifacts from the cloned target" "Nothing was published; check the Cargo error above and retry: just seed-worktree-target"
fi
if ! clean_workspace_artifacts "$tmp_target" --release; then
  fail "could not remove release workspace-member artifacts from the cloned target" "Nothing was published; check the Cargo error above and retry: just seed-worktree-target"
fi
# `--doc` cannot be combined with the workspace selection flag; it is a
# documentation cache, not a build input, so cleaning it wholesale is safe.
if ! (
  cd "$dest_root"
  RUSTC_WRAPPER="" cargo clean --locked --doc --target-dir "$tmp_target" >/dev/null
); then
  fail "could not remove workspace documentation from the cloned target" "Nothing was published; check the Cargo error above and retry: just seed-worktree-target"
fi
if [ -d "$tmp_target/llvm-cov-target" ]; then
  if ! clean_workspace_artifacts "$tmp_target/llvm-cov-target"; then
    fail "could not remove coverage workspace-member artifacts from the cloned target" "Nothing was published; check the Cargo error above and retry: just seed-worktree-target"
  fi
  if [ -d "$tmp_target/llvm-cov-target/release" ]; then
    if ! clean_workspace_artifacts "$tmp_target/llvm-cov-target" --release; then
      fail "could not remove release coverage workspace-member artifacts from the cloned target" "Nothing was published; check the Cargo error above and retry: just seed-worktree-target"
    fi
  fi
fi
# Cargo's transient staging directory is not a cache and may describe the
# previous checkout.
rm -rf "$tmp_target/tmp"

# Publish atomically. With --replace the old target is renamed to a sibling
# backup first; it is never deleted, and an interrupted attempt restores it.
if [ "$replace_existing" -eq 1 ] && [ -e "$dest_target" ]; then
  backup_target="$dest_root/.target-seed-backup.$(date +%Y%m%d%H%M%S).$$"
  if [ -e "$backup_target" ]; then
    fail "backup path already exists ($backup_target)" "Remove the stale backup or retry in a moment"
  fi
  if ! mv "$dest_target" "$backup_target"; then
    backup_target=''
    fail "could not move the existing target aside" "The existing target is unchanged; check permissions and retry"
  fi
fi

if ! mv -n "$tmp_target" "$dest_target"; then
  fail "could not publish the seeded target" "Check permissions; an existing target (if any) is preserved"
fi
if [ -e "$tmp_target" ]; then
  # A concurrent process created target/ after the early check. Never clobber
  # it; leave the backup in place and report the expected skip.
  skip "destination target appeared while seeding" "Rerun when the worktree is idle: just seed-worktree-target-replace"
fi

published=1
status_line seeded "published a private CoW-backed dependency target via $copy_strategy"
printf 'seed_strategy=%s\n' "$copy_strategy"
printf 'seed_logical_kib=%s\n' "$source_logical_kb"
printf 'seed_allocated_kib=%s\n' "$allocated_kb"
if [ -n "$backup_target" ]; then
  printf 'seed_backup=%s\n' "$backup_target"
fi

log "target seed OK ✓ $copy_strategy"
log "  source: $source_target"
log "  target: $dest_target"
log "  workspace artifacts removed; dependency artifacts retained"
if [ -n "$backup_target" ]; then
  log "  previous target preserved at: $backup_target"
  log "  Remove that backup once the seeded target is verified."
fi
