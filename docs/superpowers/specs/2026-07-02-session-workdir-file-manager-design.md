# Session Working Directory & File Manager — Design Spec

**Date:** 2026-07-02
**Status:** Design approved

## Overview

Two features for the terminal experience:

1. **Session working directory** — Agent-level config for the default tmux session working directory.
2. **File manager** — A collapsible side panel in the terminal view with a file browser, and a tab-based file viewer. Full read/write/create/delete/upload.

---

## Feature 1: Session Working Directory

### Goal

When creating a tmux session, use a configurable default directory instead of the agent process's current working directory. Not user-overridable per session — purely agent config.

### Agent Config

Add to `AgentConfig` (`crates/nession-agent/src/config.rs`):

```rust
/// Default working directory for new tmux sessions.
/// If not set, defaults to $HOME.
#[serde(default = "default_working_dir")]
pub default_working_dir: String,

fn default_working_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}
```

### TmuxManager

`create_session` gains a `working_dir: &str` parameter:

```rust
pub async fn create_session(
    &self, name: &str, width: u16, height: u16, working_dir: &str
) -> Result<()> {
    Command::new("tmux")
        .args(["new-session", "-d", "-s", name,
               "-x", &width.to_string(),
               "-y", &height.to_string(),
               "-c", working_dir])
        .status().await?;
}
```

### Protocol

No protocol payload changes needed. The user cannot override the working directory per session. The agent always uses its configured `default_working_dir` when handling `server.session.create`.

### Call Chain

```
Web UI → server (client.session.create) → agent (server.session.create)
                                                   ↓
                                     reads config.default_working_dir
                                                   ↓
                                          TmuxManager::create_session(name, w, h, dir)
                                                   ↓
                                          tmux new-session -d -s <name> -x <w> -y <h> -c <dir>
```

No changes to the Web UI or Create Session dialog.

---

## Feature 2: File Manager

### Goal

Full remote file management via the P2P WebSocket connection: browse, view, edit, create, delete, rename, upload files on the agent's filesystem. UI is a collapsible left side panel (extensible for future tool sections) with a tabbed right panel (terminal + file tabs).

### Architecture Decision: Pure WebSocket

File operations use the existing agent P2P WebSocket connection. Content is base64-encoded in JSON messages. This avoids extra ports, separate auth, and CORS concerns. For the file sizes encountered in development work (source code, configs, logs), base64 overhead is negligible.

### Protocol — New Message Types

All messages use the existing `Message<T>` envelope.

| Direction | `msg_type` | Payload | Response |
|---|---|---|---|
| client → agent | `file.list` | `{ path: string }` | `{ entries: FileEntry[] }` |
| client → agent | `file.read` | `{ path: string }` | `{ path, content: base64, mime_type: string }` |
| client → agent | `file.write` | `{ path, content: base64 }` | `{ path, written: number }` |
| client → agent | `file.delete` | `{ path: string }` | `{ path, success: bool }` |
| client → agent | `file.create_dir` | `{ path: string }` | `{ path, success: bool }` |
| client → agent | `file.rename` | `{ from: string, to: string }` | `{ from, to, success: bool }` |
| client → agent | `file.upload` | `{ path, content: base64, size: number }` | `{ path, written: number }` |

**FileEntry:**
```json
{
  "name": "string",
  "path": "string (absolute)",
  "is_dir": true,
  "size": 1234,
  "modified": 1719900000
}
```

**Error codes:** `permission_denied`, `not_found`, `is_directory`, `already_exists`, `io_error`, `file_too_large`

**Upload chunked transfer (future enhancement):** For files > 1MB, chunk with `file.upload.chunk` + `file.upload.commit`.

### Agent-Side Implementation

**New module: `crates/nession-agent/src/fs/`**

```
fs/
├── mod.rs
├── ops.rs       // FileOps: list, read, write, delete, create_dir, rename
└── sandbox.rs   // Path sandboxing
```

**PathSandbox (`sandbox.rs`):**
- Root set to `file_root` config or `default_working_dir`
- All paths canonicalized and verified to stay within root
- Symlinks resolved before bounds check
- `..` traversal outside root → `permission_denied`

**FileOps (`ops.rs`):**
- `list_dir` — returns sorted `FileEntry` array
- `read_file` — capped at 10MB, returns base64 + MIME type
- `write_file` — atomic (temp file → rename), returns bytes written
- `delete` — fails on non-empty directories
- `create_dir` — creates parents if needed
- `rename` — across same filesystem only
- All I/O via `tokio::task::spawn_blocking`
- MIME detection via `mime_guess` crate

**Wiring:** New match arms in `AgentServer::handle_request`. `FileOps` created once per connection, shared via `Arc`. File read/write spawned as background tasks (like PTY output).

### Agent Config

```rust
pub file_root: Option<String>,  // restricts file ops; defaults to default_working_dir
```

### Web UI Components

