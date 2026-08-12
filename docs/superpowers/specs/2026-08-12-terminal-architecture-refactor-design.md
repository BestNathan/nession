# Terminal Architecture Refactor Design

**Date:** 2026-08-12  
**Branch:** `staging` → will branch `feat/terminal-arch-refactor`  
**Scope:** Restructure terminal subsystem — Jotai state domains, Controller extraction, Input system, React component tree, directory layout  
**Motivation:** Clean up existing complexity; lay groundwork for future features (command palette, AI input, search, multi-tab)

**Naming note:** The current codebase has two things named `TerminalView`:
- `terminal/TerminalView.ts` — the imperative class that creates xterm and wires managers
- `components/TerminalView.tsx` — the React layout shell with header, P2P driver, and toolbar

After refactoring: the class delegates to `TerminalController`; the React component becomes `TerminalWorkspace`. No more name collision.

---

## 1. Design Principles

1. **Jotai manages "intent and state"; xterm manages "terminal rendering"; they connect via Controller/Adapter.**
2. **High-frequency imperative data → Controller; low-frequency declarative data → Jotai.**
3. **Global state (`atoms/`) stays global; terminal-specific state lives in `terminal/state/`.**
4. **No new features in this refactoring — architecture restructure only. Functionality unchanged.**

---

## 2. Directory Structure

```
terminal/
├── components/              # React components
│   ├── TerminalWorkspace.tsx     # new - top-level layout shell (evolves from TerminalView.tsx)
│   ├── TerminalPane.tsx          # new - single session container
│   ├── TerminalViewport.tsx      # new - pure xterm DOM mount point
│   ├── TerminalToolbar.tsx       # moved from components/
│   ├── TerminalTabs.tsx          # new - stub for future tab support
│   └── input/
│       ├── TerminalInputOverlay.tsx  # new - InputMode switch renderer
│       └── (CommandPalette/Search/AI stubs — future)

├── state/                   # Jotai atoms (6 domains)
│   ├── session.ts               # TerminalSession derived atoms
│   ├── terminal.ts              # Terminal business state (size, focus, selection, title)
│   ├── input.ts                 # InputMode discriminated union, input value
│   ├── ui.ts                    # Banner, overlay visibility
│   ├── layout.ts                # Panel sizes, sidebar
│   └── capability.ts            # Capability flags

├── controller/              # Imperative controllers
│   ├── TerminalController.ts    # Main facade over xterm + transport
│   ├── InputController.ts       # Routes xterm onData → InputRouter
│   ├── ResizeController.ts      # ResizeObserver → debounce → transport + xterm
│   └── SelectionController.ts   # MouseIntentResolver + clipboard

├── input/                   # Input routing system
│   ├── InputRouter.ts           # Mode-based routing
│   ├── InputHandler.ts          # Handler interface
│   ├── TerminalInputHandler.ts  # xterm → PTY (only complete implementation)
│   └── (Command/AI/Custom handlers — stubs, future)

├── runtime/                 # xterm lifecycle
│   ├── TerminalRuntime.ts       # xterm instance creation, addon wiring
│   └── TerminalManager.ts       # Multi-session registry (Map<sessionId, TerminalController>)

├── transport/               # Wire-level transport
│   └── TerminalTransport.ts     # Interface wrapping ConnectionManager

├── DeviceProfile.ts         # unchanged
├── MobileInput.ts           # unchanged
├── MouseIntentResolver.ts   # unchanged
├── AddonManager.ts          # unchanged
├── Renderer.ts              # unchanged
├── ThemeManager.ts          # unchanged
├── FontSizeManager.ts       # unchanged
├── types.ts                 # expanded
└── index.ts                 # updated exports
```

### 2.1 Global vs Terminal State Boundary

