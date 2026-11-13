# Global EROFS Image Manager

> Owner of immutable EROFS image builds, durable asynchronous build execution,
> content-addressed bytes, aliases and authorized blob access
> ([#3022](https://github.com/BestNathan/nession/issues/3022),
> [#3334](https://github.com/BestNathan/nession/issues/3334)).
> Upstream model: [#3021 Project](project.md), [product-model.md](../design/product-model.md),
> [agent-process-discovery.md](agent-process-discovery.md) for the Agent/Server
> trust style this follows.

## Ownership

EROFS is a **global immutable resource**, not a `ProjectEnvironment`.

| Thing | Owner |
|---|---|
| Portable EROFS mechanics: byte digest/verify, content-addressed atomic store, deterministic builder, optional cache and FUSE mount primitives | `nession-erofs` |
| Image metadata, digest, published bytes, aliases, leases, access grants | Server Image Manager (`crates/nession-server/src/image`) |
| Durable build execution state (one directory per build) | Server Image Manager; `state.json` is the execution-state authority |
| Stage mechanics, snapshot checkpoint, bounded subprocess lifecycle | `nession-erofs` (`build`) |
| `image_digest` reference on a Project | Project declaration (`projects.image_digest`) |
| Build worker and `mkfs.erofs` | Server Image Manager (consumes the crate's builder) |
| Sandbox policy | `nession-sandbox`; it never clones Git or manages a registry |
| Runtime provisioning / mounting | Follow-up managed-location and Sandbox work (#2681, #3024) |

A Project only references a digest. Deleting a Project never deletes shared
bytes, and two Projects may reference one physical image.

### Reusable crate boundary (#3303)

`crates/nession-erofs` is a workspace library with explicit cargo features,
not a second authority:

| Feature | Owns | Consumer |
|---|---|---|
| core (`digest`) | `sha256:` validation and streamed file verification | every consumer |
| `store` | content-addressed `sha256/<hex>` files, `.tmp` publication, atomic rename, usage | Server Image Manager |
| `build` | controlled Git/local snapshot, fixed `mkfs.erofs` argv, `Packaging` mechanics | Server Image Manager |
| `cache` | authenticated ranged download/resume, verify-before-publish, identity namespace, pin/eviction, diagnostics | Agent adapter (`crates/nession-agent/src/erofs_cache.rs`) |
| `mount` (Linux) | unprivileged `erofsfuse` probe/mount/unmount primitive with an owned handle | Sandbox composition (`crates/nession-sandbox/src/linux/erofs.rs`) |

The crate has no `nession-protocol` dependency. The Server translates the
versioned `ImageSource`/`ImagePackaging` DTO into the crate's mechanical inputs
after wire validation; the Agent adapter supplies the configured root and
identity; the Sandbox keeps source-root authorization, mount ordering, overlay
composition, execution records and teardown. The crate never owns image roles,
Project identity, registry metadata, authorization, download origins or
Session orchestration.


## Sources

V1 accepts exactly two source shapes:

1. **Public GitHub HTTPS repository** — `https://github.com/<owner>/<repo>`
   with a branch name or a full 40-character commit SHA. The canonical
   validator is `nession_protocol::contracts::image::v1`. Private
   authentication, SSH, `git://`, HTTP, userinfo, queries, fragments and extra
   path segments are refused. A fixed SHA that the remote cannot fetch is an
   explicit build failure.
2. **Validated local directory or bundle** — an absolute path with no `..` or
   control characters. The tree is copied without following symlinks, scanned,
   and built from the private copy.

A branch is resolved **once** by the shallow clone; the resolved commit is
recorded as `source_sha`. Git runs with no system/global config, no prompt, no
askpass, no hooks and no credential helper. Snapshot materialization runs only
Git plumbing: repository code, hooks, package scripts and build commands are
never executed.

The snapshot is `git clone --depth 1 --single-branch --no-tags` (or an explicit
single-SHA fetch). Its `.git` directory remains usable for `git status`,
`git add` and new commits. Tags are absent, and a `.git/config` containing any
credential, extra-header, askpass or insteadOf material fails the build rather
than being embedded.

Symlinks must be relative and stay inside the snapshot. Absolute or escaping
links, special files, and trees above the entry/byte bounds fail the build.
This is a path-safety rule, not a sandbox: V1 does not claim to execute the
image.

## Deterministic packaging

`ImagePackaging` is fixed in V1:

```text
compression       none
block size        4096
fixed timestamp   0
fixed UUID        11111111-1111-4111-8111-111111111111
```

`mkfs.erofs` receives exactly:

```sh
mkfs.erofs -T 0 -U 11111111-1111-4111-8111-111111111111 \
  -b 4096 IMAGE SNAPSHOT
```

The image digest is `sha256:<64 lowercase hex>` of the **final bytes**, not a
caller claim. The record also stores the exact source commit, size, status and
the canonical packaging JSON. A build for identical content and parameters
computes the same digest and reuses one physical blob; a different revision can
never overwrite a referenced digest.

## Blob store and aliases

Bytes live under `image_blob_dir` at `sha256/<hex>`. Publication writes a
private temporary file in the same store, fsyncs it, and renames it under the
computed digest. A partial write is never visible as a digest. Storing the same
digest again reuses the existing file; the store verifies the digest on read.

An **alias** is a mutable tag (`[a-z0-9][a-z0-9._-]{0,127}`) that resolves to a
digest only after the bytes are ready. Moving a tag to a new revision changes
which digest the tag names; existing Project references and leases keep their
old digest.

## Durable build directory (#3334)

Every Image build is asynchronous and directory-backed. One build ID is one
directory under the existing configured build root (`image_build_dir`, default
`~/.nession/server/images/build`):

```text
<image_build_dir>/<build-id>/
  state.json          versioned execution state, atomically replaced
  snapshot/           private validated source snapshot (while reusable)
  snapshot.json       source + packaging identity and content manifest
  image.erofs.part    in-progress mkfs output; never published
  build.log           bounded operator diagnostics
```

`state.json` is written to a temporary file, fsynced, renamed and followed by a
parent-directory fsync, so a reader never observes truncated JSON. It records
the canonical requested source, the pinned Git commit, packaging identity,
`queued|running|succeeded|failed|canceled`, the current stage, real measured
file/byte counts, elapsed time, the last bounded diagnostic, attempt history and
the result digest. The Build directory is **execution state**, not a new Image
Registry: a succeeded build publishes an immutable blob and registry row through
the pre-existing Blob Store and Image Manager.

Stages are `fetching`, `snapshotting`, `validating`, `packaging` and
`publishing`. After the snapshot manifest is measured, the descriptor carries
real file and byte counts. `mkfs.erofs` has no native progress report, so the
packaging stage reports stage and elapsed time and **no invented percentage**.

### Asynchronous protocol units

| Unit | Policy | Meaning |
|---|---|---|
| `server.image.build.submit` | Inline | Validate input, create the durable directory and `building` row, return the queued record promptly |
| `server.image.build.get` | Query | Read the authoritative durable record (valid after reconnect/restart) |
| `server.image.build.list` | Query | Durable build inventory, newest first |
| `server.image.build.cancel` | Inline | Terminate owned subprocesses, record truthful `canceled`; idempotent on a terminal record |
| `server.image.build.retry` | Inline | New attempt in the same record, reusing a verified snapshot |
| `server.image.build` | Inline | **Legacy synchronous compatibility path**: submits the same durable build and waits for the terminal record, then returns the ready/failed `ImageDescriptor` |

The legacy unit is explicit and versioned, not reinterpreted: a client that
calls it still receives an Image descriptor, never a build/JOB record. New
clients use the asynchronous family. All units require an authenticated client;
contract types and validation live in
`nession-protocol::contracts::image::v1`.

The Server pushes `server.image.build.updated` with the descriptor read from the
durable state at each transition. A client that misses a push (navigation or
reconnect) re-reads `server.image.build.get|list`; there is no client-side
fabrication of progress.

### Stage-level restart recovery

The manager takes an exclusive advisory lock on
`<image_build_dir>/.owner.lock` for its lifetime and fails closed if another
process owns the root. That lock is what makes startup recovery truthful: after
acquiring it, every `running` record is an orphan whose previous owner is gone.

Startup scans the build directories and reconciles non-terminal records:

- a verified snapshot checkpoint (source identity, packaging identity and
  recomputed content manifest match) resumes at `packaging`;
- a Git record whose commit was pinned may refetch exactly that commit; a Git
  branch is pinned once for the lifetime of the build, so later branch movement
  cannot change the result;
- a local directory with no trustworthy snapshot fails explicitly instead of
  re-copying a possibly changed source;
- a corrupted checkpoint is rejected, never reused; an unreadable `state.json`
  directory is moved aside as `<build-id>.rejected` and is never resumed,
  listed or executed;
- an incomplete `image.erofs.part` is discarded and packaging is rerun from the
  validated snapshot. No resume happens inside `mkfs.erofs`, Git transfer or an
  arbitrary partial write.

A `building` registry row with no durable build directory is stale and is marked
failed on recovery, never offered as ready.

### Cancellation, retry and concurrency

Cancellation sets the build's cancellation control, waits for the worker, and
the owned Git/`mkfs.erofs` subprocess run loop kills and reaps its child.
Dropping a Tokio future is not cancellation. A canceled build publishes no
bytes, fails only its own registry row and never changes a Project reference or
alias.

Retry creates the next attempt in the same record and preserves the terminal
attempt's stage/error history. A verified snapshot is reused without the source;
packaging is rerun; a Git source with no snapshot is refetched (pinned commit
when one exists); a local source without a snapshot is refused with "submit a
new build". A succeeded build cannot be retried.

`image_max_concurrent_builds` still bounds simultaneous workers with an
in-process semaphore. Each build ID has at most one active execution; a
duplicate client submission with the same `client_request_id` and the same
source returns the existing record. Different builds write only inside their own
directories. Publication, digest dedupe and alias application are serialized:
a stale completion cannot move an alias past a newer submitted intent.

**V1 single-owner assumption:** exactly one active Server build manager may own
a shared build root. The advisory lock detects a same-host second owner and the
Server refuses to start with it. This is not a claim that multiple Server Pods
can safely share a network filesystem; multi-writer build ownership remains
unsupported until a verified cross-instance mechanism exists.

### Bounded cleanup

Terminal build directories are retained for `image_build_retention_secs`
(default 7 days) and removed by the same scheduled maintenance tick as image GC.
Failed/canceled snapshots stay within that window so a retry can reuse them.
Successful builds release their snapshot and partial image immediately after
publication. Cleanup never removes an active build, a published blob, an Image
alias, a Session lease or an Agent cache; Blob GC (#3180) remains a separate
sweep over registry rows.

## Image registry protocol units

| Unit | Policy | Meaning |
|---|---|---|
| `server.image.list` | Query | Complete inventory, newest first, paginated and searchable |
| `server.image.get` | Query | Exactly one of `digest` or `alias` |
| `server.image.access` | Inline | Mint a Project- or Session-scoped, expiring bearer grant for one digest |

All require an authenticated client. The contract types and validation live in
`nession-protocol::contracts::image::v1`.

`server.image.list` takes an absolute `offset`, a `limit` (default 200 for an
older client, maximum 200) and an optional case-sensitive `query` over alias,
digest, image id and persisted source. The reply always carries `total` and
carries `next_offset` while more rows remain. The descriptor's `aliases` field
is the sorted set of tags currently resolving to the immutable digest; the
build-time `alias` remains the tag supplied by that build. A UI can therefore
render the complete >200-image inventory without paging-by-convention or
silent truncation.

`server.session.create`'s Managed path (#3062) is a Server-originated image
consumer: after resolving the Project's pinned Source image and the requested
Base Runtime/toolchain digests, the Server mints scoped grants with
`ImageManager::grant_managed_access`. It keeps the same Ready and digest rules
but does not require the Project to reference a global Base Runtime/toolchain
artifact; the client-facing Project access path keeps that reference rule.

Sandbox Enter (#3181) is a second Server-originated consumer. The client sends
Web-safe `SandboxImageSelection` values (role, digest, target, mode), never a
native source path. The Server validates the selection shape, requires each
digest to be Ready, and mints one `grant_sandbox_access(session_id, digest)`
bearer per selected image. The Agent prepares those grants in its own durable
cache and builds the canonical `filesystem.composition`. The token remains
bound to one `(session_id, digest)`.

`server.image.access` names exactly one consumer. A Project consumer must
durably reference the digest in `projects.image_digest`. A Session consumer
must name a digest already resolved by that Session's ready Managed context.
Unrelated Sessions and guessed digests are refused; a Project-scoped request
remains compatible.

Per-digest transfer and verification progress is deliberately **not** a Server
image status. The Agent owns the versioned `ImageCacheObservation` (#3412) and
reports measured bytes/activity for its own cache through the authenticated
Session-context query. A Server `ready` image does not imply that any Agent has
fetched, verified or is downloading it; conversely, an Agent partial is not a
Server build failure. See [Agent EROFS cache](agent-erofs-cache.md#per-digest-progress-observation-3412).

## Authorized blob HTTP

The Server's Axum router maps `/images/blobs/<digest>` to the image service
(`#3439`; the route is registered beside `/ws` and the optional MCP endpoint).
The service accepts `GET`/`HEAD` and requires:

```http
Authorization: Bearer <grant token>
```

The token is random, stored only as SHA-256, expires (default five minutes),
and is bound to one consumer (`project_id` or `session_id`) and one digest.
`server.image.access` mints a Project token only when the named Project durably
references that digest, and a Session token only when that Session's ready
Managed context resolved it. Knowing another consumer's digest therefore does
not authorize its bytes. Access grants are ephemeral capabilities, not durable
bookmarks: the m009 migration may rebuild their table and a client simply
requests a new grant.

Responses are digest-bound:

- `200 OK` with `Content-Length`, `Accept-Ranges: bytes`, `ETag: "<digest>"` and
  `X-Nession-Image-Digest: <digest>`;
- `206 Partial Content` with `Content-Range: bytes start-end/size` for one
  `Range` request (suffix ranges supported);
- `416 Range Not Satisfiable` with `Content-Range: bytes */size`;
- `403 Forbidden` for a missing, expired, foreign-project or wrong-digest grant;
- `404 Not Found` for an unknown digest;
- `304 Not Modified` for a matching `If-None-Match`.

The service holds an in-process transfer guard while streaming.

## GC and failure states

A build is persisted before the worker starts as `building`, becomes `ready`
only after the verified digest is published from stored bytes, and becomes
`failed` with a bounded error if the worker fails or is canceled. Failed and
stale `building` rows are never offered as bytes.

GC removes:

- failed rows;
- `building` rows older than the stale threshold, **except** a row protected by
  a live durable build directory (`skipped_active_builds` reports the skip);
- ready rows (and their blob) only when **no** Project references the digest,
  no alias points at it, no unexpired lease exists, and no in-process transfer
  is active.

Expired access grants and leases are pruned on GC. Restarting the Server keeps
image metadata, aliases and Project references because all of it is in SQLite;
blob bytes are already on disk under their digest.

### Bounded, scheduled sweeps (#3180)

The GC operation is bounded per sweep by `image_gc_max_candidates` and a
deletion byte budget; `GcReport` reports `candidates`, `examined_images`,
`removed_images`, `removed_blobs`, `reclaimed_bytes`, `skipped_active_transfers`
and `deferred_by_limit`. A candidate deferred by either bound is **not**
deleted at all (a ready row is never removed while its blob is kept), and the
next sweep re-selects it from the database. The sweep owns no in-memory cursor,
so an interrupted or restarted sweep is retryable by construction: a failed
unlink leaves the row for the next attempt.

The Server runtime (not a test or request path) schedules the sweep every
`image_gc_interval_secs` (default 6 hours; `0` disables the schedule and an
operator can still run one sweep). Each completed tick logs one structured
receipt: removed images/blobs, reclaimed bytes, deferred candidates and skipped
active transfers. There is no unbounded delete loop and no per-request GC.

### GC and diagnostics

`ImageManager::diagnostics()` reports metadata rows by status
(`ready_images`, `failed_images`, `building_images`) separately from storage
usage: `blobs`/`blob_bytes` are ready content-addressed bytes under
`sha256/`, while `temp_files`/`temp_bytes` are unpublished `.tmp` artifacts of
a failed or interrupted publication. The same values are available without a
listener:

```bash
nession-server --print-image-diagnostics [config.toml]
```

Agent cache bytes are deliberately a different owner and are reported by
`ErofsCache::diagnostics` (see [agent EROFS cache](agent-erofs-cache.md)); the
two counters are what distinguish Server registry consumption from per-Agent
cache consumption.

## Configuration

```toml
image_blob_dir = "~/.nession/server/images/blobs"
image_build_dir = "~/.nession/server/images/build"
image_max_concurrent_builds = 2
image_access_token_expiry_secs = 300
image_gc_interval_secs = 21600   # 0 disables scheduled GC
image_gc_max_candidates = 64
image_build_stage_timeout_secs = 1800  # 0 disables the subprocess bound
image_build_log_max_bytes = 1048576
image_build_retention_secs = 604800   # terminal build directories
```

Bounds: `image_max_concurrent_builds` in `[1, 8]`, grant expiry in
`[30, 3600]` seconds, `image_gc_interval_secs` either `0` or in `[60, 604800]`,
`image_gc_max_candidates` in `[1, 1024]`,
`image_build_stage_timeout_secs` either `0` or in `[30, 86400]`,
`image_build_log_max_bytes` in `[4096, 16777216]`, and
`image_build_retention_secs` in `[60, 31536000]`. The build workspace must be
private to the Server; never point it at a repository or a user directory.
The byte budget for one sweep is fixed at 512 MiB, in addition to the
candidate bound.

Missing, uncreatable or unwritable build storage fails the Server start closed.
There is deliberately no fallback to ephemeral Pod storage when durable storage
is required.

## Runtime prerequisites

- `mkfs.erofs` on the build host. Both Server and Agent images ship a pinned
  build of `erofs-utils` (`deploy/build-erofs-utils.sh`) because Debian
  bookworm's 1.5 package cannot run the V1 argv; Ubuntu CI test hosts install
  `erofs-utils` for the acceptance Case, and the ordinary Rust gates use a
  deterministic fake. The image build fetches the pinned source from the
  official erofs-utils GitHub tag archive — byte-identical to the upstream
  cgit snapshot and carrying the same SHA-256 — because the image runners
  cannot reach `git.kernel.org` (#3386). The script verifies the checksum, the
  top-level directory and the `VERSION` file before building, and reports
  network, integrity and revision failures as distinct states. The
  `runtime-image-tools` guard covers both the from-source and prebuilt image
  paths (#3178) and its self-test exercises those three failure states.
- Git with normal HTTPS support; no credential is required for a public source.
- Enough disk for one snapshot plus its image per concurrent build; the build
  root is durable execution state, not scratch.
- Exactly one active Server build manager per build root (V1 single-owner
  condition, enforced by the advisory lock).
- Docker Compose (`deploy/docker-compose.yml`) mounts `server-data` at
  `/data` and sets `NESSION_HOME=/data`, so the effective metadata DB
  (`/data/server/server.db`), image blobs (`/data/server/images/blobs`) and
  build workspace (`/data/server/images/build`) survive container
  recreation. `docker compose down -v` is the explicit storage-deletion
  operation. The retired Compose value `SERVER_DB_PATH` was never consumed
  by the entrypoint or the Server; do not reintroduce it (#3179).

## Non-goals

No OCI registry or layer snapshotter, no P2P distribution, no automatic refresh
of live Sessions when a branch moves, no custom script execution, no private
GitHub OAuth, and no image daemon inside the Sandbox. Digest dedupe is physical
only; Project authorization is always checked independently.

## Verification

- `cargo test -p nession-erofs` — source validation, shallow/tagless/committable
  snapshot, credential refusal, symlink escape refusal, fixed `mkfs` argv,
  deterministic fake builds, atomic/deduplicating store.
- `cargo test -p nession-server --lib image` — dedupe, alias revision, failed
  build state, Project/digest grant isolation, GC refs/leases/transfers,
  bounded/resumable GC with a byte budget, storage diagnostics, restart
  persistence, HTTP 200/206/403/404/416.
- `scripts/gitops-storage-contract.mjs` (Gate `gitops-storage-contract`)
  renders every managed GitOps environment and proves the Server registry,
  blobs and build workspace resolve under the environment's persisted NFS
  PV/PVC/subPath, with distinct effective roots per environment (#3180 SC-03).
- The `#3022` acceptance Cases run the real `mkfs.erofs` build and the exact
  command/store/HTTP assertions at the PR head.
