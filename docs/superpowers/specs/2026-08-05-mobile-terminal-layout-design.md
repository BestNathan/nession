# Mobile Terminal Layout Redesign — Design Spec

**Date:** 2026-08-05
**Status:** Approved
**Requirement:** [#174](https://github.com/BestNathan/nession/issues/174)

## 1. Overview

Redesign the Nession web UI terminal page for mobile devices, addressing three core problems: tab switching height jumps, chaotic commands layout, and keyboard push-up behavior. Desktop layout (≥1024px) remains unchanged.

### Decision Summary

| # | Decision |
|---|----------|
| 1 | **Separate MobileTerminalLayout** — new component, desktop code untouched |
| 2 | **Manual collapse/expand** — ▼/▲ button + keyboard auto-collapse |
| 3 | **8px invisible trigger strip** — activates FloatingKeyBar on touch |
| 4 | **sendText + refocus** — key press → send → focus terminal (same as existing MobileKeyPanel pattern) |
| 5 | **localStorage history** — global, 500 entries, deduplicated by command text |
| 6 | **Shared panels** — InputPanel and QuickCommandsPanel used by both mobile and desktop |
| 7 | **Zoom in TabBar** — right side of bottom sheet tab bar |
| 8 | **11 physical keys** — single row ≥400px, two rows <400px, never drop keys |

---

## 2. Component Architecture

### 2.1 Component Tree

```
TerminalView
├── TerminalHeader                          (zoom removed on mobile)
├── [isMobile]
│   └── MobileTerminalLayout               NEW
│       ├── FloatingKeyBar                  NEW (overlay, absolute)
│       ├── Terminal                        (shared, existing)
│       ├── KeyBarTrigger                   NEW (8px touch strip)
│       └── BottomSheet                    (heavily refactored from BottomBar)
│           ├── TabBar                      NEW (extracted from BottomBar)
│           ├── InputPanel                  NEW (tab content)
│           ├── QuickCommandsPanel          REWRITE (tab content, shared with desktop)
│           ├── EnvPanel                    (shared, existing)
│           └── FileBrowser                (shared, existing)
│   └── [desktop]
│       └── TerminalLayout                  (existing, updated to use new panels)
│           ├── FileTabs / SidePanel        (unchanged)
│           └── BottomBar                   (updated: uses new QuickCommandsPanel + InputPanel)
```

### 2.2 File Manifest

| File | Action | Purpose |
|------|--------|---------|
| `components/MobileTerminalLayout.tsx` | **NEW** | Mobile layout orchestrator: FloatingKeyBar + KeyBarTrigger + Terminal + BottomSheet |
| `components/FloatingKeyBar.tsx` | **NEW** | 11-key semi-transparent overlay, auto-hide timer, swipe dismiss, ◉ restore handle |
| `components/InputPanel.tsx` | **NEW** | Fixed-height textarea + action buttons + live-filtered history list. Shared mobile & desktop. |
| `components/QuickCommandsPanel.tsx` | **REWRITE** | Flat list, 6 Ctrl+ presets, Plain/Ctrl+ add modes. Shared mobile & desktop. |
| `components/BottomSheet.tsx` | **NEW** | Fixed-height sheet (40vh/30vh), TabBar + tab content area + collapse state. Mobile only. |
| `components/TerminalLayout.tsx` | UPDATE | Add mobile detection; route mobile to MobileTerminalLayout. Use new InputPanel/QuickCommandsPanel for desktop BottomBar. |
| `components/TerminalView.tsx` | UPDATE | Add visualViewport wiring, command history state, keyboard-aware collapse |
| `components/BottomBar.tsx` | UPDATE | Accept new InputPanel/QuickCommandsPanel as children; preserve desktop behavior |
| `components/TerminalToolbar.tsx` | UPDATE | Extract input section; delegates to InputPanel on desktop |
| `components/MobileKeyPanel.tsx` | **DELETE** | Replaced by FloatingKeyBar |
| `hooks/useVisualViewport.ts` | **NEW** | visualViewport API wrapper: height, offsetTop, isKeyboardOpen |
| `hooks/useCommandHistory.ts` | **NEW** | Global history store: localStorage, 500 entries, dedup, search/filter |
| `hooks/useFloatingKeyBar.ts` | **NEW** | Key bar state machine: visible → timer → auto-hide, dismissed → ◉ handle → restore |

---

## 3. Component Specs

### 3.1 FloatingKeyBar

**Purpose:** Semi-transparent overlay providing PC keyboard keys missing on mobile. Auto-hides when not in use.

```
┌──────────────────────────────┐
│   Terminal (xterm.js)        │
│                              │
│ ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐ │
│ ┊ ← ↑ ↓ → │ Home End │    ┊ │  ← ≥400px: single row, horizontal scroll
│ ┊ PgUp PgDn │ Tab Esc Del ┊ │     <400px: flex-wrap two rows, no scroll
│ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘ │
│                              │
│ [KeyBarTrigger 8px strip]    │  ← invisible touch target
├──────────────────────────────┤
│ BottomSheet                  │
└──────────────────────────────┘
```

**Keys (11 total, 3 groups):**

| Group | Keys | Escape Sequences |
|-------|------|-----------------|
| Nav | ← ↑ ↓ → | `\x1b[D]` `\x1b[A]` `\x1b[B]` `\x1b[C]` |
| Jump | Home End PgUp PgDn | `\x1b[H]` `\x1b[F]` `\x1b[5~]` `\x1b[6~]` |
| Special | Tab Esc Del | `\t` `\x1b` `\x1b[3~]` |

**Props:**

```typescript
interface FloatingKeyBarProps {
  sendText: (text: string) => void;
  focusTerminal: () => void;
}
```

**State (internal, via useFloatingKeyBar hook):**

```typescript
interface FloatingKeyBarState {
  visible: boolean;       // currently shown
  dismissed: boolean;     // user manually closed (shows ◉ handle)
}
```

**Behavior:**
- `visible=true` when KeyBarTrigger touch detected or ◉ handle tapped
- 3s after last button tap → `visible=false` (fade-out 300ms)
- Swipe down on key bar → `dismissed=true, visible=false`
- `dismissed=true` → render ◉ handle pill (8px × 40px, centered at bottom of terminal area)
- ◉ handle tap → `dismissed=false, visible=true`
- Keyboard open (`isKeyboardOpen`) → force `visible=false` regardless of state
- All buttons: `tabIndex={-1}`, `onClick` → `sendText(seq)` → `focusTerminal()`
- Visual: `bg-background/80 backdrop-blur-sm`, rounded-md, mx-2, absolute bottom-0 of terminal container

**Adaptive layout:**
```css
/* ≥400px: single row, scroll if needed */
.keybar-row { display: flex; flex-wrap: nowrap; overflow-x: auto; }
/* <400px: wrap to two rows, no scroll */
@media (max-width: 399px) { .keybar-row { flex-wrap: wrap; overflow-x: visible; } }
```

### 3.2 BottomSheet

**Purpose:** Fixed-height tabbed panel replacing the variable-height BottomBar on mobile.

```
┌──────────────────────────────────────────┐
│ [Input] [Commands] [Env] [Files]  [-14+↺][▼]│  ← TabBar (40px)
├──────────────────────────────────────────┤
│                                          │
│ Tab content area                         │  ← h-[40vh] portrait / h-[30vh] landscape
│ overflow-y-auto                          │     fixed height, all tabs share it
│                                          │
└──────────────────────────────────────────┘

Collapsed: TabBar only (40px), content area hidden.
```

**Props:**

```typescript
interface BottomSheetProps {
  activeTab: BottomTab;
  onTabChange: (tab: BottomTab) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  showFilesTab: boolean;
  fontSizeManager: FontSizeManager | null;
  inputPanel: ReactNode;
  commandsPanel: ReactNode;
  envPanel: ReactNode;
  filesPanel?: ReactNode;
}
```

**TabBar internal:**
- 4 buttons (Input/Commands/Env/Files), active state with `border-b-2 border-primary`
- Zoom controls (`- 14px + ↺`) from existing ZoomControls component
- Collapse toggle (▼/▲) on far right
- Files tab hidden when `showFilesTab=false`

**Collapse behavior:**
- `collapsed=true` → content area `hidden`, TabBar remains
- Toggle via ▼/▲ button → `onToggleCollapse()`
- `isKeyboardOpen=true` → parent sets `collapsed=true` automatically
- Keyboard closes → parent restores `collapsed` to user's last manual state

### 3.3 InputPanel

**Purpose:** Command input + live-filtered history. Shared by mobile (inside BottomSheet tab) and desktop (inside TerminalToolbar area).

```
┌──────────────────────────────┐
│ [✕] [📋] [📄]               │  操作按钮行
├──────────────────────────────┤
│ $ git p....                  │  textarea, 固定 2-3 行高度
│                              │  Enter → 发送, Shift+Enter → 换行
├──────────────────────────────┤
│ Matching (3)                 │  ← 实时匹配结果
│ git pull            (2m ago) │     tap → 回填到输入框
│ git push origin    (12m ago) │     输入为空 → 显示全量历史
│ git log --oneline   (1h ago) │
└──────────────────────────────┘
```

**Props:**

```typescript
interface InputPanelProps {
  sendText: (text: string) => void;
  disabled: boolean;
}
```

**Action buttons:**

| Icon | Action | Implementation |
|------|--------|---------------|
| ✕ | Clear input | `setInputValue('')` |
| 📋 | Copy input | `navigator.clipboard.writeText(inputValue)` |
| 📄 | Paste to input | `navigator.clipboard.readText().then(setInputValue)` |

**Live filtering:**
- `onChange` on textarea → `filterHistory(inputValue)` from `useCommandHistory`
- Match: case-insensitive substring of `command` field
- Results sorted by recency (most recent first)
- Show match count in header ("Matching (3)" or "History (500)")
- Empty input → show all, most recent first
- Tap result → `setInputValue(entry.command)`, does NOT send

### 3.4 useCommandHistory Hook

```typescript
interface HistoryEntry {
  id: string;           // nanoid
  command: string;      // the full command string
  timestamp: number;    // Date.now()
}

interface UseCommandHistoryReturn {
  history: HistoryEntry[];
  addEntry: (command: string) => void;
  removeEntry: (id: string) => void;
  clearHistory: () => void;
  filterHistory: (query: string) => HistoryEntry[];
}
```

**Storage:**
- localStorage key: `nession_command_history`
- Max 500 entries
- Dedup: if `command` already exists → update `timestamp` to now, move to front. Do NOT add duplicate.
- FIFO eviction when >500

**filterHistory:**
- Case-insensitive substring match on `entry.command`
- Returns matching entries sorted by `timestamp` desc
- Empty query → all entries, sorted by `timestamp` desc

### 3.5 QuickCommandsPanel (rewrite)

**Purpose:** Flat list of commands with Ctrl+ support. Shared mobile & desktop.

```
┌──────────────────────────────┐
│ Ctrl+C        (SIGINT)  [▶] │  ← preset, no delete button
│ Ctrl+D        (EOF)     [▶] │
│ Ctrl+A     (beg-of-line)[▶] │
│ Ctrl+E     (end-of-line)[▶] │
│ Ctrl+W    (del-word)   [▶] │
│ Ctrl+U    (del-line)   [▶] │
│ ─────────────────────────── │
│ ls -la              [▶] [×] │  ← user command, deletable
│ git status          [▶] [×] │
│ ─────────────────────────── │
│ [+ Add Command]             │
└──────────────────────────────┘
```

**Props:**

```typescript
interface QuickCommandsPanelProps {
  sendText: (text: string) => void;
  disabled: boolean;
}
```

**Data model:**

```typescript
interface CommandEntry {
  id: string;          // 'preset-ctrl-c' or server-assigned id
  label: string;       // 'Ctrl+C' or 'ls -la'
  command: string;     // '\x03' or 'ls -la'
  raw: boolean;        // true → verbatim, false → append \r
  isPreset: boolean;   // true → not deletable
}
```

**Default presets:**

| ID | Label | Hint | Command | raw |
|----|-------|------|---------|-----|
| preset-ctrl-c | Ctrl+C | SIGINT | `\x03` | true |
| preset-ctrl-d | Ctrl+D | EOF | `\x04` | true |
| preset-ctrl-a | Ctrl+A | beg-of-line | `\x01` | true |
| preset-ctrl-e | Ctrl+E | end-of-line | `\x05` | true |
| preset-ctrl-w | Ctrl+W | del-word | `\x17` | true |
| preset-ctrl-u | Ctrl+U | del-line | `\x15` | true |

**Add form (inline expansion or Dialog):**

Two modes, toggle via segmented control:

```
Plain Text mode:
  Label:   [____________]
  Command: [____________]   → sends command + \r

Ctrl+ mode:
  Label: [Ctrl+K_______]   ← auto-generated, editable
  Key:   [K]              ← single letter A-Z, generates String.fromCharCode(code-64)
```

**Data source:**
- Presets: hardcoded constants (6 entries)
- User commands: via existing `useQuickCommands` hook (server-side storage via WebSocket)
- Render: `[...presets, ...userCommands]` as flat list, separator line between

**Click behavior:**
- Tap row → `sendText(cmd.raw ? cmd.command : cmd.command + '\r')`
- Desktop click → same behavior
- Delete button (×) only on user commands → `deleteCommand(id)`

### 3.6 useVisualViewport Hook

```typescript
interface VisualViewportState {
  height: number;
  offsetTop: number;
  width: number;
  isKeyboardOpen: boolean;
}

function useVisualViewport(): VisualViewportState;
```

**Implementation:**

```typescript
function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(() => ({
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
    offsetTop: 0,
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    isKeyboardOpen: false,
  }));

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;

    const handler = () => {
      const vv = window.visualViewport!;
      const isKeyboardOpen = vv.height < window.innerHeight * 0.75;
      setState({
        height: vv.height,
        offsetTop: vv.offsetTop,
        width: vv.width,
        isKeyboardOpen,
      });
    };

    window.visualViewport.addEventListener('resize', handler);
    window.visualViewport.addEventListener('scroll', handler);  // iOS needs both
    handler(); // initial read

    return () => {
      window.visualViewport!.removeEventListener('resize', handler);
      window.visualViewport!.removeEventListener('scroll', handler);
    };
  }, []);

  return state;
}
```

### 3.7 MobileTerminalLayout

**Purpose:** Orchestrator composing all mobile-specific components.

```
┌──────────────────────────────┐
│ TerminalHeader (compact)     │  ← Back, Session ▼, P2P badge, Address (no zoom)
├──────────────────────────────┤
│                              │
│ Terminal                    │  ← flex-1 min-h-0, mounts xterm
│   + KeyBarTrigger (8px)     │     invisible strip at bottom edge
│   + FloatingKeyBar (overlay)│     absolute bottom-0, z-10
│                              │
├──────────────────────────────┤
│ BottomSheet                  │  ← flex-shrink-0
│   TabBar + content           │     40vh/30vh fixed height
└──────────────────────────────┘
```

**State managed here:**
- `showKeyBar: boolean` — passed to FloatingKeyBar visible
- `keyBarDismissed: boolean` — passed to FloatingKeyBar dismissed
- `bottomTab: BottomTab` — active tab
- `sheetCollapsed: boolean` — user's manual collapse state

**Keyboard handling:**
- `isKeyboardOpen` from `useVisualViewport`
- → `useEffect`: keyboard opens → save current `sheetCollapsed` ref, set `collapsed=true`
- → `useEffect`: keyboard closes → restore saved `sheetCollapsed`
- → `useEffect`: keyboard opens → `setShowKeyBar(false)`

### 3.8 Desktop Compatibility

**TerminalLayout (desktop path):**
- `isMobile=false` → existing layout structure unchanged
- Replaces old `QuickCommandsPanel` with new shared `QuickCommandsPanel`
- Adds `InputPanel` in the input area (replaces the current raw textarea in `TerminalToolbar`)
- Zoom controls stay in existing position (next to send button) on desktop

**BottomBar (desktop):** existing `max-h-[40dvh]` behavior, variable height, shows the same new panel components.

---

## 4. Data Flow

```
TerminalView (state owner)
│
├── useVisualViewport()         → { isKeyboardOpen, ... }
├── useQuickCommands()          → { userCommands, addCommand, deleteCommand }
│
├── MobileTerminalLayout
│   ├── FloatingKeyBar          ← sendText (prop), focusTerminal (prop)
│   ├── Terminal                ← sessionId, mode, connections
│   └── BottomSheet
│       ├── InputPanel          ← sendText (uses useCommandHistory internally)
│       ├── QuickCommandsPanel  ← sendText, userCommands, presets
│       ├── EnvPanel            ← sessionId (existing)
│       └── FileBrowser         ← fileOps (existing)
│
└── TerminalLayout (desktop)
    ├── InputPanel              ← same props
    ├── QuickCommandsPanel      ← same props
    └── ...existing...
```

**Send flow (InputPanel):**
1. User types → Enter → `sendText(command + '\r')`
2. `addEntry(command)` → history updated, deduped, localStorage persisted
3. `setInputValue('')` — clear input

**Send flow (QuickCommandsPanel):**
1. User taps row → `sendText(raw ? command : command + '\r')`
2. Does NOT add to history (Commands tab = convenience, not user's own input)

**Send flow (FloatingKeyBar):**
1. User taps key → `sendText(escapeSequence)` → `focusTerminal()`
2. Does NOT add to history (raw key, not a command)

---

## 5. CSS / Layout Notes

### Height Constants

| Context | Height |
|---------|--------|
| BottomSheet expanded (portrait) | `h-[40vh]` |
| BottomSheet expanded (landscape) | `h-[30vh]` |
| BottomSheet collapsed | `h-10` (TabBar only, ~40px) |
| TabBar | `h-10` |
| InputPanel textarea | `h-[3.25rem]` (~2.5 rows at 16px) |
| FloatingKeyBar button | `h-8` (32px visual, 44px touch via padding) |
| KeyBarTrigger strip | `h-2` (8px) |

### Keyboard Handling CSS

```css
/* Prevent keyboard from pushing layout */
.mobile-terminal-container {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  /* bottom set via JS based on visualViewport */
}
```

Primary approach: use ResizeObserver on terminal container (already exists) + BottomSheet collapse. The root `h-[100dvh]` behavior is acceptable when the sheet is collapsed (just TabBar visible).

### FloatingKeyBar Positioning

```css
.floating-keybar {
  position: absolute;
  bottom: calc(0.5rem + 8px);  /* above KeyBarTrigger */
  left: 0.5rem;
  right: 0.5rem;
  z-index: 10;
  background: hsl(var(--background) / 0.8);
  backdrop-filter: blur(4px);
  border-radius: var(--radius-md);
}
```

---

## 6. Deletion List

| File | Reason |
|------|--------|
| `components/MobileKeyPanel.tsx` | Replaced by FloatingKeyBar |
| `components/__tests__/MobileKeyPanel.test.tsx` | Component removed |

---

## 7. Testing Strategy

### Unit Tests (new)
- `useVisualViewport` — mock `window.visualViewport`, test resize/scroll events, `isKeyboardOpen` threshold
- `useCommandHistory` — add, dedup, sort, filter, localStorage read/write, 500 limit eviction
- `useFloatingKeyBar` — state machine: visible→timer→hide, dismiss→handle→restore
- `InputPanel` — render, action buttons (clear/copy/paste), filter display, tap-to-fill
- `QuickCommandsPanel` — render presets + user commands, add form toggle, Ctrl+ mode char generation
- `FloatingKeyBar` — render 11 keys, button click sends correct escape sequence, responsive class
- `BottomSheet` — tab switching, collapse/expand, height classes, zoom controls

### Existing Tests (updated)
- `BottomBar.test.tsx` — update for new props/children pattern
- `TerminalToolbar` — update for InputPanel extraction

### Integration (manual + Playwright)
- Mobile viewport (375px, 414px, 768px) screenshot comparison
- Keyboard open/close simulation
- Tab switching height consistency
- FloatingKeyBar show/hide behavior

---

## 8. Rollout

1. Implement hooks first (`useVisualViewport`, `useCommandHistory`, `useFloatingKeyBar`)
2. Build new components (`FloatingKeyBar`, `InputPanel`, `BottomSheet`)
3. Rewrite `QuickCommandsPanel` (shared)
4. Build `MobileTerminalLayout` composing everything
5. Wire `TerminalLayout` and `TerminalView` for mobile/desktop routing
6. Desktop: replace old panels with new shared ones
7. Delete `MobileKeyPanel`
8. Tests + screenshots
