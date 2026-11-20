# Toolchain directory preparation and OCI publishing (#4092)

For execution guidance use the [nession-toolchain-release Skill](../../.claude/skills/nession-toolchain-release/SKILL.md); for the source-grounded decision and authenticated GHCR release proof use [Nession native Toolchain OCI release to GHCR](https://github.com/BestNathan/nession/blob/knowledge/topics/workflows/nession-native-toolchain-oci-release-to-ghcr.md). The checked-in recipes, [Release Workflow](../../.github/workflows/release-toolchains.yml) and Nession EROFS library remain authoritative.

This workflow has **no declarative Recipe model**. A reviewed shell script implements the only tool-specific contract:

```sh
bash scripts/toolchains/prepare.sh prepare jq 1.8.1 linux/amd64 "$ROOTFS"
```

`ROOTFS` must be a private absolute empty directory. The selected allowlisted recipe is invoked as `bash recipes/<tool>.sh prepare VERSION PLATFORM ROOTFS`. Recipes obtain exact pinned binary sources, verify their SHA256, copy **all** required files into ROOTFS and run their version checks. They cannot accept arbitrary download URLs, shell commands or filesystem destinations from workflow_dispatch.

Today: jq 1.7.1/1.8.1, kubectl 1.35.0, gh 2.105.0 (the official GitHub CLI), and bundle 2026.11 (jq 1.8.1 + kubectl 1.35.0 installed into the **same directory**); linux/amd64 only. The gh recipe installs only the pinned executable from the upstream SHA256-verified release archive; authentication/Session ENV is supplied by consumers, not baked into the image. Add versions and future tools in reviewed scripts; do not duplicate a GitHub Actions workflow for each version. Bundles pin their component versions.

The common `release-toolchains.yml` workflow:
1. A read-only, uncredentialed prepare job generates ROOTFS and checks the binaries. It stores the prepared file tree in an ephemeral tar **solely to retain Unix modes across GitHub Actions artifacts**. This is **not** an OCI Archive or an OCI image format.
2. A trusted-main publish job verifies the transferred bytes and calls `scripts/toolchains/cargo.sh publish` (thin reusable Rust adapter), which uses existing nession-erofs Build -> OCI Config/Manifest -> CAS -> native Registry Push. It does not rerun recipe scripts. Only this job has `packages: write`.
3. A separate `packages: read` job pulls the exact Manifest digest from GHCR, downloads the original EROFS bytes, extracts them and executes CLI version checks (without a write token).
4. PRs run the negative fixtures and native EROFS local build/extract via `self-test.sh`, with no GHCR publishing permission.

Tags are `ghcr.io/bestnathan/nession-toolchain-<tool>:<version>-r<revision>`; old versions are preserved, a different digest under an existing tag is an error, and consumers must pin the immutable Manifest digest. Revisions are explicitly selected; avoid `latest` aliases. This does not change Nession's EROFS format, OCI Registry, Server Images, Sandbox mounts or credential injection rules.

For adding a new version, update the recipe's version case to include the exact source URL/checksum, verify executable/runtime dependency closure and increment packaging revision if the output for a previously published version changes. The fixed version checks and checksums are not fetched from an unpinned upstream "stable" endpoint.

CI recipe tests: `bash scripts/toolchains/self-test.sh`. OCI adapter: `TOOLCHAIN_TOOL=jq TOOLCHAIN_VERSION=1.8.1 TOOLCHAIN_PLATFORM=linux/amd64 TOOLCHAIN_REVISION=1 TOOLCHAIN_ROOTFS=/tmp/private-rootfs bash scripts/toolchains/cargo.sh local`.

Runtime PATH/mount mapping is controlled by the existing Sandbox/Images consumers, not these scripts. Never package cloud credentials, kubeconfig, Docker socket or developer HOME.
