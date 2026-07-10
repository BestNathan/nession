# xterm.js Frontend Architecture Refactoring

**Date:** 2026-07-10
**Status:** approved

## Goal

Refactor the monolithic `Terminal.tsx` (728 lines) into a class-based manager architecture
that separates xterm.js rendering, input, viewport, theme, addon, and connection concerns
into independently testable modules. The refactoring also formalizes a responsive strategy
where the terminal adapts to PC/tablet/phone viewports via font scaling, without resizing
the remote PTY.

## Background

The current `web/src/components/Terminal.tsx` is a single `forwardRef` component that
handles everything inside one large `useEffect`:

- xterm.js Terminal creation and disposal
- CanvasAddon + FitAddon registration
- P2P and relay dual-mode keyboard input forwarding
- Window resize → fitAddon.fit() + font scaling
- Mouse tracking event throttling (16ms)
- Scroll wheel interception → viewport scrollback
- Keepalive pings (30s interval, P2P mode)
- Reconnection banner state machine
- Imperative handle (sendText, refit)

This design was organic and functional, but has reached a complexity threshold where:
1. No part of the terminal logic is unit-testable without mounting a full React tree.
2. Changes to one concern (e.g., reconnection behavior) risk breaking unrelated concerns
   (e.g., font scaling) because they share the same effect closure.
3. The tight coupling between input handling and WebSocket modes makes it hard to add
   new connection modes or change the protocol.

A prior design spec (2026-07-09) already decoupled terminal resize events from tmux —
the web client no longer sends `cols × rows` to the agent. This refactoring builds on
that decoupling by formalizing the client-side resize strategy.

## Architecture Overview

### Module Tree

```
terminal/
├── index.ts                     # Re-export TerminalView
├── types.ts                     # Shared types
├── DeviceProfile.ts             # Device profile presets
├── TerminalView.ts              # Entry point — owns all managers
├── Renderer.ts                  # Canvas/WebGL backend selection
├── ThemeManager.ts              # Theme loading, switching, presets
├── ViewportManager.ts           # ResizeObserver → fit + font scaling + scroll
├── InputManager.ts              # Keyboard/mouse/IME event classification
├── ConnectionManager.ts         # P2P/relay send, keepalive, reconnection state
├── AddonManager.ts              # Centralized addon registration
└── __tests__/
    ├── Renderer.test.ts
    ├── ThemeManager.test.ts
    ├── ViewportManager.test.ts
    ├── InputManager.test.ts
    ├── ConnectionManager.test.ts
    ├── AddonManager.test.ts
    └── TerminalView.test.ts
```

### Module Dependency Graph

```text
                    TerminalView
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   ConnectionManager  ViewportManager  InputManager
        │                │                │
        │           ThemeManager          │
        │                │                │
        └────────────────┼────────────────┘
                         │
                   AddonManager
                         │
                      Renderer
                         │
                      xterm.js
```

- `TerminalView` is the sole entry point — React components only interact with it.
- Each manager receives the `Terminal` instance via constructor; managers do not hold
  references to each other.
- Cross-manager communication is mediated by `TerminalView` (e.g., `InputManager.onData`
  → `ConnectionManager.send` is wired in the TerminalView constructor).
- Only `ConnectionManager` has knowledge of WebSocket / P2P protocol details.
- `InputManager` classifies events but does not know where the data goes.

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Manager communication | TerminalView as mediator | Avoid circular dependencies between managers |
| xterm ownership | TerminalView creates, passes to managers | Single ownership, clear lifecycle |
| React integration | TerminalView instantiated in useEffect | React component stays a thin shell |
| ViewportManager | Merges Layout + Viewport + Scroll | These concerns share ResizeObserver and font state; splitting causes circular calls |
| ConnectionManager | New module (not in original proposal) | Current keepalive, reconnect, and dual-mode routing span ~200 lines — needs a home |
| Decode base64 | ConnectionManager (not TerminalView) | Only ConnectionManager knows the protocol wire format |

## Module Specifications

### 1. TerminalView (Entry Point + Coordinator)

Responsibility: lifecycle management, xterm creation, manager wiring, unified public API.

```ts
class TerminalView {
  // Public
  readonly terminal: Terminal;
  sendText(text: string): void;
  refit(): void;
  dispose(): void;
  onStateChange: ((state: TerminalViewState) => void) | null;
  onCtrlD: (() => void) | null;
  onError: ((error: Error) => void) | null;
  onDisconnect: (() => void) | null;

  // Internal
  private renderer: Renderer;
  private theme: ThemeManager;
  private viewport: ViewportManager;
  private input: InputManager;
  private connection: ConnectionManager;
  private addons: AddonManager;
}

interface TerminalViewState {
  banner: 'none' | 'reconnecting' | 'failed';
  reconnectAttempt: number;
  isConnected: boolean;
}
```

