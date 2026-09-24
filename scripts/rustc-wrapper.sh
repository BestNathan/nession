#!/usr/bin/env bash
# Cargo rustc wrapper for local development.
#
# Cargo passes the real rustc path as argv[1]. Local builds use sccache when it
# is installed; CI and explicit opt-out bypass it. Keep this script policy-free:
# target layout, profiles and build selection still belong to Cargo/just.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "rustc-wrapper: Cargo did not provide a rustc executable" >&2
  echo "  Fix: invoke this wrapper through Cargo, or pass rustc as the first argument" >&2
  exit 2
fi

rustc_bin=$1
shift

if [ "${CI:-}" = "true" ] || [ "${GITHUB_ACTIONS:-}" = "true" ] || [ "${NSESSION_DISABLE_SCCACHE:-0}" = "1" ]; then
  exec "$rustc_bin" "$@"
fi

if command -v sccache >/dev/null 2>&1; then
  exec sccache "$rustc_bin" "$@"
fi

exec "$rustc_bin" "$@"
