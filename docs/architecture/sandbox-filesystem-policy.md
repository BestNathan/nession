# Sandbox filesystem declaration model

Status: **Policy direction recorded by
[#3405](https://github.com/BestNathan/nession/issues/3405); not executable on
`main` yet.** The current V1 contract still accepts only
`filesystem.access` or the Agent-prepared `filesystem.composition`, and the two
remain mutually exclusive. The executable declaration, mount-plan compiler and
native proof belong to the follow-up implementation Requirement. This document
is the source of truth for the declaration semantics that implementation must
consume; it does not claim that any host currently installs them.

The current execution architecture remains
[Sandbox policy and execution isolation](sandbox-policy-and-execution.md). Its
[prepared EROFS root composition](sandbox-policy-and-execution.md#prepared-erofs-root-composition-3024)
section is still the mechanics owner until the implementation lands.

## One owner per layer

The Filesystem policy is split into three contracts with different authority.
Do not collapse them into one object, and do not let a later layer recreate a
decision that belongs to an earlier one.

| Layer | Contents | Owner | Client-visible |
|---|---|---|---|
| **Client-safe declaration** | Requested RootFS mode/source, additional mount sources and targets, Workspace reference, `access.read/write` | Protocol Kernel `SandboxPolicy.filesystem` (`crates/nession-protocol/src/contracts/sandbox/v1.rs`) | Yes |
| **Trusted prepared plan** | Verified local image bytes, owned write directories, exact resolved target mappings, mount order, cleanup ownership | Agent prepares it; `nession-sandbox` compiles and verifies it | No |
| **Effective observation** | Actual mounts/modes, pinned digests, workspace path class and enforcement evidence | `nession-sandbox` execution record; read-only projection | Yes, read-only |

The declaration never carries a raw local image path, a bearer grant, a mount
command or a second Compose/OCI root model. The prepared plan never becomes a
client input. Effective observation never substitutes for Server image
readiness or Agent cache verification.

### Source-of-truth decisions

- **Root authority.** `filesystem.rootfs` is the single client authoring field
  for the root. `SandboxImageSelection` remains the existing Server/Agent
  grant transport for the Enter flow; it is derived from the declaration and
  is not a second independently editable authoring surface. The Agent resolves
  a selected digest through its verified cache and compiles the internal
  prepared plan.
- **Mount authority.** `filesystem.mounts[]` declares authorized image sources
  and explicit targets. The Agent resolves each digest to a verified cache
  path; the Sandbox decides mount ordering and refuses unsafe targets.
- **Workspace authority.** `filesystem.workspace` selects an Agent resource by
  reference. The resource identity, inventory, durable storage and deletion
  belong to the Agent Workspace Manager
  ([#3407](https://github.com/BestNathan/nession/issues/3407)); the Filesystem
  policy only consumes it at the implicit `/workspace` target.
- **Access authority.** `filesystem.access.read/write` keeps its V1 identity
  mapping exactly. It is not a mount grammar and never gains a target field.
- **Project Location authority.** A Project's existing location remains a
  Project-owned `{agent_id, path}` declaration. The Agent validates it at use
  time and never copies, chowns or deletes the directory.

## Path mapping contracts

Four mapping shapes are distinct. The identity map is not a rename operator,
and an image mount is not an `access` entry.

| Declaration | Input / source | In-Sandbox target | Mapping rule | Permission |
|---|---|---|---|---|
| `filesystem.rootfs` | `local` (the backend's host-root baseline) or one immutable `base_runtime` EROFS digest | `/`, fixed and implicit | Fixed RootFS mapping `source → /`; at most one root owner | Read-only for an image root |
| `filesystem.mounts[]` | One immutable **non-`base_runtime`** EROFS digest | Explicit validated absolute `target` | Authorized Source → Target mapping | Read-only in the first implementation |
| `filesystem.workspace` | One Agent resource reference: current Project's Existing Location or an Agent-managed Workspace | `/workspace`, fixed and implicit | Agent-resolved resource → `/workspace`; an optional Project EROFS lower may be merged through a bounded writable Overlay | Writable |
| `filesystem.access.read[]` | One validated existing Agent host path `P` | **The same path `P`** | Identity mapping `P → P` | Read-only |
| `filesystem.access.write[]` | One validated existing Agent host path `P` | **The same path `P`** | Identity mapping `P → P` | Read/write; write implies visible |

`rootfs` and `workspace` have no target field. `mounts[].target` is the only
caller-selected target in the declaration. `Home` and temporary runtime paths
are not policy fields: the backend owns them (see [runtime-owned
paths](#runtime-owned-paths)).

### Converged client declaration

The following field names and semantics are the convergence decision for the
follow-up implementation. They extend the existing `filesystem` object; they do
not rename `filesystem`, `filesystem.access`, `access.read` or `access.write`.

```jsonc
{
  "filesystem": {
    "rootfs": {
      // "local" (or omitted) uses the backend host-root baseline.
      "kind": "image",
      "digest": "sha256:<base_runtime_digest>"
    },
    "mounts": [
      {
        "source": { "kind": "image", "digest": "sha256:<tool_digest>" },
        "target": "/opt/rust",
        "read_only": true
      }
    ],
    "workspace": {
      // "auto" | "project_location" | "managed"
      "kind": "managed",
      "workspace_id": "ws_<stable-id>"
      // or, for a new/reused name: "name": "<human-name>"
    },
    "access": {
      "read": ["/usr/share"],
      "write": ["/home/dev/project"]
    }
  }
}
```

Rules for the converged shape:

- `rootfs` is optional. Absence means `kind: "local"`, the backend's current
  host-root baseline, equivalent to the editor's `Local` option. When present,
  `kind: "image"` requires exactly one `sha256:<64 lowercase hex>` digest.
- `mounts` defaults to an empty list. Every entry has one image `source`, one
  normalized absolute `target`, and `read_only: true`. A writable mount, a
  missing `read_only`, an overlap, a duplicate target, or a reserved runtime
  path is refused before any host resource exists.
- `workspace` is optional; absence means `kind: "auto"`. `auto` resolves to a
  matching current-Agent Project Location when one exists, otherwise to the
  Agent-managed `get_or_create(name = session.name)`. `project_location`
  selects the current Project's declaration on the current Agent. `managed`
  carries exactly one of `workspace_id` or `name`; a stable `workspace_id` is
  the durable reference, while a name is a lookup alias. No other Agent's
  location is a candidate.
- `access` remains the same object and same identity semantics. It is not
  converted into mounts.
- `filesystem.composition` is not part of this client declaration. It remains
  the Agent/Server-prepared V1 input and may be renamed by the implementation
  Requirement; its internal/privileged distinction does not change.

A declaration that names both a nonempty `access` object and an executable
composed-root plan (an image-backed `rootfs`, any `mounts`, or a Workspace
compiled into that plan) is **structurally representable but not executable**
in the first implementation. Preflight refuses the unsupported combination at
the precise field path; it does not silently drop one side. A later mixing
model requires a separate safety decision and OS-native proof.

### Concrete examples

**Host-root baseline with identity access paths.** The absent `rootfs` is the
editor's `Local` selection. `/usr/share` is visible read-only at the same path
and `/home/dev/project` writable at the same path. This is the successor to
V1's access-only mode.

```json
{
  "filesystem": {
    "access": {
      "read": ["/usr/share"],
      "write": ["/home/dev/project"]
    }
  }
}
```

**EROFS root, one tool mount, automatic workspace.** The Base Runtime is
read-only at `/`; the Rust toolchain is read-only at `/opt/rust`; the absent
`workspace` resolves through `auto` (current Project Location first, otherwise
the Session-named managed workspace).

```json
{
  "filesystem": {
    "rootfs": { "kind": "image", "digest": "sha256:<base_runtime_digest>" },
    "mounts": [
      {
        "source": { "kind": "image", "digest": "sha256:<rust_toolchain_digest>" },
        "target": "/opt/rust",
        "read_only": true
      }
    ]
  }
}
```

**Existing Project Location.** The Project owns `{agent_id, path}`. The Agent
validates the declaration at use time and mounts that directory at the
implicit `/workspace`; the Filesystem editor shows the path read-only and
never creates or deletes it.

```json
{
  "filesystem": {
    "workspace": { "kind": "project_location" }
  }
}
```

**Managed Workspace.** The first resolution creates or reuses the stable
`workspace_id` for the name; the Session's bound reference stores the ID so a
later rename cannot silently rebind its storage. A Session that already holds
the ID sends it directly.

```json
{
  "filesystem": {
    "workspace": { "kind": "managed", "name": "fix-terminal" }
  }
}
```

A managed Workspace is an Agent-owned resource, not an EROFS image, a Project
or the logical Nession Workspace. Its bytes outlive the execution and the
Session; only an explicit, unmounted, unreferenced deletion removes them.

## Validation, ordering and isolation

Validation happens before any host resource is created. The single
`nession-sandbox::compile` gate remains the backstop; the Server and the
Web-safe draft projection may reject earlier but must not create a second
policy authority.

1. **RootFS.** At most one root. An image root must be a `base_runtime` image
   verified in the selected Agent's cache. Server `ready` alone is
   insufficient. The image is read-only at `/`. A host that cannot install the
   requested root refuses the launch.
2. **Mounts.** Only immutable non-`base_runtime` EROFS images. Targets are
   absolute, normalized and free of `..`, symlink traversal and control
   characters. The first executable implementation keeps the V1 target
   restriction `/opt/<lowercase-name>`; any wider target is an explicit
   field-level unsupported error, not a silent remap. The
   `base_runtime`/non-`base_runtime` category and an image `default_mount`
   are proposed registry metadata for the implementation; `main` does not
   expose either yet, so neither can be treated as an existing production
   authority.
3. **Workspace.** Exactly one source at the implicit `/workspace`. A Project
   Location must belong to the current Agent and the current Project; an
   explicit managed Workspace must be owned by the current Agent. Missing,
   offline, foreign-Agent or unauthorized selections fail with an actionable
   state and no hidden fallback. The workspace is also the default working
   directory after Enter.
4. **Access.** Each path is an existing, absolute, normalized host path on the
   current Agent. Overlapping read and write entries for the same tree are
   contradictory and refused. Access entries never become image mounts, and
   they never expose the Agent's control paths, cache root or another
   consumer's data.
5. **Ordering.** Establish the root first, then additional mounts, then the
   Workspace, then backend-owned `/dev`, `/proc`, `/home`, `/tmp` and
   `/run/nession`. A later mount must not shadow a runtime-owned path or an
   earlier validated target. The prepared plan records the final order.
6. **Fail closed.** An unsupported backend, helper, kernel feature, cache
   state, grant, workspace or target refuses preparation with a typed error.
   There is no Native fallback, no extraction fallback and no kernel-loop
   substitution.
7. **Preparation is not reservation.** Preflight validates and probes without
   downloading or reserving bytes. Enter re-probes and re-reads authoritative
   state before creating resources. A stale preflight is never trusted.

## Runtime-owned paths

These paths are not Filesystem policy and must not be misrepresented as
`access` entries or user mounts:

| Path | Owner | Lifetime |
|---|---|---|
| `/home` | Backend | Private tmpfs in a composed root; no persistent user home is promised by this policy |
| `/tmp` | Backend/execution | Private tmpfs when not visible; removed with the execution |
| `/dev`, `/proc` | Backend | Created for the execution; never caller-supplied binds |
| `/run/nession` | Backend | Execution-scoped runtime directory carrying the trusted bridge and channel; masked from user policy |
| Agent state, cache root, tmux socket | Agent | Always masked; a policy that exposes one is refused |

`Home` is deliberately not a fifth editable Filesystem section. The editor's
fifth always-visible item is the derived **Preview**, not a Home policy.

## Resource identity and lifetime matrix

| Resource | Created by | Durable owner | Survives execution exit | Survives Session deletion | Deleted by |
|---|---|---|---|---|---|
| Base Runtime image bytes | Server build; Agent cache fetch | Server registry + Agent cache | Yes, as cache bytes | Yes, subject to cache retention | Server GC / Agent cache eviction, never by execution cleanup |
| Mounted image (RootFS or extra mount) | Agent prepares cache path; Sandbox mounts | Server registry + Agent cache; Sandbox owns the mount only | Unmounted; bytes remain | Bytes remain | Execution cleanup unmounts; cache owns bytes |
| Project Location | Project declaration (external) | User/Project, never the Agent Manager | Yes | Yes | Never by Workspace management |
| Managed Workspace | Agent Workspace Manager `get_or_create` | Agent, under its durable storage root | Yes | Yes | Explicit delete when unmounted and unreferenced; never execution cleanup |
| Workspace Overlay upper/work | Agent for the execution or durable managed workspace | Agent Workspace Manager for managed storage | Per the workspace kind; a managed upper persists | Per the workspace kind | Workspace deletion policy, never the EROFS cache |
| Execution mounts and mountpoints | Sandbox `prepare` | Sandbox execution record | No | No | Cleanup/reconciliation, in reverse order |
| `/home`, `/tmp`, `/run/nession` runtime paths | Backend | Execution | No | No | Execution cleanup |

Lifetime detail for Workspaces is owned by
[#3407](https://github.com/BestNathan/nession/issues/3407). This document only
fixes the Filesystem-facing rule: the execution owns the **mount**, not the
durable workspace bytes, and cleanup must not delete reusable data.

## Negative examples

Every row must fail before user code runs. The exact field path and error code
belong to the implementation; the rejection itself is the invariant.

| Declaration | Why it is refused |
|---|---|
| `mounts[].source: "/var/lib/nession/erofs/agents/.../sha256/<hex>"` | Raw Agent-local path is not a client-safe source; only an authorized image digest reference is accepted |
| `mounts[].source.digest` does not match the verified bytes | Digest mismatch is a hard failure; a partial/corrupt cache is never mounted |
| `rootfs` names a non-`base_runtime` image category | The root requires a `base_runtime` image |
| `rootfs` digest is Server-ready but absent/partial in the Agent cache | Server readiness is not Agent cache readiness; the selection cannot be prepared |
| `mounts[].target: "/workspace"` or `/` | Target overlaps the fixed Workspace or RootFS owner |
| `mounts[].target: "/etc"`, `/usr`, `/run/nession`, `/proc`, `/dev`, `/home`, `/tmp` | Reserved/system/runtime path; shadowing it would break the execution or its evidence |
| `mounts[].target: "/opt/rust"` twice | Duplicate target is ambiguous; one target has one owner |
| `mounts[].target: "opt/rust"` or `/opt/../etc` | Targets must be absolute, normalized paths |
| `mounts[].read_only: false` | Writable image mounts are not part of the first implementation |
| Two mount targets where one is a parent of the other | Overlapping mount order is not a supported language; refuse instead of guessing precedence |
| `workspace` names another Agent's Project Location | A path that is not visible on the current Agent is not a candidate; no network copy/fallback |
| `workspace` names an unavailable/missing managed Workspace | Explicit selections do not fall back to auto-allocation |
| Managed workspace `name` collides concurrently | `get_or_create` must return one stable ID; it must not overwrite or create a second directory |
| Deleting a managed Workspace that is mounted or leased | Delete is refused while any attachment/lease exists |
| A Session is rebound to a different Agent while its bound Workspace ID/location belongs to the old Agent | The explicit reference is unavailable on the new Agent; there is no silent re-allocation or copy |
| Nonempty `access` together with an image-backed root/mount/workspace | The first implementation preserves V1's one-root-owner rule; the combination fails closed at its field path |
| Any declaration while the host lacks `erofsfuse`, `/dev/fuse`, `fuse-overlayfs` (when a lower is used) or a usable cache root | Backend missing is `UnsupportedPolicy`, never Native fallback |
| Agent offline during preparation or a grant expires mid-transfer | Observed as unavailable/unknown or failed; never reported as verified/mount-ready |

## Editor projection (Filesystem)

The product editor is owned by the Sandbox capability
([#3408](https://github.com/BestNathan/nession/issues/3408)); the protocol
declaration above is its only policy source. The editor presents five
always-visible sections in this order:

1. **RootFS** (`/`) — `Local` or a `base_runtime` image verified in the
   current Agent's cache. The selector is not a general image picker.
2. **Mounts** — initially empty; zero or more non-`base_runtime` images, each
   with a proposed `default_mount` and an editable validated target.
3. **Workspace** (`/workspace`, the default working directory) — the current
   Project's Agent location, read-only in this editor, or an Agent-managed
   Workspace (auto by Session name, existing, or new name).
4. **Access** — independent read/write identity-path rows, one path per row.
5. **Preview** — derived, never editable: every target, source and mode from
   the four configuration sections, recomputed live.

The editor must show cache readiness, unsupported backend state, validation
errors and destructive-action confirmations inline. It must not present a
standalone Home editor, an outer Host-vs-Composition switch, or a raw
host-source/mount-command field. Architecture rationale and mock limitations
belong outside the product viewport.

## Current V1 compatibility

Until the follow-up implementation lands, the following remain true and must
not be weakened by this design document:

- `SandboxFilesystemPolicy` accepts `access` and an Agent-prepared
  `composition`; carrying both is refused.
- A composition requires one Base Runtime at `/`, a writable workspace, and
  zero or more toolchains at exactly `/opt/<lowercase-name>`.
- The composed root is an empty tmpfs plus a read-only Base Runtime bind;
  `/workspace` is a bind or a read-only lower merged with an Agent-owned
  writable upper/work through `fuse-overlayfs`; `/home` and `/tmp` are private
  tmpfs.
- Image sources are verified local files beneath the Agent-authorized EROFS
  image root. The Sandbox re-verifies every digest before mounting.
- No client-supplied `rootfs`, `mounts` or `workspace` field is executable on
  `main`. The Server and Agent must reject unknown fields; they must not
  ignore a declaration that they cannot install.

The follow-up implementation Requirement owns the schema change, the
declaration-to-prepared-plan compiler, the target policy, the Workspace
Manager integration and the native Linux proof. It must reuse the existing
#3024 EROFS/Sandbox Case lane and must not introduce a second mount backend,
a second image registry or a second Workspace registry.

## References

- [#3405](https://github.com/BestNathan/nession/issues/3405) — normative
  Filesystem declaration, mapping and IA decisions.
- [#3407](https://github.com/BestNathan/nession/issues/3407) — Agent-owned
  managed Workspace identity, inventory, reuse and deletion.
- [#3408](https://github.com/BestNathan/nession/issues/3408) — Session-scoped
  Sandbox navigation and Filesystem editor presentation.
- [#3023](https://github.com/BestNathan/nession/issues/3023) — Agent EROFS
  cache mechanics.
- [#3024](https://github.com/BestNathan/nession/issues/3024) — prepared EROFS
  root composition and native proof lane.
- [#3062](https://github.com/BestNathan/nession/issues/3062) — Managed Session
  preparation.
- [#3161](https://github.com/BestNathan/nession/issues/3161) — per-policy
  implementation support discovery.
- [#3181](https://github.com/BestNathan/nession/issues/3181) — existing-Session
  image composition and Server-owned image selection.
- [Sandbox policy and execution isolation](sandbox-policy-and-execution.md) —
  current executable architecture.
- [Global EROFS Image Manager](erofs-image-manager.md) and
  [Agent EROFS cache](agent-erofs-cache.md) — image bytes and cache ownership.
