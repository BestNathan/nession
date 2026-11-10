# Global EROFS Image Manager

> Owner of immutable EROFS image builds, content-addressed bytes, aliases and
> authorized blob access ([#3022](https://github.com/BestNathan/nession/issues/3022)).
> Upstream model: [#3021 Project](project.md), [product-model.md](../design/product-model.md),
> [agent-process-discovery.md](agent-process-discovery.md) for the Agent/Server
> trust style this follows.

## Ownership

EROFS is a **global immutable resource**, not a `ProjectEnvironment`.

| Thing | Owner |
|---|---|
| Image metadata, digest, bytes, aliases, leases, access grants | Server Image Manager (`crates/nession-server/src/image`, `crates/nession-erofs`) |
| `image_digest` reference on a Project | Project declaration (`projects.image_digest`) |
| Build worker and `mkfs.erofs` | Server Image Manager |
| Sandbox policy | `nession-sandbox`; it never clones Git or manages a registry |
| Runtime provisioning / mounting | Follow-up managed-location and Sandbox work (#2681, #3024) |

A Project only references a digest. Deleting a Project never deletes shared
bytes, and two Projects may reference one physical image.

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

## Server protocol units

| Unit | Policy | Meaning |
|---|---|---|
| `server.image.build` | Inline | Validate a source, run the bounded worker, return the ready/failed descriptor |
| `server.image.list` | Query | Newest builds first, bounded |
| `server.image.get` | Query | Exactly one of `digest` or `alias` |
| `server.image.access` | Inline | Mint a Project-scoped, expiring bearer grant for one digest |

All four require an authenticated client. The contract types and validation
live in `nession-protocol::contracts::image::v1`.

## Authorized blob HTTP

The existing Server listener sniffs one HTTP request head and routes
`/images/blobs/<digest>` to the image service before WebSocket/MCP handling.
The service accepts `GET`/`HEAD` and requires:

```http
Authorization: Bearer <grant token>
```

The token is random, stored only as SHA-256, expires (default five minutes),
and is bound to one `(project_id, digest)`. `server.image.access` mints it only
when the named Project durably references that digest. Knowing another
Project's digest therefore does not authorize its bytes.

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
only after the digest is computed from stored bytes, and becomes `failed` with
a bounded error if the worker fails. Failed and stale `building` rows are never
offered as bytes.

GC removes:

- failed rows;
- `building` rows older than the stale threshold;
- ready rows (and their blob) only when **no** Project references the digest,
  no alias points at it, no unexpired lease exists, and no in-process transfer
  is active.

Expired access grants and leases are pruned on GC. Restarting the Server keeps
image metadata, aliases and Project references because all of it is in SQLite;
blob bytes are already on disk under their digest.

## Configuration

```toml
image_blob_dir = "~/.nession/server/images/blobs"
image_build_dir = "~/.nession/server/images/build"
image_max_concurrent_builds = 2
image_access_token_expiry_secs = 300
```

Bounds: `image_max_concurrent_builds` in `[1, 8]`, grant expiry in
`[30, 3600]` seconds. The build workspace must be private to the Server; never
point it at a repository or a user directory.

## Runtime prerequisites

- `mkfs.erofs` on the build host. Both Server images ship a pinned build of
  `erofs-utils` (`deploy/build-erofs-utils.sh`) because Debian bookworm's 1.5
  package cannot run the V1 argv; Ubuntu CI test hosts install `erofs-utils`
  for the acceptance Case, and the ordinary Rust gates use a deterministic
  fake. The `runtime-image-tools` guard covers both the from-source and
  prebuilt image paths (#3178).
- Git with normal HTTPS support; no credential is required for a public source.
- Enough temporary disk for one snapshot plus its image per concurrent build.
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
  restart persistence, HTTP 200/206/403/404/416.
- The `#3022` acceptance Cases run the real `mkfs.erofs` build and the exact
  command/store/HTTP assertions at the PR head.
