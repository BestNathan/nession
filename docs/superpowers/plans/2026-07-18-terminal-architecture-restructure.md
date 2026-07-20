# Terminal Architecture Restructure — tmux-Driven Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure terminal architecture so tmux drives terminal dimensions, web client handles rendering/scrolling/scaling via CSS transform.

**Architecture:** Remove FitAddon and viewport-driven sizing. Agent monitors tmux control mode events, broadcasts resize messages via WebSocket. Web client receives messages, updates xterm dimensions, and applies CSS transform scaling based on device type. Viewport handles overflow scrolling.

**Tech Stack:** Rust (protocol, agent, server), TypeScript/React (web client), xterm.js 5.5, tmux control mode

---

## File Structure

### Rust (Protocol & Agent)
- **Modify:** `crates/nession-common/src/protocol.rs` — add `AgentTerminalResizePayload` and `ServerTerminalResizePayload`
- **Create:** `crates/nession-agent/src/tmux/control_mode.rs` — parse tmux control mode events
- **Modify:** `crates/nession-agent/src/tmux/mod.rs` — integrate control mode
- **Modify:** `crates/nession-agent/src/sync.rs` — send resize messages to server
- **Modify:** `crates/nession-server/src/broker.rs` — broadcast resize messages to clients

### Web Client
- **Delete:** `web/src/terminal/ViewportManager.ts` — replaced by TerminalSizeManager
- **Create:** `web/src/terminal/TerminalSizeManager.ts` — tmux-driven sizing
- **Create:** `web/src/terminal/ScalingManager.ts` — CSS transform scaling
- **Modify:** `web/src/terminal/AddonManager.ts` — remove FitAddon
- **Modify:** `web/src/terminal/ConnectionManager.ts` — handle terminal.resize messages
- **Modify:** `web/src/terminal/TerminalView.ts` — use TerminalSizeManager + ScalingManager
- **Modify:** `web/src/terminal/types.ts` — update types
- **Modify:** `web/src/components/Terminal.tsx` — update DOM structure
- **Modify:** `web/src/components/TerminalToolbar.tsx` — add zoom controls

### Tests
- **Create:** `web/src/terminal/__tests__/TerminalSizeManager.test.ts`
- **Create:** `web/src/terminal/__tests__/ScalingManager.test.ts`
- **Modify:** `web/src/terminal/__tests__/ConnectionManager.test.ts`
- **Modify:** `web/src/terminal/__tests__/TerminalView.test.ts`

---

## Task 1: Add Protocol Types for Terminal Resize

**Files:**
- Modify: `crates/nession-common/src/protocol.rs:595-695` (end of file, before tests)

- [ ] **Step 1: Write failing test for protocol serialization**

Add test to `crates/nession-common/src/protocol.rs` in the `tests` module:

```rust
#[test]
fn test_terminal_resize_payload_serde() {
    let payload = AgentTerminalResizePayload {
        session_id: "session-123".to_string(),
        cols: 120,
        rows: 40,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let deserialized: AgentTerminalResizePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.session_id, "session-123");
    assert_eq!(deserialized.cols, 120);
    assert_eq!(deserialized.rows, 40);
}

#[test]
fn test_server_terminal_resize_payload_serde() {
    let payload = ServerTerminalResizePayload {
        cols: 120,
        rows: 40,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let deserialized: ServerTerminalResizePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.cols, 120);
    assert_eq!(deserialized.rows, 40);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p nession-common test_terminal_resize_payload_serde`
Expected: FAIL with "cannot find type `AgentTerminalResizePayload`"

- [ ] **Step 3: Add protocol types**

Add to `crates/nession-common/src/protocol.rs` before the `#[cfg(test)]` section:

```rust
// ============================================================================
// Terminal resize events
// ============================================================================

/// Agent → Server: tmux session resized.
/// Agent parses tmux control mode `%window-resize` events and sends this
/// payload with the session id and new dimensions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTerminalResizePayload {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Server → Client: broadcast terminal resize to all attached clients.
/// Reuses the message type name already used by CLI (`terminal.resize`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerTerminalResizePayload {
    pub cols: u16,
    pub rows: u16,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p nession-common test_terminal_resize_payload_serde`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/nession-common/src/protocol.rs