Dependencies: all managers.

### 2. Renderer

Responsibility: select rendering backend (Canvas or WebGL), prefer WebGL with Canvas
fallback.

```ts
class Renderer {
  constructor(term: Terminal, preferred?: 'webgl' | 'canvas');
  readonly type: 'webgl' | 'canvas';
}
```

Theme is NOT handled here — that is ThemeManager's responsibility.

### 3. ThemeManager

Responsibility: apply, switch, and reset terminal themes. Catppuccin Mocha is the
built-in default.

```ts
class ThemeManager {
  constructor(term: Terminal, theme?: ITheme);
  setTheme(theme: Partial<ITheme>): void;
  resetToDefault(): void;
  getTheme(): ITheme;
}
```

### 4. ViewportManager

Responsibility: observe container size changes, fit the terminal to the container,
apply font scaling for narrow viewports, intercept scroll wheel for viewport scrollback.
Merges the original proposal's LayoutManager + ViewportManager.

```ts
class ViewportManager {
  constructor(term: Terminal, fitAddon: FitAddon, profile?: DeviceProfile);

  fit(): void;
  updateProfile(profile: DeviceProfile): void;
  setTargetColumns(cols: number): void;
  dispose(): void;
}
```

Internal behavior:
- Uses `ResizeObserver` on the container element (not `window.resize`), so it works
  correctly when the terminal is in a split pane or resizable panel.
- Font scaling: when `term.cols < TARGET_COLS` (default 80), proportionally shrinks
  font down to a minimum of 10px, with double-rAF for reliable browser reflow.
- Scroll wheel: intercepts wheel events on the xterm element in capture phase,
  scrolling the terminal's scrollback buffer instead of forwarding to the PTY.
- Does NOT call `terminal.resize(cols, rows)` — the PTY dimensions are never changed.
- Device profile detection: container width < 640px → phone, < 1024px → tablet,
  else desktop. Uses container width, not window width.

### 5. InputManager

Responsibility: listen to xterm `onData` events, classify input (keyboard vs mouse
tracking vs Ctrl+D), apply throttling to mouse events, expose callbacks.

```ts
type DataCallback = (data: string) => void;
type CtrlDCallback = () => void;

class InputManager {
  constructor(term: Terminal);
  onData(cb: DataCallback): void;
  onCtrlD(cb: CtrlDCallback): void;
  dispose(): void;
}
```

Internal behavior:
- SGR mouse tracking sequences (`\x1b[<…`) and normal mouse tracking (`\x1b[M…`)
  are throttled to 60 fps (16ms, leading + trailing).
- Keyboard and other escape sequences pass through immediately with zero added latency.
- Ctrl+D (`\x04`) is intercepted and routed to `onCtrlD` callback instead of `onData`.
- InputManager has zero knowledge of WebSocket, P2P, relay, or any connection details.

### 6. ConnectionManager

Responsibility: P2P/relay dual-mode data sending, `client.attach` handshake, keepalive
pings (30s), reconnection state machine. This is the ONLY manager that knows about
WebSocket connections.

```ts
interface ConnectionOptions {
  mode: 'p2p' | 'relay';
  sessionName: string;
  sessionId: string;
  p2pConnection?: P2PConnection;
  serverConnection?: WebSocketService;
}

class ConnectionManager {
  constructor(options: ConnectionOptions);
  send(data: string): void;
  attach(): Promise<void>;

  onStateChange: ((state: ConnectionState, attempt: number) => void) | null;
  onOutput: ((data: string) => void) | null;
  onError: ((error: Error) => void) | null;
  onDisconnect: (() => void) | null;

  dispose(): void;
}

type ConnectionState = 'connected' | 'reconnecting' | 'lost';
```

Key behaviors:
- `send(data)`: routes to P2P `terminal.input` message or relay
  `sendTerminalInput()` based on mode.
- `onOutput`: emits clean terminal output data. For P2P mode, ConnectionManager
  handles base64 decoding internally before calling `onOutput` — consumers always
  receive plain strings.
- P2P binary WebSocket frames are handled directly, not routed through the message
  protocol layer.
- Keepalive: sends `keepalive.ping` every 30s in P2P mode.
- State machine: `connected → reconnecting → connected` (success) or
  `connected → reconnecting → lost → onDisconnect()` (retries exhausted).

Reconnection state machine:
```text
                    ┌─────────────┐
                    │   created   │
                    └──────┬──────┘
                           │ attach()
                    ┌──────▼──────┐
            ┌───────│  connected  │◄────────┐
            │       └──────┬──────┘         │
            │              │ ws close       │ reconnected
            │       ┌──────▼──────┐         │
            │       │ reconnecting│─────────┘
            │       └──────┬──────┘
            │              │ max retries
            │       ┌──────▼──────┐
            │       │    lost     │──→ onDisconnect()
            │       └─────────────┘
            │
            └──── dispose() → cleaned up
```

