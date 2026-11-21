#!/usr/bin/env bash
# #4092: a recipe only prepares checked, version-pinned bytes in a supplied root.
set -euo pipefail
[[ $# -eq 4 && "$1" == prepare ]] || { echo "usage: jq.sh prepare VERSION linux/amd64 ROOTFS" >&2; exit 2; }
version="$2"; platform="$3"; rootfs="$4"
[[ "$platform" == linux/amd64 ]] || { echo "jq: unsupported platform: $platform" >&2; exit 2; }
case "$version" in
  1.7.1) digest="5942c9b0934e510ee61eb3e30273f1b3fe2590df93933a93d7c58b81d19c8ff5" ;;
  1.8.1) digest="020468de7539ce70ef1bceaf7cde2e8c4f2ca6c3afb84642aabc5c97d9fc2a0d" ;;
  *) echo "jq: unsupported version: $version" >&2; exit 2 ;;
esac
[[ -d "$rootfs" && ! -L "$rootfs" && ! -e "$rootfs/bin/jq" ]] || { echo "jq: invalid or conflicting rootfs" >&2; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
url="https://github.com/jqlang/jq/releases/download/jq-${version}/jq-linux-amd64"
curl --fail --location --silent --show-error --retry 3 --max-time 180 "$url" --output "$tmp/jq"
printf '%s  %s\n' "$digest" "$tmp/jq" | sha256sum --check --status || { echo "jq: source SHA256 mismatch" >&2; exit 1; }
mkdir -p -- "$rootfs/bin"
install -m 0755 "$tmp/jq" "$rootfs/bin/jq"
[[ "$("$rootfs/bin/jq" --version)" == "jq-${version}" ]] || { echo "jq: executable version mismatch" >&2; exit 1; }
echo "recipe jq $version $platform source_sha256=$digest"
