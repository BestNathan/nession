# Design: Terminal Architecture Restructure — tmux-Driven Sizing

**Date:** 2026-07-18  
**Status:** Draft  
**Requirements:** https://github.com/BestNathan/nession/issues/83

---

## 1. Overview

**Core Change:** Shift from viewport-driven terminal sizing to tmux-driven sizing. The web client no longer calculates terminal dimensions based on viewport size. Instead, terminal dimensions always match the tmux session size, and the web client handles rendering, scrolling, and scaling.

**Key Principles:**
1. **tmux is the single source of truth** — web client never calculates cols/rows, only responds to tmux resize events
2. **Viewport handles scrolling** — when tmux size > viewport, CSS overflow provides horizontal/vertical scrolling
3. **CSS transform handles scaling** — device-based auto-scaling + manual zoom controls, without affecting xterm.js internal rendering
4. **Session-level scaling** — zoom level is not persisted, resets to default on refresh/new session

## 2. Architecture

### 2.1 Data Flow

```
tmux (resize -x 120 -y 40)
  ↓ (tmux control mode event: %window-resize @window-id 120 40)
nession-agent (parses control mode event)
  ↓ WebSocket: agent.terminal.resize {session_id, cols: 120, rows: 40}
nession-server (broadcasts to all attached clients)
  ↓ WebSocket: terminal.resize {cols: 120, rows: 40}
web client (receives message)
  ↓ TerminalSizeManager.handleResize(120, 40)
  ↓ term.resize(120, 40)
xterm.js (updates cols/rows, re-renders)
  ↓ CSS transform: scale(0.8)
viewport (displays scaled terminal, overflow scrolling if needed)
```

### 2.2 Component Responsibilities

| Component | Responsibility | Change |
|-----------|---------------|--------|
| FitAddon | Calculate cols/rows from viewport | **Remove** |
| ViewportManager | ResizeObserver + fit() + font scaling | **Rename to TerminalSizeManager** |
| TerminalSizeManager (new) | Listen to tmux resize messages, call term.resize() | **Refactor from ViewportManager** |
| ScalingManager (new) | Device detection, CSS transform scaling, manual zoom controls | **New** |
| ConnectionManager | WebSocket message handling (including terminal.resize) | **Keep, extend** |
| AddonManager | Manage xterm addons | **Keep, remove FitAddon** |

## 3. Protocol Changes

### 3.1 tmux Control Mode

Agent connects to tmux with control mode (`tmux attach -C` or `tmux new-session -C`). tmux sends real-time event notifications:

```
%window-resize @window-id width height
```

Example:
```
%window-resize @1 120 40
```

Agent parses this event, extracts session_id (via window-id → session-id mapping), cols, rows, and sends WebSocket message.

**Advantages over polling:**
- **Real-time:** immediate notification after tmux resize, no delay
- **Low overhead:** event-driven, no polling
- **Reliable:** official tmux mechanism

### 3.2 New WebSocket Message Types

**Agent → Server: `agent.terminal.resize`**

```rust
// crates/nession-common/src/protocol.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTerminalResizePayload {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}
```

**Server → Client: `terminal.resize`**

Reuses the message type name already used by CLI.

```rust
// crates/nession-common/src/protocol.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerTerminalResizePayload {
    pub cols: u16,
    pub rows: u16,
}
```

### 3.3 Message Flow

```
Agent detects tmux control mode event: %window-resize @1 120 40
  ↓ Parses: window_id=1, cols=120, rows=40
  ↓ Maps window_id → session_id (via tmux list-windows or attach response)
  ↓ msg_type: "agent.terminal.resize"
  ↓ payload: {session_id, cols: 120, rows: 40}
Server receives message
  ↓ Finds all clients attached to this session
  ↓ msg_type: "terminal.resize" (reuses CLI message type)
  ↓ payload: {cols: 120, rows: 40}
Client receives message
  ↓ ConnectionManager.onResize callback
  ↓ TerminalSizeManager.handleResize(120, 40)
  ↓ term.resize(120, 40)
  ↓ updateContainerSize(120, 40)
```

### 3.4 Agent Implementation

