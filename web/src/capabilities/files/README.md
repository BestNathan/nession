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
| File identity (`{sourceId, path}`) | `capabilities/files/model/fileRef.ts` | One `FileSource` per active transport/Session; changing source invalidates refs rather than retargeting them |
| Create/upload destination | `capabilities/files/model/createTarget.ts` + `useNewEntryForm` | Captured when the form opens; immutable for that operation |
| Tree structure, expand/collapse, selection, active | `platform/explorer` — `ExplorerStore` class | One instance per `Explorer` mount (`useExplorerStore`), bound to the provider (→ fileOps → transport) baked in at construction |
| File operations (list/read/write/rename/delete) | `FileOps` RPC surface (`FilesPlugin`) | Per SessionRuntime agent socket; surfaced to UI as `ctx.fileOps` when a P2P transport is attached |
| Explorer extensions (decorations, context menus) | `platform/explorer` — `ExplorerRegistry` | One registry per `Explorer` mount; register/unregister notify subscribers → incremental row refresh |
| Selected file + navigation | Web: `app/experiences/web/FilesWebLayout.tsx` + `useFilesWebSwitchGuard.ts`; App: `app/experiences/app/FilesAppLayout.tsx` and `useAppFilesNavigator.ts` | Web tree/detail selection and the dirty-switch decision versus App directory/search/pushed viewer state; layout scoped, no shared DocumentStore |
| File content / edit state (dirty, saving, revision, conflict) | `useFileViewer` per viewer mount | Owned by the mounted viewer; the Web layout receives dirty/saving reports and a guarded save handler so a tree switch cannot unmount a dirty viewer silently |
| Editor UI state (cursor/selection) | Inside `CodeMirrorEditor`'s EditorView | Not lifted; only text diffs are used for dirty tracking |

**Scoping:** a file reference carries its `sourceId` (Session-derived, Agent
fallback) and a path; the path is not meaningful outside that source. The
layouts reset selected/open state when the provider or source id changes, and
the agent's guarded mutations (create-only, no-replace rename, expected
revision) are the authority for conflict semantics. `ExplorerStore` is still
created per provider. Sandbox policy/enforcement remains #2681's; this
capability consumes an authorized provider and has no host fallback.

## Terminal file-reference resolution (#3187)

The Terminal product recognizes `path[:line[:column]]` in output; Files owns
resolving and reading it. A relative reference is joined to the Session's
current CWD from `file.cwd` at activation time (`.`/`..` normalized). `file.cwd`
already returns this source's path convention, so the joined path is used
directly. An absolute path stays absolute on the same bound `FileOps` source and
is never stripped under the workspace root.

Resolution lists the target's parent and matches exactly one entry by `path` or
`full_path`. There is no basename scan, fuzzy search or first-match selection;
missing, directory, unavailable-source and ambiguous targets surface a
recoverable message instead of opening a different file. The opened target
carries `line`/`column`; the viewer renders source/raw at that position and
re-activating the same file elsewhere repositions the mounted viewer rather
than remounting it or discarding edits.

## Web dirty-file switching (#3171)

Web owns selection, so it owns the transition that may replace the mounted
viewer. It does **not** own the file content: `FileViewer` reports `dirty` and
`saving`, and registers a guarded save handler. `useFilesWebSwitchGuard` keeps
the pending target and the one decision:

- a clean file switches directly;
- a dirty file opens one unsaved-changes dialog naming A and B;
- Cancel keeps A, its exact draft and the tree selection;
- Discard opens B and does not persist A's draft;
- Save and switch calls the viewer's guarded save and opens B only on success;
  a conflict hands the next step to the viewer's existing conflict dialog
  without opening B; any other failure keeps A and shows a retryable error;
- a switch requested while the toolbar's own save is in flight waits for that
  save, then opens B only if it committed, otherwise keeps A;
- repeated B/C requests while the decision is pending are ignored, so the
  dialog and the eventual target cannot disagree.

The App already has a pushed-detail Back guard (`useAppFilesPushedSurface` +
`AppFilesViewerLayer`) and keeps that behavior. This is a Web selection
transition, not a global navigation guard, DocumentStore or multi-tab editor.

## DocumentStore / EditorStore — boundary, not yet entities

The Phase-4 target model names `DocumentStore` (file content + edit state)
and `EditorStore` (editor UI state) alongside `ExplorerStore`. Those are
**not implemented as stores yet**: content has no cross-layout cache, a Web
dirty switch is an explicit guarded transition, and the two live layouts
deliberately differ (Web tree + viewer; App directory navigator + pushed
viewer). The intended
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
