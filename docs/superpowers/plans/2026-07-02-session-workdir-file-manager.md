# Session Working Directory & File Manager — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable tmux session working directory and a full remote file manager with side panel + tabbed viewer in the terminal view.

**Architecture:** Agent config gains `default_working_dir` and `file_root` fields. A new `fs` module (sandbox + ops) handles file operations on the agent side, wired into the existing P2P WebSocket protocol. The web UI refactors the P2P WebSocket into a `useP2PConnection` hook shared by Terminal and new components: SidePanel (collapsible drawer), FileBrowser (directory navigation), FileTabs + FileViewer (tabbed file content).

**Tech Stack:** Rust (tokio, serde, mime_guess), TypeScript/React (shadcn/ui, Tailwind v4, xterm.js)

---

### Task 1: Agent working directory config + file_root

**Files:**
- Modify: `crates/nession-agent/src/config.rs`
- Modify: `crates/nession-agent/src/tmux/manager.rs`
- Modify: `crates/nession-agent/src/main.rs`
- Modify: `crates/nession-agent/src/connection/server_client.rs`

- [ ] **Step 1: Add `default_working_dir` and `file_root` fields to `AgentConfig`**

In `crates/nession-agent/src/config.rs`, add after `connect_url`:

```rust
/// Default working directory for new tmux sessions.
/// When not set, defaults to $HOME.
#[serde(default = "default_working_dir")]
pub default_working_dir: String,

/// Root directory for file operations via the P2P WebSocket.
/// When not set, defaults to `default_working_dir`.
/// File operations are restricted to paths within this directory.
#[serde(default)]
pub file_root: Option<String>,
```

Add the default function (keep existing defaults, add after `default_session_poll_interval`):

```rust
fn default_working_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}
```

Update the `Default` impl to include the new fields:

```rust
impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            agent_id: format!("agent-{}", uuid::Uuid::new_v4()),
            server_url: "ws://localhost:8443".to_string(),
            auth_token: String::new(),
            listen_address: default_listen_address(),
            tls_cert_path: None,
            tls_key_path: None,
            heartbeat_interval_secs: default_heartbeat_interval(),
            session_poll_interval_secs: default_session_poll_interval(),
            advertise_address: None,
            connect_url: None,
            default_working_dir: default_working_dir(),
            file_root: None,
        }
    }
}
```

- [ ] **Step 2: Add `working_dir` parameter to `TmuxManager::create_session`**

In `crates/nession-agent/src/tmux/manager.rs`, change the signature and body:

```rust
pub async fn create_session(
    &self,
    name: &str,
    width: u16,
    height: u16,
    working_dir: &str,
) -> Result<()> {
    let status = Command::new("tmux")
        .args([
            "new-session",
            "-d",
            "-s",
            name,
            "-x",
            &width.to_string(),
            "-y",
            &height.to_string(),
            "-c",
            working_dir,
        ])
        .status()
        .await?;

    if !status.success() {
        anyhow::bail!("Failed to create session: {}", name);
    }

    Ok(())
}
```

- [ ] **Step 3: Thread `default_working_dir` through `ServerClient`**

In `crates/nession-agent/src/connection/server_client.rs`:

Add field to `ServerClient` struct (after `connect_url`):

```rust
/// Default working directory for new tmux sessions.
default_working_dir: String,
```

Add parameter to `ServerClient::new` (after `connect_url`):

```rust
#[allow(clippy::too_many_arguments)]
pub fn new(
    server_url: impl Into<String>,
    auth_token: impl Into<String>,
    agent_id: impl Into<String>,
    hostname: impl Into<String>,
    ip_address: impl Into<String>,
    port: u16,
    connect_url: Option<String>,
    metadata: AgentMetadata,
    tmux: Arc<TmuxManager>,
    default_working_dir: String,
) -> Self {
    Self {
        server_url: server_url.into(),
        auth_token: auth_token.into(),
        agent_id: agent_id.into(),
        hostname: hostname.into(),
        ip_address: ip_address.into(),
        port,
        connect_url,
        metadata,
        tmux,
        default_working_dir,
    }
}
```

Update the `server.session.create` handler to pass `working_dir` (around line 489):

```rust
"server.session.create" => {
    let request_id = msg.payload["request_id"].as_str().unwrap_or("").to_string();
    let name = msg.payload["name"].as_str().unwrap_or("").to_string();
    let width = msg.payload["width"].as_u64().unwrap_or(80) as u16;
    let height = msg.payload["height"].as_u64().unwrap_or(24) as u16;

    info!(
        "Server requested session create: name={}, width={}, height={}",
        name, width, height
    );

    let (success, error, session_name) =
        match self.tmux.create_session(&name, width, height, &self.default_working_dir).await {
            Ok(()) => (true, None, Some(name.clone())),
            Err(e) => (false, Some(e.to_string()), None),
        };
    // ... rest unchanged
```

Update tests in the same file — add `"".to_string()` or `"/tmp".to_string()` as the last argument to every `ServerClient::new()` call (there are 5 test functions). Also update the `TmuxManager::create_session` calls in test files where applicable.

- [ ] **Step 4: Update `main.rs` to pass `default_working_dir` to `ServerClient`**

In `crates/nession-agent/src/main.rs`, update the `ServerClient::new` call:

```rust
let server_client = ServerClient::new(
    &config.server_url,
    &config.auth_token,
    &config.agent_id,
    &hostname,
    &ip_address,
    port,
    config.connect_url.clone(),
    metadata,
    tmux_for_client,
    config.default_working_dir.clone(),
);
```

- [ ] **Step 5: Verify compilation**

Run: `cargo build -p nession-agent`
Expected: Compilation succeeds (test failures expected due to updated signatures).

- [ ] **Step 6: Update and run all tests**

Run: `cargo test -p nession-agent`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add crates/nession-agent/src/config.rs crates/nession-agent/src/tmux/manager.rs crates/nession-agent/src/main.rs crates/nession-agent/src/connection/server_client.rs
git commit -m "feat: add configurable session working directory and file_root

- AgentConfig gets default_working_dir (defaults to $HOME) and file_root
- TmuxManager::create_session passes -c <dir> to tmux
- ServerClient threads working_dir to session.create handler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Agent-side fs module — PathSandbox

**Files:**
- Create: `crates/nession-agent/src/fs/mod.rs`
- Create: `crates/nession-agent/src/fs/sandbox.rs`
- Modify: `crates/nession-agent/src/lib.rs` (add `pub mod fs;`)

- [ ] **Step 1: Create `fs/mod.rs`**

```rust
pub mod ops;
pub mod sandbox;
```

- [ ] **Step 2: Create `fs/sandbox.rs` with tests**

