#!/usr/bin/env bash
# Reclaim tmux servers and directories orphaned by hard-killed test/e2e runs.
#
# Every test/e2e run gets its own tmux socket in its own directory, and the
# run's own trap/teardown cleans it up on a normal exit. A run killed hard
# (Ctrl-C does run the trap, so: SIGKILL, kill -9, a crash, a frozen machine)
# never reaches that cleanup, leaving an orphaned server and directory behind.
# Each new run picks a new path, so orphans accumulate instead of overwriting.
# This tool is the manual reclamation pass for that situation.
#
# Orphan classes (by directory pattern — a directory only ever belongs to a
# run when its name matches one of these, so the match is ownership, and the
# developer's default tmux socket is never addressed):
#
#   [test]  ${TMPDIR:-/tmp}/nession-test-tmux.*   — Rust test runs, created by
#           scripts/tmux-run-socket.sh (mktemp -d)
#   [e2e]   /tmp/nession-e2e-tmux-*               — e2e runs, created by
#           e2e/runtime.ts
#
# Both hold the run's socket at <dir>/tmux.sock. A whole directory is the
# reclaim unit: within an owned run directory, everything is that run's.
#
# Safety (the iron law, enforced structurally):
#   - only the two patterns above are ever touched; no tmux call without an
#     explicit `-S <absolute path>` appears in this script
#   - a directory whose owner.pid names a live process is a LIVE run — listed
#     but never killed. The lock is written by the run itself at directory
#     creation time, before any server can exist on the socket (scripts/
#     tmux-run-socket.sh and e2e/globalSetup.ts), and dies with the directory.
#     A directory without a live owner is an orphan: either an old-regime
#     leftover that predates the lock, or a run killed before it could write
#     the lock — which cannot have started a server yet
#   - before kill-server, the server is asked to confirm #{socket_path}
#     equals the path we are addressing; a mismatch is refused loudly
#
# Usage:
#   ./scripts/sweep-test-sessions.sh            # list orphans, kill nothing
#   ./scripts/sweep-test-sessions.sh --kill     # reclaim orphaned run dirs
#   ./scripts/sweep-test-sessions.sh --help     # this text

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

kill_mode=false
case "${1:-}" in
    --kill) kill_mode=true ;;
    "") ;;
    -h | --help)
        sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    *)
        echo -e "${RED}unknown argument: $1${NC}" >&2
        echo "usage: $0 [--kill]" >&2
        exit 2
        ;;
esac

# ── Discovery: the two project-owned run-directory patterns ─────────────────
shopt -s nullglob
test_dirs=("${TMPDIR:-/tmp}"/nession-test-tmux.*)
e2e_dirs=(/tmp/nession-e2e-tmux-*)

class_of() {
    local dir="$1"
    case "/$dir" in
        */nession-test-tmux.*) echo test ;;
        */nession-e2e-tmux-*) echo e2e ;;
        *) echo unknown ;;
    esac
}

is_owned_dir() {
    [[ $(class_of "$1") != unknown ]]
}

# ── Live-run detection ──────────────────────────────────────────────────────
# The run writes <dir>/owner.pid at directory creation time, holding the PID
# of the process that runs the run (see scripts/tmux-run-socket.sh and
# e2e/globalSetup.ts). If that PID is alive, the run is live and its directory
# must not be touched. `kill -0` needs no environment access, so this works on
# macOS and Linux alike. A missing or unreadable lock means "not a live run
# under the current regime": either a leftover that predates the lock or a run
# killed before it could write one — which cannot have started a server yet.
owner_is_live() {
    local dir="$1" pid
    [[ -f $dir/owner.pid ]] || return 1
    pid=$(<"$dir/owner.pid") || return 1
    [[ $pid =~ ^[0-9]+$ ]] || return 1
    kill -0 "$pid" 2>/dev/null
}

