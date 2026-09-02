# Terminal Output Lifecycle Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the xterm/controller and terminal output consumer alive through React StrictMode replay and make the session-first terminal stack compile and attach deterministically.

**Architecture:** Keep `TerminalController` and its xterm instance stable for a session. `TerminalViewport` may detach and reattach DOM/transport, while `useTerminal` defers final controller disposal by one microtask so StrictMode replay can cancel it; controller replacement still disposes the old instance. Session-first attach remains transport-first and sends `client.attach`/`beginRelay` only after the output handler is wired.

**Tech Stack:** React 18, TypeScript, Jotai, xterm.js, Vitest, Testing Library, Vite.

---

### Task 1: Add a failing StrictMode lifecycle regression test

**Files:**
- Create: `web/src/terminal/hooks/__tests__/integration/useTerminal.test.tsx`
- Reference: `web/src/terminal/hooks/useTerminal.ts`

- [ ] **Step 1: Write the failing test**

Mock `TerminalController` with a constructor that returns an object containing `dispose`, and render a small hook consumer under `React.StrictMode`. Put the hoisted mock state before the import so Vitest can apply the module mock safely:

```tsx
const { controllerCtor, disposeMock } = vi.hoisted(() => ({
  controllerCtor: vi.fn(),
  disposeMock: vi.fn(),
}));

vi.mock('@/terminal/controller/TerminalController', () => ({
  TerminalController: controllerCtor,
}));

import { createElement, StrictMode, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useTerminal } from '@/terminal/hooks/useTerminal';
import type { TerminalController } from '@/terminal/controller/TerminalController';
import type { TerminalTransport } from '@/terminal/transport/TerminalTransport';

it('does not dispose the active controller during StrictMode effect replay', async () => {
  const controller = { dispose: disposeMock };
  controllerCtor.mockImplementation(() => controller as unknown as TerminalController);

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(StrictMode, null, children);

  const { unmount } = renderHook(
    () => useTerminal({
      sessionId: 'agent:sess',
      sessionName: 'sess',
      mode: 'p2p',
      transportFactory: vi.fn() as unknown as () => TerminalTransport,
      rendererType: 'canvas',
    }),
    { wrapper },
  );

  expect(disposeMock).not.toHaveBeenCalled();
  unmount();
  await Promise.resolve();
  expect(disposeMock).toHaveBeenCalledTimes(1);
});
```

Import `TerminalTransport` as a type if needed; the factory is never called by the mocked controller. Keep the test focused on the lifecycle behavior; do not assert implementation-private refs.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/terminal/hooks/__tests__/integration/useTerminal.test.tsx`

Expected: FAIL because the current empty-dependency cleanup calls `controller.dispose()` during StrictMode replay.

### Task 2: Implement StrictMode-safe controller disposal

**Files:**
- Modify: `web/src/terminal/hooks/useTerminal.ts:72-90`
- Test: `web/src/terminal/hooks/__tests__/integration/useTerminal.test.tsx`

- [ ] **Step 1: Replace immediate cleanup with deferred identity-checked cleanup**

Use refs to track the active controller and effect generation, and return cleanup from the `[controller]` effect. The cleanup queues a microtask and disposes only if the same controller and effect generation are still current; the next effect setup advances the generation before the microtask during StrictMode replay. When a new controller appears, dispose the previous controller immediately and let its queued cleanup become a no-op:

```ts
const activeControllerRef = useRef<TerminalController | null>(null);
const controllerEffectGenerationRef = useRef(0);

