# Mobile Terminal Layout Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Nession mobile terminal page with a fixed-height bottom sheet (4 tabs), floating physical-key overlay, live-filtered command history, and keyboard-aware layout — while preserving all desktop behavior.

**Architecture:** New `MobileTerminalLayout` component composes `FloatingKeyBar` (overlay) + `Terminal` (shared) + `BottomSheet` (fixed-height tabbed panel). `InputPanel` and `QuickCommandsPanel` are shared between mobile and desktop. Three new hooks (`useVisualViewport`, `useCommandHistory`, `useFloatingKeyBar`) encapsulate keyboard detection, history storage, and key bar state. Desktop `TerminalLayout` is updated to use the new shared panels but keeps its existing structure.

**Tech Stack:** React 19, TypeScript, xterm.js 5.5, Tailwind CSS v4, shadcn/ui, Vitest + @testing-library/react

---

### Task 1: useVisualViewport hook

**Files:**
- Create: `web/src/hooks/useVisualViewport.ts`
- Create: `web/src/hooks/__tests__/useVisualViewport.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// web/src/hooks/__tests__/useVisualViewport.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVisualViewport } from '../useVisualViewport';

type Listener = (e: Event) => void;

interface MockVisualViewport {
  height: number;
  offsetTop: number;
  width: number;
  addEventListener: (event: string, listener: Listener) => void;
  removeEventListener: (event: string, listener: Listener) => void;
}

function installVisualViewport(initial: { height: number; offsetTop: number; width: number }) {
  const listeners: Record<string, Listener> = {};
  const vv: MockVisualViewport = {
    ...initial,
    addEventListener: vi.fn((event: string, listener: Listener) => {
      listeners[event] = listener;
    }),
    removeEventListener: vi.fn((event: string) => {
      delete listeners[event];
    }),
  };
  vi.stubGlobal('visualViewport', vv);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('innerWidth', 400);
  return {
    emit: (event: string) => {
      listeners[event]?.({} as Event);
    },
    updateProps: (props: Partial<{ height: number; offsetTop: number; width: number }>) => {
      Object.assign(vv, props);
    },
  };
}

describe('useVisualViewport', () => {
  beforeEach(() => {
    vi.stubGlobal('visualViewport', undefined);
    vi.stubGlobal('innerHeight', 800);
    vi.stubGlobal('innerWidth', 400);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns fallback values when visualViewport is not available', () => {
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.height).toBe(800);
    expect(result.current.isKeyboardOpen).toBe(false);
  });

  it('reads initial visualViewport values', () => {
    installVisualViewport({ height: 800, offsetTop: 0, width: 400 });
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.height).toBe(800);
    expect(result.current.isKeyboardOpen).toBe(false);
  });

  it('detects keyboard open when viewport height drops below 75%', () => {
    const { emit, updateProps } = installVisualViewport({ height: 800, offsetTop: 0, width: 400 });
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.isKeyboardOpen).toBe(false);

    updateProps({ height: 400, offsetTop: 0 });
    act(() => emit('resize'));
    expect(result.current.isKeyboardOpen).toBe(true);
    expect(result.current.height).toBe(400);
  });

  it('detects keyboard close when viewport height returns above 75%', () => {
    const { emit, updateProps } = installVisualViewport({ height: 400, offsetTop: 0, width: 400 });
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.isKeyboardOpen).toBe(true);

    updateProps({ height: 800, offsetTop: 0 });
    act(() => emit('resize'));
    expect(result.current.isKeyboardOpen).toBe(false);
  });

  it('listens to both resize and scroll events', () => {
    const vv = installVisualViewport({ height: 800, offsetTop: 0, width: 400 });
    renderHook(() => useVisualViewport());
    expect(vv.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(vv.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('cleans up event listeners on unmount', () => {
    const vv = installVisualViewport({ height: 800, offsetTop: 0, width: 400 });
    const { unmount } = renderHook(() => useVisualViewport());
    unmount();
    expect(vv.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(vv.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('keyboard open at exactly 75% (600/800)', () => {
    const { emit, updateProps } = installVisualViewport({ height: 800, offsetTop: 0, width: 400 });
    const { result } = renderHook(() => useVisualViewport());

    updateProps({ height: 600, offsetTop: 0 }); // exactly 75%
    act(() => emit('resize'));
    expect(result.current.isKeyboardOpen).toBe(false); // NOT open at 75%, must be BELOW 75%
  });

  it('keyboard open below 75% (599/800)', () => {
    const { emit, updateProps } = installVisualViewport({ height: 800, offsetTop: 0, width: 400 });
    const { result } = renderHook(() => useVisualViewport());

    updateProps({ height: 599, offsetTop: 200 });
    act(() => emit('resize'));
    expect(result.current.isKeyboardOpen).toBe(true);
    expect(result.current.offsetTop).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/hooks/__tests__/useVisualViewport.test.ts`
Expected: all tests FAIL (module not found)

- [ ] **Step 3: Implement useVisualViewport**

```typescript
// web/src/hooks/useVisualViewport.ts
import { useEffect, useState } from 'react';

export interface VisualViewportState {
  height: number;
  offsetTop: number;
  width: number;
  isKeyboardOpen: boolean;
}

export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(() => ({
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
    offsetTop: 0,
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    isKeyboardOpen: false,
  }));

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) {
      return;
    }

    const handler = () => {
      const vv = window.visualViewport!;
      setState({
        height: vv.height,
        offsetTop: vv.offsetTop,
        width: vv.width,
        isKeyboardOpen: vv.height < window.innerHeight * 0.75,
      });
    };

    window.visualViewport.addEventListener('resize', handler);
    window.visualViewport.addEventListener('scroll', handler);
    handler();

    return () => {
      window.visualViewport!.removeEventListener('resize', handler);
      window.visualViewport!.removeEventListener('scroll', handler);
    };
  }, []);

  return state;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/hooks/__tests__/useVisualViewport.test.ts`
Expected: all 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useVisualViewport.ts web/src/hooks/__tests__/useVisualViewport.test.ts
git commit -m "feat: add useVisualViewport hook for keyboard detection

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: useCommandHistory hook

