---
title: "Session metadata and display identity ownership"
description: "Session-owned title, description and tags with an Agent store fenced by tmux instance identity; the display title aliases navigation without renaming tmux"
topic: engineering
categories: ["architecture", "session", "metadata", "identity", "ownership", "web", "app"]
status: verified
created_at: 2026-11-05T18:11:33Z
updated_at: 2026-11-11T13:15:17Z
sources: ["https://github.com/BestNathan/nession/issues/2789", "https://github.com/BestNathan/nession/pull/2795", "https://github.com/BestNathan/nession/blob/615da2bf5a40791f91754712fc9cd1ece8b6cb4c/docs/architecture/session-tmux-sdk-ownership.md", "https://github.com/BestNathan/nession/blob/615da2bf5a40791f91754712fc9cd1ece8b6cb4c/crates/nession-agent/src/session/metadata.rs", "https://github.com/BestNathan/nession/blob/615da2bf5a40791f91754712fc9cd1ece8b6cb4c/web/src/product/session/components/SessionMetadataSection.tsx", "https://github.com/BestNathan/nession/blob/615da2bf5a40791f91754712fc9cd1ece8b6cb4c/docs/design/design-system/patterns/session-item.md"]
---

# Session metadata and display identity ownership

## Decision

A Session's user-authored work context is Session-owned state, not tmux state
and not Server state. It consists of `title?`, `description?`, `tags:
string[]` and `revision`/timestamps.

- **The Agent is the only writer.** `SessionMetadataStore` in
  `crates/nession-agent/src/session/metadata.rs` owns
  `~/.nession/agent/sessions/<opaque-session-instance-id>/metadata.json`.
  `nession-tmux` carries no business fields; it exposes only the tmux
  Session's `@nession_instance_id` user option.
- **The instance fence, not the name, keys the store.** The opaque UUID lives
  in the tmux Session, so it survives an Agent restart while that tmux Session
  survives. Killing and recreating the same `agent_id:session_name` creates a
  new fence and therefore no inherited metadata. Absent metadata is revision 0,
  so a legacy Session needs no migration step.
- **Writes are validated, atomic and revision-guarded.** The Protocol Kernel's
  `validate_session_metadata` trims and bounds title/description/tags (Unicode
  scalar values; title 120, description 2,000, 12 tags of 32), rejects
  case-insensitive duplicates and preserves first-seen tag order. The store
  writes temp + rename under one per-instance lock; a stale revision is a
  conflict that leaves the stored metadata intact, and invalid input writes
  nothing.
- **The Server routes; it does not own a second store.** The Agent answers
  `agent.session.metadata.get|update` on both its P2P socket and its central
  connection. `server.session.metadata.get|update` authenticates the client,
  validates `agent:name`, requires an online Agent and forwards the typed
  operation. Stable `error_kind` values (`conflict`, `invalid`, `not_found`,
  `unavailable`, `unauthorized`) survive the translation.
- **Title is a display alias.** Session navigation and the Workspace header use
  the metadata title when set and the tmux name otherwise. `session_id`, the
  tmux name, attach/kill targets and the terminal remain unchanged. Tags and
  descriptions stay in the Workspace details; navigation rows never gain tag
  clouds or cards.

## Context and evidence

The Web reads metadata through the Session product API (`SessionsPlugin`) into
one shared cache, so a save updates both the details editor and row titles
without a list refetch. The details editor is a contained inline editor with
distinct loading, absent-metadata, saving, success, invalid, revision-conflict
and unreachable-Agent states; a conflict keeps the draft until the user
explicitly discards it and loads the remote revision.

The contract landed with #2789. Sources at commit `615da2bf5`:
`docs/architecture/session-tmux-sdk-ownership.md` (ownership section),
`crates/nession-agent/src/session/metadata.rs`,
`web/src/product/session/components/SessionMetadataSection.tsx` and
`docs/design/design-system/patterns/session-item.md`. The verified prototype is
recorded in the product repository at
`docs/design/design-system/patterns/session-metadata-2789-prototype.md`.

## Limits and when to revisit

- This article does not describe Session I/O, observation, history or
  orchestration; those remain a separate model (#2789 explicitly defers them).
- The Server has no mutable metadata cache today. If one is introduced, it must
  be marked last-known and must not become a second authority.
- Workspace identity linkage is still contextual rather than a first-class
  persisted entity. The explicit, persisted projection of work resources and
  Session presets is a Project (#3021); Session metadata remains Session-scoped
  and a Session with no Project association stays valid.
- Retaining a killed instance's metadata directory is deliberate. A future
  cleanup policy must be explicit and must not delete metadata behind the
  user's back.

Related knowledge:

- [App mobile spatial navigation and Terminal touch ownership](../app/app-mobile-spatial-navigation-and-terminal-touch-ownership.md)
  covers the App Workspace depth and Back that the narrow editor relies on.
- [Project declaration and Workspace location ownership](project-declaration-and-workspace-location-ownership.md)
  owns the persisted Project declaration and the explicit mapping of previously
  inferred Workspace Locations.
- [Nession MCP access layer semantic tool ownership and protocol versions](nession-mcp-access-layer-semantic-tool-ownership-and-protocol-versions.md)
  routes MCP Session Tools to this same Agent-owned Session authority instead
  of introducing a second one.