```
atoms/ (global, unchanged)              terminal/state/ (terminal-only, new)
─────────────────────────────            ─────────────────────────────────────
sessionIdAtom                            session.ts:
sessionNameAtom                          └─ terminalSessionAtom (derived)
attachInfoAtom                               reads from global atoms,
orderedUrlsAtom                               adds startedAt timestamp
manualOverrideAtom
forcedRelayAtom                         terminal.ts:
rendererAtom                            └─ terminalSizeAtomFamily
envRefsAtom                                 terminalFocusAtomFamily
                                             terminalSelectionAtomFamily
atoms/connection.ts:                         terminalTitleAtomFamily
p2pStateAtom
p2pConnectionAtom                       input.ts:
terminalSessionStateAtom → MOVED        └─ inputModeAtomFamily
activeUrlAtom                               inputValueAtomFamily
effectiveModeAtom
lastResizeAtom → MOVED                  ui.ts:
addressesAtom                           └─ bannerAtomFamily
agentIdAtom                                 bannerAttemptAtomFamily
hasActiveSessionAtom
attachToSessionAtom                     layout.ts:
disconnectAtom                          └─ sidebarOpenAtom
switchAddressAtom                           panelSizesAtom
atoms/probe.ts:                         capability.ts:
probeResultsAtom                        └─ capabilitiesAtomFamily
```

**Rules:**
- `atoms/` stays as the global data source. Dashboard writes `sessionIdAtom`; Terminal reads it.
- `terminal/state/` contains ONLY terminal-internal state: either derived from global atoms, or terminal-only UI state.
- `terminal/state/` never re-defines `sessionIdAtom` or `sessionNameAtom`; it reads them via `atom((get) => ...)`.

---

## 3. Types

### 3.1 TerminalSession

The local terminal connection instance — distinct from the backend `Session` concept.

```ts
type TerminalStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'attached'
  | 'reconnecting'
  | 'failed';

interface TerminalSession {
  id: string;            // = global sessionIdAtom value
  name: string;          // = global sessionNameAtom value
  status: TerminalStatus;
  mode: 'p2p' | 'relay';
  startedAt: number;     // Date.now() when attach was initiated
}
```

### 3.2 InputMode (Discriminated Union)

```ts
type InputMode =
  | { type: 'terminal' }
  | { type: 'command' }
  | { type: 'search' }
  | { type: 'ai' }
  | { type: 'custom'; id: string };
```

### 3.3 TerminalCapabilities

```ts
interface TerminalCapabilities {
  clipboard: boolean;
  search: boolean;
  customInput: boolean;
  aiInput: boolean;
  commandPalette: boolean;
  mouse: boolean;
  resize: boolean;
}
```

---

## 4. Jotai State Domains

### 4.1 `terminal/state/session.ts`

```ts
export const terminalSessionAtom = atom<TerminalSession | null>((get) => {
  const id = get(sessionIdAtom);
  if (!id) return null;
  return {
    id,
    name: get(sessionNameAtom),
    status: get(terminalSessionStateAtom),
    mode: get(effectiveModeAtom),
    startedAt: Date.now(), // set once at creation; use a writable atom in practice
  };
});
```

### 4.2 `terminal/state/terminal.ts`

Only low-frequency declarative state. High-frequency resize goes through Controller, not React re-renders.

```ts
export const terminalSizeAtomFamily = atomFamily((_sessionId: string) =>
  atom<{ cols: number; rows: number }>({ cols: 80, rows: 24 })
);

export const terminalFocusAtomFamily = atomFamily((_sessionId: string) =>
  atom<boolean>(false)
);

export const terminalSelectionAtomFamily = atomFamily((_sessionId: string) =>
  atom<string>('')
);

export const terminalTitleAtomFamily = atomFamily((_sessionId: string) =>
  atom<string>('')
);
```

### 4.3 `terminal/state/input.ts`

```ts
export const inputModeAtomFamily = atomFamily((_sessionId: string) =>
  atom<InputMode>({ type: 'terminal' })
);

export const inputValueAtomFamily = atomFamily((_sessionId: string) =>
  atom<string>('')
);
```

### 4.4 `terminal/state/ui.ts`

```ts
export const bannerAtomFamily = atomFamily((_sessionId: string) =>
  atom<ReconnectBanner>('none')
);

export const bannerAttemptAtomFamily = atomFamily((_sessionId: string) =>
  atom<number>(0)
);
```

### 4.5 `terminal/state/layout.ts`

```ts
export const sidebarOpenAtom = atom<boolean>(false);
export const panelSizesAtom = atom<number[]>([70, 30]);
```

