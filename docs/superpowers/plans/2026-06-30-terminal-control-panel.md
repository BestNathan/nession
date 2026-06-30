# Terminal Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-hand control panel to the terminal view that sends one-click quick commands (presets + user-added, persisted in localStorage) and free-text input to the attached terminal session.

**Architecture:** Expose an imperative `sendText` handle from the `Terminal` component (via `forwardRef` + `useImperativeHandle`), reusing the existing per-mode (P2P/relay) transport logic through a single `sendData` closure stored in a ref. `TerminalView` holds the ref and passes a `sendText` callback to a new `ControlPanel` sibling rendered in a flex-row layout.

**Tech Stack:** React 18 + TypeScript, xterm.js, Vite. No JS test runner exists — verification is `npm run lint` + `npm run build` (tsc) + manual smoke tests.

---

## Verification Note

This project has **no JS unit-test framework** (only ESLint + tsc via `npm run build`). Standard TDD with test files does not apply. Each task is verified by:
- `npm run build` — TypeScript compiles, Vite bundles.
- `npm run lint` — ESLint clean (`--max-warnings 0`).
- Manual smoke tests at the checkpoints called out below.

All commands run from the `web/` directory.

## File Structure

- `web/src/components/quickCommands.ts` — **new.** `QuickCommand` type, `PRESETS`, and localStorage load/save helpers. Pure module, no React.
- `web/src/components/Terminal.tsx` — **modify.** Add `TerminalHandle`, `forwardRef`, extract `sendData` into a ref, `useImperativeHandle`.
- `web/src/components/ControlPanel.tsx` — **new.** The sidebar UI (quick commands + free input).
- `web/src/components/ControlPanel.css` — **new.** Sidebar styling.
- `web/src/components/Dashboard.tsx` — **modify.** `TerminalView` holds the ref and renders `ControlPanel`.
- `web/src/components/Dashboard.css` — **modify.** `.terminal-view-body` becomes a flex row; responsive column rule.

---

## Task 1: Quick commands module (type, presets, persistence)

**Files:**
- Create: `web/src/components/quickCommands.ts`

- [ ] **Step 1: Create the module**

Create `web/src/components/quickCommands.ts`:

```ts
// Quick command definitions and persistence for the terminal control panel.
//
// Presets are code-defined and never persisted. Only user-added commands are
// stored in localStorage, so changing the preset list in a future release
// never clobbers a user's saved commands.

export interface QuickCommand {
  /** Stable unique id (preset ids are fixed strings; user ids are timestamps). */
  id: string;
  /** Button label shown in the panel. */
  label: string;
  /** Text sent to the terminal. */
  command: string;
  /**
   * When true, `command` is sent verbatim with no trailing carriage return —
   * used for control keys like Ctrl+C ("\x03"). When false/undefined, the
   * sender appends "\r" to execute the command.
   */
  raw?: boolean;
}

const STORAGE_KEY = 'nession_quick_commands';

/** Built-in commands. Order here is the order shown above user commands. */
export const PRESETS: QuickCommand[] = [
  { id: 'preset-clear', label: 'clear', command: 'clear' },
  { id: 'preset-ls', label: 'ls -la', command: 'ls -la' },
  { id: 'preset-git-status', label: 'git status', command: 'git status' },
  { id: 'preset-git-pull', label: 'git pull', command: 'git pull' },
  { id: 'preset-ctrl-c', label: 'Ctrl+C', command: '\x03', raw: true },
];

/** Read user-added commands from localStorage; returns [] on any failure. */
export function loadUserCommands(): QuickCommand[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Keep only well-formed entries.
    return parsed.filter(
      (c): c is QuickCommand =>
        c &&
        typeof c.id === 'string' &&
        typeof c.label === 'string' &&
        typeof c.command === 'string',
    );
  } catch {
    return [];
  }
}

/** Persist user-added commands. Swallows quota/serialization errors. */
export function saveUserCommands(cmds: QuickCommand[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cmds));
  } catch {
    // Ignore — persistence is best-effort.
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd web && npm run build`
Expected: build succeeds (no type errors). The module is unused so far, which is fine.

