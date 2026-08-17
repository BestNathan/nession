# Terminal PC/Mobile Architecture Separation Design

**Date:** 2026-08-16  
**Status:** Approved  
**Requirements:** GitHub Issue #256

---

## Overview

This document describes the architectural design for separating the Terminal subsystem into distinct PC and Mobile paths while sharing the core controller/runtime/transport layers. The design preserves scrollback buffer across layout switches, implements a two-layer input system (Source + Mode), and simplifies device profiles.

## Key Decisions

### 1. TerminalInstance Stability (方案 E)

**Decision:** Controller keeps xterm instance alive, DOM node is moved on attach/detach.

**Rationale:** 
- xterm state (including scrollback buffer) is stored in JavaScript objects, not DOM
- Calling `terminal.open()` recreates DOM but preserves JS state
- Single xterm instance across layout switches preserves scrollback
- Simpler than manual DOM manipulation or placeholder approaches

### 2. Two-Layer Input System (Option A)

**Decision:** Separate Input Source Layer (detection) + Input Mode Layer (routing).

**Rationale:**
- Clear separation: Source layer handles "where input comes from", Mode layer handles "what input means"
- Independent evolution: Can modify Source or Mode layer independently
- Easy to understand: Two simple layers, easy to debug
- Backward compatible: Existing InputRouter and InputHandler unchanged

### 3. Device Profile Simplification

**Decision:** Remove tablet tier, keep only mobile (<768px) and desktop (≥768px).

**Rationale:**
- Tablet and desktop interaction differences are minimal (both have mouse/trackpad)
- Main difference is screen size, handled by responsive layout
- Simpler than 3-tier or 4-tier approach

### 4. API Changes

**Decision:** Allow breaking changes, but keep `send()` backward compatible.

**Rationale:**
- Cleaner API design
- TypeScript catches breaking changes at compile time
- `send()` remains compatible with default source parameter
- New `handleInput()` method is the recommended approach

## Architecture

### Component Hierarchy

```
TerminalWorkspace (root)
  ├─ TerminalHeader
  └─ TerminalLayout
      ├─ Mobile path (<768px, CSS hidden when desktop)
      │   ├─ MobileTerminalLayout
      │   │   ├─ SwipeableViewport
      │   │   │   ├─ Terminal panel
      │   │   │   │   ├─ TerminalViewport (xterm DOM container)
      │   │   │   │   └─ TerminalScrollOverlay
      │   │   │   ├─ Files panel
      │   │   │   └─ Envs panel
      │   │   └─ TerminalInputBar
      │   └─ MobileInput (React component, only in mobile path)
      └─ Desktop path (≥768px, CSS hidden when mobile)
          └─ DesktopTerminalLayout
              ├─ FileTabs
              │   ├─ TerminalViewport (xterm DOM container)
              │   └─ BottomBar
              └─ MouseIntentResolver (only in desktop path)

TerminalController (stable)
  ├─ InputSourceManager (Layer 1: Source detection)
  ├─ InputRouter (Layer 2: Mode routing)
  ├─ TerminalInstance (stable, created in controller constructor)
  │   ├─ Terminal (xterm, stable)
  │   │   └─ scrollback buffer (stable) ✅
  │   ├─ Renderer
  │   └─ ThemeManager
  └─ Transport (stable)
```

### Two-Layer Input System

```
Input Sources (keyboard/touch/mouse/component)
  ↓ call controller.handleInput(event)
  
TerminalController.handleInput(event)
  ↓ Layer 1: inputSourceManager.setActiveSource(event.source)
  ↓ Layer 2: inputRouter.route(event.data)
  
InputRouter.route(data)
  ↓ route based on currentMode
  
InputHandler (terminal/command/search/ai/custom)
  ↓ handle(data)
  
Transport → PTY
```

## Detailed Design

### TerminalInstance (renamed from TerminalRuntime)

```typescript
class TerminalInstance {
  readonly terminal: Terminal;
  readonly fontSizeManager: FontSizeManager;
  private disposed = false;
  
  constructor(options: TerminalInstanceOptions) {
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: options.fontSize ?? 14,
      fontFamily: DEFAULT_FONT,
      allowProposedApi: true,
      scrollback: options.scrollback ?? 50000,
    });
    
    // Renderer and ThemeManager created at construction
    new Renderer(this.terminal, options.rendererType);
    new ThemeManager(this.terminal);
    
    this.fontSizeManager = new FontSizeManager(
      this.terminal,
      () => this.fontSizeCallback(),
      options.fontSize ?? 14,
    );
  }
  
  attach(element: HTMLElement): void {
    // Use open() method, xterm handles DOM creation/re-rendering
    // State (scrollback buffer) is preserved in terminal instance
    this.terminal.open(element);
  }
  
  detach(): void {
    // No-op: terminal instance and state remain unchanged
    // DOM will be replaced on next open() call
  }
  
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
  }
}
```

