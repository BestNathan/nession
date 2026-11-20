---
title: "Nession native Toolchain OCI release to GHCR"
description: "Verified version-pinned Shell Recipe directory preparation, Nession EROFS-backed OCI packaging, isolated GHCR publishing and independent readback"
topic: workflows
categories: ["architecture","ci","erofs","release","security","toolchain","workflows"]
status: verified
created_at: 2026-11-20T01:08:30Z
updated_at: 2026-11-20T01:08:30Z
sources: ["https://github.com/BestNathan/nession/blob/06ff007d55092878d27e2606a29abcac6c8cb70b/scripts/toolchains/README.md","https://github.com/BestNathan/nession/blob/06ff007d55092878d27e2606a29abcac6c8cb70b/.github/workflows/release-toolchains.yml","https://github.com/BestNathan/nession/blob/06ff007d55092878d27e2606a29abcac6c8cb70b/scripts/toolchains/prepare.sh","https://github.com/BestNathan/nession/blob/06ff007d55092878d27e2606a29abcac6c8cb70b/scripts/toolchains/oci-publish.rs","https://github.com/BestNathan/nession/issues/4092","https://github.com/BestNathan/nession/pull/4094","https://github.com/BestNathan/nession/issues/4113"]
---

# Nession native Toolchain OCI release to GHCR

## Decision

**Toolchain Release is a Release/Delivery workflow over a prepared directory, not a declarative Recipe format or a second image system.** Each reviewed shell recipe accepts `prepare VERSION PLATFORM ROOTFS` and installs pinned, checksum-verified tool binaries (or a bundled set of binaries) into one private, initially empty directory. The common workflow passes that directory to **existing** `nession-erofs`, which builds an EROFS filesystem layer and OCI Config/Manifest objects in CAS and pushes them through the existing OCI Distribution Registry client to GHCR.

This is the completed #4092 design; the implementation is [PR #4094](https://github.com/BestNathan/nession/pull/4094), merged to `main` at `06ff007d55092878d27e2606a29abcac6c8cb70b`. The task-level operating guide is the [Toolchain Release Skill](https://github.com/BestNathan/nession/blob/main/.claude/skills/nession-toolchain-release/SKILL.md) and the executable reference is the [toolchain script README](https://github.com/BestNathan/nession/blob/06ff007d55092878d27e2606a29abcac6c8cb70b/scripts/toolchains/README.md). A Skill and this article are references, **not** executable policy owners.

## Responsibilities and implementation contract

- **Recipe Shell scripts**, `scripts/toolchains/recipes/`: one allowlisted, reviewed, version-specific preparation implementation per tool or bundle. `scripts/toolchains/prepare.sh` selects only supported tool/version/platform combinations, supplies an absolute empty `ROOTFS`, then checks paths, executable modes and unsupported entries. Fixed source URLs and SHA256 checksums are kept in the scripts, not a new `recipe.yaml`, `versions.yaml`, parser, database or Rust Recipe type. Bundles invoke component recipes to populate the *same* root directory.
- **Release / Toolchains**, `.github/workflows/release-toolchains.yml`: a read-only PR verification job; trusted-main `prepare` with `contents: read` and no GHCR write authority; a checksum-verified transport artifact; then a `publish` job with `packages: write`; finally an independent `readback` with `packages: read`. The intermediate `.tar` is **only an Actions artifact to preserve file modes**, not an OCI Archive or an EROFS input format.
- **`nession-erofs`**, through the narrow `scripts/toolchains/cargo.sh` / `oci-publish.rs` bridge: `ErofsBuilder::build_local(ROOTFS)` → raw EROFS layer → standard OCI Config/Manifest graph → CAS → `registry::push_image`. OCI Manifest digest identifies the immutable Image revision; an EROFS layer digest identifies the filesystem bytes. Do not substitute Dockerfile, Docker tar layer, manual Registry API or independent OCI JSON implementation.
- **GHCR registry** stores and serves the OCI objects by digest. The exact-version/revision tag `ghcr.io/bestnathan/nession-toolchain-<tool>:<version>-r<revision>` is an alias: an identical-digest retry is valid, a different-digest rewrite is refused and requires a revision bump. Consumers should pin Manifest digest.
- **Server Images/Sandbox** remain responsible for image access, caching, mounts and runtime PATH/ENV; releasing the binaries does not confer Kubernetes/cloud/Docker privileges, nor include kubeconfig, cloud tokens or a Docker socket.

## Real-world evidence

[Release / Toolchains GitHub Actions run #44586296125, attempt 1](https://github.com/BestNathan/nession/actions/runs/44586296125) completed **successfully** on `main` at `06ff007d55092878d27e2606a29abcac6c8cb70b`. Its jobs proved the separation: `prepare` produced a real jq 1.8.1 binary with pinned checksum, `publish` uploaded two blobs and one Manifest with native Nession OCI Registry Push and verified the remote content, and the independent `readback` downloaded the tagged OCI/EROFS image, extracted its tool and executed the expected version probe.

- Exact published tag: `ghcr.io/bestnathan/nession-toolchain-jq:1.8.1-r1`.
- OCI Manifest digest: `sha256:8edf29ce84b0e144ee6288ca92ef76bb507e968cb705484bc96f5a4f93635e59`.
- Config digest: `sha256:d14e3810398025ca13428480e6884fff58646b8d8670b7151964f4bf398c1d40`.
- EROFS layer digest: `sha256:716824762ea985fb218800b2382b5ed38df8d083e795db142b7106d828922696`.
- The PR [local Recipe verification run #44585147796](https://github.com/BestNathan/nession/actions/runs/44585147796) built and extracted distinct images for jq 1.7.1, jq 1.8.1 and the jq+kubectl bundle from one rootfs; kubectl 1.35.0 source/version checks passed. This does **not** imply that every recipe version was separately published to GHCR.

## Related knowledge

- [Nession GitHub Actions workflow domains and trust boundaries](nession-github-actions-workflow-domains-and-trust-boundaries.md) — why the Release workflow remains a thin orchestrator with separated write/read privileges.
- [Global EROFS Image Manager](../engineering/global-erofs-image-manager.md) — immutable image ownership, digest/catalog and the separate consumption boundary.
- [Nession CI, E2E and acceptance qualification timing](nession-ci-e2e-and-acceptance-qualification-timing.md) — local PR proof versus trusted main publication evidence.

## Limits / revisit triggers

V1 is **Linux AMD64 only**, and new versions/tools require a reviewed script, pinned upstream checksum and a matching executable/version probe. ARM64/OCI Index, automated upstream discovery, arbitrary user recipes and a declarative Recipe DSL are *not* delivered. OCI Registry acceptance of an EROFS media type does not mean Docker Engine can execute that layer directly. Revise this article after a verified change to the script contract, GHCR tag policy, architecture support, source trust boundary or Registry readback—not merely because a new tool binary was added.
