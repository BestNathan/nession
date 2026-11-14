---
title: "Global EROFS Image Manager"
description: "Server-owned immutable EROFS artifacts with complete paged inventory, Project-or-Session scoped access, a durable Agent cache and a directory-backed asynchronous build lifecycle: deterministic public-GitHub/local builds, stage observation, cancel/retry, restart recovery, content-addressed bytes, mutable aliases, reference-safe GC, Workspace Images discovery, and Sandbox image composition"
topic: engineering
categories: ["architecture", "erofs", "images", "server", "storage", "security", "agent", "workspace", "sandbox"]
status: verified
created_at: 2026-11-09T12:54:48Z
updated_at: 2026-11-14T05:51:34Z
sources: ["https://github.com/BestNathan/nession/issues/3022", "https://github.com/BestNathan/nession/pull/3120", "https://github.com/BestNathan/nession/issues/3023", "https://github.com/BestNathan/nession/pull/3125", "https://github.com/BestNathan/nession/issues/3181", "https://github.com/BestNathan/nession/pull/3309", "https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/docs/architecture/erofs-image-manager.md", "https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/docs/architecture/sandbox-policy-and-execution.md", "https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-erofs/src/build.rs", "https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-erofs/src/cache.rs", "https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-server/src/image/mod.rs", "https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-protocol/src/contracts/image/v1.rs", "https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-protocol/src/contracts/sandbox/v1.rs", "https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-server/src/db/migration/m009_image_access_grants_consumers.rs", "https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-agent/src/sandbox_images.rs", "https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/web/src/capabilities/images/ImagesPlugin.ts", "https://github.com/BestNathan/nession/issues/3334", "https://github.com/BestNathan/nession/pull/3354", "https://github.com/BestNathan/nession/blob/5e5ae99d1a6270239779894859056e21c954bf79/docs/architecture/erofs-image-manager.md", "https://github.com/BestNathan/nession/blob/5e5ae99d1a6270239779894859056e21c954bf79/crates/nession-server/src/image/builds.rs", "https://github.com/BestNathan/nession/blob/5e5ae99d1a6270239779894859056e21c954bf79/crates/nession-server/src/image/mod.rs", "https://github.com/BestNathan/nession/blob/5e5ae99d1a6270239779894859056e21c954bf79/crates/nession-erofs/src/build.rs", "https://github.com/BestNathan/nession/blob/5e5ae99d1a6270239779894859056e21c954bf79/crates/nession-protocol/src/contracts/image/v1.rs", "https://github.com/BestNathan/nession/blob/5e5ae99d1a6270239779894859056e21c954bf79/web/src/capabilities/images/ImagesPlugin.ts", "https://github.com/BestNathan/nession/issues/3449", "https://github.com/BestNathan/nession/pull/3450", "https://github.com/BestNathan/nession/blob/46d7a906730f9fc048e4bbf43d5e5fd3b23183fe/crates/nession-erofs/src/mount_manager.rs"]
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
`a0a970da27ba97da76e5dd7c619d9c9dc0c44b88`). The cache mechanics moved to the
shared `nession-erofs` crate (#3303); `nession-agent` keeps only the identity
adapter and the protocol projection.

#3181 (PR #3309, merged to staging at
`21f74c944f97ad472b4f5d1d515f4b673a632b1e`) completes the consumer side:
Workspace discovers a Session-free Images capability, Project and Sandbox own
independent selection flows, and an existing Session can Enter a Sandbox Pane
whose root is composed from Server-authorized images. The Server remains the
only owner of metadata and bytes; the Agent only fetches what a scoped grant
authorizes.

## Ownership

