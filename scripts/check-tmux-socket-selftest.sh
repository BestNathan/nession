#!/usr/bin/env bash
# Verify scripts/check-tmux-socket.sh actually fires. Injects one violation of
# each spawn form into a scratch file, checks it is reported, then removes it.
#
# This matters more than most selftests: the gate it guards replaced a review
# habit that had already failed once. #575 recorded the specific way a tmux gate
# goes blind — matching only the string `Command::new("tmux")` reported
# SessionManager as clean while all 14 of its production calls went through a
# variable (`&self.tmux_bin`). The "variable form" probe below is that case.
set -uo pipefail

RUST_TARGET="crates/nession-common/src/zz_tmux_socket_probe.rs"
SHELL_TARGET="scripts/zz-tmux-socket-probe.sh"

pass=0
fail=0

cleanup() { rm -f "$RUST_TARGET" "$SHELL_TARGET"; }
trap cleanup EXIT INT TERM

probe() {
    local name="$1" expect="$2" target="$3" body="$4"
    printf '%s\n' "$body" >"$target"
    local out
    out=$(./scripts/check-tmux-socket.sh 2>&1)
    rm -f "$target"
    if grep -q "$expect" <<<"$out"; then
        echo "  ✓ detected: $name"
        pass=$((pass + 1))
    else
        echo "  ✗ MISSED:   $name  (expected /$expect/)"
        echo "$out" | sed 's/^/      /'
        fail=$((fail + 1))
    fi
}

echo "→ each rule must fire on an injected violation"

probe "rule 1a: Command::new(\"tmux\") literal" "outside the chokepoint" "$RUST_TARGET" \
    'pub async fn probe() {
    let _ = tokio::process::Command::new("tmux")
        .args(["list-sessions"])
        .status()
        .await;
}'

probe "rule 1a: std::process::Command literal" "outside the chokepoint" "$RUST_TARGET" \
    'pub fn probe() {
    let _ = std::process::Command::new("tmux").arg("kill-server").status();
}'

probe "rule 1c: portable-pty CommandBuilder literal" "outside the chokepoint" "$RUST_TARGET" \
    'pub fn probe() {
    let mut cmd = portable_pty::CommandBuilder::new("tmux");
    cmd.args(["attach", "-t", "x"]);
}'

# The regression this gate exists for: no literal anywhere, so a
# literal-matching check passes while the call lands on the default socket.
probe "rule 1b: spawn from a variable (the #575 blind spot)" "spawned from a variable" "$RUST_TARGET" \
    'pub struct Probe {
    tmux_bin: String,
}
impl Probe {
    pub async fn list(&self) {
        let _ = tokio::process::Command::new(&self.tmux_bin)
            .args(["list-sessions"])
            .status()
            .await;
    }
}'

probe "rule 2: shell tmux without -S" "without -S" "$SHELL_TARGET" \
    '#!/usr/bin/env bash
tmux new-session -d -s probe'

probe "rule 2: shell kill-session without -S" "without -S" "$SHELL_TARGET" \
    '#!/usr/bin/env bash
tmux kill-session -t probe'

probe "rule 3: TMUX_TMPDIR assignment in shell" "TMUX_TMPDIR does not isolate" "$SHELL_TARGET" \
    '#!/usr/bin/env bash
TMUX_TMPDIR=/tmp/probe tmux -S /tmp/probe/sock new-session -d -s probe'

probe "rule 3: TMUX_TMPDIR set from Rust" "TMUX_TMPDIR does not isolate" "$RUST_TARGET" \
    'pub fn probe() {
    std::env::set_var("TMUX_TMPDIR", "/tmp/probe");
}'

echo "→ compliant code must NOT fire"

compliant() {
    local name="$1" target="$2" body="$3"
    printf '%s\n' "$body" >"$target"
    local out
    out=$(./scripts/check-tmux-socket.sh 2>&1)
    rm -f "$target"
    if grep -q 'OK ✓' <<<"$out"; then
        echo "  ✓ no false positive: $name"
        pass=$((pass + 1))
    else
        echo "  ✗ FALSE POSITIVE: $name"
        echo "$out" | sed 's/^/      /'
        fail=$((fail + 1))
    fi
}

compliant "socket-addressed shell call" "$SHELL_TARGET" \
    '#!/usr/bin/env bash
tmux -S /tmp/nession-probe/tmux.sock new-session -d -s probe'

compliant "tmux -V opens no socket" "$SHELL_TARGET" \
    '#!/usr/bin/env bash
echo "tmux: $(tmux -V 2>/dev/null || echo none)"'

compliant "stripping TMUX_TMPDIR is the remedy, not the offence" "$RUST_TARGET" \
    'pub fn probe(cmd: &mut std::process::Command) {
    cmd.env_remove("TMUX_TMPDIR");
    cmd.env_remove("TMUX");
}'

compliant "non-tmux spawn marked // not-tmux" "$RUST_TARGET" \
    '// A file that mentions tmux but also spawns something else.
pub fn probe(exe: &std::path::Path) {
    // not-tmux: re-executes this binary, not tmux
    let _ = std::process::Command::new(exe).status();
}'

echo ""
echo "  $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
