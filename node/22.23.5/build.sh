#!/usr/bin/env bash
# Official Node.js 22.23.5 LTS. SHA256 sourced from nodejs.org/en/blog/release/v22.23.5 PGP-signed SHASUMS.
# Refs #4241. Full Node/npm/npx distribution, no host HOME or npm cache embedded.
set -euo pipefail
if [[ "${1:-}" == targets && "$#" -eq 1 ]]; then printf 'linux/amd64\nlinux/arm64\n'; exit 0; fi
[[ "$#" -eq 7 && ( "$1" == prepare || "$1" == verify ) && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || { echo 'usage: build.sh targets | prepare|verify --platform linux --arch amd64|arm64 --rootfs ABSOLUTE_DIR' >&2; exit 2; }
mode="$1"; os="$3"; arch="$5"; rootfs="$7"
[[ "$os/$arch" == linux/amd64 || "$os/$arch" == linux/arm64 ]] || { echo "unsupported target: $os/$arch" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && -d "$rootfs" && ! -L "$rootfs" ]] || { echo 'unsafe rootfs' >&2; exit 2; }
version=22.23.5
case "$arch" in
  amd64) upstream_arch=x64; digest=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8 ;;
  arm64) upstream_arch=arm64; digest=2babb9eb5264860d540849f4b064a6fbdebcdc323657d9d382ce23d313fd5e09 ;;
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
  # The official archive also ships internal Corepack/npm helper links.
  # Convert only resolvable regular files *inside* the source-verified tree,
  # retaining relative behavior while honoring the EROFS no-symlink contract.
  while IFS= read -r -d '' link; do
    resolved="$(readlink -f -- "$link")"
    [[ "$resolved" == "$rootfs/"* && -f "$resolved" ]] || { echo "unsafe Node installed link: $link" >&2; exit 1; }
    cp -L -- "$link" "$link.nession-copy"
    rm -- "$link"
    mv -- "$link.nession-copy" "$link"
  done < <(find "$rootfs" -type l -print0)
  [[ -z "$(find "$rootfs" -type l -print -quit)" ]] || { echo 'Node rootfs contains unsupported symlink' >&2; exit 1; }
fi
[[ -x "$rootfs/bin/node" && -x "$rootfs/bin/npm" && -x "$rootfs/bin/npx" ]] || { echo 'missing Node/npm/npx executable' >&2; exit 1; }
[[ "$("$rootfs/bin/node" --version)" == "v${version}" ]] || { echo 'wrong Node version' >&2; exit 1; }
"$rootfs/bin/node" -e 'if (!process.versions.node || process.platform !== "linux") process.exit(1)'
[[ "$("$rootfs/bin/npm" --version)" =~ ^[0-9]+[.][0-9]+[.][0-9]+ ]] || { echo 'npm invocation failed' >&2; exit 1; }
[[ "$("$rootfs/bin/npx" --version)" =~ ^[0-9]+[.][0-9]+[.][0-9]+ ]] || { echo 'npx invocation failed' >&2; exit 1; }
[[ -z "$(find "$rootfs" -type l -print -quit)" ]] || { echo 'unexpected symbolic link in extracted Node rootfs' >&2; exit 1; }
