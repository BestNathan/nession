#!/usr/bin/env bash
# Official just 1.59.0, GitHub Release asset SHA256 verified from casey/just.
# Refs #4241; static linux-musl payload, exactly one executable, no host state.
set -euo pipefail
if [[ "${1:-}" == targets && "$#" -eq 1 ]]; then printf 'linux/amd64\nlinux/arm64\n'; exit 0; fi
[[ "$#" -eq 7 && ( "$1" == prepare || "$1" == verify ) && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || { echo 'usage: build.sh targets | prepare|verify --platform linux --arch amd64|arm64 --rootfs ABSOLUTE_DIR' >&2; exit 2; }
mode="$1"; os="$3"; arch="$5"; rootfs="$7"
[[ "$os/$arch" == linux/amd64 || "$os/$arch" == linux/arm64 ]] || { echo "unsupported target: $os/$arch" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && -d "$rootfs" && ! -L "$rootfs" ]] || { echo 'unsafe rootfs' >&2; exit 2; }
version=1.59.0
case "$arch" in
  amd64) upstream_arch=x86_64; digest=409044617b6f06517c1035e55ca38c8c856ff8b650e41bc2aa1ef82d5903a23e ;;
  arm64) upstream_arch=aarch64; digest=23871b1702bfd550fb5f901778fd4290ecf2ee034a45a889fbe96d89b188086d ;;
esac
if [[ "$mode" == prepare ]]; then
  [[ -z "$(find "$rootfs" -mindepth 1 -print -quit)" ]] || { echo 'rootfs must be empty' >&2; exit 2; }
  tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
  archive="just-${version}-${upstream_arch}-unknown-linux-musl.tar.gz"
  curl -fLSs --retry 3 --max-time 300 "https://github.com/casey/just/releases/download/1.59.0/${archive}" -o "$tmp/archive.tar.gz"
  printf '%s  %s\n' "$digest" "$tmp/archive.tar.gz" | sha256sum --check --status || { echo 'just upstream archive SHA256 mismatch' >&2; exit 1; }
  # Extract exactly the expected executable; neither archive metadata nor
  # nested links/extra files can become content of the EROFS image.
  mapfile -t entries < <(tar -tzf "$tmp/archive.tar.gz" | grep -E '(^|/)just$' || true)
  [[ "${#entries[@]}" -eq 1 ]] || { echo 'expected exactly one just binary in upstream archive' >&2; exit 1; }
  tar -xOzf "$tmp/archive.tar.gz" "${entries[0]}" > "$tmp/just"
  [[ -s "$tmp/just" ]] || { echo 'empty executable' >&2; exit 1; }
  mkdir -p "$rootfs/bin"
  install -m 0755 "$tmp/just" "$rootfs/bin/just"
fi
[[ -x "$rootfs/bin/just" && ! -L "$rootfs/bin/just" ]] || { echo 'missing just' >&2; exit 1; }
version_output="$("$rootfs/bin/just" --version | sed -n '1p')"
[[ "$version_output" == "just 1.59.0"* ]] || { echo "incorrect just version: $version_output" >&2; exit 1; }

# Exercise just's taskfile parser and native shell invocation without the network.
probe_dir="$(mktemp -d)"; trap 'rm -rf -- "$probe_dir"' EXIT
printf 'check:\n    @printf nession-just\n' > "$probe_dir/justfile"
[[ "$("$rootfs/bin/just" --justfile "$probe_dir/justfile" check)" == nession-just ]] || { echo 'just task execution failed' >&2; exit 1; }
