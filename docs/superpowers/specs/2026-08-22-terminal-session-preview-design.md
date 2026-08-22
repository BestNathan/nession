# Design Spec: Terminal Session Preview (Scrollback Snapshot)

**Issue:** [#366](https://github.com/BestNathan/nession/issues/366)

## Overview

On-demand preview of tmux session scrollback — user clicks a button in the session list or terminal toolbar, the agent runs `capture-pane -S -<lines> -e`, the ANSI text travels back over the existing request/response protocol, and the web UI renders it in a readonly xterm inside a Dialog. A "Save PNG" button renders the same ANSI through an offscreen xterm+canvas addon and triggers a browser download. `lines` is a request parameter (default 2000, reset on every Dialog open, never persisted).

**Non-goals** (see issue): no agent/server config for capture depth, no persistent `lines` preference, no PNG on the wire, no P2P-specific changes, no live refresh, no CLI command, no copy-mode interop.

## Architecture

```
Browser (Dialog open, user clicks Preview)
  │ request: client.session.capture_preview { session_id, lines }
  ▼
nession-server  (handler.rs — new arm in the msg_type match)
  │ command_broker.send_command(agent_id, "session.capture_preview", id, payload)
  ▼
nession-agent   (websocket.rs — new arm in msg_type dispatch)
  │ tmux::util::capture_scrollback(session_name, lines)   ← already exists
  ▼
tmux capture-pane -t <session> -p -S -<lines> -E - -e
  │ stdout: ANSI bytes
  ▼
agent encodes base64 → make_response("ok", { ansi_b64 })
  │ (round-trips back through command_broker → server → browser)
  ▼
RequestPlugin.capturePreview(sessionId, lines) → decoded UTF-8 string
  │
  ├─ Preview dialog: readonly xterm writes ANSI, scrollable
  └─ Save PNG: offscreen xterm + CanvasAddon → canvas.toBlob() → download
```

**Key principle:** the wire format is ANSI bytes (base64-encoded for transport symmetry with `terminal.input`). All rendering — both the on-screen readonly preview and the off-screen PNG export — happens in the browser, using the same xterm.js + canvas addon stack the live terminal already uses.

## Protocol

### New message types

| Direction | msg_type | Payload | Notes |
|-----------|----------|---------|-------|
| client → server | `client.session.capture_preview` | `{ session_id: string, lines: u16 }` | `lines` is caller-decided, default 2000 |
| server → agent | `session.capture_preview` | same | relayed verbatim via `command_broker` |
| agent → server | `ok` (same `id`) | `{ ansi_b64: string }` | base64 of ANSI bytes |
| agent → server | `error` | `{ code, message }` | tmux failure / unknown session / invalid lines |

**`lines` validation (agent-side):**
- `lines == 0` → error `"invalid_lines"`.
- `lines > 100_000` → error `"lines_too_large"` (client-side UI cap at 10000, but agent has a hard ceiling for safety).
- Otherwise: call `capture_scrollback(session, lines)`. If tmux returns empty stdout (no history available), respond with `ansi_b64: ""` — the UI renders an empty-state message. If tmux exits non-zero, respond with error.

**Transport size:** 2000 lines × ~100 bytes/line (typical) ≈ 200 KB of ANSI, ~270 KB base64. 10000 lines ≈ 1.3 MB base64. Well within WebSocket frame limits; no chunking needed.

### Why base64

The existing `terminal.input` payload is already base64 (to carry binary PTY bytes safely). The preview ANSI string can contain arbitrary escape sequences including bytes that may not round-trip cleanly through UTF-8 JSON. Base64 is symmetric and the existing `general_purpose::STANDARD` engine in agent + `atob`/`btoa` (or `TextDecoder`+`btoa`) in browser are trivial.

## Components

### Agent: `crates/nession-agent/src/server/websocket.rs`

**Add `msg_types::SESSION_CAPTURE_PREVIEW = "session.capture_preview"`** to the constants module (alongside `SESSION_LIST`, `SESSION_KILL`, etc.).

**New payload types:**

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

**New arm in the dispatch match (line ~965):**

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
    match capture_scrollback(&payload.session_name, payload.lines).await {
        Some(bytes) => {
            let ansi_b64 = general_purpose::STANDARD.encode(&bytes);
            let resp = SessionCapturePreviewResponse { ansi_b64 };
            serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                .unwrap_or_default()
        }
        None => err("capture_failed", &format!("tmux capture-pane failed for session {:?}", payload.session_name)),
    }
}
```

**Note:** `capture_scrollback` already returns `None` on failure (tmux exit non-zero OR empty stdout). Empty history is not a failure — tmux writes nothing to stdout when there are 0 lines to capture, and we currently return `None`. We need to distinguish "session exists but has no history yet" (respond OK with empty string) from "session doesn't exist / pane gone" (respond error). Change `capture_scrollback` to return `Result<Vec<u8>, CaptureError>` OR add a separate probe. **Decision:** change to return `Result<Option<Vec<u8>>, std::io::Error>`:
- `Ok(Some(bytes))` — capture succeeded with content.
- `Ok(None)` — tmux exited 0 but stdout empty (session exists, no history) → send `ansi_b64: ""`.
- `Err(e)` — tmux binary missing or failed to spawn → propagate error.

Then the handler checks: if `tmux capture-pane` exited non-zero, `Command::output().status.success()` is false. Looking at the current implementation, we conflate "tmux failed" with "empty stdout". Fix: return `Some(bytes)` when success+nonempty, `Some(vec![])` when success+empty, `None` only when status is failure.

### Server: `crates/nession-server/src/server/handler.rs`

**Add arm in the `msg.msg_type.as_str()` match (line ~155):**

```rust
"client.session.capture_preview" => self.handle_client_session_capture_preview(msg).await,
```

**New handler method** — follows the pattern of `handle_client_session_kill`:
1. Check `self.authenticated_client`.
2. Parse `session_id` as `"agent_id:session_name"` (same convention as kill).
3. Parse `lines` from payload (default to 2000 if missing → defensive; UI should always send it).
4. Call `self.agent_command(agent_id, "session.capture_preview", payload)` with a 15-second timeout (capture can take longer than the default 10s for large `lines` values).
5. Forward the agent's response (ok or error) back to the client with `msg_type: "client.session.capture_preview.response"`.

### Web: `web/src/services/websocket/plugins/RequestPlugin.ts`

**New method:**

```ts
async capturePreview(sessionId: string, lines: number): Promise<string> {
  this.requireAuth();
  if (lines <= 0 || !Number.isInteger(lines)) {
    throw new Error(`Invalid lines: ${lines}`);
  }
  const response = await this.core.request<{ ansi_b64?: string; error?: string }>(
    'client.session.capture_preview',
    { session_id: sessionId, lines },
  );
  if (response.error || response.ansi_b64 == null) {
    throw new Error(response.error ?? 'Capture failed');
  }
  // Decode base64 → UTF-8
  return decodeBase64Utf8(response.ansi_b64);
}
```

`decodeBase64Utf8` is a tiny helper (use `TextDecoder` on `Uint8Array.from(atob(b64), c => c.charCodeAt(0))`) — add to `web/src/lib/encoding.ts` (new file).

### Web: Preview Dialog — `web/src/components/SessionPreviewDialog.tsx`

**Props:**
```ts
interface SessionPreviewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;       // "agentId:sessionName"
  sessionName: string;     // display label
}
```

**State:**
- `lines: number` (initialised to 2000 via `useDialogReset` on every `isOpen` false→true transition)
- `status: 'idle' | 'loading' | 'ready' | 'error'`
- `ansi: string` (decoded UTF-8)
- `error: string | null`

**Layout:**
```
Dialog (max-w-4xl, h-[80vh])
  DialogHeader
    DialogTitle: "Preview — {sessionName}"
    DialogDescription: "Last {lines} lines. Refresh to update."
  DialogContent (flex flex-col, gap-3)
    ┌─── Toolbar row ─────────────────────────────────┐
    │ [Lines: Input type=number, default 2000]        │
    │ [Refresh button] (disabled while loading)       │
    │ [Save PNG button] (disabled until ready)        │
    └─────────────────────────────────────────────────┘
    ┌─── Preview area (flex-1, overflow hidden) ─────┐
    │ Readonly xterm, dark background (Catppuccin    │
    │ Mocha to match live terminal), scrollbar.      │
    │ OR empty-state card: "No content captured."    │
    │ OR error card with retry.                      │
    └────────────────────────────────────────────────┘
  DialogFooter
    [Close]
