# Nession Toolchain catalog

This is an **independent orphan branch** of BestNathan/nession. It is not merged to main.

Each supported distribution has exactly one recipe at `<tool>/<version>/build.sh`; a distribution may ship multiple binaries (e.g. rustc/cargo/clippy) but **never composes unrelated tools**. Composing multiple tool images belongs to Nession Images.

Each script accepts `targets` (one canonical `os/arch` per line), `prepare --platform OS --arch ARCH --rootfs ABSOLUTE_EMPTY_DIR`, and `verify --platform OS --arch ARCH --rootfs ABSOLUTE_DIR`. The script pins official source bytes and SHA256; do not use latest URLs or ambient dependencies. Its exact bytes are the release fingerprint. Adding auxiliary build inputs requires explicit re-review of the fingerprint contract.

The trusted `main` Release / Toolchains workflow handles manual and automatic discovery, builds EROFS, constructs OCI Manifest / Index, and publishes to `ghcr.io/bestnathan/nession-toolchain:<tool>-<version>`. Scripts never see package-write credentials. Consumers bind immutable OCI digests.

See [Requirement #4160](https://github.com/BestNathan/nession/issues/4160) and the main branch's `nession-toolchain-release` Skill.