### 4.6 `terminal/state/capability.ts`

All static (hardcoded) for now; future: negotiate with agent.

```ts
export const capabilitiesAtomFamily = atomFamily((_sessionId: string) =>
  atom<TerminalCapabilities>({
    clipboard: true,
    search: false,
    customInput: false,
    aiInput: false,
    commandPalette: false,
    mouse: true,
    resize: true,
  })
);
```

### 4.7 ViewModel Pattern

Derived atom that aggregates terminal state for React consumption. Components read ONE atom instead of many.

```ts
export const terminalViewModelAtomFamily = atomFamily((sessionId: string) =>
  atom((get) => ({
    session: get(terminalSessionAtom),
    size: get(terminalSizeAtomFamily(sessionId)),
    mode: get(inputModeAtomFamily(sessionId)),
    focused: get(terminalFocusAtomFamily(sessionId)),
    capabilities: get(capabilitiesAtomFamily(sessionId)),
    banner: get(bannerAtomFamily(sessionId)),
  }))
);
```

---

## 5. TerminalController

Extracted from the 295-line `TerminalView` god class. `TerminalView` currently owns all managers directly; `TerminalController` becomes the facade React interacts with.

### 5.1 Interface

```ts
class TerminalController {
  constructor(session: TerminalSession, transport: TerminalTransport);

  // Lifecycle
  attach(element: HTMLElement): void;
  detach(): void;

  // Data flow
  write(data: string | Uint8Array): void;  // write to xterm display
  send(data: string): void;                 // user input → transport → PTY

  // Terminal actions
  resize(cols: number, rows: number): void;
  focus(): void;
  clear(): void;
  paste(text: string): void;

  // Input mode
  setInputMode(mode: InputMode): void;
  getInputMode(): InputMode;

  // Callbacks → Jotai
  onStateChange: ((status: TerminalStatus) => void) | null;
  onTitleChange: ((title: string) => void) | null;
}
```

### 5.2 Internal Composition

```
TerminalController (facade)
├── InputRouter
│     └── handlers[]
├── InputController        # xterm onData subscription → InputRouter
├── ResizeController       # ResizeObserver → debounce → xterm.resize() + transport
└── SelectionController    # MouseIntentResolver + clipboard
```

### 5.3 Relationship to TerminalView

`TerminalView` is refactored to delegate to `TerminalController`. The existing manager classes (`Renderer`, `ThemeManager`, `FontSizeManager`, `AddonManager`) remain unchanged but are wired through `TerminalRuntime` rather than directly in the constructor.

---

## 6. Transport Layer

### 6.1 TerminalTransport Interface

An abstraction over ConnectionManager so Controller never touches WebSocket/P2P details.

```ts
interface TerminalTransport {
  readonly mode: 'p2p' | 'relay';

  send(data: string): void;
  sendResize(cols: number, rows: number): void;

  onOutput: ((data: Uint8Array) => void) | null;
  onResize: ((cols: number, rows: number) => void) | null;
  onStateChange: ((state: ConnectionState) => void) | null;
  onError: ((err: Error) => void) | null;
  onDisconnect: (() => void) | null;

  dispose(): void;
}
```

`ConnectionManager` already implements this shape; we formalize the interface so it can be swapped. No functional changes to ConnectionManager itself.

---

## 7. Input System

### 7.1 InputHandler Interface

```ts
interface InputHandler {
  readonly mode: InputMode['type'];
  handle(data: string): void;
  activate(): void;
  deactivate(): void;
}
```

### 7.2 TerminalInputHandler (only complete implementation)

```ts
class TerminalInputHandler implements InputHandler {
  readonly mode = 'terminal';
  private unsub: (() => void) | null = null;

  constructor(
    private transport: TerminalTransport,
    private xtermOnData: (cb: (data: string) => void) => () => void,
  ) {}

  activate(): void {
    this.unsub = this.xtermOnData((data: string) => {
      if (data === '\x04') {
        this.onCtrlD?.();
        return;
      }
      this.transport.send(data);
    });
  }

  deactivate(): void {
    this.unsub?.();
  }

  handle(data: string): void {
    this.transport.send(data);
  }

  onCtrlD: (() => void) | null = null;
}
```

