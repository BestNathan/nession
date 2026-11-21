#!/usr/bin/env bash
# Official Node.js 24.22.3 LTS. SHA256 sourced from nodejs.org/en/blog/release/v24.22.3 PGP-signed SHASUMS.
# Refs #4241. Full Node/npm/npx distribution, no host HOME or npm cache embedded.
set -euo pipefail
if [[ "${1:-}" == targets && "$#" -eq 1 ]]; then printf 'linux/amd64\nlinux/arm64\n'; exit 0; fi
[[ "$#" -eq 7 && ( "$1" == prepare || "$1" == verify ) && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || { echo 'usage: build.sh targets | prepare|verify --platform linux --arch amd64|arm64 --rootfs ABSOLUTE_DIR' >&2; exit 2; }
mode="$1"; os="$3"; arch="$5"; rootfs="$7"
[[ "$os/$arch" == linux/amd64 || "$os/$arch" == linux/arm64 ]] || { echo "unsupported target: $os/$arch" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && -d "$rootfs" && ! -L "$rootfs" ]] || { echo 'unsafe rootfs' >&2; exit 2; }
version=24.22.3
case "$arch" in
  amd64) upstream_arch=x64; digest=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb ;;
  arm64) upstream_arch=arm64; digest=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c ;;
esac
if [[ "$mode" == prepare ]]; then
  [[ -z "$(find "$rootfs" -mindepth 1 -print -quit)" ]] || { echo 'rootfs must be empty' >&2; exit 2; }
  tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
  archive="node-v${version}-linux-${upstream_arch}.tar.xz"
  curl -fLSs --retry 3 --max-time 600 "https://nodejs.org/dist/v${version}/${archive}" -o "$tmp/node.tar.xz"
  printf '%s  %s\n' "$digest" "$tmp/node.tar.xz" | sha256sum --check --status || { echo 'official Node.js archive SHA256 mismatch' >&2; exit 1; }
  tar -xJf "$tmp/node.tar.xz" -C "$rootfs" --strip-components=1 --no-same-owner
  [[ -x "$rootfs/bin/node" && -f "$rootfs/lib/node_modules/npm/bin/npm-cli.js" && -f "$rootfs/lib/node_modules/npm/bin/npx-cli.js" ]] || { echo 'incomplete official node/npm/npx distribution' >&2; exit 1; }
  # Native Node distributions expose npm/npx as symlinks; the OCI EROFS transport
  # deliberately forbids symlinks. Use relocatable wrappers instead of baking paths.
  rm -f -- "$rootfs/bin/npm" "$rootfs/bin/npx" "$rootfs/bin/corepack"
  for command in npm npx; do
    printf '%s\n' '#!/bin/sh' 'set -eu' 'base="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"' "exec \"\$base/bin/node\" \"\$base/lib/node_modules/npm/bin/${command}-cli.js\" \"\$@\"" > "$rootfs/bin/$command"
    chmod 0755 "$rootfs/bin/$command"
  done
  [[ -z "$(find "$rootfs" -type l -print -quit)" ]] || { echo 'Node archive contains unsupported symlink beyond npm/npx/corepack' >&2; exit 1; }
fi
[[ -x "$rootfs/bin/node" && -x "$rootfs/bin/npm" && -x "$rootfs/bin/npx" ]] || { echo 'missing Node/npm/npx executable' >&2; exit 1; }
[[ "$("$rootfs/bin/node" --version)" == "v${version}" ]] || { echo 'wrong Node version' >&2; exit 1; }
"$rootfs/bin/node" -e 'if (!process.versions.node || process.platform !== "linux") process.exit(1)'
[[ "$("$rootfs/bin/npm" --version)" =~ ^[0-9]+[.][0-9]+[.][0-9]+ ]] || { echo 'npm invocation failed' >&2; exit 1; }
[[ "$("$rootfs/bin/npx" --version)" =~ ^[0-9]+[.][0-9]+[.][0-9]+ ]] || { echo 'npx invocation failed' >&2; exit 1; }
[[ -z "$(find "$rootfs" -type l -print -quit)" ]] || { echo 'unexpected symbolic link in extracted Node rootfs' >&2; exit 1; }
