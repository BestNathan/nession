# Terminal Session Jotai Atoms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered `useState` + prop-drilling + callback chains in the terminal attach/session flow with Jotai atoms. Eliminate `useAttachFlow` and `useP2PWithFallback`; components subscribe to only the atoms they need.

**Architecture:** 12 base atoms (semantic state units with independent update frequencies), 6 derived atoms (pure computations), 4 action atoms (atomic multi-atom writes). `useP2PConnection` exposes a setter so `p2pStateAtom` is written from WebSocket events. Protocol messages unchanged.

**Tech Stack:** Jotai 2.x, React 18, TypeScript 5.x, xterm.js, Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `web/package.json` | modify | add `jotai` dependency |
| `web/src/atoms/terminal.ts` | **create** | all base, derived, and action atoms |
| `web/src/hooks/useP2PConnection.ts` | modify | expose `setP2pState` setter; write `p2pStateAtom` from ws events |
| `web/src/components/Terminal.tsx` | modify | read atoms instead of props; keep effect logic |
| `web/src/components/TerminalView.tsx` | modify | remove `useP2PWithFallback`; read derived atoms; delete callback chain |
| `web/src/components/SessionDropdown.tsx` | modify | use `attachToSessionAtom` instead of `onSwitchSession` prop |
| `web/src/components/AddressSelector.tsx` | modify | use `manualOverrideAtom`/`switchAddressAtom` instead of props |
| `web/src/components/env/AttachDialog.tsx` | modify | use `attachInfoAtom`/`requestAttachAtom` instead of local state |
| `web/src/components/Dashboard.tsx` | modify | remove `useAttachFlow`; use `hasActiveSessionAtom`, `disconnectAtom`, `attachToSessionAtom` |
| `web/src/components/RenderTerminal.tsx` | modify | remove AttachedSession prop; read from atoms |
| `web/src/hooks/useAttachFlow.ts` | **delete** | — |
| `web/src/hooks/useP2PWithFallback.ts` | **delete** | — |
| `web/src/atoms/__tests__/terminal.test.ts` | **create** | derived atom computation + action atom writes |

---

### Task 1: Install Jotai and scaffold atoms file

**Files:**
- Modify: `web/package.json`
- Create: `web/src/atoms/terminal.ts`
- Create: `web/src/atoms/__tests__/terminal.test.ts`

- [ ] **Step 1: Install jotai**

```bash
cd web && npm install jotai
```

- [ ] **Step 2: Verify install**

```bash
cd web && node -e "require('jotai')" && echo "jotai OK"
```
Expected: no error, "jotai OK"

- [ ] **Step 3: Create atoms file with base and derived atoms**

