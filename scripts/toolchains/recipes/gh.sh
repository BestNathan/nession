#!/usr/bin/env bash
# #4147: official immutable GitHub CLI release; only the checked binary enters ROOTFS.
set -euo pipefail
[[ $# -eq 4 && "$1" == prepare ]] || { echo "usage: gh.sh prepare VERSION linux/amd64 ROOTFS" >&2; exit 2; }
version="$2"; platform="$3"; rootfs="$4"
[[ "$platform" == linux/amd64 ]] || { echo "gh: unsupported platform: $platform" >&2; exit 2; }
case "$version" in
  2.105.0) digest="79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f" ;;
  *) echo "gh: unsupported version: $version" >&2; exit 2 ;;
esac
[[ -d "$rootfs" && ! -L "$rootfs" && ! -e "$rootfs/bin/gh" ]] || { echo "gh: invalid or conflicting rootfs" >&2; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
url="https://github.com/cli/cli/releases/download/v${version}/gh_${version}_linux_amd64.tar.gz"
curl --fail --location --silent --show-error --retry 3 --max-time 300 "$url" --output "$tmp/gh.tar.gz"
printf '%s  %s\n' "$digest" "$tmp/gh.tar.gz" | sha256sum --check --status || { echo "gh: source SHA256 mismatch" >&2; exit 1; }
tar -xOzf "$tmp/gh.tar.gz" "gh_${version}_linux_amd64/bin/gh" > "$tmp/gh"
[[ -s "$tmp/gh" ]] || { echo "gh: missing executable in source archive" >&2; exit 1; }
mkdir -p -- "$rootfs/bin"
install -m 0755 "$tmp/gh" "$rootfs/bin/gh"
version_line="$("$rootfs/bin/gh" --version | sed -n '1p')"
[[ "$version_line" == "gh version ${version} ("* ]] || { echo "gh: executable version mismatch" >&2; exit 1; }
echo "recipe gh $version $platform source_sha256=$digest"