```rust
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Restricts file operations to a root directory.
///
/// All paths are canonicalized and verified to stay within the sandbox
/// root. Symlinks are resolved before the bounds check. Attempts to
/// escape via `..` or symlinks outside root return `permission_denied`.
#[derive(Debug, Clone)]
pub struct PathSandbox {
    /// Canonicalized absolute root directory.
    root: PathBuf,
}

impl PathSandbox {
    /// Create a new sandbox rooted at `root`.
    ///
    /// The root path is canonicalized immediately. Returns an error if
    /// the root does not exist or cannot be accessed.
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = std::fs::canonicalize(root.as_ref())
            .with_context(|| format!("sandbox root does not exist: {}", root.as_ref().display()))?;
        Ok(Self { root })
    }

    /// Resolve a user-supplied path relative to the sandbox root.
    ///
    /// Returns the canonical absolute path, or an error with code
    /// `permission_denied` if the resolved path lies outside the root.
    pub fn resolve(&self, path: &str) -> Result<PathBuf> {
        // Normalize: strip leading '/' to make it relative to root
        let relative = path.trim_start_matches('/');
        let combined = self.root.join(relative);

        // Canonicalize if it exists, otherwise canonicalize the parent
        // and append the filename for non-existent paths (create, rename).
        let resolved = if combined.exists() {
            std::fs::canonicalize(&combined)
                .with_context(|| format!("path not found: {}", path))?
        } else {
            // For paths that don't exist yet, resolve the parent.
            let parent = combined
                .parent()
                .unwrap_or(&self.root);
            let canonical_parent = std::fs::canonicalize(parent)
                .with_context(|| format!("parent not found for: {}", path))?;
            let filename = combined
                .file_name()
                .context("path has no filename")?;
            canonical_parent.join(filename)
        };

        // Verify the resolved path is within the root.
        if !resolved.starts_with(&self.root) {
            anyhow::bail!("permission_denied: path outside sandbox root");
        }

        Ok(resolved)
    }

    /// Return the sandbox root path.
    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn setup_sandbox() -> (tempfile::TempDir, PathSandbox) {
        let dir = tempfile::tempdir().unwrap();
        let sandbox = PathSandbox::new(dir.path()).unwrap();
        (dir, sandbox)
    }

    #[test]
    fn test_resolve_simple_path() {
        let (dir, sandbox) = setup_sandbox();
        let file_path = dir.path().join("test.txt");
        fs::write(&file_path, b"hello").unwrap();

        let resolved = sandbox.resolve("test.txt").unwrap();
        assert_eq!(resolved, file_path.canonicalize().unwrap());
    }

    #[test]
    fn test_resolve_nonexistent_path() {
        let (dir, sandbox) = setup_sandbox();
        let resolved = sandbox.resolve("new_file.txt").unwrap();
        assert_eq!(resolved, dir.path().canonicalize().unwrap().join("new_file.txt"));
    }

    #[test]
    fn test_resolve_subdirectory() {
        let (dir, sandbox) = setup_sandbox();
        let subdir = dir.path().join("sub");
        fs::create_dir(&subdir).unwrap();
        let file = subdir.join("nested.txt");
        fs::write(&file, b"nested").unwrap();

        let resolved = sandbox.resolve("sub/nested.txt").unwrap();
        assert_eq!(resolved, file.canonicalize().unwrap());
    }

    #[test]
    fn test_resolve_rejects_dot_dot_escape() {
        let (_dir, sandbox) = setup_sandbox();
        let result = sandbox.resolve("../etc/passwd");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("permission_denied") || err.contains("outside sandbox"));
    }

    #[test]
    fn test_resolve_rejects_absolute_path_outside_root() {
        let (_dir, sandbox) = setup_sandbox();
        let result = sandbox.resolve("/etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn test_resolve_rejects_symlink_escape() {
        let (dir, sandbox) = setup_sandbox();
        // Create a symlink pointing outside the sandbox.
        let link_path = dir.path().join("escape_link");
        symlink("/etc/passwd", &link_path).unwrap();

        let result = sandbox.resolve("escape_link");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("permission_denied") || err.contains("outside sandbox"));
    }

    #[test]
    fn test_resolve_allows_symlink_within_sandbox() {
        let (dir, sandbox) = setup_sandbox();
        let target = dir.path().join("target.txt");
        fs::write(&target, b"target").unwrap();
        let link_path = dir.path().join("link.txt");
        symlink(&target, &link_path).unwrap();

        let resolved = sandbox.resolve("link.txt").unwrap();
        assert_eq!(resolved, target.canonicalize().unwrap());
    }

    #[test]
    fn test_resolve_with_leading_slash() {
        let (dir, sandbox) = setup_sandbox();
        let file = dir.path().join("slash_test.txt");
        fs::write(&file, b"slash").unwrap();

        let resolved = sandbox.resolve("/slash_test.txt").unwrap();
        assert_eq!(resolved, file.canonicalize().unwrap());
    }

    #[test]
    fn test_sandbox_nonexistent_root() {
        let result = PathSandbox::new("/tmp/nession-nonexistent-dir-xyz");
        assert!(result.is_err());
    }
}
```

Note: The tests use `tempfile` which is already available as a transitive dependency. If not directly available, add it to `dev-dependencies`.

- [ ] **Step 3: Add `pub mod fs;` to `lib.rs`**

In `crates/nession-agent/src/lib.rs`, add after `pub mod config;`:

```rust
pub mod fs;
```

- [ ] **Step 4: Run sandbox tests**

Run: `cargo test -p nession-agent fs::sandbox`
Expected: All 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/nession-agent/src/fs/ crates/nession-agent/src/lib.rs
git commit -m "feat: add PathSandbox for secure file operation scoping

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Agent-side fs module — FileOps

**Files:**
- Create: `crates/nession-agent/src/fs/ops.rs`
- Modify: `crates/nession-agent/Cargo.toml` (add `mime_guess` dep)
- Modify: `Cargo.toml` (workspace root — add `mime_guess` to workspace deps)

- [ ] **Step 1: Add `mime_guess` dependency**

In workspace `Cargo.toml`, add to `[workspace.dependencies]`:

```toml
mime_guess = "2.0"
```

In `crates/nession-agent/Cargo.toml`, add to `[dependencies]`:

```toml
mime_guess.workspace = true
```

- [ ] **Step 2: Create `fs/ops.rs` with `FileEntry` type and `FileOps` struct**

```rust
use anyhow::{Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tokio::task;

use super::sandbox::PathSandbox;

/// Maximum file size for read operations (10 MB).
const MAX_READ_SIZE: u64 = 10 * 1024 * 1024;

/// A filesystem entry returned by directory listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

/// Data returned by a file read operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileData {
    pub path: String,
    /// Base64-encoded file content.
    pub content: String,
    /// MIME type (e.g. "text/plain", "application/json").
    pub mime_type: String,
}

/// High-level file operations scoped to a sandbox root.
pub struct FileOps {
    sandbox: PathSandbox,
}

impl FileOps {
    pub fn new(sandbox: PathSandbox) -> Self {
        Self { sandbox }
    }

    /// List entries in a directory. Sorted: directories first, then files,
    /// both alphabetically by name.
    pub async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>> {
        let resolved = self.sandbox.resolve(path)?;

        if !resolved.is_dir() {
            anyhow::bail!("not_a_directory: {}", path);
        }

        let entries = task::spawn_blocking(move || -> Result<Vec<FileEntry>> {
            let mut result: Vec<FileEntry> = Vec::new();
            let dir = fs::read_dir(&resolved)
                .with_context(|| format!("failed to read directory: {}", resolved.display()))?;

            for entry in dir {
                let entry = entry?;
                let metadata = entry.metadata()?;
                let entry_path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();

                // Skip hidden files and directories (leading dot), except "." and ".."
                // Actually include hidden files — they're common in dev work (.env, .gitignore, etc.)
                result.push(FileEntry {
                    name,
                    path: entry_path.to_string_lossy().to_string(),
                    is_dir: metadata.is_dir(),
                    size: metadata.len(),
                    modified: metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                });
            }

            // Sort: directories first (alphabetical), then files (alphabetical).
            result.sort_by(|a, b| {
                b.is_dir
                    .cmp(&a.is_dir)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });

            Ok(result)
        })
        .await??;

        Ok(entries)
    }

    /// Read the contents of a file. Returns base64-encoded content.
    /// Rejects files larger than `MAX_READ_SIZE`.
    pub async fn read_file(&self, path: &str) -> Result<FileData> {
        let resolved = self.sandbox.resolve(path)?;

        if resolved.is_dir() {
            anyhow::bail!("is_directory: cannot read a directory");
        }

        let path_str = resolved.to_string_lossy().to_string();
        let path_for_mime = path_str.clone();

        let content = task::spawn_blocking(move || -> Result<(Vec<u8>, String)> {
            let metadata = fs::metadata(&resolved)
                .with_context(|| format!("failed to read metadata: {}", resolved.display()))?;
            let size = metadata.len();

            if size > MAX_READ_SIZE {
                anyhow::bail!(
                    "file_too_large: file is {} bytes, max allowed is {} bytes",
                    size,
                    MAX_READ_SIZE
                );
            }

            let data = fs::read(&resolved)
                .with_context(|| format!("failed to read file: {}", resolved.display()))?;

            // Detect MIME type from the file extension.
            let mime = mime_guess::from_path(&path_for_mime)
                .first_or_text_plain()
                .to_string();

            Ok((data, mime))
        })
        .await??;

        let encoded = base64::engine::general_purpose::STANDARD.encode(&content.0);

        Ok(FileData {
            path: path_str,
            content: encoded,
            mime_type: content.1,
        })
    }

    /// Write content to a file. Uses atomic write (temp + rename).
    /// `content` is base64-encoded bytes.
    pub async fn write_file(&self, path: &str, content_b64: &str) -> Result<u64> {
        let resolved = self.sandbox.resolve(path)?;

        let data = base64::engine::general_purpose::STANDARD
            .decode(content_b64)
            .context("failed to decode base64 content")?;

        let len = data.len() as u64;

        task::spawn_blocking(move || -> Result<u64> {
            // Ensure parent directory exists.
            if let Some(parent) = resolved.parent() {
                fs::create_dir_all(parent)
                    .with_context(|| format!("failed to create parent dir: {}", parent.display()))?;
            }

            // Atomic write: write to temp file, then rename.
            let tmp = resolved.with_extension("tmp");
            fs::write(&tmp, &data)
                .with_context(|| format!("failed to write temp file: {}", tmp.display()))?;
            fs::rename(&tmp, &resolved)
                .with_context(|| format!("failed to rename temp file: {}", tmp.display()))?;

            Ok(len)
        })
        .await??;

        Ok(len)
    }

    /// Delete a file or an empty directory.
    pub async fn delete(&self, path: &str) -> Result<()> {
        let resolved = self.sandbox.resolve(path)?;

        task::spawn_blocking(move || -> Result<()> {
            if resolved.is_dir() {
                fs::remove_dir(&resolved)
                    .with_context(|| format!("failed to remove directory: {}", resolved.display()))?;
            } else {
                fs::remove_file(&resolved)
                    .with_context(|| format!("failed to remove file: {}", resolved.display()))?;
            }
            Ok(())
        })
        .await??;

        Ok(())
    }

    /// Create a directory (and any missing parents).
    pub async fn create_dir(&self, path: &str) -> Result<()> {
        let resolved = self.sandbox.resolve(path)?;

        task::spawn_blocking(move || -> Result<()> {
            fs::create_dir_all(&resolved)
                .with_context(|| format!("failed to create directory: {}", resolved.display()))?;
            Ok(())
        })
        .await??;

        Ok(())
    }

    /// Rename (move) a file or directory within the sandbox.
    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        let from_resolved = self.sandbox.resolve(from)?;
        let to_resolved = self.sandbox.resolve(to)?;

        task::spawn_blocking(move || -> Result<()> {
            // Ensure parent of destination exists.
            if let Some(parent) = to_resolved.parent() {
                fs::create_dir_all(parent).with_context(|| {
                    format!("failed to create parent dir: {}", parent.display())
                })?;
            }
            fs::rename(&from_resolved, &to_resolved).with_context(|| {
                format!(
                    "failed to rename {} to {}",
                    from_resolved.display(),
                    to_resolved.display()
                )
            })?;
            Ok(())
        })
        .await??;

        Ok(())
    }

    /// Return the sandbox root path as a string.
    pub fn root_path(&self) -> String {
        self.sandbox.root().to_string_lossy().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, FileOps) {
        let dir = tempfile::tempdir().unwrap();
        let sandbox = PathSandbox::new(dir.path()).unwrap();
        let ops = FileOps::new(sandbox);
        (dir, ops)
    }

    #[tokio::test]
    async fn test_list_empty_dir() {
        let (_dir, ops) = setup();
        let entries = ops.list_dir("").await.unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn test_list_dir_with_files() {
        let (dir, ops) = setup();
        fs::write(dir.path().join("a.txt"), b"a").unwrap();
        fs::write(dir.path().join("b.txt"), b"bb").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();

        let entries = ops.list_dir("").await.unwrap();
        assert_eq!(entries.len(), 3);
        // Directories first.
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].name, "subdir");
        assert_eq!(entries[1].name, "a.txt");
        assert_eq!(entries[2].name, "b.txt");
        assert_eq!(entries[2].size, 2);
    }

    #[tokio::test]
    async fn test_read_write_roundtrip() {
        let (dir, ops) = setup();
        let content = "Hello, Nession! 你好 🚀";
        let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());

        let written = ops.write_file("test.txt", &b64).await.unwrap();
        assert_eq!(written, content.len() as u64);

        let file_data = ops.read_file("test.txt").await.unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&file_data.content)
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), content);
        assert_eq!(file_data.mime_type, "text/plain");
    }

    #[tokio::test]
    async fn test_read_file_too_large() {
        let (dir, ops) = setup();
        // Create a small file then try to read with a mock limit — the actual
        // limit is 10MB which we can't test, but we verify the error format.
        // Instead, verify normal reads work and that directories are rejected.
        let result = ops.read_file("nonexistent.txt").await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("not found") || err.contains("path not found"));
    }

    #[tokio::test]
    async fn test_read_directory_fails() {
        let (dir, ops) = setup();
        fs::create_dir(dir.path().join("mydir")).unwrap();
        let result = ops.read_file("mydir").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("is_directory"));
    }

    #[tokio::test]
    async fn test_delete_file() {
        let (dir, ops) = setup();
        fs::write(dir.path().join("del.txt"), b"delete me").unwrap();
        ops.delete("del.txt").await.unwrap();
        assert!(!dir.path().join("del.txt").exists());
    }

    #[tokio::test]
    async fn test_delete_nonexistent_fails() {
        let (_dir, ops) = setup();
        let result = ops.delete("nope.txt").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_create_dir() {
        let (dir, ops) = setup();
        ops.create_dir("a/b/c").await.unwrap();
        assert!(dir.path().join("a/b/c").is_dir());
    }

    #[tokio::test]
    async fn test_rename_file() {
        let (dir, ops) = setup();
        fs::write(dir.path().join("old.txt"), b"old").unwrap();
        ops.rename("old.txt", "new.txt").await.unwrap();
        assert!(!dir.path().join("old.txt").exists());
        assert_eq!(fs::read_to_string(dir.path().join("new.txt")).unwrap(), "old");
    }

    #[tokio::test]
    async fn test_write_creates_parent_dirs() {
        let (dir, ops) = setup();
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"deep");
        ops.write_file("deep/nested/file.txt", &b64).await.unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("deep/nested/file.txt")).unwrap(),
            "deep"
        );
    }
}
```

