---
title: "Global EROFS Image Manager"
description: "Server-owned immutable EROFS artifacts with a durable Agent cache: deterministic public-GitHub/local builds, content-addressed bytes, mutable aliases, Project-scoped access grants, Range HTTP, reference-safe GC and fail-closed PVC-backed Agent storage"
topic: engineering
categories: ["architecture", "erofs", "images", "server", "storage", "security", "agent"]
status: verified
created_at: 2026-11-09T12:54:48Z
updated_at: 2026-11-09T17:07:00Z
sources: ["https://github.com/BestNathan/nession/issues/3022", "https://github.com/BestNathan/nession/pull/3120", "https://github.com/BestNathan/nession/blob/5e9a2d82118a8ea4da2b2418af6b161d86bf3841/docs/architecture/erofs-image-manager.md", "https://github.com/BestNathan/nession/blob/5e9a2d82118a8ea4da2b2418af6b161d86bf3841/crates/nession-erofs/src/build.rs", "https://github.com/BestNathan/nession/blob/5e9a2d82118a8ea4da2b2418af6b161d86bf3841/crates/nession-server/src/image/mod.rs", "https://github.com/BestNathan/nession/blob/5e9a2d82118a8ea4da2b2418af6b161d86bf3841/crates/nession-protocol/src/contracts/image/v1.rs", "https://github.com/BestNathan/nession/blob/5e9a2d82118a8ea4da2b2418af6b161d86bf3841/crates/nession-server/src/db/migration/m007_erofs_images.rs", "https://github.com/BestNathan/nession/issues/3023", "https://github.com/BestNathan/nession/pull/3125", "https://github.com/BestNathan/nession/blob/a0a970da27ba97da76e5dd7c619d9c9dc0c44b88/docs/architecture/agent-erofs-cache.md", "https://github.com/BestNathan/nession/blob/a0a970da27ba97da76e5dd7c619d9c9dc0c44b88/crates/nession-agent/src/erofs_cache.rs", "https://github.com/BestNathan/nession/blob/a0a970da27ba97da76e5dd7c619d9c9dc0c44b88/crates/nession-agent/src/config.rs", "https://github.com/BestNathan/nession/blob/a0a970da27ba97da76e5dd7c619d9c9dc0c44b88/deploy/entrypoint-agent.sh", "https://github.com/BestNathan/nession/blob/f05e138c4ef36dac920ca9aefa1111de0552315a/base/nession/deployment-agent.yaml"]
---

# Global EROFS Image Manager

## Decision

EROFS is a **global immutable resource**, not a `ProjectEnvironment`. The Server
owns image metadata, bytes, aliases and authorized distribution. A Project only
references an immutable `sha256:<64 lowercase hex>` digest; the Image Manager
owns the build, the blob and the access boundary. Sandbox never clones Git or
manages a registry.

Delivered by #3022 (PR #3120, merged to staging at
`5e9a2d82118a8ea4da2b2418af6b161d86bf3841`). The Agent-side durable cache
was delivered by #3023 (PR #3125, merged to staging at
`a0a970da27ba97da76e5dd7c619d9c9dc0c44b88`).

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

## Agent cache and durable storage (#3023)

The Agent consumes a digest, never a logical image: the Server resolves the
image and mints a scoped grant, and `nession-agent` keeps only a local copy of
bytes it was authorized to read. The cache is the Agent-side mirror of the
Server's blob store; it does not build, tag or resolve images.

- **Configuration.** `[erofs] storage_dir` in the Agent TOML. Precedence is
  explicit TOML, `NESION_EROFS_STORAGE_DIR`, `$NESION_HOME/erofs`, then the
  native default (`/var/lib/nession/erofs` on Linux, `$HOME/.nession/erofs`
  elsewhere). Relative, empty, control-character and `..` paths are rejected;
  the resolution owner is `AgentConfig::effective_erofs_storage_dir`.
- **Fail closed.** An explicit path is a **durable-location declaration**: the
  Agent requires a real directory (not a symlink), matching ownership when not
  root, a real write+fsync probe, and on Linux a `/proc/mounts` filesystem that
  is not tmpfs/ramfs/overlay/aufs/etc. It never falls back to the container
  writable layer or tmpfs. An implicit default is a development convenience and
  does not claim a PVC.
