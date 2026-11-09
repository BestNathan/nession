---
title: "Project declaration and Workspace location ownership"
description: "First-class server-owned Project declaration of Git source, Existing Locations, Session defaults and an image digest reference, with the canonical Project/Workspace/Location/Session/Image ownership boundary"
topic: engineering
categories: ["architecture", "project", "workspace", "session", "ownership", "server", "protocol"]
status: verified
created_at: 2026-11-09T01:09:24Z
updated_at: 2026-11-09T01:09:24Z
sources: ["https://github.com/BestNathan/nession/issues/3021", "https://github.com/BestNathan/nession/pull/3046", "https://github.com/BestNathan/nession/blob/54e3044acd9641eb9990af8a6d638869654e4425/docs/design/project.md", "https://github.com/BestNathan/nession/blob/54e3044acd9641eb9990af8a6d638869654e4425/crates/nession-protocol/src/contracts/project/v1.rs", "https://github.com/BestNathan/nession/blob/54e3044acd9641eb9990af8a6d638869654e4425/crates/nession-server/src/db/migration/m005_projects.rs"]
---

# Project declaration and Workspace location ownership

## Decision

A Project is a first-class, long-lived **declaration** of work resources and
Session presets, owned by the Server. It is not an Agent, a Sandbox, an EROFS
image, a Workspace, or a persistent `ProjectEnvironment`.

- **Declaration, not environment.** A Project holds an optional Git source
  (`repository_url` plus a branch or full commit SHA), zero or more Existing
  Locations (`{agent_id, path}`), optional Session defaults (shell, env profile
  ids, sandbox policy ref) and an optional immutable `sha256:<64 hex>` image
  digest reference. Materializing a Session environment remains Session-owned
  (#170); managed EROFS build/mount work belongs to #3022–#3024.
- **Existing Locations are references to user-owned directories.** The Server
  never clones, mutates or deletes them because a Project is edited or deleted.
  An offline or unknown Agent does not prevent persistence: desired references
  are stored, Agent availability is an observation.
- **The Server owns identity and persistence.** Identities are minted as
  `project-<uuid>`; `m005_projects` stores name/description, JSON-encoded source,
  locations and defaults, image digest and timestamps in SQLite. A restart
  restores the same identity and references. Update is a whole replacement of
  the mutable declaration and preserves creation time.
- **Versioned API.** `server.project.create`, `.list`, `.get`, `.update` and
  `.delete` are authenticated Protocol Units. Validation is canonical in
  `nession-protocol` (name/description bounds, URL/ref rules, absolute
  non-parent paths, Agent ids, env profile ids, digest shape); refusals carry
  stable `invalid` / `not_found` / `unavailable` / `unauthorized` kinds.
- **No cascade and no ownership of shared bytes.** Deleting a Project removes
  only the declaration. Existing Location directories, other Projects
  referencing the same digest, and unrelated Sessions survive.
- **Reads are independent of Sessions and Agents.** List and detail reads work
  with an empty Session registry and no selected Agent; a legacy Session with no
  Project association remains valid.

## Context and evidence

The earlier product model inferred logical Workspace identity and Workspace
Locations from Session + Agent + current-directory facts (#739). #3021 maps that
inference explicitly rather than redefining it: a previously inferred location
becomes an Existing Location only when a user declares `{agent_id, path}` on a
Project. Workspace remains the contextual UI/capability surface
(`docs/design/workspace.md`); it is not duplicated into a persistent object per
Project.

The canonical domain document is
[the project design document](https://github.com/BestNathan/nession/blob/54e3044acd9641eb9990af8a6d638869654e4425/docs/design/project.md),
which states the Project / Workspace / Workspace Location / Existing Location /
Session / EROFS image / Agent ownership map and records that no persistent
`ProjectEnvironment` type exists. `product-model.md`,
`information-architecture.md` and `workspace.md` link to it.

The contract landed with #3021 (PR #3046, merged to staging at
`54e3044acd9641eb9990af8a6d638869654e4425`). Source-aligned Cases SC-01–SC-04
and SC-06 ran exact-SHA Rust protocol/DB/handler tests; SC-05 evaluated this
canonical document. Web Sidebar/App presentation, Standalone Project detail and
Existing/Managed Session creation are owned by #3025.

## Limits and when to revisit

- This article does not describe EROFS build/registry or image storage; a
  Project only references an immutable digest owned by the global Image Manager.
- A Project has no mandatory Agent binding, and it is not a navigation parent.
  Any future grouping of Sessions by Project (#3025) must preserve legacy
  Sessions with no Project.
- The JSON-encoded declaration columns are a Server-owned storage detail. If a
  second writer appears, it must consume the canonical validation rather than
  write those columns directly.
- Project deletion is explicit and refuses an absent identity; there is no
  destructive cascade by design.

Related knowledge:

- [Session metadata and display identity ownership](session-metadata-and-display-identity-ownership.md)
  owns the Session-scoped metadata store and display alias that a Project's
  Session defaults do not replace.
- [Nession Sandbox policy and execution isolation architecture](nession-sandbox-policy-and-execution-isolation-architecture.md)
  owns the policy behind the Project's optional `sandbox_policy_ref`; the
  Project stores only the desired reference.