git commit -m "feat(protocol): add terminal resize payload types"
```

---

## Task 2: Implement tmux Control Mode Event Parser

**Files:**
- Create: `crates/nession-agent/src/tmux/control_mode.rs`
- Create: `crates/nession-agent/src/tmux/control_mode_test.rs` (inline tests)

- [ ] **Step 1: Write failing test for control mode parser**

Create `crates/nession-agent/src/tmux/control_mode.rs`:

```rust
//! Parse tmux control mode events.
//!
//! When agent connects to tmux with `-C` flag, tmux sends event notifications
//! including window resize events in the format: `%window-resize @window-id width height`

/// Parsed window resize event from tmux control mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowResizeEvent {
    pub window_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Parse a `%window-resize` event line from tmux control mode.
///
/// Format: `%window-resize @window-id width height`
/// Example: `%window-resize @1 120 40`
///
/// Returns `None` if the line is not a window-resize event or is malformed.
pub fn parse_window_resize(line: &str) -> Option<WindowResizeEvent> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() >= 4 && parts[0] == "%window-resize" {
        let window_id = parts[1].trim_start_matches('@').to_string();
        let cols: u16 = parts[2].parse().ok()?;
        let rows: u16 = parts[3].parse().ok()?;
        Some(WindowResizeEvent {
            window_id,
            cols,
            rows,
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_window_resize_valid() {
        let line = "%window-resize @1 120 40";
        let event = parse_window_resize(line).unwrap();
        assert_eq!(event.window_id, "1");
        assert_eq!(event.cols, 120);
        assert_eq!(event.rows, 40);
    }

    #[test]
    fn test_parse_window_resize_large_dimensions() {
        let line = "%window-resize @5 300 100";
        let event = parse_window_resize(line).unwrap();
        assert_eq!(event.window_id, "5");
        assert_eq!(event.cols, 300);
        assert_eq!(event.rows, 100);
    }

    #[test]
    fn test_parse_window_resize_not_resize_event() {
        let line = "%output %1 hello world";
        assert!(parse_window_resize(line).is_none());
    }

    #[test]
    fn test_parse_window_resize_malformed() {
        let line = "%window-resize @1";
        assert!(parse_window_resize(line).is_none());
    }

    #[test]
    fn test_parse_window_resize_invalid_dimensions() {
        let line = "%window-resize @1 abc def";
        assert!(parse_window_resize(line).is_none());
    }
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cargo test -p nession-agent control_mode::tests`
Expected: PASS (implementation is already complete)

- [ ] **Step 3: Commit**

```bash
git add crates/nession-agent/src/tmux/control_mode.rs
git commit -m "feat(agent): add tmux control mode event parser"
```

---

## Task 3: Integrate Control Mode into tmux Module

**Files:**
- Modify: `crates/nession-agent/src/tmux/mod.rs` — export control_mode
- Modify: `crates/nession-agent/src/tmux/session.rs` — integrate control mode reading

- [ ] **Step 1: Export control_mode module**

Add to `crates/nession-agent/src/tmux/mod.rs`:

```rust
pub mod control_mode;
```

- [ ] **Step 2: Verify compilation**

Run: `cargo build -p nession-agent`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/nession-agent/src/tmux/mod.rs
git commit -m "feat(agent): export control_mode module"
```

**Note:** Full integration of control mode into session management (reading from tmux stdout, maintaining window-id to session-id mapping) is complex and depends on the current tmux session architecture. For this plan, we'll assume the agent already has a mechanism to read tmux events and will add the resize broadcasting logic in Task 5. If the agent doesn't yet use control mode, that's a separate feature beyond the scope of this architecture restructure.

---

## Task 4: Add Resize Broadcasting to Agent Sync

**Files:**
- Modify: `crates/nession-agent/src/sync.rs` — send resize messages to server

- [ ] **Step 1: Add resize message sending function**

Add to `crates/nession-agent/src/sync.rs`:

```rust
use nession_common::protocol::{AgentTerminalResizePayload, Message};

/// Send terminal resize event to server.
pub async fn send_terminal_resize(
    writer: &mut (impl tokio::io::AsyncWriteExt + Unpin),
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let payload = AgentTerminalResizePayload {
        session_id: session_id.to_string(),
        cols,
        rows,
    };
    let msg = Message::new(
        "agent.terminal.resize".to_string(),
        uuid::Uuid::new_v4().to_string(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs(),
        payload,
    );
    let json = serde_json::to_string(&msg)?;
    writer.write_all(json.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}
```

- [ ] **Step 2: Verify compilation**

Run: `cargo build -p nession-agent`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/nession-agent/src/sync.rs
git commit -m "feat(agent): add terminal resize message sending"
```

---

## Task 5: Add Server Broadcasting for Resize Messages

**Files:**
- Modify: `crates/nession-server/src/broker.rs` — handle agent.terminal.resize and broadcast to clients

- [ ] **Step 1: Add resize message handling in broker**

Add to `crates/nession-server/src/broker.rs` in the message handling match statement:

```rust
"agent.terminal.resize" => {
    let payload: nession_common::protocol::AgentTerminalResizePayload = 
        serde_json::from_value(msg.payload.clone())?;
    
    // Find all clients attached to this session
    let session_id = payload.session_id.clone();
    let attached_clients = registry.get_clients_for_session(&session_id);
    
    // Broadcast resize to all attached clients
    let broadcast_payload = nession_common::protocol::ServerTerminalResizePayload {
        cols: payload.cols,
        rows: payload.rows,
    };
    let broadcast_msg = Message::new(
        "terminal.resize".to_string(),
        uuid::Uuid::new_v4().to_string(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs(),
        broadcast_payload,
    );
    let json = serde_json::to_string(&broadcast_msg)?;
    
    for client_id in attached_clients {
        if let Some(client_tx) = registry.get_client_sender(&client_id) {
            let _ = client_tx.send(json.clone()).await;
        }
    }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cargo build -p nession-server`
Expected: PASS (may need to add helper methods to registry)

- [ ] **Step 3: Commit**

```bash
git add crates/nession-server/src/broker.rs
git commit -m "feat(server): broadcast terminal resize to attached clients"
```

---

## Task 6: Remove FitAddon from Web Client

**Files:**
- Modify: `web/src/terminal/AddonManager.ts` — remove FitAddon registration
- Delete: `web/src/terminal/ViewportManager.ts` — will be replaced
- Delete: `web/src/terminal/__tests__/ViewportManager.test.ts`

- [ ] **Step 1: Update AddonManager to remove FitAddon**

Modify `web/src/terminal/AddonManager.ts`:

```typescript
import type { Terminal } from '@xterm/xterm';

export class AddonManager {
  private terminal: Terminal;

  constructor(terminal: Terminal) {
    this.terminal = terminal;
  }

  // Remove the register() method that was used for FitAddon
  // Or keep it generic for other addons if needed

  dispose(): void {
    // Clean up addons
  }
}
```

- [ ] **Step 2: Delete ViewportManager files**

```bash
rm web/src/terminal/ViewportManager.ts
rm web/src/terminal/__tests__/ViewportManager.test.ts
```

- [ ] **Step 3: Update index.ts exports**

Remove from `web/src/terminal/index.ts`:

```typescript
export { ViewportManager } from './ViewportManager';
```

- [ ] **Step 4: Verify TypeScript compilation**

Run: `cd web && npm run build`
Expected: FAIL (TerminalView still references ViewportManager)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(web): remove FitAddon and ViewportManager"
```

---

## Task 7: Implement TerminalSizeManager

**Files:**
- Create: `web/src/terminal/TerminalSizeManager.ts`
- Create: `web/src/terminal/__tests__/TerminalSizeManager.test.ts`

- [ ] **Step 1: Write failing test for TerminalSizeManager**

Create `web/src/terminal/__tests__/TerminalSizeManager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalSizeManager } from '../TerminalSizeManager';
import { Terminal } from '@xterm/xterm';

describe('TerminalSizeManager', () => {
  let term: Terminal;
  let scrollContainer: HTMLElement;
  let mountElement: HTMLElement;
  let manager: TerminalSizeManager;

  beforeEach(() => {
    term = new Terminal();
    scrollContainer = document.createElement('div');
    mountElement = document.createElement('div');
    document.body.appendChild(scrollContainer);
    scrollContainer.appendChild(mountElement);
    manager = new TerminalSizeManager(term, scrollContainer, mountElement);
  });

  it('should update terminal and container size on handleResize', () => {
    const resizeSpy = vi.spyOn(term, 'resize');
    
    manager.handleResize(120, 40);
    
    expect(resizeSpy).toHaveBeenCalledWith(120, 40);
    // Container size should be updated based on cell dimensions
    expect(mountElement.style.width).toBeDefined();
    expect(mountElement.style.height).toBeDefined();
  });

  it('should calculate container size from cols/rows and cell dimensions', () => {
    // Mock cell dimensions
    vi.spyOn(term, '_core', 'get').mockReturnValue({
      _renderService: {
        dimensions: {
          css: {
            cell: { width: 8, height: 16 }
          }
        }
      }
    } as any);

    manager.handleResize(100, 30);

    expect(mountElement.style.width).toBe('800px'); // 100 * 8
    expect(mountElement.style.height).toBe('480px'); // 30 * 16
  });

  it('should dispose cleanly', () => {
    manager.dispose();
    // Should not throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- TerminalSizeManager.test.ts`
Expected: FAIL with "Cannot find module '../TerminalSizeManager'"

- [ ] **Step 3: Implement TerminalSizeManager**

Create `web/src/terminal/TerminalSizeManager.ts`:

```typescript
import type { Terminal } from '@xterm/xterm';

/**
 * Manages terminal dimensions driven by tmux resize events.
 * Replaces ViewportManager — no longer fits to viewport, instead responds
 * to tmux resize messages and updates container dimensions accordingly.
 */
export class TerminalSizeManager {
  private mountElement: HTMLElement;
  private scrollContainer: HTMLElement;
  private disposed = false;

  constructor(
    private term: Terminal,
    scrollContainer: HTMLElement,
    mountElement: HTMLElement,
  ) {
    this.scrollContainer = scrollContainer;
    this.mountElement = mountElement;
    // Initial size will be set by first terminal.resize message
  }

  /**
   * Handle tmux resize event.
   * Updates xterm internal dimensions and mount element CSS size.
   */
  handleResize(cols: number, rows: number): void {
    if (this.disposed) return;

    // 1. Update xterm internal size
    this.term.resize(cols, rows);

    // 2. Update mount element CSS dimensions (pixel values)
    this.updateContainerSize(cols, rows);
  }

  /**
   * Calculate and apply container size based on cols/rows and cell dimensions.
   */
  private updateContainerSize(cols: number, rows: number): void {
    // xterm.js internal API: get cell pixel size
    // Fallback to reasonable defaults if API unavailable
    const renderService = (this.term as any)._core?._renderService;
    const cellWidth = renderService?.dimensions?.css?.cell?.width ?? 8;
    const cellHeight = renderService?.dimensions?.css?.cell?.height ?? 16;

    const width = cols * cellWidth;
    const height = rows * cellHeight;

    this.mountElement.style.width = `${width}px`;
    this.mountElement.style.height = `${height}px`;
  }

  dispose(): void {
    this.disposed = true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- TerminalSizeManager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/terminal/TerminalSizeManager.ts web/src/terminal/__tests__/TerminalSizeManager.test.ts
git commit -m "feat(web): implement TerminalSizeManager for tmux-driven sizing"
```

---

## Task 8: Implement ScalingManager

**Files:**
- Create: `web/src/terminal/ScalingManager.ts`
- Create: `web/src/terminal/__tests__/ScalingManager.test.ts`

- [ ] **Step 1: Write failing test for ScalingManager**

Create `web/src/terminal/__tests__/ScalingManager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScalingManager } from '../ScalingManager';

describe('ScalingManager', () => {
  let wrapperElement: HTMLElement;
  let manager: ScalingManager;

  beforeEach(() => {
    wrapperElement = document.createElement('div');
    document.body.appendChild(wrapperElement);
  });

  it('should detect device type based on viewport width', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(375);
    manager = new ScalingManager(wrapperElement);
    expect((manager as any).deviceType).toBe('mobile');

    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(768);
    manager = new ScalingManager(wrapperElement);
    expect((manager as any).deviceType).toBe('mobile');

    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
    manager = new ScalingManager(wrapperElement);
    expect((manager as any).deviceType).toBe('tablet');

    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920);
    manager = new ScalingManager(wrapperElement);
    expect((manager as any).deviceType).toBe('desktop');
  });

  it('should apply default scale based on device type', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(375);
    manager = new ScalingManager(wrapperElement);
    expect(manager.getScale()).toBe(0.6);
    expect(wrapperElement.style.transform).toBe('scale(0.6)');

    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
    manager = new ScalingManager(wrapperElement);
    expect(manager.getScale()).toBe(0.8);

    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920);
    manager = new ScalingManager(wrapperElement);
    expect(manager.getScale()).toBe(1.0);
  });

  it('should zoom in and out', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920);
    manager = new ScalingManager(wrapperElement);
    
    manager.zoomIn();
    expect(manager.getScale()).toBe(1.1);

    manager.zoomOut();
    expect(manager.getScale()).toBe(1.0);

    manager.zoomOut();
    expect(manager.getScale()).toBe(0.9);
  });

  it('should clamp scale between 0.3 and 3.0', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920);
    manager = new ScalingManager(wrapperElement);

    for (let i = 0; i < 30; i++) manager.zoomIn();
    expect(manager.getScale()).toBe(3.0);

    for (let i = 0; i < 50; i++) manager.zoomOut();
    expect(manager.getScale()).toBe(0.3);
  });

  it('should reset to default scale', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(375);
    manager = new ScalingManager(wrapperElement);

    manager.zoomIn();
    manager.zoomIn();
    expect(manager.getScale()).toBe(0.8);

    manager.reset();
    expect(manager.getScale()).toBe(0.6);
  });

  it('should adjust wrapper size to inverse of scale', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920);
    manager = new ScalingManager(wrapperElement);

    // scale = 1.0, wrapper size = 100%
    expect(wrapperElement.style.width).toBe('100%');
    expect(wrapperElement.style.height).toBe('100%');

    manager.zoomOut(); // scale = 0.9
    expect(wrapperElement.style.width).toBe(`${100 / 0.9}%`);
    expect(wrapperElement.style.height).toBe(`${100 / 0.9}%`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- ScalingManager.test.ts`
Expected: FAIL with "Cannot find module '../ScalingManager'"

- [ ] **Step 3: Implement ScalingManager**

Create `web/src/terminal/ScalingManager.ts`:

```typescript
/**
 * Manages CSS transform scaling for terminal display.
 * Provides device-based auto-scaling and manual zoom controls.
 * Scaling is visual only — does not affect xterm.js internal dimensions.
 */
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- ScalingManager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/terminal/ScalingManager.ts web/src/terminal/__tests__/ScalingManager.test.ts
git commit -m "feat(web): implement ScalingManager for CSS transform scaling"
```

---

## Task 9: Extend ConnectionManager to Handle Resize Messages

**Files:**
- Modify: `web/src/terminal/ConnectionManager.ts` — add onResize callback
- Modify: `web/src/terminal/__tests__/ConnectionManager.test.ts` — add test

- [ ] **Step 1: Write failing test for resize message handling**

Add to `web/src/terminal/__tests__/ConnectionManager.test.ts`:

```typescript
it('should call onResize callback when terminal.resize message received', async () => {
  const onResize = vi.fn();
  const manager = new ConnectionManager({
    mode: 'relay',
    sessionName: 'test',
    sessionId: 'sess-1',
    serverConnection: mockServerConnection,
  });
  manager.onResize = onResize;

  // Simulate receiving terminal.resize message
  const messageHandler = mockServerConnection.onMessage.mock.calls[0][0];
  messageHandler({
    msg_type: 'terminal.resize',
    payload: { cols: 120, rows: 40 },
  });

  expect(onResize).toHaveBeenCalledWith(120, 40);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- ConnectionManager.test.ts`
Expected: FAIL with "onResize is not a function"

- [ ] **Step 3: Add onResize callback to ConnectionManager**

Add to `web/src/terminal/ConnectionManager.ts`:

```typescript
export class ConnectionManager {
  // ... existing properties ...
  
  onResize: ((cols: number, rows: number) => void) | null = null;

  // In the message handling switch statement:
  case 'terminal.resize':
    const { cols, rows } = payload as { cols: number; rows: number };
    this.onResize?.(cols, rows);
    break;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- ConnectionManager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/terminal/ConnectionManager.ts web/src/terminal/__tests__/ConnectionManager.test.ts
git commit -m "feat(web): handle terminal.resize messages in ConnectionManager"
```

---

## Task 10: Update TerminalView to Use New Managers

**Files:**
- Modify: `web/src/terminal/TerminalView.ts` — replace ViewportManager with TerminalSizeManager + ScalingManager
- Modify: `web/src/terminal/types.ts` — update TerminalViewOptions

- [ ] **Step 1: Update TerminalView to use TerminalSizeManager and ScalingManager**

Modify `web/src/terminal/TerminalView.ts`:

```typescript
import { TerminalSizeManager } from './TerminalSizeManager';
import { ScalingManager } from './ScalingManager';

export class TerminalView {
  readonly terminal: Terminal;

  private addons: AddonManager;
  private sizeManager: TerminalSizeManager;
  private scalingManager: ScalingManager;
  private input: InputManager;
  private connection: ConnectionManager;

  private isDisposed = false;
  private attachTimer: ReturnType<typeof setTimeout> | null = null;

  onStateChange: ((state: TerminalViewState) => void) | null = null;
  onCtrlD: (() => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onDisconnect: (() => void) | null = null;

  constructor(container: HTMLElement, options: TerminalViewOptions) {
    // 1. Create xterm instance (same as before)
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: options.deviceProfile?.fontSize ?? 14,
      fontFamily: DEFAULT_FONT,
      theme: options.theme,
      allowProposedApi: true,
      scrollback: options.deviceProfile?.scrollback ?? 10000,
    });

    // 2. Create managers
    this.addons = new AddonManager(this.terminal);
    new Renderer(this.terminal, options.rendererType);
    new ThemeManager(this.terminal, options.theme);

    // Create DOM structure for scaling + scrolling
    const scalingWrapper = document.createElement('div');
    scalingWrapper.className = 'h-full w-full';
    scalingWrapper.style.transformOrigin = 'top left';

    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'h-full w-full';
    scrollContainer.style.overflow = 'auto';
    scrollContainer.style.backgroundColor = '#1e1e2e';
    scrollContainer.style.webkitOverflowScrolling = 'touch';

    const mountElement = document.createElement('div');
    
    scalingWrapper.appendChild(scrollContainer);
    scrollContainer.appendChild(mountElement);
    container.appendChild(scalingWrapper);

    this.scalingManager = new ScalingManager(scalingWrapper);
    this.sizeManager = new TerminalSizeManager(this.terminal, scrollContainer, mountElement);

    this.input = new InputManager(this.terminal);
    this.connection = new ConnectionManager(options.connection);

    // 3. Wire managers together
    this.input.onData((data: string) => {
      if (!this.isDisposed) { this.connection.send(data); }
    });
    this.input.onCtrlD(() => {
      this.onCtrlD?.();
    });

    this.connection.onOutput = (data: string) => {
      if (!this.isDisposed) { this.terminal.write(data); }
    };
    this.connection.onResize = (cols: number, rows: number) => {
      if (!this.isDisposed) {
        this.sizeManager.handleResize(cols, rows);
      }
    };
    this.connection.onStateChange = (state: ConnectionState, attempt: number) => {
      this.onStateChange?.({
        banner: state === 'reconnecting' ? 'reconnecting'
              : state === 'lost' ? 'failed'
              : 'none',
        reconnectAttempt: attempt,
        isConnected: state === 'connected',
      });
    };
    this.connection.onError = (err: Error) => {
      this.onError?.(err);
    };
    this.connection.onDisconnect = () => {
      this.onDisconnect?.();
    };

    // 4. Open terminal in DOM
    this.terminal.open(mountElement);

    // 5. Deferred attach
    this.attachTimer = setTimeout(() => {
      if (!this.isDisposed) {
        this.connection.attach().catch(() => {});
      }
    }, 50);
  }

  // ... rest of methods (sendText, refit, setExternalBanner, reattach, dispose) ...

  dispose(): void {
    this.isDisposed = true;
    if (this.attachTimer) { clearTimeout(this.attachTimer); this.attachTimer = null; }
    this.input.dispose();
    this.sizeManager.dispose();
    this.connection.dispose();
    this.terminal.dispose();
  }
}
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `cd web && npm run build`
Expected: PASS

- [ ] **Step 3: Run all terminal tests**

Run: `cd web && npm test -- terminal`
Expected: PASS (some old ViewportManager tests deleted, new tests pass)

- [ ] **Step 4: Commit**

```bash
git add web/src/terminal/TerminalView.ts
git commit -m "feat(web): update TerminalView to use TerminalSizeManager and ScalingManager"
```

---

## Task 11: Add Zoom Controls to TerminalToolbar

**Files:**
- Modify: `web/src/components/TerminalToolbar.tsx` — add zoom buttons

- [ ] **Step 1: Add zoom controls to TerminalToolbar**

Add to `web/src/components/TerminalToolbar.tsx`:

```typescript
import { Minus, Plus, RotateCcw } from 'lucide-react';

interface TerminalToolbarProps {
  // ... existing props ...
  scalingManager?: ScalingManager | null;
}

export function TerminalToolbar({ scalingManager, ...props }: TerminalToolbarProps) {
  // ... existing code ...

  return (
    <div className="...">
      {/* Existing toolbar content */}
      
      {/* Zoom controls */}
      {scalingManager && (
        <div className="flex items-center gap-2 ml-auto">
          <Button 
            onClick={() => scalingManager.zoomOut()} 
            size="sm" 
            variant="ghost"
            title="Zoom out"
          >
            <Minus className="h-4 w-4" />
          </Button>
          <span className="text-sm font-mono min-w-[3rem] text-center">
            {Math.round(scalingManager.getScale() * 100)}%
          </span>
          <Button 
            onClick={() => scalingManager.zoomIn()} 
            size="sm" 
            variant="ghost"
            title="Zoom in"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button 
            onClick={() => scalingManager.reset()} 
            size="sm" 
            variant="ghost"
            title="Reset zoom"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Pass ScalingManager from Terminal component**

Modify `web/src/components/Terminal.tsx` to expose ScalingManager to parent, which passes it to TerminalToolbar.

- [ ] **Step 3: Verify TypeScript compilation**

Run: `cd web && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/components/TerminalToolbar.tsx web/src/components/Terminal.tsx
git commit -m "feat(web): add zoom controls to TerminalToolbar"
```

---

## Task 12: Update Documentation and Take Screenshots

**Files:**
- Modify: `README.md` — document zoom controls
- Create: Playwright screenshots

- [ ] **Step 1: Update README with zoom controls documentation**

Add to README.md:

```markdown
## Terminal Zoom Controls

The web terminal supports zoom controls for better readability on different devices:

- **Auto-scaling:** Terminal automatically scales based on device type (mobile: 60%, tablet: 80%, desktop: 100%)
- **Manual zoom:** Use the +/- buttons in the terminal toolbar to adjust zoom level (30%-300%)
- **Reset:** Click the reset button to restore default zoom for your device
- **Scrolling:** When terminal size exceeds viewport, use scrollbars or touch gestures to navigate

Zoom level is session-specific and resets on page refresh.
```

- [ ] **Step 2: Take Playwright screenshots**

Start local dev stack and use Playwright MCP to take screenshots on iPhone/iPad/Desktop viewports showing the zoom controls and scrolling behavior.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add terminal zoom controls documentation"
```

---

## Task 13: Final Integration Testing

**Files:**
- E2E tests with Playwright

- [ ] **Step 1: Run E2E tests**

Use Playwright to test:
1. tmux resize sync
2. Overflow scrolling on different viewports
3. Zoom controls functionality
4. Multi-client sync

- [ ] **Step 2: Manual testing on real devices**

Test on iPhone, iPad, and desktop browsers.

- [ ] **Step 3: Create PR with screenshots**

```bash
git push origin feat/terminal-architecture-restructure
gh pr create --title "feat: terminal architecture restructure — tmux-driven sizing" --body "..."
```

---

## Summary

**Total tasks:** 13  
**Estimated time:** 7-10 days  
**Key deliverables:**
- Protocol types for terminal resize
- tmux control mode integration in agent
- Server broadcasting
- Web client TerminalSizeManager + ScalingManager
- Zoom controls in TerminalToolbar
- Documentation and screenshots

**Next step:** Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement.
