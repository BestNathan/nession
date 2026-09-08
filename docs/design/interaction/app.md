# App Interaction Model

App shares the same domain IA as Web ([information-architecture.md](../information-architecture.md)) but uses a **mobile-native spatial** interaction model. It is not a responsive shrink of the Web layout.

## Spatial model

```text
Navigation             Primary Work             Auxiliary Work

 Sessions     ←──────    Terminal    ──────→      Workspace
```

Default focus is Terminal.

Conceptually the user learns one model:

```text
Navigation  ←  Work  →  Tools
```

## Gestures and visible alternatives

- Swipe right from the Session (Terminal) surface: reveal/open Sessions.
- Swipe left from the Session (Terminal) surface: reveal/open Workspace.
- Sessions and Workspace **must** also have visible controls. Gestures are accelerators, not the only discoverable or accessible path.

Landed in Phase 2C (#561): the single-row App header provides them — `[≡]` Sessions / `[☰]` Workspace on the Terminal page, `[←]` back-to-Terminal on the Workspace page (plus the workspace bottom floating tool bar). The former 44px overlay PanelLeft/PanelRight buttons were removed as duplicates.

## Workspace inside App

Workspace tools use a **normal native navigation stack** internally (push/pop within the tool, system back). Nested tool navigation must not conflict with the top-level `Sessions ← Terminal → Workspace` gestures.

Do not force a Files-style master/detail chrome onto every tool. See [workspace.md](../workspace.md).

Files' App layout pushes the editor with a tool-internal sub-header (`←` + path, dirty edits confirm before leaving); session/agent tools use full-screen scroll containers with bottom safe-area — master/detail stays local to Files.

## Implementation note

The implementation does not need to literally maintain three permanently translated pages. Sessions can be a navigation layer/drawer, Terminal the root content, and Workspace a contextual layer, as long as:

1. The spatial interaction remains coherent (`Navigation ← Work → Tools`).
2. Nested navigation does not fight top-level gestures.
3. Visible non-gesture controls exist for Sessions and Workspace.

## What App must not do

- Ship as a responsive/shrunken Web workspace (no Sessions-sidebar-plus-surface-toggle as the App shell).
- Make gestures the only way to reach Sessions or Workspace.
- Collapse Agent connection, Session lifecycle, and attachment into one status ([product-model.md](../product-model.md)).
- Treat `Sessions ← Terminal → Workspace` as a color or spacing token. It is an interaction pattern, not an Experience token ([design-system/tokens.md](../design-system/tokens.md)).

Platform migration for this model is [#473](https://github.com/BestNathan/nession/issues/473).
