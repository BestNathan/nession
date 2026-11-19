#!/usr/bin/env bash
# Narrow adapter: run checked-in CI Rust source as an ephemeral cargo example.
# No change to the product CLI or the nession-erofs crate's API.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: cargo.sh {local|publish|readback}" >&2; exit 2; }
case "$1" in local|publish|readback) ;; *) exit 2 ;; esac
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
example="crates/nession-erofs/examples/ci_toolchain_release.rs"
[[ ! -e "$example" ]] || { echo "refusing to overwrite $example" >&2; exit 2; }
mkdir -p -- "$(dirname -- "$example")"
trap 'rm -f -- "$example"' EXIT
cp -- scripts/toolchains/oci-publish.rs "$example"
cargo run --locked -p nession-erofs --example ci_toolchain_release -- "$1"