**Key points:**
- Created in TerminalController constructor, not in attach()
- attach() only calls terminal.open(), xterm handles DOM
- detach() is a no-op, terminal instance stays alive
- dispose() only called when controller is destroyed
- Scrollback buffer preserved (stored in JS, not DOM)

### InputSourceManager

```typescript
type InputSource = 
  | 'keyboard'           // Physical keyboard (Desktop)
  | 'touch'              // Touch screen (Mobile)
  | 'mouse'              // Mouse (selection/click)
  | 'component-input'    // InputPanel component
  | 'component-quickcmd' // QuickCommandsPanel component
  | string;              // Extensible

interface InputEvent {
  source: InputSource;
  data: string;
  timestamp: number;
}

class InputSourceManager {
  private activeSource: InputSource | null = null;
  private onSourceChangeCallbacks: Array<(source: InputSource) => void> = [];
  
  setActiveSource(source: InputSource): void {
    if (this.activeSource === source) return;
    
    this.activeSource = source;
    
    // Trigger callbacks for UI response
    this.onSourceChangeCallbacks.forEach(cb => cb(source));
  }
  
  getActiveSource(): InputSource | null {
    return this.activeSource;
  }
  
  onSourceChange(callback: (source: InputSource) => void): () => void {
    this.onSourceChangeCallbacks.push(callback);
    return () => {
      const index = this.onSourceChangeCallbacks.indexOf(callback);
      if (index >= 0) {
        this.onSourceChangeCallbacks.splice(index, 1);
      }
    };
  }
  
  dispose(): void {
    this.onSourceChangeCallbacks = [];
    this.activeSource = null;
  }
}
```

**Key points:**
- Independent class, manages activeSource state
- Provides onSourceChange callback for UI response
- Single active source at a time
- Auto-detection: first input event sets active source

### TerminalController Integration

```typescript
class TerminalController {
  private instance: TerminalInstance | null = null;
  private inputSourceManager: InputSourceManager;
  private inputRouter: InputRouter | null = null;
  
  constructor(
    session: TerminalSession,
    transportFactory: () => TerminalTransport,
    private options: TerminalControllerOptions,
  ) {
    this.session = session;
    this.transportFactory = transportFactory;
    
    // Created in constructor
    this.instance = new TerminalInstance(options);
    this.inputSourceManager = new InputSourceManager();
    
    this.initInputRouter();
  }
  
  handleInput(event: InputEvent): void {
    // Layer 1: Update active source
    this.inputSourceManager.setActiveSource(event.source);
    
    // Layer 2: Route to current mode handler
    this.inputRouter?.route(event.data);
  }
  
  send(data: string, source: InputSource = 'component-input'): void {
    this.handleInput({
      source,
      data,
      timestamp: Date.now(),
    });
  }
  
  getActiveInputSource(): InputSource | null {
    return this.inputSourceManager.getActiveSource();
  }
  
  onInputSourceChange(callback: (source: InputSource) => void): () => void {
    return this.inputSourceManager.onSourceChange(callback);
  }
  
  attach(element: HTMLElement): void {
    if (this.attached) return;
    
    const transport = this.transportFactory();
    this.transport = transport;
    this.attached = true;
    
    this.instance.attach(element);
    
    transport.onOutput = (data) => { this.instance?.terminal.write(data); };
    transport.onResize = (cols, rows) => { this.instance?.terminal.resize(cols, rows); };
    
    // ... other setup
  }
  
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    
    this.instance?.detach();
    
    this.transport?.dispose();
    this.transport = null;
    
    // Note: inputSourceManager state is NOT reset
  }
  
  dispose(): void {
    this.inputSourceManager.dispose();
    this.instance?.dispose();
    this.instance = null;
    this.inputRouter = null;
  }
}
```

### React Component Integration

#### Desktop Layout

```typescript
function DesktopTerminalLayout({ controller }) {
  useEffect(() => {
    if (!controller) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      
      controller.handleInput({
        source: 'keyboard',
        data: e.key,
        timestamp: Date.now(),
      });
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [controller]);
  
  return (
    <div className="h-full flex flex-col">
      <FileTabs ... />
      <BottomBar ... />
    </div>
  );
}
```

