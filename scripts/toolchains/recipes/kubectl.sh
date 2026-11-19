#!/usr/bin/env bash
# #4092: package one upstream-pinned kubectl binary, never kubeconfig/host state.
set -euo pipefail
[[ $# -eq 4 && "$1" == prepare ]] || { echo "usage: kubectl.sh prepare VERSION linux/amd64 ROOTFS" >&2; exit 2; }
version="$2"; platform="$3"; rootfs="$4"
[[ "$platform" == linux/amd64 ]] || { echo "kubectl: unsupported platform: $platform" >&2; exit 2; }
case "$version" in
  1.35.0) digest="cf699c56340dc775230fde4ef84237d27563ea6ef52164c7d078072b586c3918" ;;
  *) echo "kubectl: unsupported version: $version" >&2; exit 2 ;;
esac
[[ -d "$rootfs" && ! -L "$rootfs" && ! -e "$rootfs/bin/kubectl" ]] || { echo "kubectl: invalid or conflicting rootfs" >&2; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
url="https://dl.k8s.io/release/v${version}/bin/linux/amd64/kubectl"
curl --fail --location --silent --show-error --retry 3 --max-time 300 "$url" --output "$tmp/kubectl"
printf '%s  %s\n' "$digest" "$tmp/kubectl" | sha256sum --check --status || { echo "kubectl: source SHA256 mismatch" >&2; exit 1; }
mkdir -p -- "$rootfs/bin"
install -m 0755 "$tmp/kubectl" "$rootfs/bin/kubectl"
"$rootfs/bin/kubectl" version --client --output=json | grep -Eq "\"gitVersion\"[[:space:]]*:[[:space:]]*\"v${version}\"" || { echo "kubectl: executable version mismatch" >&2; exit 1; }
echo "recipe kubectl $version $platform source_sha256=$digest"
