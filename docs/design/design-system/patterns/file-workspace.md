# FileWorkspace

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [product model](../../product-model.md) → [workspace](../../workspace.md)

FileWorkspace is the **Files capability view** for resources that belong to the current logical Workspace.

Its browser/editor composition is local to Files. It is not the Workspace shell, not a permanent peer of Terminal, and not proof that Workspace equals one remote directory.

## Purpose

Let users browse and edit Workspace resources when file-oriented interaction is useful to the current work.

The view should work with today's Session/Agent-backed filesystem while remaining compatible with a logical Workspace that can span multiple Locations and providers.

## Resource scope

Files may be scoped to:

```text
Logical Workspace
    ├── Workspace Location A / resource source
    ├── Workspace Location B / resource source
    └── shared / provider-backed resources
```

A current Session normally gives Nession a useful default Location and working directory, but that default must not permanently define the Workspace's entire file model.

Local and remote are properties of resource sources / Workspace Locations, not separate Files products.

## Presence

Files is a capability, not a guaranteed navigation slot.

```text
unavailable
    -> no dead Files entry required

available
    -> discoverable when useful

relevant
    -> may gain direct Workspace presence

active / explicitly opened
    -> show FileWorkspace
```

If the current work has no meaningful file capability, Workspace should not advertise an inert Files area simply because Nession supports files elsewhere.

## Anatomy

A wide Web presentation may use master/detail:

```text
Files
┌─ Resource browser ─────┬─ Editor / viewer ────────────────┐
│ Workspace / location   │ selected file                     │
│ src/                   │                                   │
│ ├ components/          │                                   │
│ ├ hooks/               │                                   │
│ └ lib/                 │                                   │
└────────────────────────┴───────────────────────────────────┘
```

| Part | Role |
|------|------|
| Resource scope | Communicates Workspace / Location source only when ambiguity exists |
| Browser | Tree/list, path context, file operations |
| Editor / viewer | Open file content; local tabs may exist inside this capability |
| Empty detail | No file selected; remains local to the Files view |
| Split | Files-specific master/detail on sufficiently wide Web layouts |

On App or narrow layouts, prefer browser → pushed editor/viewer instead of preserving the desktop split.

## Multi-location behavior

When Workspace spans multiple Locations:

- the user must be able to understand which source a file belongs to when ambiguity matters;
- a sensible current/default Location may be selected from Session context;
- additional Locations should be progressively disclosed rather than always consuming a permanent column;
- one unreachable Location must not automatically hide the whole Files capability if other sources remain usable;
- cross-location operations must make source/destination context explicit before destructive or ambiguous actions.

Do not build a permanent node selector merely because multi-location is possible. Show location choice when the current operation needs it.

## Availability and failure

Availability is scoped to the resource source, not necessarily to the whole logical Workspace.

| Condition | Behavior |
|-----------|----------|
| No file provider for current context | Files may stay hidden or be discoverable as unavailable only where explanation is useful |
| Current/default Location reachable | Normal browser/editor experience |
| One Location offline | Preserve other usable sources; affected source shows contextual reachability problem |
| Session exited but resource source still reachable | Files may remain readable/editable according to provider capability |
| File provider unavailable | State names provider/Agent/location reachability rather than falsely declaring the Session dead |

The Files view should not reuse a fused Session status as its availability model.

## Relationship to Session and Terminal

A Session can provide current-directory and active-Location context, but FileWorkspace is a Workspace capability view rather than a child of terminal rendering.

Opening Files should feel like moving deeper into the work context, not switching to a different application.

Exact presentation is experience-specific:

- Web may replace the active content region, open contextual depth, or use another approved Workspace composition;
- App normally opens inside the Workspace spatial layer / navigation stack;
- Terminal state should be preserved when possible so returning to current work is immediate.

Do not require a permanent `Terminal | Workspace | Files` mode bar.

## Tokens

| Part | Tokens |
|------|--------|
| Workspace/File surfaces | Domain `workspace.*` / Semantic surfaces |
| Selection | Domain `file.selected` |
| Diff/status | Domain `file.modified` `file.created` `file.deleted` |
| Editor | Domain `editor.*` |
| Split/divider | Semantic border + Experience density |
| Source/location metadata | Semantic secondary text; infrastructure Domain state only when relevant |

No Primitive palette classes in product-level Files UI.

## Web vs App

| | Web | App |
|--|-----|-----|
| Browser/editor | Side-by-side when width and task justify it | Navigation stack: browser → editor/viewer |
| Location/source choice | Contextual control, picker, breadcrumb, or section only when needed | Push/sheet/picker as appropriate |
| Workspace navigation | Outside the Files-specific master/detail | Workspace stack/root owns capability navigation |
| Terminal | Preserve Session runtime; presentation may move away from Terminal while Files is open | Workspace layer covers/replaces current Terminal presentation until dismissed |

## Visual contract

### Dominance

- When explicitly opened, selected file/editor content is primary within the Files view.
- Browser, source metadata, and file operations are supporting structure.
- Files chrome must not look like a second global application shell.

### Surface treatment

- Dense file/editor panes may use separators where needed.
- Avoid wrapping the entire capability in decorative cards.
- Location/source metadata remains quiet until needed for disambiguation or failure.

### Progressive disclosure

Common file navigation stays immediate. Advanced file operations, provider choice, cross-location actions, and infrastructure diagnostics should appear only when requested or contextually necessary.

## Anti-patterns

- Defining Workspace as the directory of the active Session.
- Assuming all files are remote or all resource access comes from one Agent.
- Hiding Files globally because one Workspace Location is offline.
- Permanent source/location selector when there is no ambiguity.
- Files permanently beside Terminal merely because both capabilities exist.
- Files as a mandatory Workspace tab.
- Applying Files master/detail to unrelated Workspace capabilities.
- A second app-wide sidebar whose only job is listing file/resource capabilities.

## Acceptance for future implementation work

- [ ] FileWorkspace is scoped to logical Workspace resources, with a Session-derived Location allowed as the current default.
- [ ] The design can represent more than one Workspace Location/resource source.
- [ ] One source failure does not automatically invalidate every Files source.
- [ ] Files presence follows capability/context state rather than permanent registration.
- [ ] Master/detail remains local to Files and adapts to App/narrow layouts.
- [ ] Source/location context is shown when it matters and allowed to disappear when it does not.
- [ ] Returning to the Session preserves continuity rather than recreating terminal/runtime state unnecessarily.
