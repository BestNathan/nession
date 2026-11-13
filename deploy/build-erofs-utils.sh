#!/usr/bin/env bash
# Build the pinned EROFS helper binaries carried by the Server and Agent
# runtime images (#3178, #3386).
#
# Debian bookworm packages erofs-utils 1.5, whose mkfs.erofs has no `-b`
# (block size) option and therefore cannot run the V1 packaging argv, and it
# packages no erofsfuse at all. Both images therefore build the two tools from
# this one pinned upstream release.
#
# Compression support is disabled deliberately: the V1 image contract builds
# uncompressed images (`compression = "none"`), and the resulting erofsfuse
# then links only libfuse3 and libc. A future compressor is a protocol change
# owned by `nession-protocol`, not an image-build flag.
#
# The binaries are installed at /usr/local/bin/{mkfs.erofs,erofsfuse}. Only the
# binary a role needs is copied into that role's final runtime stage.
#
# Source supply chain (#3386): the GitHub Actions image runners cannot reach
# git.kernel.org, so the source comes from the erofs-utils GitHub tag archive
# instead. That archive is byte-identical to the upstream cgit snapshot and
# carries the same pinned SHA-256, so the EROFS source and version identity are
# unchanged. The checksum, top-level directory and VERSION file are verified
# before the build; a network failure, an integrity failure and a revision
# failure each exit with their own diagnostic.
set -euo pipefail

EROFS_UTILS_VERSION="${EROFS_UTILS_VERSION:-1.9.4}"
EROFS_UTILS_SHA256="${EROFS_UTILS_SHA256:-7d135aa2550326a5acf20f53c518aea5a8900015ce50700044e40f818c31dd80}"
# The default is the official erofs-utils GitHub tag archive (the same tag as
# the pinned upstream release). The overrides exist for deterministic source
# verification tests; the checksum is always verified.
EROFS_UTILS_URL="${EROFS_UTILS_URL:-https://github.com/erofs/erofs-utils/archive/refs/tags/v${EROFS_UTILS_VERSION}.tar.gz}"
# Test seam: fetch, verify and extract the source, then print its path without
# building. The Gate self-test exercises the same fetch/verify code this way.
EROFS_UTILS_SOURCE_ONLY="${EROFS_UTILS_SOURCE_ONLY:-0}"

digest_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "${1}" | awk '{print $1}'
    else
        shasum -a 256 "${1}" | awk '{print $1}'
    fi
}

require_tools() {
    for tool in "$@"; do
        if ! command -v "${tool}" >/dev/null 2>&1; then
            echo "build-erofs-utils: required build tool is missing: ${tool}" >&2
            exit 2
        fi
    done
}

require_tools curl tar
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    echo "build-erofs-utils: required build tool is missing: sha256sum or shasum" >&2
    exit 2
fi
if [ "${EROFS_UTILS_SOURCE_ONLY}" != "1" ]; then
    require_tools make gcc autoconf autoheader aclocal automake libtoolize pkg-config
fi

work="${1:-}"
if [ -z "${work}" ]; then
    work="$(mktemp -d)"
    trap 'rm -rf "${work}"' EXIT
fi
mkdir -p "${work}"
tarball="${work}/erofs-utils.tar.gz"

echo "build-erofs-utils: fetching erofs-utils ${EROFS_UTILS_VERSION} from ${EROFS_UTILS_URL}" >&2
if ! curl -fsSL --connect-timeout 20 --max-time 180 --retry 2 --retry-delay 2 \
    "${EROFS_UTILS_URL}" -o "${tarball}"; then
    echo "build-erofs-utils: source download failed (network/endpoint): ${EROFS_UTILS_URL}" >&2
    exit 3
fi

actual_sha256="$(digest_of "${tarball}")"
if [ "${actual_sha256}" != "${EROFS_UTILS_SHA256}" ]; then
    echo "build-erofs-utils: source integrity check failed: expected=sha256:${EROFS_UTILS_SHA256} actual=sha256:${actual_sha256}" >&2
    exit 4
fi

tar -xzf "${tarball}" -C "${work}"
source_dir="${work}/erofs-utils-${EROFS_UTILS_VERSION}"
if [ ! -d "${source_dir}" ]; then
    echo "build-erofs-utils: source revision check failed: tarball has no top-level directory erofs-utils-${EROFS_UTILS_VERSION}" >&2
    exit 5
fi
declared_version="$(head -n 1 "${source_dir}/VERSION" 2>/dev/null || true)"
if [ "${declared_version}" != "${EROFS_UTILS_VERSION}" ]; then
    echo "build-erofs-utils: source revision check failed: VERSION declares '${declared_version}', expected '${EROFS_UTILS_VERSION}'" >&2
    exit 5
fi

if [ "${EROFS_UTILS_SOURCE_ONLY}" = "1" ]; then
    printf '%s\n' "${source_dir}"
    exit 0
fi

cd "${source_dir}"
./autogen.sh
./configure \
    --enable-fuse \
    --disable-lz4 \
    --disable-lzma \
    --without-zlib \
    --without-libzstd \
    --without-xxhash \
    --without-uuid
make -j"$(nproc)"
install -m 0755 mkfs/mkfs.erofs /usr/local/bin/mkfs.erofs
install -m 0755 fuse/erofsfuse /usr/local/bin/erofsfuse

for binary in mkfs.erofs erofsfuse; do
    if [ ! -x "/usr/local/bin/${binary}" ]; then
        echo "build-erofs-utils: ${binary} was not installed" >&2
        exit 1
    fi
done

# Both tools print their version line to stdout. `erofsfuse --version` also
# exits through usage() on stderr in the FUSE3 build, so capture stdout only
# and assert the printed identity rather than the helper's exit status.
mkfs_version="$(mkfs.erofs --version 2>/dev/null | head -n 1 || true)"
case "${mkfs_version}" in
    *"${EROFS_UTILS_VERSION}"*)
        ;;
    *)
        echo "build-erofs-utils: installed mkfs.erofs does not report the pinned version: ${mkfs_version}" >&2
        exit 6
        ;;
esac
erofsfuse_version="$(erofsfuse --version 2>/dev/null | head -n 1 || true)"
case "${erofsfuse_version}" in
    *"${EROFS_UTILS_VERSION}"*)
        ;;
    *)
        echo "build-erofs-utils: installed erofsfuse does not report the pinned version: ${erofsfuse_version}" >&2
        exit 6
        ;;
esac
