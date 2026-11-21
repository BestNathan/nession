#!/usr/bin/env bash
# One *shared rootfs* from two independent version-pinned recipes.
set -euo pipefail
[[ $# -eq 4 && "$1" == prepare ]] || { echo "usage: k8s-bundle.sh prepare VERSION linux/amd64 ROOTFS" >&2; exit 2; }
[[ "$2" == 2026.11 ]] || { echo "k8s-bundle: unsupported release: $2" >&2; exit 2; }
[[ "$3" == linux/amd64 ]] || { echo "k8s-bundle: unsupported platform: $3" >&2; exit 2; }
dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bash "$dir/jq.sh" prepare 1.8.1 "$3" "$4"
bash "$dir/kubectl.sh" prepare 1.35.0 "$3" "$4"
echo "recipe k8s-bundle 2026.11 $3 contains=jq:1.8.1,kubectl:1.35.0"
