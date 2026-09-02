# FileWorkspace

The **Files** tool: browser + editor master/detail. This layout is **local to Files**, not to Workspace.

## Purpose

Browse and open remote files for the active Session when the terminal is not enough.

Must not:

- Become the Workspace shell or the Web default split next to Terminal.
- Force master/detail onto Session or Agent tools ([workspace.md](../../workspace.md)).
- Live as a peer of Terminal at the SurfaceSwitcher level (Files is a Workspace tool).

Related overlap: [#207](https://github.com/BestNathan/nession/issues/207) (filebrowser UX). This spec does not replace that issue’s finder/multi-select/keyboard work; coordinate during implementation.

Shipping `FileBrowser.tsx` is a predecessor for the **browser pane** only.

## Anatomy

```text
Files tool (inside Workspace)

┌─ FileBrowser ──────────┬─ Editor ─────────────────────────┐
│ src/                   │ AgentCard.tsx                    │
│ ├ components/          │                                  │
│ ├ hooks/               │                                  │
│ └ lib/                 │                                  │
└────────────────────────┴──────────────────────────────────┘
```

| Part | Role |
|------|------|
| Browser | Tree/list, path chrome, file operations |
| Editor | Open file(s). Tabs **inside this pane** are Files-tool chrome, not SurfaceSwitcher |
| Empty editor | No file open: empty state in the detail pane, not a prompt to leave Workspace |
| Split | Master/detail **inside FileWorkspace**. On narrow Web, stacked or browser-then-editor is allowed. On App, stack: browser → push editor ([interaction/app.md](../../interaction/app.md)) |

WorkspaceNavigation remains **above** this split (Web) or **under** the Workspace root (App). Do not add a third app-wide sidebar for files.

## States

FileWorkspace uses **file/editor** domain tokens plus Session reachability for the file API.

| Concern | Presentation |
|---------|----------------|
| `file.selected` | Browser highlight |
| `file.modified` / `created` / `deleted` | Editor/browser marks |
| Editor chrome | `editor.background` `editor.gutter` `editor.activeLine` |
| Agent `offline` | Files `availability` may hide the tool, or show a Files-level error that the **file API** is unreachable — copy names Agent/connectivity, not “Session offline” |
| Session `exited` | Files may be read-only or unavailable; do not imply Agent is down |

Do not use ConnectionStatus’s three channels as file row colors.

## Tokens

| Part | Tokens |
|------|--------|
| Panes | Domain `workspace.surface`, Semantic `border.subtle` |
| Selection | Domain `file.selected` |
| Diff/status | Domain `file.modified` `file.created` `file.deleted` |
| Editor | Domain `editor.*` |
| Split handle | Semantic border; Experience density |

No Primitive zinc/gray path colors in product TSX.

## Web vs App

| | Web | App ([#473](https://github.com/BestNathan/nession/issues/473)) |
|--|-----|-----|
| Master/detail | Side-by-side when width allows | Navigation stack: list → editor. Do not keep a permanent browser column beside the editor unless it still fits touch IA |
| Gestures | Splitter drag | Inner horizontal swipe must not dismiss Workspace; prefer stack back |
| Terminal | Hidden while Workspace/Files is the surface | Hidden while Workspace layer is open |

## Visual Contract

Derived from [visual-language.md](../../visual-language.md) and Web Workspace canonical screen ([#566](https://github.com/BestNathan/nession/pull/566)).

### Dominance

- FileWorkspace is a **secondary work surface** inside Workspace — auxiliary to the Session, never peer to Terminal at the shell level.
- When Files is active, the **editor content or selected file name** may be primary within the tool; the browser tree is secondary/supporting.

### Information hierarchy

- **Primary (detail pane):** open file content / editor hero.
- **Secondary (browser pane):** tree paths, file names, selection highlight.
- **Tertiary:** path chrome, diff marks, empty-editor placeholder.

### Alignment

- Master/detail split inside the tool only — browser left (Web wide), editor right; App stack: browser → push editor.
- WorkspaceNavigation stays **above** this split (Web) or at stack root (App) — not embedded in the file panes.

### Density

- **Workspace tools density** — dense tree rows and editor chrome ([visual-language.md](../../visual-language.md) §4).
- Editor uses Domain `editor.*` tokens — not shadcn admin card padding.

### Whitespace

- Pane separation: border or background shift between browser and editor — acceptable here because whitespace alone cannot separate two dense work panes (R-S3 content exception).
- Do not wrap the entire Files tool in an outer card that separates it from Workspace shell.

### Contrast

- Selected file: Domain `file.selected` — one accent in the browser pane.
- Modified/created/deleted marks: Domain file tokens — not Primitive palette dots.
- Unreachable file API: `conditional-prominent` local error — names Agent/connectivity, not Session death.

### Surface treatment

- Secondary work surface background shift vs Workspace canvas.
- Bordered split **inside** the tool only — not a shell-level Terminal \| Files split.

### State-driven emphasis

| Condition | Emphasis |
|-----------|----------|
| File selected | Browser row highlight; editor shows content |
| File modified | Domain mark on tab/row — local, not whole-pane alarm |
| Agent offline / file API unavailable | Tool hidden or Files-level error — `conditional-prominent` |
| Session `exited` | Read-only/unavailable — Session channel neutral, not Agent red |

### Anti-patterns

- Default Web layout with Files beside Terminal (permanent split).
- Master/detail layout forced onto AgentDetail or Session tool bodies.
- ConnectionStatus three-channel colors on file rows.
- Files tool as a second app shell with its own persistent outer sidebar.
- App: shrunken side-by-side Web split when stack navigation fits better.

### Canonical reference

- Web: `/#/fixture/workspace` 1440×900 — tree + editor with realistic fixture files ([#566](https://github.com/BestNathan/nession/pull/566)).
- App: `/#/fixture/app` Workspace → Files — `filesApp` push layout ([#568](https://github.com/BestNathan/nession/pull/568)).

## Acceptance

- [ ] Master/detail exists only inside the Files tool.
- [ ] Agent and Session tools do not inherit this split from FileWorkspace.
- [ ] Files is not visible beside Terminal as the default Web shell.
- [ ] App Files uses a stack (or equivalent), not a shrunken Web split by default.
- [ ] Unreachable file API is an Agent/connectivity or availability problem, not “Session offline”.
