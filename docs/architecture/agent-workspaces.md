# Agent-owned managed Workspaces

Status: **Registry/API (#3407), managed `/workspace` attachment (#3405) and
one shared writable Overlay per managed Workspace (#3582).** The Agent owns
the registry, names, stable identities, durable bytes, the durable Overlay
upper/work, the ordered lower compatibility key and attachment leases; the
physical Merged View is owned by `nession_erofs::overlay::OverlayMountManager`.
Project Location selection and the Web/App inventory remain owned by their
referenced Requirements.

## Ownership

| Thing | Owner |
|---|---|
| Managed Workspace registry, stable IDs, names, durable directories, leases and deletion | Agent Workspace Manager (`crates/nession-agent/src/workspace_manager.rs`) |
| Project Existing Location `{agent_id, path}` | Project declaration; the Agent only validates/references it; never copied or deleted here |
| Authenticated routing and Session target authorization | Server (`server.workspace.*` → `agent.workspace.*`) |
| Filesystem policy selection and `/workspace` mounting | `nession-sandbox` / the follow-up #3405 implementation |
| Physical writable Merged View per managed Workspace | `nession-erofs::overlay::OverlayMountManager` (#3582) |
| Sandbox execution lifecycle | `nession-sandbox`; it owns execution isolation and records, not the durable workspace bytes |

A managed Workspace is **not** the logical Nession Workspace, a Project, an
EROFS image or a Sandbox execution. The logical Workspace remains the
contextual product surface; a managed Workspace is one Agent-local filesystem
resource it may use.

## Durable layout

The production root is the Agent sandbox state directory's `agent-workspaces/`
child (`<sandbox state>/agent-workspaces`). The sandbox state directory is the
configured durable location; the sandbox mount validation already confines
`filesystem.composition.workspace.write` to it:

```text
<root>/registry.json                 versioned metadata, atomically replaced
<root>/workspaces/<workspace_id>/    durable user content
  upper/                             durable Overlay writable layer
  work/                              Overlay work directory (same filesystem)
  .nession-overlay/                  manager-owned owner identity + advisory lock
```

- The root must be a real directory, not a symlink, and is secured `0700`.
- `registry.json` is written to a private temporary file, fsynced, atomically
  renamed and the parent directory fsynced. A reader never sees a truncated
  registry.
- The physical directory is keyed by the opaque `ws_<uuid>` identity, never by
  the human display name. Deleting a workspace removes exactly one direct
  child named by that validated id; it cannot follow a symlink or touch a
  Project Location.
- An unreadable, malformed or unknown-version registry is a hard error. The
  manager reports the inventory API unavailable rather than starting empty and
  fabricating readiness.
- A record pins the effective **ordered** lower Blob digest set
  (`lower_layers`, with the legacy `lower_digest` read as a one-element set):
  the Project source EROFS layers the durable upper was first prepared
  against. It is a property of the stored bytes, not a lookup alias; a
  changed or missing set is refused. Identical physical lower bytes under a
  changed Manifest are compatible at the filesystem layer; environment
  semantics remain a separate concern.
- `overlay_storage` records that the durable `upper`/`work` pair was
  initialized by this Agent. Once true, a missing, partial or symlinked pair
  is data-loss evidence and is refused; it is never replaced with a fresh
  empty upper. The pair is created on first lower-backed attachment.

## Identity, names and namespaces

- `workspace_id` is `ws_` plus a UUID. It is stable across restarts, Session
  deletion and re-entry.
- A human `name` is a lookup alias. Names are unique after normalization:
  surrounding whitespace trimmed, internal whitespace collapsed to one `-`,
  then lowercased. The first display spelling is preserved.
- The namespace is `project:<project_id>` when the caller has a Project, and
  `default` otherwise. The same name may exist in different namespaces; it is
  unique within one namespace.
- `get_or_create` is serialized and idempotent: concurrent callers for one
  `(namespace, normalized name)` observe exactly one stable id and one
  directory. A collision never overwrites or creates a second directory.
- `auto_created` records provenance (Session-name auto-allocation); it is not
  `delete_on_exit`.

## Selection and status

The Agent reports one observed status per resource:

| Status | Meaning |
|---|---|
| `available` | The durable directory exists and no execution holds an attachment |
| `in_use` | An attachment, a live physical Overlay/consumer, a durable owner lock or a surviving execution record uses it; deletion is refused |
| `missing` | Metadata exists but the durable directory is missing; the manager never recreates it |
| `error` | The path is a symlink/not a directory or cannot be inspected |

Explicit resolution rules are owned by the Filesystem policy implementation
(#3405): explicit workspace id/name > matching current-Agent Project Location >
managed `get_or_create(name = session.name)`. This registry implements the
managed branch and the stable identity it relies on; it does not silently fall
back when an explicit selection is invalid, missing or offline.

## Sandbox `/workspace` attachment

`filesystem.workspace` is resolved on Enter with one precedence
(#3407 SC-02):

1. an explicit stable `workspace_id` or `name` selects that managed Workspace
   and outranks the Project Location;
2. otherwise a matching current-Agent Project Existing Location is selected
   (`auto`, or the explicit `project_location` selection);
3. otherwise the Session name is `get_or_create`d in the default namespace.

Only the Server knows the Session's Project binding; it resolves the matching
`{agent_id, path}` for the target Agent and sends it with the Enter/preflight
request. The Agent re-validates that path at use time: it must be absolute, a
real (non-symlink) directory and already canonical. A wrong-Agent location is
never a candidate, an explicit `project_location` without a matching
declaration is refused, and no branch silently falls back.

A managed Workspace becomes the composition's writable `/workspace`; the
execution holds an attachment lease and cleanup releases it without deleting
durable bytes. The selected directory is Agent-owned, so it is also the
durable Overlay upper: when the Project pins a source EROFS image, the Server
adds it as the workspace lower, and the shared Overlay manager merges
`lowerdir=<Project image>` with
`upperdir=<workspace>/upper, workdir=<workspace>/work`. The Workspace Manager
records the ordered lower Blob set on first attachment; a later attachment
with a different or missing set is refused instead of merging a different
Project image into the same durable upper (#3407 SC-04, #3582).

Several Sessions may attach the same managed Workspace concurrently. They
share one physical Merged View and see each other's writes with normal
filesystem semantics; Nession does not merge or resolve concurrent writes.
The Overlay manager, not the process-local lease count, owns the unique
physical mount: it derives the mountpoint from its authorized Workspace root,
holds a durable owner lock next to the durable bytes, and only unmounts after
the last identified consumer. A failed unmount retains the mount, the lower
pin and the durable upper. Another process or manager root that shares the
durable upper is fenced by the owner lock plus mountinfo; network filesystems
are refused, so cross-node writable use is not enabled.

A Project Existing Location is bound directly, with `ownership:
project_location`. It is external and user-owned: the Agent never writes
Overlay metadata into it, never deletes or copies it, and refuses a
declaration that combines it with a Project EROFS lower. The per-execution
scratch directory remains available when no Workspace is selected.

Attachment leases are in-memory, but they are not the only authority. A
restart drops them; the durable execution record's Overlay binding is then
adopted only when the manager proves the durable identity, generation, Agent
identity, mount namespace, owner lock, mountinfo and read-only lower all
agree. Deletion also consults those observed facts and surviving execution
records, so unlinking a Workspace that a live or uncertain execution still
uses is refused rather than silently destroying bytes.

## Lifetime and deletion

- Managed bytes persist after Sandbox Enter/Return Native, Pane termination,
  Session deletion, Agent restart and Session rename. `last_used_at` is
  refreshed on reuse.
- Deletion is explicit and allowed only for an Agent-owned managed Workspace
  with no RW lease. The registry and directory are removed together.
- A Project Existing Location is reference-only: no endpoint in this manager
  deletes, copies, chowns or recreates it.
- Orphaned/missing metadata stays listable as `missing`; it is not silently
  repaired or removed.
- RW leases are currently in-memory attachments. The durable execution record
  that reconstructs them after an Agent restart is part of the #3405/#3407
  Sandbox attachment work.

## Protocol units

All units are authenticated and Session-scoped. The Server resolves the
registered Session's online Agent; the client never selects another Agent.

| Unit | Policy | Meaning |
|---|---|---|
| `server.workspace.list` | Query | Measured managed inventory, optional namespace filter |
| `server.workspace.create` | Keyed by Session | Idempotent get-or-create by name |
| `server.workspace.delete` | Keyed by Session | Explicit managed deletion after the Agent's attachment check |
| `agent.workspace.list` | Query | The Agent's own inventory |
| `agent.workspace.create` | Keyed by namespace+name | The Agent's serialized allocation |
| `agent.workspace.delete` | Keyed by workspace id | The Agent's ownership/lease check |

The Server validates the request shape, Session target and returned
descriptor (managed workspaces never expose a physical path). It keeps no
second inventory. The Agent's response is the observed resource, not a
Server-cached claim.

## Limits / when to revisit

- Project Location selection is limited to the current Project's declaration
  on the current Agent; there is no cross-Agent copy or fallback. A managed
  Workspace with a lower is pinned to that lower until the Workspace is
  deleted/recreated; changing the Project image requires a new Workspace.
- A managed Workspace is exclusive for RW attachment in the first
  implementation; concurrent sharing needs a separate decision.
- The Agent data directory must be a durable mount. A container writable layer
  is not a durable workspace store; the manager does not redirect to one.
- The Web/App inventory and selection surface are P3.

## References

- [#3407](https://github.com/BestNathan/nession/issues/3407) — normative
  resource model and lifecycle.
- [#3405](https://github.com/BestNathan/nession/issues/3405) — Filesystem
  policy and `/workspace` mapping.
- [#3408](https://github.com/BestNathan/nession/issues/3408) — Sandbox
  navigation and the Workspaces section.
- [Sandbox policy and execution isolation](sandbox-policy-and-execution.md) —
  current execution and mount mechanics.
- [Product model](../design/product-model.md) — logical Workspace versus
  Agent-local resources.