```
TerminalView
├── Header
└── Main area (flex row)
    ├── SidePanel (collapsible, extensible)
    │   ├── PanelHandle (toggle button)
    │   └── PanelContent
    │       └── FileBrowser
    │           ├── FileBrowserToolbar (refresh, new file, new folder, upload)
    │           ├── Breadcrumb (clickable path segments)
    │           └── FileList (scrollable, sortable)
    └── RightPanel (flex col)
        ├── TabBar
        │   ├── Terminal tab (always present, not closable)
        │   └── FileViewer tab[] (per opened file)
        └── TabContent
```

**New files:**
```
web/src/components/
├── SidePanel.tsx        // Collapsible panel container
├── FileBrowser.tsx       // Directory listing + toolbar + breadcrumb
├── FileViewer.tsx        // File content viewer/editor
├── FileTabs.tsx          // Tab bar + content switching
└── fileOps.ts            // File operation helpers (P2P WebSocket)
```

**SidePanel:**
- Closed by default
- Toggle via vertical handle on the right edge
- Smooth CSS transition on width, default ~260px
- Accepts `children` — only FileBrowser for now; extensible for future tool sections

**FileBrowser:**
- Toolbar: Refresh, New File, New Folder, Upload (hidden file input)
- Breadcrumb: clickable path segments
- FileList: icon (📁/📄), name, size (human-readable), modified (relative time)
- Click folder → navigate in; click file → open in viewer tab
- Columns sortable: name (default), size, modified
- Loading/empty/error states

**FileViewer:**
- Per-file tab with toolbar: filename, Edit toggle, Save (when dirty), Close
- Content in scrollable `<textarea>` — read-only initially, toggle to edit
- Unsaved changes: dot indicator on tab + confirm before close
- Files > 1MB: warn before loading

**FileTabs:**
- Terminal tab always first, not closable
- File tabs added on click, removed via close button
- Soft cap at 10 open tabs
- Tab state: `{ id, path, filename, content, isDirty, isLoading, isReadOnly }`

### P2P WebSocket Refactor

Currently `Terminal.tsx` owns the P2P WebSocket (created in a `useEffect`). This needs to be lifted to `TerminalView` level so both `Terminal` and `FileBrowser`/`FileViewer` share the same connection.

Approach: Extract a `useP2PConnection` hook that manages the WebSocket lifecycle (connect, disconnect, send, onMessage). `TerminalView` owns the hook instance. The hook exposes:
- `sendMessage(msg)` — send a JSON message on the P2P socket
- `onMessage(handler)` — subscribe to incoming messages
- `connectionState` — 'connecting' | 'connected' | 'disconnected'

`Terminal` receives `sendMessage` and message stream via props instead of owning the WebSocket directly. `fileOps.ts` becomes a set of functions that take the `sendMessage` + `onMessage` from the hook, rather than owning a WebSocket itself.

### Data Flow — Open a File

```
User clicks "app.log" in FileBrowser
  → FileBrowser calls onFileClick(path)
  → FileTabs adds tab: { path, status: "loading" }
  → fileOps.readFile(path) on P2P WS
  → Agent resolves path, reads file, returns base64 content
  → FileTabs updates tab: { content, status: "ready" }
  → Auto-switch to the new file tab
  → FileViewer renders content in textarea
```

### Data Flow — Save Edited File

```
User clicks "Edit" in FileViewer
  → isReadOnly = false, user edits
  → User clicks "Save"
  → fileOps.writeFile(path, content) on P2P WS
  → Agent writes file atomically, returns bytes written
  → isDirty = false, toast.success("File saved")
```

### Error Handling

- File operation errors → `toast.error()` via Sonner
- Network errors → "Connection lost" toast, dirty state preserved
- Every component handles loading, empty, and error states
- Sandbox violations return `permission_denied` with no path details

---

## Testing

### Rust
- `fs/sandbox.rs` — unit tests: path traversal, symlink escape, edge cases
- `fs/ops.rs` — integration tests with temp directories
- `server/websocket.rs` — new test cases for each `file.*` message type

### Web UI
- Component unit tests for SidePanel, FileBrowser, FileViewer, FileTabs
- Mock P2P WebSocket for file operation tests

---

## Implementation Order

1. **Feature 1:** Agent working directory config + TmuxManager change (small, independent)
2. **Feature 2 — agent side:** `fs/` module (sandbox + ops) + protocol handlers in websocket.rs
3. **Feature 2 — UI refactor:** Lift P2P WebSocket from Terminal to TerminalView
4. **Feature 2 — UI components:** SidePanel → FileBrowser → FileViewer → FileTabs → integration
5. **Polish:** Loading/empty/error states, toast notifications, transitions

---

## Out of Scope (Future)

- File change watching (`file.watch`)
- Right-click context menu in FileBrowser
- Drag-and-drop file upload
- Syntax highlighting in FileViewer
- Directory size calculation
- Multiple file selection / batch operations
- Additional SidePanel sections (process monitor, resource usage, etc.)
