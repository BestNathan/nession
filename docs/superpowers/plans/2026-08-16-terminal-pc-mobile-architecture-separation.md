# Terminal PC/Mobile Architecture Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate Terminal subsystem into distinct PC and Mobile paths while preserving scrollback buffer across layout switches and implementing a two-layer input system.

**Architecture:** TerminalInstance (renamed from TerminalRuntime) stays alive in controller constructor, xterm DOM moves via open() on attach/detach. Two-layer input system: InputSourceManager (detection) + InputRouter (routing). Device profiles simplified to mobile (<768px) and desktop (≥768px).

**Tech Stack:** TypeScript, React, xterm.js, Jotai, Vitest

**Spec:** docs/superpowers/specs/2026-08-16-terminal-pc-mobile-architecture-separation-design.md

---

## Implementation Overview

This plan is divided into 6 phases matching the design spec:

1. **Phase 1: TerminalInstance Stabilization** (Tasks 1-8) - Make xterm instance stable, preserve scrollback
2. **Phase 2: DeviceProfile Simplification** (Tasks 9-12) - Remove tablet tier, use mobile/desktop only
3. **Phase 3: InputSourceManager Implementation** (Tasks 13-19) - Two-layer input system
4. **Phase 4: React Component Layer Separation** (Tasks 20-22) - Desktop/Mobile layout separation
5. **Phase 5: Input Layer Migration** (Tasks 23-28) - Move MobileInput to React, migrate all inputs
6. **Phase 6: Cleanup and Optimization** (Tasks 29-32) - Remove deprecated code, update docs

**Estimated Timeline:** 16 days (~3 weeks)

---

## Phase 1: TerminalInstance Stabilization

### Task 1: Define TerminalInstance Types

**Files:**
- Modify: `web/src/terminal/types.ts`

- [ ] **Step 1: Add TerminalInstanceOptions type**

Add to `web/src/terminal/types.ts`:

```typescript
export interface TerminalInstanceOptions {
  rendererType: 'webgl' | 'canvas';
  fontSize?: number;
  scrollback?: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/terminal/types.ts
git commit -m "feat(terminal): add TerminalInstanceOptions type"
```

---

### Task 2: Write TerminalInstance Tests

**Files:**
- Create: `web/src/terminal/instance/__tests__/TerminalInstance.test.ts`

- [ ] **Step 1: Write failing test for TerminalInstance creation**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TerminalInstance } from '../TerminalInstance';

