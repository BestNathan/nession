---
name: nession-toolchain-release
description: Use when adding or changing version-pinned toolchain/bundle shell recipes, packaging their prepared directories as native EROFS-backed OCI images, publishing them to GHCR or diagnosing Release / Toolchains and its readback.
---

# Nession Toolchain Release

This Skill is a **task playbook**, not another Recipe schema, Registry implementation or packaging owner. The released contract was delivered by [#4092](https://github.com/BestNathan/nession/issues/4092), [PR #4094](https://github.com/BestNathan/nession/pull/4094) and a successful [native GHCR publish/readback run](https://github.com/BestNathan/nession/actions/runs/44586296125). Read the [toolchain script README](../../../scripts/toolchains/README.md) and the [real Release workflow](../../../.github/workflows/release-toolchains.yml) first; their current executable contracts outrank this summary.

Load [nession-cicd](../nession-cicd/SKILL.md) for release permissions/PR policy, [nession-workflows](../nession-workflows/SKILL.md) for Actions taxonomy, [nession-development](../nession-development/SKILL.md) for Issue-first worktrees/PRs, and [nession-knowledge](../nession-knowledge/SKILL.md) when recording a changed durable decision. Follow `scripts/AGENTS.md` and `.github/AGENTS.md` for files in those trees. The curated [Toolchain OCI release knowledge](https://github.com/BestNathan/nession/blob/knowledge/topics/workflows/nession-native-toolchain-oci-release-to-ghcr.md) explains the rationale, evidence and scope; it is not an executable source.

## Ownership and invariants

1. **Reviewed Shell Recipes own input acquisition and directory preparation only.** The sole recipe contract is `bash scripts/toolchains/recipes/<tool>.sh prepare VERSION PLATFORM ROOTFS`, called through the allowlisted `scripts/toolchains/prepare.sh`. The rootfs is a *private absolute empty directory*; all payload files live inside it (e.g. `bin/`, `lib/`, `share/`). Recipes pin supported versions, approved source URLs and SHA256, safely install and verify executables, and reject unsupported platform/version or unsafe filesystem content. A bundle pins component versions and places all tools in **one** rootfs.
2. **The Workflow is the coordinator.** `Release / Toolchains` selects a reviewed tool/version/revision, runs uncredentialed prepare and transfers a checksum-verified artifact to the publisher. The transport-only tar preserves Unix modes between Actions jobs; **it is not** an OCI Archive, layer encoding or user-visible image artifact.
3. **`nession-erofs` alone owns image and transport.** The thin `scripts/toolchains/cargo.sh` / `oci-publish.rs` adapter invokes the existing `ErofsBuilder::build_local(rootfs)`, creates EROFS layer + OCI Config/Manifest in CAS and publishes via the existing `registry::push_image()` OCI Distribution client. Do not duplicate the OCI model, implement a second Registry Push, introduce Docker Build/tar layers, or require OCI Layout export.
4. **Registry authority is isolated.** PR tests and preparation run with `contents: read`, without `packages: write`; only trusted-main `publish` has `packages: write`. `readback` is an independent `packages: read` job pinned to the pushed Manifest digest. Never execute untrusted `pull_request_target` shell input with release credentials or inject kubeconfig, Docker socket, cloud secrets or developer HOME into images.
5. **Immutable identity is the Manifest digest**, not the tag or layer digest. Exact release refs follow `ghcr.io/bestnathan/nession-toolchain-<tool>:<version>-r<revision>`. Identical-digest retries are allowed; a different digest under an existing exact-version/revision tag is rejected and requires a packaging revision bump. Avoid mutable `latest` aliases. Consumers pin the digest and own mount/PATH mapping in Images/Sandbox.

## Add a tool or version

- **First** inspect the live scope-matching Requirement and `main`; make a separate Issue-first branch/worktree. Check existing recipes, versions, the target architecture/ABI and whether the intended file-tree is a single tool or a bundle.
- Add/update `scripts/toolchains/recipes/<tool>.sh`. Keep source SHA256 per pinned version in the reviewed script; validate the downloaded executable with its real version command. A new tool must also be allowlisted by `scripts/toolchains/prepare.sh`, supported in `scripts/toolchains/oci-publish.rs`'s version probe, and included in the workflow's bounded choice options. Adding **another version of an existing tool** should not clone the Workflow.
- For a bundle, reuse the checked-in component recipes to populate the **same** rootfs, detect filename conflicts and verify every component's exact version. Never include ambient runtime credentials, caches or files from the host outside the prepared tree.
- Preserve the `linux/amd64` V1 boundary until native arm64 builds and OCI Index handling are separately proven. Do not silently label an amd64 binary for another platform or assume Docker Engine supports raw EROFS OCI layers.

## Verification and release

On a compatible Linux runner with `mkfs.erofs` and `fsck.erofs`:

```sh
bash scripts/toolchains/self-test.sh
```

This tests rejected selectors/paths, multiple pinned versions, same-rootfs bundle preparation, native EROFS/OCI build, extraction and executable/version validation. For an individual locally prepared directory:

```sh
ROOTFS="$(mktemp -d)"
bash scripts/toolchains/prepare.sh prepare jq 1.8.1 linux/amd64 "$ROOTFS"
TOOLCHAIN_TOOL=jq TOOLCHAIN_VERSION=1.8.1 TOOLCHAIN_PLATFORM=linux/amd64 \
TOOLCHAIN_REVISION=1 TOOLCHAIN_ROOTFS="$ROOTFS" \
  bash scripts/toolchains/cargo.sh local
```

Before an authorized publish, check the exact recipe source, supported version and `-rN` packaging revision. Use the single existing [Release / Toolchains](../../../.github/workflows/release-toolchains.yml) workflow on trusted `main`; do not manually push Nession Docker images. Verify its **prepare → publish → readback** job results and read the GHCR tag's remote Manifest, Config and EROFS layer by digest; the readback job must extract and execute the expected version(s). Record run ID/attempt, exact Git SHA, tag, Manifest/Layer digests and any upload/reuse counters. A green PR test is not proof of GHCR publication.

## Troubleshooting and escalation

- **Source SHA/version mismatch:** correct the reviewed script's exact source/version pair, never disable checksum verification.
- **EROFS/OCI build, extraction or file-mode mismatch:** inspect the `nession-erofs` call and prepared rootfs; do not add a second packer.
- **GHCR 401/403, rejected media type or digest mismatch:** diagnose the isolated Registry permission/transport boundary; do not downgrade the EROFS layer to pretend to be Docker tar.
- **Tag collision with another digest:** increase packaging revision and retain the old immutable release.
- **Images/Sandbox mount/PATH/runtime selection:** that belongs to consumers, not to Release Recipes. See [OCI/EROFS image infrastructure](../../../docs/architecture/oci-erofs-image-infrastructure.md).

The checked-in scripts/Workflow and authenticated GitHub Run observations always decide what actually shipped. Update the [Knowledge article](https://github.com/BestNathan/nession/blob/knowledge/topics/workflows/nession-native-toolchain-oci-release-to-ghcr.md) through the protected Knowledge Publisher only when the underlying durable contract changes.