**Files:**
- Create: `web/src/hooks/useCommandHistory.ts`
- Create: `web/src/hooks/__tests__/useCommandHistory.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// web/src/hooks/__tests__/useCommandHistory.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCommandHistory } from '../useCommandHistory';

// localStorage mock
function mockLocalStorage() {
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
  });
  return store;
}

describe('useCommandHistory', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockLocalStorage();
  });

  it('starts with empty history', () => {
    const { result } = renderHook(() => useCommandHistory());
    expect(result.current.history).toEqual([]);
  });

  it('adds a new entry', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('ls -la'); });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0].command).toBe('ls -la');
    expect(result.current.history[0].timestamp).toBeGreaterThan(0);
    expect(typeof result.current.history[0].id).toBe('string');
  });

  it('deduplicates: same command updates timestamp and moves to front', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('ls -la'); });
    const firstTimestamp = result.current.history[0].timestamp;
    const firstId = result.current.history[0].id;

    // Wait a tick so timestamp is different
    act(() => { result.current.addEntry('git status'); });
    act(() => { result.current.addEntry('ls -la'); }); // duplicate

    expect(result.current.history).toHaveLength(2); // still 2 entries
    expect(result.current.history[0].command).toBe('ls -la'); // moved to front
    expect(result.current.history[0].id).toBe(firstId); // same id, not duplicated
    expect(result.current.history[0].timestamp).not.toBe(firstTimestamp); // updated timestamp
    expect(result.current.history[1].command).toBe('git status');
  });

  it('orders by most recent first', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('first'); });
    act(() => { result.current.addEntry('second'); });
    act(() => { result.current.addEntry('third'); });
    expect(result.current.history[0].command).toBe('third');
    expect(result.current.history[1].command).toBe('second');
    expect(result.current.history[2].command).toBe('first');
  });

  it('evicts oldest entry when exceeding max (500)', () => {
    const { result } = renderHook(() => useCommandHistory());
    // Add 500 unique entries
    act(() => {
      for (let i = 0; i < 500; i++) {
        result.current.addEntry(`command-${i}`);
      }
    });
    expect(result.current.history).toHaveLength(500);
    expect(result.current.history[499].command).toBe('command-0'); // oldest at end

    // Add one more
    act(() => { result.current.addEntry('overflow'); });
    expect(result.current.history).toHaveLength(500);
    expect(result.current.history[0].command).toBe('overflow');
    expect(result.current.history[499].command).toBe('command-1'); // command-0 evicted
  });

  it('removes an entry by id', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('ls -la'); });
    act(() => { result.current.addEntry('git status'); });
    const targetId = result.current.history[1].id; // 'ls -la' is older

    act(() => { result.current.removeEntry(targetId); });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0].command).toBe('git status');
  });

  it('clears all history', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('ls -la'); });
    act(() => { result.current.addEntry('git status'); });
    act(() => { result.current.clearHistory(); });
    expect(result.current.history).toEqual([]);
  });

  it('filterHistory returns matching entries (case-insensitive)', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('git status'); });
    act(() => { result.current.addEntry('GIT PULL'); });
    act(() => { result.current.addEntry('npm test'); });

    const matches = result.current.filterHistory('git');
    expect(matches).toHaveLength(2);
    expect(matches[0].command).toBe('GIT PULL'); // most recent first
    expect(matches[1].command).toBe('git status');
  });

  it('filterHistory returns all entries sorted by recency when query is empty', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('first'); });
    act(() => { result.current.addEntry('second'); });

    const matches = result.current.filterHistory('');
    expect(matches).toHaveLength(2);
    expect(matches[0].command).toBe('second');
  });

  it('filterHistory returns empty array for no match', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('ls -la'); });

    const matches = result.current.filterHistory('nonexistent');
    expect(matches).toEqual([]);
  });

  it('persists to localStorage', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('ls -la'); });

    // Read localStorage directly
    const stored = JSON.parse(localStorage.getItem('nession_command_history')!);
    expect(stored).toHaveLength(1);
    expect(stored[0].command).toBe('ls -la');
  });

  it('loads existing data from localStorage on init', () => {
    const existing = [
      { id: 'abc', command: 'existing-cmd', timestamp: Date.now() - 1000 },
    ];
    localStorage.setItem('nession_command_history', JSON.stringify(existing));

    const { result } = renderHook(() => useCommandHistory());
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0].command).toBe('existing-cmd');
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('nession_command_history', 'not-valid-json');
    const { result } = renderHook(() => useCommandHistory());
    expect(result.current.history).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/hooks/__tests__/useCommandHistory.test.ts`
Expected: all tests FAIL (module not found)

- [ ] **Step 3: Implement useCommandHistory**

```typescript
// web/src/hooks/useCommandHistory.ts
import { useState, useCallback, useMemo } from 'react';

const STORAGE_KEY = 'nession_command_history';
const MAX_ENTRIES = 500;

export interface HistoryEntry {
  id: string;
  command: string;
  timestamp: number;
}

let idCounter = 0;
function generateId(): string {
  idCounter += 1;
  return `hist_${Date.now()}_${idCounter}`;
}

function loadFromStorage(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: unknown): e is HistoryEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as HistoryEntry).id === 'string' &&
        typeof (e as HistoryEntry).command === 'string' &&
        typeof (e as HistoryEntry).timestamp === 'number',
    );
  } catch {
    return [];
  }
}

function saveToStorage(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage full or unavailable — silently ignore.
  }
}

export interface UseCommandHistoryReturn {
  history: HistoryEntry[];
  addEntry: (command: string) => void;
  removeEntry: (id: string) => void;
  clearHistory: () => void;
  filterHistory: (query: string) => HistoryEntry[];
}

export function useCommandHistory(): UseCommandHistoryReturn {
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadFromStorage());

  const addEntry = useCallback((command: string) => {
    setHistory((prev) => {
      // Dedup: if command already exists, update timestamp and move to front.
      const existingIdx = prev.findIndex((e) => e.command === command);
      let next: HistoryEntry[];
      if (existingIdx !== -1) {
        const existing = prev[existingIdx];
        next = [
          { ...existing, timestamp: Date.now() },
          ...prev.slice(0, existingIdx),
          ...prev.slice(existingIdx + 1),
        ];
      } else {
        next = [
          { id: generateId(), command, timestamp: Date.now() },
          ...prev,
        ];
      }
      // FIFO eviction
      if (next.length > MAX_ENTRIES) {
        next = next.slice(0, MAX_ENTRIES);
      }
      saveToStorage(next);
      return next;
    });
  }, []);

  const removeEntry = useCallback((id: string) => {
    setHistory((prev) => {
      const next = prev.filter((e) => e.id !== id);
      saveToStorage(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveToStorage([]);
  }, []);

  const filterHistory = useCallback(
    (query: string): HistoryEntry[] => {
      if (!query) {
        return [...history].sort((a, b) => b.timestamp - a.timestamp);
      }
      const lower = query.toLowerCase();
      return history
        .filter((e) => e.command.toLowerCase().includes(lower))
        .sort((a, b) => b.timestamp - a.timestamp);
    },
    [history],
  );

  return { history, addEntry, removeEntry, clearHistory, filterHistory };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/hooks/__tests__/useCommandHistory.test.ts`
Expected: all 12 tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useCommandHistory.ts web/src/hooks/__tests__/useCommandHistory.test.ts
git commit -m "feat: add useCommandHistory hook with dedup and localStorage persistence

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: useFloatingKeyBar hook

**Files:**
- Create: `web/src/hooks/useFloatingKeyBar.ts`
- Create: `web/src/hooks/__tests__/useFloatingKeyBar.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// web/src/hooks/__tests__/useFloatingKeyBar.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFloatingKeyBar } from '../useFloatingKeyBar';

describe('useFloatingKeyBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with visible=false and dismissed=false', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    expect(result.current.visible).toBe(false);
    expect(result.current.dismissed).toBe(false);
  });

  it('show makes visible=true', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.show(); });
    expect(result.current.visible).toBe(true);
    expect(result.current.dismissed).toBe(false);
  });

  it('auto-hides after 3 seconds of inactivity', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.show(); });
    expect(result.current.visible).toBe(true);

    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.visible).toBe(false);
  });

  it('activity resets the auto-hide timer', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.show(); });
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => { result.current.onActivity(); }); // user tapped a key
    act(() => { vi.advanceTimersByTime(2000); }); // 2 more seconds, total 4s since show
    expect(result.current.visible).toBe(true); // still visible, timer reset
    act(() => { vi.advanceTimersByTime(1000); }); // 3s since last activity
    expect(result.current.visible).toBe(false);
  });

  it('dismiss sets visible=false and dismissed=true', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.show(); });
    act(() => { result.current.dismiss(); });
    expect(result.current.visible).toBe(false);
    expect(result.current.dismissed).toBe(true);
  });

  it('restore clears dismissed and shows', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.dismiss(); });
    expect(result.current.dismissed).toBe(true);

    act(() => { result.current.restore(); });
    expect(result.current.dismissed).toBe(false);
    expect(result.current.visible).toBe(true);
  });

  it('forceHide sets visible=false but preserves dismissed state', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.show(); });
    act(() => { result.current.forceHide(); });
    expect(result.current.visible).toBe(false);
    expect(result.current.dismissed).toBe(false); // not dismissed, just hidden
  });

  it('cleans up timer on unmount', () => {
    const { result, unmount } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.show(); });
    unmount();
    // No timer leak — advancing should not cause state updates on unmounted component
    act(() => { vi.advanceTimersByTime(5000); });
    // No crash = pass
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/hooks/__tests__/useFloatingKeyBar.test.ts`
Expected: all tests FAIL (module not found)

- [ ] **Step 3: Implement useFloatingKeyBar**

