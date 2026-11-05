#!/usr/bin/env bash
# Regression tests for scripts/seed-worktree-target.sh and the WorktreeCreate
# hook (.claude/hooks/create-worktree.sh).
#
# The suite is deliberately platform-independent: it fakes `uname`, `stat`,
# `diskutil`, `plutil`, `fuser`, `df`, `cp` and `cargo`, so the Darwin APFS
# classification (the #2735 regression) and the Linux reflink path are both
# exercised on either host. Every scenario asserts the published state, not
# just the exit status.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
seed="$root/scripts/seed-worktree-target.sh"
hook="$root/.claude/hooks/create-worktree.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

bin="$tmp/bin"
mkdir -p "$bin"

cat >"$bin/git" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "rev-parse" ] && [ "${2:-}" = "--show-toplevel" ]; then
  printf '%s\n' "$NSESSION_TEST_DEST"
  exit 0
fi
echo "unexpected fake git call: $*" >&2
exit 1
EOF

cat >"$bin/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${NSESSION_TEST_UNAME:-Linux}"
EOF

cat >"$bin/stat" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%Sd" ]; then
  case "${3:-}" in
    */dest) printf '%s\n' "${NSESSION_TEST_DEST_BSD:-${NSESSION_TEST_BSD_DEVICE:-disk3s5}}" ;;
    *) printf '%s\n' "${NSESSION_TEST_BSD_DEVICE:-disk3s5}" ;;
  esac
  exit 0
fi
if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%d" ]; then
  case "${3:-}" in
    */dest) printf '%s\n' "${NSESSION_TEST_DEST_DEVNUM:-${NSESSION_TEST_DEVNUM:-16777233}}" ;;
    *) printf '%s\n' "${NSESSION_TEST_DEVNUM:-16777233}" ;;
  esac
  exit 0
fi
exec /usr/bin/stat "$@"
EOF

cat >"$bin/diskutil" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" != "info" ] || [ "${2:-}" != "-plist" ]; then
  echo "unexpected fake diskutil call: $*" >&2
  exit 1