```typescript
// web/src/atoms/terminal.ts
import { atom } from 'jotai';
import type { AttachInfo, EnvFileRef } from '../types';
import type { P2PConnection, ConnectionState } from '../hooks/useP2PConnection';

// ── Base atoms ──────────────────────────────────────────────────

/** Current attached session id, e.g. "k8s-agent:1". */
export const sessionIdAtom = atom('');
/** Short session name, e.g. "1". Sent in client.attach/terminal.input payloads. */
export const sessionNameAtom = atom('');
/** Server response from client.session.attach — all candidate addresses + token. */
export const attachInfoAtom = atom<AttachInfo | null>(null);
/** Browser-latency-sorted candidate P2P URLs, best-first. */
export const orderedUrlsAtom = atom<string[]>([]);
/** Selected renderer: webgl (GPU) or canvas (compatibility). */
export const rendererAtom = atom<'webgl' | 'canvas'>('webgl');
/** Env files to source after attach. */
export const envRefsAtom = atom<EnvFileRef[]>([]);
/** Manual address override (null = auto). Set by AddressSelector. */
export const manualOverrideAtom = atom<string | null>(null);
/** True when all P2P candidates have failed and we fell back to relay. */
export const forcedRelayAtom = atom(false);
/** P2P WebSocket connection state. Written from useP2PConnection ws events. */
export const p2pStateAtom = atom<ConnectionState>('disconnected');
/** Stable P2P connection object. Written from useP2PConnection after construction. */
export const p2pConnectionAtom = atom<P2PConnection | null>(null);

// ── Derived atoms ────────────────────────────────────────────────

/** Currently active P2P URL — manual override, or best candidate, or null in relay. */
export const activeUrlAtom = atom<string | null>((get) => {
  const override = get(manualOverrideAtom);
  if (override) return override;
  if (get(forcedRelayAtom)) return null;
  return get(orderedUrlsAtom)[0] ?? null;
});

/** Effective transport mode after considering forced relay fallback. */
export const effectiveModeAtom = atom<'p2p' | 'relay'>((get) => {
  if (get(forcedRelayAtom)) return 'relay';
  return get(attachInfoAtom)?.mode === 'p2p' ? 'p2p' : 'relay';
});

/** True while the user manually selected an address that hasn't connected yet. */
export const isSwitchingAtom = atom((get) =>
  get(manualOverrideAtom) !== null && get(p2pStateAtom) !== 'connected',
);

/** True when the user has an active terminal session (dashboard → terminal). */
export const hasActiveSessionAtom = atom((get) => get(sessionIdAtom) !== '');

/** Session ID parsed from the URL pathname, for deep-link restore. */
export const sessionIdFromUrlAtom = atom<string | null>(null);
// Written once by Dashboard on mount from location.pathname.

// ── Action atoms ─────────────────────────────────────────────────

import type { Session } from '../types';
import type { AttachChoice } from '../components/env/AttachDialog';

/** Attach to a session: write all base atoms + navigate to terminal route.
 *  Called from AttachDialog onConfirm, or from SessionDropdown in-terminal switch. */
export const attachToSessionAtom = atom(
  null,
  (_get, set, session: Session, choice: AttachChoice, navigate: (path: string) => void) => {
    set(sessionIdAtom, session.session_id);
    set(sessionNameAtom, session.session_name);
    set(attachInfoAtom, choice.attachInfo);
    set(orderedUrlsAtom, choice.orderedUrls);
    set(rendererAtom, choice.renderer);
    set(envRefsAtom, choice.envRefs ?? []);
    set(manualOverrideAtom, choice.selectedUrl ?? null);
    set(forcedRelayAtom, false);
    navigate(`/terminal/${encodeURIComponent(session.session_id)}`);
  },
);

/** Disconnect from the current session: clear all atoms + navigate to dashboard. */
export const disconnectAtom = atom(
  null,
  (_get, set, navigate: (path: string) => void) => {
    set(sessionIdAtom, '');
    set(sessionNameAtom, '');
    set(attachInfoAtom, null);
    set(orderedUrlsAtom, []);
    set(manualOverrideAtom, null);
    set(forcedRelayAtom, false);
    set(p2pConnectionAtom, null);
    set(p2pStateAtom, 'disconnected');
    navigate('/');
  },
);

/** Set a manual P2P address override. Called by AddressSelector. */
export const switchAddressAtom = atom(
  null,
  (_get, set, url: string | null) => {
    set(manualOverrideAtom, url);
  },
);
```

- [ ] **Step 4: Write unit tests for derived atoms and action atoms**

