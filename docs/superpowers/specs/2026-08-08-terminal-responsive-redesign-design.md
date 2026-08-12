# Terminal Responsive Redesign — Design Spec

**Date:** 2026-08-08
**Branch:** feat/mobile-file-viewing (current)

## Overview

Full overhaul of the terminal layout for both PC and mobile — replacing hand-rolled custom components with shadcn/ui primitives, unifying responsive strategy, and introducing swipe-based mobile navigation.

## Goals

1. Replace hand-rolled tab strips with shadcn `Tabs` everywhere
2. Mobile: bottom tab navigator (Terminal / Files / Envs) with swipe-to-switch
3. Desktop: keep side-by-side resizable split, polish with shadcn
4. CSS-driven responsive switching (no JSX `if/return` that unmounts xterm)
5. Collapse Input + QuickCommands into Terminal's bottom area (mobile)
6. Remove `BottomSheet.tsx`, simplify `MobileFileTabs.tsx`

## Architecture

### Mobile (`< 1024px`)

```
MobileTerminalLayout (rewritten)
├── SwipeableViewport          ← touch swipe + CSS transform, 3 panels
│   ├── TerminalPanel
│   │   ├── xterm Terminal
│   │   └── CollapsibleInputBar
│   │       └── Tabs: Input / Commands
│   ├── FilesPanel             ← independent nav stack
│   │   ├── FileBrowser
│   │   └── FileViewer (← back arrow returns to FileBrowser)
│   └── EnvsPanel
│       └── EnvPanel (reuse)
└── BottomNavIndicator         ← 3 dots (· · ·), current highlighted, visual only
```

### Desktop (`≥ 1024px`)

```
FileTabs (polished, structure unchanged)
├── ResizablePanelGroup
│   ├── SidePanel → FileBrowser
│   └── Main content
│       ├── TabBar (shadcn Tabs for Terminal + file tabs)
│       ├── Terminal / FileViewer
│       └── BottomBar (shadcn Tabs: Input / Commands / Env)
```

## Component Changes

### New / Modified

| File | Action |
|------|--------|
| `MobileTerminalLayout.tsx` | Rewrite: SwipeableViewport + CollapsibleInputBar + BottomNavIndicator |
| `TerminalLayout.tsx` | Simplify: CSS-driven mount, remove BottomSheet wiring |
| `FileTabs.tsx` | Polish TabBar: replace hand-rolled buttons with shadcn `Tabs` |
| `BottomBar.tsx` | Keep as-is (already uses shadcn Tabs) |
| `MobileFileTabs.tsx` | Delete — absorbed into new MobileTerminalLayout |
| `BottomSheet.tsx` | Delete — replaced by CollapsibleInputBar |
| `SwipeableViewport.tsx` | New: touch event handling + CSS transform panel switching |

### shadcn Components Used

- `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` — tab strips (already installed)
- `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` — input bar toggle (already installed)
- `Tooltip` — send/action buttons (already installed)
- `ScrollArea` — file browser viewer (already installed)
- `Separator` — visual dividers (already installed)
- `Button` — back arrow, actions (already installed)

## Responsive Strategy

- **Single breakpoint:** `lg:` (1024px). Below = mobile layout; above = desktop.
- **Both layouts always mounted** — CSS `hidden` / `contents` toggles visibility; no JSX conditional render
- **xterm instance preservation:** The terminal element is shared/proxied so the xterm instance survives layout switches. Desktop `FileTabs` and mobile `MobileTerminalLayout` both receive the same `terminalElement` prop, and only the visible one mounts it into DOM.
- **useMediaQuery hook** drives the toggle; resize from mobile → desktop or vice versa does not destroy terminal state

## Mobile Interaction

- **Swipe:** `touchstart` / `touchend` on the SwipeableViewport — horizontal delta > 50px triggers panel switch, `transform: translateX()` follows the finger
- **Bottom indicator:** 3 dots, current panel highlighted via `bg-primary` / `bg-muted` transition. Non-interactive (swipe is primary; dots are status). Can eventually accept tap if users request it, but not MVP
- **Files panel nav stack:** internal back-arrow from FileViewer → FileBrowser, no impact on other panels
- **CollapsibleInputBar:** `Collapsible` with a toggle button above the Input area. Collapsed = terminal fills to bottom; expanded = Input + Commands tabs visible

## Desktop TabBar

Current hand-rolled `<button>` strip → shadcn `Tabs`:
- `TabsList` contains `TabsTrigger` for Terminal + each open file
- Close button (`X`) inside trigger with `e.stopPropagation()`
- Dirty indicator: amber dot via CSS, not a separate element
- Extension tabs via `renderSlot('terminal-header', ...)` — rendered as additional `TabsTrigger` items

## Files to Remove

- `BottomSheet.tsx` — replaced by CollapsibleInputBar in TerminalPanel
- `MobileFileTabs.tsx` — absorbed into new MobileTerminalLayout

## Risks / Notes

- **xterm double-mount:** Must ensure the xterm DOM node is only attached in one layout at a time. Use a ref-based approach where the xterm wrapper checks visibility before attaching.
- **Swipe vs scroll conflict:** FileBrowser's vertical scroll must not trigger horizontal swipe. Only swipes with `|deltaX| > |deltaY|` count as panel switches.
- **Desktop preserves feature parity:** All existing desktop functionality (resize handle, BottomBar tabs, file browser) remains unchanged — only the TabBar switches to shadcn Tabs.
