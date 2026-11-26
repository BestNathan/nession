#!/usr/bin/env bash
# Verify scripts/check-test-isolation.sh actually fires. Injects one violation
# of each rule into a scratch test file, checks it is reported, then removes it.
# A gate that silently stops detecting is worse than no gate.
set -uo pipefail

# Keep the inventory check out of each probe run; the selftest runs it once at
# the end against the committed inventory.
export NSESSION_TEST_ISOLATION_SELFTEST=1

TARGET="crates/nession-common/tests/zz_isolation_probe.rs"
JS_TARGET="e2e/runner/zz_isolation_probe.mjs"
E2E_TARGET="e2e/tests/browser/zz_isolation_probe.spec.ts"
mkdir -p "$(dirname "$TARGET")" "$(dirname "$E2E_TARGET")"

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

js_probe() {
    local target="$1" name="$2" expect="$3" body="$4"
    printf '%s\n' "$body" >"$target"
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
    rm -f "$target"
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

probe "rule 3: nession_home without NESION_HOME" "without an owned root" \
    '#[test]
fn t() {
    let _ = nession_common::paths::nession_home().unwrap();
}'

probe "rule 4: misspelled socket override" "misspelled tmux-socket override" \
    '#[test]
fn t() {
    std::env::set_var("NESSON_TMUX_SOCKET", "/tmp/probe.sock");
}'

probe "rule 5: process-global env mutation" "process-global env mutation" \
    '#[test]
fn t() {
    std::env::set_var("PROBE", "1");
    std::env::remove_var("PROBE");
}'

probe "rule 7: production metadata store" "SessionMetadataStore::new in an integration test" \
    '#[test]
fn t() {
    let _ = nession_agent::session::metadata::SessionMetadataStore::new(
        std::sync::Arc::new(nession_agent::tmux::SessionManager::new()),
    );
}'

js_probe "$E2E_TARGET" "rule 6: fixed E2E endpoint" "fixed E2E endpoint or run root" \
    "import { test } from '@playwright/test';
test('probe', async ({ page }) => {
  await page.goto('/?server_url=' + encodeURIComponent('ws://localhost:19090/ws'));
});"

js_probe "$JS_TARGET" "rule 9: recursive deletion of ambient path" "recursive deletion of ambient or caller-supplied path" \
    "const fs = require('node:fs');
fs.rmSync(process.env.HOME, { recursive: true, force: true });"

js_probe "$JS_TARGET" "rule 10: harness spreads process.env" "harness spreads process.env into a child" \
    "const { spawn } = require('node:child_process');
spawn('true', [], { env: { ...process.env, CI: '' } });"

echo "→ a compliant file must NOT fire"
printf '%s\n' 'use tokio::net::TcpListener;
#[test]
fn t() {
    let _dir = tempfile::tempdir().unwrap();
    let _own = std::path::Path::new("/tmp/nession-probe/tmux.sock");
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
rm -f "$TARGET" "$JS_TARGET" "$E2E_TARGET"
rmdir "$(dirname "$TARGET")" 2>/dev/null

echo "→ the committed Test Runtime inventory must be current"
if node scripts/test-runtime-inventory.mjs --check; then
    echo "  ✓ inventory current, no unresolved reference"
    pass=$((pass + 1))
else
    echo "  ✗ inventory stale or has unresolved references"
    fail=$((fail + 1))
fi

echo ""
echo "passed $pass, failed $fail"
[[ $fail -eq 0 ]]
