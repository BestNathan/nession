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
> [#4086](https://github.com/BestNathan/nession/issues/4086) extends this
> architecture with peer-capable Store/Registry nodes: every Server and Agent
> may own a local verified CAS, mount the same standard OCI Distribution
> Registry service and use the same Registry Client SDK. That extension is
> specified in [Peer-capable Store and Registry topology](#peer-capable-store-and-registry-topology-4086)
> and delivered by children #4087–#4091; it does not reopen the accepted
> #3494/#3495/#3496/#3498/#3499 evidence.
> Where this document and an un-migrated deployment differ, this document is
> the contract, not evidence that a particular runner installed it.

## Ownership

| Responsibility | Owner |
|---|---|
| OCI Descriptor/Manifest/Config/Index model, validation and exact-byte import/export | `nession-erofs` (`src/oci`) |
| Content-addressed storage for Index/Manifest/Config/EROFS objects; reusable `BlobStore` read/write/exists/verify contract (#4087) | `nession-erofs` (`src/blob`) |
| Repository/tag/reference graph, `RepositoryStore` reachability contract, SQLite metadata schema/migration, GC | `nession-erofs` (`src/catalog`, `src/image/*`); the SQLite catalog executes inside the Server's SQLite transaction authority, the Agent projects the same contract from its verified local references (#4087) |
| Source adapters and EROFS conversion/publication | `nession-erofs` (`src/build`) driven by the existing #3334 async build lifecycle |
| Host-independent OCI Distribution Client SDK: pull/push, tag→digest resolution, verified multi-source CAS ingest (#4089) | `nession-erofs` (`src/registry`) |
| Mountable standard OCI Distribution Registry service (`/v2/`, read-only or push-enabled) over a supplied Store/Repository/authorizer (#4088) | `nession-erofs` (`src/registry` service module) |
| Server→Agent transfer engine and Agent verified cache | `nession-erofs` (`src/distribution`, `src/cache`) |
| FUSE mount primitive, physical mount leases | `nession-erofs` (`src/mount`) |
| Identity/authorization, Project/Session/tenant access policy, HTTP/WS/MCP entrypoints, ordering of Server operations | `nession-server` |
| Server Registry mount, official catalog policy, authorized external import, endpoint advertising (#4090) | `nession-server` adapter over the crate contracts |
| Versioned wire DTOs (`ImageSource`, image descriptors, grants, selections) | `nession-protocol`; it does not duplicate the OCI object model |
| Agent identity, Session runtime, grant consumption, cache adapter, optional opt-in read-only Registry adapter and peer source selection (#4090/#4091) | `nession-agent` |
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
two Configs can share one physical mount. The Server's global registry
credentials never reach the Agent; approved peer/external fetches under #4086
use only Agent-scoped credentials or short-lived grants.

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

The OCI Distribution Client SDK (pull/push) lives in `nession-erofs`. It
supports registry challenge/token authentication, bounded redirects and hosts,
scoped credentials from a caller-owned secret source, and explicit errors for
401/403, 404, digest mismatch, unsupported platform and malformed Manifest. It
does not unpack tar layers. OCI→EROFS source conversion belongs to the
publication phase, not to the registry transport.

Under #4086 the client is host-independent: the Server uses it to import
authorized external sources into its own CAS/Catalog, and an Agent may use the
same SDK against approved Server/peer/external Registries with its own scoped
credentials. The reusable `/v2/` Registry **service** is a separate crate
module (#4088), not part of the client. The accepted #3498 rule that the
Server's global registry credentials never reach an Agent still holds: an
Agent receives only repository-scoped credentials or short-lived grants for
explicitly approved sources, never the Server's secret source itself. The
proprietary `/images/blobs/{digest}` transfer path remains during the #4090
migration window; the steady-state data path is standard OCI Distribution.
See [Peer-capable Store and Registry topology](#peer-capable-store-and-registry-topology-4086).

## Peer-capable Store and Registry topology (#4086)

[#4086](https://github.com/BestNathan/nession/issues/4086) changes the topology
from Server-authoritative transfer to reusable Registry nodes over a shared
CAS contract. Every Nession Server/Agent may independently (a) own a local
verified CAS, (b) mount the same standard OCI Distribution Registry service,
and (c) use the same OCI Registry Client SDK to pull/push as authorized. The
Server is not a mandatory image data hop. This is new scope layered on the
accepted #3494–#3500 delivery, not a regression reopening it.

### Shared Store contracts (#4087)

Three reusable contracts in `nession-erofs`, consumed by both hosts:

| Contract | Responsibility |
|---|---|
| `BlobStore` | Content/sha256-addressed bytes: read, write, exists, verify-stream. Atomic private-temp publication, dedupe of identical digests without rewriting bytes, re-verification of preexisting objects. Reuses `blob::store`; no parallel CAS implementation. |
| `RepositoryStore` | Determines accessible Manifests/Tags and the **complete reachable blob closure** of a repository. The Server implements it over the SQLite catalog; the Agent implements it as a projection of its verified local references (grants and cached Manifest closures). |
| `RegistryAuthorizer` | Gates pull/push/list actions per principal, repository and scope. Injected by the host; never a bypassing global token. |

Delivery status: `BlobStore`/`RepositoryStore` and the shared repository/tag
grammars are delivered by #4087 in `nession-erofs::contracts`, with the Server
adapters `FsBlobStore`/`CatalogRepositoryStore` and the Agent adapters
`CacheBlobStore`/`CacheRepositoryStore`. `RegistryAuthorizer` is delivered with
the Registry service (#4088). Contract reads are raw streaming access gated by
explicit verification before consumption; the Agent adapter is stricter and
verifies on read. Removal/eviction is deliberately absent from `BlobStore`:
retention belongs to the owning host's policy, so a shared Registry reader can
never reclaim another owner's pinned or transferring bytes.

Rules:

- A local Store is either **authoritative/persistent** (Server CAS + catalog)
  or a **re-fetchable Cache** (Agent verified cache). A Cache is a Store plus
  fetch/retention policy — not a second incompatible byte-store protocol.
  Object format, digest identity and verify-before-ready rules are identical.
- Pin, lease and eviction policies are independent per host. Cache eviction
  may reclaim unpinned re-fetchable objects but never pinned, actively mounted
  or transferring objects; GC never crosses ownership namespaces (Server
  catalog roots vs the Agent per-identity namespace).
- Repository reachability and verified complete closure gate blob reads. A
  raw CAS directory must never be published as a globally accessible
  Registry, and the adapter must not invent repository aliases for unrelated
  cached blobs. Possessing a digest is never authorization.
- A cache miss is distinct from an authorized-but-nonexistent repository
  object; the Registry boundary maps them to distinct OCI error semantics.
- Agent identity namespaces and single-flight partial-write ownership stay
  safe on shared volumes. Composite closure is explicitly represented or
  treated unsupported — never silently truncated.

### Mountable Registry service (#4088)

A reusable Axum/Tower-mounted OCI Distribution `/v2/` service, independent of
host identity, mounted on the host's existing HTTP ingress — no extra accept
loop and no second authorization state machine (#3439). It is supplied the
host's `BlobStore`, `RepositoryStore` and `RegistryAuthorizer`.

- Pull surface: `GET /v2/`, `GET/HEAD /v2/{name}/manifests/{ref}`,
  `GET/HEAD /v2/{name}/blobs/{digest}`, `GET /v2/{name}/tags/list`, with
  correct digest, media-type/Accept negotiation, Range/ETag, repository scope
  and OCI error semantics.
- Push surface (only behind explicit push policy): the standard
  `POST/PATCH/PUT /v2/{name}/blobs/uploads/` sequence and
  `PUT /v2/{name}/manifests/{ref}`. Uploads stage privately with digest/size
  validation; Catalog publication is atomic and only after the complete
  verified referenced closure exists; tags keep durable CAS semantics.
- Agent mode is **read-only by explicit opt-in**: all mutation verbs are
  denied even with a read credential, and access is scoped to verified
  complete artifacts and authenticated peers.

Delivery status: the service is delivered by #4088 in
`nession-erofs::registry::service` (feature `registry-service`), generic over
the supplied `BlobStore`/`RepositoryStore`/`RegistryAuthorizer` plus a
`RepositoryPublisher` for write mode (`RegistryMode::ReadOnly`/`ReadWrite`).
The Server publication adapter `CatalogRepositoryPublisher` (feature `catalog`)
records objects, descriptor edges and the Tag in one catalog transaction.
Exposure follows the #4087 tag-rooted reachability fence: a Manifest pushed by
Tag is readable by Tag and digest; moving a Tag moves the exposed root
atomically. The service compiles and mounts without the external client or the
catalog (the Agent boundary); wiring it into the Server/Agent ingresses and the
proprietary-endpoint migration belong to #4090.

### Registry Client SDK (#4089)

The #3498 client becomes a host-independent SDK:

- `ImageReference` (registry, repository, tag or digest); canonical tag→digest
  resolution; Index→platform-specific Manifest selection; Config/Blob closure
  download; immutable digest pinning **before** any alternate-source fetch.
- Network fetch, verification, CAS ingest and optional local Catalog tag
  publication are separate steps. Server import may publish a local tag after
  verification; an Agent fetch may simply retain pinned OCI objects.
- The caller supplies the local CAS/Cache, a scoped credential provider,
  progress/cancellation and source policy. Existing auth/challenge, bounded
  redirect/SSRF defenses and resumable single-flight transfer are reused;
  Range support is negotiated and a Registry without resume triggers a safe
  restart, never a partial Ready object.
- Credentials are never serialized into Session grants or Image Config and
  never leak to redirects or logs. A tag name does not imply the same digest
  across registries.

### Data flow and authority boundaries

```text
external GHCR/OCI ──authorized import──▶ Server Store (CAS + Catalog)
                                            │  /v2/ (Server authority)
        ┌───────────────────────────────────┤
        ▼                                   ▼
   Agent A Store ◀──/v2/ pull──▶ Agent B Store      (peer, #4091)
        │  optional opt-in read-only /v2/
        ▼
   Sandbox verified local immutable objects + mount leases
```

- The Server keeps Project/Session/tenant authorization, official catalog
  policy, endpoint advertising and grant issuance. Control-plane grants carry
  pinned immutable identity and allowed sources — not raw registry secrets.
- An Agent fetches from the Server Registry, an approved peer Registry or an
  approved external Registry using the same SDK, and re-verifies exact
  digest+size regardless of source. Network reachability is not authorization.
- Direct external sources follow allowlists, SSRF/redirect/credential
  restrictions and immutable digest verification. There is no global Server
  bearer credential shared across peers.
- Peer discovery (#4091) advertises or resolves only verified pinned
  Manifest/complete-closure availability and authorized endpoints, from a
  bounded explicit candidate list. A requester resolves and authorizes the
  immutable digest first, then selects a reachable authorized source; on
  failure it falls back only to another authorized source for the **same
  pinned digest**. No public peer discovery, no automatic cross-tenant
  sharing, no mandatory availability inventory database.

### Format interoperability constraints

- OCI Distribution interoperability does **not** imply Docker can execute
  `application/vnd.erofs` layers. No claim of Docker runtime compatibility is
  made for raw EROFS objects.
- A referenced Composite's nested dependency closure needs an explicit
  portable representation/compatibility decision before portable registry
  support is claimed. Until then, opaque OCI descriptor transport is allowed
  where valid, and unsupported EROFS runtime types are rejected explicitly at
  the consumer boundary rather than corrupting OCI bytes.
- Original OCI bytes are preserved end to end. Index/Manifest identity stays
  digest-pinned; tags are mutable names scoped to one repository; there is no
  global tag consistency across registries.

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

### Peer Registry delivery (#4086)

The peer-capable extension is a second acyclic subtree with one owner per
deliverable. Dependencies: **(1) → (2, 3) → (4) → (5)**. The prior #3498
client and #3496 catalog are reused, not duplicated; #4084 remains the GHCR
EROFS publish/readback smoke owner.

```text
#4086 peer architecture (this contract)
  └─ #4087 1: shared CAS BlobStore / RepositoryStore / Cache lifecycle (P0)
       ├─ #4088 2: mountable standard OCI Distribution Registry service (P1)
       ├─ #4089 3: reusable Registry Client SDK / verified multi-source fetch (P1)
       └──────┬─ #4090 4: Server/Agent host adapters, GHCR import, direct pulls (P1; needs 2+3)
              └─ #4091 5: peer source discovery, scoped Agent-to-Agent pull, fallback (P2)
```

| Stage | Issue | Predecessors | Deliverable | Verification owner | Migration / rollback |
|---|---|---|---|---|---|
| 1 | [#4087](https://github.com/BestNathan/nession/issues/4087) | #4086; reuses #3496/#3499 | Reusable `BlobStore`/`RepositoryStore` contracts, Cache lifecycle and ownership-safe GC/eviction | Deterministic CAS/repository positive+negative fixtures at exact PR head (SCN-01): hash tampering, cross-repo reachability, eviction vs pins | Additive contracts over existing layouts; no byte migration. Rollback = revert adapters; existing Server catalog and Agent cache paths remain valid |
| 2 | [#4088](https://github.com/BestNathan/nession/issues/4088) | #4087 | Host-agnostic `/v2/` Registry service (pull, push behind policy, read-only mode) | Source-aligned staging protocol/runtime Case at exact merged SHA (SCN-03): loopback OCI clients, ORAS readback, malformed/unauthorized probes | Service mounts alongside the proprietary endpoint; nothing replaces it yet. Rollback = unmount the router; no state change |
| 3 | [#4089](https://github.com/BestNathan/nession/issues/4089) | #4087; reuses #3498 client | Host-independent Client SDK with verified multi-source CAS ingest | Deterministic local registry + adversarial fixtures at exact PR head (SCN-01); reuses the #3498 test registry | SDK refactor preserves #3498 pull/push behavior; Server import keeps working throughout. Rollback = retain the prior pull path until parity is proven |
| 4 | [#4090](https://github.com/BestNathan/nession/issues/4090) | #4087, #4088, #4089 | Server Registry mount + authorized external import; Agent SDK fetch + opt-in read-only Registry; proprietary-endpoint migration | Staging Cases (SCN-03/04): authenticated import, Session-authorized Agent pull, deny probes, cache-hit, compatibility transition | Explicit compatibility window for `/images/blobs/{digest}`; cutover only after Agent adoption and parity receipts. Rollback = re-enable the proprietary path; Session pins, resume and digest verification never regress |
| 5 | [#4091](https://github.com/BestNathan/nession/issues/4091) | #4090 | Control-plane source discovery, scoped peer pull, resilient same-digest fallback | Isolated staging Server+two-Agent Case (SCN-03) plus identity/credential isolation profile (SCN-04); positive and negative permission/network/disconnect probes | Opt-in bounded candidate list; fail-closed fallback to Server/GHCR. Rollback = disable peer sources; the #4090 Server/external paths are unchanged |

No child re-imposes full regression on another. Each stage keeps the accepted
#3494–#3500 evidence intact; a decision change updates this document instead
of spawning a competing explanation.

## Proprietary Blob transport retirement (#4250)

[#4250](https://github.com/BestNathan/nession/issues/4250) is the explicitly
deferred #4090 cutover: supported Session image acquisition moves from the
proprietary `/images/blobs/{digest}` transfer endpoint to the standard OCI
Distribution `/v2/` API, and the legacy route is retired in a separately
reviewable slice once parity is accepted. It is a transport-endpoint migration,
not the #3496 legacy storage migration, and it adds no second CAS, SDK or token
authority.

**Cutover rule.** The `/v2/` Registry exposes an immutable digest only when a
repository's Tags reach it through descriptor edges (including Index children
and the referenced Composite closure). The Server therefore grants a
repository-scoped `/v2/{repo}/manifests/{digest}` route (objects on
`/v2/{repo}/blobs/{digest}`) exactly when the resolved Manifest is Tag-reachable
in some repository, derived by `catalog::reference::v2_repository_for_manifest`
from the same Tag roots and descriptor edges as the Registry's reachability
fence. An untagged build or a digest-only legacy row has no such repository and
keeps the bounded compatibility route `/images/blobs/{digest}`. The reachability
fence itself is unchanged: a pin is still GC protection, not a `/v2/` root, and
the cutover grants no access `/v2/` already denies.

**Production caller inventory** (owners, not a volatile line list; the exact
source is the #4250 delivery PR head):

| Caller | Responsibility | Route after cutover |
|---|---|---|
| `nession-server::image::resolve_image_for` | Issues the Session/Project/Managed/Sandbox Manifest closure grant and object routes | `/v2/` when Tag-reachable; compatibility route otherwise |
| `nession-server::image::legacy_image_resolution` | Digest-addressed ready EROFS row with no catalog identity | Bounded compatibility route (supported-client obligation) |
| `nession-server::handler::server_session_sandbox_images` / `server_session_create_v1` | Project the resolved closure into the Server→Agent grant | Derive the grant route from the authorized Manifest object route |
| `nession-agent::erofs_cache::resolve_grant_image` | Dispatch a grant to the verified SDK/cache fetch | `/v2/` Manifest **and** Composite closure; compatibility route for legacy grants |
| `nession-erofs::cache::fetch::{fetch_manifest_image_v2, fetch_composite_image_v2}` | The one verified fetch over `/v2/` routes | Repository-scoped; same cache/pin/digest semantics as the legacy path |
| `nession-erofs::registry::service` + `catalog::repository_store` | The `/v2/` pull surface and its Tag-reachability fence | Unchanged; already serves Manifest and Composite closures |

Web/App, MCP, CLI and Sandbox have no runtime caller of the legacy route; the
generated Web bindings carry only the grant `path` doc projection. The legacy
route's auth (Server Token), single-Range/ETag/resume and GC-transfer guard
semantics in `nession-server::image::http` are preserved for the compatibility
window and are the rollback surface.

**Removal and rollback guards (separate slice).** After the staging parity Case
(SC-02) is accepted, the legacy route mount is gated by the protected operator
toggle `ServerConfig::legacy_blob_route` (`[server] legacy_blob_route`, default
`true`), applied by the Server ingress `http_router` — the single owner of the
mount decision. The standard `/v2/` Registry is mounted regardless of the toggle.

- `legacy_blob_route = true` (default) keeps the bounded compatibility window:
  untagged builds and digest-only legacy rows still resolve to the proprietary
  route, while Tag-reachable catalog images already acquire through `/v2/` only.
- `legacy_blob_route = false` is the staged removal. The proprietary route is
  unmounted, so a migrated client holding only `/v2/` grants is unaffected and a
  caller still asking for `/images/blobs/{digest}` receives a 404. `/v2/` continues
  to serve approved complete closures and to deny wrong principal, wrong
  repository and forged digest.
- Flipping back to `true` is the fail-closed rollback: the supported legacy reader
  returns without relaxing the Server Token or digest checks (absent/wrong token
  stays 403, an unknown digest stays 404).

The toggle is an operator configuration, never a client-negotiated capability. It
deletes no durable blob and rewrites no Manifest identity; Session pins, resume
and digest verification never regress. Because acquisition is `/v2/`-only, the
persistent Agent cache and an active mount (pin) survive the removal unchanged.
The #4250 SC-03 staging Case
(`sc03_legacy_route_removed_with_protected_rollback`,
`nession-server::server::websocket`) drives the real `http_router` in both toggle
states and proves these negatives, the cache/mount preservation and the
fail-closed rollback.

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
| `contracts` | Reusable `BlobStore`/`RepositoryStore` contracts and the shared repository/tag name grammars (#4087); no host identity, database or authorization state |
| `blob/` | digest and general CAS store; `FsBlobStore` is the Server CAS adapter of the `BlobStore` contract |
| `catalog/` | repository, tag, reference graph, SQLite schema/migration, GC; `CatalogRepositoryStore` is the Server adapter of the `RepositoryStore` contract |
| `image/` | publish, resolve, inspect |
| `build/` | EROFS, Git, local, archive and OCI-source publication |
| `registry/` | OCI Distribution Client SDK (auth, pull, push, verified multi-source ingest) and the mountable `/v2/` Registry service (#4088/#4089); both host-independent, authorization and credentials injected by the host |
| `distribution/` | Server→Agent HTTP transfer engine |
| `cache/` | Agent fetch/resume/verify and eviction; `CacheBlobStore`/`CacheRepositoryStore` are the Agent adapters of the shared contracts over the verified per-identity namespace |
| `mount/` | FUSE primitive and physical mount lease manager |

The direction of dependency is one-way: `oci` and `blob` are foundational;
`catalog`, `build`, `registry`, `distribution`, `cache` and `mount` consume
them where needed. `nession-server`, `nession-agent`, `nession-sandbox` and
`nession-protocol` depend on the crate; the reverse edge is forbidden. The
catalog receives a transaction from the Server's SQLite authority rather than
opening its own database. The crate continues to expose cargo features so a
consumer compiles only the mechanics it uses (Server: build/store/catalog plus
registry client/service; Agent: cache/distribution/mount plus registry
client/service for approved sources; Sandbox: mount). The #4086 rule that
reusable Registry and CAS code stays independent of `nession-server`,
`nession-agent`, `nession-sandbox` and `nession-protocol` is checked with the
cargo boundary commands in [Verification](#verification); the Agent's
historical exclusion of the `registry` feature existed to keep Server
credentials out of Agent builds, and is superseded by scoped per-host
credential injection — never by sharing the Server's secret source.

## Non-goals

No Dockerfile, generic software installer or container runtime; no execution of
OCI `Entrypoint`/`Cmd`; no tar layer unpacking; no new background job queue; no
second image database or mirrored state; no compressed/chunk-index/lazy EROFS
variants in v1; the referenced multi-blob Composite is its own descriptor
layer and is never expressed as an arbitrary OCI `Manifest.layers[]` union; no
registry credentials in images, EROFS, Agent grants or logs; no automatic
re-mount of a running process.

The #4086 extension adds its own bounded non-goals: the `/v2/` Registry
service is a reusable distribution surface, not a Docker/OCI runtime, a blob
replication scheduler or an unrestricted CAS view; no host-specific
Session/Project decisions inside the crate; no mandatory publishing,
all-to-all P2P, public peer discovery, automatic cross-tenant sharing or
automatic GHCR credential forwarding; no speculative P2P CDN or mandatory
availability inventory database.

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
each. The #4086 peer subtree (#4087–#4091) is verified the same way: the
architecture and dependency/Issue map by document/link review at the exact PR
SHA, and the crate boundary by the commands above plus focused
compile/contract checks proving the reusable Registry/CAS modules carry no
`nession-server`/`nession-agent`/`nession-sandbox`/`nession-protocol` edge.
The architecture document itself is checked against the implementing PR
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
- [#4086](https://github.com/BestNathan/nession/issues/4086) — peer-capable
  OCI Store and Registry infrastructure architecture; children
  [#4087](https://github.com/BestNathan/nession/issues/4087),
  [#4088](https://github.com/BestNathan/nession/issues/4088),
  [#4089](https://github.com/BestNathan/nession/issues/4089),
  [#4090](https://github.com/BestNathan/nession/issues/4090),
  [#4091](https://github.com/BestNathan/nession/issues/4091)
