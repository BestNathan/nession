#!/usr/bin/env bash
# Official sccache 0.19.0, GitHub Release asset SHA256 verified from mozilla/sccache.
# Refs #4241; static linux-musl payload, exactly one executable, no host state.
set -euo pipefail
if [[ "${1:-}" == targets && "$#" -eq 1 ]]; then printf 'linux/amd64\nlinux/arm64\n'; exit 0; fi
[[ "$#" -eq 7 && ( "$1" == prepare || "$1" == verify ) && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || { echo 'usage: build.sh targets | prepare|verify --platform linux --arch amd64|arm64 --rootfs ABSOLUTE_DIR' >&2; exit 2; }
mode="$1"; os="$3"; arch="$5"; rootfs="$7"
[[ "$os/$arch" == linux/amd64 || "$os/$arch" == linux/arm64 ]] || { echo "unsupported target: $os/$arch" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && -d "$rootfs" && ! -L "$rootfs" ]] || { echo 'unsafe rootfs' >&2; exit 2; }
version=0.19.0
case "$arch" in
  amd64) upstream_arch=x86_64; digest=aa73c7270c997894038c0d8f0d297865f57569e1687883322bc431713d4bb9dd ;;
  arm64) upstream_arch=aarch64; digest=3e47fc4a71b1ddd1b4294a0de9d34498922fdf41e3cd0bda5df3954e3d6deb9d ;;
esac
if [[ "$mode" == prepare ]]; then
  [[ -z "$(find "$rootfs" -mindepth 1 -print -quit)" ]] || { echo 'rootfs must be empty' >&2; exit 2; }
  tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
  archive="sccache-v${version}-${upstream_arch}-unknown-linux-musl.tar.gz"
  curl -fLSs --retry 3 --max-time 300 "https://github.com/mozilla/sccache/releases/download/v0.19.0/${archive}" -o "$tmp/archive.tar.gz"
  printf '%s  %s\n' "$digest" "$tmp/archive.tar.gz" | sha256sum --check --status || { echo 'sccache upstream archive SHA256 mismatch' >&2; exit 1; }
  # Extract exactly the expected executable; neither archive metadata nor
  # nested links/extra files can become content of the EROFS image.
  mapfile -t entries < <(tar -tzf "$tmp/archive.tar.gz" | grep -E '(^|/)sccache$' || true)
  [[ "${#entries[@]}" -eq 1 ]] || { echo 'expected exactly one sccache binary in upstream archive' >&2; exit 1; }
  tar -xOzf "$tmp/archive.tar.gz" "${entries[0]}" > "$tmp/sccache"
  [[ -s "$tmp/sccache" ]] || { echo 'empty executable' >&2; exit 1; }
  mkdir -p "$rootfs/bin"
  install -m 0755 "$tmp/sccache" "$rootfs/bin/sccache"
fi
[[ -x "$rootfs/bin/sccache" && ! -L "$rootfs/bin/sccache" ]] || { echo 'missing sccache' >&2; exit 1; }
version_output="$("$rootfs/bin/sccache" --version | sed -n '1p')"
[[ "$version_output" == "sccache 0.19.0"* ]] || { echo "incorrect sccache version: $version_output" >&2; exit 1; }

