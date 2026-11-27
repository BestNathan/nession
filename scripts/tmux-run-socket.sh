#!/usr/bin/env bash
# Give this test run its own tmux socket and its own Test Runtime root.
# Meant to be sourced, not executed:
#
#   . "$(dirname "$0")/tmux-run-socket.sh"
#   trap 'nession_tmux_run_cleanup' EXIT INT TERM
#
# scripts/test-runtime.sh is the single run-root owner (#4597): it creates the
# private HOME/NESSION_HOME, NESSION_RUNTIME_DIR, TMPDIR, XDG/tool config roots
# and the private tmux socket, writes the ownership manifest, and refuses an
# inherited production-like path override. This file keeps the tmux-facing name
# and cleanup function the Rust test wrappers already use.
#
# Why a private socket at all: Rust tests create real tmux sessions. Without
# one, a real-tmux test binary now fails closed at nession's tmux chokepoint
# (#4596) rather than silently creating Sessions on the socket a locally
# running Agent serves. Two runs sharing a server also means one run's teardown
# kills sessions the other is still using, and the failure looks random (see
# "测试并发安全" in CLAUDE.md).
#
# An inherited verified capability is reused, so a nested invocation shares the
# outer run's root instead of stranding a second server. An inherited bare
# NESSION_TMUX_SOCKET/NESSION_HOME/NESSION_RUNTIME_DIR is not trusted: only a
# root with a matching manifest, live owner.pid and current uid is accepted.
#
# Cleanup is NOT installed as a trap here: callers already have their own EXIT
# traps, and bash keeps only the last handler per signal, so a trap set here
# would silently replace theirs (or be replaced by it). Callers must chain the
# function into their own trap — it is always defined, so the call is
# unconditional.

_nession_tmux_run_socket_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=scripts/test-runtime.sh
. "$_nession_tmux_run_socket_dir/test-runtime.sh"
unset _nession_tmux_run_socket_dir

nession_test_runtime_init

# Kill this run's tmux server and remove its run root. No-op when the
# capability was inherited rather than created here.
nession_tmux_run_cleanup() {
    nession_test_runtime_cleanup
}