#### Mobile Layout

```typescript
function MobileTerminalLayout({ controller }) {
  const mobileInputRef = useRef<MobileInputHandle>(null);
  
  useEffect(() => {
    if (!controller || !mobileInputRef.current) return;
    
    mobileInputRef.current.onInput((text) => {
      controller.handleInput({
        source: 'touch',
        data: text,
        timestamp: Date.now(),
      });
    });
  }, [controller]);
  
  return (
    <div className="h-full flex flex-col">
      <SwipeableViewport ...>
        <TerminalPanel>
          <TerminalViewport controller={controller} />
          <TerminalScrollOverlay ... />
        </TerminalPanel>
        <FilesPanel ... />
        <EnvsPanel ... />
      </SwipeableViewport>
      
      <MobileInput ref={mobileInputRef} controller={controller} />
      <TerminalInputBar ... />
    </div>
  );
}
```

#### MobileInput Component (moved to React layer)

```typescript
export const MobileInput = forwardRef<MobileInputHandle, MobileInputProps>(
  function MobileInput({ controller }, ref) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const inputCallbackRef = useRef<((text: string) => void) | null>(null);
    
    useImperativeHandle(ref, () => ({
      onInput: (callback) => {
        inputCallbackRef.current = callback;
      },
    }));
    
    useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      
      const handleInput = (e: Event) => {
        const ie = e as InputEvent;
        if (ie.inputType === 'insertText' && ie.data && !ie.isComposing) {
          inputCallbackRef.current?.(ie.data);
          textarea.value = '';
        }
      };
      
      textarea.addEventListener('input', handleInput);
      return () => textarea.removeEventListener('input', handleInput);
    }, []);
    
    return (
      <textarea
        ref={textareaRef}
        className="mobile-input"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
    );
  }
);
```

#### InputPanel Component

```typescript
function InputPanel({ controller, disabled }) {
  const [text, setText] = useState('');
  
  const handleSubmit = () => {
    if (!text.trim() || !controller) return;
    
    controller.handleInput({
      source: 'component-input',
      data: text + '\r',
      timestamp: Date.now(),
    });
    
    setText('');
  };
  
  return (
    <div className="input-panel">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
        }}
        disabled={disabled}
      />
      <Button onClick={handleSubmit} disabled={disabled}>
        Send
      </Button>
    </div>
  );
}
```

#### QuickCommandsPanel Component

```typescript
function QuickCommandsPanel({ controller, disabled }) {
  const handleCommand = (command: string) => {
    if (!controller) return;
    
    controller.handleInput({
      source: 'component-quickcmd',
      data: command,
      timestamp: Date.now(),
    });
  };
  
  return (
    <div className="quick-commands">
      <Button onClick={() => handleCommand('\x03')} disabled={disabled}>
        Ctrl-C
      </Button>
      <Button onClick={() => handleCommand('\r')} disabled={disabled}>
        Enter
      </Button>
      <Button onClick={() => handleCommand('clear\n')} disabled={disabled}>
        Clear
      </Button>
    </div>
  );
}
```

## API Changes

### Breaking Changes

| Old API | New API | Impact | Migration |
|---------|---------|--------|-----------|
| `TerminalRuntime` | `TerminalInstance` | Class rename | Global replace |
| `runtime.open(element)` | `instance.attach(element)` | Method rename | Global replace |
| `runtime.installMobileInput()` | Removed | Feature moved to React layer | Use `<MobileInput>` component |
| `controller.send(data)` | `controller.send(data, source?)` | Signature change (backward compatible) | No change needed, or use new signature |
| N/A | `controller.handleInput(event)` | New method | Recommended |
| N/A | `controller.getActiveInputSource()` | New method | Optional |
| N/A | `controller.onInputSourceChange()` | New method | Optional |

### Migration Guide

#### For TerminalRuntime users

```typescript
// Old
const runtime = new TerminalRuntime(options);
runtime.open(element);
runtime.installMobileInput(parent, onSend);
runtime.dispose();

// New
const instance = new TerminalInstance(options);
instance.attach(element);
// MobileInput moved to React layer: <MobileInput ref={ref} controller={controller} />
instance.dispose();
```

#### For controller.send() users

```typescript
// Old
controller.send('ls -la');

// New (option 1: backward compatible)
controller.send('ls -la');  // default source='component-input'

// New (option 2: explicit source)
controller.send('ls -la', 'keyboard');

// New (option 3: recommended, use handleInput)
controller.handleInput({
  source: 'keyboard',
  data: 'ls -la',
  timestamp: Date.now(),
});
```

