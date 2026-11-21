#!/usr/bin/env bash
# Rust 1.96.0 official complete release: rustc/cargo/rustfmt/clippy/rust-std.
# Refs #4241. SHA256 checked against official static.rust-lang.org dist releases.
set -euo pipefail
if [[ "${1:-}" == targets && "$#" -eq 1 ]]; then printf 'linux/amd64\nlinux/arm64\n'; exit 0; fi
[[ "$#" -eq 7 && ( "$1" == prepare || "$1" == verify ) && "$2" == --platform && "$4" == --arch && "$6" == --rootfs ]] || { echo 'usage: build.sh targets | prepare|verify --platform linux --arch amd64|arm64 --rootfs ABSOLUTE_DIR' >&2; exit 2; }
mode="$1"; os="$3"; arch="$5"; rootfs="$7"
[[ "$os/$arch" == linux/amd64 || "$os/$arch" == linux/arm64 ]] || { echo "unsupported target: $os/$arch" >&2; exit 2; }
[[ "$rootfs" == /* && "$rootfs" != / && "$rootfs" != *"/../"* && "$rootfs" != */.. && "$rootfs" != *"/./"* && "$rootfs" != */. && -d "$rootfs" && ! -L "$rootfs" ]] || { echo 'unsafe rootfs' >&2; exit 2; }
version=1.96.0
case "$arch" in
  amd64) target=x86_64-unknown-linux-gnu; digest=c295047583a56238ea06b43f849f4b877fa12bfd4c7103f8d9a74c94c9c4e108 ;;
  arm64) target=aarch64-unknown-linux-gnu; digest=371eadcca97062219cbd8593628eb5d2802bc370515d085fedce1b56b2baed57 ;;
esac
if [[ "$mode" == prepare ]]; then
  [[ -z "$(find "$rootfs" -mindepth 1 -print -quit)" ]] || { echo 'rootfs must be empty' >&2; exit 2; }
  tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
  archive="rust-${version}-${target}.tar.xz"
  curl -fLSs --retry 3 --max-time 900 "https://static.rust-lang.org/dist/${archive}" -o "$tmp/rust.tar.xz"
  printf '%s  %s\n' "$digest" "$tmp/rust.tar.xz" | sha256sum --check --status || { echo 'Rust release archive digest mismatch' >&2; exit 1; }
  tar -xJf "$tmp/rust.tar.xz" -C "$tmp" --no-same-owner
  installer="$tmp/rust-${version}-${target}/install.sh"
  [[ -f "$installer" ]] || { echo 'official Rust installer missing' >&2; exit 1; }
  # Bundle contains all Rust-specific components (not an unrelated-tool bundle).
  # --disable-ldconfig prevents mutating host state when the install prefix is private.
  bash "$installer" --prefix="$rootfs" --without=rust-docs --disable-ldconfig >/dev/null
  # The native EROFS transfer forbids symlinks. Convert only resolvable links
  # entirely within this verified Rust distribution to independent copies.
  while IFS= read -r -d '' link; do
    target_path="$(readlink -f -- "$link")"
    [[ "$target_path" == "$rootfs/"* && -f "$target_path" ]] || { echo "unsafe Rust installed symlink: $link" >&2; exit 1; }
    cp -L -- "$link" "$link.nession-copy"
    rm -- "$link"
    mv -- "$link.nession-copy" "$link"
  done < <(find "$rootfs" -type l -print0)
fi
for binary in rustc cargo rustfmt cargo-clippy; do
  [[ -x "$rootfs/bin/$binary" && ! -L "$rootfs/bin/$binary" ]] || { echo "missing Rust binary: $binary" >&2; exit 1; }
done
[[ "$("$rootfs/bin/rustc" --version)" == rustc\ ${version}\ * ]] || { echo 'incorrect rustc version' >&2; exit 1; }
[[ "$("$rootfs/bin/cargo" --version)" == cargo\ ${version}\ * ]] || { echo 'incorrect cargo version' >&2; exit 1; }
"$rootfs/bin/rustfmt" --version | grep -F "$version" >/dev/null || { echo 'rustfmt version mismatch' >&2; exit 1; }
"$rootfs/bin/cargo-clippy" --version | grep -F "$version" >/dev/null || { echo 'clippy version mismatch' >&2; exit 1; }
[[ -d "$rootfs/lib/rustlib/$target/lib" ]] || { echo 'missing Rust target standard libraries' >&2; exit 1; }
[[ -z "$(find "$rootfs" -type l -print -quit)" ]] || { echo 'Rust payload contains unresolved symlink' >&2; exit 1; }
# Real offline native compiler smoke checks compiler/linker/std, not just --version.
tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
printf '%s\n' 'fn main() { println!("nession-rust"); }' > "$tmp/main.rs"
env -u RUSTUP_HOME -u RUSTUP_TOOLCHAIN "$rootfs/bin/rustc" "$tmp/main.rs" -o "$tmp/rust-smoke"
[[ "$("$tmp/rust-smoke")" == nession-rust ]] || { echo 'native Rust compilation smoke failed' >&2; exit 1; }