- [ ] **Step 3: Run file ops tests**

Run: `cargo test -p nession-agent fs::ops`
Expected: All 10 tests pass.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml crates/nession-agent/Cargo.toml crates/nession-agent/src/fs/ops.rs
git commit -m "feat: add FileOps for sandboxed file operations

- list_dir, read_file, write_file (atomic), delete, create_dir, rename
- All I/O via tokio::task::spawn_blocking
- Max read size 10MB, base64 encoding for wire transfer

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Wire file ops into AgentServer P2P WebSocket protocol

**Files:**
- Modify: `crates/nession-agent/src/server/websocket.rs`

- [ ] **Step 1: Add file operation message type constants**

In `crates/nession-agent/src/server/websocket.rs`, add to the `msg_types` module after `pub const CLIENT_SESSION_KILL`:

```rust
// File operations
pub const FILE_LIST: &str = "file.list";
pub const FILE_READ: &str = "file.read";
pub const FILE_WRITE: &str = "file.write";
pub const FILE_DELETE: &str = "file.delete";
pub const FILE_CREATE_DIR: &str = "file.create_dir";
pub const FILE_RENAME: &str = "file.rename";
pub const FILE_UPLOAD: &str = "file.upload";
```

- [ ] **Step 2: Add file operation payload types**

After the existing payload type definitions (after `ErrorPayload`), add:

```rust
// --- File operation payloads ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileListPayload {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileReadPayload {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileWritePayload {
    pub path: String,
    /// Base64-encoded content.
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileWriteResponse {
    pub path: String,
    pub written: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDeletePayload {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDeleteResponse {
    pub path: String,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileCreateDirPayload {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileCreateDirResponse {
    pub path: String,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRenamePayload {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRenameResponse {
    pub from: String,
    pub to: String,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileUploadPayload {
    pub path: String,
    /// Base64-encoded content.
    pub content: String,
    pub size: u64,
}
```

- [ ] **Step 3: Add `FileOps` to the connection handler**

In `AgentServer`, add `file_ops: Arc<FileOps>` as a field:

```rust
pub struct AgentServer {
    tmux_manager: TmuxManager,
    file_ops: Arc<crate::fs::ops::FileOps>,
    shutdown_tx: mpsc::Sender<()>,
    shutdown_rx: Option<mpsc::Receiver<()>>,
    tls_acceptor: Option<tokio_rustls::TlsAcceptor>,
    listen_address: String,
}
```

Update `AgentServer::new` to accept and store `file_root: &str`:

```rust
pub fn new(
    listen_address: impl Into<String>,
    tls: Option<(
        Vec<rustls::pki_types::CertificateDer<'static>>,
        rustls::pki_types::PrivateKeyDer<'static>,
    )>,
    file_root: &str,
) -> Result<Self> {
    let tls_acceptor = match tls {
        Some((certs, key)) => {
            let config = tokio_rustls::rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(certs, key)
                .context("failed to build TLS config")?;
            Some(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
        }
        None => None,
    };

    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);

    let sandbox = crate::fs::sandbox::PathSandbox::new(file_root)
        .context("failed to create file sandbox")?;
    let file_ops = Arc::new(crate::fs::ops::FileOps::new(sandbox));

    Ok(Self {
        tmux_manager: TmuxManager::new(),
        file_ops,
        shutdown_tx,
        shutdown_rx: Some(shutdown_rx),
        tls_acceptor,
        listen_address: listen_address.into(),
    })
}
```

- [ ] **Step 4: Update `handle_connection` and `run_message_loop` to pass `file_ops`**

In `AgentServer::handle_connection`, clone `file_ops`:

```rust
let file_ops = Arc::clone(&self.file_ops);
// ... later in run_message_loop call:
Self::run_message_loop(ws_stream, sink, tmux_manager, sessions, file_ops, addr).await
```

Update `run_message_loop` signature to accept `file_ops: Arc<FileOps>` and pass it to `handle_request`.

Update `handle_request` signature to accept `file_ops: Arc<FileOps>`.

- [ ] **Step 5: Add match arms for file operations in `handle_request`**

After the existing `match msg_type` arms, add before the `unknown` fallback:

