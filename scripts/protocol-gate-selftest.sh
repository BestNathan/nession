#!/usr/bin/env bash
# Prove the protocol gate still catches what it exists for.
#
# A gate that has quietly stopped matching reports success, and success is
# indistinguishable from "nothing is wrong". So each rule is injected into a
# fixture tree and the gate has to fail with that rule named — including the
# shapes that started this: a sender naming a wire no runtime answers (#913),
# and a listener subscribing to one nothing declares (#949).
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

# ── 3. The transitional alias path ──────────────────────────────────────────
# Rust refuses a use of the missing module, so the interesting case is the
# module coming back — which the compiler would accept.
reset_fixture
rm -rf "$WORK/tree/crates/nession-common"
mkdir -p "$WORK/tree/crates/nession-common/src"
echo 'pub mod protocol;' > "$WORK/tree/crates/nession-common/src/lib.rs"
cat > "$WORK/tree/crates/nession-common/src/protocol.rs" <<'RS'
pub use nession_protocol::contracts::agent::v1::*;
RS
expect_fail "rule 3 — the alias module coming back" 'the transitional alias module is back'

reset_fixture
mkdir -p "$WORK/tree/crates/thing/src"
cat > "$WORK/tree/crates/thing/src/lib.rs" <<'RS'
use nession_common::protocol::AgentMetadata;
RS
write_caller <<'TS'
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request('alpha.one', {});
  socket.request('beta.two', {});
}
TS
expect_fail "rule 3 — an import of the alias path" 'the transitional alias path'

# ── 4. A subscription naming a wire nothing declares ────────────────────────
# The listener half of the same failure, and the half rule 1 cannot reach: a
# typo'd sender waits for a reply that never comes, a typo'd listener is silent
# from the start. Rule 1 asks whether some runtime *answers* the wire, and a
# push is answered by nobody — so the wires a subscription legitimately names
# are exactly the ones the advertised set does not contain (#949).
reset_fixture
write_caller <<'TS'
export function go(socket: {
  request(t: string, p: unknown): void;
  subscribe(t: string, h: () => void): void;
}) {
  socket.request('alpha.one', {});
  socket.request('beta.two', {});
  socket.subscribe('alpha.chagned', () => {});
}
TS
expect_fail "rule 4 — a subscription naming a wire nothing declares" 'nothing declares `alpha.chagned`'

# The direction that matters just as much: a subscription to a push is the
# *normal* case, so a rule that flagged it would be worse than no rule at all.
# The fixture declares the push the way the server does — a `pub const` beside
# the code that emits it, and nothing at a sender call site, because a push is
# never sent as a request.
reset_fixture
cat > "$WORK/tree/crates/thing/src/lib.rs" <<'RS'
pub const ALPHA_CHANGED: &str = "alpha.changed";
RS
write_caller <<'TS'
export function go(socket: {
  request(t: string, p: unknown): void;
  subscribe(t: string, h: () => void): void;
}) {
  socket.request('alpha.one', {});
  socket.request('beta.two', {});
  socket.subscribe('alpha.changed', () => {});
}
TS
expect_pass "a subscription to a declared push is not a violation"

# The other source of the declared set — a wire some sender names. A request and
# a subscription naming the same wire is what a request/response pair looks like
# from the listener's side, and it has to stay clean.
reset_fixture
write_caller <<'TS'
export function go(socket: {
  request(t: string, p: unknown): void;
  subscribe(t: string, h: () => void): void;
}) {
  socket.request('alpha.one', {});
  socket.request('beta.two', {});
  socket.subscribe('alpha.one', () => {});
}
TS
expect_pass "a subscription to a wire a sender names is not a violation"

# …and the line escape covers rule 4, which is what keeps `AgentsPlugin.ts`'s
# deliberately-tested non-protocol subscription from failing the gate. Only
# where it is written: the unmarked site above is still a violation.
reset_fixture
write_caller <<'TS'
export function go(socket: {
  request(t: string, p: unknown): void;
  subscribe(t: string, h: () => void): void;
}) {
  socket.request('alpha.one', {});
  socket.request('beta.two', {});
  // not-protocol: a wire nothing sends, kept on purpose.
  socket.subscribe('alpha.chagned', () => {});
}
TS
expect_pass "a marked subscription is excused"

echo
if [[ $failures -eq 0 ]]; then
    echo -e "${GREEN}protocol gate selftest OK ✓${NC}"
    exit 0
fi
echo -e "${RED}${failures} selftest case(s) failed${NC}"
exit 1
