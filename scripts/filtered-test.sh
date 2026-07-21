#!/usr/bin/env bash
# Run cargo test and print only failures + summary lines.
# Preserves cargo test exit code.
set -o pipefail

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

cargo test --workspace --color=always >"$tmp" 2>&1
rc=$?

# Print only FAILED lines and error lines, plus the final test result
grep -E '(FAILED|^error\[|^error:)' "$tmp" || true
grep '^test result:' "$tmp"

exit $rc