describe('TerminalInstance', () => {
  let instance: TerminalInstance;

  beforeEach(() => {
    instance = new TerminalInstance({
      rendererType: 'canvas',
      fontSize: 14,
      scrollback: 1000,
    });
  });

  afterEach(() => {
    instance.dispose();
  });

  it('should create terminal with options', () => {
    expect(instance.terminal).toBeDefined();
    expect(instance.fontSizeManager).toBeDefined();
  });

  it('should have correct initial state', () => {
    expect(instance.terminal.rows).toBeGreaterThan(0);
    expect(instance.terminal.cols).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- src/terminal/instance/__tests__/TerminalInstance.test.ts`
Expected: FAIL — Cannot find module '../TerminalInstance'

- [ ] **Step 3: Commit failing test**

```bash
git add web/src/terminal/instance/__tests__/TerminalInstance.test.ts
git commit -m "test(terminal): add failing tests for TerminalInstance"
```

---

### Task 3: Implement TerminalInstance Class

**Files:**
- Create: `web/src/terminal/instance/TerminalInstance.ts`

- [ ] **Step 1: Create TerminalInstance class**

```typescript
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Renderer } from '../Renderer';
import { ThemeManager } from '../ThemeManager';
import { FontSizeManager } from '../FontSizeManager';
import type { TerminalInstanceOptions } from '../types';

const DEFAULT_FONT =
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace";
const DEFAULT_FONT_SIZE = 14;

/**
 * Stable xterm wrapper that persists across attach/detach cycles.
 * Created once in TerminalController constructor, not recreated on each attach.
 * Scrollback buffer is preserved because xterm state is in JS objects, not DOM.
 */
export class TerminalInstance {
  readonly terminal: Terminal;
  readonly fontSizeManager: FontSizeManager;
  private disposed = false;
  private fontSizeCallback: () => void = () => {};

  constructor(options: TerminalInstanceOptions) {
    const initialFontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
    
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      fontFamily: DEFAULT_FONT,
      allowProposedApi: true,
      scrollback: options.scrollback ?? 50000,
    });

    new Renderer(this.terminal, options.rendererType);
    new ThemeManager(this.terminal);

    this.fontSizeManager = new FontSizeManager(
      this.terminal,
      () => this.fontSizeCallback(),
      initialFontSize,
    );
  }

  set onCellSizeChange(cb: () => void) {
    this.fontSizeCallback = cb;
  }

  /** Attach xterm to container. Uses open() which preserves JS state. */
  attach(element: HTMLElement): void {
    if (this.disposed) return;
    this.terminal.open(element);
  }

  /** Detach from container. No-op: terminal instance stays alive. */
  detach(): void {
    // Intentionally empty
  }

  get cellDimensions(): { width: number; height: number } {
    const rs = (this.terminal as any)._core?._renderService;
    return {
      width: rs?.dimensions?.css?.cell?.width || 8,
      height: rs?.dimensions?.css?.cell?.height || 16,
    };
  }

  scrollToBottom(): void { this.terminal.scrollToBottom(); }
  scrollPages(pages: number): void { this.terminal.scrollPages(pages); }
  scrollLines(lines: number): void { this.terminal.scrollLines(lines); }
  focus(): void { this.terminal.focus(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
  }
}
```

- [ ] **Step 2: Run tests**

Run: `cd web && npm test -- src/terminal/instance/__tests__/TerminalInstance.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/terminal/instance/TerminalInstance.ts
git commit -m "feat(terminal): implement TerminalInstance class"
```

---

### Task 4: Write Scrollback Preservation Test

**Files:**
- Modify: `web/src/terminal/instance/__tests__/TerminalInstance.test.ts`

- [ ] **Step 1: Add scrollback test**

```typescript
it('should preserve scrollback after attach/detach cycle', () => {
  const container1 = document.createElement('div');
  const container2 = document.createElement('div');
  document.body.appendChild(container1);
  document.body.appendChild(container2);

  instance.attach(container1);
  instance.terminal.write('line 1\r\n');
  instance.terminal.write('line 2\r\n');
  instance.terminal.write('line 3\r\n');

  instance.detach();
  instance.attach(container2);

  const buffer = instance.terminal.buffer.active;
  expect(buffer.getLine(0)?.translateToString()).toBe('line 1');
  expect(buffer.getLine(1)?.translateToString()).toBe('line 2');
  expect(buffer.getLine(2)?.translateToString()).toBe('line 3');

  document.body.removeChild(container1);
  document.body.removeChild(container2);
});
```

- [ ] **Step 2: Run test**

Run: `cd web && npm test -- src/terminal/instance/__tests__/TerminalInstance.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/terminal/instance/__tests__/TerminalInstance.test.ts
git commit -m "test(terminal): verify scrollback preservation"
```

---

### Task 5-8: Update TerminalController and Verify

**Files:**
- Modify: `web/src/terminal/controller/TerminalController.ts`
- Modify: `web/src/terminal/index.ts`

**Key changes:**
1. Replace `TerminalRuntime` with `TerminalInstance`
2. Create instance in constructor, not in attach()
3. Use `instance.attach()` instead of `runtime.open()`
4. Use `instance.detach()` (no-op) instead of `runtime.dispose()`
5. Remove `installMobileInput()` call (migrated later)
6. Export `TerminalInstance` from index.ts

**Verification:**
- Run: `cd web && npm test`
- Manual test: Layout switch preserves scrollback

- [ ] **Complete all controller updates**
- [ ] **Run all tests - should pass**
- [ ] **Manual verification**
- [ ] **Commit Phase 1**

---

## Phase 2: DeviceProfile Simplification

### Task 9-12: Simplify DeviceProfile

**Files:**
- Modify: `web/src/terminal/DeviceProfile.ts`
- Modify: `web/src/terminal/types.ts`
- Modify: `web/src/components/TerminalLayout.tsx`

**Key changes:**
1. Change `DeviceProfile` type to `'mobile' | 'desktop'`
2. Set `MOBILE_BREAKPOINT = 768`
3. Remove tablet tier
4. Update `TerminalLayout` to use 768px breakpoint

**Verification:**
- Run: `cd web && npm test`
- Manual test: Tablet sizes (640-1024px) use desktop layout

- [ ] **Complete all DeviceProfile updates**
- [ ] **Run all tests - should pass**
- [ ] **Manual verification**
- [ ] **Commit Phase 2**

---

## Phase 3: InputSourceManager Implementation

### Task 13-19: Implement Two-Layer Input System

**Files:**
- Modify: `web/src/terminal/types.ts`
- Create: `web/src/terminal/input/InputSourceManager.ts`
- Modify: `web/src/terminal/controller/TerminalController.ts`
- Modify: `web/src/terminal/index.ts`

**Key changes:**
1. Add `InputSource` type and `InputEvent` interface
2. Implement `InputSourceManager` class
3. Add `handleInput()` method to controller
4. Update `send()` to use `handleInput()`
5. Add `getActiveInputSource()` and `onInputSourceChange()` methods

**Verification:**
- Run: `cd web && npm test`
- Manual test: Different input sources update activeSource correctly

- [ ] **Complete all InputSourceManager implementation**
- [ ] **Run all tests - should pass**
- [ ] **Manual verification**
- [ ] **Commit Phase 3**

---

## Phase 4: React Component Layer Separation

### Task 20-22: Separate Desktop/Mobile Layouts

**Files:**
- Rename: `web/src/components/TerminalLayout.tsx` → `DesktopTerminalLayout.tsx`
- Modify: `web/src/components/DesktopTerminalLayout.tsx`

**Key changes:**
1. Rename `TerminalLayout` to `DesktopTerminalLayout`
2. Add keyboard event listener in `useEffect`
3. Call `controller.handleInput({ source: 'keyboard', ... })`

**Verification:**
- Run: `cd web && npm test`
- Manual test: Desktop layout responds to keyboard input

- [ ] **Complete layout separation**
- [ ] **Run all tests - should pass**
- [ ] **Manual verification**
- [ ] **Commit Phase 4**

---

## Phase 5: Input Layer Migration

### Task 23-28: Migrate All Input Sources

**Files:**
- Create: `web/src/components/MobileInput.tsx`
- Modify: `web/src/components/MobileTerminalLayout.tsx`
- Modify: `web/src/components/InputPanel.tsx`
- Modify: `web/src/components/QuickCommandsPanel.tsx`

**Key changes:**
1. Move `MobileInput` from `terminal/` to `components/`
2. Convert to React component with `forwardRef`
3. Update all input sources to use `handleInput()` with proper source
4. Remove old `installMobileInput()` code

**Verification:**
- Run: `cd web && npm test`
- Manual test: All input sources work correctly

- [ ] **Complete input migration**
- [ ] **Run all tests - should pass**
- [ ] **Manual verification**
- [ ] **Commit Phase 5**

---

## Phase 6: Cleanup and Optimization

### Task 29-32: Final Cleanup

**Files:**
- Delete: Deprecated code
- Modify: Documentation

**Key changes:**
1. Remove all `TerminalRuntime` references
2. Remove tablet-related code
3. Update API documentation
4. Add migration guide

**Verification:**
- Run: `cd web && npm test`
- Performance test: Layout switch < 100ms
- Check: No deprecated code remains

- [ ] **Complete cleanup**
- [ ] **Run all tests - should pass**
- [ ] **Performance verification**
- [ ] **Commit Phase 6**

---

## Final Verification

- [ ] **Run full test suite: `cd web && npm test`**
- [ ] **Run linting: `cd web && npm run lint`**
- [ ] **Build: `cd web && npm run build`**
- [ ] **Manual testing across all phases**
- [ ] **Create PR with all changes**

---

## Success Criteria

1. ✅ Scrollback preserved across layout switches
2. ✅ PC and Mobile paths clearly separated
3. ✅ Input source tracking works correctly
4. ✅ All tests pass (≥80% coverage)
5. ✅ No deprecated code remains
6. ✅ Documentation complete

---

**Plan Status:** Ready for execution
**Next Step:** Choose execution method (Subagent-Driven or Inline)
