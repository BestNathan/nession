#!/usr/bin/env bash
# #4160: canonical catalog and OCI Index self-test; historical #4092 proof remains in Git history.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
bash "$root/catalog-selftest.sh"
node "$root/catalog-plan.mjs" self-test
mkdir -p "$tmp/catalog/demo/1.0"
cat > "$tmp/catalog/demo/1.0/build.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
[[ -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" && -z "${GHCR_TOKEN:-}" ]] || exit 91
if [[ "${1:-}" == targets ]]; then printf 'linux/amd64\n'; exit 0; fi
[[ $# -eq 7 && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || exit 2
if [[ "$1" == prepare ]]; then
  mkdir -p "$7/bin"
  printf '#!/bin/sh\necho demo\n' > "$7/bin/demo"
  chmod 755 "$7/bin/demo"
fi
[[ -x "$7/bin/demo" && "$("$7/bin/demo")" == demo ]]
SCRIPT
must_fail() {
  if "$@" >/dev/null 2>&1; then
    echo "unexpected success: $*" >&2; exit 1
  fi
}
GH_TOKEN=sensitive GITHUB_TOKEN=sensitive GHCR_TOKEN=sensitive bash "$root/catalog-run.sh" prepare "$tmp/catalog" demo 1.0 linux amd64 "$tmp/ok"
GH_TOKEN=sensitive GITHUB_TOKEN=sensitive GHCR_TOKEN=sensitive bash "$root/catalog-run.sh" verify "$tmp/catalog" demo 1.0 linux amd64 "$tmp/ok"
must_fail bash "$root/catalog-run.sh" prepare "$tmp/catalog" demo 1.0 linux amd64 "$tmp/ok"
must_fail bash "$root/catalog-run.sh" prepare "$tmp/catalog" demo 1.0 linux arm64 "$tmp/other"
must_fail bash "$root/catalog-run.sh" prepare "$tmp/catalog" ../demo 1.0 linux amd64 "$tmp/other"
must_fail bash "$root/catalog-run.sh" prepare "$tmp/catalog" k8s-bundle 2026.11 linux amd64 "$tmp/other"
must_fail bash "$root/catalog-run.sh" prepare "$tmp/catalog" demo 1.0 linux amd64 /
mkdir -p "$tmp/occupied"; printf keep > "$tmp/occupied/data"
must_fail bash "$root/catalog-run.sh" prepare "$tmp/catalog" demo 1.0 linux amd64 "$tmp/occupied"
grep -q keep "$tmp/occupied/data"
ln -s "$tmp/occupied" "$tmp/symlink"
must_fail bash "$root/catalog-run.sh" prepare "$tmp/catalog" demo 1.0 linux amd64 "$tmp/symlink"
mkdir -p "$tmp/native/linux-amd64/bin"
cp "$tmp/ok/bin/demo" "$tmp/native/linux-amd64/bin/demo"
TOOLCHAIN_TOOL=demo TOOLCHAIN_VERSION=1.0 TOOLCHAIN_TARGETS=linux/amd64 \
TOOLCHAIN_FINGERPRINT="sha256:$(printf demo | sha256sum | cut -d' ' -f1)" \
TOOLCHAIN_CATALOG_SHA="$(printf 'a%.0s' {1..40})" TOOLCHAIN_ROOTFS="$tmp/native" \
  bash "$root/cargo-v2.sh" local
echo 'Toolchain catalog, negative fixtures, credential stripping and native OCI Index: PASS'
