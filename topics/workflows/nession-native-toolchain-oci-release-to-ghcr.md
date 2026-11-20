---
title: "Nession native Toolchain OCI release to GHCR"
description: "Verified single-tool orphan build.sh catalog, SHA256 fingerprint-gated automatic release, native EROFS OCI Index and unified GHCR readback"
topic: workflows
categories: ["architecture","ci","erofs","release","security","toolchain","workflows"]
status: verified
created_at: 2026-11-20T01:08:30Z
updated_at: 2026-11-20T10:58:49Z
sources: ["https://github.com/BestNathan/nession/blob/e1f4b9a39cf7c67499a647bde08af9082b2a9f56/scripts/toolchains/README.md","https://github.com/BestNathan/nession/blob/e1f4b9a39cf7c67499a647bde08af9082b2a9f56/.github/workflows/release-toolchains.yml","https://github.com/BestNathan/nession/blob/e1f4b9a39cf7c67499a647bde08af9082b2a9f56/scripts/toolchains/oci-publish-v2.rs","https://github.com/BestNathan/nession/blob/e1f4b9a39cf7c67499a647bde08af9082b2a9f56/.claude/skills/nession-toolchain-release/SKILL.md","https://github.com/BestNathan/nession/issues/4160","https://github.com/BestNathan/nession/pull/4163","https://github.com/BestNathan/nession/pull/4164","https://github.com/BestNathan/nession/pull/4165","https://github.com/BestNathan/nession/issues/4092","https://github.com/BestNathan/nession/issues/4147"]
---

# Nession native Toolchain OCI release to GHCR

## Current decision: one versioned tool distribution, one shared OCI registry

