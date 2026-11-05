---
title: "Files capability identity, creation context and safe mutation ownership"
description: "Agent-host Files is source-scoped: a FileRef names its provider, creation freezes one destination when the form opens, and mutations refuse silent overwrites or stale writes instead of trusting a path alone"
topic: web
categories: ["app", "files", "ownership", "protocol", "safety", "web"]
status: verified
created_at: 2026-11-05T10:32:06Z
updated_at: 2026-11-05T10:32:06Z
sources: ["https://github.com/BestNathan/nession/issues/2751", "https://github.com/BestNathan/nession/pull/2771", "https://github.com/BestNathan/nession/blob/9230d49c3a3ae51e5cfe9f3c4551743135486950/docs/design/design-system/patterns/file-workspace.md", "https://github.com/BestNathan/nession/blob/9230d49c3a3ae51e5cfe9f3c4551743135486950/crates/nession-protocol/src/contracts/file/v1.rs", "https://github.com/BestNathan/nession/blob/9230d49c3a3ae51e5cfe9f3c4551743135486950/crates/nession-agent/src/fs/ops.rs", "https://github.com/BestNathan/nession/blob/9230d49c3a3ae51e5cfe9f3c4551743135486950/web/src/capabilities/files/model/fileRef.ts", "https://github.com/BestNathan/nession/blob/9230d49c3a3ae51e5cfe9f3c4551743135486950/web/src/capabilities/files/model/createTarget.ts", "https://github.com/BestNathan/nession/blob/9230d49c3a3ae51e5cfe9f3c4551743135486950/web/src/capabilities/files/hooks/useFileViewer.ts"]
---

# Files capability identity, creation context and safe mutation ownership

## Decision

Files is a **source-scoped capability**, not a path browser over one implicit
host. A file reference is `{sourceId, path}`; the path means nothing outside the
`FileSource` that produced it. The client resolves a source from the active
Session's agent transport (`FilesPlugin`/`FileOps`), names it explicitly, and
renders an unavailable state when no provider exists. It does not fall back to
the host, to another Session, or to a stale provider when the source changes.
The committed design owner is
[file-workspace.md](https://github.com/BestNathan/nession/blob/9230d49c3a3ae51e5cfe9f3c4551743135486950/docs/design/design-system/patterns/file-workspace.md).

Creation and upload have **one captured destination per operation**. When the
form opens, resolution order is: the right-clicked entry (a directory is
itself, a file is its parent), then the selected entry (same rule), then the
active entry, then the browser's current directory. The destination is frozen
for that operation and shown before submit; a later selection or browse change
does not redirect a form already being filled. The App applies the same rule to
its pushed directory: folder actions explicitly name the pushed folder, and a
successful create reveals the untouched target in that parent.

Editing is **read first**. A file opens in a viewer with an explicit Edit
action; content, dirty state and the revision it was loaded at are owned by the
viewer instance. Saving sends that revision, and the agent refuses the write if
the file changed after the read. The client turns that refusal into a choice
between reloading the newer content and explicitly overwriting it, preserving
the local edit while the choice is open.

## Mutation contract

The file contract grows three additive optional guards (serde defaults keep old
peers working):

- `create_only` on write and directory creation;
- `no_replace` on rename;
- `expected_revision` on write, with the current revision returned by reads
  and writes.

The Agent is the writer for its host view, so one per-Files mutation lock makes
"check the expected state, then replace" a single decision instead of two that
a concurrent request can interleave. Create-only uses a hard link (falling back
to `create_new`) so the destination is reserved atomically; rename checks the
destination with `symlink_metadata` and refuses; a write whose expected revision
no longer matches, or whose file was removed, is an `already_exists`/`conflict`
error rather than a silent overwrite. The wire error prefixes are stable and
the client classifies them into actionable messages.

The Agent's path sandbox root (its configured file root, which follows
`default_working_dir`) is a **browse root**, not a Sandbox policy. Absolute
paths outside it are deliberately reachable for terminal parity, so this
capability must never present the root as an isolation boundary. Sandbox
policy, mounts, capabilities and unsupported-backend failures remain #2681's.

## Byte/text boundary

Chunked reads advance the request offset by the raw byte count the Agent
returned, never by the decoded JavaScript string length. A streaming
`TextDecoder` carries a UTF-8 sequence split across chunks into the next chunk,
and an empty non-final chunk fails closed instead of spinning or truncating.
Large files stay explicitly read-only rather than pretending a guarded save is
available.

## Evidence

- Requirement: [#2751](https://github.com/BestNathan/nession/issues/2751);
  implementation PR [#2771](https://github.com/BestNathan/nession/pull/2771).
- Exact merged staging commit: `9230d49c3a3ae51e5cfe9f3c4551743135486950`.
- Source-aligned Acceptance Cases: SC-01 identity/resolver, SC-02 Web creation
  context, SC-03 App pushed-directory/read-first/unsaved guard, SC-05 split
  UTF-8 chunks, SC-06 flows/docs/labels, and the staging SC-04 real-Agent RPC
  create-only/no-replace/stale-revision proof.
- New browser E2E `files-context-create` exercises the Web/App flows against
  the canonical fixture; the fixture FileOps is a mutable in-memory file system
  with real revisions so the conflict path is executable without a network.

## Limits / when to revisit

This is not Sandbox isolation, and the mock/prototype is not production
evidence. Cross-source move/copy, global search, resumable uploads and server-
side authorization remain out of scope. Revisit if Files gains a second
concurrent writer path outside the Agent, if a source can be retargeted without
a provider change, or when #2681 ships a real SandboxPolicy view that Files must
consume rather than the current browse-root convention.

### Related knowledge

- [Nession Sandbox policy and execution isolation architecture](../engineering/nession-sandbox-policy-and-execution-isolation-architecture.md) — the Sandbox owner; Agent-host Files is not that policy.