```rust
// crates/nession-agent/src/tmux/control_mode.rs
// Parse tmux control mode events
fn parse_window_resize(line: &str) -> Option<(String, u16, u16)> {
    // Format: %window-resize @window-id width height
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() >= 4 && parts[0] == "%window-resize" {
        let window_id = parts[1].trim_start_matches('@').to_string();
        let width: u16 = parts[2].parse().ok()?;
        let height: u16 = parts[3].parse().ok()?;
        Some((window_id, width, height))
    } else {
        None
    }
}
```

Agent maintains window_id → session_id mapping (via `tmux list-windows` or attach response).

### 3.5 Client Implementation

```typescript
// web/src/terminal/ConnectionManager.ts
case 'terminal.resize':
  const { cols, rows } = payload;
  this.onResize?.(cols, rows);
  break;
```

TerminalSizeManager listens to onResize callback:

```typescript
this.connection.onResize = (cols: number, rows: number) => {
  this.term.resize(cols, rows);
  this.updateContainerSize(cols, rows);
};
```

## 4. Component Changes

### 4.1 TerminalSizeManager (Refactored from ViewportManager)

**Responsibility:** Manage tmux-driven terminal dimensions, handle CSS overflow scrolling.

**Removed:**
- `FitAddon` related code (constructor parameter, `fit()` method, `scheduleFit()` method)
- `ResizeObserver` listening to viewport changes
- `scaleFont()` font scaling logic (no longer needed to adjust font based on viewport)
- `detectAndApplyProfile()` device detection (moved to ScalingManager)
- `installWheelIntercept()` wheel event interception (use browser native overflow scrolling)

**Kept:**
- `dispose()` resource cleanup
- `setTargetColumns()` (if still needed, but may not be under tmux-driven)

**Added:**
- `handleResize(cols: number, rows: number)` — respond to tmux resize message
- `updateContainerSize(cols: number, rows: number)` — update mount element CSS dimensions
- `getPixelSize()` — return current terminal pixel size (width × height), for ScalingManager

**Core Logic:**

```typescript
export class TerminalSizeManager {
  private mountElement: HTMLElement;
  private scrollContainer: HTMLElement;
  
  constructor(
    private term: Terminal,
    scrollContainer: HTMLElement,
    mountElement: HTMLElement,
  ) {
    this.scrollContainer = scrollContainer;
    this.mountElement = mountElement;
    // Initial size determined by tmux, first terminal.resize message received after attach
  }

  handleResize(cols: number, rows: number): void {
    // 1. Update xterm internal size
    this.term.resize(cols, rows);
    // 2. Update mount element CSS dimensions (pixel values)
    this.updateContainerSize(cols, rows);
  }

  private updateContainerSize(cols: number, rows: number): void {
    const cellWidth = this.term._core._renderService?.dimensions?.css?.cell.width ?? 8;
    const cellHeight = this.term._core._renderService?.dimensions?.css?.cell.height ?? 16;
    const width = cols * cellWidth;
    const height = rows * cellHeight;
    this.mountElement.style.width = `${width}px`;
    this.mountElement.style.height = `${height}px`;
  }

  dispose(): void {
    // Clean up resources
  }
}
```

**DOM Structure:**

```html
<div class="terminal-scroll-container" style="overflow: auto; width: 100%; height: 100%">
  <div class="terminal-mount" style="width: 960px; height: 480px">
    <!-- xterm.js renders here -->
  </div>
</div>
```

- `terminal-scroll-container`: fixed size (viewport), `overflow: auto` provides scrolling
- `terminal-mount`: size determined by tmux cols/rows, may be larger than scroll-container

### 4.2 ScalingManager (New)

**Responsibility:** Device detection, CSS transform scaling, manual zoom controls.

**Core Functionality:**

