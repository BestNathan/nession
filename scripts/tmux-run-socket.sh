#!/usr/bin/env bash
# Give this test run its own tmux socket. Meant to be sourced, not executed:
#
#   . "$(dirname "$0")/tmux-run-socket.sh"
#   trap 'nession_tmux_run_cleanup' EXIT INT TERM
#
# Rust tests create real tmux sessions. Without this they land on whatever
# NESSION_TMUX_SOCKET resolves to by default — nession's own socket, so never
# the developer's default one, but still shared with a locally running agent and
# with every other test run on this machine. Two runs sharing a tmux server means
# one run's teardown kills sessions the other is still using, and the failure
# looks random (see "测试并发安全" in CLAUDE.md).
#
# mktemp -d gives a path no other run can produce — unlike a timestamp plus an
# in-process counter, which two processes starting in the same second both
# generate identically.
#
# An inherited NESSION_TMUX_SOCKET is honoured, so CI (or a developer debugging
# one test) can point a run at a specific socket, and a nested invocation shares
# the outer run's socket instead of stranding a second server. In that case this
# run does not own the socket and `nession_tmux_run_cleanup` does nothing.
#
# Cleanup is NOT installed as a trap here: callers already have their own EXIT
# traps, and bash keeps only the last handler per signal, so a trap set here
# would silently replace theirs (or be replaced by it). Callers must chain the
# function into their own trap — it is always defined, so the call is
# unconditional.

if [ -z "${NESSION_TMUX_SOCKET:-}" ]; then
    NESSION_TMUX_RUN_DIR_OWNED=$(mktemp -d "${TMPDIR:-/tmp}/nession-test-tmux.XXXXXX")
    NESSION_TMUX_SOCKET="${NESSION_TMUX_RUN_DIR_OWNED}/tmux.sock"
    export NESSION_TMUX_SOCKET
else
    NESSION_TMUX_RUN_DIR_OWNED=""
fi

# Kill this run's tmux server and remove its directory. No-op when the socket
# was inherited rather than created here.
#
# The server is asked to confirm its own socket path before being killed, so a
# mangled variable can never turn this into a kill-server against a socket this
# run does not own.
nession_tmux_run_cleanup() {
    [ -n "${NESSION_TMUX_RUN_DIR_OWNED}" ] || return 0

    if [ -S "${NESSION_TMUX_SOCKET}" ]; then
        local reported
        reported=$(tmux -S "${NESSION_TMUX_SOCKET}" display-message -p '#{socket_path}' 2>/dev/null || true)
        if [ "${reported}" = "${NESSION_TMUX_SOCKET}" ]; then
            tmux -S "${NESSION_TMUX_SOCKET}" kill-server 2>/dev/null || true
        fi
    fi

    case "${NESSION_TMUX_RUN_DIR_OWNED}" in
        */nession-test-tmux.*) rm -rf "${NESSION_TMUX_RUN_DIR_OWNED}" ;;
    esac
}
