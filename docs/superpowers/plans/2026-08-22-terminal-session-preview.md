# Terminal Session Preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On-demand tmux scrollback preview — session list + terminal toolbar → Dialog with readonly xterm + Save PNG. Issue #366.

**Architecture:** See `docs/superpowers/specs/2026-08-22-terminal-session-preview-design.md`.

**Tech Stack:**
- Rust: tokio, serde, serde_json, base64, tmux CLI (existing)
- Web: React 19, @xterm/xterm 5.5, @xterm/addon-canvas, shadcn/ui Dialog + Button + Input, Vitest + Testing Library

**Execution context:** Worktree `feat/terminal-session-preview` based on `origin/main`. Copy this plan into the worktree and commit with Task 1.

---

## Task 1: Refactor `capture_scrollback` to 3-state result

**Files:**
- Modify: `crates/nession-agent/src/tmux/util.rs:66-88`
- Modify: `crates/nession-agent/src/server/websocket.rs:1175` (attach-time prefill call site)

**Why:** Current `capture_scrollback` returns `Option<Vec<u8>>`, conflating "tmux failed" with "empty stdout". Preview needs to distinguish: session exists but no history → OK with empty string; tmux binary missing / session gone → error.

- [ ] **Step 1.1: Change signature**

In `crates/nession-agent/src/tmux/util.rs`, change `capture_scrollback` (line 66):

```rust
/// Capture the last `lines` lines of scrollback for a session's active pane,
/// including ANSI escape sequences so xterm.js can render formatting.
///
/// Returns:
/// - `Ok(Some(bytes))` — tmux exited 0 and stdout is non-empty.
/// - `Ok(None)` — tmux exited 0 but stdout is empty (session exists, no history yet).
/// - `Err(e)` — tmux binary missing, failed to spawn, or exited non-zero.
pub async fn capture_scrollback(
    session: &str,
    lines: u16,
) -> Result<Option<Vec<u8>>, std::io::Error> {
    let lines_str = lines.to_string();
    let output = Command::new("tmux")
        .args([
            "capture-pane",
            "-t",
            session,
            "-p",
            "-S",
            &format!("-{lines_str}"),
            "-E",
            "-",
            "-e",
        ])
        .output()
        .await?;
    if output.status.success() {
        if output.stdout.is_empty() {
            Ok(None)
        } else {
            Ok(Some(output.stdout))
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("tmux capture-pane failed: {}", stderr),
        ))
    }
}
```

- [ ] **Step 1.2: Update attach-time call site**

In `crates/nession-agent/src/server/websocket.rs:1175`, the attach path calls `capture_scrollback(&session_name, 2000).await` and expects `Option<Vec<u8>>`. Update to:

```rust
match crate::tmux::util::capture_scrollback(&session_name, 2000).await {
    Ok(Some(bytes)) => bytes,
    Ok(None) | Err(_) => Vec::new(),  // no history or tmux failure → empty prefill
}
```

- [ ] **Step 1.3: Add unit tests**

In `crates/nession-agent/src/tmux/util.rs` (in the existing `#[cfg(test)] mod tests` block, or create one), add:

```rust
#[tokio::test]
async fn capture_scrollback_empty_history_returns_none() {
    // Requires tmux binary; skip if absent
    if !crate::tmux::util::check_tmux_available().await.unwrap_or(false) {
        return;
    }
    // Create a session with no output
    let session = "nession-test-preview-empty";
    let _ = crate::tmux::Tmux::new().create_session(session, 80, 24, None, &[]).await;
    let result = super::capture_scrollback(session, 100).await;
    let _ = crate::tmux::Tmux::new().kill_session(session).await;
    assert!(matches!(result, Ok(None)));
}

#[tokio::test]
async fn capture_scrollback_with_output_returns_some() {
    if !crate::tmux::util::check_tmux_available().await.unwrap_or(false) {
        return;
    }
    let session = "nession-test-preview-output";
    let tmux = crate::tmux::Tmux::new();
    let _ = tmux.create_session(session, 80, 24, None, &[]).await;
    let _ = tmux.send_keys(session, &["echo hello"]).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let result = super::capture_scrollback(session, 100).await;
    let _ = tmux.kill_session(session).await;
    assert!(matches!(result, Ok(Some(_))));
}
```