### 7. AddonManager

Responsibility: centralized addon registration and retrieval.

```ts
class AddonManager {
  constructor(term: Terminal);
  register<T extends ITerminalAddon>(addon: T): T;
  get<T extends ITerminalAddon>(type: new (...args: never[]) => T): T | undefined;
}
```

### 8. DeviceProfile

Responsibility: responsive design presets for different device classes.

```ts
interface DeviceProfile {
  fontSize: number;
  lineHeight: number;
  scrollback: number;
}

const PROFILES: Record<'desktop' | 'tablet' | 'phone', DeviceProfile> = {
  desktop: { fontSize: 14, lineHeight: 1.2, scrollback: 50000 },
  tablet:  { fontSize: 13, lineHeight: 1.2, scrollback: 30000 },
  phone:   { fontSize: 11, lineHeight: 1.1, scrollback: 10000 },
};
```

Breakpoints: container width < 640px → phone, < 1024px → tablet, else desktop.
Uses container width (not window width) to work correctly in split-pane layouts.

## Data Flow

### Input Path (Keyboard → Remote)

```text
Keyboard event
  ↓
xterm.js (hidden textarea)
  ↓ onData(data)
InputManager
  ├─ Ctrl+D? → onCtrlD() callback
  ├─ Mouse tracking? → throttle(16ms) → onData callback
  └─ Normal → immediate → onData callback
  ↓
TerminalView (wiring)
  ↓ connection.send(data)
ConnectionManager
  ├─ P2P mode → p2pConnection.sendMessage({ msg_type: 'terminal.input', ... })
  └─ Relay mode → serverConnection.sendTerminalInput(sessionId, data)
  ↓
WebSocket → Agent → PTY → tmux
```

### Output Path (Remote → Screen)

```text
Agent → WebSocket
  ↓
ConnectionManager
  ├─ P2P: parse message → base64 decode → onOutput(decoded)
  └─ Relay: onTerminalOutput → onOutput(data)
  ↓
TerminalView (wiring)
  ↓ term.write(data)
xterm.js → Canvas/WebGL → Screen
```

Base64 decoding is handled inside ConnectionManager. Consumers of `onOutput` always
receive plain decoded strings.

### Resize Path (Container → Viewport)

```text
ResizeObserver fires (container size change)
  ↓
ViewportManager.resize()
  ├─ fitAddon.fit()
  ├─ detectProfile() → update fontSize if device class changed
  ├─ scaleFont() if cols < TARGET_COLS
  └─ Does NOT call terminal.resize(cols, rows)
```

## React Integration

### New Terminal.tsx (~100 lines)

The React component becomes a thin shell:

```tsx
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(
  function Terminal(props, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<TerminalView | null>(null);
    const [banner, setBanner] = useState<ReconnectBanner>('none');
    const [reconnectAttempt, setReconnectAttempt] = useState(0);

    // Create/dispose TerminalView — only rebuild on session/mode change
    useEffect(() => {
      const view = new TerminalView(containerRef.current!, {
        rendererType: 'webgl',
        connection: { mode: props.mode, ... },
      });
      view.onStateChange = (state) => {
        setBanner(state.banner);
        setReconnectAttempt(state.reconnectAttempt);
      };
      viewRef.current = view;
      return () => { view.dispose(); viewRef.current = null; };
    }, [props.sessionId, props.sessionName, props.mode,
        props.p2pConnection, props.serverConnection]);

    useImperativeHandle(ref, () => ({
      sendText: (text) => viewRef.current?.sendText(text),
      refit: () => viewRef.current?.refit(),
    }), []);

    return (
      <div className="flex-1 min-w-0 min-h-0 relative">
        {banner !== 'none' && <BannerOverlay ... />}
        <div ref={containerRef} className="h-full w-full" />
      </div>
    );
  }
);
```

### What Stays in React vs Moves to TerminalView

| Stays in React (Terminal.tsx) | Moves to TerminalView/Managers |
|-------------------------------|-------------------------------|
| DOM container ref | xterm instance creation |
| Banner UI (React-rendered) | Reconnection logic + state machine |
| `useImperativeHandle` | sendText / refit implementation |
| `onCtrlD` callback (navigation) | Ctrl+D detection (InputManager) |
| `onBannerChange` / `onDisconnect` / `onError` notification | All protocol-layer logic |
| TerminalView creation/disposal | Addon registration |
| | Theme management |
| | Font scaling + viewport control |
| | Keepalive pings |
| | Mouse tracking throttle |
| | Scroll wheel interception |

### TerminalView Rebuild Triggers

TerminalView is rebuilt only when session identity or connection mode changes:
`[sessionId, sessionName, mode, p2pConnection, serverConnection]`

