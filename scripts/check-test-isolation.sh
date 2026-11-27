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
#   3. A test touching a production path resolver (nession_home/runtime_dir/...)
#      must set the matching root env or use an explicit owned root.
#   4. The misspelled `NESSON_TMUX_SOCKET` is never trusted; the resolver reads
#      `NESION_TMUX_SOCKET` only (#4596/#4597).
#   5. No process-global env mutation in integration tests; use an explicit
#      input seam or a child-local env (#4597 F10).
#   6. E2E/Acceptance code uses the run-scoped constants from e2e/runtime.ts,
#      never fixed ports or /tmp/nession-e2e (#4597 F09).
#   7. Integration tests construct SessionMetadataStore::with_root, never the
#      production default (#4597 F04).
#   9. No recursive deletion derived directly from the ambient environment or
#      caller options; ownership must be verified first (#4597 F03).
#  10. Harness files never spread process.env into children; build a sanitized
#      run-owned environment (#4597 F07).
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
# the first real test module (`#[cfg(test)] mod tests`). An inline
# `#[cfg(test)] use` earlier in a production file must not turn the rest of the
# file into "test code" — that misclassification hid production resolvers from
# this check and produced false findings.
test_regions() {
    find crates -type f -name '*.rs' -path '*/tests/*' 2>/dev/null |
        while IFS= read -r f; do echo "$f:1"; done
    find crates -type f -name '*.rs' -path '*/src/*' 2>/dev/null |
        while IFS= read -r f; do
            local n
            n=$(awk '
                /^[[:space:]]*#\[cfg\(test\)\][[:space:]]*mod / { print NR; exit }
                /^[[:space:]]*#\[cfg\(test\)\][[:space:]]*$/ {
                    line = NR
                    getline next_line
                    if (next_line ~ /^[[:space:]]*(pub )?mod /) { print line; exit }
                }
            ' "$f" 2>/dev/null)
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

    # ---- Rule 3: production path resolvers without an owned root -----------
    if grep -qE 'nession_home\(\)|runtime_dir\(\)|ensure_runtime_dir\(\)|agent_sessions_dir\(\)|agent_claude_bindings_dir\(\)|agent_env_bindings_dir\(\)|server_db_path\(\)' "$file" 2>/dev/null &&
        ! grep -qE 'NESION_HOME|NESION_RUNTIME_DIR|test_runtime|with_root|runRoot|sanitizedEnv' "$file" 2>/dev/null; then
        while IFS=: read -r ln text; do
            [[ -z ${ln:-} ]] && continue
            ((ln < start)) && continue
            # A pure comparison of the resolved default (assert_eq!/assert!)
            # reads no state and writes nothing; the harness still owns the
            # path. Only a test that *uses* the resolver is a finding.
            if sed -n "$((ln > 3 ? ln - 3 : 1)),${ln}p" "$file" 2>/dev/null |
                grep -qE 'assert(_eq|_ne)?!'; then
                continue
            fi
            report "$file" "$ln" "production path resolver without an owned root (rule 3)" "$text" \
                'set NESION_HOME/NESION_RUNTIME_DIR (the harness does) or pass an explicit with_root/tempdir root'
        done < <(grep -nE 'nession_home\(\)|runtime_dir\(\)|ensure_runtime_dir\(\)|agent_sessions_dir\(\)|agent_claude_bindings_dir\(\)|agent_env_bindings_dir\(\)|server_db_path\(\)' "$file" 2>/dev/null)
    fi
done < <(test_regions)

# ---- Rule 4: the misspelled socket override (repo-wide) -------------------
while IFS=: read -r f ln text; do
    [[ -z ${ln:-} ]] && continue
    case "$f" in
        crates/nession-agent/src/tmux/cmd.rs) continue ;;
        docs/*) continue ;;
        scripts/check-test-isolation.sh) continue ;;
        scripts/check-test-isolation-selftest.sh) continue ;;
        scripts/test-runtime-inventory.mjs) continue ;;
    esac
    report "$f" "$ln" "misspelled tmux-socket override (rule 4)" "$text" \
        'use NESION_TMUX_SOCKET (the resolver reads only that name); the tmux-socket chokepoint diagnoses the misspelling'
done < <(grep -rn 'NESSON_TMUX_SOCKET' crates scripts e2e .github 2>/dev/null |
    grep -v node_modules | grep -vE ':[0-9]+:[[:space:]]*(//|/\*|\*)')

# ---- Rule 5: process-global env mutation in integration tests -------------
while IFS=: read -r f ln text; do
    [[ -z ${ln:-} ]] && continue
    case "$f" in
        crates/*/tests/*) ;;
        *) continue ;;
    esac
    report "$f" "$ln" "process-global env mutation in an integration test (rule 5)" "$text" \
        'use an explicit-input seam, a child-local env, or a focused unit test with a serialized guard'
done < <(grep -rnE '\bstd::env::(set|remove)_var' crates --include='*.rs' 2>/dev/null |
    grep -vE ':[0-9]+:[[:space:]]*(//|/\*|\*)')

# ---- Rule 6: fixed E2E/Acceptance endpoints and roots ---------------------
while IFS=: read -r f ln text; do
    [[ -z ${ln:-} ]] && continue
    report "$f" "$ln" "fixed E2E endpoint or run root (rule 6)" "$text" \
        'import E2E_SERVER_URL/E2E_AGENT_URL/E2E_WEB_ORIGIN/E2E_RUN_DIR from e2e/runtime.ts; the run owns a leased port block and a private root'
done < <(grep -rnE 'ws://(localhost|127\.0\.0\.1):(19090|19091|19092)|http://localhost:4173|/tmp/nession-e2e' \
    e2e/tests e2e/helpers e2e/pages e2e/acceptance/cases --include='*.ts' --include='*.js' --include='*.cjs' 2>/dev/null |
    grep -v node_modules | grep -vE ':[0-9]+:[[:space:]]*(//|/\*|\*)')

# ---- Rule 7: SessionMetadataStore uses the production default -------------
while IFS=: read -r f ln text; do
    [[ -z ${ln:-} ]] && continue
    case "$f" in
        crates/*/tests/*) ;;
        *) continue ;;
    esac
    report "$f" "$ln" "SessionMetadataStore::new in an integration test (rule 7)" "$text" \
        'use SessionMetadataStore::with_root with the test tempdir; the default writes into ~/.nession/agent/sessions'
done < <(grep -rn 'SessionMetadataStore::new' crates --include='*.rs' 2>/dev/null |
    grep -vE ':[0-9]+:[[:space:]]*(//|/\*|\*)')

# ---- Rule 9: recursive deletion from ambient input ------------------------
while IFS=: read -r f ln text; do
    [[ -z ${ln:-} ]] && continue
    report "$f" "$ln" "recursive deletion of ambient or caller-supplied path (rule 9)" "$text" \
        'verify the run-root manifest/owner first (assertOwnedPath/removeRunRoot) and delete only an owned path'
done < <(grep -rnE 'rmSync\(\s*(process\.env|options\??\.|options\.)' \
    e2e/runner e2e/acceptance e2e/globalSetup.ts e2e/runtime.ts \
    --include='*.js' --include='*.mjs' --include='*.cjs' --include='*.ts' 2>/dev/null |
    grep -v node_modules | grep -vE ':[0-9]+:[[:space:]]*(//|/\*|\*)')

# ---- Rule 10: harness spreads the ambient environment ---------------------
while IFS=: read -r f ln text; do
    [[ -z ${ln:-} ]] && continue
    report "$f" "$ln" "harness spreads process.env into a child (rule 10)" "$text" \
        'build the child environment with sanitizedEnv(runRoot, tmuxSocket, overrides) from e2e/runner/runtime/test-runtime.js'
done < <(grep -rn '\.\.\.process\.env' \
    e2e/runner e2e/globalSetup.ts e2e/runtime.ts \
    --include='*.js' --include='*.mjs' --include='*.cjs' --include='*.ts' 2>/dev/null |
    grep -v node_modules | grep -vE ':[0-9]+:[[:space:]]*(//|/\*|\*)')

# ---- Machine-readable inventory (#4597 SC-07) -----------------------------
# The committed inventory is generated, never hand-edited. `--check` fails when
# it is stale or when a reference is still unclassified. Skipped inside the
# checker's own selftest, which runs it explicitly once.
if [ "${NSESSION_TEST_ISOLATION_SELFTEST:-0}" != 1 ] &&
    command -v node >/dev/null 2>&1 &&
    [ -f scripts/test-runtime-inventory.mjs ]; then
    if ! node scripts/test-runtime-inventory.mjs --check; then
        findings=$((findings + 1))
    fi
fi

if [[ $findings -eq 0 ]]; then
    echo -e "${GREEN}Test isolation OK ✓${NC}"
    exit 0
fi
echo -e "${RED}${findings} test-isolation violation(s)${NC}"
echo -e "${YELLOW}Background: scripts/check-test-concurrency.sh runs every test binary"
echo -e "twice at once and shows what these cause. See \"测试并发安全\" in CLAUDE.md.${NC}"
exit 1
