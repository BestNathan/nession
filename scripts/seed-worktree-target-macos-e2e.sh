#!/usr/bin/env bash
# Native macOS/APFS end-to-end receipt for #2735 SC-04.
#
# Run this from a linked worktree on a Mac. It creates two fresh detached
# worktrees at the tested revision: a warm source worktree and a destination.
# It builds a bounded package set in the source with the current toolchain,
# seeds the destination from that source target, independently checks CoW
# allocation and source quiescence, then runs the same build in the destination
# and requires every dependency crate to be Fresh.
#
# The bounded package set keeps this a targeted probe rather than a full
# workspace benchmark; it still exercises the real Cargo fingerprints, the real
# APFS clone and the real seed script. The JSON receipt is committed under
# e2e/acceptance/cases/2735/SC-04/macos-receipt.json so the Linux CI Case can
# verify its binding to the tested source revision.
set -euo pipefail

log() { echo "$*" >&2; }
die() { log "seed e2e failed: $*"; exit 1; }

output=${1:-}
package=${NSESSION_SEED_E2E_PACKAGE:-nession-common}
root=$(cd "$(dirname "$0")/.." && pwd)

[ "$(uname -s)" = "Darwin" ] || die "this receipt requires macOS/APFS"
for tool in git cargo rustc jq shasum; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

cd "$root"
tested_revision=$(git rev-parse HEAD)

create_worktree() {
  local target=$1
  git worktree add --detach "$target" "$tested_revision" >/dev/null 2>&1 \
    || die "could not create the worktree at $target"
  [ ! -e "$target/target" ] || die "worktree unexpectedly already has target/: $target"
}

