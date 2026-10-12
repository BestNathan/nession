#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
WORK="$(mktemp -d /tmp/nession-version-gate-selftest.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
FIXTURE="$WORK/repo"
mkdir -p "$FIXTURE/gates/lib" "$FIXTURE/gates/checks" "$FIXTURE/web"
cp "$ROOT/gates/lib/common.sh" "$FIXTURE/gates/lib/common.sh"
cp "$ROOT/gates/checks/release-version-consistency.sh" "$FIXTURE/gates/checks/release-version-consistency.sh"
cat >"$FIXTURE/Cargo.toml" <<'CARGO'
[workspace]
members = []
[workspace.package]
version = "0.35.0"
CARGO
cat >"$FIXTURE/web/package.json" <<'JSON'
{"name":"fixture","version":"0.35.0"}
JSON
fail() { echo "release-version-consistency-selftest: $*" >&2; exit 1; }
capture() {
  local expected="$1" outfile="$2" status=0
  (cd / && bash "$FIXTURE/gates/checks/release-version-consistency.sh") >"$outfile" 2>&1 || status=$?
  [ "$status" -eq "$expected" ] || fail "expected $expected got $status: $(cat "$outfile")"
}
capture 0 "$WORK/pass.log"
grep -F '✓ release-version-consistency' "$WORK/pass.log" >/dev/null || fail 'valid versions did not pass'
printf '{"name":"fixture","version":"0.36.0"}\n' >"$FIXTURE/web/package.json"
capture 1 "$WORK/mismatch.log"
grep -F '[FAIL] release-version-consistency' "$WORK/mismatch.log" >/dev/null || fail 'mismatch was not FAIL'
grep -F 'version mismatch' "$WORK/mismatch.log" >/dev/null || fail 'mismatch omitted explanation'
rm "$FIXTURE/web/package.json"
capture 2 "$WORK/missing-web.log"
grep -F '[ERROR] release-version-consistency' "$WORK/missing-web.log" >/dev/null || fail 'unreadable Web version was not ERROR'
cat >"$FIXTURE/web/package.json" <<'JSON'
{"name":"fixture","version":"0.35.0"}
JSON
rm "$FIXTURE/Cargo.toml"
capture 2 "$WORK/missing-cargo.log"
grep -F '[ERROR] release-version-consistency' "$WORK/missing-cargo.log" >/dev/null || fail 'unreadable Cargo version was not ERROR'
echo 'release-version-consistency-selftest: 4 positive/negative cases passed'