- **Cache contract.** Verified blobs live at `sha256/<hex>`; downloads stage in
  `tmp/<hex>.part`, verify SHA-256, fsync and rename atomically. One in-process
  fetch per digest serves concurrent callers; an interrupted `.part` resumes
  with `Range`, a `200` restarts, and stale partials are reconciled after 24h.
  A warm hit re-hashes the blob, transfers zero body bytes, and a corrupted file
  is removed and refetched. Pins prevent eviction; the cache never deletes a
  mounted resource and never buffers a whole image in memory.
- **Container/GitOps.** Both Agent Dockerfiles create `/data` and `/data/erofs`
  and document that an OCI `VOLUME` is not a PVC. The GitOps Agent Deployment
  keeps `NESION_HOME=/data` on the existing `nession-server-data` PVC and sets
  `AGENT_EROFS_STORAGE_DIR=/data/erofs`; it creates no second PVC and moves no
  Server, Claude-home or Session data. `deploy/entrypoint-agent.sh` validates
  the override and writes the optional `[erofs]` table after every top-level
  key.

## Evidence

All five runtime criteria passed source-aligned Cases in Case Smoke run
`42616401375` at PR head `bccee7b4269334df26ee589a87e3628632cb6c0e`; SC-06's
documentation criterion passed the trusted agent in run `42616398587` at the
same head. The Cases build a real EROFS image with `erofs-utils` (superblock
magic at byte 1024), prove shallow/tagless/committable snapshots, deterministic
digest reuse, HTTP Range/ETag/403/404/416 and Project-isolated grants, GC
protection and restart persistence. Staging deployed server/agent/ui image
`5e9a2d8`; the server pod started with the m007 migration applied.

The Agent cache merged to staging at
`a0a970da27ba97da76e5dd7c619d9c9dc0c44b88` (PR #3125). Its pre-merge criteria
passed Case Smoke run `42637855144` at PR head
`bc91a75ecd1454183ed3bc19b8600c90d634d3a4` (SC-01, SC-03, SC-04) and the
trusted agent run `42637858414` (SC-02). The merged staging Acceptance / Cases
run `42638717201` initially recorded SC-05 as Pending with the blocked
K8s-runner reason.

SC-05 was then observed by a one-time controlled trusted CI Task (run
`42660858103`, source `8bf780722d338e3b654f738cea0167d8da578374`) on Ubuntu
24.04: a kind v0.25.0 / Kubernetes v1.31.2 cluster bound PVC `sc05-pvc`
(PV `sc05-pv`) and served a real EROFS image with the fixed `-T 0 -U … -b 4096`
packaging (`sha256=f83590c0…`, 266240 bytes). Pod `sc05-agent-1` downloaded it
once and published it under `sha256/<digest>` on the PVC; the Pod was deleted;
recreated Pod `sc05-agent-2` — a different Pod UID — reused the identical
digest and bytes, and the HTTP server recorded exactly one blob GET. The
receipt is archived in `task-results` at
`runs/3023-sc05-k8s/42660858103-1/record.json` as an **untrusted Task
observation** (the Task skill does not grant Acceptance authority); the owner
recorded it for SC-05 because no committed K8s Case lane exists, and the Issue
closed with every criterion Pass.

The staging release for `a0a970d` succeeded, and the server, Agent and UI
deployments were observed Running at their `a0a970d` images. GitOps deploy
commit `f05e138c4ef36dac920ca9aefa1111de0552315a` carries that image set and
keeps `AGENT_EROFS_STORAGE_DIR=/data/erofs` on the existing
`nession-server-data` PVC.

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
- The Agent cache is a delivered component with its own configuration and
  storage contract; no Session/Sandbox image consumer invokes it yet, and
  provisioning/mounting remains with #3024/#3062.
- SC-05's controlled Kubernetes Pod-delete/recreate proof is a **one-time Task
  observation**, not a reusable committed K8s Case lane. The existing staging
  Case still reports Pending when executed; a future trusted K8s Case runner
  should codify the fixture and replace the one-time receipt.
