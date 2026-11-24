#!/usr/bin/env bash
# Regression tests for scripts/seed-worktree-base.sh (#4469).
#
# The fixture is a real Git repository (so worktree registration, detached
# checkout and remote refresh are exercised) with a fake cargo that only
# records the warm command and creates a target marker.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/scripts/seed-worktree-base.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

bin="$tmp/bin"
mkdir -p "$bin"
cat >"$bin/cargo" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${NSESSION_TEST_BASE_CARGO_LOG:?}"
if [ "${NSESSION_TEST_BASE_CARGO_MODE:-ok}" = "fail" ]; then
  exit 1
fi
mkdir -p target/debug
printf 'warm\n' >target/debug/warm
EOF
chmod +x "$bin/cargo"

suite_index=0
pass_test() {
  suite_index=$((suite_index + 1))
  printf 'ok %d - %s\n' "$suite_index" "$1"
}
fail_test() {
  echo "not ok - $1" >&2
  echo "  $2" >&2
  exit 1
}
assert_eq() { [ "$1" = "$2" ] || fail_test "$3" "expected [$2], got [$1]"; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail_test "$3" "missing [$2] in: $1" ;; esac; }
assert_absent() { [ ! -e "$1" ] || fail_test "$2" "unexpected path exists: $1"; }

repo="$tmp/repo"
git init -q "$repo"
git -C "$repo" config user.email "selftest@example.invalid"
git -C "$repo" config user.name "Seed Base Selftest"
cat >"$repo/.gitignore" <<'EOF'
/target/
.claude/worktrees/
EOF
printf 'one\n' >"$repo/file.txt"
git -C "$repo" add .
git -C "$repo" commit -q -m "fixture one"

base="$repo/.claude/worktrees/_seed-base"
cargo_log="$tmp/cargo.log"
: >"$cargo_log"

run_base() {
  set +e
  out=$(cd "$repo" && env PATH="$bin:/usr/bin:/bin" \
    NSESSION_TEST_BASE_CARGO_LOG="$cargo_log" \
    NSESSION_TEST_BASE_CARGO_MODE="${NSESSION_TEST_BASE_CARGO_MODE:-ok}" \
    bash "$script" "$@" 2>"$tmp/stderr")
  rc=$?
  set -e
}
worktree_count() {
  git -C "$repo" worktree list --porcelain | grep -c '^worktree .*_seed-base$' || true
}

run_base --check
assert_eq "$rc" 0 'check before creation exits 0'
assert_contains "$out" 'seed_base_exists=no' 'check reports the missing base'
assert_contains "$out" 'seed_base_target=no' 'check reports no target'
assert_absent "$base" 'check publishes nothing'
pass_test '--check reports a missing base without side effects'

run_base
assert_eq "$rc" 0 'create exits 0'
assert_contains "$out" 'seed_base_status=ready' 'create reports ready'
assert_contains "$out" 'seed_base_state=created' 'create reports created'
[ -d "$base/target/debug" ] || fail_test 'create warms a target' 'target missing'
[ -f "$base/target/debug/warm" ] || fail_test 'create runs cargo' 'warm marker missing'
assert_eq "$(git -C "$base" rev-parse --abbrev-ref HEAD)" 'HEAD' 'create leaves the base detached'
assert_contains "$(cat "$cargo_log")" 'build --workspace --all-targets --locked' 'create uses a locked workspace build'
assert_eq "$(worktree_count)" 1 'create registers exactly one base worktree'
pass_test 'create builds a detached warm base worktree'

run_base --check
assert_eq "$rc" 0 'check after creation exits 0'
assert_contains "$out" 'seed_base_registered=yes' 'check reports the registered base'
assert_contains "$out" 'seed_base_target=yes' 'check reports the warm target'
assert_contains "$out" 'seed_base_dirty=no' 'check reports a clean base'
pass_test '--check reports a warm clean base'

run_base
assert_eq "$rc" 0 'second create exits 0'
assert_contains "$out" 'seed_base_state=refreshed' 'second create is idempotent'
assert_eq "$(worktree_count)" 1 'second create does not register a duplicate worktree'
pass_test 'refresh is idempotent'

printf 'dirty\n' >"$base/dirty.txt"
run_base --check
assert_contains "$out" 'seed_base_dirty=yes' 'check sees uncommitted base changes'
run_base
assert_eq "$rc" 1 'dirty refresh exits 1'
assert_contains "$out" 'seed_base_status=failed' 'dirty refresh reports failed'
assert_contains "$(cat "$tmp/stderr")" 'uncommitted changes' 'dirty refresh names the cause'
[ -f "$base/dirty.txt" ] || fail_test 'dirty refresh preserves base state' 'dirty file was removed'
rm "$base/dirty.txt"
pass_test 'a dirty base is never discarded'

remote="$tmp/remote.git"
git init -q --bare "$remote"
git -C "$repo" remote add origin "$remote"
git -C "$repo" push -q origin main
run_base
assert_eq "$rc" 0 'refresh from origin/main exits 0'
assert_eq "$(git -C "$base" rev-parse HEAD)" "$(git -C "$repo" rev-parse origin/main)" 'refresh tracks origin/main'

printf 'two\n' >"$repo/file.txt"
git -C "$repo" commit -q -am "fixture two"
git -C "$repo" push -q origin main
run_base
assert_eq "$rc" 0 'refresh after origin/main advances exits 0'
assert_eq "$(git -C "$base" rev-parse HEAD)" "$(git -C "$repo" rev-parse origin/main)" 'refresh advances to the new origin/main'
pass_test 'refresh follows origin/main'

NSESSION_TEST_BASE_CARGO_MODE=fail run_base
assert_eq "$rc" 1 'warm build failure exits 1'
assert_contains "$out" 'seed_base_status=failed' 'warm build failure reports failed'
assert_contains "$(cat "$tmp/stderr")" 'warm build failed' 'warm build failure names the cause'
[ -d "$base" ] || fail_test 'warm build failure keeps the base' 'base was removed'
pass_test 'warm build failure keeps the base for diagnosis'

echo "seed worktree base selftest OK ✓ create, idempotent refresh, dirty refusal, origin/main tracking, build failure"