source_root=$(mktemp -d "${TMPDIR:-/tmp}/nession-seed-e2e-source.XXXXXX")
dest_root=$(mktemp -d "${TMPDIR:-/tmp}/nession-seed-e2e-dest.XXXXXX")
stamp_file=''
cleanup() {
  for tree in "$dest_root" "$source_root"; do
    git worktree remove --force "$tree" >/dev/null 2>&1 || true
    rm -rf "$tree" 2>/dev/null || true
  done
  # Worktree teardown must never leave the shared repository bare.
  if [ "$(git -C "$root" rev-parse --is-bare-repository 2>/dev/null || true)" = "true" ]; then
    git -C "$root" config core.bare false || true
  fi
  rm -f "$stamp_file" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

create_worktree "$source_root"
create_worktree "$dest_root"
cmp -s "$source_root/Cargo.lock" "$dest_root/Cargo.lock" \
  || die "Cargo.lock differs between the two worktrees"
cmp -s "$source_root/rust-toolchain.toml" "$dest_root/rust-toolchain.toml" \
  || die "rust-toolchain.toml differs between the two worktrees"

log "warming $package in the source worktree"
source_build_log="$source_root/.source-build.log"
source_rc=0
( cd "$source_root" && cargo build -p "$package" >"$source_build_log" 2>&1 ) || source_rc=$?
tail -n 10 "$source_build_log" >&2 || true
[ "$source_rc" -eq 0 ] || die "warming the source worktree failed (exit $source_rc)"
source_target="$source_root/target"
[ -d "$source_target" ] || die "the source build produced no target/"

device=$(stat -f '%Sd' "$source_target")
filesystem=$(diskutil info -plist "$device" 2>/dev/null | plutil -extract FilesystemType raw -o - - 2>/dev/null) \
  || die "cannot classify $device"
[ "$filesystem" = "apfs" ] || die "source target is not on APFS ($filesystem)"

# Quiescence: a Cargo build must not be holding the source lock.
for lock_file in $(find "$source_target" -maxdepth 3 -name '.cargo-lock' -type f 2>/dev/null); do
  lock_output=$(fuser "$lock_file" 2>/dev/null || true)
  lock_pids=${lock_output##*:}
  if printf '%s' "$lock_pids" | grep -q '[0-9]'; then
    die "source target is in use by a Cargo build ($lock_file)"
  fi
done

df_before=$(df -k "$dest_root" 2>/dev/null | awk 'NR==2 {print $4}')
logical_kb=$(du -sk "$source_target" 2>/dev/null | awk '{print $1}')
[[ "${df_before:-}" =~ ^[0-9]+$ ]] || die "cannot read free space for $dest_root"
[[ "${logical_kb:-}" =~ ^[0-9]+$ ]] || die "cannot measure $source_target"
limit_kb=$((logical_kb / 10))
if [ "$limit_kb" -lt 65536 ]; then
  limit_kb=65536
fi

# Taken after the source build: anything written from now on means the source
# was not quiescent while the seed copied it.
stamp_file=$(mktemp "${TMPDIR:-/tmp}/nession-seed-e2e-stamp.XXXXXX")

start_ms=$(date +%s)
seed_rc=0
seed_out=$(bash "$root/scripts/seed-worktree-target.sh" "$source_root" "$dest_root" \
  2>"$dest_root/.seed.stderr") || seed_rc=$?
end_ms=$(date +%s)
printf '%s\n' "$seed_out" >&2
cat "$dest_root/.seed.stderr" >&2
[ "$seed_rc" -eq 0 ] || die "seed exited $seed_rc"
printf '%s\n' "$seed_out" | grep -q '^seed_status=seeded$' || die "seed did not report seeded"
strategy=$(printf '%s\n' "$seed_out" | sed -n 's/^seed_strategy=//p' | tail -1)
reported_allocated=$(printf '%s\n' "$seed_out" | sed -n 's/^seed_allocated_kib=//p' | tail -1)
reported_logical=$(printf '%s\n' "$seed_out" | sed -n 's/^seed_logical_kib=//p' | tail -1)
[ "$strategy" = "APFS clonefile" ] || die "unexpected seed strategy: ${strategy:-none}"

# Independent quiescence check: no source file or directory was written after
# the stamp taken immediately before the seed.
changed=$(find "$source_target" -newer "$stamp_file" -print -quit 2>/dev/null || true)
[ -z "$changed" ] || die "source target changed during the seed: $changed"

df_after=$(df -k "$dest_root" 2>/dev/null | awk 'NR==2 {print $4}')
[[ "${df_after:-}" =~ ^[0-9]+$ ]] || die "cannot read free space after seeding"
allocated_kb=$((df_before - df_after))
if [ "$allocated_kb" -lt 0 ]; then
  allocated_kb=0
fi
[ "$allocated_kb" -le "$limit_kb" ] \
  || die "seed allocated ${allocated_kb} KiB (limit ${limit_kb}); not a CoW clone"

[ -d "$dest_root/target" ] || die "seed did not publish target/"
[ ! -L "$dest_root/target" ] || die "published target/ is a symlink"
source_id=$(stat -f '%d:%i' "$source_target")
dest_id=$(stat -f '%d:%i' "$dest_root/target")
[ "$source_id" != "$dest_id" ] || die "source and destination target directories alias"

# The seed removes workspace-member outputs from every profile it cloned. Scan
# before the destination build recreates them.
leaked=$(find "$dest_root/target" \( \
  -path '*/deps/libnession_*' -o -path '*/deps/nession-*' \
  -o -path '*/.fingerprint/nession-*' -o -path '*/build/nession-*' \
  -o -path '*/incremental/nession_*' \
  -o -path '*/debug/nession-*' -o -path '*/release/nession-*' \
  \) -print -quit 2>/dev/null || true)
[ -z "$leaked" ] || die "workspace artifacts were carried across: $leaked"

log "building $package in the seeded worktree; dependencies must be Fresh"
build_log="$dest_root/.build.log"
# Do not override RUSTC_WRAPPER: this is the real worktree configuration, where
# each checkout resolves scripts/rustc-wrapper.sh relative to itself. The test
# must prove reuse with that actual input, not a hand-normalized wrapper path.
build_rc=0
( cd "$dest_root" && cargo build -v -p "$package" >"$build_log" 2>&1 ) || build_rc=$?
tail -n 20 "$build_log" >&2 || true
[ "$build_rc" -eq 0 ] || die "cargo build failed (exit $build_rc)"

metadata=$(cd "$dest_root" && cargo metadata --no-deps --format-version 1 2>/dev/null) \
  || die "cargo metadata failed"
workspace_names=$(printf '%s' "$metadata" | jq -r '.packages[].name')

fresh_names=$(sed -n 's/^[[:space:]]*Fresh \([^ ]*\) v.*/\1/p' "$build_log" | sort -u)
compiled_names=$(sed -n 's/^[[:space:]]*Compiling \([^ ]*\) v.*/\1/p' "$build_log" | sort -u)

dependencies_fresh=''
dependencies_compiled=''
workspace_compiled=''
while IFS= read -r name; do
  [ -n "$name" ] || continue
  if printf '%s\n' "$workspace_names" | grep -qx "$name"; then
    continue
  fi
  dependencies_fresh+="$name"$'\n'
done <<< "$fresh_names"
while IFS= read -r name; do
  [ -n "$name" ] || continue
  if printf '%s\n' "$workspace_names" | grep -qx "$name"; then
    workspace_compiled+="$name"$'\n'
  else
    dependencies_compiled+="$name"$'\n'
  fi
done <<< "$compiled_names"

[ -z "$dependencies_compiled" ] \
  || die "dependency crates recompiled: $(printf '%s' "$dependencies_compiled" | tr '\n' ' ')"
[ -n "$dependencies_fresh" ] || die "cargo reported no Fresh dependency crates"
[ -n "$workspace_compiled" ] \
  || die "no workspace member recompiled; workspace artifacts were not removed"

as_json_array() {
  printf '%s' "$1" | jq -R -s 'split("\n") | map(select(length > 0))'
}
dependencies_fresh_json=$(as_json_array "$dependencies_fresh")
dependencies_compiled_json=$(as_json_array "$dependencies_compiled")
workspace_compiled_json=$(as_json_array "$workspace_compiled")

# Bind the receipt to the exact seed surface at the tested revision. The CI
# checkout is shallow, so the verifier compares these Git blob entries and the
# receipt commit's parent SHA rather than requiring the parent object.
source_paths=(
  scripts/seed-worktree-target.sh
  scripts/seed-worktree-target-selftest.sh
  scripts/seed-worktree-target-macos-e2e.sh
  .claude/hooks/create-worktree.sh
  gates/checks/worktree-target-seed.sh
  justfile
  e2e/acceptance/cases/2735/SC-04/case.yaml
  e2e/acceptance/cases/2735/SC-04/verify.cjs
  e2e/acceptance/shared/worktree-seed-cases.cjs
)
source_tree=$(git -C "$root" ls-tree HEAD -- "${source_paths[@]}")
[[ -n "$source_tree" ]] || die "could not read the seed source tree at $tested_revision"
source_paths_json=$(printf '%s\n' "${source_paths[@]}" | jq -R -s 'split("\n") | map(select(length > 0))')
source_tree_json=$(printf '%s' "$source_tree" | jq -R -s 'split("\n") | map(select(length > 0))')

receipt=$(jq -n \
  --arg tested_revision "$tested_revision" \
  --arg verified_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg kernel "$(uname -r)" \
  --arg arch "$(uname -m)" \
  --arg device "$device" \
  --arg filesystem "$filesystem" \
  --arg package "$package" \
  --arg cargo_lock_sha256 "$(shasum -a 256 "$root/Cargo.lock" | awk '{print $1}')" \
  --arg rust_toolchain_sha256 "$(shasum -a 256 "$root/rust-toolchain.toml" | awk '{print $1}')" \
  --arg rustc "$(rustc --version)" \
  --arg cargo "$(cargo --version)" \
  --arg strategy "$strategy" \
  --argjson logical_kb "$logical_kb" \
  --argjson allocated_kb "$allocated_kb" \
  --argjson limit_kb "$limit_kb" \
  --argjson reported_allocated "${reported_allocated:-0}" \
  --argjson reported_logical "${reported_logical:-0}" \
  --argjson seed_duration_ms "$((end_ms - start_ms))" \
  --argjson dependencies_fresh "$dependencies_fresh_json" \
  --argjson dependencies_compiled "$dependencies_compiled_json" \
  --argjson workspace_compiled "$workspace_compiled_json" \
  --argjson source_paths "$source_paths_json" \
  --argjson source_tree "$source_tree_json" \
  '{
    schema_version: 1,
    issue: 2735,
    criterion: "SC-04",
    tested_revision: $tested_revision,
    source_paths: $source_paths,
    source_tree: $source_tree,
    verified_at: $verified_at,
    platform: { os: "Darwin", kernel: $kernel, arch: $arch },
    filesystem: { device: $device, type: $filesystem },
    inputs: {
      packages: [ $package ],
      profile: "dev",
      rustflags: "",
      rustc_wrapper: "per-worktree scripts/rustc-wrapper.sh (resolved by Cargo config)",
      cargo_lock_sha256: $cargo_lock_sha256,
      rust_toolchain_sha256: $rust_toolchain_sha256,
      rustc: $rustc,
      cargo: $cargo
    },
    seed: {
      outcome: "seeded",
      strategy: $strategy,
      logical_kib: $logical_kb,
      allocated_kib: $allocated_kb,
      allocation_limit_kib: $limit_kb,
      reported_allocated_kib: $reported_allocated,
      reported_logical_kib: $reported_logical,
      duration_ms: $seed_duration_ms
    },
    source_unchanged: true,
    workspace_artifacts_removed: true,
    targets_private: true,
    build: {
      command: ("cargo build -v -p " + $package),
      exit_code: 0,
      dependencies_compiled: $dependencies_compiled,
      dependencies_fresh: $dependencies_fresh,
      workspace_compiled: $workspace_compiled
    }
  }')

if [ -n "$output" ]; then
  printf '%s\n' "$receipt" >"$output"
  log "receipt written to $output"
else
  printf '%s\n' "$receipt"
fi