```typescript
export class ScalingManager {
  private scale: number = 1.0;
  private wrapperElement: HTMLElement;
  private deviceType: 'mobile' | 'tablet' | 'desktop';

  constructor(wrapperElement: HTMLElement) {
    this.wrapperElement = wrapperElement;
    this.deviceType = this.detectDevice();
    this.scale = this.getDefaultScale();
    this.applyScale();
  }

  private detectDevice(): 'mobile' | 'tablet' | 'desktop' {
    const width = window.innerWidth;
    if (width <= 768) return 'mobile';
    if (width <= 1024) return 'tablet';
    return 'desktop';
  }

  private getDefaultScale(): number {
    switch (this.deviceType) {
      case 'mobile': return 0.6;
      case 'tablet': return 0.8;
      case 'desktop': return 1.0;
    }
  }

  zoomIn(): void {
    this.scale = Math.min(3.0, this.scale + 0.1);
    this.applyScale();
  }

  zoomOut(): void {
    this.scale = Math.max(0.3, this.scale - 0.1);
    this.applyScale();
  }

  reset(): void {
    this.scale = this.getDefaultScale();
    this.applyScale();
  }

  private applyScale(): void {
    this.wrapperElement.style.transform = `scale(${this.scale})`;
    this.wrapperElement.style.transformOrigin = 'top left';
    // Adjust wrapper display size after scaling to avoid overflow calculation errors
    const inverseScale = 1 / this.scale;
    this.wrapperElement.style.width = `${inverseScale * 100}%`;
    this.wrapperElement.style.height = `${inverseScale * 100}%`;
  }

  getScale(): number {
    return this.scale;
  }
}
```

**DOM Structure Extension:**

```html
<div class="terminal-scaling-wrapper" style="transform: scale(0.8); transform-origin: top left">
  <div class="terminal-scroll-container" style="overflow: auto; width: 100%; height: 100%">
    <div class="terminal-mount" style="width: 960px; height: 480px">
      <!-- xterm.js renders here -->
    </div>
  </div>
</div>
```

### 4.3 TerminalToolbar Zoom Controls

Add zoom buttons to TerminalToolbar:

```typescript
// web/src/components/TerminalToolbar.tsx
<div className="flex items-center gap-2">
  <Button onClick={() => scalingRef.current?.zoomOut()} size="sm" variant="ghost">
    <Minus className="h-4 w-4" />
  </Button>
  <span className="text-sm font-mono">{Math.round(scalingRef.current?.getScale() * 100)}%</span>
  <Button onClick={() => scalingRef.current?.zoomIn()} size="sm" variant="ghost">
    <Plus className="h-4 w-4" />
  </Button>
  <Button onClick={() => scalingRef.current?.reset()} size="sm" variant="ghost">
    <RotateCcw className="h-4 w-4" />
  </Button>
</div>
```

## 5. CSS/Rendering Strategy

### 5.1 Container Hierarchy

```html
<!-- JSX returned by Terminal.tsx -->
<div className="flex-1 min-w-0 min-h-0 relative">
  {/* Reconnection banner overlay */}
  {banner !== 'none' && <ReconnectBanner />}
  
  {/* Scaling layer: CSS transform applied here */}
  <div 
    ref={scalingWrapperRef}
    className="h-full w-full"
    style={{
      transform: `scale(${scale})`,
      transformOrigin: 'top left',
      // Adjust size after scaling to avoid overflow calculation errors
      width: `${100 / scale}%`,
      height: `${100 / scale}%`,
    }}
  >
    {/* Scrolling layer: overflow handling */}
    <div
      ref={scrollContainerRef}
      className="h-full w-full"
      style={{ 
        overflow: 'auto',
        backgroundColor: '#1e1e2e', // terminal background color
      }}
    >
      {/* Mount layer: xterm.js renders here, size determined by tmux */}
      <div
        ref={mountRef}
        style={{
          width: '960px',  // dynamically set by TerminalSizeManager
          height: '480px', // dynamically set by TerminalSizeManager
        }}
      />
    </div>
  </div>
</div>
```

### 5.2 CSS Transform Scaling Principle

**Problem:** If `transform: scale(0.8)` is applied directly to scroll-container, overflow scrolling calculates based on scaled size, causing incorrect scroll range.

**Solution:** Apply scaling to wrapper, and adjust wrapper size to `100% / scale`:

```css
.wrapper {
  transform: scale(0.8);
  transform-origin: top left;
  width: 125%;   /* 100% / 0.8 = 125% */
  height: 125%;
}
```

