#!/usr/bin/env bash
# CI-only adapter: reuse nession-erofs and the repository's pinned Cargo.lock.
set -euo pipefail

mode="${1:-}"
case "$mode" in
  local|publish) ;;
  *)
    echo "usage: erofs-ghcr-smoke.sh {local|publish}" >&2
    exit 2
    ;;
esac

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
example="crates/nession-erofs/examples/ci_erofs_ghcr_smoke.rs"
if [[ -e "$example" ]]; then
  echo "refusing to replace existing example $example" >&2
  exit 2
fi
mkdir -p "$(dirname "$example")"
trap 'rm -f -- "$example"' EXIT
cp -- scripts/ci/erofs-ghcr-smoke.rs "$example"
cargo run --locked -p nession-erofs --example ci_erofs_ghcr_smoke -- "$mode"