### 7.3 InputRouter

```ts
class InputRouter {
  private handlers = new Map<InputMode['type'], InputHandler>();
  private currentMode: InputMode['type'] = 'terminal';

  register(handler: InputHandler): void;
  setMode(mode: InputMode): void;   // deactivate current, activate new
  route(data: string): void;        // dispatch to current handler
}
```

### 7.4 Stub Handlers

`CommandInputHandler`, `SearchInputHandler`, `AIInputHandler`, `CustomInputHandler` are defined as stubs with empty `handle()` bodies. They exist so the InputRouter's handler map is complete and the `InputMode` type can be consumed immediately. Their full implementations are future work.

### 7.5 Wiring

```
xterm.onData → InputController → InputRouter.route()
                                      │
                                      ▼
                              handler.handle(data)
                                      │
                        ┌─────────────┼─────────────┐
                        │             │             │
                    terminal       command         search …
                        │
                        ▼
                  transport.send() → PTY
```

---

## 8. React Component Tree

```
TerminalWorkspace          ← evolves from TerminalView.tsx (the layout shell)
│
├── TerminalHeader         ← unchanged (back, session dropdown, mode badge, address selector)
│
├── TerminalPane           ← new, single-session container
│   │
│   ├── TerminalViewport   ← pure DOM mount, useTerminal() hook
│   │   └── [xterm]        ← TerminalController.attach() mounts here
│   │
│   ├── TerminalInputOverlay  ← InputMode switch (currently always renders null)
│   │
│   └── TerminalBanner     ← reconnection / failed banner
│
├── TerminalToolbar        ← moved from components/, unchanged
│
└── TerminalSidebar        ← stub (future file panel)
```

### 8.1 TerminalViewport (The Pure Component)

```tsx
function TerminalViewport({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useTerminal(sessionId, containerRef);  // attach/detach lifecycle

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ backgroundColor: '#1e1e2e' }}
    />
  );
}
```

No knowledge of: WebSocket, P2P, session lifecycle, command palette, tabs, toolbar. Sole responsibility: provide a DOM mount point for xterm.

### 8.2 TerminalPane

```tsx
function TerminalPane({ sessionId }: { sessionId: string }) {
  const vm = useAtomValue(terminalViewModelAtomFamily(sessionId));

  return (
    <div>
      <TerminalBanner banner={vm.banner} />
      <TerminalViewport sessionId={sessionId} />
      <TerminalInputOverlay sessionId={sessionId} />
    </div>
  );
}
```

### 8.3 TerminalInputOverlay

```tsx
function TerminalInputOverlay({ sessionId }: { sessionId: string }) {
  const mode = useAtomValue(inputModeAtomFamily(sessionId));

  switch (mode.type) {
    case 'terminal':
      return null;  // xterm handles input directly
    case 'command':
      return <CommandPalette />;     // stub
    case 'search':
      return <SearchInput />;        // stub
    case 'ai':
      return <AIInput />;            // stub
    case 'custom':
      return <CustomInput id={mode.id} />;  // stub
  }
}
```

### 8.4 State Machine Extraction

The ~100-line 6-state switch in `Terminal.tsx` moves to a dedicated hook:

```ts
// hooks/useTerminalStateMachine.ts
function useTerminalStateMachine(controller: TerminalController | null) {
  // P2P bridge, attach timeout, reconnect counting
  // Logic unchanged from current Terminal.tsx
}
```

### 8.5 Data Injection Change

**Before:**
```tsx
const [sessionId] = useAtom(sessionIdAtom);
const [mode] = useAtom(effectiveModeAtom);
const [p2pConnection] = useAtom(p2pConnectionAtom);
const [terminalState, setTerminalState] = useAtom(terminalSessionStateAtom);
// ... scattered across 400 lines
```

**After:**
```tsx
const vm = useAtomValue(terminalViewModelAtomFamily(sessionId));
// vm.session, vm.size, vm.mode, vm.focused, vm.capabilities, vm.banner — all from one read
```

---

## 9. Data Flow (End State)

