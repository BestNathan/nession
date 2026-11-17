# Images management · Web/App interaction design

> Candidate for [#3799](https://github.com/BestNathan/nession/issues/3799) and [#3795](https://github.com/BestNathan/nession/issues/3795), [#3796](https://github.com/BestNathan/nession/issues/3796), [#3798](https://github.com/BestNathan/nession/issues/3798). Prototype owner: `sandbox-capability-3124/`, **not** a separate global Images UI. All implementation/acceptance obligations remain on their Issues.

## 1. Product model and placement

```text
Selected Session
└─ Workspace (host-owned Web/App)
   └─ Sandbox (Session-context capability)
      ├─ Overview                  existing
      ├─ Images
      │  ├─ Library               Server Catalog / immutable revisions / mutable Tags
      │  ├─ Builds                Server durable jobs / source creation and image compose
      │  └─ Distribution          current Session Agent only / verified cache
      ├─ Workspaces                Agent-owned writable resources, NOT Image storage
      └─ Policies                  Sandbox runtime, filesystem composition
```

**Single-owner rules.** Images belong to the Server Catalog + CAS; an Image identity is a resolved immutable Manifest/Index Digest. A Tag is a movable repository-scoped pointer. Builds create Images; they do not create a Workspace, Session or a runtime MountPlan. Distribution is the current Agent's scoped cache observation and explicit preparation; not a global fleet push UI. Sandbox consumes an authorized prepared Image and cannot change its source metadata or Tags. Project references Image digests without owning Blob bytes.

Follow `docs/design/information-architecture.md` / `docs/design/product-model.md`. Images remains contextual in the existing Sandbox screen. A running Session is not required to understand the global Catalog's bytes, but the present **surface** remains Session-contextual per accepted #3408; changing that presence model is explicitly out of scope.

## 2. Visual language and shared content grammar

- **List at rest**: one compact, border-separated resource list; no per-row card walls, shadows, standalone detail panels after the list, or metric-dashboard tiles. Rows disclose Name, Repository/Tag, Representation, Size and a *Server* status. Search and filters are controls, not a permanent toolbar of decorative badges.
- **ResourceDetail on expansion**: stays **immediately under the owning row**, with its identity, exact Digest in mono, group headers, Label/Value facts, References and Availability. Only one image row expanded at a time. Healthy observations are neutral. Unknown values must stay explicit, never synthesized from Legacy Descriptor omissions.
- **ConfigurationForm**: the New Image operation groups Source type, source-specific inputs, Compose rows, optional Tag/alias and submit/recovery. Fields have visible labels, error/help roles and measured control band. Use this inside the current Images content, not a new global modal, page header, or feature dashboard.
- **OperationSurface**: Tag change/unlink is a deliberate, stateful, reversible-before-confirm operation with a review of Repository, Tag, expected old Digest, proposed target and pinned consumer impact. Server Catalog is the mutation authority. The preview shows a synthetic CAS conflict and requires re-review after refresh.
- **Colors and geometry**: Nession semantic `--nession-*` canvas/surface/line/foreground/muted; no green celebration badge for Ready/Verified; warning/danger color only for unavailable and failed state. Controls use radius-control; the deliberately opened operation uses radius-surface. Digests/ids technical paths use mono. No raw unowned App widths or extra product scroll root.
- **Experience**: Web 1180/1024 preserves host-owned Session Sidebar, Sandbox top-level nav and scoped Images side-nav. App 390/375 preserves exactly one App host header and Back, with horizontal scoped nav and one-column list/details. App controls use 44px minimum hit targets. The review frame preserves **actual CSS pixels**, not scale.

Canonical sources: `docs/design/visual-language.md`, `docs/design/composition.md`, `docs/design/design-system/patterns/{resource-detail,configuration-form,operation-surface}.md`, `docs/design/design-system/tokens.md` and `docs/design/interaction/{web,app}.md`.

## 3. Library · discover, inspect, manage

| Level | Content | Interaction |
|---|---|---|
| Heading | Image Library, global Server scope, quiet image count, current Agent context | Single primary **New image** takes user to Builds |
| Filter/scan | Search names, Digests, Tags and Source; Repository and Server-status filter | No destructive actions in list scan; paging keeps resource identity clear |
| Row | Name, Repository/Tag, Representation, Size, Server state | Click/keyboard expands a **single row-local** ResourceDetail |
| Identity | Manifest Digest, Repository/Tag, Platform, Representation, Created, technical Config unknown where unobserved | Explicit Copy digest when browser permission permits |
| Source & dependencies | Exact source provenance, layer/closure, proposed mount target, size and packaging | Referenced Composite shows external-blob closure and runtime limitation; not silently considered mount-ready |
| References | Known Project/Session pins and other catalog relationships | Optional data is visibly unknown if not observed; never assert 0 from missing privileges |
| Availability | Server publication, current Agent cache, runtime compatibility **separate** | Use as RootFS / Mount in Filesystem only when runtime-compatible |
| Tag management | Name or existing Tag, expected old Manifest, target Manifest, impact | Create/move CAS, Unlink Tag, refresh/re-review on conflict |

**Tag safety:** a Tag unlink is *not* Blob deletion. It never directly evicts Agent cache, unmounts running consumers or rebinds a pinned Project/Session revision. Server GC separately protects reachable Manifests, referenced blob closure, active leases and tags. On failed conflict/permission/readback, no mutation is claimed. Server unreachable disables mutation; Agent offline does not prevent Server Catalog reads/writes.

## 4. Builds · source configuration and durable operation

```text
Builds
├─ + New image
│  ├─ Select Source:
│  │    GitHub        supported current v1
│  │    Directory     supported current v1, authorized Server root
│  │    Compose       supported current v1
│  │    Archive / OCI disabled (requires source DTO / Server adapter #3795)
│  ├─ Source ConfigurationForm
│  ├─ Compose: order, pinned source revision, destination, add/remove/reorder
│  ├─ Output representation: Flattened or Referenced (Compose only)
│  └─ Review validation → Submit durable Server Build
└─ Build activity
   ├─ Status filter + history pagination
   └─ Build row → inline execution facts / diagnostic / attempts
      └─ Cancel active · Retry failed/canceled · Open published Image
```

- Do not imply that GitHub snapshot executes install scripts, shell hooks, package installation, privileged mounting or conversion automatically.
- Compose requires valid, distinct, authorized input revisions; destination targets must be absolute, normalized, and not nested/overlapping. Referenced Composite has stricter root/closure requirements and is **not** automatically supported by the Sandbox MountPlan (#3784).
- Show real stage names, known files/bytes and elapsed per attempt. `mkfs.erofs` progress has no verified global percentage; show indeterminate phase, never invented percentages.
- Server build Job is durable. Navigation, reconnect and retry must eventually read the authoritative Build record, not rely solely on an in-memory event stream.
- Browser mock source buttons for Archive/OCI remain **disabled** pending a typed Submit protocol; lower-level converter/registry capability is not evidence of a supported Web action.

## 5. Distribution · one Agent, three independent readiness dimensions

```text
Image revision
  ├─ Server:     Published / Building / Failed / Unreachable
  ├─ Agent:      Absent / Downloading / Resumable / Verifying / Verified / Failed / Unknown
  └─ Runtime:    Compatible / Wrong platform / Missing blob closure / Unsupported backend
```

Cache details expand in place with immutable Manifest identity, observed bytes, total bytes, verification phase and Runtime reason. **Byte download completion is not Digest Verified**. Use explicitly authorized Prepare / Resume / Retry on this Agent only. If Agent is offline, reads are Unknown rather than stale Verified; no implicit multi-Agent push, speculative download or silent Host fallback.

## 6. Interaction and failure matrix

| Scenario | Expected UI |
|---|---|
| No Images / no search matches | Quiet row-aligned empty state with reset affordance; no giant illustration or fake metrics |
| Browser search / Repository filter | Match Server image records; keep list scroll and current resource identity; pages scoped to current query |
| Expand / collapse a row | Immediate in-row ResourceDetail; no second detail below the list |
| Tag CAS success | New mutable Tag target; immutable Manifest and existing pinned references unchanged |
| Tag moved concurrently | Conflict message; expected Digest refresh must **return to Review**, not bypass confirmation |
| Tag unlink with active consumers | Show impact; confirmation only unlinks Tag, not GC/delete/mounts |
| Build unsupported adapter | Disabled choice with reason, not a submit that must fail downstream |
| Build invalid source/Compose conflict | Inline field-context error; no submitted Job, draft preserved |
| Build failure/retry | Existing diagnostic and attempt retained by real Server owner; UI shows new attempt state |
| Cache resumable/download/verifying | Transfer progress only for bytes with known totals; Verify is not mount-ready |
| Wrong-platform / referenced Composite | Reason under Runtime Compatibility; consumption action disabled |
| Agent offline, Server online | Catalog/Builds remain Server-scoped; Agent status Unknown; Agent Prepare disabled |
| Server offline | Registry marked unavailable/stale; mutation and new transfer disabled |
| Web → App → Web | Same selected Session and Images resource data, correct host shell/header, no duplicated Back |

## 7. Implementation mapping / status

| Surface | Current source owner | Requirement |
|---|---|---|
| Library read UI & page hooks | `web/src/capabilities/images/components/ImagesWorkspace.tsx`, `useImagesPage.ts` | #3799 |
| Catalog Tag/GC | `crates/nession-erofs/src/catalog/`, `crates/nession-erofs/src/image/`, `nession-server` adapter | #3799 |
| Source Submit + Build detail | `web/src/capabilities/images/ImagesPlugin.ts`, `crates/nession-protocol/src/contracts/image/v1.rs` | #3795 |
| Build history & recovery UI | `web/src/capabilities/images/hooks/useImageBuilds.ts` | #3798 |
| Agent cache observation/prepare | `web/src/capabilities/sandbox/components/SandboxDistributionPanel.tsx`, `crates/nession-agent/src/erofs_cache.rs` | #3796 |
| Consumer compatibility and mounts | `web/src/capabilities/sandbox/components/SandboxImageSelectDialog.tsx`, Agent/Sandbox MountPlan | #3793 / #3792 / #3784 |

**Prototype fidelity:** `images-management.js` uses synthetic local arrays, an in-browser CAS conflict fixture, pretend build records and mock cache transfers. It does not call the real Server, mutate Catalog, persist a Tag, transfer a Blob, mount EROFS, run a sandbox or prove kernel capabilities. Syntax and deterministic synthetic interaction checks are useful development guards, **not** Chromium screenshots, visual acceptance, trusted Pages release identity, or production SC evidence. Actual Chromium 1180/1024/390/375 plus frame geometry, a11y and App scroll/focus remains to be independently executed and recorded. Historical prototype receipts are not inherited.
