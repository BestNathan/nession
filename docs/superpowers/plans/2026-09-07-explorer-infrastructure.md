# Explorer Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-directory `FileBrowser` with an extensible `Explorer` framework backed internally by `react-arborist`, preserving all existing file operations and enabling future Git/diagnostics extensions via registration.

**Architecture:** Normalized `ExplorerStore` + `ExplorerDataProvider` abstraction + extension registry (decorations, context menus) + internal react-arborist tree + shadcn `ExplorerNodeRenderer`. `FileBrowser` becomes a thin wrapper composing `NessionFileSystemProvider` and core contributions.

**Tech Stack:** React 18, TypeScript, react-arborist, Vitest, shadcn/ui, existing `fileOps` RPC

**Spec:** `docs/superpowers/specs/2026-09-07-explorer-infrastructure-design.md`

**Worktree:** `.claude/worktrees/feat-explorer-infrastructure` (base `staging`)

---

## File Map

| File | Responsibility |
|------|----------------|
| `web/src/explorer/types.ts` | Public Explorer types (`ExplorerNode`, load state, props) |
| `web/src/explorer/providers/types.ts` | `ExplorerDataProvider` interface |
| `web/src/explorer/providers/NessionFileSystemProvider.ts` | Maps `FileOps` → `ExplorerNode[]` |
| `web/src/explorer/ExplorerStore.ts` | Normalized tree state, lazy load, invalidation |
| `web/src/explorer/hooks/useExplorerStore.ts` | React hook binding store to component lifecycle |
| `web/src/explorer/decorations/types.ts` | Decoration types |
| `web/src/explorer/decorations/resolveDecorations.ts` | Merge providers by priority |
| `web/src/explorer/registry.ts` | Extension registration + lookup |
| `web/src/explorer/commands/types.ts` | Context menu / action types |
| `web/src/explorer/commands/coreContributions.ts` | Copy path, rename trigger, delete trigger |
| `web/src/explorer/renderers/ExplorerNodeRenderer.tsx` | shadcn row + decorations + context menu |
| `web/src/explorer/Explorer.tsx` | Public component; react-arborist internally |
| `web/src/explorer/index.ts` | Public exports (no react-arborist types) |
| `web/src/explorer/__tests__/unit/*.test.ts` | Store, provider, registry, decorations |
| `web/src/explorer/__tests__/integration/Explorer.test.tsx` | Component + mock extension |
| `web/src/components/FileBrowser.tsx` | Thin wrapper |
| `web/src/explorer/testing/mockExtension.ts` | Test mock extension |

---

### Task 1: Dependencies and core types

**Files:**
- Modify: `web/package.json`
- Create: `web/src/explorer/types.ts`
- Create: `web/src/explorer/providers/types.ts`
- Create: `web/src/explorer/index.ts` (minimal re-exports)
- Test: `web/src/explorer/__tests__/unit/types.test.ts`

- [ ] **Step 1: Add react-arborist**

```bash
cd web && npm install react-arborist
```

- [ ] **Step 2: Write types test**

Create `web/src/explorer/__tests__/unit/types.test.ts` asserting `ExplorerNode` shape helpers compile and `fileEntryToExplorerNode` maps correctly.

- [ ] **Step 3: Implement types**

`web/src/explorer/types.ts`:
- `ExplorerNode`, `NodeId`, `LoadState`, `ExplorerProps` (partial, expanded in later tasks)
- Helper `fileEntryToExplorerNode(entry: FileEntry, parentId?: string): ExplorerNode` mapping `path` → `id`/`uri`, `is_dir` → `kind`, `full_path` → `metadata.fullPath`, etc.

`web/src/explorer/providers/types.ts`: `ExplorerDataProvider` interface per spec.

- [ ] **Step 4: Run test**

```bash
cd web && npm test -- src/explorer/__tests__/unit/types.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/src/explorer/
git commit -m "feat: add explorer core types and react-arborist dependency"
```

---

### Task 2: NessionFileSystemProvider

**Files:**
- Create: `web/src/explorer/providers/NessionFileSystemProvider.ts`
- Test: `web/src/explorer/__tests__/unit/NessionFileSystemProvider.test.ts`

- [ ] **Step 1: Write failing provider test**

Test `createNessionFileSystemProvider(fileOps)`:
- `loadChildren(null)` calls `listDir('')` and maps entries
- `loadChildren(dirNode)` calls `listDir(dirNode.uri)`
- `rename`, `delete`, `create` delegate to fileOps when present
- Directories sorted before files, name ascending (match current FileBrowser sort default)

- [ ] **Step 2: Implement provider**

- [ ] **Step 3: Run test, commit**

```bash
git commit -m "feat: add NessionFileSystemProvider for explorer"
```

---

### Task 3: ExplorerStore

**Files:**
- Create: `web/src/explorer/ExplorerStore.ts`
- Create: `web/src/explorer/hooks/useExplorerStore.ts`
- Test: `web/src/explorer/__tests__/unit/ExplorerStore.test.ts`

- [ ] **Step 1: Write failing store tests**

Cover:
- `ensureRootLoaded()` loads root via provider
- `expand(nodeId)` sets expanded + triggers lazy load if not loaded
- `collapse(nodeId)` removes from expanded
- `getChildren(nodeId)` returns cached ids
- `refresh(nodeId)` reloads branch
- `applyEvent({ type: 'delete', nodeId })` removes node and prunes from parent
- `setSelection` / `setActive`
- `getFlatData()` returns array suitable for react-arborist adapter `{ id, name, children }`

- [ ] **Step 2: Implement ExplorerStore class**

Use normalized maps. Emit `subscribe` listeners for React hook. Root node id = `''` or `'__root__'`.

- [ ] **Step 3: Implement useExplorerStore hook**