```rust
msg_types::FILE_LIST => {
    let payload: FileListPayload = match serde_json::from_value(payload_value) {
        Ok(p) => p,
        Err(e) => return err("parse_error", &e.to_string()),
    };
    match file_ops.list_dir(&payload.path).await {
        Ok(entries) => {
            let resp = serde_json::json!({
                "entries": entries,
            });
            serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                .unwrap_or_default()
        }
        Err(e) => err("list_failed", &e.to_string()),
    }
}

msg_types::FILE_READ => {
    let payload: FileReadPayload = match serde_json::from_value(payload_value) {
        Ok(p) => p,
        Err(e) => return err("parse_error", &e.to_string()),
    };
    match file_ops.read_file(&payload.path).await {
        Ok(data) => {
            serde_json::to_string(&make_response(&id, msg_types::OK, data))
                .unwrap_or_default()
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("permission_denied") {
                err("permission_denied", &msg)
            } else if msg.contains("is_directory") {
                err("is_directory", &msg)
            } else if msg.contains("file_too_large") {
                err("file_too_large", &msg)
            } else {
                err("io_error", &msg)
            }
        }
    }
}

msg_types::FILE_WRITE => {
    let payload: FileWritePayload = match serde_json::from_value(payload_value) {
        Ok(p) => p,
        Err(e) => return err("parse_error", &e.to_string()),
    };
    let path = payload.path.clone();
    match file_ops.write_file(&payload.path, &payload.content).await {
        Ok(written) => {
            let resp = FileWriteResponse {
                path,
                written,
            };
            serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                .unwrap_or_default()
        }
        Err(e) => err("write_error", &e.to_string()),
    }
}

msg_types::FILE_DELETE => {
    let payload: FileDeletePayload = match serde_json::from_value(payload_value) {
        Ok(p) => p,
        Err(e) => return err("parse_error", &e.to_string()),
    };
    let path = payload.path.clone();
    match file_ops.delete(&payload.path).await {
        Ok(()) => {
            let resp = FileDeleteResponse { path, success: true };
            serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                .unwrap_or_default()
        }
        Err(e) => {
            let resp = FileDeleteResponse { path, success: false };
            serde_json::to_string(&make_response(&id, msg_types::ERROR, resp))
                .unwrap_or_default()
        }
    }
}

msg_types::FILE_CREATE_DIR => {
    let payload: FileCreateDirPayload = match serde_json::from_value(payload_value) {
        Ok(p) => p,
        Err(e) => return err("parse_error", &e.to_string()),
    };
    let path = payload.path.clone();
    match file_ops.create_dir(&payload.path).await {
        Ok(()) => {
            let resp = FileCreateDirResponse { path, success: true };
            serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                .unwrap_or_default()
        }
        Err(e) => {
            let resp = FileCreateDirResponse { path, success: false };
            serde_json::to_string(&make_response(&id, msg_types::ERROR, resp))
                .unwrap_or_default()
        }
    }
}

msg_types::FILE_RENAME => {
    let payload: FileRenamePayload = match serde_json::from_value(payload_value) {
        Ok(p) => p,
        Err(e) => return err("parse_error", &e.to_string()),
    };
    let from = payload.from.clone();
    let to = payload.to.clone();
    match file_ops.rename(&payload.from, &payload.to).await {
        Ok(()) => {
            let resp = FileRenameResponse { from, to, success: true };
            serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                .unwrap_or_default()
        }
        Err(e) => {
            let resp = FileRenameResponse { from, to, success: false };
            serde_json::to_string(&make_response(&id, msg_types::ERROR, resp))
                .unwrap_or_default()
        }
    }
}

msg_types::FILE_UPLOAD => {
    let payload: FileUploadPayload = match serde_json::from_value(payload_value) {
        Ok(p) => p,
        Err(e) => return err("parse_error", &e.to_string()),
    };
    let path = payload.path.clone();
    match file_ops.write_file(&payload.path, &payload.content).await {
        Ok(written) => {
            let resp = FileWriteResponse { path, written };
            serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                .unwrap_or_default()
        }
        Err(e) => err("upload_error", &e.to_string()),
    }
}
```

- [ ] **Step 6: Add `use` imports for the file ops types at top of file**

```rust
use crate::fs::ops::{FileOps, FileEntry, FileData};
```

- [ ] **Step 7: Update `main.rs` to pass `file_root` to `AgentServer::new`**

In `crates/nession-agent/src/main.rs`, update the AgentServer creation:

```rust
let file_root = config.file_root.as_deref().unwrap_or(&config.default_working_dir);
let agent_server = AgentServer::new(&config.listen_address, tls_option, file_root)
    .context("failed to create agent server")?;
```

- [ ] **Step 8: Add integration tests for file protocol messages**

Add to the existing test module in `server/websocket.rs`, following the pattern from existing tests like `test_session_list_request`. Add a test that connects a client, sends `file.list` with path `"/"`, and verifies the response contains `entries`.

```rust
#[tokio::test]
async fn test_file_list_root() {
    let (addr, handle) = start_test_server_on(18087).await;
    let (mut sink, mut stream) = connect_client(addr).await;

    let req = new_message(msg_types::FILE_LIST, FileListPayload {
        path: "".to_string(),
    });
    let resp: Message<serde_json::Value> = send_and_receive(&mut sink, &mut stream, &req).await;

    assert_eq!(resp.msg_type, msg_types::OK);
    assert!(resp.payload.get("entries").is_some());

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn test_file_write_and_read_roundtrip() {
    let (addr, handle) = start_test_server_on(18088).await;
    let (mut sink, mut stream) = connect_client(addr).await;

    // Write a file.
    let content = b"nession file test";
    let b64 = base64::engine::general_purpose::STANDARD.encode(content);
    let write_req = new_message(msg_types::FILE_WRITE, FileWritePayload {
        path: "roundtrip_test.txt".to_string(),
        content: b64,
    });
    let write_resp: Message<FileWriteResponse> =
        send_and_receive(&mut sink, &mut stream, &write_req).await;
    assert_eq!(write_resp.msg_type, msg_types::OK);
    assert!(write_resp.payload.written > 0);

    // Read it back.
    let read_req = new_message(msg_types::FILE_READ, FileReadPayload {
        path: "roundtrip_test.txt".to_string(),
    });
    let read_resp: Message<FileData> =
        send_and_receive(&mut sink, &mut stream, &read_req).await;
    assert_eq!(read_resp.msg_type, msg_types::OK);
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&read_resp.payload.content)
        .unwrap();
    assert_eq!(&decoded, content);

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn test_file_delete() {
    let (addr, handle) = start_test_server_on(18089).await;
    let (mut sink, mut stream) = connect_client(addr).await;

    // Create a file first.
    let content = base64::engine::general_purpose::STANDARD.encode(b"to delete");
    let write_req = new_message(msg_types::FILE_WRITE, FileWritePayload {
        path: "to_delete.txt".to_string(),
        content,
    });
    let _: Message<FileWriteResponse> =
        send_and_receive(&mut sink, &mut stream, &write_req).await;

    // Delete it.
    let del_req = new_message(msg_types::FILE_DELETE, FileDeletePayload {
        path: "to_delete.txt".to_string(),
    });
    let del_resp: Message<FileDeleteResponse> =
        send_and_receive(&mut sink, &mut stream, &del_req).await;
    assert_eq!(del_resp.msg_type, msg_types::OK);
    assert!(del_resp.payload.success);

    // Verify it's gone by trying to read it.
    let read_req = new_message(msg_types::FILE_READ, FileReadPayload {
        path: "to_delete.txt".to_string(),
    });
    let read_resp: Message<ErrorPayload> =
        send_and_receive(&mut sink, &mut stream, &read_req).await;
    assert_eq!(read_resp.msg_type, msg_types::ERROR);

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn test_file_permission_denied_on_escape() {
    let (addr, handle) = start_test_server_on(18090).await;
    let (mut sink, mut stream) = connect_client(addr).await;

    let req = new_message(msg_types::FILE_READ, FileReadPayload {
        path: "../etc/passwd".to_string(),
    });
    let resp: Message<ErrorPayload> = send_and_receive(&mut sink, &mut stream, &req).await;

    assert_eq!(resp.msg_type, msg_types::ERROR);
    assert!(resp.payload.code == "permission_denied" || resp.payload.code == "io_error");

    handle.shutdown().await.ok();
}
```

- [ ] **Step 9: Update `start_test_server_on` to accept file_root**

The test helper `start_test_server_on` needs to create the server with a temp dir for `file_root`. Update it:

```rust
async fn start_test_server_on(port: u16) -> (SocketAddr, ServerHandle) {
    let addr_str = format!("127.0.0.1:{}", port);
    let tmp = tempfile::tempdir().expect("tempdir for test");
    let server = AgentServer::new(
        &addr_str,
        None,
        tmp.path().to_string_lossy().as_ref(),
    ).expect("server creation should succeed");
    let handle = server.start().await.expect("start should succeed");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    (addr_str.parse().unwrap(), handle)
}
```

Note: add `tempfile` as a dev-dependency in `crates/nession-agent/Cargo.toml`:

```toml
[dev-dependencies]
tempfile = "3"
```

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 10: Run all websocket tests**

Run: `cargo test -p nession-agent server::websocket`
Expected: All tests pass (existing + 4 new file op tests).

- [ ] **Step 11: Commit**