- [ ] **Step 3: Verify lint is clean**

Run: `cd web && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/quickCommands.ts
git commit -m "feat(web): quick command presets and localStorage helpers"
```

---

## Task 2: Expose `sendText` imperative handle from Terminal

**Files:**
- Modify: `web/src/components/Terminal.tsx`

This task refactors `Terminal` to be a `forwardRef` component that exposes
`sendText`. The send logic is extracted into a single `sendData` closure stored
in a ref so both the keystroke path and the imperative handle reuse it.

- [ ] **Step 1: Add imports and the handle type**

In `web/src/components/Terminal.tsx`, update the React import on line 1 and add the handle interface near the other exported interface.

Change line 1 from:

```ts
import { useEffect, useRef, useCallback } from 'react';
```

to:

```ts
import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
```

Add this interface immediately before `export interface TerminalProps {` (currently line 31):

```ts
/** Imperative methods exposed by the Terminal component via ref. */
export interface TerminalHandle {
  /**
   * Send text to the attached session as if typed. Works in both P2P and
   * relay modes. No-op if the underlying connection is not open.
   */
  sendText: (text: string) => void;
}
```

- [ ] **Step 2: Convert the component to forwardRef**

Replace the function declaration (currently `export function Terminal({ ... }: TerminalProps) {` through its destructured params, lines 57-66) with a `forwardRef` wrapper.

Change:

```ts
export function Terminal({
  sessionId,
  sessionName,
  mode,
  agentUrl,
  connectionToken,
  serverConnection,
  onDisconnect,
  onError,
}: TerminalProps) {
```

to:

```ts
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  {
    sessionId,
    sessionName,
    mode,
    agentUrl,
    connectionToken,
    serverConnection,
    onDisconnect,
    onError,
  },
  ref,
) {
```

- [ ] **Step 3: Add the sendData ref and the imperative handle**

Immediately after the `containerRef` declaration (currently line 67: `const containerRef = useRef<HTMLDivElement>(null);`), add:

```ts
  // Holds the live "send text to remote" closure, assigned inside the connection
  // effect once the transport is established. Lets the imperative handle (and the
  // keystroke path) reuse one mode-aware sender. Null when not connected.
  const sendDataRef = useRef<((data: string) => void) | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      sendText: (text: string) => {
        sendDataRef.current?.(text);
      },
    }),
    [],
  );
```

- [ ] **Step 4: Define sendData inside the effect (P2P + relay)**

Inside the main `useEffect`, after the `sendResize` function definition (the block ending at line 170, just before the section-2 comment), add a `sendData` closure that mirrors the existing keystroke transport for both modes:

```ts
    /**
     * Send raw text to the remote session using whichever transport is active.
     * P2P: terminal.input with base64 data + session_name.
     * Relay: serverConnection.sendTerminalInput(sessionId, data).
     * No-op if the connection is not open.
     */
    const sendData = (data: string) => {
      if (!active) return;
      try {
        if (mode === 'p2p') {
          if (p2pWs?.readyState === WebSocket.OPEN) {
            p2pWs.send(
              JSON.stringify({
                msg_type: 'terminal.input',
                id: generateId(),
                timestamp: Math.floor(Date.now() / 1000),
                payload: { session_name: sessionName, data: encodeB64(data) },
              }),
            );
          }
        } else if (serverConnection?.isConnected()) {
          serverConnection.sendTerminalInput(sessionId, data);
        }
      } catch (err) {
        reportError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    // Expose the sender to the imperative handle for the lifetime of this effect.
    sendDataRef.current = sendData;
```

- [ ] **Step 5: Route the keystroke path through sendData**