```

**Readonly xterm rendering:**
- Create a new `Terminal` instance (from `@xterm/xterm`) with options `{ convertEol: true, disableStdin: true, cursorBlink: false, fontFamily: 'JetBrains Mono, monospace', fontSize: 13, theme: CATPPUCCIN_MOCHA }`.
- Load the `CanvasAddon` (not WebGL — canvas `toBlob()` is trivial; WebGL needs `preserveDrawingBuffer`).
- Mount in a `div` sized to fit the Dialog content area; use `FitAddon` to fill.
- `term.write(ansi)` once on data arrival.
- Dispose on Dialog close.

**Save PNG flow:**
1. Create a hidden container (`position: fixed; left: -99999px`).
2. Calculate `cols` from actual max line width in ANSI content, capped at 300 columns.
3. Instantiate a **second** `Terminal` with identical options but **explicit `CanvasAddon`** (not WebGL), `fontSize: 14` (matches live terminal), and explicit dimensions: `cols = calculated width`, `rows = lineCount`.
4. Write the same ANSI, wait one rAF for render.
5. Find the `<canvas>` inside `term.element`, call `canvas.toBlob(blob => ...)`.
6. Trigger download via a temporary `<a download="{sessionName}_{YYYY-MM-DD_HH-mm-ss}.png">`.
7. Dispose the offscreen terminal + container.

**Width choice:** Dynamic sizing based on actual content. Calculate max line width from ANSI, cap at 300 columns to prevent excessively wide PNGs. This ensures narrow content produces narrow PNGs and wide content (up to 300 cols) produces appropriately wide PNGs.

**Font size:** 14px to match the live terminal font size, ensuring visual consistency between preview and exported PNG.

**Filename format:** `{sessionName}_{YYYY-MM-DD_HH-mm-ss}.png` (e.g., `myapp_2026-08-22_14-30-45.png`) for clear identification.

**Error handling:** If canvas is not found after render or toBlob fails, throw an error. Caller (SessionPreviewDialog) catches and shows toast notification.

**Lines input cap:** UI max 10000 (agent hard cap 100000 for safety). Input uses `Input type=number min=1 max=10000 step=100`. Values outside range → clamp + toast.

### Web: Session list entry — `web/src/components/SessionList.tsx`

Add a Preview button alongside Attach and Kill in `SessionRow`:

```tsx
<Tooltip>
  <TooltipTrigger render={<Button size="sm" variant="outline" onClick={() => onPreview(session)} ... />}>
    <Eye className="h-4 w-4" />
  </TooltipTrigger>
  <TooltipContent side="bottom"><p>Preview scrollback</p></TooltipContent>
