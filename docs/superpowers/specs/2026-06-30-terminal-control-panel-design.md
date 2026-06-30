# Terminal Control Panel — Design

**Date:** 2026-06-30
**Status:** Approved (design)
**Area:** Web UI (`web/src`)

## Summary

Add a control panel to the terminal view that lets the user (1) send quick
commands with one click and (2) type free text in an input box and send it to
the attached terminal session. The panel lives as a right-hand sidebar next to
the terminal.

Both send paths inject text into the same remote session that keyboard input
already uses, working identically in P2P and relay modes.

## Goals

- One-click "quick commands" that execute in the attached session.
- A free-text input + send button that sends arbitrary text to the session.
- Quick commands: built-in presets **plus** user-added commands, with user
  additions persisted in the browser (localStorage).
- Send auto-executes (appends carriage return `\r`).

## Non-Goals

- No server-side storage or sync of quick commands (local browser only).
- No editing of preset commands (presets are code-defined; users add their own).
- No new JS test framework (project currently has none).
- No changes to the agent/server protocol.

## Background / Current State

`TerminalView` (in `web/src/components/Dashboard.tsx`) renders a header and a
`<Terminal>` component. `Terminal` (`web/src/components/Terminal.tsx`) owns its
WebSocket connection inside a `useEffect` and forwards xterm keystrokes
(`term.onData`) to the remote session:

- **P2P mode:** sends a `terminal.input` message with base64-encoded `data` and
  `session_name` over a WebSocket the component owns directly.
- **Relay mode:** calls `serverConnection.sendTerminalInput(sessionId, data)` on
  the shared `WebSocketService`.

There is currently **no way for an outside component to inject input** into the
session — this is the seam the control panel needs.

## Architecture

### The `sendText` seam (chosen: imperative ref handle)

`Terminal` is wrapped with `forwardRef` and exposes an imperative handle:

```ts
export interface TerminalHandle {
  sendText: (text: string) => void;
}
```

Implementation:

- Inside the existing effect, the per-mode send logic is extracted into a single
  closure `sendData(data: string)` that wraps text the same way the keystroke
  path already does (P2P: base64 + `session_name` `terminal.input`; relay:
  `serverConnection.sendTerminalInput`).
- The closure is stored in a ref (`sendDataRef`) so it remains reachable after
  the effect runs and always references the live connection.
- `useImperativeHandle(ref, () => ({ sendText: (t) => sendDataRef.current?.(t) }))`.
- If the socket is not open, `sendText` is a no-op (mirrors the existing
  keystroke guard) — no throw, no error spam.

The existing `term.onData` keystroke path is refactored to call the same
`sendData` closure, so there is one transport implementation per mode rather
than two.

### Component tree

```
TerminalView (Dashboard.tsx)
├── header (Back, session title, mode badge)   [unchanged]
└── terminal-view-body  (flex row)
    ├── Terminal (forwardRef → TerminalHandle)  flex: 1
    └── ControlPanel { sendText }               fixed-width sidebar
```

`TerminalView` holds a `useRef<TerminalHandle>` and passes
`sendText={(t) => terminalRef.current?.sendText(t)}` to `ControlPanel`.

## Components

### `ControlPanel.tsx` (new) + `ControlPanel.css` (new)

**Props:** `{ sendText: (text: string) => void }`

Two stacked regions inside the sidebar:

1. **Quick commands (快捷指令)** — scrollable list of buttons.
   - Click → `sendText(command + "\r")` (auto-execute), unless the command is
     flagged `raw`, in which case `sendText(command)` exactly (for control keys).
   - User-added commands show a small `×` delete control; presets do not.
   - A `+ 添加` button reveals an inline form (label + command text fields) plus
     a confirm action that appends to the user command list and persists.

2. **Free input (输入框 + 发送)** — a `<textarea>` (1–2 rows) and a 发送 button.
   - Send → `sendText(value + "\r")`, then clear the textarea.
   - `Enter` sends; `Shift+Enter` inserts a newline.
   - Empty/whitespace-only input is ignored.

### `quickCommands.ts` (new — small module)

- Type: `QuickCommand { id: string; label: string; command: string; raw?: boolean }`.
- `PRESETS: QuickCommand[]` — starter set: `clear`, `ls -la`, `git status`,
  `git pull`, and `Ctrl+C` (`command: "\x03"`, `raw: true`).
- `loadUserCommands(): QuickCommand[]` — reads localStorage key
  `nession_quick_commands`, wrapped in try/catch; returns `[]` on any failure.
- `saveUserCommands(cmds: QuickCommand[]): void` — writes the array.
- Rendered list = `PRESETS` concatenated with user commands. Only user commands
  are persisted, so future preset changes never clobber user data.

## Data Flow

```
Quick command click ─┐
Free input send ─────┤→ ControlPanel.sendText(text [+ "\r"])
                      └→ TerminalView terminalRef.current.sendText(text)
                          └→ Terminal sendDataRef.current(text)
                              ├ P2P:   WS terminal.input { session_name, data: b64 }
                              └ relay: serverConnection.sendTerminalInput(sessionId, text)
```

Identical to the keystroke path; the control panel is mode-agnostic.

## Layout

- `terminal-view-body` becomes a flex row.
- Terminal: `flex: 1` — fills remaining width; existing `window.resize` → fit
  logic is unchanged, so it adapts to the narrower stable width.
- ControlPanel: fixed width ~240px, full height; command list scrolls; input
  pinned at the bottom. Dark theme matching the existing Catppuccin palette
  (`#1e1e2e` / `#cdd6f4`, etc.).
- Responsive: below ~768px the layout switches to a column (sidebar drops below
  the terminal).

## Error Handling

- `sendText` no-ops when the socket is closed (same guard as keystrokes).
- Add-command form trims whitespace and ignores empty label or command.
- localStorage read/parse failures fall back to presets-only.

## Testing

The project has no JS test runner (ESLint only). Verification:

- `npm run lint` passes clean.
- `npm run build` (tsc + vite) passes.
- Manual smoke test: attach to a session; click a preset (executes); type and
  send free text; add and delete a custom command; reload to confirm the custom
  command persists; confirm both P2P and relay sessions work.

## Files Touched

- `web/src/components/Terminal.tsx` — `forwardRef`, `TerminalHandle`,
  `sendData` extraction, `useImperativeHandle`.
- `web/src/components/Dashboard.tsx` — `TerminalView` holds the ref, flex-row
  body, renders `ControlPanel`.
- `web/src/components/ControlPanel.tsx` — new.
- `web/src/components/ControlPanel.css` — new.
- `web/src/components/quickCommands.ts` — new (presets + persistence helpers).
- `web/src/components/Dashboard.css` — terminal-view-body flex-row + responsive.
