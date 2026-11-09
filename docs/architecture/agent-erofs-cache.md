# Agent EROFS image cache

> Durable, digest-addressed cache for Server-owned EROFS images (#3023).
> Upstream: [Global EROFS Image Manager](erofs-image-manager.md),
> [Project declaration](project.md), [Sandbox policy](sandbox-policy-and-execution.md) and the
> Agent runtime instructions in `crates/nession-agent/AGENTS.md`.

## Ownership

The Server Image Manager owns image identity, bytes, aliases and grants. The
Agent owns only a **local cache of bytes the Server has already authorized**.
The Agent never builds, tags or resolves a logical image itself:

```text
Server: logical image -> immutable sha256 digest -> scoped bearer grant
Agent:  digest -> persistent cache -> (miss) bounded Range download -> verify -> publish
```

A Project references a digest; a Session/consumer asks the Server for a grant;
the Agent caches the exact bytes under that digest. Sandbox never treats the
cache as a rootfs or mounts it; EROFS kernel mounting is separate (#3024).

## Configuration and precedence

```toml
[erofs]
storage_dir = "/data/erofs"   # optional, absolute
```

Resolution, highest precedence first:

1. explicit `[erofs] storage_dir` in the Agent TOML;
2. `NESSION_EROFS_STORAGE_DIR` when the TOML has no value;
3. `$NESSION_HOME/erofs` when `NESSION_HOME` is set and absolute;
4. the native default: `/var/lib/nession/erofs` on Linux, `$HOME/.nession/erofs`
   elsewhere.

There is no `/tmp`, current-directory or container-writable-layer fallback.
The effective path must be absolute and may not contain `..`.

An explicit path is a **durable-location declaration**. On Linux the Agent
reads `/proc/mounts` and refuses `tmpfs`, `ramfs`, `overlay`, `aufs`,
`devtmpfs`, `proc`, `sysfs` and cgroup filesystems; it also refuses a path it
cannot create, stat, write (a real probe file with `fsync`) or whose ownership
does not match the effective user (when not root). An implicit default is a
development convenience and does not claim a PVC.

## Cache layout and lifecycle

```text
<storage_dir>/sha256/<64-hex>      verified immutable blob
<storage_dir>/tmp/<64-hex>.part    in-progress download (resumable)
```

- **Cold fetch.** The Agent sends `GET` with the bearer grant and
  `Accept-Encoding: identity`, streams the body in 64 KiB chunks to the `.part`
  file, computes SHA-256 over the complete file, and only after a match
  `fsync`s and atomically renames it to `sha256/<hex>`. A mismatch removes the
  partial file and never publishes a ready blob.
- **Warm hit.** The existing blob is re-hashed before reuse. A verified hit
  performs **zero image-body transfers**; a corrupted file is removed and
  fetched again.
- **Concurrency.** One in-process lock per digest means N concurrent callers
  share one fetch; callers that waited re-check the published blob.
- **Resume.** An existing `.part` is sent as `Range: bytes=<len>-`; `206`
  appends, `200` restarts from zero, `416` discards the partial and asks the
  caller to retry. A failed/interrupted download leaves a `.part` that a later
  call can resume.
- **Restart.** The cache is a directory, not memory: a new Agent process with
  the same storage directory re-reads `sha256/<hex>`, verifies it, and reuses
  it. Partial files older than 24 hours are reconciled (deleted); newer ones
  are resumable.
- **Pinning/eviction.** A consumer pins a digest for the duration of its use;
  eviction refuses a pinned digest. No mounted resource is deleted by the cache
  (mounting is #3024).
- **Bounds.** One chunk is buffered at a time; there is no whole-image memory
  buffer. The HTTP client has a 15 s connect and 30 min total timeout.

## Container and Kubernetes contract

- `Dockerfile.agent` and `Dockerfile.agent.prebuilt` create `/data` and
  `/data/erofs`. An OCI `VOLUME` is **not** a PVC: without a mounted durable
  volume, `/data` is part of the container writable layer and disappears with
  the container.
- The GitOps Agent Deployment (`gitops:base/nession/deployment-agent.yaml`)
  mounts the **existing** `nession-server-data` PVC at `/data`, keeps
  `NESSION_HOME=/data`, and sets `AGENT_EROFS_STORAGE_DIR=/data/erofs`. It does
  not create a second PVC, replace the PVC, or move Server/Claude-home/Session
  data paths.
- `deploy/entrypoint-agent.sh` writes the optional `[erofs] storage_dir` into
  the generated Agent config; an explicit TOML value wins over the environment.
- A Kubernetes NFS PVC is suitable for immutable EROFS **bytes**. It is not
  automatically suitable for OverlayFS upper/work or an EROFS kernel mount;
  that decision belongs to Sandbox/managed-location work (#3024).

## Failure semantics

- Missing, non-writable, wrongly owned or (for an explicit path) ephemeral
  storage is a startup/open error. The Agent never silently redirects the cache
  to the container layer or tmpfs.
- A grant is single-digest and expiring; a `403`/`404` is surfaced, never
  retried as an anonymous download.
- A corrupted or partial blob is never returned as a cache hit and never handed
  to a mount/build consumer.
- Losing the cache is recoverable by re-downloading the immutable digest; it
  never changes the image identity.

## Verification

- `cargo test -p nession-agent --lib config::erofs_tests` — precedence,
  absolute/parent rejection, NESSION_HOME default.
- `cargo test -p nession-agent --lib erofs_cache` — cold/warm, concurrent
  single fetch, resume, corruption/mismatch, pin/eviction, stale partial, and
  fail-closed explicit tmpfs/unwritable storage.
- `e2e/acceptance/cases/3023/SC-01`, `SC-03` and `SC-04` run those exact tests
  at the PR head; SC-02's trusted agent reads this document, the Dockerfiles and
  the GitOps snapshot.
- SC-05 (a controlled Kubernetes Pod-delete/recreate fixture on the same PVC)
  is **Pending**: its staging Case binds the exact SHA and records that no
  trusted K8s Case lane exists and that ephemeral cluster/PVC provisioning does
  not fit the standard verifier budget. It is not claimed as live proof.
