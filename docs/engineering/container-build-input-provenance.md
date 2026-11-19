# Container build input provenance (#3961)

This record is the reviewed upstream input selection for the official Nession
Staging image builder as of **2026-11-19**. It records source identity, not a
claim that any particular rebuild or deployed environment passed. The
authoritative executable contract is `scripts/runtime-image-tools.mjs`;
GitHub Actions remains the **only** authorized image builder/publisher.

## Immutable upstream OCI indexes

The following `FROM <tag>@sha256:<digest>` references are multi-platform
**index** identities from the public official Docker Hub `library/*`
repositories; they are not one architecture's child manifest digest.

| Base reference | Multi-platform index digest | Audited upstream |
| --- | --- | --- |
| `debian:bookworm-20261104-slim` (also `12.15-slim`) | `sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc` | [Docker Hub official Debian image](https://hub.docker.com/layers/library/debian/12-slim/images/sha256-c67e92c8099ba22853ab4cfda7cfb494d253d6012ca82dee98ba8976772af018) |
| `rust:1.96-bullseye` (also `1.96.0-bullseye`) | `sha256:7069898d5edfc11b0ba498ecefbcc5438f6390b3ce0be11a9750cf39cab7e02f` | [Docker Hub official Rust image](https://hub.docker.com/layers/library/rust/1.96.0-bullseye/images/sha256-5ebdedce38fc37fb279c5b35b2832298e769ccf3385240846ab4fc983f00fa0f) |
| `node:20-alpine` | `sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293` | [Docker Hub official Node image](https://hub.docker.com/layers/library/node/20-alpine/images/sha256-aa9a9fa739b6372d0f53b733a4f9caab50a0d528d9f0e7acade6177a2e62ca18) |
| `nginx:1.27-alpine` | `sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10` | [Docker Hub official nginx image](https://hub.docker.com/layers/library/nginx/1.27-alpine/images/sha256-75bb62c57c7996d74812d7ec7362fc7fb6df52fba6c0724b3c082717ea810173) |

The dated Debian index is shared between the Server, Agent and MCP runtime
and EROFS helper build stages. Rust and Node builder stages, and standalone
nginx UI runtime, use their corresponding pinned indexes. The trusted
`release-staging.yml` supplies the exact audited Agent Debian base build
argument for **both** architectures, instead of overriding the Dockerfile
with an unpinned tag.

When intentionally upgrading any parent image, re-audit the **index** against
the official registry and both `linux/amd64` and `linux/arm64` children;
review the tag, index, package compatibility and build ARG together. Never
copy an architecture-specific child digest into a multi-arch `FROM`.
The source version, not a mutable tag, must identify a build input.

## NodeSource repository trust

`deploy/setup-nodesource.sh` replaces the downloaded and executed
`https://deb.nodesource.com/setup_22.x` script. It registers a fixed
`node_22.x` `nodistro` APT source using an isolated
`Signed-By: /usr/share/keyrings/nodesource.gpg` keyring. Before registering
the source, it checks **exactly one primary public-key fingerprint** against
`6F71F525282841EEDAF851B42F59B5F99B1BE0B4` and restricts architecture
to `amd64` or `arm64`. A mismatch, extra key, bad key, unsupported arch
or APT signature failure aborts the build. No downloaded shell is executed.

Source: [NodeSource official Debian setup](https://github.com/nodesource/distributions/blob/master/scripts/deb/setup_22.x);
[NodeSource upstream key/signature discussion](https://github.com/nodesource/distributions/issues/1923).
Only an audited signing-key rotation may change the hard-coded fingerprint.
APT verifies the repository `InRelease` signature and the explicitly pinned
`nodejs=22.23.5-1nodesource1` install; the two Agent variants retain
`@anthropic-ai/claude-code@2.1.323`, tmux 3.6b and EROFS 1.9.4 with source
SHA-256. The build still consumes signed Debian/NodeSource package repositories;
the package repository snapshots are not immutable content-addressed snapshots.

## Verification boundaries

- `runtime-image-tools-selftest` rejects floating/wrong builder and runtime
  parent digests, mismatched Agent ARGs, unsafe NodeSource registration and
  signing-key bypass, including deterministic negative mutations.
- Exact-head PR Quality checks are **source-level** proof only. They do not
  claim container assembly succeeded on either platform.
- An independent protected Staging `Release / Staging Artifacts` must build
  and publish all eight role × architecture outputs; `Deploy / Staging ACR`
  must authenticate the exact source Run/Attempt, copy and verify per-arch
  digests; `Deploy / Identity` must separately attest ready deployed roles.
  None of these must be substituted with a local Docker build or manual
  registry/GitOps mutation.

This record concerns official Docker image **build inputs**, not the separate
Nession EROFS OCI/registry runtime model in
[OCI/EROFS Image Infrastructure](../architecture/oci-erofs-image-infrastructure.md).
