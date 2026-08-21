#!/usr/bin/env bash
# Static check: test code must not share state between test *runs*.
#
# Two test runs overlap routinely here — several git worktrees coexist, and CI
# can run while a developer runs tests locally. State shared between runs makes
# them fight, and the resulting failures look random.
#
# This is a grep-level check, deliberately, because it is fast (<1s), it is
# deterministic, and it points at the offending line. Running the whole suite
# twice (scripts/check-test-concurrency.sh) is the complementary tool: it finds
# *unknown* categories, but it is probabilistic — a race can pass one run and
# fail the next — and doubling machine load can make timing-sensitive tests fail
# spuriously. So the runtime check stays a diagnostic, and this one is the gate.
#
# Rules enforced (see "测试并发安全" in CLAUDE.md):
#
#   1. No hardcoded listen port. Bind "127.0.0.1:0" and let the OS assign one;
#      a reserved range still collides between two concurrent runs.
#   2. No fixed filename under the shared system temp dir. Use
#      tempfile::tempdir(), whose path is unique per run.
#   3. A test touching paths::nession_home() must set NESSION_HOME first, or it
#      reads and writes the developer's real $HOME/.nession.
#
# Scope: everything under crates/*/tests/, plus the part of each crates/*/src/
# file that follows its first `#[cfg(test)]`.
#
# Usage:
#   ./scripts/check-test-isolation.sh          # check the tree
#   ./scripts/check-test-isolation.sh --list   # print the scanned regions

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

findings=0

# Emit one finding.
report() {
    local file="$1" line="$2" rule="$3" text="$4" fix="$5"
    echo -e "${RED}✗${NC} ${file}:${line}"
    echo -e "    ${YELLOW}${rule}${NC}"
    echo -e "    $(printf '%s' "$text" | sed 's/^[[:space:]]*//')"
    echo -e "    ${GREEN}fix:${NC} ${fix}"
    echo ""
    findings=$((findings + 1))
}

# Print "<file>:<first-test-line>" for every file with test code.
# For crates/*/tests/** the whole file counts; for src/** only the region after
# the first `#[cfg(test)]`.
test_regions() {
    find crates -type f -name '*.rs' -path '*/tests/*' 2>/dev/null |
        while IFS= read -r f; do echo "$f:1"; done
    find crates -type f -name '*.rs' -path '*/src/*' 2>/dev/null |
        while IFS= read -r f; do
            local n
            n=$(grep -n '^\s*#\[cfg(test)\]' "$f" 2>/dev/null | head -1 | cut -d: -f1)
            [[ -n ${n:-} ]] && echo "$f:$n"
        done
}

if [[ ${1:-} == "--list" ]]; then
    test_regions
    exit 0
fi

while IFS= read -r region; do
    file="${region%:*}"
    start="${region##*:}"

    # ---- Rule 1: hardcoded listen port ------------------------------------
    # `let port = 29081;` — the give-away for a fixed bind target.
    while IFS=: read -r ln text; do
        [[ -z ${ln:-} ]] && continue
        ((ln < start)) && continue
        report "$file" "$ln" "hardcoded port literal (rule 1)" "$text" \
            'bind("127.0.0.1:0") and return listener.local_addr(); for an address nothing listens on, use a free_port() helper'
    done < <(grep -nE '^\s*let (port|_port) *(:[^=]*)?= *[0-9]+ *;' "$file" 2>/dev/null)

    # A non-zero port written straight into a bind or listen_address.
    # Only in files that actually stand a server up — `listen_address` also
    # appears in serde round-trip tests, where it is data, not a bind target.
    if grep -qE 'WebSocketServer::new|AgentServer::new|TcpListener::bind' "$file" 2>/dev/null; then
        while IFS=: read -r ln text; do
            [[ -z ${ln:-} ]] && continue
            ((ln < start)) && continue
            report "$file" "$ln" "hardcoded bind address (rule 1)" "$text" \
                'use "127.0.0.1:0" so the OS assigns the port'
        done < <(grep -nE '(bind|listen_address)[^0-9]*"127\.0\.0\.1:[0-9]*[1-9][0-9]*"' "$file" 2>/dev/null |
            grep -vE '^\s*[0-9]+:\s*(//|///|\*|assert)')
    fi

    # `bind(format!("127.0.0.1:{port}"))` — a bind driven by a port variable.
    while IFS=: read -r ln text; do
        [[ -z ${ln:-} ]] && continue
        ((ln < start)) && continue
        # Allowed in a helper that exists to re-bind a released port.
        grep -q 'fn start_mock_server_on\|fn .*_on(' <<<"$(sed -n "$((ln > 12 ? ln - 12 : 1)),${ln}p" "$file")" && continue
        report "$file" "$ln" "bind on a caller-supplied port (rule 1)" "$text" \
            'bind "127.0.0.1:0" instead, or name the helper *_on() if it deliberately re-binds a free_port()'
    done < <(grep -nE '(bind|listen_address)[^"]*format!\("127\.0\.0\.1:\{' "$file" 2>/dev/null)

    # ---- Rule 2: fixed name in the shared temp dir -------------------------
    # The violation is *naming a fixed artifact* in the shared dir, not using
    # that dir as a base — `temp_dir()` alone is a legitimate default, and the
    # tests that pass it around only compute paths or run no-ops.
    while IFS=: read -r ln text; do
        [[ -z ${ln:-} ]] && continue
        ((ln < start)) && continue
        report "$file" "$ln" "fixed name in the shared temp dir (rule 2)" "$text" \
            'use tempfile::tempdir() and keep the TempDir alive; its path is unique per run'
    done < <(grep -nE 'temp_dir\(\)\.join\("' "$file" 2>/dev/null |
        grep -vE '^\s*[0-9]+:\s*(//|///|\*)')

    # A db/file path stamped with time plus a counter is not unique across
    # processes: two starting in the same second both begin the counter at 0.
    while IFS=: read -r ln text; do
        [[ -z ${ln:-} ]] && continue
        ((ln < start)) && continue
        report "$file" "$ln" "time+counter path is not unique across processes (rule 2)" "$text" \
            'use tempfile::tempdir(); two processes starting in the same second produce the same name'
    done < <(grep -nE 'static COUNTER: AtomicU64' "$file" 2>/dev/null)

    # ---- Rule 3: the developer's real config dir --------------------------
    if grep -qE 'nession_home\(\)' "$file" 2>/dev/null &&
        ! grep -qE 'NESSION_HOME|NESSION_HOME_ENV' "$file" 2>/dev/null; then
        while IFS=: read -r ln text; do
            [[ -z ${ln:-} ]] && continue
            ((ln < start)) && continue
            report "$file" "$ln" "nession_home() without NESSION_HOME (rule 3)" "$text" \
                'set NESSION_HOME to a tempfile::tempdir() first, or this edits the real $HOME/.nession'
        done < <(grep -nE 'nession_home\(\)' "$file" 2>/dev/null)
    fi
done < <(test_regions)

if [[ $findings -eq 0 ]]; then
    echo -e "${GREEN}Test isolation OK ✓${NC}"
    exit 0
fi
echo -e "${RED}${findings} test-isolation violation(s)${NC}"
echo -e "${YELLOW}Background: scripts/check-test-concurrency.sh runs every test binary"
echo -e "twice at once and shows what these cause. See \"测试并发安全\" in CLAUDE.md.${NC}"
exit 1