This way:
- wrapper visually shrinks to 80%
- but wrapper occupies 125% space, ensuring scroll-container can scroll completely
- mount element inside scroll-container has size determined by tmux (e.g., 960×480px)
- browser overflow calculates scroll range based on mount's actual pixel size

### 5.3 xterm.js Cell Size Calculation

TerminalSizeManager needs to know each character cell's pixel size to convert cols/rows to pixel dimensions:

```typescript
private updateContainerSize(cols: number, rows: number): void {
  // xterm.js internal API: get cell pixel size
  const renderService = (this.term as any)._core._renderService;
  const cellWidth = renderService?.dimensions?.css?.cell?.width ?? 8;
  const cellHeight = renderService?.dimensions?.css?.cell?.height ?? 16;
  
  const width = cols * cellWidth;
  const height = rows * cellHeight;
  
  this.mountElement.style.width = `${width}px`;
  this.mountElement.style.height = `${height}px`;
}
```

**Note:** This is xterm.js internal API, may change in future versions. Alternative is to use `FitAddon.getDimensions()` or listen to `term.onResize` event to get cell size.

### 5.4 Mobile Touch Scrolling

CSS `overflow: auto` automatically supports touch scrolling on mobile, but iOS Safari doesn't have inertial scrolling by default. Need to add:

```css
.terminal-scroll-container {
  -webkit-overflow-scrolling: touch; /* iOS inertial scrolling */
  overscroll-behavior: contain; /* prevent scroll propagation to parent */
}
```

### 5.5 Wheel Event Handling

Current ViewportManager intercepts wheel events (`installWheelIntercept`) for xterm's internal scrollback scrolling.

**Under new architecture:** Browser native overflow scrolling handles wheel events, but xterm's internal scrollback scrolling still needs interception.

**Strategy:**
- If terminal content exceeds rows (has scrollback), intercept wheel events, call `term.scrollLines()`
- If terminal content doesn't exceed rows, don't intercept, let browser handle overflow scrolling
- Or: always intercept wheel events for xterm scrollback, users use touch or scrollbar for overflow area

**Recommended:** Keep current wheel interception logic for xterm scrollback. Overflow scrolling mainly via touch (mobile) or dragging scrollbar (desktop).

## 6. Testing Strategy

### 6.1 Unit Tests

1. **TerminalSizeManager.test.ts**
   - Test `handleResize(cols, rows)` correctly calls `term.resize()` and updates container size
   - Test `updateContainerSize()` correctly calculates pixel size (cols × cellWidth, rows × cellHeight)
   - Test `dispose()` cleans up resources

2. **ScalingManager.test.ts**
   - Test `detectDevice()` returns correct device type based on viewport width
   - Test `getDefaultScale()` returns correct default scale (mobile=0.6, tablet=0.8, desktop=1.0)
   - Test `zoomIn()`/`zoomOut()`/`reset()` correctly adjust scale and apply CSS transform
   - Test `applyScale()` correctly sets wrapper size to `100% / scale`

3. **ConnectionManager.test.ts**
   - Test receiving `terminal.resize` message calls `onResize` callback

**Integration Tests:**

4. **TerminalView.test.ts**
   - Test complete resize flow: simulate receiving `terminal.resize` message → xterm size updates → container size updates
   - Test zoom functionality: zoomIn/zoomOut/reset correctly applies CSS transform

### 6.2 E2E Tests (Playwright)

**Test Scenarios:**

1. **tmux resize sync**
   ```typescript
   // 1. Attach to session, initial size 80×24
   // 2. Execute in terminal: tmux resize-window -x 120 -y 40
   // 3. Verify xterm cols/rows immediately updates to 120×40
   // 4. Verify container size updates (120 * cellWidth, 40 * cellHeight)
   ```

2. **overflow scrolling**
   ```typescript
   // 1. Create tmux session size 200×60
   // 2. In 1920×1080 viewport, verify horizontal and vertical scrollbars appear
   // 3. Scroll to bottom-right, verify content displays completely
   // 4. In iPhone (375×667) viewport, verify scrollbars appear and touch scrolling works
   ```

