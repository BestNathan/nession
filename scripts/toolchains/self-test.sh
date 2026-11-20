#!/usr/bin/env bash
# Positive and negative script protocol fixtures for #4092; no Registry secrets.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

must_fail() {
  if bash "$root/prepare.sh" "$@" > /dev/null 2>&1; then
    echo "unexpected success for invalid toolchain request: $*" >&2
    exit 1
  fi
}

must_fail prepare unknown 1.0 linux/amd64 "$tmp/bad-tool"
must_fail prepare jq latest linux/amd64 "$tmp/bad-version"
must_fail prepare gh latest linux/amd64 "$tmp/bad-gh-version"
must_fail prepare gh 2.104.0 linux/amd64 "$tmp/bad-gh-unsupported"
must_fail prepare gh 2.105.0 linux/arm64 "$tmp/bad-gh-platform"
must_fail prepare jq 1.8.1 linux/arm64 "$tmp/bad-platform"
must_fail prepare jq 1.8.1 linux/amd64 /
must_fail prepare jq 1.8.1 linux/amd64 ../relative
mkdir -p "$tmp/not-empty"
echo preserve-me > "$tmp/not-empty/data"
must_fail prepare jq 1.8.1 linux/amd64 "$tmp/not-empty"
grep -q preserve-me "$tmp/not-empty/data" || { echo "nonempty rootfs was modified" >&2; exit 1; }
ln -s "$tmp/not-empty" "$tmp/symlink"
must_fail prepare jq 1.8.1 linux/amd64 "$tmp/symlink"

bash "$root/prepare.sh" prepare jq 1.7.1 linux/amd64 "$tmp/jq-old"
bash "$root/prepare.sh" prepare jq 1.8.1 linux/amd64 "$tmp/jq-new"
bash "$root/prepare.sh" prepare kubectl 1.35.0 linux/amd64 "$tmp/kubectl"
bash "$root/prepare.sh" prepare gh 2.105.0 linux/amd64 "$tmp/gh"
[[ "$(find "$tmp/gh" -type f | wc -l)" -eq 1 && -x "$tmp/gh/bin/gh" ]] || { echo "gh: payload must contain only executable bin/gh" >&2; exit 1; }
bash "$root/prepare.sh" prepare k8s-bundle 2026.11 linux/amd64 "$tmp/bundle"
[[ "$("$tmp/jq-old/bin/jq" --version)" == jq-1.7.1 ]]
[[ "$("$tmp/jq-new/bin/jq" --version)" == jq-1.8.1 ]]
[[ "$("$tmp/gh/bin/gh" --version | sed -n '1p')" == "gh version 2.105.0 ("* ]]
[[ -x "$tmp/kubectl/bin/kubectl" && -x "$tmp/bundle/bin/kubectl" && -x "$tmp/bundle/bin/jq" ]]
cmp "$tmp/jq-new/bin/jq" "$tmp/bundle/bin/jq"
cmp "$tmp/kubectl/bin/kubectl" "$tmp/bundle/bin/kubectl"

for fixture in "jq:1.7.1:$tmp/jq-old" "jq:1.8.1:$tmp/jq-new" "k8s-bundle:2026.11:$tmp/bundle" "gh:2.105.0:$tmp/gh"; do
  IFS=: read -r tool version directory <<< "$fixture"
  TOOLCHAIN_TOOL="$tool" TOOLCHAIN_VERSION="$version" TOOLCHAIN_PLATFORM=linux/amd64 TOOLCHAIN_REVISION=1 TOOLCHAIN_ROOTFS="$directory" bash "$root/cargo.sh" local
done

# #4160: validate generic single-tool selector and native OCI Index adapter without GHCR credentials.
bash "$root/catalog-selftest.sh"
mkdir -p "$tmp/generic/linux-amd64"
cp -a "$tmp/jq-new/." "$tmp/generic/linux-amd64/"
TOOLCHAIN_TOOL=jq TOOLCHAIN_VERSION=1.8.1 TOOLCHAIN_TARGETS=linux/amd64 \\
TOOLCHAIN_FINGERPRINT="sha256:$(printf sample | sha256sum | cut -d ' ' -f1)" \\
TOOLCHAIN_CATALOG_SHA="$(printf 'a%.0s' {1..40})" TOOLCHAIN_ROOTFS="$tmp/generic" \\
  bash "$root/cargo-v2.sh" local
echo "Generic catalog + OCI Index fixture: PASS"

echo "Toolchain script protocol, versions, bundle, OCI and failure cases: PASS"