</Tooltip>
```

Parent `SessionList` gains a new prop `onPreview: (session: Session) => void`. Caller (Dashboard / SessionsSection) opens the Dialog.

### Web: Terminal page button — `web/src/components/TerminalLayout.tsx`

Add a Preview button to the QuickCommandsPanel toolbar area (or next to it). The terminal's `sessionId` and `sessionName` are already available via props. Same Dialog, opened from the toolbar.

### Web: Hook — `web/src/hooks/useSessionPreview.ts`

Encapsulates the RPC + state + error localization:

```ts
import { toast } from 'sonner';

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

function isVersionError(error: string): boolean {
  return (
    error.toLowerCase().includes('unsupported message type') ||
    error.toLowerCase().includes('unknown message type')
  );
}

function localizeError(error: string): string {
  if (isVersionError(error)) {
    return 'Preview not supported by this agent version. Please upgrade the agent.';
  }
  if (error.includes('session not found')) {
    return 'Session not found. It may have been killed.';
  }
  if (error.includes('capture_failed')) {
    return 'Failed to capture terminal output.';
  }
  return error;
}

export function useSessionPreview() {
  const ws = useWebSocket();
  const [status, setStatus] = useState<PreviewStatus>('idle');
  const [ansi, setAnsi] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<AbortController | null>(null);

  const capture = useCallback(async (sessionId: string, lines: number) => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setStatus('loading');
    setError(null);
    try {
      const result = await ws.capturePreview(sessionId, lines);
      if (ctrl.signal.aborted) return;
      setAnsi(result);
      setStatus(result === '' ? 'idle' : 'ready');  // empty → show empty-state
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const errorMessage = localizeError((e as Error).message);
      setError(errorMessage);
      setStatus('error');
      toast.error('Failed to capture preview', {
        description: errorMessage,
      });
    }
  }, [ws]);

  const reset = useCallback(() => {
    inflight.current?.abort();
    setStatus('idle');
    setAnsi('');
    setError(null);
  }, []);

  return { status, ansi, error, capture, reset };
}
```

**Version compatibility:** Detects "unsupported message type" errors from old agents and shows user-friendly message: "Preview not supported by this agent version. Please upgrade the agent."

**Toast notifications:** All capture failures trigger a Sonner toast with localized error message, ensuring users are notified even if they don't notice the inline error state.

Aborts in-flight request on re-capture or Dialog close.

## Edge Cases

| Case | Handling |
|------|----------|
| Session killed between click and capture | Agent returns error → toast via Sonner + inline error with retry |
| tmux capture fails (no pane) | Agent returns error → toast via Sonner + inline error |
| Empty scrollback (new session) | `ansi_b64: ""` → Dialog shows "No content captured" empty state |
| `lines = 0` | Agent rejects with `invalid_lines`; UI input also prevents 0 |
| `lines` > tmux history-limit | tmux returns whatever it has; no error |
| Very long lines | xterm wraps naturally; PNG caps at 300 cols |
| Rapid re-clicks | `useSessionPreview` aborts prior in-flight request |
| Alt-screen TUI (vim/less) | `capture-pane` captures current screen; Dialog shows current content |
| PNG export fails (memory / offscreen canvas limit) | Toast error; ANSI preview stays visible |
| Dialog unmount during export | AbortController cancels; no orphan download |
| Old agent version (doesn't support preview) | Error detected → toast: "Preview not supported by this agent version. Please upgrade the agent." |

## Tests

### Agent (Rust)

**Unit tests in `crates/nession-agent/src/server/websocket.rs` or `tmux/util.rs`:**
- `capture_scrollback` returns `Ok(Some(bytes))` on success.
- `capture_scrollback` returns `Ok(None)` on empty stdout (session exists, no history).
- `capture_scrollback` returns `Err` when tmux binary is absent.
- New msg dispatch:
  - `session.capture_preview` with valid payload → OK response with base64.
  - `lines = 0` → error `"invalid_lines"`.
  - `lines = 200_000` → error `"lines_too_large"`.
  - unknown session → error `"capture_failed"`.

**Integration test (`crates/nession-agent/tests/`):**
- Spawn tmux, create session, push output, capture preview with various `lines`, verify content matches `tmux capture-pane` stdout.

### Server (Rust)

**Unit test in `crates/nession-server/src/server/handler.rs`:**
- New arm: handler parses `session_id`, relays to agent, forwards response.
- Mock `command_broker` to return success / error / timeout.

### Web (Vitest)

**Unit tests:**
- `RequestPlugin.capturePreview` — mock `core.request` → returns decoded ANSI.
- `decodeBase64Utf8` — round-trip with non-ASCII bytes.
- `useSessionPreview` — loading → ready → error transitions; abort on re-capture.
- `SessionPreviewDialog`:
  - Renders with readonly xterm when `status === 'ready'`.
  - Shows skeleton while loading.
  - Shows empty-state when ansi is empty.
  - Shows error state with retry button.
  - Lines input resets to 2000 on re-open (`useDialogReset`).
  - Save PNG button creates download link (mock `canvas.toBlob`).

**Coverage exclusions:** Add `SessionPreviewDialog.tsx` to vitest coverage excludes if it becomes glue-heavy; the hook and the plugin method are the testable units.

## Files Changed

| File | Change |
|------|--------|
| `crates/nession-agent/src/server/websocket.rs` | New `msg_types::SESSION_CAPTURE_PREVIEW`, new payload structs, new dispatch arm, refactor `capture_scrollback` to return 3-state result |
| `crates/nession-agent/src/tmux/util.rs` | Change `capture_scrollback` signature: `Option<Vec<u8>>` → `Result<Option<Vec<u8>>, std::io::Error>` |
| `crates/nession-agent/src/server/websocket.rs:1175` | Update attach-time scrollback prefill call site to new signature |
| `crates/nession-server/src/server/handler.rs` | New arm + `handle_client_session_capture_preview` method |
| `web/src/services/websocket/plugins/RequestPlugin.ts` | New `capturePreview` method |
| `web/src/lib/encoding.ts` | New file: `decodeBase64Utf8`, `encodeUtf8Base64` |
| `web/src/hooks/useSessionPreview.ts` | New hook |
| `web/src/components/SessionPreviewDialog.tsx` | New Dialog component |
| `web/src/components/SessionList.tsx` | Add Preview button + `onPreview` prop |
| `web/src/components/TerminalLayout.tsx` | Add Preview button in toolbar |
| `web/src/hooks/useDashboard.ts` (or caller) | Wire Dialog state + `onPreview` |
| `web/src/types.ts` | No change — sessionId is already a string |

## Success Criteria Mapped

1. ✅ Session list preview → 3s timeout on agent RPC (use 15s timeout; typical <3s).
2. ✅ `lines=500` → tmux gets `-S -500` verbatim; parity check against `tmux capture-pane -S -500`.
3. ✅ ANSI colors correct → Catppuccin Mocha theme in readonly xterm.
4. ✅ Save PNG → canvas.toBlob download, row order matches ANSI.
5. ✅ `lines` by request param only — no agent/server config.
6. ✅ `useDialogReset` resets to 2000 on every re-open.
7. ✅ Preview RPC is independent of attach — doesn't start control-mode, doesn't consume terminal subscription slot.
8. ✅ Vitest + agent integration tests cover protocol + lines param + failure path.

## Open Questions Resolved

1. **UI max `lines`:** 10000 in the UI, 100000 hard cap in the agent.
2. **PNG width:** fixed 200 columns (covers most real sessions; info callout if lines exceed).
3. **P2P routing:** session list preview always goes through server→agent (never P2P, since user isn't attached). After attach, the terminal toolbar Preview button uses the same RPC — also through server, not P2P — for simplicity. P2P path not added; no need to duplicate.