- [ ] **Step 1.4: Verify**

```bash
cargo test -p nession-agent --lib tmux::util::tests::capture_scrollback
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check
```

---

## Task 2: Add `session.capture_preview` msg_type + dispatch arm

**Files:**
- Modify: `crates/nession-agent/src/server/websocket.rs:119-154` (msg_types module)
- Modify: `crates/nession-agent/src/server/websocket.rs:166-213` (payload structs)
- Modify: `crates/nession-agent/src/server/websocket.rs:965-1010` (dispatch match)

- [ ] **Step 2.1: Add msg_type constant**

In `crates/nession-agent/src/server/websocket.rs`, inside `pub mod msg_types` (line 119), add after `SESSION_KILL`:

```rust
pub const SESSION_CAPTURE_PREVIEW: &str = "session.capture_preview";
```

- [ ] **Step 2.2: Add payload structs**

After `TerminalResizePayload` (line ~212), add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCapturePreviewPayload {
    pub session_name: String,
    pub lines: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCapturePreviewResponse {
    pub ansi_b64: String,
}
```

- [ ] **Step 2.3: Add dispatch arm**

In the `match msg_type` block (line ~965), add a new arm after `SESSION_KILL`:

```rust
msg_types::SESSION_CAPTURE_PREVIEW => {
    let payload: SessionCapturePreviewPayload = match serde_json::from_value(payload_value) {
        Ok(p) => p,
        Err(e) => return err("parse_error", &e.to_string()),
    };
    if payload.lines == 0 {
        return err("invalid_lines", "lines must be > 0");
    }
    if payload.lines > 100_000 {
        return err("lines_too_large", "lines exceeds 100000 ceiling");
    }
    match crate::tmux::util::capture_scrollback(&payload.session_name, payload.lines).await {
        Ok(Some(bytes)) => {
            let ansi_b64 = general_purpose::STANDARD.encode(&bytes);
            let resp = SessionCapturePreviewResponse { ansi_b64 };
            serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                .unwrap_or_default()
        }
        Ok(None) => {
            // Session exists but no history → empty preview
            let resp = SessionCapturePreviewResponse { ansi_b64: String::new() };
            serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                .unwrap_or_default()
        }
        Err(e) => err("capture_failed", &e.to_string()),
    }
}
```

- [ ] **Step 2.4: Add unit tests**

In `crates/nession-agent/src/server/websocket.rs` (in `#[cfg(test)] mod tests`, or create one), add tests for the dispatch logic. If the dispatch is not easily unit-testable without a full WebSocket setup, add an integration test in `crates/nession-agent/tests/preview.rs`:

```rust
#[tokio::test]
async fn preview_lines_zero_rejected() {
    // Mock or spawn agent, send session.capture_preview with lines=0
    // Expect error response with code "invalid_lines"
}

#[tokio::test]
async fn preview_lines_too_large_rejected() {
    // lines=200_000 → error "lines_too_large"
}

#[tokio::test]
async fn preview_unknown_session_returns_error() {
    // lines=100, session="nonexistent" → error "capture_failed"
}

#[tokio::test]
async fn preview_valid_request_returns_base64() {
    // Create tmux session, push output, capture with lines=100
    // Verify response.ansi_b64 decodes to valid UTF-8 containing "hello"
}
```

(Exact test scaffolding depends on existing integration test patterns in `crates/nession-agent/tests/` — follow those.)

- [ ] **Step 2.5: Verify**

```bash
cargo test -p nession-agent
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check
```

---

## Task 3: Add server handler for `client.session.capture_preview`

**Files:**
- Modify: `crates/nession-server/src/server/handler.rs:155-190` (msg_type match)
- Modify: `crates/nession-server/src/server/handler.rs` (add `handle_client_session_capture_preview` method)

- [ ] **Step 3.1: Add match arm**

In the `match msg.msg_type.as_str()` block (line ~155), add:

```rust
"client.session.capture_preview" => self.handle_client_session_capture_preview(msg).await,
```

- [ ] **Step 3.2: Implement handler**

Follow the pattern of `handle_client_session_kill` (line 1674). Add a new method:

```rust
async fn handle_client_session_capture_preview(
    &mut self,
    msg: ProtocolMessage<serde_json::Value>,
) -> anyhow::Result<HandlerAction> {
    if !self.authenticated_client {
        return Ok(reply_json(
            &msg.id,
            "client.session.capture_preview.response",
            json!({ "error": "Not authenticated" }),
        ));
    }

    let session_id = msg
        .payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let lines = msg
        .payload
        .get("lines")
        .and_then(|v| v.as_u64())
        .unwrap_or(2000) as u16;

    let (agent_id, session_name) = match session_id.split_once(':') {
        Some((aid, sname)) => (aid.to_string(), sname.to_string()),
        None => {
            return Ok(reply_json(
                &msg.id,
                "client.session.capture_preview.response",
                json!({ "error": "Invalid session_id format. Expected 'agent_id:session_name'" }),
            ));
        }
    };

    // Check agent is online
    let agent = self.agent_registry.get(&agent_id).await;
    match agent {
        Some(a) if a.status != AgentStatus::Online => {
            return Ok(reply_json(
                &msg.id,
                "client.session.capture_preview.response",
                json!({ "error": format!("Agent '{}' is offline", agent_id) }),
            ));
        }
        None => {
            return Ok(reply_json(
                &msg.id,
                "client.session.capture_preview.response",
                json!({ "error": format!("Agent '{}' not found", agent_id) }),
            ));
        }
        _ => {}
    }

    // Relay to agent with 15s timeout (capture can be slow for large lines)
    let payload = json!({
        "session_name": session_name,
        "lines": lines,
    });
    match self.agent_command_with_timeout(&agent_id, "session.capture_preview", payload, std::time::Duration::from_secs(15)).await {
        Ok(response) => {
            // Forward agent's response (ok or error) to client
            Ok(reply_json(&msg.id, "client.session.capture_preview.response", response))
        }
        Err(e) => {
            Ok(reply_json(
                &msg.id,
                "client.session.capture_preview.response",
                json!({ "error": e }),
            ))
        }
    }
}
```

- [ ] **Step 3.3: Add unit test**

In `crates/nession-server/src/server/handler.rs` tests (or a new integration test), mock `command_broker` and verify:
- Handler parses `session_id` correctly.
- Offline agent → error response.
- Agent timeout → error response.
- Agent success → forwards response.

- [ ] **Step 3.4: Verify**

```bash
cargo test -p nession-server
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check
```

---

## Task 4: Web — encoding helper

**Files:**
- New: `web/src/lib/encoding.ts`
- Test: `web/src/lib/__tests__/encoding.test.ts`

- [ ] **Step 4.1: Create encoding module**

`web/src/lib/encoding.ts`:

```ts
/**
 * Decode base64 → UTF-8 string.
 * Used for ANSI strings from agent (which may contain non-ASCII bytes).
 */
export function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Encode UTF-8 string → base64.
 * Symmetric with decodeBase64Utf8.
 */
export function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
```

- [ ] **Step 4.2: Add tests**

`web/src/lib/__tests__/encoding.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decodeBase64Utf8, encodeUtf8Base64 } from '../encoding';

describe('decodeBase64Utf8', () => {
  it('decodes ASCII', () => {
    expect(decodeBase64Utf8(btoa('hello'))).toBe('hello');
  });
  it('decodes non-ASCII UTF-8', () => {
    const text = '你好世界';
    expect(decodeBase64Utf8(encodeUtf8Base64(text))).toBe(text);
  });
  it('decodes ANSI escape sequences', () => {
    const ansi = '\x1b[31mred\x1b[0m';
    expect(decodeBase64Utf8(encodeUtf8Base64(ansi))).toBe(ansi);
  });
});

describe('encodeUtf8Base64', () => {
  it('encodes ASCII', () => {
    expect(encodeUtf8Base64('hello')).toBe(btoa('hello'));
  });
  it('round-trips', () => {
    const text = 'hello 你好 \x1b[31mred\x1b[0m';
    expect(decodeBase64Utf8(encodeUtf8Base64(text))).toBe(text);
  });
});
```

- [ ] **Step 4.3: Verify**

```bash
cd web
npm test -- encoding.test.ts
```

---

## Task 5: Web — RequestPlugin.capturePreview

**Files:**
- Modify: `web/src/services/websocket/plugins/RequestPlugin.ts`
- Test: `web/src/services/websocket/plugins/__tests__/RequestPlugin.test.ts` (if exists, else create)

- [ ] **Step 5.1: Add method**

In `web/src/services/websocket/plugins/RequestPlugin.ts`, after `serverInfo()` (line ~98), add:

```ts
/**
 * Capture tmux session scrollback as ANSI text.
 * @param sessionId — "agentId:sessionName"
 * @param lines — number of lines to capture (default 2000, UI sends explicitly)
 * @returns decoded UTF-8 ANSI string (may be empty if session has no history)
 */
async capturePreview(sessionId: string, lines: number): Promise<string> {
  this.requireAuth();
  if (!Number.isInteger(lines) || lines <= 0) {
    throw new Error(`Invalid lines: ${lines}`);
  }
  const response = await this.core.request<{ ansi_b64?: string; error?: string }>(
    'client.session.capture_preview',
    { session_id: sessionId, lines },
  );
  if (response.error) {
    throw new Error(response.error);
  }
  if (response.ansi_b64 == null) {
    throw new Error('Capture failed: no data returned');
  }
  const { decodeBase64Utf8 } = await import('@/lib/encoding');
  return decodeBase64Utf8(response.ansi_b64);
}
```

- [ ] **Step 5.2: Add test**

In `web/src/services/websocket/plugins/__tests__/RequestPlugin.test.ts` (or create), mock `core.request` and verify:
- `capturePreview` sends correct msg_type + payload.
- Decodes base64 → UTF-8.
- Throws on error response.
- Throws on invalid lines.

- [ ] **Step 5.3: Verify**

```bash
cd web
npm test -- RequestPlugin
```

---

## Task 6: Web — useSessionPreview hook

**Files:**
- New: `web/src/hooks/useSessionPreview.ts`
- Test: `web/src/hooks/__tests__/useSessionPreview.test.ts`

- [ ] **Step 6.1: Create hook**

`web/src/hooks/useSessionPreview.ts`:

```ts
import { useState, useRef, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

export function useSessionPreview() {
  const ws = useWebSocket();
  const [status, setStatus] = useState<PreviewStatus>('idle');
  const [ansi, setAnsi] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const capture = useCallback(
    async (sessionId: string, lines: number) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setStatus('loading');
      setError(null);
      try {
        const result = await ws.capturePreview(sessionId, lines);
        if (ctrl.signal.aborted) return;
        setAnsi(result);
        setStatus(result === '' ? 'idle' : 'ready');
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setError((e as Error).message);
        setStatus('error');
      }
    },
    [ws],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setStatus('idle');
    setAnsi('');
    setError(null);
  }, []);

  return { status, ansi, error, capture, reset };
}
```

- [ ] **Step 6.2: Add test**

`web/src/hooks/__tests__/useSessionPreview.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionPreview } from '../useSessionPreview';
import { useWebSocket } from '../useWebSocket';

vi.mock('../useWebSocket');

describe('useSessionPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures and transitions to ready', async () => {
    vi.mocked(useWebSocket).mockReturnValue({
      capturePreview: vi.fn().mockResolvedValue('hello'),
    } as any);
    const { result } = renderHook(() => useSessionPreview());
    await act(async () => {
      await result.current.capture('agent1:session1', 100);
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.ansi).toBe('hello');
  });

  it('transitions to error on failure', async () => {
    vi.mocked(useWebSocket).mockReturnValue({
      capturePreview: vi.fn().mockRejectedValue(new Error('tmux failed')),
    } as any);
    const { result } = renderHook(() => useSessionPreview());
    await act(async () => {
      await result.current.capture('agent1:session1', 100);
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('tmux failed');
  });

  it('aborts in-flight request on re-capture', async () => {
    const mockCapture = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.mocked(useWebSocket).mockReturnValue({
      capturePreview: mockCapture,
    } as any);
    const { result } = renderHook(() => useSessionPreview());
    act(() => {
      result.current.capture('agent1:session1', 100);
    });
    await act(async () => {
      await result.current.capture('agent1:session1', 200);
    });
    expect(mockCapture).toHaveBeenCalledTimes(2);
  });

  it('reset clears state', async () => {
    vi.mocked(useWebSocket).mockReturnValue({
      capturePreview: vi.fn().mockResolvedValue('data'),
    } as any);
    const { result } = renderHook(() => useSessionPreview());
    await act(async () => {
      await result.current.capture('agent1:session1', 100);
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.ansi).toBe('');
  });
});
```

- [ ] **Step 6.3: Verify**

```bash
cd web
npm test -- useSessionPreview
```

---

## Task 7: Web — SessionPreviewDialog component

**Files:**
- New: `web/src/components/SessionPreviewDialog.tsx`
- Test: `web/src/components/__tests__/SessionPreviewDialog.test.tsx`

- [ ] **Step 7.1: Create Dialog component**

`web/src/components/SessionPreviewDialog.tsx`:

```tsx
import { useState, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Skeleton } from './ui/skeleton';
import { RefreshCw, Download } from 'lucide-react';
import { useSessionPreview } from '../hooks/useSessionPreview';
import { useDialogReset } from '../hooks/useDialogReset';
import { CATPPUCCIN_MOCHA } from '@/lib/terminalThemes';

interface SessionPreviewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  sessionName: string;
}

const DEFAULT_LINES = 2000;
const MAX_LINES = 10000;

export function SessionPreviewDialog({
  isOpen,
  onClose,
  sessionId,
  sessionName,
}: SessionPreviewDialogProps) {
  const [lines, setLines] = useState(DEFAULT_LINES);
  const { status, ansi, error, capture, reset } = useSessionPreview();
  const termRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<Terminal | null>(null);

  useDialogReset(isOpen, () => {
    setLines(DEFAULT_LINES);
    reset();
  });

  useEffect(() => {
    if (!isOpen || status !== 'ready' || !termRef.current) return;
    const term = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 13,
      theme: CATPPUCCIN_MOCHA,
    });
    const canvasAddon = new CanvasAddon();
    const fitAddon = new FitAddon();
    term.loadAddon(canvasAddon);
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();
    term.write(ansi);
    termInstanceRef.current = term;
    return () => {
      term.dispose();
      termInstanceRef.current = null;
    };
  }, [isOpen, status, ansi]);

  const handleRefresh = () => {
    if (lines < 1 || lines > MAX_LINES) {
      return;
    }
    capture(sessionId, lines);
  };

  const handleSavePng = async () => {
    if (status !== 'ready' || !ansi) return;
    // Create offscreen terminal for PNG export
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.left = '-99999px';
    container.style.width = '1600px';  // 200 cols × 8px per char
    document.body.appendChild(container);
    const offscreen = new Terminal({
      cols: 200,
      rows: ansi.split('\n').length,
      convertEol: true,
      disableStdin: true,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 13,
      theme: CATPPUCCIN_MOCHA,
    });
    const canvasAddon = new CanvasAddon();
    offscreen.loadAddon(canvasAddon);
    offscreen.open(container);
    offscreen.write(ansi);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const canvas = container.querySelector('canvas');
    if (!canvas) {
      offscreen.dispose();
      document.body.removeChild(container);
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `preview-${sessionName}-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
      offscreen.dispose();
      document.body.removeChild(container);
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Preview — {sessionName}</DialogTitle>
          <DialogDescription>
            Last {lines} lines. Refresh to update.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 flex flex-col gap-3 min-h-0">
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="lines">Lines</Label>
              <Input
                id="lines"
                type="number"
                min={1}
                max={MAX_LINES}
                step={100}
                value={lines}
                onChange={(e) => setLines(Number(e.target.value))}
                className="w-32"
                disabled={status === 'loading'}
              />
            </div>
            <Button onClick={handleRefresh} disabled={status === 'loading'} size="sm">
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh
            </Button>
            <Button
              onClick={handleSavePng}
              disabled={status !== 'ready'}
              variant="outline"
              size="sm"
            >
              <Download className="h-4 w-4 mr-1" />
              Save PNG
            </Button>
          </div>
          <div className="flex-1 min-h-0 border rounded bg-black/50">
            {status === 'loading' && (
              <div className="p-4 space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            )}
            {status === 'idle' && (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                No content captured. Click Refresh to fetch.
              </div>
            )}
            {status === 'ready' && <div ref={termRef} className="h-full w-full" />}
            {status === 'error' && (
              <div className="flex flex-col items-center justify-center h-full gap-2">
                <p className="text-destructive">{error}</p>
                <Button onClick={handleRefresh} variant="outline" size="sm">
                  Retry
                </Button>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 7.2: Add test**

`web/src/components/__tests__/SessionPreviewDialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionPreviewDialog } from '../SessionPreviewDialog';
import { useSessionPreview } from '../../hooks/useSessionPreview';

vi.mock('../../hooks/useSessionPreview');
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
    dispose: vi.fn(),
  })),
}));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn() }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn() }));

describe('SessionPreviewDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSessionPreview).mockReturnValue({
      status: 'idle',
      ansi: '',
      error: null,
      capture: vi.fn(),
      reset: vi.fn(),
    });
  });

  it('renders with lines input defaulting to 2000', () => {
    render(<SessionPreviewDialog isOpen onClose={() => {}} sessionId="a:b" sessionName="test" />);
    expect(screen.getByLabelText(/lines/i)).toHaveValue(2000);
  });

  it('shows skeleton while loading', () => {
    vi.mocked(useSessionPreview).mockReturnValue({
      status: 'loading',
      ansi: '',
      error: null,
      capture: vi.fn(),
      reset: vi.fn(),
    });
    render(<SessionPreviewDialog isOpen onClose={() => {}} sessionId="a:b" sessionName="test" />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('shows error state with retry', () => {
    vi.mocked(useSessionPreview).mockReturnValue({
      status: 'error',
      ansi: '',
      error: 'tmux failed',
      capture: vi.fn(),
      reset: vi.fn(),
    });
    render(<SessionPreviewDialog isOpen onClose={() => {}} sessionId="a:b" sessionName="test" />);
    expect(screen.getByText('tmux failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('calls capture on refresh', () => {
    const capture = vi.fn();
    vi.mocked(useSessionPreview).mockReturnValue({
      status: 'idle',
      ansi: '',
      error: null,
      capture,
      reset: vi.fn(),
    });
    render(<SessionPreviewDialog isOpen onClose={() => {}} sessionId="a:b" sessionName="test" />);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(capture).toHaveBeenCalledWith('a:b', 2000);
  });
});
```

- [ ] **Step 7.3: Verify**

```bash
cd web
npm test -- SessionPreviewDialog
tsc --noEmit
```

---

## Task 8: Web — SessionList integration

**Files:**
- Modify: `web/src/components/SessionList.tsx`
- Modify: `web/src/components/Dashboard.tsx` (or `SessionsSection.tsx`) — wire Dialog state

- [ ] **Step 8.1: Add Preview button to SessionRow**

In `web/src/components/SessionList.tsx`, add `onPreview` prop to `SessionListProps` and `SessionRow`. In `SessionRow`, add a Preview button alongside Attach and Kill:

```tsx
<Tooltip>
  <TooltipTrigger
    render={
      <Button
        size="sm"
        variant="outline"
        onClick={() => onPreview(session)}
        className="flex-1 md:flex-none min-h-11 md:min-h-7"
      >
        <Eye className="h-4 w-4" />
      </Button>
    }
  >
    Preview scrollback
  </TooltipTrigger>
  <TooltipContent side="bottom">
    <p>Preview scrollback</p>
  </TooltipContent>
</Tooltip>
```

Import `Eye` from `lucide-react`.

- [ ] **Step 8.2: Wire Dialog in Dashboard**

In `web/src/components/Dashboard.tsx` (or wherever `SessionList` is rendered), add state:

```ts
const [previewSession, setPreviewSession] = useState<Session | null>(null);
```

Pass `onPreview={setPreviewSession}` to `SessionList`. Render `SessionPreviewDialog`:

```tsx
<SessionPreviewDialog
  isOpen={previewSession !== null}
  onClose={() => setPreviewSession(null)}
  sessionId={previewSession?.session_id ?? ''}
  sessionName={previewSession?.session_name ?? ''}
/>
```

- [ ] **Step 8.3: Verify**

```bash
cd web
npm run build
tsc --noEmit
```

---

## Task 9: Web — TerminalLayout toolbar integration

**Files:**
- Modify: `web/src/components/TerminalLayout.tsx`

- [ ] **Step 9.1: Add Preview button**

In the toolbar area (near `QuickCommandsPanel` or `InputPanel`), add a Preview button that opens the same Dialog. Use the existing `sessionId` and `sessionName` props.

- [ ] **Step 9.2: Verify**

```bash
cd web
npm run build
tsc --noEmit
```

---

## Task 10: Playwright verification

- [ ] **Step 10.1: Start local stack**

```bash
HOME=/tmp/nession-demo cargo run -p nession-server &
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &
cd web && npm run dev
```

- [ ] **Step 10.2: Playwright MCP verification**

Use Playwright MCP tools to:
1. Navigate to http://localhost:13000
2. Log in (any non-empty token)
3. Create a tmux session via agent (or use existing)
4. Push some output to the session (e.g., `for i in {1..100}; do echo "Line $i"; done`)
5. In session list, click Preview button → Dialog opens
6. Verify lines input defaults to 2000
7. Click Refresh → xterm renders ANSI output
8. Change lines to 500, click Refresh → verify content matches `tmux capture-pane -S -500`
9. Click Save PNG → verify download triggers
10. Close Dialog, re-open → verify lines resets to 2000
11. Take screenshots: before/after preview, empty state, error state, PNG download

- [ ] **Step 10.3: Collect screenshots**

Save to `.playwright-mcp/screenshots/preview-*.png`. Post as PR comment.

---

## Task 11: Final verification + PR

- [ ] **Step 11.1: Run all gates**

```bash
cargo test
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check
cd web
npm test
npm run lint
npm run build
tsc --noEmit
```

- [ ] **Step 11.2: Commit + push**

```bash
git add -A
git commit -m "feat: terminal session preview (scrollback snapshot)

- Agent: session.capture_preview RPC with lines param
- Server: relay via command_broker
- Web: SessionPreviewDialog with readonly xterm + Save PNG
- Session list + terminal toolbar entry points
- Tests: agent integration, server handler, web hook + component

Closes #366"
git push -u origin feat/terminal-session-preview
```

- [ ] **Step 11.3: Create PR**

```bash
gh pr create --base staging --title "feat: terminal session preview (scrollback snapshot)" --body "$(cat <<'BODY'
## 变更内容
- On-demand tmux scrollback preview via `session.capture_preview` RPC
- Session list + terminal toolbar entry points
- Dialog with readonly xterm (Catppuccin Mocha theme) + Save PNG button
- `lines` is caller-decided (default 2000, reset on Dialog re-open, never persisted)
- Agent validates lines (0 rejected, >100000 rejected)
- Server relays with 15s timeout

## 测试报告
- `cargo test`: all passed
- `just coverage`: all crates above threshold
- `cargo fmt --all -- --check`: OK
- `cargo clippy -- -D warnings`: 0 errors
- `npm test`: all passed
- `just web-coverage`: above thresholds
- `npx tsc --noEmit`: 0 errors
- `npm run lint`: 0 warnings
- `npm run build`: success
- Playwright verification: see screenshots in comments

Closes #366
BODY
)"
```

- [ ] **Step 11.4: Enable auto-merge**

```bash
gh pr merge <PR-NUMBER> --auto --merge
```

---

## Summary

**11 tasks** covering:
- Rust: `capture_scrollback` refactor, agent msg_type + dispatch, server handler
- Web: encoding helper, RequestPlugin method, useSessionPreview hook, SessionPreviewDialog component, SessionList + TerminalLayout integration
- Verification: Playwright functional test, all gates, PR to staging

**Estimated subagent dispatches:** 3-4 (Rust backend, Web frontend, Playwright verification, PR).
