# Files feature — ownership

The files feature owns the nession file **protocol capability** (FilesPlugin,
FileOps/FileApi RPC surfaces) and the file **browsing and viewing UI**
(FileBrowser/FileViewer and their viewers). It does not own the extensible
tree framework itself — that lives in `features/explorer`.

## Module map

| Module | Responsibility |
|---|---|
| `FilesPlugin.ts`, `types.ts`, `index.ts` | File RPC capability (`file.list/read/write/…`) installed per SessionRuntime on the agent socket |
| `adapters/NessionFileSystemProvider.ts` | Maps `FileOps` → `ExplorerDataProvider` (the files-side implementation of the explorer port); `ExplorerNode` ids are relative paths |
| `components/FileBrowser.tsx` | Browser chrome (toolbar, new-entry row, upload, delete confirm) composing `Explorer` from features/explorer |
| `components/FileViewer.tsx` + viewer components | Viewer dispatch: image/video/audio/pdf/markdown/code-mirror; content load + dirty tracking live in `hooks/useFileViewer` |
| `hooks/useExplorerFileBrowser.ts` | Provider wiring, navigation state, mutations for FileBrowser |
| `hooks/useFileViewer.ts` | Per-viewer content/read-state (`useFileLoader`: read/chunked/blob/markdown detection) |
| `model/viewerRegistry.ts`, `model/codeMirrorLangs.ts` | Extension → viewer-type dispatch; code-mirror language preloading from paths |

## State ownership

Rules follow #649: transient render state stays in the component; state shared
across a capability lives in feature/model; transport/connection lifecycle
belongs to core runtime; layout/selection state belongs to app/workbench.

| State | Owner today | Lifetime / scope |
|---|---|---|
| Tree structure, expand/collapse, lazy load, selection, active | `features/explorer` — `ExplorerStore` class | One instance per `Explorer` mount (`useExplorerStore`), bound to the provider (→ fileOps → transport) baked in at construction |
| File operations (list/read/write/rename/delete) | `FileOps` RPC surface (`FilesPlugin`) | Per SessionRuntime agent socket; surfaced to UI as `ctx.fileOps` when a P2P transport is attached |
| Explorer extensions (decorations, context menus) | `features/explorer` — `ExplorerRegistry` | One registry per `Explorer` mount; register/unregister notify subscribers → incremental row refresh |
| Open-files/tab state | Per-surface hooks: `useFileTabs` (legacy desktop `FileTabs`), `useFilesPanelNav` (legacy mobile layout), single-selection state in `session-first` `filesWeb`/`filesApp` tools | Per mount; content is re-read from the backend on every viewer mount — deliberately no cross-surface cache today |
| File content / edit state (dirty, saving) | `useFileViewer` per viewer mount | Discarded on tab switch (viewers unmount) |
| Editor UI state (cursor/selection) | Inside `CodeMirrorEditor`'s EditorView | Not lifted; only text diffs are used for dirty tracking |

**Scoping:** nothing file-side is keyed by `sessionIdAtom`/workspace id yet —
state follows the **`fileOps`/provider object identity**, which changes when
the transport changes. Session-first tools reset their selection on fileOps
change; a new `ExplorerStore` is created for a new provider.

## DocumentStore / EditorStore — boundary, not yet entities

The Phase-4 target model names `DocumentStore` (file content + edit state)
and `EditorStore` (editor UI state) alongside `ExplorerStore`. Those are
**not implemented as stores yet**: content is never cached, viewers unmount on
switch, and the four surfaces deliberately differ (10-tab + terminal pseudo
tab on legacy desktop; single selection in session-first). The intended
boundaries:

- **ExplorerStore** — implemented (`features/explorer/ExplorerStore.ts`).
- **DocumentStore** (future) — open-file set, per-document content/edit
  state, delete/rename sync across surfaces, keyed by session/workspace.
  Extraction triggers: a real multi-workspace/workbench model with
  workspace-scoped state (#649 roadmap), a second consumer of open-document
  state, or Git/Diagnostics landing and needing a shared “current documents”
  notion. Until then per-surface hooks stay the owners — do not hoist file
  state into global atoms.
- **EditorStore** (future) — lifts cursor/selection/view from CodeMirror;
  only worth it when an editor feature (find/replace, multi-document state)
  needs it. Today CodeMirror owns it.

When DocumentStore/EditorStore are introduced they must follow the state
rules above: instance-per-workspace, keyed by workspace/session, owned by
`features/files/model`, and exposed to layouts through the feature public
surface — never through module globals.

## Consumers

The app shell (`app/workspace/tools/files*.tsx`) composes the feature
through `@/features/files/...` subpaths. The legacy desktop terminal layouts
(`components/FileTabs.tsx`, `components/MobileTerminalLayout.tsx`) that also
composed it — and the now-dead `useFileTabs` tab-strip state — were deleted
with the Dashboard shell in #655.
