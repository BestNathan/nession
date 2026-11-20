#!/usr/bin/env bash
# Source-locked jq 1.7.1 distribution; #4160
set -euo pipefail
if [[ "${1:-}" == targets && "$#" -eq 1 ]]; then printf 'linux/amd64\n'; exit 0; fi
[[ "$#" -eq 7 && ( "$1" == prepare || "$1" == verify ) && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || { echo "usage: build.sh targets | prepare|verify --platform linux --arch amd64 --rootfs ABSOLUTE_DIR" >&2; exit 2; }
mode="$1"; os="$3"; arch="$5"; rootfs="$7"
[[ "$os/$arch" == linux/amd64 ]] || { echo "unsupported target: $os/$arch" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && -d "$rootfs" && ! -L "$rootfs" ]] || { echo "unsafe rootfs" >&2; exit 2; }
version=1.7.1
digest=5942c9b0934e510ee61eb3e30273f1b3fe2590df93933a93d7c58b81d19c8ff5
if [[ "$mode" == prepare ]]; then
  [[ -z "$(find "$rootfs" -mindepth 1 -print -quit)" ]] || { echo "rootfs must be empty" >&2; exit 2; }
  tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
  curl -fLSs --retry 3 --max-time 180 "https://github.com/jqlang/jq/releases/download/jq-${version}/jq-linux-amd64" -o "$tmp/jq"
  printf '%s  %s\n' "$digest" "$tmp/jq" | sha256sum --check --status
  mkdir -p "$rootfs/bin"; install -m 0755 "$tmp/jq" "$rootfs/bin/jq"
fi
[[ -x "$rootfs/bin/jq" && ! -L "$rootfs/bin/jq" ]] || { echo "missing jq binary" >&2; exit 1; }
[[ "$("$rootfs/bin/jq" --version)" == "jq-${version}" ]] || { echo "incorrect jq version" >&2; exit 1; }
