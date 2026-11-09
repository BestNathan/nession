---
title: "Global EROFS Image Manager"
description: "Server-owned immutable EROFS artifacts: deterministic public-GitHub/local builds, content-addressed bytes, mutable aliases, Project-scoped access grants, Range HTTP and reference-safe GC"
topic: engineering
categories: ["architecture", "erofs", "images", "server", "storage", "security"]
status: verified
created_at: 2026-11-09T12:54:48Z
updated_at: 2026-11-09T12:54:48Z
sources: ["https://github.com/BestNathan/nession/issues/3022", "https://github.com/BestNathan/nession/pull/3120", "https://github.com/BestNathan/nession/blob/5e9a2d82118a8ea4da2b2418af6b161d86bf3841/docs/architecture/erofs-image-manager.md", "https://github.com/BestNathan/nession/blob/5e9a2d82118a8ea4da2b2418af6b161d86bf3841/crates/nession-erofs/src/build.rs", "https://github.com/BestNathan/nession/blob/5e9a2d82118a8ea4da2b2418af6b161d86bf3841/crates/nession-server/src/image/mod.rs", "https://github.com/BestNathan/nession/blob/5e9a2d82118a8ea4da2b2418af6b161d86bf3841/crates/nession-protocol/src/contracts/image/v1.rs", "https://github.com/BestNathan/nession/blob/5e9a2d82118a8ea4da2b2418af6b161d86bf3841/crates/nession-server/src/db/migration/m007_erofs_images.rs"]
---

# Global EROFS Image Manager

## Decision

EROFS is a **global immutable resource**, not a `ProjectEnvironment`. The Server
owns image metadata, bytes, aliases and authorized distribution. A Project only
references an immutable `sha256:<64 lowercase hex>` digest; the Image Manager
owns the build, the blob and the access boundary. Sandbox never clones Git or
manages a registry.

Delivered by #3022 (PR #3120, merged to staging at
`5e9a2d82118a8ea4da2b2418af6b161d86bf3841`).

## Ownership

| Thing | Owner |
|---|---|
| Source validation, build worker, `mkfs.erofs`, digest | `nession-erofs` + `nession-server/src/image` |
| Image/alias/lease/grant metadata | Server SQLite (`m007_erofs_images`) |
| `image_digest` reference | Project declaration (`projects.image_digest`) |
| Sandbox policy/execution | `nession-sandbox`; it is not a container or image manager |
| Mounting/provisioning | Managed-location/Sandbox work (#3062, #3024), not this capability |

The canonical cross-reference is [Project declaration and Workspace location
ownership](project-declaration-and-workspace-location-ownership.md), which
states that a Project never owns blob bytes, a build engine or a store.

## Deterministic build

V1 accepts exactly two source shapes:

1. a **public GitHub HTTPS** repository `https://github.com/<owner>/<repo>` with
   a branch name or full 40-character commit SHA;
2. a validated **absolute local directory/bundle**.

SSH, `git://`, plain HTTP, userinfo/private auth, ambiguous refs and `..` local
paths are refused by the canonical contract
(`nession-protocol::contracts::image::v1`). A branch is resolved once by the
snapshot; the exact commit is recorded. A fixed SHA that cannot be fetched is
an explicit failure.

The snapshot is `git clone --depth 1 --single-branch --no-tags` (or a single-SHA
fetch). Only Git plumbing runs: repository code, hooks and package scripts are
never executed. `.git` remains usable for `git status`/`add`/`commit`. Git runs
with no system/global config, no prompt, no askpass, no hooks and no credential
helper; credential/extraHeader/insteadOf material found in `.git/config` fails
the build. Symlinks must be relative and stay inside the snapshot; absolute or
escaping links and special files fail.

Packaging is fixed: uncompressed EROFS, `-T 0`, fixed UUID
`11111111-1111-4111-8111-111111111111`, block size 4096. The digest is SHA-256
of the final bytes, so identical source+parameters produce one digest and reuse
one physical blob; a different revision can never overwrite a referenced digest.

## Registry, authorization and lifecycle

- **Atomic blob store.** `sha256/<hex>` is written through a private temp file,
  fsynced and renamed; a partial write is never visible under a digest. Reads
  verify the digest.
- **Aliases** are mutable tags (`[a-z0-9][a-z0-9._-]{0,127}`) that resolve to a
  digest only after the bytes are ready. Moving a tag changes the tag, not the
  old digest's references.
- **Access grants.** `server.image.access` mints a random, SHA-256-stored,
  expiring bearer token only when the named Project durably references the
  digest. The token is bound to that `(project_id, digest)`.
- **HTTP.** The existing Server listener serves
  `/images/blobs/<digest>` with GET/HEAD, `200`/`206`/`304`/`403`/`404`/`416`,
  one `Range`, `ETag`, `Accept-Ranges` and `X-Nession-Image-Digest`. A grant for
  Project A cannot read Project B's bytes by knowing its digest.
- **Protocol units.** `server.image.build`, `.list`, `.get` and `.access`; the
  Web `ImagesPlugin` is the typed projection (no UI in this scope).
- **Failure/GC.** A build row is `building`, becomes `ready` only after the
  digest is computed from stored bytes, or `failed` with a bounded error.
  Failed/stale builds never expose bytes. GC removes failed/stale rows and an
  unreferenced blob only when no Project references the digest, no alias points
  at it, no unexpired lease exists, and no in-process transfer is active.
  Restart preserves metadata, aliases and Project references in SQLite.

## Evidence

All five runtime criteria passed source-aligned Cases in Case Smoke run
`42616401375` at PR head `bccee7b4269334df26ee589a87e3628632cb6c0e`; SC-06's
documentation criterion passed the trusted agent in run `42616398587` at the
same head. The Cases build a real EROFS image with `erofs-utils` (superblock
magic at byte 1024), prove shallow/tagless/committable snapshots, deterministic
digest reuse, HTTP Range/ETag/403/404/416 and Project-isolated grants, GC
protection and restart persistence. Staging deployed server/agent/ui image
`5e9a2d8`; the server pod started with the m007 migration applied.

## Limits and when to revisit

- No EROFS mount/boot, Agent/Sandbox provisioning or Project-facing UI is
  claimed. Managed EROFS creation stays with #3062; managed location/mount with
  #3024; the Project surface with #3025.
- Private GitHub authentication, OCI/layered snapshotters, cross-digest dedupe,
  P2P distribution and automatic refresh of live Sessions remain non-goals.
- Builds require `mkfs.erofs` (erofs-utils) and disk for one snapshot+image per
  concurrent build. The accepted packaging set is deliberately exact; adding a
  compressor or block size is a contract change, not a tuning knob.
- Digest dedupe is physical only; every Project authorization is checked
  independently. A Project referencing a missing digest remains a declaration;
  `server.image.access` refuses until the image is ready.
