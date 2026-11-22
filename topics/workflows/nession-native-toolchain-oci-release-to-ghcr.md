---
title: "Nession native Toolchain OCI release to GHCR"
description: "Verified single-tool orphan build.sh catalog, SHA256 fingerprint-gated automatic release, native EROFS OCI Index and unified GHCR readback"
topic: workflows
categories: ["architecture","ci","erofs","release","security","toolchain","workflows"]
status: verified
created_at: 2026-11-20T01:08:30Z
updated_at: 2026-11-22T15:48:07Z
sources: ["https://github.com/BestNathan/nession/blob/e1f4b9a39cf7c67499a647bde08af9082b2a9f56/scripts/toolchains/README.md","https://github.com/BestNathan/nession/blob/e1f4b9a39cf7c67499a647bde08af9082b2a9f56/.github/workflows/release-toolchains.yml","https://github.com/BestNathan/nession/blob/e1f4b9a39cf7c67499a647bde08af9082b2a9f56/scripts/toolchains/oci-publish-v2.rs","https://github.com/BestNathan/nession/blob/e1f4b9a39cf7c67499a647bde08af9082b2a9f56/.claude/skills/nession-toolchain-release/SKILL.md","https://github.com/BestNathan/nession/issues/4160","https://github.com/BestNathan/nession/pull/4163","https://github.com/BestNathan/nession/pull/4164","https://github.com/BestNathan/nession/pull/4165","https://github.com/BestNathan/nession/issues/4092","https://github.com/BestNathan/nession/issues/4147","https://github.com/BestNathan/nession/blob/a00a55f8fb4213ba577472c825bc3daa9cab64f3/scripts/toolchains/catalog-plan.mjs","https://github.com/BestNathan/nession/blob/894e05314a11ef4e3ef0c753caf00c8cc75b0b7d/.github/workflows/release-toolchains.yml","https://github.com/BestNathan/nession/blob/dcd98846c7daead0ccbce664cfd23373f2fa30fa/jq/1.8.1/build.sh","https://github.com/BestNathan/nession/pull/4190","https://github.com/BestNathan/nession/issues/4241","https://github.com/BestNathan/nession/blob/ff00fbd6b504ca2953293dce9ea4097fce9a3452/scripts/toolchains/oci-publish-v2.rs","https://github.com/BestNathan/nession/blob/fbe9c8daa0a40f41b69659068cefed9c75478f22/ansible/2.22.0/build.sh"]
---

# Nession native Toolchain OCI release to GHCR

## Current decision: one versioned tool distribution, one shared OCI registry

