# Mobile Mode Bar — Design Spec

**Date:** 2026-08-08
**Branch:** feat/mobile-file-viewing
**Status:** approved

## Overview

Replace the bottom dot indicator (`BottomNavIndicator`) with a top-mounted 2px mode bar inside `SwipeableViewport`. The mode bar is a thin phosphor-green line that slides between three positions (33% / 50% / 67%) to indicate which panel is active. It follows the user's finger during drag and springs to the nearest position on release.

## Motivation

The current three-dot indicator (`● ○ ○`) is functional but reads as a generic onboarding carousel. For a terminal tool — where every pixel of vertical space matters and the aesthetic should feel precise and hardware-like — a thin line at the top is both more space-efficient and more distinctive.

## Signature Element

A 2px-tall bar with a moving primary-colored segment:

```
████████░░░░░░░░░░░░░░░░  ← Terminal active
░░░░░░░░████████░░░░░░░░  ← Files active
░░░░░░░░░░░░░░░░████████  ← Envs active
```

- **Track**: full width, `bg-muted/20`, 2px height
- **Thumb**: 1/3 width (100% / panelCount), `bg-primary`
- **During drag**: no transition (instant follow)
- **On release**: `transition-[left] duration-300 ease-out`

## Architecture

### New Component: `ModeBar`

```
web/src/components/ModeBar.tsx
```

```ts
interface ModeBarProps {
  count: number;           // number of panels (3)
  activeIndex: number;     // 0, 1, or 2
  dragOffset: number;      // px offset during drag, 0 when idle
  isDragging: boolean;
}
```

Internal calculation:
```
segmentWidth = 100 / count              // e.g. 33.33%
baseLeft = activeIndex * segmentWidth   // e.g. 0%, 33.33%, 66.67%
offsetPercent = (dragOffset / viewportWidth) * segmentWidth
finalLeft = clamp(baseLeft - offsetPercent, 0, 100 - segmentWidth)
```

The `viewportWidth` is read from a ref on the track element via `getBoundingClientRect()`.

### Modified: `SwipeableViewport`

- Render `<ModeBar>` at the top (inside the container, above the inner flex div)
- Pass `activeIndex`, `dragOffset` (from state), `isDragging` (from state) as props
- ModeBar is absolutely positioned at top:0 — it overlays the panel content
- The inner flex container gets `pt-[2px]` so panel content starts below the mode bar

### Modified: `MobileTerminalLayout`

- Remove `<BottomNavIndicator>` import and usage
- Add minimal panel headers for Files and Envs:
  ```tsx
  {/* Files panel header */}
  <div className="flex items-center px-3 h-7 border-b">
    <span className="text-xs text-muted-foreground font-medium">Files</span>
  </div>
  ```
  ```tsx
  {/* Envs panel header */}
  <div className="flex items-center px-3 h-7 border-b">
    <span className="text-xs text-muted-foreground font-medium">Environment</span>
  </div>
  ```
- Terminal panel gets no header — terminal starts right below the mode bar

### Deleted

- `web/src/components/BottomNavIndicator.tsx`
- `web/src/components/__tests__/BottomNavIndicator.test.tsx` (if exists)

## Panel Layout (ASCII)

```
Panel 0: Terminal                    Panel 1: Files                       Panel 2: Envs
┌─────────────────────┐             ┌─────────────────────┐             ┌─────────────────────┐
│████████░░░░░░░░░░░░░│ ModeBar     │░░░░░░░░████████░░░░░│             │░░░░░░░░░░░░░░░░█████│
│                     │             │ Files               │ header      │ Environment         │
│                     │             ├─────────────────────┤             ├─────────────────────┤
│    xterm.js         │             │                     │             │                     │
│    (full-bleed)     │             │    FileViewer       │             │    KEY = VALUE      │
│                     │             │    (60%)            │             │    KEY = VALUE      │
│                     │             │                     │             │                     │
│                     │             ├─────────────────────┤             │                     │
├─────────────────────┤             │    FileBrowser      │             │                     │
│ ▲  [^C] [⌧] [^R]   │ input bar   │    (40%)            │             │                     │
└─────────────────────┘             └─────────────────────┘             └─────────────────────┘
```

## Behavior

| State | ModeBar behavior |
|-------|-----------------|
| Idle | Bar sits at its segment position, no animation |
| Dragging | Bar follows finger in real-time, no CSS transition |
| Released (snap) | Bar springs to nearest full position, 300ms ease-out |
| Panel snapped | `activeIndex` updates, bar is at the target position |

## Non-goals

- ModeBar is NOT interactive (tap on it does nothing)
- No haptic feedback
- No panel count > 3 support in this iteration
- Desktop layout is unchanged

## shadcn/ui Compliance

- Uses semantic tokens only: `bg-primary`, `bg-muted/20`
- No custom colors, no raw hex values
- No new shadcn components needed

## Files Changed

| File | Action |
|------|--------|
| `web/src/components/ModeBar.tsx` | NEW |
| `web/src/components/SwipeableViewport.tsx` | MODIFY — integrate ModeBar |
| `web/src/components/MobileTerminalLayout.tsx` | MODIFY — remove BottomNavIndicator, add headers |
| `web/src/components/BottomNavIndicator.tsx` | DELETE |
