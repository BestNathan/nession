# Single-tool catalog → native EROFS OCI → unified GHCR (#4160)

**The authoritative, versioned tool definitions live in the independent `toolchains` orphan branch**, not under `main/scripts/toolchains/recipes/`. Every supported `<tool>/<version>/build.sh` prepares one tool distribution into one rootfs; a distribution such as Rust may contain several tools (rustc, cargo, clippy), but **bundles/compositions of unrelated tools are not supported**. Such composition belongs to Nession Images consumers.

## Version directory contract

Each executable shell file accepts:

```sh
bash jq/1.8.1/build.sh targets
bash jq/1.8.1/build.sh prepare --platform linux --arch amd64 --rootfs "$EMPTY_ROOTFS"
bash jq/1.8.1/build.sh verify --platform linux --arch amd64 --rootfs "$EXTRACTED_ROOTFS"
```

- `targets` outputs newline-separated explicit `os/arch` targets (initial native targets `linux/amd64` and `linux/arm64` for tools whose exact upstream SHA256 has been reviewed).
- `prepare` installs **all files** for the exact version into a private absolute empty directory. Verify fixed upstream source digest; never ingest host `HOME`, credentials, caches or configuration.
- `verify` probes the extracted binaries/versions in an **uncredentialed** worker; no executable from the catalog is run inside the credentialed Registry publisher.
- A version's build fingerprint is **SHA256 of exact `build.sh` bytes**; do not introduce auxiliary build inputs without first updating the contract. Git SHA alone is not a build fingerprint.
- Only one version entry per tool/version, no packaging revision, no Recipe YAML, no `dependencies`, no `k8s-bundle`.

## Build/Release owner

The trusted default-branch `Release / Toolchains` workflow is the one release coordinator. Manual `workflow_dispatch` selects exact `tool`, `version`, optional `platform=all` and `arch=all` (default). The branch-local `Toolchains / Catalog Change` push signal invokes the same coordinator through authenticated `workflow_run`. Its exact source-parent diff selects only added, changed or restored `<tool>/<version>/build.sh` files; unrelated README-only changes produce no release jobs, and deletions never delete historical OCI digests. Each selected candidate is independently fingerprint-probed against real GHCR Manifest/Index objects to skip an identical complete release. A manual dispatch can always select a specific version for recovery.

The pipeline is **targets (no secrets) → probe (read-only Registry) → prepare + version check (no Registry secrets) → verified artifact transfer → native EROFS/OCI build + Index + Registry push (trusted main, packages:write only) → independent remote readback (packages:read) → extracted version verification (uncredentialed)**. Every stage binds source SHA, recipe fingerprint and target matrix. Publisher refuses a superseded catalog tip and serializes writes per tool-version. A complete public tag must contain every supported target; partial manual selections may prepare/validate but cannot overwrite a complete release with an incomplete Index.

The one shared OCI registry repository is:

```text
ghcr.io/bestnathan/nession-toolchain:<tool>-<version>
ghcr.io/bestnathan/nession-toolchain:gh-2.105.0
```

The tag is an *updatable version pointer* after a reviewed change to that version's `build.sh`. **Consumers pin immutable OCI Index/Manifest digests**, not the tag. Preserve previous digests and authenticated Run/Attempt receipts. No `latest`, no `-rN` packaging revision, and no per-tool GHCR package. Single-tool multi-arch selection uses a native OCI Index; multi-tool composition is a separate Images layer.

`scripts/toolchains/catalog-plan.mjs` owns discovery/filter validation; `catalog-run.sh` owns the shell invocation boundary; `oci-publish-v2.rs` is an adapter over existing `nession-erofs` EROFS/Config/Manifest/Index/CAS and `registry::push_image`. They do not introduce a new image format or Registry client.

## Verification and migration

- `node scripts/toolchains/catalog-plan.mjs self-test`, `bash scripts/toolchains/catalog-selftest.sh`: catalog validity and negative fixtures.
- `bash scripts/toolchains/self-test.sh`: canonical synthetic rootfs security fixtures, source-parent change/replay/deletion tests, OCI fingerprint/architecture Rust unit tests and native local EROFS/OCI Index roundtrip. The historical #4092 implementation remains in Git history; its obsolete executable Bundle helpers are retired from active main.
- A successful **trusted main** publish is not proven by PR checks: inspect exact `Release / Toolchains` workflow Run/Attempt, `packages:write` isolated publisher, independent remote OCI Index/Manifest/Config/layer readback and extracted native version checks.
- Existing `gh` 2.105.0 source/checksum, local extraction and tests delivered by #4147 / merged PR #4148 are preserved in `toolchains:gh/2.105.0/build.sh`. The old `nession-toolchain-gh:2.105.0-r1` is superseded; authoritative new tag is `nession-toolchain:gh-2.105.0` after real proof.
- Old `main/scripts/toolchains/recipes`, `prepare.sh`, `cargo.sh` and old `oci-publish.rs` are retired from active main. Their exact implementation and original release receipts remain in immutable Git history. Never silently rewrite previously published legacy OCI identities.

For task guidance see the [Toolchain Release Skill](../../.claude/skills/nession-toolchain-release/SKILL.md), [Requirement #4160](https://github.com/BestNathan/nession/issues/4160) and the [current curated Knowledge article](https://github.com/BestNathan/nession/blob/knowledge/topics/workflows/nession-native-toolchain-oci-release-to-ghcr.md). Update that protected Knowledge article through its authorized publisher when the actual release migration has been verified.
