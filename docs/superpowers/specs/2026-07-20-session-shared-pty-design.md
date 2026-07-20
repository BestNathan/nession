# Design: Session-Shared PTY

**Date:** 2026-07-20
**Status:** Draft

---

## 1. Problem

Each `client.attach` creates a new `PtySession` + `tmux attach` process, then
inserts into `HashMap<String, AttachedSession>` keyed by session name.  The
second client overwrites the first — the dropped PtySession kills the tmux
process, disconnecting the first client.

## 2. Fix

**One PtySession per session.**  First `client.attach` creates it, subsequent
attaches reuse it.  All clients subscribed to the same session share one PTY
and one `tmux attach` process.

```
Session "dev"
  └── PtySession (唯一)
        ├── reader thread → broadcast channel → [Client A, Client B, Client C]
        ├── write ← multiplex from any client
        └── resize ← any client → PTY resize → tmux reflow → all clients see it
```

## 3. Data Structure

Replace `HashMap<String, AttachedSession>` with a shared session registry:

```rust
struct SharedPtySession {
    pty: PtySession,
    /// Senders for all connected clients — output is broadcast to all.
    subscribers: Vec<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>,
}

type SessionRegistry = HashMap<String, SharedPtySession>;
```

- `client.attach` → if session exists → clone a new subscriber sender → push to vec
- `client.attach` → if session doesn't exist → create PtySession → spawn reader → push first subscriber
- `client.detach` → remove subscriber → if vec empty → drop PtySession
- `client.input` → write to `pty.write(data)`
- `client.resize` → call `pty.resize(cols, rows)`

## 4. Attach Flow

```
Client A → attach "dev"
  ├── SessionRegistry 查询 "dev" → None
  ├── PtySession::attach("dev", cols, rows) → (pty, mpsc::Receiver)
  ├── 创建 SharedPtySession { pty, subscribers: [tx_A] }
  ├── 启动 reader task: mpsc::Receiver → broadcast 给所有 subscribers
  └── ok response → Client A 收到 terminal.output 流

Client B → attach "dev"
  ├── SessionRegistry 查询 "dev" → Some(shared)
  ├── 创建 tx_B, push 到 shared.subscribers
  ├── （不创建新 PtySession）
  └── ok response → Client B 立即收到同样的输出流
```

## 5. Detach Flow

```
Client A → detach "dev"
  ├── 从 shared.subscribers 移除 tx_A
  ├── subscribers 还有 [tx_B] → PtySession 保持
  └── ok

Client B → detach "dev"
  ├── 从 shared.subscribers 移除 tx_B
  ├── subscribers 空了 → drop PtySession → child.kill()
  └── ok
```

## 6. Resize Flow

```
Client A → resize { cols: 120, rows: 40 }
  ├── SessionRegistry 查找 "dev" → shared.pty.resize(120, 40)
  ├── tmux 收到 SIGWINCH → reflow
  └── 新尺寸的内容通过已有的 broadcast channel 到达所有 clients
```

## 7. Code Changes

| File | Change |
|------|--------|
| `tmux/pty.rs` | PtySession 本身不改（创建、读写、resize 不变） |
| `server/websocket.rs` | `SessionMap` → `SessionRegistry`；CLIENT_ATTACH 加复用逻辑；CLIENT_DETACH 按订阅者数量处理；cleanup 移除 subscriber |

## 8. What Stays

- PtySession struct API 不变
- AttachMode config 不变
- Control mode path 不变（还是每人一个 ControlModeSession）
- Web client 不变

---

**Document Status:** Draft — awaiting user review