## Implementation Phases

### Phase 1: TerminalInstance Stabilization (3 days)

**Goal:** xterm instance stable, scrollback preserved

**Steps:**
1. Rename `TerminalRuntime` → `TerminalInstance`
2. Modify constructor to create in `TerminalController` constructor
3. Modify `attach()` to only call `terminal.open(element)`
4. Modify `detach()` to be a no-op
5. Modify `dispose()` to only be called when controller is destroyed
6. Remove `installMobileInput()` method (migrate later)
7. Write tests: scrollback preserved on layout switch

**Verification:**
- ✅ Layout switch 5 times, scrollback not lost
- ✅ Rapid switching doesn't crash
- ✅ Memory usage stable (only one xterm instance)
- ✅ All existing tests pass

### Phase 2: DeviceProfile Simplification (2 days)

**Goal:** Remove tablet tier, keep only mobile/desktop

**Steps:**
1. Modify `DeviceProfile.ts` to only return `'mobile' | 'desktop'`
2. Modify `detectProfile()`, breakpoint to 768px
3. Modify `TerminalLayout.tsx`, `useMediaQuery` breakpoint to 768px
4. Delete tablet-related code and tests
5. Write tests: different screen sizes use correct layout

**Verification:**
- ✅ < 768px uses mobile layout
- ✅ ≥ 768px uses desktop layout
- ✅ Tablet devices (640-1024px) use desktop layout
- ✅ All tests pass

### Phase 3: InputSourceManager Implementation (4 days)

**Goal:** Implement two-layer input system, fine-grained input source distinction

**Steps:**
1. Define `InputSource` type and `InputEvent` interface (types.ts)
2. Implement `InputSourceManager` class
3. Integrate `InputSourceManager` in `TerminalController`
4. Implement `handleInput()` method
5. Modify `send()` method to be a wrapper, default source='component-input'
6. Add `getActiveInputSource()` and `onInputSourceChange()` methods
7. Write tests: different sources route correctly

**Verification:**
- ✅ keyboard source routes correctly
- ✅ touch source routes correctly
- ✅ component source routes correctly
- ✅ activeSource auto-switches
- ✅ onSourceChange callback triggers correctly
- ✅ All tests pass

### Phase 4: React Component Layer Separation (3 days)

**Goal:** Desktop and Mobile layouts clearly separated

**Steps:**
1. Rename `TerminalLayout` → `DesktopTerminalLayout` (or confirm responsibilities)
2. Confirm `MobileTerminalLayout` responsibilities are clear
3. Add keyboard/mouse event listeners in Desktop layout
4. Prepare MobileInput component mount point in Mobile layout
5. Write tests: both sides work independently, don't affect each other

**Verification:**
- ✅ Desktop layout listens to keyboard/mouse events
- ✅ Mobile layout ready
- ✅ Both sides' code doesn't depend on each other
- ✅ All tests pass

### Phase 5: Input Layer Migration (2 days)

**Goal:** All input sources use handleInput()

**Steps:**
1. Move `MobileInput` from `terminal/` to `components/`
2. Change to React component, use forwardRef
3. Modify `MobileTerminalLayout` to use new `MobileInput` component
4. Modify `InputPanel` to use `handleInput({source: 'component-input'})`
5. Modify `QuickCommandsPanel` to use `handleInput({source: 'component-quickcmd'})`
6. Delete `TerminalRuntime.installMobileInput()` related code
7. Write tests: all input sources send correctly

**Verification:**
- ✅ MobileInput works as React component
- ✅ touch input sends via handleInput
- ✅ keyboard input sends via handleInput
- ✅ component input sends via handleInput
- ✅ No paths bypass InputRouter
- ✅ All tests pass

### Phase 6: Cleanup and Optimization (2 days)

**Goal:** Clean up old code, optimize performance, update documentation

**Steps:**
1. Delete tablet-related code from `DeviceProfile`
2. Delete `TerminalRuntime` related code (renamed to TerminalInstance)
3. Delete old `installMobileInput()` code
4. Optimize layout switch performance (reduce re-renders)
5. Update API documentation and migration guide
6. Write performance tests: layout switch < 100ms

**Verification:**
- ✅ No deprecated code
- ✅ Layout switch < 100ms
- ✅ Memory usage stable
- ✅ Documentation clear and complete
- ✅ All tests pass

## Testing Strategy

### Unit Tests