# ── Directory reclamation ───────────────────────────────────────────────────
# Removes an owned run directory. The pattern guard is the last line of
# defence: rm -rf runs only when the name still matches one of the two
# project-owned patterns.
remove_dir() {
    local dir="$1"
    if is_owned_dir "$dir"; then
        rm -rf "$dir"
    else
        echo -e "${RED}refusing to remove ${dir} — not a nession run directory${NC}" >&2
        return 1
    fi
}

# Kills the server on an owned run socket and removes its directory. The
# socket path is confirmed by the server itself before kill-server, so a
# mangled variable can never redirect the kill at another server.
reclaim_dir() {
    local dir="$1" sock="$dir/tmux.sock"
    local class
    class=$(class_of "$dir")
    printf -v tag '[%s] %s' "$class" "$dir"

    # Owner check first: a live run whose socket does not exist yet (the
    # window between lock-write and its first tmux spawn) is still live.
    if owner_is_live "$dir"; then
        local owner_pid
        owner_pid=$(<"$dir/owner.pid")
        echo -e "${YELLOW}live run${NC} ${tag} — owner pid ${owner_pid}, not touched"
        return 0
    fi

    if [[ ! -S $sock ]]; then
        # No socket file — no server can be alive (exit-empty closes the
        # server once its last session goes, removing the socket with it).
        # Leftover directory only.
        echo -e "${YELLOW}empty${NC} ${tag}"
        reclaimable=$((reclaimable + 1))
        [[ $kill_mode == true ]] && remove_dir "$dir"
        return 0
    fi

    # No live owner — orphan. Ask the server to identify itself first.
    local reported
    reported=$(tmux -S "$sock" display-message -p '#{socket_path}' 2>/dev/null || true)
    if [[ -z $reported ]]; then
        # Socket file present but no server answering — stale leftovers.
        echo -e "${YELLOW}stale${NC} ${tag} (no server on socket)"
        reclaimable=$((reclaimable + 1))
        [[ $kill_mode == true ]] && remove_dir "$dir"
        return 0
    fi
    if [[ $reported != "$sock" ]]; then
        echo -e "${RED}refusing kill-server: socket at ${sock} reported ${reported}${NC}" >&2
        echo "  fix: inspect the socket by hand — this should be impossible for an owned run directory" >&2
        return 1
    fi

    echo -e "${YELLOW}orphan${NC} ${tag} (server on ${sock})"
    reclaimable=$((reclaimable + 1))
    if [[ $kill_mode == true ]]; then
        if tmux -S "$sock" kill-server 2>/dev/null; then
            echo -e "${GREEN}killed${NC} ${tag}"
        else
            echo -e "${RED}kill-server failed for ${sock}${NC}" >&2
            echo "  fix: check the server state by hand (tmux -S ${sock} list-sessions)" >&2
            return 1
        fi
        remove_dir "$dir"
    fi
}

# ── Report ──────────────────────────────────────────────────────────────────
found=0
reclaimable=0
failures=0

for dir in "${test_dirs[@]}" "${e2e_dirs[@]}"; do
    [[ -d $dir ]] || continue
    found=$((found + 1))
    if ! reclaim_dir "$dir"; then
        failures=$((failures + 1))
    fi
done

if [[ $found -eq 0 ]]; then
    echo -e "${GREEN}no orphaned tmux-socket run directories — nothing to reclaim${NC}"
    exit 0
fi

if [[ $reclaimable -eq 0 ]]; then
    if [[ $kill_mode == false ]]; then
        echo
        echo -e "${GREEN}nothing to reclaim${NC} — all run directories found are live (in progress)"
    fi
elif [[ $kill_mode == false ]]; then
    echo
    echo "run with --kill to reclaim the ${reclaimable} orphaned director(y/ies) above"
fi

if [[ $failures -gt 0 ]]; then
    echo -e "${RED}${failures} directory/directories could not be reclaimed${NC}" >&2
    exit 1
fi
exit 0