```typescript
// web/src/atoms/__tests__/terminal.test.ts
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import {
  sessionIdAtom, sessionNameAtom, attachInfoAtom, orderedUrlsAtom,
  manualOverrideAtom, forcedRelayAtom, p2pStateAtom, rendererAtom, envRefsAtom,
  activeUrlAtom, effectiveModeAtom, isSwitchingAtom, hasActiveSessionAtom,
  attachToSessionAtom, disconnectAtom, switchAddressAtom,
} from '../terminal';
import type { AttachInfo, Session } from '../../types';
import type { AttachChoice } from '../../components/env/AttachDialog';

function makeAttachInfo(overrides?: Partial<AttachInfo>): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent:sess',
    session_name: 'sess',
    connection_token: 'tok',
    addresses: [
      { url: 'ws://a:1/ws', label: 'tailscale', status: 'reachable' as const },
      { url: 'ws://b:2/ws', label: 'lan', status: 'reachable' as const },
    ],
    ...overrides,
  };
}

function makeSession(overrides?: Partial<Session>): Session {
  return {
    session_id: 'agent:sess',
    session_name: 'sess',
    agent_id: 'agent',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeChoice(session: Session, overrides?: Partial<AttachChoice>): AttachChoice {
  return {
    mode: 'auto',
    attachInfo: makeAttachInfo(),
    orderedUrls: ['ws://a:1/ws', 'ws://b:2/ws'],
    latencies: [],
    selectedUrl: null,
    renderer: 'webgl',
    envRefs: [],
    ...overrides,
  };
}

const navigate = () => {};

describe('base atoms', () => {
  it('start with default values', () => {
    const store = createStore();
    expect(store.get(sessionIdAtom)).toBe('');
    expect(store.get(sessionNameAtom)).toBe('');
    expect(store.get(attachInfoAtom)).toBeNull();
    expect(store.get(orderedUrlsAtom)).toEqual([]);
    expect(store.get(manualOverrideAtom)).toBeNull();
    expect(store.get(forcedRelayAtom)).toBe(false);
    expect(store.get(p2pStateAtom)).toBe('disconnected');
    expect(store.get(rendererAtom)).toBe('webgl');
    expect(store.get(envRefsAtom)).toEqual([]);
  });
});

describe('derived atoms', () => {
  it('activeUrlAtom: falls back to first ordered url when no override', () => {
    const store = createStore();
    store.set(orderedUrlsAtom, ['ws://a:1/ws', 'ws://b:2/ws']);
    expect(store.get(activeUrlAtom)).toBe('ws://a:1/ws');
  });

  it('activeUrlAtom: manual override wins', () => {
    const store = createStore();
    store.set(orderedUrlsAtom, ['ws://a:1/ws', 'ws://b:2/ws']);
    store.set(manualOverrideAtom, 'ws://b:2/ws');
    expect(store.get(activeUrlAtom)).toBe('ws://b:2/ws');
  });

  it('activeUrlAtom: returns null when forcedRelay', () => {
    const store = createStore();
    store.set(orderedUrlsAtom, ['ws://a:1/ws']);
    store.set(forcedRelayAtom, true);
    expect(store.get(activeUrlAtom)).toBeNull();
  });

  it('activeUrlAtom: returns null for empty orderedUrls', () => {
    const store = createStore();
    expect(store.get(activeUrlAtom)).toBeNull();
  });

  it('effectiveModeAtom: p2p when attachInfo says p2p and not forced relay', () => {
    const store = createStore();
    store.set(attachInfoAtom, makeAttachInfo({ mode: 'p2p' }));
    expect(store.get(effectiveModeAtom)).toBe('p2p');
  });

  it('effectiveModeAtom: relay when forcedRelay is true', () => {
    const store = createStore();
    store.set(attachInfoAtom, makeAttachInfo({ mode: 'p2p' }));
    store.set(forcedRelayAtom, true);
    expect(store.get(effectiveModeAtom)).toBe('relay');
  });

  it('effectiveModeAtom: relay when no attachInfo', () => {
    const store = createStore();
    expect(store.get(effectiveModeAtom)).toBe('relay');
  });

  it('isSwitchingAtom: true when manual override set and not connected', () => {
    const store = createStore();
    store.set(manualOverrideAtom, 'ws://b:2/ws');
    store.set(p2pStateAtom, 'connecting');
    expect(store.get(isSwitchingAtom)).toBe(true);
  });

  it('isSwitchingAtom: false when override set but already connected', () => {
    const store = createStore();
    store.set(manualOverrideAtom, 'ws://b:2/ws');
    store.set(p2pStateAtom, 'connected');
    expect(store.get(isSwitchingAtom)).toBe(false);
  });

  it('isSwitchingAtom: false when no override', () => {
    const store = createStore();
    store.set(p2pStateAtom, 'connecting');
    expect(store.get(isSwitchingAtom)).toBe(false);
  });

  it('hasActiveSessionAtom: true when sessionId is set', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    expect(store.get(hasActiveSessionAtom)).toBe(true);
  });

  it('hasActiveSessionAtom: false by default', () => {
    const store = createStore();
    expect(store.get(hasActiveSessionAtom)).toBe(false);
  });
});

describe('action atoms', () => {
  it('attachToSessionAtom writes all base atoms', () => {
    const store = createStore();
    const session = makeSession({ session_id: 'agent:sess', session_name: 'sess' });
    const choice = makeChoice(session, {
      selectedUrl: 'ws://a:1/ws',
      renderer: 'canvas',
      envRefs: [{ source: 'server', name: '.env' }],
    });

    store.set(attachToSessionAtom, session, choice, navigate);

    expect(store.get(sessionIdAtom)).toBe('agent:sess');
    expect(store.get(sessionNameAtom)).toBe('sess');
    expect(store.get(attachInfoAtom)?.connection_token).toBe('tok');
    expect(store.get(orderedUrlsAtom)).toEqual(['ws://a:1/ws', 'ws://b:2/ws']);
    expect(store.get(rendererAtom)).toBe('canvas');
    expect(store.get(envRefsAtom)).toEqual([{ source: 'server', name: '.env' }]);
    expect(store.get(manualOverrideAtom)).toBe('ws://a:1/ws');
    expect(store.get(forcedRelayAtom)).toBe(false);
  });

  it('disconnectAtom clears all atoms', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    store.set(sessionNameAtom, 'sess');
    store.set(manualOverrideAtom, 'ws://a:1/ws');
    store.set(p2pStateAtom, 'connected');

    store.set(disconnectAtom, navigate);

    expect(store.get(sessionIdAtom)).toBe('');
    expect(store.get(sessionNameAtom)).toBe('');
    expect(store.get(manualOverrideAtom)).toBeNull();
    expect(store.get(p2pStateAtom)).toBe('disconnected');
  });

  it('switchAddressAtom sets manualOverride', () => {
    const store = createStore();
    store.set(switchAddressAtom, 'ws://b:2/ws');
    expect(store.get(manualOverrideAtom)).toBe('ws://b:2/ws');

    store.set(switchAddressAtom, null);
    expect(store.get(manualOverrideAtom)).toBeNull();
  });
});
```

