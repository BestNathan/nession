# Mobile Panel Layout Redesign — Design Spec

**Date:** 2026-08-08
**Branch:** feat/mobile-file-viewing

## Overview

Redesign the internal layouts of Terminal Panel and Files Panel within the mobile SwipeableViewport. Both panels use a collapsible bottom section pattern — terminal has an input/commands bar, files has a file browser. The collapse/expand behavior should be consistent across both panels.

## Goals

1. **Terminal Panel:** Redesign CollapsibleInputBar with quick-action buttons in collapsed state, proper xterm refit on expand/collapse
2. **Files Panel:** Restructure as top-bottom split (60/40): FileViewer on top, collapsible FileBrowser on bottom
3. Both panels use consistent collapse UX (toggle button with chevron, smooth transition)

## Architecture

### Terminal Panel

```
Collapsed (default):
┌─────────────────────────┐
│   Terminal (flex-1)     │
├─────────────────────────┤
│ ▲ Input & Commands [⚡] [🗑] [📋] │  ← toggle + quick actions
└─────────────────────────┘

Expanded:
┌─────────────────────────┐
│   Terminal (flex-1)     │
├─────────────────────────┤
│ ▼ Hide   [Input] [Commands] │  ← toggle + Tabs
│   InputPanel / QuickCommands │
└─────────────────────────┘
```

- **Collapsed toolbar:** toggle button + 2-3 quick-action icon buttons (send break/Ctrl-C, clear terminal, copy selection)
- **Expanded:** `Tabs` (Input | Commands) with `InputPanel` / `QuickCommandsPanel`
- **xterm refit:** Call `onTerminalReveal` after collapse/expand animation completes
- **Content height:** `max-h-[35vh]` for the expanded content area

### Files Panel

```
Expanded (default):
┌─────────────────────────┐
│   FileViewer (60%)      │  ← or empty state if no file selected
├─────────────────────────┤
│ ▼ Files                 │
│   FileBrowser (40%)     │
└─────────────────────────┘

Collapsed:
┌─────────────────────────┐
│   FileViewer (100%)     │
├─────────────────────────┤
│ ▲ Files                 │
└─────────────────────────┘
```

- Uses shadcn `Resizable` with `ResizablePanelGroup` (vertical), `defaultSize` 60/40
- Or simpler: CSS `flex` with a toggle that switches between 60/40 and 100/0
- **Prefer CSS flex approach** for simplicity (no Resizable dependency in mobile panel):
  - `flex-[6]` / `flex-[4]` when expanded
  - `flex-1` / `hidden` when collapsed
- **Empty state:** "Select a file to view" centered in the viewer area when no file selected
- **Toggle:** same chevron pattern as Terminal panel — `▼ Files` when expanded, `▲ Files` when collapsed

## Components

### Modified

| File | Changes |
|------|---------|
| `MobileTerminalLayout.tsx` | Rewrite `CollapsibleInputBar` → new `TerminalInputBar`; rewrite Files panel section → new `FilesPanel` component; extract helper components |

### New (within MobileTerminalLayout.tsx)

- `TerminalInputBar` — replaces CollapsibleInputBar: quick actions in collapsed state, Tabs in expanded state
- `FilesPanel` — new component: top-bottom split with collapsible FileBrowser

### No new files

All changes are within `MobileTerminalLayout.tsx`. If the file grows too large (>300 lines), extract `TerminalInputBar` and `FilesPanel` into separate files.

## shadcn Components Used

- `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` — collapse/expand (already installed)
- `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` — Input/Commands tabs (already installed)
- `Button` — toggle and quick-action buttons (already installed)
- `Tooltip` — quick-action button labels (already installed)
- `Separator` — visual divider between toolbar and content (already installed)

## Behavior

### Collapse/Expand
- Both panels default to collapsed (terminal: input hidden, files: browser hidden)
- Toggle button always visible at bottom of panel
- Chevron direction: ▲ = collapsed (click to expand), ▼ = expanded (click to collapse)
- smooth CSS animation via CollapsibleContent

### xterm refit
- When TerminalInputBar expands/collapses, the terminal container height changes
- After the Collapsible animation completes (~200ms), call `onTerminalReveal?.()` to trigger xterm.fit()
- `onTerminalReveal` is passed from parent via `TerminalLayout`

### Files empty state
- When no file is selected, the top 60% area shows a centered message: "Select a file to view"
- When a file is selected, FileViewer renders immediately
- Bottom FileBrowser is always mounted (preserves scroll position)
