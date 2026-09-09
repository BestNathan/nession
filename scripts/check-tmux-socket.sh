#!/usr/bin/env bash
# Static check: every tmux process nession spawns must go through the one
# chokepoint that adds `-S <socket>`.
#
# Why this is a gate rather than a code review habit: a tmux call that forgets
# `-S` does not fail. It succeeds against tmux's *default* socket, where the
# user's own sessions live — and since tmux's `exit-empty` is `on` by default,
# a kill aimed at nession's last session there takes the user's entire tmux
# server with it. That destroyed a real session on 2026-09-02 (#574/#575). The
# symptom appears far from the mistake, so the mistake has to be caught here.
#
# Rules enforced:
#
#   1. Rust: no tmux process spawned outside crates/nession-agent/src/tmux/cmd.rs.
#      Three spawn forms count, and the second one is the point:
#        a. `Command::new("tmux")`            — the literal
#        b. `Command::new(<expression>)`      — e.g. `&self.tmux_bin`. A gate
#           matching only literals reported SessionManager as clean while all 14
#           of its create/kill/list calls used a variable.
#        c. `CommandBuilder::new("tmux")`     — portable-pty's separate API
#   2. Shell/TS: a `tmux` invocation in scripts/**, e2e/**, deploy/** or the
#      justfile must carry `-S`.
#   3. Nothing may *set* TMUX_TMPDIR. It is not an isolation mechanism: tmux
#      ignores it whenever $TMUX is set — i.e. whenever anything runs from
#      inside a tmux session — and silently uses the default socket instead
#      (measured, #574). Naming it in order to strip it (`env_remove`) is the
#      remedy, not the offence, so only assignment forms are flagged.
#
# Escape hatch for rule 1b: a `Command::new(<var>)` that provably does not spawn
# tmux can carry a `// not-tmux: <reason>` marker on the same line or within the
# three lines above it. Deliberately per-line and self-documenting — a path-wide
# exemption would also cover the next spawn added to that file.
#
# Usage:
#   ./scripts/check-tmux-socket.sh          # check the tree
#   ./scripts/check-tmux-socket.sh --list   # print what is scanned

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# The one file allowed to name tmux in a process constructor.
CHOKEPOINT="crates/nession-agent/src/tmux/cmd.rs"

# Shell/TS files exempt from rule 2, each for a stated reason.
#
#   this script + its selftest — they contain the offending patterns as data.
#   sweep-test-sessions.sh used to be exempt while it deliberately scanned the
#   default socket; since #582 it reclaims whole owned run directories with
#   explicit -S only, so it is scanned like every other script.
is_shell_exempt() {
    case "$1" in
        scripts/check-tmux-socket.sh) return 0 ;;
        scripts/check-tmux-socket-selftest.sh) return 0 ;;
        *) return 1 ;;
    esac
}

findings=0

report() {
    local file="$1" line="$2" rule="$3" text="$4" fix="$5"
    echo -e "${RED}✗${NC} ${file}:${line}"
    echo -e "    ${YELLOW}${rule}${NC}"
    echo -e "    $(printf '%s' "$text" | sed 's/^[[:space:]]*//')"
    echo -e "    ${GREEN}fix:${NC} ${fix}"
    echo ""
    findings=$((findings + 1))
}

rust_files() {
    find crates -type f -name '*.rs' 2>/dev/null | sort
}

shell_files() {
    find scripts e2e deploy -type f \( -name '*.sh' -o -name '*.ts' -o -name '*.js' -o -name '*.yaml' -o -name '*.yml' \) \
        -not -path '*/node_modules/*' 2>/dev/null | sort
    [[ -f justfile ]] && echo justfile
}

if [[ ${1:-} == "--list" ]]; then
    echo "── Rust (chokepoint: $CHOKEPOINT) ──"
    rust_files
    echo "── Shell / TS ──"
    shell_files
    exit 0
fi