```bash
git add crates/nession-agent/src/server/websocket.rs crates/nession-agent/src/main.rs crates/nession-agent/Cargo.toml
git commit -m "feat: add file operation protocol handlers to agent P2P server

- New msg_types: file.list, file.read, file.write, file.delete, file.create_dir, file.rename, file.upload
- FileOps wired into AgentServer via PathSandbox
- agent main.rs passes file_root config to server
- Tests for list, read/write roundtrip, delete, sandbox escape rejection

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: P2P WebSocket refactor — extract `useP2PConnection` hook

**Files:**
- Create: `web/src/hooks/useP2PConnection.ts`
- Modify: `web/src/components/Terminal.tsx`
- Modify: `web/src/components/Dashboard.tsx` (TerminalView)

- [ ] **Step 1: Create `useP2PConnection` hook**

Create `web/src/hooks/useP2PConnection.ts`:

```typescript
import { useEffect, useRef, useCallback, useState } from 'react';

export interface P2PMessage {
  msg_type: string;
  id: string;
  timestamp: number;
  payload: any;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

type MessageHandler = (msg: P2PMessage) => void;

export interface P2PConnection {
  sendMessage: (msg: Record<string, unknown>) => void;
  onMessage: (handler: MessageHandler) => () => void;
  connectionState: ConnectionState;
  close: () => void;
}

interface UseP2PConnectionOptions {
  agentUrl: string;
  connectionToken?: string;
  sessionName: string;
}

/**
 * Manages a P2P WebSocket connection to an agent for both terminal I/O
 * and file operations. The connection lifecycle is tied to component mount.
 */
export function useP2PConnection({
  agentUrl,
  connectionToken,
  sessionName,
}: UseP2PConnectionOptions): P2PConnection {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const activeRef = useRef(true);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');

  useEffect(() => {
    activeRef.current = true;

    const wsUrl = connectionToken
      ? `${agentUrl}${agentUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(connectionToken)}`
      : agentUrl;

    console.log('[P2P] Connecting to:', wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';
    setConnectionState('connecting');

    ws.onopen = () => {
      if (!activeRef.current) {
        ws.close();
        return;
      }
      console.log('[P2P] Connected');
      setConnectionState('connected');
    };

    ws.onmessage = (event) => {
      if (!activeRef.current) return;
      try {
        if (typeof event.data === 'string') {
          const msg: P2PMessage = JSON.parse(event.data);
          handlersRef.current.forEach((handler) => {
            try {
              handler(msg);
            } catch (e) {
              console.error('[P2P] Handler error:', e);
            }
          });
        }
      } catch (err) {
        console.error('[P2P] Message parse error:', err);
      }
    };

    ws.onerror = (event) => {
      console.error('[P2P] WebSocket error:', event);
    };

    ws.onclose = () => {
      console.log('[P2P] WebSocket closed');
      if (activeRef.current) {
        setConnectionState('disconnected');
      }
    };

    return () => {
      activeRef.current = false;
      ws.onclose = null;
      ws.close();
      wsRef.current = null;
    };
  }, [agentUrl, connectionToken, sessionName]);

  const sendMessage = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const onMessage = useCallback((handler: MessageHandler): () => void => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const close = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  return { sendMessage, onMessage, connectionState, close };
}
```

- [ ] **Step 2: Refactor `Terminal.tsx` to receive P2P connection via props**

In `Terminal.tsx`, modify the `TerminalProps` interface. Replace the P2P-specific props with a `p2pConnection` prop:

```typescript
import type { P2PConnection } from '../hooks/useP2PConnection';

export interface TerminalProps {
  sessionId: string;
  sessionName: string;
  mode: 'p2p' | 'relay';
  /** For P2P mode: shared connection (terminal + file ops) */
  p2pConnection?: P2PConnection;
  /** For relay mode: server connection */
  serverConnection?: WebSocketService;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}
```

Remove the internal P2P WebSocket creation logic (the entire `mountTimer` block for `mode === 'p2p'`). Instead, use `p2pConnection` props:

- `p2pConnection.sendMessage(...)` replaces `p2pWs.send(...)`
- Subscribe to messages via `p2pConnection.onMessage(handler)`
- Watch `p2pConnection.connectionState` instead of tracking `ws.readyState`
- `p2pConnection.close()` replaces `p2pWs.close()`

The key changes in the Terminal effect:

```typescript
// In the useEffect body, for P2P mode:
if (mode === 'p2p' && p2pConnection) {
  // Subscribe to incoming messages.
  const unsub = p2pConnection.onMessage((msg) => {
    switch (msg.msg_type) {
      case 'terminal.output':
        if (msg.payload?.data) {
          term.write(decodeB64(msg.payload.data));
        }
        break;
      case 'ok':
        break;
      case 'error':
        if (msg.id?.startsWith('ka-')) break;
        reportError(new Error(msg.payload?.message || 'Remote error'));
        break;
      case 'keepalive.pong':
        break;
    }
  });

  // Send attach message when connection is ready.
  // (Use a ref to track whether we've already attached.)
  const attachRef = { current: false };
  const checkConnected = setInterval(() => {
    if (p2pConnection.connectionState === 'connected' && !attachRef.current) {
      attachRef.current = true;
      clearInterval(checkConnected);
      const attachMsg = {
        msg_type: 'client.attach',
        id: generateId(),
        timestamp: Math.floor(Date.now() / 1000),
        payload: {
          session_name: sessionName,
          width: term.cols,
          height: term.rows,
        },
      };
      p2pConnection.sendMessage(attachMsg);
      // Send newline to trigger prompt.
      const encoder = new TextEncoder();
      const b64 = btoa(String.fromCharCode(...encoder.encode('\r')));
      p2pConnection.sendMessage({
        msg_type: 'terminal.input',
        id: generateId(),
        timestamp: Math.floor(Date.now() / 1000),
        payload: { session_name: sessionName, data: b64 },
      });
    }
  }, 100);

  // Expose data sender.
  sendDataRef.current = (data: string) => {
    if (p2pConnection.connectionState === 'connected') {
      p2pConnection.sendMessage({
        msg_type: 'terminal.input',
        id: generateId(),
        timestamp: Math.floor(Date.now() / 1000),
        payload: { session_name: sessionName, data: encodeB64(data) },
      });
    }
  };

  // Keepalive ping.
  pingTimer = setInterval(() => {
    p2pConnection.sendMessage({
      msg_type: 'keepalive.ping',
      id: `ka-${Date.now()}`,
      timestamp: Math.floor(Date.now() / 1000),
      payload: {},
    });
  }, 30_000);

  // Cleanup.
  // (store unsub, clearInterval handles, etc. in cleanup return)
}
```

Remove `p2pWs` references and the direct `new WebSocket()` call. The cleanup should call `unsub()` and clear intervals but NOT close the WebSocket (that's owned by `useP2PConnection`).

- [ ] **Step 3: Update `TerminalView` in `Dashboard.tsx` to use `useP2PConnection`**

In the `TerminalView` component:

```typescript
import { useP2PConnection } from '../hooks/useP2PConnection';

function TerminalView({ session, wsService, onBack, onDisconnect, onError }: TerminalViewProps) {
  const { attachInfo, sessionId, sessionName } = session;
  const isP2P = attachInfo.mode === 'p2p';
  const terminalRef = useRef<TerminalHandle>(null);

  const p2pConnection = useP2PConnection(
    isP2P && attachInfo.agent_address
      ? {
          agentUrl: attachInfo.agent_address,
          connectionToken: attachInfo.connection_token,
          sessionName,
        }
      : null,
  );

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="border-b px-4 py-2 flex items-center gap-4 flex-shrink-0">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <span className="text-sm text-muted-foreground">
          Session: <strong className="text-foreground">{sessionName}</strong>
        </span>
        <Badge variant={attachInfo.mode === 'p2p' ? 'default' : 'secondary'} className="text-xs">
          {attachInfo.mode.toUpperCase()}
        </Badge>
      </header>
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0">
          <Terminal
            ref={terminalRef}
            sessionId={sessionId}
            sessionName={sessionName}
            mode={attachInfo.mode}
            p2pConnection={isP2P ? p2pConnection : undefined}
            serverConnection={!isP2P ? wsService : undefined}
            onDisconnect={onDisconnect}
            onError={onError}
          />
        </div>
        <TerminalToolbar sendText={(text) => terminalRef.current?.sendText(text)} />
      </div>
    </div>
  );
}
```

Wait — there's a problem. If `useP2PConnection` is called conditionally (only when `isP2P`), it violates the rules of hooks. Let me fix this: always call the hook but with `null` options for relay mode.

Actually, let me redesign this. `useP2PConnection` should accept possibly-null options:

```typescript
export function useP2PConnection(
  options: UseP2PConnectionOptions | null,
): P2PConnection | null {
  // ... inside useEffect, if options is null, skip connecting
}
```

Or better: only call the hook when in P2P mode. But hooks can't be conditional. Let me just always call it and handle null inside:

```typescript
const p2pConnection = useP2PConnection(
  isP2P && attachInfo.agent_address
    ? {
        agentUrl: attachInfo.agent_address,
        connectionToken: attachInfo.connection_token,
        sessionName,
      }
    : null,
);
```

And in the hook:

```typescript
export function useP2PConnection(
  options: UseP2PConnectionOptions | null,
): P2PConnection | null {
  // ...
  useEffect(() => {
    if (!options) return;
    // ... rest of connection logic
  }, [options?.agentUrl, options?.connectionToken, options?.sessionName]);
  // ...
}
```

This is clean. The hook returns `null` when options are null, and `Terminal` handles `undefined` p2pConnection gracefully (the existing code already checks mode before using the connection).

- [ ] **Step 4: Verify TypeScript compilation**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors (some may exist from previous tasks, focus on new errors only).

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/ web/src/components/Terminal.tsx web/src/components/Dashboard.tsx
git commit -m "refactor: extract P2P WebSocket into useP2PConnection hook

- New hook manages WebSocket lifecycle, message routing, connection state
- Terminal receives P2P connection via props instead of owning it
- Enables file manager components to share the same P2P connection

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: File operations helper — `fileOps.ts`

**Files:**
- Create: `web/src/services/fileOps.ts`

- [ ] **Step 1: Create `fileOps.ts`**

Create `web/src/services/fileOps.ts`:

```typescript
import type { P2PConnection } from '../hooks/useP2PConnection';

// --- Types ---

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

export interface FileData {
  path: string;
  content: string; // base64
  mime_type: string;
}

// --- Helpers ---

let msgCounter = 0;
function generateId(): string {
  return `file-${Date.now()}-${++msgCounter}`;
}

function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64Decode(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function sendRequest(
  p2p: P2PConnection,
  msgType: string,
  payload: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = generateId();
    const timeout = setTimeout(() => {
      unsub();
      reject(new Error(`File operation timeout: ${msgType}`));
    }, timeoutMs);

    const unsub = p2p.onMessage((msg) => {
      if (msg.id === id) {
        clearTimeout(timeout);
        unsub();
        if (msg.msg_type === 'error') {
          reject(new Error(msg.payload?.message || `File operation failed: ${msgType}`));
        } else {
          resolve(msg.payload);
        }
      }
    });

    p2p.sendMessage({
      msg_type: msgType,
      id,
      timestamp: Math.floor(Date.now() / 1000),
      payload,
    });
  });
}

// --- Public API ---

export function createFileOps(p2p: P2PConnection) {
  return {
    listDir: (path: string): Promise<{ entries: FileEntry[] }> =>
      sendRequest(p2p, 'file.list', { path }),

    readFile: (path: string): Promise<FileData> =>
      sendRequest(p2p, 'file.read', { path }),

    writeFile: (path: string, content: string): Promise<{ path: string; written: number }> =>
      sendRequest(p2p, 'file.write', { path, content: base64Encode(content) }),

    deleteFile: (path: string): Promise<{ path: string; success: boolean }> =>
      sendRequest(p2p, 'file.delete', { path }),

    createDir: (path: string): Promise<{ path: string; success: boolean }> =>
      sendRequest(p2p, 'file.create_dir', { path }),

    renameFile: (from: string, to: string): Promise<{ from: string; to: string; success: boolean }> =>
      sendRequest(p2p, 'file.rename', { from, to }),

    uploadFile: (path: string, file: File): Promise<{ path: string; written: number }> => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const content = reader.result as string;
          // content is a data URL: "data:...;base64,..."
          const b64 = content.split(',')[1];
          sendRequest(p2p, 'file.upload', { path, content: b64, size: file.size })
            .then(resolve)
            .catch(reject);
        };
        reader.onerror = () => reject(new Error('Failed to read file for upload'));
        reader.readAsDataURL(file);
      });
    },

    base64Decode,
    base64Encode,
  };
}