fi
target=${3:-}
printf '%s\n' "$target" >>"${NSESSION_TEST_DISKUTIL_LOG:-/dev/null}"
case "$target" in
  /*)
    # The pre-fix script passed a directory path; current macOS answers with an
    # error plist that carries no FilesystemType.
    cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Error</key><true/><key>ErrorMessage</key><string>Could not find disk</string></dict></plist>
PLIST
    ;;
  *)
    if [ "${NSESSION_TEST_DISKUTIL_BROKEN:-0}" = "1" ]; then
      cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Error</key><true/></dict></plist>
PLIST
    else
      printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
        '<plist version="1.0"><dict><key>FilesystemType</key><string>'"${NSESSION_TEST_FS:-apfs}"'</string></dict></plist>'
    fi
    ;;
esac
EOF

cat >"$bin/plutil" <<'EOF'
#!/usr/bin/env bash
input=$(cat)
value=$(printf '%s' "$input" | sed -n 's:.*<key>FilesystemType</key><string>\([^<]*\)</string>.*:\1:p' | head -1)
if [ -z "$value" ]; then
  echo "Could not extract value, error: No value at that key path" >&2
  exit 1
fi
printf '%s\n' "$value"
EOF

cat >"$bin/fuser" <<'EOF'
#!/usr/bin/env bash
# macOS fuser prints the path and exits 0 even with no holder; the PID list is
# the signal. Linux may print only PIDs. Model both shapes.
case "${NSESSION_TEST_FUSER:-idle}" in
  busy)
    printf '%s: 4242\n' "$1"
    exit 0
    ;;
  uncertain) exit 2 ;;
  idle)
    printf '%s: \n' "$1"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
EOF

cat >"$bin/df" <<'EOF'
#!/usr/bin/env bash
state=${NSESSION_TEST_DF_STATE:?}
count=$(cat "$state" 2>/dev/null || echo 0)
before=${NSESSION_TEST_DF_BEFORE:-1000000}
after=${NSESSION_TEST_DF_AFTER:-1000000}
if [ "$count" -eq 0 ]; then avail=$before; else avail=$after; fi
echo $((count + 1)) >"$state"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nfake 2000000 0 %s 0%% /\n' "$avail"
EOF

cat >"$bin/cp" <<'EOF'
#!/usr/bin/env bash
src=${@: -2:1}
dst=${@: -1}
mode=${NSESSION_TEST_CP_MODE:-clone}
printf '%s %s %s\n' "$mode" "$src" "$dst" >>"${NSESSION_TEST_CP_LOG:-/dev/null}"
case "$mode" in
  clone) exec /bin/cp -Rp "$src" "$dst" ;;
  fail)
    mkdir -p "$dst"
    echo partial >"$dst/partial-artifact"
    exit 1
    ;;
  unsupported) exit 1 ;;
  mutate)
    /bin/cp -Rp "$src" "$dst"
    touch "$src/mutated-during-copy"
    exit 0
    ;;
  *)
    echo "unknown fake cp mode: $mode" >&2
    exit 9
    ;;
esac
EOF

cat >"$bin/mv" <<'EOF'
#!/usr/bin/env bash
if [ "${NSESSION_TEST_MV_MODE:-ok}" = "fail-publish" ] && [ "${1:-}" = "-n" ]; then
  echo "injected publish failure" >&2
  exit 1
fi
exec /bin/mv "$@"
EOF

cat >"$bin/cargo" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${NSESSION_TEST_CARGO_LOG:?}"
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
if [ "${NSESSION_TEST_CARGO_MODE:-ok}" = "fail" ]; then
  exit 1
fi
rm -f "$target/workspace-artifact"
EOF

chmod +x "$bin"/*

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
assert_not_contains() { case "$1" in *"$2"*) fail_test "$3" "unexpected [$2] in: $1" ;; *) ;; esac; }
assert_absent() { [ ! -e "$1" ] || fail_test "$2" "unexpected path exists: $1"; }

new_fixture() {
  fixture="$tmp/$1"
  rm -rf "$fixture"
  mkdir -p "$fixture/source/target/deps" "$fixture/dest" "$fixture/state"
  printf 'lock\n' >"$fixture/source/Cargo.lock"
  printf 'lock\n' >"$fixture/dest/Cargo.lock"
  printf 'toolchain\n' >"$fixture/source/rust-toolchain.toml"
  printf 'toolchain\n' >"$fixture/dest/rust-toolchain.toml"
  printf 'dependency\n' >"$fixture/source/target/deps/dependency-artifact"
  printf 'workspace\n' >"$fixture/source/target/workspace-artifact"
  printf '0\n' >"$fixture/state/df-count"
  : >"$fixture/state/cargo.log"
  : >"$fixture/state/diskutil.log"
  : >"$fixture/state/cp.log"
  : >"$fixture/state/stderr"
}

run_seed() {
  local fixture=$1
  local search_path=$2
  shift 2
  set +e
  out=$(env PATH="$search_path:/usr/bin:/bin" \
    NSESSION_TEST_DEST="$fixture/dest" \
    NSESSION_TEST_CARGO_LOG="$fixture/state/cargo.log" \
    NSESSION_TEST_DISKUTIL_LOG="$fixture/state/diskutil.log" \
    NSESSION_TEST_CP_LOG="$fixture/state/cp.log" \
    NSESSION_TEST_DF_STATE="$fixture/state/df-count" \
    NSESSION_TEST_UNAME="${NSESSION_TEST_UNAME:-Linux}" \
    NSESSION_TEST_FS="${NSESSION_TEST_FS:-apfs}" \
    NSESSION_TEST_FUSER="${NSESSION_TEST_FUSER:-idle}" \
    NSESSION_TEST_CP_MODE="${NSESSION_TEST_CP_MODE:-clone}" \
    NSESSION_TEST_DF_BEFORE="${NSESSION_TEST_DF_BEFORE:-1000000}" \
    NSESSION_TEST_DF_AFTER="${NSESSION_TEST_DF_AFTER:-1000000}" \
    NSESSION_TEST_CARGO_MODE="${NSESSION_TEST_CARGO_MODE:-ok}" \
    NSESSION_TEST_DISKUTIL_BROKEN="${NSESSION_TEST_DISKUTIL_BROKEN:-0}" \
    NSESSION_TEST_MV_MODE="${NSESSION_TEST_MV_MODE:-ok}" \
    NSESSION_TEST_BSD_DEVICE="${NSESSION_TEST_BSD_DEVICE:-disk3s5}" \
    NSESSION_TEST_DEVNUM="${NSESSION_TEST_DEVNUM:-16777233}" \
    NSESSION_TEST_DEST_BSD="${NSESSION_TEST_DEST_BSD:-}" \
    NSESSION_TEST_DEST_DEVNUM="${NSESSION_TEST_DEST_DEVNUM:-}" \
    "$seed" "$fixture/source" "$fixture/dest" "$@" 2>"$fixture/state/stderr")
  rc=$?
  set -e
}

reset_env() {
  NSESSION_TEST_UNAME=Linux
  NSESSION_TEST_FS=apfs
  NSESSION_TEST_FUSER=idle
  NSESSION_TEST_CP_MODE=clone
  NSESSION_TEST_DF_BEFORE=1000000
  NSESSION_TEST_DF_AFTER=1000000
  NSESSION_TEST_CARGO_MODE=ok
  NSESSION_TEST_DISKUTIL_BROKEN=0
  NSESSION_TEST_MV_MODE=ok
  NSESSION_TEST_BSD_DEVICE=disk3s5
  NSESSION_TEST_DEVNUM=16777233
  NSESSION_TEST_DEST_BSD=''
  NSESSION_TEST_DEST_DEVNUM=''
}

# ── Linux reflink path ───────────────────────────────────────────────────
reset_env
new_fixture linux-reflink
run_seed "$fixture" "$bin"
assert_eq "$rc" 0 'linux reflink seed exits 0'
assert_contains "$out" 'seed_status=seeded' 'linux reflink seed reports seeded'
assert_contains "$out" 'seed_strategy=reflink' 'linux reflink seed names the strategy'
[ -f "$fixture/dest/target/deps/dependency-artifact" ] || fail_test 'linux reflink seed keeps dependency artifacts' 'dependency artifact missing'
assert_absent "$fixture/dest/target/workspace-artifact" 'linux reflink seed removes workspace artifacts'
[ -f "$fixture/source/target/workspace-artifact" ] || fail_test 'linux reflink seed leaves the source untouched' 'source workspace artifact was removed'
assert_contains "$(cat "$fixture/state/cargo.log")" 'clean --workspace --locked --target-dir ' 'linux reflink seed cleans workspace members'
pass_test 'linux reflink seeds a private dependency target'

reset_env
new_fixture linux-no-reflink
NSESSION_TEST_CP_MODE=unsupported
run_seed "$fixture" "$bin"
assert_eq "$rc" 0 'linux missing reflink exits 0'
assert_contains "$out" 'seed_status=skipped' 'linux missing reflink reports skipped'
assert_contains "$(cat "$fixture/state/stderr")" 'reflink' 'linux missing reflink names the cause'
assert_absent "$fixture/dest/target" 'linux missing reflink publishes nothing'
pass_test 'linux reflink-unavailable is an expected skip'

# ── Darwin APFS classification (#2735 root cause) ───────────────────────
reset_env
NSESSION_TEST_UNAME=Darwin
new_fixture darwin-apfs
run_seed "$fixture" "$bin"
assert_eq "$rc" 0 'darwin APFS seed exits 0'
assert_contains "$out" 'seed_status=seeded' 'darwin APFS seed reports seeded'
assert_contains "$out" 'seed_strategy=APFS clonefile' 'darwin APFS seed names clonefile'
[ -f "$fixture/dest/target/deps/dependency-artifact" ] || fail_test 'darwin APFS seed keeps dependency artifacts' 'dependency artifact missing'
assert_absent "$fixture/dest/target/workspace-artifact" 'darwin APFS seed removes workspace artifacts'
diskutil_log=$(cat "$fixture/state/diskutil.log")
assert_contains "$diskutil_log" 'disk3s5' 'darwin APFS classification resolves the BSD device'
assert_not_contains "$diskutil_log" "$fixture/source/target" 'darwin APFS classification never passes a directory to diskutil'
pass_test 'darwin APFS detection classifies by backing device'

reset_env
NSESSION_TEST_UNAME=Darwin
new_fixture darwin-different-device
NSESSION_TEST_DEVNUM=222
NSESSION_TEST_DEST_DEVNUM=333
NSESSION_TEST_DEST_BSD=disk4s1
run_seed "$fixture" "$bin"
assert_eq "$rc" 0 'darwin different device exits 0'
assert_contains "$out" 'seed_status=skipped' 'darwin different device reports skipped'
assert_contains "$(cat "$fixture/state/stderr")" 'different devices' 'darwin different device names the cause'
assert_absent "$fixture/dest/target" 'darwin different device publishes nothing'
[ ! -s "$fixture/state/cp.log" ] || fail_test 'darwin different device never clones' 'cp was invoked across devices'
pass_test 'darwin different devices are a safe skip'

reset_env
NSESSION_TEST_UNAME=Darwin
NSESSION_TEST_FS=hfs
new_fixture darwin-non-apfs
run_seed "$fixture" "$bin"
assert_eq "$rc" 0 'darwin non-APFS exits 0'
assert_contains "$out" 'seed_status=skipped' 'darwin non-APFS reports skipped'
assert_contains "$(cat "$fixture/state/stderr")" 'not on APFS' 'darwin non-APFS names the cause'
assert_absent "$fixture/dest/target" 'darwin non-APFS publishes nothing'
pass_test 'darwin non-APFS is a safe skip'

reset_env
NSESSION_TEST_UNAME=Darwin
NSESSION_TEST_DISKUTIL_BROKEN=1
new_fixture darwin-classify-fail
run_seed "$fixture" "$bin"
assert_eq "$rc" 1 'unclassifiable Darwin filesystem exits 1'
assert_contains "$out" 'seed_status=failed' 'unclassifiable Darwin filesystem reports failed'
assert_contains "$(cat "$fixture/state/stderr")" 'cannot classify' 'unclassifiable Darwin filesystem names the cause'
assert_absent "$fixture/dest/target" 'unclassifiable Darwin filesystem publishes nothing'
pass_test 'unexpected Darwin classification failure is a failed outcome'

# ── Darwin CoW verification ─────────────────────────────────────────────
reset_env
NSESSION_TEST_UNAME=Darwin
NSESSION_TEST_DF_BEFORE=1000000
NSESSION_TEST_DF_AFTER=850000
new_fixture darwin-full-copy
run_seed "$fixture" "$bin"
assert_eq "$rc" 1 'darwin full-copy fallback exits 1'
assert_contains "$out" 'seed_status=failed' 'darwin full-copy fallback reports failed'
assert_contains "$(cat "$fixture/state/stderr")" 'full-copy fallback' 'darwin full-copy fallback names the cause'
assert_absent "$fixture/dest/target" 'darwin full-copy fallback publishes nothing'
pass_test 'darwin clone allocation refuses a full-copy fallback'

# ── Source quiescence ───────────────────────────────────────────────────
reset_env
NSESSION_TEST_UNAME=Darwin
NSESSION_TEST_FUSER=busy
new_fixture source-busy
# A lock file must exist for the busy check to observe it.
mkdir -p "$fixture/source/target/debug"
: >"$fixture/source/target/debug/.cargo-lock"
run_seed "$fixture" "$bin"
assert_eq "$rc" 0 'busy source exits 0'
assert_contains "$out" 'seed_status=skipped' 'busy source reports skipped'
assert_contains "$(cat "$fixture/state/stderr")" 'in use by a Cargo build' 'busy source names the lock'
assert_absent "$fixture/dest/target" 'busy source publishes nothing'
[ ! -s "$fixture/state/cp.log" ] || fail_test 'busy source never clones' 'cp was invoked while Cargo held the lock'
pass_test 'an active Cargo build is a safe skip'

reset_env
NSESSION_TEST_UNAME=Darwin
NSESSION_TEST_FUSER=uncertain
new_fixture source-uncertain
mkdir -p "$fixture/source/target/debug"
: >"$fixture/source/target/debug/.cargo-lock"
run_seed "$fixture" "$bin"
assert_eq "$rc" 0 'uncertain fuser exits 0'
assert_contains "$out" 'seed_status=skipped' 'uncertain fuser reports skipped'
assert_contains "$(cat "$fixture/state/stderr")" 'cannot verify source quiescence' 'uncertain fuser names the uncertainty'
assert_absent "$fixture/dest/target" 'uncertain fuser publishes nothing'
pass_test 'an unverifiable source quiescence state is a safe skip'

reset_env
NSESSION_TEST_UNAME=Darwin
NSESSION_TEST_CP_MODE=mutate
new_fixture source-mutated
run_seed "$fixture" "$bin"
assert_eq "$rc" 0 'source mutation exits 0'
assert_contains "$out" 'seed_status=skipped' 'source mutation reports skipped'
assert_contains "$(cat "$fixture/state/stderr")" 'changed while seeding' 'source mutation names the cause'
assert_absent "$fixture/dest/target" 'source mutation publishes nothing'
pass_test 'a source that changes during the copy is discarded'

# ── Failure injection and cleanup ───────────────────────────────────────
reset_env
NSESSION_TEST_UNAME=Darwin
NSESSION_TEST_CP_MODE=fail
new_fixture clone-fail
run_seed "$fixture" "$bin"
assert_eq "$rc" 1 'clone failure exits 1'
assert_contains "$out" 'seed_status=failed' 'clone failure reports failed'
assert_absent "$fixture/dest/target" 'clone failure publishes nothing'
leftover=$(find "$fixture/dest" -maxdepth 1 -name '.target-seed.*' -print -quit)
assert_eq "$leftover" '' 'clone failure cleans the temporary target'
assert_contains "$(cat "$fixture/state/stderr")" 'APFS clone copy failed' 'clone failure names the cause'
pass_test 'a clone failure leaves no partial target'

reset_env
NSESSION_TEST_UNAME=Darwin
NSESSION_TEST_CARGO_MODE=fail
new_fixture clean-fail
run_seed "$fixture" "$bin"
assert_eq "$rc" 1 'workspace clean failure exits 1'
assert_contains "$out" 'seed_status=failed' 'workspace clean failure reports failed'
assert_absent "$fixture/dest/target" 'workspace clean failure publishes nothing'
assert_contains "$(cat "$fixture/state/stderr")" 'workspace-member artifacts' 'workspace clean failure names the cause'
pass_test 'a workspace-clean failure leaves no partial target'

# ── Existing target and safe retry ──────────────────────────────────────
reset_env
new_fixture existing-target
mkdir -p "$fixture/dest/target"
printf 'owned\n' >"$fixture/dest/target/owned-artifact"
run_seed "$fixture" "$bin"
assert_eq "$rc" 0 'existing target exits 0'
assert_contains "$out" 'seed_status=skipped' 'existing target reports skipped'
assert_contains "$(cat "$fixture/state/stderr")" 'never overwritten' 'existing target explains the refusal'
assert_contains "$(cat "$fixture/state/stderr")" 'seed-worktree-target-replace' 'existing target offers the safe retry'
[ -f "$fixture/dest/target/owned-artifact" ] || fail_test 'existing target stays untouched' 'owned artifact disappeared'
[ ! -s "$fixture/state/cargo.log" ] || fail_test 'existing target skips cloning' 'cargo ran for an existing target'
pass_test 'an existing destination target is never overwritten'

reset_env
new_fixture replace-target
mkdir -p "$fixture/dest/target"
printf 'owned\n' >"$fixture/dest/target/owned-artifact"
run_seed "$fixture" "$bin" --replace
assert_eq "$rc" 0 'replace exits 0'
assert_contains "$out" 'seed_status=seeded' 'replace reports seeded'
[ -f "$fixture/dest/target/deps/dependency-artifact" ] || fail_test 'replace publishes the new target' 'new dependency artifact missing'
backup=$(find "$fixture/dest" -maxdepth 1 -name '.target-seed-backup.*' -print -quit)
[ -n "$backup" ] || fail_test 'replace preserves a backup' 'no backup directory found'
[ -f "$backup/owned-artifact" ] || fail_test 'replace preserves the old target' 'old owned artifact missing from the backup'
pass_test 'replace keeps the previous target as a backup'

reset_env
NSESSION_TEST_MV_MODE=fail-publish
new_fixture replace-interrupted
mkdir -p "$fixture/dest/target"
printf 'owned\n' >"$fixture/dest/target/owned-artifact"
run_seed "$fixture" "$bin" --replace
assert_eq "$rc" 1 'interrupted replace exits 1'
assert_contains "$out" 'seed_status=failed' 'interrupted replace reports failed'
assert_contains "$(cat "$fixture/state/stderr")" 'could not publish' 'interrupted replace names the failure'
[ -f "$fixture/dest/target/owned-artifact" ] || fail_test 'interrupted replace restores the original target' 'owned artifact was not restored'
[ ! -e "$fixture/dest/target/deps/dependency-artifact" ] || fail_test 'interrupted replace publishes nothing' 'new dependency artifact leaked'
backup=$(find "$fixture/dest" -maxdepth 1 -name '.target-seed-backup.*' -print -quit)
assert_eq "$backup" '' 'interrupted replace leaves no orphan backup'
leftover=$(find "$fixture/dest" -maxdepth 1 -name '.target-seed.*' -print -quit)
assert_eq "$leftover" '' 'interrupted replace cleans the temporary target'
pass_test 'an interrupted replace restores the original target'

reset_env
new_fixture incompatible-lock
printf 'different-lock\n' >"$fixture/dest/Cargo.lock"
run_seed "$fixture" "$bin"
assert_eq "$rc" 0 'incompatible Cargo.lock exits 0'
assert_contains "$out" 'seed_status=skipped' 'incompatible Cargo.lock reports skipped'
assert_absent "$fixture/dest/target" 'incompatible Cargo.lock publishes nothing'
[ ! -s "$fixture/state/cargo.log" ] || fail_test 'incompatible Cargo.lock skips Cargo' 'cargo ran for incompatible inputs'
pass_test 'incompatible Cargo inputs cold-start'

# ── WorktreeCreate hook outcomes (SC-03) ────────────────────────────────
hook_repo="$tmp/hook-repo"
mkdir -p "$hook_repo/scripts"
hook_repo=$(cd "$hook_repo" && pwd -P)
git init -q "$hook_repo"
git -C "$hook_repo" config user.email "selftest@example.invalid"
git -C "$hook_repo" config user.name "Seed Selftest"
cat >"$hook_repo/scripts/seed-worktree-target.sh" <<'EOF'
#!/usr/bin/env bash
printf 'seed_status=%s\n' "${NSESSION_TEST_HOOK_STATUS:-seeded}"
printf 'seed_reason=%s\n' "${NSESSION_TEST_HOOK_REASON:-test outcome}"
[ "${NSESSION_TEST_HOOK_EXIT:-0}" = "0" ] || exit 1
EOF
chmod +x "$hook_repo/scripts/seed-worktree-target.sh"
printf 'repo\n' >"$hook_repo/README.md"
git -C "$hook_repo" add .
git -C "$hook_repo" commit -q -m "seed hook fixture"

run_hook() {
  local name=$1 status=$2 exit_code=$3 reason=$4
  local safe_name=${name//\//-}
  local worktree="$hook_repo/.claude/worktrees/$safe_name"
  local error_file="$tmp/hook-$safe_name.stderr"
  set +e
  hook_out=$(printf '{"name":"%s","cwd":"%s"}' "$name" "$hook_repo" | \
    NSESSION_TEST_HOOK_STATUS="$status" \
    NSESSION_TEST_HOOK_EXIT="$exit_code" \
    NSESSION_TEST_HOOK_REASON="$reason" \
    bash "$hook" 2>"$error_file")
  hook_rc=$?
  set -e
  assert_eq "$hook_rc" 0 "hook $name keeps WorktreeCreate successful"
  assert_eq "$hook_out" "$worktree" "hook $name keeps stdout to the worktree path"
  [ -d "$worktree" ] || fail_test "hook $name created the worktree" "missing $worktree"
  hook_err=$(cat "$error_file")
}

run_hook "feat/seed-ok" seeded 0 "a private target was published"
assert_contains "$hook_err" 'target seed seeded' 'hook reports seeded'
assert_not_contains "$hook_out" 'seed_status=' 'hook keeps seed status off stdout'
pass_test 'WorktreeCreate reports a seeded target'

run_hook "feat/seed-skip" skipped 0 "destination target already exists"
assert_contains "$hook_err" 'target seed skipped' 'hook reports skipped'
assert_contains "$hook_err" 'seed-worktree-target-replace' 'hook offers the safe retry for a skip'
pass_test 'WorktreeCreate reports a skipped target with a retry path'

run_hook "feat/seed-fail" failed 1 "unexpected clone failure"
assert_contains "$hook_err" 'target seed failed' 'hook reports failed'
assert_contains "$hook_err" 'continuing with an empty private target' 'hook continues after a failure'
assert_contains "$hook_err" 'seed-worktree-target-replace' 'hook offers the safe retry for a failure'
pass_test 'WorktreeCreate reports a failed seed and still creates the worktree'

echo "worktree target seed selftest OK ✓ seeded/skipped/failed outcomes, Darwin APFS, CoW refusal, quiescence and safe retry"