useEffect(() => {
  const previous = activeControllerRef.current;
  const generation = ++controllerEffectGenerationRef.current;
  activeControllerRef.current = controller;

  if (previous && previous !== controller) {
    previous.dispose();
  }

  return () => {
    const retiring = controller;
    const cleanupGeneration = generation;
    queueMicrotask(() => {
      if (
        activeControllerRef.current === retiring
        && isCurrentControllerGeneration(controllerEffectGenerationRef, cleanupGeneration)
      ) {
        retiring?.dispose();
        activeControllerRef.current = null;
      }
    });
  };
}, [controller]);
```

Remove the separate empty-dependency cleanup because it is the cleanup that incorrectly treats StrictMode replay as real unmount. Preserve the existing controller memo dependencies and do not include `p2pEpoch` in them; transport route changes are handled by `TerminalViewport`'s transport epoch.

- [ ] **Step 2: Run the focused regression test**

Run: `cd web && npx vitest run src/terminal/hooks/__tests__/integration/useTerminal.test.tsx`

Expected: PASS, with zero unexpected console errors.

- [ ] **Step 3: Run existing terminal lifecycle tests**

Run: `cd web && npx vitest run src/terminal/components/__tests__/integration/TerminalViewport.test.tsx src/terminal/controller/__tests__/integration/TerminalController.test.ts src/terminal/instance/__tests__/integration/TerminalInstance.test.ts`

Expected: all selected tests PASS.

### Task 3: Fix the session-first attach setter contract

**Files:**
- Modify: `web/src/session-first/terminal/useSessionFirstTerminalAttach.ts:70-83,133-135`
- Test: `web/src/session-first/terminal/__tests__/integration/useSessionFirstTerminalAttach.test.ts`

- [ ] **Step 1: Confirm the existing type failure**

Run: `cd web && npx tsc --noEmit`

Expected before the change: an error at `useSessionFirstTerminalAttach.ts:134` because `P2pAttachCtx.setTerminalState` accepts only `TerminalStatus`, while the timeout passes a function updater.

- [ ] **Step 2: Update the context type to match the Jotai setter**

Import `SetStateAction` from React and declare:

```ts
setTerminalState: (value: SetStateAction<TerminalStatus>) => void;
```

Keep `runP2pAttach`'s timeout transition unchanged:

```ts
ctx.setTerminalState((prev) => (prev === 'connecting' ? 'reconnecting' : 'connecting'));
```

This changes only the TypeScript contract and preserves the existing runtime state transition.

- [ ] **Step 3: Run the attach tests and type check**

Run: `cd web && npx vitest run src/session-first/terminal/__tests__/integration/useSessionFirstTerminalAttach.test.ts`

Expected: all attach tests PASS.

Run: `cd web && npx tsc --noEmit`

Expected: exit 0.

### Task 4: Verify output delivery and the full web build

**Files:**
- No production changes expected unless a test exposes a regression in the scoped lifecycle code.
- Reference tests: `web/src/terminal/controller/__tests__/integration/TerminalController.test.ts`, `web/src/terminal/__tests__/unit/ConnectionManager.test.ts`, `web/src/services/websocket/plugins/__tests__/unit/EventPlugin.test.ts`

- [ ] **Step 1: Run all terminal and session-first integration tests**

Run: `cd web && npx vitest run src/terminal src/session-first/terminal src/session-first/__tests__/integration/SessionFirstTerminal.test.tsx`

Expected: all matching tests PASS.

- [ ] **Step 2: Run the complete web test suite**

Run: `cd web && npm test`

Expected: all Vitest projects PASS with no failed tests.

- [ ] **Step 3: Run the production build**

Run: `cd web && npm run build`

Expected: TypeScript compilation and Vite build both exit 0.

- [ ] **Step 4: Check the final diff**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only the intended design/plan commits and terminal lifecycle implementation/test changes are present. Do not stage or alter unrelated pre-existing worktree changes.

- [ ] **Step 5: Commit the implementation separately**

After verification, stage only the lifecycle/type/test files changed by this plan and commit:

```bash
git add web/src/terminal/hooks/useTerminal.ts web/src/terminal/hooks/__tests__/integration/useTerminal.test.tsx web/src/session-first/terminal/useSessionFirstTerminalAttach.ts
git commit -m "fix: preserve xterm across strict mode replay"
```