- [ ] **Step 5: Run tests to verify atoms work**

```bash
cd web && npx vitest run src/atoms/__tests__/terminal.test.ts
```
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json \
        web/src/atoms/terminal.ts \
        web/src/atoms/__tests__/terminal.test.ts
git commit -m "feat: add jotai atoms for terminal session state

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Adapt useP2PConnection to write p2pStateAtom and p2pConnectionAtom

**Files:**
- Modify: `web/src/hooks/useP2PConnection.ts`

- [ ] **Step 1: Add atom setters inside useP2PConnection**

In `useP2PConnection.ts`, import the atoms and use `useSetAtom` to write them from WebSocket events. The key change: `ws.onopen` now writes `p2pStateAtom`, and the stable connection object is written to `p2pConnectionAtom`.

Add these imports at the top:

```typescript
// web/src/hooks/useP2PConnection.ts — add after existing imports
import { useSetAtom } from 'jotai';
import { p2pStateAtom, p2pConnectionAtom } from '../atoms/terminal';
```

Inside `useP2PConnection`, add the setters:

```typescript
// Add right after line 152 (current state initialization):
const setP2pState = useSetAtom(p2pStateAtom);
const setP2pConnection = useSetAtom(p2pConnectionAtom);
```

- [ ] **Step 2: Write p2pStateAtom from ws.onopen and ws.onclose in connectWs**

Modify `connectWs` to accept the atom setter. Change the signature:

```typescript
// web/src/hooks/useP2PConnection.ts
// In ConnectWsContext interface (around line 48), add:
interface ConnectWsContext {
  // ... existing fields ...
  setP2pState: (s: ConnectionState) => void;
}

// In ws.onopen (around line 79), add after ctx.setConnectionState('connected'):
ctx.setP2pState('connected');

// In ws.onclose (around line 107), add after ctx.setConnectionState:
if (attempt >= ctx.maxReconnectAttempts) {
  ctx.setP2pState('disconnected');
}
// Also add ctx.setP2pState('reconnecting') right before setConnectionState('reconnecting')
```

- [ ] **Step 3: Write p2pConnectionAtom when connection object is ready**

In `useP2PConnection`, after computing `connection` via `useMemo` (around line 309), add an effect that writes the connection object:

```typescript
// Add after the connection useMemo:
useEffect(() => {
  if (options) {
    setP2pConnection(connection);
  }
  return () => {
    setP2pConnection(null);
  };
}, [connection, !!options, setP2pConnection]);
```

- [ ] **Step 4: Pass setP2pState through ConnectWsContext**

In the `useEffect` that calls `connectWs(ctx)` (around line 208), add `setP2pState` to the ctx:

```typescript
const ctx: ConnectWsContext = {
  agentUrl, connectionToken,
  generation: myGeneration,
  generationRef,
  reconnectAttemptRef,
  setConnectionState, setReconnectAttempt, handlersRef,
  maxReconnectAttempts, reconnectBaseDelay, onError,
  reconnectTimerRef, wsRef,
  setP2pState,   // <-- add this
  connectSelf: () => connectWs(ctx),
};
```