- [ ] **Step 4: Run tests, commit**

```bash
git commit -m "feat: add ExplorerStore with lazy loading and normalized state"
```

---

### Task 4: Extension registry and decorations

**Files:**
- Create: `web/src/explorer/decorations/types.ts`
- Create: `web/src/explorer/decorations/resolveDecorations.ts`
- Create: `web/src/explorer/registry.ts`
- Create: `web/src/explorer/commands/types.ts`
- Test: `web/src/explorer/__tests__/unit/registry.test.ts`
- Test: `web/src/explorer/__tests__/unit/resolveDecorations.test.ts`

- [ ] **Step 1: Write failing tests**

- Multiple decoration providers merge (higher priority wins for badge/className; icons concatenate)
- Registry `registerExtension` / `getExtensions`
- Context menu contributions filtered by `when`

- [ ] **Step 2: Implement registry + resolveDecorations**

- [ ] **Step 3: Run tests, commit**

```bash
git commit -m "feat: add explorer extension registry and decoration resolution"
```

---

### Task 5: Core context menu contributions

**Files:**
- Create: `web/src/explorer/commands/coreContributions.ts`
- Test: `web/src/explorer/__tests__/unit/coreContributions.test.ts`

- [ ] **Step 1: Write test** for contribution ids and `when` predicates

- [ ] **Step 2: Implement** copy path, copy full path, rename (dispatches store event/callback), delete (dispatches callback). Use existing clipboard + toast patterns from FileBrowser.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: extract core explorer context menu contributions"
```

---

### Task 6: ExplorerNodeRenderer

**Files:**
- Create: `web/src/explorer/renderers/ExplorerNodeRenderer.tsx`
- Test: `web/src/explorer/__tests__/integration/ExplorerNodeRenderer.test.tsx`

- [ ] **Step 1: Write renderer test**

Renders file/dir icons, name, size column, modified column, decoration badge, context menu items from registry.

- [ ] **Step 2: Implement renderer**

Match existing FileBrowser row styling (text-xs, hover:bg-accent, Folder blue-400, BIN badge). Use shadcn ContextMenu, merge core + extension menu items.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add ExplorerNodeRenderer with shadcn UI"
```

---

### Task 7: Explorer component (react-arborist integration)

**Files:**
- Create: `web/src/explorer/Explorer.tsx`
- Modify: `web/src/explorer/index.ts`
- Test: `web/src/explorer/__tests__/integration/Explorer.test.tsx`

- [ ] **Step 1: Write integration test**

- Renders tree with mock provider (nested dirs)
- Expanding directory loads children (provider called once)
- Click file invokes `onFileActivate`
- Mock extension badge visible on matching node
- Mock extension context menu item clickable

- [ ] **Step 2: Implement Explorer**

- Accept `provider`, `extensions`, `onFileActivate`, `initialPath?`, rename/delete callbacks
- Internal: create store, register extensions, adapt store flat data to react-arborist
- Toolbar slot prop or built-in minimal toolbar (refresh, expand all root)
- Inline rename via react-arborist rename API or local state mirroring current FileBrowser rename row
- Do NOT export react-arborist types from index.ts

- [ ] **Step 3: Create mock extension** at `web/src/explorer/testing/mockExtension.ts`

- [ ] **Step 4: Run tests, commit**

```bash
git commit -m "feat: add Explorer component with react-arborist tree engine"
```

---

### Task 8: Refactor FileBrowser to thin wrapper

**Files:**
- Rewrite: `web/src/components/FileBrowser.tsx`
- Create: `web/src/hooks/useExplorerFileBrowser.ts` (toolbar state: new file/folder, upload, CWD, delete dialog)
- Modify: `web/src/components/__tests__/integration/FileBrowser.test.tsx`

- [ ] **Step 1: Extract toolbar/dialog logic to hook**

Preserve: new file/folder creation UI, upload input, delete AlertDialog, terminal CWD button, file size gate on activate.

- [ ] **Step 2: Rewrite FileBrowser**

Compose `<Explorer provider={...} extensions={[coreExtension]} ... />` + toolbar. Keep exact same `FileBrowserProps` export.

- [ ] **Step 3: Migrate FileBrowser tests**

Update tests for tree UI:
- Copy path tests: context menu on tree row still works
- Parent directory: may become "reveal parent in tree" or navigate via collapsing — preserve behavior or update test to expand/collapse tree equivalent
- Add test that expanding folder loads nested entries

- [ ] **Step 4: Run full web checks**

```bash
cd web && npm run lint && npm test && npm run build
```

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: FileBrowser wraps extensible Explorer infrastructure"
```

---

### Task 9: Documentation and final verification

**Files:**
- Create: `web/src/explorer/README.md` (brief extension API doc)

- [ ] **Step 1: Add README** with registerExtension example for future Git

- [ ] **Step 2: Run coverage**

```bash
cd web && npm run coverage
```

Ensure new explorer modules meet thresholds; add tests if needed.

- [ ] **Step 3: Commit docs**

```bash
git commit -m "docs: document explorer extension API"
```

---

## PR and Deploy

1. Push branch: `git push -u origin feat/explorer-infrastructure`
2. Create PR to `staging` with 变更内容 + 测试报告
3. `gh pr merge --auto --merge`
4. `./scripts/deploy-watch.sh staging`

## Notes for implementers

- Work only in worktree `.claude/worktrees/feat-explorer-infrastructure`
- Never export react-arborist types from public explorer API
- Hooks go in `web/src/explorer/hooks/` or `web/src/hooks/` — not in `components/`
- No `eslint-disable`; fix lint properly
- Event handlers: `onClick={() => fn()}`
- `FileEntry` stays in `fileOps.ts`; map at provider boundary only
