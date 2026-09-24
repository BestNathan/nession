#!/usr/bin/env bash
# Regression tests for scripts/rustc-wrapper.sh.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
wrapper="$root/scripts/rustc-wrapper.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

log="$tmp/log"

cat >"$tmp/fake-rustc" <<'EOF'
#!/usr/bin/env bash
printf 'rustc:%s\n' "$*" >>"$NSESSION_WRAPPER_TEST_LOG"
EOF
chmod +x "$tmp/fake-rustc"

cat >"$tmp/sccache" <<'EOF'
#!/usr/bin/env bash
printf 'sccache:%s\n' "$*" >>"$NSESSION_WRAPPER_TEST_LOG"
"$@"
EOF
chmod +x "$tmp/sccache"

assert_line() {
  expected=$1
  actual=$(cat "$log")
  if [ "$actual" != "$expected" ]; then
    echo "rustc-wrapper selftest failed" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    echo "  Fix: keep local/CI selection logic in scripts/rustc-wrapper.sh consistent" >&2
    exit 1
  fi
}

: >"$log"
PATH="$tmp:/usr/bin:/bin" NSESSION_WRAPPER_TEST_LOG="$log" "$wrapper" "$tmp/fake-rustc" --crate-name demo
assert_line "sccache:$tmp/fake-rustc --crate-name demo
rustc:--crate-name demo"

: >"$log"
PATH="$tmp:/usr/bin:/bin" CI=true NSESSION_WRAPPER_TEST_LOG="$log" "$wrapper" "$tmp/fake-rustc" --crate-name demo
assert_line "rustc:--crate-name demo"

: >"$log"
PATH="/usr/bin:/bin" NSESSION_WRAPPER_TEST_LOG="$log" "$wrapper" "$tmp/fake-rustc" --crate-name demo
assert_line "rustc:--crate-name demo"

: >"$log"
PATH="$tmp:/usr/bin:/bin" NSESSION_DISABLE_SCCACHE=1 NSESSION_WRAPPER_TEST_LOG="$log" "$wrapper" "$tmp/fake-rustc" --crate-name demo
assert_line "rustc:--crate-name demo"

echo "rustc wrapper selftest OK ✓ local sccache + CI/no-sccache fallbacks"