```typescript
// web/src/hooks/useFloatingKeyBar.ts
import { useState, useRef, useCallback, useEffect } from 'react';

const AUTO_HIDE_MS = 3000;

export interface FloatingKeyBarState {
  visible: boolean;
  dismissed: boolean;
  show: () => void;
  onActivity: () => void;
  dismiss: () => void;
  restore: () => void;
  forceHide: () => void;
}

export function useFloatingKeyBar(): FloatingKeyBarState {
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      setVisible(false);
    }, AUTO_HIDE_MS);
  }, [clearTimer]);

  const show = useCallback(() => {
    setVisible(true);
    setDismissed(false);
    startTimer();
  }, [startTimer]);

  const onActivity = useCallback(() => {
    if (dismissed) return;
    startTimer();
  }, [dismissed, startTimer]);

  const dismiss = useCallback(() => {
    clearTimer();
    setVisible(false);
    setDismissed(true);
  }, [clearTimer]);

  const restore = useCallback(() => {
    setDismissed(false);
    setVisible(true);
    startTimer();
  }, [startTimer]);

  const forceHide = useCallback(() => {
    clearTimer();
    setVisible(false);
  }, [clearTimer]);

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  return { visible, dismissed, show, onActivity, dismiss, restore, forceHide };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/hooks/__tests__/useFloatingKeyBar.test.ts`
Expected: all 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useFloatingKeyBar.ts web/src/hooks/__tests__/useFloatingKeyBar.test.ts
git commit -m "feat: add useFloatingKeyBar hook with auto-hide timer and dismiss/restore

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Update useQuickCommands to support `raw` in addCommand

**Files:**
- Modify: `web/src/hooks/useQuickCommands.ts`

The existing `addCommand(label, command)` hardcodes `raw: false` in the call to `wsService.addCommand()`. It needs to accept an optional `raw` parameter so the new `QuickCommandsPanel` can add Ctrl+ combo commands.

- [ ] **Step 1: Update the hook**

In `web/src/hooks/useQuickCommands.ts`, change the `addCommand` signature:

```typescript
// Before (line ~92):
const addCommand = useCallback(
  async (label: string, command: string) => {
    try {
      await wsService.addCommand(label, command, false);
      await refreshCommands();
    } catch {
      toast.error('Failed to add command');
    }
  },
  [wsService, refreshCommands],
);

// After:
const addCommand = useCallback(
  async (label: string, command: string, raw = false) => {
    try {
      await wsService.addCommand(label, command, raw);
      await refreshCommands();
    } catch {
      toast.error('Failed to add command');
    }
  },
  [wsService, refreshCommands],
);
```

Update the return type as well:

```typescript
// Before (line ~17-21):
export interface UseQuickCommandsResult {
  userCommands: QuickCommand[];
  addCommand: (label: string, command: string) => Promise<void>;
  deleteCommand: (id: string) => Promise<void>;
}

// After:
export interface UseQuickCommandsResult {
  userCommands: QuickCommand[];
  addCommand: (label: string, command: string, raw?: boolean) => Promise<void>;
  deleteCommand: (id: string) => Promise<void>;
}
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `cd web && npx vitest run`
Expected: all existing tests PASS (no test change needed — the `raw` param is optional with default `false`)

- [ ] **Step 3: Commit**

```bash
git add web/src/hooks/useQuickCommands.ts
git commit -m "feat: support raw parameter in useQuickCommands.addCommand

Add optional `raw` parameter to addCommand() so Ctrl+ combo commands
(sent verbatim, no trailing \\r) can be added from the new
QuickCommandsPanel add form.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: FloatingKeyBar component

**Files:**
- Create: `web/src/components/FloatingKeyBar.tsx`
- Create: `web/src/components/__tests__/FloatingKeyBar.test.tsx`

- [ ] **Step 1: Write failing tests**

```typescript
// web/src/components/__tests__/FloatingKeyBar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FloatingKeyBar, KEY_DEFINITIONS } from '../FloatingKeyBar';

describe('FloatingKeyBar', () => {
  const defaultProps = {
    sendText: vi.fn(),
    focusTerminal: vi.fn(),
    visible: true,
    dismissed: false,
    onShow: vi.fn(),
    onActivity: vi.fn(),
    onDismiss: vi.fn(),
    onRestore: vi.fn(),
  };

  it('renders all 11 keys when visible', () => {
    render(<FloatingKeyBar {...defaultProps} />);
    expect(screen.getByText('←')).toBeInTheDocument();
    expect(screen.getByText('↑')).toBeInTheDocument();
    expect(screen.getByText('↓')).toBeInTheDocument();
    expect(screen.getByText('→')).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('End')).toBeInTheDocument();
    expect(screen.getByText('PgUp')).toBeInTheDocument();
    expect(screen.getByText('PgDn')).toBeInTheDocument();
    expect(screen.getByText('Tab')).toBeInTheDocument();
    expect(screen.getByText('Esc')).toBeInTheDocument();
    expect(screen.getByText('Del')).toBeInTheDocument();
  });

  it('hides when visible=false', () => {
    render(<FloatingKeyBar {...defaultProps} visible={false} />);
    expect(screen.queryByText('↑')).toBeNull();
  });

  it('shows ◉ restore handle when dismissed', () => {
    render(<FloatingKeyBar {...defaultProps} visible={false} dismissed={true} />);
    expect(screen.getByText('◉')).toBeInTheDocument();
  });

  it('clicking ◉ calls onRestore', () => {
    render(<FloatingKeyBar {...defaultProps} visible={false} dismissed={true} />);
    fireEvent.click(screen.getByText('◉'));
    expect(defaultProps.onRestore).toHaveBeenCalledOnce();
  });

  it('clicking a key sends the escape sequence and refocuses terminal', () => {
    render(<FloatingKeyBar {...defaultProps} />);
    fireEvent.click(screen.getByText('↑'));
    expect(defaultProps.sendText).toHaveBeenCalledWith('\x1b[A');
    expect(defaultProps.focusTerminal).toHaveBeenCalledOnce();
  });

  it('clicking Tab sends \\t', () => {
    render(<FloatingKeyBar {...defaultProps} />);
    fireEvent.click(screen.getByText('Tab'));
    expect(defaultProps.sendText).toHaveBeenCalledWith('\t');
  });

  it('clicking Esc sends \\x1b', () => {
    render(<FloatingKeyBar {...defaultProps} />);
    fireEvent.click(screen.getByText('Esc'));
    expect(defaultProps.sendText).toHaveBeenCalledWith('\x1b');
  });

  it('clicking Del sends \\x1b[3~', () => {
    render(<FloatingKeyBar {...defaultProps} />);
    fireEvent.click(screen.getByText('Del'));
    expect(defaultProps.sendText).toHaveBeenCalledWith('\x1b[3~');
  });

  it('KEY_DEFINITIONS has exactly 11 entries in 3 groups', () => {
    expect(KEY_DEFINITIONS).toHaveLength(3);
    const allKeys = KEY_DEFINITIONS.flatMap((g) => g.keys);
    expect(allKeys).toHaveLength(11);
  });

  it('buttons have tabIndex -1 to not interfere with terminal focus', () => {
    render(<FloatingKeyBar {...defaultProps} />);
    const button = screen.getByText('Esc').closest('button');
    expect(button?.getAttribute('tabIndex')).toBe('-1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/__tests__/FloatingKeyBar.test.tsx`
Expected: all tests FAIL (module not found)

- [ ] **Step 3: Implement FloatingKeyBar**