Two places currently send keystrokes; point both at `sendData`.

(a) Relay-mode `term.onData` handler (currently lines 310-319). Replace:

```ts
      relayInputDisposable = term.onData((data) => {
        if (!active) return;
        try {
          if (serverConnection?.isConnected()) {
            serverConnection.sendTerminalInput(sessionId, data);
          }
        } catch (err) {
          reportError(err instanceof Error ? err : new Error(String(err)));
        }
      });
```

with:

```ts
      relayInputDisposable = term.onData((data) => {
        sendData(data);
      });
```

(b) The P2P `dataDisposable` handler (currently lines 346-359). Replace:

```ts
    dataDisposable = term.onData((data) => {
      if (!active) return;
      if (mode === 'p2p' && p2pWs?.readyState === WebSocket.OPEN) {
        p2pWs.send(
          JSON.stringify({
            msg_type: 'terminal.input',
            id: generateId(),
            timestamp: Math.floor(Date.now() / 1000),
            payload: { session_name: sessionName, data: encodeB64(data) },
          })
        );
      }
      // Relay mode onData is already wired up separately above.
    });
```

with:

```ts
    dataDisposable = term.onData((data) => {
      // Relay mode is wired separately above; only forward P2P keystrokes here.
      if (mode === 'p2p') {
        sendData(data);
      }
    });
```

- [ ] **Step 6: Clear sendDataRef on cleanup**

In the effect's cleanup function, after `active = false;` (currently line 386), add:

```ts
      sendDataRef.current = null;
```

- [ ] **Step 7: Close the forwardRef wrapper**

The component currently ends with:

```ts
  return (
    <div className="nession-terminal">
      <div ref={containerRef} className="nession-terminal-container" />
    </div>
  );
}
```

Change the final `}` to `});` to close the `forwardRef(function Terminal(...))` call:

```ts
  return (
    <div className="nession-terminal">
      <div ref={containerRef} className="nession-terminal-container" />
    </div>
  );
});
```

- [ ] **Step 8: Verify it compiles**