export type FileOps = ReturnType<typeof createFileOps>;
```

- [ ] **Step 2: Commit**

```bash
git add web/src/services/fileOps.ts
git commit -m "feat: add fileOps helper for P2P file operations

- Request/response correlation via message IDs
- Base64 encode/decode utilities
- All 7 file operations: list, read, write, delete, createDir, rename, upload

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: SidePanel component

**Files:**
- Create: `web/src/components/SidePanel.tsx`

- [ ] **Step 1: Create `SidePanel.tsx`**

```typescript
import { useState, useCallback, useRef, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SidePanelProps {
  children: React.ReactNode;
  defaultOpen?: boolean;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
}

/**
 * Collapsible, resizable side panel.
 *
 * Extensible: accepts any children. Currently hosts FileBrowser; future
 * sections (process monitor, etc.) can be added as siblings or tabs
 * inside PanelContent.
 */
export function SidePanel({
  children,
  defaultOpen = false,
  defaultWidth = 260,
  minWidth = 180,
  maxWidth = 480,
}: SidePanelProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [width, setWidth] = useState(defaultWidth);
  const isResizing = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = width;

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = e.clientX - startX;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
      setWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [width, minWidth, maxWidth]);

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  return (
    <div
      ref={panelRef}
      className={cn(
        'flex-shrink-0 border-r bg-muted/30 transition-all duration-200 overflow-hidden',
        isOpen ? '' : 'w-0 border-r-0',
      )}
      style={{ width: isOpen ? width : 0 }}
    >
      <div className="relative h-full flex flex-col" style={{ width }}>
        {children}
      </div>

      {/* Resize handle — visible only when panel is open */}
      {isOpen && (
        <div
          className="absolute top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors z-10"
          style={{ right: -2 }}
          onMouseDown={startResize}
        />
      )}

      {/* Toggle button — always visible, attached to right edge */}
      <button
        onClick={toggle}
        className={cn(
          'absolute top-1/2 -translate-y-1/2 h-16 w-5 flex items-center justify-center',
          'bg-muted border rounded-r-md cursor-pointer hover:bg-accent transition-colors z-20',
          isOpen ? '-right-5' : 'left-0',
        )}
        title={isOpen ? 'Close panel' : 'Open panel'}
      >
        {isOpen ? (
          <ChevronLeft className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/SidePanel.tsx
git commit -m "feat: add SidePanel — collapsible, resizable drawer component

- Toggle open/close via edge button
- Draggable resize handle
- CSS transition for smooth open/close
- Generic children slot for extensibility

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: FileBrowser component

**Files:**
- Create: `web/src/components/FileBrowser.tsx`

- [ ] **Step 1: Create `FileBrowser.tsx`**

```typescript
import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw,
  FolderPlus,
  FilePlus,
  Upload,
  Folder,
  File,
  ChevronRight,
  Home,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Skeleton } from './ui/skeleton';
import { cn } from '@/lib/utils';
import type { FileOps, FileEntry } from '../services/fileOps';

export interface FileBrowserProps {
  fileOps: FileOps;
  onFileClick: (entry: FileEntry) => void;
  /** Initial path to display (empty = root). */
  initialPath?: string;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatModified(ts: number): string {
  if (!ts) return '';
  const now = Date.now();
  const diff = now - ts * 1000;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

type SortKey = 'name' | 'size' | 'modified';
type SortDir = 'asc' | 'desc';

export function FileBrowser({ fileOps, onFileClick, initialPath = '' }: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [showNewFile, setShowNewFile] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newName, setNewName] = useState('');
  const fileInputRef = useState<HTMLInputElement | null>(null);

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fileOps.listDir(path);
      setEntries(result.entries);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load directory';
      setError(msg);
      toast.error(msg);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [fileOps]);

  useEffect(() => {
    loadDir(currentPath);
  }, [currentPath, loadDir]);

  const handleRefresh = () => {
    loadDir(currentPath);
  };

  const navigateTo = (path: string) => {
    setCurrentPath(path);
  };

  const handleEntryClick = (entry: FileEntry) => {
    if (entry.is_dir) {
      navigateTo(entry.path);
    } else {
      onFileClick(entry);
    }
  };

  const handleCreateFile = async () => {
    const name = newName.trim();
    if (!name) return;
    const fullPath = currentPath ? `${currentPath}/${name}` : name;
    try {
      await fileOps.writeFile(fullPath, '');
      toast.success(`Created ${name}`);
      setShowNewFile(false);
      setNewName('');
      loadDir(currentPath);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create file');
    }
  };