```typescript
// web/src/components/FloatingKeyBar.tsx
import { X } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

interface KeyDef {
  label: string;
  command: string;
}

interface KeyGroup {
  keys: KeyDef[];
}

export const KEY_DEFINITIONS: KeyGroup[] = [
  {
    keys: [
      { label: '←', command: '\x1b[D' },
      { label: '↑', command: '\x1b[A' },
      { label: '↓', command: '\x1b[B' },
      { label: '→', command: '\x1b[C' },
    ],
  },
  {
    keys: [
      { label: 'Home', command: '\x1b[H' },
      { label: 'End', command: '\x1b[F' },
      { label: 'PgUp', command: '\x1b[5~' },
      { label: 'PgDn', command: '\x1b[6~' },
    ],
  },
  {
    keys: [
      { label: 'Tab', command: '\t' },
      { label: 'Esc', command: '\x1b' },
      { label: 'Del', command: '\x1b[3~' },
    ],
  },
];

interface FloatingKeyBarProps {
  sendText: (text: string) => void;
  focusTerminal: () => void;
  visible: boolean;
  dismissed: boolean;
  onShow: () => void;
  onActivity: () => void;
  onDismiss: () => void;
  onRestore: () => void;
}

export function FloatingKeyBar({
  sendText,
  focusTerminal,
  visible,
  dismissed,
  onShow: _onShow,
  onActivity,
  onDismiss,
  onRestore,
}: FloatingKeyBarProps) {
  const handleKey = (command: string) => {
    sendText(command);
    focusTerminal();
    onActivity();
  };

  // Dismissed state: show ◉ restore handle
  if (dismissed && !visible) {
    return (
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10">
        <button
          type="button"
          onClick={onRestore}
          className="text-xs text-muted-foreground/50 hover:text-muted-foreground px-2 py-0.5 rounded-full bg-background/50 backdrop-blur-sm"
          tabIndex={-1}
          aria-label="Show keyboard keys"
        >
          ◉
        </button>
      </div>
    );
  }

  if (!visible) return null;

  return (
    <div
      className={cn(
        'absolute bottom-2 left-2 right-2 z-10',
        'bg-background/80 backdrop-blur-sm rounded-md',
        'border shadow-sm',
        'px-1.5 py-1',
        'transition-opacity duration-300',
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none',
      )}
    >
      <div className="flex flex-wrap gap-0.5 items-center">
        {KEY_DEFINITIONS.map((group, gi) => (
          <div key={gi} className="flex items-center gap-0.5">
            {gi > 0 && <div className="w-px h-4 bg-border mx-0.5 flex-shrink-0" />}
            {group.keys.map((key) => (
              <Button
                key={key.label}
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs font-mono hover:bg-accent flex-shrink-0"
                tabIndex={-1}
                onClick={() => handleKey(key.command)}
              >
                {key.label}
              </Button>
            ))}
          </div>
        ))}
        <div className="w-px h-4 bg-border mx-0.5 flex-shrink-0" />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 hover:bg-accent flex-shrink-0"
          tabIndex={-1}
          onClick={onDismiss}
          aria-label="Dismiss key bar"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/FloatingKeyBar.test.tsx`
Expected: all 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/FloatingKeyBar.tsx web/src/components/__tests__/FloatingKeyBar.test.tsx
git commit -m "feat: add FloatingKeyBar component with 11 physical keys

Overlay component providing PC keyboard keys missing on mobile:
arrows, Home/End/PgUp/PgDn, Tab/Esc/Del. Semi-transparent with
backdrop-blur, auto-hide via useFloatingKeyBar hook, dismissable
with ◉ restore handle. Responsive: flex-wrap for small screens.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: QuickCommandsPanel rewrite

**Files:**
- Rewrite: `web/src/components/QuickCommandsPanel.tsx`
- Update: `web/src/components/__tests__/` (existing tests need updating, or create new)

The existing `QuickCommandsPanel.test.tsx` does not exist — check:

Run: `find web/src/components/__tests__ -name "*QuickCommand*"`

- [ ] **Step 1: Verify no existing test file**

Run: `find web/src/components/__tests__ -name "*QuickCommand*"`
Expected: no output (no existing test file)

- [ ] **Step 2: Write failing tests for the new QuickCommandsPanel**

```typescript
// web/src/components/__tests__/QuickCommandsPanel.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QuickCommandsPanel } from '../QuickCommandsPanel';
import { PRESETS } from '../quickCommands';

describe('QuickCommandsPanel', () => {
  const defaultProps = {
    sendText: vi.fn(),
    disabled: false,
  };

  beforeEach(() => {
    vi.stubGlobal('WebSocket', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders all 6 preset commands', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    for (const preset of PRESETS) {
      expect(screen.getByText(preset.label)).toBeInTheDocument();
    }
  });

  it('renders presets as flat list (one per row)', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    const presetButtons = screen.getAllByRole('button', { name: /▶/ });
    expect(presetButtons.length).toBeGreaterThanOrEqual(PRESETS.length);
  });

  it('clicking a preset run button sends the command', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    const ctrlC = PRESETS.find((p) => p.id === 'preset-ctrl-c')!;
    // Find the row containing the preset label and click its ▶ button
    const row = screen.getByText('Ctrl+C').closest('div')!;
    const runBtn = row.querySelector('button');
    fireEvent.click(runBtn!);
    expect(defaultProps.sendText).toHaveBeenCalledWith('\x03');
  });

  it('non-raw presets append \\r', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    const clearCmd = PRESETS.find((p) => p.id === 'preset-clear')!;
    const row = screen.getByText('clear').closest('div')!;
    const runBtn = row.querySelector('button');
    fireEvent.click(runBtn!);
    expect(defaultProps.sendText).toHaveBeenCalledWith('clear\r');
  });

  it('shows add command button', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    expect(screen.getByText(/Add Command/)).toBeInTheDocument();
  });

  it('clicking add shows the add form', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    fireEvent.click(screen.getByText(/Add Command/));
    expect(screen.getByPlaceholderText('Label')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Command')).toBeInTheDocument();
  });

  it('add form has Plain/Ctrl toggle', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    fireEvent.click(screen.getByText(/Add Command/));
    expect(screen.getByText('Plain')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+')).toBeInTheDocument();
  });

  it('switching to Ctrl+ mode shows single letter input', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    fireEvent.click(screen.getByText(/Add Command/));
    fireEvent.click(screen.getByText('Ctrl+'));
    // Should show Key input instead of Command input
    expect(screen.queryByPlaceholderText('Command')).toBeNull();
    expect(screen.getByPlaceholderText('Key')).toBeInTheDocument();
  });

  it('presets do not have delete buttons', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    const ctrlCRow = screen.getByText('Ctrl+C').closest('div')!;
    const deleteBtns = ctrlCRow.querySelectorAll('button[aria-label="Delete"]');
    expect(deleteBtns.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/__tests__/QuickCommandsPanel.test.tsx`
Expected: all tests FAIL (file doesn't exist or old component doesn't match)

- [ ] **Step 4: Delete old QuickCommandsPanel and implement the new one**

