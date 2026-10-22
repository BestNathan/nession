#!/usr/bin/env bash
# Mirror already-published multi-architecture GHCR images to another registry.
# CI owns image builds/manifests; this script only copies existing release tags.
set -euo pipefail

if [[ "$#" -ne 4 ]]; then
  echo "Usage: $0 <source-image> <destination-image> <server-agent-tag-suffix> <ui-tag-suffix>" >&2
  exit 2
fi

source_image="$1"
destination_image="$2"
runtime_version="$3"
ui_version="$4"

for tag in "server-${runtime_version}" "agent-${runtime_version}" "ui-${ui_version}"; do
  source_ref="${source_image}:${tag}"
  destination_ref="${destination_image}:${tag}"

  echo "Mirroring ${source_ref} -> ${destination_ref}"
  # With one multi-arch source index, imagetools copies its platform images
  # and index to the destination registry. No compilation or image rebuild.
  docker buildx imagetools create --tag "${destination_ref}" "${source_ref}"

  # Verify that the copy is pullable as a multi-architecture image, and both
  # required architectures still reference the same platform image digests.
  platform_digests() {
    docker buildx imagetools inspect --raw "$1" | jq -ce '
      [.manifests[]?
       | select(.platform.os == "linux" and
                (.platform.architecture == "amd64" or .platform.architecture == "arm64"))
       | {arch: .platform.architecture, digest: .digest}]
      | sort_by(.arch)
      | select(length == 2 and .[0].arch == "amd64" and .[1].arch == "arm64")
    '
  }

  source_platforms="$(platform_digests "${source_ref}")"
  destination_platforms="$(platform_digests "${destination_ref}")"

  if [[ -z "${source_platforms}" || "${source_platforms}" != "${destination_platforms}" ]]; then
    echo "ERROR: ACR mirror platform digests do not match GHCR for ${tag}" >&2
    exit 1
  fi

  echo "Verified both linux/amd64 and linux/arm64 for ${destination_ref}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf -- '- `%s` — amd64 and arm64 verified\n' "${destination_ref}" >> "${GITHUB_STEP_SUMMARY}"
  fi
done
