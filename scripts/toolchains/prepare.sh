#!/usr/bin/env bash
# Minimal recipe contract: prepare VERSION PLATFORM ROOTFS.
# No user supplied script, command, filesystem path or download URL is executed.
set -euo pipefail
[[ $# -eq 5 && "$1" == prepare ]] || { echo "usage: prepare.sh prepare TOOL VERSION linux/amd64 ABSOLUTE_EMPTY_ROOTFS" >&2; exit 2; }
tool="$2"; version="$3"; platform="$4"; rootfs="$5"
case "$tool" in jq|kubectl|k8s-bundle|gh) ;; *) echo "unknown tool: $tool" >&2; exit 2 ;; esac
[[ "$version" =~ ^[0-9][0-9A-Za-z._-]*$ && "$version" != *..* ]] || { echo "invalid version" >&2; exit 2; }
[[ "$platform" == linux/amd64 ]] || { echo "unsupported platform: $platform" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && ! -L "$rootfs" ]] || { echo "unsafe rootfs path" >&2; exit 2; }
if [[ -e "$rootfs" ]]; then
  [[ -d "$rootfs" && ! -n "$(find "$rootfs" -mindepth 1 -print -quit)" ]] || { echo "rootfs must be empty" >&2; exit 2; }
else
  mkdir -p -- "$rootfs"
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bash "$script_dir/recipes/$tool.sh" prepare "$version" "$platform" "$rootfs"
[[ -d "$rootfs/bin" && -n "$(find "$rootfs/bin" -maxdepth 1 -type f -print -quit)" ]] || { echo "recipe produced no bin executables" >&2; exit 1; }
if [[ -n "$(find "$rootfs" -type l -print -quit)" ]]; then echo "recipe produced unsupported symlink" >&2; exit 1; fi
if [[ -n "$(find "$rootfs" ! -type d ! -type f -print -quit)" ]]; then echo "recipe produced unsafe special files" >&2; exit 1; fi
while IFS= read -r -d '' binary; do
  [[ -x "$binary" ]] || { echo "recipe produced non-executable binary: $binary" >&2; exit 1; }
done < <(find "$rootfs/bin" -maxdepth 1 -type f -print0)
echo "prepared $tool $version $platform into $rootfs"