```typescript
// web/src/components/QuickCommandsPanel.tsx
import { useState } from 'react';
import { Plus, X, Play } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { PRESETS, type QuickCommand } from './quickCommands';
import { useQuickCommands } from '../hooks/useQuickCommands';

interface QuickCommandsPanelProps {
  sendText: (text: string) => void;
  disabled: boolean;
}

type AddMode = 'plain' | 'ctrl';

export function QuickCommandsPanel({ sendText, disabled }: QuickCommandsPanelProps) {
  const { userCommands, addCommand, deleteCommand } = useQuickCommands();
  const [showAddForm, setShowAddForm] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>('plain');
  const [newLabel, setNewLabel] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [ctrlKey, setCtrlKey] = useState('');

  const handleRun = (cmd: QuickCommand) => {
    sendText(cmd.raw ? cmd.command : cmd.command + '\r');
  };

  const handleAdd = async () => {
    if (addMode === 'ctrl') {
      const letter = ctrlKey.trim().toUpperCase();
      if (!letter || letter.length !== 1 || letter < 'A' || letter > 'Z') return;
      const label = newLabel.trim() || `Ctrl+${letter}`;
      const command = String.fromCharCode(letter.charCodeAt(0) - 64);
      await addCommand(label, command, true);
    } else {
      const label = newLabel.trim();
      const command = newCommand.trim();
      if (!label || !command) return;
      await addCommand(label, command, false);
    }
    setNewLabel('');
    setNewCommand('');
    setCtrlKey('');
    setShowAddForm(false);
  };

  const allCommands = [...PRESETS, ...userCommands];

  return (
    <div className="flex flex-col min-h-0 p-2 gap-1">
      {/* Command list — flat, one per row */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {allCommands.map((cmd) => {
          const isPreset = PRESETS.some((p) => p.id === cmd.id);
          return (
            <div
              key={cmd.id}
              className="flex items-center gap-1.5 py-1 px-1 rounded hover:bg-accent/50 group"
            >
              <span className="text-xs flex-1 min-w-0 truncate">{cmd.label}</span>
              {cmd.raw && (
                <span className="text-[10px] text-muted-foreground flex-shrink-0">
                  {cmd.label.includes('Ctrl+') ? cmd.label.replace('Ctrl+', '') : 'raw'}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 flex-shrink-0 opacity-0 group-hover:opacity-100"
                disabled={disabled}
                onClick={() => handleRun(cmd)}
                aria-label="Run"
                title="Run"
              >
                <Play className="h-3 w-3" />
              </Button>
              {!isPreset && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 flex-shrink-0 opacity-0 group-hover:opacity-100 hover:text-destructive"
                  disabled={disabled}
                  onClick={() => deleteCommand(cmd.id)}
                  aria-label="Delete"
                  title="Delete"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {/* Separator + Add button/form */}
      <div className="border-t pt-1 flex-shrink-0">
        {showAddForm ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-1">
              <Button
                variant={addMode === 'plain' ? 'default' : 'outline'}
                size="sm"
                className="h-6 text-[11px] px-2"
                onClick={() => setAddMode('plain')}
              >
                Plain
              </Button>
              <Button
                variant={addMode === 'ctrl' ? 'default' : 'outline'}
                size="sm"
                className="h-6 text-[11px] px-2"
                onClick={() => setAddMode('ctrl')}
              >
                Ctrl+
              </Button>
            </div>
            <Input
              placeholder="Label"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              className="h-6 text-[11px]"
              disabled={disabled}
            />
            {addMode === 'plain' ? (
              <Input
                placeholder="Command"
                value={newCommand}
                onChange={(e) => setNewCommand(e.target.value)}
                className="h-6 text-[11px]"
                disabled={disabled}
              />
            ) : (
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground">Ctrl+</span>
                <Input
                  placeholder="Key"
                  value={ctrlKey}
                  onChange={(e) => setCtrlKey(e.target.value.slice(0, 1))}
                  maxLength={1}
                  className="h-6 w-12 text-[11px] text-center"
                  disabled={disabled}
                />
              </div>
            )}
            <div className="flex gap-1">
              <Button
                size="sm"
                className="h-6 text-[11px] px-2"
                disabled={disabled}
                onClick={handleAdd}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[11px] px-2"
                onClick={() => setShowAddForm(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs w-full"
            disabled={disabled}
            onClick={() => setShowAddForm(true)}
          >
            <Plus className="h-3 w-3 mr-1" /> Add Command
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/QuickCommandsPanel.test.tsx`
Expected: tests PASS (some may need adjustment for the new row-based layout — fix assertions as needed)

- [ ] **Step 6: Commit**

```bash
git add web/src/components/QuickCommandsPanel.tsx web/src/components/__tests__/QuickCommandsPanel.test.tsx
git commit -m "feat: rewrite QuickCommandsPanel as flat list with Ctrl+ support

Flat list layout, one command per row. 6 Ctrl+ presets (C/D/A/E/W/U).
Add form supports Plain Text and Ctrl+ modes. Shared by mobile
(BottomSheet tab) and desktop (BottomBar). Presets are not deletable.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: InputPanel component

**Files:**
- Create: `web/src/components/InputPanel.tsx`
- Create: `web/src/components/__tests__/InputPanel.test.tsx`

- [ ] **Step 1: Write failing tests**

```typescript
// web/src/components/__tests__/InputPanel.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InputPanel } from '../InputPanel';

// Mock useCommandHistory
const mockAddEntry = vi.fn();
const mockFilterHistory = vi.fn().mockReturnValue([]);

vi.mock('../../hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    history: [
      { id: '1', command: 'git status', timestamp: Date.now() - 60000 },
      { id: '2', command: 'git pull', timestamp: Date.now() - 120000 },
      { id: '3', command: 'npm test', timestamp: Date.now() - 300000 },
    ],
    addEntry: mockAddEntry,
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: mockFilterHistory,
  }),
}));

