# Mobile File Viewing — Design Spec

**Date:** 2026-08-07
**Status:** Draft
**PR:** TBD

## 1. Problem

On mobile (≤1023px), tapping a file in the file browser does nothing — `onFileClick` is `() => {}` in `MobileTerminalLayout`. Users can browse files but cannot view or edit them.

Desktop supports full view + edit via `FileTabs` (tab strip, FileViewer with CodeMirror, dirty tracking, max 10 tabs). Mobile should match.

## 2. Design

### 2.1 Approach: Extract hook, add MobileFileTabs

**Strategy: one shared hook (`useFileTabs`), two layout components (`FileTabs` for desktop, `MobileFileTabs` for mobile).**

| Concern | Where |
|---------|-------|
| Open-file state, tab switching, dirty tracking | `hooks/useFileTabs.ts` (shared) |
| Desktop layout (ResizablePanelGroup + SidePanel + tab bar) | `FileTabs.tsx` (unchanged structure) |
| Mobile layout (tab strip + content area) | `MobileFileTabs.tsx` (new) |
| Wiring FileBrowser → file opening on mobile | `MobileTerminalLayout.tsx` (ref-based callback) |

### 2.2 Step 1: Extract `hooks/useFileTabs.ts`

Move lines 41-188 from `FileTabs.tsx` into a new hook file. No logic changes.

**Exports:**
```ts
export interface OpenFile { id: string; path: string; filename: string; }
export const MAX_TABS = 10;

export function useFileTabs(onTerminalReveal?: () => void): {
  openFiles: OpenFile[];
  activeTabId: string;
  setActiveTabId: (id: string) => void;
  dirtyFiles: Set<string>;
  activeFile: OpenFile | undefined;
  showTerminal: boolean;
  handleFileClick: (entry: FileEntry) => void;
  handleCloseFile: (id: string) => void;
  handleDirtyChange: (id: string, dirty: boolean) => void;
  handleFileDeleted: (path: string) => void;
  handleFileRenamed: (oldPath: string, newPath: string) => void;
}
```

`FileTabs.tsx` imports from `hooks/useFileTabs` — internal `TabBar` component stays in `FileTabs.tsx`.

### 2.3 Step 2: New `components/MobileFileTabs.tsx`

Lightweight mobile variant — no ResizablePanelGroup, no SidePanel.

**Layout:**
```
┌─────────────────────────┐
│ [Terminal] config.ts ×  │  ← tab strip (only visible when openFiles.length > 0)
├─────────────────────────┤
│                         │
│  Terminal or FileViewer │  ← main content area
│  (mutually exclusive)   │
│                         │
└─────────────────────────┘
```

- No files open → tab strip hidden, terminal fills screen (identical to current mobile)
- File clicked → tab strip appears, FileViewer shown, terminal hidden (CSS `hidden`)
- Terminal tab clicked → back to terminal
- Tab × clicked → close file, switch to adjacent tab or terminal

**Props:**
```ts
interface MobileFileTabsProps {
  fileOps: FileOps;
  terminalElement: React.ReactNode;
  onTerminalReveal?: () => void;
  sessionId?: string;
  onGetTerminalPwd?: () => Promise<string>;
  onFileClickRef: React.MutableRefObject<((entry: FileEntry) => void) | null>;
}
```

`onFileClickRef` is populated by the hook's `handleFileClick` so the parent can wire the FileBrowser.

### 2.4 Step 3: Wire in `MobileTerminalLayout.tsx`

Current:
```tsx
<FileBrowser onFileClick={() => {}} ... />
```

Changed to:
```tsx
const fileClickRef = useRef<(entry: FileEntry) => void>(null);
// ...
<MobileFileTabs
  fileOps={fileOps}
  terminalElement={...}
  onFileClickRef={fileClickRef}
  ...
/>
// In BottomSheet:
<FileBrowser
  onFileClick={(entry) => fileClickRef.current?.(entry)}
  ...
/>
```

### 2.5 Mobile Tab Bar Component

A compact scrollable tab strip. Simpler than desktop's `TabBar` — no extension tabs, no dirty dot, close button is always visible.

```
[Terminal] [config.ts  ×] [package.json  ×]
             ───active───
```

- Active tab: white text + blue bottom border
- Inactive tab: muted text
- Close button: `×` on each file tab
- Terminal tab: always first, always present, never closeable

### 2.6 Shared Behavior

| Feature | Desktop | Mobile |
|---------|---------|--------|
| Max tabs | 10 | 10 |
| Dirty tracking | Amber dot in tab | Not shown (simplify) |
| Large file warning | Dialog | Dialog |
| Delete → close tab | ✓ | ✓ |
| Rename → update tab path | ✓ | ✓ |
| Refit terminal on reveal | ✓ (useEffect) | ✓ (useEffect) |
| Tab overflow | Scrollable | Scrollable |

## 3. Files Changed

| File | Change |
|------|--------|
| `hooks/useFileTabs.ts` | **New** — extracted hook |
| `components/FileTabs.tsx` | Import hook, remove inline definition; keep `TabBar` |
| `components/MobileFileTabs.tsx` | **New** — mobile layout |
| `components/MobileTerminalLayout.tsx` | Wire `onFileClick` via ref, add `MobileFileTabs` above BottomSheet |
| `components/__tests__/FileTabs.test.tsx` | Update imports if needed |
| `components/__tests__/MobileFileTabs.test.tsx` | **New** — mobile-specific tests |

## 4. Testing

- `useFileTabs` — already covered by `FileTabs.test.tsx` (631 existing tests, hook extraction doesn't change behavior)
- `MobileFileTabs.test.tsx` — new:
  - Renders terminal when no files open, no tab strip visible
  - Clicking a file (via hook) shows tab strip + FileViewer
  - Switching to terminal tab shows terminal
  - Closing last file tab hides tab strip
  - Max 10 tabs enforced
  - File delete closes corresponding tab

## 5. Non-Goals

- Mobile editing parity (dirty indicator, unsaved-changes dialog) — deferred to follow-up
- P2P file transfer on mobile — already works, unchanged
- CodeMirror mobile keyboard issues — existing FileViewer handles this
