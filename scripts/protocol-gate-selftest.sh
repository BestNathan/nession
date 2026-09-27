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
#
# It also carries the two non-operation wires, because the rules that read them
# are only exercised if the fixture has some: `server.widgets.changed` is a
# notification (rule 4), and `control.ping` / `control.pong` are control wires
# (rule 5). **Two** dispatch files, because rule 5's whole claim is about every
# runtime and one file cannot tell "every" from "one".
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
    write_runtime "$WORK/tree/crates/thing/src/first.rs" core_routes
    write_runtime "$WORK/tree/crates/thing/src/second.rs" p2p_routes
}

# One runtime: a route table (so the gate reads the file as a runtime at all),
# a notification it declares, and the two control wires with a branch each.
#
# `$3` is the notification's wire, so a case can declare a bad one; `$4` is a
# control constant to leave *without* a branch, so a case can watch rule 5
# fire on a runtime that handles one of the two.
write_runtime() {
    local notification="${3:-server.widgets.changed}"
    local missing="${4:-}"
    cat > "$1" <<RS
pub const WIDGETS_CHANGED: &str = "$notification";
pub const CONTROL_PING: &str = "control.ping";
pub const CONTROL_PONG: &str = "control.pong";

$2! {
    "alpha.one" => "alpha.one" => {}
}

fn route(wire: &str) -> bool {
    match wire {
$(runtime_arms "$missing")
        _ => false,
    }
}
RS
}

runtime_arms() {
    [[ "$1" == CONTROL_PING ]] || echo "        CONTROL_PING => true,"
    [[ "$1" == CONTROL_PONG ]] || echo "        CONTROL_PONG => true,"
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

# ── 1b. `<wire>.response` is no longer advertised ───────────────────────────
# The advertised set used to be extended by the kernel's `<wire>.response` rule.
# One wire per operation removed the spelling (#953, Rule 1): a reply now carries
# the request's own wire name. A call site still naming the suffix has to be
# reported, because the derivation's removal is otherwise invisible — the gate
# would simply have kept answering "yes" to a name nothing sends.
reset_fixture
write_caller <<'TS'
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request('alpha.one.response', {});
  socket.request('beta.two', {});
}
TS
expect_fail "rule 1b — the removed response-suffix derivation" 'no runtime answers `alpha.one.response`'

# ── 1a. A name that is not an id at all ─────────────────────────────────────
reset_fixture
write_caller <<'TS'
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request('alpha_one', {});
  socket.request('beta.two', {});
}
TS
expect_fail "rule 1a — a malformed name" 'contains `_`'

# ── 1b. The listener half: a subscription ───────────────────────────────────
# `subscribe` names a wire the client is *waiting* for, so the question is not
# "who answers this" but "who sends it" — and a declared notification is the
# answer to the second and not the first.
#
# The negative case comes first and is not optional. The first attempt at
# scanning this call site asked the sender's question of a listener and
# reported three legitimate push subscriptions (`server.agents.changed` and
# its siblings) as violations. A rule that flags a conforming subscription is
# worse than no rule at all: it trains people to write exemptions, and once the
# exemptions are there it catches nothing. So the shape it must *accept* is
# pinned here, beside the shape it must reject.
reset_fixture
write_caller <<'TS'
export function go(socket: {
  request(t: string, p: unknown): void;
  subscribe(t: string, h: () => void): void;
}) {
  socket.request('alpha.one', {});
  socket.request('beta.two', {});
  socket.subscribe('server.widgets.changed', () => {});
}
TS
expect_pass "rule 1b — a conforming subscription is not flagged"

# …and a misspelling is caught, which is the only reason the call site is read:
# an unrecognised wire is ignored, so the handler never fires and nothing says
# so. The typo is a transposition of the real wire above, not some name that
# happens to be unknown.
reset_fixture
write_caller <<'TS'
export function go(socket: {
  request(t: string, p: unknown): void;
  subscribe(t: string, h: () => void): void;
}) {
  socket.request('alpha.one', {});
  socket.request('beta.two', {});
  socket.subscribe('server.widgets.chagned', () => {});
}
TS
expect_fail "rule 1b — a subscription to a wire nothing sends" 'no runtime answers `server.widgets.chagned`'

# `subscribe` is also the name of every in-process observer in the tree, where
# the argument is a callback set rather than a wire. Reading those reported
# seven correct call sites, so the flag that skips them is load-bearing — and
# this is the case that fails if someone drops it as redundant.
reset_fixture
write_caller <<'TS'
export function go(socket: { request(t: string, p: unknown): void }) {
  socket.request('alpha.one', {});
  socket.request('beta.two', {});
  store.subscribe(listener);
}
TS
expect_pass "a non-wire subscribe is not read as a protocol"

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

# ── 4. A notification names the runtime that emits it ───────────────────────
# The negative case first, and deliberately: `server.agents.changed` is exactly
# the shape this rule exists to require, and a rule that flags it would be
# worse than no rule. The fixture declares one in each runtime (`server.
# widgets.changed`), so the clean case above is already it — this repeats it
# under its own name so a change to the fixture cannot quietly drop it.
reset_fixture
expect_pass "rule 4 — a conforming notification is not flagged"

reset_fixture
write_runtime "$WORK/tree/crates/thing/src/first.rs" core_routes widgets.changed
write_runtime "$WORK/tree/crates/thing/src/second.rs" p2p_routes widgets.changed
expect_fail "rule 4 — a notification that names no emitter" 'does not name the runtime that emits it'

# The declarations are read from a file that writes its own envelope as well as
# from a file that routes: that is where `server.agents.changed` lives, and a
# rule that cannot see its own example is not a rule.
reset_fixture
cat > "$WORK/tree/crates/thing/src/registry.rs" <<'RS'
pub const WIDGETS_CHANGED: &str = "server.widgets.changed";

pub fn envelope() -> serde_json::Value {
    serde_json::json!({ "msg_type": WIDGETS_CHANGED })
}
RS
expect_pass "a notification declared by the file that builds its envelope"

# …and the same file with a bad emitter is reported, which is the half that
# proves the widened source is still checked rather than merely accepted.
reset_fixture
cat > "$WORK/tree/crates/thing/src/registry.rs" <<'RS'
pub const WIDGETS_CHANGED: &str = "widgets.changed";

pub fn envelope() -> serde_json::Value {
    serde_json::json!({ "msg_type": WIDGETS_CHANGED })
}
RS
expect_fail "rule 4 — a hand-built envelope with a bad emitter" 'does not name the runtime that emits it'

# ── 5. A control wire is dispatched by every runtime ────────────────────────
reset_fixture
expect_pass "rule 5 — control wires carried by every runtime are not flagged"

# One runtime, one wire, no branch: the asymmetry the category exists to
# forbid, and the only form of it a static check can see.
reset_fixture
write_runtime "$WORK/tree/crates/thing/src/second.rs" p2p_routes server.widgets.changed CONTROL_PONG
expect_fail "rule 5 — a control wire with a branch in only one runtime" '`control.pong` has no branch here'

# Declared and carried by nothing at all. A prefix test would call this
# conforming, which is why the rule reads branches instead.
reset_fixture
cat >> "$WORK/tree/crates/thing/src/first.rs" <<'RS'

pub const CONTROL_SILENT: &str = "control.silent";
RS
expect_fail "rule 5 — a control wire no runtime carries" '`control.silent` has no branch here'

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

echo
if [[ $failures -eq 0 ]]; then
    echo -e "${GREEN}protocol gate selftest OK ✓${NC}"
    exit 0
fi
echo -e "${RED}${failures} selftest case(s) failed${NC}"
exit 1