P2P connectionState transitions (connecting → connected → reconnecting) do NOT trigger
a rebuild — `ConnectionManager` handles these internally.

## State Management

### State Layering

```text
React layer — UI state only
  banner: 'none' | 'reconnecting' | 'failed'
  reconnectAttempt: number
  → drives Banner UI rendering
       ↕ onStateChange callback
TerminalView layer — lifecycle state
  isDisposed: boolean
  → guards against post-dispose operations
       ↕ delegates
ConnectionManager layer — connection state machine
  connectionState: connected | reconnecting | lost
  reconnectAttempt: number
  → drives keepalive + reconnection
```

Principles:
- React only holds state needed for rendering UI (banner text, retry count).
- `ConnectionManager` owns the connection state machine, notifies React via callbacks.
- `TerminalView` does not store `cols`, `rows`, `fontSize`, or `selection` — these are
  xterm internal state, accessible via `term.options` and `term.cols` as needed.
- The `TerminalState` interface from the original proposal (fontSize, theme, scrollTop,
  selection, focused) is deferred to v2. Currently there is no consumer that needs a
  snapshot of all terminal state. It would be valuable for state persistence/restore
  (e.g., restoring font size after page refresh).

## Error Handling

| Error Type | Handler | Behavior |
|------------|---------|----------|
| WebSocket disconnect | ConnectionManager | Auto-reconnect, notify React → banner |
| Retries exhausted | ConnectionManager | State → lost, 3s delay, onDisconnect() |
| client.attach failure | ConnectionManager | onError → React → toast |
| xterm write after dispose | TerminalView | Swallow (handler unregistered at dispose) |
| fit() on zero-size container | ViewportManager | try/catch, swallow |
| WebGL unavailable | Renderer | Auto-fallback to Canvas, log warning |

## Responsive Strategy

### Core Principle

**xterm.js is a View, not a Terminal.** It renders terminal content without dictating
terminal dimensions. The PTY is never resized by the web client.

### Device Profiles

```ts
desktop: fontSize=14, lineHeight=1.2, scrollback=50000
tablet:  fontSize=13, lineHeight=1.2, scrollback=30000
phone:   fontSize=11, lineHeight=1.1, scrollback=10000
```

Breakpoints based on container width: < 640px phone, < 1024px tablet, else desktop.

### Resize Strategy

When the container shrinks:
1. `fitAddon.fit()` fills available space
2. If `term.cols < TARGET_COLS (80)`, font size is proportionally reduced (min 10px)
3. If cols remain below a readable minimum, the xterm buffer's natural horizontal
   scroll handles overflow

When the container grows:
1. Font is restored toward the profile default (max 14px)
2. `fitAddon.fit()` recalculates

The PTY dimensions are never changed. The `proposeDimensions` mechanism from the
original proposal is deferred to v2 — currently there is no consumer that needs
dimension suggestions.

## Migration Plan

### Step 1: Skeleton — new modules, no behavior change (PR #1)

- Create `terminal/` directory
- Implement AddonManager, Renderer, ThemeManager (no external dependencies)
- Implement DeviceProfile + types.ts
- Unit tests for these modules
- Old Terminal.tsx unchanged

### Step 2: Core modules — all managers implemented (PR #2)

- Implement InputManager, ViewportManager, ConnectionManager
- Implement TerminalView (assembles all managers)
- Unit tests + integration tests
- Old Terminal.tsx still unchanged and functional

### Step 3: Switch — replace Terminal.tsx (PR #3)

- Rewrite Terminal.tsx as thin shell component (~100 lines)
- TerminalView.tsx adapts to new Terminal's unchanged props interface
- Delete inlined logic from old Terminal.tsx
- Playwright screenshots to verify: login, attach, terminal rendering, reconnection
  banner, font scaling on narrow viewports

### Step 4: Cleanup

- Verify no leftover inlined logic
- Remove unused dependencies if any

### Rollback Strategy

If Step 3 has issues: `git revert` a single PR. Steps 1-2 are additive and have no
effect on the running application.

## Non-Goals

- Changing the agent/server protocol or PTY resize behavior (already done in
  2026-07-09 spec).
- Adding WebGL renderer support (architecture supports it via Renderer, but Canvas
  remains the default until WebGL is validated).
- SearchAddon / SerializeAddon / UnicodeAddon integration — the architecture supports
  adding them via AddonManager, but they are not part of this refactoring.
- Terminal state persistence/snapshot (TerminalState interface deferred to v2).
- `proposeDimensions` mechanism (deferred to v2 — no consumer exists yet).

## Core Principle

**xterm.js is a View, not a Terminal.** It renders terminal content. It does not decide
terminal size, lifecycle, or backend connectivity. This separation ensures consistent
frontend behavior regardless of whether the backend is SSH, local shell, Docker, or
Kubernetes.
