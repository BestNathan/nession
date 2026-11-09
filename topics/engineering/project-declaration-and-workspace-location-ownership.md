---
title: "Project declaration and Workspace location ownership"
description: "First-class server-owned Project declaration of Git source, Existing Locations, Session defaults and an image digest reference, plus the Project maintenance UI, Project-aware Existing Session creation with Session-owned ENV bindings, durable Session→Project membership and the context-sensed Project capability"
topic: engineering
categories: ["architecture", "project", "workspace", "session", "ownership", "server", "protocol"]
status: verified
created_at: 2026-11-09T01:09:24Z
updated_at: 2026-11-09T12:54:48Z
sources: ["https://github.com/BestNathan/nession/issues/3021", "https://github.com/BestNathan/nession/pull/3046", "https://github.com/BestNathan/nession/blob/54e3044acd9641eb9990af8a6d638869654e4425/docs/design/project.md", "https://github.com/BestNathan/nession/blob/54e3044acd9641eb9990af8a6d638869654e4425/crates/nession-protocol/src/contracts/project/v1.rs", "https://github.com/BestNathan/nession/blob/54e3044acd9641eb9990af8a6d638869654e4425/crates/nession-server/src/db/migration/m005_projects.rs", "https://github.com/BestNathan/nession/issues/3025", "https://github.com/BestNathan/nession/pull/3064", "https://github.com/BestNathan/nession/blob/0929326e13c4349a5798064e931789b27d84597a/crates/nession-protocol/src/contracts/session/v1.rs", "https://github.com/BestNathan/nession/blob/0929326e13c4349a5798064e931789b27d84597a/crates/nession-server/src/server/handler/server_session_create_v1.rs", "https://github.com/BestNathan/nession/blob/0929326e13c4349a5798064e931789b27d84597a/web/src/app/patterns/ProjectsSection.tsx", "https://github.com/BestNathan/nession/blob/0929326e13c4349a5798064e931789b27d84597a/web/src/product/project/components/ProjectDetail.tsx", "https://github.com/BestNathan/nession/issues/3082", "https://github.com/BestNathan/nession/pull/3102", "https://github.com/BestNathan/nession/pull/3120", "https://github.com/BestNathan/nession/blob/5e9a2d82118a8ea4da2b2418af6b161d86bf3841/docs/architecture/erofs-image-manager.md", "https://github.com/BestNathan/nession/blob/a1f90a2ef226dba1a578e0dd7330157819bce3c5/crates/nession-protocol/src/contracts/session/v1.rs", "https://github.com/BestNathan/nession/blob/a1f90a2ef226dba1a578e0dd7330157819bce3c5/crates/nession-server/src/db/migration/m006_session_project_bindings.rs", "https://github.com/BestNathan/nession/blob/a1f90a2ef226dba1a578e0dd7330157819bce3c5/crates/nession-server/src/server/handler/server_session_project_set_v1.rs", "https://github.com/BestNathan/nession/blob/a1f90a2ef226dba1a578e0dd7330157819bce3c5/crates/nession-server/src/registry/session.rs", "https://github.com/BestNathan/nession/blob/a1f90a2ef226dba1a578e0dd7330157819bce3c5/web/src/capabilities/project/model.ts", "https://github.com/BestNathan/nession/blob/a1f90a2ef226dba1a578e0dd7330157819bce3c5/web/src/app/workspace/ProjectWorkspaceView.tsx", "https://github.com/BestNathan/nession/blob/a1f90a2ef226dba1a578e0dd7330157819bce3c5/e2e/acceptance/cases/3082/SC-07/verify.cjs"]
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
  (#170); the [global EROFS Image Manager](global-erofs-image-manager.md)
  owns build/store (#3022, delivered at `5e9a2d821`), while managed
  creation/mount remains #3062/#3024.
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
- **A sibling destination, not a Session parent.** Web Sidebar and the App
  Sessions layer expose a flat, selectable Projects section; opening one shows a
  standalone detail without requiring, selecting, replacing or re-parenting a
  Session. App pushes the detail with exactly one host-owned header and returns
  through Back; Web keeps the list and the selected Session intact.
- **Project-aware creation is additive.** `server.session.create` accepts an
  optional `project_id`. When present, `agent_id` and `working_dir` must match a
  declared Existing Location, and the Project never reaches the Agent. Missing
  or offline Agents are explicit refusals that preserve the declaration; legacy
  and no-Project creates are unchanged.
- **Defaults are create-time suggestions; the binding is Session-owned.**
  Precedence is explicit request ENV selection over the Project's ordered
  `env_profile_ids`. The resolved ENV binding belongs to the Session, so a later
  Project edit never changes an existing Session's environment, source version
  or mounts.
- **Managed EROFS/Sandbox creation is a separate requirement.** It is owned by
  #3062 and remains blocked on #3023, #3024 and #2681; the #3022 image
  build/store dependency is delivered. The Project detail
  exposes a Managed entry that fails closed: it creates nothing, preserves the
  declaration and never falls back to a Native Session.
- **Session→Project membership is zero-or-one and Server-owned.** A Session may
  carry one explicit Project membership. `m006_session_project_bindings`
  persists it in `session_project_bindings` keyed by `session_id` with
  `agent_id`, `project_id`, the Session incarnation and a monotonic `revision`;
  the Agent-reported `sessions` row remains a recovery/list cache, not the
  membership authority. `server.session.project.set` associates, changes or
  removes the membership with an authenticated caller, a known Session and
  Project, and an optional `expected_revision` that makes a stale write a
  `conflict`. `server.session.create` commits the initial membership together
  with the Session and returns `project_id`; `server.session.list` and
  `sessions.changed` project the same field. Ordinary and legacy Sessions stay
  valid with no membership.
- **Membership is fenced to the Session incarnation, not its name.** The binding
  adopts the tmux `@nession_instance_id` that the Agent now carries on
  `agent.session.report` and `server.agent.session-update`; the Server persists
  it on the Session recovery row, with tmux `created_at` as the legacy fallback.
  A created Session binds optimistically to its reported incarnation; a Session
  whose name is reused never inherits the previous Project.
- **Membership survives reports; destruction and absence clear it.** Agent
  report/refresh, re-registration, offline grace, transport swaps and a Server
  restart preserve membership. Confirmed Session destruction, a successful
  force-refresh that proves the Session absent, Project deletion and explicit
  Agent deletion clear it in one authoritative transaction. A failed
  `tmux list-sessions` is reported as a failure and never replaces the known
  Session set with an authoritative empty one.
- **Relinking is metadata-only.** Associate/Change/Remove writes no cwd, ENV
  binding, mount, image digest or process change and never deletes the Session.
  It is a membership edit, not a migration or a create-from-Project shortcut.
- **The Project capability resolves only from the focused Session.** The Web
  provider reads the focused Session's persisted `project_id`: unbound Sessions
  show no Project presence, a bound authorized Project becomes `relevant`, and
  opening its Peek or Workspace view makes it `active` for that interaction.
  Focusing A→B recomputes from B alone (no carry-over), an offline Agent does
  not erase the context, and a deleted or unauthorized Project reports a safe
  unavailable state without disclosing stale settings. The Terminal capsule
  chip/Peek, the Workspace Project view and the standalone Project detail reuse
  the same Project identity and content; a Project's related-Sessions section
  is a read projection, not a Sidebar hierarchy. Web and App keep the flat
  Session list; App keeps its single host-owned header/Back.
- **The prototype proof is a readback Case, not Agent visibility.** SC-07 is
  proven by an exact-SHA `runtime` Case that reads the reviewed public prototype
  source, the live Pages manifest/gallery and the archived Chromium record
  (32/32 assertions), because a read-only Acceptance Agent cannot access the
  orphan `prototype` branch or local HTTP. A general orphan-source staging
  mechanism remains #3068.

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
canonical document.

#3025 (PR #3064, merged to staging at
`0929326e13c4349a5798064e931789b27d84597a`) delivered the Project maintenance
surface and the Existing-location create path: Web/App Projects navigation and
standalone detail, name-only create, rename/settings/delete with explicit
confirmation, optional `project_id` on Session create, Project ENV defaults with
explicit-request precedence, and the fail-closed Managed entry. Its SC-01,
SC-03, SC-04, SC-06, SC-07 and SC-08 passed source-aligned Cases at PR head
`49f811938b05ab30493f57ff9379c332588ca97d`; the selected E2E IDs
(`project-management`, `project-sidebar-detail`, `project-session-create` and
the `fixture-*`/`session-lifecycle` regressions) passed in run 42563353256. The
Managed EROFS/Sandbox criteria moved to #3062 and stay Pending until its native
staging lane exists. Because the read-only Acceptance Agent cannot see the
orphan `prototype` branch, SC-06 is proven by a Case that reads back the pinned
public Pages manifest/HTML and the archived Chromium record; a general
orphan-source staging proposal is #3068.

#3082 (PR #3102, merged to staging at
`a1f90a2ef226dba1a578e0dd7330157819bce3c5`) delivered the durable Session→Project
membership and the context-sensed capability. The Server migration
`m006_session_project_bindings` adds the binding table and the Session
recovery row's `instance_id`; the Agent carries the tmux
`@nession_instance_id` on its Session reports and updates; the Web Project
capability reads the focused Session's persisted `project_id` and renders a
capsule chip, Peek and Workspace view over the existing Project detail. The
Issue's seven source-aligned Cases passed pre-merge (Case Smoke run
`42582458224` at `ddc9c5180`), the selected E2E run `42582458220` passed on the
same head, and SC-07's readback Case verified the reviewed prototype revision
`3e6d994677a9c10405e862e40abb80154b22995f`, the live Pages manifest/gallery and
the archived 32/32 Chromium record. #3062 still owns Managed EROFS creation.