# ── Rule 1: Rust spawn sites ────────────────────────────────────────────────
while IFS= read -r file; do
    [[ $file == "$CHOKEPOINT" ]] && continue

    # 1a + 1c: a literal naming tmux in any process constructor.
    while IFS=: read -r ln text; do
        [[ -z ${ln:-} ]] && continue
        report "$file" "$ln" "tmux spawned outside the chokepoint (rule 1a/1c)" "$text" \
            "build it with crate::tmux::cmd::global().tokio() / .std() / .pty() — those add -S <socket>"
    done < <(grep -nE '(Command|CommandBuilder)::new\(\s*"[^"]*tmux' "$file" 2>/dev/null |
        grep -vE '^[0-9]+:\s*(//|///|\*)')

    # 1b: a constructor taking a non-literal, in a file that deals with tmux.
    # This is the form that hid SessionManager's 14 production calls: the
    # binary came from `self.tmux_bin`, so no literal appeared anywhere near it.
    if grep -qi 'tmux' "$file" 2>/dev/null; then
        while IFS= read -r hit; do
            ln="${hit%%:*}"
            text="${hit#*:}"
            [[ -z ${ln:-} ]] && continue
            # Explicitly marked as not spawning tmux, on this line or in the
            # three above it (enough room for a real justification).
            sed -n "$((ln > 3 ? ln - 3 : 1)),${ln}p" "$file" | grep -q 'not-tmux' && continue
            report "$file" "$ln" "process spawned from a variable in a tmux file (rule 1b)" "$text" \
                "if this spawns tmux, use crate::tmux::cmd::global(); otherwise mark the line // not-tmux: <reason>"
        done < <(grep -nE '(Command|CommandBuilder)::new\(\s*[^"[:space:]]' "$file" 2>/dev/null |
            grep -vE '^[0-9]+:\s*(//|///|\*)')
    fi
done < <(rust_files)

# ── Rule 2: shell / TS tmux invocations without -S ──────────────────────────
while IFS= read -r file; do
    is_shell_exempt "$file" && continue
    while IFS=: read -r ln text; do
        [[ -z ${ln:-} ]] && continue
        # Already socket-addressed on this line?
        grep -qE -- '-S[[:space:]]' <<<"$text" && continue
        grep -qE "'-S'" <<<"$text" && continue
        # `tmux -V` only prints the version — it opens no socket at all.
        grep -qE -- 'tmux[[:space:]]+-V([[:space:]]|$|["'"'"'])' <<<"$text" && continue
        report "$file" "$ln" "tmux invoked without -S (rule 2)" "$text" \
            "pass -S <absolute socket path>; without it this lands on the user's default tmux socket"
    done < <(grep -nE "(^|[^[:alnum:]_./-])tmux[[:space:]]+[a-z-]" "$file" 2>/dev/null |
        grep -vE '^[0-9]+:[[:space:]]*(#|//|\*|///)' |
        grep -vE 'tmux[[:space:]]+(installed|sessions?|server|socket|commands?|version|is|does|may|not|conf)')
done < <(shell_files)

# ── Rule 3: TMUX_TMPDIR anywhere ────────────────────────────────────────────
while IFS= read -r file; do
    is_shell_exempt "$file" && continue
    [[ $file == "$CHOKEPOINT" ]] && continue
    while IFS=: read -r ln text; do
        [[ -z ${ln:-} ]] && continue
        report "$file" "$ln" "TMUX_TMPDIR does not isolate anything (rule 3)" "$text" \
            "use an explicit -S <socket path>; TMUX_TMPDIR is ignored whenever \$TMUX is set"
    done < <(grep -nE 'TMUX_TMPDIR[[:space:]]*[=:]|(^|[^_[:alnum:]])(env|var|set_var)\([[:space:]]*"TMUX_TMPDIR"' "$file" 2>/dev/null |
        grep -vE '^[0-9]+:[[:space:]]*(#|//|\*|///)')
done < <(
    rust_files
    shell_files
)

if [[ $findings -eq 0 ]]; then
    echo -e "${GREEN}tmux socket isolation OK ✓${NC}"
    exit 0
fi
echo -e "${RED}${findings} tmux-socket violation(s)${NC}"
echo -e "${YELLOW}Every tmux call must be addressed with an explicit -S. See"
echo -e "\"tmux socket 隔离\" in CLAUDE.md and crates/nession-agent/src/tmux/cmd.rs.${NC}"
exit 1
