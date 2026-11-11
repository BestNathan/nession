#!/usr/bin/env bash
# Build the pinned EROFS helper binaries carried by the Server and Agent
# runtime images (#3178).
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
set -euo pipefail

EROFS_UTILS_VERSION='1.9.4'
EROFS_UTILS_SHA256='7d135aa2550326a5acf20f53c518aea5a8900015ce50700044e40f818c31dd80'
EROFS_UTILS_URL="https://git.kernel.org/pub/scm/linux/kernel/git/xiang/erofs-utils.git/snapshot/erofs-utils-${EROFS_UTILS_VERSION}.tar.gz"

for tool in curl sha256sum tar make gcc autoconf autoheader aclocal automake libtoolize pkg-config; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "build-erofs-utils: required build tool is missing: ${tool}" >&2
        exit 2
    fi
done

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

curl -fsSL "${EROFS_UTILS_URL}" -o "${work}/erofs-utils.tar.gz"
echo "${EROFS_UTILS_SHA256}  ${work}/erofs-utils.tar.gz" | sha256sum -c -
tar -xzf "${work}/erofs-utils.tar.gz" -C "${work}"

cd "${work}/erofs-utils-${EROFS_UTILS_VERSION}"
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
