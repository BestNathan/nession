#!/usr/bin/env bash
# Source-locked kubectl 1.35.0 distribution; #4160
set -euo pipefail
if [[ "${1:-}" == targets && "$#" -eq 1 ]]; then printf 'linux/amd64\nlinux/arm64\n'; exit 0; fi
[[ "$#" -eq 7 && ( "$1" == prepare || "$1" == verify ) && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || { echo "usage: build.sh targets | prepare|verify --platform linux --arch amd64 --rootfs ABSOLUTE_DIR" >&2; exit 2; }
mode="$1"; os="$3"; arch="$5"; rootfs="$7"
[[ "$os/$arch" == linux/amd64 || "$os/$arch" == linux/arm64 ]] || { echo "unsupported target: $os/$arch" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && -d "$rootfs" && ! -L "$rootfs" ]] || { echo "unsafe rootfs" >&2; exit 2; }
version=1.35.0
case "$arch" in
  amd64) digest=a2e984a18a0c063279d692533031c1eff93a262afcc0afdc517375432d060989 ;;
  arm64) digest=58f82f9fe796c375c5c4b8439850b0f3f4d401a52434052f2df46035a8789e25 ;;
esac
if [[ "$mode" == prepare ]]; then
  [[ -z "$(find "$rootfs" -mindepth 1 -print -quit)" ]] || { echo "rootfs must be empty" >&2; exit 2; }
  tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
  curl -fLSs --retry 3 --max-time 300 "https://dl.k8s.io/release/v${version}/bin/linux/amd64/kubectl" -o "$tmp/kubectl"
  printf '%s  %s\n' "$digest" "$tmp/kubectl" | sha256sum --check --status
  mkdir -p "$rootfs/bin"; install -m 0755 "$tmp/kubectl" "$rootfs/bin/kubectl"
fi
[[ -x "$rootfs/bin/kubectl" && ! -L "$rootfs/bin/kubectl" ]] || { echo "missing kubectl binary" >&2; exit 1; }
"$rootfs/bin/kubectl" version --client --output=json | grep -Eq '"gitVersion"[[:space:]]*:[[:space:]]*"v1[.]35[.]0"' || { echo "incorrect kubectl version" >&2; exit 1; }
printf '%s  %s\n' "$digest" "$rootfs/bin/kubectl" | sha256sum --check --status || { echo 'extracted kubectl upstream SHA256 mismatch' >&2; exit 1; }
