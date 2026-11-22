#!/usr/bin/env bash
# Official ripgrep 15.2.0, GitHub Release asset SHA256 verified from BurntSushi/ripgrep.
# Refs #4241; static linux-musl payload, exactly one executable, no host state.
set -euo pipefail
if [[ "${1:-}" == targets && "$#" -eq 1 ]]; then printf 'linux/amd64\nlinux/arm64\n'; exit 0; fi
[[ "$#" -eq 7 && ( "$1" == prepare || "$1" == verify ) && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || { echo 'usage: build.sh targets | prepare|verify --platform linux --arch amd64|arm64 --rootfs ABSOLUTE_DIR' >&2; exit 2; }
mode="$1"; os="$3"; arch="$5"; rootfs="$7"
[[ "$os/$arch" == linux/amd64 || "$os/$arch" == linux/arm64 ]] || { echo "unsupported target: $os/$arch" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && -d "$rootfs" && ! -L "$rootfs" ]] || { echo 'unsafe rootfs' >&2; exit 2; }
version=15.2.0
case "$arch" in
  amd64) upstream_arch=x86_64; digest=33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c ;;
  arm64) upstream_arch=aarch64; digest=800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915 ;;
esac
if [[ "$mode" == prepare ]]; then
  [[ -z "$(find "$rootfs" -mindepth 1 -print -quit)" ]] || { echo 'rootfs must be empty' >&2; exit 2; }
  tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
  archive="ripgrep-${version}-${upstream_arch}-unknown-linux-musl.tar.gz"
  curl -fLSs --retry 3 --max-time 300 "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/${archive}" -o "$tmp/archive.tar.gz"
  printf '%s  %s\n' "$digest" "$tmp/archive.tar.gz" | sha256sum --check --status || { echo 'rg upstream archive SHA256 mismatch' >&2; exit 1; }
  # Extract exactly the expected executable; neither archive metadata nor
  # nested links/extra files can become content of the EROFS image.
  mapfile -t entries < <(tar -tzf "$tmp/archive.tar.gz" | grep -E '(^|/)rg$' || true)
  [[ "${#entries[@]}" -eq 1 ]] || { echo 'expected exactly one rg binary in upstream archive' >&2; exit 1; }
  tar -xOzf "$tmp/archive.tar.gz" "${entries[0]}" > "$tmp/rg"
  [[ -s "$tmp/rg" ]] || { echo 'empty executable' >&2; exit 1; }
  mkdir -p "$rootfs/bin"
  install -m 0755 "$tmp/rg" "$rootfs/bin/rg"
fi
[[ -x "$rootfs/bin/rg" && ! -L "$rootfs/bin/rg" ]] || { echo 'missing rg' >&2; exit 1; }
version_output="$("$rootfs/bin/rg" --version | sed -n '1p')"
[[ "$version_output" == "ripgrep 15.2.0"* ]] || { echo "incorrect rg version: $version_output" >&2; exit 1; }
printf "nession-toolchain\n" | "$rootfs/bin/rg" "^nession-toolchain$" >/dev/null || { echo "rg smoke failed" >&2; exit 1; }
