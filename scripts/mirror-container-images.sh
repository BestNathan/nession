#!/usr/bin/env bash
# Mirror already-published multi-architecture GHCR images to another registry.
# CI owns image builds/manifests; this script only copies existing release tags.
set -euo pipefail

if [[ "$#" -lt 4 || "$#" -gt 5 ]]; then
  echo "Usage: $0 <source-image> <destination-image> <server-agent-tag-suffix> <ui-tag-suffix> [server|agent|ui]" >&2
  exit 2
fi

source_image="$1"
destination_image="$2"
runtime_version="$3"
ui_version="$4"
image_kind="${5:-all}"

case "${image_kind}" in
  server) tags=("server-${runtime_version}") ;;
  agent) tags=("agent-${runtime_version}") ;;
  ui) tags=("ui-${ui_version}") ;;
  all) tags=("server-${runtime_version}" "agent-${runtime_version}" "ui-${ui_version}") ;;
  *) echo "ERROR: Invalid image kind: ${image_kind}" >&2; exit 2 ;;
esac

# Some cross-border registry proxies interrupt the HTTP/2 upload stream with
# PROTOCOL_ERROR. Use HTTP/1.1 for Go's registry client to avoid this class of
# transport issue while keeping the existing authenticated Buildx transfer.
export GODEBUG="${GODEBUG:+${GODEBUG},}http2client=0"

# Only the Ubuntu GitHub Actions release lane calls this mirror. Fail explicitly
# if its deadline primitive is missing rather than holding the serialized
# staging deployment lane for the entire job timeout.
if ! command -v timeout >/dev/null 2>&1; then
  echo "ERROR: ACR mirror requires GNU coreutils timeout (Ubuntu release runner)" >&2
  exit 2
fi

# Preserve the fast Buildx path for small/cached images, but do not spend
# 3 x 420 seconds repeating the *same* large Blob upload failure (#3674).
# regctl's chunked registry protocol handles large layers independently.
bounded_inspect() {
  timeout --signal=TERM --kill-after=15s 90s docker buildx imagetools inspect --raw "$1"
}
bounded_create() {
  local destination="$1" amd64="$2" arm64="$3"
  timeout --signal=TERM --kill-after=15s 90s docker buildx imagetools create \
    --tag "$destination" "$amd64" "$arm64"
}
bounded_copy() {
  local source="$1" destination="$2"
  timeout --signal=TERM --kill-after=15s 360s regctl image copy "$source" "$destination"
}
bounded_index() {
  local destination="$1" amd64="$2" arm64="$3"
  timeout --signal=TERM --kill-after=15s 90s regctl index create "$destination" \
    --ref "$amd64" --ref "$arm64"
}
chunked_copy() {
  local tag="$1" amd64="$2" arm64="$3"
  if ! command -v regctl >/dev/null 2>&1; then
    echo "ERROR: pinned regctl is required for chunked ACR copy" >&2
    return 2
  fi

  # The same target ACR hostname, the Docker login already established; never
  # transmit credentials to an unrelated registry or mirror.
  regctl registry set "${destination_image%%/*}" \
    --blob-max 67108864 --blob-chunk 16777216

  local arch digest source_ref dest_ref copied
  for arch in amd64 arm64; do
    if [[ "$arch" == amd64 ]]; then digest="$amd64"; else digest="$arm64"; fi
    # @ source manifest is pinned by its platform digest, not an index tag.
    source_ref="${source_image}@$digest"
    dest_ref="${destination_image}:${tag}-$arch"
    copied=false
    for attempt in 1 2 3; do
      if bounded_copy "$source_ref" "$dest_ref"; then
        copied=true
        break
      fi
      if (( attempt < 3 )); then
        echo "::warning::chunked ACR copy failed for ${tag}/$arch attempt $attempt/3; retrying" >&2
        sleep "$((attempt * 15))"
      fi
    done
    if [[ "$copied" != true ]]; then
      echo "ERROR: chunked ACR copy failed for ${tag}/$arch after 3 attempts" >&2
      return 1
    fi
  done

  # These per-architecture tags retain already-completed Blobs across reruns.
  # The published index contains only linux/amd64 and linux/arm64, no GHCR
  # SBOM/provenance unknown-platform images rejected by ACR Personal Edition.
  bounded_index "${destination_image}:${tag}" \
    "${destination_image}:${tag}-amd64" \
    "${destination_image}:${tag}-arm64"
}

platform_digests() {
  bounded_inspect "$1" | jq -ce '
    [.manifests[]?
     | select(.platform.os == "linux" and
              (.platform.architecture == "amd64" or .platform.architecture == "arm64"))
     | {arch: .platform.architecture, digest: .digest}]
    | sort_by(.arch)
    | select(length == 2 and .[0].arch == "amd64" and .[1].arch == "arm64")
  '
}

for tag in "${tags[@]}"; do
  source_ref="${source_image}:${tag}"
  destination_ref="${destination_image}:${tag}"

  # Buildx-created GHCR indexes can contain provenance/SBOM attestation
  # manifests (OCI empty configs with platform unknown/unknown). Alibaba ACR
  # Personal Edition rejects these: "unknown manifest class for
  # application/vnd.oci.empty.v1+json". Copy the two actual platform image
  # manifests by digest instead of copying the entire upstream index.
  source_platforms="$(platform_digests "${source_ref}")"
  if [[ -z "${source_platforms}" ]]; then
    echo "ERROR: GHCR image ${source_ref} does not contain exactly amd64 and arm64" >&2
    exit 1
  fi

  amd64_digest="$(jq -r '.[] | select(.arch == "amd64") | .digest' <<< "${source_platforms}")"
  arm64_digest="$(jq -r '.[] | select(.arch == "arm64") | .digest' <<< "${source_platforms}")"

  echo "Mirroring two platform manifests: ${source_ref} -> ${destination_ref}"
  # Fast path: no excessive wait when ACR already holds the shared blobs.
  # A failed/slow Buildx transfer triggers per-architecture chunked transport
  # rather than repeating the same problematic opaque upload three times.
  if bounded_create "${destination_ref}" \
      "${source_image}@${amd64_digest}" "${source_image}@${arm64_digest}"; then
    echo "Buildx fast-path ACR copy completed: ${tag}"
  else
    echo "::warning::Buildx ACR copy for ${tag} failed or exceeded 90s; using chunked regctl fallback"
    chunked_copy "${tag}" "${amd64_digest}" "${arm64_digest}"
  fi

  # The destination must preserve exactly the selected platform manifest
  # digests (not just their tags or architecture labels).
  destination_platforms="$(platform_digests "${destination_ref}")"
  if [[ -z "${destination_platforms}" || "${source_platforms}" != "${destination_platforms}" ]]; then
    echo "ERROR: ACR mirror platform digests do not match GHCR for ${tag}" >&2
    exit 1
  fi

  echo "Verified both linux/amd64 and linux/arm64 for ${destination_ref}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf -- '- `%s` — amd64 and arm64 verified\n' "${destination_ref}" >> "${GITHUB_STEP_SUMMARY}"
  fi
done
