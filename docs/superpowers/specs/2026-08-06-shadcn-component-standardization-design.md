# shadcn/ui Component Standardization — Design Spec

**Issue:** [#177](https://github.com/BestNathan/nession/issues/177)
**Date:** 2026-08-06
**Status:** Draft

## 1. Overview

Replace 3 categories of hand-rolled UI patterns with shadcn/ui primitives:

| Pattern | Sites | Replacement | shadcn Primitive |
|---------|-------|-------------|-----------------|
| Tab strip | BottomBar, BottomSheet, AgentDetailPanel | `<TabsList>` + `<TabsTrigger>` | `Tabs` |
| Drag-resize | SidePanel (~30 raw DOM lines) | `<ResizablePanelGroup>` + `<ResizableHandle>` | `Resizable` |
| Destructive confirm | KillConfirmDialog | `<AlertDialog>` (matching FileBrowser pattern) | `AlertDialog` (already installed) |
| Icon-only buttons | ~20 buttons across app | `<Tooltip>` + `<TooltipTrigger>` + `<TooltipContent>` | `Tooltip` |

**What stays custom:**
- FileTabs TabBar — dirty indicators, close buttons, max-tab eviction are domain-specific extensions
- SearchBar filter group — `Button` group works fine; `ToggleGroup` optional bonus
- All terminal-related components (Terminal, InputPanel, QuickCommandsPanel)

## 2. Execution Strategy

**Phase order:** Install all primitives → Refactor component-by-component → Update docs.

**Refactor order:** BottomBar → BottomSheet → AgentDetailPanel → SidePanel → KillConfirmDialog → Tooltips.

Rationale: BottomBar is the simplest tab strip (no extra features), so it validates the Tabs migration pattern. BottomSheet follows the same pattern. AgentDetailPanel is last because its TabBar lives inside a `Sheet`. Tooltips last since they're additive (no behavior change).

## 3. Component Designs

### 3.1. shadcn Tabs Migration

**Current state (all 3 sites share this pattern):**
```tsx
// Hand-rolled tab strip — duplicated in BottomBar, BottomSheet, AgentDetailPanel
<button onClick={() => selectTab(id)}
  className={cn('border-b-2', active ? 'border-primary' : 'border-transparent')}>
  <Icon /> {label}
</button>
```

**Target state:**
```tsx
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

<Tabs value={activeTab} onValueChange={onTabChange}>
  <TabsList className="h-10 border-b rounded-none bg-transparent">
    <TabsTrigger value="input" className="gap-1 text-xs data-[state=active]:border-b-2 data-[state=active]:border-primary">
      <Keyboard className="w-3 h-3" /> Input
    </TabsTrigger>
    {/* ... */}
  </TabsList>
</Tabs>
```

**BottomBar specifics:**
- Remove hand-rolled `<button>` loop (lines 58-76)
- Replace with `<TabsList>` + `<TabsTrigger>`
- Mobile sheet toggle button stays outside Tabs
- Content panel switching stays the same (conditional rendering based on `activeTab`)

**BottomSheet specifics:**
- Same Tabs migration as BottomBar
- ZoomControls stay outside Tabs (they're not tabs)
- Collapse toggle stays outside Tabs

**AgentDetailPanel specifics:**
- Internal `TabBar` function (lines 339-363) replaced with `<TabsList>`
- Two tabs: Overview / Claude Code
- Content switching stays the same

**⚠ FileTabs TabBar — KEPT AS-IS.** Its close buttons, dirty dots, and max-tab eviction logic are beyond what shadcn Tabs provides. No change.

### 3.2. shadcn Resizable Migration (SidePanel)

**Current state** (SidePanel.tsx lines 31-52):
```tsx
// Raw DOM listeners for drag-resize
const startResize = (e: React.MouseEvent) => {
  const onMouseMove = (e: MouseEvent) => {
    const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
    setWidth(newWidth);
  };
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
};
```

**Target state:**
```tsx
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';

// Desktop (lg+): resizable inline panel
<ResizablePanelGroup direction="horizontal">
  <ResizablePanel defaultSize={20} minSize={15} maxSize={35}>
    <FileBrowser ... />
  </ResizablePanel>
  <ResizableHandle className="hidden lg:block" />
  <ResizablePanel defaultSize={80}>
    {/* main content */}
  </ResizablePanel>
</ResizablePanelGroup>
```

**What changes:**
- Remove `startResize`, `isResizing`, `onMouseMove`, `onMouseUp` (~30 lines)
- Remove custom resize handle `<div>` (lines 84-90)
- Replace `width` state with `ResizablePanel`'s built-in size management
- Mobile overlay (fixed + backdrop) stays as-is; `Resizable` only active at `lg+`
- Collapse toggle button stays; it sets panel size to 0/min

**What stays:**
- Mobile backdrop + overlay behavior
- Collapse/expand toggle button
- Children rendering (FileBrowser or any future panel)

### 3.3. AlertDialog Standardization (KillConfirmDialog)

**Current:** Uses `<Dialog>` for destructive confirmation.
**Target:** Uses `<AlertDialog>` — matches FileBrowser's delete confirmation pattern.

```tsx
// Change imports:
- import { Dialog, DialogContent, ... } from './ui/dialog';
+ import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';

// Change rendering:
- <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
-   <DialogContent>
-     <DialogHeader><DialogTitle>Kill Session</DialogTitle>...</DialogHeader>
-     <DialogFooter>
-       <Button variant="outline" onClick={onClose}>Cancel</Button>
-       <Button variant="destructive" onClick={handleConfirm}>Kill Session</Button>
-     </DialogFooter>
-   </DialogContent>
- </Dialog>
+ <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
+   <AlertDialogContent>
+     <AlertDialogHeader>
+       <AlertDialogTitle>Kill Session</AlertDialogTitle>
+       <AlertDialogDescription>...</AlertDialogDescription>
+     </AlertDialogHeader>
+     <AlertDialogFooter>
+       <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
+       <AlertDialogAction onClick={handleConfirm} disabled={loading}
+         className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
+         {loading ? 'Killing...' : 'Kill Session'}
+       </AlertDialogAction>
+     </AlertDialogFooter>
+   </AlertDialogContent>
+ </AlertDialog>
```

**What changes:**
- Import from `alert-dialog` instead of `dialog`
- `<AlertDialogAction>` replaces `<Button variant="destructive">`
- `<AlertDialogCancel>` replaces `<Button variant="outline">` — auto-closes dialog

### 3.4. Tooltip Addition

Add `<Tooltip>` to every icon-only button across the codebase. Pattern:

```tsx
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

<Tooltip>
  <TooltipTrigger asChild>
    <Button variant="ghost" size="icon" onClick={...}>
      <SomeIcon className="h-4 w-4" />
    </Button>
  </TooltipTrigger>
  <TooltipContent side="bottom">
    <p>Clear input</p>
  </TooltipContent>
</Tooltip>
```

**Sites (~20 buttons):**
- DashboardHeader: Env Files, Refresh
- QuickCommandsPanel: physical keys (arrows, Home, End, etc.), Delete on each command
- InputPanel: Clear, Copy, Paste, Send
- BottomSheet: ZoomControls (Zoom in/out/reset), collapse toggle
- SessionDropdown: Kill button on each session row
- FileBrowser toolbar: Refresh, New File, New Folder, Upload, CWD refresh
- SessionList: Attach, Kill per session

**Rule:** If a button has no visible text label (icon-only), it gets a `<Tooltip>`.

## 4. State Management

No new state management needed. All changes are purely presentational:

- **Tabs:** `value` + `onValueChange` replaces `activeTab` + `onTabChange` (props unchanged, just wired to Tabs instead of buttons)
- **Resizable:** Panel sizes managed by `ResizablePanelGroup` internally (replaces `useState(width)` + manual resize)
- **AlertDialog:** No state changes (already uses `open` + `onOpenChange` pattern)
- **Tooltip:** No state (pure presentational wrapper)

## 5. Error Handling & Edge Cases

| Component | Edge Case | Handling |
|-----------|-----------|----------|
| BottomBar | Mobile sheet toggle | Stays outside `<Tabs>`, no change |
| BottomBar | `files` tab hidden on desktop | Same `showFilesTab` conditional; TabsTrigger hidden when `!show` |
| BottomSheet | Font size zoom controls | Stay outside `<Tabs>`, no change |
| AgentDetailPanel | Dynamic tab content (Claude Code extension) | `TabsTrigger` rendered conditionally, same as current |
| SidePanel | Mobile overlay (fixed + backdrop) | `Resizable` only active at `lg+`; mobile behavior unchanged |
| SidePanel | Collapse toggle | Sets panel to `minSize`/0 via `ResizablePanel` API |
| KillConfirmDialog | Async loading state | `AlertDialogAction` disabled while `loading` |
| KillConfirmDialog | Error display | Error text stays between header and footer, unchanged |
| Tooltip | Already-visible text buttons | Skip — only icon-only buttons get Tooltips |

## 6. Testing Strategy

### Before migration (baseline):
```bash
cd web && npm test && npm run lint && npx tsc --noEmit
```

### Per-component verification:
1. Install primitive(s) → `npm run build` (verify no import errors)
2. Refactor component → `npx tsc --noEmit && npm run lint`
3. Functional check → Playwright browser verification
4. Run full test suite → `npm test`

### Playwright checklist (per component):
- [ ] Component renders correctly in all breakpoints (375px / 768px / 1280px)
- [ ] Tab switching works (click, keyboard nav)
- [ ] Resize handle works (drag, min/max constraints)
- [ ] AlertDialog opens/closes, cancel works, confirm works
- [ ] Tooltips appear on hover, dismiss on unhover
- [ ] No console errors (`browser_console_messages`)
- [ ] No visual regression vs baseline screenshots

## 7. Files Changed

| File | Change | Risk |
|------|--------|------|
| `BottomBar.tsx` | Replace tab buttons with `<Tabs>` | Low |
| `BottomSheet.tsx` | Replace tab buttons with `<Tabs>` | Low |
| `AgentDetailPanel.tsx` | Replace TabBar with `<Tabs>` | Low |
| `SidePanel.tsx` | Replace raw resize with `<Resizable>` | Medium |
| `KillConfirmDialog.tsx` | `<Dialog>` → `<AlertDialog>` | Low |
| `DashboardHeader.tsx` | Add Tooltips | Low |
| `QuickCommandsPanel.tsx` | Add Tooltips | Low |
| `InputPanel.tsx` | Add Tooltips | Low |
| `SessionDropdown.tsx` | Add Tooltips | Low |
| `FileBrowser.tsx` | Add Tooltips | Low |
| `SessionList.tsx` | Add Tooltips | Low |
| `references/shadcn-components.md` | Update installed count + priority queue | None |