- [ ] **Step 5: Run ESLint + TypeScript**

```bash
cd web && npx eslint src/hooks/useP2PConnection.ts --max-warnings 0 && \
  ../../node_modules/.bin/tsc --noEmit
```
Expected: no errors

- [ ] **Step 6: Run existing P2P tests**

```bash
cd web && npx vitest run src/hooks/__tests__/useP2PConnection.ordering.test.tsx
```
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add web/src/hooks/useP2PConnection.ts
git commit -m "feat: write p2pStateAtom and p2pConnectionAtom from useP2PConnection

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Migrate AttachDialog to atoms

**Files:**
- Modify: `web/src/components/env/AttachDialog.tsx`

- [ ] **Step 1: Replace local attachInfo state with atom**

In `AttachDialog.tsx`, remove the local `useState<AttachInfo | null>` and replace with `useAtom(attachInfoAtom)`:

```typescript
// web/src/components/env/AttachDialog.tsx
// Remove:
// const [attachInfo, setAttachInfo] = useState<AttachInfo | null>(null);

// Add import:
import { useAtom } from 'jotai';
import { attachInfoAtom } from '../../atoms/terminal';

// Inside the component:
const [attachInfo, setAttachInfo] = useAtom(attachInfoAtom);
```

- [ ] **Step 2: Replace wsService.requestAttach with direct call + setAttachInfo**

The `requestAttach` call stays the same (it sends `client.session.attach`), but the response is written to the atom:

```typescript
// In the useEffect that calls requestAttach (around line 104):
void (async () => {
  try {
    const info = await wsService.requestAttach(session.session_id, requestedMode, relayUrl);
    if (!cancelled) {
      setAttachInfo(info);  // writes to attachInfoAtom now
    }
  } catch (err) {
    if (!cancelled) {
      setError(err instanceof Error ? err.message : 'Failed to query agent addresses');
    }
  }
})();
```

- [ ] **Step 3: Run ESLint + TypeScript**

```bash
cd web && npx eslint src/components/env/AttachDialog.tsx --max-warnings 0 && \
  ../../node_modules/.bin/tsc --noEmit
```
Expected: no errors

- [ ] **Step 4: Run related tests**

```bash
cd web && npx vitest run src/components/env/__tests__/
```
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add web/src/components/env/AttachDialog.tsx
git commit -m "refactor: migrate AttachDialog attachInfo to jotai atom

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Migrate AddressSelector to atoms

**Files:**
- Modify: `web/src/components/AddressSelector.tsx`

- [ ] **Step 1: Replace setManualOverride prop with switchAddressAtom**

```typescript
// web/src/components/AddressSelector.tsx
import { useAtom, useSetAtom } from 'jotai';
import { manualOverrideAtom, switchAddressAtom,
         activeUrlAtom, isSwitchingAtom, orderedUrlsAtom } from '../atoms/terminal';

// Inside AddressSelector component:
const [manualOverride] = useAtom(manualOverrideAtom);
const [activeUrl] = useAtom(activeUrlAtom);
const [orderedUrls] = useAtom(orderedUrlsAtom);
const [isSwitching] = useAtom(isSwitchingAtom);
const setAddress = useSetAtom(switchAddressAtom);

// Replace all setManualOverride(url) calls with setAddress(url)
// Replace the local isAuto computed value:
const isAuto = manualOverride === null;
```

- [ ] **Step 2: Remove the setManualOverride prop from the interface**

Delete `setManualOverride` and related props from the `AddressSelectorProps` interface. The component now reads/writes atoms directly.

- [ ] **Step 3: Run ESLint + TypeScript**

```bash
cd web && npx eslint src/components/AddressSelector.tsx --max-warnings 0 && \
  ../../node_modules/.bin/tsc --noEmit
```
Expected: no errors

- [ ] **Step 4: Run related tests**

```bash
cd web && npx vitest run src/components/__tests__/AddressSelector
```
Expected: all pass (or adapt test mocks)

- [ ] **Step 5: Commit**