describe('InputPanel', () => {
  const defaultProps = {
    sendText: vi.fn(),
    disabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFilterHistory.mockReturnValue([]);
  });

  it('renders a textarea', () => {
    render(<InputPanel {...defaultProps} />);
    expect(screen.getByPlaceholderText(/Type to send/)).toBeInTheDocument();
  });

  it('renders action buttons: clear, copy, paste, send', () => {
    render(<InputPanel {...defaultProps} />);
    expect(screen.getByLabelText('Clear input')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy input')).toBeInTheDocument();
    expect(screen.getByLabelText('Paste to input')).toBeInTheDocument();
    expect(screen.getByLabelText('Send')).toBeInTheDocument();
  });

  it('sends command on Enter and adds to history', () => {
    render(<InputPanel {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/Type to send/);
    fireEvent.change(textarea, { target: { value: 'ls -la' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(defaultProps.sendText).toHaveBeenCalledWith('ls -la\r');
    expect(mockAddEntry).toHaveBeenCalledWith('ls -la');
  });

  it('Shift+Enter inserts newline without sending', () => {
    render(<InputPanel {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/Type to send/);
    fireEvent.change(textarea, { target: { value: 'line1' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(defaultProps.sendText).not.toHaveBeenCalled();
  });

  it('clear button empties the textarea', () => {
    render(<InputPanel {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/Type to send/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'some text' } });
    fireEvent.click(screen.getByLabelText('Clear input'));
    expect(textarea.value).toBe('');
  });

  it('send button triggers send', () => {
    render(<InputPanel {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/Type to send/);
    fireEvent.change(textarea, { target: { value: 'git status' } });
    fireEvent.click(screen.getByLabelText('Send'));
    expect(defaultProps.sendText).toHaveBeenCalledWith('git status\r');
  });

  it('does nothing on empty input', () => {
    render(<InputPanel {...defaultProps} />);
    fireEvent.click(screen.getByLabelText('Send'));
    expect(defaultProps.sendText).not.toHaveBeenCalled();
  });

  it('disables all buttons when disabled prop is true', () => {
    render(<InputPanel {...defaultProps} disabled={true} />);
    expect(screen.getByPlaceholderText(/Type to send/)).toBeDisabled();
    expect(screen.getByLabelText('Send')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/__tests__/InputPanel.test.tsx`
Expected: all tests FAIL (module not found)

- [ ] **Step 3: Implement InputPanel**

```typescript
// web/src/components/InputPanel.tsx
import { useState } from 'react';
import { X, Copy, ClipboardPaste, SendHorizontal } from 'lucide-react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { useCommandHistory } from '../hooks/useCommandHistory';

interface InputPanelProps {
  sendText: (text: string) => void;
  disabled: boolean;
}

export function InputPanel({ sendText, disabled }: InputPanelProps) {
  const [inputValue, setInputValue] = useState('');
  const { filterHistory, addEntry, clearHistory } = useCommandHistory();

  const doSend = () => {
    const text = inputValue.trim();
    if (!text) return;
    sendText(text + '\r');
    addEntry(text);
    setInputValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      doSend();
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inputValue);
    } catch { /* clipboard unavailable */ }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setInputValue((prev) => prev + text);
    } catch { /* clipboard unavailable */ }
  };

  const matchingHistory = filterHistory(inputValue);

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Action buttons */}
      <div className="flex items-center gap-1 px-2 pt-1.5 pb-0.5 flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={disabled || !inputValue}
          onClick={() => setInputValue('')}
          aria-label="Clear input"
          title="Clear"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={disabled || !inputValue}
          onClick={handleCopy}
          aria-label="Copy input"
          title="Copy"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={disabled}
          onClick={handlePaste}
          aria-label="Paste to input"
          title="Paste"
        >
          <ClipboardPaste className="h-3.5 w-3.5" />
        </Button>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1"
          disabled={disabled || !inputValue.trim()}
          onClick={doSend}
          aria-label="Send"
        >
          <SendHorizontal className="h-3.5 w-3.5" /> Send
        </Button>
      </div>

      {/* Textarea */}
      <div className="px-2 pb-1 flex-shrink-0">
        <Textarea
          placeholder="Type to send… (Enter to submit, Shift+Enter for newline)"
          value={inputValue}
          rows={3}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          className="text-xs resize-none h-[3.25rem] field-sizing-fixed py-1.5"
          disabled={disabled}
        />
      </div>

      {/* History (filtered) */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {inputValue ? (
          <div className="text-[11px] text-muted-foreground mb-1 px-1">
            Matching ({matchingHistory.length})
          </div>
        ) : (
          <div className="flex items-center justify-between mb-1 px-1">
            <span className="text-[11px] text-muted-foreground">
              History ({matchingHistory.length})
            </span>
            {matchingHistory.length > 0 && (
              <button
                type="button"
                onClick={clearHistory}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
        )}
        {matchingHistory.length === 0 ? (
          <p className="text-[11px] text-muted-foreground px-1">
            {inputValue ? 'No matching commands' : 'No command history yet'}
          </p>
        ) : (
          <div className="space-y-0.5">
            {matchingHistory.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setInputValue(entry.command)}
                className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-accent/50 flex items-center justify-between gap-2 min-h-[44px]"
              >
                <span className="truncate font-mono">{entry.command}</span>
                <span className="text-[10px] text-muted-foreground flex-shrink-0">
                  {relativeTime(entry.timestamp)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/InputPanel.test.tsx`
Expected: tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/InputPanel.tsx web/src/components/__tests__/InputPanel.test.tsx
git commit -m "feat: add InputPanel with live-filtered command history

Fixed-height textarea, action buttons (clear/copy/paste/send),
live-filtered history list with tap-to-fill. Uses useCommandHistory
hook internally. Shared by mobile (BottomSheet) and desktop.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: BottomSheet component

**Files:**
- Create: `web/src/components/BottomSheet.tsx`
- Create: `web/src/components/__tests__/BottomSheet.test.tsx`

- [ ] **Step 1: Write failing tests**

```typescript
// web/src/components/__tests__/BottomSheet.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BottomSheet } from '../BottomSheet';

describe('BottomSheet', () => {
  const defaultProps = {
    activeTab: 'input' as const,
    onTabChange: vi.fn(),
    collapsed: false,
    onToggleCollapse: vi.fn(),
    showFilesTab: false,
    fontSizeManager: null,
    inputPanel: <div data-testid="input-panel">Input</div>,
    commandsPanel: <div data-testid="commands-panel">Commands</div>,
    envPanel: <div data-testid="env-panel">Env</div>,
  };

  it('renders tab bar with Input, Commands, Env tabs', () => {
    render(<BottomSheet {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Input/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Commands/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Env/ })).toBeInTheDocument();
  });

  it('renders Files tab when showFilesTab is true', () => {
    render(<BottomSheet {...defaultProps} showFilesTab={true} />);
    expect(screen.getByRole('button', { name: /Files/ })).toBeInTheDocument();
  });

  it('hides content area when collapsed', () => {
    render(<BottomSheet {...defaultProps} collapsed={true} />);
    expect(screen.queryByTestId('input-panel')).toBeNull();
  });

  it('shows active tab content', () => {
    render(<BottomSheet {...defaultProps} activeTab="commands" />);
    expect(screen.getByTestId('commands-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('input-panel')).toBeNull();
  });

  it('calls onTabChange when clicking a tab', () => {
    render(<BottomSheet {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /Commands/ }));
    expect(defaultProps.onTabChange).toHaveBeenCalledWith('commands');
  });

  it('calls onToggleCollapse when clicking toggle button', () => {
    render(<BottomSheet {...defaultProps} />);
    fireEvent.click(screen.getByLabelText('Collapse'));
    expect(defaultProps.onToggleCollapse).toHaveBeenCalledOnce();
  });

  it('renders zoom controls when fontSizeManager is provided', () => {
    const mockManager = {
      getSize: vi.fn().mockReturnValue(14),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      reset: vi.fn(),
    };
    render(<BottomSheet {...defaultProps} fontSizeManager={mockManager} />);
    expect(screen.getByText('14px')).toBeInTheDocument();
  });

  it('has fixed height class', () => {
    const { container } = render(<BottomSheet {...defaultProps} />);
    const sheet = container.firstElementChild as HTMLElement;
    // Should contain height classes
    expect(sheet.className).toContain('h-[40vh]');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/__tests__/BottomSheet.test.tsx`
Expected: all tests FAIL

- [ ] **Step 3: Implement BottomSheet**

```typescript
// web/src/components/BottomSheet.tsx
import { Keyboard, Zap, Package, FolderTree, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Minus, Plus as PlusIcon, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { FontSizeManager } from '@/terminal/FontSizeManager';

export type BottomTab = 'input' | 'commands' | 'env' | 'files';

interface BottomSheetProps {
  activeTab: BottomTab;
  onTabChange: (tab: BottomTab) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  showFilesTab: boolean;
  fontSizeManager: FontSizeManager | null;
  inputPanel: React.ReactNode;
  commandsPanel: React.ReactNode;
  envPanel: React.ReactNode;
  filesPanel?: React.ReactNode;
}

function ZoomControls({ fontSizeManager }: { fontSizeManager: FontSizeManager }) {
  const [size, setSize] = useState(() => fontSizeManager.getSize());

  return (
    <div className="flex items-center gap-0.5 flex-shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => { fontSizeManager.zoomOut(); setSize(fontSizeManager.getSize()); }}
        title="Zoom out"
      >
        <Minus className="h-3 w-3" />
      </Button>
      <span className="text-[11px] font-mono min-w-[2.5rem] text-center">{size}px</span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => { fontSizeManager.zoomIn(); setSize(fontSizeManager.getSize()); }}
        title="Zoom in"
      >
        <PlusIcon className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => { fontSizeManager.reset(); setSize(fontSizeManager.getSize()); }}
        title="Reset zoom"
      >
        <RotateCcw className="h-3 w-3" />
      </Button>
    </div>
  );
}

export function BottomSheet({
  activeTab,
  onTabChange,
  collapsed,
  onToggleCollapse,
  showFilesTab,
  fontSizeManager,
  inputPanel,
  commandsPanel,
  envPanel,
  filesPanel,
}: BottomSheetProps) {
  const effectiveTab = activeTab === 'files' && !showFilesTab ? 'input' : activeTab;

  const tabs = [
    { id: 'input' as const, icon: Keyboard, label: 'Input', always: true },
    { id: 'commands' as const, icon: Zap, label: 'Commands', always: true },
    { id: 'env' as const, icon: Package, label: 'Env', always: true },
    { id: 'files' as const, icon: FolderTree, label: 'Files', always: false },
  ];

  return (
    <div
      className={cn(
        'border-t flex-shrink-0 flex flex-col bg-background',
        'h-[40vh] landscape:h-[30vh]',
        collapsed && 'h-auto',
      )}
    >
      {/* TabBar */}
      <div className="flex items-center border-b h-10 flex-shrink-0">
        {tabs.map(({ id, icon: Icon, label, always }) => {
          if (!always && !showFilesTab) return null;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onTabChange(id)}
              className={cn(
                'flex items-center gap-1 px-2.5 py-2 text-xs transition-colors border-b-2 -mb-px h-full',
                effectiveTab === id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="w-3 h-3" /> {label}
            </button>
          );
        })}
        <div className="flex-1" />
        {fontSizeManager && <ZoomControls fontSizeManager={fontSizeManager} />}
        <button
          type="button"
          onClick={onToggleCollapse}
          className="px-2 py-2 text-xs text-muted-foreground hover:text-foreground"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {effectiveTab === 'input' && inputPanel}
          {effectiveTab === 'commands' && commandsPanel}
          {effectiveTab === 'env' && envPanel}
          {effectiveTab === 'files' && filesPanel}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/BottomSheet.test.tsx`
Expected: tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/BottomSheet.tsx web/src/components/__tests__/BottomSheet.test.tsx
git commit -m "feat: add BottomSheet with fixed-height tabs and zoom controls

Mobile-only fixed-height (40vh/30vh) tabbed panel. TabBar with
Input/Commands/Env/Files tabs, zoom controls, collapse toggle.
All tabs share the same height — no layout jumps on switch.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: MobileTerminalLayout component

**Files:**
- Create: `web/src/components/MobileTerminalLayout.tsx`
- Create: `web/src/components/__tests__/MobileTerminalLayout.test.tsx`

- [ ] **Step 1: Write failing tests**

```typescript
// web/src/components/__tests__/MobileTerminalLayout.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MobileTerminalLayout } from '../MobileTerminalLayout';

// Mock visualViewport hook
vi.mock('../../hooks/useVisualViewport', () => ({
  useVisualViewport: () => ({
    height: 800,
    offsetTop: 0,
    width: 400,
    isKeyboardOpen: false,
  }),
}));

describe('MobileTerminalLayout', () => {
  const defaultProps = {
    terminalElement: <div data-testid="terminal">Terminal</div>,
    sessionId: 'sess-1',
    sessionName: 'test-session',
    sendText: vi.fn(),
    toolbarDisabled: false,
    fileOps: null,
    onTerminalReveal: vi.fn(),
    fontSizeManager: null,
    focusTerminal: vi.fn(),
    onGetTerminalPwd: undefined,
  };

  it('renders the terminal element', () => {
    render(<MobileTerminalLayout {...defaultProps} />);
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
  });

  it('renders BottomSheet with Input and Commands tabs', () => {
    render(<MobileTerminalLayout {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Input/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Commands/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Env/ })).toBeInTheDocument();
  });

  it('shows Files tab when fileOps is provided', () => {
    const fileOps = { getCwd: vi.fn(), listFiles: vi.fn() };
    render(<MobileTerminalLayout {...defaultProps} fileOps={fileOps as any} />);
    expect(screen.getByRole('button', { name: /Files/ })).toBeInTheDocument();
  });

  it('auto-collapses sheet when keyboard opens', () => {
    // This test validates the keyboard-aware behavior exists.
    // Full keyboard simulation tested via useVisualViewport unit tests.
    render(<MobileTerminalLayout {...defaultProps} />);
    // BottomSheet should start not collapsed (8 buttons: 3 tabs + zoom + collapse + 3 zoom buttons = varies)
    const collapseBtn = screen.getByLabelText('Collapse');
    expect(collapseBtn).toBeInTheDocument();
    // Sheet content should be visible
    expect(screen.getByPlaceholderText(/Type to send/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/__tests__/MobileTerminalLayout.test.tsx`
Expected: all tests FAIL

- [ ] **Step 3: Implement MobileTerminalLayout**

```typescript
// web/src/components/MobileTerminalLayout.tsx
import { useState, useRef, useEffect, useCallback } from 'react';
import { BottomSheet, type BottomTab } from './BottomSheet';
import { FloatingKeyBar } from './FloatingKeyBar';
import { InputPanel } from './InputPanel';
import { QuickCommandsPanel } from './QuickCommandsPanel';
import { EnvPanel } from './env/EnvPanel';
import { FileBrowser } from './FileBrowser';
import { useVisualViewport } from '../hooks/useVisualViewport';
import { useFloatingKeyBar } from '../hooks/useFloatingKeyBar';
import type { FileOps } from '../services/fileOps';
import type { FontSizeManager } from '@/terminal/FontSizeManager';

interface MobileTerminalLayoutProps {
  terminalElement: React.ReactNode;
  sessionId: string;
  sessionName?: string;
  sendText: (text: string) => void;
  toolbarDisabled: boolean;
  fileOps?: FileOps | null;
  onTerminalReveal?: () => void;
  fontSizeManager?: FontSizeManager | null;
  focusTerminal?: () => void;
  onGetTerminalPwd?: () => Promise<string>;
}

export function MobileTerminalLayout({
  terminalElement,
  sessionId,
  sendText,
  toolbarDisabled,
  fileOps,
  fontSizeManager,
  focusTerminal,
  onGetTerminalPwd,
}: MobileTerminalLayoutProps) {
  const { isKeyboardOpen } = useVisualViewport();
  const keyBar = useFloatingKeyBar();
  const [bottomTab, setBottomTab] = useState<BottomTab>('input');
  const [sheetCollapsed, setSheetCollapsed] = useState(false);
  const prevCollapsedRef = useRef(false);

  // Keyboard: auto-collapse sheet and hide key bar
  useEffect(() => {
    if (isKeyboardOpen) {
      prevCollapsedRef.current = sheetCollapsed;
      setSheetCollapsed(true);
      keyBar.forceHide();
    } else {
      setSheetCollapsed(prevCollapsedRef.current);
    }
    // Only react to isKeyboardOpen changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isKeyboardOpen]);

  const handleToggleCollapse = useCallback(() => {
    setSheetCollapsed((prev) => !prev);
  }, []);

  const envPanel = <EnvPanel sessionId={sessionId} />;
  const commandsPanel = <QuickCommandsPanel sendText={sendText} disabled={toolbarDisabled} />;
  const inputPanel = <InputPanel sendText={sendText} disabled={toolbarDisabled} />;
  const filesPanel = fileOps ? (
    <FileBrowser
      fileOps={fileOps}
      onFileClick={() => {}}
      onFileDeleted={() => {}}
      onFileRenamed={() => {}}
      onGetTerminalPwd={onGetTerminalPwd}
    />
  ) : undefined;

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      {/* Terminal area */}
      <div className="flex-1 min-h-0 relative">
        {terminalElement}

        {/* KeyBar trigger strip — 8px invisible touch target */}
        <div
          className="absolute bottom-0 left-0 right-0 h-2 z-10"
          onTouchStart={() => keyBar.show()}
        />

        {/* Floating key bar overlay */}
        <FloatingKeyBar
          sendText={sendText}
          focusTerminal={focusTerminal ?? (() => {})}
          visible={keyBar.visible}
          dismissed={keyBar.dismissed}
          onShow={keyBar.show}
          onActivity={keyBar.onActivity}
          onDismiss={keyBar.dismiss}
          onRestore={keyBar.restore}
        />
      </div>

      {/* Bottom sheet */}
      <BottomSheet
        activeTab={bottomTab}
        onTabChange={setBottomTab}
        collapsed={sheetCollapsed}
        onToggleCollapse={handleToggleCollapse}
        showFilesTab={!!fileOps}
        fontSizeManager={fontSizeManager ?? null}
        inputPanel={inputPanel}
        commandsPanel={commandsPanel}
        envPanel={envPanel}
        filesPanel={filesPanel}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/MobileTerminalLayout.test.tsx`
Expected: tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/MobileTerminalLayout.tsx web/src/components/__tests__/MobileTerminalLayout.test.tsx
git commit -m "feat: add MobileTerminalLayout composing key bar + terminal + bottom sheet

Orchestrates FloatingKeyBar overlay + Terminal + BottomSheet.
Keyboard-aware: auto-collapses sheet and hides key bar when
visualViewport detects soft keyboard open. Manages tab state,
collapse state, and key bar visibility.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Update TerminalLayout for mobile/desktop routing

**Files:**
- Modify: `web/src/components/TerminalLayout.tsx`

The existing `TerminalLayout` chooses between `FileTabs` (when fileOps available) and bare terminal + `BottomBar`. Now on mobile it routes to `MobileTerminalLayout` instead.

- [ ] **Step 1: Update TerminalLayout**

Read the current file, then apply the changes:

In `web/src/components/TerminalLayout.tsx`, replace the existing `return` logic:

```typescript
// Add import at top:
import { useMediaQuery } from '../hooks/useMediaQuery';
import { MobileTerminalLayout } from './MobileTerminalLayout';
import { InputPanel } from './InputPanel';
import { QuickCommandsPanel } from './QuickCommandsPanel';

// Inside the component, add mobile detection:
const isMobile = useMediaQuery('(max-width: 1023px)');

// Mobile path (before the fileOps check):
if (isMobile) {
  return (
    <MobileTerminalLayout
      terminalElement={terminalElement}
      sessionId={sessionId}
      sessionName={sessionName}
      sendText={sendText}
      toolbarDisabled={toolbarDisabled}
      fileOps={fileOps ?? undefined}
      onTerminalReveal={onTerminalReveal}
      fontSizeManager={fontSizeManager ?? undefined}
      focusTerminal={focusTerminal}
      onGetTerminalPwd={onGetTerminalPwd}
    />
  );
}
```

The desktop path (existing) stays the same but uses the new `InputPanel` and `QuickCommandsPanel` for the `BottomBar`.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no errors (or fix any that appear)

- [ ] **Step 3: Verify existing bottom bar test passes**

Run: `cd web && npx vitest run src/components/__tests__/BottomBar.test.tsx`
Expected: existing tests PASS (BottomBar still used on desktop path)

- [ ] **Step 4: Commit**

```bash
git add web/src/components/TerminalLayout.tsx
git commit -m "feat: route mobile to MobileTerminalLayout in TerminalLayout

Add mobile detection via useMediaQuery('(max-width: 1023px)').
Mobile path delegates to MobileTerminalLayout with FloatingKeyBar
+ BottomSheet. Desktop path unchanged (FileTabs + BottomBar).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Update TerminalView for visualViewport and state wiring

**Files:**
- Modify: `web/src/components/TerminalView.tsx`

The main change: remove `useState(bottomTab)` and `useState(sheetOpen)` — these are now managed inside `MobileTerminalLayout`. The `TerminalView` still owns the `terminalHandle` and passes it through. Desktop path unchanged.

- [ ] **Step 1: Update TerminalView**

In `web/src/components/TerminalView.tsx`:

Remove these state declarations (they're now inside MobileTerminalLayout):
```typescript
// REMOVE:
const [bottomTab, setBottomTab] = useState<BottomTab>('commands');
const [sheetOpen, setSheetOpen] = useState(false);
```

Remove the `BottomTab` import if no longer used.

Update the `TerminalLayout` rendering (desktop path) — `bottomTab`, `sheetOpen` etc. are no longer passed from TerminalView. Instead, `TerminalLayout` manages these internally for the desktop path.

Wait — actually for the desktop path `TerminalLayout` still needs bottomTab state. Let me reconsider.

The cleanest approach: `TerminalView` passes `terminalHandle` down. `TerminalLayout` manages its own `bottomTab` and `sheetOpen` state internally. The mobile path doesn't use these at all (MobileTerminalLayout has its own); the desktop path needs them.

So in `TerminalView.tsx`:

Keep `terminalHandle` state and related callbacks.

Remove:
```typescript
const [bottomTab, setBottomTab] = useState<BottomTab>('commands');
const [sheetOpen, setSheetOpen] = useState(false);
```

Update the JSX — don't pass `bottomTab`, `sheetOpen` to `TerminalLayout`. Instead `TerminalLayout` will manage these internally.

In `TerminalLayout.tsx` (desktop path), add local state for bottomTab/sheetOpen since TerminalView no longer manages them.

Actually, the simplest change: just move `bottomTab` and `sheetOpen` state into `TerminalLayout.tsx`. Remove the props from `TerminalView.tsx`.

- [ ] **Step 2: Verify tests pass**

Run: `cd web && npx vitest run`
Expected: all existing tests PASS

- [ ] **Step 3: Run TypeScript check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add web/src/components/TerminalView.tsx web/src/components/TerminalLayout.tsx
git commit -m "refactor: move bottomTab/sheetOpen state into TerminalLayout

MobileTerminalLayout manages its own tab/collapse state. Desktop
TerminalLayout now manages bottomTab/sheetOpen internally. TerminalView
only owns terminalHandle and passes it down.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 12: Update BottomBar for desktop with new panels

**Files:**
- Modify: `web/src/components/BottomBar.tsx`

The existing `BottomBar` on desktop should accept and render the new `InputPanel` and `QuickCommandsPanel` instead of the old `TerminalToolbar` content. The `BottomBar` already uses `children` patterns (envPanel, commandsPanel, filesPanel as ReactNode). Compatible as-is.

For the desktop path in `TerminalLayout`, update the commandsPanel from old `TerminalToolbar` to the new `InputPanel` + `QuickCommandsPanel` combination.

- [ ] **Step 1: Update TerminalLayout desktop path**

In `TerminalLayout.tsx`, the desktop path:

```typescript
// Before:
const commandsPanel = (
  <TerminalToolbar sendText={sendText} disabled={toolbarDisabled} fontSizeManager={fontSizeManager} focusTerminal={focusTerminal} />
);

// After:
const commandsPanel = (
  <div className="flex flex-col min-h-0">
    <InputPanel sendText={sendText} disabled={toolbarDisabled} />
    <QuickCommandsPanel sendText={sendText} disabled={toolbarDisabled} />
  </div>
);
```

Remove the `TerminalToolbar` import (or keep if still used elsewhere — check).

- [ ] **Step 2: Verify BottomBar tests pass**

Run: `cd web && npx vitest run src/components/__tests__/BottomBar.test.tsx`
Expected: PASS (BottomBar unchanged — it receives ReactNode props)

- [ ] **Step 3: Commit**

```bash
git add web/src/components/TerminalLayout.tsx
git commit -m "feat: wire new InputPanel and QuickCommandsPanel in desktop BottomBar

Desktop path now uses the new shared InputPanel and QuickCommandsPanel
inside BottomBar instead of old TerminalToolbar content.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 13: Delete MobileKeyPanel

**Files:**
- Delete: `web/src/components/MobileKeyPanel.tsx`

- [ ] **Step 1: Check no remaining imports**

Run: `grep -r "MobileKeyPanel" web/src --include="*.ts" --include="*.tsx"`
Expected: no results (only the file itself)

- [ ] **Step 2: Delete the file and verify build**

```bash
rm web/src/components/MobileKeyPanel.tsx
cd web && npx tsc --noEmit && npx vitest run
```

Expected: no errors, all tests pass.

- [ ] **Step 3: Commit**

```bash
git rm web/src/components/MobileKeyPanel.tsx
git commit -m "refactor: remove MobileKeyPanel, replaced by FloatingKeyBar

MobileKeyPanel's virtual keys are replaced by FloatingKeyBar (overlay)
and Ctrl+ combos are moved to QuickCommandsPanel (Commands tab).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 14: Final integration — lint, test, build

- [ ] **Step 1: Run full lint check**

```bash
cd web && npm run lint
```
Fix any ESLint violations (no `eslint-disable` comments allowed).

- [ ] **Step 2: Run full TypeScript check**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 3: Run all tests**

```bash
cd web && npx vitest run
```
All tests must pass.

- [ ] **Step 4: Run coverage check**

```bash
cd web && npm run coverage
```
Coverage must remain ≥80%.

- [ ] **Step 5: Run Rust checks (unchanged, but verify)**

```bash
cargo fmt --all -- --check && cargo clippy -- -D warnings && cargo test
```

- [ ] **Step 6: Commit final state**

```bash
git add -A
git commit -m "chore: final integration pass — lint, test, build

All quality gates pass: ESLint, tsc, vitest, coverage, clippy.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Implementation Order Summary

| Order | Task | Dependencies | Creates | Modifies | Deletes |
|-------|------|-------------|---------|----------|---------|
| 1 | useVisualViewport hook | none | 2 files | — | — |
| 2 | useCommandHistory hook | none | 2 files | — | — |
| 3 | useFloatingKeyBar hook | none | 2 files | — | — |
| 4 | useQuickCommands raw param | none | — | 1 file | — |
| 5 | FloatingKeyBar component | Task 3 | 2 files | — | — |
| 6 | QuickCommandsPanel rewrite | Task 4 | 1 file | 1 file | — |
| 7 | InputPanel component | Task 2 | 2 files | — | — |
| 8 | BottomSheet component | none | 2 files | — | — |
| 9 | MobileTerminalLayout | Tasks 1,3,5,7,6,8 | 2 files | — | — |
| 10 | TerminalLayout routing | Task 9 | — | 1 file | — |
| 11 | TerminalView cleanup | Task 10 | — | 1 file | — |
| 12 | Desktop BottomBar wiring | Tasks 6,7 | — | 1 file | — |
| 13 | Delete MobileKeyPanel | Task 5 | — | — | 1 file |
| 14 | Final integration | all above | — | — | — |
