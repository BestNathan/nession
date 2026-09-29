# Design: Plain PTY Attach Mode

**Date:** 2026-07-20
**Status:** Draft

> **Divergence, 2026-09-29 (#321 S3).** The default was reversed:
> `AttachMode::Control` is now the default and `Plain` is the fallback. The
> premise below — that plain PTY attach is the right shape for the browser — was
> never measured against what it costs. tmux's *client* owns the outer terminal
> on 3.6b, so under Plain it enters the alternate screen unconditionally and
> enables mouse reporting (Nession's own `set-option mouse on`, `manager.rs`),
> which means xterm accumulates no scrollback and the wheel goes to tmux copy
> mode rather than to the application. That is [interaction-semantics.md](../../design/terminal/interaction-semantics.md)'s
> "four modes cannot discriminate" paragraph, and it is a property of the
> transport rather than of the Web code.
>
> Plain is **kept**: it still works, it now receives the attach bootstrap like
> every other arm (S6), and it is the fallback when Control misbehaves. What it
> cannot do is satisfy #1096 criteria 7–10. The canonical statement of the split
> is [scrollback-bootstrap.md](../../design/terminal/scrollback-bootstrap.md);
> this document is left as written rather than rewritten, so the reasoning that
> led here stays legible.

---

## 1. Overview

Add an `attach_mode` config option to the agent.  When `"plain"` (the default),
`client.attach` spawns a plain `tmux attach` under a PTY instead of the current
`tmux -C attach` control-mode session.  The PTY master is read/written
directly — no message parsing, no manual resize commands, no refresh-client
hacks.  tmux handles everything natively.

The existing control-mode path is preserved behind `attach_mode = "control"`.

## 2. Why

Control mode (`-C`) was introduced for per-client independent viewports, but
that goal has been abandoned.  We now want tmux as the single source of truth.
Plain PTY gives us for free:

| Concern | Control mode | Plain PTY |
|---------|-------------|-----------|
| Resize | Manual `resize-window` + `refresh-client` | `TIOCSWINSZ` ioctl, tmux reacts natively |
| Redraw after resize | Must send `refresh-client` | Automatic |
| Scrollback on attach | Must `capture-pane` separately | Same (still needed) |
| Multi-client sync | Per-client sessions, manual broadcast | One shared PTY, natural sync |
| Code complexity | ~500 lines of parsing/routing | ~150 lines of raw I/O |

## 3. Configuration

**`agent-config.toml`:**
```toml
# Attach mode: "plain" (tmux attach + PTY) or "control" (tmux -C attach).
# Default: "plain"
attach_mode = "plain"
```

**`AgentConfig` struct (`crates/nession-agent/src/config.rs`):**
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachMode {
    Plain,
    Control,
}

impl Default for AttachMode {
    fn default() -> Self { AttachMode::Plain }
}

pub struct AgentConfig {
    // ... existing fields ...
    #[serde(default)]
    pub attach_mode: AttachMode,
}
```

## 4. Architecture

### 4.1 Plain PTY path

```
agent
 └── Session "dev"
       ├── openpty() → (master, slave) with initial cols×rows
       ├── spawn "tmux attach -t dev" with slave as stdin/stdout/stderr
       ├── (optional) capture-pane via separate tmux process → scrollback
       ├── read loop:  master.read() → broadcast terminal.output to all clients
       ├── write:      client → agent → master.write_all()
       └── resize:     client → agent → TIOCSWINSZ(master, cols, rows)
```

One `PtySession` per tmux session.  All web clients attached to the same
session share the PTY — tmux handles multi-client natively.

### 4.2 Control mode path (unchanged)

```
agent
 └── Session "dev"
       └── Per-client ControlModeSession
             ├── spawn "tmux -C attach -t dev"
             ├── parse %output / %window-resize
             ├── read_output_loop
             └── resize via stdin commands
```

## 5. New Components

### 5.1 `crates/nession-agent/src/tmux/pty.rs` (new)

```rust
pub struct PtySession {
    session_name: String,
    child: Child,          // tmux attach process
    master: PtyMaster,     // PTY master for I/O
    viewport: (u16, u16),  // current cols, rows
}

impl PtySession {
    /// Open a PTY, spawn `tmux attach`, return the session.
    pub async fn attach(
        session_name: &str,
        cols: u16,
        rows: u16,
    ) -> Result<Self>;

    /// Read raw ANSI bytes from the PTY master.
    pub async fn read(&mut self, buf: &mut [u8]) -> Result<usize>;

    /// Write raw input bytes to the PTY master (forwarded to tmux).
    pub async fn write(&mut self, data: &[u8]) -> Result<()>;

    /// Resize the PTY — triggers SIGWINCH, tmux reflows automatically.
    pub async fn resize(&mut self, cols: u16, rows: u16) -> Result<()>;

    /// Kill the tmux subprocess.
    pub async fn close(&mut self) -> Result<()>;
}
```

### 5.2 `crates/nession-agent/src/server/websocket.rs` (modify)

In `client.attach` handler, branch on config:

```rust
match config.attach_mode {
    AttachMode::Plain => {
        let session = PtySession::attach(&name, width, height).await?;
        sessions.insert(name.clone(), session);
        // spawn read loop → broadcast to all clients on this session
        // collect input from clients → write to PTY
    }
    AttachMode::Control => {
        // existing ControlModeSession::attach() logic
    }
}
```

### 5.3 `crates/nession-agent/src/tmux/mod.rs` (modify)

```rust
pub mod control;
pub mod pty;  // new
// ...
```

## 6. Multi-Client Behaviour

With plain PTY, the session map changes from per-connection to shared:

```rust
// Before (control mode): each connection has its own session
type SessionMap = HashMap<String, ControlModeSession>;

// After (plain mode): one session shared, each connection subscribes
type PtySessionMap = HashMap<String, Arc<Mutex<PtySession>>>;
type Subscribers = HashMap<String, Vec<Sender>>;
```

When client A sends input, it goes to the shared PTY.  When the PTY produces
output, it's broadcast to ALL subscribers.

Resize works the same way: any client can call `pty_session.resize(cols, rows)`.
Last writer wins — the most recent resize sets the PTY size for everyone.

## 7. What Stays / Goes

| Component | Fate |
|-----------|------|
| `ControlModeSession` | Keep — **and since 2026-09-29 it is what `attach_mode` defaults to**; the parenthetical that used to read "gated behind `attach_mode = "control"`" now describes Plain, not this |
| `control_mode.rs` (parser) | Keep |
| `control.rs` | Keep |
| `read_output_loop` | Keep |
| `capture_scrollback` | Keep (used by both paths) |
| `run_tmux_command` | Keep |
| `TerminalSizeManager` (web) | Keep |
| `FontSizeManager` (web) | Keep |
| `ResizeObserver` (web) | Keep |
| `ConnectionManager` (web) | Keep |

Web client is unchanged — it still sends `client.attach { width, height }` and
`terminal.resize { cols, rows }`.  The agent just handles them differently.

## 8. Testing Strategy

### Unit tests
- `PtySession::resize()` sets correct TIOCSWINSZ
- `PtySession::write()` forwards bytes to PTY
- Config parsing: `attach_mode = "plain"` / `"control"` / unset → default plain

### Integration tests
- New e2e test: attach via plain PTY, write input, read output, verify echo
- Existing control-mode e2e tests still pass (unchanged)

### Manual verification
- `attach_mode = "plain"` (default): attach → resize → content reflows
- `attach_mode = "control"`: existing behaviour preserved
- Scrollback on attach: verify `capture-pane` works with plain PTY

## 9. Migration

1. Add `AttachMode` enum to config (1 file)
2. Implement `PtySession` (1 new file, ~150 lines)
3. Branch `client.attach` handler on config (1 file, ~80 lines)
4. Update `tmux/mod.rs` exports (1 line)
5. Tests + docs

**Estimated:** 2-3 days

---

**Document Status:** Draft — awaiting user review
