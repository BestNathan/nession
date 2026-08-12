# Terminal Architecture Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure the terminal subsystem into 5 layers (state → controller → input → components), extract TerminalController from the god class, formalize the Input system, and split the 400-line React Terminal component into focused components — all without changing user-visible behavior.

**Architecture:** Bottom-up migration across 4 phases, each independently testable. Phase 1 creates Jotai state domains. Phase 2 extracts TerminalController + sub-controllers + TerminalTransport interface. Phase 3 builds the Input system (InputRouter + handlers). Phase 4 refactors React components and swaps App.tsx to TerminalWorkspace.

**Tech Stack:** TypeScript, Jotai, xterm.js (unchanged), Vitest
**Spec:** docs/superpowers/specs/2026-08-12-terminal-architecture-refactor-design.md

---

## Phase 1: State (Atoms)

### Task 1: Terminal state domains — session, terminal, input, ui, layout, capability

**Files to create:**
- web/src/terminal/state/session.ts — TerminalSession type + terminalSessionAtom (derived from global atoms)
- web/src/terminal/state/terminal.ts — terminalSizeAtomFamily, terminalFocusAtomFamily, terminalSelectionAtomFamily, terminalTitleAtomFamily
- web/src/terminal/state/input.ts — InputMode type + inputModeAtomFamily, inputValueAtomFamily
- web/src/terminal/state/ui.ts — ReconnectBanner type + bannerAtomFamily, bannerAttemptAtomFamily
- web/src/terminal/state/layout.ts — sidebarOpenAtom, panelSizesAtom
- web/src/terminal/state/capability.ts — TerminalCapabilities type + capabilitiesAtomFamily
- web/src/terminal/state/index.ts — barrel exports + terminalViewModelAtomFamily derived atom
- web/src/terminal/state/__tests__/ — test files for each domain

**Verification:** npx vitest run src/terminal/state/__tests__/ — ~17 tests pass

### Task 2: Move terminalSessionStateAtom and lastResizeAtom into terminal/state/

**Files to modify:**
- web/src/atoms/connection.ts — remove terminalSessionStateAtom and lastResizeAtom definitions
- web/src/terminal/state/session.ts — add terminalSessionStateAtom definition
- web/src/terminal/state/terminal.ts — add lastResizeAtom definition
- web/src/terminal/state/index.ts — export moved atoms
- web/src/atoms/session.ts — update import path
- web/src/components/Terminal.tsx — update import paths
- web/src/terminal/ConnectionManager.ts — update import path
- web/src/atoms/__tests__/connection.test.ts — update import paths

**Verification:** npx vitest run — all existing tests pass; npx tsc --noEmit — no errors

---

## Phase 2: Controller

### Task 3: TerminalTransport interface

**Files to create:**
- web/src/terminal/transport/TerminalTransport.ts — TerminalTransport interface (send, sendResize, onOutput, onResize, onStateChange, onError, onDisconnect, dispose, mode)

ConnectionManager already satisfies this shape — no changes needed.

### Task 4: TerminalController + ResizeController

**Files to create:**
- web/src/terminal/controller/TerminalController.ts — TerminalController class (attach, detach, write, send, resize, focus, clear, paste, setInputMode, getInputMode) + ResizeController class (ResizeObserver wrapper)
- web/src/terminal/controller/__tests__/TerminalController.test.ts — 6 tests

**Verification:** npx vitest run src/terminal/controller/__tests__/ — 6 tests pass

---

## Phase 3: Input System

### Task 5: InputRouter, InputHandler, TerminalInputHandler + stubs

**Files to create:**
- web/src/terminal/input/InputHandler.ts — InputHandler interface (mode, handle, activate, deactivate)
- web/src/terminal/input/InputRouter.ts — InputRouter class (register, setMode, getMode, route)
- web/src/terminal/input/TerminalInputHandler.ts — TerminalInputHandler (full implementation: xterm onData → transport.send, Ctrl+D interceptor)
- web/src/terminal/input/CommandInputHandler.ts — stub
- web/src/terminal/input/SearchInputHandler.ts — stub
- web/src/terminal/input/AIInputHandler.ts — stub
- web/src/terminal/input/CustomInputHandler.ts — stub
- web/src/terminal/input/index.ts — barrel
- web/src/terminal/input/__tests__/InputRouter.test.ts — 4 tests
- web/src/terminal/input/__tests__/TerminalInputHandler.test.ts — 6 tests

**Verification:** npx vitest run src/terminal/input/__tests__/ — 10 tests pass

### Task 6: Wire InputRouter into TerminalController

**Files to modify:**
- web/src/terminal/controller/TerminalController.ts — create InputRouter in constructor, register handlers, wire TerminalInputHandler in attach(), deactivate in detach()

**Verification:** all previous tests still pass

---

## Phase 4: React Components

### Task 7: TerminalTabs stub

**Create:** web/src/terminal/components/TerminalTabs.tsx — returns null

### Task 8: TerminalBanner component

**Create:** web/src/terminal/components/TerminalBanner.tsx — extract banner JSX from components/Terminal.tsx (lines 365-385). Props: banner, reconnectAttempt.

### Task 9: TerminalViewport component

**Create:** web/src/terminal/components/TerminalViewport.tsx — pure DOM mount point. Receives controller prop. useEffect: controller.attach(container) on mount, controller.detach() on unmount. Returns div with terminal background color.
**Create:** web/src/terminal/components/__tests__/TerminalViewport.test.tsx — 2 tests

### Task 10: TerminalInputOverlay component

**Create:** web/src/terminal/components/input/TerminalInputOverlay.tsx — reads inputModeAtomFamily, switches on mode.type. All cases return null (stubs).  
**Create:** web/src/terminal/components/input/__tests__/TerminalInputOverlay.test.tsx — 2 tests

### Task 11: TerminalPane component

**Create:** web/src/terminal/components/TerminalPane.tsx — composes TerminalBanner + TerminalViewport + TerminalInputOverlay. Reads terminalViewModelAtomFamily.  
**Create:** web/src/terminal/components/__tests__/TerminalPane.test.tsx — 1 test

### Task 12: useTerminalStateMachine hook

**Create:** web/src/terminal/hooks/useTerminalStateMachine.ts — extract the 6-state switch from components/Terminal.tsx (lines 106-229). Takes serverConnection, returns { terminalState, reconnectCount }.  
**Create:** web/src/terminal/hooks/__tests__/useTerminalStateMachine.test.ts — 1 test

### Task 13: TerminalWorkspace + App.tsx switch

**Create:** web/src/terminal/components/TerminalWorkspace.tsx — identical copy of components/TerminalView.tsx, renamed export to TerminalWorkspace. Uses same imports, same logic.  
**Modify:** web/src/App.tsx — change import from `./components/TerminalView` to `./terminal/components/TerminalWorkspace`, rename JSX usage.  
**Modify:** web/src/components/TerminalView.tsx — re-export TerminalWorkspace as TerminalView for backward compatibility.

**Verification:** npx tsc --noEmit && npm run build && npx vitest run — no errors, all pass

### Task 14: Update terminal/index.ts barrel exports

Add all new exports to web/src/terminal/index.ts: TerminalController, ResizeController, InputRouter, TerminalInputHandler, all state atoms, new components, useTerminalStateMachine.

---

## Phase 5: Final Verification

### Task 15: Run full test suite + Playwright screenshots

- cargo test — all Rust tests pass
- cd web && npx vitest run — all web tests pass
- cd web && npm run lint — 0 warnings
- cd web && npx tsc --noEmit — no errors
- cd web && npm run build — builds successfully
- Start local stack and take Playwright screenshots — no visual regressions
