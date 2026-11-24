---
title: "Global EROFS Image Manager"
description: "Server-owned immutable EROFS artifacts with complete paged inventory, Project-or-Session scoped access, a durable Agent cache and a directory-backed asynchronous build lifecycle: deterministic public-GitHub/local builds, stage observation, cancel/retry, restart recovery, content-addressed bytes, mutable aliases, reference-safe GC, Workspace Images discovery, and Sandbox image composition; plus the #4086 peer-capable OCI Registry topology (shared CAS contracts, mountable read-only/push Registry service, host-independent Client SDK, bounded authorized peer discovery with same-digest fallback)"
topic: engineering
categories: ["architecture", "erofs", "images", "server", "storage", "security", "agent", "workspace", "sandbox", "registry"]
status: verified
created_at: 2026-11-09T12:54:48Z
updated_at: 2026-11-24T05:28:21Z
sources: ["https://github.com/BestNathan/nession/issues/3022","https://github.com/BestNathan/nession/pull/3120","https://github.com/BestNathan/nession/issues/3023","https://github.com/BestNathan/nession/pull/3125","https://github.com/BestNathan/nession/issues/3181","https://github.com/BestNathan/nession/pull/3309","https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/docs/architecture/erofs-image-manager.md","https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/docs/architecture/sandbox-policy-and-execution.md","https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-erofs/src/build.rs","https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-erofs/src/cache.rs","https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-server/src/image/mod.rs","https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-protocol/src/contracts/image/v1.rs","https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-protocol/src/contracts/sandbox/v1.rs","https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-server/src/db/migration/m009_image_access_grants_consumers.rs","https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/crates/nession-agent/src/sandbox_images.rs","https://github.com/BestNathan/nession/blob/21f74c944f97ad472b4f5d1d515f4b673a632b1e/web/src/capabilities/images/ImagesPlugin.ts","https://github.com/BestNathan/nession/issues/3334","https://github.com/BestNathan/nession/pull/3354","https://github.com/BestNathan/nession/blob/5e5ae99d1a6270239779894859056e21c954bf79/docs/architecture/erofs-image-manager.md","https://github.com/BestNathan/nession/blob/5e5ae99d1a6270239779894859056e21c954bf79/crates/nession-server/src/image/builds.rs","https://github.com/BestNathan/nession/blob/5e5ae99d1a6270239779894859056e21c954bf79/crates/nession-server/src/image/mod.rs","https://github.com/BestNathan/nession/blob/5e5ae99d1a6270239779894859056e21c954bf79/crates/nession-erofs/src/build.rs","https://github.com/BestNathan/nession/blob/5e5ae99d1a6270239779894859056e21c954bf79/crates/nession-protocol/src/contracts/image/v1.rs","https://github.com/BestNathan/nession/blob/5e5ae99d1a6270239779894859056e21c954bf79/web/src/capabilities/images/ImagesPlugin.ts","https://github.com/BestNathan/nession/issues/3449","https://github.com/BestNathan/nession/pull/3450","https://github.com/BestNathan/nession/blob/46d7a906730f9fc048e4bbf43d5e5fd3b23183fe/crates/nession-erofs/src/mount_manager.rs","https://github.com/BestNathan/nession/blob/2909dcbb0ad65c9e9bff4c874a36f2a8de29918f/docs/architecture/erofs-image-manager.md","https://github.com/BestNathan/nession/blob/2909dcbb0ad65c9e9bff4c874a36f2a8de29918f/crates/nession-server/src/image/mod.rs","https://github.com/BestNathan/nession/pull/3493","https://github.com/BestNathan/nession/issues/3693","https://github.com/BestNathan/nession/issues/3695","https://github.com/BestNathan/nession/issues/3696","https://github.com/BestNathan/nession/issues/3697","https://github.com/BestNathan/nession/issues/3698","https://github.com/BestNathan/nession/pull/3725","https://github.com/BestNathan/nession/pull/3703","https://github.com/BestNathan/nession/pull/3709","https://github.com/BestNathan/nession/pull/3736","https://github.com/BestNathan/nession/pull/3741","https://github.com/BestNathan/nession/pull/3754","https://github.com/BestNathan/nession/blob/5e9e853ab8b52f836a4af0b4fcacb2a213a9d76e/crates/nession-erofs/src/build/compose.rs","https://github.com/BestNathan/nession/blob/5e9e853ab8b52f836a4af0b4fcacb2a213a9d76e/crates/nession-erofs/src/build/referenced.rs","https://github.com/BestNathan/nession/blob/5e9e853ab8b52f836a4af0b4fcacb2a213a9d76e/crates/nession-sandbox/src/mount/mod.rs","https://github.com/BestNathan/nession/blob/5e9e853ab8b52f836a4af0b4fcacb2a213a9d76e/crates/nession-sandbox/src/mount/plan.rs","https://github.com/BestNathan/nession/issues/4086","https://github.com/BestNathan/nession/pull/4171","https://github.com/BestNathan/nession/blob/c9190d4f15ab8b17470a8425fe7372fa238a8e98/docs/architecture/oci-erofs-image-infrastructure.md","https://github.com/BestNathan/nession/issues/4087","https://github.com/BestNathan/nession/issues/4088","https://github.com/BestNathan/nession/issues/4089","https://github.com/BestNathan/nession/issues/4090","https://github.com/BestNathan/nession/issues/4091","https://github.com/BestNathan/nession/issues/4250","https://github.com/BestNathan/nession/pull/4430","https://github.com/BestNathan/nession/pull/4446","https://github.com/BestNathan/nession/pull/4449","https://github.com/BestNathan/nession/blob/00db673886ee5d6cda579d0f180d973ae7e7f600/docs/architecture/oci-erofs-image-infrastructure.md","https://github.com/BestNathan/nession/blob/00db673886ee5d6cda579d0f180d973ae7e7f600/crates/nession-server/src/server/websocket.rs","https://github.com/BestNathan/nession/blob/00db673886ee5d6cda579d0f180d973ae7e7f600/crates/nession-common/src/config.rs"]
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
only owner of metadata and bytes; the Agent only fetches paths the Server
resolved for it, authenticating with the Server Token (#3440).

[#4086](https://github.com/BestNathan/nession/issues/4086) extends this topology
without reopening those accepted deliveries: the Server keeps catalog,
authorization and official-source policy, but is **no longer a mandatory image
data hop**. Every Server/Agent may own a local verified CAS, mount the same
standard OCI Distribution Registry service and use the same Client SDK to fetch
verified bytes from an authorized Server, peer Agent or external Registry. See
[Peer-capable Store and Registry topology](#peer-capable-store-and-registry-topology-4086)
below; the historical Server-authoritative path remains valid and is now one
authorized source among several.

## Ownership

| Thing | Owner |
|---|---|
| Source validation, build worker, `mkfs.erofs`, digest | `nession-erofs` + `nession-server/src/image` |
| Image/alias/lease metadata | Server SQLite (`m007_erofs_images`; the retired `m009_image_access_grants_consumers` table is not read for authorization) |
| `image_digest` reference | Project declaration (`projects.image_digest`); Project never owns bytes |
| Workspace Images discovery/operation | `web/src/capabilities/images` (Session-free capability; no permanent sidebar item) |
| Sandbox image selection/composition | Sandbox capability owns target/mode/digest pins; the Server resolves path grants; the Agent prepares the local composition |
| Sandbox policy/execution | `nession-sandbox`; it is not a container or image manager |
| Physical read-only mount sharing | `nession-erofs::mount_manager` (#3449): one FUSE mount per verified digest per Agent identity/mount namespace, consumer leases, strict reclamation |
| Mount manager instance, cache pins, durable consumers | `nession-agent`; Sandbox records leases and owns only execution-scoped composition |

The physical mount layer is separate from image ownership: the Server still owns bytes and their path resolution, while the Agent-owned `MountManager` deduplicates read-only FUSE mounts by digest and hands each execution a non-unmount-capable lease. See [Nession Sandbox policy and execution isolation architecture](nession-sandbox-policy-and-execution-isolation-architecture.md#shared-recoverable-erofs-mounts-3449) for the lease/recovery contract and its merged-staging evidence (#3449).

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
- **Path grants.** The Server resolves a Ready digest to a blob route for an
  authorized consumer: a Project that durably references the digest, or an
  authenticated Session whose ready Managed context resolved it. Sandbox Enter
  is a separate Server-originated path: after validating the Web-safe selection
  and Server readiness, it returns one path-only `ManagedImageGrant` per
  selected image. There is no per-digest bearer to mint (#3440); the scope
  rules decide which route the Server hands out, not who may read the bytes.
- **HTTP.** The existing Server listener serves
  `/images/blobs/<digest>` with GET/HEAD, `200`/`206`/`304`/`403`/`404`/`416`,
  one `Range`, `ETag`, `Accept-Ranges` and `X-Nession-Image-Digest`. The route
  requires the Server Token and authenticates it **before** resolving the
  digest: a missing or wrong bearer is `403` regardless of the digest, and an
  authenticated unknown digest is `404`. See
  [Endpoint-owned Server and Agent tokens](endpoint-owned-server-and-agent-tokens.md).
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
image to an authorized path, and the Agent keeps only a local copy of bytes it
fetched with the Server Token. The cache is the Agent-side mirror of the
Server's blob store; it does not build, tag or resolve images. The durable
download, resume, verify and pin mechanics live in `nession-erofs::cache`; the
Agent owns the configured root and identity and projects readiness into the
wire contract.

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
digest reuse, HTTP Range/ETag/403/404/416 and Project-scoped path resolution, GC
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
- **Enter.** The Agent fetches each resolved image path into its identity cache, creates an
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
- Private GitHub authentication, OCI/layered snapshotters, cross-digest dedupe
  and automatic refresh of live Sessions remain non-goals. Bounded authorized
  peer Registry distribution is delivered by #4086 (see
  [Peer-capable Store and Registry topology](#peer-capable-store-and-registry-topology-4086));
  all-to-all P2P, public peer discovery, automatic cross-tenant sharing and a
  speculative P2P CDN remain non-goals.
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
- Digest dedupe is physical only; the Server checks the Project/Session scope
  before it hands out a path, while the blob route itself is guarded by the
  Server Token. A Project referencing a missing digest remains a declaration;
  the Server resolves no path until the image is ready. An Agent cache
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

## EROFS Image Composition and Sandbox runtime composition — delivered boundary (2026-11-16, updated 2026-11-17)

**Decision:** [#3693](https://github.com/BestNathan/nession/issues/3693). **Current vs target:** The boundary and both Image-Compose representations are **delivered on staging** by [#3696](https://github.com/BestNathan/nession/issues/3696) and [#3697](https://github.com/BestNathan/nession/issues/3697); the runtime side is delivered by [#3695](https://github.com/BestNathan/nession/issues/3695) and [#3698](https://github.com/BestNathan/nession/issues/3698). The remaining explicit non-goal is Sandbox runtime *selection* of a referenced Composite, which fails closed; the referenced Composite Image format and its physical mount are delivered.

Two meanings of composition coexist; they have **different output resources**:

1. **EROFS Image Composition** takes pinned immutable Image revisions, path/merge/conflict rules and produces **a new immutable, Manifest-addressed Image**. #3696 delivers `flattened`: one self-contained raw EROFS layer built by `fsck.erofs --extract` staging and deterministic `mkfs.erofs`. #3697 delivers `referenced`: a distinct Manifest identity whose single versioned Composite descriptor names one metadata EROFS and the ordered backing devices; the Catalog, grants, cache and mount manager retain and pin the whole Blob closure. Neither an OCI multi-platform Index nor arbitrary extra `layers[]` is a filesystem composition. Both variants validate source Manifest pins, deterministic conflict/whiteout/path rules, safe publication and dependency closure.
2. **Sandbox runtime composition** takes existing read-only Image views, an authorized Workspace/Upper, bind paths, ENV and policy to produce **an execution filesystem view**. It does **not** produce or publish an Image. #3695 delivers the typed `MountPlan`/`MountSource::{Erofs, Overlay, Bind}`/`MountBackend`/`MountedView` domain; #3698 adds up to 16 ordered read-only lowers and an explicit opt-in writable RootFS with an execution-owned transient upper.

**Ownership:** `nession-erofs` owns OCI/CAS/Catalog/Image Build/Image Compose/distribution/cache and digest-addressed physical **read-only** Image mounts. A mutable Workspace upper and its shared Overlay View do **not** become EROFS Image contents; they belong to `nession-sandbox`'s mount/Workspace domain (#3695). OverlayFS is a reusable filesystem mechanism; Image Build may use a temporary primitive without owning a Sandbox runtime. The Image's OCI Config/annotations are read-only data: Sandbox/Session owns effective environment precedence, PATH, mount targets, capabilities and execution policy. Running untrusted package-manager scripts is outside the EROFS library; a build may invoke an appropriately authorized Sandbox worker.

**Delivered evidence:**

| Child | Delivered on staging | Evidence |
|---|---|---|
| #3695 typed mount domain and Overlay ownership | PR [#3725](https://github.com/BestNathan/nession/pull/3725) at `0d8fda4825829f2ad64eb4cfc0192d2e15fa07f8` | PR Agent run `43852186904`; merged staging Cases `43853127951` (SC-02/SC-03: two consumers share one physical Overlay; restart/foreign-mount/fault recovery) |
| #3696 flattened Image Compose | PR [#3703](https://github.com/BestNathan/nession/pull/3703) at `fbc4aa2e4faa8e03040f42b3d492c969d906bde4`; Case setup PR [#3710](https://github.com/BestNathan/nession/pull/3710) at `e84fb5df` | PR Agent run `43815815870`; merged staging Case `43813771715` (composition survives cancel/retry/restart; Agent mounts result after every source payload is deleted) |
| #3697 referenced Composite | PR [#3709](https://github.com/BestNathan/nession/pull/3709) at `47507cf4368dce4ece012a7b10088146b8133f6d`; repair PR [#3715](https://github.com/BestNathan/nession/pull/3715) at `67c3533e` | PR Agent run `43818068382`; merged staging Cases `43822627408` (GC/transfer/cache retain the closure; erofsfuse mounts after source blobs are removed) |
| #3698 ordered lowers and writable RootFS | PR [#3736](https://github.com/BestNathan/nession/pull/3736) at `5434c991`; follow-up PR [#3741](https://github.com/BestNathan/nession/pull/3741) at `5e9e853ab8b52f836a4af0b4fcacb2a213a9d76e` | PR Agent run `43875307694`; merged staging Cases `43877231534` (ordered priority, transient RootFS isolation, ordered identity across restart) |

**Compatibility and limits:** physical EROFS RO `MountManager` and #3449 digest-keyed consumers/cache pins are unchanged. A referenced composite has a distinct composite physical-view identity and complete pinned Blob closure, never a fake single Blob digest. Legacy single-layer Manifests, legacy `workspace.image` payloads and #3582 durable Workspace paths remain valid; the reader accepts the legacy fields and the writer records both the legacy first-lower fields and the ordered set. Sandbox runtime selection of a referenced Composite remains a non-goal and fails closed. Docs and this article are not kernel proof; the native receipts are the merged staging Cases above.

**Related:** [Nession Sandbox policy and execution isolation architecture](nession-sandbox-policy-and-execution-isolation-architecture.md). Canonical contracts in the docs PR [#3754](https://github.com/BestNathan/nession/pull/3754): [OCI/EROFS image infrastructure](https://github.com/BestNathan/nession/pull/3754/files) (this decision and the delivery DAG) and [Sandbox policy and execution isolation](https://github.com/BestNathan/nession/pull/3754/files).

## Peer-capable Store and Registry topology (#4086)

**Decision:** [#4086](https://github.com/BestNathan/nession/issues/4086) (canonical
architecture PR [#4171](https://github.com/BestNathan/nession/pull/4171), merged to
main at `26e7cc87687f812eb1b037cc5fc9224304433bb9`). The topology changes from
Server-authoritative transfer to **reusable Registry nodes over a shared CAS
contract**. Every Nession Server/Agent may independently (a) own a local verified
CAS, (b) mount the same standard OCI Distribution `/v2/` Registry service, and
(c) use the same OCI Registry Client SDK to pull/push as authorized. The Server is
not a mandatory image data hop. This is new scope layered on the accepted
#3494–#3500 delivery, not a regression reopening it. The single canonical owner is
[OCI/EROFS image infrastructure](https://github.com/BestNathan/nession/blob/c9190d4f15ab8b17470a8425fe7372fa238a8e98/docs/architecture/oci-erofs-image-infrastructure.md).

**Shared Store contracts (#4087).** Three reusable contracts in `nession-erofs`,
consumed by both hosts: `BlobStore` (content/sha256-addressed bytes; atomic
private-temp publication, identical-digest dedupe without rewriting bytes,
re-verification of preexisting objects; reuses `blob::store`, no parallel CAS);
`RepositoryStore` (accessible Manifests/Tags and the **complete reachable blob
closure** of a repository — Server over the SQLite catalog, Agent as a projection
of verified local references); and `RegistryAuthorizer` (gates pull/push/list per
principal, repository and scope; injected by the host, never a bypassing global
token). A local Store is either authoritative/persistent (Server CAS + catalog) or
a re-fetchable Cache (Agent verified cache) — a Cache is a Store plus
fetch/retention policy, not a second incompatible byte-store protocol. Removal is
deliberately absent from `BlobStore`: retention is the owning host's policy, so a
shared Registry reader can never reclaim another owner's pinned or transferring
bytes. **Possessing a digest is never authorization**; a raw CAS directory must
never be published as a globally accessible Registry, and a cache miss is distinct
from an authorized-but-nonexistent object (distinct OCI error semantics).

**Mountable Registry service (#4088).** A reusable Axum/Tower-mounted OCI
Distribution `/v2/` service in `nession-erofs::registry::service` (feature
`registry-service`), independent of host identity, mounted on the host's existing
HTTP ingress — no extra accept loop and no second authorization state machine. It
is supplied the host's `BlobStore`/`RepositoryStore`/`RegistryAuthorizer` plus a
`RepositoryPublisher` for write mode (`RegistryMode::ReadOnly`/`ReadWrite`). Pull
surface: `GET /v2/`, `GET/HEAD …/manifests/{ref}`, `GET/HEAD …/blobs/{digest}`,
`GET …/tags/list` with digest, media-type/Accept negotiation, Range/ETag,
repository scope and OCI error semantics. Push (only behind explicit push policy):
the standard `POST/PATCH/PUT …/blobs/uploads/` sequence and `PUT …/manifests/{ref}`;
uploads stage privately with digest/size validation and Catalog publication is
atomic only after the complete verified referenced closure exists. Exposure follows
the #4087 **tag-rooted reachability fence**: a Manifest pushed by Tag is readable by
Tag and digest, and moving a Tag moves the exposed root atomically. Agent mode is
**read-only by explicit opt-in**: all mutation verbs are denied even with a read
credential, scoped to verified complete artifacts and authenticated peers.

**Registry Client SDK (#4089).** The #3498 client becomes a host-independent SDK in
`nession-erofs::registry`: `ImageReference` (registry, repository, tag or digest),
canonical tag→digest resolution, Index→platform-specific Manifest selection,
Config/Blob closure download, and immutable digest pinning **before** any
alternate-source fetch. Network fetch, verification, CAS ingest and optional local
Catalog tag publication are separate steps; the caller supplies the local CAS/Cache,
a scoped credential provider, progress/cancellation and source policy. Existing
auth/challenge, bounded redirect/SSRF defenses and resumable single-flight transfer
are reused; a Registry without resume triggers a safe restart, never a partial Ready
object. Credentials are never serialized into Session grants or Image Config and
never leak to redirects or logs; a tag name does not imply the same digest across
registries.

**Host adapters (#4090) and peer discovery (#4091).** `nession-server` mounts the
read-write Server Registry on its existing ingress and imports authorized external
(GHCR) images into its own Store; `nession-agent` mounts an optional opt-in
read-only Registry adapter and selects peer sources, reusing Agent P2P identity and
transport. Peer discovery advertises or resolves only verified pinned
Manifest/complete-closure availability and authorized endpoints from a **bounded
explicit candidate list**. A requester resolves and authorizes the immutable digest
first, then selects a reachable authorized source and re-verifies exact digest+size
regardless of source; on failure it falls back only to another authorized source for
the **same pinned digest**, never consuming partial bytes. Control-plane grants carry
pinned immutable identity and allowed sources — not raw registry secrets; there is no
global Server bearer credential shared across peers.

**Proprietary Blob transport retirement (#4250).** The deferred #4090 cutover moves
supported Session image acquisition from the proprietary `/images/blobs/{digest}`
transfer endpoint to the standard OCI Distribution `/v2/` API; it is a
transport-endpoint migration, not the #3496 storage migration, and adds no second
CAS, SDK or token authority. The `/v2/` Registry exposes an immutable digest only
when a repository's Tags reach it through descriptor edges (Index children and the
referenced Composite closure included). The Server therefore grants a
repository-scoped `/v2/{repo}/manifests/{digest}` route (objects on
`/v2/{repo}/blobs/{digest}`) exactly when the resolved Manifest is Tag-reachable,
derived by `catalog::reference::v2_repository_for_manifest` from the same Tag roots
and edges as the Registry reachability fence. Untagged builds and digest-only legacy
rows have no such repository and keep the bounded compatibility route. The fence is
unchanged: a pin is GC protection, not a `/v2/` root, and the cutover grants no access
`/v2/` already denies.

The legacy route mount is gated by the protected operator toggle
`ServerConfig::legacy_blob_route` (default `true`), applied by the Server ingress
`http_router` — the single owner of the mount decision; the standard `/v2/` Registry
is mounted regardless. `false` is the staged removal (the proprietary route is
unmounted, migrated clients holding only `/v2/` grants are unaffected, a caller still
asking for the legacy route gets 404); flipping back to `true` is the fail-closed
rollback (the supported legacy reader returns without relaxing the Server Token or
digest checks). The toggle deletes no durable blob and rewrites no Manifest identity.
Because acquisition is `/v2/`-only, the persistent Agent cache and an active mount
(pin) survive the removal unchanged. The bounded compatibility obligation keeps the
legacy helpers live, so the retirement delivers a protected disable plus proof rather
than deleting still-supported code.

Evidence: SC-01 exact PR-head inventory + deterministic protocol-contract tests
(agent run `45318146210`); SC-02 merged-staging native Server+Agent parity Case and
SC-03 removal/rollback Case both Pass (Case run `45332521480` at
`00db673886ee5d6cda579d0f180d973ae7e7f600`). SC-02 proves cold/warm fetch, restart
adoption, tag-move pin stability and lease-protected eviction with no proprietary
URL; SC-03 (`sc03_legacy_route_removed_with_protected_rollback`,
`nession-server::server::websocket`) drives the real `http_router` in both toggle
states — removal negatives (legacy 404, `/v2/` parity, wrong principal/repository/
forged digest denied), persistent Agent cache and active-pin preservation, and
fail-closed rollback. Canonical owner:
`docs/architecture/oci-erofs-image-infrastructure.md` (Proprietary Blob transport
retirement).

**Authority and format boundaries.** The Server keeps Project/Session/tenant
authorization, official catalog policy, endpoint advertising and grant issuance.
`nession-erofs` does not depend on `nession-server`, `nession-agent`,
`nession-sandbox` or `nession-protocol`; the reverse edge is forbidden and checked by
`cargo tree -p nession-erofs --edges normal`. OCI Distribution interoperability does
**not** imply Docker can execute `application/vnd.erofs` layers; a referenced
Composite's nested closure needs an explicit portable representation before portable
registry support is claimed. Original OCI bytes are preserved end to end;
Index/Manifest identity stays digest-pinned, tags are mutable names scoped to one
repository, and there is no global tag consistency across registries.

**Bounded non-goals.** The `/v2/` service is a reusable distribution surface, not a
Docker/OCI runtime, a blob replication scheduler or an unrestricted CAS view; no
host-specific Session/Project decisions inside the crate; no mandatory publishing,
all-to-all P2P, public peer discovery, automatic cross-tenant sharing, automatic GHCR
credential forwarding, speculative P2P CDN or mandatory availability inventory
database.

**Delivery DAG and evidence.** Dependencies **(1) → (2, 3) → (4) → (5)**: #4087
(shared contracts) → #4088 (Registry service) + #4089 (Client SDK) → #4090 (host
adapters) → #4091 (peer discovery/fallback). The prior #3498 client and #3496 catalog
are reused, not duplicated; #4084 remains the GHCR EROFS publish/readback smoke owner.

| Child | Deliverable | Delivery evidence |
|---|---|---|
| #4087 | Shared `BlobStore`/`RepositoryStore` contracts + host adapters | PR [#4177](https://github.com/BestNathan/nession/pull/4177) → staging `4b59fcbde175094fd5fcfe7f2fa4cdce14385fa7` |
| #4088 | Mountable `/v2/` Registry service | merged-staging Cases SC-01/02/03 Pass (Case run `44755679055`, ingest `44756439239`) |
| #4089 | Host-independent Registry Client SDK | PR [#4200](https://github.com/BestNathan/nession/pull/4200) → staging `03d7251d4b2c11f90ec392764aeecf74d52c1b6c` |
| #4090 | Server/Agent host adapters, GHCR import, direct pulls | PR [#4215](https://github.com/BestNathan/nession/pull/4215) → staging `88cbc9932023b8e3a26dd0a3304313b1f67f5b7e`; merged-staging Case run `44785298936` |
| #4091 | Peer source discovery, scoped A2A pull, same-digest fallback | PR [#4218](https://github.com/BestNathan/nession/pull/4218) → staging `a19633cf1fd50456b88e9d969446b19c1712ad8e`; merged-staging Cases SC-01/02/03 Pass (Case run `44792675605`, ingest `44793352488`) |

The architecture and dependency/Issue map were accepted by document/link review at
the exact PR SHA (agent run `44730903223`, ref `1558e1eb54984cd6c0996d4312f2bdf951709511`);
the crate boundary is proven by the cargo commands above plus focused compile/contract
checks. Child runtime criteria are proven by their own exact-SHA Rust tests and
trusted merged-staging Cases, not by this article.

**Related:** [Nession Sandbox policy and execution isolation architecture](nession-sandbox-policy-and-execution-isolation-architecture.md)
(verified local immutable objects + mount leases), [Endpoint-owned Server and Agent
tokens](endpoint-owned-server-and-agent-tokens.md) (host identity/authorization) and
[Project declaration and Workspace location ownership](project-declaration-and-workspace-location-ownership.md)
(a Project never owns blob bytes).