```
React Components          → read viewModelAtom + call controller imperative methods
      │
      ▼
Jotai (terminal/state/)   → 6 domains, all derived from or independent of global atoms
      │
      ▼
TerminalController        → imperative facade; owns InputRouter, sub-controllers
      │
      ├── InputRouter        → routes to handlers by mode
      ├── ResizeController   → ResizeObserver → xterm + transport (no React re-render)
      └── SelectionController
      │
      ▼
TerminalRuntime           → xterm instance, addons, managers (FontSize, Renderer, Theme)
      │
      ▼
TerminalTransport         → interface → ConnectionManager (unchanged)
      │
      ▼
WebSocket / P2P           → backend / tmux
```

**High-frequency data path (resize):**
```
ResizeObserver → ResizeController → xterm.resize() + transport.sendResize()
                   ↓ (debounced, low frequency)
              terminalSizeAtomFamily (Jotai)
```

**User input path:**
```
xterm.onData → InputController → InputRouter → handler → transport.send() → PTY
```

---

## 10. Migration Strategy (5 Phases)

Each phase produces a working, testable state. No phase leaves the system broken.

### Phase 1: State (atoms)
- Create `terminal/state/` with 6 domain files
- Move `terminalSessionStateAtom` from `atoms/connection.ts` → `terminal/state/session.ts`
- Move `lastResizeAtom` from `atoms/connection.ts` → `terminal/state/terminal.ts`
- Add viewModel derived atom
- **Verify:** All atoms export correctly; global atoms unchanged; existing tests pass

### Phase 2: Controller
- Create `TerminalController` class
- Extract `InputController`, `ResizeController`, `SelectionController`
- Define `TerminalTransport` interface
- Adapt `ConnectionManager` to implement `TerminalTransport` (no logic change)
- Refactor `TerminalView` to delegate to `TerminalController` internally
- **Verify:** TerminalView constructor behavior unchanged; React layer sees no difference

### Phase 3: Input System
- Create `InputRouter`, `InputHandler` interface, `TerminalInputHandler`
- Create `terminal/input/` directory
- Wire `TerminalController` to hold `InputRouter`
- Register `TerminalInputHandler` as the only active handler
- Define stub handlers for future modes
- **Verify:** Terminal input works identically to current behavior

### Phase 4: React Components
- Create `TerminalViewport`, `TerminalPane`, `TerminalInputOverlay`
- Extract state machine to `useTerminalStateMachine` hook
- Switch components to read `terminalViewModelAtomFamily`
- Move `TerminalToolbar.tsx` into `terminal/components/`
- Rename `components/TerminalView.tsx` → `terminal/components/TerminalWorkspace.tsx`
- Remove `components/Terminal.tsx` (absorbed into new components)
- **Verify:** Full functional parity — no user-visible changes

### Phase 5 (future): Input Features
- Implement `CommandInputHandler` + `CommandPalette` component
- Implement `SearchInputHandler` + `SearchInput` component
- Implement `AIInputHandler` + `AIInput` component
- Implement `CustomInputHandler` + `CustomInput` component
- Update `capabilitiesAtomFamily` flags when features ship
- Out of scope for this refactoring

---

## 11. What Does NOT Change

- `ConnectionManager` logic (transport send/recv, keepalive, relay subscriptions)
- `InputManager` logic (xterm onData, mouse throttle, Ctrl+D)
- `TerminalSizeManager`, `FontSizeManager`, `Renderer`, `ThemeManager`, `AddonManager`
- `MobileInput`
- `MouseIntentResolver`
- `DeviceProfile` / `detectProfile`
- `useP2PConnection` hook
- Global `atoms/session.ts` and `atoms/connection.ts` (except moving 2 atoms out)
- `k8s/` manifests, `deploy/` configs, CI pipelines

---

## 12. Testing Strategy

- Existing `terminal/__tests__/` tests for managers: keep passing through all phases
- Phase 1: new test file for `terminal/state/` atoms (derived atom correctness)
- Phase 2: new test file for `TerminalController` (attach/detach lifecycle, method delegation)
- Phase 3: new test file for `InputRouter` (register, setMode, route), `TerminalInputHandler`
- Phase 4: update existing component tests for new component tree; add `TerminalViewport` and `TerminalInputOverlay` tests
- All phases: Playwright screenshot verification for visual regression