**The canonical Toolchain catalog lives in the independent `toolchains` orphan branch** of [BestNathan/nession](https://github.com/BestNathan/nession/tree/toolchains), not in the main branch's historical `scripts/toolchains/recipes/`. Each reviewed `<tool>/<version>/build.sh` is a self-contained, pinned release for a single upstream tool distribution. A distribution may ship several executables (Rust includes rustc, cargo, clippy and rustfmt), but **there is no Bundle/dependencies graph** for unrelated tools; jq and kubectl must be composed, if needed, by separate Nession Images/consumer capabilities.

The shell protocol contains `targets` (newline-separated `os/arch`), `prepare --platform OS --arch ARCH --rootfs ABSOLUTE_EMPTY_DIR`, and `verify --platform OS --arch ARCH --rootfs DIR`. The script itself pins the source version, immutable upstream URL/checksum and all prepared files. **Build fingerprint = SHA256 of exact `build.sh` bytes**, keyed by tool/version and checked against already published platform-specific OCI metadata. Readme-only orphan changes do not rebuild valid existing releases. Scripts do not receive GHCR write credentials. No separate Recipe DSL/schema, packaging revision, `latest` resolver or tool-specific Rust allowlist is used.

All versions share **one GHCR repository**: `ghcr.io/bestnathan/nession-toolchain:<tool>-<version>`, such as `gh-2.105.0`. An intentionally reviewed repackage can move that version Tag, but **consumers must pin immutable OCI Index/Manifest digest**, and old digests/Run receipts remain historical evidence. Default release includes every declared native platform, producing an OCI Index even for single-platform tools. A partial target selection cannot replace a complete public version tag.

## Execution and trust boundaries

The `main`-owned [Release / Toolchains](https://github.com/BestNathan/nession/blob/e1f4b9a39cf7c67499a647bde08af9082b2a9f56/.github/workflows/release-toolchains.yml) receives manual `workflow_dispatch` or the branch-local unprivileged `Toolchains / Catalog Change` push signal via a source-verified `workflow_run`. It discovers version directories and compares their script fingerprint to actual GHCR roots; a missing/changed/incomplete release schedules preparation. Git source commit and source recipe digest are pinned through the pipeline, and the publisher refuses superseded orphan heads.

The jobs are isolated: read-only planner and fingerprint probe; uncredentialed native AMD64/ARM64 preparation and tool version checks; SHA256-protected artifact transfer; trusted main-only `packages:write` publisher that **does not execute catalog scripts**; independent `packages:read` OCI Index/Manifest/Config/raw EROFS layer readback; finally an uncredentialed native extracted version probe. Nession's existing `nession-erofs` provides `ErofsBuilder`, OCI Image Config/Manifest/Index, CAS, and `registry::push_image`—there is **no separate image format, Docker tar layer, or second Registry protocol**. Server Images and Sandbox remain owners of caching, mount, PATH and credentials at consumption time.

## Authenticated release and fingerprint reuse evidence

The first authorized orphan push signal, [Run 44721545621](https://github.com/BestNathan/nession/actions/runs/44721545621), led to the trusted main [Release / Toolchains Run 44721571308 (attempt 1)](https://github.com/BestNathan/nession/actions/runs/44721571308) at `b9e9886714ad1f4f78ec87897c30ccb6c9c84c64`. All **29 jobs completed successfully**, including actual GHCR native Index publishing, independent readback and real executable verification:

| Tool/version tag | Supported native targets | Published immutable OCI Index digest |
| --- | --- | --- |
| `gh-2.105.0` | linux/amd64, linux/arm64 | `sha256:2bd0fe388655d48fd514431095bc52bfb1d319fedc4fd183feb5949e4fb73587` |
| `jq-1.8.1` | linux/amd64, linux/arm64 | `sha256:8cb5abadfafe287b41700c0624fa93241dbc0e77373894d1875d32f6059dd7df` |
| `jq-1.7.1` | linux/amd64 | `sha256:87d7f39a64ac5864515d312d8175fdc851940335ae46ab899c8a722c3e1d01a7` |
| `kubectl-1.35.0` | linux/amd64 | `sha256:704c2e6c12f6b404ae76977757272d9bed3473b4e4b95daeedef28822f0ad650` |

A subsequent orphan **README-only** signal [Run 44723056499](https://github.com/BestNathan/nession/actions/runs/44723056499) led to [Release Run 44723079703](https://github.com/BestNathan/nession/actions/runs/44723079703), completed **successfully**. Every tool/version fingerprint probe matched the already published verified Index, so all `prepare/publish/readback/verify` jobs were skipped. No tool-specific build script bytes changed. Thus both real missing-image publication and content-identical reuse were exercised.

## Historical contract and retained evidence

This article originally documented **#4092 / PR #4094** at main `06ff007d55092878d27e2606a29abcac6c8cb70b`. The [historical main release Run 44586296125](https://github.com/BestNathan/nession/actions/runs/44586296125) proved a single Linux/amd64 jq 1.8.1 EROFS OCI Manifest under `ghcr.io/bestnathan/nession-toolchain-jq:1.8.1-r1` with exact Manifest `sha256:8edf29ce84b0e144ee6288ca92ef76bb507e968cb705484bc96f5a4f93635e59`. The old recipe allowlist, version-plus-`-rN` tag and cross-tool `k8s-bundle` are **superseded**, not erased. **#4147 / merged PR #4148** delivered the source-pinned gh 2.105.0 amd64 recipe and native local tests; its actual canonical GHCR publication and cross-arch readback are now proven by the #4160 run above. Do not fabricate an old per-tool Registry receipt or rewrite historical Acceptance results.

The canonical current code/Skill remains authoritative over this sourced Knowledge article. Its protected publication must follow the Knowledge Publisher and Pages evidence contract, not generic direct writes to the orphan `knowledge` branch.

## Related knowledge

- [Nession GitHub Actions workflow domains and trust boundaries](nession-github-actions-workflow-domains-and-trust-boundaries.md) — why release coordination and Registry write authority stay isolated.
- [Global EROFS Image Manager](../engineering/global-erofs-image-manager.md) — immutable image identities, platform-aware distribution and consumer ownership.
- [Nession CI, E2E and acceptance qualification timing](nession-ci-e2e-and-acceptance-qualification-timing.md) — exact-SHA CI evidence versus actual trusted remote publication.

## Limits and revisit triggers

The verified Release targets are Linux/amd64 for all four versions, plus Linux/arm64 for gh 2.105.0 and jq 1.8.1 only. No macOS EROFS consumer or dynamic upstream version resolver has been proven. A GHCR Registry accepting raw EROFS OCI media types does not imply Docker Engine can execute the layers. The minimal script-only fingerprint assumes no additional undeclared build inputs; evolving the script protocol or environment identity needs an explicit new decision. GitHub branch protection and third-party source trust must remain reviewed supply-chain boundaries.
