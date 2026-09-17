#!/usr/bin/env bash
# The canonical Design System gate (issue #759).
#
# One implementation, three entry points:
#
#   manual / Agent   →  just design-check
#   git hooks        →  .githooks/pre-commit, .githooks/pre-push
#   CI               →  .github/workflows/quality.yml (through `just web-lint`)
#
# Hooks and CI call this script rather than listing design checks themselves.
# That is the whole point: when the three entry points each carry their own
# list, they drift, and a violation caught by one is silently absent from the
# others. Before this script existed, pre-commit ran `web-lint` (token/contract
# checks) but not `design-test`, pre-push ran `design-test` but not the token
# checks, and editing `design/tokens/*.json` on its own ran neither — a token
# source edit whose generated artifact was stale committed cleanly.
#
# Division of ownership, so that neither half can drift on its own:
#
#   this script     — WHICH checks constitute the design gate
#   justfile        — WHAT command implements each one
#   eslint.config.js — WHICH rules count as design rules
#
# The design rules are therefore not enumerated here either: `just web-eslint`
# runs the repo config, so web/eslint.config.js is the single place a design
# rule is declared. A second list in this file would be exactly the drift this
# gate exists to prevent.
#
# Layers, cheapest first:
#
#   1. token artifacts       generated output is in sync with design/tokens/*
#   2. contract resolution   design/generated/contracts.json is in sync
#   3. inventory integrity   the design inventory still resolves deterministically
#   4. design test suite     design/scripts/*.test.mjs — contrast floors, palette
#                            inheritance, generator and contract semantics
#   5. rule fault fixtures   web/eslint-plugin-nession/__tests__ — proves each
#                            rule still *fails* on the input it claims to catch
#   6. ESLint over web/src   the design rules applied to shipping code
#
# Steps 1–5 are milliseconds each. Step 6 dominates (~5s) and is why the whole
# gate is a pre-commit step rather than a pre-push one.
#
# Usage:
#   ./scripts/design-check.sh
#   ./scripts/design-check.sh --list    # print the layers without running them

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
NC='\033[0m'

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FAILED=()
LAYERS=()

# Run one layer. A layer is a name plus a command; the name is what the summary
# and the repair table are keyed on, so keep them in sync with REPAIRS below.
run_layer() {
    local name="$1"; shift
    LAYERS+=("$name")

    if [[ ${DESIGN_CHECK_LIST:-0} == 1 ]]; then
        echo -e "  ${DIM}•${NC} $name"
        return 0
    fi

    printf '  %-34s' "$name"
    local log
    log=$(mktemp)
    if "$@" >"$log" 2>&1; then
        echo -e "${GREEN}✓${NC}"
        rm -f "$log"
        return 0
    fi

    echo -e "${RED}✗${NC}"
    FAILED+=("$name")
    # Indent the captured output so a layer's own diagnostics stay attached to
    # its name rather than reading as unrelated output.
    sed 's/^/      /' "$log"
    rm -f "$log"
    return 1
}

if [[ ${1:-} == "--list" ]]; then
    DESIGN_CHECK_LIST=1
fi

if [[ ${DESIGN_CHECK_LIST:-0} != 1 ]]; then
    echo ""
    echo -e "${YELLOW}Design gate${NC} ${DIM}(#759 — one gate, three entry points)${NC}"
fi

run_layer 'token artifacts in sync'      just tokens-check
run_layer 'contract resolution in sync'  just contracts-check
run_layer 'design inventory integrity'   just design-inventory-check
run_layer 'design test suite'            just design-test
run_layer 'rule fault fixtures'          just design-rule-fixtures
run_layer 'design rules over web/src'    just web-eslint

if [[ ${DESIGN_CHECK_LIST:-0} == 1 ]]; then
    exit 0
fi

if [[ ${#FAILED[@]} -eq 0 ]]; then
    echo -e "\n${GREEN}Design gate passed ✓${NC}\n"
    exit 0
fi

# ── Summary ─────────────────────────────────────────────────────────────────
# Each failed layer gets its canonical owner and a first repair step. The owner
# is the file that legitimately decides the thing that failed — going there is
# the difference between fixing the design system and patching the nearest line.
echo ""
echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${RED}  Design gate failed — ${#FAILED[@]} of ${#LAYERS[@]} layer(s)${NC}"
echo ""

for name in "${FAILED[@]}"; do
    case "$name" in
        'token artifacts in sync')
            owner='design/tokens/*.json'
            repair='run `just tokens-gen` and commit source + generated output together'
            ;;
        'contract resolution in sync')
            owner='design/contracts/*.json'
            repair='run `just contracts-gen` and commit source + generated output together'
            ;;
        'design inventory integrity')
            owner='design/scripts/audit-design-system.mjs'
            repair='run `just design-inventory` to see the affected entries'
            ;;
        'design test suite')
            owner='design/scripts/*.test.mjs'
            repair='run `node --test design/scripts/*.test.mjs` — the failing test names its rule'
            ;;
        'rule fault fixtures')
            owner='web/eslint-plugin-nession/rules/*.js'
            repair='a rule stopped catching what it claims; fix the rule or its fixture'
            ;;
        'design rules over web/src')
            owner='web/eslint.config.js'
            repair='each violation above ends with its own owner/repair lines; fix the owner, not the call site'
            ;;
        *)
            owner='(unmapped)'
            repair='see the layer output above'
            ;;
    esac
    echo -e "  ${RED}✗${NC} ${YELLOW}${name}${NC}"
    echo -e "      owner:  ${owner}"
    echo -e "      repair: ${repair}"
done

echo ""
echo -e "  ${DIM}Do not clear a failure by disabling a rule, widening a contract, or${NC}"
echo -e "  ${DIM}lowering a visual threshold. Fix the owner, or get the design changed.${NC}"
echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
exit 1
