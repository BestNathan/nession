#!/usr/bin/env bash
# Official Cloudflare CLI cf@1.0.0-rc.2 source release (Git SHA pinned).
# Refs #4241. An external Node 24 toolchain is a declared runtime prerequisite.
# Do not include node in this individual cf EROFS toolchain distribution.
set -euo pipefail
if [[ "$#" -eq 1 && "$1" == targets ]]; then printf 'linux/amd64\nlinux/arm64\n'; exit 0; fi
[[ "$#" -eq 7 && ( "$1" == prepare || "$1" == verify ) && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || { echo 'usage: build.sh targets | prepare|verify --platform linux --arch amd64|arm64 --rootfs ABSOLUTE_DIR' >&2; exit 2; }
mode="$1"; os="$3"; arch="$5"; rootfs="$7"
[[ "$os/$arch" == linux/amd64 || "$os/$arch" == linux/arm64 ]] || { echo "unsupported target: $os/$arch" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && -d "$rootfs" && ! -L "$rootfs" ]] || { echo 'unsafe rootfs' >&2; exit 2; }
version=1.0.0-rc.2
source_sha=87e509e317dcd36dbe7e4b7e095dda628b91285c
case "$arch" in
  amd64) upstream_arch=x64; pnpm_digest=568fd50dd174a57e80efacc04be1d6a228bb41fbebe557f2ef63a1c3a721a5f4 ;;
  arm64) upstream_arch=arm64; pnpm_digest=e6edbf380ee2299be4cde0f5b8f7183529a8963916637896dd6b3ac71a216ae0 ;;
esac
command -v node >/dev/null || { echo 'cf requires separately mounted Node 24 runtime' >&2; exit 2; }
node_version="$(node -p 'process.versions.node')"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_minor="$(node -p 'process.versions.node.split(".")[1]')"
[[ "$node_major" == 24 || "$node_major" == 26 || ( "$node_major" == 22 && "$node_minor" -ge 23 ) ]] || { echo "unsupported host Node version: $node_version" >&2; exit 2; }
if [[ "$mode" == prepare ]]; then
  [[ -z "$(find "$rootfs" -mindepth 1 -print -quit)" ]] || { echo 'rootfs must be empty' >&2; exit 2; }
  command -v git >/dev/null || { echo 'Git required to fetch pinned CF source' >&2; exit 2; }
  tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
  archive="pnpm-linux-$upstream_arch.tar.gz"
  curl -fLSs --retry 3 --max-time 400 "https://github.com/pnpm/pnpm/releases/download/v12.20.0/$archive" -o "$tmp/pnpm.tar.gz"
  printf '%s  %s\n' "$pnpm_digest" "$tmp/pnpm.tar.gz" | sha256sum --check --status || { echo 'official pnpm executable SHA mismatch' >&2; exit 1; }
  entry="$(tar -tzf "$tmp/pnpm.tar.gz" | grep -E '(^|/)pnpm$' || true)"
  [[ -n "$entry" && "$(printf '%s\n' "$entry" | wc -l)" -eq 1 ]] || { echo 'unexpected pinned pnpm archive layout' >&2; exit 1; }
  tar -xOzf "$tmp/pnpm.tar.gz" "$entry" > "$tmp/pnpm"
  chmod 0755 "$tmp/pnpm"
  [[ "$("$tmp/pnpm" --version)" == 12.20.0 ]] || { echo 'wrong pnpm version' >&2; exit 1; }
  git clone -q --depth=1 --branch 'cf@1.0.0-rc.2' https://github.com/cloudflare/cf.git "$tmp/source"
  [[ "$(git -C "$tmp/source" rev-parse HEAD)" == "$source_sha" ]] || { echo 'CF tag source commit mismatch' >&2; exit 1; }
  [[ -f "$tmp/source/pnpm-lock.yaml" ]] || { echo 'missing immutable upstream lock' >&2; exit 1; }
  (cd "$tmp/source" && "$tmp/pnpm" install --frozen-lockfile && "$tmp/pnpm" --filter cf build && "$tmp/pnpm" --filter cf deploy --prod "$tmp/app")
  [[ -f "$tmp/app/dist/index.mjs" && -f "$tmp/app/bin/cf" ]] || { echo 'missing built CF CLI bundle' >&2; exit 1; }
  mkdir -p "$rootfs/bin" "$rootfs/lib"
  cp -a -- "$tmp/app" "$rootfs/lib/cf"
  cat > "$rootfs/bin/cf" <<'WRAPPER'
#!/bin/sh
set -eu
base="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
exec node "$base/lib/cf/bin/cf" "$@"
WRAPPER
  chmod 0755 "$rootfs/bin/cf"
  # The EROFS transport rejects symlinks. Resolve only strictly internal
  # package links; never materialize files from outside the pinned image.
  for attempt in $(seq 1 10000); do
    link="$(find "$rootfs" -type l -print -quit)"
    [[ -n "$link" ]] || break
    target="$(readlink -f -- "$link")"
    [[ "$target" == "$rootfs/"* && ( -f "$target" || -d "$target" ) ]] || { echo "unsafe CF dependency link: $link" >&2; exit 1; }
    if [[ -d "$target" ]]; then cp -aL -- "$link" "$link.nession-copy"; else cp -L -- "$link" "$link.nession-copy"; fi
    rm -- "$link"
    mv -- "$link.nession-copy" "$link"
  done
  [[ -z "$(find "$rootfs" -type l -print -quit)" ]] || { echo 'unbounded CF dependency symlinks' >&2; exit 1; }
fi
[[ -x "$rootfs/bin/cf" && -f "$rootfs/lib/cf/dist/index.mjs" ]] || { echo 'missing Cloudflare CLI payload' >&2; exit 1; }
[[ -z "$(find "$rootfs" -type l -print -quit)" ]] || { echo 'CF image contains symlink' >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
output="$(env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u CLOUDFLARE_EMAIL -u CLOUDFLARE_API_KEY HOME="$tmp" CI=1 NO_COLOR=1 CF_NO_UPDATE_NOTIFIER=1 timeout 40 "$rootfs/bin/cf" --version)"
[[ "$output" == *"$version"* ]] || { echo "CF version invocation failed: $output" >&2; exit 1; }
env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u CLOUDFLARE_EMAIL -u CLOUDFLARE_API_KEY HOME="$tmp" CI=1 NO_COLOR=1 CF_NO_UPDATE_NOTIFIER=1 timeout 40 "$rootfs/bin/cf" --help >/dev/null || { echo 'CF offline help failed' >&2; exit 1; }