```bash
git add web/src/components/AddressSelector.tsx web/src/components/__tests__/
git commit -m "refactor: migrate AddressSelector to jotai atoms

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Migrate SessionDropdown to atoms

**Files:**
- Modify: `web/src/components/SessionDropdown.tsx`

- [ ] **Step 1: Replace onSwitchSession prop with attachToSessionAtom**

```typescript
// web/src/components/SessionDropdown.tsx
import { useAtom, useSetAtom } from 'jotai';
import { sessionIdAtom, sessionNameAtom, attachToSessionAtom } from '../atoms/terminal';

// Inside SessionDropdown:
const [currentSessionId] = useAtom(sessionIdAtom);
const doAttach = useSetAtom(attachToSessionAtom);

// Replace onSwitchSession(session, choice) with:
//   doAttach(session, choice, navigate)
// For the navigate function, import from react-router:
import { useNavigate } from 'react-router-dom';
const navigate = useNavigate();
```

- [ ] **Step 2: Remove the onSwitchSession prop**

Delete `onSwitchSession` from `SessionDropdownProps`. The component no longer needs it.

- [ ] **Step 3: Update confirmAttach callback**

```typescript
// In SessionDropdown:
const confirmAttach = useCallback((session: Session, choice: AttachChoice) => {
  setAttachTarget(null);
  doAttach(session, choice, navigate);
}, [doAttach, navigate]);
```

- [ ] **Step 4: Run ESLint + TypeScript**

```bash
cd web && npx eslint src/components/SessionDropdown.tsx --max-warnings 0 && \
  ../../node_modules/.bin/tsc --noEmit
```
Expected: no errors

- [ ] **Step 5: Run related tests**

```bash
cd web && npx vitest run src/components/__tests__/SessionList
```
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add web/src/components/SessionDropdown.tsx
git commit -m "refactor: migrate SessionDropdown to jotai atoms

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Migrate TerminalView to atoms (remove useP2PWithFallback)

**Files:**
- Modify: `web/src/components/TerminalView.tsx`

- [ ] **Step 1: Remove useP2PWithFallback import and call**

```typescript
// web/src/components/TerminalView.tsx
// Remove:
// import { useP2PWithFallback } from '../hooks/useP2PWithFallback';

// Add:
import { useAtom, useSetAtom } from 'jotai';
import {
  sessionIdAtom, sessionNameAtom, attachInfoAtom,
  activeUrlAtom, effectiveModeAtom, isSwitchingAtom,
  orderedUrlsAtom, manualOverrideAtom, forcedRelayAtom,
  p2pConnectionAtom, p2pStateAtom, rendererAtom, envRefsAtom,
  switchAddressAtom, disconnectAtom,
} from '../atoms/terminal';

// Remove this block:
// const {
//   p2pConnection,
//   effectiveMode,
//   activeUrl,
//   forcedRelay,
//   manualOverride,
//   setManualOverride,
//   isSwitching,
// } = useP2PWithFallback(attachInfo, sessionName, {
//   orderedUrls: orderedUrls ?? null,
//   initialSelectedAddress: selectedAddress ?? null,
// });

// Replace with direct atom reads:
const [sessionId] = useAtom(sessionIdAtom);
const [sessionName] = useAtom(sessionNameAtom);
const [effectiveMode] = useAtom(effectiveModeAtom);
const [activeUrl] = useAtom(activeUrlAtom);
const [forcedRelay] = useAtom(forcedRelayAtom);
const [manualOverride] = useAtom(manualOverrideAtom);
const setManualOverride = useSetAtom(switchAddressAtom);
const [isSwitching] = useAtom(isSwitchingAtom);
const [p2pConnection] = useAtom(p2pConnectionAtom);
const [attachInfo] = useAtom(attachInfoAtom);
const doDisconnect = useSetAtom(disconnectAtom);
```

- [ ] **Step 2: Replace AttachedSession prop with atoms**

Remove the `session` prop from `TerminalViewProps`. All fields now come from atoms.

```typescript
// Remove AttachedSession from the interface
export interface TerminalViewProps {
  // Remove: session: AttachedSession;
  onBack: () => void;
  onSwitchSession: (session: Session, choice: AttachChoice) => void;
  onDisconnect: () => void;
  onError: (error: Error) => void;
}