**The canonical Toolchain catalog lives in the independent `toolchains` orphan branch** of [BestNathan/nession](https://github.com/BestNathan/nession/tree/toolchains), not in the main branch's historical `scripts/toolchains/recipes/`. Each reviewed `<tool>/<version>/build.sh` is a self-contained, pinned release for a single upstream tool distribution. A distribution may ship several executables (Rust includes rustc, cargo, clippy and rustfmt), but **there is no Bundle/dependencies graph** for unrelated tools; jq and kubectl must be composed, if needed, by separate Nession Images/consumer capabilities.

The shell protocol contains `targets` (newline-separated `os/arch`), `prepare --platform OS --arch ARCH --rootfs ABSOLUTE_EMPTY_DIR`, and `verify --platform OS --arch ARCH --rootfs DIR`. The script itself pins the source version, immutable upstream URL/checksum and all prepared files. **Build fingerprint = SHA256 of exact `build.sh` bytes**, keyed by tool/version and checked against already published platform-specific OCI metadata. Readme-only orphan changes do not rebuild valid existing releases. Scripts do not receive GHCR write credentials. No separate Recipe DSL/schema, packaging revision, `latest` resolver or tool-specific Rust allowlist is used.

All versions share **one GHCR repository**: `ghcr.io/bestnathan/nession-toolchain:<tool>-<version>`, such as `gh-2.105.0`. An intentionally reviewed repackage can move that version Tag, but **consumers must pin immutable OCI Index/Manifest digest**, and old digests/Run receipts remain historical evidence. Default release includes every declared native platform, producing an OCI Index even for single-platform tools. A partial target selection cannot replace a complete public version tag.

## Execution and trust boundaries

The `main`-owned [Release / Toolchains](https://github.com/BestNathan/nession/blob/e1f4b9a39cf7c67499a647bde08af9082b2a9f56/.github/workflows/release-toolchains.yml) receives manual `workflow_dispatch` or the branch-local unprivileged `Toolchains / Catalog Change` push signal via a source-verified `workflow_run`. It selects only added/modified/restored `<tool>/<version>/build.sh` from the exact orphan source commit's **first-parent Git diff**, including reviewed two-parent Merge Commits; README-only pushes schedule no version, and manual dispatch selects an explicit tool/version. Every selected version is independently fingerprint-probed against actual GHCR roots; a missing/changed/incomplete release schedules preparation. Git source commit and source recipe digest are pinned through the pipeline, and the publisher refuses superseded orphan heads.

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

## Verified changed-only update of jq 1.8.1 (current published version tag)

The main-owned scanner and shallow-history fail-closed checks landed through [PR #4180](https://github.com/BestNathan/nession/pull/4180) (merge `a00a55f8fb4213ba577472c825bc3daa9cab64f3`), and the trusted Workflow's changed-script routing through [PR #4181](https://github.com/BestNathan/nession/pull/4181) (merge `894e05314a11ef4e3ef0c753caf00c8cc75b0b7d`). One-file [orphan PR #4190](https://github.com/BestNathan/nession/pull/4190) merged with two parents into catalog SHA `dcd98846c7daead0ccbce664cfd23373f2fa30fa`; **only `jq/1.8.1/build.sh` changed**, adding post-extraction official binary SHA256 verification.

The [unprivileged Catalog Change signal Run 44864351292](https://github.com/BestNathan/nession/actions/runs/44864351292) succeeded; trusted [Release / Toolchains Run 44864365276 attempt 1](https://github.com/BestNathan/nession/actions/runs/44864365276) succeeded with **nine of nine jobs**. The planner logged `Selected 1 catalog versions at dcd98846c7daead0ccbce664cfd23373f2fa30fa`. Only jq 1.8.1 was scheduled—there were **no gh, kubectl or jq 1.7.1 jobs**. AMD64 and ARM64 Prepare, fingerprint probe, trusted Index Publisher, independent remote OCI Index/Manifest/Config/EROFS readback, and two uncredentialed native extracted binary/version/SHA probes all completed successfully.

The **current** unified GHCR tag `ghcr.io/bestnathan/nession-toolchain:jq-1.8.1` now refers to **OCI Index `sha256:3f0d11626e8633fcb9eb3ea885fa3ccfb692a1292055b8d63608ba3343fd15a4`** (both Linux architectures). The new publisher reused all four previously published content-addressed Blob objects (`uploaded=0 reused=4 manifests=3`): byte-identical payload can coexist with changed signed provenance/recipe fingerprint and therefore a new OCI root digest. The earlier immutable root `sha256:8cb5abadfafe287b41700c0624fa93241dbc0e77373894d1875d32f6059dd7df` is **historical**, no longer the current Tag pointer. Nession consumers remain pinned to immutable root digests, never mutable Tags.

## Production toolchain catalog population (#4241, 2026-11-22)

The user-selected **13 distinct tool types (14 independently versioned distributions, since Node 22 and Node 24 are separate)** are now published in the existing unified GHCR repository. Every cited trusted-main release Run below is **completed/success, attempt 1**: the unprivileged Linux/amd64 and Linux/arm64 jobs prepare and run real executables, the isolated Registry Publisher creates the two-platform OCI Index, an independent `packages:read` job verifies the full remote Index/Manifest/Config/raw EROFS graph, and separate uncredentialed native Jobs extract and execute each architecture-specific payload. A green PR or upload alone is not counted.

| Version tag under `ghcr.io/bestnathan/nession-toolchain` | Current immutable two-platform OCI Index digest | Trusted GHCR release + native readback |
| --- | --- | --- |
| `gh-2.105.0` | `sha256:2bd0fe388655d48fd514431095bc52bfb1d319fedc4fd183feb5949e4fb73587` | [Run 44721571308, attempt 1](https://github.com/BestNathan/nession/actions/runs/44721571308) |
| `jq-1.8.1` | `sha256:3f0d11626e8633fcb9eb3ea885fa3ccfb692a1292055b8d63608ba3343fd15a4` | [Run 44864365276, attempt 1](https://github.com/BestNathan/nession/actions/runs/44864365276) |
| `rust-1.96.0` | `sha256:ef5637081a2191262d92a7f780b19b8fece747294b9963ce198f21b1d9795587` | [Run 44987103624, attempt 1](https://github.com/BestNathan/nession/actions/runs/44987103624) |
| `node-24.22.3` | `sha256:813e68563ecb87c626ec964cab85e70844231ca33a7baf339143c4955d92fa38` | [Run 44986798782, attempt 1](https://github.com/BestNathan/nession/actions/runs/44986798782) |
| `node-22.23.5` | `sha256:30202cb3aac092aa3fd61a5f8ca760aa9ed1669c6971a2ee88e3a0d19fe9d7c1` | [Run 44986798782, attempt 1](https://github.com/BestNathan/nession/actions/runs/44986798782) |
| `git-2.56.0` | `sha256:7b40cf83f58e0907710405dec2e8ad6774ef1695b790809987d2b7c2bfd606ef` | [Run 45038935012, attempt 1](https://github.com/BestNathan/nession/actions/runs/45038935012) |
| `rg-15.2.0` | `sha256:1ed9f3eaacf9fb90673ab05dc70b91defd74a69fd6721f343d2020be65583c14` | [Run 44985763088, attempt 1](https://github.com/BestNathan/nession/actions/runs/44985763088) |
| `just-1.59.0` | `sha256:52275a52ace36ff6eabe677ffe55be81987bfc48245ae66c37c98d2a6690d065` | [Run 44985763088, attempt 1](https://github.com/BestNathan/nession/actions/runs/44985763088) |
| `sccache-0.19.0` | `sha256:663c0f18ad1dab4dbe1e8cd0b7c54a32e32204aa242348fa5c5b9b9a5cbb93a7` | [Run 44985763088, attempt 1](https://github.com/BestNathan/nession/actions/runs/44985763088) |
| `claude-2.1.330` | `sha256:67b868c42f4fbf52baffbd157f1306abb745a0d1a09e0f1e0b4b79fe1db55b24` | [Run 44987552392, attempt 1](https://github.com/BestNathan/nession/actions/runs/44987552392) |
| `codex-0.171.0` | `sha256:f34ff2010d08cc8180b1c1e293bff006b2bcef8ad8dc4f673d7cc16c96345788` | [Run 44987552392, attempt 1](https://github.com/BestNathan/nession/actions/runs/44987552392) |
| `kubectl-1.35.0` | `sha256:fae382a25fde7648e37b906a3e8f006d2786e2e5f9331c9305ff231de7bed11b` | [Run 44986490415, attempt 1](https://github.com/BestNathan/nession/actions/runs/44986490415) |
| `cf-1.0.0-rc.2` | `sha256:fa98b3e8fa0c3e5cfc9edd43c502dea6f911e008f84fbd0901f2abc0e1215a92` | [Run 44988367094, attempt 1](https://github.com/BestNathan/nession/actions/runs/44988367094) |
| `ansible-2.22.0` | `sha256:08803ffc8924120056412eee4ad8c517cd00d15c8f1ff068c03919602135674e` | [Run 45039534062, attempt 1](https://github.com/BestNathan/nession/actions/runs/45039534062) |

The current `jq-1.8.1` digest above is the updated changed-script release from Run 44864365276, **not** the first historical `sha256:8cb5...` index. The earlier `jq-1.7.1` single-amd64 version is still retained in GHCR, outside the 14 newly requested version entries. Existing `gh-2.105.0` and `jq-1.8.1` were preserved rather than rebuilt without a fingerprint change.

The premerge candidate validator is owned by [main PR #4266](https://github.com/BestNathan/nession/pull/4266), with only an unprivileged orphan-side trigger in [PR #4267](https://github.com/BestNathan/nession/pull/4267). All recipes remain per-version scripts under the independent `toolchains` branch. `git-2.56.0` had two superseded failure receipts: a 2 GiB EROFS source-byte bound breach in [Run 44987942761](https://github.com/BestNathan/nession/actions/runs/44987942761), corrected by PRs [#4277](https://github.com/BestNathan/nession/pull/4277) and [#4295](https://github.com/BestNathan/nession/pull/4295); and an EROFS Store API change causing trusted adapter compile errors in [Run 45037322734](https://github.com/BestNathan/nession/actions/runs/45037322734), corrected by main [PR #4294](https://github.com/BestNathan/nession/pull/4294). Both final Git/Ansible runs succeeded after those fixes, with no global limit relaxation or GHCR credential boundary change.

External runtime composition remains a **consumer obligation**, not a cross-tool Bundle: `cf-1.0.0-rc.2` requires a compatible separately mounted Node 24 runtime; `ansible-2.22.0` includes exact-SHA256-locked Python package wheels and requires an externally supplied Python 3.13 runtime. Trusted uncredentialed build/readback jobs supply those runtimes explicitly via [main PR #4274](https://github.com/BestNathan/nession/pull/4274). The native extracted `cf --help/--version` and Ansible playbook syntax-check probes were observed on both platforms. Registry upload alone does not prove mount/PATH integration inside an Agent Sandbox; Images/Sandbox remain the consumer owner.

**Requirement evidence:** [#4241 authenticated release matrix and exact Run/Attempt receipts](https://github.com/BestNathan/nession/issues/4241#issuecomment-7081552282). This live publication evidence is independent of the separate formal SC Acceptance updater; do not reinterpret stale Pending acceptance report rows as new false release failures, or manufacture SC Pass from this article.

## Historical contract and retained evidence

This article originally documented **#4092 / PR #4094** at main `06ff007d55092878d27e2606a29abcac6c8cb70b`. The [historical main release Run 44586296125](https://github.com/BestNathan/nession/actions/runs/44586296125) proved a single Linux/amd64 jq 1.8.1 EROFS OCI Manifest under `ghcr.io/bestnathan/nession-toolchain-jq:1.8.1-r1` with exact Manifest `sha256:8edf29ce84b0e144ee6288ca92ef76bb507e968cb705484bc96f5a4f93635e59`. The old recipe allowlist, version-plus-`-rN` tag and cross-tool `k8s-bundle` are **superseded**, not erased. **#4147 / merged PR #4148** delivered the source-pinned gh 2.105.0 amd64 recipe and native local tests; its actual canonical GHCR publication and cross-arch readback are now proven by the #4160 run above. Do not fabricate an old per-tool Registry receipt or rewrite historical Acceptance results.

The canonical current code/Skill remains authoritative over this sourced Knowledge article. Its protected publication must follow the Knowledge Publisher and Pages evidence contract, not generic direct writes to the orphan `knowledge` branch.

## Related knowledge

- [Nession GitHub Actions workflow domains and trust boundaries](nession-github-actions-workflow-domains-and-trust-boundaries.md) — why release coordination and Registry write authority stay isolated.
- [Global EROFS Image Manager](../engineering/global-erofs-image-manager.md) — immutable image identities, platform-aware distribution and consumer ownership.
- [Nession CI, E2E and acceptance qualification timing](nession-ci-e2e-and-acceptance-qualification-timing.md) — exact-SHA CI evidence versus actual trusted remote publication.

## Limits and revisit triggers

The 14 requested versioned distributions now have authenticated Linux/amd64 and Linux/arm64 OCI and extracted-runtime proofs. The retained historical jq 1.7.1 remains Linux/amd64 only. No macOS EROFS consumer or dynamic upstream version resolver has been proven. A GHCR Registry accepting raw EROFS OCI media types does not imply Docker Engine can execute the layers. The minimal script-only fingerprint assumes no additional undeclared build inputs; evolving the script protocol or environment identity needs an explicit new decision. GitHub branch protection and third-party source trust must remain reviewed supply-chain boundaries.