| Thing | Owner |
|---|---|
| Source validation, build worker, `mkfs.erofs`, digest | `nession-erofs` + `nession-server/src/image` |
| Image/alias/lease/grant metadata | Server SQLite (`m007_erofs_images`; ephemeral grants rebuilt by `m009_image_access_grants_consumers`) |
| `image_digest` reference | Project declaration (`projects.image_digest`); Project never owns bytes |
| Workspace Images discovery/operation | `web/src/capabilities/images` (Session-free capability; no permanent sidebar item) |
| Sandbox image selection/composition | Sandbox capability owns target/mode/digest pins; Server mints grants; Agent prepares the local composition |
| Sandbox policy/execution | `nession-sandbox`; it is not a container or image manager |
| Physical read-only mount sharing | `nession-erofs::mount_manager` (#3449): one FUSE mount per verified digest per Agent identity/mount namespace, consumer leases, strict reclamation |
| Mount manager instance, cache pins, durable consumers | `nession-agent`; Sandbox records leases and owns only execution-scoped composition |

The physical mount layer is separate from image ownership: the Server still owns bytes and grants, while the Agent-owned `MountManager` deduplicates read-only FUSE mounts by digest and hands each execution a non-unmount-capable lease. See [Nession Sandbox policy and execution isolation architecture](nession-sandbox-policy-and-execution-isolation-architecture.md#shared-recoverable-erofs-mounts-3449) for the lease/recovery contract and its merged-staging evidence (#3449).

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

## Asynchronous durable build lifecycle (#3334)

Delivered by #3334 (PR #3354). Every Image build runs in the background and is
directory-backed. One build ID is one directory under the existing configured
`image_build_dir` (default `~/.nession/server/images/build`):

```text
<image_build_dir>/<build-id>/
  state.json          versioned execution state, atomically replaced
  snapshot/           private validated source snapshot (weeks-to-retry window)
  snapshot.json       source + packaging identity and content manifest
  image.erofs.part    in-progress mkfs output; never published
  build.log           bounded operator diagnostics
```

`state.json` is the execution-state authority. It is written through a private
temporary file, fsync, rename and parent-directory fsync, and records the
canonical source, pinned Git commit, packaging identity,
`queued|running|succeeded|failed|canceled`, current stage, real measured
file/byte counts, elapsed time, the last bounded diagnostic, attempt history and
the result digest. It is **not** a second Image Registry: a succeeded build
publishes immutable bytes through the existing Blob Store and is referenced by
the existing registry, aliases and grants.

Stages are `fetching`, `snapshotting`, `validating`, `packaging` and
`publishing`. File/byte counts appear only after the deterministic snapshot
manifest measured them. `mkfs.erofs` has no native progress report, so the
packaging stage reports the stage and elapsed time and never an invented
percentage. A client that missed a push re-reads the durable record.

The asynchronous units are `server.image.build.submit|get|list|cancel|retry`
plus the `server.image.build.updated` push. `server.image.build` remains the
explicit synchronous compatibility path: it submits the same durable build and
waits for the terminal record before returning an Image descriptor; it is never
reinterpreted as a job.

**Stage-level restart recovery.** The manager holds an exclusive advisory lock on
`<image_build_dir>/.owner.lock` for its lifetime and refuses to start if another
process owns the root. After acquiring it, every `running` record is an orphan.
Startup recovery reuses a snapshot only after its source identity, packaging
identity and recomputed content manifest match; a Git record may refetch its
pinned commit (a branch is pinned once for the build's lifetime), a local source
with no trustworthy snapshot fails explicitly instead of re-copying a changed
directory, a corrupted checkpoint is rejected, an unreadable `state.json`
directory is moved aside as `<build-id>.rejected`, and an incomplete
`image.erofs.part` is discarded before packaging reruns. There is no resume
inside `mkfs.erofs`, Git transfer or an arbitrary partial write.

**Cancel/retry.** Cancellation sets the build's control, the owned Git/mkfs run
loop kills and reaps its child, and a canceled build publishes no bytes and
changes no reference. Retry creates a new attempt in the same record, preserves
terminal attempt history, reuses a verified snapshot without the source, and
refuses a local source that has no validated snapshot. A succeeded build cannot
be retried.

**Concurrency and cleanup.** `image_max_concurrent_builds` bounds simultaneous
workers; one build ID has at most one execution; duplicate client submissions
with the same `client_request_id` are serialized and idempotent; publication,
digest dedupe and alias application are serialized so a stale completion cannot
move a newer alias intent. Live build directories protect their `building`
registry rows from GC. Terminal build directories expire after
`image_build_retention_secs` (default 7 days); successful builds release their
snapshot and partial image immediately, and cleanup never removes published
blobs, aliases, leases, Agent caches or active work.

**V1 single-owner condition.** Exactly one active Server build manager may own a
shared build root. The advisory lock detects a same-host second owner and the
Server fails closed. This is not a multi-Pod NFS locking claim; multi-writer
build ownership remains unsupported until a verified cross-instance mechanism
exists.

## Registry, authorization and lifecycle

- **Atomic blob store.** `sha256/<hex>` is written through a private temp file,
  fsynced and renamed; a partial write is never visible under a digest. Reads
  verify the digest.
- **Aliases** are mutable tags (`[a-z0-9][a-z0-9._-]{0,127}`) that resolve to a
  digest only after the bytes are ready. Moving a tag changes the tag, not the
  old digest's references.
- **Access grants.** `server.image.access` mints a random, SHA-256-stored,
  expiring bearer token for exactly one consumer: a Project that durably
  references the digest, or an authenticated Session whose ready Managed
  context resolved it. The token is bound to `(project_id | session_id,
  digest)`. Sandbox Enter is a separate Server-originated path: after
  validating the Web-safe selection and Server readiness, it mints one
  `grant_sandbox_access(session_id, digest)` per selected image. Knowing a
  digest never authorizes its bytes.
- **HTTP.** The existing Server listener serves
  `/images/blobs/<digest>` with GET/HEAD, `200`/`206`/`304`/`403`/`404`/`416`,
  one `Range`, `ETag`, `Accept-Ranges` and `X-Nession-Image-Digest`. A grant for
  Project A cannot read Project B's bytes by knowing its digest.
- **Complete inventory.** `server.image.list` takes absolute `offset`, `limit`
  (default/max 200) and an optional `query` over alias, digest, image id and
  persisted source. The reply carries `total`, `next_offset` while more rows
  remain, and each descriptor's sorted `aliases`. The UI pages a >200-image
  registry rather than silently truncating it.
- **Protocol units.** The asynchronous `server.image.build.submit|get|list|cancel|retry`
  family plus `server.image.build.updated`; the registry units `.list`, `.get`
  and `.access`; and the legacy synchronous `server.image.build` compatibility
  path. The Web `ImagesPlugin` (in `capabilities/images`) is the typed
  projection and reads the durable inventory again after reconnect.
  `server.session.sandbox.context` accepts `cache_digests` and returns
  Agent-observed `cache_statuses`.
- **Failure/GC.** A build row is `building`, becomes `ready` only after the
  verified digest is published from stored bytes, or `failed` with a bounded
  error. Failed, canceled and stale builds never expose bytes. GC removes
  failed/stale rows and an unreferenced blob only when no Project references the
  digest, no alias points at it, no unexpired lease exists, and no in-process
  transfer is active; a `building` row protected by a live durable build
  directory is skipped (`skipped_active_builds`). Restart preserves metadata,
  aliases and Project references in SQLite; durable build directories are
  reconciled separately.

## Agent cache and durable storage (#3023)

The Agent consumes a digest, never a logical image: the Server resolves the
image and mints a scoped grant, and the Agent keeps only a local copy of bytes
it was authorized to read. The cache is the Agent-side mirror of the Server's
blob store; it does not build, tag or resolve images. The durable download,
resume, verify and pin mechanics live in `nession-erofs::cache`; the Agent owns
the configured root and identity and projects readiness into the wire contract.

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
- **Observation, not readiness transfer.** `ErofsCache::observe` reports
  `verified | preparing | absent | failed` without downloading or mutating. The
  Agent projects this into `ImageCacheStatus` (`unavailable` when no cache is
  configured). Server Ready only means the Blob exists; it never implies that a
  particular Agent has verified bytes.
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

## Workspace, Project and Sandbox surfaces (#3181)

- **Workspace.** `images` is a registered capability available whenever the
  authenticated Server provides it, independent of a selected Session. It is
  contextual, not a permanent global sidebar item. The same capability renders
  the complete paged/searchable inventory and its Server/Agent readiness.
- **Project.** A Project-specific single-image selector and an explicit
  Git-source build path. A build result is shown but does not change the
  reference; only an explicit "Use this image" after readiness binds the new
  digest, and a failed build preserves the old reference. Project and Sandbox
  deliberately do not share a Picker or reference model.
- **Sandbox.** The Sandbox composition editor selects one or more images,
  infers the canonical role from the target (`/` Base, `/workspace` Workspace,
  `/opt/<name>` Toolchain), enforces read-only/overlay rules, and pins the
  resolved digest at selection time. It never exposes native image paths to the
  Web client. Alias mutation changes the alias, not an existing pinned digest.
- **Enter.** The Agent fetches each grant into its identity cache, creates an
  Agent-owned bounded workspace, builds the canonical `filesystem.composition`
  (Base at `/`, workspace overlay at `/workspace`, toolchains at
  `/opt/<name>`), and hands local paths to `nession-sandbox`. Preflight composes
  placeholder paths without fetching. A failure before the sandbox owns the
  workspace removes it; after a successful prepare, the sandbox record owns it.
- **Authorization boundary.** A Project-less but authorized Session can obtain
  only the digests its ready Managed context resolved; an explicit Sandbox
  selection is authorized by the Server on Enter. Unrelated Sessions and
  guessed digests are refused.

#3181 delivered the consumption surfaces (PR #3309, merge commit
`21f74c944f97ad472b4f5d1d515f4b673a632b1e`). Its pre-merge Cases passed in
trusted Case Smoke run `43069274350` at the merged PR head
`2d5d8fec5d4cedebb2c8e4de2f193664b65c6233` (SC-01 browser; SC-02 and SC-04
browser+runtime), the prototype criterion passed the trusted agent in run
`43069274738`, and the project/sandbox/Images E2E set passed in run
`43069274711` (5/5, 3/3, 16/16). The merged staging Acceptance / Cases run
`43070506302` at `21f74c94` passed SC-03's Session-scoped authorization Case.
Staging deployed image tag `21f74c9`; the server, Agent and UI pods were
observed Running at that image.

## Limits and when to revisit

- No EROFS boot, OCI image layer store, container ingress or whole-Session
  enforcement is claimed. Managed EROFS creation stays with #3062; managed
  location/mount with #3024. #3181 adds Workspace/Project/Sandbox consumption
  surfaces, not a second registry or blob owner.
- Private GitHub authentication, OCI/layered snapshotters, cross-digest dedupe,
  P2P distribution and automatic refresh of live Sessions remain non-goals.
- Builds require `mkfs.erofs` (erofs-utils) and durable disk for one
  snapshot+image per concurrent build. The accepted packaging set is
  deliberately exact; adding a compressor or block size is a contract change,
  not a tuning knob. Build storage that cannot be created or written fails the
  Server start closed; there is no ephemeral-storage fallback.
- The durable build directory is execution state, not a registry, job platform,
  scheduler or multi-writer queue. Resume is stage-level only (no byte-offset
  resume inside `mkfs.erofs`), and exactly one Server build manager per build
  root is the V1 deployment condition. Build retention is
  `image_build_retention_secs`; a disabled GC schedule also disables the
  scheduled build-directory cleanup.
- Digest dedupe is physical only; every consumer authorization is checked
  independently. A Project referencing a missing digest remains a declaration;
  `server.image.access` refuses until the image is ready. An Agent cache
  observation is not persisted Server state: it is re-read through the
  authenticated Session context.
- The Agent cache is a delivered component with its own configuration and
  storage contract. Sandbox Enter consumes it; Managed creation/mount
  choreography remains with #3062/#3024, and a host without EROFS/FUSE support
  still refuses composition rather than falling back.
- SC-05's controlled Kubernetes Pod-delete/recreate proof is a **one-time Task
  observation**, not a reusable committed K8s Case lane. The existing staging
  Case still reports Pending when executed; a future trusted K8s Case runner
  should codify the fixture and replace the one-time receipt.
