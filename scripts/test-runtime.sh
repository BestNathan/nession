#!/usr/bin/env bash
# The single Test Runtime owner (#4597). Source this file; do not execute it.
#
# A test run must not share mutable resources with the developer's live
# Nession state, a locally running Agent, or another concurrent test run. This
# owner creates one run root and exports every mutable root a test process or
# child may resolve:
#
#   <root>/manifest.json     run identity + ownership (read by Rust and JS)
#   <root>/owner.pid         PID of the shell that created the run
#   <root>/tmux.sock         this run's private tmux server
#   <root>/home/             HOME and NESSION_HOME
#   <root>/runtime/          NESSION_RUNTIME_DIR (PID files, readiness)
#   <root>/tmp/              TMPDIR (tempfile::tempdir, build scratch)
#   <root>/config/           XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME
#   <root>/cache/            XDG_CACHE_HOME
#   <root>/data/             XDG_DATA_HOME
#   <root>/state/            XDG_STATE_HOME
#   <root>/gitconfig         GIT_CONFIG_GLOBAL (empty)
#   <root>/gitconfig-system  GIT_CONFIG_SYSTEM (empty)
#
# It also refuses an inherited production-like NESSION_HOME / NESSION_RUNTIME_DIR
# / NESSION_TMUX_SOCKET that is not backed by a verified capability. The shell
# wrapper is not the authority for the Rust boundary — nession-common's
# test_runtime module re-verifies root, uid, permissions, manifest and path
# containment — but it must not hand a child a production path in the first
# place.
#
# Usage:
#   . "$(dirname "$0")/test-runtime.sh"
#   nession_test_runtime_init          # once, before cargo/JS can resolve paths
#   trap 'nession_test_runtime_cleanup' EXIT INT TERM
#
# Callers own the trap: bash keeps only one handler per signal, so this file
# does not install one. The cleanup is safe to call when the capability was
# inherited (a nested invocation never owns the outer root).
#
# Hard-killed runs (SIGKILL) cannot clean up; scripts/sweep-test-sessions.sh
# reclaims roots whose owner.pid is no longer alive. Cleanup that cannot prove
# the socket belongs to this run keeps the directory for that reaper and says
# why instead of deleting it.

NSESSION_TEST_RUNTIME_DIR_ENV="NSESSION_TEST_RUNTIME_DIR"
NSESSION_TEST_RUNTIME_MANIFEST_ENV="NSESSION_TEST_RUNTIME_MANIFEST"
NSESSION_TEST_RUNTIME_LIB_LOADED=1
NSESSION_TEST_RUNTIME_OWNED=0
NSESSION_TEST_RUNTIME_READY=0

nession_test_runtime_fail() {
    printf '\n[test-runtime] REFUSED: %s\n' "$*" >&2
    printf '[test-runtime] owner: scripts/test-runtime.sh (invariant: #4597)\n' >&2
    exit 1
}

nession_test_runtime_uid() {
    id -u
}

