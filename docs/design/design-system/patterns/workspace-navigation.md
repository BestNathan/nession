# WorkspaceNavigation

Tool-level switching **inside** Workspace: Files \| Session \| Agent \| registered others. Not a second app sidebar.

## Purpose

Move between session-scoped tools without rewriting the Workspace shell and without a default permanent full-width inner sidebar ([workspace.md](../../workspace.md), [interaction/web.md](../../interaction/web.md)).

Must not:

- Duplicate [SurfaceSwitcher](surface-switcher.md) (that is Terminal vs Workspace).
- Force Files master/detail chrome onto Session or Agent tools.
- Hard-code a closed `switch (tab)` of tools as the only extension path.

## Anatomy

```text
Workspace
┌─ WorkspaceNavigation ─────────────────────────┐
│  Files    Session    Agent    [ + registered ]│  compact top (Web)
└───────────────────────────────────────────────┘
┌─ Tool body ───────────────────────────────────┐
│  FileWorkspace  XOR  Session details XOR      │
│  AgentDetail  XOR  future tool                │
└───────────────────────────────────────────────┘
```

| Part | Role |
|------|------|
| Tool list | Registered tools in `order`, filtered by `availability` |
| Active tool body | One tool at a time |
| Overflow | If tools do not fit, collapse into a compact menu — still not a full-height sidebar by default |

### Registry

Conceptual contract from the architecture (API is implementation-specific in #471):

```ts
interface WorkspaceTool {
  id: string
  label: string
  icon: unknown
  order: number
  availability: (context: SessionContext) => boolean
  component: unknown
}
```

**Extensibility:** a future tool (Git, Preview, Processes) **registers**. The shell renders whatever the registry returns. Do not add a new top-level pattern unless the tool needs a new composition (as Files needs [FileWorkspace](file-workspace.md)).

`availability === false`: omit the tool. Do not leave a disabled tab that implies the capability exists when the Agent has no file API (for example).

Hidden tools must not reserve empty chrome.

## States

| Nav state | Meaning |
|-----------|---------|
| Tool `id` selected | That tool’s body is shown |
| Tool unavailable | Absent from the nav |
| Zero tools | Should not happen for the initial set if Session+Agent always exist; if it does, show Workspace empty — not Terminal |

WorkspaceNavigation does not present Agent connection as a tab state. Unhealthy Agent may hide Files via `availability` while Session and Agent tools remain.

## Tokens

| Part | Tokens |
|------|--------|
| Nav strip | Domain `workspace.navigation`, Semantic `surface.*` |
| Selected tool | Semantic `accent` / `text.primary` |
| Unselected | Semantic `text.secondary` |
| Tool body | Domain `workspace.background` / `workspace.surface` |
| Size | Experience `control.*` — compact on Web |

## Web vs App

| | Web | App ([#473](https://github.com/BestNathan/nession/issues/473)) |
|--|-----|-----|
| Tool switching | Compact top tabs or equivalent horizontal control | **Native navigation stack** inside Workspace: list of tools → push tool. System back pops within Workspace, not out to Terminal, until the user uses the top-level Workspace dismiss |
| Inner sidebar | Not default | Not default. Files may split *inside* FileWorkspace after push |
| Gestures | N/A | Nested tool swipe must not fight `Sessions ← Terminal → Workspace`. Prefer vertical scroll and explicit back |

## Acceptance

- [ ] Initial tools: Files, Session, Agent (Files may hide if unavailable).
- [ ] No default permanent full-width Workspace-level sidebar.
- [ ] File master/detail is not applied to Agent or Session tools.
- [ ] Spec/implementation path exists to add a tool by registration without editing a hardcoded tab enum as the only means.
- [ ] App: tool navigation is a stack; top-level spatial gestures still dismiss Workspace rather than the inner tool (unless the stack is at root).
