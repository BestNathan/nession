# Workspace

Workspace is a container for **session-scoped auxiliary capabilities**, not a synonym for File Browser.

It exists because the terminal is sometimes insufficient: browsing the remote tree, inspecting Session metadata, or reading Agent/connection detail. Those capabilities belong to the Active Session, not to a global app chrome.

## Initial tools

```text
Workspace
├── Files
├── Session
└── Agent
```

| Tool | Role | Typical layout |
|------|------|----------------|
| Files | Remote file browser and editor | Master/detail (browser + editor) **inside this tool** |
| Session | Session details (identity, lifecycle, attach/kill affordances as appropriate) | Single detail surface |
| Agent | Agent details and connection | Single detail surface |

Git, Preview, Processes, and similar tools are **not** required for the first migration. The architecture must allow them later without rewriting the Workspace shell.

## Tool registry

Prefer a Workspace tool registry over hard-coded tab conditionals. A tool is a **plugin**: it owns its label, icon, order, availability, and its own layouts per experience. Adding a tool = one file + one registry line; the framework (shell, tool bar, container) does not change. Conceptual shape (matches the shipped contract):

```ts
interface WorkspaceTool {
  id: WorkspaceToolId
  label: string
  icon: Icon
  order: number
  availability: (ctx: WorkspaceContext) => boolean
  layout: {
    web: ComponentType<{ ctx: WorkspaceContext }>   // per-experience layout
    app: ComponentType<{ ctx: WorkspaceContext }>   // per-experience layout
  }
}
```

Workspace navigation is extensible by registering tools, not by growing a switch of special cases in the shell.

- **Per-experience layouts.** Web/App differences live in `layout.web` / `layout.app` — never scattered `if (mobile)` metrics inside a shared component. Files is exactly this: web = tree ‖ editor, app = tree full-screen → push editor; the pushed editor carries a tool-internal sub-header (`←` + file path, dirty-confirm back); session/agent tools provide app containers (full-screen scroll + bottom safe-area clearing the home indicator and the floating tool bar) rather than shared web fallbacks.
- **No fixed pixels for structure.** Tool-internal layouts use grids and proportions (Files web = CSS grid, tree `1fr` ‖ editor `2fr`); spacing comes from `--sf-space-*` / Experience tokens, widths from proportion or content.
- **Availability is per-Session** (e.g. Files when the Agent exposes no file API). A tool may also choose not to register at all — hidden tools leave no empty chrome. Registered-but-unavailable tools render as **disabled pills** (inert) in the tool bar — visible, not clickable — never as empty slots.
- The framework renders a registry-driven **bottom floating tool bar** (label / icon / order / availability → disabled state) plus the active tool's layout for the current experience. It is the workspace's **only floating element**, same capsule family (radius / elevation / tokens) as the terminal input capsule.

## Master/detail is local to Files

Files may use a browser/editor split:

```text
Files

┌──────────────────────┬────────────────────────────────────┐
│ File Browser         │ Editor                             │
│                      │                                    │
│ src/                 │ AgentCard.tsx                      │
│ ├ components/        │                                    │
│ ├ hooks/             │ export function ...               │
│ └ lib/               │                                    │
└──────────────────────┬────────────────────────────────────┘
```

This layout belongs to the **Files tool**, not to Workspace globally. Agent and Session tools can use a single detail surface. Future tools choose their own internal layout.

Do not introduce a permanent full-width inner sidebar at the Workspace level in order to mimic Files. Platform chrome for switching tools is documented in [interaction/web.md](interaction/web.md) and [interaction/app.md](interaction/app.md).

## Relationship to Terminal

Terminal and Workspace are peer surfaces of the Active Session (same slot; Terminal is the default). Only one is visible. Switching surfaces does not change which Session is active, and does not nest Workspace inside the terminal (or the reverse).

See [information-architecture.md](information-architecture.md) for the IA tree.
