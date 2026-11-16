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
  local destination="$1" amd64="$2" arm64="$3" diagnostic="$4"
  timeout --signal=TERM --kill-after=15s 90s docker buildx imagetools create \
    --tag "$destination" "$amd64" "$arm64" > "$diagnostic" 2>&1
}
bounded_copy() {
  local source="$1" destination="$2" diagnostic="$3"
  timeout --signal=TERM --kill-after=15s 360s regctl image copy \
    "$source" "$destination" > "$diagnostic" 2>&1
}
# Only emit fixed diagnostic classes. Raw registry errors can contain signed
# token URLs, account names and query strings; never copy them to Actions logs.
failure_class() {
  local status="$1" diagnostic="$2"
  if grep -Eiq '(^|[^0-9])(401|403)([^0-9]|$)|unauthorized|incorrect.*password|authentication required|denied' "$diagnostic"; then
    printf 'credential_or_permission_rejected'
  elif [[ "$status" -eq 124 || "$status" -eq 137 ]]; then
    printf 'transfer_deadline'
  elif grep -Eiq 'TLS handshake timeout|TLS.*timeout' "$diagnostic"; then
    printf 'tls_handshake_timeout'
  elif grep -Eiq 'connection reset by peer|connection refused|EOF' "$diagnostic"; then
    printf 'connection_reset'
  elif grep -Eiq 'context canceled|i/o timeout|network is unreachable|context deadline exceeded|dial tcp' "$diagnostic"; then
    printf 'network_transport'
  else
    printf 'copy_error'
  fi
}
# A platform manifest reports compressed source layer bytes, NOT the actual
# transferred bytes (ACR may already have shared blobs). Observational only.
source_layer_bytes() {
  local manifest
  manifest="$(timeout --signal=TERM --kill-after=5s 20s \
    docker buildx imagetools inspect --raw "$1" 2>/dev/null)" || {
    printf 'unknown'; return 0;
  }
  jq -er '[.layers[]?.size | select(type == "number")] |
    if length == 0 then "unknown" else add end' <<< "$manifest" 2>/dev/null || printf 'unknown'
}
observe_transfer() {
  local tag="$1" arch="$2" mode="$3" attempt="$4" chunk="$5" bytes="$6" start="$7" outcome="$8" status="$9"
  local elapsed="$(( $(date +%s) - start ))"
  echo "ACR_MIRROR_ATTEMPT tag=$tag arch=$arch method=$mode attempt=$attempt chunk_bytes=$chunk source_layer_bytes=$bytes elapsed_s=$elapsed outcome=$outcome exit_code=$status"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf -- '- %s/%s %s attempt %s: %ss, %s (source layers: %s bytes, chunk: %s bytes)\n' \
      "$tag" "$arch" "$mode" "$attempt" "$elapsed" "$outcome" "$bytes" "$chunk" >> "$GITHUB_STEP_SUMMARY"
  fi
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

  # Force moderately sized layers down the chunked path; use progressively
  # smaller chunks on transport failure, never a different registry/credential.
  # Completed blobs remain content-addressed in ACR across exact-SHA retries.
  local arch digest source_ref dest_ref copied diagnostic status outcome start bytes
  local attempt chunk
  diagnostic="$(mktemp)"
  chmod 600 "$diagnostic"
  for arch in amd64 arm64; do
    if [[ "$arch" == amd64 ]]; then digest="$amd64"; else digest="$arm64"; fi
    # Source is pinned by its architecture manifest digest, not a mutable tag.
    source_ref="${source_image}@$digest"
    dest_ref="${destination_image}:${tag}-$arch"
    bytes="$(source_layer_bytes "$source_ref")"
    copied=false
    for attempt in 1 2 3; do
      case "$attempt" in
        1) chunk=4194304 ;;
        2) chunk=1048576 ;;
        3) chunk=524288 ;;
      esac
      # Configuration touches only this same registry hostname; credentials
      # remain in Docker's login store and never appear in the output.
      regctl registry set "${destination_image%%/*}" \
        --blob-max 1048576 --blob-chunk "$chunk"
      start="$(date +%s)"
      status=0
      bounded_copy "$source_ref" "$dest_ref" "$diagnostic" || status=$?
      if [[ "$status" -eq 0 ]]; then
        observe_transfer "$tag" "$arch" regctl "$attempt" "$chunk" "$bytes" "$start" success 0
        copied=true
        break
      fi
      outcome="$(failure_class "$status" "$diagnostic")"
      observe_transfer "$tag" "$arch" regctl "$attempt" "$chunk" "$bytes" "$start" "$outcome" "$status" >&2
      if [[ "$outcome" == credential_or_permission_rejected || "$outcome" == copy_error ]]; then
        echo "ERROR: ACR copy terminated on non-transient $outcome for ${tag}/$arch" >&2
        rm -f "$diagnostic"
        return 1
      fi
      if (( attempt < 3 )); then
        echo "::warning::chunked ACR copy failed for ${tag}/$arch attempt $attempt/3; retrying with smaller chunk" >&2
        sleep "$((attempt * 15))"
      fi
    done
    if [[ "$copied" != true ]]; then
      echo "ERROR: chunked ACR copy failed for ${tag}/$arch after 3 attempts" >&2
      rm -f "$diagnostic"
      return 1
    fi
  done
  rm -f "$diagnostic"

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
  diagnostic="$(mktemp)"
  chmod 600 "$diagnostic"
  start="$(date +%s)"
  status=0
  bounded_create "${destination_ref}" \
    "${source_image}@${amd64_digest}" "${source_image}@${arm64_digest}" \
    "$diagnostic" || status=$?
  if [[ "$status" -eq 0 ]]; then
    observe_transfer "$tag" all buildx 1 0 unknown "$start" success 0
    echo "Buildx fast-path ACR copy completed: ${tag}"
  else
    outcome="$(failure_class "$status" "$diagnostic")"
    observe_transfer "$tag" all buildx 1 0 unknown "$start" "$outcome" "$status" >&2
    if [[ "$outcome" == credential_or_permission_rejected ]]; then
      rm -f "$diagnostic"
      echo "ERROR: ACR copy rejected credentials/permission for ${tag}; not retrying" >&2
      exit 1
    fi
    echo "::warning::Buildx ACR copy for ${tag} failed or exceeded 90s; using chunked regctl fallback"
    rm -f "$diagnostic"
    chunked_copy "${tag}" "${amd64_digest}" "${arm64_digest}"
  fi
  rm -f "$diagnostic"

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