# Verify a capability handed in by a parent run. Returns the canonical root on
# stdout; fails closed otherwise. The Rust and JS readers repeat the full
# validation, so this is the shell-side early refusal, not the only proof.
nession_test_runtime_verify_inherited() {
    local root="$1" manifest="$2" canonical pid

    case "$root" in
        /*) ;;
        *) nession_test_runtime_fail "$NSESSION_TEST_RUNTIME_DIR_ENV must be absolute, got '$root'" ;;
    esac
    [ -n "$manifest" ] || nession_test_runtime_fail \
        "incomplete capability: $NSESSION_TEST_RUNTIME_MANIFEST_ENV is required with $NSESSION_TEST_RUNTIME_DIR_ENV"
    if [ -L "$root" ]; then
        nession_test_runtime_fail \
            "$NSESSION_TEST_RUNTIME_DIR_ENV '$root' is a symlink; the run root must be a real directory"
    fi
    [ -d "$root" ] || nession_test_runtime_fail \
        "$NSESSION_TEST_RUNTIME_DIR_ENV '$root' is not a directory"
    [ -O "$root" ] || nession_test_runtime_fail \
        "$NSESSION_TEST_RUNTIME_DIR_ENV '$root' is not owned by the current user"
    canonical=$(cd "$root" && pwd -P) || nession_test_runtime_fail \
        "cannot canonicalize $NSESSION_TEST_RUNTIME_DIR_ENV '$root'"
    case "$manifest" in
        /*) ;;
        *) nession_test_runtime_fail "$NSESSION_TEST_RUNTIME_MANIFEST_ENV must be absolute, got '$manifest'" ;;
    esac
    [ -f "$manifest" ] && [ ! -L "$manifest" ] || nession_test_runtime_fail \
        "manifest '$manifest' is not a real file"
    [ -f "$canonical/owner.pid" ] || nession_test_runtime_fail \
        "run root '$canonical' has no owner.pid; it was not created by this harness"
    pid=$(<"$canonical/owner.pid")
    case "$pid" in
        ''|*[!0-9]*) nession_test_runtime_fail "run root '$canonical' has an invalid owner.pid" ;;
    esac
    kill -0 "$pid" 2>/dev/null || nession_test_runtime_fail \
        "run root '$canonical' is owned by pid $pid, which is not running; it is a stale run"
    grep -Eq '"lifecycle"[[:space:]]*:[[:space:]]*"active"' "$manifest" || nession_test_runtime_fail \
        "manifest '$manifest' is not active"
    grep -Fq "\"root\": \"$canonical\"" "$manifest" || nession_test_runtime_fail \
        "manifest '$manifest' does not name the verified root '$canonical'"
    grep -Fq "\"uid\": $(nession_test_runtime_uid)" "$manifest" || nession_test_runtime_fail \
        "manifest '$manifest' does not name the current uid"
    printf '%s\n' "$canonical"
}

# Publish the canonical run-root paths into the environment.
nession_test_runtime_export() {
    local root="$1"
    mkdir -p \
        "$root/home" "$root/runtime" "$root/tmp" "$root/config" \
        "$root/cache" "$root/data" "$root/state" || nession_test_runtime_fail \
        "cannot prepare the run root '$root'"

    # Build/toolchain caches are read-only shared infrastructure, not mutable
    # test state. Keep the developer's cargo and rustup homes so the run uses
    # the same registry/toolchain instead of downloading a second copy.
    if [ -z "${CARGO_HOME:-}" ] && [ -n "${NESSON_TEST_RUNTIME_ORIGINAL_HOME:-}" ]; then
        CARGO_HOME="$NESSON_TEST_RUNTIME_ORIGINAL_HOME/.cargo"
    fi
    if [ -z "${RUSTUP_HOME:-}" ] && [ -n "${NESSON_TEST_RUNTIME_ORIGINAL_HOME:-}" ]; then
        RUSTUP_HOME="$NESSON_TEST_RUNTIME_ORIGINAL_HOME/.rustup"
    fi
    if [ -z "${SCCACHE_DIR:-}" ] && [ -n "${NESSON_TEST_RUNTIME_ORIGINAL_HOME:-}" ]; then
        # Keep the shared build cache: it is explicitly read-only build
        # infrastructure, and a fresh cache per run would make every run cold.
        if [ "$(uname -s)" = "Darwin" ]; then
            SCCACHE_DIR="$NESSON_TEST_RUNTIME_ORIGINAL_HOME/Library/Caches/Mozilla.sccache"
        else
            SCCACHE_DIR="${ORIGINAL_XDG_CACHE_HOME:-$NESSON_TEST_RUNTIME_ORIGINAL_HOME/.cache}/sccache"
        fi
    fi
    : >"$root/gitconfig"
    : >"$root/gitconfig-system"

    export NSESSION_TEST_RUNTIME_DIR="$root"
    export NSESSION_TEST_RUNTIME_MANIFEST="$root/manifest.json"
    export NESSION_TMUX_SOCKET="$root/tmux.sock"
    # Keep the standard HOME/.nession relationship: tests that assert the
    # default durable home still see a home derived from HOME, and it is owned.
    export NESSION_HOME="$root/home/.nession"
    export NESSION_RUNTIME_DIR="$root/runtime"
    export HOME="$root/home"
    export TMPDIR="$root/tmp"
    export XDG_CONFIG_HOME="$root/config"
    export XDG_CACHE_HOME="$root/cache"
    export XDG_DATA_HOME="$root/data"
    export XDG_STATE_HOME="$root/state"
    export CLAUDE_CONFIG_DIR="$root/config/claude"
    export CODEX_HOME="$root/config/codex"
    export GIT_CONFIG_GLOBAL="$root/gitconfig"
    export GIT_CONFIG_SYSTEM="$root/gitconfig-system"
    if [ -n "${CARGO_HOME:-}" ]; then export CARGO_HOME; fi
    if [ -n "${RUSTUP_HOME:-}" ]; then export RUSTUP_HOME; fi
    if [ -n "${SCCACHE_DIR:-}" ]; then export SCCACHE_DIR; fi
    # A test run must not reach the developer's live ssh-agent, askpass helper,
    # provider credentials or proxy endpoints. Cases that need a credential
    # declare their own explicit lane (#4597 SC-05).
    unset SSH_AUTH_SOCK GIT_ASKPASS SSH_ASKPASS
    # An Agent Session launches this test process with its own shell
    # provenance (ZDOTDIR and the user-baseline marker). A real-tmux fixture
    # must not inherit that: zsh would source the developer's startup files
    # against the run-owned HOME and the session would never reach its own
    # adapter (#4597; the #4605 regression tests).
    unset ZDOTDIR NESSION_RUNTIME_USER_ZDOTDIR NESSION_RUNTIME_SESSION_ID ZSH
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
    unset OPENAI_API_KEY OPENAI_BASE_URL OPENAI_ORG_ID
    unset GITHUB_TOKEN GH_TOKEN GITHUB_PAT
    unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
    unset GOOGLE_APPLICATION_CREDENTIALS AZURE_CLIENT_SECRET
    unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
    unset http_proxy https_proxy all_proxy no_proxy
    export NSESSION_TEST_RUNTIME_READY=1
}

# Create or adopt the run root. Call once from each entry script.
nession_test_runtime_init() {
    if [ "${NSESSION_TEST_RUNTIME_READY:-0}" = 1 ]; then return 0; fi

    NESSION_TEST_RUNTIME_ORIGINAL_HOME="${HOME:-}"
    ORIGINAL_XDG_CACHE_HOME="${XDG_CACHE_HOME:-}"

    local root="${NSESSION_TEST_RUNTIME_DIR:-}"
    local manifest="${NSESSION_TEST_RUNTIME_MANIFEST:-}"

    if [ -n "$root" ] || [ -n "$manifest" ]; then
        # Nested invocation: only a verified parent capability is reusable.
        root=$(nession_test_runtime_verify_inherited "$root" "$manifest") || exit 1
        export NSESSION_TEST_RUNTIME_DIR="$root"
        NSESSION_TEST_RUNTIME_OWNED=0
        nession_test_runtime_export "$root"
        return 0
    fi

    # No capability, but inherited production-like path overrides. These are
    # exactly the accidental leaks #4596/#4597 exist to stop: a parent shell
    # exporting a real home, runtime dir or Agent socket is not a run context.
    if [ -n "${NESION_HOME:-}" ] || [ -n "${NESION_RUNTIME_DIR:-}" ] || [ -n "${NESION_TMUX_SOCKET:-}" ]; then
        nession_test_runtime_fail \
            "inherited NESSION_HOME/NESSION_RUNTIME_DIR/NESSION_TMUX_SOCKET without a verified Test Runtime capability; unset them (the harness creates a private root) or point $NSESSION_TEST_RUNTIME_DIR_ENV and $NSESSION_TEST_RUNTIME_MANIFEST_ENV at a root created by scripts/test-runtime.sh"
    fi

    # A short root under /tmp, not $TMPDIR: macOS per-user temp paths are
    # already long, and tests derive unix sockets inside TMPDIR (for example
    # tempfile::tempdir()/tmux.sock). Adding this root to that path can exceed
    # sockaddr_un.sun_path (104 bytes) and make every real-tmux test fail with
    # "File name too long". /tmp is world-writable, but mktemp -d creates 0700
    # and the manifest/owner checks below prove ownership.
    root=$(mktemp -d "/tmp/nession-test-runtime.XXXXXX") || nession_test_runtime_fail \
        "cannot create a run root under /tmp"
    root=$(cd "$root" && pwd -P) || nession_test_runtime_fail "cannot canonicalize the run root"
    chmod 700 "$root" || nession_test_runtime_fail "cannot make the run root private"

    local run_id owner_started
    run_id=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
    owner_started=$(ps -o lstart= -p "$$" 2>/dev/null | sed 's/^ *//' || true)
    [ -n "$owner_started" ] || owner_started="unknown"

    printf '%s\n' "$$" >"$root/owner.pid"
    {
        printf '{\n'
        printf '  "schema_version": 1,\n'
        printf '  "run_id": "%s",\n' "$run_id"
        printf '  "owner_pid": %s,\n' "$$"
        printf '  "owner_started": "%s",\n' "$owner_started"
        printf '  "uid": %s,\n' "$(nession_test_runtime_uid)"
        printf '  "root": "%s",\n' "$root"
        printf '  "tmux_socket": "%s",\n' "$root/tmux.sock"
        printf '  "lifecycle": "active"\n'
        printf '}\n'
    } >"$root/manifest.json"

    export NSESSION_TEST_RUNTIME_DIR="$root"
    export NSESSION_TEST_RUNTIME_MANIFEST="$root/manifest.json"
    NSESSION_TEST_RUNTIME_OWNED=1
    nession_test_runtime_export "$root"
}

