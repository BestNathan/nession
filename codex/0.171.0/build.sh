#!/usr/bin/env bash
# Pinned official codex 0.171.0 native executable; upstream GitHub Release asset SHA256.
# Refs #4241. No auth material, user HOME or machine-local configuration is bundled.
set -euo pipefail
if [[ "${1:-}" == targets && "$#" -eq 1 ]]; then printf 'linux/amd64\nlinux/arm64\n'; exit 0; fi
[[ "$#" -eq 7 && ( "$1" == prepare || "$1" == verify ) && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || { echo 'usage: build.sh targets | prepare|verify --platform linux --arch amd64|arm64 --rootfs ABSOLUTE_DIR' >&2; exit 2; }
mode="$1"; os="$3"; arch="$5"; rootfs="$7"
[[ "$os/$arch" == linux/amd64 || "$os/$arch" == linux/arm64 ]] || { echo "unsupported target: $os/$arch" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && -d "$rootfs" && ! -L "$rootfs" ]] || { echo 'unsafe rootfs' >&2; exit 2; }
version=0.171.0
case "$arch" in
  amd64) upstream_arch=x86_64; digest=01baa2e47809f8597be5b2f8abd4e4dfe3fb5bcb6e504c2fbaaad97056c15e8d ;;
  arm64) upstream_arch=aarch64; digest=bcf50b836385e51bd2976ab2bbe92b1b08a1cbe37712eb8dbe378aa78d24871c ;;
esac
if [[ "$mode" == prepare ]]; then
  [[ -z "$(find "$rootfs" -mindepth 1 -print -quit)" ]] || { echo 'rootfs must be empty' >&2; exit 2; }
  tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
  archive="codex-${upstream_arch}-unknown-linux-musl.tar.gz"
  curl -fLSs --retry 3 --max-time 600 "https://github.com/openai/codex/releases/download/rust-v0.171.0/${archive}" -o "$tmp/archive.tar.gz"
  printf '%s  %s\n' "$digest" "$tmp/archive.tar.gz" | sha256sum --check --status || { echo 'codex official archive SHA256 mismatch' >&2; exit 1; }
  # Upstream versions may wrap the binary in an architecture-specific directory.
  # Select exactly one executable pathname; do not extract other archive members.
  mapfile -t entries < <(tar -tzf "$tmp/archive.tar.gz" | grep -E '(^|/)(codex|codex-(x86_64|aarch64)-unknown-linux-musl)$' || true)
  [[ "${#entries[@]}" -eq 1 ]] || { echo 'expected exactly one codex native executable in official archive' >&2; exit 1; }
  tar -xOzf "$tmp/archive.tar.gz" "${entries[0]}" > "$tmp/codex"
  [[ -s "$tmp/codex" ]] || { echo 'missing codex payload' >&2; exit 1; }
  mkdir -p "$rootfs/bin"
  install -m 0755 "$tmp/codex" "$rootfs/bin/codex"
fi
[[ -x "$rootfs/bin/codex" && ! -L "$rootfs/bin/codex" ]] || { echo 'missing native codex executable' >&2; exit 1; }
version_output="$(env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN -u OPENAI_API_KEY "$rootfs/bin/codex" --version | sed -n '1p')"
[[ "$version_output" == *"0.171.0"* ]] || { echo "wrong codex version: $version_output" >&2; exit 1; }
env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN -u OPENAI_API_KEY "$rootfs/bin/codex" --help >/dev/null || { echo 'codex help smoke failed' >&2; exit 1; }