## Limits and when to revisit

- This article does not describe EROFS build/registry or image storage; a
  Project only references an immutable digest owned by the
  [global EROFS Image Manager](global-erofs-image-manager.md), which owns the
  deterministic build, content-addressed bytes, aliases and authorized access.
- A Project has no mandatory Agent binding, and it is not a navigation parent.
  The delivered Projects section is a sibling destination over a flat Session
  list; it must keep legacy Sessions with no Project valid.
- Managed EROFS/Sandbox Session creation is not implemented. #3062 owns that
  behavior; until its dependencies land, the detail's Managed action refuses
  explicitly rather than creating a Native Session.
- The JSON-encoded declaration columns are a Server-owned storage detail. If a
  second writer appears, it must consume the canonical validation rather than
  write those columns directly.
- Project deletion is explicit and refuses an absent identity; there is no
  destructive cascade by design. It does clear Session memberships in the same
  transaction, so affected Sessions become unassociated rather than joining
  another Project.
- Session membership is metadata, not an authorization scope. The repository
  has a single authenticated Server identity today, so the Project API's
  `unauthorized` is the unauthenticated case; a future multi-tenant owner must
  feed the same handler rather than add a parallel check in the Web client.
- The Project chip is terminal-capsule chrome: it is rendered once the focused
  Terminal surface is attached. The membership itself is already persisted, so
  an Agent being offline does not erase the Session's Project context; only an
  unavailable Project summary degrades the chip's label and actions.

Related knowledge:

- [Session and Project operation surface presentation by Experience](../web/session-and-project-operation-surface-presentation-by-experience.md)
  owns how Web and App compose the Project create/settings and Project-aware
  Session create operations over this declaration.
- [Session metadata and display identity ownership](session-metadata-and-display-identity-ownership.md)
  owns the Session-scoped metadata store and the tmux `@nession_instance_id`
  fence that Project membership also uses; a Project's Session defaults do not
  replace Session-owned metadata.
- [Nession Sandbox policy and execution isolation architecture](nession-sandbox-policy-and-execution-isolation-architecture.md)
  owns the policy behind the Project's optional `sandbox_policy_ref`; the
  Project stores only the desired reference.
