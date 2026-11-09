# Project

> Upstream: [`VISION.md`](../../VISION.md) → [`PRINCIPLE.md`](../../PRINCIPLE.md) → [product-model.md](product-model.md)

A **Project** is a first-class, long-lived **declaration** of work resources and Session presets. It is not an Agent, a Sandbox, an EROFS image, a Workspace, or a persistent environment object.

This document is the canonical owner for Project / Workspace / Location / Session / Image ownership. It reconciles the earlier inferred Workspace-Location model ([#739](https://github.com/BestNathan/nession/issues/739)) without redefining Workspace.

## What a Project owns

```text
Project (server-owned declaration)
├── identity                 stable `project-<uuid>`, minted once by the Server
├── name / description       user-facing declaration text
├── Git Source (optional)    { repository_url, ref: branch | full commit SHA }
├── Existing Locations       zero or more { agent_id, path } references
├── Session defaults         optional shell / env profile ids / sandbox policy ref
└── Image digest (optional)  immutable reference to a shared EROFS artifact
```

A Project can exist with no Agent, no Git source, no location and no Session. It may be created and edited while every referenced Agent is offline. Nothing in this model makes a Project a mandatory navigation parent for Sessions.

### Existing Locations

An Existing Location is a **user-owned host directory**: a pair of an Agent identity and an absolute path.

- The Project **references** the directory; it does not own it.
- Editing or deleting a Project never clones, mutates or deletes its Existing Locations.
- An Agent does not need to be online or registered for a valid Project to persist. Online/offline is an observation, not a write precondition.
- An Existing Location is not a managed location. Provisioning, mounting and materialization belong to the separate managed-location work ([#3022](https://github.com/BestNathan/nession/issues/3022)–[#3024](https://github.com/BestNathan/nession/issues/3024)).

### Git Source

The optional Git Source declares where the work comes from and which branch or full commit SHA it intends to use. It is a declaration only: credentials, cloning and checkout are capabilities outside this slice. Validation is deterministic; an absent source is valid.

### Session defaults

Session defaults describe what a new Session created in the Project should start from. They are **desired defaults**, not a binding: the actual Session environment reconciliation remains owned by [#170](https://github.com/BestNathan/nession/issues/170). A legacy Session with no Project association remains valid.

### Image reference

An optional `image_digest` is an immutable reference (`sha256:<64 hex>`) to an EROFS artifact owned by the global Image Manager. A Project never owns blob bytes, a build engine or a store. Deleting a Project removes only the declaration; globally shared content and every other Project referencing the same digest are untouched.

## Ownership map

| Concept | Nature | Owner |
|---|---|---|
| Project | Persistent declaration of resources and Session presets | Server (`server.project.*` protocol units); types in `nession-protocol`; Web/App presentation owned by [#3025](https://github.com/BestNathan/nession/issues/3025) |
| Workspace | Contextual UI/capability surface around the current work | [workspace.md](workspace.md) |
| Workspace Location | Physical realization of part of the work (Agent/provider + directory/environment) | [product-model.md](product-model.md) |
| Existing Location | A Project's reference to a user-owned Agent directory | This document |
| Session | Primary active work object; executes on one location today | [product-model.md](product-model.md) |
| EROFS image / digest | Globally deduplicated artifact owned by the Image Manager | Follow-up [#3022](https://github.com/BestNathan/nession/issues/3022) |
| Agent | Infrastructure context: node-side execution endpoint | [product-model.md](product-model.md) |

There is no persistent `ProjectEnvironment` type. The Server stores the Project declaration and its Session defaults; materializing an environment is a Session-owned concern ([#170](https://github.com/BestNathan/nession/issues/170)) and a managed-location concern ([#3024](https://github.com/BestNathan/nession/issues/3024)).

## Relationship to Workspace and the existing inferred locations

Workspace remains the **contextual** surface described in [workspace.md](workspace.md); it is not automatically duplicated into a persistent object per Project.

The implementation before this model inferred logical Workspace identity and Workspace Locations from Session + Agent + current-directory facts ([#739](https://github.com/BestNathan/nession/issues/739)). That inference is mapped explicitly, not silently redefined:

- a previously inferred location becomes an **Existing Location** only when a user explicitly declares `{agent_id, path}` on a Project;
- a Session without a Project keeps working and remains a valid Session;
- the Web/App may present Project information in Session context, but Project is not a required parent of Session navigation.

Workspace can therefore be understood as the current contextual projection over one or more explicitly declared Projects, Sessions and locations. It does not become a second persisted Project copy.

## API and persistence boundary

The Server is the owner of Project persistence, identity and authorization:

- `server.project.create`, `.list`, `.get`, `.update`, `.delete` are versioned Protocol Units;
- `update` is a whole replacement of the mutable declaration, so an edit cannot silently leave a stale location or source behind;
- identity shape, URL/ref, path, agent-id, digest and bounds validation is canonical in `nession-protocol` and reused by consumers;
- reads and writes require an authenticated client;
- list and detail reads work with zero Sessions and no selected Agent;
- deletion removes only the declaration — it never cascades to Sessions, user-owned directories or shared image content.

Project navigation, Sidebar/App entry points, row actions and the standalone detail view belong to [#3025](https://github.com/BestNathan/nession/issues/3025).

## Non-goals

- No EROFS store, build engine or blob ownership in Project.
- No Sandbox Policy implementation ([#2681](https://github.com/BestNathan/nession/issues/2681)).
- No automatic scheduler.
- No GitHub credentials integration.
- No mandatory Sessions-by-Project grouping.
- No new WorkContract hierarchy ([#2541](https://github.com/BestNathan/nession/issues/2541)).