Run: `cd web && npm run build`
Expected: build succeeds. (`Terminal` is still used by `Dashboard.tsx` exactly as before — it's a named export, and adding a ref is backward compatible.)

- [ ] **Step 9: Verify lint is clean**

Run: `cd web && npm run lint`
Expected: no errors. Note: the effect dependency list is unchanged and still has the existing `eslint-disable-next-line react-hooks/exhaustive-deps`.

- [ ] **Step 10: Commit**

```bash
git add web/src/components/Terminal.tsx
git commit -m "feat(web): expose sendText imperative handle from Terminal"
```

---

## Task 3: ControlPanel component + styles

**Files:**
- Create: `web/src/components/ControlPanel.tsx`
- Create: `web/src/components/ControlPanel.css`

- [ ] **Step 1: Create ControlPanel.css**

Create `web/src/components/ControlPanel.css`:

```css
/* Control panel sidebar for the terminal view.
 * Fixed-width column to the right of the terminal: a scrollable quick-command
 * list on top, a free-text input pinned at the bottom. Catppuccin-ish palette
 * to match the terminal theme. */

.control-panel {
  display: flex;
  flex-direction: column;
  width: 240px;
  flex: none;
  height: 100%;
  background-color: #181825;
  border-left: 1px solid rgba(255, 255, 255, 0.08);
  color: #cdd6f4;
  overflow: hidden;
}

.control-panel-section-title {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #9399b2;
  padding: 0.6rem 0.75rem 0.3rem;
  margin: 0;
}

/* ── Quick commands ──────────────────────────────────────────────── */

.control-panel-commands {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 0.5rem;
}

.control-panel-command-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-bottom: 0.3rem;
}

.control-panel-command-btn {
  flex: 1;
  text-align: left;
  padding: 0.4rem 0.55rem;
  font-size: 0.82rem;
  font-family: 'JetBrains Mono', Menlo, Monaco, monospace;
  background-color: #1e1e2e;
  color: #cdd6f4;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.control-panel-command-btn:hover {
  background-color: #313244;
  border-color: rgba(255, 255, 255, 0.25);
}

.control-panel-delete-btn {
  flex: none;
  width: 1.4rem;
  height: 1.4rem;
  line-height: 1;
  font-size: 0.9rem;
  background: transparent;
  color: #6c7086;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.control-panel-delete-btn:hover {
  color: #f38ba8;
  background-color: rgba(243, 139, 168, 0.12);
}

/* ── Add-command form ────────────────────────────────────────────── */

.control-panel-add-btn {
  width: 100%;
  padding: 0.4rem;
  margin: 0.2rem 0 0.4rem;
  font-size: 0.8rem;
  background-color: transparent;
  color: #89b4fa;
  border: 1px dashed rgba(137, 180, 250, 0.4);
  border-radius: 5px;
  cursor: pointer;
}

.control-panel-add-btn:hover {
  background-color: rgba(137, 180, 250, 0.1);
}

.control-panel-add-form {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.4rem 0;
}

.control-panel-add-form input {
  padding: 0.35rem 0.5rem;
  font-size: 0.8rem;
  background-color: #1e1e2e;
  color: #cdd6f4;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
}

.control-panel-add-form-actions {
  display: flex;
  gap: 0.3rem;
}

.control-panel-add-form-actions button {
  flex: 1;
  padding: 0.35rem;
  font-size: 0.78rem;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
  background-color: #313244;
  color: #cdd6f4;
}

.control-panel-add-form-actions button.primary {
  background-color: #89b4fa;
  color: #11111b;
  border-color: #89b4fa;
}

/* ── Free input ──────────────────────────────────────────────────── */

.control-panel-input-area {
  flex: none;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.control-panel-input-area textarea {
  resize: none;
  padding: 0.45rem 0.55rem;
  font-size: 0.82rem;
  font-family: 'JetBrains Mono', Menlo, Monaco, monospace;
  background-color: #1e1e2e;
  color: #cdd6f4;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 5px;
}

.control-panel-send-btn {
  padding: 0.45rem;
  font-size: 0.85rem;
  font-weight: 600;
  background-color: #a6e3a1;
  color: #11111b;
  border: none;
  border-radius: 5px;
  cursor: pointer;
}

.control-panel-send-btn:hover {
  background-color: #94d68f;
}

/* ── Responsive: drop below the terminal on narrow screens ───────── */

@media (max-width: 768px) {
  .control-panel {
    width: 100%;
    height: auto;
    max-height: 45%;
    border-left: none;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
}
```

- [ ] **Step 2: Create ControlPanel.tsx**

Create `web/src/components/ControlPanel.tsx`:

```tsx
import { useState } from 'react';
import {
  PRESETS,
  loadUserCommands,
  saveUserCommands,
  type QuickCommand,
} from './quickCommands';
import './ControlPanel.css';

export interface ControlPanelProps {
  /** Send text to the attached terminal session. */
  sendText: (text: string) => void;
}

/**
 * Sidebar with one-click quick commands (presets + user-added) and a free-text
 * input box. Quick commands auto-execute (append "\r") unless flagged `raw`.
 * The free-text box appends "\r" on send so the command runs.
 */
export function ControlPanel({ sendText }: ControlPanelProps) {
  const [userCommands, setUserCommands] = useState<QuickCommand[]>(() => loadUserCommands());
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [inputValue, setInputValue] = useState('');

  const runCommand = (cmd: QuickCommand) => {
    sendText(cmd.raw ? cmd.command : cmd.command + '\r');
  };

  const deleteUserCommand = (id: string) => {
    const next = userCommands.filter((c) => c.id !== id);
    setUserCommands(next);
    saveUserCommands(next);
  };

  const addUserCommand = () => {
    const label = newLabel.trim();
    const command = newCommand.trim();
    if (!label || !command) return;
    const next = [...userCommands, { id: `user-${Date.now()}`, label, command }];
    setUserCommands(next);
    saveUserCommands(next);
    setNewLabel('');
    setNewCommand('');
    setShowAddForm(false);
  };

  const sendInput = () => {
    const text = inputValue.trim();
    if (!text) return;
    sendText(text + '\r');
    setInputValue('');
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendInput();
    }
  };

  return (
    <aside className="control-panel">
      <h3 className="control-panel-section-title">Quick Commands</h3>
      <div className="control-panel-commands">
        {PRESETS.map((cmd) => (
          <div className="control-panel-command-row" key={cmd.id}>
            <button className="control-panel-command-btn" onClick={() => runCommand(cmd)}>
              {cmd.label}
            </button>
          </div>
        ))}
        {userCommands.map((cmd) => (
          <div className="control-panel-command-row" key={cmd.id}>
            <button className="control-panel-command-btn" onClick={() => runCommand(cmd)}>
              {cmd.label}
            </button>
            <button
              className="control-panel-delete-btn"
              onClick={() => deleteUserCommand(cmd.id)}
              title="Delete command"
            >
              &times;
            </button>
          </div>
        ))}

        {showAddForm ? (
          <div className="control-panel-add-form">
            <input
              type="text"
              placeholder="Label"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
            <input
              type="text"
              placeholder="Command"
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
            />
            <div className="control-panel-add-form-actions">
              <button onClick={() => setShowAddForm(false)}>Cancel</button>
              <button className="primary" onClick={addUserCommand}>
                Add
              </button>
            </div>
          </div>
        ) : (
          <button className="control-panel-add-btn" onClick={() => setShowAddForm(true)}>
            + Add command
          </button>
        )}
      </div>

      <div className="control-panel-input-area">
        <textarea
          rows={2}
          placeholder="Type text to send… (Enter to send, Shift+Enter for newline)"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleInputKeyDown}
        />
        <button className="control-panel-send-btn" onClick={sendInput}>
          Send
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd web && npm run build`
Expected: build succeeds. (`ControlPanel` is not yet rendered anywhere — that's Task 4 — but it must type-check.)

- [ ] **Step 4: Verify lint is clean**

Run: `cd web && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ControlPanel.tsx web/src/components/ControlPanel.css
git commit -m "feat(web): add ControlPanel sidebar component"
```

---

## Task 4: Wire ControlPanel into TerminalView + layout

**Files:**
- Modify: `web/src/components/Dashboard.tsx`
- Modify: `web/src/components/Dashboard.css`

- [ ] **Step 1: Add imports**

In `web/src/components/Dashboard.tsx`, update the React import (line 1) and add the new imports.

Change line 1 from:

```ts
import { useState, useEffect, useCallback } from 'react';
```

to:

```ts
import { useState, useEffect, useCallback, useRef } from 'react';
```

Change the Terminal import (line 4) from:

```ts
import { Terminal } from './Terminal';
```

to:

```ts
import { Terminal, type TerminalHandle } from './Terminal';
import { ControlPanel } from './ControlPanel';
```

- [ ] **Step 2: Hold the ref and render ControlPanel in TerminalView**

Replace the entire `TerminalView` function (currently lines 361-390) with:

```tsx
function TerminalView({ session, wsService, onBack, onDisconnect, onError }: TerminalViewProps) {
  const { attachInfo, sessionId, sessionName } = session;
  const isP2P = attachInfo.mode === 'p2p';
  const terminalRef = useRef<TerminalHandle>(null);

  return (
    <div className="terminal-view">
      <header className="terminal-view-header">
        <button className="btn-back" onClick={onBack}>
          &larr; Back to Dashboard
        </button>
        <span className="terminal-view-title">
          Session: <strong>{sessionName}</strong>
          <span className={`mode-badge mode-${attachInfo.mode}`}>{attachInfo.mode.toUpperCase()}</span>
        </span>
      </header>
      <div className="terminal-view-body">
        <Terminal
          ref={terminalRef}
          sessionId={sessionId}
          sessionName={sessionName}
          mode={attachInfo.mode}
          agentUrl={isP2P ? `ws://${attachInfo.agent_address}/ws` : undefined}
          connectionToken={isP2P ? attachInfo.connection_token : undefined}
          serverConnection={!isP2P ? wsService : undefined}
          onDisconnect={onDisconnect}
          onError={onError}
        />
        <ControlPanel sendText={(text) => terminalRef.current?.sendText(text)} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Make the terminal body a flex row**

In `web/src/components/Dashboard.css`, replace the `.terminal-view-body` rule (currently lines 393-397):

```css
.terminal-view-body {
  min-height: 0;
  padding: 0;  /* Remove padding so terminal fills completely */
  overflow: hidden;
}
```

with:

```css
.terminal-view-body {
  min-height: 0;
  padding: 0;  /* Remove padding so terminal fills completely */
  overflow: hidden;
  display: flex;
  flex-direction: row;
}

/* The Terminal wrapper fills the space left of the control panel. */
.terminal-view-body .nession-terminal {
  flex: 1;
  min-width: 0;
}

/* Responsive: stack the control panel below the terminal on narrow screens. */
@media (max-width: 768px) {
  .terminal-view-body {
    flex-direction: column;
  }
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd web && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Verify lint is clean**

Run: `cd web && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Dashboard.tsx web/src/components/Dashboard.css
git commit -m "feat(web): render control panel beside terminal"
```

---

## Task 5: Manual smoke test

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

Run: `cd web && npm run dev`
Open the printed local URL, connect with a valid token + server URL, and attach to a session.

- [ ] **Step 2: Verify quick commands execute**

Click `ls -la`. Expected: the command appears in the terminal AND executes (output shown) — confirming the trailing `\r`. Click `clear`; the screen clears.

- [ ] **Step 3: Verify Ctrl+C (raw) works**

Start a long-running command (e.g. `sleep 30`), then click `Ctrl+C`. Expected: the command is interrupted (no extra blank line from a stray `\r`).

- [ ] **Step 4: Verify free input**

Type `echo hello` in the textarea, press Enter (or click Send). Expected: `hello` printed, textarea clears. Type a line, press Shift+Enter. Expected: a newline is inserted, nothing sent.

- [ ] **Step 5: Verify add / delete / persistence**

Click `+ Add command`, add label `whoami` / command `whoami`, click Add. Click it — it runs. Reload the page and re-attach — the `whoami` button is still present (loaded from localStorage). Click its `×` — it disappears; reload to confirm it stays gone.

- [ ] **Step 6: Verify both modes (if available)**

Repeat steps 2 and 4 for a P2P session and a relay session if both are reachable, confirming `sendText` works in each.

- [ ] **Step 7: Verify responsive layout**

Narrow the window below 768px. Expected: the control panel moves below the terminal; both remain usable.

---

## Self-Review Notes

- **Spec coverage:** quick commands preset+user (Task 1, 3), persistence (Task 1, 3), free input + send (Task 3), auto-execute `\r` (Task 3), `raw` control-key flag (Task 1, 3), `sendText` seam reusing P2P/relay transport (Task 2), right sidebar + responsive (Task 3, 4), error/no-op guards (Task 2 `sendData`, Task 1 localStorage try/catch). All spec sections map to tasks.
- **Verification path:** adapted to project reality (no JS test runner) — build + lint + manual smoke per the spec's Testing section.
- **Type consistency:** `TerminalHandle.sendText`, `QuickCommand { id,label,command,raw? }`, `loadUserCommands`/`saveUserCommands`, `ControlPanelProps.sendText` are used identically across tasks.
