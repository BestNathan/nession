#!/usr/bin/env bash
# #4160: version folder owns executable verification; publisher never calls this wrapper.
set -euo pipefail
[[ $# -eq 7 ]] || { echo 'usage: catalog-run.sh prepare|verify CATALOG TOOL VERSION PLATFORM ARCH ROOTFS' >&2; exit 2; }
mode="$1"; root="$2"; tool="$3"; version="$4"; platform="$5"; arch="$6"; dest="$7"
[[ "$mode" == prepare || "$mode" == verify ]] || exit 2
[[ "$tool" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ && "$tool" != *..* && "$version" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ && "$version" != *..* ]] || { echo 'unsafe selector' >&2; exit 2; }
[[ "$root" == /* && "$dest" == /* && "$dest" != / && "$dest" != */.. && "$dest" != *'/../'* && "$dest" != */. && "$dest" != *'/./'* ]] || { echo 'unsafe directory' >&2; exit 2; }
script="$root/$tool/$version/build.sh"
[[ -f "$script" && ! -L "$script" ]] || { echo 'missing build.sh' >&2; exit 2; }
if [[ "$mode" == prepare ]]; then
  [[ ! -e "$dest" && ! -L "$dest" ]] || { echo 'rootfs must not preexist' >&2; exit 2; }
  mkdir -p -- "$dest"
else
  [[ -d "$dest" && ! -L "$dest" ]] || exit 2
fi
env -u GH_TOKEN -u GITHUB_TOKEN -u GHCR_TOKEN -u GHCR_ACTOR -u NESSION_MCP_INBOUND_TOKEN \\\n  bash "$script" "$mode" --platform "$platform" --arch "$arch" --rootfs "$dest"
[[ -d "$dest/bin" && -n "$(find "$dest/bin" -maxdepth 1 -type f -print -quit)" ]] || { echo 'empty bin/' >&2; exit 1; }
[[ -z "$(find "$dest" -type l -print -quit)" && -z "$(find "$dest" ! -type d ! -type f -print -quit)" ]] || { echo 'unsafe rootfs file type' >&2; exit 1; }
while IFS= read -r -d '' file; do [[ -x "$file" ]] || { echo "nonexecutable: $file" >&2; exit 1; }; done < <(find "$dest/bin" -maxdepth 1 -type f -print0)