```typescript
// TerminalInstance tests
describe('TerminalInstance', () => {
  it('should preserve scrollback after attach/detach', () => {
    const instance = new TerminalInstance({ fontSize: 14 });
    const container1 = document.createElement('div');
    const container2 = document.createElement('div');
    
    instance.attach(container1);
    instance.terminal.write('line 1\n');
    instance.terminal.write('line 2\n');
    instance.detach();
    
    instance.attach(container2);
    expect(instance.terminal.buffer.active.getLine(0)?.translateToString()).toBe('line 1');
    expect(instance.terminal.buffer.active.getLine(1)?.translateToString()).toBe('line 2');
  });
});

// InputSourceManager tests
describe('InputSourceManager', () => {
  it('should track active source', () => {
    const manager = new InputSourceManager();
    
    manager.setActiveSource('keyboard');
    expect(manager.getActiveSource()).toBe('keyboard');
    
    manager.setActiveSource('touch');
    expect(manager.getActiveSource()).toBe('touch');
  });
  
  it('should trigger onSourceChange callback', () => {
    const manager = new InputSourceManager();
    const callback = jest.fn();
    
    manager.onSourceChange(callback);
    manager.setActiveSource('keyboard');
    
    expect(callback).toHaveBeenCalledWith('keyboard');
  });
});

// TerminalController tests
describe('TerminalController', () => {
  it('should route input through handleInput', () => {
    const controller = new TerminalController(...);
    const sendSpy = jest.spyOn(controller.transport, 'send');
    
    controller.handleInput({
      source: 'keyboard',
      data: 'ls',
      timestamp: Date.now(),
    });
    
    expect(sendSpy).toHaveBeenCalledWith('ls');
    expect(controller.getActiveInputSource()).toBe('keyboard');
  });
});
```

### Integration Tests

```typescript
describe('Layout switch integration', () => {
  it('should preserve scrollback when switching from desktop to mobile', () => {
    // Start desktop layout
    // Input some commands, generate scrollback
    // Switch to mobile layout
    // Verify scrollback preserved
  });
  
  it('should handle rapid layout switches', () => {
    // Switch rapidly 5 times
    // Verify no crash, state correct
  });
});

describe('Input source integration', () => {
  it('should route keyboard input correctly', () => {
    // Simulate keyboard input
    // Verify sends via handleInput
    // Verify activeSource updates
  });
  
  it('should route touch input correctly', () => {
    // Simulate touch input
    // Verify sends via handleInput
    // Verify activeSource updates
  });
});
```

### Performance Tests

```typescript
describe('Performance', () => {
  it('should switch layout in < 100ms', () => {
    const start = performance.now();
    // Switch layout
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(100);
  });
  
  it('should maintain stable memory usage', () => {
    const initialMemory = performance.memory.usedJSHeapSize;
    // Switch layout 10 times
    const finalMemory = performance.memory.usedJSHeapSize;
    expect(finalMemory - initialMemory).toBeLessThan(10 * 1024 * 1024); // < 10MB
  });
});
```

## Timeline

- Phase 1: 3 days
- Phase 2: 2 days
- Phase 3: 4 days
- Phase 4: 3 days
- Phase 5: 2 days
- Phase 6: 2 days
- **Total: 16 days (~3 weeks)**

## Risks and Mitigations

### Risk 1: xterm open() behavior

**Risk:** xterm's open() might not preserve state as expected.

**Mitigation:** 
- Test thoroughly in Phase 1
- If open() doesn't preserve state, fallback to manual DOM manipulation (Option A from design discussion)

### Risk 2: MobileInput React component migration

**Risk:** Migrating MobileInput from class to React component might introduce bugs.

**Mitigation:**
- Keep original class implementation as reference
- Write comprehensive tests before migration
- Test on real mobile devices

### Risk 3: Input source detection accuracy

**Risk:** Auto-detection might not work well in all cases.

**Mitigation:**
- Provide manual override API if needed
- Monitor activeSource changes in production
- Add logging for debugging

## Success Criteria

1. **Scrollback preservation:** Layout switch preserves scrollback buffer
2. **Clear architecture:** PC and Mobile paths clearly separated
3. **Input source tracking:** Can distinguish keyboard/touch/component inputs
4. **Performance:** Layout switch < 100ms, memory stable
5. **Test coverage:** ≥ 80% for new code, all tests pass
6. **Documentation:** Clear API documentation and migration guide

## References

- Requirements: GitHub Issue #256
- Architecture diagrams: GitHub Issue #256 comment
- xterm.js documentation: https://xtermjs.org/docs/
