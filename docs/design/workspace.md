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

Prefer a Workspace tool registry over hard-coded tab conditionals. Conceptual shape (the concrete API is implementation-specific):

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

Workspace navigation should be extensible by registering tools, not by growing a switch of special cases in the shell.

`availability` may hide a tool for a given Session (for example Files when the Agent does not expose a file API). Hidden tools must not leave empty chrome that implies the tool exists.

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

Terminal and Workspace are peer surfaces of the Active Session. Only one is normally visible. Switching surfaces does not change which Session is active, and does not nest Workspace inside the terminal (or the reverse).

See [information-architecture.md](information-architecture.md) for the IA tree.
