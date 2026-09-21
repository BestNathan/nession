#!/usr/bin/env bash
# Prove the protocol gate still catches what it exists for.
#
# A gate that has quietly stopped matching reports success, and success is
# indistinguishable from "nothing is wrong". So each rule is injected into a
# fixture tree and the gate has to fail with that rule named — including the
# shape that started this: a sender naming a wire no runtime answers (#913).
#
# The fixture is a tree of its own because the gate reads `process.cwd()`. That
# also means rule 2 can be exercised at all: on the real tree every unit has a
# caller, so the only way to watch the rule fire is to declare a unit nothing
# calls.
#
# No `sed`: `-i` differs between BSD and GNU, and this runs on both.

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

GATE="$(cd "$(dirname "$0")" && pwd)/protocol-gate.mjs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0

# ── The fixture ─────────────────────────────────────────────────────────────
# Two units, both called. A clean tree has to pass, or nothing below means
# anything.
reset_fixture() {
    rm -rf "$WORK/tree"
    mkdir -p "$WORK/tree/web/src/generated/protocol/core/alpha-one" \
        "$WORK/tree/web/src/generated/protocol/core/beta-two" \
        "$WORK/tree/web/src/app" \
        "$WORK/tree/crates/thing/src"

    cat > "$WORK/tree/web/src/generated/protocol/core/alpha-one/v1.ts" <<'TS'
export const PROTOCOL = 'alpha.one';
export const WIRES = ['alpha.one'] as const;
export const WIRE = 'alpha.one';
TS
    cat > "$WORK/tree/web/src/generated/protocol/core/beta-two/v1.ts" <<'TS'
export const PROTOCOL = 'beta.two';
export const WIRES = ['beta.two'] as const;
export const WIRE = 'beta.two';
TS
    write_caller <<'TS'
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request('alpha.one', {});
  socket.request('beta.two', {});
}
TS
    echo 'pub fn nothing() {}' > "$WORK/tree/crates/thing/src/lib.rs"
}

write_caller() { cat > "$WORK/tree/web/src/app/caller.ts"; }

run_gate() { (cd "$WORK/tree" && node "$GATE" 2>&1); }

expect_fail() {
    local label="$1" want="$2" out
    out="$(run_gate)"
    if [[ $? -eq 0 ]]; then
        echo -e "${RED}✗${NC} ${label}: gate passed, expected a failure"
        failures=$((failures + 1))
        return
    fi
    if ! grep -qF "$want" <<<"$out"; then
        echo -e "${RED}✗${NC} ${label}: failed, but never said \`$want\`"
        sed 's/^/      /' <<<"$out"
        failures=$((failures + 1))
        return
    fi
    echo -e "${GREEN}✓${NC} ${label}"
}

expect_pass() {
    local label="$1" out
    out="$(run_gate)"
    if [[ $? -eq 0 ]]; then
        echo -e "${GREEN}✓${NC} ${label}"
    else
        echo -e "${RED}✗${NC} ${label}: the gate failed on a tree that is correct"
        sed 's/^/      /' <<<"$out"
        failures=$((failures + 1))
    fi
}

# ── 0. The fixture is clean ─────────────────────────────────────────────────
reset_fixture
expect_pass "a clean fixture passes"

# ── 1b. The #913 shape: a sender naming a wire nothing answers ──────────────
reset_fixture
write_caller <<'TS'
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request('alpha.gone', {});
  socket.request('beta.two', {});
}
TS
expect_fail "rule 1b — a wire no runtime answers" 'no runtime answers `alpha.gone`'

# ── 1a. A name that is not an id at all ─────────────────────────────────────
reset_fixture
write_caller <<'TS'
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request('alpha_one', {});
  socket.request('beta.two', {});
}
TS
expect_fail "rule 1a — a malformed name" 'contains `_`'

# ── 2. A declared unit nothing calls ────────────────────────────────────────
reset_fixture
write_caller <<'TS'
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request('beta.two', {});
}
TS
expect_fail "rule 2 — a protocol with no caller" '`alpha.one` has no caller'

# ── The resolution paths, which are what stop the gate crying wolf ──────────
# A `pub const` is a declared wire. Treating every non-literal as unnameable
# reported eighty call sites that were all correct.
reset_fixture
cat > "$WORK/tree/crates/thing/src/lib.rs" <<'RS'
pub const ALPHA: &str = "alpha.one";

pub fn go() -> String {
    proto_msg(ALPHA).msg_type
}
RS
write_caller <<'TS'
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request('beta.two', {});
}
TS
expect_pass "a call through a declared constant is not a violation"

# A const that names a wire nothing answers is still a violation.
reset_fixture
cat > "$WORK/tree/crates/thing/src/lib.rs" <<'RS'
pub const ALPHA: &str = "alpha.gone";

pub fn go() -> String {
    proto_msg(ALPHA).msg_type
}
RS
write_caller <<'TS'
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request('beta.two', {});
}
TS
expect_fail "a constant naming a wire that does not exist" 'which no runtime answers'

# An imported binding is a wire by construction.
reset_fixture
write_caller <<'TS'
import { WIRE as ALPHA_WIRE } from '@/generated/protocol/core/alpha-one/v1';

export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request(ALPHA_WIRE, {});
  socket.request('beta.two', {});
}
TS
expect_pass "a call through an imported binding is not a violation"

# A name that resolves to nothing is still a violation — this is the half that
# keeps resolution from becoming a way to pass anything through a variable.
reset_fixture
write_caller <<'TS'
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request(mysteryWire, {});
  socket.request('beta.two', {});
}
TS
expect_fail "an unresolvable name is reported" 'names no declared wire'

# ── The escape hatches themselves ───────────────────────────────────────────
reset_fixture
write_caller <<'TS'
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request('alpha.one', {});
  socket.request('beta.two', {});
  // not-protocol: a placeholder, as far as this file is concerned.
  socket.request('alpha.gone', {});
}
TS
expect_pass "a marked line is excused"

reset_fixture
write_caller <<'TS'
// not-protocol-file: this file is about the transport, not about any protocol.
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request('alpha.gone', {});
  socket.request('alpha.one', {});
  socket.request('beta.two', {});
}
TS
expect_pass "a header-marked file is excused"

# …but only in its header. Halfway down is not a way to exempt a file, which is
# the failure mode a path-wide exemption would have had.
reset_fixture
write_caller <<'TS'
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request('alpha.one', {});
  socket.request('beta.two', {});
}

// not-protocol-file: smuggled below the header.

export function other(socket: { request(t: string, p: unknown): void }) {
  socket.request('alpha.gone', {});
}
TS
expect_fail "a file marker below the header does not exempt" 'no runtime answers `alpha.gone`'

echo
if [[ $failures -eq 0 ]]; then
    echo -e "${GREEN}protocol gate selftest OK ✓${NC}"
    exit 0
fi
echo -e "${RED}${failures} selftest case(s) failed${NC}"
exit 1
