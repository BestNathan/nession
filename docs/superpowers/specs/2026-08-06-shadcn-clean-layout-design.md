# shadcn Clean Layout — Design Spec

**Date:** 2026-08-06
**Status:** Approved

## 1. Principle

**Let shadcn components own their styles.** Remove all custom CSS that overrides or conflicts with default shadcn styling. Only add minimal Tailwind for layout structure (flex, gap, padding).

## 2. Component Changes

### 2.1. BottomBar

| Before | After |
|--------|-------|
| `variant="line"`, `rounded-none`, `border-b-2`, `data-active:border-primary` | Default variant (`bg-muted rounded-lg` pill) |
| Manual `{content}` with conditional rendering | `<TabsContent>` (auto show/hide) |
| `border-t` on outer div | No border — TabsList `bg-muted` provides natural separation |
| `flex-row` override on Tabs | Default `flex-col` (TabsList above, content below) |
| Extra wrapper div for "flex items-center border-b" row | Simple flex row wrapping TabsList + toggle button |

### 2.2. BottomSheet

Same pattern as BottomBar. Remove:
- `variant="line"` → default
- All TabsTrigger `border-b-2 data-active:border-*` overrides → default
- `border-t` → no border
- Manual content switching → `TabsContent`

Keep: ZoomControls, collapse toggle button, height constraints.

### 2.3. FileTabs

Remove redundant wrapper div. Before:
```tsx
<div className="flex-1 min-h-0">           ← remove this
  <div className="flex-1 min-h-0 flex flex-col">  ← already in parent TerminalView
```

After: `ResizablePanelGroup` / mobile div is the direct outermost element.

ResizableHandle: always rendered (not conditional on sidePanelOpen).

### 2.4. SidePanel

No changes needed. Current implementation is clean (just content wrapper + mobile overlay + toggle).

## 3. What stays unchanged

- Terminal, TerminalLayout, MobileTerminalLayout
- AgentDetailPanel (already cleaned)
- FileBrowser, FileViewer
- InputPanel, QuickCommandsPanel
- Dashboard, LoginPage
- KillConfirmDialog (already using AlertDialog)
- SessionDropdown, SessionList

## 4. Files changed

| File | Changes |
|------|---------|
| `BottomBar.tsx` | Default Tabs, TabsContent, remove border/overrides |
| `BottomSheet.tsx` | Default Tabs, TabsContent, remove border/overrides |
| `FileTabs.tsx` | Remove wrapper div, ResizableHandle always visible |

## 5. Verification

- `npx tsc --noEmit`: 0 errors
- `npm run lint`: 0 warnings
- `npm run build`: success
- `npm test`: all pass
- Playwright: desktop 1280px + mobile 375px, tabs render correctly, resize works
