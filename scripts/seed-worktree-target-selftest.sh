#!/usr/bin/env bash
# Regression tests for scripts/seed-worktree-target.sh.
#
# This does not require the CI filesystem itself to support reflinks. It fakes
# clone-copy and Cargo clean so the test can prove the orchestration invariants:
# private destination, dependency retention, workspace cleanup, and safe skips.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
seed="$root/scripts/seed-worktree-target.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

source_root="$tmp/source"
dest_root="$tmp/dest"
bin="$tmp/bin"
mkdir -p "$source_root/target/deps" "$dest_root" "$bin"

printf 'lock\n' >"$source_root/Cargo.lock"
printf 'lock\n' >"$dest_root/Cargo.lock"
printf 'toolchain\n' >"$source_root/rust-toolchain.toml"
printf 'toolchain\n' >"$dest_root/rust-toolchain.toml"
printf 'dependency\n' >"$source_root/target/deps/dependency-artifact"
printf 'workspace\n' >"$source_root/target/workspace-artifact"

cat >"$bin/git" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "rev-parse" ]; then
  printf '%s\n' "$NSESSION_TEST_DEST"
  exit 0
fi
echo "unexpected fake git call: $*" >&2
exit 1
EOF

cat >"$bin/uname" <<'EOF'
#!/usr/bin/env bash
echo Linux
EOF

cat >"$bin/cp" <<'EOF'
#!/usr/bin/env bash
# seed invokes: cp -cRp SOURCE_TARGET TMP_TARGET
src=${@: -2:1}
dst=${@: -1}
exec /bin/cp -Rp "$src" "$dst"
EOF

cat >"$bin/cargo" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$NSESSION_TEST_CARGO_LOG"
target=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--target-dir" ]; then
    shift
    target=$1
    break
  fi
  shift
done
[ -n "$target" ] || exit 2
rm -f "$target/workspace-artifact"
EOF

chmod +x "$bin/git" "$bin/uname" "$bin/cp" "$bin/cargo"
cargo_log="$tmp/cargo.log"
: >"$cargo_log"

PATH="$bin:/usr/bin:/bin" \
NSESSION_TEST_DEST="$dest_root" \
NSESSION_TEST_CARGO_LOG="$cargo_log" \
  "$seed" "$source_root" "$dest_root"

[ -f "$dest_root/target/deps/dependency-artifact" ] || {
  echo "target seed selftest failed: dependency artifact was not retained" >&2
  echo "  Fix: seed the cloned target before cleaning workspace members" >&2
  exit 1
}
[ ! -e "$dest_root/target/workspace-artifact" ] || {
  echo "target seed selftest failed: workspace artifact leaked into destination" >&2
  echo "  Fix: run cargo clean --workspace against the temporary cloned target" >&2
  exit 1
}
[ -f "$source_root/target/workspace-artifact" ] || {
  echo "target seed selftest failed: source target was modified" >&2
  echo "  Fix: clean only the destination temporary target" >&2
  exit 1
}
grep -q '^clean --workspace --locked --target-dir ' "$cargo_log" || {
  echo "target seed selftest failed: cargo clean --workspace was not used" >&2
  echo "  Fix: preserve dependency artifacts while removing workspace-member outputs" >&2
  exit 1
}

# Existing target is owned by that worktree and must never be replaced.
printf 'owned\n' >"$dest_root/target/owned"
: >"$cargo_log"
PATH="$bin:/usr/bin:/bin" \
NSESSION_TEST_DEST="$dest_root" \
NSESSION_TEST_CARGO_LOG="$cargo_log" \
  "$seed" "$source_root" "$dest_root"
[ -f "$dest_root/target/owned" ] || {
  echo "target seed selftest failed: existing destination target was overwritten" >&2
  echo "  Fix: skip seeding whenever destination target already exists" >&2
  exit 1
}
[ ! -s "$cargo_log" ] || {
  echo "target seed selftest failed: existing target still triggered a clean" >&2
  echo "  Fix: return before cloning/cleaning an existing destination" >&2
  exit 1
}

# Incompatible inputs must cold-start rather than copy questionable artifacts.
rm -rf "$dest_root/target"
printf 'different-lock\n' >"$dest_root/Cargo.lock"
: >"$cargo_log"
PATH="$bin:/usr/bin:/bin" \
NSESSION_TEST_DEST="$dest_root" \
NSESSION_TEST_CARGO_LOG="$cargo_log" \
  "$seed" "$source_root" "$dest_root"
[ ! -e "$dest_root/target" ] || {
  echo "target seed selftest failed: incompatible Cargo.lock still produced a seed" >&2
  echo "  Fix: compare Cargo.lock and rust-toolchain.toml before cloning" >&2
  exit 1
}
[ ! -s "$cargo_log" ] || {
  echo "target seed selftest failed: incompatible seed still invoked Cargo" >&2
  exit 1
}

echo "worktree target seed selftest OK ✓ private target + dependency-only seed"
