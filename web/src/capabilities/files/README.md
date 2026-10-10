# Files feature — ownership

The files feature owns the nession file **protocol capability** (FilesPlugin,
FileOps/FileApi RPC surfaces) and the file **browsing and viewing UI**
(FileBrowser/FileViewer and their viewers). It does not own the extensible
tree framework itself — that lives in `platform/explorer`.

## Module map

| Module | Responsibility |
|---|---|
| `FilesPlugin.ts`, `types.ts`, `index.ts` | File RPC capability (`file.list/read/write/…`) installed per SessionRuntime on the agent socket |
| `adapters/NessionFileSystemProvider.ts` | Maps `FileOps` → `ExplorerDataProvider` (the files-side implementation of the explorer port); `ExplorerNode` ids are relative paths |
| `components/FileBrowser.tsx` | Browser chrome (toolbar, new-entry row, upload, delete confirm) composing `Explorer` from platform/explorer |
| `components/FileViewer.tsx` + viewer components | Viewer dispatch: image/video/audio/pdf/markdown/structured JSON/JSONL/editor; content load + dirty tracking live in `hooks/useFileViewer` |
| `hooks/useExplorerFileBrowser.ts` | Provider wiring, navigation state, mutations for FileBrowser |
| `hooks/useFileViewer.ts` | Per-viewer content/read-state (`useFileLoader`: read/chunked/blob/markdown detection) |
| `model/viewerRegistry.ts`, `components/JsonPreview.tsx`, `components/JsonlPreview.tsx` | Viewer dispatch and JSON/JSONL presentation; editor language support lives in `platform/editor/model/codeMirrorLangs.ts` and `shared/lib/languageId.ts` |

## State ownership

Rules follow #649: transient render state stays in the component; state shared
across a capability lives in feature/model; transport/connection lifecycle
belongs to core runtime; layout/selection state belongs to app/workbench.

| State | Owner today | Lifetime / scope |
|---|---|---|
| Tree structure, expand/collapse, lazy load, selection, active | `platform/explorer` — `ExplorerStore` class | One instance per `Explorer` mount (`useExplorerStore`), bound to the provider (→ fileOps → transport) baked in at construction |
| File operations (list/read/write/rename/delete) | `FileOps` RPC surface (`FilesPlugin`) | Per SessionRuntime agent socket; surfaced to UI as `ctx.fileOps` when a P2P transport is attached |
| Explorer extensions (decorations, context menus) | `platform/explorer` — `ExplorerRegistry` | One registry per `Explorer` mount; register/unregister notify subscribers → incremental row refresh |
| Selected file + navigation | Web: `app/experiences/web/FilesWebLayout.tsx`; App: `app/experiences/app/FilesAppLayout.tsx` and `useAppFilesNavigator.ts` | Web tree/detail selection versus App directory/search/pushed viewer state; layout scoped, no shared DocumentStore |
| File content / edit state (dirty, saving) | `useFileViewer` per viewer mount | Discarded on tab switch (viewers unmount) |
| Editor UI state (cursor/selection) | Inside `CodeMirrorEditor`'s EditorView | Not lifted; only text diffs are used for dirty tracking |

**Scoping:** nothing file-side is keyed by `sessionIdAtom`/workspace id yet —
state follows the **`fileOps`/provider object identity**, which changes when
the transport changes. The Web layout resets its selected viewer on fileOps
change; the App navigator composes its own directory and pushed-detail state.
A new `ExplorerStore` is created for a new provider.

## DocumentStore / EditorStore — boundary, not yet entities

The Phase-4 target model names `DocumentStore` (file content + edit state)
and `EditorStore` (editor UI state) alongside `ExplorerStore`. Those are
**not implemented as stores yet**: content has no cross-layout cache, viewers unmount on
switch, and the two live layouts deliberately differ (Web tree + viewer;
App directory navigator + pushed viewer). The intended
boundaries:

- **ExplorerStore** — implemented (`platform/explorer/ExplorerStore.ts`).
- **DocumentStore** (future) — open-file set, per-document content/edit
  state, rename/delete sync across surfaces, keyed by session/workspace.
  Extract only when multiple views need a shared document identity or edit
  lifetime; until then per-surface hooks stay the owners — do not hoist file
  state into global atoms.
- **EditorStore** (future) — lifts cursor/selection/view from CodeMirror;
  only worth it when an editor feature (find/replace, multi-document state)
  needs it. Today CodeMirror owns it.

When DocumentStore/EditorStore are introduced they must follow the state
rules above: instance-per-workspace, keyed by workspace/session, owned by
`capabilities/files/model`, and exposed to layouts through the feature public
surface — never through module globals.

## Consumers

The live Web/App layout components under `app/experiences/{web,app}/`
compose this capability through `@/capabilities/files` and its public
components. The legacy Dashboard file tabs were removed in #655.