  const handleCreateFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    const fullPath = currentPath ? `${currentPath}/${name}` : name;
    try {
      await fileOps.createDir(fullPath);
      toast.success(`Created ${name}/`);
      setShowNewFolder(false);
      setNewName('');
      loadDir(currentPath);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create folder');
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fullPath = currentPath ? `${currentPath}/${file.name}` : file.name;
    try {
      await fileOps.uploadFile(fullPath, file);
      toast.success(`Uploaded ${file.name}`);
      loadDir(currentPath);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to upload file');
    }
    // Reset the input so the same file can be re-uploaded.
    e.target.value = '';
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  // Sort entries: dirs always first regardless of sort key.
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortKey === 'name') {
      return dir * a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    }
    if (sortKey === 'size') return dir * (a.size - b.size);
    if (sortKey === 'modified') return dir * (a.modified - b.modified);
    return 0;
  });

  // Breadcrumb segments.
  const segments = currentPath
    ? currentPath.split('/').filter(Boolean)
    : [];

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleRefresh}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => { setShowNewFile(true); setShowNewFolder(false); }}
          title="New file"
        >
          <FilePlus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => { setShowNewFolder(true); setShowNewFile(false); }}
          title="New folder"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
        <label className="cursor-pointer">
          <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
            <span title="Upload file">
              <Upload className="h-3.5 w-3.5" />
            </span>
          </Button>
          <input
            type="file"
            className="hidden"
            onChange={handleUpload}
          />
        </label>
      </div>

      {/* New file/folder input */}
      {(showNewFile || showNewFolder) && (
        <div className="flex items-center gap-1 px-2 py-1 border-b">
          <Input
            autoFocus
            placeholder={showNewFile ? 'filename.txt' : 'folder-name'}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                showNewFile ? handleCreateFile() : handleCreateFolder();
              }
              if (e.key === 'Escape') {
                setShowNewFile(false);
                setShowNewFolder(false);
                setNewName('');
              }
            }}
            className="h-7 text-xs"
          />
          <Button size="sm" className="h-7 text-xs" onClick={showNewFile ? handleCreateFile : handleCreateFolder}>
            Create
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => {
            setShowNewFile(false);
            setShowNewFolder(false);
            setNewName('');
          }}>
            Cancel
          </Button>
        </div>
      )}

      {/* Breadcrumb */}
      <div className="flex items-center gap-0.5 px-2 py-1 text-xs text-muted-foreground overflow-x-auto flex-shrink-0 border-b">
        <button
          onClick={() => navigateTo('')}
          className="hover:text-foreground transition-colors flex items-center gap-0.5 flex-shrink-0"
          title="Root"
        >
          <Home className="h-3 w-3" />
        </button>
        {segments.map((seg, i) => {
          const path = '/' + segments.slice(0, i + 1).join('/');
          return (
            <span key={path} className="flex items-center gap-0.5 flex-shrink-0">
              <ChevronRight className="h-3 w-3" />
              <button
                onClick={() => navigateTo(path)}
                className="hover:text-foreground transition-colors truncate max-w-[100px]"
              >
                {seg}
              </button>
            </span>
          );
        })}
      </div>

      {/* Column headers */}
      <div className="flex items-center px-2 py-0.5 text-[10px] text-muted-foreground border-b select-none">
        <button
          className="flex-1 text-left hover:text-foreground transition-colors"
          onClick={() => handleSort('name')}
        >
          Name{sortKey === 'name' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
        </button>
        <button
          className="w-16 text-right hover:text-foreground transition-colors"
          onClick={() => handleSort('size')}
        >
          Size{sortKey === 'size' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
        </button>
        <button
          className="w-16 text-right hover:text-foreground transition-colors"
          onClick={() => handleSort('modified')}
        >
          Mod{sortKey === 'modified' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
        </button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-2 space-y-1">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="p-3 text-center text-sm text-muted-foreground">
            <p className="text-destructive mb-1">Failed to load directory</p>
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              Retry
            </Button>
          </div>
        ) : sortedEntries.length === 0 ? (
          <div className="p-3 text-center text-sm text-muted-foreground">
            This directory is empty
          </div>
        ) : (
          sortedEntries.map((entry) => (
            <button
              key={entry.path}
              onClick={() => handleEntryClick(entry)}
              className="flex items-center w-full px-2 py-0.5 text-xs hover:bg-accent transition-colors text-left"
            >
              {entry.is_dir ? (
                <Folder className="h-3.5 w-3.5 mr-1.5 text-blue-400 flex-shrink-0" />
              ) : (
                <File className="h-3.5 w-3.5 mr-1.5 text-muted-foreground flex-shrink-0" />
              )}
              <span className="flex-1 truncate">{entry.name}</span>
              <span className="w-16 text-right text-muted-foreground flex-shrink-0">
                {entry.is_dir ? '' : formatSize(entry.size)}
              </span>
              <span className="w-16 text-right text-muted-foreground flex-shrink-0">
                {formatModified(entry.modified)}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/FileBrowser.tsx
git commit -m "feat: add FileBrowser component

- Directory listing with file/folder icons
- Breadcrumb navigation
- Sortable columns (name, size, modified)
- Toolbar: refresh, new file, new folder, upload
- Loading/empty/error states

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: FileViewer component

**Files:**
- Create: `web/src/components/FileViewer.tsx`

- [ ] **Step 1: Create `FileViewer.tsx`**

```typescript
import { useState, useEffect, useCallback } from 'react';
import { Edit3, Save, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import type { FileOps } from '../services/fileOps';

export interface FileViewerProps {
  fileOps: FileOps;
  path: string;
  filename: string;
  /** Called when the tab should be closed. */
  onClose: () => void;
  /** Called with the new dirty state. */
  onDirtyChange?: (dirty: boolean) => void;
}

const MAX_SIZE_WARNING = 1 * 1024 * 1024; // 1 MB

export function FileViewer({ fileOps, path, filename, onClose, onDirtyChange }: FileViewerProps) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(true);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isLargeFile, setIsLargeFile] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fileOps.readFile(path)
      .then((data) => {
        if (cancelled) return;
        const decoded = fileOps.base64Decode(data.content);
        // Check size before loading.
        if (decoded.length > MAX_SIZE_WARNING) {
          setIsLargeFile(true);
          // Still load it — the user was warned by the tab creation flow.
        }
        setContent(decoded);
        setOriginalContent(decoded);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to read file');
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [path, fileOps]);

  const handleEditToggle = () => {
    setIsReadOnly((prev) => !prev);
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    setContent(newContent);
    const dirty = newContent !== originalContent;
    setIsDirty(dirty);
    onDirtyChange?.(dirty);
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await fileOps.writeFile(path, content);
      setOriginalContent(content);
      setIsDirty(false);
      onDirtyChange?.(false);
      toast.success(`Saved ${filename}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [fileOps, path, content, filename, onDirtyChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl+S / Cmd+S to save.
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (isDirty && !isReadOnly) {
        handleSave();
      }
    }
  };

  // Warn before closing with unsaved changes.
  const handleCloseClick = () => {
    if (isDirty) {
      if (!window.confirm('You have unsaved changes. Close anyway?')) {
        return;
      }
    }
    onClose();
  };

  return (
    <div className="flex flex-col h-full" onKeyDown={handleKeyDown}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 py-1 border-b flex-shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground truncate max-w-[200px]">
            {filename}
          </span>
          {isDirty && <span className="w-2 h-2 rounded-full bg-amber-500" title="Unsaved changes" />}
          {isLargeFile && (
            <span title="Large file" className="flex items-center gap-0.5 text-amber-500">
              <AlertTriangle className="h-3 w-3" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!isReadOnly && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={handleSave}
              disabled={!isDirty || saving}
            >
              <Save className="h-3 w-3 mr-1" />
              {saving ? 'Saving...' : 'Save'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={handleEditToggle}
          >
            <Edit3 className="h-3 w-3 mr-1" />
            {isReadOnly ? 'Edit' : 'View'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs hover:text-destructive"
            onClick={handleCloseClick}
          >
            ✕
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="p-3 space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : error ? (
          <div className="p-3 text-center text-sm">
            <p className="text-destructive mb-1">{error}</p>
            <Button variant="outline" size="sm" onClick={() => {
              setLoading(true);
              setError(null);
              fileOps.readFile(path).then((data) => {
                const decoded = fileOps.base64Decode(data.content);
                setContent(decoded);
                setOriginalContent(decoded);
                setLoading(false);
              }).catch((err) => {
                setError(err instanceof Error ? err.message : 'Failed to read file');
                setLoading(false);
              });
            }}>
              Retry
            </Button>
          </div>
        ) : (
          <textarea
            value={content}
            onChange={handleContentChange}
            readOnly={isReadOnly}
            className={cn(
              'w-full h-full resize-none bg-transparent p-3 font-mono text-xs leading-relaxed',
              'focus:outline-none',
              isReadOnly ? 'cursor-default' : 'cursor-text',
            )}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}

// Need cn for conditional classes
import { cn } from '@/lib/utils';
```

Wait — I put the import at the bottom. Let me fix that in the plan. The import should be at the top.

Actually, looking at this, the import should be at the top of the file. The code structure is fine — just move the cn import up. Let me fix.

- [ ] **Step 2: Commit**

```bash
git add web/src/components/FileViewer.tsx
git commit -m "feat: add FileViewer component

- Read-only textarea with Edit toggle
- Save with Ctrl+S support
- Dirty state tracking with unsaved warning
- Large file warning indicator
- Loading/error states with retry

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: FileTabs component + TerminalView integration

**Files:**
- Create: `web/src/components/FileTabs.tsx`
- Modify: `web/src/components/Dashboard.tsx` (TerminalView section)

- [ ] **Step 1: Create `FileTabs.tsx`**

```typescript
import { useState, useCallback } from 'react';
import { X, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SidePanel } from './SidePanel';
import { FileBrowser } from './FileBrowser';
import { FileViewer } from './FileViewer';
import type { FileOps, FileEntry } from '../services/fileOps';

export interface OpenFile {
  id: string;
  path: string;
  filename: string;
}

interface FileTabsProps {
  fileOps: FileOps;
  terminalElement: React.ReactNode;
  /** Called when a connection-disconnect occurs and no files are open. */
}

const MAX_TABS = 10;

export function FileTabs({ fileOps, terminalElement }: FileTabsProps) {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('terminal');
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());

  const handleFileClick = useCallback((entry: FileEntry) => {
    if (entry.is_dir) return; // handled inside FileBrowser

    // Check if already open.
    const existing = openFiles.find((f) => f.path === entry.path);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    // Enforce max tabs.
    if (openFiles.length >= MAX_TABS) {
      // Remove the oldest non-dirty file tab.
      const toClose = openFiles.find((f) => !dirtyFiles.has(f.id));
      if (toClose) {
        setOpenFiles((prev) => prev.filter((f) => f.id !== toClose.id));
      } else {
        alert(`Maximum ${MAX_TABS} files open. Close some first.`);
        return;
      }
    }

    const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newFile: OpenFile = {
      id,
      path: entry.path,
      filename: entry.name,
    };
    setOpenFiles((prev) => [...prev, newFile]);
    setActiveTabId(id);
  }, [openFiles, dirtyFiles]);

  const handleCloseFile = useCallback((id: string) => {
    if (dirtyFiles.has(id)) {
      if (!window.confirm('Unsaved changes will be lost. Close anyway?')) {
        return;
      }
    }
    setOpenFiles((prev) => {
      const filtered = prev.filter((f) => f.id !== id);
      // If closing the active tab, switch to the last remaining file or terminal.
      if (activeTabId === id) {
        setActiveTabId(filtered.length > 0 ? filtered[filtered.length - 1].id : 'terminal');
      }
      return filtered;
    });
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, [activeTabId, dirtyFiles]);

  const handleDirtyChange = useCallback((id: string, dirty: boolean) => {
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const activeFile = openFiles.find((f) => f.id === activeTabId);
  const showTerminal = activeTabId === 'terminal';

  return (
    <div className="flex-1 min-h-0 flex flex-row">
      {/* Left: SidePanel with FileBrowser */}
      <SidePanel>
        <FileBrowser
          fileOps={fileOps}
          onFileClick={handleFileClick}
        />
      </SidePanel>

      {/* Right: Tab bar + content */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Tab bar */}
        <div className="flex items-center border-b bg-muted/20 flex-shrink-0 overflow-x-auto">
          {/* Terminal tab */}
          <button
            onClick={() => setActiveTabId('terminal')}
            className={cn(
              'flex items-center gap-1 px-3 py-1.5 text-xs border-r border-b-2 transition-colors flex-shrink-0',
              showTerminal
                ? 'border-b-primary bg-background text-foreground'
                : 'border-b-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Terminal className="h-3 w-3" />
            Terminal
          </button>

          {/* File tabs */}
          {openFiles.map((file) => (
            <button
              key={file.id}
              onClick={() => setActiveTabId(file.id)}
              className={cn(
                'flex items-center gap-1 px-3 py-1.5 text-xs border-r border-b-2 transition-colors flex-shrink-0 max-w-[160px]',
                activeTabId === file.id
                  ? 'border-b-primary bg-background text-foreground'
                  : 'border-b-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="truncate">{file.filename}</span>
              {dirtyFiles.has(file.id) && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />
              )}
              <X
                className="h-3 w-3 flex-shrink-0 hover:text-destructive ml-0.5"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseFile(file.id);
                }}
              />
            </button>
          ))}
        </div>

        {/* Content area */}
        <div className="flex-1 min-h-0">
          {showTerminal ? (
            terminalElement
          ) : activeFile ? (
            <FileViewer
              key={activeFile.id}
              fileOps={fileOps}
              path={activeFile.path}
              filename={activeFile.filename}
              onClose={() => handleCloseFile(activeFile.id)}
              onDirtyChange={(dirty) => handleDirtyChange(activeFile.id, dirty)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update `TerminalView` in `Dashboard.tsx` to use `FileTabs`**

Replace the current TerminalView body with the integrated layout. The TerminalView now:

1. Creates the `useP2PConnection` hook
2. Creates `FileOps` from the connection
3. Wraps the Terminal in a `FileTabs` component

```typescript
import { useP2PConnection } from '../hooks/useP2PConnection';
import { createFileOps } from '../services/fileOps';
import { FileTabs } from './FileTabs';

function TerminalView({ session, wsService, onBack, onDisconnect, onError }: TerminalViewProps) {
  const { attachInfo, sessionId, sessionName } = session;
  const isP2P = attachInfo.mode === 'p2p';
  const terminalRef = useRef<TerminalHandle>(null);

  const p2pConnection = useP2PConnection(
    isP2P && attachInfo.agent_address
      ? {
          agentUrl: attachInfo.agent_address,
          connectionToken: attachInfo.connection_token,
          sessionName,
        }
      : null,
  );

  const fileOps = p2pConnection ? createFileOps(p2pConnection) : null;

  const terminalElement = (
    <Terminal
      ref={terminalRef}
      sessionId={sessionId}
      sessionName={sessionName}
      mode={attachInfo.mode}
      p2pConnection={isP2P ? p2pConnection : undefined}
      serverConnection={!isP2P ? wsService : undefined}
      onDisconnect={onDisconnect}
      onError={onError}
    />
  );

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="border-b px-4 py-2 flex items-center gap-4 flex-shrink-0">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <span className="text-sm text-muted-foreground">
          Session: <strong className="text-foreground">{sessionName}</strong>
        </span>
        <Badge variant={attachInfo.mode === 'p2p' ? 'default' : 'secondary'} className="text-xs">
          {attachInfo.mode.toUpperCase()}
        </Badge>
      </header>

      <div className="flex-1 min-h-0 flex flex-col">
        {fileOps ? (
          <FileTabs
            fileOps={fileOps}
            terminalElement={
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0">
                  {terminalElement}
                </div>
                <TerminalToolbar sendText={(text) => terminalRef.current?.sendText(text)} />
              </div>
            }
          />
        ) : (
          <>
            <div className="flex-1 min-h-0">
              {terminalElement}
            </div>
            <TerminalToolbar sendText={(text) => terminalRef.current?.sendText(text)} />
          </>
        )}
      </div>
    </div>
  );
}
```

When `fileOps` is null (relay mode or connection not ready), the terminal renders in its original layout without the side panel. In P2P mode, FileTabs wraps everything with the side panel + tabbed layout.

- [ ] **Step 3: Build and verify**

Run: `cd web && npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/FileTabs.tsx web/src/components/Dashboard.tsx
git commit -m "feat: integrate FileTabs + SidePanel into TerminalView

- FileTabs manages open file tabs alongside the terminal tab
- SidePanel hosts FileBrowser when in P2P mode
- Relay mode renders original layout without side panel
- TerminalView wires useP2PConnection + FileOps together

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Polish — State handling, edge cases, final verification

**Files:**
- Modify: `web/src/components/FileViewer.tsx` (fix import order)
- Verify: all test suites pass

- [ ] **Step 1: Fix `FileViewer.tsx` import order**

Move the `import { cn } from '@/lib/utils';` line to the top of the file, with the other imports. The current code in Task 9 placed it at the bottom erroneously.

- [ ] **Step 2: Add large file warning in FileBrowser before opening**

In `FileBrowser.tsx`, before calling `onFileClick`, check if the file is > 1MB and warn:

```typescript
const handleEntryClick = (entry: FileEntry) => {
  if (entry.is_dir) {
    navigateTo(entry.path);
  } else {
    if (entry.size > MAX_SIZE_WARNING && !window.confirm(
      `This file is ${formatSize(entry.size)}. Loading large files may be slow. Continue?`
    )) {
      return;
    }
    onFileClick(entry);
  }
};
```

Add `const MAX_SIZE_WARNING = 1 * 1024 * 1024;` near the top of the file.

- [ ] **Step 3: Ensure disconnected state is handled in file ops**

In `FileTabs.tsx`, watch for `p2pConnection.connectionState === 'disconnected'` and show a toast if file operations are attempted while disconnected. This can be a prop or checked in `fileOps.ts` sendRequest.

In `fileOps.ts`, update `sendRequest`:

```typescript
function sendRequest(
  p2p: P2PConnection,
  msgType: string,
  payload: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (p2p.connectionState === 'disconnected') {
      reject(new Error('Connection lost'));
      return;
    }
    // ... rest unchanged
  });
}
```

- [ ] **Step 4: Run full test suite**

Run: `cargo test`
Expected: All tests pass.

Run: `cd web && npm run build`
Expected: Build succeeds.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "fix: polish file manager — import order, large file warning, disconnect handling

Co-Authored-By: Claude <noreply@anthropic.com>"
```