// Inside the component, remove destructuring of `session` prop.
// All values now come from atoms.
```

- [ ] **Step 3: Replace envRefs from session to atom**

```typescript
// Replace: const refs = session.envRefs;
// With:
const [envRefs] = useAtom(envRefsAtom);
```

- [ ] **Step 4: Replace handleBack and handleSwitchSession to use disconnectAtom**

```typescript
// Remove handleBack and handleSwitchSession callbacks.
// Use doDisconnect for back navigation:
import { useNavigate } from 'react-router-dom';
const navigate = useNavigate();

const handleBack = useCallback(() => {
  if (effectiveMode === 'relay' && wsService?.isConnected()) {
    try { wsService.endRelay(sessionId); } catch { /* best-effort */ }
  }
  doDisconnect(navigate);
}, [effectiveMode, wsService, sessionId, doDisconnect, navigate]);
```

- [ ] **Step 5: Run ESLint + TypeScript**

```bash
cd web && npx eslint src/components/TerminalView.tsx --max-warnings 0 && \
  ../../node_modules/.bin/tsc --noEmit
```
Expected: no errors

- [ ] **Step 6: Run related tests**

```bash
cd web && npx vitest run src/components/__tests__/
```
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add web/src/components/TerminalView.tsx
git commit -m "refactor: migrate TerminalView to jotai atoms, remove useP2PWithFallback

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Migrate Terminal to atoms

**Files:**
- Modify: `web/src/components/Terminal.tsx`

- [ ] **Step 1: Replace props with atom reads**

```typescript
// web/src/components/Terminal.tsx
import { useAtom } from 'jotai';
import {
  sessionIdAtom, sessionNameAtom, effectiveModeAtom,
  p2pConnectionAtom, p2pStateAtom,
} from '../atoms/terminal';

// Inside Terminal component:
const [sessionId] = useAtom(sessionIdAtom);
const [sessionName] = useAtom(sessionNameAtom);
const [mode] = useAtom(effectiveModeAtom);
const [p2pConnection] = useAtom(p2pConnectionAtom);
```

Remove corresponding props from `TerminalProps` interface: `sessionId`, `sessionName`, `mode`, `p2pConnection`.

- [ ] **Step 2: Keep the effect unchanged**

The effect that watches `p2pState` and drives `view.reattach()` is unchanged — it now reads `p2pState` from the atom instead of a prop, but the logic is identical.

```typescript
// The p2pState variable:
// const p2pState = p2pConnection?.connectionState;
// stays unchanged — it reads from the getter on the connection object.
// The effect's dependency on [mode, p2pState, p2pConnection] stays the same.
```

- [ ] **Step 3: Run ESLint + TypeScript**

```bash
cd web && npx eslint src/components/Terminal.tsx --max-warnings 0 && \
  ../../node_modules/.bin/tsc --noEmit
```
Expected: no errors

- [ ] **Step 4: Run Terminal tests**

```bash
cd web && npx vitest run src/components/__tests__/Terminal
```
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Terminal.tsx
git commit -m "refactor: migrate Terminal component to jotai atoms

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Migrate Dashboard and RenderTerminal to atoms (remove useAttachFlow)

**Files:**
- Modify: `web/src/components/Dashboard.tsx`
- Modify: `web/src/components/RenderTerminal.tsx`

- [ ] **Step 1: Remove useAttachFlow from Dashboard**

```typescript
// web/src/components/Dashboard.tsx
// Remove:
// import { useAttachFlow } from '../hooks/useAttachFlow';

// Add:
import { useAtom, useSetAtom } from 'jotai';
import {
  hasActiveSessionAtom, sessionIdAtom, sessionIdFromUrlAtom,
  attachToSessionAtom, disconnectAtom,
} from '../atoms/terminal';

// Remove:
// const {
//   attachedSession,
//   attachDialogSession, setAttachDialogSession,
//   onAttach, confirmAttach,
//   backToDashboard,
//   pendingTerminalSessionId,
// } = useAttachFlow(fetchSessions, navigate, location);

// Replace with:
const [hasActiveSession] = useAtom(hasActiveSessionAtom);
const [sessionId] = useAtom(sessionIdAtom);
const doAttach = useSetAtom(attachToSessionAtom);
const doDisconnect = useSetAtom(disconnectAtom);

