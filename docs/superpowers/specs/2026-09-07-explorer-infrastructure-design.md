# Explorer Infrastructure — Design Spec

**Date:** 2026-09-07  
**Issue:** [#636](https://github.com/BestNathan/nession/issues/636)  
**Branch:** `feat/explorer-infrastructure` (base: `staging`)

## Overview

Refactor the current `FileBrowser` into a reusable, extensible **Explorer infrastructure** for Nession. The goal is **not** simply to replace the list UI with a tree component — it is to introduce a stable Explorer capability layer whose public API is owned by Nession, while using `react-arborist` only as an internal tree engine.

Future capabilities (Git status, diagnostics, Agent-modified markers, task/process state, plugin-defined node actions) must extend the Explorer **without modifying Explorer core or filesystem node schema**.

## Current State

`web/src/components/FileBrowser.tsx` is a single-directory browser:

```text
currentPath → fileOps.listDir(currentPath) → FileEntry[] → sort → entries.map → FileEntryRow
```

Opening a directory replaces the list by changing `currentPath`. There is no persistent tree node graph, expanded-node state, lazy child cache, virtualized visible-node model, or extension/decorator mechanism.

The existing `file.list { path }` protocol naturally maps to lazy one-level directory loading.

## Design Goals

- Lazy directory loading
- Virtualized rendering for large repositories
- Controlled Explorer state (selection, expansion, activation)
- Stable node identity
- Rename, move/drag-and-drop where supported
- Keyboard navigation
- shadcn/Tailwind-based rendering
- Generic extension points (decorations, context menus, actions)
- Event-driven incremental updates (model ready; full watcher protocol out of scope)
- **No Git/diagnostics/Agent fields on `ExplorerNode`**

> Adding Git status later must not require modifying `Explorer`, `ExplorerNode`, or the filesystem protocol.

## Architecture

```text
                           Explorer
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
  ExplorerStore          Tree Engine          Extension Host
        │              react-arborist               │
        │                     │                     │
        │              ExplorerNodeRenderer         │
        │             shadcn / Tailwind             │
        │                                           │
        │                              ┌────────────┼────────────┐
        │                              │            │            │
FilesystemProvider                    Git*     Diagnostics*    Agent*
        │
 Nession file.* RPC

* future — registered via extension API, not in this issue
```

### Boundary

`react-arborist` is an implementation detail. Nession exposes its own Explorer abstractions so replacing the tree engine later does not require rewriting integrations.

## Core Types

### ExplorerNode

```ts
interface ExplorerNode {
  id: string
  uri: string
  name: string
  kind: 'file' | 'directory'
  parentId?: string
  capabilities: {
    rename?: boolean
    delete?: boolean
    move?: boolean
    createChild?: boolean
  }
  metadata?: {
    size?: number
    modifiedAt?: number
    isBinary?: boolean
    fullPath?: string  // absolute path for "copy full path"
  }
}
```

No `gitStatus`, `diagnosticCount`, or `agentModified` — those belong to extensions.

### ExplorerDataProvider

```ts
interface ExplorerDataProvider {
  loadChildren(node: ExplorerNode | null): Promise<ExplorerNode[]>
  create?(parent: ExplorerNode | null, kind: 'file' | 'directory', name: string): Promise<void>
  rename?(node: ExplorerNode, name: string): Promise<void>
  delete?(node: ExplorerNode): Promise<void>
  move?(node: ExplorerNode, target: ExplorerNode): Promise<void>
}
```

`NessionFileSystemProvider` implements this via `file.list`, `file.write`, `file.create_dir`, `file.rename`, `file.delete`.

### ExplorerStore

Normalized hierarchical state:

```ts
nodesById: Map<NodeId, ExplorerNode>
childrenById: Map<NodeId, NodeId[]>
expandedIds: Set<NodeId>
selectedIds: Set<NodeId>
activeId: NodeId | null
loadStateById: Map<NodeId, 'idle' | 'loading' | 'loaded' | 'error'>
```

Responsibilities: lazy child loading, refresh/invalidation, incremental event application hooks, revision tracking placeholder.

### Extension Registry

```ts
interface ExplorerExtension {
  id: string
  decorations?: ExplorerDecorationProvider[]
  contextMenus?: ExplorerContextMenuProvider[]
  actions?: ExplorerActionProvider[]
  commands?: ExplorerCommand[]
  nodeRenderer?: ExplorerNodeRendererContribution
}
```

#### DecorationProvider (primary metadata extension)

```ts
interface ExplorerDecoration {
  badge?: string
  tooltip?: string
  className?: string
  icon?: ReactNode
  priority?: number
}

interface ExplorerDecorationProvider {
  provide(node: ExplorerNode): ExplorerDecoration | undefined
}
```

Renderer resolves all providers → `ResolvedNodePresentation` → `ExplorerNodeRenderer`.

#### Context Menu Contributions

Core actions (copy path, copy full path, rename, delete) move from hardcoded `FileEntryRow` into Explorer contributions. Extensions merge by `when` predicate + node capabilities.

```ts
interface ExplorerContextMenuContribution {
  id: string
  when?: (node: ExplorerNode) => boolean
  render: (node: ExplorerNode, ctx: ExplorerContextMenuContext) => ReactNode
}
```

## Module Layout

```text
web/src/explorer/
├── Explorer.tsx                 # Public component; wraps react-arborist internally
├── ExplorerStore.ts             # State + lazy loading
├── types.ts                     # ExplorerNode, public types
├── registry.ts                  # Extension registration
├── providers/
│   ├── types.ts                 # ExplorerDataProvider
│   └── NessionFileSystemProvider.ts
├── decorations/
│   ├── types.ts
│   └── resolveDecorations.ts
├── commands/
│   ├── types.ts
│   ├── registry.ts
│   └── coreContributions.ts     # copy path, rename, delete, etc.
├── hooks/
│   └── useExplorerStore.ts
└── renderers/
    └── ExplorerNodeRenderer.tsx

web/src/components/FileBrowser.tsx   # Thin wrapper → Explorer + NessionFileSystemProvider
```

## Tree Engine Integration

```text
ExplorerStore
     ↓ (adapter: flat nodes → arborist data)
Explorer (react-arborist Tree)
     ↓
ExplorerNodeRenderer (shadcn ContextMenu, Tooltip, Input, Badge, AlertDialog)
```

- Do **not** export react-arborist types from `web/src/explorer/index.ts`
- Virtualization via react-arborist's built-in support
- Expand → `ExplorerStore.loadChildren` → provider → cache → rerender

## Separation from Editor State

Explorer owns filesystem hierarchy, expansion, selection, loading. Document/editor lifecycle stays in existing `useFileTabs` / `useFileViewer` hooks. Opening a file dispatches via `onFileActivate(node)` callback; rename/move callbacks update tabs without destroying editor state.

## Lazy Loading Flow

```text
expand directory → ExplorerStore.loadChildren → provider.loadChildren → file.list → cache children → react-arborist rerenders visible nodes
```

Unexpanded descendants are not loaded.

## Filesystem Events (model only)

Store exposes `applyEvent({ type: 'create'|'modify'|'delete'|'rename', ... })` and `invalidate(nodeId)` for future watcher integration. Full backend watcher is out of scope.

## FileBrowser Migration

`FileBrowser` becomes a thin composition:

```tsx
<Explorer
  provider={nessionFileSystemProvider}
  extensions={[coreExplorerExtension, ...userExtensions]}
  onFileActivate={...}
  toolbarExtras={...}  // CWD sync, upload, new file/folder
/>
```

Preserve existing props surface (`fileOps`, `onFileClick`, `onFileDeleted`, `onFileRenamed`, `onGetTerminalPwd`, `initialPath`) for backward compatibility with `FileTabs` and `MobileTerminalLayout`.

### UI parity

- Toolbar: refresh, new file/folder, upload, parent (tree: collapse to parent or reveal in tree), terminal CWD sync
- Tree view replaces flat list + breadcrumb (tree expansion replaces directory navigation)
- Column sort moves to per-directory sort in store or default name sort (directories first)
- Size/modified columns in node renderer metadata columns
- Binary badge preserved via node metadata + decoration or inline renderer
- File size gate before open (50MB text / 10MB binary) stays in activation handler

## Mock Extension (validation)

A test-only `mockExplorerExtension` registers:
1. A decoration provider adding badge `"MOCK"` to nodes whose name starts with `test-`
2. A context menu item `"Mock action"` visible on all files

Proves extension API without modifying Explorer core.

## Non-Goals

- Git repository discovery, status backend, watcher, GitStore, Source Control panel
- Diff viewer, stage/unstage, commit, branch switching
- General application-wide plugin framework beyond Explorer extensions
- Complete backend filesystem watcher protocol

## Acceptance Criteria

- [ ] `FileBrowser` is a thin wrapper around reusable `Explorer`
- [ ] Nession owns public API; react-arborist types do not leak to consumers
- [ ] react-arborist used as internal virtualized tree engine
- [ ] Rows rendered with shadcn/Tailwind
- [ ] `ExplorerNode` has no Git/diagnostics/Agent fields
- [ ] `ExplorerDataProvider` abstracts Nession RPC
- [ ] `file.list` drives lazy expansion
- [ ] ExplorerStore caches loaded branches independently
- [ ] Unexpanded descendants not loaded
- [ ] Large trees virtualized
- [ ] Existing file actions work (create, rename, delete, upload, copy path)
- [ ] Core context menus not hardcoded in row component
- [ ] DecorationProvider registry exists
- [ ] Mock extension adds badge without modifying Explorer source
- [ ] Mock extension adds context menu without modifying Explorer source
- [ ] Explorer state separate from document/editor state
- [ ] FileBrowser integration tests migrated without regression

## Dependencies

- Add `react-arborist` to `web/package.json`
- Vitest tests for store, provider, registry, Explorer component
- Migrate `FileBrowser.test.tsx` to cover tree behavior + extension mock

## Follow-up

Git as separate Explorer extension:

```text
GitService → GitStore → gitExplorerExtension (DecorationProvider, ContextMenuProvider, Commands)
```

Must not require Explorer core changes.
