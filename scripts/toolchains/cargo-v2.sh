#!/usr/bin/env bash
# #4160: adapter compiles the dedicated CI example using the canonical nession-erofs library.
set -euo pipefail
[[ $# -eq 1 && "$1" =~ ^(probe|local|publish|readback)$ ]] || { echo "usage: cargo-v2.sh probe|local|publish|readback" >&2; exit 2; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
cp scripts/toolchains/oci-publish-v2.rs crates/nession-erofs/examples/toolchain-release-v2.rs
trap 'rm -f crates/nession-erofs/examples/toolchain-release-v2.rs' EXIT
cargo run --quiet -p nession-erofs --example toolchain-release-v2 -- "$1"