# Remove this run's owned resources. A verified-but-inherited root is never
# removed (the outer run owns it). A cleanup that cannot confirm ownership
# keeps the directory and prints why, so scripts/sweep-test-sessions.sh can
# reclaim it later without guessing.
nession_test_runtime_cleanup() {
    [ "${NSESSION_TEST_RUNTIME_OWNED:-0}" = 1 ] || return 0
    local root="${NSESSION_TEST_RUNTIME_DIR:-}"
    [ -n "$root" ] || return 0

    local socket="$root/tmux.sock"
    if [ -S "$socket" ]; then
        local reported
        reported=$(tmux -S "$socket" display-message -p '#{socket_path}' 2>/dev/null || true)
        if [ -n "$reported" ] && [ "$reported" != "$socket" ]; then
            printf '[test-runtime] refusing to remove %s: server reported socket "%s", expected "%s"; leaving it for scripts/sweep-test-sessions.sh\n' \
                "$root" "$reported" "$socket" >&2
            : >"$root/cleanup-failed" 2>/dev/null || true
            return 1
        fi
        if [ "$reported" = "$socket" ]; then
            tmux -S "$socket" kill-server >/dev/null 2>&1 || true
        fi
        # An empty report means the socket file is a stale leftover with no
        # server behind it; there is nothing to kill and the file is ours.
    fi

    case "$root" in
        */nession-test-runtime.*)
            [ -O "$root" ] || {
                printf '[test-runtime] refusing to remove %s: not owned by the current user\n' "$root" >&2
                return 1
            }
            rm -rf -- "$root"
            ;;
        *)
            printf '[test-runtime] refusing to remove %s: not a nession test run root\n' "$root" >&2
            return 1
            ;;
    esac
    NSESSION_TEST_RUNTIME_OWNED=0
    NSESSION_TEST_RUNTIME_READY=0
}
