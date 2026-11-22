#!/usr/bin/env bash
# Pinned official claude 2.1.330 glibc native executable; upstream GitHub Release asset SHA256; musl asset requires absent musl loader on Ubuntu 24.04 runner.
# Refs #4241. No auth material, user HOME or machine-local configuration is bundled.
set -euo pipefail
if [[ "${1:-}" == targets && "$#" -eq 1 ]]; then printf 'linux/amd64\nlinux/arm64\n'; exit 0; fi
[[ "$#" -eq 7 && ( "$1" == prepare || "$1" == verify ) && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || { echo 'usage: build.sh targets | prepare|verify --platform linux --arch amd64|arm64 --rootfs ABSOLUTE_DIR' >&2; exit 2; }
mode="$1"; os="$3"; arch="$5"; rootfs="$7"
[[ "$os/$arch" == linux/amd64 || "$os/$arch" == linux/arm64 ]] || { echo "unsupported target: $os/$arch" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && -d "$rootfs" && ! -L "$rootfs" ]] || { echo 'unsafe rootfs' >&2; exit 2; }
version=2.1.330
case "$arch" in
  amd64) upstream_arch=x64; digest=4d2cde1b749a0c9badcb7ad2ac49d735eebb66b5d503b6e073b81e356ffd5f54 ;;
  arm64) upstream_arch=arm64; digest=d14fa911fec091b5e0365fa55f900d3b596e4bf5040a9fac79ca417ec370287c ;;
esac
if [[ "$mode" == prepare ]]; then
  [[ -z "$(find "$rootfs" -mindepth 1 -print -quit)" ]] || { echo 'rootfs must be empty' >&2; exit 2; }
  tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
  archive="claude-linux-${upstream_arch}.tar.gz"
  curl -fLSs --retry 3 --max-time 600 "https://github.com/anthropics/claude-code/releases/download/v2.1.330/${archive}" -o "$tmp/archive.tar.gz"
  printf '%s  %s\n' "$digest" "$tmp/archive.tar.gz" | sha256sum --check --status || { echo 'claude official archive SHA256 mismatch' >&2; exit 1; }
  # Upstream versions may wrap the binary in an architecture-specific directory.
  # Select exactly one executable pathname; do not extract other archive members.
  mapfile -t entries < <(tar -tzf "$tmp/archive.tar.gz" | grep -E '(^|/)(claude|claude-linux-(x64|arm64)(-musl)?)$' || true)
  [[ "${#entries[@]}" -eq 1 ]] || { echo 'expected exactly one claude native executable in official archive' >&2; exit 1; }
  tar -xOzf "$tmp/archive.tar.gz" "${entries[0]}" > "$tmp/claude"
  [[ -s "$tmp/claude" ]] || { echo 'missing claude payload' >&2; exit 1; }
  mkdir -p "$rootfs/bin"
  install -m 0755 "$tmp/claude" "$rootfs/bin/claude"
fi
[[ -x "$rootfs/bin/claude" && ! -L "$rootfs/bin/claude" ]] || { echo 'missing native claude executable' >&2; exit 1; }
version_output="$(env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN -u OPENAI_API_KEY "$rootfs/bin/claude" --version | sed -n '1p')"
[[ "$version_output" == *"2.1.330"* ]] || { echo "wrong claude version: $version_output" >&2; exit 1; }
env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN -u OPENAI_API_KEY "$rootfs/bin/claude" --help >/dev/null || { echo 'claude help smoke failed' >&2; exit 1; }
