#!/usr/bin/env bash
# Official pinned GitHub CLI 2.105.0, migrated from #4147/PR #4148; #4160
set -euo pipefail
if [[ "${1:-}" == targets && "$#" -eq 1 ]]; then printf 'linux/amd64\nlinux/arm64\n'; exit 0; fi
[[ "$#" -eq 7 && ( "$1" == prepare || "$1" == verify ) && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || { echo "usage: build.sh targets | prepare|verify --platform linux --arch amd64 --rootfs ABSOLUTE_DIR" >&2; exit 2; }
mode="$1"; os="$3"; arch="$5"; rootfs="$7"
[[ "$os/$arch" == linux/amd64 || "$os/$arch" == linux/arm64 ]] || { echo "unsupported target: $os/$arch" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && -d "$rootfs" && ! -L "$rootfs" ]] || { echo "unsafe rootfs" >&2; exit 2; }
version=2.105.0
if [[ "$arch" == amd64 ]]; then digest=79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f
else digest=b1278c75107423d818f1937fd92cafc9e5e9b606631568f68d7fb816f5885a02; fi
if [[ "$mode" == prepare ]]; then
  [[ -z "$(find "$rootfs" -mindepth 1 -print -quit)" ]] || { echo "rootfs must be empty" >&2; exit 2; }
  tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
  curl -fLSs --retry 3 --max-time 300 "https://github.com/cli/cli/releases/download/v${version}/gh_${version}_linux_${arch}.tar.gz" -o "$tmp/gh.tar.gz"
  printf '%s  %s\n' "$digest" "$tmp/gh.tar.gz" | sha256sum --check --status
  tar -xOzf "$tmp/gh.tar.gz" "gh_${version}_linux_${arch}/bin/gh" > "$tmp/gh"
  [[ -s "$tmp/gh" ]] || { echo "missing gh in archive" >&2; exit 1; }
  mkdir -p "$rootfs/bin"; install -m 0755 "$tmp/gh" "$rootfs/bin/gh"
fi
[[ -x "$rootfs/bin/gh" && ! -L "$rootfs/bin/gh" ]] || { echo "missing gh binary" >&2; exit 1; }
version_line="$(env -u GH_TOKEN -u GITHUB_TOKEN -u GHCR_TOKEN "$rootfs/bin/gh" --version | sed -n '1p')"
[[ "$version_line" == "gh version ${version} ("* ]] || { echo "incorrect gh version" >&2; exit 1; }
