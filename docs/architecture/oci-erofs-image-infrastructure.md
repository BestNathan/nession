# OCI/EROFS image infrastructure

> Canonical owner of the OCI/EROFS image format, identity, content-addressed
> storage, catalog, distribution, cache and migration architecture
> ([#3494](https://github.com/BestNathan/nession/issues/3494)). This document is
> Phase 0 of the staged delivery graph in [Delivery DAG](#delivery-dag); the
> child Issues carry implementation acceptance.
>
> It supersedes the #3303 restriction that registry data-plane/domain models
> must stay outside `nession-erofs`; the no-reverse-dependency rule is retained.
> Current Server Image Manager behavior remains described by
> [Global EROFS Image Manager](erofs-image-manager.md) and the current Agent
> cache by [Agent EROFS cache](agent-erofs-cache.md). The v1 object model, CAS,
> catalog, distribution/cache and physical mount manager are delivered; Image
> Compose and Sandbox runtime mount composition are delivered by the children
> in [Composition and mount delivery](#composition-and-mount-delivery-3693).
> Where this document and an un-migrated deployment differ, this document is
> the contract, not evidence that a particular runner installed it.

## Ownership

| Responsibility | Owner |
|---|---|
| OCI Descriptor/Manifest/Config/Index model, validation and exact-byte import/export | `nession-erofs` (`src/oci`) |
| Content-addressed storage for Index/Manifest/Config/EROFS objects | `nession-erofs` (`src/blob`) |
| Repository/tag/reference graph, SQLite metadata schema/migration, GC | `nession-erofs` (`src/catalog`, `src/image/*`) executed inside the Server's SQLite transaction authority |
| Source adapters and EROFS conversion/publication | `nession-erofs` (`src/build`) driven by the existing #3334 async build lifecycle |
| OCI Distribution client (external registry pull/push) | `nession-erofs` (`src/registry`) |
| Server→Agent transfer engine and Agent verified cache | `nession-erofs` (`src/distribution`, `src/cache`) |
| FUSE mount primitive, physical mount leases | `nession-erofs` (`src/mount`) |
| Identity/authorization, Project/Session/tenant access policy, HTTP/WS/MCP entrypoints, ordering of Server operations | `nession-server` |
| Versioned wire DTOs (`ImageSource`, image descriptors, grants, selections) | `nession-protocol`; it does not duplicate the OCI object model |
| Agent identity, Session runtime, grant consumption and cache adapter | `nession-agent` |
| Sandbox policy, composition, environment application, execution records | `nession-sandbox` |
| Web/App Filesystem UX and target policy | existing #3405 owner; not redefined here |

Rules that follow from this table:

- `nession-erofs` does not depend on `nession-server`, `nession-agent`,
  `nession-sandbox` or `nession-protocol`. The Server validates wire DTOs and
  translates them into crate inputs at its adapter boundary; the Agent and
  Sandbox supply identity, roots and policy.
- Authorization happens before a catalog write or blob read. Knowing a digest
  is never authorization.
- The catalog is not a second Server state machine: it uses the Server's
  existing SQLite connection and transaction, and the Server keeps
  Project/Session authorization and orchestration.
- There is one OCI model. `nession-protocol` may carry opaque digests, media
  types and descriptors on the wire, but a second typed OCI implementation is
  forbidden.

## Two compositions, two output resources

"Composition" names two operations with different owners and different
outputs. They are not two names for one pipeline, and OverlayFS is not an Image
type or a third composition owner ([#3693](https://github.com/BestNathan/nession/issues/3693)).

| | EROFS Image Composition | Sandbox Runtime Composition |
|---|---|---|
| Canonical owner | `nession-erofs` image Build/Catalog, driven by the Server Image Manager | `nession-sandbox` `mount` domain, hosted by the Agent adapter |
| Input | One to sixteen **pinned catalog Image revisions**, validated destinations and merge rules | Authorized, already-prepared host views: verified EROFS files, an authorized Workspace upper/work or canonical directory, Sandbox targets and policy |
| Output | A **new immutable Manifest-addressed Image** published to the CAS/Catalog | One prepared `MountPlan` and the per-execution `MountedView` set; no Image, Manifest, Blob, Catalog row or grant |
| Data / mount identity | Manifest digest = Image revision. A raw layer digest or a referenced Composite descriptor/metadata digest identifies physical bytes. A Tag is an alias, never a runtime path. | The backend-derived host mountpoint plus generation identifies a physical view. The in-Sandbox target is a separate identity. A durable Workspace upper is Agent workspace data, not an EROFS Blob. |
| Lifetime | Persistent until no Tag, pin or lease reaches it and GC reclaims it | A consumer lease per execution. The one Workspace Overlay may outlive an execution, but its upper never becomes an Image. |
| APIs | Image Compose submission (`flattened` / `referenced`), catalog publication, distribution, grants and cache | `MountPlan`, `MountSource::{Erofs, Overlay, Bind}`, `MountBackend::acquire`, `MountedView`, `MountRecoveryBinding` and explicit release |
| Explicit non-goals | No process execution, no `/workspace` upper, no ENV/PATH precedence, no mount target policy | No CAS/Catalog publication, no Manifest creation, no second physical EROFS mount manager, no image build |

Rules that keep the boundary one-way:

- A Sandbox view may consume an Image Compose result exactly like any other
  Image. Runtime composition never changes that Image, and its own output is
  never publishable as an Image.
- `ErofsRoBackend` delegates physical read-only mounting, digest-keyed sharing,
  cache pins and recovery to `nession_erofs::mount_manager`. It must not
  reimplement them; `nession-erofs` must not depend on `nession-sandbox`.
- OverlayFS is a mechanism inside the Sandbox mount domain (persistent
  Workspace upper/work or an execution-owned transient RootFS upper/work). It
  is never an Image format or a `Manifest.layers[]` value. A referenced
  Composite is an Image format; it is not an Overlay.
- Image Config ENV/Entrypoint/Cmd/WorkingDir and `io.nession.*` annotations are
  read-only Image data. Sandbox policy owns the effective environment, PATH,
  targets and execution isolation.

## Object model and immutable identity

Four object kinds are stored as immutable, sha256-addressed blobs.

| Object | v1 media type | Role |
|---|---|---|
| OCI Image Index | `application/vnd.oci.image.index.v1+json` | Optional multi-platform selection |
| OCI Image Manifest | `application/vnd.oci.image.manifest.v1+json` | Image revision identity |
| OCI Image Config | `application/vnd.oci.image.config.v1+json` | Standard runtime configuration |
| EROFS image layer | `application/vnd.erofs` | Raw filesystem bytes (physical data identity) |

A descriptor carries `mediaType`, `digest`, `size` and the standard optional
`urls`, `annotations`, `platform`, `artifactType` and `data` fields. Unknown
optional fields are preserved. Every digest and size is computed from the exact
bytes and a descriptor's claim is verified against those bytes before the object
is consumed.

The two identities are deliberately distinct:

- **Manifest digest = image revision.** A Tag resolves to a Manifest/Index
  digest; a Session pins that digest.
- **EROFS layer digest = physical data.** Many Manifests can reference one
  EROFS blob; cache, dedupe and physical mount leases key on this digest.

Imported JSON is never reserialized and then presented as the original digest.
An imported Manifest/Config/Index keeps its exact source bytes and source
digest, including key order and unknown standard fields. Changing an annotation
or Config produces a new Manifest digest; an unchanged EROFS layer keeps its
digest and its bytes.

### Config and annotation split

The standard OCI Config owns `architecture`, `os`, `os.version`,
`os.features`, `variant`, `config.Env`, `config.Entrypoint`, `config.Cmd`,
`config.WorkingDir`, `rootfs` and `history`. The EROFS layer is the single raw
layer in `rootfs.diff_ids`, with `rootfs.type = "layers"`.

Only these annotations are Nession-specific:

- `io.nession.kind` — `base_runtime`, `tool` or `directory`;
- `io.nession.mount.default` — default mount target suggestion;
- `io.nession.path.prepend` — executable subdirectory suggestion relative to
  the actual mountpoint.

They are advisory metadata. They are not the image format classifier, they do
not make an invalid object valid, and they never grant an authorization or a
mount. `org.erofs.*` annotations are never silently reinterpreted as Nession
kinds, and there is no `io.nession.env.*`: runtime environment defaults live in
the standard Config.

### Supported v1 forms

V1 supports:

1. one raw `application/vnd.erofs` layer per Manifest;
2. a standard multi-platform Image Index whose child descriptors carry a
   matching `platform` and whose `os.features` includes `erofs`;
3. platform selection by the Agent's `os`/`architecture` (and `variant` when
   present) with an exact, deterministic match.

A missing match, an ambiguous match, an incomplete child descriptor or a
wrong-platform-only Index fails closed. An unsupported image is never replaced
with a compatible-looking substitute.

The following are rejected explicitly in v1, with precise errors, rather than
being guessed at or partially interpreted: zstd/compressed or otherwise
non-raw layers, multi-device EROFS, chunk-index/lazy variants, multiple layers,
and Overlay/role variants. Original input bytes are preserved where the storage
or import policy allows so a future version can adopt them.

### Image Compose (#3696)

A Compose build (`representation = "flattened"`, the default) consumes one to
sixteen **catalog** source Images and produces one new ordinary single-layer
EROFS Image. `representation = "referenced"` produces the multi-blob form
described in [Referenced multi-blob Composite](#referenced-multi-blob-composite-3697). Each source names its Repository, a
Tag or immutable digest, and a validated absolute destination prefix; the
Server resolves each reference to an immutable Manifest/Config/layer **once at
submission** and pins it for the build. Execution re-verifies those exact
identities, extracts each source with the pinned `fsck.erofs --extract`, merges
the trees under disjoint destinations with fail-closed duplicate/shadowing,
whiteout and symlink checks, scans the result once, and packages it with the
fixed `mkfs.erofs` argv. The result layer digest is a new physical identity;
the source layer digests are provenance, not the result. Config Env merges by
name with conflicts failing; commands/working directory are retained only when
every defining source agrees; conflicting advisory annotations fail. The
Manifest carries `io.nession.compose.format` and
`io.nession.compose.sources` provenance annotations (`io.nession.*` values are
advisory; they never authorize a mount). Whether the result is later referenced
by source blobs is a separate format owned by #3697, not a v1 Manifest-layer
shortcut.

### Referenced multi-blob Composite (#3697)

A referenced Composite reuses the pinned source EROFS bytes instead of copying
them. `mkfs.erofs` rebuild mode produces one **metadata EROFS** whose chunk
indexes reference the source images as external devices in the declared device
order. The immutable image identity is a standard OCI Manifest with exactly
one layer descriptor of media type
`application/vnd.nession.erofs.composite.v1+json`; that JSON names the
metadata device, the ordered backing devices, the platform and the pinned
packer identity (`erofs-rebuild-v1`, 4096-byte block/chunk, `mkfs.erofs`).

The Config is a documented Nession rootfs form:
`rootfs.type = "erofs-composite"` and `rootfs.diff_ids` equals the metadata
digest followed by the backing device digests. The Manifest still has one
layer descriptor, so this is not a multi-layer OCI claim; the descriptor
closure is verified against catalog rows and CAS bytes before any publication
or mount.

Rules:

- every source must be block-addressed (no inline file data); an unsupported
  source layout makes the pinned rebuild fail closed with an explicit
  compatibility diagnostic;
- every source tree layers at the composed root; destination prefixes are
  refused for this representation;
- a path owned by two sources, a file-vs-directory mismatch, special files,
  overlay whiteouts and escaping symlinks fail before publication;
- the metadata image must carry `chunked_file` + `device_table` and declare
  exactly the expected extra-device count;
- catalog edges are `manifest → composite → metadata/device`; GC retains every
  reachable backing blob while a Tag or live pin reaches the Manifest;
- Server→Agent grants carry the whole closure; the Agent cache verifies and
  pins the metadata and every device for the physical mount lifetime;
- `nession-erofs::mount_manager` keys the physical view by the Composite
  descriptor digest (never a data Blob digest), passes `erofsfuse
  --device=<path>` in closure order and records that closure in the durable
  mount identity;
- Sandbox runtime composition of a Composite is explicitly out of scope for
  #3697 (not a prerequisite for runtime multi-lower work); selecting one in the
  current Sandbox composition fails closed.

v1 single-layer images remain unchanged and supported.

Validation verifies the object schema, media types, digest and size, the
Manifest's Config descriptor, `rootfs.diff_ids` equality with the EROFS layer
digest, and Index child descriptors. A validation failure never produces a
partially published object.

## Storage layout

### Server

```text
<image_blob_dir>/sha256/<hex>     # Index, Manifest, Config and EROFS bytes
<image_blob_dir>/.tmp/<uuid>      # private publication temp files
<image_build_dir>/...             # #3334 durable build root (unchanged)
<server SQLite database>          # catalog metadata tables
```

All four object kinds are stored by digest with no extension or type suffix in
the filename. Publication writes a private temporary file in the same store,
fsyncs it and renames it into place. Publishing an object that already exists
re-verifies its digest and byte count instead of trusting the filename. A
partial or failed publication is never visible as a ready object.

The catalog metadata (repository, mutable tag, descriptor reference edges,
pins, build/transfer grants, leases and GC marks) lives in the Server's
existing SQLite database and is written through the same connection and
transaction authority the Server already owns. `nession-erofs` owns the schema,
migration and catalog logic; it does not open a second database, start a
second scheduler or keep mirrored image state. Immutable JSON bytes stay in the
CAS; database rows are transactional indexes over them.

Publication order is fixed:

1. verify and publish the EROFS blob;
2. verify and publish the Config;
3. verify and publish the Manifest (and Index when present);
4. validate the parent/child descriptor edges;
5. atomically move the Tag with the expected previous Manifest digest.

An object is exposed as ready only after the whole chain and its edges are
committed. A concurrent Tag update whose expected old digest no longer matches
fails instead of overwriting. Moving a Tag never changes an already pinned
Manifest for a Session.

### Agent

```text
<storage_dir>/agents/<identity>/sha256/<hex>      # verified cached objects
<storage_dir>/agents/<identity>/tmp/<hex>.part    # resumable download
<agent runtime state>/mounts/...                  # physical lease state
```

The existing per-identity namespace and the existing `sha256/` cache paths are
preserved. Index, Manifest, Config and EROFS files all follow the same
verify-before-ready rule; a warm hit is re-hashed before reuse. Manifest/Config
metadata is cached separately from the EROFS payload, so two Manifests sharing
one payload perform one payload download and produce one physical cache file.
Mount leases are keyed by the EROFS layer digest, not the Manifest digest, so
two Configs can share one physical mount. Registry credentials never reach the
Agent.

## Publication and source conversion

Source adapters are selected by an explicit source declaration, never by an
optional annotation:

- Git and local directory sources keep the existing non-executing snapshot and
  deterministic `mkfs.erofs` path;
- catalog Image Compose (#3696/#3697) is an explicit source adapter: it
  resolves and pins Repository references, and publishes either a fresh
  flattened single-EROFS Manifest (`fsck.erofs --extract` staging) or a
  referenced metadata EROFS plus its verified backing closure (`mkfs.erofs`
  rebuild); it never treats a digest as authorization;
- archive/HTTPS/GitHub Release inputs are bounded downloads with checksum
  verification and path-safe extraction (no traversal, escaping links, devices
  or hardlink escapes) and never run install scripts;
- an upstream OCI container image may be converted by a pinned external
  OCI→EROFS converter for a pinned platform and source digest. The generated
  Config carries fresh EROFS `rootfs.diff_ids` and retained standard Env; a
  missing converter or unsupported source fails explicitly;
- an already-built raw EROFS file or OCI EROFS artifact is validated and
  published byte-for-byte without a filesystem rebuild.

Every publication records normalized source, platform, pinned upstream
digest/Git SHA, converter/mkfs tool identity, EROFS SHA and Manifest SHA, with
an observable failure reason. It reuses the accepted #3334 build worker,
stages, progress and cancel/retry mechanics; there is no second build database
or async scheduler.

## Distribution, authorization and transfer

The Server resolves Repository/Tag/Index to a pinned Manifest using the
requesting Agent's supported platform and the `erofs` feature. A Tag never
reaches runtime unresolved.

The Server remains the sole authority for Project/Session/tenant image access.
It grants transfer by the resolved Manifest and narrowly scoped reachable
descriptors (or an explicit authorized descriptor set), not by knowledge of a
digest. Grant issuance and the HTTP route are Server adapters; the digest-scoped
transfer engine lives in the crate.

Transfers keep the accepted mechanics: authenticated HTTP `Range`/`ETag`,
resumable partials, SHA-256 verification before a file becomes ready,
concurrent single-flight downloads and the #3412 per-digest progress owner. An
interrupted transfer, duplicate request or process restart yields only fully
verified ready files; unverified bytes are never mounted or evicted while
active leases/pins exist.

An external OCI Distribution client (pull/push) lives in `nession-erofs`. It
supports registry challenge/token authentication, bounded redirects and hosts,
scoped credentials from a Server-owned secret source, and explicit errors for
401/403, 404, digest mismatch, unsupported platform and malformed Manifest. It
does not implement a `/v2/` Registry server, does not unpack tar layers and
does not hand registry credentials to the Agent. OCI→EROFS source conversion
belongs to the publication phase, not to the registry transport.

## Legacy migration, GC, failure and rollback

Historical #3022 state is an alias/Image row keyed to an EROFS Blob digest.
Migration synthesizes one standard single-layer Config and Manifest per legacy
Blob **without rebuilding, moving or rewriting EROFS bytes**, keeps the legacy
alias mapping stable, and makes existing digest-pinned Project, Managed
Session and Sandbox references resolve. Legacy `Image` rows stay readable for
rollback; a failed migration transaction rolls back wholly and exposes no
broken reference. #3334 directory-backed build Jobs and #3180 PVC semantics are
preserved.

GC roots are all tags, live Project/Session pins, unexpired leases,
active build/publish/transfer grants and mount consumers. The sweep is
mark → bounded grace → recheck → bounded deletion, retryable after crash or
restart and safe against concurrent publishing: a concurrently published
object cannot be orphaned by a sweep that started earlier. Server GC and Agent
cache eviction are distinct owners with distinct roots.

Publication and migration failures leave at most private temporary files. An
incomplete object is never Ready, a failed Tag CAS never overwrites the current
Tag, and a rollback never exposes a half-migrated reference.

## Runtime consumption and compatibility

A usage resolver reads standard Config `Env`, `Entrypoint`, `Cmd`,
`WorkingDir` and the optional Nession annotations and exposes typed read-only
suggestions. It does not execute the entrypoint, own Sandbox policy or replace
the workspace.

- `io.nession.kind` informs UI defaults/filter hints only; it never changes
  object validity or authorizes a mount.
- `io.nession.mount.default` proposes a target; policy and validation belong to
  the #3405/#3449 owners, and unsupported targets fail closed.
- `io.nession.path.prepend` is resolved relative to the actual mountpoint
  (mount `/opt/go` + `bin` → `/opt/go/bin`; an overridden `/tools/go` →
  `/tools/go/bin`). Absolute paths, `..`, unsafe overlaps and forbidden targets
  are rejected before an Agent starts.

Standard Config Env is a bounded default. Explicit Session/Sandbox ENV
overrides it deterministically; Base Config defaults sit below enabled tool
defaults; equal-precedence tool conflicts need an explicit deterministic rule
and sandbox-owned security-sensitive variables stay protected. The executable
rule is: identical tool defaults dedupe, different values fail closed; `PATH`,
loader, shell-startup, proxy, host-control-socket and `NESSON_*` keys fail
closed; terminal/locale/home variables are dropped because the execution owns
them; `PATH` comes only from the resolved `path.prepend` directories below
validated mount targets. Mounts and the resulting environment are established
before the Coding Agent process starts. An already running process never
receives a retroactive mount or PATH change; adopting a new image binding
requires re-enter/restart.

The physical mount manager remains keyed on the EROFS blob digest (#3449); a
referenced Composite is keyed on its Composite descriptor digest and pins the
whole device closure. Two Manifests sharing one payload share one physical
mount but can have distinct Env and targets; a pinned running Session keeps its
Manifest after a Tag moves. Runtime composition of these views belongs to the
Sandbox mount domain; see
[Sandbox policy and execution isolation](sandbox-policy-and-execution.md#typed-mount-plan-and-backends-3695).

## Delivery DAG

The graph is acyclic and has one owner per deliverable. Child Issues carry
implementation acceptance; no child re-imposes full regression on another.

```text
#3494 Phase 0 (this document)
  └─ #3495 A: OCI/EROFS object model and validation
       └─ #3496 B: CAS, catalog, tags, reference graph, GC, migration
            ├─ #3497 C: source conversion and Manifest publication
            ├─ #3498 D: external OCI Registry pull/push (parallel with C)
            └─ #3499 E: Manifest-aware Server→Agent distribution and cache
                 └─ #3500 F: Sandbox Config Env and mount annotations
```

| Phase | Issue | Predecessors | Deliverable | Verification owner |
|---|---|---|---|---|
| 0 | #3494 | none | This canonical architecture, ownership and migration reference | Architecture/source review at the exact PR SHA; `cargo tree`/Cargo boundary check |
| A | #3495 | #3494 | Standard Index/Manifest/Config/Descriptor parse, validate, exact bytes | Deterministic OCI JSON fixtures and PR-SHA Rust tests (SCN-01) |
| B | #3496 | #3495 | CAS, Catalog, Repository/Tag, reference graph, SQLite migration, GC | SQLite/Blob concurrency tests at PR head; trusted staging persistence Cases (SCN-01/04) |
| C | #3497 | #3495, #3496 | Git/local/archive/OCI-source EROFS publication through the existing build lifecycle | Deterministic source fixtures; Linux CI conversion/EROFS verifier (SCN-01/03) |
| D | #3498 | #3495, #3496 | External OCI Distribution pull/push and ORAS interoperability | Disposable local registry/ORAS CI fixtures; staging auth-boundary Case (SCN-01/03/04) |
| E | #3499 | #3495, #3496; fixtures from C or D | Manifest-aware Server→Agent distribution and physical blob cache reuse | HTTP/cache/protocol fixtures; trusted staging Server–Agent Case (SCN-01/03/04) |
| F | #3500 | #3495, #3499, #3449; coordinate #3405 | Sandbox mount defaults, Config Env, relative PATH, Session pinning | Linux Sandbox launch/PATH/env tests; trusted staging mount/lease Case (SCN-03/native) |

Critical path: **#3495 → #3496 → #3499 → #3500**. After #3496, #3497 and
#3498 run in parallel. #3499 may start against local fixtures; completion must
cover produced and imported images. No implementation may bypass the catalog
and assume the EROFS blob digest is still image identity.

Integration order: (1) pure format and CAS tests; (2) producer/registry
conformance and import/export tests; (3) Server/Agent pinned Manifest and
transfer tests; (4) native Sandbox mount/ENV and lease tests;
(5) persistence/recovery/GC. Reuse #3022, #3303, #3334, #3449, #3412, #3405,
#3180 and #3062 as the accepted baselines; do not reopen them merely because
this architecture expands their scope.

## Composition and mount delivery (#3693)

The Image-Compose and runtime-composition children are separate Requirements so
one can be verified without waiting for the other:

```text
#3693 architecture boundary (this contract)
  ├─ #3695 MountPlan/MountBackend and Workspace Overlay ownership migration
  │    └─ #3698 runtime ordered multi-lower and opt-in writable RootFS
  └─ #3696 flattened Image Compose (self-contained raw EROFS)
       └─ #3697 referenced multi-blob Image Compose (metadata + device closure)
```

`#3698` does not depend on `#3697`: runtime multi-lower consumes ordinary
single-layer Images and must not wait for the referenced Composite format.
`#3697` does not depend on `#3695`: its physical mount support belongs to
`nession_erofs::mount_manager`, which already owns digest-keyed leases.

| Child | Delivery PR | PR-stage evidence | Native Linux proof |
|---|---|---|---|
| [#3695](https://github.com/BestNathan/nession/issues/3695) | PR [#3725](https://github.com/BestNathan/nession/pull/3725) at `0d8fda4825829f2ad64eb4cfc0192d2e15fa07f8` | Agent run `43852186904` at `9cad89f59b91ad873b108aaf93e77051b18ab08a` (SC-01/SC-04) | Acceptance / Cases run `43853127951` at `0d8fda48` (SC-02/SC-03) |
| [#3696](https://github.com/BestNathan/nession/issues/3696) | PR [#3703](https://github.com/BestNathan/nession/pull/3703) at `fbc4aa2e4faa8e03040f42b3d492c969d906bde4`; Case setup PR [#3710](https://github.com/BestNathan/nession/pull/3710) at `e84fb5dfb92e2442984d28ba0143883834ad1616` | Agent run `43815815870` at `10c3e3f3fe03d688fb69cf515f659a4101b51429` (SC-01/SC-02) | Acceptance / Cases run `43813771715` at `e84fb5df` (SC-03) |
| [#3697](https://github.com/BestNathan/nession/issues/3697) | PR [#3709](https://github.com/BestNathan/nession/pull/3709) at `47507cf4368dce4ece012a7b10088146b8133f6d`; repairs PRs [#3713](https://github.com/BestNathan/nession/pull/3713), [#3714](https://github.com/BestNathan/nession/pull/3714), [#3715](https://github.com/BestNathan/nession/pull/3715) at `67c3533e9fd51e66bb325d8c1f3434b24a0c3abd` | Agent run `43818068382` at `dd69c927fe13798fb6f1dbd3d33e765551660daa` (SC-01) | Acceptance / Cases run `43822627408` at `67c3533e` (SC-02/SC-03) |
| [#3698](https://github.com/BestNathan/nession/issues/3698) | PR [#3736](https://github.com/BestNathan/nession/pull/3736) at `5434c99158330729032ecb28b804baf863be8992`; follow-up PR [#3741](https://github.com/BestNathan/nession/pull/3741) at `5e9e853ab8b52f836a4af0b4fcacb2a213a9d76e` | Agent run `43875307694` at `9ba3a457499f51d55c8d69547aa6bb6fcaac6d0d` (SC-04) | Acceptance / Cases run `43877231534` at `5e9e853a` (SC-01/SC-02/SC-03) |

Legacy compatibility and proof ownership:

- A v1 single-layer Image remains valid and mountable. The Compose and
  Composite forms are additive; #3494 is not reopened.
- A pre-#3698 `workspace.image` declaration decodes as a one-element ordered
  lower set, and the legacy `OverlayBinding`/execution-record fields remain
  readable. No reader requires the new ordered fields; the new writer fills
  both the legacy first-lower fields and the ordered set.
- #3582 durable Workspace `upper`/`work` paths, owner lock, generation,
  mountinfo and restart adoption are preserved; the ownership move changed the
  module, not the on-disk layout or the algorithm.
- Native Linux behaviour is owned by the child staging Cases above (real
  `erofsfuse`/`fuse-overlayfs`, mountinfo, restart and fault injection). This
  architecture document and the Knowledge articles are not kernel evidence.

## Cargo and module boundaries

Target module ownership inside `nession-erofs`:

| Module | Owns |
|---|---|
| `oci/` | Descriptor, Manifest, Config, Index, annotations, validation, OCI layout |
| `blob/` | digest and general CAS store |
| `catalog/` | repository, tag, reference graph, SQLite schema/migration, GC |
| `image/` | publish, resolve, inspect |
| `build/` | EROFS, Git, local, archive and OCI-source publication |
| `registry/` | OCI Distribution client, auth, pull, push |
| `distribution/` | Server→Agent HTTP transfer engine |
| `cache/` | Agent fetch/resume/verify and eviction |
| `mount/` | FUSE primitive and physical mount lease manager |

The direction of dependency is one-way: `oci` and `blob` are foundational;
`catalog`, `build`, `registry`, `distribution`, `cache` and `mount` consume
them where needed. `nession-server`, `nession-agent`, `nession-sandbox` and
`nession-protocol` depend on the crate; the reverse edge is forbidden. The
catalog receives a transaction from the Server's SQLite authority rather than
opening its own database. The crate continues to expose cargo features so a
consumer compiles only the mechanics it uses (Server: build/store/catalog;
Agent: cache/distribution/mount; Sandbox: mount).

## Non-goals

No Dockerfile, generic software installer or container runtime; no execution of
OCI `Entrypoint`/`Cmd`; no full `/v2/` OCI Registry server; no tar layer
unpacking; no new background job queue; no second image database or mirrored
state; no compressed/chunk-index/lazy EROFS variants in v1; the referenced
multi-blob Composite is its own descriptor layer and is never expressed as an
arbitrary OCI `Manifest.layers[]` union; no
registry credentials in images, EROFS, Agent grants or logs; no automatic
re-mount of a running process.

## Verification

Phase 0 is verified by documentation review and the cargo boundary, not by
inventing a new Gate:

```bash
cargo metadata --no-deps --format-version 1   # workspace members and edges
cargo tree -p nession-erofs --edges normal    # no nession-server/agent/sandbox/protocol
rg -n '^nession-(server|agent|sandbox|protocol)' crates/nession-erofs/Cargo.toml
```

Child phases add their own Gate/test/Case evidence at the exact PR or staging
SHA; the [Delivery DAG](#delivery-dag) table names the verification owner for
each. The architecture document itself is checked against the implementing PR
SHA when a child changes a decision recorded here; a decision change updates
this document instead of spawning a competing explanation.

## References

- OCI Image Spec — <https://github.com/opencontainers/image-spec>
- EROFS Image Spec — <https://github.com/erofs/erofs-image-spec/blob/main/spec.md>
- [Global EROFS Image Manager](erofs-image-manager.md) — current Server behavior
- [Agent EROFS cache](agent-erofs-cache.md) — current Agent cache behavior
- [Sandbox filesystem declaration model](sandbox-filesystem-policy.md)
- [Sandbox policy and execution isolation](sandbox-policy-and-execution.md)
- [#3693](https://github.com/BestNathan/nession/issues/3693) — owner decision
  separating Image Compose output from Sandbox runtime composition