// For deep-link restore, write sessionIdFromUrlAtom on mount:
import { useEffect } from 'react';
const [sessionIdFromUrl, setSessionIdFromUrl] = useAtom(sessionIdFromUrlAtom);
useEffect(() => {
  const match = location.pathname.match(/^\/terminal\/(.+)$/);
  setSessionIdFromUrl(match?.[1] ?? null);
}, [location.pathname, setSessionIdFromUrl]);
```

- [ ] **Step 2: Update Dashboard render logic**

```typescript
// Replace:
// if (terminalMatch && attachedSession) {
//   return <RenderTerminal key={attachedSession.sessionId} ... />;

// With:
if (terminalMatch && hasActiveSession) {
  return (
    <RenderTerminal
      key={sessionId}
      handleBackToDashboard={() => doDisconnect(navigate)}
      handleSwitchSession={(session, choice) => doAttach(session, choice, navigate)}
      handleTerminalDisconnect={handleTerminalDisconnect}
      handleTerminalError={handleTerminalError}
    />
  );
}
```

- [ ] **Step 3: Simplify RenderTerminal**

```typescript
// web/src/components/RenderTerminal.tsx
// Remove AttachedSession prop — it now reads from atoms.
// Keep the basic wrapper structure but remove the session prop:

import { useAtom } from 'jotai';
import { sessionIdAtom } from '../atoms/terminal';

export function RenderTerminal({
  handleBackToDashboard,
  handleSwitchSession,
  handleTerminalDisconnect,
  handleTerminalError,
}: {
  handleBackToDashboard: () => void;
  handleSwitchSession: (session: Session, choice: AttachChoice) => void;
  handleTerminalDisconnect: () => void;
  handleTerminalError: (err: Error) => void;
}) {
  const [sessionId] = useAtom(sessionIdAtom);
  // TerminalView now reads session data from atoms, no prop needed
  return (
    <TerminalView
      onBack={handleBackToDashboard}
      onSwitchSession={handleSwitchSession}
      onDisconnect={handleTerminalDisconnect}
      onError={handleTerminalError}
    />
  );
}
```

- [ ] **Step 4: Pass the remaining props correctly**

`handleTerminalDisconnect` and `handleTerminalError` can remain as props for now (they deal with the WebSocket service, not session state).

- [ ] **Step 5: Run ESLint + TypeScript**

```bash
cd web && npx eslint src/components/Dashboard.tsx src/components/RenderTerminal.tsx --max-warnings 0 && \
  ../../node_modules/.bin/tsc --noEmit
```
Expected: no errors

- [ ] **Step 6: Run tests**

```bash
cd web && npx vitest run src/components/__tests__/
```
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add web/src/components/Dashboard.tsx web/src/components/RenderTerminal.tsx
git commit -m "refactor: migrate Dashboard to jotai atoms, remove useAttachFlow

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Delete useAttachFlow and useP2PWithFallback

**Files:**
- Delete: `web/src/hooks/useAttachFlow.ts`
- Delete: `web/src/hooks/useP2PWithFallback.ts`

- [ ] **Step 1: Verify no remaining imports reference these files**

```bash
cd web && grep -r "useAttachFlow\|useP2PWithFallback" src/ --include="*.ts" --include="*.tsx" | grep -v "node_modules\|__tests__"
```
Expected: no output (all references removed)

- [ ] **Step 2: Delete the files**

```bash
rm web/src/hooks/useAttachFlow.ts web/src/hooks/useP2PWithFallback.ts
```

- [ ] **Step 3: Run TypeScript to verify no broken imports**

```bash
cd web && ../../node_modules/.bin/tsc --noEmit
```
Expected: no errors

- [ ] **Step 4: Run full test suite**

```bash
cd web && npm test
```
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git rm web/src/hooks/useAttachFlow.ts web/src/hooks/useP2PWithFallback.ts
git commit -m "refactor: delete useAttachFlow and useP2PWithFallback hooks

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run full lint + type check**

```bash
cd web && npx eslint src/ --ext .ts,.tsx --max-warnings 0 && \
  ../../node_modules/.bin/tsc --noEmit
```
Expected: no errors

- [ ] **Step 2: Run full test suite**

```bash
cd web && npm test
```
Expected: all 768 tests pass

- [ ] **Step 3: Run Rust tests to confirm no regression**

```bash
cargo test --workspace --tests -- --test-threads=1
```
Expected: all pass

- [ ] **Step 4: Push and verify CI**

```bash
git push origin fix/sessions-hard-refresh
# Watch CI: gh run watch <run_id>
```