3. **zoom functionality**
   ```typescript
   // 1. In iPhone viewport, verify default scale is 0.6
   // 2. Click + button, verify scale increases to 0.7, CSS transform updates
   // 3. Click - button, verify scale decreases to 0.6
   // 4. Click reset button, verify restores to default 0.6
   // 5. In Desktop viewport, verify default scale is 1.0
   ```

4. **multi-client sync**
   ```typescript
   // 1. Two browser windows attach to same session
   // 2. Resize tmux in one window
   // 3. Verify other window also updates size immediately
   ```

### 6.3 Manual Verification Checklist

**Mobile experience:**
- [ ] iPhone Safari: terminal content readable, touch scrolling smooth
- [ ] iPad Safari: scale appropriate, landscape/portrait rotation works
- [ ] Android Chrome: touch scrolling normal, zoom controls clickable

**Desktop experience:**
- [ ] Chrome/Firefox/Safari/Edge: default scale 1.0, no distortion
- [ ] tmux resize triggers immediate web update
- [ ] overflow scrollbar position correct, dragging scrollbar smooth

**Edge cases:**
- [ ] Very small tmux size (40×10): no scrollbar, renders normally
- [ ] Very large tmux size (300×100): scrollbar appears, content complete
- [ ] Rapid consecutive resize: web doesn't lag, messages don't pile up
- [ ] Multiple clients connected: one resizes, others sync

### 6.4 Performance Baseline

**No special optimization needed** because:
- CSS transform is GPU accelerated
- overflow scrolling is browser native capability
- tmux resize event frequency is very low (manual user operation)

**Monitoring metrics:**
- Latency from tmux resize → web update (target < 100ms)
- Frame rate during zoom (target 60fps)

## 7. Migration Plan

### Phase 1: Protocol Layer (1-2 days)
- Add `AgentTerminalResizePayload` and `ServerTerminalResizePayload` to protocol.rs
- Implement tmux control mode event parsing in agent
- Implement message broadcasting in server
- Implement message handling in client ConnectionManager

### Phase 2: TerminalSizeManager (2-3 days)
- Remove FitAddon from AddonManager
- Refactor ViewportManager → TerminalSizeManager
- Remove fit/ResizeObserver/font scaling logic
- Add handleResize and updateContainerSize methods
- Update Terminal.tsx to use TerminalSizeManager

### Phase 3: ScalingManager (1-2 days)
- Create ScalingManager with device detection and CSS transform
- Add scaling wrapper to Terminal.tsx DOM structure
- Add zoom controls to TerminalToolbar

### Phase 4: Testing (2-3 days)
- Write unit tests for TerminalSizeManager and ScalingManager
- Write integration tests for TerminalView
- Write E2E tests with Playwright
- Manual testing on multiple devices

### Phase 5: Documentation (0.5 day)
- Update README with zoom controls usage
- Take Playwright screenshots for PR
- Create PR with screenshots

**Total estimated time:** 7-10 days (aligns with 1-2 week timeline from requirements)

## 8. Risks and Mitigations

### Risk 1: xterm.js Internal API Changes
**Risk:** TerminalSizeManager uses `term._core._renderService` to get cell size, which is internal API.
**Mitigation:** Add fallback logic. If internal API unavailable, use `FitAddon.getDimensions()` or calculate from terminal element size / cols.

### Risk 2: CSS Transform Scaling Edge Cases
**Risk:** Certain zoom levels may cause blurriness or rendering artifacts.
**Mitigation:** Test across browsers and devices. If issues found, consider using `will-change: transform` CSS hint.

### Risk 3: tmux Control Mode Availability
**Risk:** Older tmux versions may not support control mode events.
**Mitigation:** Check tmux version on agent startup. If < 3.0, fall back to polling (500ms interval). Document minimum tmux version requirement.

## 9. Future Enhancements (Out of Scope)

- **Persistent zoom preference:** localStorage to remember user's zoom preference across sessions
- **Session creation with device-based initial size:** create sessions with size optimized for device
- **P2P vs relay mode differentiation:** different scaling strategies for different connection modes
- **Virtual scrolling for very large terminals:** optimize rendering for 300×100+ terminals
- **Keyboard shortcuts for zoom:** Ctrl+= / Ctrl+- for zoom in/out

---

**Document Status:** Draft — awaiting user review
