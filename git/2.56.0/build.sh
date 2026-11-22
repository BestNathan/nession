#!/usr/bin/env bash
# Git 2.56.0 official kernel.org source release, locally compiled on native runners.
# Refs #4241. Source SHA256 pinned against kernel.org Git release checksums.
set -euo pipefail
if [[ "${1:-}" == targets && "$#" -eq 1 ]]; then printf 'linux/amd64\nlinux/arm64\n'; exit 0; fi
[[ "$#" -eq 7 && ( "$1" == prepare || "$1" == verify ) && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || { echo 'usage: build.sh targets | prepare|verify --platform linux --arch amd64|arm64 --rootfs ABSOLUTE_DIR' >&2; exit 2; }
mode="$1"; os="$3"; arch="$5"; rootfs="$7"
[[ "$os/$arch" == linux/amd64 || "$os/$arch" == linux/arm64 ]] || { echo "unsupported target: $os/$arch" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && -d "$rootfs" && ! -L "$rootfs" ]] || { echo 'unsafe rootfs' >&2; exit 2; }
version=2.56.0
digest=26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3
if [[ "$mode" == prepare ]]; then
  [[ -z "$(find "$rootfs" -mindepth 1 -print -quit)" ]] || { echo 'rootfs must be empty' >&2; exit 2; }
  command -v cc >/dev/null && command -v make >/dev/null || { echo 'native C compiler and make required' >&2; exit 2; }
  command -v curl-config >/dev/null || { echo 'libcurl development headers required for Git HTTPS transport' >&2; exit 2; }
  # #4271: trusted native prepare jobs supply libcurl4-openssl-dev, zlib1g-dev
  # and libssl-dev on Ubuntu 24.04; the uncredentialed recipe never invokes sudo.
  tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
  curl -fLSs --retry 3 --max-time 300 "https://www.kernel.org/pub/software/scm/git/git-${version}.tar.xz" -o "$tmp/git.tar.xz"
  printf '%s  %s\n' "$digest" "$tmp/git.tar.xz" | sha256sum --check --status || { echo 'official Git source SHA256 mismatch' >&2; exit 1; }
  tar -xJf "$tmp/git.tar.xz" -C "$tmp" --no-same-owner
  src="$tmp/git-${version}"
  [[ -d "$src" && -f "$src/Makefile" ]] || { echo 'missing Git source Makefile' >&2; exit 1; }
  # Preserve libcurl/OpenSSL HTTP support; only omit optional UI and Perl tools.
  # Runtime prefix lets helpers resolve relative to this EROFS mount, rather
  # than hard-coding the transient CI staging path.
  # Git's default install hardlinks >100 dashed builtins to the multi-MB git
  # binary. The EROFS manifest accounts for each pathname's bytes and rejects
  # payloads beyond 2 GiB. Builtins remain callable as 'git <subcommand>';
  # do not duplicate the standalone git ELF for every dashed built-in.
  build_flags=(RUNTIME_PREFIX=YesPlease NO_RUST=YesPlease NO_TCLTK=YesPlease NO_GETTEXT=YesPlease NO_PERL=YesPlease NO_PYTHON=YesPlease INSTALL_SYMLINKS=YesPlease SKIP_DASHED_BUILT_INS=YesPlease)
  make -C "$src" -j2 "${build_flags[@]}" prefix="$rootfs" all
  make -C "$src" "${build_flags[@]}" prefix="$rootfs" install
  # The EROFS layer format accepted by the current publisher excludes links.
  # Copy only internal release links as files, never materialize host files.
  while IFS= read -r -d '' link; do
    resolved="$(readlink -f -- "$link")"
    [[ "$resolved" == "$rootfs/"* && -f "$resolved" ]] || { echo "unsafe Git installed symlink: $link" >&2; exit 1; }
    cp -L -- "$link" "$link.nession-copy"
    rm -- "$link"
    mv -- "$link.nession-copy" "$link"
  done < <(find "$rootfs" -type l -print0)
fi
# Verify the source byte bound both after prepare and after remote EROFS extraction;
# this is the same check used before Git is built into an OCI layer.
# Mirror the publisher's per-file byte accounting (including hardlinks)
# here so an oversized Git distro fails uncredentialed candidate proof,
# not the trusted GHCR uploader after a time-consuming native compile.
payload_bytes="$(find "$rootfs" -type f -printf '%s\n' | awk '{sum += $1} END {printf "%.0f",sum+0}')"
[[ "$payload_bytes" -le 2147483648 ]] || { echo "Git prepared rootfs exceeds EROFS 2GiB image source bound: $payload_bytes" >&2; exit 1; }
[[ -x "$rootfs/bin/git" ]] || { echo 'missing Git binary' >&2; exit 1; }
[[ "$("$rootfs/bin/git" --version)" == "git version ${version}" ]] || { echo 'incorrect Git version' >&2; exit 1; }
[[ -x "$rootfs/libexec/git-core/git-remote-https" ]] || { echo 'Git HTTPS transport helper absent' >&2; exit 1; }
[[ -z "$(find "$rootfs" -type l -print -quit)" ]] || { echo 'Git rootfs contains symlink' >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
"$rootfs/bin/git" init -q "$tmp/repo"
"$rootfs/bin/git" -C "$tmp/repo" -c user.name=nession -c user.email=ci@example.invalid commit --allow-empty -qm init
[[ "$("$rootfs/bin/git" -C "$tmp/repo" rev-list --count HEAD)" == 1 ]] || { echo 'Git repository smoke failed' >&2; exit 1; }
