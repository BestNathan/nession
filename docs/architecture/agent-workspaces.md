# Agent-owned managed Workspaces

Status: **P1-A resource registry and API (#3407).** The Agent owns the
registry, names, stable identities and durable bytes. Filesystem Policy
attachment at `/workspace` and the optional EROFS lower/Overlay are the
follow-up implementation (#3405); the Web/App inventory is P3. This document
does not claim that a Sandbox currently mounts a managed Workspace.

## Ownership

| Thing | Owner |
|---|---|
| Managed Workspace registry, stable IDs, names, durable directories, leases and deletion | Agent Workspace Manager (`crates/nession-agent/src/workspace_manager.rs`) |
| Project Existing Location `{agent_id, path}` | Project declaration; the Agent only validates/references it; never copied or deleted here |
| Authenticated routing and Session target authorization | Server (`server.workspace.*` → `agent.workspace.*`) |
| Filesystem policy selection and `/workspace` mounting | `nession-sandbox` / the follow-up #3405 implementation |
| Sandbox execution lifecycle | `nession-sandbox`; it owns the mount, not the durable workspace bytes |

A managed Workspace is **not** the logical Nession Workspace, a Project, an
EROFS image or a Sandbox execution. The logical Workspace remains the
contextual product surface; a managed Workspace is one Agent-local filesystem
resource it may use.

## Durable layout

The production root is the Agent data directory's `workspaces/` child
(`$NESSION_HOME/workspaces` in the deployment, on the Agent's durable volume):

```text
<root>/registry.json                 versioned metadata, atomically replaced
<root>/workspaces/<workspace_id>/    durable user content
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
| `available` | The durable directory exists and no execution holds an RW lease |
| `in_use` | An execution holds an RW lease; deletion is refused |
| `missing` | Metadata exists but the durable directory is missing; the manager never recreates it |
| `error` | The path is a symlink/not a directory or cannot be inspected |

Explicit resolution rules are owned by the Filesystem policy implementation
(#3405): explicit workspace id/name > matching current-Agent Project Location >
managed `get_or_create(name = session.name)`. This registry implements the
managed branch and the stable identity it relies on; it does not silently fall
back when an explicit selection is invalid, missing or offline.

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

- Project Location discovery/selection and the Filesystem `/workspace`
  attachment are not implemented by this registry.
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
