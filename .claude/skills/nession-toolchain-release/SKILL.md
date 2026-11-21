---
name: nession-toolchain-release
description: Use for the single-tool orphan catalog, version-pinned build.sh preparation and fingerprinted EROFS OCI Index release/readback to the unified GHCR repository.
---

# Nession Toolchain Release

**Read current executable owners first:** [scripts/toolchains/README.md](../../../scripts/toolchains/README.md), [Release / Toolchains](../../../.github/workflows/release-toolchains.yml), [Reusable single-tool release](../../../.github/workflows/release-toolchain-one.yml), `scripts/toolchains/catalog-plan.mjs` and the existing `crates/nession-erofs`. [Issue #4160](https://github.com/BestNathan/nession/issues/4160) is the canonical migration contract; [#4092](https://github.com/BestNathan/nession/issues/4092) and [#4147](https://github.com/BestNathan/nession/issues/4147) preserve legacy proof.

Load `nession-development` for Issue-first worktrees/PRs, `nession-workflows` and `nession-cicd` for GitHub Actions ownership and Registry permission boundary, `nession-gates` for tests, and `nession-knowledge` for the protected Knowledge update. Follow scoped `.github/AGENTS.md` and `scripts/AGENTS.md`.

## One owner per responsibility

1. **Catalog:** the **independent `toolchains` orphan branch** owns `<tool>/<version>/build.sh`. Each script implements `targets`, `prepare --platform OS --arch ARCH --rootfs ABSOLUTE_EMPTY_DIR` and `verify --platform OS --arch ARCH --rootfs DIR`. The script pins the upstream exact version and source SHA256. One tool distribution may ship many binaries, but there are no `bundle` recipes, no cross-tool `dependencies` and no Recipe schema.
2. **Release selector:** trusted main-owned `catalog-plan.mjs` discovers tool/version paths. Versioned script SHA256 is the **only V1 build fingerprint**; tool/version/target are keys. Invalid selectors, duplicate/unsupported targets, special files, symlink escapes, missing files and unsupported environments fail closed.
3. **Trigger:** `workflow_dispatch` for manual exact tool/version/optional platform+arch, or unprivileged `Toolchains / Catalog Change` push signal from orphan branch consumed by the **main** `workflow_run` gate. All auto candidates are probed by fingerprint against actual GHCR OCI contents. The toolchain script never selects GitHub ref or executable Registry path.
4. **Prepare/probe boundary:** recipe scripts run only without GHCR write credentials. The approved target matrix is checked on native runners; staged rootfs transport is checksum verified and bound to source SHA/fingerprint. A partial/manual single-platform build cannot replace a complete public multi-platform tag.
5. **OCI and Registry:** `nession-erofs` owns Build → raw EROFS Layer → OCI Config/Manifest/Index → CAS → `registry::push_image`. Only trusted main publisher receives `packages:write` and **never runs catalog scripts**. The readback job uses `packages:read` and verifies Index/Manifest/Config/EROFS; a separate uncredentialed native job runs each extracted version probe.
6. **Release identity:** one package, `ghcr.io/bestnathan/nession-toolchain:<tool>-<version>`. No `-rN` or `latest`. A reviewed update may move a version tag to a new digest; existing consumer bindings must remain on immutable OCI digests. Fail stale source, unauthorized push, mismatched target closure or incomplete remote object rather than silently publishing partial or mislabeled platforms.

## Add or update a tool version

- Inspect current `toolchains` branch and live #4160/child Issue; create a reviewed PR to **the orphan branch**, not to `main`. Copy only the shell protocol, pin source URLs and SHA256, make script self-contained. Version comes from its path. For example, Rust `rust/1.96.0/build.sh` may contain rustc/cargo/clippy/rustfmt as the one upstream distribution; jq+kubectl is never a recipe.
- Test `targets`, native `prepare`, `verify`, invalid path/platform/version, source digest mismatch, missing runtime closure and source SHA fingerprint; verify that no host credentials/config enter ROOTFS.
- Merge after review. The branch-local push signal requests a trusted main release; do not grant package-write permission to its job. For a manual recovery use `Release / Toolchains` dispatch with exact tool/version and the default complete target matrix.
- Check remote GHCR tag, immutable Index digest, every platform-specific child Manifest/Config/raw EROFS layer and independent extracted version probes. Record catalog SHA, script fingerprint, build Run/Attempt, pre/post tag digest and upload/reuse outcomes. No mere CI green or model assertion is evidence of a real GHCR publish.

## Troubleshooting

- Wrong source/version/SHA256: fix the version's reviewed script and re-run, never disable digest check.
- Source SHA superseded: restart using latest approved orphan commit, never allow delayed publisher to overwrite a newer Tag.
- Index incomplete or architecture mislabeled: fail; prove native binary on actual target runner, never claim multi-platform from host arch alone.
- Registry failure, media-type refusal, remote digest mismatch: repair `nession-erofs`/Registry owner or permissions; don't add Docker tar layers or another OCI client.
- Tool composition/mount/PATH: defer to Images/Sandbox consumer, not Toolchain Release.

Current [curated Knowledge article](https://github.com/BestNathan/nession/blob/knowledge/topics/workflows/nession-native-toolchain-oci-release-to-ghcr.md) is verified against protected publication `b74b8457cfc0232fa2bc982f813a3e59f8cf60bb` and anonymous Pages readback Run `44723952582`. Canonical GHCR release Run `44721571308` and identical-fingerprint skip Run `44723079703` are the source-bound producer receipts. After future changes, update that article through the owner-authenticated Knowledge Publisher, never by direct writes to the protected orphan branch.
