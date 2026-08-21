#!/usr/bin/env bash
# Verify scripts/check-test-isolation.sh actually fires. Injects one violation
# of each rule into a scratch test file, checks it is reported, then removes it.
# A gate that silently stops detecting is worse than no gate.
set -uo pipefail

TARGET="crates/nession-common/tests/zz_isolation_probe.rs"
mkdir -p "$(dirname "$TARGET")"

pass=0
fail=0

probe() {
    local name="$1" expect="$2" body="$3"
    printf '%s\n' "$body" >"$TARGET"
    local out
    out=$(./scripts/check-test-isolation.sh 2>&1)
    if grep -q "$expect" <<<"$out"; then
        echo "  ✓ detected: $name"
        pass=$((pass + 1))
    else
        echo "  ✗ MISSED:   $name  (expected /$expect/)"
        echo "$out" | sed 's/^/      /'
        fail=$((fail + 1))
    fi
    rm -f "$TARGET"
}

echo "→ each rule must fire on an injected violation"

probe "rule 1: let port = literal" "hardcoded port literal" \
    '#[test]
fn t() {
    let port = 31234;
    let _ = port;
}'

probe "rule 1: hardcoded bind address" "hardcoded bind address" \
    'use tokio::net::TcpListener;
#[test]
fn t() {
    let _ = TcpListener::bind("127.0.0.1:31235");
}'

probe "rule 1: bind on a supplied port" "bind on a caller-supplied port" \
    'use tokio::net::TcpListener;
async fn helper(port: u16) {
    let _ = TcpListener::bind(format!("127.0.0.1:{port}")).await;
}'

probe "rule 2: fixed name in temp dir" "fixed name in the shared temp dir" \
    '#[test]
fn t() {
    let _ = std::env::temp_dir().join("nession-probe-fixed.db");
}'

probe "rule 2: time + counter path" "time+counter path is not unique" \
    'use std::sync::atomic::AtomicU64;
static COUNTER: AtomicU64 = AtomicU64::new(0);'

probe "rule 3: nession_home without NESSION_HOME" "without NESSION_HOME" \
    '#[test]
fn t() {
    let _ = nession_common::paths::nession_home().unwrap();
}'

echo "→ a compliant file must NOT fire"
printf '%s\n' 'use tokio::net::TcpListener;
#[test]
fn t() {
    let _dir = tempfile::tempdir().unwrap();
}
async fn helper() {
    let _ = TcpListener::bind("127.0.0.1:0").await;
}' >"$TARGET"
if ./scripts/check-test-isolation.sh >/dev/null 2>&1; then
    echo "  ✓ no false positive on compliant code"
    pass=$((pass + 1))
else
    echo "  ✗ FALSE POSITIVE on compliant code"
    ./scripts/check-test-isolation.sh 2>&1 | sed 's/^/      /'
    fail=$((fail + 1))
fi
rm -f "$TARGET"
rmdir "$(dirname "$TARGET")" 2>/dev/null

echo ""
echo "passed $pass, failed $fail"
[[ $fail -eq 0 ]]
