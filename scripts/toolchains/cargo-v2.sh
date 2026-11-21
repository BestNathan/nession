#!/usr/bin/env bash
# #4160: transient native adapter over the canonical nession-erofs crate.
set -euo pipefail
[[ $# -eq 1 && "$1" =~ ^(probe|local|publish|readback|test)$ ]] || { echo "usage: cargo-v2.sh probe|local|publish|readback|test" >&2; exit 2; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
example="crates/nession-erofs/examples/toolchain_release_v2.rs"
[[ ! -e "$example" ]] || { echo "refusing to overwrite $example" >&2; exit 2; }
mkdir -p -- "$(dirname -- "$example")"
trap 'rm -f -- "$example"' EXIT
cp -- scripts/toolchains/oci-publish-v2.rs "$example"
if [[ "$1" == test ]]; then
  cargo test --locked --quiet -p nession-erofs --example toolchain_release_v2
else
  cargo run --locked --quiet -p nession-erofs --example toolchain_release_v2 -- "$1"
fi
